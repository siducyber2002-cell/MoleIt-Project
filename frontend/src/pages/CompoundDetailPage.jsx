import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  ArrowLeft, PenTool, NotebookPen, Plus, CheckCircle2, XCircle,
  RotateCcw, Loader2, ExternalLink,
} from 'lucide-react';
import ThreeMoleculeViewer from '../components/Viewer3D/ThreeMoleculeViewer';
import MolecularShapeDiagram from '../components/Library/MolecularShapeDiagram';
import NMRPanel from '../components/Library/NMRPanel';
import IRPanel from '../components/Library/IRPanel';
import { categoryTone, Formula } from '../components/Library/CompoundCard';
import { useLibraryTheme, LibraryThemeStyles } from '../components/Library/libTheme';
import { elementInfo } from '../lib/elements';
import { fetchCompound, fetchQuizQuestionsForCompound, fetchNotes } from '../api/api';
import { useAuth } from '../context/AuthContext';

// True while the viewport matches the media query (used to size the 3D viewer on phones).
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

const TABS = ['Overview', 'Structure', '3D', 'Properties', 'Bonding', 'NMR', 'IR', 'Notes', 'Quiz'];
// These two tabs render their own full panel, so they skip the outer one.
const BARE_TABS = new Set(['NMR', 'IR']);

export default function CompoundDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const [compound, setCompound] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const initialTab = TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'Overview';
  const [tab, setTab] = useState(initialTab);

  // Light theme for this page only (see libTheme.jsx)
  useLibraryTheme();

  const selectTab = (t) => {
    setTab(t);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t === 'Overview') next.delete('tab');
      else next.set('tab', t);
      return next;
    }, { replace: true });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setLoadError(false);
    setCompound(null);
    const requestedTab = searchParams.get('tab');
    setTab(TABS.includes(requestedTab) ? requestedTab : 'Overview');
    fetchCompound(id)
      .then((data) => {
        if (cancelled) return;
        setCompound(data);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.response?.status === 404) setNotFound(true);
        else setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Guards against a race when navigating between compounds quickly
    // (e.g. back/forward) — an in-flight request for the *previous* id
    // resolving after the new one has already started shouldn't be
    // allowed to overwrite it.
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading || notFound || loadError || !compound) {
    return (
      <div className="lib-page cd-page">
        <LibraryThemeStyles />
        <div className="lib-wrap cd-wrap">
          <Link to="/library" className="cd-back">
            <ArrowLeft size={15} strokeWidth={2.4} /> Back to library
          </Link>
          <div className="cd-state" role="status">
            {loading ? (
              <>
                <Loader2 size={18} className="lib-spin" /> Loading compound…
              </>
            ) : notFound ? (
              'Compound not found.'
            ) : (
              "Couldn't load this compound — check your connection and try again."
            )}
          </div>
        </div>
        <style>{DETAIL_CSS}</style>
      </div>
    );
  }

  const showCommon = compound.common_name && compound.common_name !== compound.name;

  return (
    <div className="lib-page cd-page">
      <LibraryThemeStyles />
      <div className="lib-wrap cd-wrap">
        <Link to="/library" className="cd-back">
          <ArrowLeft size={15} strokeWidth={2.4} /> Back to library
        </Link>

        <header className="cd-head" style={categoryTone(compound.category)}>
          <div className="cd-chips">
            <span className="cd-cat">{compound.category}</span>
            {compound.source === 'pubchem' && (
              <a
                href={`https://pubchem.ncbi.nlm.nih.gov/compound/${compound.pubchem_cid}`}
                target="_blank"
                rel="noreferrer"
                className="cd-src"
              >
                via PubChem (CID {compound.pubchem_cid}) <ExternalLink size={12} strokeWidth={2.4} />
              </a>
            )}
          </div>
          <h1 className="cd-title">{compound.name}</h1>
          {showCommon && <p className="cd-common">{compound.common_name}</p>}
          {compound.formula && (
            <span className="cd-formula">
              <Formula text={compound.formula} />
            </span>
          )}
          <span className="cd-orb" aria-hidden="true" />
        </header>

        <nav className="cd-tabs" role="tablist" aria-label="Compound sections">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => selectTab(t)}
              className={`cd-tab ${tab === t ? 'is-active' : ''}`}
            >
              {t}
            </button>
          ))}
        </nav>

        <section className={`cd-scope ${BARE_TABS.has(tab) ? 'cd-bare' : 'cd-panel'}`} role="tabpanel">
          {tab === 'Overview' && <OverviewTab compound={compound} navigate={navigate} />}
          {tab === 'Structure' && <StructureTab compound={compound} />}
          {tab === '3D' && <ThreeDTab compound={compound} />}
          {tab === 'Properties' && <PropertiesTab compound={compound} />}
          {tab === 'Bonding' && <BondingTab compound={compound} />}
          {tab === 'NMR' && <NMRTab compound={compound} />}
          {tab === 'IR' && <IRTab compound={compound} />}
          {tab === 'Notes' && <NotesTab compound={compound} user={user} navigate={navigate} />}
          {tab === 'Quiz' && <QuizTab compound={compound} />}
        </section>
      </div>
      <style>{DETAIL_CSS}</style>
    </div>
  );
}

