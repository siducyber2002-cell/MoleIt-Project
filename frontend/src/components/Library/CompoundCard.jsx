import { useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Globe2, ArrowUpRight } from 'lucide-react';

// ---------------------------------------------------------------------------
// Category tones (light theme)
// Each category gets a pale chip (ink / bg / bd) and a glossy "orb" gradient
// (hi / mid / lo) so the little 3D sphere on the card matches its chip.
// ---------------------------------------------------------------------------
const TONES = {
  Organic: { ink: '#3b5600', bg: '#f0fbc8', bd: '#bcdc4c', hi: '#f4ffa8', mid: '#ccEb2d', lo: '#7e9911' },
  Inorganic: { ink: '#4c2fa8', bg: '#ece7ff', bd: '#b9a6f5', hi: '#e2d9ff', mid: '#a78bfa', lo: '#5b3fc4' },
  Biochemistry: { ink: '#8a4b00', bg: '#fff0d1', bd: '#f1c064', hi: '#ffe7ad', mid: '#f5a524', lo: '#a86400' },
  Pharmaceuticals: { ink: '#a01a3a', bg: '#ffe4ea', bd: '#f5a3b5', hi: '#ffd6df', mid: '#fb7185', lo: '#b4234a' },
  Polymers: { ink: '#0c5a86', bg: '#def2ff', bd: '#8ccbf0', hi: '#d2f0ff', mid: '#38bdf8', lo: '#0b6ea3' },
  Solvents: { ink: '#0a6273', bg: '#d9f7fb', bd: '#7edbe8', hi: '#ccf7ff', mid: '#22d3ee', lo: '#0b7c90' },
  Acids: { ink: '#a3320b', bg: '#ffe6dc', bd: '#f5ac91', hi: '#ffd9c8', mid: '#f97316', lo: '#a3400b' },
  Bases: { ink: '#3730a3', bg: '#e4e6ff', bd: '#a5abf5', hi: '#d9dcff', mid: '#6366f1', lo: '#3730a3' },
  Carbohydrates: { ink: '#166534', bg: '#dcf8e4', bd: '#86d9a0', hi: '#cff7dc', mid: '#34d399', lo: '#15803d' },
  'Amino Acids': { ink: '#86198f', bg: '#fbe4fd', bd: '#eba0f2', hi: '#f9d6fc', mid: '#d946ef', lo: '#86198f' },
  'Famous Molecules': { ink: '#715c00', bg: '#fff8c9', bd: '#ecd34a', hi: '#fff4ab', mid: '#eab308', lo: '#8a6d00' },
  PubChem: { ink: '#0f5e57', bg: '#d8f8f1', bd: '#79dcc9', hi: '#c9f7ee', mid: '#2dd4bf', lo: '#0f766e' },
};
const FALLBACK_TONE = { ink: '#4a4f3f', bg: '#eef0e6', bd: '#c9cdb8', hi: '#f4ffa8', mid: '#ccEb2d', lo: '#7e9911' };

// CSS variables for a category — spread into a `style` prop.
export function categoryTone(category) {
  const t = TONES[category] || FALLBACK_TONE;
  return {
    '--t-ink': t.ink,
    '--t-bg': t.bg,
    '--t-bd': t.bd,
    '--o-hi': t.hi,
    '--o-mid': t.mid,
    '--o-lo': t.lo,
  };
}

// "C6H12O6" -> C6H12O6 with real subscripts. Digits are only subscripted when
// they follow a letter or a closing bracket, so a leading coefficient ("2H2O")
// stays full size.
export function Formula({ text }) {
  const parts = String(text ?? '').split(/(\d+)/);
  return parts.map((p, i) =>
    i > 0 && /^\d+$/.test(p) && /[A-Za-z)\]]$/.test(parts[i - 1]) ? <sub key={i}>{p}</sub> : p
  );
}

