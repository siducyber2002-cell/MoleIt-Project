import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Loader2, FlaskConical } from 'lucide-react';
import { useThreeScene } from './useThreeScene';
import { buildMoleculeGroup, disposeGroup, fitCameraToRadius, parseMolV2000 } from './moleculeMeshBuilder';
import { atomsToMolBlock } from '../../lib/molblock';

const HIGHLIGHT_COLOR = '#f5a524';
const HIGHLIGHT_SCALE = 1.3;
const BOND_COLOR = 0xaaa39a;

// The shared "one live molecule" 3D preview used wherever exactly one
// structure is on screen at a time (GroupFlashcard, NMRPanel, IRPanel,
// QuizPage). Restyled to match the homepage HeroMolecule / ThreeMoleculeViewer
// look — a pale paper card with a drifting wash instead of the old dark
// panel — same atoms/bonds/highlightAtomIds/onAtomHover/onAtomLeave contract.
//
// Two label layers, same split as before:
//  - `highlightAtomIds`/`highlightBondAtomIds` (external, e.g. "this atom
//    belongs to the NMR peak you're hovering") get a persistent amber
//    color + scale-up, restyled without touching the hover/click machinery.
//  - Hovering or clicking an atom directly in the 3D scene shows a
//    floating text label ("H1", "H2", "O" — numbered only when more than
//    one atom of that element exists), independent of whatever the caller
//    is highlighting.
export default function ThreeStructurePreview({
  atoms,
  bonds,
  title = 'Molecule',
  height = 180,
  spin = true,
  highlightAtomIds = null,
  highlightBondAtomIds = null,
  onAtomHover = null,
  onAtomLeave = null,
}) {
  const containerRef = useRef(null);
  const labelsContainerRef = useRef(null);
  const groupRootRef = useRef(null);
  const atomRecordsRef = useRef([]); // [{ mesh, element, index, baseColor }]
  const bondRecordsRef = useRef([]); // [{ mesh, a1, a2 }]
  const pinnedLabelsRef = useRef(new Map()); // atom index -> label <div>
  const hoverLabelRef = useRef(null); // { index, div } | null
  const pointerDownRef = useRef({ x: 0, y: 0, moved: false });

  const molBlock = useMemo(() => (atoms && atoms.length ? atomsToMolBlock(atoms, bonds, title) : ''), [atoms, bonds, title]);
  const parsed = useMemo(() => parseMolV2000(molBlock), [molBlock]);

  // "H1"/"H2"/"O" — numbered only when this element appears more than
  // once in the molecule, same convention the 3Dmol version used.
  const labelTextByIndex = useMemo(() => {
    if (!atoms) return [];
    const counts = {};
    atoms.forEach((a) => (counts[a.element] = (counts[a.element] || 0) + 1));
    const seen = {};
    return atoms.map((a) => {
      seen[a.element] = (seen[a.element] || 0) + 1;
      return counts[a.element] > 1 ? `${a.element}${seen[a.element]}` : a.element;
    });
  }, [atoms]);

  const makeLabelDiv = (index) => {
    const div = document.createElement('div');
    div.className = 'three-structure-label';
    div.textContent = labelTextByIndex[index] || '';
    labelsContainerRef.current?.appendChild(div);
    return div;
  };

  const positionLabel = (div, mesh, cam, w, h) => {
    const ndc = mesh.position.clone().project(cam);
    const x = (ndc.x * 0.5 + 0.5) * w;
    const y = (-ndc.y * 0.5 + 0.5) * h;
    div.style.transform = `translate(${x}px, ${y}px) translate(-50%, -155%)`;
    div.style.opacity = ndc.z > 1 ? '0' : '1';
  };

  // Runs every rendered frame — reprojects whatever labels are currently
  // showing (pinned + hover) into screen space. Deliberately cheap: only
  // touches the handful of labels actually on screen, not every atom.
  const handleFrame = () => {
    const cam = cameraRef.current;
    const container = containerRef.current;
    if (!cam || !container) return;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    pinnedLabelsRef.current.forEach((div, idx) => {
      const rec = atomRecordsRef.current[idx];
      if (rec) positionLabel(div, rec.mesh, cam, w, h);
    });
    if (hoverLabelRef.current) {
      const rec = atomRecordsRef.current[hoverLabelRef.current.index];
      if (rec) positionLabel(hoverLabelRef.current.div, rec.mesh, cam, w, h);
    }
  };

  // background: null + lighting: 'light' keeps this in step with
  // ThreeMoleculeViewer's pale paper-card look everywhere else in the app.
  const { sceneRef, cameraRef, controlsRef, status } = useThreeScene(containerRef, {
    background: null,
    lighting: 'light',
    onFrame: handleFrame,
  });
  const ready = status === 'ready';

  const clearAllLabels = () => {
    pinnedLabelsRef.current.forEach((div) => div.remove());
    pinnedLabelsRef.current.clear();
    if (hoverLabelRef.current) {
      hoverLabelRef.current.div.remove();
      hoverLabelRef.current = null;
    }
  };

  // Effect 1: mount the molecule. Only reruns when the actual structure
  // changes — not on every highlight update (see Effect 2 below).
  useEffect(() => {
    if (!ready || !sceneRef.current || !parsed.atoms.length) return;
    const scene = sceneRef.current;

    if (groupRootRef.current) {
      scene.remove(groupRootRef.current);
      disposeGroup(groupRootRef.current);
    }
    if (labelsContainerRef.current) labelsContainerRef.current.innerHTML = '';
    clearAllLabels();

    const { group, atomRecords, bondRecords } = buildMoleculeGroup({
      atoms: parsed.atoms,
      bonds: parsed.bonds,
      styleId: 'ballstick',
      bondColor: BOND_COLOR,
    });
    scene.add(group);
    groupRootRef.current = group;
    atomRecordsRef.current = atomRecords.map((r) => ({ ...r, baseColor: r.mesh.material.color.getHex() }));
    bondRecordsRef.current = bondRecords.map((r) => ({ ...r, baseColor: r.mesh.material.color.getHex() }));

    const centroid = parsed.atoms.reduce(
      (acc, a) => acc.add(new THREE.Vector3(a.x, a.y, a.z)),
      new THREE.Vector3()
    ).multiplyScalar(1 / parsed.atoms.length);
    const radius = Math.max(1.2, ...parsed.atoms.map((a) => new THREE.Vector3(a.x, a.y, a.z).distanceTo(centroid)));

    if (cameraRef.current && controlsRef.current) {
      fitCameraToRadius(cameraRef.current, controlsRef.current, centroid, radius);
      controlsRef.current.autoRotate = spin;
    }
    // Deliberately excludes `spin`: the initial mount honors whatever it
    // was at that moment, and the effect below handles it changing later
    // (e.g. GroupFlashcard pausing rotation once flipped to its back) —
    // toggling `spin` should never rebuild the whole scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [molBlock, ready]);

  // Reacts to `spin` changing after mount, independent of the scene-build
  // effect above.
  useEffect(() => {
    if (!ready || !controlsRef.current) return;
    controlsRef.current.autoRotate = spin;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin, ready, molBlock]);

  // Effect 2: (re)apply the externally-driven highlight overlay only —
  // leaves camera, spin, and any pinned labels untouched.
  useEffect(() => {
    if (!ready || !atoms) return;
    const highlightIds = new Set(highlightAtomIds || []);
    (highlightBondAtomIds || []).forEach((id) => highlightIds.add(id));

    atomRecordsRef.current.forEach((rec, i) => {
      const hi = highlightIds.has(atoms[i]?.id);
      rec.mesh.material.color.set(hi ? HIGHLIGHT_COLOR : rec.baseColor);
      rec.mesh.scale.setScalar(hi ? HIGHLIGHT_SCALE : 1);
    });
    bondRecordsRef.current.forEach((rec) => {
      const hi = highlightIds.has(atoms[rec.a1]?.id) || highlightIds.has(atoms[rec.a2]?.id);
      rec.mesh.material.color.set(hi ? HIGHLIGHT_COLOR : rec.baseColor);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightAtomIds, highlightBondAtomIds, ready, molBlock, atoms]);

  // Clean up labels on unmount so a stale ref never outlives its viewer.
  useEffect(() => {
    return () => clearAllLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const raycastAtom = (clientX, clientY) => {
    const container = containerRef.current;
    const cam = cameraRef.current;
    if (!container || !cam) return null;
    const rect = container.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, cam);
    const meshes = atomRecordsRef.current.map((r) => r.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].object.userData.atomIndex : null;
  };

  const onPointerDown = (e) => {
    pointerDownRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };

  const onPointerMove = (e) => {
    const d = pointerDownRef.current;
    if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) d.moved = true;

    const idx = raycastAtom(e.clientX, e.clientY);
    if (idx === null) {
      if (hoverLabelRef.current) {
        hoverLabelRef.current.div.remove();
        hoverLabelRef.current = null;
        onAtomLeave?.();
      }
      return;
    }
    if (pinnedLabelsRef.current.has(idx)) return; // already pinned, nothing to add
    if (!hoverLabelRef.current || hoverLabelRef.current.index !== idx) {
      if (hoverLabelRef.current) hoverLabelRef.current.div.remove();
      hoverLabelRef.current = { index: idx, div: makeLabelDiv(idx) };
    }
    const ourAtom = atoms?.[idx];
    if (ourAtom) onAtomHover?.(ourAtom.id);
  };

  const onPointerLeaveContainer = () => {
    if (hoverLabelRef.current) {
      hoverLabelRef.current.div.remove();
      hoverLabelRef.current = null;
    }
    onAtomLeave?.();
  };

  const onPointerUp = (e) => {
    if (pointerDownRef.current.moved) return; // was a drag, not a click
    const idx = raycastAtom(e.clientX, e.clientY);
    if (idx === null) return;
    if (pinnedLabelsRef.current.has(idx)) {
      pinnedLabelsRef.current.get(idx).remove();
      pinnedLabelsRef.current.delete(idx);
    } else {
      const div = hoverLabelRef.current && hoverLabelRef.current.index === idx
        ? hoverLabelRef.current.div
        : makeLabelDiv(idx);
      if (hoverLabelRef.current && hoverLabelRef.current.index === idx) hoverLabelRef.current = null;
      pinnedLabelsRef.current.set(idx, div);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-lab-700 bg-[#fafaf9] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.6)]">
      <style>{`
        .three-structure-label {
          position: absolute; top: 0; left: 0;
          font: 600 10px/1 ui-monospace, "JetBrains Mono", Menlo, monospace;
          color: #262626;
          background: rgba(250,250,249,0.95);
          border: 1px solid #5eead4;
          border-radius: 6px;
          padding: 2px 6px;
          white-space: nowrap;
          pointer-events: none;
          z-index: 10;
        }
        .three-structure-wash {
          position: absolute; inset: -20%; pointer-events: none; z-index: 0;
          background:
            radial-gradient(42% 42% at 68% 30%, rgba(59,191,247,.22), transparent 70%),
            radial-gradient(48% 48% at 24% 78%, rgba(238,160,43,.18), transparent 70%),
            #fafaf9;
          animation: three-structure-drift 46s ease-in-out infinite alternate;
        }
        @keyframes three-structure-drift {
          0% { transform: translate(0, 0) scale(1); }
          100% { transform: translate(-3%, 3%) scale(1.06); }
        }
        @media (prefers-reduced-motion: reduce) {
          .three-structure-wash { animation: none; }
        }
      `}</style>
      <div className="three-structure-wash" />
      <div
        ref={containerRef}
        style={{ height, width: '100%', position: 'relative', zIndex: 1, cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeaveContainer}
      />
      <div ref={labelsContainerRef} className="pointer-events-none absolute inset-0 overflow-hidden z-10" />
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
      {!atoms?.length && status === 'ready' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-[#8a8681]">No structure available</div>
      )}
    </div>
  );
}