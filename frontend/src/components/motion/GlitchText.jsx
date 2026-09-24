// frontend/src/components/motion/GlitchText.jsx
//
// Renders `text` resolving out of scrambled glitch characters into the
// final clean string, classic "decrypting" effect: every character
// flickers through random glyphs before landing on its real one, on a
// per-character randomized timer, so the whole string reads as
// glitching in and then clearing rather than a uniform fade.
//
// Runs once on mount, and again whenever `text` or `replayKey` changes
// (bump `replayKey` to force a replay of the same text, e.g. on every
// tab visit). Respects prefers-reduced-motion by skipping straight to
// the final text with no scrambling.
//
// Usage:
//   <GlitchText as="span" className="bg-gradient-to-r ..." text="Every mechanism," />

import { useEffect, useRef, useState } from 'react';

const GLITCH_CHARS = '!<>-_\\/[]{}—=+*^?#$%&01';

function randomChar() {
  return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
}

function scrambledInitial(text) {
  return text.split('').map((c) => ({ char: c === ' ' ? ' ' : randomChar(), done: c === ' ' }));
}

function finalChars(text) {
  return text.split('').map((c) => ({ char: c, done: true }));
}

export default function GlitchText({
  text,
  as: Tag = 'span',
  className = '',
  dudClassName = 'glitch-dud',
  replayKey,
  frameMs = 35,
  minCycles = 5,
  maxCycles = 16,
  delayMs = 0,
  ...rest
}) {
  const prefersReduced = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  const [chars, setChars] = useState(() =>
    prefersReduced.current ? finalChars(text) : scrambledInitial(text)
  );
  const frameRef = useRef(0);
  const rafRef = useRef(null);
  const timeoutRef = useRef(null);
  const queueRef = useRef([]);

  useEffect(() => {
    if (prefersReduced.current) {
      setChars(finalChars(text));
      return undefined;
    }

    setChars(scrambledInitial(text));

    const start = () => {
      queueRef.current = text.split('').map((c) =>
        c === ' '
          ? { to: c, done: true }
          : {
              to: c,
              done: false,
              end: minCycles + Math.floor(Math.random() * Math.max(1, maxCycles - minCycles)),
            }
      );
      frameRef.current = 0;
      let lastTick = performance.now();

      const tick = (now) => {
        if (now - lastTick < frameMs) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        lastTick = now;
        frameRef.current += 1;

        let allDone = true;
        const next = queueRef.current.map((entry) => {
          if (entry.done) return { char: entry.to, done: true };
          if (frameRef.current >= entry.end) {
            entry.done = true;
            return { char: entry.to, done: true };
          }
          allDone = false;
          return { char: randomChar(), done: false };
        });
        setChars(next);

        if (!allDone) {
          rafRef.current = requestAnimationFrame(tick);
        }
      };

      rafRef.current = requestAnimationFrame(tick);
    };

    timeoutRef.current = window.setTimeout(start, delayMs);

    return () => {
      window.clearTimeout(timeoutRef.current);
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, replayKey, delayMs, frameMs, minCycles, maxCycles]);

  return (
    <Tag className={className} {...rest}>
      {chars.map((c, i) => (
        <span key={i} className={c.done ? undefined : dudClassName}>
          {c.char}
        </span>
      ))}
    </Tag>
  );
}