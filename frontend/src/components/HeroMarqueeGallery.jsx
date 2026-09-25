import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  PenTool,
  Box,
  BookOpen,
  Grid3X3,
  Sparkles,
  NotebookPen,
  Atom,
  Newspaper,
  Beaker,
  Activity,
  FlaskConical,
  Layers,
} from 'lucide-react';

import {
  DrawLabVisual,
  ViewerVisual,
  SpectroscopyVisual,
  LibraryVisual,
  FunctionalGroupsVisual,
  ReactionsVisual,
  GroupTheoryVisual,
  QuizVisual,
  NotesVisual,
  MyMoleculesVisual,
  NewsVisual,
} from './home/HeroTileVisuals';

// ---------------------------------------------------------------------------
// FEATURE TILES — every tile now carries its own small animated `visual`
// (see home/HeroTileVisuals.jsx) instead of a static screenshot.
// ---------------------------------------------------------------------------

const FEATURE_TILES = [
  {
    key: 'draw',
    title: 'Draw Lab',
    tag: 'Sketch molecules',
    icon: PenTool,
    to: '/draw',
    color: 'cyan',
    visual: DrawLabVisual,
  },
  {
    key: '3d',
    title: '3D Viewer',
    tag: 'Rotate & inspect',
    icon: Box,
    to: '/draw',
    color: 'violet',
    visual: ViewerVisual,
  },
  {
    key: 'spectroscopy',
    title: 'Spectroscopy Engine',
    tag: 'Predict NMR spectra',
    icon: Activity,
    to: '/library',
    color: 'blue',
    visual: SpectroscopyVisual,
  },
  {
    key: 'library',
    title: 'Compound Library',
    tag: '10K+ compounds',
    icon: BookOpen,
    to: '/library',
    color: 'blue',
    visual: LibraryVisual,
  },
  {
    key: 'groups',
    title: 'Functional Groups',
    tag: 'Flashcard drills',
    icon: Grid3X3,
    to: '/functional-groups',
    color: 'pink',
    visual: FunctionalGroupsVisual,
  },
  {
    key: 'reactions',
    title: 'Reactions',
    tag: 'Mechanisms & pathways',
    icon: FlaskConical,
    to: '/reactions',
    color: 'emerald',
    visual: ReactionsVisual,
  },
  {
    key: 'group-theory',
    title: 'Group Theory',
    tag: 'Symmetry & point groups',
    icon: Layers,
    to: '/group-theory',
    color: 'indigo',
    visual: GroupTheoryVisual,
  },
  {
    key: 'quiz',
    title: 'Quiz Mode',
    tag: 'Test yourself',
    icon: Sparkles,
    to: '/quiz',
    color: 'amber',
    visual: QuizVisual,
  },
  {
    key: 'notes',
    title: 'Notes',
    tag: 'Save & revisit',
    icon: NotebookPen,
    to: '/notes',
    color: 'teal',
    visual: NotesVisual,
  },
  {
    key: 'mine',
    title: 'My Molecules',
    tag: 'Your saved drawings',
    icon: Atom,
    to: '/my-molecules',
    color: 'violet',
    visual: MyMoleculesVisual,
  },
  {
    key: 'news',
    title: 'News',
    tag: 'Latest research',
    icon: Newspaper,
    to: '/news',
    color: 'coral',
    visual: NewsVisual,
  },
];

// ---------------------------------------------------------------------------
// CHEMISTRY TEXT CONTENT
// ---------------------------------------------------------------------------

const CHEMISTRY_TEXTS = [
  'H₂O — Water',
  'C₆H₆ — Benzene',
  'CH₄ — Methane',
  'C₂H₅OH — Ethanol',
  'CO₂ — Carbon dioxide',
  'NH₃ — Ammonia',
  'H₂SO₄ — Sulfuric acid',
  'C₆H₁₂O₆ — Glucose',
  'Marie Curie — Radioactivity',
  'Amedeo Avogadro — Molecular theory',
  'Antoine Lavoisier — Conservation of mass',
  'Linus Pauling — Chemical bonding',
  'NMR Spectroscopy',
  'Molar Mass',
  'Activation Energy',
  'DNA — Molecular genetics',
  'Periodic Table',
  'Covalent Bond',
  'Molecular Orbitals',
  'Chemical Equilibrium',
  'SN2 — Reaction Mechanism',
  'C₂ᵥ — Point Group',
];

