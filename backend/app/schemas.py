from datetime import datetime
from typing import Optional, Any, List

from pydantic import BaseModel, EmailStr, ConfigDict, Field, field_validator


class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        return v.strip()


class UserLogin(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.strip().lower()


class ForgotPasswordRequest(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.strip().lower()


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    email: EmailStr
    created_at: datetime


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class CompoundOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    common_name: Optional[str] = None
    formula: str
    category: str
    smiles: Optional[str] = None
    molar_mass: Optional[str] = None
    description: Optional[str] = None
    uses: Optional[str] = None
    structure_2d: Optional[Any] = None
    mol_block: Optional[str] = None
    image_hint: Optional[str] = None
    iupac_name: Optional[str] = None
    interesting_facts: Optional[str] = None
    geometry: Optional[str] = None
    hybridization: Optional[str] = None
    bonding_notes: Optional[str] = None
    geometry_centers: Optional[List[Any]] = None
    source: Optional[str] = None
    pubchem_cid: Optional[str] = None

    inchi: Optional[str] = None
    inchikey: Optional[str] = None
    cas_number: Optional[str] = None
    synonyms: Optional[List[str]] = None

    xlogp: Optional[str] = None
    exact_mass: Optional[str] = None
    monoisotopic_mass: Optional[str] = None
    tpsa: Optional[str] = None
    complexity: Optional[str] = None
    charge: Optional[int] = None
    h_bond_donor_count: Optional[int] = None
    h_bond_acceptor_count: Optional[int] = None
    rotatable_bond_count: Optional[int] = None
    heavy_atom_count: Optional[int] = None

    appearance: Optional[str] = None
    odor: Optional[str] = None
    melting_point: Optional[str] = None
    boiling_point: Optional[str] = None
    density: Optional[str] = None
    solubility: Optional[str] = None
    vapor_pressure: Optional[str] = None
    flash_point: Optional[str] = None
    stability: Optional[str] = None


class CompoundFetchRequest(BaseModel):
    query: str


class CompoundMatch(BaseModel):
    source: str
    compound_id: Optional[str] = None
    cid: Optional[str] = None
    name: str
    formula: str
    smiles: Optional[str] = None
    formula_match: Optional[str] = None
    ring_count: Optional[int] = None


class CompoundMatchResolve(BaseModel):
    compound_id: Optional[str] = None
    cid: Optional[str] = None


class NewsArticleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    link: str
    source: str
    summary: Optional[str] = None
    image_url: Optional[str] = None
    published_at: Optional[datetime] = None
    fetched_at: datetime


class NoteCreate(BaseModel):
    title: str
    content: str = ""
    compound_id: Optional[str] = None
    folder: Optional[str] = None
    embedded_molecules: List[Any] = []


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    compound_id: Optional[str] = None
    folder: Optional[str] = None
    embedded_molecules: Optional[List[Any]] = None
    attachments: Optional[List[Any]] = None


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    content: str
    compound_id: Optional[str] = None
    folder: Optional[str] = None
    embedded_molecules: List[Any] = []
    attachments: List[Any] = []
    created_at: datetime
    updated_at: datetime


class BlogPostCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1)


class BlogPostUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    content: Optional[str] = Field(default=None, min_length=1)


class BlogPostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    content: str
    author_id: str
    author_name: str
    attachments: List[Any] = []
    created_at: datetime
    updated_at: datetime


class BlogCommentCreate(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class BlogCommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    post_id: str
    author_id: str
    author_name: str
    content: str
    created_at: datetime


class AttachmentOut(BaseModel):
    id: str
    filename: str
    url: str
    content_type: Optional[str] = None
    size: int


class MoleculeCreate(BaseModel):
    name: str = "Untitled Molecule"
    structure_2d: Any
    derived_formula: Optional[str] = None
    derived_smiles: Optional[str] = None
    is_public: bool = False


class MoleculeUpdate(BaseModel):
    name: Optional[str] = None
    structure_2d: Optional[Any] = None
    derived_formula: Optional[str] = None
    derived_smiles: Optional[str] = None
    is_public: Optional[bool] = None


class MoleculeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    structure_2d: Any
    derived_formula: Optional[str] = None
    derived_smiles: Optional[str] = None
    is_public: bool
    created_at: datetime
    updated_at: datetime


class QuizAttemptCreate(BaseModel):
    score: int
    total: int
    category: Optional[str] = None


class QuizAttemptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    score: int
    total: int
    category: Optional[str] = None
    created_at: datetime


class QuizQuestionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    type: str
    category: str
    difficulty: str
    prompt: str
    sub_prompt: Optional[str] = None
    options: List[str]
    answer: str
    mono: bool
    mol_block: Optional[str] = None
    structure: Optional[Any] = None
    highlight_bond_id: Optional[str] = None


class QuizQuestionIn(BaseModel):
    id: str
    type: str
    category: str
    difficulty: str = "normal"
    prompt: str
    sub_prompt: Optional[str] = None
    options: List[str]
    answer: str
    mono: bool = False
    mol_block: Optional[str] = None
    structure: Optional[Any] = None
    highlight_bond_id: Optional[str] = None


class QuizQuestionBulkIn(BaseModel):
    questions: List[QuizQuestionIn]


class FunctionalGroupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    formula: str
    description: str
    recognition: str
    examples: str
    tier: str
    structure_2d: Any

class ReactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    category: str
    general_equation: str
    reagents: Optional[str] = None
    conditions: Optional[str] = None
    summary: str
    tier: str
    mechanism_steps: List[Any]