import { useEffect, useId, useRef, useState } from 'react';

/**
 * The blue "road" that grows out of the ring in the hero and follows the
 * reader down the page as they scroll.
 *
 * How it works
 * ------------
 * 1. MEASURE — the page marks spots with data-road attributes:
 *      probe : invisible ruler; its left/width/height carry the gutter x,
 *              the road thickness and the corner radius (all from CSS vars)
 *      ring  : the hero ring (the road starts at its bottom)
 *      bend  : ANY NUMBER of zero-size markers, each fixing one turn's
 *              (x, y) via its own CSS `left`/`top`. Zero, one, or many —
 *              the road threads through them, in DOCUMENT ORDER, alternating
 *              a straight drop down to the marker's y with a turn to its x.
 *      run2  : y of the mandatory final horizontal run that lines the road
 *              back up with the closing marker's x, right before it ends
 *      end   : the point the road terminates at. The road's final leg feeds
 *              up into a small circular loop centred on this marker (credit
 *              text sits inside the loop), and — unlike the hero ring,
 *              which is always fully drawn — the loop itself is traced by
 *              the SAME animated stroke as the road, as the final bit of
 *              down-scroll, so it visibly closes as the reader reaches it.
 *    From those we build ONE SVG path made of straight, axis-aligned legs
 *    joined by rounded corners: ring -> [down -> turn]  x N bends -> down ->
 *    turn to the end marker's x -> down to the TOP EDGE of the end loop ->
 *    two arcs tracing the loop closed.
 *
 * 2. MAP SCROLL -> LENGTH — the scroll position is turned into "how much of
 *    the path is drawn" by walking the same list of legs: a vertical leg's
 *    drawn length tracks the reader's position directly (so the tip sits
 *    ~62% down the viewport, just ahead of what's being read); a horizontal
 *    leg (a turn) is swept over a short, fixed scroll distance so it reads
 *    as a deliberate turn instead of snapping. This generalizes to any
 *    number of bends — add or remove a `data-road="bend"` marker and the
 *    map rebuilds itself around it. The very last stretch of scroll — the
 *    same reserved buffer that used to just be dead space at the bottom of
 *    the page — is spent sweeping the end loop shut, the same way a turn
 *    sweeps.
 *
 * 3. DRAW — stroke-dasharray reveals that length, with a little critically-
 *    damped easing so the tip glides even when the wheel is jumpy. Only the
 *    hero ring is drawn as a separate, always-fully-drawn shape; the end
 *    loop is part of the single animated path.
 *
 * Everything re-measures on resize / layout change (ResizeObserver), so it
 * stays glued to the layout at any width.
 */

const HEAD_FRACTION = 0.62; // where the tip sits in the viewport while descending
const SWEEP_VH = 0.3; // how much scroll (as a fraction of viewport height) each turn takes to sweep
const MIN_LEG_SCROLL = 60; // minimum scroll distance guaranteed to each vertical leg
const END_RING_SCALE = 0.6; // end loop radius, as a fraction of the hero ring's radius — tweak to resize the loop

