import { useEffect, useRef } from 'react';

// Custom pointer for the full-screen site menu.
//
// Why this exists: the homepage hides the native cursor (html.ix-cursor) and
// draws its own dot, but that dot lives inside the homepage's stacking context,
// so the dark menu paints OVER it and the pointer looks invisible. This one is
// mounted by SiteMenu itself (outside every page), only while the menu is open,
// and sits above the menu, so it works the same on every page.
//
// It grows into a ring over anything clickable (menu links, Close, Log out...)
// and shrinks slightly while the button is held. Fine pointers only — never
// runs on touch screens.
const INTERACTIVE = 'a, button, [role="button"], input, textarea, select, summary, label, [data-cursor]';

// Remember the last mouse position even before the menu opens, so the dot
// appears exactly under the pointer the moment the menu opens (the user has
// just clicked the Menu button and may not move the mouse again).
const last = { x: null, y: null };
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      last.x = e.clientX;
      last.y = e.clientY;
    },
    { passive: true },
  );
}

export default function MenuCursor() {
  const dotRef = useRef(null);

  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const dot = dotRef.current;
    if (!fine || !dot) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = document.documentElement;
    root.classList.add('ix-menu-cursor');

    let tx = last.x ?? -100;
    let ty = last.y ?? -100;
    let x = tx;
    let y = ty;
    let raf = 0;

    if (last.x !== null) {
      dot.style.opacity = '1';
      const el = document.elementFromPoint(last.x, last.y);
      dot.classList.toggle('is-link', Boolean(el?.closest?.(INTERACTIVE)));
    }

    const loop = () => {
      const k = reduce ? 1 : 0.28;
      x += (tx - x) * k;
      y += (ty - y) * k;
      dot.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e) => {
      const first = dot.style.opacity !== '1';
      tx = e.clientX;
      ty = e.clientY;
      if (first) {
        x = tx;
        y = ty;
        dot.style.opacity = '1';
      }
      dot.classList.toggle('is-link', Boolean(e.target?.closest?.(INTERACTIVE)));
    };
    const onDown = () => dot.classList.add('is-down');
    const onUp = () => dot.classList.remove('is-down');
    const onLeave = () => {
      dot.style.opacity = '0';
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    document.documentElement.addEventListener('mouseleave', onLeave);
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      root.classList.remove('ix-menu-cursor');
    };
  }, []);

  return <div ref={dotRef} className="ix-dot ix-dot--menu" aria-hidden="true" />;
}