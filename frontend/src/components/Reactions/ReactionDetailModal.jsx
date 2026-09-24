// frontend/src/components/Reactions/ReactionDetailModal.jsx
//
// Popup shown when a reaction card (in the hero or the browse grid) is
// clicked. Medium-width panel, dark lab/violet theme to match the rest
// of the app.
//
// The mechanism is shown as a step-through: one step on screen at a
// time, its electron-pushing arrows drawing themselves in when it comes
// into view. Navigation is the row of dots below the diagram only — no
// Prev/Next chevron buttons and no autoplay/replay control.

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, FlaskConical } from 'lucide-react';
import MechanismStepDiagram from './MechanismStepDiagram';

export default function ReactionDetailModal({ reaction, onClose }) {
  const [stepIndex, setStepIndex] = useState(0);

  const steps = reaction?.mechanism_steps || [];
  const stepCount = steps.length;

  // Reset to the first step whenever a different reaction is opened, and
  // lock body scroll / wire up Esc-to-close while the modal is open.
  useEffect(() => {
    if (!reaction) return undefined;
    setStepIndex(0);
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reaction?.id]);

  const step = steps[stepIndex];

  const goTo = (i) => {
    setStepIndex(Math.max(0, Math.min(stepCount - 1, i)));
  };

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
            className="relative flex max-h-[calc(100vh-7rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-violet/25 bg-[#120c1e] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] sm:max-h-[calc(100vh-8rem)]"
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
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-lab-400">
                    Mechanism — step {stepIndex + 1} of {stepCount}
                  </h3>

                  <AnimatePresence mode="wait">
                    <motion.div
                      key={stepIndex}
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -16 }}
                      transition={{ duration: 0.22, ease: 'easeOut' }}
                      className="rounded-xl border border-lab-800 bg-lab-950/60 p-3"
                    >
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet">
                        {step.title}
                      </div>
                      {/* Keyed by stepIndex so the draw-in animation
                          replays every time a different step comes into
                          view. */}
                      <MechanismStepDiagram
                        key={stepIndex}
                        atoms={step.atoms}
                        bonds={step.bonds}
                        arrows={step.arrows}
                        height={190}
                      />
                      <p className="mt-2 text-xs leading-relaxed text-lab-300">{step.description}</p>
                    </motion.div>
                  </AnimatePresence>

                  {stepCount > 1 && (
                    <div className="mt-3 flex items-center justify-center gap-1.5">
                      {steps.map((_, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => goTo(i)}
                          aria-label={`Go to step ${i + 1}`}
                          className={`h-1.5 rounded-full transition-all ${
                            i === stepIndex ? 'w-5 bg-fuchsia-400' : 'w-1.5 bg-lab-700 hover:bg-lab-600'
                          }`}
                        />
                      ))}
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