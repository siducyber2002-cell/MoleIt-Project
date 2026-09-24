from typing import Any, Dict, List

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..exceptions import BadRequestError
from ..logging_config import get_logger
from ..responses import ok, err
from ..formula import (
    compute_formula,
    compute_molar_mass,
    derive_smiles,
    find_valence_issues,
    resolve_bond_orders,
)
from ..graph_analysis import count_rings
from ..smiles_parser import parse_smiles
from ..structure_cleanup import (
    autocorrect_structure,
    apply_tetrahedral_wedges,
    expand_isolated_atom_hydrogens,
    recenter_structure,
    remap_structure_ids,
)
from ..ring_templates import generate_ring_structure

logger = get_logger(__name__)

router = APIRouter(prefix="/api/structure", tags=["structure"])


class StructureRequest(BaseModel):
    """Same `atoms`/`bonds` shape as everywhere else in this API: an atom
    is `{id, element, x, y, charge}`, a bond is `{id, from, to, order,
    aromatic}`."""

    atoms: List[Dict[str, Any]] = Field(..., min_length=1)
    bonds: List[Dict[str, Any]] = Field(default_factory=list)


def _validate_atoms_bonds(atoms: List[Dict[str, Any]], bonds: List[Dict[str, Any]]) -> None:
    for a in atoms:
        if "id" not in a or "element" not in a:
            raise BadRequestError("Every atom needs an 'id' and 'element'")
    atom_ids = {a["id"] for a in atoms}
    for b in bonds:
        if b.get("from") not in atom_ids or b.get("to") not in atom_ids:
            raise BadRequestError("Every bond's 'from'/'to' must reference an atom id in 'atoms'")


@router.post("/analyze")
def analyze_structure(payload: StructureRequest):
    """Formula, molar mass, an approximate SMILES, valence-check warnings,
    ring count, and every bond's resolved single/double/triple order
    (Kekulé-resolved for aromatic bonds) for a drawn structure. This is
    the same computation that used to run client-side in lib/elements.js
    and lib/graphAnalysis.js (computeFormula, computeMolarMass,
    deriveSmiles, findValenceIssues, kekulizeAromaticBonds/
    bondOrderValue, countRings) — including for the copy of it that gets
    persisted on save, which previously had no server-side check at all.
    See app/formula.py and app/graph_analysis.py for the full mechanism.
    """
    logger.info("Structure analysis requested | atoms=%d bonds=%d", len(payload.atoms), len(payload.bonds))
    try:
        _validate_atoms_bonds(payload.atoms, payload.bonds)
        formula = compute_formula(payload.atoms, payload.bonds)
        molar_mass = compute_molar_mass(payload.atoms, payload.bonds)
        smiles = derive_smiles(payload.atoms, payload.bonds)
        issues = find_valence_issues(payload.atoms, payload.bonds)
        bond_orders = resolve_bond_orders(payload.atoms, payload.bonds)
        ring_count = count_rings(payload.atoms, payload.bonds)
        logger.info("Structure analysis succeeded | formula=%s issues=%d", formula, len(issues))
        return ok(
            200,
            "Structure analyzed successfully",
            formula=formula,
            molar_mass=molar_mass,
            smiles=smiles,
            issues=issues,
            bond_orders=bond_orders,
            ring_count=ring_count,
        )
    except BadRequestError as e:
        logger.warning("Structure analysis failed | reason=%s", e)
        return err(400, str(e))
    except Exception:
        logger.error("Structure analysis crashed", exc_info=True)
        return err(500, "Internal server error")


class SmilesRequest(BaseModel):
    smiles: str


@router.post("/from-smiles")
def structure_from_smiles(payload: SmilesRequest):
    """Parses a SMILES string into {atoms, bonds} — the same computation
    that used to run client-side in lib/smilesParser.js's parseSmiles.
    Used by the Draw Lab's "Import from SMILES" box and by the
    Autocorrect flow's structure_2d-missing fallback."""
    logger.info("SMILES parse requested | length=%d", len(payload.smiles or ''))
    try:
        structure = parse_smiles(payload.smiles)
        logger.info("SMILES parse succeeded | atoms=%d bonds=%d", len(structure['atoms']), len(structure['bonds']))
        return ok(200, "SMILES parsed successfully", atoms=structure['atoms'], bonds=structure['bonds'])
    except BadRequestError as e:
        logger.warning("SMILES parse failed | reason=%s", e)
        return err(400, str(e))
    except Exception:
        logger.error("SMILES parse crashed", exc_info=True)
        return err(500, "Internal server error")


