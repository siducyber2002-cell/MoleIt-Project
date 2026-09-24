// Renders a small VSEPR shape diagram for each recognized geometry
// mentioned in a compound's `geometry` text. That text isn't a clean
// enum — curated entries are hand-written prose ("Trigonal planar at the
// carboxyl carbon") and computed ones come from real 3D bond-angle
// measurement (see backend/app/pubchem.py's compute_geometry_summary) —
// so recognition works by matching known VSEPR phrases as substrings,
// case-insensitively. A compound can mention more than one shape (e.g. a
// carboxylic acid has both a trigonal planar carbon and, if there's an
// alkyl chain, tetrahedral ones); each recognized shape gets its own
// small diagram. If nothing is recognized, this renders nothing — the
// existing text description still shows on its own, it just goes
// without a bonus icon.
//
// Interactive: hovering (or tapping, or focusing via keyboard) a shape
// previews *why* it has that shape — pulling the backend's per-center
// electron-domain reasoning (`geometryCenters`, from pubchem.py's
// compute_geometry_summary) when it's available for this compound, and
// otherwise falling back to a general VSEPR explanation of that shape
// family so the card is never empty.
//
// A hover-only preview disappears the instant the mouse leaves, which is
// fine for a quick glance but useless if you actually want to sit and
// read the explanation. Each shape also has a small checkbox: checking it
// *pins* that shape's reasoning in the detail panel below, so it stays
// put regardless of the mouse — hovering a different shape still previews
// it temporarily, but moving away reverts to whatever's pinned rather
// than clearing entirely.
//
// The detail panel lives in one fixed place below the row of shapes
// (never a floating/absolutely-positioned popup), and shapes highlight
// with a small border change rather than a large rescale — both on
// purpose, so nothing here ever overlaps or covers neighboring content.

import { useState } from 'react';
import { Check } from 'lucide-react';

const BOND_LEN = 30;
const CENTER = 44;

