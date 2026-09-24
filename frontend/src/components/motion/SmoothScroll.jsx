import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import Lenis from 'lenis';

/** Buttery momentum scrolling on EVERY scrolling page of the app.
 *
 *  Pages that are fixed-height "app" screens (nothing to scroll at page
 *  level, and they own their wheel/scroll behaviour) are left on plain
 *  native scroll — see NATIVE_SCROLL_ROUTES. Lenis is created when the
 *  route is a smooth one and destroyed the instant it isn't, so a native
 *  page never has a lingering Lenis instance holding on to stale bounds
 *  (or swallowing its wheel events).
 *
 *  Also bails out entirely if the user has "reduce motion" set at the OS
 *  level. Touch devices keep their own native momentum scrolling (Lenis's
 *  default) — only mouse-wheel / trackpad input is smoothed.
 *
 *  ------------------------------------------------------------------
 *  WHY IT USED TO GET "STUCK MIDWAY" — and what keeps it from happening
 *  ------------------------------------------------------------------
 *  Lenis caches the page's total scroll height (its "limit") and only
 *  refreshes it via a ResizeObserver on <html>. index.css pins
 *  `html, body, #root { height: 100% }`, so <html>'s own box NEVER changes
 *  size when content grows and the observer never fires. A page that mounts
 *  short (skeleton loaders, async data, lazy images, web fonts, framer
 *  animations) got measured once, then grew, and Lenis kept clamping the
 *  scroll to the old, short height.
 *
 *  Fix: we keep Lenis's measurement in sync ourselves (see syncLimit) using
 *  a ResizeObserver on the app shell + a cheap height check + load/font
 *  events, and call lenis.resize() whenever the real height differs.
 *
 *  ------------------------------------------------------------------
 *  HOW IT COEXISTS WITH EVERYTHING ELSE ON THE PAGE
 *  ------------------------------------------------------------------
 *  - Anything that already handled the wheel itself and called
 *    preventDefault() — Three.js OrbitControls zoom, custom canvases,
 *    sliders, the site menu — is left alone (virtualScroll below).
 *  - Full-screen fixed overlays (modals, 3D viewer pop-ups: `fixed inset-0`)
 *    and role="dialog" / aria-modal elements scroll natively (prevent
 *    below); their own inner scrolling and the body-scroll-lock they set
 *    just work.
 *  - Any nested scrollable box (overflow-y: auto panels, flashcard backs,
 *    horizontal rails, textareas) scrolls itself first and hands off to the
 *    page smoothly at its edges (allowNestedScroll).
 *  - If anything locks page scroll (body/html overflow hidden — modals, the
 *    open site menu), Lenis is paused for the duration and resumed after.
 *  - Navigating to a new page starts at the top instead of inheriting the
 *    previous page's scroll offset.
 */

// Fixed-viewport / self-scrolling screens: native scroll only.
//  - /draw: full-screen canvas app with its own wheel-zoom.
//  - /notes: two-pane app layout with its own inner scrollers.
//  - auth pages: single-viewport cards (Register scrolls inside its card).
const NATIVE_SCROLL_ROUTES = new Set([
  '/draw',
  '/notes',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
]);

const isSmoothPath = (pathname) => {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return !NATIVE_SCROLL_ROUTES.has(clean);
};

// Elements whose wheel/touch scrolling should be left entirely to the browser.
const leaveToBrowser = (node) => {
  const cl = node.classList;
  if (cl && cl.contains('fixed') && cl.contains('inset-0')) return true; // modal / lightbox / viewer overlay
  if (node.getAttribute('role') === 'dialog') return true;
  if (node.getAttribute('aria-modal') === 'true') return true;
  return false;
};

// True while something has locked page-level scrolling (modal, open menu…).
const isPageScrollLocked = () => {
  const html = document.documentElement;
  const htmlY = window.getComputedStyle(html).overflowY;
  if (htmlY === 'hidden' || htmlY === 'clip') return true;
  // body's overflow only reaches the viewport when <html>'s is `visible`
  if (htmlY === 'visible' && document.body) {
    const bodyY = window.getComputedStyle(document.body).overflowY;
    return bodyY === 'hidden' || bodyY === 'clip';
  }
  return false;
};

export default function SmoothScroll({ children }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const smoothRoute = isSmoothPath(location.pathname);
  const lenisRef = useRef(null);

  // --- Create / destroy the Lenis instance ---------------------------------
  useEffect(() => {
    if (!smoothRoute) return undefined;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return undefined;

    const lenis = new Lenis({
      lerp: 0.1,
      smoothWheel: true,
      // Let nested scrollable boxes scroll themselves, then hand off to the page.
      allowNestedScroll: true,
      // Modals / overlays / dialogs are the browser's business.
      prevent: leaveToBrowser,
      // If an inner handler already consumed this wheel/touch event
      // (canvas zoom, custom widgets…), don't ALSO scroll the page.
      virtualScroll: ({ event }) => !event.defaultPrevented,
    });
    lenisRef.current = lenis;

    let rafId;
    function raf(time) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

    // --- Keep Lenis's cached scroll limit in sync with the real page ------
    const doc = document.documentElement;
    const syncLimit = () => {
      if (document.hidden) return;
      // Don't yank the target out from under a glide that's in flight — the
      // next tick (a few ms later) will pick the change up.
      if (lenis.isScrolling === 'smooth') return;
      if (doc.scrollHeight !== lenis.dimensions.scrollHeight) lenis.resize();
    };

    // 1) Reactive: the app shell grows/shrinks with page content (its own
    //    height is content-driven, unlike the pinned <html>/<body>/#root).
    const shell = document.getElementById('root')?.firstElementChild ?? null;
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncLimit) : null;
    if (shell && resizeObserver) resizeObserver.observe(shell);

    // 2) Safety net for anything that changes scrollHeight without changing
    //    the shell's box (absolute/overflowing content, transforms, …).
    const intervalId = window.setInterval(syncLimit, 250);

    // 3) Snappy re-measure on the common triggers so the limit is right well
    //    before the user scrolls that far. `load` doesn't bubble, so listen
    //    in the capture phase to catch <img>.
    window.addEventListener('load', syncLimit);
    document.addEventListener('load', syncLimit, true);
    document.addEventListener('visibilitychange', syncLimit);
    document.fonts?.ready?.then(syncLimit).catch(() => {});
    const settleTimers = [50, 300, 800, 1600].map((ms) => window.setTimeout(syncLimit, ms));

    // --- Pause Lenis while anything locks page scroll ---------------------
    const updateLock = () => {
      if (isPageScrollLocked()) lenis.stop();
      else lenis.start();
    };
    const lockObserver = new MutationObserver(updateLock);
    const lockOpts = { attributes: true, attributeFilter: ['class', 'style'] };
    lockObserver.observe(doc, lockOpts);
    if (document.body) lockObserver.observe(document.body, lockOpts);
    updateLock();

    return () => {
      cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
      settleTimers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener('load', syncLimit);
      document.removeEventListener('load', syncLimit, true);
      document.removeEventListener('visibilitychange', syncLimit);
      resizeObserver?.disconnect();
      lockObserver.disconnect();
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [smoothRoute]);

  // --- New page => start at the top ---------------------------------------
  // (Back/forward keeps the browser's own restoration behaviour.)
  useEffect(() => {
    if (navigationType === 'POP') return;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    // Drop any in-flight glide and re-sync Lenis's internal position to 0 so
    // it can't animate back toward the previous page's offset.
    lenisRef.current?.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return children;
}