// ---------------------------------------------------------------------------
// ACCENTS — each tile's colour, shared by the animated visual background
// and the icon-only fallback (used only if a tile has no `visual` set)
// ---------------------------------------------------------------------------

const ACCENTS = {
  cyan: '#3bbff7',
  violet: '#a78bfa',
  blue: '#3bbff7',
  pink: '#f472b6',
  amber: '#eea02b',
  teal: '#2dd4bf',
  coral: '#fb7185',
  emerald: '#34d399',
  indigo: '#818cf8',
};

// ---------------------------------------------------------------------------
// FEATURE TILE (inner content only — the coverflow ring handles positioning,
// the link wrapper, and drag-vs-click detection)
// ---------------------------------------------------------------------------

function FeatureTile({ tile }) {
  const accent = ACCENTS[tile.color] || ACCENTS.cyan;
  const Icon = tile.icon || Beaker;
  const Visual = tile.visual;

  return (
    <div className="gallery-tile group">
      {Visual ? (
        <>
          <Visual color={accent} />
          <div className="gallery-tile__shade" />
        </>
      ) : (
        <span className="gallery-tile__icon" style={{ background: accent }}>
          <Icon size={18} />
        </span>
      )}

      <div className={`gallery-tile__text ${Visual ? 'is-over-image' : ''}`}>
        <p className="gallery-tile__title">{tile.title}</p>
        <p className="gallery-tile__tag">{tile.tag}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROW 1 — 3D COVERFLOW RING
//
// Every tile sits on a circle in 3D space (rotateY(i * step) translateZ(r)),
// so as the whole "stage" spins around the Y axis the cards read like a
// curved wall of screens that continuously orbits past the viewer. It never
// stops — a rAF loop keeps nudging the angle forward — but a pointer drag
// grabs the ring directly and spins it 1:1 with the cursor, with the
// angular velocity at release carried through as momentum, easing back into
// the idle auto-spin. A click that didn't drag still navigates normally.
// ---------------------------------------------------------------------------

const BASE_SPEED = 7; // deg / second, idle auto-rotate speed
const DRAG_SENSITIVITY = 0.32; // deg per px of pointer movement
const RECOVERY_RATE = 1.1; // how fast momentum eases back to BASE_SPEED
const CLICK_DRAG_THRESHOLD = 10; // px — below this, a pointerup still counts as a click

function FeatureCoverflow() {
  const tiles = FEATURE_TILES;
  const count = tiles.length;
  const angleStep = 360 / count;
  const navigate = useNavigate();

  const viewportRef = useRef(null);
  const stageRef = useRef(null);

  const angleRef = useRef(0);
  const velocityRef = useRef(BASE_SPEED);
  const draggingRef = useRef(false);
  const lastXRef = useRef(0);
  const lastTRef = useRef(0);
  const movedRef = useRef(0);
  const rafRef = useRef(null);

  const [geometry, setGeometry] = useState({ width: 210, radius: 400 });

  // Recompute card width + ring radius from the live viewport width so the
  // ring always closes up cleanly, at any screen size.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;

    const compute = () => {
      const vw = el.clientWidth || window.innerWidth;
      const width = Math.min(232, Math.max(150, vw * 0.16));
      const halfAngle = Math.PI / count;
      const radius = width / 2 / Math.tan(halfAngle) + 34;
      setGeometry({ width, radius });
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);

  // Main animation loop: idles forward at BASE_SPEED, or — after a drag —
  // keeps coasting at the released velocity while it decays back to BASE_SPEED.
  // Gated the same way the app's 3D molecule viewers already are (see
  // useThreeScene.js / HeroMolecule.jsx): this is an 11-card 3D
  // `preserve-3d` carousel, each card carrying its own looping SVG
  // animation on top — continuously rotating that whole stack, even while
  // it's scrolled off-screen or the tab is backgrounded, is exactly the
  // kind of steady frame cost that reads as "smooth on a laptop, janky on
  // a phone." Pausing the rotation math + style write while off-screen
  // costs nothing visually (it isn't visible) and gives every other
  // on-screen animation more of the phone's frame budget.
  useEffect(() => {
    const viewportEl = viewportRef.current;
    let onScreen = true;
    let last = performance.now();

    const tick = (now) => {
      if (!onScreen || document.hidden) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (!draggingRef.current) {
        velocityRef.current += (BASE_SPEED - velocityRef.current) * Math.min(1, dt * RECOVERY_RATE);
        angleRef.current += velocityRef.current * dt;
      }

      if (stageRef.current) {
        stageRef.current.style.transform = `translate(-50%, -50%) rotateY(${angleRef.current}deg)`;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    let io;
    if (viewportEl && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        ([entry]) => {
          onScreen = entry.isIntersecting;
          // Dropping straight back in mid-rotation is fine — the loop
          // just resumes advancing the angle from wherever it left off,
          // there's nothing to "catch up" on.
          if (onScreen) last = performance.now();
        },
        { threshold: 0 }
      );
      io.observe(viewportEl);
    }
    const onVisibility = () => {
      if (!document.hidden) last = performance.now();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(rafRef.current);
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const handlePointerDown = useCallback((e) => {
    draggingRef.current = true;
    movedRef.current = 0;
    lastXRef.current = e.clientX;
    lastTRef.current = performance.now();
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e) => {
    if (!draggingRef.current) return;
    const now = performance.now();
    const dx = e.clientX - lastXRef.current;
    const dt = Math.max(1, now - lastTRef.current);

    movedRef.current += Math.abs(dx);
    angleRef.current += dx * DRAG_SENSITIVITY;
    velocityRef.current = (dx / dt) * 1000 * DRAG_SENSITIVITY;

    lastXRef.current = e.clientX;
    lastTRef.current = now;
  }, []);

  // Navigation is fired from here — NOT from the anchor's native click —
  // because `setPointerCapture` above retargets the click that follows a
  // captured pointer back to this viewport element, so a click handler sitting
  // on the tile's own <a> can end up never firing at all. Resolving tap-vs-drag
  // and calling `navigate()` directly on pointerup sidesteps that entirely.
  const handlePointerUp = useCallback((e) => {
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op — pointer capture may already be released */
    }

    if (movedRef.current <= CLICK_DRAG_THRESHOLD) {
      const tileEl = e.target.closest?.('[data-tile-to]');
      const to = tileEl?.getAttribute('data-tile-to');
      if (to) navigate(to);
    }
  }, [navigate]);

  // Handles the two cases pointerup can't: keyboard activation (Enter/Space
  // on a focused tile never fires pointerdown/up at all) and stopping the
  // browser's own full-page navigation for a plain mouse/touch click on the
  // underlying <a href>. Modifier/middle clicks are left alone so "open in
  // a new tab" etc. still works.
  const handleTileClick = useCallback((e, to) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const isKeyboardActivation = e.detail === 0;
    if (isKeyboardActivation) navigate(to);
  }, [navigate]);

  return (
    <div
      ref={viewportRef}
      className="coverflow-viewport"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="coverflow-stage" ref={stageRef}>
        {tiles.map((tile, i) => {
          const rotation = i * angleStep;
          const card = (
            <div
              className="coverflow-card"
              style={{
                width: `${geometry.width}px`,
                transform: `translate(-50%, -50%) rotateY(${rotation}deg) translateZ(${geometry.radius}px)`,
              }}
            >
              <FeatureTile tile={tile} />
            </div>
          );

          return (
            <a
              key={tile.key}
              href={tile.to || '#'}
              className="coverflow-link"
              draggable={false}
              data-tile-to={tile.to}
              onClick={(e) => handleTileClick(e, tile.to)}
            >
              {card}
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROW 2 — CHEMISTRY TEXT CARDS (slides right, unchanged)
// ---------------------------------------------------------------------------

function ChemistryTextMarquee() {
  const doubled = [...CHEMISTRY_TEXTS, ...CHEMISTRY_TEXTS];

  return (
    <div className="gallery-viewport">
      <div className="gallery-track gallery-track--right">
        {doubled.map((item, index) => (
          <span key={`${item}-${index}`} className="gallery-chip">
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MAIN COMPONENT
//
// A 3D coverflow ring of feature tiles on top (drag to spin, otherwise
// it orbits on its own; tap/click any tile to open its page), and the flat
// chemistry ticker below. The section is transparent — the blue road line
// on the homepage runs behind it.
// ---------------------------------------------------------------------------

export default function HeroMarqueeGallery() {
  return (
    <section className="hero-marquee-gallery" aria-label="MoleIt chemistry features">
      <style>{`
        .hero-marquee-gallery {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 16px;
          width: 100%;
          overflow: hidden;
          isolation: isolate;
        }

        /* ---------------- Row 1: 3D coverflow ring ---------------- */

        .coverflow-viewport {
          position: relative;
          width: 100%;
          height: clamp(200px, 19vw, 270px);
          overflow: hidden;
          perspective: 1500px;
          perspective-origin: 50% 45%;
          cursor: grab;
          touch-action: pan-y;
          -webkit-mask-image: linear-gradient(
            to right,
            transparent 0%,
            #000 12%,
            #000 88%,
            transparent 100%
          );
          mask-image: linear-gradient(
            to right,
            transparent 0%,
            #000 12%,
            #000 88%,
            transparent 100%
          );
        }
        .coverflow-viewport:active { cursor: grabbing; }

        .coverflow-stage {
          position: absolute;
          left: 50%;
          top: 50%;
          transform-style: preserve-3d;
          will-change: transform;
        }

        .coverflow-link {
          position: absolute;
          left: 0;
          top: 0;
          display: block;
          transform-style: preserve-3d;
          outline: none;
        }
        .coverflow-link:focus-visible .coverflow-card { box-shadow: 0 0 0 3px #3bbff7; }

        .coverflow-card {
          position: relative;
          aspect-ratio: 8 / 5;
          transform-style: preserve-3d;
          backface-visibility: hidden;
          pointer-events: none;
        }

        .gallery-tile {
          position: relative;
          width: 100%;
          height: 100%;
          overflow: hidden;
          border-radius: 20px;
          background: #fafaf9;
          box-shadow: 0 18px 40px -18px rgba(0, 0, 0, 0.45);
          user-select: none;
        }

        .gallery-tile__img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          pointer-events: none;
        }

        .gallery-tile__shade {
          position: absolute;
          inset: 0;
          background: linear-gradient(to top, rgba(20, 20, 20, 0.82), rgba(20, 20, 20, 0) 62%);
        }

        .gallery-tile__icon {
          position: absolute;
          top: 16px;
          left: 16px;
          display: grid;
          place-items: center;
          width: 38px;
          height: 38px;
          border-radius: 50%;
          color: #262626;
        }

        .gallery-tile__text {
          position: relative;
          z-index: 1;
          display: flex;
          height: 100%;
          flex-direction: column;
          justify-content: flex-end;
          padding: 14px 16px;
          color: #262626;
        }
        .gallery-tile__text.is-over-image { color: #fff; }

        .gallery-tile__title {
          margin: 0;
          font-family: var(--font-display);
          font-size: 14px;
          font-weight: 600;
          letter-spacing: -0.01em;
        }
        .gallery-tile__tag {
          margin: 2px 0 0;
          font-size: 11px;
          opacity: 0.78;
        }

        /* ---------------- Row 2: flat chemistry ticker ---------------- */

        .gallery-viewport {
          position: relative;
          width: 100%;
          overflow: hidden;
        }

        .gallery-track {
          display: flex;
          align-items: center;
          gap: 16px;
          width: max-content;
          will-change: transform;
        }
        .gallery-track--right { animation: gallery-right 64s linear infinite; }

        @keyframes gallery-right {
          from { transform: translate3d(calc(-50% - 8px), 0, 0); }
          to { transform: translate3d(0, 0, 0); }
        }

        .gallery-viewport:hover .gallery-track { animation-play-state: paused; }

        .gallery-chip {
          display: inline-flex;
          flex: 0 0 auto;
          align-items: center;
          height: clamp(52px, 4.9vw, 68px);
          padding: 0 clamp(22px, 2.2vw, 34px);
          border-radius: 20px;
          background: #fafaf9;
          color: #262626;
          font-family: var(--font-display);
          font-size: clamp(14px, 1.15vw, 17px);
          font-weight: 500;
          white-space: nowrap;
        }

        @media (max-width: 640px) {
          .hero-marquee-gallery { gap: 12px; }
          .coverflow-viewport { height: clamp(160px, 46vw, 210px); perspective: 900px; }
          .gallery-tile { border-radius: 16px; }
          .gallery-track { gap: 12px; }
          .gallery-chip { border-radius: 16px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .gallery-track { animation-play-state: paused !important; }
        }
      `}</style>

      <FeatureCoverflow />
      <ChemistryTextMarquee />
    </section>
  );
}