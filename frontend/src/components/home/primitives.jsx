import { useEffect, useRef, useState } from 'react';

/** "03 / SPECTROSCOPY ENGINE" — the small numbered caption above each block. */
export function SectionLabel({ n, children, className = '' }) {
  return (
    <p className={`ix-label ${className}`}>
      {String(n).padStart(2, '0')} / {children}
    </p>
  );
}

/** Orange highlighter. The marker wipes in from the left the first time the
 *  phrase scrolls into view. `chip` = tight single-line chip for display
 *  sizes; default = inline, wraps across lines with a rounded box per line. */
export function Mark({ children, chip = false, delay = 0, className = '' }) {
  const ref = useRef(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setOn(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setOn(true);
          io.disconnect();
        }
      },
      { threshold: 0.6 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <mark
      ref={ref}
      className={`ix-mark ${chip ? 'ix-mark--chip' : ''} ${on ? 'is-on' : ''} ${className}`}
      style={delay ? { transitionDelay: `${delay}s` } : undefined}
    >
      {children}
    </mark>
  );
}