function buildPath(points, cornerR) {
  const n = points.length;
  const dirs = [];
  const lens = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const len = Math.hypot(dx, dy);
    dirs.push({ x: len ? dx / len : 0, y: len ? dy / len : 0 });
    lens.push(len);
  }

  let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  let cursor = { ...points[0] };
  let length = 0;
  const cornerStart = {};
  const cornerEnd = {};
  const radii = {};

  for (let i = 1; i < n - 1; i += 1) {
    const r = Math.max(0, Math.min(cornerR, lens[i - 1] / 2, lens[i] / 2));
    radii[i] = r;
    const a = { x: points[i].x - dirs[i - 1].x * r, y: points[i].y - dirs[i - 1].y * r };
    const b = { x: points[i].x + dirs[i].x * r, y: points[i].y + dirs[i].y * r };
    d += ` L${a.x.toFixed(2)},${a.y.toFixed(2)}`;
    length += Math.hypot(a.x - cursor.x, a.y - cursor.y);
    cornerStart[i] = length;
    const cross = dirs[i - 1].x * dirs[i].y - dirs[i - 1].y * dirs[i].x;
    d += ` A${r.toFixed(2)},${r.toFixed(2)} 0 0 ${cross > 0 ? 1 : 0} ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
    length += (Math.PI * r) / 2;
    cornerEnd[i] = length;
    cursor = b;
  }

  const last = points[n - 1];
  d += ` L${last.x.toFixed(2)},${last.y.toFixed(2)}`;
  length += Math.hypot(last.x - cursor.x, last.y - cursor.y);
  return { d, length, cornerStart, cornerEnd, radii };
}

const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));

// The origin ring is drawn as a regular hexagon (a benzene shape) instead
// of a circle. One vertex sits directly below the centre — at (cx, cy+r) —
// so it lines up exactly with the point the road's first leg already
// starts from, and directly above at (cx, cy-r), keeping the shape
// symmetric on the vertical axis the same way the old circle was.
function hexagonPath(cx, cy, r) {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = ((90 + 60 * i) * Math.PI) / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  return `M${pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L')} Z`;
}

export default function RoadLine({ rootRef }) {
  const pathRef = useRef(null);
  const [geo, setGeo] = useState(null);
  const stateRef = useRef({ head: () => 0, top: 0, total: 0, cur: 0, intro: true });
  // A single shared gradient (defined below, in userSpaceOnUse coordinates)
  // that both the ring and the road path read from, so their colors stay
  // continuous across the two separate <path> elements.
  const gradientId = `ix-road-gradient-${useId()}`;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = 0;
    let disposed = false;

    const apply = (len) => {
      const p = pathRef.current;
      if (!p) return;
      const total = stateRef.current.total;
      p.style.strokeDasharray = `${Math.max(0, len).toFixed(1)} ${(total + 40).toFixed(1)}`;
    };

    const tick = (now) => {
      raf = 0;
      if (disposed) return;
      const st = stateRef.current;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      const target = st.head(window.scrollY - st.top);
      if (reduce) {
        st.cur = target;
      } else {
        const rate = st.intro ? 4.2 : 13;
        st.cur += (target - st.cur) * (1 - Math.exp(-dt * rate));
      }
      apply(st.cur);
      if (Math.abs(target - st.cur) > 0.01) raf = requestAnimationFrame(tick);
      else st.intro = false;
    };

    const wake = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    const measure = () => {
      const q = (name) => root.querySelector(`[data-road="${name}"]`);
      const probe = q('probe');
      const ring = q('ring');
      const run2 = q('run2');
      const end = q('end');
      const bendEls = Array.from(root.querySelectorAll('[data-road="bend"]'));
      if (!probe || !ring || !run2 || !end) return;

      const rootRect = root.getBoundingClientRect();
      const rel = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - rootRect.left, y: r.top - rootRect.top, w: r.width, h: r.height };
      };

      const T = probe.offsetWidth;
      const cornerR = probe.offsetHeight;

      const rg = rel(ring);
      const rcx = rg.x + rg.w / 2;
      const rcy = rg.y + rg.h / 2;
      const ringR = rg.w / 2 - T / 2; // centre-line radius of the hero ring

      const eg = rel(end);
      const ecx = eg.x + eg.w / 2;
      const ecy = eg.y + eg.h / 2;
      const endRingR = Math.max(ringR * END_RING_SCALE, T); // centre-line radius of the end loop

      const run2Y = rel(run2).y;
      const bends = bendEls.map(rel); // each carries its own x AND y

      // ---- build the waypoint list: ring -> each bend in turn -> align with
      // the ring's x at run2Y -> straight down, stopping at the TOP EDGE of
      // the end loop (not its centre) so the road visibly feeds into it.
      // Zero bends still works: it's just the single mandatory turn to end.
      const pts = [{ x: rcx, y: rcy + ringR }];
      let curX = rcx;
      bends.forEach((b) => {
        pts.push({ x: curX, y: b.y });
        pts.push({ x: b.x, y: b.y });
        curX = b.x;
      });
      pts.push({ x: curX, y: run2Y });
      pts.push({ x: ecx, y: run2Y });
      pts.push({ x: ecx, y: ecy - endRingR });

      // Sanity: every leg must move strictly downward or sideways (never up,
      // never zero-length), or we'd draw junk.
      let ok = true;
      for (let i = 0; ok && i < pts.length - 1; i += 1) {
        const dx = pts[i + 1].x - pts[i].x;
        const dy = pts[i + 1].y - pts[i].y;
        if (dy < -4) ok = false; // never doubles back up
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) ok = false; // degenerate leg
      }
      if (!ok) {
        setGeo(null);
        return;
      }

      const n = pts.length;
      const path = buildPath(pts, cornerR);
      const straightLen = path.length; // length up to the top edge of the end loop, loop not included yet

      // ---- append the end loop onto the SAME path, as two 180° arcs from
      // the top of the loop, clockwise, back to the top of the loop. Since
      // it continues straight on from the last `L` command with no `M`,
      // it's one unbroken stroke — so the existing dasharray reveal draws
      // the loop closing exactly like it draws every other leg.
      const loopBottom = `${ecx.toFixed(2)},${(ecy + endRingR).toFixed(2)}`;
      const loopTop = `${ecx.toFixed(2)},${(ecy - endRingR).toFixed(2)}`;
      const rStr = endRingR.toFixed(2);
      const d = `${path.d} A${rStr},${rStr} 0 1,1 ${loopBottom} A${rStr},${rStr} 0 1,1 ${loopTop}`;
      const circumference = 2 * Math.PI * endRingR;
      const total = straightLen + circumference; // full length, straight road + closed loop

      // ---- scroll -> drawn-length map ------------------------------------
      const vh = window.innerHeight;
      const headY = HEAD_FRACTION * vh;
      const top = rootRect.top + window.scrollY;
      const maxS = Math.max(1, rootRect.height - vh);
      const sweep = Math.max(160, SWEEP_VH * vh);

      // initial stem length: reaches ~73% of the first screen (never shorter
      // than a stub, never past where the first corner starts)
      const initY = Math.max(0.73 * vh, pts[0].y + 90);
      const firstCornerLen = n > 2 ? path.cornerStart[1] : path.length;
      const Linit = Math.min(firstCornerLen - 8, Math.max(60, initY - pts[0].y));

      // Walk every leg once, building (scroll, length-drawn) checkpoints.
      // Vertical legs track the reader's position directly; horizontal legs
      // (turns) are swept over a fixed scroll budget so they read as a turn.
      // The scroll budget reserved for the final leg (`sweep`) is spent on
      // sweeping the end loop shut, once the straight road reaches its top.
      const checkpoints = [{ s: 0, len: Linit }];
      let sCursor = 0;
      for (let i = 0; i < n - 1; i += 1) {
        const dy = pts[i + 1].y - pts[i].y;
        const dx = pts[i + 1].x - pts[i].x;
        const isVertical = Math.abs(dy) >= Math.abs(dx);
        const segEndLen = i + 1 === n - 1 ? straightLen : path.cornerStart[i + 1];
        if (isVertical) {
          const rAfter = i + 1 === n - 1 ? 0 : path.radii[i + 1] ?? 0;
          const yEnd = pts[i + 1].y - rAfter;
          let sReach = Math.max(sCursor + MIN_LEG_SCROLL, yEnd - headY);
          sReach = Math.min(sReach, maxS - sweep);
          checkpoints.push({ s: sReach, len: segEndLen });
          sCursor = sReach;
        } else {
          const sEnd = Math.min(sCursor + sweep, maxS - sweep);
          checkpoints.push({ s: sEnd, len: segEndLen });
          sCursor = sEnd;
        }
      }
      // final stretch of scroll: sweep the loop shut, straightLen -> total
      checkpoints.push({ s: maxS, len: total });

      const head = (s) => {
        if (s <= 0) return Linit;
        for (let i = 1; i < checkpoints.length; i += 1) {
          if (s <= checkpoints[i].s) {
            const a = checkpoints[i - 1];
            const b = checkpoints[i];
            return lerp(a.len, b.len, (s - a.s) / Math.max(1, b.s - a.s));
          }
        }
        return total;
      };

      const st = stateRef.current;
      st.head = head;
      st.top = top;
      st.total = total;

      setGeo({
        w: rootRect.width,
        h: rootRect.height,
        t: T,
        d,
        ring: { cx: rcx, cy: rcy, r: ringR },
      });
      // (re)paint immediately with the new geometry
      requestAnimationFrame(() => {
        if (disposed) return;
        apply(stateRef.current.cur);
        wake();
      });
    };

    let measureTimer = 0;
    const scheduleMeasure = () => {
      window.clearTimeout(measureTimer);
      measureTimer = window.setTimeout(measure, 60);
    };

    measure();
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(root);
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('load', scheduleMeasure);
    window.addEventListener('scroll', wake, { passive: true });
    if (document.fonts?.ready) document.fonts.ready.then(scheduleMeasure);
    const late = [400, 1200, 2600].map((ms) => window.setTimeout(measure, ms));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(measureTimer);
      late.forEach((id) => window.clearTimeout(id));
      ro.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('load', scheduleMeasure);
      window.removeEventListener('scroll', wake);
    };
  }, [rootRef]);

  if (!geo) return null;

  // A colorful, ever-flowing "liquid" gradient — five brand hues cycling
  // continuously through the stops, each stop offset in time from the
  // next so the colors appear to stream along the road. gradientUnits is
  // userSpaceOnUse (not the default objectBoundingBox) with coordinates
  // fixed to the SVG's own full height, so the hero ring and the road path
  // (which now includes the end loop) — two separate <path> elements with
  // two different bounding boxes — read off the exact same gradient
  // instead of each stretching it across its own box, which is what
  // caused mismatched, seam-like color jumps between them.
  const flowPalette = ['#14b8a6', '#22d3ee', '#8b5cf6', '#ec4899', '#f59e0b'];
  const flowDur = 12;
  const flowValues = `${flowPalette.join(';')};${flowPalette[0]}`;

  return (
    <svg
      className="ix-road"
      width={geo.w}
      height={geo.h}
      viewBox={`0 0 ${geo.w} ${geo.h}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2={geo.h}
        >
          {flowPalette.map((color, i) => (
            <stop key={i} offset={`${(i / (flowPalette.length - 1)) * 100}%`} stopColor={color}>
              <animate
                attributeName="stop-color"
                values={flowValues}
                dur={`${flowDur}s`}
                begin={`${-(i / flowPalette.length) * flowDur}s`}
                repeatCount="indefinite"
              />
            </stop>
          ))}
        </linearGradient>
      </defs>

      {/* the benzene-shaped ring the road grows out of — always fully drawn */}
      <path
        d={hexagonPath(geo.ring.cx, geo.ring.cy, geo.ring.r)}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={geo.t}
        strokeLinejoin="round"
      />
      <path
        ref={pathRef}
        d={geo.d}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={geo.t}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="0 100000"
      />
    </svg>
  );
}