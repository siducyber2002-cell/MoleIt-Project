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

    class Config:
        env_file = ".env"


settings = Settings()
