import { useId } from 'react';
import { Link } from 'react-router-dom';

// A small, self-contained animated lockup for the "MoleIt" name, meant
// to replace a plain icon+text pairing wherever the brand needs to
// stand out (navbar, homepage banner, etc). Three things move, each on
// its own loop so nothing feels mechanically synced:
//   1. A tiny molecule badge (three atoms on bonds) spinning slowly.
//   2. The "It" in the wordmark shimmering with a moving gradient.
//   3. A hand-drawn-looking underline that traces itself in a loop.
//
// `size` picks a preset scale ('sm' for the navbar, 'lg' for a hero
// banner, 'hero' for the homepage's big lockup). Pass `to="/"` to render the whole lockup as a router Link;
// omit it to render as a plain, non-interactive span (e.g. when it's
// just a decorative wordmark inside a card that isn't itself a link).
const SIZE_PRESETS = {
  sm: {
    badge: 'h-9 w-9',
    rounded: 'rounded-xl',
    text: 'text-lg',
    gap: 'gap-2.5',
    underlineWidth: 72,
    underlineHeight: 6,
    lift: '1px',
  },
  lg: {
    badge: 'h-14 w-14',
    rounded: 'rounded-2xl',
    text: 'text-3xl sm:text-4xl',
    gap: 'gap-4',
    underlineWidth: 130,
    underlineHeight: 10,
    lift: '1.6px',
  },
  xl: {
    badge: 'h-20 w-20 sm:h-24 sm:w-24',
    rounded: 'rounded-3xl',
    text: 'text-5xl sm:text-6xl',
    gap: 'gap-5 sm:gap-6',
    underlineWidth: 190,
    underlineHeight: 14,
    lift: '2px',
  },
  // Homepage hero lockup — scales with the viewport like the big headline
  // it stands in for. The underline stretches to the wordmark's width.
  hero: {
    badge: 'h-[clamp(4.5rem,10vw,9.5rem)] w-[clamp(4.5rem,10vw,9.5rem)]',
    rounded: 'rounded-[28%]',
    text: 'text-[clamp(3.25rem,9.3vw,9rem)]',
    gap: 'gap-[clamp(1rem,2.4vw,2.4rem)]',
    underlineWidth: 380,
    underlineHeight: 22,
    lift: 'clamp(2.5px, 0.42vw, 4.5px)',
    fluidUnderline: true,
  },
};

// tone="dark"  (default) — for dark surfaces: neon atoms, near-white wordmark.
// tone="light" — for the warm-paper homepage: the ORIGINAL brand colours (teal /
//                violet / pink atoms, cyan→violet "It" and underline) with the
//                wordmark in charcoal so it reads on paper.
// Both tones put the molecule on a white, raised 3D tile (see .moleit-logo-tile).
const TONES = {
  dark: {
    badge: 'moleit-logo-tile',
    word: 'text-lab-100',
    bond: ['rgba(20,184,166,0.6)', 'rgba(139,92,246,0.6)', 'rgba(236,72,153,0.55)'],
    atom: ['#14b8a6', '#8b5cf6', '#ec4899'],
    core: '#06b6d4',
    gradient: ['#22d3ee', '#a78bfa'],
    itClass: 'moleit-logo-shimmer',
  },
  light: {
    badge: 'moleit-logo-tile',
    word: 'text-[#262626]',
    bond: ['rgba(20,184,166,0.6)', 'rgba(139,92,246,0.6)', 'rgba(236,72,153,0.55)'],
    atom: ['#14b8a6', '#8b5cf6', '#ec4899'],
    core: '#06b6d4',
    gradient: ['#22d3ee', '#a78bfa'],
    itClass: 'moleit-logo-shimmer-light',
  },
};

