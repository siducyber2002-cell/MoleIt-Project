"""
Response helpers matching the existing house style (see
nodal_officer_assignment_routes.py etc):

    {
      "messageCode": 200,
      "status": "success",
      "message": "Nodal officer assigned successfully",
      "data": { ... }          <- or whatever resource-specific key(s) fit
    }

`messageCode` is always the same number as the HTTP status code — that's
the convention the existing routes use, so it's kept here rather than
inventing a separate app-specific code space.

    ok(200, "Compound fetched successfully", compound=compound_dict)
    err(404, "Compound not found")

Every router follows the same try/except shape as the VLTS examples:
business logic raises one of app/exceptions.py's exception types for an
expected failure, the route catches specific types first (each mapped to
its HTTP status via err()), then a bare `except Exception` as the 500
fallback. See app/exceptions.py's docstring for the full pattern.

`serialize` / `serialize_list` turn an ORM row into a plain dict via the
matching Pydantic schema in schemas.py — used to build the `compound=`,
`note=`, etc. keyword arguments passed into ok().

The three global handlers at the bottom catch things that never reach a
route's own try/except: a 401 raised by the `get_current_user` auth
dependency (via HTTPException), a request-body validation failure FastAPI
rejects before the route runs, and any truly unhandled crash. All three
are logged and reshaped into the same messageCode/status/message shape so
the response format is consistent everywhere, not just inside routes
that remembered to catch everything.
"""

from typing import Any

from fastapi import Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .logging_config import get_logger

logger = get_logger(__name__)


def ok(status_code: int, message: str, **extra: Any) -> JSONResponse:
    content = {"messageCode": status_code, "status": "success", "message": message}
    content.update(jsonable_encoder(extra))
    return JSONResponse(status_code=status_code, content=content)


def err(status_code: int, message: str, **extra: Any) -> JSONResponse:
    content = {"messageCode": status_code, "status": "error", "message": message}
    content.update(jsonable_encoder(extra))
    return JSONResponse(status_code=status_code, content=content)


def serialize(schema_cls, orm_obj) -> dict:
    """One ORM row -> plain dict, via its Pydantic *Out schema."""
    return jsonable_encoder(schema_cls.model_validate(orm_obj))


def serialize_list(schema_cls, orm_objs) -> list:
    return [jsonable_encoder(schema_cls.model_validate(o)) for o in orm_objs]


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Catches HTTPException raised outside a route's own try/except — in
    practice this is almost always the 401 from the get_current_user auth
    dependency, since that runs before the route body does."""
    logger.warning(
        "HANDLED FAILURE | %s %s | status=%s | detail=%s",
        request.method, request.url.path, exc.status_code, exc.detail,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"messageCode": exc.status_code, "status": "error", "message": str(exc.detail)},
        headers=getattr(exc, "headers", None),
    )


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Request body/query failed Pydantic validation before the route ran."""
    logger.warning(
        "VALIDATION FAILED | %s %s | errors=%s",
        request.method, request.url.path, exc.errors(),
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "messageCode": status.HTTP_422_UNPROCESSABLE_ENTITY,
            "status": "error",
            "message": "Request validation failed. Check the fields you sent.",
            "errors": jsonable_encoder(exc.errors()),
        },
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last-resort catch-all for anything that escaped a route's own
    try/except (a bug in a dependency, a DB connection drop mid-request,
    etc). Full traceback goes to logs/error.log."""
    logger.error(
        "UNHANDLED EXCEPTION | %s %s", request.method, request.url.path, exc_info=exc,
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "messageCode": status.HTTP_500_INTERNAL_SERVER_ERROR,
            "status": "error",
            "message": "Internal server error",
        },
    )


def register_exception_handlers(app) -> None:
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)