import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowDown, Sparkles } from 'lucide-react';
import { categoryTone, Formula } from './CompoundCard';

// ---------------------------------------------------------------------------
// Orbiting compound cards
// ---------------------------------------------------------------------------
// Eight fixed slots the cards fan out into, around the central heading.
// `depth` sets how far a card drifts toward the cursor relative to the others.
// `lg` slots are hidden on tablets and `md` slots on small tablets, where there
// isn't room for them; `tab` re-positions a slot for tablet widths.
const SLOTS = [
  { top: '7%', left: '3%', size: 'sm', rot: -9, depth: 1.5, z: 3, tab: { top: '5%', left: '2%' } },
  { top: '6%', left: '19%', size: 'xs', rot: 7, depth: 1.7, z: 4, lg: true },
  { top: '42%', left: '3%', size: 'md', rot: 6, depth: 1.0, z: 3, lg: true },
  { top: '72%', left: '15%', size: 'sm', rot: -6, depth: 1.4, z: 2, sm: true, tab: { top: '75%', left: '1%' } },
  { top: '5%', left: '80%', size: 'sm', rot: 8, depth: 1.2, z: 3, tab: { top: '5%', left: '78%' } },
  { top: '24%', left: '69%', size: 'xs', rot: -8, depth: 1.6, z: 4, lg: true },
  { top: '46%', left: '82%', size: 'md', rot: -7, depth: 0.8, z: 3, lg: true },
  { top: '73%', left: '71%', size: 'sm', rot: 9, depth: 1.3, z: 2, sm: true, tab: { top: '75%', left: '79%' } },
];

// How far outward (px) a card travels as it flies in / out of its slot.
const RADIAL_TRAVEL = 90;
// Swap window for each slot — randomised per slot, per swap, so the cards
// never cycle in lockstep.
const CYCLE_MIN_MS = 3200;
const CYCLE_MAX_MS = 5600;

