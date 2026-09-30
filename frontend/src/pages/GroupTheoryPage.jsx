import { useEffect, useMemo, useState } from 'react';
import {
  Orbit, Loader2, AlertTriangle, Search, ChevronDown, Sparkles,
  RotateCcw, Info, Atom, Axis3d, FileDown, ListTree, XCircle, Radio, Star,
} from 'lucide-react';
import SymmetryElementsViewer, { KIND_META } from '../components/Viewer3D/SymmetryElementsViewer';
import { Reveal, StaggerGroup, Word, InlineReveal } from '../components/motion/ScrollReveal';
import {
  fetchSymmetryDemos, analyzeSymmetry, fetchPubchemStructure, fetchPubchemGenerate3d, fetchPubchemConformer,
  fetchPubchemConformerNames,
  exportSymmetryReport, extractErrorMessage,
} from '../api/api';
import { symmetryAtomsToMolBlock } from '../lib/symmetryMolblock';
import './GroupTheoryPage.css';

// Height of the 3-D viewers. A fixed 480px is taller than most phone screens
// in landscape and eats the whole viewport in portrait, so scale it down.
function useViewerHeight() {
  const pick = () => {
    if (typeof window === 'undefined') return 480;
    const w = window.innerWidth;
    if (w < 480) return 340;
    if (w < 768) return 400;
    return 480;
  };
  const [h, setH] = useState(pick);
  useEffect(() => {
    const onResize = () => setH(pick());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return h;
}

const PLACEHOLDER = `3
water
O 0 0 0
H 0.757 0.586 0
H -0.757 0.586 0`;

const OP_KIND_LABEL = { E: 'Identity', C: 'Rotation', i: 'Inversion', M: 'Mirror plane', S: 'Improper rotation' };

// Quick-start compounds shown under the PubChem search box.
const QUICK_COMPOUNDS = ['water', 'ammonia', 'methane', 'benzene', 'ferrocene', 'sulfur hexafluoride'];

// Saves a Blob the backend returned as a file download.
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const TICKER_ITEMS = [
  'SCHOENFLIES NOTATION', 'POINT GROUPS', 'CHARACTER TABLES', 'IRREDUCIBLE REPRESENTATIONS',
  '\u0393\u2083\u2099 REDUCTION', 'MIRROR PLANES', 'ROTATION AXES',
];

// The last molecule the user looked at is remembered here so the page never
// opens on an empty "paste something" state — it always reopens on whatever
// was last on screen (or, the very first time, an auto-analyzed default).
const LAST_MOLECULE_KEY = 'gt:lastMolecule:v1';

function loadLastMolecule() {
  try {
    const raw = localStorage.getItem(LAST_MOLECULE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.structure === 'string') return parsed;
  } catch {
    // ignore corrupt/unavailable storage — falls back to the placeholder
  }
  return null;
}

function saveLastMolecule(data) {
  try {
    localStorage.setItem(LAST_MOLECULE_KEY, JSON.stringify(data));
  } catch {
    // storage full/unavailable — not worth surfacing to the user
  }
}

export default function GroupTheoryPage() {
  // Read once, synchronously, so the very first render already has
  // whichever molecule the user left the page on last time.
  const [saved] = useState(() => loadLastMolecule());

  const [demos, setDemos] = useState([]);
  const [structure, setStructure] = useState(saved?.structure || PLACEHOLDER);
  const [tolerance, setTolerance] = useState(saved?.tolerance ?? 0.08);
  const [pubchemQuery, setPubchemQuery] = useState(saved?.pubchemQuery || '');

  // Two independent busy flags: searching PubChem and calculating the point
  // group are separate actions, so each button only ever spins for its own job.
  const [searching, setSearching] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [exporting, setExporting] = useState(false);
  // generating: the backend is building a 3-D geometry for a compound PubChem only has a 2-D drawing of.
  // switchingConformer: fetching + analysing a conformer picked from the chooser.
  const [generating, setGenerating] = useState(false);
  const [switchingConformer, setSwitchingConformer] = useState(false);
  const busy = searching || calculating || generating || switchingConformer;
  // The exact structure + tolerance (+ PubChem CID) the current result was
  // calculated from — this is what the backend re-analyzes for the export,
  // so the report always matches the result on screen even if the text box
  // has been edited since.
  const [analyzed, setAnalyzed] = useState(() =>
    saved?.result
      ? { structure: saved.structure, tolerance: saved.tolerance ?? 0.08, cid: saved.pubchemMeta?.cid ?? null }
      : null
  );
  const [error, setError] = useState(null);
  const [result, setResult] = useState(saved?.result || null);
  const [pubchemMeta, setPubchemMeta] = useState(saved?.pubchemMeta || null);
  // A structure that has been fetched (from PubChem) and can already be
  // shown in 3-D, but hasn't been run through the symmetry engine yet —
  // that only happens once the user clicks "Calculate point group". Kept
  // separate from `result` so the "point group not calculated yet" view
  // and the full report never get confused with each other.
  const [preview, setPreview] = useState(null);
  // Alternative 3-D conformers of the loaded compound (PubChem's own, or ones the backend generated),
  // and which one is on screen. Empty when there is only one, so no chooser is shown.
  const [conformers, setConformers] = useState([]);
  const [activeConformerId, setActiveConformerId] = useState(null);
  // Shape names (Staggered, Eclipsed, Chair ...) for PubChem's own conformers, looked up in the background
  // after a search: { [conformerId]: { name, detail } }. Generated conformers carry their name already.
  const [conformerNames, setConformerNames] = useState({});
  // Which "load a structure" tab is showing — paste-a-structure or
  // search-PubChem. Purely a UI toggle so both ways to load a molecule
  // live in one card instead of two stacked ones.
  const [loadMode, setLoadMode] = useState('pubchem');
  const [showDerivation, setShowDerivation] = useState(false);
  const [hoveredOp, setHoveredOp] = useState(null);
  const [pinnedOp, setPinnedOp] = useState(null);
  const [playRequest, setPlayRequest] = useState(null); // { label, token } — token forces a replay even on the same label
  const activeHighlight = hoveredOp || pinnedOp;

  // A fresh analysis invalidates any pinned/hovered operation label from
  // the previous structure (it may not even exist in the new one).
  useEffect(() => {
    setHoveredOp(null);
    setPinnedOp(null);
    setPlayRequest(null);
  }, [result]);

  useEffect(() => {
    let cancelled = false;
    fetchSymmetryDemos()
      .then((data) => { if (!cancelled) setDemos(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // First-ever visit (nothing saved yet): don't leave the results panel
  // empty — auto-run the placeholder so there's always a molecule showing.
  useEffect(() => {
    if (!saved) runAnalyze(PLACEHOLDER);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever a new result lands, remember it (with the structure/tolerance/
  // query that produced it) so reopening the page picks up right here.
  useEffect(() => {
    if (!result) return;
    saveLastMolecule({ structure, tolerance, pubchemQuery, result, pubchemMeta });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Runs the actual symmetry engine on whatever structure text is
  // currently loaded (pasted by hand, a demo, or a structure already
  // fetched from PubChem via runPubchem below). This is the one call that
  // does the heavy lifting, so it only ever fires when the user explicitly
  // asks for it — either by clicking "Calculate point group" directly, or
  // by clicking it from the preview card after a PubChem search.
  const runAnalyze = async (text = structure, cid = pubchemMeta?.cid ?? null) => {
    setCalculating(true);
    setError(null);
    try {
      const r = await analyzeSymmetry(text, tolerance);
      setResult(r);
      setAnalyzed({ structure: text, tolerance, cid });
      setPreview(null); // superseded by the full result now
    } catch (err) {
      setError(extractErrorMessage(err, "Couldn't analyze that structure."));
      setResult(null);
    } finally {
      setCalculating(false);
    }
  };

  // Export: the report is built on the backend (POST /api/symmetry/report),
  // which re-runs the analysis on the exact structure behind the result and
  // sends the finished file back — nothing is assembled in the browser.
  const handleExport = async () => {
    if (!result || exporting) return;
    const src = analyzed || { structure, tolerance, cid: pubchemMeta?.cid ?? null };
    setExporting(true);
    setError(null);
    try {
      const { blob, filename } = await exportSymmetryReport(src.structure, src.tolerance, src.cid);
      saveBlob(blob, filename);
    } catch (err) {
      setError(extractErrorMessage(err, "Couldn't export the report."));
    } finally {
      setExporting(false);
    }
  };

  // Search step only: resolves the compound and loads its real 3-D
  // structure into the viewer immediately. Deliberately does NOT run the
  // symmetry engine — that used to happen automatically on every search
  // and was the source of the long delay, since point-group detection
  // scales with atom count/symmetry richness. The engine now only runs
  // when the user clicks "Calculate point group" afterwards.
  const applyPreview = (p) => {
    setStructure(p.sourceStructure || structure);
    setPreview(p);
    setPubchemMeta({ cid: p.pubchemCid, url: p.pubchemUrl });
    setConformers(p.conformers || []);
    setActiveConformerId(p.activeConformerId || null);
    const pubchemOnes = (p.conformers || []).filter((c) => c.source === 'pubchem');
    if (pubchemOnes.length && p.pubchemCid) {
      fetchPubchemConformerNames(p.pubchemCid, pubchemOnes.map((c) => c.id))
        .then((names) => setConformerNames((prev) => ({ ...prev, ...names })))
        .catch(() => {}); // names are decoration; the chooser works without them
    }
  };

  // Second step for compounds with no 3-D record at PubChem: ask the backend to build a geometry.
  // The 2-D drawing stays on screen (analysis blocked) until it comes back, so the search itself
  // never waits on this.
  const buildGenerated = async (p2d) => {
    setGenerating(true);
    try {
      const g = await fetchPubchemGenerate3d(p2d.pubchemCid);
      applyPreview(g);
    } catch (err) {
      setPreview({
        ...p2d,
        needsGeneration: false,
        analysisBlocked: true,
        structureWarning: extractErrorMessage(err, "Couldn't build a 3-D structure for this compound."),
      });
    } finally {
      setGenerating(false);
    }
  };

  const runPubchem = async (query = pubchemQuery) => {
    const q = String(query || '').trim();
    if (!q) return;
    if (q !== pubchemQuery) setPubchemQuery(q);
    setSearching(true);
    setError(null);
    setResult(null);
    setPreview(null);
    setPubchemMeta(null);
    setConformers([]);
    setActiveConformerId(null);
    let pending = null;
    try {
      const p = await fetchPubchemStructure(q);
      applyPreview(p);
      if (p.needsGeneration) pending = p;
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not fetch that compound from PubChem.'));
      setPreview(null);
    } finally {
      setSearching(false);
    }
    if (pending) buildGenerated(pending);
  };

  // Click on a conformer chip: load that exact geometry and show its point group straight away.
  const selectConformer = async (c) => {
    if (busy || c.id === activeConformerId) return;
    const cid = pubchemMeta?.cid;
    setError(null);
    setSwitchingConformer(true);
    try {
      let text;
      if (c.source === 'generated') {
        text = c.structure;
      } else {
        const p = await fetchPubchemConformer(cid, c.id);
        text = p.sourceStructure;
      }
      setStructure(text);
      setActiveConformerId(c.id);
      const r = await analyzeSymmetry(text, tolerance);
      setResult(r);
      setAnalyzed({ structure: text, tolerance, cid });
      setPreview(null);
    } catch (err) {
      setError(extractErrorMessage(err, "Couldn't load or analyze that conformer."));
    } finally {
      setSwitchingConformer(false);
    }
  };

  const loadDemo = (demo) => {
    setStructure(demo.xyz);
    setPubchemQuery('');
    setPubchemMeta(null);
    setPreview(null);
    setConformers([]);
    setActiveConformerId(null);
    runAnalyze(demo.xyz, null);
  };

  const molBlock = useMemo(() => {
    const atoms = result?.atoms || preview?.atoms;
    const bonds = result?.bonds || preview?.bonds;
    if (!atoms?.length) return null;
    return symmetryAtomsToMolBlock(atoms, bonds || [], result?.formulaPretty || preview?.formulaPretty || 'Structure');
  }, [result, preview]);

  const opGroups = useMemo(() => {
    if (!result?.operations) return [];
    const byKind = new Map();
    for (const op of result.operations) {
      if (!byKind.has(op.kind)) byKind.set(op.kind, []);
      byKind.get(op.kind).push(op.label);
    }
    return [...byKind.entries()];
  }, [result]);

  // While this page is mounted, force the surrounding <html>/<body> to the
  // same paper-cream color as the page itself. The rest of the app is a
  // dark "lab" theme (see index.css), so without this, any sliver of body
  // background that peeks past the page content — wide-viewport side
  // margins, mobile overscroll/rubber-banding above or below the page —
  // showed the dark theme through. The navbar is a separate fixed element
  // and keeps its own dark background on purpose.
  const viewerHeight = useViewerHeight();

  useEffect(() => {
    document.documentElement.classList.add('gt-light-scroll');
    document.body.classList.add('gt-light-scroll');
    return () => {
      document.documentElement.classList.remove('gt-light-scroll');
      document.body.classList.remove('gt-light-scroll');
    };
  }, []);

  const bondCount = result?.bonds?.length ?? preview?.bonds?.length ?? 0;
  const conformerLabel = (c) => {
    const n = c.name || conformerNames[c.id]?.name;
    return n ? `${c.label} \u00b7 ${n}` : c.label;
  };
  const conformerTip = (c) => c.detail || conformerNames[c.id]?.detail || undefined;
  const liveStatusLine = pubchemMeta
    ? result
      ? `PubChem CID ${pubchemMeta.cid} \u00b7 3-D structure loaded into the simulator \u00b7 point group ${result.groupPretty} \u00b7 ${result.atomCount} atoms \u00b7 ${bondCount} bonds`
      : `PubChem CID ${pubchemMeta.cid} \u00b7 3-D structure loaded into the simulator \u00b7 ${preview?.atomCount ?? '?'} atoms \u00b7 ${bondCount} bonds \u00b7 point group not calculated yet`
    : result
    ? `3-D structure loaded into the simulator \u00b7 point group ${result.groupPretty} \u00b7 ${result.atomCount} atoms \u00b7 ${bondCount} bonds`
    : null;

  return (
    <div className="gt-page min-h-screen w-full overflow-x-clip">
    <div className="gt-shell mx-auto w-full max-w-[1680px] overflow-x-clip px-3 pb-24 pt-6 sm:px-6 lg:px-10">
      {/* ---------------- hero ---------------- */}
      <div className="gt-section gt-section-paper relative mb-6 px-4 py-6 sm:px-9 sm:py-12">
        <div
          className="gt-hero-diamond pointer-events-none absolute -left-6 top-10 hidden h-10 w-10 border-2 border-[var(--gt-ink)]/25 sm:block"
          aria-hidden="true"
        />

        <div className="relative z-10 grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <div>
            <Reveal trigger="mount" className="gt-kicker mb-4">
              <span className="gt-kicker-num">01</span> Symmetry lab
            </Reveal>

            <StaggerGroup as="h1" trigger="mount" className="gt-heading text-[1.85rem] sm:text-5xl lg:text-6xl">
              <Word>Find</Word> <Word>the</Word>{' '}
              <InlineReveal as="span" className="gt-mark">symmetry</InlineReveal>{' '}
              <Word>hiding</Word> <Word>in</Word> <Word>any</Word> <Word>molecule.</Word>
            </StaggerGroup>

            <Reveal trigger="mount" delay={0.2} as="p" className="mt-4 max-w-xl text-sm leading-relaxed text-[var(--gt-ink-soft)] sm:text-[15px]">
              Real symmetry detection, not a lookup table — three steps and you&rsquo;re staring at a point group.
            </Reveal>

            <Reveal trigger="mount" delay={0.28} className="gt-steps mt-5">
              <span className="gt-step"><span className="gt-step-emoji" aria-hidden="true">🔍</span> Search or paste</span>
              <span className="gt-step-arrow" aria-hidden="true">&rarr;</span>
              <span className="gt-step"><span className="gt-step-emoji" aria-hidden="true">🧬</span> Spin it in 3-D</span>
              <span className="gt-step-arrow" aria-hidden="true">&rarr;</span>
              <span className="gt-step"><span className="gt-step-emoji" aria-hidden="true">⚡</span> Calculate</span>
            </Reveal>
          </div>

          <Reveal trigger="mount" delay={0.15} direction="up" className="min-w-0">
            <GTHeroGraphic />
          </Reveal>
        </div>

        <div className="gt-ticker-row relative z-10 mt-8 border-t-2 border-[var(--gt-ink)] pt-3">
          <div className="gt-ticker-track">
            {[...TICKER_ITEMS, ...TICKER_ITEMS].map((t, i) => (
              <span key={i} className="mx-4 font-display text-[11px] font-bold uppercase tracking-widest text-[var(--gt-ink-soft)]">
                {t} <span className="text-[var(--gt-orange)]">&middot;</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* ---------------- input panel ---------------- */}
        <div className="min-w-0 space-y-5">
          <div className="gt-section gt-section-light relative px-4 py-5 sm:px-5 sm:py-6">
            <div className="relative z-10">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="gt-kicker text-[var(--gt-ink-soft)]"><span className="gt-kicker-num">02</span> Load a structure</span>
                <div className="gt-tab-group">
                  <button
                    type="button"
                    onClick={() => setLoadMode('pubchem')}
                    className={`gt-tab gt-tab-hot ${loadMode === 'pubchem' ? 'is-active' : ''}`}
                  >
                    <Search size={12} /> PubChem
                    <span className="gt-tab-badge"><Star size={8} fill="currentColor" /> Start here</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLoadMode('paste')}
                    className={`gt-tab ${loadMode === 'paste' ? 'is-active' : ''}`}
                  >
                    Paste
                  </button>
                </div>
              </div>

              {loadMode === 'pubchem' ? (
                <div className="mt-4">
                  <div className="gt-spot">
                    <label className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[var(--gt-ink)]">
                      <Search size={13} /> Search any compound or CID
                    </label>
                    <div className="flex gap-2">
                      <input
                        value={pubchemQuery}
                        onChange={(e) => setPubchemQuery(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && runPubchem()}
                        placeholder="e.g. \u201cferrocene\u201d or 2519"
                        className="gt-input min-w-0 flex-1 text-sm"
                        enterKeyHint="search"
                        autoCapitalize="none"
                        autoCorrect="off"
                      />
                      <button onClick={() => runPubchem()} disabled={busy} className="gt-btn shrink-0 px-4" aria-label="Search PubChem">
                        {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                        <span className="hidden min-[400px]:inline">Search</span>
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-semibold text-[var(--gt-ink-soft)]">Try:</span>
                    {QUICK_COMPOUNDS.map((name) => (
                      <button key={name} type="button" onClick={() => runPubchem(name)} disabled={busy} className="gt-chip">
                        {name}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-[var(--gt-ink)]/60">
                    Pulls the real 3-D structure first &mdash; nothing gets calculated until you say so.
                  </p>
                </div>
              ) : (
                <>
                  <label className="mb-2 mt-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink)]/80">
                    <Atom size={13} /> XYZ / SDF / PDB
                  </label>
                  <textarea
                    value={structure}
                    onChange={(e) => {
                      setStructure(e.target.value);
                      // Hand-editing the box invalidates any PubChem-sourced
                      // preview/attribution — it's no longer the fetched structure.
                      setPreview(null);
                      setPubchemMeta(null);
                      setConformers([]);
                      setActiveConformerId(null);
                    }}
                    rows={9}
                    spellCheck={false}
                    className="gt-textarea text-xs"
                  />
                </>
              )}

              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <label className="gt-tolerance-box">
                  <span className="text-[var(--gt-ink)]/70">Tolerance</span>
                  <input
                    type="number"
                    min={0.01}
                    max={0.3}
                    step={0.01}
                    value={tolerance}
                    onChange={(e) => setTolerance(parseFloat(e.target.value) || 0)}
                  />
                  <span className="text-[var(--gt-ink)]/70">&Aring;</span>
                </label>
                <button onClick={() => runAnalyze()} disabled={busy} className="gt-btn w-full justify-center sm:w-auto">
                  {calculating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                  Calculate point group
                </button>
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--gt-ink)]/55">
                Higher tolerance forgives noisy coordinates, but can over-detect symmetry.
              </p>

              {liveStatusLine && (
                <div className="gt-status-line mt-4">
                  <span className="gt-live-dot" />
                  <span>
                    {liveStatusLine}
                    {pubchemMeta && (
                      <>
                        {' \u00b7 '}
                        <a href={pubchemMeta.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">
                          Open PubChem record
                        </a>
                      </>
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>

          {demos.length > 0 && (
            <div className="gt-card p-4 sm:p-5">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink-soft)]">
                Demo structures
              </label>
              <div className="flex flex-wrap gap-1.5">
                {demos.map((d) => (
                  <button key={d.key} onClick={() => loadDemo(d)} className="gt-chip">
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="gt-card-flat flex items-start gap-2 border-[var(--gt-ink)] p-3 text-xs" style={{ background: '#fdece7' }}>
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#c24a2e]" />
              <span className="text-[#7a2f1c]">{error}</span>
            </div>
          )}
        </div>

        {/* ---------------- results panel ---------------- */}
        <div className="min-w-0 space-y-5">
          <span className="gt-kicker text-[var(--gt-ink-soft)]"><span className="gt-kicker-num">03</span> Results</span>

          {!result && !preview && !busy && (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-[18px] border-2 border-dashed border-[var(--gt-ink)]/30 bg-[var(--gt-paper-soft)] p-8 text-center">
              <Orbit size={28} className="mb-2 text-[var(--gt-ink-soft)]" />
              <p className="text-sm text-[var(--gt-ink-soft)]">Paste a structure, pick a demo, or fetch one from PubChem to get started.</p>
            </div>
          )}

          {conformers.length > 1 && (
            <Reveal className="gt-card p-4 sm:p-5">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink-soft)]">
                Choose a conformer
              </label>
              <p className="mb-2.5 text-[11px] leading-relaxed text-[var(--gt-ink)]/70">
                This compound has {conformers.length} distinct 3-D shapes. Click one to load it and see its point group &mdash; different conformers can have different symmetry.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {conformers.map((c) => {
                  const active = c.id === activeConformerId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => selectConformer(c)}
                      disabled={busy}
                      aria-pressed={active}
                      className="gt-chip"
                      title={conformerTip(c)}
                      style={active ? { background: 'var(--gt-ink)', color: 'var(--gt-paper)' } : undefined}
                    >
                      {conformerLabel(c)}
                    </button>
                  );
                })}
                {switchingConformer && <Loader2 size={15} className="ml-1 animate-spin self-center" />}
              </div>
            </Reveal>
          )}

          {!result && preview && (
            <>
              <Reveal className="gt-card p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="gt-heading text-xl text-[var(--gt-ink)] sm:text-2xl">{preview.formulaPretty}</div>
                    <p className="mt-1 text-xs text-[var(--gt-ink-soft)]">
                      {preview.analysisBlocked ? '2-D drawing only' : '3-D structure loaded'} &middot; {preview.atomCount} atoms &middot; {preview.bondCount} bonds
                    </p>
                    {preview.conformerName && <ConformerBadge name={preview.conformerName} detail={preview.conformerDetail} />}
                    {generating ? (
                      <p className="mt-2 flex max-w-xl items-center gap-2 text-[12px] leading-relaxed text-[var(--gt-ink)]/80">
                        <Loader2 size={13} className="shrink-0 animate-spin" />
                        PubChem has no 3-D record for this compound &mdash; building a 3-D geometry now. This can take up to about 40 seconds.
                      </p>
                    ) : preview.analysisBlocked ? (
                      <p className="mt-2 max-w-xl text-[12px] leading-relaxed text-[var(--gt-ink)]/80">
                        No point group can be calculated from this flat drawing.
                      </p>
                    ) : (
                      <p className="mt-2 max-w-xl text-[12px] leading-relaxed text-[var(--gt-ink)]/80">
                        Point group not calculated yet. Rotate and inspect the structure below, then hit
                        &ldquo;Calculate point group&rdquo; when you&rsquo;re ready to run the symmetry engine.
                      </p>
                    )}
                  </div>
                  <button onClick={() => runAnalyze()} disabled={busy || preview.analysisBlocked} className="gt-btn w-full justify-center sm:w-auto">
                    {calculating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                    Calculate point group
                  </button>
                </div>

                {preview.structureNote && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border-2 border-[var(--gt-teal)]/40 p-2.5 text-[11px]" style={{ background: '#e9f6f4' }}>
                    <Info size={14} className="mt-0.5 shrink-0 text-[var(--gt-teal)]" />
                    <span className="text-[#1c5c54]">{preview.structureNote}</span>
                  </div>
                )}
                {preview.structureWarning && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border-2 border-[var(--gt-orange)]/50 p-2.5 text-[11px]" style={{ background: '#fdf1de' }}>
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--gt-orange)]" />
                    <span className="text-[#6b4a13]">{preview.structureWarning}</span>
                  </div>
                )}
              </Reveal>

              {molBlock && (
                <Reveal delay={0.03} className="gt-card-flat gt-viewer-card overflow-hidden">
                  <div className="flex items-center gap-1.5 border-b-2 border-[var(--gt-ink)] px-4 py-2.5">
                    <Axis3d size={13} className="text-[var(--gt-teal)]" />
                    <span className="text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink-soft)]">
                      Live 3-D structure &mdash; symmetry not run yet
                    </span>
                  </div>
                  <div className="p-1.5">
                    <SymmetryElementsViewer
                      molBlock={molBlock}
                      atoms={preview.atoms}
                      operations={[]}
                      groupPretty={null}
                      formulaPretty={preview.formulaPretty}
                      height={viewerHeight}
                    />
                  </div>
                </Reveal>
              )}
            </>
          )}

          {result && (
            <>
              <Reveal className="gt-card p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="gt-heading text-3xl text-[var(--gt-teal)] sm:text-4xl">{result.groupPretty}</div>
                    <p className="mt-1 text-xs text-[var(--gt-ink-soft)]">
                      Detected automatically from {result.atomCount} atoms &middot; formula {result.formulaPretty}
                    </p>
                    {result.conformerName && <ConformerBadge name={result.conformerName} detail={result.conformerDetail} />}
                    {result.groupDescription && (
                      <p className="mt-2 max-w-xl text-[12px] leading-relaxed text-[var(--gt-ink)]/80">
                        {result.groupDescription}
                      </p>
                    )}
                  </div>
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <button onClick={handleExport} disabled={exporting || busy} className="gt-btn-ghost flex-1 justify-center disabled:opacity-60 sm:flex-none">
                      {exporting ? <Loader2 size={12} className="animate-spin" /> : <FileDown size={12} />}
                      {exporting ? 'Exporting\u2026' : 'Export report'}
                    </button>
                    <button onClick={() => runAnalyze()} disabled={busy} className="gt-btn-ghost flex-1 justify-center disabled:opacity-60 sm:flex-none">
                      {calculating ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Re-run
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Group order" value={result.orderLabel ? `${result.orderLabel} (infinite)` : `${result.detectedOps} / ${result.expectedOrder}`} />
                  <Stat label="Inversion" value={result.inversion ? 'Yes' : 'No'} />
                  <Stat label="Mirror planes" value={result.mirrorCount} />
                  <Stat label="Improper rot." value={result.improperRotationCount} />
                  <Stat label="Rotational orders" value={result.rotationalOrders?.join(', ') || 'none'} />
                  <Stat label="Linear" value={result.linear ? 'Yes' : 'No'} />
                  <Stat label="Tolerance" value={`${result.tolerance.toFixed(3)} \u00c5`} />
                  <Stat label="Max match error" value={`${result.maxError.toFixed(4)} \u00c5`} />
                  {typeof result.symmetryScore === 'number' && (
                    <Stat label="Symmetry score" value={`${result.symmetryScore}%`} />
                  )}
                </div>

                {result.distortionWarning && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border-2 border-[var(--gt-orange)]/50 p-2.5 text-[11px]" style={{ background: '#fdf1de' }}>
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--gt-orange)]" />
                    <span className="text-[#6b4a13]">{result.distortionWarning}</span>
                  </div>
                )}
              </Reveal>

              {molBlock && (
                <Reveal delay={0.03} className="gt-card-flat gt-viewer-card overflow-hidden">
                  <div className="flex items-center gap-1.5 border-b-2 border-[var(--gt-ink)] px-4 py-2.5">
                    <Axis3d size={13} className="text-[var(--gt-teal)]" />
                    <span className="text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink-soft)]">
                      Live 3-D structure &mdash; the main event
                    </span>
                  </div>
                  <div className="p-1.5">
                    <SymmetryElementsViewer
                      molBlock={molBlock}
                      atoms={result.atoms}
                      center={result.center}
                      operations={result.operations}
                      groupPretty={result.groupPretty}
                      formulaPretty={result.formulaPretty}
                      height={viewerHeight}
                      highlightLabel={activeHighlight}
                      onHighlightChange={setHoveredOp}
                      playRequest={playRequest}
                    />
                  </div>
                </Reveal>
              )}

              <Reveal delay={0.06} className="gt-card p-4 sm:p-5">
                <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink-soft)]">
                  <Axis3d size={13} /> Detected symmetry operations
                </div>
                <p className="mb-3 text-[11px] text-[var(--gt-ink-soft)]">
                  Hover an operation to spotlight its axis or plane above; click to play it out on the structure.
                </p>
                <div className="space-y-2">
                  {opGroups.map(([kind, labels]) => (
                    <div key={kind} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="flex w-full shrink-0 items-center gap-1.5 text-[11px] text-[var(--gt-ink-soft)] sm:w-32">
                        {KIND_META[kind] && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: KIND_META[kind].color }} />
                        )}
                        {OP_KIND_LABEL[kind] || kind} ({labels.length})
                      </span>
                      <div className="flex min-w-0 flex-wrap gap-1.5 sm:gap-1">
                        {labels.slice(0, 24).map((l, i) => {
                          const isActive = activeHighlight === l;
                          return (
                            <button
                              key={i}
                              type="button"
                              onMouseEnter={() => setHoveredOp(l)}
                              onMouseLeave={() => setHoveredOp(null)}
                              onClick={() => {
                                setPinnedOp((p) => (p === l ? null : l));
                                setPlayRequest({ label: l, token: Date.now() });
                              }}
                              style={{ borderLeftColor: KIND_META[kind]?.color || undefined }}
                              className={`gt-op-btn ${isActive ? 'is-active' : ''}`}
                            >
                              {l}
                            </button>
                          );
                        })}
                        {labels.length > 24 && (
                          <span className="text-[10px] text-[var(--gt-ink-soft)]">+{labels.length - 24} more</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Reveal>

              {(result.decisionTrace?.length > 0 || result.rejectedTests?.length > 0) && (
                <Reveal delay={0.08} className="gt-card p-4 sm:p-5">
                  {result.decisionTrace?.length > 0 && (
                    <>
                      <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink-soft)]">
                        <ListTree size={13} /> Why this point group
                      </div>
                      <ol className="space-y-1.5 text-[12px] leading-relaxed text-[var(--gt-ink)]/85">
                        {result.decisionTrace.map((line, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="shrink-0 font-mono text-[10px] text-[var(--gt-ink-soft)]">{i + 1}.</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ol>
                    </>
                  )}

                  {result.rejectedTests?.length > 0 && (
                    <>
                      <div className={`${result.decisionTrace?.length ? 'mt-5 border-t-2 border-[var(--gt-ink)]/10 pt-4' : ''} mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink-soft)]`}>
                        <XCircle size={13} /> Symmetry tests that didn&rsquo;t pass
                      </div>
                      <p className="mb-2 text-[11px] text-[var(--gt-ink-soft)]">
                        Closest miss for each element that was tested but not found, sorted by how close it came.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {result.rejectedTests.map((t, i) => (
                          <span key={i} className="gt-op-btn" style={{ borderLeftColor: '#c24a2e', cursor: 'default' }}>
                            {t.label} <span className="text-[var(--gt-ink-soft)]">&mdash; off by {t.errorAngstrom} &Aring;</span>
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </Reveal>
              )}

              {result.representation ? (
                <Reveal delay={0.1} className="gt-card p-4 sm:p-5">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--gt-teal)]">
                    Representation reduction
                  </div>
                  <div className="space-y-1 break-words rounded-lg border-2 border-[var(--gt-ink)]/10 bg-[var(--gt-paper-soft)] p-3 font-mono text-[12px] text-[var(--gt-ink)] [overflow-wrap:anywhere]">
                    <div>&Gamma;<sub>3N</sub> = {result.representation.gamma3N}</div>
                    <div>&Gamma;<sub>trans</sub> = {result.representation.gammaTrans}</div>
                    <div>&Gamma;<sub>rot</sub> = {result.representation.gammaRot}</div>
                    <div className="text-[#b46a13] font-semibold">&Gamma;<sub>vib</sub> = {result.representation.gammaVib}</div>
                  </div>

                  <div className="gt-chartable-wrap mt-4 overflow-x-auto">
                    <table className="gt-chartable w-full min-w-[420px] text-left text-xs text-[var(--gt-ink)]">
                      <thead>
                        <tr className="text-[var(--gt-ink-soft)]">
                          <th className="py-1 pr-3 font-medium">Class</th>
                          <th className="py-1 pr-3 font-medium">Size</th>
                          <th className="py-1 pr-3 font-medium">&chi;(&Gamma;<sub>3N</sub>)</th>
                          {result.characterTable.irreps.map((ir) => (
                            <th key={ir.name} className="py-1 pr-3 font-medium">{ir.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.representation.classRows.map((row) => (
                          <tr key={row.label} className="border-t border-[var(--gt-ink)]/10">
                            <td className="py-1 pr-3 font-mono">{row.label}</td>
                            <td className="py-1 pr-3">{row.size}</td>
                            <td className="py-1 pr-3">{row.chiGamma3N}</td>
                            {row.characters.map((c, i) => (
                              <td key={i} className="py-1 pr-3">{c}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {result.representation.note && (
                    <p className="mt-3 text-[11px] leading-relaxed text-[var(--gt-ink-soft)]">{result.representation.note}</p>
                  )}

                  {result.representation.validation && (
                    <div
                      className="mt-3 flex items-center gap-1.5 rounded-lg border-2 p-2 text-[11px]"
                      style={
                        result.representation.validation.gamma3NMatchesAtomCount && result.representation.validation.decompositionConsistent
                          ? { borderColor: 'rgba(15,157,138,0.3)', background: 'rgba(15,157,138,0.08)', color: '#0f6e5f' }
                          : { borderColor: 'rgba(194,74,46,0.4)', background: '#fdece7', color: '#7a2f1c' }
                      }
                    >
                      {result.representation.validation.gamma3NMatchesAtomCount && result.representation.validation.decompositionConsistent ? (
                        <>&#10003; Validated: &Gamma;<sub>3N</sub> accounts for exactly {result.representation.validation.gamma3NDimension} of {result.representation.validation.expectedDimension} Cartesian degrees of freedom (3N), and &Gamma;<sub>trans</sub>+&Gamma;<sub>rot</sub>+&Gamma;<sub>vib</sub> reconstructs it exactly.</>
                      ) : (
                        <>&#9888; Reduction mismatch: got {result.representation.validation.gamma3NDimension} of {result.representation.validation.expectedDimension} expected degrees of freedom &mdash; treat this vibrational breakdown with caution.</>
                      )}
                    </div>
                  )}

                  {result.representation.spectroscopy?.length > 0 && (
                    <div className="mt-4">
                      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--gt-ink-soft)]">
                        <Radio size={13} /> IR / Raman activity
                      </div>
                      <div className="gt-chartable-wrap overflow-x-auto">
                        <table className="gt-chartable w-full min-w-[320px] text-left text-xs text-[var(--gt-ink)]">
                          <thead>
                            <tr className="text-[var(--gt-ink-soft)]">
                              <th className="py-1 pr-3 font-medium">Irrep</th>
                              <th className="py-1 pr-3 font-medium">Modes</th>
                              <th className="py-1 pr-3 font-medium">IR active</th>
                              <th className="py-1 pr-3 font-medium">Raman active</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.representation.spectroscopy.map((s) => (
                              <tr key={s.irrep} className="border-t border-[var(--gt-ink)]/10">
                                <td className="py-1 pr-3 font-mono">{s.irrep}</td>
                                <td className="py-1 pr-3">{s.count}</td>
                                <td className="py-1 pr-3">{s.irActive ? '\u2713' : '\u2014'}</td>
                                <td className="py-1 pr-3">
                                  {s.ramanActive ? '\u2713' : '\u2014'}
                                  {s.silent && <span className="ml-1 text-[10px] text-[var(--gt-ink-soft)]">(silent)</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => setShowDerivation((s) => !s)}
                    className="mt-4 flex items-center gap-1 text-xs font-semibold text-[var(--gt-teal)] hover:underline"
                  >
                    <Info size={13} />
                    How this is derived
                    <ChevronDown size={13} className={`transition-transform ${showDerivation ? 'rotate-180' : ''}`} />
                  </button>
                  {showDerivation && (
                    <ol className="mt-3 space-y-2 text-[12px] leading-relaxed text-[var(--gt-ink-soft)]">
                      <li>
                        <b className="text-[var(--gt-ink)]">1. Build &Gamma;<sub>3N</sub>.</b> The 3N Cartesian
                        displacement coordinates are the basis. Only atoms an operation leaves in place
                        contribute: a proper rotation by &theta; contributes 1&nbsp;+&nbsp;2cos&theta; per
                        fixed atom, an improper operation contributes &minus;1&nbsp;+&nbsp;2cos&theta;.
                      </li>
                      <li>
                        <b className="text-[var(--gt-ink)]">2. Reduce it.</b> For each irreducible representation
                        &Gamma;<sub>i</sub>, the multiplicity is a<sub>i</sub> = (1/h) &sum;<sub>R</sub> n<sub>R</sub> &chi;<sub>3N</sub>(R) &chi;<sub>i</sub>(R),
                        with h the group order and n<sub>R</sub> the class size.
                      </li>
                      <li>
                        <b className="text-[var(--gt-ink)]">3. Strip translation and rotation.</b> &Gamma;<sub>vib</sub> = &Gamma;<sub>3N</sub> &minus; &Gamma;<sub>trans</sub> &minus; &Gamma;<sub>rot</sub>,
                        using the x/y/z and R<sub>x</sub>/R<sub>y</sub>/R<sub>z</sub> basis functions from the character table.
                      </li>
                      <li>
                        <b className="text-[var(--gt-ink)]">4. The point group itself</b> comes first and
                        separately &mdash; from the actual operations discovered on this geometry (their
                        closure, then grouped into conjugacy classes), not from this table.
                      </li>
                    </ol>
                  )}
                </Reveal>
              ) : (
                <div className="gt-card-flat flex items-start gap-2 p-3 text-xs" style={{ background: '#fdf1de' }}>
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--gt-orange)]" />
                  <span className="text-[#6b4a13]">
                    {result.representationError
                      ? `Point group found, but the representation reduction couldn't be completed: ${result.representationError}`
                      : `A character table for ${result.groupPretty} isn't in this build yet, so the point group is shown above but the \u0393 reduction isn't.`}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

// The detected shape of the loaded geometry (Staggered, Eclipsed, Chair, Trigonal bipyramidal ...).
function ConformerBadge({ name, detail }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        className="inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--gt-ink)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--gt-ink)]"
        style={{ background: '#fdf1de' }}
      >
        <span className="uppercase tracking-wide text-[var(--gt-ink-soft)]">Conformer</span>
        {name}
      </span>
      {detail && <span className="text-[11px] text-[var(--gt-ink-soft)]">{detail}</span>}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="gt-stat">
      <div className="text-[10px] uppercase tracking-wide text-[var(--gt-ink-soft)]">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-[var(--gt-ink)]">{value}</div>
    </div>
  );
}

/** Hero graphic — "the four moves". Benzene (D6h) stays put while ONE tagged
 *  atom (orange) is pushed through the symmetry operations that define a point
 *  group: E (identity), C3 (rotate 120 deg), sigma-v (reflect through a mirror
 *  plane) and i (inversion through the centre). The molecule looks identical
 *  after every move — that is exactly what makes it a symmetry operation.
 *  Pure SVG + CSS (see the gt-sym-* rules in GroupTheoryPage.css). */
const SYM_STEPS = [
  { sym: 'E', name: 'Identity', hint: 'do nothing' },
  { sym: 'C\u2083', name: 'Rotation', hint: 'spin 120\u00b0' },
  { sym: '\u03c3v', name: 'Mirror plane', hint: 'reflect' },
  { sym: 'i', name: 'Inversion', hint: 'through the centre' },
];

function GTHeroGraphic() {
  const cx = 100;
  const cy = 75;
  const r = 44; // C-C ring radius
  const rH = 62; // H position radius
  const verts = [90, 30, -30, -90, -150, 150].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { c: [cx + r * Math.cos(a), cy - r * Math.sin(a)], h: [cx + rH * Math.cos(a), cy - rH * Math.sin(a)] };
  });
  // tagged atom sits on the 30 deg vertex (upper right)
  const tag = verts[1].c;

  return (
    <div
      className="gt-sym relative mx-auto flex aspect-square w-full max-w-[250px] flex-col overflow-hidden rounded-[22px] border-2 border-[var(--gt-ink)] sm:max-w-[280px] lg:ml-auto lg:mr-0"
      style={{ background: 'var(--gt-sky)', boxShadow: '7px 7px 0 var(--gt-ink)' }}
      role="img"
      aria-label="Animation: a benzene molecule with one tagged atom being moved by the symmetry operations identity, C3 rotation, mirror plane and inversion"
    >
      <div className="relative min-h-0 flex-1">
        <span className="absolute left-2.5 top-2 z-10 rounded-full border-[1.5px] border-[var(--gt-ink)] bg-[#fffdf8] px-2 py-0.5 font-mono text-[10px] font-bold leading-none text-[var(--gt-ink)]">
          C&#8326;H&#8326; &middot; D&#8326;&#8341;
        </span>

        <svg viewBox="0 0 200 150" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
          {/* mirror plane (only visible during the sigma-v step) */}
          <g className="gt-sym-mirror">
            <rect x={cx - 1.5} y="6" width="3" height="138" fill="#fff" opacity="0.45" />
            <line x1={cx} y1="6" x2={cx} y2="144" stroke="#16191b" strokeWidth="1.6" strokeDasharray="5 4" />
          </g>

          {/* inversion line through the centre (only during the i step) */}
          <g className="gt-sym-inv">
            <line x1={cx - 48.5} y1={cy + 28} x2={cx + 48.5} y2={cy - 28} stroke="#16191b" strokeWidth="1.6" strokeDasharray="4 4" />
          </g>

          {/* rotation arc (only during the C3 step) */}
          <path
            className="gt-sym-arc"
            d={`M ${cx + 28 * Math.cos(Math.PI / 6)} ${cy - 28 * Math.sin(Math.PI / 6)} A 28 28 0 0 1 ${cx} ${cy + 28}`}
            fill="none"
            stroke="#16191b"
            strokeWidth="2.4"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray="100"
          />
          {/* arrowhead at the end of the arc (pointing left, the direction of travel at the bottom of the ring) */}
          <polygon className="gt-sym-arrowhead" points={`${cx + 4},${cy + 22.5} ${cx - 4},${cy + 28} ${cx + 4},${cy + 33.5}`} fill="#16191b" />

          {/* the molecule itself never moves */}
          <g>
            {verts.map((v, i) => (
              <line key={`h-${i}`} x1={v.c[0]} y1={v.c[1]} x2={v.h[0]} y2={v.h[1]} stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            ))}
            <polygon points={verts.map((v) => v.c.join(',')).join(' ')} fill="none" stroke="#fff" strokeWidth="4" strokeLinejoin="round" />
            <polygon points={verts.map((v) => v.c.join(',')).join(' ')} fill="none" stroke="#16191b" strokeWidth="0.9" strokeLinejoin="round" opacity="0.35" />
            {verts.map((v, i) => (
              <circle key={`hh-${i}`} cx={v.h[0]} cy={v.h[1]} r="4" fill="#fff" stroke="#16191b" strokeWidth="1.2" />
            ))}
            {verts.map((v, i) => (
              <circle key={`c-${i}`} cx={v.c[0]} cy={v.c[1]} r="7" fill="#fff" stroke="#16191b" strokeWidth="2" />
            ))}
            {/* C6 axis symbol at the centre */}
            <polygon
              points={[0, 60, 120, 180, 240, 300].map((d) => {
                const a = (d * Math.PI) / 180;
                return `${cx + 5 * Math.cos(a)},${cy + 5 * Math.sin(a)}`;
              }).join(' ')}
              fill="#16191b"
            />
            <circle className="gt-sym-center" cx={cx} cy={cy} r="5" fill="none" stroke="#f3a53c" strokeWidth="2" />
          </g>

          {/* where the tagged atom started — a dashed "home" ring */}
          <circle cx={tag[0]} cy={tag[1]} r="11" fill="none" stroke="#16191b" strokeWidth="1.4" strokeDasharray="3 3" opacity="0.6" />
          <circle className="gt-sym-pulse" cx={tag[0]} cy={tag[1]} r="9" fill="none" stroke="#f3a53c" strokeWidth="2.5" />

          {/* the tagged atom: three nested groups, one per kind of motion */}
          <g className="gt-sym-tag">
            <g className="gt-sym-rot">
              <g className="gt-sym-refl">
                <g className="gt-sym-invert">
                  <circle cx={tag[0]} cy={tag[1]} r="8.5" fill="#f3a53c" stroke="#16191b" strokeWidth="2.4" />
                  <circle cx={tag[0] - 2.2} cy={tag[1] - 2.4} r="2" fill="#fff" opacity="0.7" />
                </g>
              </g>
            </g>
          </g>
        </svg>
      </div>

      {/* caption strip: current operation + progress dots */}
      <div className="relative z-10 flex h-[27%] items-center justify-between gap-2 border-t-2 border-[var(--gt-ink)] bg-[#fffdf8] px-3">
        <div className="relative h-full min-w-0 flex-1">
          {SYM_STEPS.map((st, i) => (
            <div
              key={st.sym}
              className="gt-sym-label absolute inset-0 flex items-center gap-2.5"
              style={{ animationDelay: `${i * 3}s` }}
              aria-hidden={i !== 0 ? 'true' : undefined}
            >
              <span className="gt-heading text-[26px] leading-none text-[var(--gt-teal)] sm:text-[30px]">{st.sym}</span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate font-display text-[11.5px] font-bold text-[var(--gt-ink)]">{st.name}</span>
                <span className="block truncate text-[10px] text-[var(--gt-ink-soft)]">{st.hint}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
          {SYM_STEPS.map((st, i) => (
            <span key={st.sym} className="gt-sym-dot" style={{ animationDelay: `${i * 3}s` }} />
          ))}
        </div>
      </div>
    </div>
  );
}