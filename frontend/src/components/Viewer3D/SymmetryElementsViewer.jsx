import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RotateCcw, Maximize2, X, Play, Pause, Loader2, FlaskConical, Tag, Turtle } from 'lucide-react';
import { useThreeScene } from './useThreeScene';
import { elemColor, elemRadius, makeAtomMaterial, makeBondMaterial, moleculeSizeScale } from './moleculeMeshBuilder';

// Same palette the rest of the app already uses (see index.css --color-*).
const KIND_META = {
  C: { label: 'Rotation axes', short: 'proper rotation axis', color: '#e8890c', hex: 0xe8890c },
  S: { label: 'Improper axes', short: 'improper rotation axis', color: '#7c5cf0', hex: 0x7c5cf0 },
  M: { label: 'Mirror planes', short: 'mirror plane', color: '#0f9d8a', hex: 0x0f9d8a },
  i: { label: 'Inversion center', short: 'inversion center', color: '#e11d48', hex: 0xe11d48 },
};
const KIND_ORDER = ['C', 'S', 'M', 'i'];
// Light-theme control styling (matches the Group Theory page's ink-border look).
const CTRL_OFF = 'border-[1.5px] border-[#16191b] bg-[#fffdf8] text-[#16191b] hover:bg-[#f3a53c]';
const CTRL_ON = 'border-[1.5px] border-[#16191b] bg-[#3cc6ef] text-[#16191b]';
// Same bond color every other molecule viewer in the app uses (Library,
// Compound Detail, homepage…), not a one-off shade specific to this page.
const BOND_COLOR = 0xaaa39a;
const AXIS_LENGTH_PAD = 0.7;
const PLANE_PAD = 0.5;
// Arrowhead cones drawn at both ends of an axis's rod, so once it's the
// active (rotating/highlighted) axis it reads as a double-headed arrow
// rather than a bare rod. Every other axis stays fully invisible (see
// coreBaseOpacity: 0 below) — only the one thing currently rotating gets
// an axis + heads drawn at all.
const ARROW_HEAD_RADIUS = 0.1;
const ARROW_HEAD_LENGTH = 0.24;
// Motion-trail "ghost" left behind at an atom's pre-move position during a
// replay, cross-faded out over the phase — the fading afterimage effect
// from molecular-symmetry.html's gGhost group, ported to this per-atom
// animator (see snapshotGhosts/fadeGhosts below).
const GHOST_OPACITY = 0.4;
// Segment count for the mirror-plane disc + its boundary ring.
const PLANE_SEGMENTS = 56;

// ------------------------------------------------------- operation replay
// Timing for one "play this operation" cycle: ease out to the fully-applied
// transform, hold so the viewer can see atoms have landed on equivalent
// positions, then ease back to rest.
const ANIM_FWD_MS = 900;
const ANIM_HOLD_MS = 380;
const ANIM_BACK_MS = 750;
const ANIM_GAP_MS = 380; // pause between steps during an auto-played sequence
const SLOW_MOTION_FACTOR = 0.25; // slow-motion runs at 25% of normal speed
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

// Maps an operation + progress amt (0 = rest, 1 = fully applied) to a world
// position for one atom's base coordinates. Every op kind is expressed as a
// continuous deformation of the *individual* atom position rather than one
// rigid transform of the whole molecule, because a mirror/inversion/improper
// rotation isn't a rigid motion at all (det < 0) — there is no rotation that
// turns a molecule into its own mirror image while it stays rigid. Animating
// each atom's own position the same way a reflection or point-inversion
// actually acts (flatten-through-zero-and-out-the-other-side, i.e. scaling
// the relevant component by cos(pi*amt) which sweeps 1 -> 0 -> -1) is the
// standard way to show these visually, and it composes correctly with a real
// rotation for Sn (rotate the in-plane part, flip the axial part). At amt=1
// every atom sits exactly on the position the real operation matrix gives it
// — verified against the backend's own matrices, not just visually plausible.
function applyOperationAmt(base, centroid, op, amt) {
  const r = new THREE.Vector3().subVectors(base, centroid);
  if (!op || op.kind === 'E') {
    const s = 1 + 0.05 * Math.sin(Math.PI * amt); // gentle "selected" pulse, nothing actually moves
    return centroid.clone().addScaledVector(r, s);
  }
  if (op.kind === 'i') {
    const s = Math.cos(Math.PI * amt);
    return centroid.clone().addScaledVector(r, s);
  }
  if (op.kind === 'C' && Array.isArray(op.axis)) {
    const axis = new THREE.Vector3(...op.axis).normalize();
    const theta = THREE.MathUtils.degToRad(op.angle ?? 360 / (op.n || 2)) * amt;
    return centroid.clone().add(r.clone().applyAxisAngle(axis, theta));
  }
  if (op.kind === 'S' && Array.isArray(op.axis)) {
    const axis = new THREE.Vector3(...op.axis).normalize();
    const along = axis.clone().multiplyScalar(r.dot(axis));
    const perp = r.clone().sub(along);
    const s = Math.cos(Math.PI * amt);
    const theta = THREE.MathUtils.degToRad(op.angle ?? 360 / (op.n || 2)) * amt;
    return centroid.clone().add(along.multiplyScalar(s)).add(perp.applyAxisAngle(axis, theta));
  }
  if (op.kind === 'M' && Array.isArray(op.normal)) {
    const n = new THREE.Vector3(...op.normal).normalize();
    const along = n.clone().multiplyScalar(r.dot(n));
    const inplane = r.clone().sub(along);
    const s = Math.cos(Math.PI * amt);
    return centroid.clone().add(along.multiplyScalar(s)).add(inplane);
  }
  return base.clone();
}

// ---------------------------------------------------------------- geometry
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
// Sign-canonicalized unit vector, so an axis and its antiparallel twin
// (e.g. two C2 operations pointing opposite ways along the same physical
// line) collapse to the same dedup key instead of drawing two rods.
function canonicalDir(v) {
  const d = norm(v);
  const lead = d.reduce((a, c) => (Math.abs(c) > Math.abs(a) ? c : a), 0);
  return lead < 0 ? d.map((c) => -c) : d;
}
function dirKey(d) { return d.map((c) => Math.round(c * 200)).join(','); }

