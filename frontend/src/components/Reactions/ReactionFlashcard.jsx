// frontend/src/components/Reactions/ReactionFlashcard.jsx

import MechanismStepDiagram from './MechanismStepDiagram';

export default function ReactionFlashcard({ reaction, flipped, onFlip }) {
  return (
    <div className="mx-auto w-full max-w-md" style={{ perspective: 1200 }}>
      <button
        type="button"
        onClick={onFlip}
        className="relative block h-96 w-full text-left transition-transform duration-500"
        style={{
          transformStyle: 'preserve-3d',
          transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
        }}
      >
        {/* Front: general equation + reagents/conditions only */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-xl border border-lab-700 bg-lab-900 p-6"
          style={{ backfaceVisibility: 'hidden' }}
        >
          <span className="rounded-full border border-violet/30 bg-violet/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet">
            {reaction.category}
          </span>
          <p className="text-center font-mono text-sm text-lab-100">{reaction.general_equation}</p>
          {reaction.reagents && (
            <p className="text-center text-xs text-lab-400">{reaction.reagents}</p>
          )}
          {reaction.conditions && (
            <p className="text-center text-[11px] text-lab-500">{reaction.conditions}</p>
          )}
          <span className="text-xs text-lab-500">Tap to reveal the mechanism</span>
        </div>

        {/* Back: name + step-by-step mechanism, scrollable */}
        <div
          className="absolute inset-0 flex flex-col gap-3 overflow-y-auto rounded-xl border border-fuchsia-400/40 bg-lab-900 p-5"
          style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
        >
          <h3 className="font-display text-base font-bold text-lab-100">{reaction.name}</h3>
          <p className="text-xs leading-relaxed text-lab-400">{reaction.summary}</p>

          <div className="flex flex-col gap-4">
            {reaction.mechanism_steps.map((step, i) => (
              <div key={i} className="rounded-lg border border-lab-800 bg-lab-950/50 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fuchsia-400/15 text-[10px] font-bold text-fuchsia-400">
                    {i + 1}
                  </span>
                  <span className="text-xs font-semibold text-lab-200">{step.title}</span>
                </div>
                <MechanismStepDiagram atoms={step.atoms} bonds={step.bonds} arrows={step.arrows} height={130} />
                <p className="mt-1.5 text-[11px] leading-relaxed text-lab-400">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </button>
    </div>
  );
}