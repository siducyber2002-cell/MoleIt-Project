import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Trash2, PenTool, Eye, Search, PlusCircle, Atom, Layers, X,
} from 'lucide-react';
import { fetchMyMolecules, deleteMolecule } from '../api/api';
import { useAuth } from '../context/AuthContext';
import ThreeMoleculeViewer from '../components/Viewer3D/ThreeMoleculeViewer';
import { atomsToMolBlock } from '../lib/molblock';
import { Reveal, StaggerGroup, StaggerItem, Word, EASE } from '../components/motion/ScrollReveal';

// Solid paper-friendly accents — one per molecule, chosen deterministically
// from its name/id, so the shelf still reads as a colorful specimen
// collection rather than a wall of identical cards.
const ACCENTS = ['#3bbff7', '#eea02b', '#1f6d49', '#6c5ce7', '#ff6b4a', '#0f9c8d'];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function accentFor(key) {
  return ACCENTS[hashString(String(key ?? '?')) % ACCENTS.length];
}

function MoleculeCardSkeleton() {
  return (
    <div className="mm-card mm-skeleton">
      <div className="mm-skeleton__swatch" />
      <div className="mm-skeleton__body">
        <div className="mm-skeleton__bar" style={{ width: '65%' }} />
        <div className="mm-skeleton__bar" style={{ width: '45%', marginTop: 8 }} />
      </div>
    </div>
  );
}

function MoleculeCard({ m, active, onPreview, onEdit, onDelete }) {
  const atomCount = m.structure_2d?.atoms?.length ?? 0;
  const accent = accentFor(m.name + m.id);

  return (
    <StaggerItem className={`mm-card mm-mol ${active ? 'is-active' : ''}`} whileHover={{ y: -4 }}>
      <div className="mm-mol__swatch" style={{ background: `${accent}22`, borderBottom: `1px solid ${accent}44` }}>
        <span className="mm-mol__count" style={{ color: accent }}>
          {atomCount} {atomCount === 1 ? 'atom' : 'atoms'}
        </span>
        <button onClick={() => onDelete(m.id, m.name)} title="Delete" className="mm-mol__del">
          <Trash2 size={13} />
        </button>
        {m.derived_formula && (
          <span className="mm-mol__formula" style={{ color: accent }}>
            {m.derived_formula}
          </span>
        )}
      </div>

      <div className="mm-mol__body">
        <h3 className="mm-mol__name">{m.name}</h3>
        {m.derived_smiles && <p className="mm-mol__smiles">{m.derived_smiles}</p>}
        <div className="mm-mol__actions">
          <button onClick={() => onPreview(m)} className="mm-mol__btn" style={active ? { borderColor: accent, color: accent } : undefined}>
            <Eye size={12} /> Preview
          </button>
          <button onClick={() => onEdit(m)} className="mm-mol__btn">
            <PenTool size={12} /> Edit
          </button>
        </div>
      </div>
    </StaggerItem>
  );
}

