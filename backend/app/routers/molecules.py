from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..auth import get_current_user
from ..exceptions import NotFoundError
from ..logging_config import get_logger
from ..responses import ok, err, serialize, serialize_list

logger = get_logger(__name__)

router = APIRouter(prefix="/api/molecules", tags=["molecules"])


@router.get("")
def list_my_molecules(
    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)
):
    logger.info("Listing molecules for user_id=%s", current_user.id)
    try:
        results = (
            db.query(models.UserMolecule)
            .filter(models.UserMolecule.owner_id == current_user.id)
            .order_by(models.UserMolecule.updated_at.desc())
            .all()
        )
        logger.info("Listing molecules succeeded | user_id=%s count=%d", current_user.id, len(results))
        return ok(200, "Molecules fetched successfully", molecules=serialize_list(schemas.MoleculeOut, results))
    except Exception:
        logger.error("Listing molecules crashed | user_id=%s", current_user.id, exc_info=True)
        return err(500, "Internal server error")


@router.get("/public")
def list_public_molecules(db: Session = Depends(get_db)):
    logger.info("Listing public molecules")
    try:
        results = (
            db.query(models.UserMolecule)
            .filter(models.UserMolecule.is_public == True)  # noqa: E712
            .order_by(models.UserMolecule.updated_at.desc())
            .limit(100)
            .all()
        )
        logger.info("Listing public molecules succeeded | count=%d", len(results))
        return ok(200, "Public molecules fetched successfully", molecules=serialize_list(schemas.MoleculeOut, results))
    except Exception:
        logger.error("Listing public molecules crashed", exc_info=True)
        return err(500, "Internal server error")


@router.post("")
def save_molecule(
    payload: schemas.MoleculeCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Save molecule requested | user_id=%s name=%r", current_user.id, payload.name)
    try:
        mol = models.UserMolecule(
            name=payload.name,
            structure_2d=payload.structure_2d,
            derived_formula=payload.derived_formula,
            derived_smiles=payload.derived_smiles,
            is_public=payload.is_public,
            owner_id=current_user.id,
        )
        db.add(mol)
        db.commit()
        db.refresh(mol)
        logger.info("Save molecule succeeded | user_id=%s molecule_id=%s", current_user.id, mol.id)
        return ok(201, "Molecule saved successfully", molecule=serialize(schemas.MoleculeOut, mol))
    except Exception:
        logger.error("Save molecule crashed | user_id=%s", current_user.id, exc_info=True)
        return err(500, "Internal server error")


@router.put("/{molecule_id}")
def update_molecule(
    molecule_id: str,
    payload: schemas.MoleculeUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Update molecule requested | user_id=%s molecule_id=%s", current_user.id, molecule_id)
    try:
        mol = (
            db.query(models.UserMolecule)
            .filter(models.UserMolecule.id == molecule_id, models.UserMolecule.owner_id == current_user.id)
            .first()
        )
        if not mol:
            raise NotFoundError("Molecule not found")

        for field, value in payload.model_dump(exclude_unset=True).items():
            setattr(mol, field, value)

        db.commit()
        db.refresh(mol)
        logger.info("Update molecule succeeded | user_id=%s molecule_id=%s", current_user.id, molecule_id)
        return ok(200, "Molecule updated successfully", molecule=serialize(schemas.MoleculeOut, mol))
    except NotFoundError as e:
        logger.warning("Update molecule failed | user_id=%s molecule_id=%s reason=%s", current_user.id, molecule_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Update molecule crashed | user_id=%s molecule_id=%s", current_user.id, molecule_id, exc_info=True)
        return err(500, "Internal server error")


@router.delete("/{molecule_id}")
def delete_molecule(
    molecule_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info("Delete molecule requested | user_id=%s molecule_id=%s", current_user.id, molecule_id)
    try:
        mol = (
            db.query(models.UserMolecule)
            .filter(models.UserMolecule.id == molecule_id, models.UserMolecule.owner_id == current_user.id)
            .first()
        )
        if not mol:
            raise NotFoundError("Molecule not found")
        db.delete(mol)
        db.commit()
        logger.info("Delete molecule succeeded | user_id=%s molecule_id=%s", current_user.id, molecule_id)
        return ok(200, "Molecule deleted successfully")
    except NotFoundError as e:
        logger.warning("Delete molecule failed | user_id=%s molecule_id=%s reason=%s", current_user.id, molecule_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Delete molecule crashed | user_id=%s molecule_id=%s", current_user.id, molecule_id, exc_info=True)
        return err(500, "Internal server error")