function OrbitSlot({ pool, slot, slotIndex, mouse }) {
  const [idx, setIdx] = useState(slotIndex % pool.length);
  const timerRef = useRef(null);

  useEffect(() => {
    if (pool.length <= 1) return undefined;
    const scheduleNext = () => {
      const delay = CYCLE_MIN_MS + Math.random() * (CYCLE_MAX_MS - CYCLE_MIN_MS);
      timerRef.current = setTimeout(() => {
        setIdx((i) => (i + 1) % pool.length);
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => clearTimeout(timerRef.current);
  }, [pool.length]);

  const compound = pool[idx % pool.length];
  if (!compound) return null;

  // Direction from the container centre out to this slot, so the card enters
  // from further out and exits further out still.
  const dx = parseFloat(slot.left) - 50;
  const dy = parseFloat(slot.top) - 50;
  const mag = Math.hypot(dx, dy) || 1;
  const radialX = (dx / mag) * RADIAL_TRAVEL;
  const radialY = (dy / mag) * RADIAL_TRAVEL;

  return (
    <div
      className={`oc-slot ${slot.lg ? 'oc-lg-only' : ''} ${slot.sm ? 'oc-sm-only' : ''}`}
      style={{
        '--top': slot.top,
        '--left': slot.left,
        '--tab-top': slot.tab?.top,
        '--tab-left': slot.tab?.left,
        zIndex: slot.z,
        transform: `translate3d(${mouse.x * slot.depth}px, ${mouse.y * slot.depth}px, 0)`,
      }}
    >
      <AnimatePresence>
        <motion.div
          key={compound.id}
          initial={{ opacity: 0, scale: 0.6, rotate: slot.rot * 2.2, x: radialX, y: radialY }}
          animate={{ opacity: 1, scale: 1, rotate: slot.rot, x: 0, y: 0 }}
          exit={{ opacity: 0, scale: 0.55, rotate: slot.rot * 2.2, x: radialX, y: radialY }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          style={{ position: 'absolute', top: 0, left: 0 }}
        >
          <div
            className="card-drift"
            style={{ '--drift-rot': `${slot.rot}deg`, animationDuration: `${5 + slotIndex}s`, animationDelay: `${slotIndex * 0.35}s` }}
          >
            <Link
              to={`/library/${compound.id}`}
              className={`oc oc--${slot.size}`}
              style={categoryTone(compound.category)}
            >
              <span
                className="oc-body"
                style={{ transform: `rotateX(${-mouse.y * 0.9}deg) rotateY(${mouse.x * 0.9}deg)` }}
              >
                <span className="oc-slab oc-slab--2" aria-hidden="true" />
                <span className="oc-slab oc-slab--1" aria-hidden="true" />
                <span className="oc-face">
                  <span className="oc-cat">{compound.category}</span>
                  <span className="oc-name">{compound.name}</span>
                  <span className="oc-formula">
                    <Formula text={compound.formula} />
                  </span>
                </span>
              </span>
            </Link>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tank -> pipes -> flood animation
// ---------------------------------------------------------------------------
// The hero starts as a glass tank of lime solution sitting on a steel rail.
// Three outlet pipes fit into the rail, their valves swing open, liquid runs
// down through the glass tubes and pours out of the nozzles while the level in
// the tank drops. The spilled liquid rises to flood the whole page, the valves
// close, the streams break off, and the tank + pipes dissolve — leaving only
// liquid, bubbles and the floating compound cards.
//
// Pure CSS (no extra dependencies). The whole timeline lives in `T` (seconds)
// and is interpolated into the stylesheet below, so tweaking one number keeps
// every phase in sync.

// true  = play the animation every time the Library page opens.
// false = play it once per browser session, then show the flooded page
//         straight away on later visits.
const REPLAY_EVERY_VISIT = true;
const SEEN_KEY = 'moleit:library-flood-seen';

const T = {
  build: 0.2, // pipes slide down out of the rail
  open: 0.9, // valve levers swing open
  fill: 1.3, // liquid runs down the glass tubes
  flow: 1.75, // streams leave the nozzles, the tank starts to drain
  drainDur: 3.0,
  rise: 2.2, // the flood starts rising from the bottom of the screen
  riseDur: 3.4,
  close: 4.6, // valves swing shut
  cut: 4.9, // streams break off and fall away
  shell: 5.5, // tank + pipes dissolve...
  shellDur: 1.2,
};

// Where each outlet pipe sits (% of tank width) and how wide it is. `lag`
// staggers the three so they never open in perfect sync.
const LEAKS = [
  { left: 19, pw: 30, lag: 0.15 },
  { left: 52, pw: 38, lag: 0 },
  { left: 81, pw: 28, lag: 0.35 },
];

// One wave tile pair (period 600, 4 periods = 2400 wide). Sliding the SVG by
// exactly -50% lands on an identical crest, so the loop is seamless.
const WAVE_PATH = `M0 30 ${'q150 -30 300 0 t300 0 '.repeat(4)}V60 H0Z`;

function useFloodPlayback() {
  const [settled] = useState(() => {
    if (REPLAY_EVERY_VISIT) return false;
    try {
      return sessionStorage.getItem(SEEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (REPLAY_EVERY_VISIT) return;
    try {
      sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* storage blocked (private mode) — animation just replays next time */
    }
  }, []);
  return settled;
}

// The liquid is drawn from OPAQUE shapes (two wave layers + a gradient body)
// and the see-through look comes from one `opacity` on the whole group. Doing
// it per-shape with rgba() made the overlaps add up and left bright seams.
function LiquidBody() {
  return (
    <div className="lib-liquid">
      <Wave />
      <div className="lib-body" />
    </div>
  );
}

function Wave() {
  return (
    <>
      <svg className="lib-wave lib-wave-back" viewBox="0 0 2400 60" preserveAspectRatio="none" aria-hidden="true">
        <path d={WAVE_PATH} />
      </svg>
      <svg className="lib-wave lib-wave-front" viewBox="0 0 2400 60" preserveAspectRatio="none" aria-hidden="true">
        <path d={WAVE_PATH} />
      </svg>
    </>
  );
}

// Fixed, page-wide liquid that sits behind everything (z-index -10) and rises
// from the bottom of the screen. Fixed on purpose: it stays put while the page
// scrolls, so the whole Library feels submerged rather than just its top.
function LiquidFlood({ bubbles }) {
  return (
    <div className="lib-flood" aria-hidden="true">
      <div className="lib-rise">
        <LiquidBody />
        <div className="lib-caustic lib-caustic-a" />
        <div className="lib-caustic lib-caustic-b" />
        {bubbles.map((b) => (
          <span
            key={b.id}
            className="lib-bubble"
            style={{
              left: `${b.left}%`,
              width: b.size,
              height: b.size,
              animationDuration: `${b.duration}s`,
              animationDelay: `${b.delay}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// One outlet: a steel flange bolted to the rail, a ball valve with a lever, a
// glass tube that fills with liquid, a lip + nozzle, and the stream itself.
// The stream is a separate element (not a child of the pipe) because it has to
// sit BEHIND the page content, while the pipe sits in front of the tank.
function Pipe({ leak }) {
  const { left, pw, lag } = leak;
  const vars = {
    left: `${left}%`,
    '--pw': `${pw}px`,
    '--b': `${(T.build + lag * 0.6).toFixed(2)}s`,
    '--vo': `${(T.open + lag).toFixed(2)}s`,
    '--vf': `${(T.fill + lag).toFixed(2)}s`,
    '--fs': `${(T.flow + lag).toFixed(2)}s`,
    '--vc': `${(T.close + lag * 0.6).toFixed(2)}s`,
    '--ve': `${(T.close + 0.35 + lag * 0.6).toFixed(2)}s`,
    '--fc': `${(T.cut + lag * 0.6).toFixed(2)}s`,
  };
  return (
    <>
      <div className="lp" style={vars} aria-hidden="true">
        <span className="lp-flange" />
        <span className="lp-valve">
          <span className="lp-arm" />
          <span className="lp-pivot" />
        </span>
        <span className="lp-pipe">
          <span className="lp-liq" />
          <span className="lp-gloss" />
        </span>
        <span className="lp-lip" />
        <span className="lp-nozzle" />
      </div>
      <div className="lp-stream" style={vars} aria-hidden="true">
        <span className="lp-core" />
        <i className="lp-drop lp-drop--a" />
        <i className="lp-drop lp-drop--b" />
      </div>
    </>
  );
}

// Hero visual for the top of the Library page: a glass tank of solution with
// compound cards whirling in and out around a centred "Compound Library"
// heading, cycling continuously through the library on independent per-slot
// timers and reacting to the cursor. The searchable grid underneath remains
// the primary way to browse.
export default function CompoundOrbitHero({ compounds = [] }) {
  const pool = useMemo(() => compounds.filter(Boolean), [compounds]);
  const settled = useFloodPlayback();
  const containerRef = useRef(null);
  const frame = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  // Fixed once on mount so the mousemove-driven re-renders below don't keep
  // reshuffling the bubbles.
  const bubbles = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        id: i,
        left: 4 + Math.random() * 92,
        size: 4 + Math.random() * 9,
        duration: 9 + Math.random() * 10,
        delay: -Math.random() * 18,
      })),
    []
  );

  const floodBubbles = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        id: i,
        left: 2 + Math.random() * 96,
        size: 5 + Math.random() * 12,
        duration: 12 + Math.random() * 14,
        delay: -Math.random() * 26,
      })),
    []
  );

  // The parallax offset lives in a plain ref, not state — this tick counter
  // only triggers one re-render per animation frame, so a fast mousemove burst
  // can't queue up more renders than the browser can paint.
  const [, setTick] = useState(0);
  const forceRender = useCallback(() => setTick((t) => t + 1), []);

  const handleMouseMove = useCallback(
    (e) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width - 0.5;
      const ny = (e.clientY - rect.top) / rect.height - 0.5;
      mouseRef.current = { x: nx * 26, y: ny * 18 };
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(forceRender);
    },
    [forceRender]
  );

  const handleMouseLeave = useCallback(() => {
    mouseRef.current = { x: 0, y: 0 };
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(forceRender);
  }, [forceRender]);

  const scrollToBrowse = useCallback(() => {
    document.getElementById('lib-browse')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const pill = pool.length > 0 ? `${pool.length} compounds and PubChem search` : 'Live PubChem search';

  return (
    <div className={`lib-root ${settled ? 'is-settled' : ''}`}>
      <LiquidFlood bubbles={floodBubbles} />

      {/* Phones don't get the tank — just the heading */}
      <div className="lib-m-head">
        <span className="lib-pill">
          <Sparkles size={14} /> {pill}
        </span>
        <h1 className="lib-title">
          <span>Compound</span> <span>Library.</span>
        </h1>
        <p className="lib-sub">
          Well-known molecules to explore, open in the Draw Lab, or view in 3D — and anything else,
          fetched live from PubChem.
        </p>
      </div>

      <div ref={containerRef} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} className="lib-stage">
        <div className="lib-tank">
          {/* Back wall of the tank: a solid slab so the tank reads as an object */}
          <div className="tank-back" />

          {/* Liquid inside the tank — drains as the valves open */}
          <div className="tank-liquid">
            <div className="tank-fill">
              <LiquidBody />
              <div className="solution-wash" />
              {bubbles.map((b) => (
                <span
                  key={b.id}
                  className="bubble"
                  style={{
                    left: `${b.left}%`,
                    width: b.size,
                    height: b.size,
                    animationDuration: `${b.duration}s`,
                    animationDelay: `${b.delay}s`,
                  }}
                />
              ))}
            </div>
          </div>

          {/* Front glass + reflections. Fades out completely. */}
          <div className="tank-shell">
            <span className="tank-gloss" />
          </div>

          {/* Steel rail the pipes bolt onto, then the pipes themselves */}
          <div className="tank-rail" />
          {LEAKS.map((l, i) => (
            <Pipe key={i} leak={l} />
          ))}

          {pool.length === 0 ? (
            <div className="lib-center lib-center--loading">
              <span className="hero-loading-pulse" />
              <p className="lib-loading-text">Loading library…</p>
            </div>
          ) : (
            <>
              <div className="lib-center">
                <span className="lib-pill">
                  <Sparkles size={14} /> {pill}
                </span>
                <h1 className="lib-title">
                  <span>Compound</span> <span>Library.</span>
                </h1>
                <p className="lib-sub">
                  Well-known molecules to explore, open in the Draw Lab, or view in 3D — and anything
                  else, fetched live from PubChem.
                </p>
                <div className="lib-cta-row">
                  <button type="button" className="lib-btn lib-btn--lime" onClick={scrollToBrowse}>
                    Browse compounds <ArrowDown size={16} strokeWidth={2.4} />
                  </button>
                  <Link to="/draw" className="lib-btn lib-btn--ink">
                    Open Draw Lab
                  </Link>
                </div>
              </div>

              {SLOTS.map((slot, i) => (
                <OrbitSlot key={i} pool={pool} slot={slot} slotIndex={i} mouse={mouseRef.current} />
              ))}
            </>
          )}
        </div>
      </div>

      <style>{`
        /* ================= stage & tank ================= */
        .lib-stage {
          position: relative;
          display: none;
          padding: 14px 0 178px; /* bottom room for the pipes + the first stretch of the streams */
        }
        .lib-m-head { display: block; padding: 28px 16px 8px; text-align: center; }
        @media (min-width: 640px) {
          .lib-stage { display: block; }
          .lib-m-head { display: none; }
        }
        .lib-tank {
          --asm: 104px; /* total height of one pipe assembly */
          --steel: linear-gradient(90deg, #939b85 0%, #f4f7ec 20%, #ffffff 32%, #d3d9c7 62%, #939b85 100%);
          position: relative;
          height: 400px;
          margin: 0 16px;
        }
        @media (min-width: 1024px) { .lib-tank { height: 440px; } }

        .tank-back {
          position: absolute; inset: 0; border-radius: 28px;
          background: linear-gradient(180deg, #ffffff 0%, #f1f6e2 100%);
          border: 1.5px solid rgba(14,16,10,0.55);
          /* stacked hard shadows = the slab's visible thickness */
          box-shadow:
            inset 0 2px 0 #fff,
            0 3px 0 #dbe5b9, 0 6px 0 #cfdba6, 0 9px 0 #c3d192, 0 12px 0 #b7c77f,
            0 44px 56px -22px rgba(70,95,10,0.45);
          animation: lib-fade-out ${T.shellDur}s ease-in-out ${T.shell}s forwards;
        }

        .tank-liquid {
          position: absolute; inset: 0; overflow: hidden; border-radius: 28px;
          animation: lib-fade-out ${T.shellDur + 0.7}s ease-in-out ${T.shell - 0.3}s forwards;
        }
        .tank-fill {
          --liq-a: 0.6;
          position: absolute; inset: 0;
          animation: lib-tank-drain ${T.drainDur}s cubic-bezier(0.45,0.05,0.55,0.95) ${T.flow}s forwards;
        }
        @keyframes lib-tank-drain { to { transform: translateY(72%); } }
        @keyframes lib-fade-out { to { opacity: 0; } }

        .tank-shell {
          position: absolute; inset: 0; border-radius: 28px; pointer-events: none; overflow: hidden;
          border: 1.5px solid rgba(255,255,255,0.9);
          background: linear-gradient(135deg, rgba(255,255,255,0.32), rgba(255,255,255,0) 38%, rgba(255,255,255,0) 70%, rgba(255,255,255,0.22));
          box-shadow: inset 0 0 0 1px rgba(14,16,10,0.06), inset 0 -18px 30px rgba(255,255,255,0.18);
          animation: lib-fade-out ${T.shellDur}s ease-in-out ${T.shell}s forwards;
        }
        .tank-gloss {
          position: absolute; top: -10%; bottom: -10%; left: 7%; width: 7%;
          background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.7), rgba(255,255,255,0));
          transform: skewX(-14deg);
        }
        .tank-gloss::after {
          content: ''; position: absolute; top: 0; bottom: 0; left: 210%; width: 34%;
          background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.4), rgba(255,255,255,0));
        }

        .tank-rail {
          position: absolute; left: 2.5%; right: 2.5%; top: calc(100% + 2px); height: 16px; z-index: 1;
          border-radius: 4px 4px 12px 12px;
          background: linear-gradient(180deg, #ffffff 0%, #dde2d3 42%, #b6bea9 100%);
          border: 1.5px solid rgba(14,16,10,0.55);
          box-shadow: inset 0 1px 0 #fff, 0 3px 0 #98a08a, 0 14px 16px -8px rgba(40,55,10,0.45);
          animation: lp-out ${T.shellDur}s ease-in-out ${T.shell}s forwards;
        }

        /* ================= outlet pipes ================= */
        .lp {
          position: absolute; top: calc(100% + 12px); z-index: 2;
          width: var(--pw); margin-left: calc(var(--pw) / -2);
          display: flex; flex-direction: column; align-items: center;
          pointer-events: none;
          animation:
            lp-build 0.7s cubic-bezier(0.16,1,0.3,1) var(--b) both,
            lp-out ${T.shellDur}s ease-in-out ${T.shell}s forwards;
        }
        @keyframes lp-build { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: none; } }
        @keyframes lp-out { to { opacity: 0; } }

        .lp-flange, .lp-lip, .lp-nozzle, .lp-valve {
          position: relative; flex: none; background: var(--steel);
          border: 1px solid rgba(14,16,10,0.5);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 3px rgba(40,55,10,0.3);
        }
        .lp-flange { width: calc(var(--pw) + 26px); height: 10px; border-radius: 4px; }
        /* bolts */
        .lp-flange::before, .lp-flange::after, .lp-lip::before, .lp-lip::after {
          content: ''; position: absolute; top: 50%; width: 4px; height: 4px; margin-top: -2px; border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, #fff, #8d9580);
          box-shadow: 0 0 0 0.5px rgba(14,16,10,0.55);
        }
        .lp-flange::before, .lp-lip::before { left: 5px; }
        .lp-flange::after, .lp-lip::after { right: 5px; }

        .lp-valve { z-index: 3; width: calc(var(--pw) + 14px); height: 34px; margin-top: -1px; border-radius: 9px; }
        .lp-valve::before, .lp-valve::after {
          content: ''; position: absolute; left: 6px; right: 6px; height: 1.5px; background: rgba(14,16,10,0.16);
        }
        .lp-valve::before { top: 7px; }
        .lp-valve::after { bottom: 7px; }

        .lp-pivot {
          position: absolute; left: 50%; top: 50%; z-index: 4; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, #fff, #c8cfbb 60%, #8d9580);
          border: 1.5px solid #0e100a;
        }
        /* Ball-valve lever: across the pipe = shut, along the pipe = open */
        .lp-arm {
          position: absolute; left: 50%; top: 50%; z-index: 3; width: 8px; height: 42px; margin: -4px 0 0 -4px;
          border-radius: 4px; border: 1.5px solid #0e100a;
          background: linear-gradient(90deg, #a9c81a, #e6f97a 42%, #ccEb2d 60%, #a9c81a);
          transform-origin: 50% 4px;
          transform: rotate(-90deg);
          animation:
            lp-arm-open 0.6s cubic-bezier(0.4,0,0.2,1) var(--vo) forwards,
            lp-arm-close 0.6s cubic-bezier(0.4,0,0.2,1) var(--vc) forwards;
        }
        .lp-arm::after {
          content: ''; position: absolute; left: 50%; bottom: -8px; width: 15px; height: 15px; margin-left: -7.5px; border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, #f4ffa8, #ccEb2d 55%, #9bb818);
          border: 1.5px solid #0e100a;
        }
        @keyframes lp-arm-open { from { transform: rotate(-90deg); } to { transform: rotate(0deg); } }
        @keyframes lp-arm-close { from { transform: rotate(0deg); } to { transform: rotate(-90deg); } }

        /* glass tube */
        .lp-pipe {
          position: relative; flex: none; overflow: hidden; width: var(--pw); height: 46px; margin-top: -1px;
          border-left: 1.5px solid rgba(14,16,10,0.55); border-right: 1.5px solid rgba(14,16,10,0.55);
          background: linear-gradient(90deg, rgba(150,160,130,0.35), rgba(255,255,255,0.9) 18%, rgba(255,255,255,0.4) 46%, rgba(225,232,205,0.6) 80%, rgba(140,150,120,0.5));
        }
        .lp-liq {
          position: absolute; inset: 0;
          clip-path: inset(0 0 100% 0);
          background:
            linear-gradient(180deg, transparent, rgba(255,255,255,0.6) 50%, transparent) 0 0 / 100% 26px repeat-y,
            linear-gradient(180deg, transparent, rgba(255,255,255,0.32) 50%, transparent) 0 0 / 100% 41px repeat-y,
            linear-gradient(180deg, #dcf45f, #ccEb2d 55%, #a6dc52);
          animation:
            lp-fill 0.5s ease-out var(--vf) forwards,
            lp-empty 0.5s ease-in var(--ve) forwards,
            lp-flow 0.8s linear infinite;
        }
        @keyframes lp-fill { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 0 0); } }
        @keyframes lp-empty { from { clip-path: inset(0 0 0 0); } to { clip-path: inset(100% 0 0 0); } }
        @keyframes lp-flow {
          from { background-position: 0 0, 0 0, 0 0; }
          to { background-position: 0 26px, 0 41px, 0 0; }
        }
        .lp-gloss {
          position: absolute; inset: 0; pointer-events: none;
          background: linear-gradient(90deg, rgba(255,255,255,0.85) 0, rgba(255,255,255,0) 24%, rgba(255,255,255,0) 66%, rgba(20,35,0,0.2) 100%);
        }

        .lp-lip { width: calc(var(--pw) + 16px); height: 9px; margin-top: -1px; border-radius: 3px; }
        .lp-nozzle { width: calc(var(--pw) - 6px); height: 9px; margin-top: -1px; border-radius: 0 0 8px 8px; }

        /* ================= streams ================= */
        .lp-stream {
          position: absolute; z-index: -5; pointer-events: none;
          top: calc(100% + 12px + var(--asm) - 3px);
          width: calc(var(--pw) - 8px); margin-left: calc((var(--pw) - 8px) / -2);
          height: min(78vh, 640px);
          transform-origin: top;
          animation:
            lp-stream-in 0.9s cubic-bezier(0.5,0,0.9,0.6) var(--fs) both,
            lp-stream-cut 0.8s cubic-bezier(0.5,0,0.9,0.4) var(--fc) forwards;
        }
        @keyframes lp-stream-in { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        @keyframes lp-stream-cut {
          from { clip-path: inset(0 -30px 0 -30px); }
          to { clip-path: inset(100% -30px 0 -30px); }
        }
        .lp-core {
          position: absolute; inset: 0;
          clip-path: polygon(0 0, 100% 0, 80% 100%, 20% 100%); /* narrows as it falls */
          background:
            linear-gradient(90deg, rgba(40,70,0,0.38), rgba(255,255,255,0.7) 24%, rgba(255,255,255,0.1) 52%, rgba(40,70,0,0.4)),
            linear-gradient(180deg, transparent, rgba(255,255,255,0.6) 50%, transparent) 0 0 / 100% 58px repeat-y,
            linear-gradient(180deg, transparent, rgba(255,255,255,0.34) 50%, transparent) 0 0 / 100% 91px repeat-y,
            linear-gradient(180deg, #dcf45f 0%, #ccEb2d 40%, #a6dc52 100%);
          animation: lp-stream-flow 0.9s linear infinite;
        }
        @keyframes lp-stream-flow {
          from { background-position: 0 0, 0 0, 0 0, 0 0; }
          to { background-position: 0 0, 0 58px, 0 91px, 0 0; }
        }
        .lp-drop {
          position: absolute; top: 0; width: 5px; height: 8px; opacity: 0;
          border-radius: 50% 50% 50% 50% / 62% 62% 38% 38%;
          background: #ccEb2d; border: 1px solid rgba(70,100,0,0.4);
          animation: lp-drop 1.15s cubic-bezier(0.5,0,1,0.6) infinite;
        }
        .lp-drop--a { left: calc(100% + 3px); animation-delay: 0.1s; }
        .lp-drop--b { right: calc(100% + 1px); width: 4px; height: 6px; animation-delay: 0.65s; }
        @keyframes lp-drop {
          0% { transform: translateY(8px); opacity: 0; }
          12% { opacity: 1; }
          100% { transform: translateY(320px); opacity: 0; }
        }

        /* ================= centre heading ================= */
        .lib-center {
          position: absolute; left: 50%; top: 50%; z-index: 10;
          width: min(560px, 90%); transform: translate(-50%, -50%);
          text-align: center; pointer-events: none;
        }
        .lib-center--loading { width: auto; }
        .lib-pill {
          display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px 7px 12px;
          border-radius: 999px; border: 1.5px solid #0e100a; background: #ffffff; color: #0e100a;
          font: 600 12.5px/1 var(--lib-font-body, system-ui, sans-serif);
          box-shadow: 0 3px 0 #0e100a;
        }
        .lib-pill svg { color: #6d8a00; }
        .lib-title {
          margin: 20px 0 0;
          font: 700 clamp(2.6rem, 5.9vw, 5rem)/0.98 var(--lib-font-display, system-ui, sans-serif);
          letter-spacing: -0.04em;
          color: #0e100a;
          /* extruded 3D type: a stack of one-pixel steps from lime down to olive, then a soft drop */
          text-shadow:
            1px 1px 0 #dcf45f, 2px 2px 0 #d3ee40, 3px 3px 0 #ccEb2d, 4px 4px 0 #c0de27, 5px 5px 0 #b4d222,
            6px 6px 0 #a8c61d, 7px 7px 0 #9cba19, 8px 8px 0 #90ad15, 9px 9px 0 #85a012,
            10px 13px 14px rgba(60,80,8,0.35), 14px 24px 32px rgba(60,80,8,0.25);
        }
        .lib-title span { display: block; }
        .lib-sub {
          max-width: 30rem; margin: 22px auto 0;
          font: 400 clamp(0.92rem, 1.25vw, 1.05rem)/1.55 var(--lib-font-body, system-ui, sans-serif);
          color: #454a3b;
        }
        .lib-cta-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 24px; pointer-events: auto; }
        .lib-m-head .lib-title { font-size: clamp(2.4rem, 12vw, 3.4rem); }
        .lib-m-head .lib-title span { display: inline; }
        .lib-m-head .lib-sub { margin-top: 18px; }

        .hero-loading-pulse {
          display: block; width: 10px; height: 10px; margin: 0 auto; border-radius: 50%; background: #ccEb2d;
          border: 1.5px solid #0e100a;
          animation: hero-loading-pulse 1.1s ease-in-out infinite;
        }
        .lib-loading-text { margin: 12px 0 0; font: 600 13px/1 var(--lib-font-body, system-ui, sans-serif); color: #7b816c; }
        @keyframes hero-loading-pulse {
          0%, 100% { opacity: 0.35; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.15); }
        }

        /* ================= orbiting 3D cards ================= */
        .oc-slot {
          position: absolute; top: var(--top); left: var(--left);
          transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @media (max-width: 1023px) {
          .oc-slot { top: var(--tab-top, var(--top)); left: var(--tab-left, var(--left)); }
          .oc--sm { width: 128px; }
          .oc--xs { width: 108px; }
        }
        .card-drift { animation: card-drift-float ease-in-out infinite; }
        @keyframes card-drift-float {
          0%, 100% { transform: translateY(0) rotate(var(--drift-rot)); }
          50% { transform: translateY(-9px) rotate(calc(var(--drift-rot) + 2.5deg)); }
        }
        .oc { position: relative; display: block; perspective: 800px; color: inherit; text-decoration: none; }
        .oc--xs { width: 118px; }
        .oc--sm { width: 148px; }
        .oc--md { width: 180px; }
        .oc-body { position: relative; display: block; transform-style: preserve-3d; transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1); }
        .oc-slab { position: absolute; inset: 0; border-radius: 16px; border: 1.5px solid rgba(14,16,10,0.55); }
        .oc-slab--1 { background: #c3e12b; transform: translate3d(2.5px, 3.5px, -7px); }
        .oc-slab--2 { background: #a3c018; transform: translate3d(5px, 7px, -14px); }
        .oc-face {
          position: relative; display: block; padding: 11px 12px 12px; border-radius: 16px;
          background: linear-gradient(160deg, #ffffff, #f6f9ea);
          border: 1.5px solid rgba(14,16,10,0.55);
          box-shadow: inset 0 1px 0 #fff, 0 22px 26px -14px rgba(60,80,8,0.55);
          transition: border-color 0.2s;
        }
        .oc:hover .oc-face, .oc:focus-visible .oc-face { border-color: #0e100a; }
        .oc--md .oc-face { padding: 13px 14px 14px; }
        .oc-cat {
          display: inline-block; padding: 2px 8px; border-radius: 999px;
          border: 1px solid var(--t-bd); background: var(--t-bg); color: var(--t-ink);
          font: 600 9.5px/1.4 var(--lib-font-body, system-ui, sans-serif);
        }
        .oc-name {
          display: block; margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font: 700 14px/1.2 var(--lib-font-display, system-ui, sans-serif); letter-spacing: -0.015em; color: #0e100a;
        }
        .oc-formula {
          display: block; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font: 500 12px/1.3 'IBM Plex Mono', ui-monospace, monospace; color: #454a3b;
        }
        .oc-formula sub { font-size: 0.7em; line-height: 0; vertical-align: -0.25em; }
        @media (max-width: 1023px) { .oc-lg-only { display: none; } }
        @media (max-width: 767px) { .oc-sm-only { display: none; } }

        /* ================= liquid (tank + flood) ================= */
        .lib-liquid { position: absolute; inset: 0; opacity: var(--liq-a); }
        .lib-body { position: absolute; inset: 0; background: linear-gradient(180deg, #dcf45f 0%, #b9e64a 45%, #6fd6a6 100%); }
        .lib-wave { position: absolute; left: 0; top: -59px; width: 200%; height: 60px; animation: lib-wave-slide 9s linear infinite; }
        .lib-wave-front path { fill: #dcf45f; }
        .lib-wave-back { top: -64px; animation-duration: 14s; animation-direction: reverse; }
        .lib-wave-back path { fill: #9fe08a; }
        @keyframes lib-wave-slide { from { transform: translateX(0); } to { transform: translateX(-50%); } }

        .solution-wash {
          position: absolute; inset: -25%;
          background:
            radial-gradient(ellipse 60% 50% at 28% 18%, rgba(255,255,255,0.55), transparent 60%),
            radial-gradient(ellipse 55% 45% at 78% 72%, rgba(111,214,166,0.35), transparent 60%);
        }
        .bubble {
          position: absolute; bottom: -5%; border-radius: 50%;
          background: radial-gradient(circle at 32% 28%, rgba(255,255,255,0.95), rgba(255,255,255,0.35) 45%, rgba(90,160,20,0.22) 64%, transparent 74%);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.7);
          animation-name: bubble-rise; animation-timing-function: linear; animation-iteration-count: infinite;
        }
        @keyframes bubble-rise {
          0% { transform: translateY(0) translateX(0); opacity: 0; }
          12% { opacity: 0.85; }
          50% { transform: translateY(-190px) translateX(8px); }
          88% { opacity: 0.5; }
          100% { transform: translateY(-380px) translateX(-6px); opacity: 0; }
        }

        /* Fixed page-wide flood. z-index -10 puts it above the page canvas but
           behind every piece of content (LibraryPage makes <body> transparent
           while this page is open, so nothing paints over it). */
        .lib-flood { position: fixed; inset: 0; z-index: -10; overflow: hidden; pointer-events: none; }
        .lib-rise {
          --liq-a: 0.34;
          position: absolute; top: 0; left: 0; right: 0; bottom: -80px; /* extra height so the final lift leaves no gap */
          transform: translateY(100%);
          will-change: transform;
          animation: lib-rise ${T.riseDur}s cubic-bezier(0.32,0.7,0.3,1) ${T.rise}s forwards;
        }
        @keyframes lib-rise { to { transform: translateY(-72px); } }
        .lib-caustic {
          position: absolute; width: 60vw; height: 60vw; border-radius: 9999px; will-change: transform;
          background: radial-gradient(circle, rgba(255,255,255,0.55), transparent 65%);
          animation: lib-caustic-drift 26s ease-in-out infinite alternate;
        }
        .lib-caustic-a { top: 5%; left: -10%; }
        .lib-caustic-b {
          top: 40%; right: -15%;
          background: radial-gradient(circle, rgba(204,235,45,0.4), transparent 65%);
          animation-duration: 32s; animation-direction: alternate-reverse;
        }
        @keyframes lib-caustic-drift {
          from { transform: translate3d(0, 0, 0) scale(1); }
          to { transform: translate3d(9vw, 7vh, 0) scale(1.15); }
        }
        .lib-bubble {
          position: absolute; bottom: 60px; border-radius: 50%;
          background: radial-gradient(circle at 32% 28%, rgba(255,255,255,0.95), rgba(255,255,255,0.35) 45%, rgba(90,160,20,0.22) 64%, transparent 74%);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.7);
          animation-name: lib-bubble-rise; animation-timing-function: linear; animation-iteration-count: infinite;
        }
        @keyframes lib-bubble-rise {
          0% { transform: translate3d(0, 0, 0); opacity: 0; }
          10% { opacity: 0.75; }
          90% { opacity: 0.4; }
          100% { transform: translate3d(14px, -115vh, 0); opacity: 0; }
        }

        /* Phones don't show the tank, so the flood shouldn't wait for it */
        @media (max-width: 639px) {
          .lib-rise { animation-delay: 0.2s; }
        }

        /* Already seen this session (REPLAY_EVERY_VISIT = false): skip straight to the end state */
        .is-settled .tank-back, .is-settled .tank-liquid, .is-settled .tank-shell,
        .is-settled .tank-rail, .is-settled .lp, .is-settled .lp-stream { display: none; }
        .is-settled .lib-rise { animation: none; transform: translateY(-72px); }
        .is-settled .lib-flood { animation: lib-flood-in 0.9s ease-out both; }
        @keyframes lib-flood-in { from { opacity: 0; } to { opacity: 1; } }

        @media (prefers-reduced-motion: reduce) {
          .card-drift, .bubble, .lib-wave, .lib-caustic, .lib-bubble, .lp-core, .lp-drop { animation: none; }
          .tank-back, .tank-liquid, .tank-shell, .tank-rail, .lp, .lp-stream { display: none; }
          .lib-rise { animation: none; transform: translateY(-72px); }
        }
      `}</style>
    </div>
  );
}