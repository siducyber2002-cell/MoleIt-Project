import { useEffect, useMemo, useRef, useState } from 'react';
import {
  motion,
  useDragControls,
  useReducedMotion,
  useMotionValue,
  useTransform,
  useScroll,
  useSpring,
  animate,
  AnimatePresence,
} from 'framer-motion';
import { Newspaper, ExternalLink, RefreshCw, Radio, Pin, PlayCircle, ArrowDown } from 'lucide-react';
import { fetchNews, fetchNewsSources, fetchNewsVideoSources, refreshNews, extractErrorMessage } from '../api/api';
import { Reveal, StaggerGroup, StaggerItem, Word, EASE } from '../components/motion/ScrollReveal';

function timeAgo(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr).getTime();
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// Stable per-card tilt/pin so the pinboard doesn't jitter on re-render —
// derived from the article id rather than Math.random().
function hashTo(id, min, max) {
  const str = String(id ?? '');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  const norm = (Math.abs(hash) % 1000) / 1000; // 0..1
  return min + norm * (max - min);
}

const PIN_COLORS = ['dp-pin--coral', 'dp-pin--violet', 'dp-pin--teal', 'dp-pin--red'];
const IMAGE_RATIOS = ['aspect-[4/3]', 'aspect-video', 'aspect-square'];

// Jagged "torn paper" bottom edge for the front-page lead story.
const TORN_EDGE_CLIP =
  'polygon(0% 0%,100% 0%,100% 92%,96% 100%,90% 90%,84% 100%,78% 91%,72% 99%,66% 90%,60% 100%,54% 92%,48% 100%,42% 91%,36% 99%,30% 90%,24% 100%,18% 91%,12% 99%,6% 90%,0% 98%)';

