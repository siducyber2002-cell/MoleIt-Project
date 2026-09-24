from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_

from .. import models, schemas
from ..database import get_db
from ..exceptions import NotFoundError
from ..logging_config import get_logger
from ..responses import ok, err, serialize, serialize_list

logger = get_logger(__name__)

router = APIRouter(prefix="/api/functional-groups", tags=["functional-groups"])


@router.get("")
def list_functional_groups(
    tier: Optional[str] = Query(None, description='"core", "advanced", or omit for all'),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    logger.info("List functional groups requested | tier=%r search=%r", tier, search)
    try:
        q = db.query(models.FunctionalGroup)
        if tier and tier.lower() != "all":
            q = q.filter(models.FunctionalGroup.tier == tier.lower())
        if search:
            like = f"%{search}%"
            q = q.filter(
                or_(
                    models.FunctionalGroup.name.ilike(like),
                    models.FunctionalGroup.examples.ilike(like),
                    models.FunctionalGroup.description.ilike(like),
                )
            )
        results = q.order_by(models.FunctionalGroup.name.asc()).all()
        logger.info("List functional groups succeeded | returned=%d", len(results))
        return ok(200, "Functional groups fetched successfully", groups=serialize_list(schemas.FunctionalGroupOut, results))
    except Exception:
        logger.error("List functional groups crashed | tier=%r search=%r", tier, search, exc_info=True)
        return err(500, "Internal server error")


@router.get("/{group_id}")
def get_functional_group(group_id: str, db: Session = Depends(get_db)):
    logger.info("Get functional group requested | group_id=%s", group_id)
    try:
        g = db.query(models.FunctionalGroup).filter(models.FunctionalGroup.id == group_id).first()
        if not g:
            raise NotFoundError("Functional group not found")
        logger.info("Get functional group succeeded | group_id=%s", group_id)
        return ok(200, "Functional group fetched successfully", group=serialize(schemas.FunctionalGroupOut, g))
    except NotFoundError as e:
        logger.warning("Get functional group failed | group_id=%s reason=%s", group_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Get functional group crashed | group_id=%s", group_id, exc_info=True)
        return err(500, "Internal server error")