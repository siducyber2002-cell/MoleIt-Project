import { useId, useRef, useState, useCallback, useEffect } from 'react';

/**
 * Interactive quantum atom visual — three elliptical orbital planes crossing
 * through a glowing nucleus. Each ring itself precesses/spins (like the
 * classic atom logo), and each electron sweeps along its own ring's exact
 * ellipse path (position computed each frame in JS), riding along with the ring's
 * rotation since it's nested in the same rotating group — so ring + electron
 * always stay locked together, just tumbling through space at different
 * speeds and directions so it never looks mechanically synced.
 *
 * Interactions:
 *  - Hover: zooms in slightly, boosts nucleus glow, and speeds orbit spin +
 *    electron sweep ~2x
 *  - Click / Enter / Space: triggers a ~4x "turbo" burst with a neon
 *    "KEEP ON LEARNING" overlay that pops in big, settles back to normal
 *    size, holds, then fades out and auto-resets after ~3s
 *
 * Pure SVG + CSS, no external dependencies.
 */
// tone="dark"  (default) — neon cyan / violet / pink on dark surfaces.
// tone="light" — sky-blue / orange / charcoal for the warm-paper homepage.
// `size` is a pixel number, or any CSS size string (e.g. '100%') to fill a box.
const TONES = {
  dark: {
    ring: ['rgba(103,232,249,0.4)', 'rgba(167,139,250,0.4)', 'rgba(236,72,153,0.35)'],
    electron: ['#67e8f9', '#c4b5fd', '#f9a8d4'],
    glow: '#67e8f9',
    core: '#ecfeff',
    text: '#ecfeff',
    textShadow: '0 0 6px #67e8f9, 0 0 16px #67e8f9, 0 0 32px #a78bfa, 0 0 2px #fff',
    textBg: 'transparent',
  },
  light: {
    ring: ['rgba(38,38,38,0.38)', 'rgba(38,38,38,0.38)', 'rgba(38,38,38,0.38)'],
    electron: ['#3bbff7', '#eea02b', '#262626'],
    glow: '#3bbff7',
    core: '#262626',
    text: '#262626',
    textShadow: 'none',
    textBg: '#eea02b',
  },
};

// Orbit geometry — must match the ring <path> ellipse below (centre 100,100; rx 84, ry 30).
const ORBIT_CX = 100;
const ORBIT_CY = 100;
const ORBIT_RX = 84;
const ORBIT_RY = 30;
// Electron starting phases (0..1 of a lap) — same offsets the old begin="-Ns" values gave.
const START_PHASE = [0, 2 / 7.5, 4 / 9];
const ELECTRON_BASE_DUR = [5.5, 7.5, 9];

// Ring path starts at the left tip (16,100) and sweeps clockwise, i.e. angle = PI + phase*2PI.
const electronPos = (phase) => {
  const a = Math.PI + phase * Math.PI * 2;
  return { x: ORBIT_CX + ORBIT_RX * Math.cos(a), y: ORBIT_CY + ORBIT_RY * Math.sin(a) };
};

