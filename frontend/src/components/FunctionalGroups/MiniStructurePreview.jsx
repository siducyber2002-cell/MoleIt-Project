import { useMemo } from 'react';
import { elementInfo } from '../../lib/elements';

// FIX: previously the viewBox was tightly fit to each molecule's own
// bounding box (min/max of its atoms + fixed padding). Since the <svg> is
// always rendered at the same pixel size (width: 100%, height: 140), the
// browser then stretches that per-molecule box to fill the same pixel
// space — so every molecule got a DIFFERENT scale: small groups (small
// coordinate spread) were blown up, big groups (large coordinate spread)
// were shrunk down.
//
// The fix is to use one FIXED viewBox size (in the same coordinate units
// as the atom.x / atom.y data coming from Supabase) for every card, and
// just re-center that fixed frame on each molecule's bounding-box center.
// That keeps "coordinate units per pixel" identical across every card, so
// a structure that's twice as wide in the database renders twice as wide
// on screen — true relative sizing instead of independent auto-fit.
//
// If a particular molecule is larger than the fixed frame, pass a bigger
// frameWidth/frameHeight for that context (e.g. a larger Draw Lab preview)
// rather than letting each card silently re-scale itself.
// These are only a fallback for when no atoms are loaded yet, or when this
// component is used somewhere that doesn't compute a shared frame (e.g. a
// standalone preview). FunctionalGroupsPage computes the REAL frame size
// from the actual data (see computeFrameSize there) and passes it down via
// frameWidth/frameHeight, so it's always big enough to fit every molecule
// in the set without clipping — see the "Orthoester was cropped" fix.
const DEFAULT_FRAME_WIDTH = 260;
const DEFAULT_FRAME_HEIGHT = 160;

export default function MiniStructurePreview({
  atoms,
  bonds,
  // '100%' by default so the SVG fills whatever height its parent container
  // actually has (e.g. a flex-1 box in a fixed-height card). Pass an
  // explicit pixel number only when the parent is NOT sized by flex/CSS —
  // a fixed pixel height here previously left dead space below the SVG
  // whenever the container ended up taller than that fixed number.
  height = '100%',
  frameWidth = DEFAULT_FRAME_WIDTH,
  frameHeight = DEFAULT_FRAME_HEIGHT,
  highlightBondId = null,
  highlightAtomIds = null,
  onAtomHover = null,
  onAtomLeave = null,
  // Opt-in palette swap for light-canvas contexts (e.g. the redesigned
  // Functional Groups tab). Defaults to false so every other caller of
  // this shared component (Library, Quiz, Notes, Reactions — all still
  // dark surfaces) keeps its original dark-panel rendering untouched.
  light = false,
}) {
  const { viewBox } = useMemo(() => {
    if (!atoms.length) return { viewBox: `${-frameWidth / 2} ${-frameHeight / 2} ${frameWidth} ${frameHeight}` };
    const xs = atoms.map((a) => a.x);
    const ys = atoms.map((a) => a.y);
    // Center the fixed-size frame on this molecule's bounding-box center —
    // this only repositions the frame, it never rescales it, so scale
    // stays identical across every card.
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const minX = centerX - frameWidth / 2;
    const minY = centerY - frameHeight / 2;
    return { viewBox: `${minX} ${minY} ${frameWidth} ${frameHeight}` };
  }, [atoms, frameWidth, frameHeight]);

  return (
    <svg
      viewBox={viewBox}
      style={{ height, width: '100%' }}
      className={`rounded-lg ${light ? '' : 'bg-lab-900/60'}`}
    >
      {bonds.map((bond) => {
        const from = atoms.find((a) => a.id === bond.from);
        const to = atoms.find((a) => a.id === bond.to);
        if (!from || !to) return null;
        return (
          <MiniBond
            key={bond.id}
            from={from}
            to={to}
            order={bond.order}
            light={light}
            highlighted={
              highlightBondId === bond.id || Boolean(highlightAtomIds && highlightAtomIds.has(from.id) && highlightAtomIds.has(to.id))
            }
          />
        );
      })}
      {atoms.map((atom) => (
        <MiniAtom
          key={atom.id}
          atom={atom}
          light={light}
          highlighted={Boolean(highlightAtomIds && highlightAtomIds.has(atom.id))}
          onAtomHover={onAtomHover}
          onAtomLeave={onAtomLeave}
        />
      ))}
    </svg>
  );
}

function MiniBond({ from, to, order, highlighted, light }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = -dy / len;
  const uy = dx / len;
  const gap = 3.5;

  const lines = [[from.x, from.y, to.x, to.y]];
  if (order === 2) {
    lines[0] = [from.x + ux * gap, from.y + uy * gap, to.x + ux * gap, to.y + uy * gap];
    lines.push([from.x - ux * gap, from.y - uy * gap, to.x - ux * gap, to.y - uy * gap]);
  } else if (order === 3) {
    lines.push([from.x + ux * gap * 1.6, from.y + uy * gap * 1.6, to.x + ux * gap * 1.6, to.y + uy * gap * 1.6]);
    lines.push([from.x - ux * gap * 1.6, from.y - uy * gap * 1.6, to.x - ux * gap * 1.6, to.y - uy * gap * 1.6]);
  }

  return (
    <>
      {highlighted && (
        <line
          x1={from.x} y1={from.y} x2={to.x} y2={to.y}
          stroke="var(--color-amber)" strokeWidth={9} strokeLinecap="round" opacity={0.35}
        />
      )}
      {lines.map((l, i) => (
        <line
          key={i}
          x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]}
          stroke={highlighted ? 'var(--color-amber)' : light ? '#94a3b8' : '#c7d0d3'}
          strokeWidth={2}
          strokeLinecap="round"
        />
      ))}
    </>
  );
}

function MiniAtom({ atom, highlighted = false, onAtomHover = null, onAtomLeave = null, light = false }) {
  const info = elementInfo(atom.element);
  const radius = atom.element === 'R' ? 13 : info.radius;
  const color = atom.element === 'R' ? '#94a3b8' : info.color;
  const charge = atom.charge || 0;
  const interactive = Boolean(onAtomHover || onAtomLeave);

  return (
    <g
      transform={`translate(${atom.x}, ${atom.y})`}
      onMouseEnter={interactive ? () => onAtomHover && onAtomHover(atom.id) : undefined}
      onMouseLeave={interactive ? () => onAtomLeave && onAtomLeave() : undefined}
      style={interactive ? { cursor: 'pointer' } : undefined}
    >
      {interactive && <circle r={radius + 8} fill="transparent" />}
      {highlighted && <circle r={radius + 5} fill="var(--color-amber)" opacity={0.3} />}
      <circle
        r={radius}
        fill={light ? '#ffffff' : '#0f1518'}
        stroke={highlighted ? 'var(--color-amber)' : color}
        strokeWidth={highlighted ? 3 : 2}
      />
      <text textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill={color} className="font-mono">
        {atom.element}
      </text>
      {charge !== 0 && (
        <text x={radius - 2} y={-radius + 2} fontSize={10} fontWeight={700} fill="var(--color-amber)">
          {charge > 0 ? `${charge > 1 ? charge : ''}+` : `${charge < -1 ? Math.abs(charge) : ''}-`}
        </text>
      )}
    </g>
  );
}