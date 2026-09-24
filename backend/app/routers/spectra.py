from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..exceptions import BadRequestError
from ..logging_config import get_logger
from ..responses import ok, err
from ..spectra import predict_nmr, predict_ir, detect_functional_groups, detect_named_scaffolds

logger = get_logger(__name__)

router = APIRouter(prefix="/api/spectra", tags=["spectra"])


class SpectraRequest(BaseModel):
    """`atoms`/`bonds` take the same shape as a compound's `structure_2d`
    everywhere else in this API: an atom is `{id, element, x, y, charge}`,
    a bond is `{id, from, to, order, aromatic}`."""

    atoms: List[Dict[str, Any]] = Field(..., min_length=1)
    bonds: List[Dict[str, Any]] = Field(default_factory=list)


class NmrRequest(SpectraRequest):
    solvent: Literal["CDCl3", "DMSO", "D2O"] = "CDCl3"


def _validate_atoms_bonds(atoms: List[Dict[str, Any]], bonds: List[Dict[str, Any]]) -> None:
    for a in atoms:
        if "id" not in a or "element" not in a:
            raise BadRequestError("Every atom needs an 'id' and 'element'")
    atom_ids = {a["id"] for a in atoms}
    for b in bonds:
        if b.get("from") not in atom_ids or b.get("to") not in atom_ids:
            raise BadRequestError("Every bond's 'from'/'to' must reference an atom id in 'atoms'")


@router.post("/nmr")
def nmr_prediction(payload: NmrRequest):
    """Predicts 1H/13C NMR peaks for a structure. This is the same rule
    engine that used to run client-side in nmrPredictor.js — see
    app/spectra/nmr.py for the full mechanism."""
    logger.info("NMR prediction requested | atoms=%d bonds=%d solvent=%s", len(payload.atoms), len(payload.bonds), payload.solvent)
    try:
        _validate_atoms_bonds(payload.atoms, payload.bonds)
        result = predict_nmr(payload.atoms, payload.bonds, payload.solvent)
        functional_groups = detect_functional_groups(payload.atoms, payload.bonds)
        scaffolds = detect_named_scaffolds(payload.atoms, payload.bonds)
        logger.info("NMR prediction succeeded | h1=%d c13=%d groups=%d scaffolds=%d", len(result["h1"]), len(result["c13"]), len(functional_groups), len(scaffolds))
        return ok(
            200, "NMR prediction computed successfully",
            h1=result["h1"], c13=result["c13"], warnings=result.get("warnings", []),
            functionalGroups=functional_groups, scaffolds=scaffolds,
        )
    except BadRequestError as e:
        logger.warning("NMR prediction failed | reason=%s", e)
        return err(400, str(e))
    except Exception:
        logger.error("NMR prediction crashed", exc_info=True)
        return err(500, "Internal server error")


@router.post("/ir")
def ir_prediction(payload: SpectraRequest):
    """Predicts IR absorption bands for a structure. Same rule engine that
    used to run client-side in irPredictor.js — see app/spectra/ir.py."""
    logger.info("IR prediction requested | atoms=%d bonds=%d", len(payload.atoms), len(payload.bonds))
    try:
        _validate_atoms_bonds(payload.atoms, payload.bonds)
        result = predict_ir(payload.atoms, payload.bonds)
        functional_groups = detect_functional_groups(payload.atoms, payload.bonds)
        scaffolds = detect_named_scaffolds(payload.atoms, payload.bonds)
        logger.info("IR prediction succeeded | bands=%d groups=%d scaffolds=%d", len(result["bands"]), len(functional_groups), len(scaffolds))
        return ok(200, "IR prediction computed successfully", bands=result["bands"], functionalGroups=functional_groups, scaffolds=scaffolds)
    except BadRequestError as e:
        logger.warning("IR prediction failed | reason=%s", e)
        return err(400, str(e))
    except Exception:
        logger.error("IR prediction crashed", exc_info=True)
        return err(500, "Internal server error")


@router.post("/functional-groups")
def functional_groups(payload: SpectraRequest):
    """Standalone functional-group + named-scaffold recognition (amides,
    lactones, esters, coumarins, flavones, chromones, ...) for a
    structure, independent of running a full NMR/IR prediction. See
    app/spectra/scaffolds.py for the recognition logic."""
    logger.info("Functional-group scan requested | atoms=%d bonds=%d", len(payload.atoms), len(payload.bonds))
    try:
        _validate_atoms_bonds(payload.atoms, payload.bonds)
        groups = detect_functional_groups(payload.atoms, payload.bonds)
        scaffolds_found = detect_named_scaffolds(payload.atoms, payload.bonds)
        logger.info("Functional-group scan succeeded | groups=%d scaffolds=%d", len(groups), len(scaffolds_found))
        return ok(200, "Functional groups detected successfully", functionalGroups=groups, scaffolds=scaffolds_found)
    except BadRequestError as e:
        logger.warning("Functional-group scan failed | reason=%s", e)
        return err(400, str(e))
    except Exception:
        logger.error("Functional-group scan crashed", exc_info=True)
        return err(500, "Internal server error")