import { memo, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useFormStatus } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

// Shared chrome for the two auth screens.
//
// Everything visual that Login and Register have in common lives here so
// the two pages can stay focused on their (deliberately different)
// interaction models. Three things worth calling out:
//
//   1. `useReducedMotionPref` reads the media query through
//      useSyncExternalStore rather than useState + an effect, so the
//      value is correct on the very first paint instead of flipping a
//      frame later.
//   2. `usePointerParallax` drives the floating-card scene by writing
//      two CSS custom properties on a single container element from
//      inside a rAF loop. No React state, so moving the mouse never
//      re-renders a component — the whole scene animates on the
//      compositor.
//   3. `SubmitButton` pulls its pending state out of the enclosing
//      <form> with useFormStatus, so neither page has to thread an
//      `isPending` prop down into it.

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

let motionQuery = null;
function getMotionQuery() {
  if (motionQuery === null && typeof window !== 'undefined') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  }
  return motionQuery;
}

function subscribeMotion(onChange) {
  const q = getMotionQuery();
  if (!q) return () => {};
  q.addEventListener('change', onChange);
  return () => q.removeEventListener('change', onChange);
}

/**
 * `prefers-reduced-motion` as a reactive, render-safe value.
 * Subscribing through useSyncExternalStore (instead of an effect) means
 * the first render already knows the answer — no motion flash for users
 * who asked for none.
 */
export function useReducedMotionPref() {
  return useSyncExternalStore(
    subscribeMotion,
    () => getMotionQuery()?.matches ?? false,
    () => false,
  );
}

/**
 * Pointer parallax with zero re-renders.
 *
 * Attach the returned ref to a container. Pointer position is smoothed
 * with a lerp inside requestAnimationFrame and published as `--px` /
 * `--py` (both roughly -1 → 1) on that container, so any descendant can
 * opt into as much or as little drift as it likes purely in CSS:
 *
 *   transform: translate3d(calc(var(--px) * 18px), calc(var(--py) * 14px), 0);
 *
 * The loop parks itself the moment the scene has settled, so an idle
 * page costs nothing.
 */
export function usePointerParallax(disabled = false) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return undefined;

    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let frame = 0;

    const loop = () => {
      current.x += (target.x - current.x) * 0.075;
      current.y += (target.y - current.y) * 0.075;
      el.style.setProperty('--px', current.x.toFixed(4));
      el.style.setProperty('--py', current.y.toFixed(4));

      const settled =
        Math.abs(target.x - current.x) < 0.0015 && Math.abs(target.y - current.y) < 0.0015;
      frame = settled ? 0 : requestAnimationFrame(loop);
    };

    const kick = () => {
      if (!frame) frame = requestAnimationFrame(loop);
    };

    const handleMove = (event) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      target.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      target.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      kick();
    };

    const handleLeave = () => {
      target.x = 0;
      target.y = 0;
      kick();
    };

    window.addEventListener('pointermove', handleMove, { passive: true });
    window.addEventListener('blur', handleLeave);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('blur', handleLeave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [disabled]);

  return ref;
}

/* ------------------------------------------------------------------ */
/* Form primitives                                                     */
/* ------------------------------------------------------------------ */

/**
 * Text field with a label that lifts into the border on focus/fill and
 * a "bond" that draws itself left-to-right underneath. Uncontrolled
 * label state (`filled`) is derived from the value prop, so the caller
 * keeps owning the data.
 */
