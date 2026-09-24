from typing import Optional

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import settings
from ..database import get_db
from ..auth import get_current_user
from ..exceptions import UnauthorizedError
from ..logging_config import get_logger
from ..responses import ok, err, serialize, serialize_list

logger = get_logger(__name__)

router = APIRouter(prefix="/api/quiz", tags=["quiz"])

# Mirrors the category -> type mapping that used to live in
# pickQuizQuestions() in quizGenerator.js.
_CATEGORY_TYPES = {
    "compounds": [
        "compoundName", "compoundFormula", "compoundFrom2D", "compoundSmiles",
        "hybridization", "bondOrder", "molarMass", "iupacName",
        "compoundCategory", "compoundUse", "elementCount",
        "degreeOfUnsaturation", "nmrPeakCount",
    ],
    "groups": ["functionalGroup", "formalCharge"],
    "elements": ["elementSymbol", "elementName", "atomicNumber", "atomicMass", "elementCategory"],
}


def _filtered(db: Session, category: str, difficulty: str):
    query = db.query(models.QuizQuestion)
    if category and category != "all":
        query = query.filter(models.QuizQuestion.type.in_(_CATEGORY_TYPES.get(category, [])))
    if difficulty and difficulty != "all":
        query = query.filter(models.QuizQuestion.difficulty == difficulty)
    return query


@router.get("/questions/count")
def count_questions(
    category: str = Query("all"),
    difficulty: str = Query("all"),
    db: Session = Depends(get_db),
):
    logger.info("Count questions requested | category=%r difficulty=%r", category, difficulty)
    try:
        count = _filtered(db, category, difficulty).count()
        logger.info("Count questions succeeded | category=%r difficulty=%r count=%d", category, difficulty, count)
        return ok(200, "Question count fetched successfully", count=count)
    except Exception:
        logger.error("Count questions crashed | category=%r difficulty=%r", category, difficulty, exc_info=True)
        return err(500, "Internal server error")


@router.get("/questions")
def get_questions(
    category: str = Query("all"),
    difficulty: str = Query("all"),
    limit: int = Query(10, ge=1, le=100),
    db: Session = Depends(get_db),
):
    logger.info("Get questions requested | category=%r difficulty=%r limit=%d", category, difficulty, limit)
    try:
        results = _filtered(db, category, difficulty).order_by(func.random()).limit(limit).all()
        logger.info("Get questions succeeded | returned=%d", len(results))
        return ok(200, "Questions fetched successfully", questions=serialize_list(schemas.QuizQuestionOut, results))
    except Exception:
        logger.error("Get questions crashed | category=%r difficulty=%r", category, difficulty, exc_info=True)
        return err(500, "Internal server error")


@router.get("/questions/by-compound/{compound_id}")
def get_questions_for_compound(compound_id: str, db: Session = Depends(get_db)):
    """Powers the 'Quiz' tab on a single compound's detail page."""
    logger.info("Get questions for compound requested | compound_id=%s", compound_id)
    try:
        results = (
            db.query(models.QuizQuestion)
            .filter(models.QuizQuestion.id.like(f"%\\_{compound_id}", escape="\\"))
            .all()
        )
        logger.info("Get questions for compound succeeded | compound_id=%s returned=%d", compound_id, len(results))
        return ok(200, "Questions fetched successfully", questions=serialize_list(schemas.QuizQuestionOut, results))
    except Exception:
        logger.error("Get questions for compound crashed | compound_id=%s", compound_id, exc_info=True)
        return err(500, "Internal server error")


@router.post("/questions/bulk")
def bulk_upsert_questions(
    payload: schemas.QuizQuestionBulkIn,
    x_seed_secret: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    """Upserts a batch of pre-generated questions. Internal-only — called
    by frontend/scripts/seedQuizQuestions.mjs, gated by QUIZ_SEED_SECRET."""
    logger.info("Bulk upsert questions requested | count=%d", len(payload.questions))
    try:
        if x_seed_secret != settings.QUIZ_SEED_SECRET:
            raise UnauthorizedError("Invalid seed secret")

        ids = [q.id for q in payload.questions]
        existing = {
            row.id: row
            for row in db.query(models.QuizQuestion).filter(models.QuizQuestion.id.in_(ids)).all()
        }

        inserted = updated = 0
        for q in payload.questions:
            row = existing.get(q.id)
            if row:
                for field, value in q.model_dump(exclude={"id"}).items():
                    setattr(row, field, value)
                updated += 1
            else:
                db.add(models.QuizQuestion(**q.model_dump()))
                inserted += 1

        db.commit()
        logger.info("Bulk upsert questions succeeded | inserted=%d updated=%d total_received=%d", inserted, updated, len(payload.questions))
        return ok(
            200, "Quiz questions upserted successfully",
            inserted=inserted, updated=updated, total_received=len(payload.questions),
        )
    except UnauthorizedError as e:
        logger.warning("Bulk upsert questions failed: %s", e)
        return err(401, str(e))
    except Exception:
        logger.error("Bulk upsert questions crashed", exc_info=True)
        return err(500, "Internal server error")


@router.get("/attempts")
def list_attempts(
    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)
):
    logger.info("Listing quiz attempts for user_id=%s", current_user.id)
    try:
        results = (
            db.query(models.QuizAttempt)
            .filter(models.QuizAttempt.owner_id == current_user.id)
            .order_by(models.QuizAttempt.created_at.desc())
            .limit(20)
            .all()
        )
        logger.info("Listing quiz attempts succeeded | user_id=%s count=%d", current_user.id, len(results))
        return ok(200, "Quiz attempts fetched successfully", attempts=serialize_list(schemas.QuizAttemptOut, results))
    except Exception:
        logger.error("Listing quiz attempts crashed | user_id=%s", current_user.id, exc_info=True)
        return err(500, "Internal server error")


@router.post("/attempts")
def create_attempt(
    payload: schemas.QuizAttemptCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logger.info(
        "Create quiz attempt requested | user_id=%s score=%s total=%s category=%r",
        current_user.id, payload.score, payload.total, payload.category,
    )
    try:
        attempt = models.QuizAttempt(
            owner_id=current_user.id,
            score=payload.score,
            total=payload.total,
            category=payload.category,
        )
        db.add(attempt)
        db.commit()
        db.refresh(attempt)
        logger.info("Create quiz attempt succeeded | user_id=%s attempt_id=%s", current_user.id, attempt.id)
        return ok(201, "Quiz attempt recorded successfully", attempt=serialize(schemas.QuizAttemptOut, attempt))
    except Exception:
        logger.error("Create quiz attempt crashed | user_id=%s", current_user.id, exc_info=True)
        return err(500, "Internal server error")