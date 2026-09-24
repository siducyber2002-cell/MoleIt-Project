// frontend/src/components/Reactions/MechanismStepDiagram.jsx
//
// Renders one mechanism step: atoms, bonds (same shape as
// FunctionalGroups/MiniStructurePreview), plus curved electron-pushing
// arrows between atom ids. Kept as its own component (rather than
// extending MiniStructurePreview) since arrows are reaction-specific.
//
// The board itself is transparent now — it used to paint its own
// grey-ish fill, which turned into a flat slab whenever the surrounding
// panel wasn't the exact same shade. The container decides the
// background; this component only draws chemistry on top of it, over a
// faint dot grid so the space still reads as a "sketch board".
//
// Animated: atoms pop in, bonds draw themselves, then the electron-
// pushing arrows draw in last (the sequence a student's eye should
// follow) and keep a soft pulsing glow afterward so the "moving
// electrons" read as ongoing, not just a static curve. Pass
// `animate={false}` (or set `prefers-reduced-motion`) to render
// everything instantly instead — used for print/reduced-motion.

import { useId, useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { elementInfo } from '../../lib/elements';

export default function MechanismStepDiagram({
  atoms,
  bonds,
  arrows = [],
  height = 170,
  animate = true,
  className = '',
}) {
  const prefersReduced = useReducedMotion();
  const shouldAnimate = animate && !prefersReduced;

  // Unique per instance so multiple diagrams on one page don't share
  // (and overwrite) each other's marker / pattern definitions.
  const uid = useId().replace(/:/g, '');
  const arrowHeadId = `mech-arrow-head-${uid}`;
  const gridId = `mech-grid-${uid}`;

  const { viewBox } = useMemo(() => {
    if (!atoms.length) return { viewBox: '0 0 100 100' };
    const pad = 35;
    const xs = atoms.map((a) => a.x);
    const ys = atoms.map((a) => a.y);
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
    const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
    return { viewBox: `${minX} ${minY} ${w} ${h}` };
  }, [atoms]);

  const atomById = useMemo(() => {
    const map = {};
    atoms.forEach((a) => { map[a.id] = a; });
    return map;
  }, [atoms]);

  // Bonds finish drawing before arrows start, and arrows are staggered
  // after that so multiple electron-pushing curves in the same step
  // don't all fire at once.
  const bondsDoneAt = shouldAnimate ? 0.25 + bonds.length * 0.04 : 0;

  return (
    <svg
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      style={{ height, width: '100%' }}
      className={`block overflow-visible ${className}`}
    >
      <defs>
        <marker
          id={arrowHeadId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-amber)" />
        </marker>

        <pattern id={gridId} width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.7" fill="rgba(167, 139, 250, 0.16)" />
        </pattern>
      </defs>

      {/* Faint dot grid instead of an opaque fill, so the diagram blends
          into whatever panel it's sitting on. */}
      <rect x="-9999" y="-9999" width="19998" height="19998" fill={`url(#${gridId})`} />

      {bonds.map((bond, i) => {
        const from = atomById[bond.from];
        const to = atomById[bond.to];
        if (!from || !to) return null;
        return (
          <StepBond
            key={bond.id}
            from={from}
            to={to}
            order={bond.order}
            animate={shouldAnimate}
            delay={0.08 + i * 0.04}
          />
        );
      })}

      {arrows.map((arrow, i) => {
        const from = atomById[arrow.from];
        const to = atomById[arrow.to];
        if (!from || !to) return null;
        return (
          <StepArrow
            key={i}
            from={from}
            to={to}
            animate={shouldAnimate}
            delay={bondsDoneAt + i * 0.35}
            markerId={arrowHeadId}
          />
        );
      })}

      {atoms.map((atom, i) => (
        <StepAtom key={atom.id} atom={atom} animate={shouldAnimate} delay={i * 0.03} />
      ))}
    </svg>
  );
}

function StepBond({ from, to, order, animate, delay }) {
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
      {lines.map((l, i) => (
        <motion.line
          key={i}
          x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]}
          stroke="var(--color-lab-300)"
          strokeWidth={2}
          strokeLinecap="round"
          initial={animate ? { pathLength: 0, opacity: 0 } : false}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={animate ? { duration: 0.35, delay, ease: 'easeOut' } : { duration: 0 }}
        />
      ))}
    </>
  );
}

// Curved electron-pushing arrow: a quadratic bezier bowed perpendicular
// to the straight line between the two atoms, with an arrowhead at `to`.
// Draws itself in on entry, then keeps a slow, gentle opacity pulse so
// it reads as "electrons are moving" rather than a static diagram line.
function StepArrow({ from, to, animate, delay, markerId }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = -dy / len;
  const uy = dx / len;
  const bow = Math.min(35, len * 0.4);

  const midX = (from.x + to.x) / 2 + ux * bow;
  const midY = (from.y + to.y) / 2 + uy * bow;

  // Pull the endpoints in slightly so the arrow doesn't start/end inside
  // the atom circles.
  const shrink = 10;
  const sx = from.x + (dx / len) * shrink;
  const sy = from.y + (dy / len) * shrink;
  const ex = to.x - (dx / len) * shrink;
  const ey = to.y - (dy / len) * shrink;

  return (
    <motion.path
      d={`M ${sx} ${sy} Q ${midX} ${midY} ${ex} ${ey}`}
      fill="none"
      stroke="var(--color-amber)"
      strokeWidth={2.2}
      strokeLinecap="round"
      markerEnd={`url(#${markerId})`}
      initial={animate ? { pathLength: 0, opacity: 0 } : false}
      animate={
        animate
          ? { pathLength: 1, opacity: [0, 1, 0.55, 0.9, 0.55, 0.9] }
          : { pathLength: 1, opacity: 0.9 }
      }
      transition={
        animate
          ? {
              pathLength: { duration: 0.55, delay, ease: 'easeInOut' },
              opacity: {
                duration: 2.6,
                delay,
                times: [0, 0.22, 0.4, 0.6, 0.8, 1],
                repeat: Infinity,
                repeatDelay: 0.4,
              },
            }
          : { duration: 0 }
      }
    />
  );
}

function StepAtom({ atom, animate, delay }) {
  const info = elementInfo(atom.element);
  const isLong = atom.element.length > 1;
  const radius = atom.element === 'R' ? 13 : isLong ? 16 : info.radius;
  const color = atom.element === 'R' || atom.element === "R'" ? '#94a3b8' : info.color;
  const charge = atom.charge || 0;

  return (
    <motion.g
      transform={`translate(${atom.x}, ${atom.y})`}
      initial={animate ? { opacity: 0, scale: 0.4 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={animate ? { duration: 0.3, delay, type: 'spring', stiffness: 260, damping: 18 } : { duration: 0 }}
    >
      {/* Opaque disc so bonds/arrows don't run through the label, and a
          coloured halo so atoms stay legible on a dark panel. */}
      <circle r={radius} fill="var(--color-lab-950)" stroke={color} strokeWidth={2} />
      <circle r={radius + 3} fill="none" stroke={color} strokeWidth={1} opacity={0.18} />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={isLong ? 9 : 11}
        fontWeight={700}
        fill={color}
        className="font-mono"
      >
        {atom.element}
      </text>
      {charge !== 0 && (
        <text x={radius - 2} y={-radius + 2} fontSize={10} fontWeight={700} fill="var(--color-amber)">
          {charge > 0 ? `${charge > 1 ? charge : ''}+` : `${charge < -1 ? Math.abs(charge) : ''}\u2212`}
        </text>
      )}
    </motion.g>
  );
}