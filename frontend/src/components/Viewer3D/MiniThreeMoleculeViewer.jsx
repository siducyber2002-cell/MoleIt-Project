import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RotateCcw, Loader2, Maximize2, X, Play, Pause, FlaskConical, Layers, ChevronUp } from 'lucide-react';
import { useThreeScene } from './useThreeScene';
import { buildMoleculeGroup, disposeGroup, fitCameraToRadius, parseMolV2000, MOLECULE_STYLES } from './moleculeMeshBuilder';

// Merge note: 'stick' was present in the old 308-line file's STYLE_IDS but
// missing from the updated version — restored here so the stick-style
// button shows up again alongside the newer cloud/ballstick/spacefill/line set.
const STYLE_IDS = ['ballstick', 'stick', 'spacefill', 'line', 'cloud'];

// Three.js replacement for the old 3Dmol.js-backed Molecule3DViewer. Same
// public contract (molBlock/height/title/atoms/colorScheme) and the same
// maximize/style-switch/spin/reset controls, but everything is real
// THREE.Mesh geometry built by moleculeMeshBuilder instead of a 3Dmol
// scene — no CDN script, no `window.$3Dmol` polling.
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

  // The style picker is collapsed into a single small button so the five
  // options never sit on top of the molecule; the list only pops up (upward)
  // while the user is actually choosing.
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const styleMenuRef = useRef(null);

  const groupRootRef = useRef(null);
  const atomRecordsRef = useRef([]);
  const pointerDownRef = useRef({ x: 0, y: 0, moved: false });
  const fittedMolRef = useRef(null);

  const parsed = useMemo(() => parseMolV2000(molBlock), [molBlock]);

  // background: null keeps the canvas transparent so the atmospheric CSS
  // gradient (.molviewer-drift-bg, below) shows through, same treatment the
  // Group Theory symmetry viewer already uses.
  const { sceneRef, cameraRef, controlsRef, status } = useThreeScene(containerRef, {
    background: null,
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
    });
    scene.add(group);
    groupRootRef.current = group;
    atomRecordsRef.current = atomRecords;

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

  // Close the style list on any press outside it (canvas, other buttons) or
  // on Escape, so it can never linger over the molecule.
  useEffect(() => {
    if (!styleMenuOpen) return undefined;
    const onPointerDown = (e) => {
      if (styleMenuRef.current && !styleMenuRef.current.contains(e.target)) setStyleMenuOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setStyleMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [styleMenuOpen]);

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
      className={`relative overflow-hidden rounded-xl border border-lab-700 bg-lab-950 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] ${
        clickable ? 'group' : ''
      }`}
    >
      <style>{`
        .molviewer-drift-bg {
          position: absolute; inset: -20%; pointer-events: none; z-index: 0;
          background:
            radial-gradient(45% 45% at 60% 32%, #12313a, transparent 70%),
            radial-gradient(60% 60% at 30% 80%, #0d2630, transparent 70%),
            #04090d;
          animation: molviewer-drift 46s ease-in-out infinite alternate;
        }
        @keyframes molviewer-drift {
          0% { transform: translate(0, 0) scale(1); }
          100% { transform: translate(-2%, 2%) scale(1.05); }
        }
        .molviewer-vignette {
          position: absolute; inset: 0; pointer-events: none; z-index: 2;
          box-shadow: inset 0 0 60px 10px rgba(2,8,12,.55);
        }
        @media (prefers-reduced-motion: reduce) {
          .molviewer-drift-bg { animation: none; }
        }
      `}</style>
      <div className="molviewer-drift-bg" />
      <div
        ref={containerRef}
        style={{ height, width: '100%', position: 'relative', zIndex: 1, cursor: clickable ? 'zoom-in' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div className="molviewer-vignette" />
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-lab-400">
          <Loader2 size={14} className="animate-spin" /> Loading 3D engine…
        </div>
      )}
      {status === 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
          <FlaskConical size={22} className="text-lab-600" />
          <p className="text-xs text-lab-500">Couldn't start the 3D engine — your browser or device may not support WebGL.</p>
        </div>
      )}
      {clickable && ready && !clickedAtom && !styleMenuOpen && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-lab-950/0 transition-colors group-hover:bg-lab-950/20">
          <span className="rounded-full bg-lab-950/80 px-3 py-1.5 text-[11px] font-medium text-phosphor opacity-0 shadow-lg ring-1 ring-phosphor/30 transition-opacity group-hover:opacity-100">
            Click background to expand
          </span>
        </div>
      )}

      {/* z-10 is the actual fix: the canvas container above is z-index 1, so
          without an explicit z-index these controls were painted *under* it
          and every click hit the canvas instead of the buttons. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex items-end justify-between gap-2">
        <div ref={styleMenuRef} className="pointer-events-auto relative min-w-0">
          {styleMenuOpen && (
            <div
              role="menu"
              aria-label="Molecule style"
              className="absolute bottom-full left-0 mb-1.5 flex w-max min-w-full flex-col gap-0.5 rounded-lg border border-lab-700 bg-lab-950/95 p-1 shadow-xl backdrop-blur"
            >
              {STYLE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={style === id}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStyle(id);
                    setStyleMenuOpen(false);
                  }}
                  className={`whitespace-nowrap rounded-md px-2.5 py-1 text-left text-[10px] font-mono transition-colors ${
                    style === id ? 'bg-phosphor text-lab-950' : 'text-lab-300 hover:bg-lab-800 hover:text-lab-100'
                  }`}
                >
                  {MOLECULE_STYLES[id].label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={styleMenuOpen}
            aria-label={`Molecule style: ${MOLECULE_STYLES[style].label}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setStyleMenuOpen((o) => !o);
            }}
            title="Change molecule style"
            className={`flex max-w-full items-center gap-1 rounded-lg bg-lab-950/85 px-2 py-1.5 font-mono text-[10px] shadow-lg backdrop-blur transition-colors hover:text-phosphor ${
              styleMenuOpen ? 'text-phosphor' : 'text-lab-200'
            }`}
          >
            <Layers size={12} className="shrink-0 text-phosphor" />
            <span className="truncate">{MOLECULE_STYLES[style].label}</span>
            <ChevronUp
              size={12}
              className={`shrink-0 transition-transform duration-200 ${styleMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </div>

        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleSpin}
            title={spinning ? 'Pause rotation' : 'Resume rotation'}
            className="rounded-lg bg-lab-950/85 p-1.5 text-lab-300 shadow-lg backdrop-blur hover:text-phosphor"
          >
            {spinning ? <Pause size={13} /> : <Play size={13} />}
          </button>
          {clickable && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMaximize?.(); }}
              title="Maximize"
              className="rounded-lg bg-lab-950/85 p-1.5 text-lab-300 shadow-lg backdrop-blur hover:text-phosphor"
            >
              <Maximize2 size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={resetView}
            title="Reset view"
            className="rounded-lg bg-lab-950/85 p-1.5 text-lab-300 shadow-lg backdrop-blur hover:text-phosphor"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {enrichedInfo && (
        <div className="absolute top-2 left-2 z-10 rounded-lg border border-lab-700 bg-lab-950/95 px-3 py-2 text-xs text-lab-200 shadow-xl backdrop-blur">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="font-mono font-bold text-phosphor">{enrichedInfo.element}</span>
            <button
              onClick={(e) => { e.stopPropagation(); setClickedAtom(null); }}
              className="text-lab-500 hover:text-lab-200"
            >
              <X size={12} />
            </button>
          </div>
          {enrichedInfo.charge !== undefined && (
            <div className="text-[11px] text-lab-400">
              Charge: <span className="text-lab-200">{enrichedInfo.charge > 0 ? `+${enrichedInfo.charge}` : enrichedInfo.charge}</span>
            </div>
          )}
          {enrichedInfo.lonePairs !== undefined && (
            <div className="text-[11px] text-lab-400">
              Lone pairs: <span className="text-lab-200">{enrichedInfo.lonePairs}</span>
            </div>
          )}
          <div className="text-[11px] text-lab-400">
            xyz: <span className="font-mono text-lab-200">{enrichedInfo.x}, {enrichedInfo.y}, {enrichedInfo.z}</span>
          </div>
        </div>
      )}
    </div>
  );
}