/** Groups the flat operations list from /api/symmetry/analyze into unique
 *  axes / planes to actually draw — several operations (e.g. C4 and its
 *  C4^3, or a Cn and a coincident Sn) share one physical line, so this
 *  collapses them before anything touches the scene. */
function buildElements(operations) {
  const axes = new Map();
  const planes = new Map();
  let hasInversion = false;
  for (const op of operations || []) {
    if (op.kind === 'i') { hasInversion = true; continue; }
    if ((op.kind === 'C' || op.kind === 'S') && Array.isArray(op.axis)) {
      const dir = canonicalDir(op.axis);
      const key = dirKey(dir);
      const entry = axes.get(key) || { dir, kinds: new Set(), order: 0, orderLabel: null, labels: [] };
      entry.kinds.add(op.kind);
      entry.order = Math.max(entry.order, op.n || 0);
      if (op.orderLabel) entry.orderLabel = op.orderLabel; // e.g. "\u221e" for C\u221e / S\u221e
      entry.labels.push(op.label);
      axes.set(key, entry);
    } else if (op.kind === 'M' && Array.isArray(op.normal)) {
      const dir = canonicalDir(op.normal);
      const key = dirKey(dir);
      const entry = planes.get(key) || { normal: dir, labels: [] };
      entry.labels.push(op.label);
      planes.set(key, entry);
    }
  }
  return { axes: [...axes.values()], planes: [...planes.values()], hasInversion };
}

// ---------------------------------------------------------------- mol parsing
// Fixed-column V2000 reader — matches both what lib/molblock.js writes and
// the standard MDL column widths (10/10/10 for x/y/z, then a 3-char
// element symbol; 3/3/3 for bond atom1/atom2/order), so this also reads
// mol blocks fetched from PubChem, not just ones this app generated.
function parseMolV2000(molBlock) {
  if (!molBlock) return { atoms: [], bonds: [] };
  const lines = molBlock.split(/\r?\n/);
  const counts = lines[3] || '';
  const nAtoms = parseInt(counts.slice(0, 3), 10) || 0;
  const nBonds = parseInt(counts.slice(3, 6), 10) || 0;
  const atoms = [];
  for (let i = 0; i < nAtoms; i++) {
    const line = lines[4 + i] || '';
    atoms.push({
      x: parseFloat(line.slice(0, 10)) || 0,
      y: parseFloat(line.slice(10, 20)) || 0,
      z: parseFloat(line.slice(20, 30)) || 0,
      element: (line.slice(31, 34) || 'C').trim() || 'C',
    });
  }
  const bonds = [];
  for (let i = 0; i < nBonds; i++) {
    const line = lines[4 + nAtoms + i] || '';
    const a1 = parseInt(line.slice(0, 3), 10);
    const a2 = parseInt(line.slice(3, 6), 10);
    if (!a1 || !a2) continue;
    bonds.push({ a1: a1 - 1, a2: a2 - 1, order: parseInt(line.slice(6, 9), 10) || 1 });
  }
  return { atoms, bonds };
}

function disposeObject(obj) {
  obj.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
    else child.material?.dispose?.();
  });
}

// ---------------------------------------------------------------- component
export default function SymmetryElementsViewer({
  molBlock, atoms, center, operations, groupPretty, formulaPretty, height = 340,
  highlightLabel, onHighlightChange, playRequest,
}) {
  const [isMaximized, setIsMaximized] = useState(false);
  return (
    <>
      <Inner
        molBlock={molBlock} atoms={atoms} center={center} operations={operations}
        groupPretty={groupPretty} formulaPretty={formulaPretty} height={height}
        onMaximize={() => setIsMaximized(true)} clickableBg
        highlightLabel={highlightLabel} onHighlightChange={onHighlightChange}
        playRequest={playRequest}
      />
      {isMaximized && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-lab-950/90 backdrop-blur-sm p-4 sm:p-10"
          onClick={() => setIsMaximized(false)}
        >
          <div
            className="relative w-full max-w-4xl rounded-xl border border-lab-700 bg-lab-900 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-lab-100">
                {formulaPretty} &mdash; {groupPretty}
              </h3>
              <button
                onClick={() => setIsMaximized(false)}
                className="rounded-md p-1.5 text-lab-400 hover:bg-lab-800 hover:text-lab-100"
              >
                <X size={18} />
              </button>
            </div>
            <Inner
              molBlock={molBlock} atoms={atoms} center={center} operations={operations}
              groupPretty={groupPretty} formulaPretty={formulaPretty} height={520}
              highlightLabel={highlightLabel} onHighlightChange={onHighlightChange}
              playRequest={playRequest}
            />
          </div>
        </div>
      )}
    </>
  );
}