class CleanupRequest(BaseModel):
    """`target_center` is the {x, y} point the cleaned-up fragment should
    end up centered on — DrawLabPage passes the target selection's
    original bounding-box center so a cleaned-up/replaced fragment lands
    roughly where the student's original (possibly messy) drawing was."""

    atoms: List[Dict[str, Any]] = Field(..., min_length=1)
    bonds: List[Dict[str, Any]] = Field(default_factory=list)
    target_center: Dict[str, float]


@router.post("/cleanup")
def cleanup_structure(payload: CleanupRequest):
    """ChemDraw-style 'Clean Up Structure': expands any isolated hydride
    atom (methane/ammonia/water-type molecules that parsed down to a bare
    unbonded atom) into its real hydrogens, recomputes clean 2D
    coordinates from connectivity alone, adds wedge/dash bonds for any
    genuine tetrahedral hub, then recenters on target_center. Connectivity
    (atom identity, element, charge, bond endpoints/order) is never
    touched — only x/y move (and any bonds newly added by the hydride
    expansion). This is the same 4-step pipeline that used to run
    client-side in lib/structureCleanup.js, called by DrawLabPage's
    Autocorrect flow. See app/structure_cleanup.py for the full
    mechanism."""
    logger.info("Structure cleanup requested | atoms=%d bonds=%d", len(payload.atoms), len(payload.bonds))
    try:
        _validate_atoms_bonds(payload.atoms, payload.bonds)
        expanded = expand_isolated_atom_hydrogens(payload.atoms, payload.bonds)
        cleaned = autocorrect_structure(expanded['atoms'], expanded['bonds'])
        wedged_bonds = apply_tetrahedral_wedges(cleaned['atoms'], cleaned['bonds'])
        recentered_atoms = recenter_structure(cleaned['atoms'], payload.target_center)
        logger.info("Structure cleanup succeeded | atoms=%d bonds=%d", len(recentered_atoms), len(wedged_bonds))
        return ok(200, "Structure cleaned up successfully", atoms=recentered_atoms, bonds=wedged_bonds)
    except BadRequestError as e:
        logger.warning("Structure cleanup failed | reason=%s", e)
        return err(400, str(e))
    except Exception:
        logger.error("Structure cleanup crashed", exc_info=True)
        return err(500, "Internal server error")


class RemapRequest(BaseModel):
    """Renumbers new_atoms/new_bonds' ids so they can't collide with
    existing_atoms/existing_bonds — used right after /cleanup or
    /from-smiles, before merging the result onto the rest of the canvas."""

    new_atoms: List[Dict[str, Any]] = Field(default_factory=list)
    new_bonds: List[Dict[str, Any]] = Field(default_factory=list)
    existing_atoms: List[Dict[str, Any]] = Field(default_factory=list)
    existing_bonds: List[Dict[str, Any]] = Field(default_factory=list)


@router.post("/remap")
def remap_structure(payload: RemapRequest):
    """Same computation that used to run client-side in
    lib/structureCleanup.js's remapStructureIds."""
    logger.info("Structure remap requested | new_atoms=%d existing_atoms=%d", len(payload.new_atoms), len(payload.existing_atoms))
    try:
        result = remap_structure_ids(payload.new_atoms, payload.new_bonds, payload.existing_atoms, payload.existing_bonds)
        return ok(200, "Structure remapped successfully", atoms=result['atoms'], bonds=result['bonds'])
    except Exception:
        logger.error("Structure remap crashed", exc_info=True)
        return err(500, "Internal server error")


class InsertRingRequest(BaseModel):
    ring_type_id: str
    center_x: float
    center_y: float
    atoms: List[Dict[str, Any]] = Field(default_factory=list)
    bonds: List[Dict[str, Any]] = Field(default_factory=list)


@router.post("/insert-ring")
def insert_ring(payload: InsertRingRequest):
    """Generates a regular-polygon ring template (cyclopropane through
    cyclohexane, or benzene) and wires it into the existing molecular
    graph. Same computation that used to run client-side in
    lib/ringTemplates.js's generateRingStructure — used by the Draw Lab's
    ring-insert toolbar. See app/ring_templates.py for the ring
    size/aromaticity table (kept in sync with the frontend's RING_TYPES,
    which stays client-side since it's just the toolbar's button labels)."""
    logger.info("Ring insert requested | ring_type=%s atoms=%d", payload.ring_type_id, len(payload.atoms))
    try:
        result = generate_ring_structure(payload.ring_type_id, payload.center_x, payload.center_y, payload.atoms, payload.bonds)
        return ok(200, "Ring inserted successfully", atoms=result['atoms'], bonds=result['bonds'])
    except Exception:
        logger.error("Ring insert crashed", exc_info=True)
        return err(500, "Internal server error")