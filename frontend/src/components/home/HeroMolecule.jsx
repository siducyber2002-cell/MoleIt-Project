import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * The slowly-turning molecule on the homepage.
 *
 * Fully independent on purpose: it depends on `three` and nothing else in the
 * app — not the shared ThreeMoleculeViewer, not moleculeMeshBuilder, not
 * useThreeScene. So changes to the lab's 3D viewer (dark theme, style picker,
 * maximize modal…) can never leak onto the homepage, and this file can be
 * restyled without touching any other page.
 *
 * Light-theme look: transparent WebGL canvas over a soft paper card with a
 * slow blue/orange wash. Ball-and-stick only, no toolbar. The mouse wheel is
 * NOT captured (no zoom) so scrolling the page over the molecule still works,
 * and on touch screens vertical swipes scroll the page while horizontal drags
 * rotate the molecule.
 */

const DEFAULT_PALETTE = {
  C: '#262626',
  N: '#3bbff7',
  O: '#eea02b',
  H: '#cfc9c1',
  default: '#8a8681',
};

// Sphere radii in Å (roughly 0.28 × van der Waals — a clear ball-and-stick look).
const ATOM_RADIUS = { H: 0.3, C: 0.46, N: 0.43, O: 0.42, F: 0.38, P: 0.5, S: 0.52, Cl: 0.5, Br: 0.55, I: 0.6 };
const BOND_COLOR = '#aaa39a';

// Cheap, local phone/tablet check — kept inline rather than imported so this
// component stays fully independent (see file comment above). Trims MSAA,
// pixel ratio and sphere/cylinder segment counts on touch-primary devices,
// which is where "smooth on desktop, laggy on Android" actually showed up.
const IS_LOW_POWER =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(pointer: coarse)').matches ||
      (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4)
    : false;

// ---- tiny MDL V2000 mol-block reader ---------------------------------------
function parseMolBlock(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let ci = lines.findIndex((l) => /V2000/.test(l));
  if (ci < 0) ci = 3;
  const counts = lines[ci] || '';
  const na = parseInt(counts.slice(0, 3), 10) || 0;
  const nb = parseInt(counts.slice(3, 6), 10) || 0;

  const atoms = [];
  for (let i = 0; i < na; i += 1) {
    const p = (lines[ci + 1 + i] || '').trim().split(/\s+/);
    const x = parseFloat(p[0]);
    const y = parseFloat(p[1]);
    const z = parseFloat(p[2]);
    if ([x, y, z].some(Number.isNaN)) continue;
    atoms.push({ x, y, z, el: p[3] || 'C' });
  }
  const bonds = [];
  for (let j = 0; j < nb; j += 1) {
    const l = lines[ci + 1 + na + j] || '';
    let a = parseInt(l.slice(0, 3), 10);
    let b = parseInt(l.slice(3, 6), 10);
    let order = parseInt(l.slice(6, 9), 10);
    if ([a, b].some(Number.isNaN)) {
      const p = l.trim().split(/\s+/).map((n) => parseInt(n, 10));
      [a, b, order] = p;
    }
    if (a && b && a <= atoms.length && b <= atoms.length) bonds.push({ a: a - 1, b: b - 1, order: order > 0 && order < 4 ? order : 1 });
  }
  return { atoms, bonds };
}

const CSS = `
  .hero-mol { position: relative; overflow: hidden; background: #fafaf9; border-radius: var(--ix-radius, 24px); }
  .hero-mol__wash {
    position: absolute; inset: -20%; z-index: 0; pointer-events: none;
    background:
      radial-gradient(42% 42% at 68% 30%, rgba(59,191,247,.22), transparent 70%),
      radial-gradient(48% 48% at 24% 78%, rgba(238,160,43,.18), transparent 70%),
      #fafaf9;
    animation: hero-mol-drift 46s ease-in-out infinite alternate;
  }
  @keyframes hero-mol-drift {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(-3%, 3%) scale(1.06); }
  }
  .hero-mol__stage { position: relative; z-index: 1; width: 100%; cursor: grab; }
  .hero-mol__stage:active { cursor: grabbing; }
  .hero-mol__stage canvas { display: block; width: 100%; height: 100%; }
  .hero-mol__hint {
    position: absolute; left: 14px; bottom: 14px; z-index: 2; pointer-events: none;
    padding: 7px 12px; border-radius: 999px; background: rgba(240,237,234,.92);
    color: #8a8681; font: 600 11px/1 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
    letter-spacing: .06em; text-transform: uppercase;
    transition: opacity .4s ease;
  }
  .hero-mol__fallback {
    position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; padding: 24px; text-align: center;
    color: #4e4e4d; font: 500 13px/1.5 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
  }
  @media (prefers-reduced-motion: reduce) { .hero-mol__wash { animation: none; } }
`;

