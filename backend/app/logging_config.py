"""
Centralized logging setup for the whole backend.

Every router/module gets its logger the same way:

    from ..logging_config import get_logger
    logger = get_logger(__name__)

    logger.info("Something happened")
    logger.warning("Expected failure: %s", reason)
    logger.error("Unexpected failure", exc_info=True)

Every log line carries the request id of the request that produced it:

    2026-09-28 14:03:11 | ERROR    | rid=a1b2c3d4e5f6 | app.routers.compounds | Fetch external compound crashed

The same id is returned to the client in the JSON body (`request_id`) and in
the `X-Request-ID` response header, so a toast on the frontend can be matched
to the exact log lines (and stack trace) in one grep:

    grep a1b2c3d4e5f6 logs/app.log

Output goes to three places:
  - console (stdout)   -> what you see when running uvicorn / Render's log tab
  - logs/app.log       -> everything (INFO and above), rotates at 5MB x 5 files
  - logs/error.log     -> ERROR and above only

Call setup_logging() once on startup (main.py does). get_logger() also calls
it defensively so scripts/tests can import a logger safely.
"""

import logging
import logging.handlers
import os
from contextvars import ContextVar

# Set per request by the middleware in main.py. Contextvars (not globals) so
# concurrent requests never see each other's ids.
request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")
endpoint_ctx: ContextVar[str] = ContextVar("endpoint", default="-")

# backend/logs  (backend/app/.. -> backend)
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

APP_LOG_FILE = os.path.join(LOG_DIR, "app.log")
ERROR_LOG_FILE = os.path.join(LOG_DIR, "error.log")

LOG_FORMAT = "%(asctime)s | %(levelname)-8s | rid=%(request_id)s | %(name)s | %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

_configured = False


class _RequestContextFilter(logging.Filter):
    """Stamps every record (ours and third-party) with the current request id."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get()
        record.endpoint = endpoint_ctx.get()
        return True


def setup_logging(level: int = logging.INFO) -> None:
    """Idempotent — safe to call multiple times."""
    global _configured
    if _configured:
        return

    root = logging.getLogger()
    root.setLevel(level)

    formatter = logging.Formatter(LOG_FORMAT, DATE_FORMAT)
    context_filter = _RequestContextFilter()

    # 1. Console
    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    console_handler.addFilter(context_filter)
    root.addHandler(console_handler)

    # 2. Rotating file — everything
    file_handler = logging.handlers.RotatingFileHandler(
        APP_LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)
    file_handler.addFilter(context_filter)
    root.addHandler(file_handler)

    # 3. Rotating file — errors only
    error_handler = logging.handlers.RotatingFileHandler(
        ERROR_LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(formatter)
    error_handler.addFilter(context_filter)
    root.addHandler(error_handler)

    # Our request middleware (main.py) already logs every request with status
    # and duration, so uvicorn's own access log would just be a duplicate.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    _configured = True


def get_logger(name: str) -> logging.Logger:
    setup_logging()
    return logging.getLogger(name)