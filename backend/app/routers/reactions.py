from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_

from .. import models, schemas
from ..database import get_db
from ..exceptions import BadRequestError, NotFoundError
from ..logging_config import get_logger
from ..mechanism import audit_reaction, prepare_mechanism
from ..responses import ok, err, serialize

logger = get_logger(__name__)

router = APIRouter(prefix="/api/reactions", tags=["reactions"])

_VALID_TIERS = {"core", "advanced", "all"}
_MAX_SEARCH_LEN = 100


def _reaction_out(r: models.Reaction, log_issues: bool = False) -> dict:
    """ORM row -> JSON dict with a draw-ready mechanism.

    mechanism_steps is run through app/mechanism.py: bad rows are repaired
    (missing atoms, duplicate ids, lowercase elements, stacked atoms...) and
    every step gets its bond lines, arrow paths/heads and viewBox computed,
    so the frontend only renders. The repairs found are reported in each
    step's `issues` and, for single-reaction fetches, written to the log so
    the source row can be fixed."""
    data = serialize(schemas.ReactionOut, r)
    steps = prepare_mechanism(data.get("mechanism_steps"))
    if log_issues:
        for n, st in enumerate(steps, 1):
            if st["issues"]:
                logger.warning(
                    "Reaction data repaired | reaction_id=%s step=%d title=%r issues=%s",
                    r.id, n, st["title"], st["issues"],
                )
    data["mechanism_steps"] = steps
    return data


def _validate_list_filters(tier: Optional[str], search: Optional[str]) -> None:
    if tier and tier.lower() not in _VALID_TIERS:
        raise BadRequestError(f"Invalid tier '{tier}'. Use 'core', 'advanced' or 'all'")
    if search and len(search) > _MAX_SEARCH_LEN:
        raise BadRequestError(f"Search text is too long (max {_MAX_SEARCH_LEN} characters)")


@router.get("")
def list_reactions(
    tier: Optional[str] = Query(None, description='"core", "advanced", or omit for all'),
    category: Optional[str] = Query(None, description="e.g. Substitution, Elimination, Addition, Named Reaction"),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    logger.info("List reactions requested | tier=%r category=%r search=%r", tier, category, search)
    try:
        _validate_list_filters(tier, search)

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

        # One corrupt row must not take the whole list down. A row that can't
        # be built is skipped, logged with its id (grep the request_id), and
        # reported back in `skipped_ids` so it can be fixed at the source.
        reactions, skipped_ids = [], []
        for r in results:
            try:
                reactions.append(_reaction_out(r))
            except Exception:
                skipped_ids.append(r.id)
                logger.error("List reactions row failed | reaction_id=%s name=%r", r.id, r.name, exc_info=True)

        if skipped_ids:
            logger.warning(
                "List reactions partially succeeded | returned=%d skipped=%d skipped_ids=%s",
                len(reactions), len(skipped_ids), skipped_ids,
            )
            return ok(
                200, f"Reactions fetched with {len(skipped_ids)} skipped (see server log)",
                reactions=reactions, skipped_ids=skipped_ids,
            )

        logger.info("List reactions succeeded | returned=%d", len(reactions))
        return ok(200, "Reactions fetched successfully", reactions=reactions)
    except BadRequestError as e:
        logger.warning("List reactions failed | tier=%r search_len=%d reason=%s", tier, len(search or ""), e)
        return err(400, str(e))
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


@router.get("/audit")
def audit_reactions(
    errors_only: bool = Query(False, description="hide WARN findings"),
    reaction_id: Optional[str] = Query(None, description="audit just one reaction"),
    db: Session = Depends(get_db),
):
    """Check every reaction's stored mechanism for data bugs (missing atoms,
    stacked atoms, valence overflow, arrows pointing at nothing...). Must be
    declared BEFORE /{reaction_id} or "audit" would be read as an id."""
    logger.info("Audit reactions requested | errors_only=%s reaction_id=%r", errors_only, reaction_id)
    try:
        q = db.query(models.Reaction)
        if reaction_id:
            q = q.filter(models.Reaction.id == reaction_id)
        rows = q.order_by(models.Reaction.name.asc()).all()
        if reaction_id and not rows:
            raise NotFoundError("Reaction not found")

        report, n_err, n_warn = [], 0, 0
        for r in rows:
            findings = audit_reaction(r.mechanism_steps)
            if errors_only:
                findings = [f for f in findings if f["severity"] == "ERROR"]
            if not findings:
                continue
            n_err += sum(1 for f in findings if f["severity"] == "ERROR")
            n_warn += sum(1 for f in findings if f["severity"] == "WARN")
            report.append({"id": r.id, "name": r.name, "findings": findings})
        logger.info("Audit reactions succeeded | checked=%d flagged=%d errors=%d warnings=%d",
                    len(rows), len(report), n_err, n_warn)
        return ok(
            200, "Reaction audit complete",
            checked=len(rows), flagged=len(report), errors=n_err, warnings=n_warn, reactions=report,
        )
    except NotFoundError as e:
        logger.warning("Audit reactions failed | reaction_id=%r reason=%s", reaction_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Audit reactions crashed | errors_only=%s reaction_id=%r", errors_only, reaction_id, exc_info=True)
        return err(500, "Internal server error")


@router.get("/{reaction_id}")
def get_reaction(reaction_id: str, db: Session = Depends(get_db)):
    logger.info("Get reaction requested | reaction_id=%s", reaction_id)
    try:
        r = db.query(models.Reaction).filter(models.Reaction.id == reaction_id).first()
        if not r:
            raise NotFoundError("Reaction not found")
        out = _reaction_out(r, log_issues=True)
        logger.info("Get reaction succeeded | reaction_id=%s steps=%d", reaction_id, len(out["mechanism_steps"]))
        return ok(200, "Reaction fetched successfully", reaction=out)
    except NotFoundError as e:
        logger.warning("Get reaction failed | reaction_id=%s reason=%s", reaction_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Get reaction crashed | reaction_id=%s", reaction_id, exc_info=True)
        return err(500, "Internal server error")