export default function HeroMolecule({
  molBlock,
  name = 'molecule',
  height = 'clamp(300px, 36vw, 500px)',
  palette,
  className = '',
}) {
  const stageRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | failed
  const [touched, setTouched] = useState(false);
  const paletteKey = JSON.stringify({ ...DEFAULT_PALETTE, ...palette });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;

    const colors = JSON.parse(paletteKey);
    const { atoms, bonds } = parseMolBlock(molBlock);
    if (!atoms.length) {
      setStatus('failed');
      return undefined;
    }

    // ---- renderer ---------------------------------------------------------
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: !IS_LOW_POWER, alpha: true, powerPreference: 'high-performance' });
    } catch {
      setStatus('failed');
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_LOW_POWER ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    stage.appendChild(renderer.domElement);
    // vertical swipes scroll the page; horizontal drags rotate the molecule
    renderer.domElement.style.touchAction = 'pan-y';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);

    // lighting: soft key + cool fill + warm rim, so charcoal atoms still get highlights
    scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    scene.add(new THREE.HemisphereLight(0xffffff, 0xe6dfd4, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(4, 6, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xcfeaff, 0.9);
    fill.position.set(-5, -1, 3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffe6c2, 1.1);
    rim.position.set(-2, 4, -6);
    scene.add(rim);

    // ---- molecule ---------------------------------------------------------
    const centroid = atoms
      .reduce((acc, a) => acc.add(new THREE.Vector3(a.x, a.y, a.z)), new THREE.Vector3())
      .multiplyScalar(1 / atoms.length);

    const group = new THREE.Group();
    scene.add(group);

    const sphereGeo = IS_LOW_POWER ? new THREE.SphereGeometry(1, 16, 12) : new THREE.SphereGeometry(1, 40, 28);
    const cylGeo = IS_LOW_POWER ? new THREE.CylinderGeometry(1, 1, 1, 10, 1) : new THREE.CylinderGeometry(1, 1, 1, 20, 1);
    const materials = new Map();
    const material = (hex) => {
      if (!materials.has(hex)) {
        materials.set(hex, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.32, metalness: 0.02 }));
      }
      return materials.get(hex);
    };

    const positions = atoms.map((a) => new THREE.Vector3(a.x, a.y, a.z).sub(centroid));
    let reach = 1.5;

    atoms.forEach((a, i) => {
      const r = ATOM_RADIUS[a.el] ?? 0.45;
      const mesh = new THREE.Mesh(sphereGeo, material(colors[a.el] || colors.default));
      mesh.position.copy(positions[i]);
      mesh.scale.setScalar(r);
      group.add(mesh);
      reach = Math.max(reach, positions[i].length() + r);
    });

    const up = new THREE.Vector3(0, 1, 0);
    bonds.forEach(({ a, b, order }) => {
      const pa = positions[a];
      const pb = positions[b];
      const dir = pb.clone().sub(pa);
      const len = dir.length();
      if (len < 1e-4) return;
      dir.normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      const ref = Math.abs(dir.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const side = new THREE.Vector3().crossVectors(dir, ref).normalize();
      const offsets = order === 1 ? [0] : order === 2 ? [-0.11, 0.11] : [-0.17, 0, 0.17];
      const radius = order === 1 ? 0.085 : 0.055;
      offsets.forEach((o) => {
        const cyl = new THREE.Mesh(cylGeo, material(BOND_COLOR));
        cyl.position.copy(mid).addScaledVector(side, o);
        cyl.quaternion.copy(quat);
        cyl.scale.set(radius, len, radius);
        group.add(cyl);
      });
    });

    // a small tilt so the very first frame already reads as 3D
    group.rotation.set(0.35, 0.5, 0);

    // ---- sizing / camera fit ---------------------------------------------
    const fit = () => {
      const w = Math.max(1, stage.clientWidth);
      const h = Math.max(1, stage.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
      const distV = reach / Math.sin(vHalf);
      const distH = reach / (Math.sin(vHalf) * Math.min(1, camera.aspect));
      // tangent-fit the molecule's bounding sphere (no extra padding — the card itself is the margin)
      const dist = Math.max(distV, distH) * 0.92;
      // look from ~27° above so flat molecules (benzene, aspirin…) are never seen fully edge-on
      const dir = camera.position.lengthSq() ? camera.position.clone().normalize() : new THREE.Vector3(0, 0.5, 1).normalize();
      camera.position.copy(dir.multiplyScalar(dist));
      camera.near = dist / 20;
      camera.far = dist * 4;
      camera.updateProjectionMatrix();
    };

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false; // never swallow the page's scroll wheel
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.9;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotate = !reduceMotion;
    controls.autoRotateSpeed = 1.6;
    controls.addEventListener('start', () => setTouched(true));
    fit();
    controls.update();

    // ---- render loop: only while on screen and the tab is visible ----------
    let raf = 0;
    let onScreen = true;
    let disposed = false;
    const frame = () => {
      raf = 0;
      if (disposed || !onScreen || document.hidden) return;
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (!raf && !disposed) raf = requestAnimationFrame(frame);
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        if (onScreen) start();
      },
      { threshold: 0 }
    );
    io.observe(stage);
    const ro = new ResizeObserver(() => {
      fit();
      renderer.render(scene, camera);
    });
    ro.observe(stage);
    const onVisibility = () => {
      if (!document.hidden) start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    setStatus('ready');
    start();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      controls.dispose();
      sphereGeo.dispose();
      cylGeo.dispose();
      materials.forEach((m) => m.dispose());
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    };
  }, [molBlock, paletteKey]);

  return (
    <div className={`hero-mol ${className}`} role="img" aria-label={`Interactive 3D model of ${name}`}>
      <style>{CSS}</style>
      <div className="hero-mol__wash" aria-hidden="true" />
      <div ref={stageRef} className="hero-mol__stage" style={{ height }} />
      {status === 'ready' && !touched && <span className="hero-mol__hint">Drag to rotate</span>}
      {status === 'failed' && (
        <div className="hero-mol__fallback">
          Couldn&apos;t start the 3D view — your browser or device may not support WebGL.
        </div>
      )}
    </div>
  );
}