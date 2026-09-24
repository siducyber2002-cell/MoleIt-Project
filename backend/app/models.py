import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, Text, DateTime, ForeignKey, JSON, Boolean, Integer
)
from sqlalchemy.orm import relationship

from .database import Base


def gen_uuid():
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    notes = relationship("Note", back_populates="owner", cascade="all, delete-orphan")
    molecules = relationship("UserMolecule", back_populates="owner", cascade="all, delete-orphan")
    quiz_attempts = relationship("QuizAttempt", back_populates="owner", cascade="all, delete-orphan")
    blog_posts = relationship("BlogPost", back_populates="author", cascade="all, delete-orphan")


class Compound(Base):
    """Library of well-known / famous compounds, seeded on startup."""
    __tablename__ = "compounds"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False, index=True)
    common_name = Column(String, nullable=True)
    formula = Column(String, nullable=False)
    category = Column(String, nullable=False, index=True)
    smiles = Column(String, nullable=True)
    molar_mass = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    uses = Column(Text, nullable=True)
    structure_2d = Column(JSON, nullable=True)
    mol_block = Column(Text, nullable=True)
    image_hint = Column(String, nullable=True)
    iupac_name = Column(String, nullable=True)
    interesting_facts = Column(Text, nullable=True)
    geometry = Column(String, nullable=True)
    hybridization = Column(String, nullable=True)
    bonding_notes = Column(Text, nullable=True)
    # Structured per-center breakdown (element, geometry, hybridization,
    # lone pairs, plain-English reason) powering the interactive Bonding
    # tab's hover explanation — see pubchem.compute_geometry_summary.
    geometry_centers = Column(JSON, nullable=True)
    # "curated" (from compounds_seed.json) or "pubchem" (fetched live and
    # cached on first search). pubchem_cid lets a re-search of the same
    # name short-circuit straight to the cached row instead of re-fetching.
    source = Column(String, nullable=True, default="curated")
    pubchem_cid = Column(String, nullable=True, index=True)

    # ---- Identifiers ----
    inchi = Column(Text, nullable=True)
    inchikey = Column(String, nullable=True)
    cas_number = Column(String, nullable=True)
    synonyms = Column(JSON, nullable=True)

    # ---- Computed descriptors (PubChem property table) ----
    xlogp = Column(String, nullable=True)
    exact_mass = Column(String, nullable=True)
    monoisotopic_mass = Column(String, nullable=True)
    tpsa = Column(String, nullable=True)
    complexity = Column(String, nullable=True)
    charge = Column(Integer, nullable=True)
    h_bond_donor_count = Column(Integer, nullable=True)
    h_bond_acceptor_count = Column(Integer, nullable=True)
    rotatable_bond_count = Column(Integer, nullable=True)
    heavy_atom_count = Column(Integer, nullable=True)

    # ---- Experimental / descriptive physical properties (PUG View,
    # best-effort — PubChem simply doesn't have these for every compound) ----
    appearance = Column(String, nullable=True)
    odor = Column(String, nullable=True)
    melting_point = Column(String, nullable=True)
    boiling_point = Column(String, nullable=True)
    density = Column(String, nullable=True)
    solubility = Column(String, nullable=True)
    vapor_pressure = Column(String, nullable=True)
    flash_point = Column(String, nullable=True)
    stability = Column(String, nullable=True)


class Note(Base):
    __tablename__ = "notes"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    compound_id = Column(String, ForeignKey("compounds.id"), nullable=True)
    folder = Column(String, nullable=True)  # e.g. "Molecules", "Reactions", "Exam Notes"
    embedded_molecules = Column(JSON, nullable=False, default=list)
    attachments = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner = relationship("User", back_populates="notes")


class UserMolecule(Base):
    """A molecule drawn and saved by a student in the Draw Lab."""
    __tablename__ = "user_molecules"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False, default="Untitled Molecule")
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    structure_2d = Column(JSON, nullable=False)
    derived_formula = Column(String, nullable=True)
    derived_smiles = Column(String, nullable=True)
    is_public = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner = relationship("User", back_populates="molecules")


class NewsArticle(Base):
    """A chemistry/science news item pulled from a public RSS feed and
    cached, so the News page doesn't hit 4+ external feeds on every load
    (see app/news.py for the fetch/refresh logic)."""
    __tablename__ = "news_articles"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, nullable=False)
    link = Column(String, nullable=False, unique=True, index=True)
    source = Column(String, nullable=False, index=True)
    summary = Column(Text, nullable=True)
    image_url = Column(String, nullable=True)
    published_at = Column(DateTime, nullable=True)
    fetched_at = Column(DateTime, default=datetime.utcnow, index=True)