export function BondField({
  label,
  name,
  type = 'text',
  icon: Icon,
  value,
  onChange,
  accent = 'phosphor',
  autoComplete,
  required,
  minLength,
  inputRef,
  hint,
  error,
  onKeyDown,
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const isPassword = type === 'password';
  const resolvedType = isPassword && revealed ? 'text' : type;
  const lifted = focused || String(value ?? '').length > 0;

  const accentVar = accent === 'violet' ? '#eea02b' : '#3bbff7';

  const handleKeyDown = (event) => {
    if (isPassword && typeof event.getModifierState === 'function') {
      setCapsLock(event.getModifierState('CapsLock'));
    }
    onKeyDown?.(event);
  };

  // Fixed-height box, always centred. The previous version reserved a
  // permanent 25px/10px top/bottom split for the caption's headroom —
  // real, asymmetric space baked into the box even when resting, which
  // is what read as "congested" with the value pushed toward the floor.
  // Instead the icon+input row is centred in a constant-height box via
  // flex, and the label is the only thing that moves: centred over the
  // row at rest (a normal-size placeholder-like caption), and floated to
  // a fixed slot above it — slightly overlapping the border, same idea
  // as an outlined Material field — once focused or filled.
  const FIELD_HEIGHT = 58;
  const LABEL_LEFT = Icon ? 39 : 14; // 14px inset + 15px icon + 10px gap

  return (
    <div className="bond-field" style={{ '--field-accent': accentVar }}>
      <div
        className={`relative rounded-xl border bg-white/80 px-3.5 backdrop-blur-sm transition-colors duration-200 ${
          error
            ? 'border-coral/60'
            : focused
              ? 'border-transparent'
              : 'border-[rgba(38,38,38,0.14)] hover:border-[rgba(38,38,38,0.28)]'
        }`}
        style={{ height: FIELD_HEIGHT }}
      >
        <label
          htmlFor={id}
          className="pointer-events-none absolute z-10 font-medium leading-none transition-all duration-200 ease-out"
          style={{
            left: LABEL_LEFT,
            top: lifted ? 11 : '50%',
            transform: lifted ? 'translateY(0)' : 'translateY(-50%)',
            fontSize: lifted ? '10.5px' : '13.5px',
            letterSpacing: lifted ? '0.055em' : '0',
            color: error
              ? 'var(--color-coral)'
              : lifted
                ? accentVar
                : '#8a8681',
          }}
        >
          {label}
        </label>

        <div
          className="flex h-full items-center gap-2.5 transition-transform duration-200 ease-out"
          style={{ transform: `translateY(${lifted ? 8 : 0}px)` }}
        >
          {Icon && (
            <Icon
              size={15}
              className="shrink-0 transition-colors duration-200"
              style={{ color: lifted ? accentVar : '#8a8681' }}
            />
          )}

          <input
            id={id}
            ref={inputRef}
            name={name}
            type={resolvedType}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setCapsLock(false);
            }}
            onKeyDown={handleKeyDown}
            required={required}
            minLength={minLength}
            autoComplete={autoComplete}
            aria-invalid={Boolean(error)}
            className="w-full bg-transparent text-sm leading-5 text-[#262626] outline-none placeholder:text-transparent"
          />

          {isPassword && (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setRevealed((r) => !r)}
              aria-label={revealed ? 'Hide password' : 'Show password'}
              className="shrink-0 text-[#8a8681] transition-colors hover:text-[#262626]"
            >
              {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          )}
        </div>

        {/* The bond: a hairline that grows out from the centre on focus. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden rounded-full"
        >
          <span
            className="block h-full w-full origin-center transition-transform duration-300 ease-out"
            style={{
              background: `linear-gradient(90deg, transparent, ${accentVar}, transparent)`,
              transform: focused ? 'scaleX(1)' : 'scaleX(0)',
            }}
          />
        </span>

        {/* Soft focus halo, drawn outside the border box. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px rounded-xl transition-opacity duration-300"
          style={{
            opacity: focused ? 1 : 0,
            boxShadow: `0 0 0 1px ${accentVar}, 0 0 22px -6px ${accentVar}`,
          }}
        />
      </div>

      {capsLock && (
        <span className="mt-1.5 block text-[11px] font-medium text-amber">Caps Lock is on</span>
      )}
      {error && <span className="mt-2 block text-[11px] leading-snug text-coral">{error}</span>}
      {!error && hint && <span className="mt-2 block text-[11px] leading-snug text-[#8a8681]">{hint}</span>}
    </div>
  );
}

/**
 * Submit button that reads its own pending state off the parent <form>
 * via useFormStatus — no prop drilling, and it stays correct no matter
 * which action the form is wired to.
 */
export function SubmitButton({ children, pendingLabel = 'Working…', accent = 'phosphor', icon: Icon }) {
  const { pending } = useFormStatus();
  const ref = useRef(null);

  // Cursor-tracking highlight: the gradient hotspot follows the pointer
  // across the button face. Written straight to CSS vars, so hovering
  // never triggers a render.
  const handleMove = (event) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
    el.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
  };

  const gradient =
    accent === 'violet'
      ? 'linear-gradient(90deg, #eea02b, #3bbff7)'
      : 'linear-gradient(90deg, #3bbff7, #eea02b)';

  return (
    <button
      ref={ref}
      type="submit"
      disabled={pending}
      onPointerMove={handleMove}
      className="auth-submit group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl px-4 py-3 text-sm font-semibold text-[#262626] transition-transform duration-150 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-70"
      style={{ backgroundImage: gradient }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), rgba(255,255,255,.55), transparent 65%)',
        }}
      />
      <span className="relative flex items-center gap-2">
        {pending ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            {pendingLabel}
          </>
        ) : (
          <>
            {children}
            {Icon && <Icon size={15} className="transition-transform group-hover:translate-x-0.5" />}
          </>
        )}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Graphics                                                            */
