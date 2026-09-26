# MoleIt — Molecular Study Lab

Draw it. Understand it. Explore it.

A full study platform built around a from-scratch 2D molecular editor, a
rotatable 3D viewer, group-theory / point-group symmetry detection, IR &
Raman spectral prediction, reaction lookup, a compound library backed by
PubChem, functional-group reference, quizzes, notes, and a blog/news feed —
all backed by a real molecular graph (atoms + bonds), not an image.

Live: https://moleit.onrender.com

## Features

- **Draw Lab** — 2D molecular editor: place atoms, draw bonds, get an
  auto-derived molecular formula and SMILES as you go.
- **3D Viewer** — every molecule (drawn or from the library) renders as an
  interactive, rotatable 3D structure via 3Dmol.js.
- **Symmetry Lab** — paste/draw a structure and the engine searches its
  actual 3-D geometry for rotations, reflections, inversion, and improper
  rotations, then derives the point group and full character table —
  not a lookup table.
- **Spectra** — predicts which vibrational modes are IR- and Raman-active
  from the derived Γvib representation.
- **Reactions** — a browsable reference of named/common reactions.
- **Functional Groups** — reference library of functional groups.
- **Compound Library** — a seeded set of well-known compounds, extendable by
  fetching new ones from PubChem (with automatic category classification).
- **Quiz** — multiple-choice quizzes with attempt tracking.
- **Notes** — personal notes, per logged-in user.
- **Blog & News** — an in-app blog (with comments) plus an aggregated
  chemistry news feed.
- **Auth** — register / login / forgot-password / reset-password, JWT-based.
  A branded welcome email is sent automatically the moment someone
  registers for the first time (see `backend/app/mailer.py`).

## Stack

- **Frontend:** React 19 + Vite + Tailwind CSS v4, `react-router-dom`,
  `framer-motion` + `lenis` for scroll/animation, `lucide-react` icons,
  `three` and `3Dmol.js` (via CDN) for 3D rendering.
- **Backend:** FastAPI + SQLAlchemy, JWT auth (`python-jose` + `bcrypt`),
  outbound email via stdlib `smtplib`, PubChem integration (`requests`),
  news aggregation (`feedparser`).
- **Database:** PostgreSQL in production (Supabase); SQLite works fine for
  quick local testing.

## Project structure

```
moleit/
├── backend/                        FastAPI app
│   ├── app/
│   │   ├── main.py                 App entrypoint, CORS, request logging, router mounting
│   │   ├── config.py                Settings (all env vars, see below)
│   │   ├── database.py              SQLAlchemy engine/session + light migrations
│   │   ├── models.py                ORM models: User, Compound, Note, UserMolecule,
│   │   │                            NewsArticle, BlogPost, BlogComment, QuizAttempt,
│   │   │                            FunctionalGroup, QuizQuestion, Reaction
│   │   ├── schemas.py               Pydantic request/response schemas
│   │   ├── auth.py                  Password hashing + JWT + reset-token helpers
│   │   ├── mailer.py                Welcome email over SMTP (IPv4-forced for Render)
│   │   ├── logging_config.py        Console + file logging setup (backend/logs/)
│   │   ├── responses.py             Uniform {success, status_code, ...} envelope + exception handlers
│   │   ├── exceptions.py            BadRequestError / UnauthorizedError etc.
│   │   ├── pubchem.py                PubChem fetch + structural category classifier
│   │   ├── seed.py                  Seeds the compound library on startup
│   │   ├── data/
│   │   │   └── compounds_seed.json  Seeded compounds (2D graph + 3D mol block)
│   │   └── routers/
│   │       ├── auth.py              register / login / forgot / reset / me
│   │       ├── compounds.py         library list/detail/categories, PubChem fetch
│   │       ├── notes.py             personal notes CRUD
│   │       ├── molecules.py         user-drawn molecule save/list/delete
│   │       ├── quiz.py               questions + attempt tracking
│   │       ├── news.py               aggregated news feed
│   │       ├── blog.py               posts + comments
│   │       ├── functional_groups.py  functional-group reference
│   │       ├── reactions.py          reaction reference
│   │       ├── symmetry.py           point-group / symmetry-operation detection
│   │       ├── spectra.py            IR/Raman activity prediction
│   │       └── structure.py          structure parsing/normalization helpers
│   ├── requirements.txt
│   ├── .env.example
│   └── Dockerfile
│
├── frontend/                        React app
│   ├── src/
│   │   ├── lib/
│   │   │   ├── elements.js          Element data (CPK colors, valence), formula/SMILES derivation
│   │   │   └── molblock.js          Converts our atoms/bonds graph → MOL block for 3Dmol.js
│   │   ├── components/
│   │   │   ├── DrawLab/             DrawCanvas, Toolbar, AtomPalette, PropertiesPanel
│   │   │   ├── Viewer3D/            Molecule3DViewer (3Dmol.js wrapper)
│   │   │   ├── Library/             CompoundCard
│   │   │   ├── Reactions/           Reaction reference UI
│   │   │   ├── FunctionalGroups/    Functional-group reference UI
│   │   │   ├── auth/                Auth-related UI pieces
│   │   │   ├── home/                Landing-page sections (incl. ReasonStack + indisea.css)
│   │   │   ├── motion/              Shared scroll/animation building blocks
│   │   │   ├── MoleItLogo.jsx, SiteMenu.jsx, MenuCursor.jsx, ProtectedRoute.jsx, ...
│   │   ├── pages/                   Home, DrawLabPage, LibraryPage, CompoundDetailPage,
│   │   │                            GroupTheoryPage, ReactionsPage, FunctionalGroupsPage,
│   │   │                            QuizPage, NotesPage, MyMoleculesPage, BlogPage,
│   │   │                            BlogPostPage, NewsPage, Login, Register,
│   │   │                            ForgotPassword, ResetPassword
│   │   ├── context/AuthContext.jsx  Auth state + token handling
│   │   └── api/api.js                Axios client
│   ├── scripts/seedQuizQuestions.mjs
│   ├── .env / .env.example           VITE_API_URL
│   └── Dockerfile
│
└── docker-compose.yml                Postgres + backend + frontend, all wired together
```

