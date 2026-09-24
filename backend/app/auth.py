import os
from datetime import datetime, timedelta
from typing import Optional

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from .database import get_db
from .logging_config import get_logger
from . import models

logger = get_logger(__name__)

SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days
RESET_TOKEN_EXPIRE_MINUTES = 30

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


def hash_password(password: str) -> str:
    pw_bytes = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pw_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    pw_bytes = plain.encode("utf-8")[:72]
    return bcrypt.checkpw(pw_bytes, hashed.encode("utf-8"))


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    token = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    logger.info("Issued access token for sub=%s, expires=%s", data.get("sub"), expire.isoformat())
    return token


def create_password_reset_token(user_id: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=RESET_TOKEN_EXPIRE_MINUTES)
    to_encode = {"sub": user_id, "type": "reset", "exp": expire}
    token = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    logger.info("Issued password reset token for sub=%s, expires=%s", user_id, expire.isoformat())
    return token


def verify_password_reset_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError as exc:
        logger.warning("Reset token rejected: could not decode/verify (%s)", exc)
        return None
    if payload.get("type") != "reset":
        logger.warning("Reset token rejected: wrong token type")
        return None
    return payload.get("sub")


def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if token is None:
        logger.warning("Auth failed: no bearer token provided on request")
        raise credentials_exception
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            logger.warning("Auth failed: token payload missing 'sub' claim")
            raise credentials_exception
    except JWTError as exc:
        logger.warning("Auth failed: could not decode/verify JWT (%s)", exc)
        raise credentials_exception

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        logger.warning("Auth failed: token valid but user_id=%s no longer exists", user_id)
        raise credentials_exception
    return user