// frontend/src/components/Reactions/ReactionsHero.jsx
//
// Hero content for the top of the Reactions tab — no card/box around
// it; it sits directly on the page's own dark-purple ambient background
// (see the fixed glow layer in ReactionsPage.jsx) so the theme reads as
// one continuous page rather than a boxed banner. An eyebrow badge, big
// two-line gradient headline, and a clickable flask-and-bubbles accent
// sit on the left; two vertical columns of reaction tiles drift past
// each other (one up, one down) on the right.
//
// The section itself is capped to roughly one viewport tall (via a
// fixed height, no visible border) purely so the counter-scrolling
// columns have bounded space to clip into — it never grows past that,
// but nothing about it looks like a distinct block. Tapping a tile
// hands the reaction up to the parent, which opens ReactionDetailModal
// as a popup.

import { useMemo, useState } from 'react';
import { motion, useAnimationControls } from 'framer-motion';
import { FlaskConical } from 'lucide-react';
import GlitchText from '../motion/GlitchText';

// Cycled by index rather than matched against reaction.category, since
// categories are free-form (Substitution, Elimination, Pericyclic…) and
// this only needs to read as "colorful mosaic", not a legend. Tiles stay
// light/white on purpose — they read as little chips floating on the
// dark hero, the same way the reaction library's data reads on paper.
const TILE_ACCENTS = [
  { text: 'text-purple-600', border: 'border-purple-200', bg: 'bg-purple-50' },
  { text: 'text-fuchsia-600', border: 'border-fuchsia-200', bg: 'bg-fuchsia-50' },
  { text: 'text-violet-600', border: 'border-violet-200', bg: 'bg-violet-50' },
  { text: 'text-indigo-600', border: 'border-indigo-200', bg: 'bg-indigo-50' },
];

function ReactionTile({ reaction, index, onSelect }) {
  const accent = TILE_ACCENTS[index % TILE_ACCENTS.length];
  return (
    <button
      type="button"
      onClick={() => onSelect(reaction)}
      className={`mb-3 w-full shrink-0 rounded-lg border ${accent.border} ${accent.bg} bg-white/95 p-3 text-left shadow-[0_6px_16px_-6px_rgba(0,0,0,0.35)] backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_24px_-6px_rgba(168,85,247,0.5)]`}
    >
      <span className={`text-[9px] font-semibold uppercase tracking-wide ${accent.text}`}>
        {reaction.category}
      </span>
      <p className="mt-1 truncate font-display text-sm font-semibold text-purple-950">{reaction.name}</p>
      <p className="mt-0.5 truncate font-mono text-xs text-purple-400">{reaction.general_equation}</p>
    </button>
  );
}