## Environment variables

### Backend (`backend/.env`)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string (or `sqlite:///./local.db` for local testing) |
| `SECRET_KEY` | Yes | JWT signing secret — use a long random string in production |
| `QUIZ_SEED_SECRET` | No | Gates the quiz bulk-seed endpoint; only the seed script needs it |
| `SMTP_HOST` | No* | e.g. `smtp.gmail.com` — leave blank to disable the welcome email entirely |
| `SMTP_PORT` | No* | e.g. `587` |
| `SMTP_USER` | No* | The sending mailbox's address |
| `SMTP_PASSWORD` | No* | An app password (not your normal account password, for Gmail) |
| `SMTP_USE_TLS` | No | `true`/`false`, defaults to `true` |
| `SMTP_FROM_EMAIL` | No | Must match `SMTP_USER` for Gmail's relay |
| `SMTP_FROM_NAME` | No | Display name on outgoing mail, defaults to `MoleIt` |
| `FRONTEND_URL` | No | Used to build the "Open MoleIt" link in the welcome email |

\* If any of `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` are left blank, the
welcome email is silently skipped — registration itself still always
succeeds. See `backend/app/mailer.py`.

Copy `backend/.env.example` to `backend/.env` and fill it in.

### Frontend (`frontend/.env`)

| Variable | Required | Notes |
|---|---|---|
| `VITE_API_URL` | Yes | Base URL of the backend, e.g. `http://localhost:8000` locally |

Copy `frontend/.env.example` to `frontend/.env`.

## Quick start (Docker)

```bash
docker compose up --build
```

- Frontend: http://localhost:5173
- Backend docs (Swagger): http://localhost:8000/docs
- Postgres: localhost:5432 (user `molapp_user` / pass `molapp_pass` / db `molapp_db`)

The backend automatically creates its tables, runs light migrations, and
seeds the compound library on first startup.

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

Logs are written to `backend/logs/app.log` as well as the console — useful
for tracing a specific request or checking whether the welcome email sent.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env   # points VITE_API_URL at http://localhost:8000
npm run dev
```

## Deployment

Currently deployed on Render as two services (backend + frontend), with
Postgres hosted on Supabase. Environment variables for the backend service
must be set directly in Render's dashboard (Environment tab) — Render does
not read `backend/.env`. After adding or changing any variable there, a
redeploy is required for it to take effect.

## API

Once the backend is running, full interactive API docs are available at
`/docs` (Swagger UI) and `/redoc`. All endpoints live under `/api/...`,
grouped by router: `auth`, `compounds`, `notes`, `molecules`, `quiz`,
`news`, `blog`, `functional-groups`, `reactions`, `symmetry`, `spectra`,
`structure`. A basic health check is available at `/api/health`.