/* ------------------------------------------------------------------ */

/** Oversized ghost wordmark sitting behind the scene. */
export const BrandWatermark = memo(function BrandWatermark({ text = 'MoleIt', className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`auth-watermark pointer-events-none select-none font-display font-bold tracking-tighter ${className}`}
    >
      {text}
    </span>
  );
});

/**
 * The tiny library of compounds the Formula card cycles through, so the
 * scene reads as a live viewer rather than a static screenshot pinned to
 * one molecule. Formula is a token list rather than a JSX-in-data string,
 * so `FormulaMark` can render subscripts consistently for any entry.
 */
const SHOWCASE_COMPOUNDS = [
  { slug: 'caffeine', name: 'caffeine', mass: '194.19 g/mol', formula: [['C', 8], ['H', 10], ['N', 4], ['O', 2]] },
  { slug: 'aspirin', name: 'aspirin', mass: '180.16 g/mol', formula: [['C', 9], ['H', 8], ['O', 4]] },
  { slug: 'ibuprofen', name: 'ibuprofen', mass: '206.28 g/mol', formula: [['C', 13], ['H', 18], ['O', 2]] },
  { slug: 'paracetamol', name: 'paracetamol', mass: '151.16 g/mol', formula: [['C', 8], ['H', 9], ['N', 1], ['O', 2]] },
  { slug: 'glucose', name: 'glucose', mass: '180.16 g/mol', formula: [['C', 6], ['H', 12], ['O', 6]] },
];

const COMPOUND_ROTATE_MS = 4200;

function FormulaMark({ formula }) {
  return (
    <>
      {formula.map(([el, count]) => (
        <span key={el}>
          {el}
          {count > 1 && <sub>{count}</sub>}
        </span>
      ))}
    </>
  );
}

/**
 * The floating scene: a tilted "app window" showing a molecule, with
 * satellite cards drifting around it at different parallax depths.
 * Pure DOM + inline SVG, so it costs one paint and no canvas.
 *
 * The Formula card and the window's file-name title are both driven off
 * one rotating index, so the two stay in sync as the showcased compound
 * changes. Rotation pauses for `prefers-reduced-motion`, landing on
 * caffeine rather than cycling.
 */
