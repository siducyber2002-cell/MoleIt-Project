import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .logging_config import setup_logging, get_logger, request_id_ctx, endpoint_ctx
from .responses import register_exception_handlers, unhandled_exception_response, ok, err
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
# unhandled exception goes through these — logged, and returned in the one
# standard envelope (messageCode / status / errorCode / message / endpoint /
# request_id). See app/responses.py for exactly what each one does.
register_exception_handlers(app)


# ---------------------------------------------------------------------------
# Middleware order matters. Starlette makes the LAST-added middleware the
# OUTERMOST one, so the request-context middleware is added first and CORS
# last. That way every response — including the 500 built here for a crash —
# still passes through CORS and carries its headers. Without that, the browser
# reports a bare "Network Error" instead of the real status/endpoint, and the
# frontend toast can't tell you which API failed.
# ---------------------------------------------------------------------------
@app.middleware("http")
async def request_context(request: Request, call_next):
    """For every request: assign a request id, bind it (and the endpoint) to
    the logging context, log start/end with status + duration, turn any
    unhandled crash into the standard 500 envelope, and echo the id back in
    the X-Request-ID header. grep the id from a toast in logs/app.log to see
    everything that happened during that one request."""
    rid = (request.headers.get("x-request-id") or uuid.uuid4().hex[:12])[:64]
    endpoint = f"{request.method} {request.url.path}"
    rid_token = request_id_ctx.set(rid)
    endpoint_token = endpoint_ctx.set(endpoint)
    start = time.perf_counter()
    try:
        logger.info("REQUEST START | %s", endpoint)
        try:
            response = await call_next(request)
        except Exception as exc:
            response = unhandled_exception_response(exc)

        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        response.headers["X-Request-ID"] = rid
        if response.status_code >= 500:
            log = logger.error
        elif response.status_code >= 400:
            log = logger.warning
        else:
            log = logger.info
        log("REQUEST END   | %s | status=%s | duration_ms=%s", endpoint, response.status_code, duration_ms)
        return response
    finally:
        request_id_ctx.reset(rid_token)
        endpoint_ctx.reset(endpoint_token)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Lets the browser read these from cross-origin responses.
    expose_headers=["X-Request-ID", "Content-Disposition", "X-Report-Filename"],
)


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
    # BUG FIX: this used to `raise` on any failure here, which — under
    # FastAPI/Uvicorn — aborts ASGI lifespan startup and takes the entire
    # process down before it ever binds a port. That meant a single bad
    # dependency (most commonly: the Postgres/Supabase DB being paused,
    # asleep, or briefly unreachable) didn't just break DB-backed routes —
    # it took down routes that don't touch the database at all, including
    # the Group Theory / PubChem symmetry endpoints (/api/symmetry/*),
    # which are otherwise fully self-contained. Now a startup failure here
    # is logged loudly but never prevents the API from coming up, so those
    # DB-independent routes keep working even if the database is down.
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
        logger.error(
            "Application startup failed while initializing the database. "
            "The API will still come up and serve database-independent "
            "routes (e.g. /api/symmetry/*), but anything touching the "
            "database will error until this is fixed.",
            exc_info=True,
        )


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
    try:
        return ok(200, "API is healthy", health="ok")
    except Exception:
        logger.error("Health check crashed", exc_info=True)
        return err(500, "Internal server error")