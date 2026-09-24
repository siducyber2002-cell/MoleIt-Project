from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..auth import (
    hash_password,
    verify_password,
    create_access_token,
    create_password_reset_token,
    verify_password_reset_token,
    get_current_user,
)
from ..exceptions import BadRequestError, UnauthorizedError
from ..logging_config import get_logger
from ..responses import ok, err, serialize

logger = get_logger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register")
def register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    logger.info("Register attempt for email=%s", payload.email)
    try:
        existing = db.query(models.User).filter(models.User.email == payload.email).first()
        if existing:
            raise BadRequestError("Email already registered")

        user = models.User(
            name=payload.name,
            email=payload.email,
            hashed_password=hash_password(payload.password),
        )
        db.add(user)
        db.commit()
        db.refresh(user)

        token = create_access_token({"sub": user.id})
        logger.info("Register success for email=%s, user_id=%s", payload.email, user.id)
        return ok(
            201, "User registered successfully",
            access_token=token, token_type="bearer", user=serialize(schemas.UserOut, user),
        )
    except BadRequestError as e:
        logger.warning("Register failed for email=%s: %s", payload.email, e)
        return err(400, str(e))
    except Exception:
        logger.error("Register crashed for email=%s", payload.email, exc_info=True)
        return err(500, "Internal server error")


@router.post("/login")
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    logger.info("Login attempt for email=%s", payload.email)
    try:
        user = db.query(models.User).filter(models.User.email == payload.email).first()
        if not user or not verify_password(payload.password, user.hashed_password):
            raise UnauthorizedError("Invalid email or password")

        token = create_access_token({"sub": user.id})
        logger.info("Login success for email=%s, user_id=%s", payload.email, user.id)
        return ok(
            200, "Login successful",
            access_token=token, token_type="bearer", user=serialize(schemas.UserOut, user),
        )
    except UnauthorizedError as e:
        logger.warning("Login failed for email=%s: %s", payload.email, e)
        return err(401, str(e))
    except Exception:
        logger.error("Login crashed for email=%s", payload.email, exc_info=True)
        return err(500, "Internal server error")


@router.post("/forgot-password")
def forgot_password(payload: schemas.ForgotPasswordRequest, db: Session = Depends(get_db)):
    logger.info("Forgot-password requested for email=%s", payload.email)
    try:
        user = db.query(models.User).filter(models.User.email == payload.email).first()

        reset_token = None
        if user:
            reset_token = create_password_reset_token(user.id)
            logger.info("Password reset token issued for user_id=%s", user.id)

        return ok(
            200,
            "If that email is registered, a password reset link has been generated.",
            reset_token=reset_token,
        )
    except Exception:
        logger.error("Forgot-password crashed for email=%s", payload.email, exc_info=True)
        return err(500, "Internal server error")


@router.post("/reset-password")
def reset_password(payload: schemas.ResetPasswordRequest, db: Session = Depends(get_db)):
    logger.info("Reset-password attempt")
    try:
        user_id = verify_password_reset_token(payload.token)
        if not user_id:
            raise BadRequestError("This reset link is invalid or has expired.")

        user = db.query(models.User).filter(models.User.id == user_id).first()
        if not user:
            raise BadRequestError("This reset link is invalid or has expired.")

        user.hashed_password = hash_password(payload.new_password)
        db.commit()
        logger.info("Password reset successful for user_id=%s", user.id)
        return ok(200, "Password updated successfully. You can now log in with your new password.")
    except BadRequestError as e:
        logger.warning("Reset-password failed: %s", e)
        return err(400, str(e))
    except Exception:
        logger.error("Reset-password crashed", exc_info=True)
        return err(500, "Internal server error")


@router.get("/me")
def me(current_user: models.User = Depends(get_current_user)):
    try:
        logger.info("Fetched current user profile: user_id=%s", current_user.id)
        return ok(200, "User profile fetched successfully", user=serialize(schemas.UserOut, current_user))
    except Exception:
        logger.error("Fetch current user crashed | user_id=%s", current_user.id, exc_info=True)
        return err(500, "Internal server error")