// Bond angle lists are tuned to look right in a flat 2D diagram, not to
// be literal projections — wedge/dash bonds use the same visual language
// as the Draw Lab canvas itself (see DrawCanvas.jsx's BondLine) for
// consistency: narrow end at the central atom, wide/dashed end away from
// the viewer.
const SHAPES = {
  linear: {
    title: 'Linear',
    angleLabel: '180°',
    bonds: [
      { angle: 0, style: 'plain' },
      { angle: 180, style: 'plain' },
    ],
    reason:
      '2 electron domains around the central atom, both bonding pairs. With nothing else ' +
      'competing for space, they spread as far apart as possible — 180° apart, a straight line.',
  },
  bent: {
    title: 'Bent (angular)',
    angleLabel: '~104–120°',
    bonds: [
      { angle: -55, style: 'plain' },
      { angle: 55, style: 'plain' },
    ],
    reason:
      'The central atom has lone pairs in addition to its 2 bonded atoms. All electron ' +
      "domains repel each other equally, but only the bonded atoms are part of the visible " +
      "shape — so the lone pair(s) push the two bonds together, bending the molecule below " +
      "the angle a straight line would need.",
  },
  trigonalPlanar: {
    title: 'Trigonal planar',
    angleLabel: '120°',
    bonds: [
      { angle: -90, style: 'plain' },
      { angle: 30, style: 'plain' },
      { angle: 150, style: 'plain' },
    ],
    reason:
      '3 electron domains, all bonding pairs and no lone pairs on the central atom. They ' +
      'spread out evenly in a flat plane at 120° apart to minimize repulsion between them.',
  },
  trigonalPyramidal: {
    title: 'Trigonal pyramidal',
    angleLabel: '~107°',
    bonds: [
      { angle: -90, style: 'wedge' },
      { angle: 30, style: 'plain' },
      { angle: 150, style: 'plain' },
    ],
    reason:
      '4 electron domains total — 3 bonding pairs and 1 lone pair. The 4 domains still ' +
      'arrange like a tetrahedron, but since the lone pair is invisible in the molecular ' +
      'shape, the 3 bonded atoms end up pushed into a pyramid rather than a flat triangle.',
  },
  tetrahedral: {
    title: 'Tetrahedral',
    angleLabel: '109.5°',
    bonds: [
      { angle: 60, style: 'wedge' },
      { angle: 120, style: 'dash' },
      { angle: 240, style: 'plain' },
      { angle: 300, style: 'plain' },
    ],
    reason:
      '4 electron domains, all bonding pairs and no lone pairs. Four domains with nothing ' +
      'else to account for spread into the corners of a tetrahedron — the arrangement that ' +
      'keeps all four as far apart as possible, giving the classic 109.5° bond angle.',
  },
  trigonalBipyramidal: {
    title: 'Trigonal bipyramidal',
    angleLabel: '90° / 120°',
    bonds: [
      { angle: 90, style: 'wedge' },
      { angle: 270, style: 'dash' },
      { angle: 0, style: 'plain' },
      { angle: 120, style: 'plain' },
      { angle: 240, style: 'plain' },
    ],
    reason:
      '5 electron domains, all bonding pairs. This is the one arrangement that lets 5 ' +
      'domains minimize repulsion: 3 in an equatorial plane at 120° apart, plus 2 axial ' +
      'ones at 90° to that plane.',
  },
  seeSaw: {
    title: 'See-saw',
    angleLabel: '~90° / ~120° / ~175°',
    bonds: [
      { angle: 90, style: 'wedge' },
      { angle: 270, style: 'dash' },
      { angle: 20, style: 'plain' },
      { angle: 200, style: 'plain' },
    ],
    reason:
      '5 electron domains — 4 bonding pairs and 1 lone pair. The lone pair takes the ' +
      'equatorial position (it repels less there than axial), leaving the 4 bonded atoms ' +
      'distorted into a see-saw shape.',
  },
  tShaped: {
    title: 'T-shaped',
    angleLabel: '~90°',
    bonds: [
      { angle: 0, style: 'plain' },
      { angle: 90, style: 'wedge' },
      { angle: 180, style: 'plain' },
    ],
    reason:
      '5 electron domains — 3 bonding pairs and 2 lone pairs. Both lone pairs occupy ' +
      'equatorial positions to minimize repulsion, leaving the 3 bonded atoms in a T.',
  },
  squarePlanar: {
    title: 'Square planar',
    angleLabel: '90°',
    bonds: [
      { angle: 0, style: 'plain' },
      { angle: 90, style: 'plain' },
      { angle: 180, style: 'plain' },
      { angle: 270, style: 'plain' },
    ],
    reason:
      '6 electron domains — 4 bonding pairs and 2 lone pairs. The lone pairs sit opposite ' +
      'each other on the axial positions, leaving the 4 bonded atoms flat in a plane.',
  },
  squarePyramidal: {
    title: 'Square pyramidal',
    angleLabel: '~90°',
    bonds: [
      { angle: 90, style: 'wedge' },
      { angle: 0, style: 'plain' },
      { angle: 135, style: 'plain' },
      { angle: 225, style: 'plain' },
      { angle: 315, style: 'plain' },
    ],
    reason:
      '6 electron domains — 5 bonding pairs and 1 lone pair. The single lone pair pushes ' +
      'the 5 bonded atoms down away from it, into a square pyramid.',
  },
  octahedral: {
    title: 'Octahedral',
    angleLabel: '90°',
    bonds: [
      { angle: 90, style: 'wedge' },
      { angle: 270, style: 'dash' },
      { angle: 45, style: 'plain' },
      { angle: 135, style: 'plain' },
      { angle: 225, style: 'plain' },
      { angle: 315, style: 'plain' },
    ],
    reason:
      '6 electron domains, all bonding pairs and no lone pairs. Six domains spread into ' +
      'the corners of an octahedron — the arrangement that keeps all six as far apart as ' +
      'possible, giving clean 90° angles everywhere.',
  },
};

// Checked longest/most-specific phrase first purely for readability and
// defensiveness — in practice none of these phrases are substrings of
// each other, so order doesn't change the result.
const SHAPE_KEYWORDS = [
  ['trigonalBipyramidal', 'trigonal bipyramidal'],
  ['squarePyramidal', 'square pyramidal'],
  ['squarePlanar', 'square planar'],
  ['trigonalPyramidal', 'trigonal pyramidal'],
  ['trigonalPlanar', 'trigonal planar'],
  ['tShaped', 't-shaped'],
  ['seeSaw', 'see-saw'],
  ['octahedral', 'octahedral'],
  ['tetrahedral', 'tetrahedral'],
  ['linear', 'linear'],
  ['bent', 'bent'],
];