export default function MoleItLogo({ size = 'sm', to, className = '', tone = 'dark' }) {
  const cfg = SIZE_PRESETS[size] ?? SIZE_PRESETS.sm;
  const t = TONES[tone] ?? TONES.dark;
  const gradientId = `moleit-underline-gradient-${useId()}`;
  const Wrapper = to ? Link : 'span';
  const wrapperProps = to ? { to } : {};

  return (
    <Wrapper
      {...wrapperProps}
      className={`moleit-logo moleit-logo--${tone} inline-flex shrink-0 items-center ${cfg.gap} ${className}`}
    >
      {/* Animated molecule badge */}
      <span
        className={`relative flex ${cfg.badge} shrink-0 items-center justify-center ${cfg.rounded} ${t.badge}`}
        style={{ '--lift': cfg.lift }}
      >
        <svg viewBox="0 0 40 40" className="moleit-logo-icon h-[68%] w-[68%] overflow-visible">
          <g className="moleit-logo-spin" style={{ transformOrigin: '20px 20px', transformBox: 'view-box' }}>
            <line x1="20" y1="20" x2="9" y2="12" stroke={t.bond[0]} strokeWidth="1.6" />
            <line x1="20" y1="20" x2="31" y2="12" stroke={t.bond[1]} strokeWidth="1.6" />
            <line x1="20" y1="20" x2="20" y2="33" stroke={t.bond[2]} strokeWidth="1.6" />
            <circle cx="9" cy="12" r="3.4" fill={t.atom[0]} className="moleit-logo-atom" style={{ animationDelay: '0s' }} />
            <circle cx="31" cy="12" r="3.4" fill={t.atom[1]} className="moleit-logo-atom" style={{ animationDelay: '.4s' }} />
            <circle cx="20" cy="33" r="3" fill={t.atom[2]} className="moleit-logo-atom" style={{ animationDelay: '.8s' }} />
          </g>
          <circle cx="20" cy="20" r="4.2" fill={t.core} className="moleit-logo-core" />
        </svg>
      </span>

      {/* Wordmark + self-drawing underline */}
      <span className="flex flex-col">
        <span className={`font-display ${cfg.text} font-bold leading-none tracking-tight ${t.word}`}>
          Mole<span className={t.itClass}>It</span>
        </span>
        <svg
          viewBox={`0 0 ${cfg.underlineWidth} ${cfg.underlineHeight}`}
          width={cfg.fluidUnderline ? undefined : cfg.underlineWidth}
          height={cfg.fluidUnderline ? undefined : cfg.underlineHeight}
          className="mt-1 overflow-visible"
          style={cfg.fluidUnderline ? { width: 0, minWidth: '100%', height: 'auto' } : undefined}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={t.gradient[0]} />
              <stop offset="100%" stopColor={t.gradient[1]} />
            </linearGradient>
          </defs>
          <path
            d={`M1,${cfg.underlineHeight - 1} Q${cfg.underlineWidth * 0.28},1 ${cfg.underlineWidth * 0.5},${cfg.underlineHeight / 2} T${cfg.underlineWidth - 1},${cfg.underlineHeight - 1}`}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth="2"
            strokeLinecap="round"
            pathLength="1"
            className="moleit-logo-underline"
          />
        </svg>
      </span>

      <style>{`
        /* White tile that "comes up" off the page: stacked hard shadows form a
           solid extruded edge, a soft shadow below lifts it, and an inner
           highlight/shade gives the face a slight bevel. Lifts further on hover. */
        .moleit-logo-tile {
          background: linear-gradient(145deg, #ffffff 0%, #f6f4f1 55%, #eceae6 100%);
          box-shadow:
            inset 0 calc(var(--lift) * 0.7) 0 rgba(255, 255, 255, 1),
            inset 0 calc(var(--lift) * -1.2) calc(var(--lift) * 2) rgba(0, 0, 0, 0.07),
            0 var(--lift) 0 #dedad5,
            0 calc(var(--lift) * 2) 0 #d2cdc7,
            0 calc(var(--lift) * 3) 0 #c6c1ba,
            0 calc(var(--lift) * 4) calc(var(--lift) * 2) rgba(0, 0, 0, 0.18),
            0 calc(var(--lift) * 8) calc(var(--lift) * 9) rgba(0, 0, 0, 0.28);
          transform: translateY(calc(var(--lift) * -1.5));
          transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .moleit-logo:hover .moleit-logo-tile {
          transform: translateY(calc(var(--lift) * -2.5)) scale(1.04);
          box-shadow:
            inset 0 calc(var(--lift) * 0.7) 0 rgba(255, 255, 255, 1),
            inset 0 calc(var(--lift) * -1.2) calc(var(--lift) * 2) rgba(0, 0, 0, 0.07),
            0 var(--lift) 0 #dedad5,
            0 calc(var(--lift) * 2) 0 #d2cdc7,
            0 calc(var(--lift) * 3) 0 #c6c1ba,
            0 calc(var(--lift) * 5) calc(var(--lift) * 3) rgba(0, 0, 0, 0.2),
            0 calc(var(--lift) * 11) calc(var(--lift) * 12) rgba(0, 0, 0, 0.3);
        }
        .moleit-logo-icon {
          filter: drop-shadow(0 calc(var(--lift) * 0.8) calc(var(--lift) * 1.2) rgba(0, 0, 0, 0.22));
        }

        .moleit-logo-spin { animation: moleit-spin 9s linear infinite; }
        @keyframes moleit-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        .moleit-logo-atom {
          animation: moleit-atom-pulse 2.4s ease-in-out infinite;
          transform-origin: center;
          transform-box: fill-box;
        }
        @keyframes moleit-atom-pulse {
          0%, 100% { opacity: .65; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.15); }
        }

        .moleit-logo-core {
          animation: moleit-core-pulse 2.4s ease-in-out infinite;
          transform-origin: center;
          transform-box: fill-box;
          filter: drop-shadow(0 0 4px rgba(34,211,238,.8));
        }
        @keyframes moleit-core-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.18); }
        }

        .moleit-logo-shimmer {
          background-image: linear-gradient(100deg, #22d3ee 20%, #a78bfa 40%, #ffffff 50%, #a78bfa 60%, #22d3ee 80%);
          background-size: 250% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: moleit-shimmer 3.5s linear infinite;
        }
        @keyframes moleit-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }

        /* same cyan→violet "It" as the original, minus the white band
           (which would vanish on the light page) */
        .moleit-logo-shimmer-light {
          background-image: linear-gradient(100deg, #22d3ee 0%, #a78bfa 50%, #22d3ee 100%);
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: moleit-shimmer 3.5s linear infinite;
        }

        .moleit-logo-underline {
          stroke-dasharray: 1;
          animation: moleit-underline-draw 3.5s ease-in-out infinite;
        }
        @keyframes moleit-underline-draw {
          0% { stroke-dashoffset: 1; opacity: 0; }
          15% { opacity: 1; }
          55% { stroke-dashoffset: 0; opacity: 1; }
          85% { opacity: 1; }
          100% { stroke-dashoffset: -1; opacity: 0; }
        }

        @media (prefers-reduced-motion: reduce) {
          .moleit-logo-spin,
          .moleit-logo-atom,
          .moleit-logo-core,
          .moleit-logo-shimmer,
          .moleit-logo-shimmer-light,
          .moleit-logo-underline {
            animation: none !important;
          }
          .moleit-logo-tile { transition: none !important; }
        }
      `}</style>
    </Wrapper>
  );
}