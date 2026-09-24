"""
Centralized logging setup for the whole backend.

Every router/module should get its logger the same way:

    from ..logging_config import get_logger
    logger = get_logger(__name__)

    logger.info("Something happened")
    logger.warning("Expected failure: %s", reason)
    logger.error("Unexpected failure", exc_info=True)

This writes to three places at once:
  - console (stdout)                -> what you see when running uvicorn
  - logs/app.log                    -> everything (INFO and above), rotates at 5MB x 5 files
  - logs/error.log                  -> ERROR and above only, so failures are easy to grep for

Call setup_logging() once on app startup (main.py does this). get_logger()
also calls it defensively so any module can safely import and use a logger
even before main.py has run (e.g. in a script or a test).
"""

import logging
import logging.handlers
import os

# backend/logs  (backend/app/.. -> backend)
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

APP_LOG_FILE = os.path.join(LOG_DIR, "app.log")
ERROR_LOG_FILE = os.path.join(LOG_DIR, "error.log")

LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

_configured = False


def setup_logging(level: int = logging.INFO) -> None:
    """Idempotent — safe to call multiple times (e.g. once from main.py's
    startup and again from get_logger() if a module is imported first)."""
    global _configured
    if _configured:
        return

    root = logging.getLogger()
    root.setLevel(level)

    formatter = logging.Formatter(LOG_FORMAT, DATE_FORMAT)

    # 1. Console — same format everywhere so console and file logs match
    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    root.addHandler(console_handler)

    # 2. Rotating file — everything
    file_handler = logging.handlers.RotatingFileHandler(
        APP_LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    # 3. Rotating file — errors only, so "what failed today" is one file
    error_handler = logging.handlers.RotatingFileHandler(
        ERROR_LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(formatter)
    root.addHandler(error_handler)

    # Quiet down noisy third-party access logs; our own request-logging
    # middleware (see main.py) already logs every request with more useful
    # detail (status code, duration).
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    _configured = True


def get_logger(name: str) -> logging.Logger:
    setup_logging()
    return logging.getLogger(name)