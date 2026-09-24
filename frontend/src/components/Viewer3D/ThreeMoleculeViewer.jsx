import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RotateCcw, Loader2, Maximize2, X, Play, Pause, FlaskConical, Tag } from 'lucide-react';
import { useThreeScene } from './useThreeScene';
import { buildMoleculeGroup, disposeGroup, fitCameraToRadius, parseMolV2000, MOLECULE_STYLES } from './moleculeMeshBuilder';

// 'stick' kept alongside the newer cloud/ballstick/spacefill/line set.
const STYLE_IDS = ['ballstick', 'stick', 'spacefill', 'line', 'cloud'];

// Short chip labels for the style strip — the full names from
// MOLECULE_STYLES (used elsewhere, e.g. MiniThreeMoleculeViewer, and as
// this button's title/tooltip) are too wide for narrow hosts like Draw
// Lab's 224px sidebar: at that width "Ball & Stick" + "Space-filling" +
// "Electron Cloud" etc as flex-wrap chips don't fit one row and wrap
// into an ugly vertical list. Shortening the on-chip text (full name
// stays in the title tooltip) plus the horizontal-scroll strip below is
// the actual fix — this alone just buys back some room.
const STYLE_SHORT_LABELS = {
  ballstick: 'Ball & Stick',
  stick: 'Stick',
  spacefill: 'Space-fill',
  line: 'Line',
  cloud: 'Cloud',
};

const BOND_COLOR = 0xaaa39a;

// Three.js molecule viewer, restyled to match the homepage's HeroMolecule
// preview: a pale paper card with a slow drifting blue/orange wash behind a
// transparent WebGL canvas, instead of the old dark "lab-950" panel. Same
// public contract (molBlock/height/title/atoms/colorScheme) and the same
// maximize/style-switch/spin/reset/click-to-inspect controls as before —
// only the look changes, everywhere this component is used (Library's 3D
// tab, Quiz, Draw Lab, My Molecules).
export default function ThreeMoleculeViewer({ molBlock, height = 320, title = 'Molecule', atoms = null, colorScheme = null }) {
  const [isMaximized, setIsMaximized] = useState(false);

  return (
    <>
      <Inner
        molBlock={molBlock}
        height={height}
        atoms={atoms}
        colorScheme={colorScheme}
        onMaximize={() => setIsMaximized(true)}
        clickable
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
              <h3 className="font-display text-sm font-semibold text-lab-100">{title}</h3>
              <button
                onClick={() => setIsMaximized(false)}
                className="rounded-md p-1.5 text-lab-400 hover:bg-lab-800 hover:text-lab-100"
              >
                <X size={18} />
              </button>
            </div>
            <Inner molBlock={molBlock} height={520} atoms={atoms} colorScheme={colorScheme} />
          </div>
        </div>
      )}
    </>
  );
}

