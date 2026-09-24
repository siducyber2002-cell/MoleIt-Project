// frontend/src/components/FunctionalGroups/GroupFlashcard.jsx
//
// Redesigned to match the light "premium SaaS" Functional Groups tab —
// same flip mechanics (3D rotateY, backface-hidden front/back faces) as
// before, restyled as a soft-shadow white card instead of the dark lab
// panel.

import MiniStructurePreview from './MiniStructurePreview';
import ThreeStructurePreview from '../Viewer3D/ThreeStructurePreview';

export default function GroupFlashcard({ group, flipped, onFlip }) {
  const tone = group.tier === 'advanced' ? 'advanced' : 'core';
  return (
    <div className="mx-auto w-full max-w-md" style={{ perspective: 1200 }}>
      <button
        type="button"
        onClick={onFlip}
        className="relative block h-80 w-full text-left transition-transform duration-500"
        style={{
          transformStyle: 'preserve-3d',
          transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
        }}
      >
        {/* Front: structure + formula only */}
        <div
          className="fg-flash-card absolute inset-0 flex flex-col items-center justify-center gap-4 p-6"
          style={{ backfaceVisibility: 'hidden' }}
        >
          <div className="grid w-full grid-cols-2 gap-2">
            <div className={`fg-preview-frame fg-preview-frame--${tone} overflow-hidden`}>
              <MiniStructurePreview atoms={group.structure_2d.atoms} bonds={group.structure_2d.bonds} height={120} light />
            </div>
            <ThreeStructurePreview
              atoms={group.structure_2d.atoms}
              bonds={group.structure_2d.bonds}
              height={120}
              title={group.name}
              spin={!flipped}
            />
          </div>
          <span className={`fg-formula-pill fg-formula-pill--${tone}`}>{group.formula}</span>
          <span className="text-xs text-[var(--fg-ink-faint)]">Tap to reveal</span>
        </div>

        {/* Back: name + description + recognition + examples */}
        <div
          className="fg-flash-card fg-flash-card--back absolute inset-0 flex flex-col justify-center gap-3 overflow-y-auto p-6"
          style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
        >
          <h3 className="font-display text-lg font-bold text-[var(--fg-ink)]">{group.name}</h3>
          <p className="text-xs leading-relaxed text-[var(--fg-ink-soft)]">{group.description}</p>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-ink-faint)]">
              Recognize it by
            </div>
            <p className="text-xs leading-relaxed text-[var(--fg-ink-soft)]">{group.recognition}</p>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-ink-faint)]">
              Examples
            </div>
            <p className="text-xs leading-relaxed text-[var(--fg-ink-soft)]">{group.examples}</p>
          </div>
        </div>
      </button>
    </div>
  );
}