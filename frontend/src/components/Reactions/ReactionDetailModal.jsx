// frontend/src/components/Reactions/ReactionDetailModal.jsx
//
// Popup shown when a reaction card (in the hero or the browse grid) is
// clicked. Medium-width panel, dark lab/violet theme to match the rest
// of the app.
//
// The mechanism plays like a video. Press Play and it runs through EVERY
// step continuously on its own: each step draws itself in (atoms -> bonds
// -> electron-pushing arrows), holds long enough to read the description,
// then the next step comes in automatically until the last one finishes.
//
//   - Play / Pause / Replay button (Space also toggles)
//   - Segmented progress bar, one segment per step; the current segment
//     fills like a video scrubber while playing
//   - Clicking a segment (or pressing the left/right arrow keys) pauses
//     playback and jumps to that step, so you can still step manually
//
// Geometry (bond lines, arrow paths, viewBox) is computed by the backend
// (app/mechanism.py); this component only renders it and drives the timing.

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, FlaskConical, Play, Pause, RotateCcw } from 'lucide-react';
import MechanismStepDiagram from './MechanismStepDiagram';

// How long one step stays on screen while playing (ms). Mirrors the draw-in
// timing inside MechanismStepDiagram (bonds, then each arrow ~0.35s apart),
// plus a reading pause that grows with the description length.
function stepDurationMs(step) {
  const bonds = step?.bonds?.length || 0;
  const arrows = step?.arrows?.length || 0;
  const drawSec = 0.25 + bonds * 0.04 + arrows * 0.35 + 0.6;
  const readSec = Math.min(3, 0.8 + (step?.description?.length || 0) / 90);
  return Math.round((drawSec + readSec) * 1000);
}

