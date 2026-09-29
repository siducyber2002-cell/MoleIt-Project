"""
Response helpers — the single place that defines what every API response
looks like.

SUCCESS (HTTP 2xx)

    {
      "success": true,
      "status": "success",
      "messageCode": 200,               <- always equals the HTTP status
      "message": "Compound fetched successfully",
      "compound": { ... },              <- resource key(s) passed to ok(...)
      "request_id": "a1b2c3d4e5f6",
      "timestamp": "2026-09-28T08:33:11.120+00:00"
    }

ERROR (HTTP 4xx / 5xx)

    {
      "success": false,
      "status": "error",
      "messageCode": 404,
      "errorCode": "NOT_FOUND",         <- stable machine-readable code
      "message": "Compound not found",
      "endpoint": "GET /api/compounds/abc123",   <- which API failed
      "request_id": "a1b2c3d4e5f6",     <- grep this in logs/app.log
      "timestamp": "..."
    }

`endpoint`, `request_id` and `timestamp` are filled in automatically from the
request context that the middleware in main.py sets up, so routers keep
calling exactly what they always did:

    return ok(200, "Compound fetched successfully", compound=...)
    return err(404, "Compound not found")

`errorCode` is derived from the HTTP status (404 -> NOT_FOUND, 502 ->
UPSTREAM_ERROR, ...). A route that needs something more specific can pass
one:  err(409, "Already assigned", error_code="OFFICER_ALREADY_ASSIGNED")

The frontend's axios interceptor reads `messageCode`, `errorCode`, `message`
and `endpoint` from this body to build the error toast, so the user (and you)
can see exactly which API failed and why.

Every router follows the same try/except shape: business logic raises one of
app/exceptions.py's types for an expected failure, the route maps each type
to a status via err(), and a bare `except Exception` is the 500 fallback.

The global handlers at the bottom catch what never reaches a route's own
try/except (the 401 from the auth dependency, request validation failures,
unknown URLs / wrong methods, truly unhandled crashes) and reshape them into
this same envelope.
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .logging_config import endpoint_ctx, get_logger, request_id_ctx

logger = get_logger(__name__)

# HTTP status -> stable errorCode. Anything not listed becomes HTTP_<status>.
_ERROR_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    422: "VALIDATION_ERROR",
    429: "TOO_MANY_REQUESTS",
    500: "INTERNAL_ERROR",
    502: "UPSTREAM_ERROR",
    503: "SERVICE_UNAVAILABLE",
    504: "UPSTREAM_TIMEOUT",
}


def error_code_for(status_code: int) -> str:
    return _ERROR_CODES.get(status_code, f"HTTP_{status_code}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def ok(status_code: int, message: str, **extra: Any) -> JSONResponse:
    content = {
        "success": True,
        "status": "success",
        "messageCode": status_code,
        "message": message,
    }
    content.update(jsonable_encoder(extra))
    content["request_id"] = request_id_ctx.get()
    content["timestamp"] = _now()
    return JSONResponse(status_code=status_code, content=content)


def err(
    status_code: int,
    message: str,
    error_code: Optional[str] = None,
    headers: Optional[dict] = None,
    **extra: Any,
) -> JSONResponse:
    content = {
        "success": False,
        "status": "error",
        "messageCode": status_code,
        "errorCode": error_code or error_code_for(status_code),
        "message": message,
    }
    content.update(jsonable_encoder(extra))
    content["endpoint"] = endpoint_ctx.get()
    content["request_id"] = request_id_ctx.get()
    content["timestamp"] = _now()
    return JSONResponse(status_code=status_code, content=content, headers=headers)


def serialize(schema_cls, orm_obj) -> dict:
    """One ORM row -> plain dict, via its Pydantic *Out schema."""
    return jsonable_encoder(schema_cls.model_validate(orm_obj))


def serialize_list(schema_cls, orm_objs) -> list:
    return [jsonable_encoder(schema_cls.model_validate(o)) for o in orm_objs]


def _ensure_context(request: Request) -> None:
    """The middleware normally sets these. A handler that runs outside it
    (Starlette's last-resort 500 handler sits outside all user middleware)
    would otherwise report endpoint '-', so fill it in from the request."""
    if endpoint_ctx.get() == "-":
        endpoint_ctx.set(f"{request.method} {request.url.path}")
    if request_id_ctx.get() == "-":
        request_id_ctx.set(uuid.uuid4().hex[:12])


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """HTTPException raised outside a route's own try/except — in practice the
    401 from the get_current_user dependency, plus unknown URLs (404) and
    wrong methods (405)."""
    _ensure_context(request)
    message = exc.detail if isinstance(exc.detail, str) and exc.detail else "Request failed"
    logger.warning(
        "HANDLED FAILURE | %s %s | status=%s | detail=%s",
        request.method, request.url.path, exc.status_code, message,
    )
    return err(exc.status_code, message, headers=getattr(exc, "headers", None))


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Request body/query failed Pydantic validation before the route ran."""
    _ensure_context(request)
    errors = jsonable_encoder(exc.errors())
    logger.warning("VALIDATION FAILED | %s %s | errors=%s", request.method, request.url.path, errors)

    # Name the first bad field so the toast says *what* was wrong, not just "422".
    message = "Request validation failed. Check the fields you sent."
    if errors:
        first = errors[0]
        field = ".".join(str(p) for p in first.get("loc", []) if p not in ("body", "query", "path"))
        detail = first.get("msg", "")
        if field and detail:
            message = f"Invalid '{field}': {detail}"
    return err(status.HTTP_422_UNPROCESSABLE_ENTITY, message, errors=errors)


def unhandled_exception_response(exc: Exception) -> JSONResponse:
    """Builds the 500 for anything nobody handled. Full traceback goes to
    logs/error.log; the client only ever sees a generic message plus the
    request_id to quote."""
    logger.error("UNHANDLED EXCEPTION | %s", endpoint_ctx.get(), exc_info=exc)
    return err(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Fallback registered with FastAPI. The request middleware in main.py
    catches these first (so the response still passes through CORS); this
    only fires if something crashes outside that middleware."""
    _ensure_context(request)
    return unhandled_exception_response(exc)


def register_exception_handlers(app) -> None:
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)