function Inner({ molBlock, height, onMaximize, clickable, atoms, colorScheme }) {
  const containerRef = useRef(null);
  const [style, setStyle] = useState('ballstick');
  const [spinning, setSpinning] = useState(true);
  const [clickedAtom, setClickedAtom] = useState(null);
  // Off by default — click the tag button to reveal every atom's label,
  // same toggle-on-demand behaviour as the Group Theory symmetry viewer.
  const [showLabels, setShowLabels] = useState(false);

  const groupRootRef = useRef(null);
  const atomRecordsRef = useRef([]);
  const pointerDownRef = useRef({ x: 0, y: 0, moved: false });
  const fittedMolRef = useRef(null);
  const labelsContainerRef = useRef(null);
  const labelDivsRef = useRef([]); // parallel to atomRecordsRef, one <div> per atom

  const parsed = useMemo(() => parseMolV2000(molBlock), [molBlock]);

  // Re-projects every atom's current 3D position into the container's
  // screen space and moves its label <div> there — same approach the
  // Group Theory symmetry viewer uses for its always-on atom labels.
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
  const handleFrame = () => {
    if (showLabels) updateLabelPositions();
  };

  // background: null keeps the canvas transparent so the light paper wash
  // (.molviewer-wash, below) shows through; lighting: 'light' swaps in
  // HeroMolecule's brighter rig so atoms don't go flat/muddy on the pale card.
  const { sceneRef, cameraRef, controlsRef, status } = useThreeScene(containerRef, {
    background: null,
    lighting: 'light',
    onFrame: handleFrame,
  });
  const ready = status === 'ready';

  // (Re)build the atom/bond meshes whenever the molecule or style changes.
  useEffect(() => {
    if (!ready || !sceneRef.current || !parsed.atoms.length) return;
    const scene = sceneRef.current;

    if (groupRootRef.current) {
      scene.remove(groupRootRef.current);
      disposeGroup(groupRootRef.current);
    }
    setClickedAtom(null);

    const { group, atomRecords } = buildMoleculeGroup({
      atoms: parsed.atoms,
      bonds: parsed.bonds,
      styleId: style,
      colorScheme,
      bondColor: BOND_COLOR,
    });
    scene.add(group);
    groupRootRef.current = group;
    atomRecordsRef.current = atomRecords;

    // Rebuild the label <div>s to match the new atom set — one per atom,
    // "C1"/"O2"-style (element + how-many-of-this-element-came-before-it),
    // same numbering the Group Theory symmetry viewer uses.
    if (labelsContainerRef.current) labelsContainerRef.current.innerHTML = '';
    labelDivsRef.current = [];
    const seenPerElement = new Map();
    atomRecords.forEach((rec) => {
      const n = (seenPerElement.get(rec.element) || 0) + 1;
      seenPerElement.set(rec.element, n);
      const labelDiv = document.createElement('div');
      labelDiv.className = 'molviewer-atom-label';
      labelDiv.textContent = `${rec.element}${n}`;
      labelsContainerRef.current?.appendChild(labelDiv);
      labelDivsRef.current.push(labelDiv);
    });

    const centroid = parsed.atoms.reduce(
      (acc, a) => acc.add(new THREE.Vector3(a.x, a.y, a.z)),
      new THREE.Vector3()
    ).multiplyScalar(1 / parsed.atoms.length);
    const radius = Math.max(1.2, ...parsed.atoms.map((a) => new THREE.Vector3(a.x, a.y, a.z).distanceTo(centroid)));

    // Re-frame the camera only when the molecule itself changed. Switching
    // style keeps the current rotation/zoom so the buttons feel instant.
    if (cameraRef.current && controlsRef.current) {
      if (fittedMolRef.current !== molBlock) {
        fitCameraToRadius(cameraRef.current, controlsRef.current, centroid, radius);
        fittedMolRef.current = molBlock;
      }
      controlsRef.current.autoRotate = spinning;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [molBlock, ready, style, colorScheme]);

  // Clean up the built meshes on unmount.
  useEffect(() => {
    return () => {
      if (groupRootRef.current && sceneRef.current) {
        sceneRef.current.remove(groupRootRef.current);
        disposeGroup(groupRootRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetView = (e) => {
    e.stopPropagation();
    if (!cameraRef.current || !controlsRef.current || !parsed.atoms.length) return;
    const centroid = parsed.atoms.reduce(
      (acc, a) => acc.add(new THREE.Vector3(a.x, a.y, a.z)),
      new THREE.Vector3()
    ).multiplyScalar(1 / parsed.atoms.length);
    const radius = Math.max(1.2, ...parsed.atoms.map((a) => new THREE.Vector3(a.x, a.y, a.z).distanceTo(centroid)));
    fitCameraToRadius(cameraRef.current, controlsRef.current, centroid, radius);
  };

  const toggleSpin = (e) => {
    e.stopPropagation();
    if (!controlsRef.current) return;
    controlsRef.current.autoRotate = !controlsRef.current.autoRotate;
    setSpinning(controlsRef.current.autoRotate);
  };

  // Click-to-inspect an atom: raycast against the sphere meshes, but only
  // register it as a "click" (not the start of an orbit-drag) when the
  // pointer barely moved between down and up.
  const onPointerDown = (e) => {
    pointerDownRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e) => {
    const d = pointerDownRef.current;
    if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) d.moved = true;
  };
  const onPointerUp = (e) => {
    if (pointerDownRef.current.moved) return;
    const container = containerRef.current;
    const cam = cameraRef.current;
    if (!container || !cam) return;
    const rect = container.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, cam);
    const meshes = atomRecordsRef.current.map((r) => r.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      const idx = hits[0].object.userData.atomIndex;
      const rec = atomRecordsRef.current[idx];
      setClickedAtom({ element: rec.element, x: rec.base.x, y: rec.base.y, z: rec.base.z, index: idx });
    } else if (clickable) {
      onMaximize?.();
    }
  };

  const enrichedInfo = (() => {
    if (!clickedAtom) return null;
    const base = {
      element: clickedAtom.element,
      x: clickedAtom.x?.toFixed(2),
      y: clickedAtom.y?.toFixed(2),
      z: clickedAtom.z?.toFixed(2),
    };
    if (atoms && atoms[clickedAtom.index]) {
      const orig = atoms[clickedAtom.index];
      return { ...base, charge: orig.charge || 0, lonePairs: orig.lonePairs || 0 };
    }
    return base;
  })();

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-lab-700 bg-[#fafaf9] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.6)] ${
        clickable ? 'group' : ''
      }`}
    >
      <style>{`
        .molviewer-wash {
          position: absolute; inset: -20%; pointer-events: none; z-index: 0;
          background:
            radial-gradient(42% 42% at 68% 30%, rgba(59,191,247,.22), transparent 70%),
            radial-gradient(48% 48% at 24% 78%, rgba(238,160,43,.18), transparent 70%),
            #fafaf9;
          animation: molviewer-drift 46s ease-in-out infinite alternate;
        }
        @keyframes molviewer-drift {
          0% { transform: translate(0, 0) scale(1); }
          100% { transform: translate(-3%, 3%) scale(1.06); }
        }
        @media (prefers-reduced-motion: reduce) {
          .molviewer-wash { animation: none; }
        }
        .molviewer-style-strip { scrollbar-width: none; -ms-overflow-style: none; }
        .molviewer-style-strip::-webkit-scrollbar { display: none; }
        .molviewer-atom-label {
          position: absolute; top: 0; left: 0;
          font: 600 10px/1 ui-monospace, "JetBrains Mono", Menlo, monospace;
          color: #262626;
          text-shadow: 0 0 3px #fafaf9, 0 0 6px #fafaf9, 0 1px 2px rgba(255,255,255,.9);
          white-space: nowrap; transition: opacity .15s ease;
        }
      `}</style>
      <div className="molviewer-wash" />
      <div
        ref={containerRef}
        style={{ height, width: '100%', position: 'relative', zIndex: 1, cursor: clickable ? 'zoom-in' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div
        ref={labelsContainerRef}
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        style={{ display: showLabels ? 'block' : 'none' }}
      />
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-xs text-[#8a8681]">
          <Loader2 size={14} className="animate-spin" /> Loading 3D view…
        </div>
      )}
      {status === 'failed' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-4 text-center">
          <FlaskConical size={22} className="text-[#8a8681]" />
          <p className="text-xs text-[#4e4e4d]">Couldn't start the 3D view — your browser or device may not support WebGL.</p>
        </div>
      )}
      {clickable && ready && !clickedAtom && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/5">
          <span className="rounded-full bg-[#fafaf9]/90 px-3 py-1.5 text-[11px] font-medium text-[#4e4e4d] opacity-0 shadow-lg ring-1 ring-black/10 transition-opacity group-hover:opacity-100">
            Click background to expand
          </span>
        </div>
      )}

      {/* Style switcher only shows in the maximized view — in the small
          inline preview it has no room to be anything but cramped/wrapped,
          and clicking the preview already opens the full view where these
          buttons have space to breathe. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex flex-col items-end gap-1">
        {!clickable && (
          <div
            className="molviewer-style-strip pointer-events-auto flex w-full max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-[#fafaf9]/90 p-1 shadow-lg ring-1 ring-black/5 backdrop-blur"
          >
            {STYLE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setStyle(id); }}
                title={MOLECULE_STYLES[id].label}
                aria-pressed={style === id}
                className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-[10px] font-mono transition-colors ${
                  style === id ? 'bg-phosphor text-lab-950' : 'text-[#5c5a56] hover:text-[#262626]'
                }`}
              >
                {STYLE_SHORT_LABELS[id]}
              </button>
            ))}
          </div>
        )}

        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowLabels((s) => !s); }}
            title={showLabels ? 'Hide atom labels' : 'Show atom labels'}
            aria-pressed={showLabels}
            className={`rounded-lg p-1.5 shadow-lg ring-1 ring-black/5 backdrop-blur ${
              showLabels ? 'bg-phosphor text-lab-950' : 'bg-[#fafaf9]/90 text-[#5c5a56] hover:text-[#262626]'
            }`}
          >
            <Tag size={13} />
          </button>
          <button
            type="button"
            onClick={toggleSpin}
            title={spinning ? 'Pause rotation' : 'Resume rotation'}
            className="rounded-lg bg-[#fafaf9]/90 p-1.5 text-[#5c5a56] shadow-lg ring-1 ring-black/5 backdrop-blur hover:text-[#262626]"
          >
            {spinning ? <Pause size={13} /> : <Play size={13} />}
          </button>
          {clickable && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMaximize?.(); }}
              title="Maximize"
              className="rounded-lg bg-[#fafaf9]/90 p-1.5 text-[#5c5a56] shadow-lg ring-1 ring-black/5 backdrop-blur hover:text-[#262626]"
            >
              <Maximize2 size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={resetView}
            title="Reset view"
            className="rounded-lg bg-[#fafaf9]/90 p-1.5 text-[#5c5a56] shadow-lg ring-1 ring-black/5 backdrop-blur hover:text-[#262626]"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {enrichedInfo && (
        <div className="absolute top-2 left-2 z-10 rounded-lg border border-black/10 bg-[#fafaf9]/95 px-3 py-2 text-xs text-[#4e4e4d] shadow-xl backdrop-blur">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="font-mono font-bold text-[#262626]">{enrichedInfo.element}</span>
            <button
              onClick={(e) => { e.stopPropagation(); setClickedAtom(null); }}
              className="text-[#8a8681] hover:text-[#262626]"
            >
              <X size={12} />
            </button>
          </div>
          {enrichedInfo.charge !== undefined && (
            <div className="text-[11px] text-[#8a8681]">
              Charge: <span className="text-[#4e4e4d]">{enrichedInfo.charge > 0 ? `+${enrichedInfo.charge}` : enrichedInfo.charge}</span>
            </div>
          )}
          {enrichedInfo.lonePairs !== undefined && (
            <div className="text-[11px] text-[#8a8681]">
              Lone pairs: <span className="text-[#4e4e4d]">{enrichedInfo.lonePairs}</span>
            </div>
          )}
          <div className="text-[11px] text-[#8a8681]">
            xyz: <span className="font-mono text-[#4e4e4d]">{enrichedInfo.x}, {enrichedInfo.y}, {enrichedInfo.z}</span>
          </div>
        </div>
      )}
    </div>
  );
}