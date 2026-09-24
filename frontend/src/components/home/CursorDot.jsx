import { useEffect, useRef } from 'react';

// The small round pointer that trails the mouse. It grows into a ring over
// anything clickable and shrinks slightly while the button is held.
// Only runs on devices with a real hover-capable pointer (never on touch),
// and only while the homepage is mounted.
const INTERACTIVE = 'a, button, [role="button"], input, textarea, select, summary, label, [data-cursor]';

export default function CursorDot() {
  const dotRef = useRef(null);

  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const dot = dotRef.current;
    if (!fine || !dot) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = document.documentElement;
    root.classList.add('ix-cursor');

    let x = -100;
    let y = -100;
    let tx = -100;
    let ty = -100;
    let shown = false;
    let raf = 0;

    const loop = () => {
      const k = reduce ? 1 : 0.24;
      x += (tx - x) * k;
      y += (ty - y) * k;
      dot.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e) => {
      tx = e.clientX;
      ty = e.clientY;
      if (!shown) {
        x = tx;
        y = ty;
        shown = true;
        dot.style.opacity = '1';
      }
      const onLink = Boolean(e.target?.closest?.(INTERACTIVE));
      dot.classList.toggle('is-link', onLink);
    };
    const onDown = () => dot.classList.add('is-down');
    const onUp = () => dot.classList.remove('is-down');
    const onLeave = () => {
      shown = false;
      dot.style.opacity = '0';
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    document.documentElement.addEventListener('mouseleave', onLeave);
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      root.classList.remove('ix-cursor');
    };
  }, []);

  return <div ref={dotRef} className="ix-dot" aria-hidden="true" />;
}