export default function MyMoleculesPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [molecules, setMolecules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  // Paint the warm-paper canvas behind the whole viewport while this page
  // is mounted — same trick the homepage and News page use, scoped so no
  // other route is affected.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-specimens');
    return () => root.classList.remove('theme-specimens');
  }, []);

  useEffect(() => {
    if (!user) return;
    fetchMyMolecules()
      .then(setMolecules)
      .catch(() => setError("Couldn't load your molecules — try refreshing."))
      .finally(() => setLoading(false));
  }, [user]);

  if (!authLoading && !user) {
    return <Navigate to="/login" state={{ from: '/my-molecules' }} replace />;
  }

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    setError('');
    try {
      await deleteMolecule(id);
      setMolecules((m) => m.filter((x) => x.id !== id));
      if (preview?.id === id) setPreview(null);
    } catch {
      setError("Couldn't delete that molecule — try again.");
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return molecules;
    return molecules.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.derived_formula?.toLowerCase().includes(q) ||
        m.derived_smiles?.toLowerCase().includes(q)
    );
  }, [molecules, query]);

  return (
    <div className="mm">
      <style>{`
        html.theme-specimens,
        html.theme-specimens body {
          background-color: #f0edea;
          background-image: none;
        }
        html.theme-specimens .moleit-logo .text-lab-100 { color: #262626 !important; }

        .mm {
          --mm-bg: #f0edea;
          --mm-card: #fafaf9;
          --mm-ink: #262626;
          --mm-ink-2: #4e4e4d;
          --mm-ink-3: #8a8681;
          --mm-line: rgba(38, 38, 38, 0.12);
          --mm-blue: #3bbff7;
          --mm-violet: #6c5ce7;

          position: relative;
          width: 100%;
          max-width: 1280px;
          margin: 0 auto;
          padding: 40px 20px 72px;
          color: var(--mm-ink);
          font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
        }

        .mm-eyebrow {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 12px; border-radius: 999px;
          background: var(--mm-card); border: 1px solid var(--mm-line);
          font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--mm-violet);
        }
        .mm-h1 {
          margin: 14px 0 0; display: flex; flex-wrap: wrap;
          font-weight: 700; letter-spacing: -0.03em; line-height: 1;
          font-size: clamp(2.4rem, 6vw, 4rem); color: var(--mm-ink);
        }
        .mm-h1 .mm-accent { color: var(--mm-violet); margin-left: 0.28em; }
        .mm-tagline { margin-top: 14px; max-width: 32em; font-size: clamp(0.95rem, 1.2vw, 1.05rem); line-height: 1.6; color: var(--mm-ink-2); }

        .mm-toolbar { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
        .mm-search { position: relative; flex: 1; min-width: 200px; max-width: 320px; }
        .mm-search svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--mm-ink-3); pointer-events: none; }
        .mm-search input {
          width: 100%; padding: 10px 12px 10px 34px; border-radius: 10px;
          border: 1px solid var(--mm-line); background: var(--mm-card);
          font-size: 13.5px; color: var(--mm-ink); outline: none; transition: border-color 0.2s;
        }
        .mm-search input:focus { border-color: var(--mm-blue); }
        .mm-count { font-size: 12px; color: var(--mm-ink-3); margin-right: auto; }
        .mm-draw-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 16px; border-radius: 10px; border: 2px solid var(--mm-ink);
          background: var(--mm-ink); color: var(--mm-card); font-size: 13px; font-weight: 700;
          cursor: pointer; transition: background 0.2s, border-color 0.2s, color 0.2s;
        }
        .mm-draw-btn:hover { background: var(--mm-blue); border-color: var(--mm-blue); color: #0b2e3d; }

        .mm-error-text { margin-top: 16px; border-radius: 10px; border: 1px solid rgba(255,59,59,0.25); background: rgba(255,59,59,0.06); padding: 8px 12px; font-size: 12.5px; color: #b52424; }

        .mm-card { border-radius: 16px; border: 1px solid var(--mm-line); background: var(--mm-card); transition: transform 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease; }

        .mm-skeleton { overflow: hidden; }
        .mm-skeleton__swatch { height: 96px; background: var(--mm-line); animation: mm-pulse 1.4s ease-in-out infinite; }
        .mm-skeleton__body { padding: 14px; }
        .mm-skeleton__bar { height: 10px; border-radius: 5px; background: var(--mm-line); animation: mm-pulse 1.4s ease-in-out infinite; }
        @keyframes mm-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }

        .mm-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; border-radius: 16px; border: 1px dashed var(--mm-line); background: var(--mm-card); padding: 64px 20px; text-align: center; }
        .mm-empty p { margin: 0; font-size: 13.5px; color: var(--mm-ink-2); }
        .mm-empty-btn {
          display: inline-flex; align-items: center; gap: 6px; border-radius: 10px; border: none;
          background: var(--mm-ink); color: var(--mm-card); padding: 9px 16px; font-size: 13px; font-weight: 700; cursor: pointer;
        }
        .mm-empty-btn:hover { background: var(--mm-violet); }

        .mm-layout { display: grid; grid-template-columns: 1fr; gap: 24px; margin-top: 28px; }
        @media (min-width: 1024px) { .mm-layout { grid-template-columns: 2fr 1fr; } }

        .mm-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
        @media (min-width: 640px) { .mm-grid { grid-template-columns: 1fr 1fr; } }

        .mm-mol { overflow: hidden; }
        .mm-mol.is-active { border-color: var(--mm-violet); box-shadow: 0 0 0 1px var(--mm-violet); }
        .mm-mol__swatch { position: relative; height: 96px; padding: 12px; display: flex; align-items: flex-start; justify-content: space-between; }
        .mm-mol__count { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; background: #fff; border-radius: 999px; padding: 3px 8px; }
        .mm-mol__del { border: none; background: #fff; border-radius: 999px; padding: 5px; color: var(--mm-ink-3); opacity: 0; cursor: pointer; transition: opacity 0.2s, color 0.2s; }
        .mm-mol:hover .mm-mol__del { opacity: 1; }
        .mm-mol__del:hover { color: #c9451f; }
        .mm-mol__formula { position: absolute; bottom: 8px; right: 12px; font-family: 'IBM Plex Mono', monospace; font-size: 22px; font-weight: 800; }
        .mm-mol__body { padding: 14px; }
        .mm-mol__name { margin: 0; font-weight: 700; font-size: 14.5px; color: var(--mm-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mm-mol__smiles { margin: 3px 0 0; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--mm-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mm-mol__actions { margin-top: 12px; display: flex; gap: 8px; }
        .mm-mol__btn {
          display: inline-flex; align-items: center; gap: 5px; border-radius: 8px; border: 1px solid var(--mm-line);
          background: transparent; padding: 6px 10px; font-size: 11.5px; color: var(--mm-ink-2); cursor: pointer; transition: border-color 0.2s, color 0.2s;
        }
        .mm-mol__btn:hover { border-color: var(--mm-ink); color: var(--mm-ink); }

        .mm-preview { position: sticky; top: 84px; overflow: hidden; border-radius: 16px; border: 1px solid var(--mm-line); background: var(--mm-card); }
        .mm-preview__head { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--mm-line); padding: 12px 14px; }
        .mm-preview__title { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--mm-ink-2); }
        .mm-preview__close { border: none; background: transparent; border-radius: 999px; padding: 4px; color: var(--mm-ink-3); cursor: pointer; }
        .mm-preview__close:hover { color: #c9451f; }
        .mm-preview__body { padding: 12px; }
        .mm-preview__name-row { display: flex; align-items: center; justify-content: space-between; padding: 0 2px 8px; }
        .mm-preview__name { font-size: 13.5px; font-weight: 600; color: var(--mm-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mm-preview__formula { font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 800; color: var(--mm-violet); }
        .mm-preview__empty { display: flex; height: 224px; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 0 24px; text-align: center; }
        .mm-preview__empty p { margin: 0; font-size: 12px; color: var(--mm-ink-3); }
      `}</style>

      <div className="mm-eyebrow">
        <Layers size={12} /> Your library
      </div>

      <StaggerGroup as="h1" trigger="mount" className="mm-h1">
        <Word className="mr-3">My</Word>
        <Word className="mm-accent">Molecules.</Word>
      </StaggerGroup>

      <Reveal trigger="mount" delay={0.15} as="p" className="mm-tagline">
        Everything you've drawn and saved in the Draw Lab, in one place.
      </Reveal>

      <Reveal trigger="mount" delay={0.25} className="mm-toolbar">
        <div className="mm-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your molecules…" />
        </div>
        {!loading && (
          <span className="mm-count">{molecules.length} saved {molecules.length === 1 ? 'molecule' : 'molecules'}</span>
        )}
        <button onClick={() => navigate('/draw')} className="mm-draw-btn">
          <PlusCircle size={15} /> Draw new
        </button>
      </Reveal>

      {error && <p className="mm-error-text">{error}</p>}

      {loading ? (
        <div className="mm-grid" style={{ marginTop: 28 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <MoleculeCardSkeleton key={i} />
          ))}
        </div>
      ) : molecules.length === 0 ? (
        <Reveal trigger="mount" className="mm-empty" style={{ marginTop: 28 }}>
          <motion.span animate={{ y: [0, -6, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}>
            <Atom size={28} color="var(--mm-ink-3)" />
          </motion.span>
          <p>You haven't saved any molecules yet.</p>
          <button onClick={() => navigate('/draw')} className="mm-empty-btn">
            <PenTool size={15} /> Go draw one
          </button>
        </Reveal>
      ) : filtered.length === 0 ? (
        <Reveal trigger="mount" className="mm-empty" style={{ marginTop: 28 }}>
          <Search size={22} color="var(--mm-ink-3)" />
          <p>No molecules match "{query}".</p>
        </Reveal>
      ) : (
        <div className="mm-layout">
          <StaggerGroup className="mm-grid">
            {filtered.map((m) => (
              <MoleculeCard
                key={m.id}
                m={m}
                active={preview?.id === m.id}
                onPreview={setPreview}
                onEdit={(mol) => navigate('/draw', { state: { structure_2d: mol.structure_2d, name: mol.name } })}
                onDelete={handleDelete}
              />
            ))}
          </StaggerGroup>

          <div className="mm-preview">
            <div className="mm-preview__head">
              <h3 className="mm-preview__title">
                <Atom size={13} color="var(--mm-violet)" /> 3D Preview
              </h3>
              <AnimatePresence>
                {preview && (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    onClick={() => setPreview(null)}
                    className="mm-preview__close"
                  >
                    <X size={14} />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence mode="wait">
              {preview ? (
                <motion.div
                  key={preview.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25, ease: EASE }}
                  className="mm-preview__body"
                >
                  <div className="mm-preview__name-row">
                    <span className="mm-preview__name">{preview.name}</span>
                    {preview.derived_formula && (
                      <span className="mm-preview__formula">{preview.derived_formula}</span>
                    )}
                  </div>
                  <ThreeMoleculeViewer
                    molBlock={atomsToMolBlock(preview.structure_2d.atoms, preview.structure_2d.bonds, preview.name)}
                    height={280}
                    atoms={preview.structure_2d.atoms}
                    title={preview.name}
                  />
                </motion.div>
              ) : (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mm-preview__empty">
                  <Atom size={24} color="var(--mm-line)" />
                  <p>Click "Preview" on a molecule to view it in 3D</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}