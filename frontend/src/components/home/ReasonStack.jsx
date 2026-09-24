import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

/**
 * Overlapping "reason cards" — the same sticky-stack effect you see on
 * agency sites like Indisea (07 / WHY COMPANIES CALL US): each panel pins a
 * few pixels lower than the one before it, so as the reader scrolls, each
 * new card slides up and settles just above the last, covering it a little
 * more with every step.
 *
 * Pure CSS (position: sticky + an incrementing --i offset) — no scroll
 * listeners, so it stays smooth next to the already-animated RoadLine.
 */

const REASONS = [
  {
    n: '1',
    heading: "A molecule's shape decides its physics",
    desc: "Symmetry isn't decoration — it's why some vibrations light up in IR but stay silent in Raman. Classify the point group first, and the rest of spectroscopy starts making sense.",
    bg: '#1d84c9',
    rotate: -4,
  },
  {
    n: '2',
    heading: 'Real operation detection, not a lookup table',
    desc: 'Paste a structure and the engine searches the actual 3-D geometry for rotations, reflections, inversion and improper rotations — then builds the group from what it finds.',
    bg: '#c17a12',
    rotate: 3,
  },
  {
    n: '3',
    heading: 'Every symmetry element, animated in 3D',
    desc: 'Rotate the molecule, hover an axis or a mirror plane, and watch the operation play out in real time. Abstract group theory turns into something you can actually watch happen.',
    bg: 'var(--ix-green)',
    rotate: -3,
  },
  {
    n: '4',
    heading: 'Character tables and Γvib, generated live',
    desc: 'The 3N Cartesian representation gets reduced into Γtrans + Γrot + Γvib automatically — go from a raw structure to which modes are IR- and Raman-active in one pass.',
    bg: 'var(--ix-ink)',
    rotate: 4,
  },
];

export default function ReasonStack() {
  return (
    <div className="ix-stack">
      {REASONS.map((r, i) => (
        <article
          key={r.n}
          className="ix-stack__card"
          style={{ '--i': i, background: r.bg }}
        >
          <div className="ix-stack__text">
            <span className="ix-stack__reason">Reason {r.n}</span>
            <h3 className="ix-stack__heading">{r.heading}</h3>
            <p className="ix-stack__desc">{r.desc}</p>
            <Link to="/group-theory" className="ix-stack__cta">
              Open Symmetry Lab <ArrowRight size={16} />
            </Link>
          </div>

          <div className="ix-stack__graphic" aria-hidden="true">
            <span className="ix-stack__num" style={{ transform: `rotate(${r.rotate}deg)` }}>
              {r.n}
            </span>
          </div>
        </article>
      ))}
    </div>
  );
}