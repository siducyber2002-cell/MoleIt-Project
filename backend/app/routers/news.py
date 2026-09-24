from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from .. import models, news, schemas
from ..database import get_db
from ..logging_config import get_logger
from ..responses import ok, err, serialize_list

logger = get_logger(__name__)

router = APIRouter(prefix="/api/news", tags=["news"])


@router.get("")
def list_news(
    source: Optional[str] = Query(None),
    limit: int = Query(40, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Public, no-auth news feed. Refreshes the cache first if it's gone
    stale — a single dead RSS feed never breaks this endpoint, it just
    contributes zero new articles that round."""
    logger.info("List news requested | source=%r limit=%d", source, limit)
    try:
        if news.needs_refresh(db):
            logger.info("News cache stale, refreshing before serving request")
            try:
                news.fetch_and_cache(db)
            except Exception:
                logger.warning("News refresh failed, serving from existing cache instead", exc_info=True)
        results = news.get_articles(db, source=source, limit=limit)
        logger.info("List news succeeded | returned=%d", len(results))
        return ok(200, "News fetched successfully", articles=serialize_list(schemas.NewsArticleOut, results))
    except Exception:
        logger.error("List news crashed | source=%r limit=%d", source, limit, exc_info=True)
        return err(500, "Internal server error")


@router.get("/sources")
def list_sources():
    logger.info("List news sources requested")
    try:
        sources = [name for name, _ in news.ALL_FEEDS]
        video_sources = sorted(news.VIDEO_SOURCES)
        logger.info("List news sources succeeded | count=%d", len(sources))
        return ok(
            200,
            "News sources fetched successfully",
            sources=sources,
            video_sources=video_sources,
        )
    except Exception:
        logger.error("List news sources crashed", exc_info=True)
        return err(500, "Internal server error")


@router.post("/refresh")
def refresh_news(db: Session = Depends(get_db)):
    """Manual refresh trigger, independent of staleness."""
    logger.info("Manual news refresh requested")
    try:
        added = news.fetch_and_cache(db)
        total = db.query(models.NewsArticle).count()
        logger.info("Manual news refresh succeeded | added=%d total=%d", added, total)
        return ok(200, "News refreshed successfully", added=added, total=total)
    except Exception:
        logger.error("Manual news refresh crashed", exc_info=True)
        return err(500, "Internal server error")