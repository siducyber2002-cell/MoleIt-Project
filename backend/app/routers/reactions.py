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

router = APIRouter(prefix="/api/reactions", tags=["reactions"])


@router.get("")
def list_reactions(
    tier: Optional[str] = Query(None, description='"core", "advanced", or omit for all'),
    category: Optional[str] = Query(None, description="e.g. Substitution, Elimination, Addition, Named Reaction"),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    logger.info("List reactions requested | tier=%r category=%r search=%r", tier, category, search)
    try:
        q = db.query(models.Reaction)
        if tier and tier.lower() != "all":
            q = q.filter(models.Reaction.tier == tier.lower())
        if category and category.lower() != "all":
            q = q.filter(models.Reaction.category == category)
        if search:
            like = f"%{search}%"
            q = q.filter(
                or_(
                    models.Reaction.name.ilike(like),
                    models.Reaction.general_equation.ilike(like),
                    models.Reaction.summary.ilike(like),
                    models.Reaction.reagents.ilike(like),
                )
            )
        results = q.order_by(models.Reaction.name.asc()).all()
        logger.info("List reactions succeeded | returned=%d", len(results))
        return ok(200, "Reactions fetched successfully", reactions=serialize_list(schemas.ReactionOut, results))
    except Exception:
        logger.error("List reactions crashed | tier=%r category=%r search=%r", tier, category, search, exc_info=True)
        return err(500, "Internal server error")


@router.get("/categories")
def list_reaction_categories(db: Session = Depends(get_db)):
    logger.info("List reaction categories requested")
    try:
        rows = db.query(models.Reaction.category).distinct().order_by(models.Reaction.category.asc()).all()
        categories = [r[0] for r in rows]
        logger.info("List reaction categories succeeded | count=%d", len(categories))
        return ok(200, "Reaction categories fetched successfully", categories=categories)
    except Exception:
        logger.error("List reaction categories crashed", exc_info=True)
        return err(500, "Internal server error")


@router.get("/{reaction_id}")
def get_reaction(reaction_id: str, db: Session = Depends(get_db)):
    logger.info("Get reaction requested | reaction_id=%s", reaction_id)
    try:
        r = db.query(models.Reaction).filter(models.Reaction.id == reaction_id).first()
        if not r:
            raise NotFoundError("Reaction not found")
        logger.info("Get reaction succeeded | reaction_id=%s", reaction_id)
        return ok(200, "Reaction fetched successfully", reaction=serialize(schemas.ReactionOut, r))
    except NotFoundError as e:
        logger.warning("Get reaction failed | reaction_id=%s reason=%s", reaction_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Get reaction crashed | reaction_id=%s", reaction_id, exc_info=True)
        return err(500, "Internal server error")