function Inner({
  molBlock, atoms, center, operations, groupPretty, formulaPretty, height, onMaximize, clickableBg,
  highlightLabel: controlledHighlight, onHighlightChange, playRequest,
}) {
  const containerRef = useRef(null);
  const [spinning, setSpinning] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [visibleKinds, setVisibleKinds] = useState(() => new Set(KIND_ORDER));
  const [internalHighlight, setInternalHighlight] = useState(null);
  const [hoverKind, setHoverKind] = useState(null);
  // DOM overlay for atom labels — real text (not a 3D sprite) projected to
  // screen space every frame, so it stays crisp at any zoom level.
  const labelsContainerRef = useRef(null);
  const labelDivsRef = useRef([]); // parallel to atomRecordsRef, one <div> per atom
  const highlightLabel = controlledHighlight !== undefined ? controlledHighlight : internalHighlight;
  const setHighlightLabel = onHighlightChange || setInternalHighlight;
  // Mirrored into a ref so the per-frame animation callback (registered
  // once, via useThreeScene's onFrame) always reads the latest value
  // without needing to be recreated every render.
  const highlightRef = useRef(highlightLabel);
  highlightRef.current = highlightLabel;
  // Kind currently hovered in the legend (C / S / M / i) — mirrored into a ref for the
  // per-frame loop, same reason as highlightRef.
  const hoverKindRef = useRef(null);

  // Elements this viewer has drawn, so the per-frame loop can lerp their
  // glow and toggleKind can flip visibility without rebuilding the scene.
  const symmetryRecordsRef = useRef([]);
  const groupRootRef = useRef(null); // holds atoms+bonds+symmetry so one rebuild swaps it out cleanly
  const fitRef = useRef(null); // { distance, target } for the reset-view button

  // ---- operation replay state ----
  // atomRecordsRef/bondRecordsRef mirror parsed.atoms/parsed.bonds 1:1 so the
  // per-frame animator can move meshes without touching React state (a replay
  // runs at 60fps; state updates every frame would thrash re-renders).
  const atomRecordsRef = useRef([]); // [{ mesh, base: Vector3 }]
  const bondRecordsRef = useRef([]); // [{ mesh, a1, a2 }] — a1/a2 index into atomRecordsRef
  const ghostRecordsRef = useRef([]); // wireframe echoes, one per atom, index-aligned with atomRecordsRef
  const centroidVecRef = useRef(new THREE.Vector3());
  const animRef = useRef(null); // { op, phase: 'fwd'|'hold'|'back', start } | null
  const playQueueRef = useRef([]); // remaining ops for an auto-played sequence
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const isPlayingAllRef = useRef(false);
  isPlayingAllRef.current = isPlayingAll;
  const [playingLabel, setPlayingLabel] = useState(null);
  // Slow motion: mirrored into a ref (like highlightRef above) so the
  // per-frame animation loop always reads the latest value without the
  // frame callback needing to be recreated.
  const [slowMotion, setSlowMotion] = useState(false);
  const slowMotionRef = useRef(false);
  function toggleSlowMotion(e) {
    e.stopPropagation();
    const next = !slowMotionRef.current;
    slowMotionRef.current = next;
    setSlowMotion(next);
  }

  const parsed = useMemo(() => parseMolV2000(molBlock), [molBlock]);
  const elements = useMemo(() => buildElements(operations), [operations]);
  const presentKinds = useMemo(() => {
    const s = new Set();
    for (const a of elements.axes) a.kinds.forEach((k) => s.add(k));
    if (elements.planes.length) s.add('M');
    if (elements.hasInversion) s.add('i');
    return KIND_ORDER.filter((k) => s.has(k));
  }, [elements]);

  const centroid = useMemo(() => {
    if (center) return [center.x, center.y, center.z];
    if (atoms?.length) {
      const sum = atoms.reduce((a, p) => [a[0] + p.x, a[1] + p.y, a[2] + p.z], [0, 0, 0]);
      return sum.map((v) => v / atoms.length);
    }
    if (parsed.atoms.length) {
      const sum = parsed.atoms.reduce((a, p) => [a[0] + p.x, a[1] + p.y, a[2] + p.z], [0, 0, 0]);
      return sum.map((v) => v / parsed.atoms.length);
    }
    return [0, 0, 0];
  }, [center, atoms, parsed]);

  const radius = useMemo(() => {
    const pts = atoms?.length ? atoms : parsed.atoms;
    if (!pts.length) return 2;
    return Math.max(1.4, ...pts.map((p) => Math.hypot(p.x - centroid[0], p.y - centroid[1], p.z - centroid[2])));
  }, [atoms, parsed, centroid]);

  // What the HUD caption at the bottom of the stage should say right now.
  const hudInfo = useMemo(() => {
    if (highlightLabel && highlightLabel !== 'i') {
      const ax = elements.axes.find((a) => a.labels.includes(highlightLabel));
      if (ax) {
        const kind = ax.kinds.has('S') ? 'S' : 'C';
        return { title: highlightLabel, sub: `${ax.orderLabel || ax.order}-fold ${KIND_META[kind].short}`, color: KIND_META[kind].color };
      }
      const pl = elements.planes.find((p) => p.labels.includes(highlightLabel));
      if (pl) return { title: highlightLabel, sub: KIND_META.M.short, color: KIND_META.M.color };
    }
    if (highlightLabel === 'i' || hoverKind === 'i') {
      return { title: 'i', sub: KIND_META.i.short, color: KIND_META.i.color };
    }
    if (hoverKind) {
      const count = hoverKind === 'M'
        ? elements.planes.length
        : elements.axes.filter((a) => a.kinds.has(hoverKind)).length;
      return { title: KIND_META[hoverKind].label, sub: `${count} detected`, color: KIND_META[hoverKind].color };
    }
    return null;
  }, [highlightLabel, hoverKind, elements]);

  // Recomputes every bond cylinder's position/orientation/length from its
  // two atoms' *current* mesh positions — called both after a rebuild and
  // every frame an operation is being replayed, since the atoms move but
  // the bonds are separate meshes that don't follow automatically.
  function updateBondMeshes() {
    const UP = new THREE.Vector3(0, 1, 0);
    for (const rec of bondRecordsRef.current) {
      const p1 = atomRecordsRef.current[rec.a1]?.mesh.position;
      const p2 = atomRecordsRef.current[rec.a2]?.mesh.position;
      if (!p1 || !p2) continue;
      const dir = new THREE.Vector3().subVectors(p2, p1);
      const len = Math.max(0.001, dir.length());
      rec.mesh.position.copy(p1).addScaledVector(dir, 0.5);
      rec.mesh.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
      rec.mesh.scale.set(1, len, 1);
    }
  }

  // Moves every atom mesh to `op` applied at progress `amt` (0 = rest,
  // 1 = fully applied — see applyOperationAmt), then re-derives the bonds
  // from the new atom positions.
  function applyAtomPositions(op, amt) {
    for (const rec of atomRecordsRef.current) {
      rec.mesh.position.copy(applyOperationAmt(rec.base, centroidVecRef.current, op, amt));
    }
    updateBondMeshes();
  }

  function snapToRest() {
    animRef.current = null;
    for (const rec of atomRecordsRef.current) rec.mesh.position.copy(rec.base);
    updateBondMeshes();
    fadeGhosts(1);
  }

  // Parks every ghost at its atom's *current* position and resets it to
  // full ghost opacity — called at the start of each replay phase (fwd,
  // then back) so the echo left behind is always "where it just was" for
  // that leg of the motion, not a stale snapshot from an earlier phase.
  function snapshotGhosts() {
    for (let i = 0; i < ghostRecordsRef.current.length; i++) {
      const ghost = ghostRecordsRef.current[i];
      const atom = atomRecordsRef.current[i];
      if (!ghost || !atom) continue;
      ghost.position.copy(atom.mesh.position);
      ghost.material.opacity = GHOST_OPACITY;
    }
  }
  // t is the phase's own raw (un-eased) progress, 0 -> 1 — the echo is
  // brightest the instant it's dropped and linearly dissolves from there.
  function fadeGhosts(t) {
    const opacity = GHOST_OPACITY * (1 - Math.min(1, Math.max(0, t)));
    for (const ghost of ghostRecordsRef.current) ghost.material.opacity = opacity;
  }

  // Kicks off the forward/hold/back replay of a single operation. Also
  // drives the existing glow highlight (handleFrame's opacity lerp already
  // reacts to highlightRef, so this reuses it rather than duplicating it)
  // except for E, which has no drawn axis/plane to glow.
  function startPlayOp(op) {
    animRef.current = { op, phase: 'fwd', start: performance.now() };
    setPlayingLabel(op.label);
    if (op.kind !== 'E') {
      setHighlightLabel(op.label);
      snapshotGhosts(); // drop an echo at the (still at-rest) starting positions
    }
  }

  function advancePlayQueue() {
    const queue = playQueueRef.current;
    if (!queue.length) {
      isPlayingAllRef.current = false;
      setIsPlayingAll(false);
      setPlayingLabel(null);
      setHighlightLabel(null);
      return;
    }
    const [next, ...rest] = queue;
    playQueueRef.current = rest;
    startPlayOp(next);
  }

  function togglePlayAll(e) {
    e.stopPropagation();
    if (isPlayingAllRef.current) {
      isPlayingAllRef.current = false;
      setIsPlayingAll(false);
      setPlayingLabel(null);
      setHighlightLabel(null);
      snapToRest();
      return;
    }
    const queue = operations && operations.length ? [...operations] : [];
    if (!queue.length) return;
    const [first, ...rest] = queue;
    playQueueRef.current = rest;
    isPlayingAllRef.current = true;
    setIsPlayingAll(true);
    startPlayOp(first);
  }

  // Re-projects every atom's current 3D position into the container's
  // screen space and moves its label <div> there. Runs every frame (atoms
  // move both from OrbitControls' camera motion and from an operation
  // replay), so labels track the molecule instead of drifting off it.
  function updateLabelPositions() {
    const cam = cameraRef.current;
    const container = containerRef.current;
    if (!cam || !container) return;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    for (let i = 0; i < atomRecordsRef.current.length; i++) {
      const div = labelDivsRef.current[i];
      if (!div) continue;
      const ndc = atomRecordsRef.current[i].mesh.position.clone().project(cam);
      const x = (ndc.x * 0.5 + 0.5) * w;
      const y = (-ndc.y * 0.5 + 0.5) * h;
      div.style.transform = `translate(${x}px, ${y}px) translate(-50%, -155%)`;
      div.style.opacity = ndc.z > 1 ? '0' : '1';
    }
  }

  // Per-frame: lerp every symmetry element's core/halo opacity + halo scale
  // toward its highlighted or resting state (the smooth "glow" 3Dmol's shape
  // API couldn't give us), and step whichever operation is currently being
  // replayed through its forward/hold/back cycle.
  const handleFrame = (dt) => {
    if (showLabels) updateLabelPositions();
    const label = highlightRef.current;
    const hk = hoverKindRef.current;
    const t = Math.min(1, dt * 9);
    for (const rec of symmetryRecordsRef.current) {
      const kindHi = hk && (rec.kinds ? rec.kinds.has(hk) : rec.kind === hk);
      const hi = kindHi || (label === 'i' ? rec.kind === 'i' : rec.labels.includes(label));
      const coreTarget = hi ? rec.coreHiOpacity : rec.coreBaseOpacity;
      const haloTarget = hi ? rec.haloHiOpacity : 0;
      const scaleTarget = hi ? rec.haloHiScale : 1;
      rec.core.material.opacity += (coreTarget - rec.core.material.opacity) * t;
      rec.halo.material.opacity += (haloTarget - rec.halo.material.opacity) * t;
      const s = rec.halo.scale.x + (scaleTarget - rec.halo.scale.x) * t;
      rec.halo.scale.setScalar(s);
      // A mirror plane's boundary ring fades with the rest of it instead of
      // sitting at a fixed opacity forever — without this it was the one
      // piece of a "hidden until active" element that stayed on screen.
      if (rec.ring) {
        const ringTarget = hi ? rec.ringHiOpacity : 0;
        rec.ring.material.opacity += (ringTarget - rec.ring.material.opacity) * t;
      }
    }

    const anim = animRef.current;
    if (!anim) return;
    // Slow motion stretches every phase's duration by 1/factor (e.g. at
    // 0.3x speed a 900ms forward swing takes 3000ms) without touching the
    // easing curve or the ghost-trail fade, which both key off the same
    // stretched progress — so the motion looks the same, just unhurried.
    const speed = slowMotionRef.current ? SLOW_MOTION_FACTOR : 1;
    const now = performance.now();
    const elapsed = now - anim.start;
    if (anim.phase === 'fwd') {
      const dur = ANIM_FWD_MS / speed;
      const rawT = Math.min(1, elapsed / dur);
      applyAtomPositions(anim.op, easeInOutCubic(rawT));
      if (anim.op.kind !== 'E') fadeGhosts(rawT);
      if (rawT >= 1) { anim.phase = 'hold'; anim.start = now; }
    } else if (anim.phase === 'hold') {
      if (elapsed >= ANIM_HOLD_MS / speed) {
        anim.phase = 'back'; anim.start = now;
        if (anim.op.kind !== 'E') snapshotGhosts(); // echo the fully-applied position before reversing
      }
    } else if (anim.phase === 'back') {
      const dur = ANIM_BACK_MS / speed;
      const rawT = Math.min(1, elapsed / dur);
      applyAtomPositions(anim.op, easeInOutCubic(Math.max(0, 1 - rawT)));
      if (anim.op.kind !== 'E') fadeGhosts(rawT);
      if (elapsed >= dur) {
        animRef.current = null;
        applyAtomPositions(anim.op, 0); // snap exactly to rest, no float drift
        if (isPlayingAllRef.current) {
          window.setTimeout(() => { if (isPlayingAllRef.current) advancePlayQueue(); }, ANIM_GAP_MS / speed);
        } else {
          setPlayingLabel(null);
          setHighlightLabel(null);
        }
      }
    }
  };

  // background: null keeps the WebGL canvas transparent so the lighter,
  // animated .symviewer-drift-bg CSS layer behind it is what's actually
  // seen — previously this was an opaque solid color painted *in front of*
  // that CSS layer, which fully hid it (and, being near-black, is also why
  // the control buttons above read as almost invisible against it).
  const { sceneRef, cameraRef, controlsRef, status } = useThreeScene(containerRef, {
    background: null,
    lighting: 'light',
    onFrame: handleFrame,
  });
  const ready = status === 'ready';

  // Build (or rebuild) the molecule + symmetry-element meshes whenever the
  // structure or its operations change. Separate from the toggle/highlight
  // effects below so flipping a checkbox never re-parses or re-lights.
  useEffect(() => {
    if (!ready || !sceneRef.current) return;
    const scene = sceneRef.current;

    if (groupRootRef.current) {
      scene.remove(groupRootRef.current);
      disposeObject(groupRootRef.current);
    }
    symmetryRecordsRef.current = [];

    // A new structure invalidates whatever operation was mid-replay (its
    // atom/bond meshes are about to be torn down) and any queued sequence.
    animRef.current = null;
    playQueueRef.current = [];
    isPlayingAllRef.current = false;
    setIsPlayingAll(false);
    setPlayingLabel(null);

    const root = new THREE.Group();
    const UP = new THREE.Vector3(0, 1, 0); // used to orient bond cylinders (initial build) and axis-rod helpers below

    // ---- atoms ----
    atomRecordsRef.current = [];
    ghostRecordsRef.current = [];
    if (labelsContainerRef.current) labelsContainerRef.current.innerHTML = '';
    labelDivsRef.current = [];
    // How many atoms of this element came before this one — lets two
    // oxygens be labelled O1/O2 instead of both just "O".
    const seenPerElement = new Map();
    const sizeScale = moleculeSizeScale(parsed.atoms, parsed.bonds);
    parsed.atoms.forEach((a) => {
      const r = elemRadius(a.element) * sizeScale;
      const geo = new THREE.SphereGeometry(r, 20, 16);
      // Exact match for the homepage/Library palette + gloss (elemColor /
      // makeAtomMaterial, shared with moleculeMeshBuilder.js) instead of
      // this viewer's own deepened-HSL take on ELEMENTS' pastel colors.
      const color = elemColor(a.element);
      const mat = makeAtomMaterial(color);
      const mesh = new THREE.Mesh(geo, mat);
      const base = new THREE.Vector3(a.x, a.y, a.z);
      mesh.position.copy(base);
      root.add(mesh);
      atomRecordsRef.current.push({ mesh, base });

      // Wireframe echo of this atom, invisible at rest — snapshotGhosts()
      // parks it at the atom's pre-move position when a replay phase
      // starts, then fadeGhosts() fades it back to 0 over that phase.
      const ghostMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0, wireframe: true, depthWrite: false,
      });
      const ghost = new THREE.Mesh(new THREE.SphereGeometry(r * 0.97, 14, 10), ghostMat);
      ghost.position.copy(base);
      root.add(ghost);
      ghostRecordsRef.current.push(ghost);

      const n = (seenPerElement.get(a.element) || 0) + 1;
      seenPerElement.set(a.element, n);
      const labelDiv = document.createElement('div');
      labelDiv.className = 'symviewer-atom-label';
      labelDiv.textContent = `${a.element}${n}`;
      labelsContainerRef.current?.appendChild(labelDiv);
      labelDivsRef.current.push(labelDiv);
    });

    // ---- bonds ----
    // Unit-height cylinders stretched/oriented via position+quaternion+scale
    // each frame (updateBondMeshes, below) rather than rebuilding geometry —
    // cheap enough to run at 60fps while an operation is being replayed.
    // Same color + gloss + radius as every other viewer (makeBondMaterial,
    // BOND_COLOR, and the homepage's 0.085 single-bond radius).
    const bondMat = makeBondMaterial(BOND_COLOR);
    bondRecordsRef.current = [];
    for (const b of parsed.bonds) {
      const a1 = parsed.atoms[b.a1];
      const a2 = parsed.atoms[b.a2];
      if (!a1 || !a2) continue;
      const geo = new THREE.CylinderGeometry(0.085, 0.085, 1, 10);
      const mesh = new THREE.Mesh(geo, bondMat);
      root.add(mesh);
      bondRecordsRef.current.push({ mesh, a1: b.a1, a2: b.a2 });
    }
    updateBondMeshes();

    // ---- symmetry elements: each is a solid "core" + a bigger, additive
    // "halo" that stays at zero opacity until highlighted (animated in
    // handleFrame above). Additive blending + no depth-write is what gives
    // the neon look without a full post-processing bloom pass. ----
    const c = new THREE.Vector3(...centroid);
    centroidVecRef.current.copy(c);
    const L = radius * 1.6 + AXIS_LENGTH_PAD;
    const R = radius * 1.3 + PLANE_PAD;

    for (const ax of elements.axes) {
      const kind = ax.kinds.has('C') ? 'C' : 'S';
      const dir = new THREE.Vector3(...ax.dir).normalize();
      const shaftLen = Math.max(0.1, L * 2 - ARROW_HEAD_LENGTH * 2);

      // Shaft: one cylinder through the centroid. Its material is shared
      // with both arrowhead cones (below), so animating this one material's
      // opacity in handleFrame lights up the whole arrow, tip to tip.
      const coreGeo = new THREE.CylinderGeometry(0.028, 0.028, shaftLen, 10);
      // depthWrite:false is the fix for the "axes stuck in the mirror plane" bug: an axis is
      // fully transparent (opacity 0) at rest, but a transparent mesh still WRITES depth by
      // default. Axes that lie inside a mirror plane (every C2/C3 in Td, etc.) therefore
      // carved invisible depth-holes into the plane's disc, which showed up as dark spokes
      // radiating from the centre. Never let a glow/guide element write depth.
      const coreMat = new THREE.MeshBasicMaterial({
        color: KIND_META[kind].hex, transparent: true, opacity: 0, depthWrite: false,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      const haloGeo = new THREE.CylinderGeometry(0.09, 0.09, shaftLen, 10);
      const haloMat = new THREE.MeshBasicMaterial({
        color: KIND_META[kind].hex, transparent: true, opacity: 0,
        blending: THREE.NormalBlending, depthWrite: false, depthTest: false,
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      [core, halo].forEach((m) => {
        m.position.copy(c);
        m.quaternion.setFromUnitVectors(UP, dir);
      });
      // core/halo share an axis and their flat end-caps sit in the exact
      // same plane at each tip, which z-fights (flickers as thin dark
      // "hidden" lines/rings right on the axis) once opacity comes up.
      // depthTest:false on the halo + explicit renderOrder makes draw
      // order deterministic instead of leaving it to per-frame camera-
      // distance sorting of two coincident-center transparent meshes.
      core.renderOrder = 1;
      halo.renderOrder = 2;

      // Arrowhead cones at both ends — a symmetry axis runs both
      // directions through the molecule, so both tips get a head (unlike a
      // one-way vector arrow).
      const tipOffset = shaftLen / 2 + ARROW_HEAD_LENGTH / 2;
      const extraMeshes = [];
      for (const sign of [1, -1]) {
        const tipDir = dir.clone().multiplyScalar(sign);
        const coneCoreGeo = new THREE.ConeGeometry(ARROW_HEAD_RADIUS, ARROW_HEAD_LENGTH, 12);
        const coneCore = new THREE.Mesh(coneCoreGeo, coreMat); // shares coreMat
        const coneHaloGeo = new THREE.ConeGeometry(ARROW_HEAD_RADIUS * 1.7, ARROW_HEAD_LENGTH * 1.15, 12);
        const coneHalo = new THREE.Mesh(coneHaloGeo, haloMat); // shares haloMat
        [coneCore, coneHalo].forEach((m) => {
          m.position.copy(c).addScaledVector(tipDir, tipOffset);
          m.quaternion.setFromUnitVectors(UP, tipDir);
        });
        coneCore.renderOrder = 1;
        coneHalo.renderOrder = 2; // see the core/halo renderOrder note above — same coincident-cap issue at the cone bases
        extraMeshes.push(coneCore, coneHalo);
      }

      root.add(core, halo, ...extraMeshes);
      symmetryRecordsRef.current.push({
        kind, kinds: ax.kinds, labels: ax.labels, core, halo, visMeshes: [core, halo, ...extraMeshes],
        // Invisible at rest — the shaft and its two arrowhead cones share
        // coreMat/haloMat, so this one opacity drives all of them. An axis
        // (and its heads) only fades in while it's the one actually being
        // rotated (playing or hovered/selected), matching how
        // molecular-symmetry.html only heads the *active* op's axis and
        // leaves every other one undrawn.
        coreBaseOpacity: 0, coreHiOpacity: 1, haloHiOpacity: 0.3, haloHiScale: 1.6,
      });
    }

    for (const pl of elements.planes) {
      // A mirror plane is drawn as a circular disc (rather than a square
      // card) with a slightly brighter ring traced around its rim, closer
      // to how these are usually sketched in symmetry diagrams.
      const n = pl.normal;
      const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = norm(cross(n, helper));
      const v = norm(cross(n, u));
      const pointAt = (radiusScale, angle) => {
        const su = Math.cos(angle) * radiusScale;
        const sv = Math.sin(angle) * radiusScale;
        return new THREE.Vector3(
          c.x + u[0] * su + v[0] * sv, c.y + u[1] * su + v[1] * sv, c.z + u[2] * su + v[2] * sv,
        );
      };
      const makeDiscMesh = (radiusScale, opacity, additive) => {
        const verts = new Float32Array(PLANE_SEGMENTS * 9);
        for (let i = 0; i < PLANE_SEGMENTS; i++) {
          const a0 = (i / PLANE_SEGMENTS) * Math.PI * 2;
          const a1 = ((i + 1) / PLANE_SEGMENTS) * Math.PI * 2;
          const p0 = pointAt(radiusScale, a0);
          const p1 = pointAt(radiusScale, a1);
          verts.set([c.x, c.y, c.z, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], i * 9);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        geo.computeVertexNormals();
        const mat = new THREE.MeshBasicMaterial({
          color: KIND_META.M.hex, transparent: true, opacity, side: THREE.DoubleSide,
          depthWrite: false, depthTest: !additive,
          blending: additive ? THREE.NormalBlending : THREE.NormalBlending,
        });
        return new THREE.Mesh(geo, mat);
      };
      const makeRingMesh = (radiusScale, opacity) => {
        const pts = [];
        for (let i = 0; i <= PLANE_SEGMENTS; i++) {
          const a = (i / PLANE_SEGMENTS) * Math.PI * 2;
          pts.push(pointAt(radiusScale, a));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
          color: KIND_META.M.hex, transparent: true, opacity,
          blending: THREE.NormalBlending, depthWrite: false, depthTest: false,
        });
        return new THREE.LineLoop(geo, mat);
      };
      // core/halo/ring are three coplanar shapes centered on the same
      // point — core and halo in particular cover the exact same triangle
      // fan over their shared radius, which is a textbook z-fighting setup
      // and is what was reading as faint, flickering "hidden axis" spokes
      // radiating across the plane. depthTest:false on the halo + ring
      // (both pure glow/outline, never meant to occlude or be occluded by
      // the core) plus explicit renderOrder makes the draw order fixed
      // instead of left to per-frame transparent-object sorting of three
      // meshes that all sit at the same distance from the camera.
      const core = makeDiscMesh(R, 0, false);
      const halo = makeDiscMesh(R * 1.06, 0, true);
      const ring = makeRingMesh(R, 0); // starts invisible — handleFrame now fades it in/out itself
      core.renderOrder = 1;
      halo.renderOrder = 2;
      ring.renderOrder = 3;
      root.add(core, halo, ring);
      symmetryRecordsRef.current.push({
        // Fully invisible at rest, same as an axis — a plane only appears
        // while it's the element actually being played/hovered/selected.
        kind: 'M', labels: pl.labels, core, halo, ring, visMeshes: [core, halo, ring],
        coreBaseOpacity: 0, coreHiOpacity: 0.38, haloHiOpacity: 0.16, haloHiScale: 1, ringHiOpacity: 0.9,
      });
    }

    if (elements.hasInversion) {
      const coreGeo = new THREE.SphereGeometry(0.14, 16, 12);
      const coreMat = new THREE.MeshBasicMaterial({ color: KIND_META.i.hex, transparent: true, opacity: 0, depthWrite: false });
      const core = new THREE.Mesh(coreGeo, coreMat);
      // Was SphereGeometry(0.14, ...) — identical radius to the core, so
      // the two spheres were perfectly coincident (a worse case of the
      // same z-fighting bug as the mirror-plane discs above: two
      // fully-overlapping surfaces flickering over which one wins the
      // depth test). Every other element's halo is deliberately bigger
      // than its core (that's what makes it read as a glow); this one
      // just never got that treatment.
      const haloGeo = new THREE.SphereGeometry(0.14 * 1.8, 16, 12);
      const haloMat = new THREE.MeshBasicMaterial({
        color: KIND_META.i.hex, transparent: true, opacity: 0,
        blending: THREE.NormalBlending, depthWrite: false, depthTest: false,
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      core.position.copy(c);
      halo.position.copy(c);
      core.renderOrder = 1;
      halo.renderOrder = 2;
      root.add(core, halo);
      symmetryRecordsRef.current.push({
        // Also fully invisible at rest now, for the same reason as the axes
        // and planes above — nothing is drawn until it's the element that's
        // actually active.
        kind: 'i', labels: ['i'], core, halo, visMeshes: [core, halo],
        coreBaseOpacity: 0, coreHiOpacity: 1, haloHiOpacity: 0.35, haloHiScale: 2.2,
      });
    }

    scene.add(root);
    groupRootRef.current = root;

    // Frame the camera on this structure.
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (cam && controls) {
      // The lens is sized to the canvas height, so in a tall, narrow canvas (a phone held upright)
      // the structure spilled off the sides. Back off in proportion to how narrow it is.
      const aspect = cam.aspect > 0 ? cam.aspect : 1;
      const narrowFactor = aspect < 1 ? Math.min(2.2, 1.15 / aspect) : 1;
      const distance = (radius * 2.6 + 3) * narrowFactor;
      fitRef.current = { distance, target: c.clone() };
      cam.position.copy(c.clone().add(new THREE.Vector3(0.35, 0.25, 1).normalize().multiplyScalar(distance)));
      controls.target.copy(c);
      controls.update();
    }

    return () => {
      if (groupRootRef.current) {
        scene.remove(groupRootRef.current);
        disposeObject(groupRootRef.current);
        groupRootRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, parsed, elements, centroid, radius]);

  // Toggling a kind just flips .visible on the already-built meshes — no
  // rebuild, so this never touches geometry/materials.
  useEffect(() => {
    for (const rec of symmetryRecordsRef.current) {
      const visible = visibleKinds.has(rec.kind);
      for (const mesh of rec.visMeshes || [rec.core, rec.halo]) mesh.visible = visible;
    }
  }, [visibleKinds, elements]);

  useEffect(() => {
    if (controlsRef.current) controlsRef.current.autoRotate = spinning;
  }, [spinning, controlsRef]);

  // Single-operation playback requested from outside (e.g. clicking an
  // operation chip on the page). `playRequest` carries a token so clicking
  // the same label twice in a row still replays it (a plain label wouldn't
  // change and this effect wouldn't re-fire).
  useEffect(() => {
    if (!playRequest?.label || !ready) return;
    const op = (operations || []).find((o) => o.label === playRequest.label);
    if (op) startPlayOp(op);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playRequest, ready, operations]);

  const toggleKind = (k) => {
    setVisibleKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const toggleSpin = (e) => { e.stopPropagation(); setSpinning((s) => !s); };

  const resetView = (e) => {
    e.stopPropagation();
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam || !controls || !fitRef.current) return;
    const { distance, target } = fitRef.current;
    cam.position.copy(target.clone().add(new THREE.Vector3(0.35, 0.25, 1).normalize().multiplyScalar(distance)));
    controls.target.copy(target);
    controls.update();
  };

  const enterKind = (k) => {
    hoverKindRef.current = k;
    setHoverKind(k);
  };
  const leaveKind = () => {
    hoverKindRef.current = null;
    setHoverKind(null);
  };

  // Distinguish "click the background to expand" from "drag to orbit" —
  // OrbitControls listens on the canvas directly, so a plain onClick here
  // would also fire at the end of every drag.
  const pointerDownRef = useRef(null);
  const onPointerDown = (e) => { pointerDownRef.current = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const onPointerUp = (e) => {
    const d = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!d || !clickableBg) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved < 6 && performance.now() - d.t < 500) onMaximize();
  };

  return (
    <div
      className="symviewer relative overflow-hidden rounded-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] group"
      style={{ background: '#fffdf8', border: '1.5px solid var(--gt-ink, #16191b)' }}
    >
      <style>{`
        @keyframes symviewer-drift {
          from { transform: translate3d(-2%, -1%, 0) scale(1); }
          to   { transform: translate3d(3%, 2%, 0) scale(1.08); }
        }
        @keyframes symviewer-rise {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes symviewer-pop {
          from { opacity: .2; transform: translateY(4px); }
          to   { opacity: 1; transform: none; }
        }
        .symviewer-drift-bg {
          /* Lighter than before on purpose — a near-black backdrop was
             swallowing darker atoms/bonds and the dark control chips above
             it alike. This is now also the *only* background (the canvas
             is transparent, see background: null above), so it's what's
             actually on screen, not a hidden layer behind an opaque canvas.
             Colors are pulled from the page's own --gt-teal palette (with
             hardcoded fallbacks) instead of a brighter, unrelated cyan, so
             the "stage" reads as part of this page's theme rather than a
             mismatched blue box dropped into a warm paper layout. */
          position: absolute; inset: -20%; pointer-events: none; z-index: 0;
          background:
            radial-gradient(45% 45% at 60% 32%, rgba(189,234,249,.75), transparent 70%),
            radial-gradient(60% 60% at 30% 80%, rgba(251,219,160,.5), transparent 70%),
            #fffdf8;
          animation: symviewer-drift 46s ease-in-out infinite alternate;
        }
        .symviewer-vignette {
          position: absolute; inset: 0; pointer-events: none; z-index: 2;
          box-shadow: inset 0 0 50px 6px rgba(22,25,27,.06);
        }
        .symviewer-chip { animation: symviewer-rise .35s ease both; }
        .symviewer-hud { animation: symviewer-pop .22s ease both; }
        .symviewer-atom-label {
          position: absolute; top: 0; left: 0;
          font: 600 10px/1 ui-monospace, "JetBrains Mono", Menlo, monospace;
          color: #16191b;
          text-shadow: 0 0 3px #fffdf8, 0 0 6px #fffdf8, 0 1px 2px rgba(255,255,255,.9);
          white-space: nowrap; transition: opacity .15s ease;
        }
        @media (prefers-reduced-motion: reduce) {
          .symviewer-drift-bg { animation: none; }
          .symviewer-chip, .symviewer-hud { animation: none; }
        }
      `}</style>

      <div className="symviewer-drift-bg" />

      <div
        ref={containerRef}
        style={{ height, width: '100%', position: 'relative', zIndex: 1, cursor: clickableBg ? 'grab' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      />

      <div
        ref={labelsContainerRef}
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        style={{ display: showLabels ? 'block' : 'none' }}
      />

      <div className="symviewer-vignette" />

      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-xs text-[#4b5257]">
          <Loader2 size={14} className="animate-spin" /> Loading 3D engine&hellip;
        </div>
      )}
      {status === 'failed' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-4 text-center">
          <FlaskConical size={22} className="text-[#4b5257]" />
          <p className="text-xs text-[#4b5257]">Couldn&rsquo;t start the 3D engine &mdash; your browser or device may not support WebGL.</p>
        </div>
      )}

      {ready && (formulaPretty || groupPretty) && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 text-[10px] tracking-wide text-[#4b5257]">
          {groupPretty && <div className="mb-0.5 uppercase">Point group</div>}
          <div className="font-display text-xl leading-none text-[#16191b]">{groupPretty || formulaPretty}</div>
          {groupPretty && formulaPretty && <div className="mt-0.5 text-[#4b5257]">{formulaPretty}</div>}
          {playingLabel && (
            <div className="mt-1.5 flex items-center gap-1 font-mono text-[10px] text-[#0f766e]">
              <Play size={9} className="shrink-0" /> playing {playingLabel}{slowMotion ? ' \u00b7 slow-mo' : ''}
            </div>
          )}
        </div>
      )}

      {ready && (
        <div className="absolute right-2 top-2 z-10 flex max-w-[calc(100%-6.75rem)] flex-wrap items-center justify-end gap-1.5 sm:max-w-none sm:flex-nowrap" onClick={(e) => e.stopPropagation()}>
          {operations && operations.length > 0 && (
            <button
              onClick={togglePlayAll}
              title={isPlayingAll ? 'Stop' : 'Play every symmetry operation in sequence'}
              className={`flex items-center gap-1 rounded-md px-2.5 py-2 text-[11px] font-medium shadow-sm transition-colors sm:px-2 sm:py-1.5 ${
                isPlayingAll
                  ? CTRL_ON
                  : CTRL_OFF
              }`}
            >
              {isPlayingAll ? <Pause size={13} /> : <Play size={13} />}
              <span className="hidden sm:inline">{isPlayingAll ? 'Stop' : 'Play all operations'}</span>
              <span className="sm:hidden">{isPlayingAll ? 'Stop' : 'Play all'}</span>
            </button>
          )}
          {operations && operations.length > 0 && (
            <button
              onClick={toggleSlowMotion}
              title={slowMotion ? 'Play at normal speed' : 'Slow motion — play operations at 0.3x speed'}
              className={`rounded-md p-2 shadow-sm transition-colors sm:p-1.5 ${
                slowMotion
                  ? CTRL_ON
                  : CTRL_OFF
              }`}
            >
              <Turtle size={13} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setShowLabels((s) => !s); }}
            title={showLabels ? 'Hide atom labels' : 'Show atom labels'}
            className={`rounded-md p-2 shadow-sm transition-colors sm:p-1.5 ${
              showLabels
                ? CTRL_ON
                : CTRL_OFF
            }`}
          >
            <Tag size={13} />
          </button>
          <button
            onClick={toggleSpin}
            title={spinning ? 'Pause rotation' : 'Resume rotation'}
            className={`rounded-md p-2 shadow-sm transition-colors sm:p-1.5 ${CTRL_OFF}`}
          >
            {spinning ? <Pause size={13} /> : <Play size={13} />}
          </button>
          {clickableBg && (
            <button
              onClick={(e) => { e.stopPropagation(); onMaximize(); }}
              title="Maximize"
              className={`rounded-md p-2 shadow-sm transition-colors sm:p-1.5 ${CTRL_OFF}`}
            >
              <Maximize2 size={13} />
            </button>
          )}
          <button
            onClick={resetView}
            title="Reset view"
            className={`rounded-md p-2 shadow-sm transition-colors sm:p-1.5 ${CTRL_OFF}`}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      )}

      {ready && presentKinds.length > 0 && (
        <div className="absolute bottom-2 left-2 z-20 flex flex-wrap gap-1.5 max-w-[70%]">
          {presentKinds.map((k, i) => (
            <button
              key={k}
              onClick={(e) => { e.stopPropagation(); toggleKind(k); }}
              onMouseEnter={() => enterKind(k)}
              onMouseLeave={leaveKind}
              style={{ animationDelay: `${i * 0.05}s`, borderColor: visibleKinds.has(k) ? '#16191b' : 'rgba(22,25,27,.25)' }}
              className={`symviewer-chip flex items-center gap-1.5 rounded-md border-[1.5px] bg-[#fffdf8] px-2 py-1 text-[10px] font-medium shadow-sm transition-all hover:-translate-y-0.5 ${
                visibleKinds.has(k) ? 'opacity-100' : 'opacity-40'
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_META[k].color }} />
              <span className="text-[#16191b]">{KIND_META[k].label}</span>
            </button>
          ))}
        </div>
      )}

      {ready && hudInfo && (
        <div className="symviewer-hud pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-11 pt-8"
          style={{ background: 'linear-gradient(to top, rgba(255,253,248,.95), rgba(255,253,248,0))' }}
        >
          <p className="font-display m-0 text-2xl leading-none" style={{ color: hudInfo.color }}>{hudInfo.title}</p>
          <p className="m-0 mt-1 text-[11px] text-[#4b5257]">{hudInfo.sub}</p>
        </div>
      )}

      {clickableBg && ready && !hudInfo && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-center pt-3">
          <span className="rounded-full bg-[#16191b] px-3 py-1.5 text-[11px] font-medium text-[#f3ede2] opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
            Click background to expand
          </span>
        </div>
      )}
    </div>
  );
}

export { KIND_META, KIND_ORDER, buildElements, parseMolV2000 };