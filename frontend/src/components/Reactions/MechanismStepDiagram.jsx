// frontend/src/components/Reactions/MechanismStepDiagram.jsx
//
// RENDER-ONLY. All chemistry/geometry logic now lives in the backend
// (backend/app/mechanism.py, served by GET /api/reactions[/{id}]): data
// repair, atom radii/labels, bond line segments (single/double/triple/
// aromatic), curved-arrow paths + arrowheads, and the viewBox. This
// component just draws what it is given.
//
// Expected step shape (already prepared by the API):
//   atoms:    [{ id, element, label, x, y, charge, r, pseudo }]
//   bonds:    [{ id, from, to, order, lines: [{x1,y1,x2,y2,dash?}] }]
//   arrows:   [{ from, to, d, head }]      d = SVG path, head = polygon points
//   viewBox:  "minX minY w h"              (API field name: view_box)
//
// Fixes kept from the previous version:
//  - Atom position lives on a plain <g transform>; only scale is animated
//    on an inner <motion.g>. (framer-motion writes `scale` as a CSS
//    transform, which used to override the SVG translate and pile atoms up
//    near the origin, away from their bonds.)
//  - Arrows are drawn AFTER atoms so arrowheads are never hidden.
//
// No background grid/dot pattern - the diagram sits on the panel's plain background.
//
// Animation: atoms pop in, bonds draw, then arrows draw and softly pulse.
// `animate={false}` (or prefers-reduced-motion) renders instantly.

import { motion, useReducedMotion } from 'framer-motion';
import { elementInfo } from '../../lib/elements';

export default function MechanismStepDiagram({
  atoms = [],
  bonds = [],
  arrows = [],
  viewBox = '0 0 100 100',
  height = 170,
  animate = true,
  className = '',
}) {
  const prefersReduced = useReducedMotion();
  const shouldAnimate = animate && !prefersReduced;

  const bondsDoneAt = shouldAnimate ? 0.25 + bonds.length * 0.04 : 0;

  return (
    <svg
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      style={{ height, width: '100%', maxHeight: '100%' }}
      className={`block overflow-visible ${className}`}
      role="img"
      aria-label="Reaction mechanism step"
    >
      {bonds.map((bond, i) => (
        <StepBond key={bond.id} lines={bond.lines || []} animate={shouldAnimate} delay={0.08 + i * 0.04} />
      ))}

      {atoms.map((atom, i) => (
        <StepAtom key={atom.id} atom={atom} animate={shouldAnimate} delay={i * 0.03} />
      ))}

      {arrows.map((arrow, i) =>
        arrow.d ? (
          <StepArrow key={i} arrow={arrow} animate={shouldAnimate} delay={bondsDoneAt + i * 0.35} />
        ) : null
      )}
    </svg>
  );
}

function StepBond({ lines, animate, delay }) {
  return (
    <>
      {lines.map((l, i) => (
        <motion.line
          key={i}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke="var(--color-lab-300)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={l.dash}
          initial={animate ? { pathLength: 0, opacity: 0 } : false}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={animate ? { duration: 0.35, delay, ease: 'easeOut' } : { duration: 0 }}
        />
      ))}
    </>
  );
}

function StepArrow({ arrow, animate, delay }) {
  return (
    <motion.g
      initial={false}
      animate={animate ? { opacity: [1, 0.6, 1, 0.65, 1] } : { opacity: 1 }}
      transition={
        animate
          ? { duration: 2.8, delay: delay + 0.6, repeat: Infinity, repeatDelay: 0.4, ease: 'easeInOut' }
          : { duration: 0 }
      }
    >
      <motion.path
        d={arrow.d}
        fill="none"
        stroke="var(--color-amber)"
        strokeWidth={2.2}
        strokeLinecap="round"
        initial={animate ? { pathLength: 0, opacity: 0 } : false}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={animate ? { duration: 0.55, delay, ease: 'easeInOut' } : { duration: 0 }}
      />
      <motion.polygon
        points={arrow.head}
        fill="var(--color-amber)"
        initial={animate ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={animate ? { duration: 0.15, delay: delay + 0.45 } : { duration: 0 }}
      />
    </motion.g>
  );
}

function StepAtom({ atom, animate, delay }) {
  const info = elementInfo(atom.element);
  const label = atom.label ?? atom.element;
  const radius = atom.r ?? 13;
  // Pseudo-atoms (R, Nu, e⁻, custom labels) get a neutral colour.
  const color = atom.pseudo ? '#94a3b8' : info.color;
  const fontSize = label.length >= 3 ? 8 : label.length === 2 ? 9.5 : 11;
  const charge = atom.charge || 0;

  return (
    // Outer <g> owns the POSITION; the inner motion.g only animates scale.
    <g transform={`translate(${atom.x}, ${atom.y})`}>
      <motion.g
        initial={animate ? { opacity: 0, scale: 0.4 } : false}
        animate={{ opacity: 1, scale: 1 }}
        transition={animate ? { duration: 0.3, delay, type: 'spring', stiffness: 260, damping: 18 } : { duration: 0 }}
      >
        <circle r={radius} fill="var(--color-lab-950)" stroke={color} strokeWidth={2} />
        <circle r={radius + 3} fill="none" stroke={color} strokeWidth={1} opacity={0.18} />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fontWeight={700}
          fill={color}
          className="font-mono"
        >
          {label}
        </text>
        {charge !== 0 && (
          <text x={radius - 2} y={-radius + 2} fontSize={10} fontWeight={700} fill="var(--color-amber)">
            {charge > 0 ? `${charge > 1 ? charge : ''}+` : `${charge < -1 ? Math.abs(charge) : ''}\u2212`}
          </text>
        )}
      </motion.g>
    </g>
  );
}