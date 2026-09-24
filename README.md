# MoleIt — Molecular Study Lab

Draw it. Understand it. Explore it.

A study app built around a from-scratch 2D molecular editor (the main
attraction), a rotatable 3D viewer, a library of well-known compounds, and a
notes section — all backed by a real molecular graph (atoms + bonds), not an
image.

## Stack

- **Frontend:** React + Vite + Tailwind CSS v4, `lucide-react` icons,
  `3Dmol.js` (via CDN) for the interactive 3D viewer.
- **Backend:** FastAPI + SQLAlchemy, JWT auth, seeded compound library.
- **Database:** PostgreSQL (SQLite works too for quick local testing — see below).

## Project structure

```
moleit/
├── backend/                 FastAPI app
│   ├── app/
│   │   ├── main.py          App entrypoint, CORS, router mounting
│   │   ├── config.py        Settings (env vars)
│   │   ├── database.py      SQLAlchemy engine/session
│   │   ├── models.py        ORM models (User, Compound, Note, Molecule)
│   │   ├── schemas.py       Pydantic request/response schemas
│   │   ├── auth.py          Password hashing + JWT helpers
│   │   ├── seed.py          Seeds the compound library on startup
│   │   ├── data/
│   │   │   └── compounds_seed.json   20 famous compounds (2D graph + 3D mol block)
│   │   └── routers/
│   │       ├── auth.py      register / login / me
│   │       ├── compounds.py library list/detail/categories
│   │       ├── notes.py     personal notes CRUD
│   │       └── molecules.py user-drawn molecule save/list/delete
│   ├── requirements.txt
│   └── Dockerfile
│
├── frontend/                 React app
│   ├── src/
│   │   ├── lib/
│   │   │   ├── elements.js   Element data (CPK colors, valence), formula/SMILES derivation
│   │   │   └── molblock.js   Converts our atoms/bonds graph → MOL block for 3Dmol.js
│   │   ├── components/
│   │   │   ├── DrawLab/      DrawCanvas, Toolbar, AtomPalette, PropertiesPanel
│   │   │   ├── Viewer3D/     Molecule3DViewer (3Dmol.js wrapper)
│   │   │   ├── Library/      CompoundCard
│   │   │   └── Navbar.jsx
│   │   ├── pages/            Home, DrawLabPage, LibraryPage, CompoundDetailPage,
│   │   │                     NotesPage, MyMoleculesPage, Login, Register
│   │   ├── context/AuthContext.jsx
│   │   └── api/api.js        Axios client
│   └── Dockerfile
│
└── docker-compose.yml
```

## Quick start (Docker)

```bash
docker compose up --build
```

- Frontend: http://localhost:5173
- Backend docs (Swagger): http://localhost:8000/docs
- Postgres: localhost:5432 (user `molapp_user` / pass `molapp_pass` / db `molapp_db`)

The backend automatically creates its tables and seeds the 20-compound
library on first startup.

## Manual local dev (no Docker)

### Backend

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Easiest: run against SQLite for local testing (no Postgres needed)
export DATABASE_URL="sqlite:///./local.db"
export SECRET_KEY="dev-secret-change-me"

uvicorn app.main:app --reload
```

To use real PostgreSQL instead, start Postgres locally and set:

```bash
export DATABASE_URL="postgresql://molapp_user:molapp_pass@localhost:5432/molapp_db"
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env   # points VITE_API_URL at http://localhost:8000
npm run dev
```

Visit http://localhost:5173.

## The Draw Lab (main feature)

- **Elements sidebar** — pick an element (C, H, O, N, S, P, halogens, and more
  under "More").
- **Atom tool** — click empty canvas to place the selected element; click an
  existing atom to relabel it; drag from an atom into empty space to grow a
  chain (a new atom is created automatically), or drag onto another atom to
  bond them.
- **Bond tool** — drag between two atoms to connect them. Pick single / double
  / triple before dragging, or click an existing bond to cycle its order.
- **Lone pair tool** — click an atom to cycle 0–3 lone pairs on it.
- **Charge +/− tools** — click an atom to bump its formal charge.
- **Move tool** — drag atoms to reposition them.
- **Erase tool** — click an atom or bond to remove it.
- **Undo/redo**, **clear canvas**, **export as JSON**, and **save** (saved
  molecules land in "My Molecules" and require an account).
- The right-hand panel renders your structure as a live, rotatable 3D model
  as you draw (via 3Dmol.js), and the left panel shows the derived molecular
  formula, molar mass, and an approximate SMILES string in real time.

Everything is stored as a **molecular graph** (`{atoms: [...], bonds: [...]}`),
never as an image — that's what makes the formula/SMILES derivation and the
3D rendering possible.

## Compound Library

20 seeded compounds spanning organic, inorganic, biomolecule, and
pharmaceutical categories (water, methane, ethanol, benzene, caffeine,
aspirin, glucose, ATP, ammonia, and more), each with a real 2D graph and a
MOL block for 3D viewing. Open any compound directly into the Draw Lab to
study or modify its structure.

## Notes

Personal, autosaving notes, optionally linked to a specific compound (e.g.
"Take notes" from a compound's detail page pre-fills the note title).

## Extending it

Natural next steps if you want to keep building:
- A quiz/study mode ("identify this molecule", "name the functional group").
- Aromatic bond rendering + ring templates (benzene, cyclohexane, etc. as a
  single click).
- Wedge/dash stereochemistry bonds.
- A proper 3D conformer generator (currently the 3D view uses your 2D layout
  as flat starting coordinates — connectivity and bond orders are accurate,
  but bond angles aren't energy-minimized).
- Real SMILES parsing (currently a best-effort generator for simple/acyclic
  structures, not a full canonicalizer).