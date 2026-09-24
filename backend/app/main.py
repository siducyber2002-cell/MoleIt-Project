import os
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .logging_config import setup_logging, get_logger
from .responses import register_exception_handlers, ok
from .database import Base, engine, SessionLocal, run_light_migrations
from .routers import auth as auth_router
from .routers import compounds as compounds_router
from .routers import notes as notes_router
from .routers import molecules as molecules_router
from .routers import quiz as quiz_router
from .routers import news as news_router
from .routers import blog as blog_router
from .routers import functional_groups as functional_groups_router
from .routers import reactions as reactions_router
from .routers import symmetry as symmetry_router
from .routers import spectra as spectra_router
from .routers import structure as structure_router
from .seed import seed_compounds
from . import models, pubchem

# Set up logging BEFORE anything else touches a logger, so every module's
# `get_logger(__name__)` call (routers included) picks up the same
# console + file handlers. See app/logging_config.py.
setup_logging()
logger = get_logger(__name__)

app = FastAPI(
    title="MoleIt API",
    description="Backend for the molecular drawing, 3D viewer, compound library, notes, and quiz app.",
    version="1.0.0",
)

# Every raised HTTPException, every request-validation error, and any
# unhandled exception now goes through these — logged, and returned to
# the client in one consistent {success, status_code, message, ...} shape.
# See app/responses.py for exactly what each one does.
register_exception_handlers(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Logs every single request that hits the API with its method, path,
    resulting status code, and how long it took. This is the fastest way
    to see, end to end, which API call was made and whether it succeeded
    or failed — grep logs/app.log for the path you're testing in Postman.
    """
    start = time.perf_counter()
    logger.info("REQUEST START | %s %s", request.method, request.url.path)
    try:
        response = await call_next(request)
    except Exception:
        # Should rarely trigger — unhandled_exception_handler normally
        # catches this first — but kept as a safety net so a crash still
        # gets logged with timing even if something bypasses the handler.
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        logger.error(
            "REQUEST CRASHED | %s %s | duration_ms=%s",
            request.method, request.url.path, duration_ms, exc_info=True,
        )
        raise
    duration_ms = round((time.perf_counter() - start) * 1000, 2)
    log_level = logger.info if response.status_code < 400 else logger.warning
    log_level(
        "REQUEST END   | %s %s | status=%s | duration_ms=%s",
        request.method, request.url.path, response.status_code, duration_ms,
    )
    return response


UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


def _backfill_pubchem_categories(db):
    """One-time-per-startup fixup: compounds fetched before the category
    classifier existed were stored with category literally set to
    "PubChem" (the data *source*, not a chemistry category) — which is
    what caused the quiz's "which category does X belong to?" question to
    offer "PubChem" as a real answer choice. Re-classify anything still
    carrying that placeholder using the same structural classifier newly
    fetched compounds get. Cheap no-op once everything's been fixed once."""
    stale = db.query(models.Compound).filter(models.Compound.category == "PubChem").all()
    if not stale:
        logger.info("Startup: no stale 'PubChem'-category compounds to backfill")
        return
    for c in stale:
        c.category = pubchem.classify_category(c.formula, c.mol_block)
    db.commit()
    logger.info("Startup: backfilled category for %d compound(s)", len(stale))


@app.on_event("startup")
def on_startup():
    logger.info("Application startup: creating tables / running migrations")
    try:
        Base.metadata.create_all(bind=engine)
        run_light_migrations()
        db = SessionLocal()
        try:
            seed_compounds(db)
            _backfill_pubchem_categories(db)
        finally:
            db.close()
        logger.info("Application startup complete")
    except Exception:
        logger.error("Application startup failed", exc_info=True)
        raise


app.include_router(auth_router.router)
app.include_router(compounds_router.router)
app.include_router(notes_router.router)
app.include_router(molecules_router.router)
app.include_router(quiz_router.router)
app.include_router(news_router.router)
app.include_router(blog_router.router)
app.include_router(functional_groups_router.router)
app.include_router(reactions_router.router)
app.include_router(symmetry_router.router)
app.include_router(spectra_router.router)
app.include_router(structure_router.router)


@app.get("/api/health")
def health_check():
    logger.info("Health check requested")
    return ok(200, "API is healthy", health="ok")