const NOT_MOLECULAR_PHRASES = ['not molecular', 'crystal lattice', 'rock-salt', 'not a discrete molecule'];

export function detectShapes(geometryText) {
  if (!geometryText) return { shapes: [], notMolecular: false };
  const lower = geometryText.toLowerCase();
  if (NOT_MOLECULAR_PHRASES.some((p) => lower.includes(p))) {
    return { shapes: [], notMolecular: true };
  }
  const found = [];
  SHAPE_KEYWORDS.forEach(([key, phrase]) => {
    if (lower.includes(phrase) && !found.includes(key)) found.push(key);
  });
  return { shapes: found, notMolecular: false };
}

// Matches a backend `geometryCenters` entry (real per-atom data computed
// from this exact compound's 3D structure — see pubchem.py) to a
// recognized shape key, by comparing its geometry name the same
// case-insensitive way detectShapes does. Several centers can share a
// shape (e.g. four equivalent sp3 carbons); when they do, they're
// combined into one card since they all have the same reason.
function matchCenters(shapeKey, geometryCenters) {
  if (!geometryCenters || geometryCenters.length === 0) return [];
  const title = SHAPES[shapeKey]?.title?.toLowerCase();
  if (!title) return [];
  const bareTitle = title.replace(/\s*\(.*\)/, ''); // "Bent (angular)" -> "bent"
  return geometryCenters.filter((c) => {
    const g = (c.geometry || '').toLowerCase();
    return g === bareTitle || title.includes(g) || g.includes(bareTitle);
  });
}

function shapeDetail(shapeKey, centers) {
  const shape = SHAPES[shapeKey];
  if (!shape) return null;
  const reasonLines = centers.length > 0 ? centers.map((c) => c.reason).filter(Boolean) : [shape.reason];
  const elementSummary =
    centers.length > 0 ? centers.map((c) => (c.count > 1 ? `${c.element} × ${c.count}` : c.element)).join(', ') : null;
  return { shape, reasonLines, elementSummary };
}

function ShapeIcon({ shapeKey, previewing, pinned, onHoverStart, onHoverEnd, onTogglePin }) {
  const shape = SHAPES[shapeKey];
  if (!shape) return null;
  const rad = (deg) => (deg * Math.PI) / 180;
  const point = (angle, len) => ({
    x: CENTER + len * Math.cos(rad(angle)),
    y: CENTER - len * Math.sin(rad(angle)),
  });

  const highlighted = previewing || pinned;

  return (
    <button
      type="button"
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      onFocus={onHoverStart}
      onBlur={onHoverEnd}
      onClick={onTogglePin}
      aria-pressed={pinned}
      aria-label={`${shape.title} — ${pinned ? 'pinned, click to unpin' : 'click to pin its explanation below'}`}
      className={`group relative flex w-[104px] flex-col items-center gap-1 rounded-lg border bg-lab-900 p-2.5 pt-2 text-center outline-none transition-colors duration-150 ${
        pinned
          ? 'border-phosphor/70 bg-phosphor/5'
          : highlighted
          ? 'border-phosphor/40'
          : 'border-lab-700 hover:border-lab-500'
      }`}
    >
      {/* The checkbox — checking it pins this shape's reasoning in the
          panel below, so it survives the mouse moving away. */}
      <span
        className={`absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded border transition-colors ${
          pinned ? 'border-phosphor bg-phosphor text-lab-950' : 'border-lab-600 text-transparent group-hover:border-lab-400'
        }`}
      >
        <Check size={11} strokeWidth={3} />
      </span>

      <svg viewBox="0 0 88 88" width={72} height={72}>
        {shape.bonds.map((b, i) => {
          const p = point(b.angle, BOND_LEN);
          const perpAngle = b.angle + 90;
          const ux = Math.cos(rad(perpAngle));
          const uy = -Math.sin(rad(perpAngle));

          if (b.style === 'wedge') {
            const wide = 5;
            const pts = `${CENTER},${CENTER} ${p.x + ux * wide},${p.y + uy * wide} ${p.x - ux * wide},${p.y - uy * wide}`;
            return <polygon key={i} points={pts} fill="var(--color-phosphor)" opacity={0.9} />;
          }
          if (b.style === 'dash') {
            const segs = [];
            for (let t = 0.25; t <= 1; t += 0.2) {
              const w = 1 + 4 * t;
              const sx = CENTER + (p.x - CENTER) * t;
              const sy = CENTER + (p.y - CENTER) * t;
              segs.push(
                <line key={t} x1={sx + ux * w} y1={sy + uy * w} x2={sx - ux * w} y2={sy - uy * w} stroke="var(--color-lab-300)" strokeWidth={1.3} />
              );
            }
            return <g key={i}>{segs}</g>;
          }
          return <line key={i} x1={CENTER} y1={CENTER} x2={p.x} y2={p.y} stroke="var(--color-lab-300)" strokeWidth={1.6} />;
        })}
        {shape.bonds.map((b, i) => {
          const p = point(b.angle, BOND_LEN);
          return <circle key={i} cx={p.x} cy={p.y} r={4.5} fill="#0f1518" stroke="var(--color-lab-400)" strokeWidth={1.4} />;
        })}
        <circle cx={CENTER} cy={CENTER} r={6} fill="#0f1518" stroke="var(--color-phosphor)" strokeWidth={1.8} />
      </svg>
      <div>
        <div className="text-[11px] font-medium text-lab-200">{shape.title}</div>
        <div className="text-[10px] text-lab-500">{shape.angleLabel}</div>
      </div>
    </button>
  );
}