// ---------------------------------------------------------------------------
// Highlighter mark — matches the homepage's marker-stroke treatment, new
// accent color, and animates its own width in rather than being static.
// ---------------------------------------------------------------------------
function DPMark({ children, delay = 0 }) {
  return (
    <span className="dp-mark">
      <motion.span
        className="dp-mark__bg"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.5, delay, ease: EASE }}
      />
      <span className="dp-mark__text">{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Empty state — "nothing on the wire". A little broadcast dial sweeping for
// a signal, in place of the old static Newspaper icon, with headline slugs
// dropping in one at a time as if a wire feed is about to come through.
// ---------------------------------------------------------------------------
function EmptySignal() {
  const slugs = ['ORGANIC CHEM WIRE', 'SPECTRA DESK', 'LAB NOTES SYNDICATE'];

  return (
    <div className="dp-signal">
      <div className="dp-signal__dial">
        <motion.span
          className="dp-signal__ring"
          animate={{ scale: [0.6, 1.6], opacity: [0.55, 0] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeOut' }}
        />
        <motion.span
          className="dp-signal__ring dp-signal__ring--delay"
          animate={{ scale: [0.6, 1.6], opacity: [0.55, 0] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeOut', delay: 1.1 }}
        />
        <motion.span
          className="dp-signal__sweep"
          animate={{ rotate: 360 }}
          transition={{ duration: 3.4, repeat: Infinity, ease: 'linear' }}
        />
        <Radio size={20} className="dp-signal__icon" />
      </div>

      <p className="dp-signal__title">Nothing on the wire yet</p>
      <p className="dp-signal__subtitle">No articles yet — try refreshing.</p>

      <div className="dp-signal__slugs">
        {slugs.map((s, i) => (
          <motion.span
            key={s}
            className="dp-signal__slug"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: [0, 1, 1, 0], y: [-4, 0, 0, 4] }}
            transition={{ duration: 2.6, repeat: Infinity, delay: i * 0.9, times: [0, 0.15, 0.75, 1] }}
          >
            {s}
          </motion.span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero icon — a small fanned stack of headline clippings that idly bob at
// their own pace, plus a "Fresh" ink stamp. Swaps out the old ring-and-
// orbiting-dots motif for something that doesn't echo the homepage.
// ---------------------------------------------------------------------------
const STACK_CARDS = [
  { rotate: -11, x: -36, y: 8, accent: 'var(--dp-coral)', delay: 0 },
  { rotate: 5, x: 16, y: -10, accent: 'var(--dp-teal)', delay: 0.5 },
  { rotate: -3, x: 42, y: 16, accent: 'var(--dp-violet)', delay: 1 },
];

function DispatchStack() {
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useTransform(my, [-50, 50], [8, -8]);
  const rotateY = useTransform(mx, [-50, 50], [-8, 8]);

  const handleMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    mx.set(e.clientX - r.left - r.width / 2);
    my.set(e.clientY - r.top - r.height / 2);
  };
  const handleLeave = () => {
    animate(mx, 0, { type: 'spring', stiffness: 200, damping: 20 });
    animate(my, 0, { type: 'spring', stiffness: 200, damping: 20 });
  };

  return (
    <motion.div
      className="dp-stack"
      style={{ rotateX, rotateY }}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
    >
      {STACK_CARDS.map((c, i) => (
        <motion.div
          key={i}
          className="dp-stack__card"
          style={{ '--rot': `${c.rotate}deg`, '--tx': `${c.x}px`, '--ty': `${c.y}px`, borderTopColor: c.accent, zIndex: i }}
          animate={{ y: [0, -9, 0] }}
          transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut', delay: c.delay }}
        >
          <span className="dp-stack__pin" style={{ background: c.accent }} />
          <span className="dp-stack__line dp-stack__line--title" />
          <span className="dp-stack__line" />
          <span className="dp-stack__line dp-stack__line--short" />
        </motion.div>
      ))}
      <motion.div
        className="dp-stack__stamp"
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.4, ease: EASE }}
      >
        Fresh
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------
function DispatchHero({ today, onScrollDown }) {
  return (
    <section className="dp-hero">
      <div className="dp-hero__copy">
        <Reveal trigger="mount" direction="none">
          <span className="dp-label">01 / Dispatch</span>
        </Reveal>

        <Reveal trigger="mount" delay={0.08} className="dp-hero__mark">
          <span className="dp-hero__mark-icon">
            <Radio size={16} />
          </span>
          <span className="dp-hero__mark-text">{today}</span>
        </Reveal>

        <StaggerGroup as="h1" trigger="mount" stagger={0.05} delayChildren={0.18} className="dp-h1">
          <Word>The</Word> <Word className="dp-h1--accent">Dispatch</Word>
        </StaggerGroup>

        <Reveal trigger="mount" delay={0.5} className="dp-hero__tagline">
          Chemistry news stops being noise here —{' '}
          <DPMark delay={0.75}>curated, cross-checked,</DPMark> and actually worth your five minutes.
        </Reveal>

        <Reveal trigger="mount" delay={0.65}>
          <button type="button" className="dp-scroll" onClick={onScrollDown}>
            Scroll
            <motion.span
              className="dp-scroll__arrow"
              animate={{ y: [0, 5, 0] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <ArrowDown size={14} />
            </motion.span>
          </button>
        </Reveal>
      </div>

      <Reveal direction="none" trigger="mount" delay={0.25} className="dp-hero__orbit-wrap">
        <DispatchStack />
      </Reveal>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------
function Ticker({ headlines }) {
  const prefersReducedMotion = useReducedMotion();
  const items = headlines.length > 0 ? headlines : ['Fetching the latest breakthroughs from the lab…'];
  const doubled = [...items, ...items];

  return (
    <div className="dp-ticker">
      <span className="dp-ticker__badge">
        <motion.span
          className="dp-ticker__pulse"
          animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
        />
        Live
      </span>
      <div className="dp-ticker__viewport">
        <div
          className="dp-ticker__track"
          style={prefersReducedMotion ? undefined : { animationDuration: `${Math.max(18, items.length * 6)}s` }}
        >
          {doubled.map((headline, i) => (
            <span key={i} className="dp-ticker__item">
              <span className="dp-ticker__dot">•</span>
              {headline}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strip — a quiet one-line statement, broken by a ring of dots, that's tied
// directly to scroll position rather than autoplaying once on entry: the
// two halves sit apart and the dot-wheel sits mid-turn while the strip is
// still below the fold, and BOTH move in lockstep with the scrollbar as
// you scroll it into view — wheel turning, halves sliding in — like a
// pulley. Scroll back up and it pulls back apart the same way. The text
// itself stays fully readable throughout (only position/rotation animate,
// never opacity) and scrollYProgress is run through a spring so the motion
// stays fluid instead of jumping in lockstep with each raw wheel tick.
// Modeled on the "we build around [icon] your existing tech" trust-line
// pattern.
// ---------------------------------------------------------------------------
const STRIP_DOTS = Array.from({ length: 6 });

function DispatchStrip() {
  const ref = useRef(null);
  const prefersReducedMotion = useReducedMotion();
  // progress 0 while the strip's top is still near the bottom of the
  // viewport (not yet scrolled to); progress 1 once it's scrolled up to
  // just above center — a short, deliberate scroll range so the "pull"
  // reads clearly rather than finishing instantly.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start 0.92', 'start 0.35'],
  });
  // Smooth the raw scroll progress with a spring so the wheel and the two
  // halves glide continuously between wheel-tick updates rather than
  // stepping — this is what makes the rotation read as "smooth" rather
  // than mechanical.
  const smoothProgress = useSpring(scrollYProgress, { stiffness: 110, damping: 24, mass: 0.4 });

  const leftX = useTransform(smoothProgress, [0, 1], [-90, 0]);
  const rightX = useTransform(smoothProgress, [0, 1], [90, 0]);
  // Two full turns rather than a partial swing — much more visible motion
  // over the same scroll distance.
  const rotate = useTransform(smoothProgress, [0, 1], [-720, 0]);

  return (
    <div className="dp-strip" ref={ref}>
      <motion.span
        className="dp-strip__half"
        style={prefersReducedMotion ? undefined : { x: leftX }}
      >
        One feed, pulled from every source we trust
      </motion.span>

      <motion.span
        className="dp-strip__icon"
        style={prefersReducedMotion ? undefined : { rotate }}
        aria-hidden="true"
      >
        {STRIP_DOTS.map((_, i) => (
          <span key={i} className="dp-strip__dot" style={{ '--i': i }} />
        ))}
      </motion.span>

      <motion.span
        className="dp-strip__half"
        style={prefersReducedMotion ? undefined : { x: rightX }}
      >
        so nothing worth reading slips past you
      </motion.span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lead story — front page, with a subtle mouse-tilt on the image
// ---------------------------------------------------------------------------
function LeadStory({ article }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(article.image_url) && !imageFailed;

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useTransform(my, [-60, 60], [4, -4]);
  const rotateY = useTransform(mx, [-60, 60], [-4, 4]);
  const handleMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    mx.set(e.clientX - r.left - r.width / 2);
    my.set(e.clientY - r.top - r.height / 2);
  };
  const handleLeave = () => {
    animate(mx, 0, { type: 'spring', stiffness: 200, damping: 20 });
    animate(my, 0, { type: 'spring', stiffness: 200, damping: 20 });
  };

  return (
    <Reveal
      as="a"
      href={article.link}
      target="_blank"
      rel="noopener noreferrer"
      trigger="mount"
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={{ rotateX, rotateY }}
      className={`dp-lead group ${showImage ? 'dp-lead--image' : ''}`}
    >
      {showImage && (
        <div className="dp-lead__frame" style={{ clipPath: TORN_EDGE_CLIP }}>
          <img
            src={article.image_url}
            alt=""
            className="dp-lead__img"
            onError={() => setImageFailed(true)}
          />
          <span className="dp-lead__badge">Front page</span>
        </div>
      )}
      <div className={showImage ? 'dp-lead__body dp-lead__body--overlap' : 'dp-lead__body'}>
        {!showImage && <span className="dp-lead__badge dp-lead__badge--static">Front page</span>}
        <div className="dp-lead__meta">
          <span>{article.source}</span>
          {article.published_at && (
            <>
              <span className="dp-dot-sep">·</span>
              <span>{timeAgo(article.published_at)}</span>
            </>
          )}
        </div>
        <h2 className="dp-lead__title">{article.title}</h2>
        {article.summary && <p className="dp-lead__summary">{article.summary}</p>}
        <span className="dp-lead__cta">
          Read the full story <ExternalLink size={13} />
        </span>
      </div>
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// Pinboard clipping — draggable, pinned, light-paper card
// ---------------------------------------------------------------------------
function ClippingCard({ article, index, boardRef }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(article.image_url) && !imageFailed;
  const dragControls = useDragControls();
  const prefersReducedMotion = useReducedMotion();

  const angle = useMemo(() => hashTo(article.id, -3.5, 3.5), [article.id]);
  const pinColor = PIN_COLORS[index % PIN_COLORS.length];
  const imageRatio = IMAGE_RATIOS[index % IMAGE_RATIOS.length];

  return (
    <motion.div
      drag={!prefersReducedMotion}
      dragControls={dragControls}
      dragListener={false}
      dragConstraints={boardRef}
      dragElastic={0.15}
      dragSnapToOrigin
      dragTransition={{ bounceStiffness: 420, bounceDamping: 24 }}
      initial={{ rotate: angle, opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      whileHover={{ rotate: 0, scale: 1.025, zIndex: 20 }}
      whileDrag={{ scale: 1.06, zIndex: 30, rotate: 0, boxShadow: '0 22px 40px rgba(38,38,38,0.22)' }}
      transition={{ duration: 0.45 }}
      style={{ rotate: prefersReducedMotion ? 0 : angle, touchAction: 'pan-y' }}
      className="dp-clip group"
    >
      <button
        type="button"
        onPointerDown={(e) => dragControls.start(e)}
        title="Drag to move"
        className={`dp-pin ${pinColor}`}
      >
        <Pin size={11} fill="currentColor" />
      </button>

      {showImage && (
        <div className={`dp-clip__frame ${imageRatio}`}>
          <img
            src={article.image_url}
            alt=""
            className="dp-clip__img"
            onError={() => setImageFailed(true)}
            draggable={false}
          />
        </div>
      )}
      <div className="dp-clip__body">
        <div className="dp-clip__meta">
          <span>{article.source}</span>
          {article.published_at && <span className="dp-clip__time">{timeAgo(article.published_at)}</span>}
        </div>
        <h3 className="dp-clip__title">{article.title}</h3>
        {article.summary && <p className="dp-clip__summary">{article.summary}</p>}
        <a href={article.link} target="_blank" rel="noopener noreferrer" className="dp-clip__cta">
          Read article <ExternalLink size={12} />
        </a>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Video card
// ---------------------------------------------------------------------------
function VideoCard({ article }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(article.image_url) && !imageFailed;

  return (
    <a href={article.link} target="_blank" rel="noopener noreferrer" className="dp-video group">
      <div className="dp-video__frame">
        {showImage ? (
          <img
            src={article.image_url}
            alt=""
            className="dp-video__img"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="dp-video__fallback">
            <Newspaper size={30} />
          </div>
        )}
        <div className="dp-video__play">
          <PlayCircle size={40} />
        </div>
        <span className="dp-video__tag">Video</span>
      </div>
      <div className="dp-video__body">
        <div className="dp-clip__meta">
          <span>{article.source}</span>
          {article.published_at && <span className="dp-clip__time">{timeAgo(article.published_at)}</span>}
        </div>
        <h3 className="dp-video__title">{article.title}</h3>
      </div>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function NewsPage() {
  const [articles, setArticles] = useState([]);
  const [sources, setSources] = useState([]);
  const [videoSources, setVideoSources] = useState([]);
  const [activeSource, setActiveSource] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const boardRef = useRef(null);

  // Scope the warm-paper "dispatch" theme to this page only — same pattern
  // the homepage uses for its own light theme, cleaned up automatically on
  // unmount (the injected <style> below removes itself with the component).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-dispatch');
    return () => root.classList.remove('theme-dispatch');
  }, []);

  const load = async (source) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchNews(source ? { source } : undefined);
      setArticles(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not load news right now.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNewsSources().then(setSources).catch(() => {});
    fetchNewsVideoSources().then(setVideoSources).catch(() => {});
    load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSourceClick = (source) => {
    setActiveSource(source);
    load(source);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshNews();
      await load(activeSource);
    } catch (err) {
      setError(extractErrorMessage(err, 'Refresh failed.'));
    } finally {
      setRefreshing(false);
    }
  };

  // Video (YouTube) entries get pulled out into their own rail rather than
  // mixed into the article pinboard/lead story.
  const videoSourceSet = useMemo(() => new Set(videoSources), [videoSources]);
  const videoArticles = useMemo(
    () => articles.filter((a) => videoSourceSet.has(a.source)),
    [articles, videoSourceSet]
  );
  const textArticles = useMemo(
    () => articles.filter((a) => !videoSourceSet.has(a.source)),
    [articles, videoSourceSet]
  );

  const [lead, ...rest] = textArticles;
  const tickerHeadlines = useMemo(() => articles.slice(0, 10).map((a) => a.title), [articles]);
  const today = useMemo(
    () => new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    []
  );

  return (
    <div className="dp">
      <style>{`
        /* Paint the warm-paper canvas behind the whole viewport while this
           page is mounted — matches the homepage's own theme-toggle trick,
           but with a fresh, page-local palette. */
        html.theme-dispatch,
        html.theme-dispatch body {
          background-color: #f5f1ea;
          background-image: none;
        }

        /* The global navbar's "MoleIt" wordmark defaults to a near-white
           color for the dark app background — invisible against this
           page's light paper. Only overridden while this page is mounted. */
        html.theme-dispatch .moleit-logo .text-lab-100 {
          color: #201f1d !important;
        }

        .dp {
          --dp-bg: #f5f1ea;
          --dp-ink: #201f1d;
          --dp-ink-2: #56524a;
          --dp-ink-3: #928c80;
          --dp-card: #fffdf8;
          --dp-line: rgba(32, 31, 29, 0.12);
          --dp-coral: #ff6b4a;
          --dp-violet: #6c5ce7;
          --dp-teal: #0f9c8d;
          --dp-red: #ff3b3b;
          --font-display: 'Space Grotesk', 'Segoe UI', system-ui, sans-serif;

          position: relative;
          width: 100%;
          max-width: 1180px;
          margin: 0 auto;
          padding: 32px 20px 64px;
          color: var(--dp-ink);
          font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
        }

        .dp-label {
          display: inline-block;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--dp-ink-3);
        }

        /* ---------- hero ---------- */
        .dp-hero {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 32px;
          padding: 20px 0 48px;
          border-bottom: 1px solid var(--dp-line);
          margin-bottom: 32px;
        }
        .dp-hero__copy { max-width: 640px; }
        .dp-hero__mark {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-top: 18px;
          padding: 6px 12px 6px 6px;
          border-radius: 999px;
          background: var(--dp-card);
          border: 1px solid var(--dp-line);
        }
        .dp-hero__mark-icon {
          display: grid;
          place-items: center;
          width: 24px;
          height: 24px;
          border-radius: 999px;
          background: var(--dp-red);
          color: #fff;
        }
        .dp-hero__mark-text { font-size: 12px; font-weight: 600; color: var(--dp-ink-2); }

        .dp-h1 {
          margin: 10px 0 0;
          font-family: var(--font-display);
          font-weight: 800;
          letter-spacing: -0.03em;
          line-height: 0.98;
          font-size: clamp(2.6rem, 6vw, 4.6rem);
          color: var(--dp-ink);
        }
        .dp-h1--accent { color: var(--dp-violet); }

        .dp-hero__tagline {
          margin-top: 18px;
          max-width: 480px;
          font-size: clamp(1.05rem, 1.6vw, 1.3rem);
          line-height: 1.5;
          color: var(--dp-ink-2);
        }

        .dp-mark { position: relative; display: inline-block; padding: 0 5px; }
        .dp-mark__bg {
          position: absolute;
          inset: 3px -2px;
          background: var(--dp-coral);
          border-radius: 3px;
          transform-origin: left;
          z-index: 0;
        }
        .dp-mark__text { position: relative; z-index: 1; color: #1a1a1a; font-weight: 600; }

        .dp-scroll {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-top: 30px;
          padding: 0;
          background: none;
          border: none;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--dp-ink);
          cursor: pointer;
        }
        .dp-scroll__arrow { display: inline-flex; }

        /* ---------- hero card stack ---------- */
        .dp-hero__orbit-wrap { perspective: 900px; flex-shrink: 0; }
        .dp-stack {
          position: relative;
          width: clamp(180px, 19vw, 250px);
          height: clamp(150px, 16vw, 200px);
          transform-style: preserve-3d;
        }
        .dp-stack__card {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 92px;
          height: 122px;
          padding: 12px 10px;
          background: var(--dp-card);
          border: 1px solid var(--dp-line);
          border-top: 4px solid;
          border-radius: 10px;
          box-shadow: 0 16px 30px rgba(32, 31, 29, 0.14);
          transform: translate(-50%, -50%) translate(var(--tx), var(--ty)) rotate(var(--rot));
        }
        .dp-stack__pin { display: block; width: 8px; height: 8px; border-radius: 50%; margin-bottom: 9px; }
        .dp-stack__line { display: block; height: 5px; border-radius: 3px; background: var(--dp-line); margin-bottom: 6px; }
        .dp-stack__line--title { height: 7px; width: 82%; background: var(--dp-ink-3); }
        .dp-stack__line--short { width: 48%; }
        .dp-stack__stamp {
          position: absolute;
          bottom: -6px;
          right: -2px;
          padding: 7px 13px;
          border: 2px solid var(--dp-red);
          border-radius: 8px;
          background: rgba(255, 59, 59, 0.06);
          color: var(--dp-red);
          font-family: var(--font-display);
          font-weight: 800;
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          transform: rotate(-12deg);
        }

        /* ---------- strip ---------- */
        .dp-strip {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          column-gap: 16px;
          row-gap: 10px;
          margin: 0 0 32px;
          padding: 30px 20px;
          border-top: 1px solid var(--dp-line);
          border-bottom: 1px solid var(--dp-line);
          font-family: var(--font-display);
          font-size: clamp(1.05rem, 2vw, 1.35rem);
          font-weight: 500;
          letter-spacing: -0.01em;
          color: var(--dp-ink);
          text-align: center;
        }
        .dp-strip__half { display: inline-block; }
        .dp-strip__icon {
          position: relative;
          display: inline-block;
          flex-shrink: 0;
          width: 26px;
          height: 26px;
        }
        /* Six dots placed at 60° increments around the icon's own center,
           via rotate() + translateY() rather than a hand-placed grid, so
           they land on an actual circle instead of a lopsided cluster. */
        .dp-strip__dot {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 6px;
          height: 6px;
          border-radius: 2px;
          background: var(--dp-violet);
          transform: translate(-50%, -50%) rotate(calc(var(--i) * 60deg)) translateY(-10px);
        }

        /* ---------- ticker ---------- */
        .dp-ticker {
          display: flex;
          align-items: center;
          gap: 12px;
          border-radius: 999px;
          background: var(--dp-card);
          border: 1px solid var(--dp-line);
          padding: 8px 8px 8px 6px;
          margin-bottom: 28px;
        }
        .dp-ticker__badge {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
          padding: 6px 12px;
          border-radius: 999px;
          background: var(--dp-red);
          color: #fff;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }
        .dp-ticker__pulse {
          position: absolute;
          left: 8px;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #fff;
        }
        .dp-ticker__viewport { position: relative; flex: 1; overflow: hidden; }
        .dp-ticker__track {
          display: flex;
          width: max-content;
          gap: 40px;
          white-space: nowrap;
          font-size: 14px;
          color: var(--dp-ink-2);
          animation: dp-ticker-scroll linear infinite;
        }
        .dp-ticker__item { display: flex; align-items: center; gap: 8px; }
        .dp-ticker__dot { color: var(--dp-violet); }
        @keyframes dp-ticker-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) { .dp-ticker__track { animation: none; } }

        /* ---------- tabs ---------- */
        .dp-tabs {
          display: flex;
          flex-wrap: wrap;
          gap: 22px 26px;
          border-bottom: 1px solid var(--dp-line);
          padding-bottom: 12px;
          margin-bottom: 30px;
        }
        .dp-tab {
          position: relative;
          padding-bottom: 6px;
          background: none;
          border: none;
          cursor: pointer;
          font-family: var(--font-display);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--dp-ink-3);
        }
        .dp-tab--active { color: var(--dp-ink); }
        .dp-tab__underline {
          position: absolute;
          left: 0;
          right: 0;
          bottom: -13px;
          height: 2px;
          border-radius: 2px;
          background: var(--dp-violet);
        }

        /* ---------- lead ---------- */
        .dp-lead {
          display: block;
          position: relative;
          overflow: hidden;
          border-radius: 22px;
          background: var(--dp-card);
          border: 1px solid var(--dp-line);
          text-decoration: none;
          color: inherit;
          margin-bottom: 30px;
        }
        .dp-lead__frame { position: relative; width: 100%; height: clamp(220px, 34vw, 340px); overflow: hidden; }
        .dp-lead__img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.6s ease; }
        .dp-lead:hover .dp-lead__img { transform: scale(1.05); }
        .dp-lead__badge {
          position: absolute;
          top: 16px;
          left: 16px;
          padding: 6px 10px;
          border-radius: 4px;
          background: var(--dp-coral);
          color: #1a1a1a;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }
        .dp-lead__badge--static { position: static; display: inline-block; margin-bottom: 12px; }
        .dp-lead__body { padding: 22px 26px 28px; }
        .dp-lead__body--overlap { margin-top: -18px; position: relative; }
        .dp-lead__meta {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--dp-violet);
          margin-bottom: 8px;
        }
        .dp-dot-sep { color: var(--dp-ink-3); }
        .dp-lead__title {
          font-family: var(--font-display);
          font-weight: 700;
          letter-spacing: -0.01em;
          font-size: clamp(1.4rem, 2.6vw, 2rem);
          line-height: 1.2;
          margin: 0 0 10px;
        }
        .dp-lead__summary {
          max-width: 720px;
          font-size: 15px;
          line-height: 1.65;
          color: var(--dp-ink-2);
          margin: 0 0 14px;
        }
        .dp-lead__summary::first-letter {
          float: left;
          margin-right: 8px;
          font-family: var(--font-display);
          font-size: 2.6rem;
          font-weight: 700;
          color: var(--dp-violet);
        }
        .dp-lead__cta { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dp-ink-2); }
        .dp-lead:hover .dp-lead__cta { color: var(--dp-violet); }

        /* ---------- pinboard ---------- */
        .dp-board { columns: 1; column-gap: 18px; }
        @media (min-width: 640px) { .dp-board { columns: 2; } }
        @media (min-width: 1024px) { .dp-board { columns: 3; } }

        .dp-clip {
          position: relative;
          margin-bottom: 18px;
          break-inside: avoid;
          overflow: hidden;
          border-radius: 16px;
          background: var(--dp-card);
          border: 1px solid var(--dp-line);
          box-shadow: 0 10px 24px rgba(38, 38, 38, 0.06);
        }
        .dp-pin {
          position: absolute;
          top: -9px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 10;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          color: #fff;
          cursor: grab;
          border: none;
        }
        .dp-pin:active { cursor: grabbing; }
        .dp-pin--coral { background: var(--dp-coral); }
        .dp-pin--violet { background: var(--dp-violet); }
        .dp-pin--teal { background: var(--dp-teal); }
        .dp-pin--red { background: var(--dp-red); }

        .dp-clip__frame { width: 100%; overflow: hidden; }
        .dp-clip__img { width: 100%; height: 100%; object-fit: cover; }
        .dp-clip__body { display: flex; flex-direction: column; gap: 8px; padding: 16px; }
        .dp-clip__meta {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--dp-violet);
        }
        .dp-clip__time { color: var(--dp-ink-3); }
        .dp-clip__title {
          font-family: var(--font-display);
          font-size: 15px;
          font-weight: 700;
          line-height: 1.35;
          margin: 0;
          color: var(--dp-ink);
        }
        .dp-clip__summary {
          font-size: 13px;
          line-height: 1.55;
          color: var(--dp-ink-2);
          margin: 0;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .dp-clip__cta { margin-top: 2px; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--dp-ink-3); text-decoration: none; }
        .dp-clip:hover .dp-clip__cta { color: var(--dp-violet); }

        /* ---------- video rail ---------- */
        .dp-video-rail { display: flex; gap: 16px; overflow-x: auto; padding-bottom: 6px; margin: 0 -20px 8px; padding-left: 20px; padding-right: 20px; scroll-snap-type: x mandatory; }
        .dp-video {
          flex: 0 0 auto;
          width: 260px;
          scroll-snap-align: start;
          border-radius: 16px;
          overflow: hidden;
          background: var(--dp-card);
          border: 1px solid var(--dp-line);
          text-decoration: none;
          color: inherit;
        }
        .dp-video__frame { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #eee7db; overflow: hidden; }
        .dp-video__img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.5s ease; }
        .dp-video:hover .dp-video__img { transform: scale(1.05); }
        .dp-video__fallback { display: grid; place-items: center; width: 100%; height: 100%; color: var(--dp-ink-3); }
        .dp-video__play {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          background: rgba(32, 31, 29, 0.15);
          color: #fff;
          opacity: 0;
          transition: opacity 0.25s ease;
        }
        .dp-video:hover .dp-video__play { opacity: 1; }
        .dp-video__tag {
          position: absolute;
          bottom: 8px;
          right: 8px;
          padding: 3px 7px;
          border-radius: 4px;
          background: rgba(32, 31, 29, 0.75);
          color: #fff;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
        }
        .dp-video__body { padding: 12px; display: flex; flex-direction: column; gap: 6px; }
        .dp-video__title { font-family: var(--font-display); font-size: 13px; font-weight: 700; line-height: 1.35; margin: 0; }

        .dp-section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
        .dp-section-head h2 { font-family: var(--font-display); font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; margin: 0; color: var(--dp-ink); }

        .dp-refresh {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 9px 16px;
          border-radius: 999px;
          background: var(--dp-card);
          border: 1px solid var(--dp-line);
          font-size: 13px;
          font-weight: 600;
          color: var(--dp-ink-2);
          cursor: pointer;
        }
        .dp-refresh:disabled { opacity: 0.5; cursor: default; }
        .dp-refresh__spin { animation: dp-spin 0.8s linear infinite; }
        @keyframes dp-spin { to { transform: rotate(360deg); } }

        .dp-empty, .dp-error {
          border-radius: 18px;
          border: 1px solid var(--dp-line);
          background: var(--dp-card);
          padding: 44px 20px;
          text-align: center;
          color: var(--dp-ink-2);
        }
        .dp-error { border-color: rgba(255, 59, 59, 0.3); background: rgba(255, 59, 59, 0.06); color: #b52424; text-align: left; padding: 16px; }

        .dp-signal { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .dp-signal__dial {
          position: relative;
          display: grid;
          place-items: center;
          width: 56px;
          height: 56px;
          margin-bottom: 10px;
        }
        .dp-signal__ring {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          border: 1.5px solid var(--dp-coral);
        }
        .dp-signal__ring--delay { border-color: var(--dp-violet); }
        .dp-signal__sweep {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: conic-gradient(from 0deg, rgba(15, 156, 141, 0.35), transparent 30%);
        }
        .dp-signal__icon {
          position: relative;
          z-index: 1;
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border-radius: 50%;
          background: var(--dp-card);
          border: 1px solid var(--dp-line);
          color: var(--dp-teal);
        }
        .dp-signal__title { margin: 0; font-family: var(--font-display); font-size: 15px; font-weight: 600; color: var(--dp-ink); }
        .dp-signal__subtitle { margin: 2px 0 14px; font-size: 13px; color: var(--dp-ink-3); }
        .dp-signal__slugs { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
        .dp-signal__slug {
          padding: 5px 10px;
          border-radius: 999px;
          border: 1px dashed var(--dp-line);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          color: var(--dp-ink-3);
        }

        .dp-skeleton { border-radius: 16px; background: var(--dp-card); border: 1px solid var(--dp-line); height: 240px; }
        .dp-skeleton-grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
        @media (min-width: 640px) { .dp-skeleton-grid { grid-template-columns: 1fr 1fr; } }
        @media (min-width: 1024px) { .dp-skeleton-grid { grid-template-columns: 1fr 1fr 1fr; } }

        @media (max-width: 720px) {
          /* BUG FIX: this rule only ever overrode flex-direction/align-items,
             so .dp-hero's base "justify-content: space-between" kept acting
             on the now-vertical main axis — shoving the copy to the top and
             the DispatchStack graphic to the bottom of whatever height the
             row ended up with, opening a large dead gap between them (and
             pushing the graphic down near the Refresh row below the hero).
             Pin it to flex-start with an explicit, comfortable gap instead. */
          .dp-hero {
            flex-direction: column;
            align-items: flex-start;
            justify-content: flex-start;
            gap: 32px;
          }
          .dp-hero__orbit-wrap { align-self: center; margin-top: 0; }
        }
      `}</style>

      <DispatchHero
        today={today}
        onScrollDown={() => document.getElementById('dp-below-hero')?.scrollIntoView({ behavior: 'smooth' })}
      />

      <DispatchStrip />

      <div id="dp-below-hero" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button onClick={handleRefresh} disabled={refreshing} className="dp-refresh">
          <RefreshCw size={14} className={refreshing ? 'dp-refresh__spin' : ''} />
          Refresh
        </button>
      </div>

      <Ticker headlines={tickerHeadlines} />

      {sources.length > 0 && (
        <div className="dp-tabs">
          <button onClick={() => handleSourceClick(null)} className={`dp-tab ${activeSource === null ? 'dp-tab--active' : ''}`}>
            All sources
            {activeSource === null && <motion.span layoutId="news-tab-underline" className="dp-tab__underline" />}
          </button>
          {sources.map((s) => (
            <button key={s} onClick={() => handleSourceClick(s)} className={`dp-tab ${activeSource === s ? 'dp-tab--active' : ''}`}>
              {s}
              {activeSource === s && <motion.span layoutId="news-tab-underline" className="dp-tab__underline" />}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="dp-skeleton-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <motion.div
              key={i}
              className="dp-skeleton"
              animate={{ opacity: [0.5, 0.9, 0.5] }}
              transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.08 }}
            />
          ))}
        </div>
      )}

      {!loading && error && <div className="dp-error">{error}</div>}

      {!loading && !error && articles.length === 0 && (
        <div className="dp-empty">
          <EmptySignal />
        </div>
      )}

      <AnimatePresence mode="wait">
        {!loading && !error && videoArticles.length > 0 && (
          <motion.div
            key="videos"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ marginBottom: 32 }}
          >
            <div className="dp-section-head">
              <PlayCircle size={16} color="var(--dp-red)" />
              <h2>Video News</h2>
            </div>
            <div className="dp-video-rail">
              {videoArticles.map((article) => (
                <VideoCard key={article.id} article={article} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!loading && !error && textArticles.length > 0 && (
        <div ref={boardRef} style={{ position: 'relative' }}>
          <LeadStory article={lead} />
          <div className="dp-board">
            {rest.map((article, i) => (
              <StaggerItem key={article.id} as="div">
                <ClippingCard article={article} index={i} boardRef={boardRef} />
              </StaggerItem>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}