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
    # Leave SMTP_HOST/SMTP_USER/SMTP_PASSWORD blank in .env to disable
    # sending entirely (registration still succeeds either way — see
    # app/mailer.py). Works with any SMTP provider: Gmail (smtp.gmail.com,
    # port 587, an App Password as SMTP_PASSWORD), SendGrid, Mailgun,
    # Amazon SES, Postmark, etc.
    SMTP_HOST: str = os.getenv("SMTP_HOST", "")
    SMTP_PORT: int = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USER: str = os.getenv("SMTP_USER", "")
    SMTP_PASSWORD: str = os.getenv("SMTP_PASSWORD", "")
    SMTP_USE_TLS: bool = os.getenv("SMTP_USE_TLS", "true").lower() == "true"
    SMTP_FROM_EMAIL: str = os.getenv("SMTP_FROM_EMAIL", "no-reply@moleit.app")
    SMTP_FROM_NAME: str = os.getenv("SMTP_FROM_NAME", "MoleIt")
    # Used to build the "Open MoleIt" link in the welcome email.
    FRONTEND_URL: str = os.getenv("FRONTEND_URL", "http://localhost:5173")

    class Config:
        env_file = ".env"


settings = Settings()