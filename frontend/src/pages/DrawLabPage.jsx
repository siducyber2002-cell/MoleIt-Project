import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Box, Smartphone } from 'lucide-react';
import MoleItLogo from '../components/MoleItLogo';
import DrawLabIntro from '../components/DrawLab/DrawLabIntro';
import DrawCanvas from '../components/DrawLab/DrawCanvas';
import Toolbar from '../components/DrawLab/Toolbar';
import AtomPalette from '../components/DrawLab/AtomPalette';
import Inspector from '../components/DrawLab/Inspector';
import PropertiesPanel from '../components/DrawLab/PropertiesPanel';
import AutocorrectPanel from '../components/DrawLab/AutocorrectPanel';
import ThreeMoleculeViewer from '../components/Viewer3D/ThreeMoleculeViewer';
import { atomsToMolBlock } from '../lib/molblock';
import {
  saveMolecule,
  matchCompoundsByFormula,
  resolveCompoundMatch,
  analyzeStructure,
  importSmiles,
  cleanupStructure,
  remapStructure,
  extractErrorMessage,
} from '../api/api';
import { useAuth } from '../context/AuthContext';
import './DrawLabPage.css';

const EMPTY = { atoms: [], bonds: [] };
const DRAFT_KEY = 'moleit_draw_draft';
const EMPTY_AUTOCORRECT = {
  open: false,
  loading: false,
  error: null,
  formula: '',
  cropped: false,
  hasBoundaryBonds: false,
  candidates: null,
  resolvingKey: null,
  targetIds: null,
  targetCenter: { x: 300, y: 220 },
};