export default function ReactionDetailModal({ reaction, onClose }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  // Bumped every time playback (re)starts so the diagram and the progress
  // segment restart their animation from zero.
  const [playKey, setPlayKey] = useState(0);

  const steps = reaction?.mechanism_steps || [];
  const stepCount = steps.length;

  // FIX: stepIndex survives the modal closing. Opening a reaction with
  // fewer steps than the one viewed last (e.g. was on step 4, new
  // reaction has 2) made `steps[stepIndex]` undefined and `step.title`
  // threw, blanking the whole page for one render. Clamp it.
  const safeIndex = stepCount ? Math.min(stepIndex, stepCount - 1) : 0;
  const step = steps[safeIndex];
  const durationMs = stepDurationMs(step);

  const goTo = (i) => {
    setPlaying(false); // any manual jump pauses the video
    setEnded(false);
    setStepIndex(Math.max(0, Math.min(stepCount - 1, i)));
  };

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Start over if it already finished, or if parked on the last step.
    if (ended || (stepCount > 1 && safeIndex === stepCount - 1)) setStepIndex(0);
    setEnded(false);
    setPlayKey((k) => k + 1);
    setPlaying(true);
  };

  // The key handler is attached once per reaction, so it reads the latest
  // handlers/state through a ref instead of capturing stale ones.
  const live = useRef({});
  live.current = { goTo, togglePlay, safeIndex };

  // Reset to the first step (stopped) whenever a different reaction is
  // opened, and lock body scroll / wire up keys while the modal is open.
  useEffect(() => {
    if (!reaction) return undefined;
    setStepIndex(0);
    setPlaying(false);
    setEnded(false);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') live.current.goTo(live.current.safeIndex + 1);
      else if (e.key === 'ArrowLeft') live.current.goTo(live.current.safeIndex - 1);
      else if (e.key === ' ' && tag !== 'BUTTON') {
        e.preventDefault();
        live.current.togglePlay();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reaction?.id]);

  // The "video clock": while playing, wait out the current step, then move
  // to the next one; after the last step, stop and offer Replay.
  useEffect(() => {
    if (!playing || !stepCount) return undefined;
    const t = setTimeout(() => {
      if (safeIndex >= stepCount - 1) {
        setPlaying(false);
        setEnded(true);
      } else {
        setStepIndex(safeIndex + 1);
      }
    }, durationMs);
    return () => clearTimeout(t);
  }, [playing, safeIndex, playKey, stepCount, durationMs]);

  const PlayIcon = playing ? Pause : ended ? RotateCcw : Play;
  const playLabel = playing ? 'Pause' : ended ? 'Replay' : safeIndex > 0 ? 'Resume' : 'Play';

  return (
    <AnimatePresence>
      {reaction && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-lab-950/80 p-4 pt-20 backdrop-blur-md sm:items-center sm:pt-24"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="relative flex max-h-[calc(100dvh-7rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-violet/25 bg-[#120c1e] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] sm:max-h-[calc(100dvh-8rem)]"
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Ambient corner glows so the panel sits in the same purple
                world as the page behind it. */}
            <div className="pointer-events-none absolute -left-20 -top-20 h-64 w-64 rounded-full bg-violet-600/20 blur-[90px]" />
            <div className="pointer-events-none absolute -bottom-24 -right-16 h-64 w-64 rounded-full bg-fuchsia-600/15 blur-[90px]" />

            <button
              type="button"
              onClick={onClose}
              className="absolute right-4 top-4 z-10 rounded-full border border-lab-700 bg-lab-900/80 p-1.5 text-lab-400 backdrop-blur transition-colors hover:border-fuchsia-400/50 hover:text-fuchsia-400"
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <div className="relative overflow-y-auto p-6 sm:p-7">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-violet/30 bg-violet/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet">
                <FlaskConical size={11} /> {reaction.category}
                {reaction.tier === 'advanced' && (
                  <span className="ml-1 rounded-full border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-amber">
                    Advanced
                  </span>
                )}
              </span>

              <h2 className="mt-3 pr-8 font-display text-2xl font-bold text-lab-100">
                {reaction.name}
              </h2>

              <p className="mt-2 font-mono text-sm text-lab-200">{reaction.general_equation}</p>
              {reaction.reagents && (
                <p className="mt-1 text-xs text-lab-500">{reaction.reagents}</p>
              )}

              <p className="mt-4 text-sm leading-relaxed text-lab-300">{reaction.summary}</p>

              {stepCount > 0 && (
                <div className="mt-6 border-t border-lab-800 pt-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-lab-400">
                      Mechanism — step {safeIndex + 1} of {stepCount}
                    </h3>
                    <button
                      type="button"
                      onClick={togglePlay}
                      className="inline-flex items-center gap-1.5 rounded-full border border-fuchsia-400/40 bg-fuchsia-500/10 px-3 py-1 text-xs font-semibold text-fuchsia-300 transition-colors hover:border-fuchsia-400 hover:bg-fuchsia-500/20"
                      aria-label={playLabel}
                    >
                      <PlayIcon size={13} />
                      {playLabel}
                    </button>
                  </div>

                  <AnimatePresence mode="wait">
                    <motion.div
                      key={safeIndex}
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -16 }}
                      transition={{ duration: 0.22, ease: 'easeOut' }}
                      className="rounded-xl border border-lab-800 bg-lab-950/60 p-3"
                    >
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet">
                        {step.title}
                      </div>
                      {/* Keyed by step AND playKey so the draw-in replays
                          when a different step comes into view and when
                          playback is (re)started. Height follows the
                          viewport so the whole step fits on short screens. */}
                      <MechanismStepDiagram
                        key={`${safeIndex}-${playKey}`}
                        atoms={step.atoms}
                        bonds={step.bonds}
                        arrows={step.arrows}
                        viewBox={step.view_box}
                        height="clamp(150px, 30dvh, 240px)"
                      />
                      <p className="mt-2 text-xs leading-relaxed text-lab-300">{step.description}</p>
                    </motion.div>
                  </AnimatePresence>

                  {/* Video-style progress: one segment per step. Finished
                      steps are filled, the current one fills over its
                      duration while playing. Click a segment to jump. */}
                  {stepCount > 1 && (
                    <div className="mt-3 flex items-center gap-1">
                      {steps.map((_, i) => {
                        const isCurrent = i === safeIndex;
                        const done = i < safeIndex || (ended && !playing);
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => goTo(i)}
                            aria-label={`Go to step ${i + 1}`}
                            className="group flex h-5 flex-1 items-center"
                          >
                            <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-lab-700 transition-colors group-hover:bg-lab-600">
                              {done && !isCurrent && (
                                <span className="absolute inset-0 bg-fuchsia-400/50" />
                              )}
                              {isCurrent && !playing && (
                                <span className="absolute inset-0 bg-fuchsia-400" />
                              )}
                              {isCurrent && playing && (
                                <motion.span
                                  key={`${safeIndex}-${playKey}`}
                                  className="absolute inset-y-0 left-0 bg-fuchsia-400"
                                  initial={{ width: '0%' }}
                                  animate={{ width: '100%' }}
                                  transition={{ duration: durationMs / 1000, ease: 'linear' }}
                                />
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}