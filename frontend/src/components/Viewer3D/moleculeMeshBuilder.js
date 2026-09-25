import * as THREE from 'three';
import { ELEMENTS } from '../../lib/elements';
import { isLowPowerDevice } from '../../lib/perfTier';

// Sphere/cylinder segment counts scale down on phones/tablets: every atom
// and every bond strand gets its own geometry (see buildMoleculeGroup
// below), so for a molecule with dozens of atoms this is the single
// biggest lever on total triangle count. The shapes stay clearly round —
// this only trims segments a mobile screen's pixel density can't resolve
// anyway, never the shape a desktop user sees.
const SPHERE_SEGMENTS = isLowPowerDevice() ? [12, 9] : [24, 18];
const CLOUD_SHELL_SEGMENTS = isLowPowerDevice() ? [12, 10] : [20, 16];
const BOND_RADIAL_SEGMENTS = isLowPowerDevice() ? 8 : 12;

// Shared Three.js molecule builder used by every molecule viewer in the app
// (ThreeMoleculeViewer, MiniThreeMoleculeViewer, ThreeStructurePreview).
// Builds real THREE.Mesh spheres/cylinders (or, for the electron-cloud
// style, layered translucent shells) instead of handing a style object to
// an external engine.

// Fixed-column V2000 reader — matches both lib/molblock.js's output and the
// standard MDL column widths, so this also reads mol blocks fetched from
// PubChem, not just ones this app generated.
export function parseMolV2000(molBlock) {
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

// Per-style sphere/cylinder sizing. Unlike the old version (which scaled
// off ELEMENTS' periodic-table radii — a *different* set of numbers than
// the homepage uses, which is why atoms used to come out roughly half the
// homepage's size), `ballstick` here uses HeroMolecule's exact ATOM_RADIUS
// table with no extra shrink (sphereMul: 1) and its exact bond radius
// (0.085 for a single bond), so the default view is a 1:1 size match with
// the homepage for every compound, not just the one that happened to be
// screenshotted. The other styles keep the *same relative* size ratios
// they always had to `ballstick` (e.g. `stick` was 0.56/0.78 of ballstick's
// sphere and 0.1/0.062 of its bond before — those ratios are preserved
// here against the new, larger ballstick baseline) so switching styles
// still feels like the same proportional family, just rebased onto
// HeroMolecule's numbers instead of the old ones.
export const MOLECULE_STYLES = {
  ballstick: {
    label: 'Ball & Stick', mode: 'solid', sphereMul: 1, bondRadius: 0.085, showBonds: true,
  },
  stick: {
    label: 'Stick', mode: 'solid', sphereMul: 0.718, bondRadius: 0.137, showBonds: true,
  },
  spacefill: {
    label: 'Space-filling', mode: 'solid', sphereMul: 2.756, bondRadius: 0.085, showBonds: false,
  },
  line: {
    label: 'Line', mode: 'solid', sphereMul: 0.192, bondRadius: 0.038, showBonds: true,
  },
  cloud: {
    label: 'Electron Cloud', mode: 'cloud', sphereMul: 0.385, bondRadius: 0.030, showBonds: true,
    // Concentric, decreasingly-opaque shells around each atom's nucleus —
    // a lightweight stand-in for an isosurface electron-density render,
    // giving a soft glowing "cloud" without a raymarched shader.
    shells: [
      { mul: 1.15, opacity: 0.5 },
      { mul: 1.75, opacity: 0.22 },
      { mul: 2.5, opacity: 0.08 },
    ],
  },
};

// Exact match for HeroMolecule's own ATOM_RADIUS table on the homepage
// (same Å-ish values, same 0.45 fallback for anything not listed) — this
// is what makes `ballstick` come out the same physical size as the
// homepage for every element it covers, for any compound.
const ATOM_RADIUS = {
  H: 0.3, C: 0.46, N: 0.43, O: 0.42, F: 0.38, P: 0.5, S: 0.52, Cl: 0.5, Br: 0.55, I: 0.6,
};
export function elemRadius(el) {
  return ATOM_RADIUS[el] ?? 0.45;
}

// ATOM_RADIUS above is sized to look right at the bond length HeroMolecule's
// own hand-placed homepage coordinates use — real mol data (this app's own
// saved molecules, PubChem fetches, etc.) isn't guaranteed to share that
// scale. A crowded, fused-ring compound can come back with a much shorter
// bond length, and at full homepage size the atom spheres swallow the bond
// cylinder between them completely — no visible stick, just overlapping
// balls. This measures the molecule's own median bond length and returns a
// shrink factor so spheres never get bigger, relative to their own bonds,
// than they are on the homepage — capped at 1 so molecules that already
// match the homepage's scale are completely unaffected.
const REFERENCE_BOND_LENGTH = 1.5;
export function moleculeSizeScale(atoms, bonds) {
  if (!bonds || !bonds.length) return 1;
  const lens = [];
  for (const b of bonds) {
    const a1 = atoms[b.a1];
    const a2 = atoms[b.a2];
    if (!a1 || !a2) continue;
    const dx = a1.x - a2.x;
    const dy = a1.y - a2.y;
    const dz = a1.z - a2.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 0.0001) lens.push(d);
  }
  if (!lens.length) return 1;
  lens.sort((x, y) => x - y);
  const median = lens[Math.floor(lens.length / 2)];
  return Math.min(1, Math.max(0.4, median / REFERENCE_BOND_LENGTH));
}