function OverviewTab({ compound, navigate }) {
  return (
    <div>
      {compound.description && <p className="cd-lead">{compound.description}</p>}

      {compound.interesting_facts && (
        <div className="cd-callout">
          <span className="cd-tag">Did you know?</span>
          <p>{compound.interesting_facts}</p>
        </div>
      )}

      {compound.uses && (
        <div className="cd-block">
          <h2 className="cd-h">Common uses</h2>
          <p className="cd-text">{compound.uses}</p>
        </div>
      )}

      <div className="cd-actions">
        {compound.structure_2d && (
          <button
            type="button"
            onClick={() =>
              navigate('/draw', { state: { structure_2d: compound.structure_2d, name: compound.name } })
            }
            className="lib-btn lib-btn--lime"
          >
            <PenTool size={16} strokeWidth={2.4} /> Open in Draw Lab
          </button>
        )}
        <Link
          to="/notes"
          state={{ compoundId: compound.id, compoundName: compound.name }}
          className="lib-btn lib-btn--white"
        >
          <NotebookPen size={16} strokeWidth={2.4} /> Take notes
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2D structure — drawn with shaded, glossy atoms and tube-style bonds
// ---------------------------------------------------------------------------
// The SVG draws inside a viewBox centred on the molecule. An SVG root clips
// anything outside its own viewBox, so the frame is sized from this specific
// compound's own bounding box (plus padding) — the whole structure always fits,
// whatever its shape.
const STRUCTURE_FRAME_PADDING = 36;
const MIN_STRUCTURE_FRAME = 150;

function computeStructureFrame(atoms) {
  if (!atoms || atoms.length === 0) {
    return { cx: 0, cy: 0, size: MIN_STRUCTURE_FRAME };
  }
  const xs = atoms.map((a) => a.x);
  const ys = atoms.map((a) => a.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const side = Math.max(maxX - minX, maxY - minY) + STRUCTURE_FRAME_PADDING * 2;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, size: Math.max(MIN_STRUCTURE_FRAME, side) };
}

function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// amt > 0 lightens toward white, amt < 0 darkens toward black
function shade(hex, amt) {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  return `rgb(${rgb.map((c) => Math.round((t - c) * p + c)).join(',')})`;
}

function labelColor(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return '#0e100a';
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return lum > 0.62 ? '#0e100a' : '#ffffff';
}

function StructureDiagram({ atoms, bonds }) {
  const frame = useMemo(() => computeStructureFrame(atoms), [atoms]);
  const byId = useMemo(() => new Map(atoms.map((a) => [a.id, a])), [atoms]);
  const elements = useMemo(() => [...new Set(atoms.map((a) => a.element))], [atoms]);

  const colorOf = (el) => (el === 'R' ? '#94a3b8' : elementInfo(el).color);
  const radiusOf = (el) => Math.max(12, el === 'R' ? 13 : elementInfo(el).radius);
  const half = frame.size / 2;

  return (
    <svg
      viewBox={`${frame.cx - half} ${frame.cy - half} ${frame.size} ${frame.size}`}
      className="cd-structure-svg"
      role="img"
      aria-label="2D structure"
    >
      <defs>
        {elements.map((el) => {
          const c = colorOf(el);
          return (
            <radialGradient key={el} id={`cd-atom-${el}`} cx="34%" cy="30%" r="75%">
              <stop offset="0%" stopColor={shade(c, 0.6)} />
              <stop offset="55%" stopColor={c} />
              <stop offset="100%" stopColor={shade(c, -0.35)} />
            </radialGradient>
          );
        })}
      </defs>

      {/* soft ground shadows */}
      {bonds.map((bond) => {
        const a = byId.get(bond.from);
        const b = byId.get(bond.to);
        if (!a || !b) return null;
        return (
          <line key={`s-${bond.id}`} x1={a.x + 2} y1={a.y + 5} x2={b.x + 2} y2={b.y + 5}
            stroke="rgba(14,16,10,0.16)" strokeWidth={6} strokeLinecap="round" />
        );
      })}
      {atoms.map((a) => (
        <ellipse key={`s-${a.id}`} cx={a.x + 2} cy={a.y + radiusOf(a.element) * 0.75 + 4} rx={radiusOf(a.element) * 0.95}
          ry={radiusOf(a.element) * 0.42} fill="rgba(14,16,10,0.18)" />
      ))}

      {bonds.map((bond) => {
        const a = byId.get(bond.from);
        const b = byId.get(bond.to);
        if (!a || !b) return null;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = -dy / len;
        const uy = dx / len;
        const gap = 4;
        const offsets = bond.order === 3 ? [-gap * 1.6, 0, gap * 1.6] : bond.order === 2 ? [-gap, gap] : [0];
        return (
          <g key={bond.id}>
            {offsets.map((o, i) => (
              <g key={i}>
                <line x1={a.x + ux * o} y1={a.y + uy * o} x2={b.x + ux * o} y2={b.y + uy * o}
                  stroke="#22271a" strokeWidth={offsets.length > 1 ? 3.4 : 4.4} strokeLinecap="round" />
                <line x1={a.x + ux * o - 0.6} y1={a.y + uy * o - 0.8} x2={b.x + ux * o - 0.6} y2={b.y + uy * o - 0.8}
                  stroke="#b9c28f" strokeWidth={1.2} strokeLinecap="round" />
              </g>
            ))}
          </g>
        );
      })}

      {atoms.map((a) => {
        const c = colorOf(a.element);
        const r = radiusOf(a.element);
        const charge = a.charge || 0;
        return (
          <g key={a.id} transform={`translate(${a.x}, ${a.y})`}>
            <circle r={r} fill={`url(#cd-atom-${a.element})`} stroke="#0e100a" strokeWidth={1.6} />
            <ellipse cx={-r * 0.3} cy={-r * 0.36} rx={r * 0.34} ry={r * 0.2} fill="#fff" opacity={0.55} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={11.5} fontWeight={700}
              fill={labelColor(c)} className="font-mono" y={1}>
              {a.element}
            </text>
            {charge !== 0 && (
              <text x={r - 1} y={-r + 3} fontSize={10} fontWeight={700} fill="#b42318">
                {charge > 0 ? `${charge > 1 ? charge : ''}+` : `${charge < -1 ? Math.abs(charge) : ''}-`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function StructureTab({ compound }) {
  const atoms = compound.structure_2d?.atoms;

  return (
    <div>
      {atoms?.length ? (
        <div className="cd-stage">
          <StructureDiagram atoms={atoms} bonds={compound.structure_2d.bonds || []} />
        </div>
      ) : (
        <div className="cd-empty">No 2D structure available</div>
      )}
      <div className="cd-structure-meta">
        <div>
          <h2 className="cd-h">Formula</h2>
          <span className="cd-formula">
            <Formula text={compound.formula} />
          </span>
        </div>
        {compound.smiles && (
          <div className="cd-smiles">
            <h2 className="cd-h">SMILES</h2>
            <code className="cd-code">{compound.smiles}</code>
          </div>
        )}
      </div>
    </div>
  );
}

function ThreeDTab({ compound }) {
  const isPhone = useMediaQuery('(max-width: 639px)');
  return compound.mol_block ? (
    <ThreeMoleculeViewer molBlock={compound.mol_block} height={isPhone ? 340 : 420} title={compound.name} />
  ) : (
    <div className="cd-empty">No 3D data available</div>
  );
}

function PropertySection({ title, rows }) {
  const filtered = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (filtered.length === 0) return null;
  return (
    <div className="cd-block">
      <h2 className="cd-h">{title}</h2>
      <div className="cd-table">
        {filtered.map(([label, value]) => (
          <div key={label} className="cd-row">
            <span className="cd-row-label">{label}</span>
            <span className="cd-row-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PropertiesTab({ compound }) {
  const isPubchem = compound.source === 'pubchem';

  return (
    <div>
      <PropertySection
        title="Identifiers"
        rows={[
          ['Molecular formula', compound.formula],
          ['IUPAC name', compound.iupac_name],
          ['Common name', compound.common_name],
          ['CAS number', compound.cas_number],
          ['Category', compound.category],
          ['SMILES', compound.smiles],
          ['InChI', compound.inchi],
          ['InChIKey', compound.inchikey],
        ]}
      />

      <PropertySection
        title="Physical properties"
        rows={[
          ['Appearance', compound.appearance],
          ['Odor', compound.odor],
          ['Melting point', compound.melting_point],
          ['Boiling point', compound.boiling_point],
          ['Density', compound.density],
          ['Solubility', compound.solubility],
          ['Vapor pressure', compound.vapor_pressure],
          ['Flash point', compound.flash_point],
          ['Stability', compound.stability],
        ]}
      />

      <PropertySection
        title="Computed descriptors"
        rows={[
          ['Molar mass', compound.molar_mass],
          ['Exact mass', compound.exact_mass],
          ['Monoisotopic mass', compound.monoisotopic_mass],
          ['XLogP (partition coefficient)', compound.xlogp],
          ['Topological polar surface area', compound.tpsa],
          ['Complexity', compound.complexity],
          ['Formal charge', compound.charge],
          ['H-bond donors', compound.h_bond_donor_count],
          ['H-bond acceptors', compound.h_bond_acceptor_count],
          ['Rotatable bonds', compound.rotatable_bond_count],
          ['Heavy atom count', compound.heavy_atom_count],
        ]}
      />

      {compound.synonyms?.length > 0 && (
        <div className="cd-block">
          <h2 className="cd-h">Also known as</h2>
          <div className="cd-syns">
            {compound.synonyms.map((s) => (
              <span key={s} className="cd-syn">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {isPubchem && (
        <p className="cd-fineprint">
          Physical and computed properties are pulled live from PubChem and cached — a field left blank means
          PubChem doesn't have that data point for this compound, not that it wasn't checked.
        </p>
      )}
    </div>
  );
}

function BondingTab({ compound }) {
  const rows = [
    ['Molecular geometry', compound.geometry],
    ['Hybridization', compound.hybridization],
  ].filter(([, v]) => v);

  return (
    <div>
      {rows.length > 0 && (
        <div className="cd-stats">
          {rows.map(([label, value]) => (
            <div key={label} className="cd-stat">
              <div className="cd-stat-label">{label}</div>
              <div className="cd-stat-value">{value}</div>
            </div>
          ))}
        </div>
      )}
      {compound.geometry && (
        <div className="cd-block">
          <h2 className="cd-h">Shapes</h2>
          <MolecularShapeDiagram geometryText={compound.geometry} geometryCenters={compound.geometry_centers} />
        </div>
      )}
      {compound.bonding_notes ? (
        <p className="cd-text">{compound.bonding_notes}</p>
      ) : (
        <p className="cd-hint">No bonding notes available for this compound yet.</p>
      )}
    </div>
  );
}

function NMRTab({ compound }) {
  const atoms = compound.structure_2d?.atoms || [];
  const bonds = compound.structure_2d?.bonds || [];
  return <NMRPanel atoms={atoms} bonds={bonds} />;
}

function IRTab({ compound }) {
  const atoms = compound.structure_2d?.atoms || [];
  const bonds = compound.structure_2d?.bonds || [];
  return <IRPanel atoms={atoms} bonds={bonds} />;
}

function NotesTab({ compound, user, navigate }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    setError(false);
    fetchNotes()
      .then((all) => setNotes(all.filter((n) => n.compound_id === compound.id)))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [user, compound.id]);

  if (!user) {
    return (
      <p className="cd-text">
        <Link to="/login" className="cd-link">Log in</Link> to write and view notes about this compound.
      </p>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate('/notes', { state: { compoundId: compound.id, compoundName: compound.name } })}
        className="lib-btn lib-btn--lime"
      >
        <Plus size={16} strokeWidth={2.4} /> New note about {compound.name}
      </button>

      <div className="cd-notes">
        {loading ? (
          <p className="cd-hint">Loading…</p>
        ) : error ? (
          <p className="cd-error">Couldn't load your notes for this compound — try refreshing.</p>
        ) : notes.length === 0 ? (
          <p className="cd-hint">No notes yet for this compound.</p>
        ) : (
          notes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => navigate('/notes', { state: { openNoteId: n.id } })}
              className="cd-note"
            >
              <span className="cd-note-title">{n.title || 'Untitled note'}</span>
              {n.content && <span className="cd-note-body">{n.content}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function QuizTab({ compound }) {
  const [pool, setPool] = useState(null);
  const [question, setQuestion] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
    fetchQuizQuestionsForCompound(compound.id)
      .then((mine) => {
        setPool(mine);
        setQuestion(mine.length ? mine[Math.floor(Math.random() * mine.length)] : null);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [compound.id]);

  const newQuestion = () => {
    if (!pool || pool.length === 0) return;
    setSelected(null);
    const others = pool.filter((q) => q.id !== question?.id);
    const next = others.length ? others[Math.floor(Math.random() * others.length)] : pool[0];
    setQuestion(next);
  };

  if (loading) {
    return (
      <div className="cd-hint cd-inline">
        <Loader2 size={15} className="lib-spin" /> Building a question…
      </div>
    );
  }

  if (error) {
    return <p className="cd-error">Couldn't load the question bank — check your connection and try again.</p>;
  }

  if (!question) {
    return (
      <p className="cd-text">
        Not enough other compounds in the library yet to build distractors for a quiz question. Try the{' '}
        <Link to="/quiz" className="cd-link">full Quiz Mode</Link> instead.
      </p>
    );
  }

  return (
    <div>
      <p className="cd-question">{question.prompt}</p>
      {question.mol_block && (
        <div className="cd-quiz-mol">
          <ThreeMoleculeViewer molBlock={question.mol_block} height={200} />
        </div>
      )}
      <div className="cd-options">
        {question.options.map((opt) => {
          const isCorrect = opt === question.answer;
          const isSelected = opt === selected;
          let state = '';
          if (selected) {
            if (isCorrect) state = 'is-correct';
            else if (isSelected) state = 'is-wrong';
            else state = 'is-dim';
          }
          return (
            <button
              key={opt}
              type="button"
              disabled={!!selected}
              onClick={() => setSelected(opt)}
              className={`cd-opt ${state}`}
            >
              <span>{opt}</span>
              {selected && isCorrect && <CheckCircle2 size={17} strokeWidth={2.4} />}
              {selected && isSelected && !isCorrect && <XCircle size={17} strokeWidth={2.4} />}
            </button>
          );
        })}
      </div>
      <div className="cd-actions">
        <button type="button" onClick={newQuestion} className="lib-btn lib-btn--white">
          <RotateCcw size={15} strokeWidth={2.4} /> New question
        </button>
      </div>
      <p className="cd-hint">
        Want more variety? Try the <Link to="/quiz" className="cd-link">full Quiz Mode</Link>.
      </p>
    </div>
  );
}

const DETAIL_CSS = `
.cd-page { padding-bottom: 96px; }
.cd-wrap { padding-top: 26px; }

/* ---------------- back link ---------------- */
.cd-back {
  display: inline-flex; align-items: center; gap: 8px; padding: 9px 16px 9px 13px; border-radius: 999px;
  border: 1.5px solid rgba(14,16,10,0.55); background: #fff; color: var(--lib-ink-2); text-decoration: none;
  font: 600 13px/1 var(--lib-font-body);
  box-shadow: 0 3px 0 rgba(14,16,10,0.55), 0 10px 14px -8px rgba(70,95,10,0.4);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.cd-back:hover { transform: translateY(-1px); color: var(--lib-ink); box-shadow: 0 4px 0 rgba(14,16,10,0.55), 0 12px 16px -8px rgba(70,95,10,0.45); }
.cd-back:active { transform: translateY(2px); box-shadow: 0 1px 0 rgba(14,16,10,0.55); }

/* ---------------- header ---------------- */
.cd-head { position: relative; margin-top: 30px; padding-right: 8px; }
.cd-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.cd-cat {
  display: inline-block; padding: 5px 13px; border-radius: 999px; border: 1px solid var(--t-bd); background: var(--t-bg);
  color: var(--t-ink); font: 600 12px/1.3 var(--lib-font-body);
}
.cd-src {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 13px; border-radius: 999px; border: 1px solid #79dcc9;
  background: #d8f8f1; color: #0f5e57; text-decoration: none; font: 600 12px/1.3 var(--lib-font-body);
}
.cd-src:hover { border-color: #0f5e57; }
.cd-title {
  margin: 18px 0 0; max-width: 100%; overflow-wrap: anywhere;
  font: 700 clamp(2.4rem, 5.2vw, 4.2rem)/1.02 var(--lib-font-display); letter-spacing: -0.04em; color: var(--lib-ink);
  /* extruded 3D type, same recipe as the Library hero */
  text-shadow:
    1px 1px 0 #dcf45f, 2px 2px 0 #d3ee40, 3px 3px 0 #ccEb2d, 4px 4px 0 #c0de27, 5px 5px 0 #b4d222,
    6px 6px 0 #a8c61d, 7px 7px 0 #9cba19, 8px 8px 0 #90ad15,
    9px 12px 14px rgba(60,80,8,0.32), 13px 22px 30px rgba(60,80,8,0.22);
}
.cd-common { margin: 14px 0 0; font: 500 16px/1.4 var(--lib-font-body); color: var(--lib-ink-3); }
.cd-formula {
  display: inline-block; margin-top: 20px; padding: 8px 16px; border-radius: 12px; border: 1.5px solid var(--lib-ink);
  background: var(--lib-lime); color: var(--lib-ink); box-shadow: 0 3px 0 var(--lib-ink);
  font: 600 19px/1.1 'IBM Plex Mono', ui-monospace, 'Courier New', monospace; overflow-wrap: anywhere;
}
.cd-formula sub { font-size: 0.68em; line-height: 0; vertical-align: -0.28em; }
.cd-orb {
  position: absolute; top: 10px; right: 26px; display: none; width: 104px; height: 104px; border-radius: 50%;
  background: radial-gradient(circle at 32% 26%, rgba(255,255,255,0.95) 0 5%, var(--o-hi) 17%, var(--o-mid) 56%, var(--o-lo) 100%);
  box-shadow: inset -8px -10px 18px rgba(0,0,0,0.18), 0 26px 30px -12px rgba(14,16,10,0.45);
}
@media (min-width: 720px) { .cd-orb { display: block; } }

/* ---------------- tabs ---------------- */
.cd-tabs { display: flex; gap: 12px; margin: 22px -8px 0; padding: 12px 8px 16px; overflow-x: auto; scrollbar-width: none; }
.cd-tabs::-webkit-scrollbar { display: none; }
.cd-tab {
  flex: none; padding: 11px 20px; border-radius: 999px; border: 1.5px solid rgba(14,16,10,0.55);
  background: #fff; color: var(--lib-ink-2); cursor: pointer; font: 600 14px/1 var(--lib-font-body);
  box-shadow: 0 3px 0 rgba(14,16,10,0.55), 0 10px 14px -8px rgba(70,95,10,0.4);
  transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
}
.cd-tab:hover { transform: translateY(-1px); color: var(--lib-ink); box-shadow: 0 4px 0 rgba(14,16,10,0.55), 0 12px 16px -8px rgba(70,95,10,0.45); }
.cd-tab:active { transform: translateY(2px); box-shadow: 0 1px 0 rgba(14,16,10,0.55); }
.cd-tab.is-active { background: var(--lib-lime); color: var(--lib-ink); border-color: var(--lib-ink); box-shadow: 0 3px 0 var(--lib-ink), 0 10px 14px -8px rgba(14,16,10,0.45); }

/* ---------------- main panel: the same stacked lime slabs as a Library card ---------------- */
.cd-panel, .cd-scope > .rounded-2xl {
  position: relative; margin: 10px 20px 0 0; padding: 32px; border-radius: 28px;
  background: linear-gradient(160deg, #ffffff 0%, #f7faee 100%); border: 1.5px solid var(--lib-ink);
  box-shadow:
    6px 7px 0 0 #c9e62c, 6px 7px 0 1.5px var(--lib-ink),
    12px 14px 0 0 #b3d022, 12px 14px 0 1.5px var(--lib-ink),
    18px 21px 0 0 #9cb81a, 18px 21px 0 1.5px var(--lib-ink),
    26px 46px 48px -20px rgba(70,95,10,0.5);
}
.cd-bare { margin: 10px 20px 0 0; }
.cd-bare > .rounded-2xl { margin: 0; }
@media (max-width: 639px) {
  .cd-panel, .cd-scope > .rounded-2xl { padding: 20px 16px; margin-right: 14px; }
  .cd-panel { box-shadow: 4px 5px 0 0 #c9e62c, 4px 5px 0 1.5px var(--lib-ink), 8px 10px 0 0 #b3d022, 8px 10px 0 1.5px var(--lib-ink), 16px 30px 34px -16px rgba(70,95,10,0.5); }
}

/* ---------------- text ---------------- */
.cd-lead { margin: 0; max-width: 62ch; font: 400 17px/1.7 var(--lib-font-body); color: var(--lib-ink-2); }
.cd-text { margin: 0; max-width: 68ch; font: 400 15.5px/1.7 var(--lib-font-body); color: var(--lib-ink-2); }
.cd-hint { margin: 10px 0 0; font: 400 13.5px/1.55 var(--lib-font-body); color: var(--lib-ink-3); }
.cd-inline { display: flex; align-items: center; gap: 8px; margin: 0; }
.cd-error { margin: 0; font: 600 14px/1.5 var(--lib-font-body); color: #b42318; }
.cd-fineprint { margin: 24px 0 0; max-width: 68ch; font: 400 12.5px/1.6 var(--lib-font-body); color: var(--lib-ink-3); }
.cd-link { color: #3f5a00; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
.cd-block { margin-top: 30px; }
.cd-block:first-child { margin-top: 0; }
.cd-h { margin: 0 0 12px; font: 700 19px/1.25 var(--lib-font-display); letter-spacing: -0.02em; color: var(--lib-ink); }
.cd-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 32px; }

.cd-callout {
  margin-top: 26px; padding: 18px 20px 20px; max-width: 68ch; border-radius: 20px; border: 1.5px solid var(--lib-ink);
  background: #f3fbc4; box-shadow: 0 4px 0 var(--lib-ink);
}
.cd-callout p { margin: 12px 0 0; font: 400 15.5px/1.65 var(--lib-font-body); color: var(--lib-ink); }
.cd-tag {
  display: inline-block; padding: 4px 12px; border-radius: 999px; border: 1.5px solid var(--lib-ink);
  background: var(--lib-lime); color: var(--lib-ink); font: 700 12px/1.3 var(--lib-font-body);
}

/* ---------------- structure ---------------- */
.cd-stage {
  border-radius: 24px; border: 1.5px solid var(--lib-ink); overflow: hidden;
  background:
    linear-gradient(rgba(14,16,10,0.05) 1px, transparent 1px) 0 0 / 28px 28px,
    linear-gradient(90deg, rgba(14,16,10,0.05) 1px, transparent 1px) 0 0 / 28px 28px,
    radial-gradient(ellipse at 30% 20%, #ffffff, #eef5cf);
  box-shadow: inset 0 3px 8px rgba(14,16,10,0.08), 0 5px 0 var(--lib-ink);
}
.cd-structure-svg { display: block; width: 100%; height: 400px; }
.cd-structure-meta { display: flex; flex-wrap: wrap; gap: 28px 44px; margin-top: 34px; }
.cd-structure-meta .cd-formula { margin-top: 0; }
.cd-smiles { flex: 1 1 260px; min-width: 0; }
.cd-code {
  display: block; padding: 11px 14px; border-radius: 14px; border: 1.5px solid var(--lib-ink); background: #fff;
  font: 500 13px/1.5 'IBM Plex Mono', ui-monospace, monospace; color: var(--lib-ink); overflow-wrap: anywhere;
  box-shadow: 0 3px 0 var(--lib-ink);
}
.cd-empty {
  display: flex; align-items: center; justify-content: center; min-height: 220px; border-radius: 20px;
  border: 1.5px dashed rgba(14,16,10,0.45); color: var(--lib-ink-3); font: 500 14px/1.4 var(--lib-font-body);
}

.cd-quiz-mol { margin-top: 16px; max-width: 520px; }

/* ---------------- properties ---------------- */
.cd-table { border-radius: 20px; border: 1.5px solid var(--lib-ink); overflow: hidden; background: #fff; box-shadow: 0 4px 0 var(--lib-ink); }
.cd-row { display: grid; grid-template-columns: minmax(130px, 260px) minmax(0, 1fr); gap: 6px 20px; padding: 13px 18px; border-top: 1px solid #e1e8c9; }
.cd-row:first-child { border-top: 0; }
.cd-row:nth-child(even) { background: #f8faee; }
.cd-row-label { font: 500 14px/1.5 var(--lib-font-body); color: var(--lib-ink-3); }
.cd-row-value { font: 500 13.5px/1.55 'IBM Plex Mono', ui-monospace, monospace; color: var(--lib-ink); overflow-wrap: anywhere; }
@media (max-width: 639px) { .cd-row { grid-template-columns: minmax(0, 1fr); } }
.cd-syns { display: flex; flex-wrap: wrap; gap: 10px; }
.cd-syn {
  padding: 7px 14px; border-radius: 999px; border: 1.5px solid rgba(14,16,10,0.55); background: #fff; color: var(--lib-ink-2);
  font: 500 13px/1.3 var(--lib-font-body); box-shadow: 0 2px 0 rgba(14,16,10,0.55);
}

/* ---------------- bonding ---------------- */
.cd-stats { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
@media (min-width: 640px) { .cd-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.cd-stat { padding: 18px 20px 20px; border-radius: 20px; border: 1.5px solid var(--lib-ink); background: #fff; box-shadow: 0 4px 0 var(--lib-ink); }
.cd-stat-label { font: 600 13px/1.3 var(--lib-font-body); color: var(--lib-ink-3); }
.cd-stat-value { margin-top: 8px; font: 700 20px/1.3 var(--lib-font-display); letter-spacing: -0.015em; color: var(--lib-ink); }
.cd-stats + .cd-block, .cd-stats + .cd-text { margin-top: 30px; }
.cd-block + .cd-text, .cd-block + .cd-hint { margin-top: 26px; }

/* ---------------- notes ---------------- */
.cd-notes { display: flex; flex-direction: column; gap: 16px; margin-top: 26px; }
.cd-note {
  display: flex; flex-direction: column; align-items: flex-start; width: 100%; padding: 16px 18px; text-align: left; cursor: pointer;
  border-radius: 18px; border: 1.5px solid var(--lib-ink); background: #fff; box-shadow: 0 4px 0 var(--lib-ink);
  transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
}
.cd-note:hover { transform: translateY(-1px); background: #f8fcdc; box-shadow: 0 5px 0 var(--lib-ink); }
.cd-note:active { transform: translateY(3px); box-shadow: 0 1px 0 var(--lib-ink); }
.cd-note-title { font: 600 15.5px/1.35 var(--lib-font-display); color: var(--lib-ink); }
.cd-note-body {
  margin-top: 6px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  font: 400 13.5px/1.5 var(--lib-font-body); color: var(--lib-ink-3);
}

/* ---------------- quiz ---------------- */
.cd-question { margin: 0; max-width: 60ch; font: 700 22px/1.3 var(--lib-font-display); letter-spacing: -0.02em; color: var(--lib-ink); }
.cd-options { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin-top: 26px; }
@media (min-width: 640px) { .cd-options { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.cd-opt {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px; text-align: left; cursor: pointer;
  border-radius: 16px; border: 1.5px solid var(--lib-ink); background: #fff; color: var(--lib-ink);
  font: 600 15px/1.3 'IBM Plex Mono', ui-monospace, monospace; box-shadow: 0 4px 0 var(--lib-ink);
  transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
}
.cd-opt:hover:not(:disabled) { transform: translateY(-1px); background: #f8fcdc; box-shadow: 0 5px 0 var(--lib-ink); }
.cd-opt:active:not(:disabled) { transform: translateY(3px); box-shadow: 0 1px 0 var(--lib-ink); }
.cd-opt:disabled { cursor: default; }
.cd-opt.is-correct { background: var(--lib-lime); }
.cd-opt.is-wrong { background: #ffe1e6; color: #a01a3a; }
.cd-opt.is-dim { opacity: 0.5; box-shadow: 0 2px 0 var(--lib-ink); }

/* ---------------- loading / error ---------------- */
.cd-state {
  display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 36px; padding: 72px 20px; text-align: center;
  border-radius: 28px; border: 1.5px solid var(--lib-ink); background: linear-gradient(180deg, #fff, #f4f8e8);
  font: 600 15px/1.4 var(--lib-font-body); color: var(--lib-ink-2);
  box-shadow: 0 4px 0 #dbe5b9, 0 8px 0 #cfdba6, 0 12px 0 var(--lib-ink), 0 34px 44px -20px rgba(70,95,10,0.5);
}

/* ===============================================================
   Re-skin for the shared panels (NMR, IR, shape diagram, 3D viewer).
   They're written with the dark theme's Tailwind palette, so inside
   .cd-scope those palette variables are re-pointed at light-theme
   values — every utility class (text-lab-300, border-lab-700 ...) and
   every var(--color-...) inside their SVG charts follows along, and
   nothing outside this page is affected.
   =============================================================== */
.cd-scope {
  --color-lab-950: #0e100a;   /* only ever used as text-on-accent in these panels */
  --color-lab-900: #ffffff;
  --color-lab-800: #eff3df;
  --color-lab-700: #b3bd94;
  --color-lab-600: #8b9576;
  --color-lab-500: #666c55;
  --color-lab-400: #4f5540;
  --color-lab-300: #3a3f2f;
  --color-lab-200: #232718;
  --color-lab-100: #0e100a;
  --color-phosphor: #587600;
  --color-phosphor-dim: #4a6300;
  --color-violet: #7053d6;
  --color-amber: #a86200;
  --color-coral: #c22147;
  --color-violet-200: #4c33b3;
  --color-violet-300: #6446c8;
  --color-violet-400: #7454dc;
  --color-sky-300: #0369a1;
  --color-sky-400: #0284c7;
  --color-amber-300: #a16207;
  --color-teal-300: #0f766e;
  color: var(--lib-ink);
}
/* solid accent fills (buttons, checked boxes, active pills) are lime, like the rest of the page */
.cd-scope .bg-phosphor { background-color: #ccEb2d; }
.cd-scope [class*="hover:bg-phosphor-dim"]:hover { background-color: #b9d61f; }
/* "sunken" dark panels become soft tinted ones */
.cd-scope [class*="bg-lab-950"] { background-color: #f4f8e6; }
.cd-scope [class*="border-white"] { border-color: rgba(14,16,10,0.16); }
.cd-scope .bg-violet.text-lab-950 { background-color: #ccEb2d; }

/* a little depth on the panels' inner cards and clickable tiles */
.cd-scope .rounded-xl[class*="border"]:not(.border-dashed) { border-color: rgba(14,16,10,0.4); box-shadow: 0 3px 0 rgba(14,16,10,0.3); }
.cd-scope button[class*="rounded-lg"][class*="border"] {
  border-color: rgba(14,16,10,0.55); box-shadow: 0 3px 0 rgba(14,16,10,0.55);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.cd-scope button[class*="rounded-lg"][class*="border"]:hover { transform: translateY(-1px); }
.cd-scope button[class*="rounded-lg"][class*="border"]:active { transform: translateY(2px); box-shadow: 0 1px 0 rgba(14,16,10,0.55); }

/* ===============================================================
   Phones and small tablets (Android included)
   =============================================================== */
@media (max-width: 639px) {
  .cd-wrap { padding-top: 18px; }
  .cd-head { margin-top: 24px; }
  .cd-tabs { margin-top: 14px; }
  .cd-structure-svg { height: 300px; }
  .cd-structure-meta { gap: 22px; margin-top: 26px; }
  .cd-lead { font-size: 16px; }
  .cd-h { font-size: 18px; }
  .cd-question { font-size: 19px; }
  .cd-actions .lib-btn { flex: 1 1 100%; }
  .cd-bare { margin-right: 14px; }
  .cd-bare > .rounded-2xl { margin: 0; }

  /* NMR / IR: tighter nesting so the content gets the width */
  .cd-scope > .rounded-2xl { padding: 14px 12px; }
  .cd-scope .rounded-xl[class*="p-3"] { padding: 10px; }

  /* Charts are drawn on a fixed 640-unit canvas; squeezing that into a phone made every label
     unreadable. Keep them at a legible size and let the card scroll sideways instead. */
  .cd-scope :has(> svg.w-full) { overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; }
  .cd-scope svg.w-full { min-width: 620px; }
  .cd-scope .rounded-xl:has(> svg.w-full)::after {
    content: "Swipe sideways to see the whole spectrum";
    position: sticky; left: 0; display: block; width: max-content; max-width: 100%; margin-top: 8px;
    font: 500 11px/1.4 var(--lib-font-body); color: var(--lib-ink-3);
  }

  /* the small 3D previews inside NMR / IR: shorter, so the canvas is wider than tall and long molecules fit */
  .cd-scope div[style*="height: 220px"] { height: 170px !important; }

  /* IR band titles wrap instead of being cut off */
  .cd-scope .truncate { overflow: visible; text-overflow: clip; white-space: normal; }

  /* NMR peak table: one small card per peak instead of a sideways-scrolling grid */
  .cd-scope .nmr-table { min-width: 0; }
  .cd-scope .nmr-table thead { display: none; }
  .cd-scope .nmr-table, .cd-scope .nmr-table tbody { display: block; }
  .cd-scope .nmr-table tr {
    display: grid; grid-template-columns: 26px auto minmax(0, 1fr) auto; align-items: center; gap: 6px 10px; padding: 12px 12px;
  }
  .cd-scope .nmr-table td { display: block; min-width: 0; padding: 0; font-size: 12px; }
  .cd-scope .nmr-table td[data-col="check"] { grid-column: 1; }
  .cd-scope .nmr-table td[data-col="num"] { grid-column: 2; }
  .cd-scope .nmr-table td[data-col="shift"] { grid-column: 3; font-size: 14px; }
  .cd-scope .nmr-table td[data-col="conf"] { grid-column: 4; }
  .cd-scope .nmr-table td[data-col="nuclei"],
  .cd-scope .nmr-table td[data-col="mult"],
  .cd-scope .nmr-table td[data-col="type"],
  .cd-scope .nmr-table td[data-col="assign"] { grid-column: 1 / -1; }
  .cd-scope .nmr-table td[data-label]::before {
    content: attr(data-label); display: inline-block; min-width: 96px; margin-right: 8px;
    font: 600 10.5px/1.4 var(--lib-font-body); color: var(--lib-ink-3);
  }
  .cd-scope .nmr-table td[data-col="assign"]::before { display: block; min-width: 0; margin: 0 0 2px; }
  .cd-scope .nmr-table td[data-col="nuclei"] > div { display: inline; margin-left: 6px; }
  .cd-scope .nmr-table td[data-col="conf"]:empty { display: none; }
}
`;