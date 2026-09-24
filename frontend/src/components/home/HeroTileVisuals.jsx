import { useId } from 'react';

/**
 * Every hero-marquee tile gets its own small animated "logo" instead of a
 * screenshot — a solid accent colour with a centered glyph that's actually
 * about that feature. Each export below is a thin wrapper around the shared
 * `TileVisualFrame` shell with its own SVG + keyframes. All keyframe/class
 * names are prefixed per-icon since every export is mounted at most once,
 * but this keeps them safely non-colliding if that ever changes.
 */

function TileVisualFrame({ color, children }) {
  return (
    <div className="tile-visual" style={{ background: color }}>
      <div className="tile-visual__icon">{children}</div>
      <style>{`
        .tile-visual { position: absolute; inset: 0; overflow: hidden; }
        .tile-visual__icon {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .tile-visual__icon svg { width: 60%; height: 60%; overflow: visible; }
        @media (prefers-reduced-motion: reduce) {
          .tile-visual__icon [class*="-anim"] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draw Lab — a bond chain drawing itself, pen nib riding the tip
// ---------------------------------------------------------------------------
export function DrawLabVisual({ color }) {
  const uid = useId();
  const pathId = `dl-path-${uid}`;
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 100">
        <path
          id={pathId}
          d="M14,70 L38,50 L62,64 L86,32"
          fill="none"
          stroke="#fff"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="dl-line-anim"
          pathLength="1"
        />
        <circle r="4.5" fill="#eea02b">
          <animateMotion dur="2.6s" repeatCount="indefinite" rotate="auto">
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      </svg>
      <style>{`
        .dl-line-anim {
          stroke-dasharray: 1;
          stroke-dashoffset: 1;
          animation: dl-draw 2.6s ease-in-out infinite;
        }
        @keyframes dl-draw {
          0% { stroke-dashoffset: 1; }
          70%, 100% { stroke-dashoffset: 0; }
        }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// 3D Viewer — a tetrahedral (methane-style) wireframe tumbling in place
// ---------------------------------------------------------------------------
export function ViewerVisual({ color }) {
  const pts = [
    { x: 50, y: 12 },
    { x: 14, y: 66 },
    { x: 50, y: 90 },
    { x: 86, y: 60 },
  ];
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 100">
        <g className="v3d-spin-anim" style={{ transformOrigin: '50px 55px' }}>
          {pts.map((p, i) => (
            <line key={`b-${i}`} x1="50" y1="55" x2={p.x} y2={p.y} stroke="#fff" strokeWidth="3" strokeOpacity="0.8" />
          ))}
          {pts.map((p, i) => (
            <circle key={`a-${i}`} cx={p.x} cy={p.y} r="7" fill="#fff" />
          ))}
          <circle cx="50" cy="55" r="6" fill="#eea02b" />
        </g>
      </svg>
      <style>{`
        .v3d-spin-anim { animation: v3d-tumble 6s ease-in-out infinite; }
        @keyframes v3d-tumble {
          0%, 100% { transform: rotate(0deg) scaleX(1); }
          50% { transform: rotate(180deg) scaleX(0.55); }
        }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// Spectroscopy — an NMR-style stack of peaks pulsing at different rates
// ---------------------------------------------------------------------------
export function SpectroscopyVisual({ color }) {
  const bars = [18, 34, 58, 30, 14, 44, 22];
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 60">
        {bars.map((h, i) => (
          <rect
            key={i}
            x={6 + i * 13}
            y={60 - h}
            width="7"
            height={h}
            rx="2"
            fill="#fff"
            className="spec-bar-anim"
            style={{ transformOrigin: `${6 + i * 13 + 3.5}px 60px`, animationDelay: `${i * 0.12}s` }}
          />
        ))}
      </svg>
      <style>{`
        .spec-bar-anim { animation: spec-pulse 1.8s ease-in-out infinite; }
        @keyframes spec-pulse {
          0%, 100% { transform: scaleY(1); }
          50% { transform: scaleY(0.45); }
        }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// Compound Library — a shelf of spines, one sliding out and back like a pick
// ---------------------------------------------------------------------------
export function LibraryVisual({ color }) {
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 70">
        <rect x="8" y="10" width="14" height="52" rx="2" fill="#fff" fillOpacity="0.55" />
        <rect x="24" y="10" width="14" height="52" rx="2" fill="#fff" className="lib-pick-anim" />
        <rect x="40" y="10" width="14" height="52" rx="2" fill="#fff" fillOpacity="0.55" />
        <rect x="56" y="10" width="14" height="52" rx="2" fill="#fff" fillOpacity="0.35" />
        <rect x="72" y="10" width="14" height="52" rx="2" fill="#fff" fillOpacity="0.55" />
      </svg>
      <style>{`
        .lib-pick-anim { animation: lib-pick 3.2s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 100%; }
        @keyframes lib-pick {
          0%, 20%, 100% { transform: translateY(0) rotate(0deg); }
          40% { transform: translateY(-14px) rotate(-6deg); }
          60% { transform: translateY(-14px) rotate(-6deg); }
        }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// Functional Groups — a flashcard grid with the "active" cell cycling
// ---------------------------------------------------------------------------
export function FunctionalGroupsVisual({ color }) {
  const cells = [0, 1, 2, 3, 4, 5];
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 68">
        {cells.map((i) => {
          const col = i % 3;
          const row = Math.floor(i / 3);
          return (
            <rect
              key={i}
              x={6 + col * 31}
              y={6 + row * 32}
              width="25"
              height="26"
              rx="5"
              fill="#fff"
              className="fg-cell-anim"
              style={{ animationDelay: `${i * 0.28}s` }}
            />
          );
        })}
      </svg>
      <style>{`
        .fg-cell-anim { opacity: 0.32; animation: fg-highlight 1.68s linear infinite; }
        @keyframes fg-highlight {
          0%, 88%, 100% { opacity: 0.32; }
          8%, 30% { opacity: 1; }
        }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// Reactions — two reactants colliding into a product, looping
// ---------------------------------------------------------------------------
export function ReactionsVisual({ color }) {
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 60">
        <circle cx="24" cy="30" r="10" fill="#fff" className="rxn-a-anim" />
        <circle cx="76" cy="30" r="10" fill="#fff" className="rxn-b-anim" />
        <path d="M40,30 L60,30" stroke="#fff" strokeWidth="3" strokeDasharray="4 5" className="rxn-arrow-anim" />
        <circle cx="50" cy="30" r="0" fill="#eea02b" className="rxn-spark-anim" />
      </svg>
      <style>{`
        .rxn-a-anim { animation: rxn-in-left 2.4s ease-in-out infinite; }
        .rxn-b-anim { animation: rxn-in-right 2.4s ease-in-out infinite; }
        @keyframes rxn-in-left { 0%, 20% { transform: translateX(0); } 50%, 65% { transform: translateX(20px); } 100% { transform: translateX(0); } }
        @keyframes rxn-in-right { 0%, 20% { transform: translateX(0); } 50%, 65% { transform: translateX(-20px); } 100% { transform: translateX(0); } }
        .rxn-arrow-anim { animation: rxn-fade 2.4s ease-in-out infinite; }
        @keyframes rxn-fade { 0%, 45% { opacity: 0; } 55%, 100% { opacity: 1; } }
        .rxn-spark-anim { animation: rxn-spark 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
        @keyframes rxn-spark { 0%, 48% { r: 0; opacity: 0; } 56% { r: 9; opacity: 1; } 68%, 100% { r: 0; opacity: 0; } }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// Group Theory — trigonal molecule spinning through its C3 axis, with a
// mirror plane flashing a reflected "ghost" copy (same idea as GTHeroGraphic)
// ---------------------------------------------------------------------------
export function GroupTheoryVisual({ color }) {
  const cx = 50;
  const cy = 54;
  const r = 26;
  const pts = [-90, 30, 150].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  });
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 100">
        <line x1={cx} y1="10" x2={cx} y2="98" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.4" strokeDasharray="4 4" />
        <g className="gt-ghost-anim" style={{ transformOrigin: `${cx}px ${cy}px` }}>
          {pts.map((p, i) => (
            <line key={`gb-${i}`} x1={cx} y1={cy} x2={2 * cx - p.x} y2={p.y} stroke="#fff" strokeOpacity="0.5" strokeWidth="2" />
          ))}
          {pts.map((p, i) => (
            <circle key={`ga-${i}`} cx={2 * cx - p.x} cy={p.y} r="5" fill="#fff" fillOpacity="0.5" />
          ))}
        </g>
        <g className="gt-spin-anim" style={{ transformOrigin: `${cx}px ${cy}px` }}>
          {pts.map((p, i) => (
            <line key={`b-${i}`} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#fff" strokeWidth="2.5" />
          ))}
          {pts.map((p, i) => (
            <circle key={`a-${i}`} cx={p.x} cy={p.y} r="6" fill="#fff" />
          ))}
          <circle cx={cx} cy={cy} r="5.5" fill="#eea02b" />
        </g>
      </svg>
      <style>{`
        .gt-spin-anim { animation: gt-spin 7s linear infinite; }
        @keyframes gt-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .gt-ghost-anim { animation: gt-mirror 4.5s ease-in-out infinite; }
        @keyframes gt-mirror { 0%, 55% { opacity: 0; } 75%, 90% { opacity: 1; } 100% { opacity: 0; } }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// Quiz Mode — a question mark that resolves into a checkmark, on repeat
// ---------------------------------------------------------------------------
export function QuizVisual({ color }) {
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 100">
        <text x="50" y="66" textAnchor="middle" fontSize="52" fontWeight="700" fill="#fff" className="quiz-q-anim" fontFamily="ui-monospace, monospace">?</text>
        <path d="M28,52 L44,68 L74,34" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" className="quiz-check-anim" pathLength="1" />
      </svg>
      <style>{`
        .quiz-q-anim { animation: quiz-q-fade 3.2s ease-in-out infinite; }
        @keyframes quiz-q-fade { 0%, 45% { opacity: 1; transform: scale(1); } 55%, 90% { opacity: 0; transform: scale(0.6); } 100% { opacity: 1; transform: scale(1); } }
        .quiz-check-anim {
          stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0;
          animation: quiz-check 3.2s ease-in-out infinite;
        }
        @keyframes quiz-check {
          0%, 50% { opacity: 0; stroke-dashoffset: 1; }
          65% { opacity: 1; }
          85%, 100% { opacity: 1; stroke-dashoffset: 0; }
        }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// Notes — handwriting lines appearing one at a time
// ---------------------------------------------------------------------------
export function NotesVisual({ color }) {
  const lines = [
    { y: 24, w: 60 },
    { y: 42, w: 74 },
    { y: 60, w: 46 },
  ];
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 80">
        {lines.map((l, i) => (
          <line
            key={i}
            x1="14" y1={l.y} x2={14 + l.w} y2={l.y}
            stroke="#fff" strokeWidth="6" strokeLinecap="round"
            className="note-line-anim"
            style={{ strokeDasharray: 1, animationDelay: `${i * 0.55}s` }}
            pathLength="1"
          />
        ))}
      </svg>
      <style>{`
        .note-line-anim { stroke-dashoffset: 1; animation: note-write 2.4s ease-in-out infinite; }
        @keyframes note-write { 0% { stroke-dashoffset: 1; } 30%, 85% { stroke-dashoffset: 0; } 95%, 100% { stroke-dashoffset: 1; } }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// My Molecules — a small saved atom with two electrons drifting in orbit
// ---------------------------------------------------------------------------
export function MyMoleculesVisual({ color }) {
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 100">
        <g className="mol-spin-a-anim" style={{ transformOrigin: '50px 50px' }}>
          <ellipse cx="50" cy="50" rx="38" ry="16" fill="none" stroke="#fff" strokeWidth="3" strokeOpacity="0.8" />
          <circle r="5" fill="#fff">
            <animateMotion dur="4s" repeatCount="indefinite">
              <mpath href="#mol-ring-a" />
            </animateMotion>
          </circle>
          <path id="mol-ring-a" d="M12,50 A38,16 0 1,1 88,50 A38,16 0 1,1 12,50" fill="none" opacity="0" />
        </g>
        <g className="mol-spin-b-anim" style={{ transformOrigin: '50px 50px' }} transform="rotate(70 50 50)">
          <ellipse cx="50" cy="50" rx="38" ry="16" fill="none" stroke="#fff" strokeWidth="3" strokeOpacity="0.6" />
          <circle r="4" fill="#eea02b">
            <animateMotion dur="5.5s" begin="-1.5s" repeatCount="indefinite">
              <mpath href="#mol-ring-b" />
            </animateMotion>
          </circle>
          <path id="mol-ring-b" d="M12,50 A38,16 0 1,1 88,50 A38,16 0 1,1 12,50" fill="none" opacity="0" />
        </g>
        <circle cx="50" cy="50" r="7" fill="#fff" />
      </svg>
      <style>{`
        .mol-spin-a-anim { animation: mol-spin 9s linear infinite; }
        .mol-spin-b-anim { animation: mol-spin 12s linear infinite reverse; }
        @keyframes mol-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </TileVisualFrame>
  );
}

// ---------------------------------------------------------------------------
// News — a headline card with "breaking" rays pulsing behind it
// ---------------------------------------------------------------------------
export function NewsVisual({ color }) {
  const rays = Array.from({ length: 8 }, (_, i) => i * 45);
  return (
    <TileVisualFrame color={color}>
      <svg viewBox="0 0 100 100">
        <g className="news-rays-anim" style={{ transformOrigin: '50px 50px' }}>
          {rays.map((deg) => (
            <line key={deg} x1="50" y1="50" x2="50" y2="8" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeOpacity="0.55" transform={`rotate(${deg} 50 50)`} />
          ))}
        </g>
        <rect x="24" y="34" width="52" height="32" rx="3" fill="#fff" />
        <rect x="30" y="41" width="24" height="4" fill={color} />
        <rect x="30" y="49" width="40" height="3" fill={color} opacity="0.7" />
        <rect x="30" y="55" width="40" height="3" fill={color} opacity="0.7" />
      </svg>
      <style>{`
        .news-rays-anim { animation: news-pulse 2.2s ease-in-out infinite; }
        @keyframes news-pulse { 0%, 100% { opacity: 0.4; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.08); } }
      `}</style>
    </TileVisualFrame>
  );
}