// One vertical auto-scrolling column of reaction tiles. `direction` flips
// which way the column drifts so the two columns move opposite each
// other. Clipped by its own overflow-hidden viewport, so however tall
// the (doubled, looping) track is, it can never push the hero taller.
function ScrollColumn({ items, direction, duration, onSelect, className = '' }) {
  const doubled = [...items, ...items];
  return (
    <div className={`reaction-col-viewport ${className}`}>
      <div
        className={direction === 'up' ? 'reaction-col-track-up' : 'reaction-col-track-down'}
        style={{ animationDuration: `${duration}s` }}
      >
        {doubled.map((r, i) => (
          <ReactionTile key={`${r.id}-${i}`} reaction={r} index={i} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

// Small clickable flask sitting next to the headline. Bubbles rise out
// of it continuously; tapping it makes the flask itself tremble/jitter
// — like a little jolt of effervescence — and fires off an extra burst
// of bubbles on top of the steady stream.
function FlaskBubbles() {
  const controls = useAnimationControls();
  const [burstKey, setBurstKey] = useState(0);
  const [bursting, setBursting] = useState(false);

  const handleClick = () => {
    controls.start({
      x: [0, -3, 3, -2.5, 2.5, -1.5, 1.5, 0],
      rotate: [0, -9, 8, -6, 5, -3, 2, 0],
      transition: { duration: 0.55, ease: 'easeInOut' },
    });
    setBurstKey((k) => k + 1);
    setBursting(true);
    window.setTimeout(() => setBursting(false), 900);
  };

  const steadyBubbles = [0, 1, 2];
  const burstBubbles = bursting ? [0, 1, 2, 3, 4] : [];

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Fizz the flask"
      className="absolute left-[10.5rem] top-[0.35rem] h-9 w-9 cursor-pointer sm:left-[16rem] sm:top-[1.8rem] sm:h-16 sm:w-16"
    >
      <motion.div
        animate={controls}
        className="relative flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-purple-400 to-fuchsia-400 shadow-lg shadow-fuchsia-900/50 ring-4 ring-lab-950/60 sm:h-16 sm:w-16"
      >
        <FlaskConical size={18} className="text-white sm:hidden" />
        <FlaskConical size={24} className="hidden text-white sm:block" />

        {steadyBubbles.map((i) => (
          <motion.span
            key={`steady-${i}`}
            className="pointer-events-none absolute top-0 h-1.5 w-1.5 rounded-full bg-white/90"
            style={{ left: `${28 + i * 16}%` }}
            initial={{ y: 0, opacity: 0, scale: 0.6 }}
            animate={{ y: -28 - i * 4, opacity: [0, 1, 0], scale: [0.6, 1, 0.8] }}
            transition={{ duration: 2.2 + i * 0.4, repeat: Infinity, delay: i * 0.5, ease: 'easeOut' }}
          />
        ))}

        {burstBubbles.map((i) => (
          <motion.span
            key={`burst-${burstKey}-${i}`}
            className="pointer-events-none absolute top-1 h-1 w-1 rounded-full bg-white"
            style={{ left: `${12 + i * 18}%` }}
            initial={{ y: 0, x: 0, opacity: 1, scale: 0.7 }}
            animate={{ y: -30 - i * 5, x: (i - 2) * 4, opacity: 0, scale: 0.4 }}
            transition={{ duration: 0.8 + i * 0.08, ease: 'easeOut' }}
          />
        ))}
      </motion.div>
    </button>
  );
}

export default function ReactionsHero({ reactions = [], onSelect, loading }) {
  const [colA, colB] = useMemo(() => {
    if (!reactions.length) return [[], []];
    const mid = Math.ceil(reactions.length / 2);
    return [reactions.slice(0, mid), reactions.slice(mid)];
  }, [reactions]);

  return (
    <section className="relative w-full sm:h-[min(88vh,760px)] sm:min-h-[560px]">
      <div className="relative z-10 grid grid-cols-1 sm:h-full lg:grid-cols-2">
        {/* Left: headline. On sm+ (where the section has a fixed height and
            the counter-scrolling tile columns sit alongside it) this is
            shifted up a bit within its centered flex box via translate —
            rather than fighting justify-center — since the badge/headline
            block otherwise sits visibly lower than those columns. On phones
            the section has no forced height at all (the columns are hidden
            below sm anyway), so this just flows naturally top-to-bottom
            with its own compact padding instead of sitting centered in a
            tall, mostly-empty box. */}
        <div className="flex flex-col justify-center px-5 py-7 sm:-translate-y-10 sm:px-10 sm:py-10">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-purple-500/30 bg-lab-900/60 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-purple-300 sm:text-sm">
            <span className="h-2 w-2 rounded-full bg-purple-400" /> Reaction Library
          </span>

          <div className="relative mt-4 w-fit max-w-2xl sm:mt-5">
            <h1 className="font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-7xl sm:leading-[1.02] lg:text-8xl">
              <GlitchText
                as="span"
                className="bg-gradient-to-r from-fuchsia-400 to-purple-300 bg-clip-text text-transparent"
                text="Every mechanism,"
              />
              <br />
              <GlitchText
                as="span"
                className="bg-gradient-to-r from-violet-300 to-fuchsia-200 bg-clip-text text-transparent"
                text="on demand."
                delayMs={180}
              />
            </h1>
            <FlaskBubbles />
          </div>

          <p className="mt-4 max-w-md text-sm leading-relaxed text-lab-400 sm:mt-6 sm:text-base lg:text-lg">
            Named reactions, electron-pushing arrows, and step-by-step mechanisms — tap any card
            to open it, or scroll down to search the full library.
          </p>
        </div>

        {/* Right: two counter-scrolling columns of reaction tiles. Only
            this inner strip clips overflow (so the endless scrolling
            track can't grow the page) — no border/background box
            around it, so it reads as part of the page, not a card. */}
        <div className="hidden h-full gap-3 overflow-hidden p-4 sm:flex">
          {colA.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <span className="hero-loading-pulse block h-2.5 w-2.5 rounded-full bg-purple-400" />
            </div>
          ) : (
            <>
              <ScrollColumn items={colA} direction="up" duration={Math.max(18, colA.length * 3.5)} onSelect={onSelect} />
              <ScrollColumn items={colB} direction="down" duration={Math.max(20, colB.length * 3.8)} onSelect={onSelect} />
            </>
          )}
        </div>
      </div>

      <style>{`
        .reaction-col-viewport {
          position: relative;
          flex: 1 1 0%;
          height: 100%;
          overflow: hidden;
          -webkit-mask-image: linear-gradient(to bottom, transparent, black 8%, black 92%, transparent);
          mask-image: linear-gradient(to bottom, transparent, black 8%, black 92%, transparent);
        }
        .reaction-col-track-up, .reaction-col-track-down {
          display: flex;
          flex-direction: column;
          width: 100%;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          will-change: transform;
        }
        .reaction-col-track-up { animation-name: reaction-col-scroll-up; }
        .reaction-col-track-down { animation-name: reaction-col-scroll-down; }
        @keyframes reaction-col-scroll-up {
          from { transform: translate3d(0, 0, 0); }
          to { transform: translate3d(0, -50%, 0); }
        }
        @keyframes reaction-col-scroll-down {
          from { transform: translate3d(0, -50%, 0); }
          to { transform: translate3d(0, 0, 0); }
        }
        .reaction-col-viewport:hover .reaction-col-track-up,
        .reaction-col-viewport:hover .reaction-col-track-down {
          animation-play-state: paused;
        }

        .hero-loading-pulse { animation: hero-loading-pulse 1.1s ease-in-out infinite; }
        @keyframes hero-loading-pulse {
          0%, 100% { opacity: 0.35; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.15); }
        }

        @media (prefers-reduced-motion: reduce) {
          .reaction-col-track-up, .reaction-col-track-down, .hero-loading-pulse {
            animation-play-state: paused;
          }
        }
      `}</style>
    </section>
  );
}