/** Renders one small, interactive diagram per recognized VSEPR shape
 *  mentioned in `geometryText` — hover, tap, or keyboard-focus a shape to
 *  zoom it in and reveal why the central atom has that geometry. Renders
 *  nothing if none are recognized or the compound isn't a discrete
 *  molecule (an ionic lattice like NaCl) — callers should still show the
 *  raw text description regardless.
 *
 *  `geometryCenters`, when provided (PubChem-fetched compounds carry this
 *  — see backend/app/pubchem.py's compute_geometry_summary), supplies
 *  real per-atom reasoning specific to this exact compound; without it,
 *  each shape falls back to a general VSEPR explanation. */
export default function MolecularShapeDiagram({ geometryText, geometryCenters }) {
  const { shapes, notMolecular } = detectShapes(geometryText);
  const [pinned, setPinned] = useState(null); // set by clicking a shape's checkbox — persists past hover
  const [preview, setPreview] = useState(null); // set by hover/focus — wins while active, reverts to `pinned` on leave

  if (notMolecular) {
    return (
      <div className="rounded-lg border border-lab-700 bg-lab-900 p-3.5 text-[11px] leading-relaxed text-lab-500">
        This isn't a discrete molecule with a single VSEPR shape — it forms an extended ionic lattice instead
        (see the description above).
      </div>
    );
  }

  if (shapes.length === 0) return null;

  const displayedKey = preview || pinned;
  const displayed = displayedKey ? shapeDetail(displayedKey, matchCenters(displayedKey, geometryCenters)) : null;

  return (
    <div>
      <div className="flex flex-wrap gap-2.5">
        {shapes.map((key) => (
          <ShapeIcon
            key={key}
            shapeKey={key}
            previewing={preview === key}
            pinned={pinned === key}
            onHoverStart={() => setPreview(key)}
            onHoverEnd={() => setPreview((p) => (p === key ? null : p))}
            onTogglePin={() => setPinned((cur) => (cur === key ? null : key))}
          />
        ))}
      </div>

      <div className="mt-3 min-h-[72px] rounded-lg border border-lab-700 bg-lab-900/60 p-3.5">
        {displayed ? (
          <>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-phosphor">Why {displayed.shape.title.toLowerCase()}?</span>
              <div className="flex items-center gap-1.5">
                {displayed.elementSummary && (
                  <span className="rounded-full border border-lab-700 px-1.5 py-0.5 font-mono text-[9px] text-lab-400">
                    {displayed.elementSummary}
                  </span>
                )}
                {pinned === displayedKey && (
                  <span className="rounded-full border border-phosphor/40 bg-phosphor/10 px-1.5 py-0.5 text-[9px] font-medium text-phosphor">
                    Pinned
                  </span>
                )}
              </div>
            </div>
            {displayed.reasonLines.map((line, i) => (
              <p key={i} className="text-[11px] leading-relaxed text-lab-300">
                {line}
              </p>
            ))}
          </>
        ) : (
          <p className="text-[11px] leading-relaxed text-lab-500">
            Hover a shape to preview why it forms that way, or check its box to pin the explanation here.
          </p>
        )}
      </div>
    </div>
  );
}