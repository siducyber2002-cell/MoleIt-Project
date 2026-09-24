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