export const MoleculeScene = memo(function MoleculeScene() {
  const reduceMotion = useReducedMotionPref();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduceMotion) return undefined;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % SHOWCASE_COMPOUNDS.length);
    }, COMPOUND_ROTATE_MS);
    return () => clearInterval(timer);
  }, [reduceMotion]);

  const compound = SHOWCASE_COMPOUNDS[index];

  return (
    <div className="auth-scene" aria-hidden="true">
      {/* Main tilted window */}
      <div className="auth-window" data-depth="near">
        <div className="auth-window-bar">
          <span className="auth-dot" style={{ background: '#fb7185' }} />
          <span className="auth-dot" style={{ background: '#f5a524' }} />
          <span className="auth-dot" style={{ background: '#5eead4' }} />
          <span className="auth-window-title font-mono">viewer · {compound.slug}.mol</span>
        </div>
        <div className="auth-window-body grid-paper">
          <svg viewBox="0 0 220 150" className="h-full w-full overflow-visible">
            <defs>
              <radialGradient id="auth-atom-c" cx="35%" cy="30%">
                <stop offset="0%" stopColor="#7dd3fc" />
                <stop offset="100%" stopColor="#0ea5e9" />
              </radialGradient>
              <radialGradient id="auth-atom-n" cx="35%" cy="30%">
                <stop offset="0%" stopColor="#c4b5fd" />
                <stop offset="100%" stopColor="#7c3aed" />
              </radialGradient>
              <radialGradient id="auth-atom-o" cx="35%" cy="30%">
                <stop offset="0%" stopColor="#fda4af" />
                <stop offset="100%" stopColor="#e11d48" />
              </radialGradient>
            </defs>

            {/* orbit rings */}
            <ellipse
              cx="110" cy="75" rx="82" ry="30"
              fill="none" stroke="rgba(59,191,247,.28)" strokeWidth="1"
              className="auth-orbit" style={{ animationDuration: '18s' }}
            />
            <ellipse
              cx="110" cy="75" rx="82" ry="30"
              fill="none" stroke="rgba(238,160,43,.25)" strokeWidth="1"
              className="auth-orbit" style={{ animationDuration: '24s', animationDirection: 'reverse' }}
              transform="rotate(62 110 75)"
            />

            {/* bonds */}
            <g stroke="rgba(38,38,38,.32)" strokeWidth="1.6" strokeLinecap="round">
              <line x1="110" y1="75" x2="74" y2="54" />
              <line x1="110" y1="75" x2="148" y2="56" />
              <line x1="110" y1="75" x2="108" y2="116" />
              <line x1="74" y1="54" x2="46" y2="76" />
              <line x1="148" y1="56" x2="176" y2="82" />
              <line x1="46" y1="76" x2="66" y2="110" />
              <line x1="176" y1="82" x2="152" y2="112" />
            </g>

            {/* atoms */}
            <circle cx="110" cy="75" r="9" fill="url(#auth-atom-c)" className="auth-node" />
            <circle cx="74" cy="54" r="7" fill="url(#auth-atom-n)" className="auth-node" style={{ animationDelay: '.3s' }} />
            <circle cx="148" cy="56" r="7" fill="url(#auth-atom-n)" className="auth-node" style={{ animationDelay: '.6s' }} />
            <circle cx="46" cy="76" r="6.5" fill="url(#auth-atom-c)" className="auth-node" style={{ animationDelay: '.9s' }} />
            <circle cx="176" cy="82" r="6.5" fill="url(#auth-atom-o)" className="auth-node" style={{ animationDelay: '1.2s' }} />
            <circle cx="108" cy="116" r="6" fill="url(#auth-atom-o)" className="auth-node" style={{ animationDelay: '1.5s' }} />
            <circle cx="66" cy="110" r="5.5" fill="url(#auth-atom-c)" className="auth-node" style={{ animationDelay: '1.8s' }} />
            <circle cx="152" cy="112" r="5.5" fill="url(#auth-atom-c)" className="auth-node" style={{ animationDelay: '2.1s' }} />
          </svg>
        </div>
      </div>

      {/* Violet gradient tile — the "hero card" of the composition.
          Content crossfades between compounds; the card itself never
          resizes, so nothing else in the scene has to reflow. */}
      <div className="auth-card auth-card--formula" data-depth="front">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/60">Formula</span>
        <AnimatePresence mode="wait">
          <motion.span
            key={compound.slug}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="mt-1 font-display text-lg font-bold leading-none text-white"
          >
            <FormulaMark formula={compound.formula} />
          </motion.span>
        </AnimatePresence>
        <AnimatePresence mode="wait">
          <motion.span
            key={compound.slug + '-meta'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, delay: 0.05 }}
            className="mt-2 text-[10px] text-white/70"
          >
            {compound.mass} · {compound.name}
          </motion.span>
        </AnimatePresence>
        <span className="auth-card-sheen" />
      </div>

      {/* Mini spectrum readout */}
      <div className="auth-card auth-card--spectra" data-depth="mid">
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#8a8681]">¹H NMR</span>
        <svg viewBox="0 0 96 34" className="mt-1.5 h-8 w-full">
          {[6, 14, 22, 30, 38, 46, 54, 62, 70, 78, 86].map((x, i) => (
            <rect
              key={x}
              x={x}
              y={4}
              width="3"
              height="26"
              rx="1.5"
              fill="#3bbff7"
              opacity={0.4 + (i % 4) * 0.2}
              className="spectrum-peak"
              style={{ animationDelay: `${i * 0.13}s` }}
            />
          ))}
        </svg>
      </div>

      {/* Study-streak grid, calendar-ish */}
      <div className="auth-card auth-card--grid" data-depth="mid">
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#8a8681]">Streak</span>
        <div className="mt-1.5 grid grid-cols-7 gap-[3px]">
          {Array.from({ length: 21 }, (_, i) => (
            <span
              key={i}
              className="h-[7px] w-[7px] rounded-[2px]"
              style={{
                background:
                  i % 5 === 0
                    ? '#3bbff7'
                    : i % 3 === 0
                      ? 'rgba(59,191,247,.4)'
                      : 'rgba(38,38,38,.1)',
              }}
            />
          ))}
        </div>
      </div>

      {/* Small pill chip */}
      <div className="auth-card auth-card--chip" data-depth="front">
        <span className="h-1.5 w-1.5 rounded-full bg-[#3bbff7]" />
        <span className="text-[10px] font-medium text-[#4e4e4d]">12 molecules saved</span>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Styles shared by both auth screens                                  */
/* ------------------------------------------------------------------ */