const MAX_TILT = 13; // degrees, at the very edge of the card

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function CompoundCard({ compound }) {
  const ref = useRef(null);

  // Tilt is written straight to CSS variables (no React state), so hovering a
  // card never re-renders the grid.
  const onEnter = useCallback((e) => {
    if (e.pointerType !== 'mouse' || prefersReducedMotion()) return;
    ref.current?.classList.add('is-live');
  }, []);

  const onMove = useCallback((e) => {
    if (e.pointerType !== 'mouse') return;
    const el = ref.current;
    if (!el || !el.classList.contains('is-live')) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    el.style.setProperty('--rx', `${(py - 0.5) * MAX_TILT * 1.3}deg`);
    el.style.setProperty('--ry', `${(0.5 - px) * MAX_TILT * 2}deg`);
    el.style.setProperty('--mx', `${px * 100}%`);
    el.style.setProperty('--my', `${py * 100}%`);
  }, []);

  const onLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove('is-live');
    ['--rx', '--ry', '--mx', '--my'].forEach((p) => el.style.removeProperty(p));
  }, []);

  const showCommon = compound.common_name && compound.common_name !== compound.name;

  return (
    <Link
      ref={ref}
      to={`/library/${compound.id}`}
      className="c3d"
      style={categoryTone(compound.category)}
      onPointerEnter={onEnter}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      <span className="c3d-body">
        <span className="c3d-ground" aria-hidden="true" />
        <span className="c3d-slab c3d-slab--3" aria-hidden="true" />
        <span className="c3d-slab c3d-slab--2" aria-hidden="true" />
        <span className="c3d-slab c3d-slab--1" aria-hidden="true" />

        <span className="c3d-face">
          <span className="c3d-glare" aria-hidden="true" />

          <span className="c3d-row c3d-z1">
            <span className="c3d-cat">{compound.category}</span>
            <span className="c3d-go" aria-hidden="true">
              <ArrowUpRight size={16} strokeWidth={2.4} />
            </span>
          </span>

          <h3 className="c3d-name c3d-z2">{compound.name}</h3>
          {showCommon && <p className="c3d-common c3d-z1">{compound.common_name}</p>}

          <span className="c3d-mid">
            <span className="c3d-formula c3d-z3">
              <Formula text={compound.formula} />
            </span>
            <span className="c3d-orb c3d-z4" aria-hidden="true" />
          </span>

          <p className="c3d-desc c3d-z1">{compound.description}</p>

          {compound.source === 'pubchem' && (
            <span className="c3d-src c3d-z1">
              <Globe2 size={11} /> via PubChem
            </span>
          )}
        </span>
      </span>

      {/* React 19 hoists this into <head> once, however many cards render */}
      <style href="moleit-lib-card" precedence="medium">{CARD_CSS}</style>
    </Link>
  );
}

