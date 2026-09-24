import { useId } from 'react';

/**
 * Animated stand-in for the old `group-theory.png.png` screenshot in the
 * homepage hero coverflow. Instead of a generic atom-orbit graphic, this
 * actually depicts a group-theory idea: a trigonal (AX3) molecule spinning
 * through its C3 rotation axis, plus a dashed σv mirror plane with a faint
 * reflected "ghost" copy fading in and out — the two symmetry operations
 * that define a C3v point group.
 *
 * Pure SVG + CSS, fills its container edge-to-edge like the image it
 * replaces (object-fit: cover), so it drops straight into `.gallery-tile`.
 */
export default function GroupTheoryTileVisual({ className = '' }) {
  const uid = useId();
  const bgId = `gt-bg-${uid}`;
  const dotId = `gt-dots-${uid}`;

  const cx = 160;
  const cy = 104;
  const r = 46;
  // Three outer atoms at 90/210/330 degrees — a trigonal planar arrangement.
  const points = [-90, 30, 150].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  });

  return (
    <div className={`gt-visual ${className}`} aria-hidden="true">
      <svg viewBox="0 0 320 208" className="gt-visual__svg" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id={bgId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#3730a3" />
          </linearGradient>
          <pattern id={dotId} width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1.5" fill="#ffffff" opacity="0.14" />
          </pattern>
        </defs>

        <rect x="0" y="0" width="320" height="208" fill={`url(#${bgId})`} />
        <rect x="0" y="0" width="320" height="208" fill={`url(#${dotId})`} />

        {/* Mirror plane (sigma-v) */}
        <line x1={cx} y1="18" x2={cx} y2="190" stroke="#ffffff" strokeOpacity="0.32" strokeWidth="1.6" strokeDasharray="5 5" />

        {/* Reflected ghost copy — fades in/out to read as the mirror operation firing */}
        <g className="gt-visual__ghost" style={{ transformOrigin: `${cx}px ${cy}px` }}>
          {points.map((p, i) => (
            <line key={`ghost-bond-${i}`} x1={cx} y1={cy} x2={2 * cx - p.x} y2={p.y} stroke="#ffffff" strokeOpacity="0.5" strokeWidth="2" />
          ))}
          {points.map((p, i) => (
            <circle key={`ghost-atom-${i}`} cx={2 * cx - p.x} cy={p.y} r="7" fill="#ffffff" fillOpacity="0.5" />
          ))}
        </g>

        {/* Spinning molecule — demonstrates the C3 rotation axis */}
        <g className="gt-visual__spin" style={{ transformOrigin: `${cx}px ${cy}px` }}>
          {points.map((p, i) => (
            <line key={`bond-${i}`} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#ffffff" strokeWidth="2.5" />
          ))}
          {points.map((p, i) => (
            <circle key={`atom-${i}`} cx={p.x} cy={p.y} r="9" fill="#ffffff" />
          ))}
          <circle cx={cx} cy={cy} r="8" fill="#eea02b" />
        </g>

        <text x="18" y="30" fontFamily="ui-monospace, SFMono-Regular, monospace" fontSize="15" fill="#ffffff" opacity="0.85">
          C&#8323;&#7525;
        </text>
      </svg>

      <style>{`
        .gt-visual {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        .gt-visual__svg {
          width: 100%;
          height: 100%;
          display: block;
        }
        .gt-visual__spin {
          animation: gt-spin 7s linear infinite;
        }
        @keyframes gt-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .gt-visual__ghost {
          animation: gt-mirror-flash 4.5s ease-in-out infinite;
        }
        @keyframes gt-mirror-flash {
          0%, 55% { opacity: 0; }
          75%, 90% { opacity: 1; }
          100% { opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .gt-visual__spin,
          .gt-visual__ghost {
            animation: none;
          }
          .gt-visual__ghost {
            opacity: 0.5;
          }
        }
      `}</style>
    </div>
  );
}