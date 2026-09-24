// Builds a MOL (V2000) block straight from the {el,x,y,z} atoms and
// [i,j] bonds the /api/symmetry endpoints return. Unlike lib/molblock.js
// (which reconstructs a fake z from wedge/dash bonds for the 2D Draw Lab
// canvas), these coordinates are already real 3-D — this just formats
// them, so it can hand the result straight to the existing
// Molecule3DViewer / ThreeMoleculeViewer the rest of the app already uses.

export function symmetryAtomsToMolBlock(atoms, bonds, title = 'Structure') {
  const atomLines = atoms.map(
    (a) => `${pad(a.x.toFixed(4), 10)}${pad(a.y.toFixed(4), 10)}${pad(a.z.toFixed(4), 10)} ${a.el.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`
  );
  const bondLines = bonds.map(([a, b]) => `${pad3(a + 1)}${pad3(b + 1)}  1  0  0  0  0`);
  const header = `${title}\n  MoleIt Group Theory\n\n${pad3(atoms.length)}${pad3(bonds.length)}  0  0  0  0  0  0  0  0999 V2000`;
  return [header, ...atomLines, ...bondLines, 'M  END'].join('\n');
}

function pad(str, len) {
  const s = String(str);
  return ' '.repeat(Math.max(0, len - s.length)) + s;
}
function pad3(n) {
  return pad(n, 3);
}