// Exact match for the homepage HeroMolecule's palette (H/C/N/O — the atoms
// that actually appear in this app's compounds). ELEMENTS' CURATED_COLORS
// is a separate, unrelated CPK-ish palette used for the Draw Lab periodic
// table and isn't touched here, so this only overrides what every molecule
// viewer (Library, Compound Detail, My Molecules, Quiz, Draw Lab,
// Functional Groups, NMR/IR previews, and — via this same exported
// function — the Group Theory symmetry viewer) renders atoms with by
// default — deliberately the same near-black C / cyan-blue N / warm-amber
// O / warm off-white H the homepage uses, instead of ELEMENTS' grey C /
// indigo N / red O.
const VIEWER_PALETTE = {
  H: '#cfc9c1',
  C: '#262626',
  N: '#3bbff7',
  O: '#eea02b',
};
export function elemColor(el, colorScheme) {
  if (colorScheme) {
    if (colorScheme[el]) return colorScheme[el];
    if (colorScheme.default) return colorScheme.default;
  }
  if (VIEWER_PALETTE[el]) return VIEWER_PALETTE[el];
  return ELEMENTS[el]?.color || '#94a3b8';
}

// Plain MeshStandardMaterial, deliberately no clearcoat/environment layer —
// see useThreeScene's comment for why: clearcoat + a PMREM environment
// looked glossy in stills but blew out to a washed-out white glare at some
// rotation angles (the environment's bright walls reflecting straight off
// the coat), which is the "fading" the reference screenshots showed.
// roughness/metalness here is an exact match for HeroMolecule's own
// `material()` helper on the homepage, so every viewer reads with the same
// gloss level instead of the atoms looking flatter/duller than the
// homepage's or the bonds looking chalkier (bonds used to sit at a
// different, rougher 0.5/0.06 — now the same material as atoms, again
// matching HeroMolecule, which reuses one material fn for both).
export function makeAtomMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.32,
    metalness: 0.02,
  });
}

export function makeBondMaterial(color = 0x8b95a0) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.32,
    metalness: 0.02,
  });
}