function bboxCenter(atoms) {
  if (!atoms.length) return { x: 300, y: 220 };
  const xs = atoms.map((a) => a.x);
  const ys = atoms.map((a) => a.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

export default function DrawLabPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Draw Lab's 3-pane layout (palette / canvas / 3D panel) needs real
  // horizontal room to work like the desktop version — on a phone held
  // upright there just isn't room for it, so instead of squeezing it into
  // a tall narrow column we gate the whole workspace behind a "rotate your
  // phone" prompt until the device is turned to landscape. Tablets and
  // desktops (anything wider than 900px) are never gated, even in
  // portrait, since they have enough width for the layout either way.
  // Plays once each time this page mounts (i.e. every time you navigate
  // into Draw Lab), then unmounts itself — see DrawLabIntro.
  const [showIntro, setShowIntro] = useState(true);

  const [needsRotate, setNeedsRotate] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px) and (orientation: portrait)');
    const update = () => setNeedsRotate(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const [activeTool, setActiveTool] = useState('atom');
  const [activeElement, setActiveElement] = useState('C');
  const [atomScale, setAtomScale] = useState(1);
  const [name, setName] = useState('Untitled molecule');
  const [show3D, setShow3D] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [ringType, setRingType] = useState('benzene');
  const [eraserSize, setEraserSize] = useState(18);
  const [selection, setSelection] = useState(null);
  const [selectedAtomIds, setSelectedAtomIds] = useState(() => new Set());
  const [autocorrectState, setAutocorrectState] = useState(EMPTY_AUTOCORRECT);

  // Bumped any time a structure is freshly loaded onto the canvas (from the
  // library, functional groups, a SMILES import, or Autocorrect) so
  // DrawCanvas knows to re-center the view on it — otherwise whatever the
  // source's raw coordinates were could land the structure pinned in a
  // corner and clipped, regardless of what's actually on the canvas.
  const [fitSignal, setFitSignal] = useState(0);
  const bumpFit = () => setFitSignal((s) => s + 1);

  const historyRef = useRef([EMPTY]);
  const historyIndexRef = useRef(0);
  const [current, setCurrent] = useState(EMPTY);
  const [historyLength, setHistoryLength] = useState(1);
  const [historyIndex, setHistoryIndex] = useState(0);

  const commit = useCallback((atoms, bonds) => {
    const next = { atoms, bonds };
    const truncated = historyRef.current.slice(0, historyIndexRef.current + 1);
    const newHist = [...truncated, next];
    historyRef.current = newHist;
    historyIndexRef.current = newHist.length - 1;
    setCurrent(next);
    setHistoryLength(newHist.length);
    setHistoryIndex(historyIndexRef.current);
  }, []);

  const resetHistory = useCallback((atoms, bonds) => {
    const next = { atoms, bonds };
    historyRef.current = [next];
    historyIndexRef.current = 0;
    setCurrent(next);
    setHistoryLength(1);
    setHistoryIndex(0);
    setSelection(null);
  }, []);

  useEffect(() => {
    if (location.state?.structure_2d) {
      const struct = location.state.structure_2d;
      resetHistory(struct.atoms || [], struct.bonds || []);
      setName(location.state.name || 'Untitled molecule');
      bumpFit();
      return;
    }
    try {
      const incomingRaw = sessionStorage.getItem('moleit_incoming_structure');
      if (incomingRaw) {
        sessionStorage.removeItem('moleit_incoming_structure');
        const incoming = JSON.parse(incomingRaw);
        if (incoming?.structure_2d) {
          resetHistory(incoming.structure_2d.atoms || [], incoming.structure_2d.bonds || []);
          setName(incoming.name || 'Untitled molecule');
          bumpFit();
          return;
        }
      }
    } catch {
      // ignore corrupt payload
    }
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft?.atoms?.length || draft?.bonds?.length) {
          resetHistory(draft.atoms || [], draft.bonds || []);
          setName(draft.name || 'Untitled molecule');
          bumpFit();
        }
      }
    } catch {
      // ignore corrupt draft
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ name, atoms: current.atoms, bonds: current.bonds })
        );
      } catch {
        // storage full/unavailable — ignore
      }
    }, 400);
    return () => clearTimeout(t);
  }, [current, name]);

  const handleChange = (atoms, bonds) => commit(atoms, bonds);

  const undo = () => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    setHistoryIndex(historyIndexRef.current);
    setCurrent(historyRef.current[historyIndexRef.current]);
  };
  const redo = () => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    setHistoryIndex(historyIndexRef.current);
    setCurrent(historyRef.current[historyIndexRef.current]);
  };
  const clearCanvas = () => {
    commit([], []);
    setSelection(null);
    localStorage.removeItem(DRAFT_KEY);
  };

  const molBlock = useMemo(
    () => (current.atoms.length ? atomsToMolBlock(current.atoms, current.bonds, name) : ''),
    [current, name]
  );

  // Formula, molar mass, SMILES and valence-check warnings for whatever's
  // currently on the canvas — this used to be a synchronous useMemo
  // (findValenceIssues et al, from lib/elements.js) but that logic now
  // lives server-side (backend/app/formula.py, via POST
  // /api/structure/analyze), so it's a debounced async call instead.
  // Debounced the same 400ms as the draft autosave effect above, so a
  // fast sequence of edits (dragging, drawing a chain) doesn't fire a
  // request per intermediate frame — only once drawing pauses.
  const [structureAnalysis, setStructureAnalysis] = useState({
    formula: '', molarMass: '', smiles: '', issues: [], bondOrders: {}, ringCount: 0, loading: false,
  });
  useEffect(() => {
    if (!current.atoms.length) {
      setStructureAnalysis({ formula: '', molarMass: '', smiles: '', issues: [], bondOrders: {}, ringCount: 0, loading: false });
      return;
    }
    setStructureAnalysis((s) => ({ ...s, loading: true }));
    let cancelled = false;
    const t = setTimeout(() => {
      analyzeStructure(current.atoms, current.bonds)
        .then((result) => {
          if (!cancelled) setStructureAnalysis({ ...result, loading: false });
        })
        .catch(() => {
          if (!cancelled) setStructureAnalysis((s) => ({ ...s, loading: false }));
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [current]);

  const valenceIssues = structureAnalysis.issues;
  const invalidAtomIds = useMemo(
    () => new Set(valenceIssues.map((i) => i.atomId)),
    [valenceIssues]
  );

  const handleImportSmiles = (structure, sourceSmiles) => {
    if (current.atoms.length > 0) {
      const ok = window.confirm('This will replace the current canvas with the imported structure. Continue?');
      if (!ok) return;
    }
    resetHistory(structure.atoms, structure.bonds);
    setName(sourceSmiles || 'Imported molecule');
    bumpFit();
  };

  // ---- Autocorrect: structure recognition ----
  // Click Autocorrect -> figure out the target (whatever's box-selected
  // with the Select tool, a "crop", or the whole canvas) -> compute its
  // formula -> ask the backend what real compound(s) that formula matches
  // (local library first, then a live PubChem formula search) -> let the
  // student confirm one and swap in that compound's actual structure, or
  // fall back to a pure geometry clean-up if nothing matches / they'd
  // rather keep exactly what they drew.
  const closeAutocorrect = () => setAutocorrectState(EMPTY_AUTOCORRECT);

  const handleAutocorrect = async () => {
    if (!current.atoms.length) return;
    const cropped = selectedAtomIds.size > 0;
    const targetIds = cropped ? new Set(selectedAtomIds) : new Set(current.atoms.map((a) => a.id));
    const targetAtoms = current.atoms.filter((a) => targetIds.has(a.id));
    if (!targetAtoms.length) return;
    const targetBonds = current.bonds.filter((b) => targetIds.has(b.from) && targetIds.has(b.to));
    const hasBoundaryBonds =
      cropped && current.bonds.some((b) => targetIds.has(b.from) !== targetIds.has(b.to));
    const targetCenter = bboxCenter(targetAtoms);

    setAutocorrectState({
      ...EMPTY_AUTOCORRECT,
      open: true,
      loading: true,
      cropped,
      hasBoundaryBonds,
      targetIds,
      targetCenter,
    });

    try {
      const { formula, ringCount: drawnRingCount } = await analyzeStructure(targetAtoms, targetBonds);
      setAutocorrectState((s) => (s.open ? { ...s, formula } : s));
      const results = await matchCompoundsByFormula(formula);
      // Rank exact-formula matches before close ones, and within each
      // group put the isomer whose ring count matches the drawing first —
      // e.g. if the student clearly drew a six-membered ring, prefer the
      // cyclic isomer of that formula over a chain isomer that happens to
      // share the same formula.
      const ranked = [...results].sort((a, b) => {
        if (a.formula_match !== b.formula_match) return a.formula_match === 'exact' ? -1 : 1;
        const da = a.ring_count == null ? 99 : Math.abs(a.ring_count - drawnRingCount);
        const db_ = b.ring_count == null ? 99 : Math.abs(b.ring_count - drawnRingCount);
        return da - db_;
      });
      setAutocorrectState((s) => (s.open ? { ...s, loading: false, candidates: ranked } : s));
    } catch {
      setAutocorrectState((s) =>
        s.open
          ? {
              ...s,
              loading: false,
              candidates: [],
              error: "Couldn't reach the compound database — you can still clean up the geometry below.",
            }
          : s
      );
    }
  };

  // Repositions the target atoms in place (no identification) — keeps
  // ids, boundary bonds to the rest of the canvas, and everything else
  // exactly as-is.
  const handleCleanupOnly = async () => {
    const { targetIds, targetCenter } = autocorrectState;
    if (!targetIds) return;
    const targetAtoms = current.atoms.filter((a) => targetIds.has(a.id));
    const targetBonds = current.bonds.filter((b) => targetIds.has(b.from) && targetIds.has(b.to));

    let recenteredAtoms, wedgedBonds;
    try {
      const result = await cleanupStructure(targetAtoms, targetBonds, targetCenter);
      recenteredAtoms = result.atoms;
      wedgedBonds = result.bonds;
    } catch (err) {
      setAutocorrectState((s) => ({ ...s, error: extractErrorMessage(err, "Couldn't clean up that structure.") }));
      return;
    }

    const posById = new Map(recenteredAtoms.map((a) => [a.id, a]));
    const bondById = new Map(wedgedBonds.map((b) => [b.id, b]));
    // Atoms/bonds the backend's hydride-expansion step added are new
    // (fresh a#/b# ids scoped to just targetAtoms/targetBonds) and could
    // collide with ids already used elsewhere on the canvas, so remap
    // before merging — same treatment as the candidate-swap path.
    const newlyAddedAtoms = recenteredAtoms.filter((a) => !targetIds.has(a.id));
    const newlyAddedBonds = wedgedBonds.filter((b) => !targetIds.has(b.from) || !targetIds.has(b.to));
    const untouchedAtoms = current.atoms.filter((a) => !targetIds.has(a.id));
    const untouchedBonds = current.bonds.filter((b) => !targetIds.has(b.from) && !targetIds.has(b.to));
    let remappedNew = [];
    let remappedNewBonds = [];
    if (newlyAddedAtoms.length) {
      try {
        const remapped = await remapStructure(newlyAddedAtoms, newlyAddedBonds, current.atoms, current.bonds);
        remappedNew = remapped.atoms;
        remappedNewBonds = remapped.bonds;
      } catch (err) {
        setAutocorrectState((s) => ({ ...s, error: extractErrorMessage(err, "Couldn't clean up that structure.") }));
        return;
      }
    }

    const repositionedOriginal = current.atoms
      .filter((a) => targetIds.has(a.id))
      .map((a) => posById.get(a.id) || a);
    const styleUpdatedOriginal = current.bonds
      .filter((b) => targetIds.has(b.from) && targetIds.has(b.to))
      .map((b) => bondById.get(b.id) || b);

    const nextAtoms = [...untouchedAtoms, ...repositionedOriginal, ...remappedNew];
    const nextBonds = [
      ...untouchedBonds,
      ...current.bonds.filter((b) => targetIds.has(b.from) !== targetIds.has(b.to)), // boundary bonds, untouched
      ...styleUpdatedOriginal,
      ...remappedNewBonds,
    ];

    commit(nextAtoms, nextBonds);
    bumpFit();
    closeAutocorrect();
  };

  // Swaps the target atoms for the picked compound's real structure.
  // Prefers the backend's own structure_2d (built server-side from
  // PubChem's actual 2D depiction, or authored directly for a curated
  // library compound) over re-deriving one from SMILES — it's strictly
  // more reliable: some PubChem records (simple ionic salts especially)
  // come back with an empty CanonicalSMILES/IsomericSMILES property, which
  // used to be a dead end here even though the compound's real structure
  // was sitting right there in structure_2d the whole time. SMILES-based
  // parsing is now only a fallback for the rare case structure_2d itself
  // is empty. Either path is cleaned up and given proper wedge/dash bonds
  // the same way. If the selection had bonds reaching outside it (cropped
  // out of a bigger drawing rather than a self-contained fragment), those
  // necessarily can't carry over — hasBoundaryBonds already warns about
  // this in the panel before the student picks anything.
  const handlePickCandidate = async (candidate) => {
    const key = candidate.compound_id || candidate.cid || candidate.name;
    setAutocorrectState((s) => ({ ...s, resolvingKey: key, error: null }));
    try {
      const full = await resolveCompoundMatch(
        candidate.compound_id ? { compound_id: candidate.compound_id } : { cid: candidate.cid }
      );

      let rawAtoms, rawBonds;
      if (full.structure_2d?.atoms?.length) {
        rawAtoms = full.structure_2d.atoms;
        rawBonds = full.structure_2d.bonds || [];
      } else if (full.smiles) {
        const parsed = await importSmiles(full.smiles);
        rawAtoms = parsed.atoms;
        rawBonds = parsed.bonds;
      } else {
        throw new Error('This compound has no structure available to draw.');
      }

      const { atoms: recenteredAtoms, bonds: wedgedBonds } = await cleanupStructure(
        rawAtoms, rawBonds, autocorrectState.targetCenter
      );

      const { targetIds, cropped } = autocorrectState;
      const remainingAtoms = current.atoms.filter((a) => !targetIds.has(a.id));
      const remainingBonds = current.bonds.filter(
        (b) => !targetIds.has(b.from) && !targetIds.has(b.to)
      );
      const { atoms: remappedAtoms, bonds: remappedBonds } = await remapStructure(
        recenteredAtoms,
        wedgedBonds,
        remainingAtoms,
        remainingBonds
      );

      commit([...remainingAtoms, ...remappedAtoms], [...remainingBonds, ...remappedBonds]);
      bumpFit();
      if (!cropped) setName(full.name);
      closeAutocorrect();
    } catch (err) {
      setAutocorrectState((s) => ({
        ...s,
        resolvingKey: null,
        error: extractErrorMessage(
          err,
          "Couldn't fetch that compound's structure — try another suggestion, or clean up the geometry instead."
        ),
      }));
    }
  };

  const handleSave = async () => {
    if (!user) {
      navigate('/login', { state: { from: '/draw' } });
      return;
    }
    setSaving(true);
    setSaveMsg('');
    try {
      // Computed fresh (not read from the debounced structureAnalysis
      // display state above) so what gets persisted always matches
      // exactly what's on the canvas at the moment Save was clicked,
      // rather than possibly-stale values from mid-debounce.
      const { formula, smiles } = await analyzeStructure(current.atoms, current.bonds);
      await saveMolecule({
        name,
        structure_2d: { atoms: current.atoms, bonds: current.bonds },
        derived_formula: formula,
        derived_smiles: smiles,
        is_public: false,
      });
      setSaveMsg('Saved to My Molecules');
      setTimeout(() => setSaveMsg(''), 2500);
    } catch (err) {
      setSaveMsg('Could not save — try again');
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    const data = JSON.stringify({ name, atoms: current.atoms, bonds: current.bonds }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/\s+/g, '_') || 'molecule'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="dl-page flex h-[100svh] flex-col overflow-hidden bg-lab-950">
      {showIntro && <DrawLabIntro onFinish={() => setShowIntro(false)} />}

      {/* Ambient glow — purely atmospheric, sits behind everything at
          z-index 0 (see DrawLabPage.css); the header/panels below all
          opt back in to z-index 1 so none of the actual UI sits under
          it or picks up its pointer-events:none. */}
      <div className="dl-orbs" aria-hidden="true">
        <div className="dl-orb dl-orb--phosphor" />
        <div className="dl-orb dl-orb--violet" />
      </div>

      {needsRotate && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-lab-950 px-6 text-center">
          <style>{`
            @keyframes drawlab-rotate-hint {
              0%, 15% { transform: rotate(0deg); }
              45%, 65% { transform: rotate(-90deg); }
              85%, 100% { transform: rotate(0deg); }
            }
            .drawlab-rotate-icon { animation: drawlab-rotate-hint 2.6s ease-in-out infinite; }
          `}</style>
          <Smartphone size={56} className="drawlab-rotate-icon text-phosphor" />
          <p className="font-display text-sm font-semibold uppercase tracking-wide text-lab-100">
            Rotate your phone
          </p>
          <p className="max-w-xs text-xs leading-relaxed text-lab-400">
            Draw Lab needs a wider screen to work properly. Turn your phone sideways to
            landscape view to get the full, desktop-style workspace — palette, canvas,
            and 3D preview all at once.
          </p>
        </div>
      )}

      {/* Draw Lab runs full-screen with its own slim header instead of the
          floating site navbar, so the workspace gets the whole viewport
          as a distraction-free canvas rather than squeezing under it. */}
      <header className="dl-header grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 bg-lab-950 px-4 py-2">
        <div className="flex items-center">
          <Link
            to="/"
            title="Exit Draw Lab"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-lab-800 bg-lab-900/60 px-3 py-1.5 text-xs font-medium text-lab-400 transition-all hover:-translate-y-px hover:border-lab-600 hover:text-lab-100"
          >
            <ArrowLeft size={14} />
            Exit
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <MoleItLogo size="sm" />
          <div className="h-6 w-px shrink-0 bg-lab-800" aria-hidden="true" />
          <div className="relative">
            <span className="flash-line font-display text-sm font-bold uppercase tracking-[0.35em] sm:text-base">
              Draw Lab
            </span>
            <span
              className="title-underline absolute -bottom-1.5 left-0 h-[2px] w-full origin-center bg-gradient-to-r from-transparent via-phosphor to-transparent"
              aria-hidden="true"
            />
          </div>
        </div>

        <div aria-hidden="true" />
      </header>
      <div className="dl-scanline" aria-hidden="true" />

      <div className="relative z-[1] flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 md:flex-row">
        <aside className="dl-panel order-2 flex w-full flex-col overflow-hidden rounded-2xl border border-lab-700 bg-lab-900 md:order-1 md:h-full md:w-64 md:overflow-y-auto">
          <AtomPalette activeElement={activeElement} setActiveElement={setActiveElement} />
          <Inspector
            selection={selection}
            atoms={current.atoms}
            bonds={current.bonds}
            bondOrders={structureAnalysis.bondOrders}
          />
          <PropertiesPanel
            atoms={current.atoms}
            bonds={current.bonds}
            name={name}
            setName={setName}
            formula={structureAnalysis.formula}
            molarMass={structureAnalysis.molarMass}
            smiles={structureAnalysis.smiles}
            ringCount={structureAnalysis.ringCount}
            analyzing={structureAnalysis.loading}
            valenceIssues={valenceIssues}
            onImportSmiles={handleImportSmiles}
          />
        </aside>

        <main className="dl-panel order-1 md:order-2 flex-1 flex flex-col min-h-[420px] overflow-hidden rounded-2xl border border-lab-700">
          <Toolbar
            activeTool={activeTool}
            setActiveTool={setActiveTool}
            onUndo={undo}
            onRedo={redo}
            canUndo={historyIndex > 0}
            canRedo={historyIndex < historyLength - 1}
            onClear={clearCanvas}
            onSave={handleSave}
            onExport={handleExport}
            saving={saving}
            atomScale={atomScale}
            setAtomScale={setAtomScale}
            ringType={ringType}
            setRingType={setRingType}
            eraserSize={eraserSize}
            setEraserSize={setEraserSize}
            validationIssues={valenceIssues}
            onAutocorrect={handleAutocorrect}
            hasAtoms={current.atoms.length > 0}
            hasSelection={selectedAtomIds.size > 0}
          />
          <div className="relative flex-1 bg-lab-900">
            <DrawCanvas
              atoms={current.atoms}
              bonds={current.bonds}
              onChange={handleChange}
              activeElement={activeElement}
              activeTool={activeTool}
              atomScale={atomScale}
              ringType={ringType}
              eraserSize={eraserSize}
              onSelect={setSelection}
              onSelectionChange={setSelectedAtomIds}
              invalidAtomIds={invalidAtomIds}
              fitSignal={fitSignal}
            />
            <AutocorrectPanel
              open={autocorrectState.open}
              loading={autocorrectState.loading}
              error={autocorrectState.error}
              formula={autocorrectState.formula}
              cropped={autocorrectState.cropped}
              hasBoundaryBonds={autocorrectState.hasBoundaryBonds}
              candidates={autocorrectState.candidates}
              resolvingKey={autocorrectState.resolvingKey}
              onPick={handlePickCandidate}
              onCleanupOnly={handleCleanupOnly}
              onClose={closeAutocorrect}
            />
            {saveMsg && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-md bg-lab-800 px-3 py-1.5 text-xs text-phosphor shadow-lg ring-1 ring-phosphor/30">
                {saveMsg}
              </div>
            )}
          </div>
        </main>

        {/* Narrower than the palette on purpose: this panel is a preview,
            not a workspace, and clicking it already opens a full
            Maximize2 modal (see ThreeMoleculeViewer) with the same rotate/
            zoom/style controls at real size — so there's no need to
            reserve a wide chunk of the layout for a permanently "zoomed
            in" inline view. Keeping it slim here is what actually gives
            DrawCanvas (the main attraction) the extra horizontal room. */}
        <aside className="dl-panel order-3 w-full shrink-0 overflow-hidden rounded-2xl border border-lab-700 bg-lab-900 p-2.5 md:h-full md:w-56 md:overflow-y-auto lg:w-64">
          <button
            onClick={() => setShow3D((s) => !s)}
            className="dl-panel-header mb-2 w-full font-display text-xs font-semibold uppercase tracking-wider text-lab-400"
          >
            <span className="flex items-center gap-1.5">
              <Box size={13} /> 3D Preview
            </span>
            <span className="text-phosphor">{show3D ? 'Hide' : 'Show'}</span>
          </button>
          {show3D && (
            <>
              {current.atoms.length > 0 ? (
                <ThreeMoleculeViewer molBlock={molBlock} height={180} title={name} atoms={current.atoms} />
              ) : (
                <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-lab-700 text-center text-xs text-lab-500 px-4">
                  Draw a molecule to see it rendered and rotate it in 3D
                </div>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-lab-500">
                Click to expand full-size. Drag to rotate, scroll to zoom —
                uses your 2D layout as starting geometry, so shape relaxes
                but connectivity and bond orders stay accurate.
              </p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}