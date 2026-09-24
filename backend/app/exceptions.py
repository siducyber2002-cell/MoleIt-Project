"""
Shared, reusable "expected failure" exception types.

Same idea as AssignmentError / WBFSSError in the VLTS Helpdesk service
files: business logic raises one of these instead of building a
JSONResponse itself, and the router's try/except maps each type to a
fixed HTTP status. The difference from VLTS is these are shared across
routers instead of one bespoke class per service file, since this app
has many endpoints that all need the same handful of error shapes
(not found / bad input / conflict / forbidden / upstream failure).

Usage in a router:

    from ..exceptions import NotFoundError, BadRequestError
    from ..responses import ok, err

    @router.get("/{id}")
    def get_thing(id: str, db: Session = Depends(get_db)):
        try:
            thing = db.query(Thing).filter(Thing.id == id).first()
            if not thing:
                raise NotFoundError("Thing not found")
            logger.info("Get thing succeeded | id=%s", id)
            return ok(200, "Thing fetched successfully", thing=serialize(schemas.ThingOut, thing))
        except NotFoundError as e:
            logger.warning("Get thing failed | id=%s reason=%s", id, e)
            return err(404, str(e))
        except Exception:
            logger.error("Get thing crashed | id=%s", id, exc_info=True)
            return err(500, "Internal server error")
"""


class BadRequestError(Exception):
    """Maps to 400 — the request itself was invalid (bad input, missing field value, etc)."""


class UnauthorizedError(Exception):
    """Maps to 401 — credentials missing/invalid for something outside the normal auth dependency."""


class ForbiddenError(Exception):
    """Maps to 403 — authenticated, but not allowed to do this."""


class NotFoundError(Exception):
    """Maps to 404 — the resource doesn't exist."""


class ConflictError(Exception):
    """Maps to 409 — the request conflicts with existing state (duplicate, already assigned, etc)."""


class UpstreamServiceError(Exception):
    """Maps to 502 — a third-party service (PubChem, an RSS feed, etc) responded but with unusable data."""


class UpstreamUnavailableError(Exception):
    """Maps to 503 — a third-party service couldn't be reached at all."""