const CARD_CSS = `
.c3d {
  --rx: 6deg;
  --ry: -9deg;
  --lift: 0px;
  position: relative;
  display: block;
  height: 100%;
  perspective: 1100px;
  color: inherit;
  text-decoration: none;
  outline: none;
  -webkit-tap-highlight-color: transparent;
}
.c3d-body {
  position: relative;
  display: block;
  height: 100%;
  transform-style: preserve-3d;
  transform: rotateX(var(--rx)) rotateY(var(--ry)) translateZ(var(--lift));
  transition: transform 0.7s cubic-bezier(0.16, 1, 0.3, 1);
}
.c3d.is-live { --lift: 26px; }
.c3d.is-live .c3d-body { transition: transform 0.14s ease-out; }

/* --- thickness: three lime slabs stacked behind the face --- */
.c3d-slab {
  position: absolute;
  inset: 0;
  border-radius: 24px;
  border: 1.5px solid rgba(14, 16, 10, 0.55);
}
.c3d-slab--1 { background: #c9e62c; transform: translate3d(2.5px, 3.5px, -7px); }
.c3d-slab--2 { background: #b3d022; transform: translate3d(5px, 7px, -14px); }
.c3d-slab--3 { background: #9cb81a; transform: translate3d(7.5px, 10.5px, -21px); }

.c3d-ground {
  position: absolute;
  left: 8%;
  right: 4%;
  bottom: -4px;
  height: 26px;
  border-radius: 50%;
  background: rgba(60, 85, 5, 0.42);
  filter: blur(14px);
  transform: translateZ(-30px) translateY(22px);
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s;
}
.c3d.is-live .c3d-ground {
  transform: translateZ(-60px) translateY(38px) scale(0.92);
  opacity: 0.8;
}

/* --- face --- */
.c3d-face {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 218px;
  padding: 20px 20px 18px;
  border-radius: 24px;
  background: linear-gradient(160deg, #ffffff 0%, #f7faee 100%);
  border: 1.5px solid rgba(14, 16, 10, 0.55);
  box-shadow: inset 0 2px 0 #fff, inset 0 -12px 26px rgba(190, 220, 60, 0.12);
  transform-style: preserve-3d;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.c3d.is-live .c3d-face { border-color: #0e100a; }
.c3d:focus-visible .c3d-face {
  border-color: #0e100a;
  box-shadow: inset 0 2px 0 #fff, 0 0 0 4px rgba(204, 235, 45, 0.85);
}

.c3d-glare {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(360px circle at var(--mx, 50%) var(--my, 0%), rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0) 62%);
  transition: opacity 0.25s;
}
.c3d.is-live .c3d-glare { opacity: 1; }

/* content floats at different heights above the face */
.c3d-z1 { transform: translateZ(14px); }
.c3d-z2 { transform: translateZ(28px); }
.c3d-z3 { transform: translateZ(42px); }
.c3d-z4 { transform: translateZ(64px); }

.c3d-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.c3d-cat {
  display: inline-block;
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--t-bd);
  background: var(--t-bg);
  color: var(--t-ink);
  font: 600 11px/1.3 var(--lib-font-body, system-ui, sans-serif);
}
.c3d-go {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: #0e100a;
  color: #fff;
  box-shadow: 0 3px 0 #3b4029;
  transition: background 0.2s, color 0.2s;
}
.c3d.is-live .c3d-go { background: #ccEb2d; color: #0e100a; }

.c3d-name {
  margin: 16px 0 0;
  font: 700 21px/1.15 var(--lib-font-display, system-ui, sans-serif);
  letter-spacing: -0.02em;
  color: #0e100a;
}
.c3d-common {
  margin: 4px 0 0;
  font: 500 12.5px/1.3 var(--lib-font-body, system-ui, sans-serif);
  color: #7b816c;
}

.c3d-mid {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 14px 0 12px;
  transform-style: preserve-3d;
}
.c3d-formula {
  display: inline-block;
  max-width: 100%;
  padding: 7px 14px;
  border-radius: 12px;
  border: 1.5px solid #0e100a;
  background: #ccEb2d;
  color: #0e100a;
  font: 600 17px/1.1 'IBM Plex Mono', ui-monospace, 'Courier New', monospace;
  overflow-wrap: anywhere;
  box-shadow: 0 3px 0 #0e100a;
}
.c3d-formula sub { font-size: 0.68em; line-height: 0; vertical-align: -0.28em; }

.c3d-orb {
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: radial-gradient(circle at 32% 26%, rgba(255, 255, 255, 0.95) 0 5%, var(--o-hi) 17%, var(--o-mid) 56%, var(--o-lo) 100%);
  box-shadow: inset -5px -7px 12px rgba(0, 0, 0, 0.18), 0 12px 16px -6px rgba(14, 16, 10, 0.4);
}

.c3d-desc {
  margin: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font: 400 13px/1.5 var(--lib-font-body, system-ui, sans-serif);
  color: #454a3b;
}
.c3d-src {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid #79dcc9;
  background: #d8f8f1;
  color: #0f5e57;
  font: 600 10.5px/1.3 var(--lib-font-body, system-ui, sans-serif);
}

@media (prefers-reduced-motion: reduce) {
  .c3d { --rx: 0deg; --ry: 0deg; }
  .c3d-body, .c3d-ground { transition: none; }
}
`;