export function AuthSceneStyles() {
  return (
    <style>{`
      .auth-watermark {
        font-size: clamp(6rem, 17vw, 14rem);
        line-height: 0.8;
        color: transparent;
        background-image: linear-gradient(180deg, rgba(38,38,38,.09), rgba(38,38,38,.015));
        -webkit-background-clip: text;
        background-clip: text;
      }

      .auth-scene {
        position: relative;
        width: min(430px, 86%);
        aspect-ratio: 1 / 0.92;
        perspective: 1200px;
        transform-style: preserve-3d;
      }

      .auth-window {
        position: absolute;
        inset: 12% 4% 16% 6%;
        border-radius: 16px;
        border: 1px solid rgba(38,38,38,.08);
        background: linear-gradient(160deg, #ffffff, #fafaf9);
        box-shadow: 0 32px 70px -26px rgba(38,38,38,.22), 0 0 0 1px rgba(38,38,38,.02) inset;
        overflow: hidden;
        transform:
          rotateY(calc(-13deg + var(--px, 0) * 5deg))
          rotateX(calc(7deg + var(--py, 0) * -4deg))
          translate3d(calc(var(--px, 0) * 10px), calc(var(--py, 0) * 8px), 0);
        transition: transform .12s linear;
        animation: auth-float 11s ease-in-out infinite;
      }

      .auth-window-bar {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(38,38,38,.08);
        background: rgba(38,38,38,.015);
      }
      .auth-dot { width: 7px; height: 7px; border-radius: 999px; opacity: .8; }
      .auth-window-title {
        margin-left: 8px;
        font-size: 9px;
        letter-spacing: .04em;
        color: #8a8681;
      }
      .auth-window-body { height: calc(100% - 31px); padding: 10px 12px; }

      .auth-card {
        position: absolute;
        display: flex;
        flex-direction: column;
        border-radius: 14px;
        padding: 10px 12px;
        border: 1px solid rgba(38,38,38,.08);
        background: rgba(255,255,255,.92);
        backdrop-filter: blur(14px);
        box-shadow: 0 20px 44px -20px rgba(38,38,38,.28);
        transform:
          rotateY(calc(-13deg + var(--px, 0) * 8deg))
          rotateX(calc(7deg + var(--py, 0) * -6deg))
          translate3d(calc(var(--px, 0) * 24px), calc(var(--py, 0) * 20px), 0);
        transition: transform .12s linear;
      }

      .auth-card--formula {
        left: -4%;
        top: 30%;
        width: 44%;
        border: none;
        background: linear-gradient(145deg, #3bbff7, #4bafd9 55%, #eea02b);
        box-shadow: 0 26px 52px -18px rgba(59,191,247,.5);
        overflow: hidden;
        animation: auth-float 9s ease-in-out infinite reverse;
      }
      .auth-card-sheen {
        position: absolute;
        inset: 0;
        background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,.35) 50%, transparent 65%);
        transform: translateX(-120%);
        animation: auth-sheen 6s ease-in-out infinite;
      }

      .auth-card--spectra {
        right: -6%;
        top: 12%;
        width: 40%;
        animation: auth-float 13s ease-in-out infinite;
      }

      .auth-card--grid {
        right: 2%;
        bottom: 4%;
        width: 34%;
        animation: auth-float 10s ease-in-out infinite reverse;
      }

      .auth-card--chip {
        left: 14%;
        bottom: -1%;
        flex-direction: row;
        align-items: center;
        gap: 7px;
        padding: 7px 11px;
        border-radius: 999px;
        animation: auth-float 12s ease-in-out infinite;
      }

      @keyframes auth-float {
        0%, 100% { margin-top: 0; }
        50% { margin-top: -12px; }
      }
      @keyframes auth-sheen {
        0%, 62% { transform: translateX(-120%); }
        88%, 100% { transform: translateX(130%); }
      }

      .auth-orbit {
        transform-origin: 110px 75px;
        animation-name: auth-orbit-spin;
        animation-timing-function: linear;
        animation-iteration-count: infinite;
      }
      @keyframes auth-orbit-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      .auth-node {
        transform-box: fill-box;
        transform-origin: center;
        animation: auth-node-pulse 3.2s ease-in-out infinite;
        filter: drop-shadow(0 0 5px rgba(34,211,238,.35));
      }
      @keyframes auth-node-pulse {
        0%, 100% { transform: scale(.9); opacity: .8; }
        50% { transform: scale(1.12); opacity: 1; }
      }

      .auth-submit { box-shadow: 0 0 26px -8px rgba(59,191,247,.55); }

      @media (prefers-reduced-motion: reduce) {
        .auth-window,
        .auth-card,
        .auth-card-sheen,
        .auth-orbit,
        .auth-node { animation: none !important; }
      }
    `}</style>
  );
}