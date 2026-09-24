// Builds a MOL block from our internal atoms/bonds shape so it can be handed
// to 3Dmol.js for a rotatable view.
//
// Z-coordinates: most atoms sit flat at z=0 (an honest "starting geometry,"
// not a real conformer), BUT any atom on the far end of a wedge or dash bond
// gets pushed toward (+z) or away from (-z) the viewer. Without this, wedge
// and dash notation — which exists specifically to show what's in front of
// or behind the plane — would be visually meaningless in the 3D view, since
// everything would sit on the same flat plane regardless of how it was drawn.

const WEDGE_DASH_Z_OFFSET = 1.4; // angstrom-ish units per wedge/dash bond

export function atomsToMolBlock(atoms, bonds, title = 'Molecule') {
  const idIndex = {};
  atoms.forEach((a, i) => (idIndex[a.id] = i + 1));

  const zOffsets = {};
  bonds.forEach((b) => {
    const style = b.style || (b.aromatic ? 'aromatic' : 'none');
    if (style === 'wedge') {
      zOffsets[b.to] = (zOffsets[b.to] || 0) + WEDGE_DASH_Z_OFFSET;
    } else if (style === 'dash') {
      zOffsets[b.to] = (zOffsets[b.to] || 0) - WEDGE_DASH_Z_OFFSET;
    }
  });

  const scale = 0.02;
  const atomLines = atoms.map((a) => {
    const x = (a.x * scale).toFixed(4);
    const y = (-a.y * scale).toFixed(4);
    const z = (zOffsets[a.id] || 0).toFixed(4);
    return `${pad(x, 10)}${pad(y, 10)}${pad(z, 10)} ${a.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
  });

  const bondLines = bonds.map((b) => {
    const a1 = idIndex[b.from];
    const a2 = idIndex[b.to];
    const style = b.style || (b.aromatic ? 'aromatic' : 'none');
    // V2000's bond-order field has a dedicated value (4) for aromatic —
    // writing an aromatic ring's numeric order (usually 1) instead would
    // silently encode a benzene ring as if it had plain single bonds.
    const order = style === 'aromatic' ? 4 : Math.min(Math.max(b.order || 1, 1), 3);
    return `${pad3(a1)}${pad3(a2)}${pad3(order)}  0  0  0  0`;
  });

  const header = `${title}\n  MoleIt 3D\n\n${pad3(atoms.length)}${pad3(bonds.length)}  0  0  0  0  0  0  0  0999 V2000`;
  return [header, ...atomLines, ...bondLines, 'M  END'].join('\n');
}

function pad(str, len) {
  const s = String(str);
  return ' '.repeat(Math.max(0, len - s.length)) + s;
}
function pad3(n) {
  return pad(n, 3);
}