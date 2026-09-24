// frontend/src/components/DrawLab/DrawLabIntro.jsx
//
// One-shot "entering the lab" intro that plays for ~3s every time
// DrawLabPage mounts, then fades itself out to reveal the workspace
// underneath. Visually it's a restrained hyperspace-jump: thin light
// streaks radiating outward from a center molecule mark, a
// boot-sequence style status line, and a progress bar timed to the
// same window — deliberately no bounce/spring easing or playful copy,
// so it reads as a professional loading sequence rather than a gag.
//
// Respects prefers-reduced-motion: skips the streak field entirely and
// finishes almost immediately with just a plain fade.

import { useEffect, useMemo, useRef, useState } from 'react';

const STATUS_LINES = ['Initializing canvas…', 'Loading atom palette…', 'Calibrating 3D viewer…'];

function useWarpStreaks(count) {
  return useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        angle: (360 / count) * i + (Math.random() * 10 - 5),
        dist: 260 + Math.random() * 220,
        length: 60 + Math.random() * 90,
        dur: 1.1 + Math.random() * 0.9,
        delay: Math.random() * 1.6,
        color: ['rgba(94,234,212,0.9)', 'rgba(34,211,238,0.9)', 'rgba(167,139,250,0.9)'][i % 3],
      })),
    [count]
  );
}

export default function DrawLabIntro({ onFinish, durationMs = 3000 }) {
  const [exiting, setExiting] = useState(false);
  const prefersReduced = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  const streaks = useWarpStreaks(prefersReduced.current ? 0 : 28);

  useEffect(() => {
    const total = prefersReduced.current ? 700 : durationMs;
    const exitLead = prefersReduced.current ? 250 : 350;
    const exitTimer = window.setTimeout(() => setExiting(true), total - exitLead);
    const doneTimer = window.setTimeout(() => onFinish?.(), total);
    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(doneTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`drawlab-intro fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-lab-950 ${
        exiting ? 'drawlab-intro-exit' : ''
      }`}
      role="status"
      aria-live="polite"
      aria-label="Entering Draw Lab"
    >
      <div className="grid-paper pointer-events-none absolute inset-0 opacity-40" />

      {streaks.map((s) => (
        <span
          key={s.id}
          className="drawlab-warp-streak"
          style={{
            width: `${s.length}px`,
            background: `linear-gradient(90deg, transparent, ${s.color}, transparent)`,
            '--angle': `${s.angle}deg`,
            '--dist': `${s.dist}px`,
            '--dur': `${s.dur}s`,
            '--delay': `${s.delay}s`,
          }}
        />
      ))}

      <div className="relative z-10 flex flex-col items-center gap-5 px-6 text-center">
        <span className="drawlab-intro-badge relative flex h-16 w-16 items-center justify-center rounded-full border border-cyan-400/30 bg-gradient-to-br from-cyan-400/15 to-violet-500/15">
          <svg viewBox="0 0 40 40" className="h-[62%] w-[62%] overflow-visible">
            <g style={{ transformOrigin: '20px 20px' }} className="drawlab-intro-spin">
              <line x1="20" y1="20" x2="9" y2="12" stroke="rgba(94,234,212,0.75)" strokeWidth="1.8" />
              <line x1="20" y1="20" x2="31" y2="12" stroke="rgba(167,139,250,0.75)" strokeWidth="1.8" />
              <line x1="20" y1="20" x2="20" y2="33" stroke="rgba(236,72,153,0.65)" strokeWidth="1.8" />
              <circle cx="9" cy="12" r="3.6" fill="#5eead4" />
              <circle cx="31" cy="12" r="3.6" fill="#a78bfa" />
              <circle cx="20" cy="33" r="3.2" fill="#ec4899" />
            </g>
            <circle cx="20" cy="20" r="4.6" fill="#22d3ee" />
          </svg>
          <span className="drawlab-intro-ring absolute inset-0 rounded-full" />
        </span>

        <div>
          <p className="font-display text-lg font-bold uppercase tracking-[0.4em] text-lab-100 sm:text-xl">
            Entering Draw Lab
          </p>
          <div className="relative mt-2 h-4">
            {STATUS_LINES.map((line, i) => (
              <p
                key={line}
                className="drawlab-intro-status absolute inset-x-0 font-mono text-[11px] uppercase tracking-widest text-lab-400"
                style={{ animationDelay: `${(i * durationMs) / STATUS_LINES.length / 1000}s` }}
              >
                {line}
              </p>
            ))}
          </div>
        </div>

        <div className="h-[2px] w-48 overflow-hidden rounded-full bg-white/10 sm:w-64">
          <div
            className="drawlab-intro-bar h-full w-full origin-left bg-gradient-to-r from-cyan-400 to-violet-400"
            style={{ animationDuration: `${durationMs}ms` }}
          />
        </div>
      </div>

      <style>{`
        .drawlab-warp-streak {
          position: absolute;
          top: 50%;
          left: 50%;
          height: 2px;
          transform-origin: left center;
          transform: translate(0, -50%) rotate(var(--angle)) translateX(0);
          opacity: 0;
          animation: drawlab-warp-streak var(--dur) linear var(--delay) infinite;
        }
        @keyframes drawlab-warp-streak {
          0% { transform: translate(0, -50%) rotate(var(--angle)) translateX(0); opacity: 0; }
          12% { opacity: 0.85; }
          82% { opacity: 0.85; }
          100% { transform: translate(0, -50%) rotate(var(--angle)) translateX(var(--dist)); opacity: 0; }
        }

        .drawlab-intro-spin { animation: drawlab-intro-spin 2.4s linear infinite; }
        @keyframes drawlab-intro-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        .drawlab-intro-ring {
          box-shadow: 0 0 0 0 rgba(34,211,238,0.45);
          animation: drawlab-intro-ring-pulse 1.8s ease-out infinite;
        }
        @keyframes drawlab-intro-ring-pulse {
          0% { box-shadow: 0 0 0 0 rgba(34,211,238,0.45); }
          100% { box-shadow: 0 0 0 18px rgba(34,211,238,0); }
        }

        .drawlab-intro-status {
          opacity: 0;
          animation: drawlab-intro-status-cycle ${durationMs}ms ease-in-out infinite;
        }
        @keyframes drawlab-intro-status-cycle {
          0% { opacity: 0; transform: translateY(3px); }
          8% { opacity: 1; transform: translateY(0); }
          28% { opacity: 1; }
          36% { opacity: 0; }
          100% { opacity: 0; }
        }

        .drawlab-intro-bar {
          animation: drawlab-intro-bar-fill linear forwards;
        }
        @keyframes drawlab-intro-bar-fill {
          from { transform: scaleX(0); }
          to { transform: scaleX(1); }
        }

        .drawlab-intro-exit {
          animation: drawlab-intro-out 0.35s ease-in both;
        }
        @keyframes drawlab-intro-out {
          from { opacity: 1; transform: scale(1); filter: blur(0); }
          to { opacity: 0; transform: scale(1.04); filter: blur(6px); }
        }

        @media (prefers-reduced-motion: reduce) {
          .drawlab-warp-streak { display: none; }
          .drawlab-intro-spin, .drawlab-intro-ring, .drawlab-intro-status, .drawlab-intro-bar { animation: none; opacity: 1; }
          .drawlab-intro-exit { animation: none; }
        }
      `}</style>
    </div>
  );
}