export default function QuantumOrbitAnimation({ size = 280, className = '', tone = 'dark' }) {
  const t = TONES[tone] ?? TONES.dark;
  const numericSize = typeof size === 'number' ? size : 280;
  const uid = useId();
  const orbit1Id = `quantum-orbit-1-${uid}`;
  const orbit2Id = `quantum-orbit-2-${uid}`;
  const orbit3Id = `quantum-orbit-3-${uid}`;
  const glowId = `quantum-nucleus-glow-${uid}`;

  const [hovered, setHovered] = useState(false);
  const [turbo, setTurbo] = useState(false);
  const [turboKey, setTurboKey] = useState(0);
  const turboTimeoutRef = useRef(null);

  // Electron dots are moved by a rAF loop (not SVG SMIL motion): SMIL leaves them at
  // (0,0) of the ring for the first moments after load, which showed up as stray dots
  // outside the orbits. Initial positions are rendered in the JSX below, so frame 1 is correct.
  const electronRefs = [useRef(null), useRef(null), useRef(null)];
  const phaseRef = useRef([...START_PHASE]);
  const speedRef = useRef(1);

  // Base durations (seconds) at idle speed
  const baseElectronDurations = { orbit1: 5.5, orbit2: 7.5, orbit3: 9 };
  const baseRingDurations = { ring1: 6, ring2: 8.5, ring3: 11 };
  const basePulse = 2.4;

  // Speed multiplier: idle = 1x, hover = ~2x, turbo = ~4x
  const speedFactor = turbo ? 4 : hovered ? 2 : 1;
  speedRef.current = speedFactor;

  const electronDur = {
    orbit1: baseElectronDurations.orbit1 / speedFactor,
    orbit2: baseElectronDurations.orbit2 / speedFactor,
    orbit3: baseElectronDurations.orbit3 / speedFactor,
  };
  const ringDur = {
    ring1: baseRingDurations.ring1 / speedFactor,
    ring2: baseRingDurations.ring2 / speedFactor,
    ring3: baseRingDurations.ring3 / speedFactor,
  };
  const pulseDur = basePulse / (turbo ? 2.5 : hovered ? 1.4 : 1);

  const triggerTurbo = useCallback(() => {
    setTurbo(true);
    setTurboKey((k) => k + 1); // forces the text span to remount so the pop animation replays every click
    if (turboTimeoutRef.current) clearTimeout(turboTimeoutRef.current);
    turboTimeoutRef.current = setTimeout(() => {
      setTurbo(false);
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (turboTimeoutRef.current) clearTimeout(turboTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return undefined;

    let raf = 0;
    let last = 0;
    const tick = (now) => {
      if (!last) last = now;
      // clamp dt so a background-tab pause doesn't cause a big jump
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const phases = phaseRef.current;
      for (let i = 0; i < 3; i += 1) {
        phases[i] = (phases[i] + (dt * speedRef.current) / ELECTRON_BASE_DUR[i]) % 1;
        const el = electronRefs[i].current;
        if (el) {
          const { x, y } = electronPos(phases[i]);
          el.setAttribute('cx', x.toFixed(2));
          el.setAttribute('cy', y.toFixed(2));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      triggerTurbo();
    }
  };

  return (
    <button
      type="button"
      onClick={triggerTurbo}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      aria-label="Quantum atom animation. Activate to trigger turbo mode."
      className={`relative border-0 bg-transparent p-0 cursor-pointer ${className}`}
      style={{
        width: size,
        height: size,
        transform: hovered || turbo ? 'scale(1.08)' : 'scale(1)',
        transition: 'transform 0.4s ease-out',
      }}
    >
      <svg viewBox="0 0 200 200" className="h-full w-full overflow-visible">
        <defs>
          <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
            <stop
              offset="0%"
              stopColor={t.glow}
              stopOpacity={turbo ? 1 : hovered ? 0.95 : 0.9}
            />
            <stop offset="45%" stopColor={t.glow} stopOpacity="0.25" />
            <stop offset="100%" stopColor={t.glow} stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Ring 1 — flat plane, spins one way */}
        <g stroke={t.ring[0]} fill="none">
          <g
            className="quantum-ring-spin"
            style={{
              transformOrigin: '100px 100px',
              transformBox: 'view-box',
              animationDuration: `${ringDur.ring1}s`,
              animationDirection: 'normal',
            }}
          >
            <path
              id={orbit1Id}
              d="M16,100 A84,30 0 1,1 184,100 A84,30 0 1,1 16,100"
              strokeWidth="1.2"
            />
            <circle
              ref={electronRefs[0]}
              r="4"
              cx={electronPos(START_PHASE[0]).x}
              cy={electronPos(START_PHASE[0]).y}
              fill={t.electron[0]}
            />
          </g>
        </g>

        {/* Ring 2 — tilted +60deg plane, spins opposite way */}
        <g stroke={t.ring[1]} fill="none" transform="rotate(60 100 100)">
          <g
            className="quantum-ring-spin"
            style={{
              transformOrigin: '100px 100px',
              transformBox: 'view-box',
              animationDuration: `${ringDur.ring2}s`,
              animationDirection: 'reverse',
            }}
          >
            <path
              id={orbit2Id}
              d="M16,100 A84,30 0 1,1 184,100 A84,30 0 1,1 16,100"
              strokeWidth="1.2"
            />
            <circle
              ref={electronRefs[1]}
              r="3.6"
              cx={electronPos(START_PHASE[1]).x}
              cy={electronPos(START_PHASE[1]).y}
              fill={t.electron[1]}
            />
          </g>
        </g>

        {/* Ring 3 — tilted -60deg plane, spins with ring 1 */}
        <g stroke={t.ring[2]} fill="none" transform="rotate(-60 100 100)">
          <g
            className="quantum-ring-spin"
            style={{
              transformOrigin: '100px 100px',
              transformBox: 'view-box',
              animationDuration: `${ringDur.ring3}s`,
              animationDirection: 'normal',
            }}
          >
            <path
              id={orbit3Id}
              d="M16,100 A84,30 0 1,1 184,100 A84,30 0 1,1 16,100"
              strokeWidth="1.2"
            />
            <circle
              ref={electronRefs[2]}
              r="3.2"
              cx={electronPos(START_PHASE[2]).x}
              cy={electronPos(START_PHASE[2]).y}
              fill={t.electron[2]}
            />
          </g>
        </g>

        {/* Nucleus glow + core */}
        <circle
          cx="100"
          cy="100"
          r="30"
          fill={`url(#${glowId})`}
          className="quantum-nucleus-pulse"
          style={{ animationDuration: `${pulseDur}s` }}
        />
        <circle cx="100" cy="100" r="5.5" fill={t.core} />
      </svg>

      {/* Turbo overlay text */}
      <div
        aria-hidden={!turbo}
        className="pointer-events-none absolute inset-0 flex items-center justify-center px-2"
        style={{
          opacity: turbo ? 1 : 0,
          transition: turbo ? 'opacity 0.35s ease-in' : 'opacity 0.6s ease-out',
        }}
      >
        <span
          key={turboKey}
          className="quantum-text-pop"
          style={{
            // Scales with the component's own size, but capped on both
            // ends so it never forces a single-line width bigger than
            // the box itself (that's what was pushing text past the
            // left/right edges on the 200px mobile variant).
            fontSize: `clamp(11px, ${numericSize * 0.062}px, 28px)`,
            fontWeight: 700,
            letterSpacing: '0.05em',
            color: t.text,
            textShadow: t.textShadow,
            background: t.textBg,
            borderRadius: '0.2em',
            padding: t.textBg === 'transparent' ? 0 : '0.12em 0.4em',
            textAlign: 'center',
            lineHeight: 1.15,
            // No more nowrap — letting it wrap onto two lines (e.g.
            // "KEEP ON" / "LEARNING") is what keeps it inside the
            // button's own box on small sizes instead of overflowing.
            maxWidth: '90%',
            display: 'inline-block',
          }}
        >
          KEEP ON LEARNING
        </span>
      </div>

      <style>{`
        .quantum-ring-spin {
          animation-name: quantum-ring-rotate;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        @keyframes quantum-ring-rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .quantum-nucleus-pulse {
          animation-name: quantum-pulse;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
          transform-origin: 100px 100px;
          transform-box: view-box;
        }
        @keyframes quantum-pulse {
          0%, 100% { opacity: .7; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.15); }
        }

        .quantum-text-pop {
          animation: quantum-text-pop 0.9s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes quantum-text-pop {
          0% { transform: scale(0.3); }
          18% { transform: scale(1.55); }
          38% { transform: scale(0.88); }
          55% { transform: scale(1.1); }
          75% { transform: scale(0.98); }
          100% { transform: scale(1); }
        }

        @media (prefers-reduced-motion: reduce) {
          .quantum-nucleus-pulse,
          .quantum-ring-spin,
          .quantum-text-pop {
            animation: none;
          }
        }
      `}</style>
    </button>
  );
}