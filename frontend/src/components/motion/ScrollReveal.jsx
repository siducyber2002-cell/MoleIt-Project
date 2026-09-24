import { motion } from 'framer-motion';

// Shared easing — a gentle "ease-out-expo" feel, the same curve most
// award-site scroll animations use (fast start, long soft settle).
export const EASE = [0.16, 1, 0.3, 1];

// `as` can be a plain tag name ("div", "h1"...) — resolved via motion.<tag>
// — or a custom component (e.g. react-router's <Link>), which needs
// motion.create() to become animatable. Cached so repeated renders of the
// same custom component don't re-wrap it every time.
const customMotionCache = new WeakMap();
function resolveMotionTag(as) {
  if (typeof as === 'string') return motion[as] || motion.div;
  if (customMotionCache.has(as)) return customMotionCache.get(as);
  const wrapped = motion.create ? motion.create(as) : motion(as);
  customMotionCache.set(as, wrapped);
  return wrapped;
}

const OFFSETS = {
  up: { y: 28 },
  down: { y: -28 },
  left: { x: 28 },
  right: { x: -28 },
  none: {},
};

/** Fades + slides a block in. Two trigger modes:
 *  - `trigger="view"` (default) — plays once the block scrolls into the
 *    viewport. Right for anything below the initial fold.
 *  - `trigger="mount"` — plays immediately when the component mounts,
 *    regardless of scroll position. Use this for anything visible in the
 *    opening view (hero, above-the-fold banners) — those are already
 *    on-screen at load, so a scroll-linked trigger either fires instantly
 *    (looks like no animation) or doesn't fire at all.
 *  `as="section"` / `as="h2"` for a tag, or `as={Link}` to animate a
 *  custom component directly (its own props, e.g. `to=`, pass straight
 *  through via ...rest). */
export function Reveal({
  children,
  as = 'div',
  direction = 'up',
  distance,
  delay = 0,
  duration = 0.7,
  once = true,
  amount = 0.25,
  trigger = 'view',
  className,
  ...rest
}) {
  const MotionTag = resolveMotionTag(as);
  const offset = distance != null ? { [direction === 'left' || direction === 'right' ? 'x' : 'y']: distance } : OFFSETS[direction] || {};
  const triggerProps =
    trigger === 'mount'
      ? { animate: { opacity: 1, x: 0, y: 0 } }
      : { whileInView: { opacity: 1, x: 0, y: 0 }, viewport: { once, amount } };

  return (
    <MotionTag
      className={className}
      initial={{ opacity: 0, ...offset }}
      {...triggerProps}
      transition={{ duration, delay, ease: EASE }}
      {...rest}
    >
      {children}
    </MotionTag>
  );
}

/** Parent for a staggered group — wrap a set of <StaggerItem> children and
 *  they'll each animate in with a small delay after the previous one.
 *  `trigger="view"` (default) waits for scroll-into-view; `trigger="mount"`
 *  plays immediately on load — use "mount" for anything in the opening
 *  view, same reasoning as <Reveal>. */
export function StaggerGroup({
  children,
  as = 'div',
  className,
  stagger = 0.09,
  delayChildren = 0,
  once = true,
  amount = 0.2,
  trigger = 'view',
  ...rest
}) {
  const MotionTag = resolveMotionTag(as);
  const triggerProps = trigger === 'mount' ? { animate: 'show' } : { whileInView: 'show', viewport: { once, amount } };
  return (
    <MotionTag
      className={className}
      initial="hidden"
      {...triggerProps}
      variants={{ hidden: {}, show: { transition: { staggerChildren: stagger, delayChildren } } }}
      {...rest}
    >
      {children}
    </MotionTag>
  );
}

/** A single item inside a <StaggerGroup> — reads the parent's "hidden"/
 *  "show" variant state, so no viewport/timing config needed here. */
export function StaggerItem({ children, as = 'div', className, direction = 'up', distance = 24, duration = 0.6, ...rest }) {
  const MotionTag = resolveMotionTag(as);
  const offset = OFFSETS[direction] || {};
  return (
    <MotionTag
      className={className}
      variants={{ hidden: { opacity: 0, ...offset }, show: { opacity: 1, x: 0, y: 0, transition: { duration, ease: EASE } } }}
      {...rest}
    >
      {children}
    </MotionTag>
  );
}

/** One "word" of a kinetic headline — must be used inside a parent that
 *  sets the "hidden"/"show" variant states (e.g. a <StaggerGroup as="h1">).
 *  The outer <span> clips (overflow: hidden) so the inner word visibly
 *  slides up out of a mask, rather than just fading in place. */
export function Word({ children, className }) {
  return (
    <span style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top' }}>
      <motion.span
        style={{ display: 'inline-block' }}
        className={className}
        variants={{ hidden: { y: '115%', opacity: 0 }, show: { y: '0%', opacity: 1, transition: { duration: 0.55, ease: EASE } } }}
      >
        {children}
      </motion.span>
    </span>
  );
}

/** For multi-word gradient/highlighted fragments — animates as one unit
 *  (not split per-word) so a `bg-clip-text` gradient stays continuous
 *  across the phrase instead of restarting on every word. Same parent
 *  requirement as <Word>. */
export function InlineReveal({ children, className, as = 'span' }) {
  const MotionTag = resolveMotionTag(as);
  return (
    <MotionTag
      className={className}
      style={{ display: 'inline-block' }}
      variants={{ hidden: { y: 22, opacity: 0 }, show: { y: 0, opacity: 1, transition: { duration: 0.6, ease: EASE } } }}
    >
      {children}
    </MotionTag>
  );
}