class BlogPost(Base):
    """A student-written update or research write-up, visible to everyone
    (not just the author) — the site's public blog/community feed. Can
    carry file attachments (data, images, writeups) and a comment thread."""
    __tablename__ = "blog_posts"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    author_id = Column(String, ForeignKey("users.id"), nullable=False)
    attachments = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    author = relationship("User", back_populates="blog_posts")
    comments = relationship(
        "BlogComment", back_populates="post", cascade="all, delete-orphan",
        order_by="BlogComment.created_at",
    )

    @property
    def author_name(self):
        return self.author.name if self.author else "Unknown"


class BlogComment(Base):
    """A comment on a BlogPost — lets the community discuss a post/research
    update instead of just reading it."""
    __tablename__ = "blog_comments"

    id = Column(String, primary_key=True, default=gen_uuid)
    post_id = Column(String, ForeignKey("blog_posts.id"), nullable=False, index=True)
    author_id = Column(String, ForeignKey("users.id"), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    post = relationship("BlogPost", back_populates="comments")
    author = relationship("User")

    @property
    def author_name(self):
        return self.author.name if self.author else "Unknown"


class QuizAttempt(Base):
    """A completed quiz session's score, for the student's progress history."""
    __tablename__ = "quiz_attempts"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    score = Column(Integer, nullable=False)
    total = Column(Integer, nullable=False)
    category = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="quiz_attempts")


class FunctionalGroup(Base):
    """Functional Group Library, seeded on startup from
    data/functional_groups_seed.json. id is the human-readable slug
    (e.g. "carboxylic-acid") rather than a random uuid, since the
    frontend already keys quiz questions and Draw Lab state off this
    same slug — keeping it stable across the JS-data era and the
    DB-backed era avoids a breaking migration for anything that
    references a group by id."""
    __tablename__ = "functional_groups"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, index=True)
    formula = Column(String, nullable=False)
    description = Column(Text, nullable=False)
    recognition = Column(Text, nullable=False)
    examples = Column(Text, nullable=False)
    # "core" (standard undergrad organic chemistry) or "advanced"
    # (specialized/second-year+ groups) — see FunctionalGroupsPage's tier filter.
    tier = Column(String, nullable=False, default="core", index=True)
    structure_2d = Column(JSON, nullable=False)


class QuizQuestion(Base):
    """Pre-generated quiz question bank, populated by
    frontend/scripts/seedQuizQuestions.mjs (which runs the same
    generateQuestionPool logic that used to run client-side, then bulk
    upserts the result via POST /api/quiz/questions/bulk). id is
    deterministic per-question (see quizGenerator.js), which is what
    makes that upsert safe to re-run.

    NOTE: reconstructed from routers/quiz.py's usage and
    seedQuizQuestions.mjs's toBackendShape() after an earlier accidental
    overwrite -- if any column here doesn't match what's actually in
    your Supabase table yet, the safest fix is dropping and
    re-`create_all`-ing this table, then re-running the seed script,
    rather than hand-editing rows.
    """
    __tablename__ = "quiz_questions"

    id = Column(String, primary_key=True)
    type = Column(String, nullable=False, index=True)
    category = Column(String, nullable=False, index=True)
    difficulty = Column(String, nullable=False, default="normal", index=True)
    prompt = Column(Text, nullable=False)
    sub_prompt = Column(Text, nullable=True)
    options = Column(JSON, nullable=False)  # list[str]
    answer = Column(String, nullable=False)
    mono = Column(Boolean, nullable=False, default=False)
    mol_block = Column(Text, nullable=True)
    structure = Column(JSON, nullable=True)
    highlight_bond_id = Column(String, nullable=True)


class Reaction(Base):
    """Named-reaction flashcard library, seeded on startup from
    data/reactions_seed.json — same upsert-by-id pattern as
    FunctionalGroup. id is a human-readable slug (e.g.
    "sn2-substitution"). Front of the flashcard shows general_equation +
    reagents/conditions; back steps through mechanism_steps, each of
    which is a self-contained {atoms, bonds, arrows, title, description}
    diagram (same atom/bond shape FunctionalGroup.structure_2d and
    Compound.structure_2d already use, plus an "arrows" list for
    electron-pushing curves — see MechanismStepDiagram.jsx)."""
    __tablename__ = "reactions"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, index=True)
    # e.g. "Substitution", "Elimination", "Addition", "Named Reaction"
    category = Column(String, nullable=False, index=True)
    general_equation = Column(String, nullable=False)
    reagents = Column(String, nullable=True)
    conditions = Column(String, nullable=True)
    summary = Column(Text, nullable=False)
    # "core" or "advanced" — same tier-filter convention as FunctionalGroup.
    tier = Column(String, nullable=False, default="core", index=True)
    # list[{ title, description, atoms, bonds, arrows }]
    mechanism_steps = Column(JSON, nullable=False)