import os
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from .logging_config import get_logger

load_dotenv()

logger = get_logger(__name__)

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg2://molapp:molapp@localhost:5432/molecular_study_app",
)

# Fallback to SQLite automatically if explicitly requested (useful for quick local dev without Postgres)
if os.getenv("USE_SQLITE", "false").lower() == "true":
    DATABASE_URL = "sqlite:///./dev.db"

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

# Never log the raw DATABASE_URL — it can contain credentials. Just log
# which driver/dialect is in play, which is all you need to tell "did it
# pick up Postgres or fall back to SQLite".
logger.info("Database dialect in use: %s", DATABASE_URL.split("://")[0])

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def run_light_migrations():
    """Add-column-if-missing for existing databases, without pulling in a
    full Alembic migration chain. Base.metadata.create_all only creates
    brand-new tables — it silently does nothing for a table that already
    exists but is missing a column a newer version of models.py added
    (e.g. `source`/`pubchem_cid` on `compounds`). ADD COLUMN is valid,
    identical syntax on both SQLite and Postgres, so one code path covers
    local.db and the hosted Supabase database alike.
    """
    from sqlalchemy import inspect, text

    inspector = inspect(engine)

    if "compounds" in inspector.get_table_names():
        existing_cols = {c["name"] for c in inspector.get_columns("compounds")}
        wanted_cols = {
            "source": "VARCHAR",
            "pubchem_cid": "VARCHAR",
            # Richer PubChem data: identifiers, computed descriptors,
            # experimental physical properties, and the structured
            # per-center bonding breakdown behind the interactive Bonding
            # tab. See pubchem.py / models.py for what populates these.
            "geometry_centers": "JSON",
            "inchi": "TEXT",
            "inchikey": "VARCHAR",
            "cas_number": "VARCHAR",
            "synonyms": "JSON",
            "xlogp": "VARCHAR",
            "exact_mass": "VARCHAR",
            "monoisotopic_mass": "VARCHAR",
            "tpsa": "VARCHAR",
            "complexity": "VARCHAR",
            "charge": "INTEGER",
            "h_bond_donor_count": "INTEGER",
            "h_bond_acceptor_count": "INTEGER",
            "rotatable_bond_count": "INTEGER",
            "heavy_atom_count": "INTEGER",
            "appearance": "VARCHAR",
            "odor": "VARCHAR",
            "melting_point": "VARCHAR",
            "boiling_point": "VARCHAR",
            "density": "VARCHAR",
            "solubility": "VARCHAR",
            "vapor_pressure": "VARCHAR",
            "flash_point": "VARCHAR",
            "stability": "VARCHAR",
        }
        missing = [name for name in wanted_cols if name not in existing_cols]
        if missing:
            logger.info("Migrating 'compounds' table, adding columns: %s", missing)
            with engine.begin() as conn:
                for col_name in missing:
                    conn.execute(text(f"ALTER TABLE compounds ADD COLUMN {col_name} {wanted_cols[col_name]}"))

    if "blog_posts" in inspector.get_table_names():
        existing_blog_cols = {c["name"] for c in inspector.get_columns("blog_posts")}
        if "attachments" not in existing_blog_cols:
            logger.info("Migrating 'blog_posts' table, adding column: attachments")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE blog_posts ADD COLUMN attachments JSON DEFAULT '[]'"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    except Exception:
        logger.error("Database session raised an exception mid-request; rolling back", exc_info=True)
        db.rollback()
        raise
    finally:
        db.close()