function makeCloudMaterial(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Builds a THREE.Group containing atom + bond meshes (or, in 'cloud' mode,
 *  a nucleus dot plus layered translucent shells per atom), sized per
 *  `styleId`. Returns the group plus parallel atom/bond records so a caller
 *  can raycast, animate, or restyle later without re-parsing the mol block.
 *  `atomRecords` always points at each atom's solid, opaque, raycast-able
 *  mesh (the nucleus dot in cloud mode) so click-to-inspect keeps working
 *  the same way regardless of style. */
export function buildMoleculeGroup({ atoms, bonds, styleId = 'ballstick', colorScheme = null, bondColor = 0x8b95a0 }) {
  const style = MOLECULE_STYLES[styleId] || MOLECULE_STYLES.ballstick;
  const group = new THREE.Group();
  const atomRecords = []; // [{ mesh, element, index, base: Vector3 }]
  const bondRecords = []; // [{ mesh, a1, a2 }]
  const sizeScale = moleculeSizeScale(atoms, bonds);

  atoms.forEach((a, i) => {
    const baseR = elemRadius(a.element) * sizeScale;
    const color = elemColor(a.element, colorScheme);
    const r = Math.max(baseR * style.sphereMul, 0.045);

    const geo = new THREE.SphereGeometry(r, SPHERE_SEGMENTS[0], SPHERE_SEGMENTS[1]);
    const mesh = new THREE.Mesh(geo, makeAtomMaterial(color));
    const base = new THREE.Vector3(a.x, a.y, a.z);
    mesh.position.copy(base);
    mesh.userData.atomIndex = i;
    group.add(mesh);
    atomRecords.push({ mesh, element: a.element, index: i, base });

    if (style.mode === 'cloud') {
      for (const shell of style.shells) {
        const shellGeo = new THREE.SphereGeometry(baseR * shell.mul, CLOUD_SHELL_SEGMENTS[0], CLOUD_SHELL_SEGMENTS[1]);
        const shellMesh = new THREE.Mesh(shellGeo, makeCloudMaterial(color, shell.opacity));
        shellMesh.position.copy(base);
        shellMesh.renderOrder = 1;
        group.add(shellMesh);
      }
    }
  });

  if (style.showBonds) {
    const UP = new THREE.Vector3(0, 1, 0);
    const bondMat = style.mode === 'cloud'
      ? new THREE.MeshBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.35, depthWrite: false })
      : makeBondMaterial(bondColor);
    // How far apart a double/triple bond's parallel strands sit, and how
    // much thinner each strand is than a single bond — exactly
    // HeroMolecule's own numbers (offsets ±0.11 / ±0.17, strand radius
    // 0.055 against a 0.085 single-bond radius), scaled down for the
    // thinner styles (stick/line/cloud) so a double bond in "Line" style
    // isn't drawn homepage-thick.
    const offsetScale = style.bondRadius / MOLECULE_STYLES.ballstick.bondRadius;
    const strandRadiusRatio = 0.055 / 0.085;
    bonds.forEach((b) => {
      const a1 = atoms[b.a1];
      const a2 = atoms[b.a2];
      if (!a1 || !a2) return;
      const p1 = new THREE.Vector3(a1.x, a1.y, a1.z);
      const p2 = new THREE.Vector3(a2.x, a2.y, a2.z);
      const dir = new THREE.Vector3().subVectors(p2, p1);
      const len = Math.max(0.001, dir.length());
      const unitDir = dir.clone().normalize();
      const mid = p1.clone().add(p2).multiplyScalar(0.5);
      const order = b.order > 0 && b.order < 4 ? b.order : 1;

      // Same construction HeroMolecule uses to find an axis perpendicular
      // to the bond to fan double/triple-bond strands out along.
      const ref = Math.abs(unitDir.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const side = new THREE.Vector3().crossVectors(unitDir, ref).normalize();
      const offsets = order === 1 ? [0]
        : order === 2 ? [-0.11 * offsetScale, 0.11 * offsetScale]
        : [-0.17 * offsetScale, 0, 0.17 * offsetScale];
      const strandRadius = order === 1 ? style.bondRadius : style.bondRadius * strandRadiusRatio;

      offsets.forEach((o) => {
        const geo = new THREE.CylinderGeometry(strandRadius, strandRadius, len, BOND_RADIAL_SEGMENTS);
        const mesh = new THREE.Mesh(geo, bondMat);
        mesh.position.copy(mid).addScaledVector(side, o);
        mesh.quaternion.setFromUnitVectors(UP, unitDir);
        group.add(mesh);
        bondRecords.push({ mesh, a1: b.a1, a2: b.a2 });
      });
    });
  }

  return { group, atomRecords, bondRecords };
}

export function disposeGroup(group) {
  group.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
    else child.material?.dispose?.();
  });
}

/** Fits the scene's camera/controls target to frame a molecule of the given
 *  radius, centered at `centroid`. Mirrors what 3Dmol's `zoomTo()` used to
 *  do for us automatically. */
export function fitCameraToRadius(camera, controls, centroid, radius) {
  // The lens is fixed to the *height* of the canvas, so in a tall, narrow canvas (a phone held
  // upright) the molecule used to spill off the sides. Back the camera off in proportion to how
  // narrow the canvas is; wide canvases (aspect >= 1) are unchanged.
  const aspect = camera.aspect > 0 ? camera.aspect : 1;
  const narrowFactor = aspect < 1 ? Math.min(2.5, 1.2 / aspect) : 1;
  // `radius` is the skeleton radius (centroid to farthest atom *center*) —
  // it doesn't know about atom sphere size, so a flat margin is added here
  // to cover the now-homepage-sized ballstick spheres (up to ~0.6) so the
  // outermost atoms' surfaces don't clip past the frame edge.
  const dist = Math.max(2.4, (radius + 0.55) * 2.6 * narrowFactor);
  const dir = new THREE.Vector3(0.35, 0.22, 1).normalize();
  camera.position.copy(centroid.clone().addScaledVector(dir, dist));
  camera.near = Math.max(0.01, dist / 100);
  camera.far = dist * 50 + 50;
  camera.updateProjectionMatrix();
  controls.target.copy(centroid);
  controls.update();
}