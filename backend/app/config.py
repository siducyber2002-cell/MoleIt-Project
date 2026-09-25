import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql://molapp_user:molapp_pass@localhost:5432/molapp_db",
    )
    SECRET_KEY: str = os.getenv("SECRET_KEY", "CHANGE_ME_super_secret_key_dev_only")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    # Gate on the /api/quiz/questions/bulk seeding endpoint -- only the
    # seed script should ever call it. Set a real value in .env for
    # anything beyond local dev.
    QUIZ_SEED_SECRET: str = os.getenv("QUIZ_SEED_SECRET", "dev_seed_secret_change_me")

    # --- Outbound email (welcome email on first-time signup) ---
    # Sent via Resend's HTTP API (port 443) instead of raw SMTP, since
    # Render blocks outbound SMTP ports (587/465) on most plans and Gmail
    # also filters mail originating from hosting-provider IPs. Leave
    # RESEND_API_KEY blank in .env to disable sending entirely
    # (registration still succeeds either way — see app/mailer.py).
    RESEND_API_KEY: str = os.getenv("RESEND_API_KEY", "")
    # Use "onboarding@resend.dev" here until you verify your own domain
    # in Resend (Domains tab) -- then switch to no-reply@yourdomain.com.
    FROM_EMAIL: str = os.getenv("FROM_EMAIL", "onboarding@resend.dev")
    FROM_NAME: str = os.getenv("FROM_NAME", "MoleIt")
    # Used to build the "Open MoleIt" link in the welcome email.
    FRONTEND_URL: str = os.getenv("FRONTEND_URL", "http://localhost:5173")

    class Config:
        env_file = ".env"


settings = Settings()