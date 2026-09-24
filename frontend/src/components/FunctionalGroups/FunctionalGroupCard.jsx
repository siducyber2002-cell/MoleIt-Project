// frontend/src/components/FunctionalGroups/FunctionalGroupCard.jsx
//
// v2: the previous hover panel was an absolute overlay that slid up
// from the bottom — on tap/focus it could rise far enough to hide the
// structure diagram behind it entirely. This version keeps the
// diagram in a fixed slot that's never covered by anything: a short
// "recognize it by" teaser sits below it at all times, and clicking
// "More details" grows the card downward (CSS grid-rows animation) to
// reveal the rest, rather than layering over existing content.

import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { PenTool, ChevronDown } from 'lucide-react';
import MiniStructurePreview from './MiniStructurePreview';

export default function FunctionalGroupCard({ group, index = 0, frameWidth, frameHeight }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const isAdvanced = group.tier === 'advanced';
  const tone = isAdvanced ? 'advanced' : 'core';

  const openInDrawLab = () =>
    navigate('/draw', { state: { structure_2d: group.structure_2d, name: group.name } });

  return (
    <div
      className="fg-card-rise"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <div className="fg-card group flex flex-col">
        <div className={`fg-card-tag fg-card-tag--${tone}`}>{isAdvanced ? 'Advanced' : 'Core'}</div>
        <span className="fg-card-index">{String(index + 1).padStart(2, '0')}</span>

        {/* header */}
        <div className="relative flex flex-col gap-2 p-5 pb-0 pt-9">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-display text-lg font-bold leading-tight tracking-tight text-[var(--fg-ink)]">
              {group.name}
            </h3>
            <span className={`fg-formula-pill fg-formula-pill--${tone} shrink-0`}>{group.formula}</span>
          </div>
        </div>

        {/* structure preview — always fully visible, never covered */}
        <div className={`fg-preview-frame fg-preview-frame--${tone} mx-5 mb-4 mt-4 h-[150px] shrink-0`}>
          <MiniStructurePreview
            atoms={group.structure_2d.atoms}
            bonds={group.structure_2d.bonds}
            frameWidth={frameWidth}
            frameHeight={frameHeight}
            light
          />
        </div>

        {/* always-visible teaser */}
        <div className="px-5 pb-5">
          <div className="fg-teaser-label">Recognize it by</div>
          <p className="fg-teaser-text mt-1">{group.recognition}</p>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className={`fg-expand-toggle ${expanded ? 'is-open' : ''}`}
            aria-expanded={expanded}
          >
            {expanded ? 'Show less' : 'More details'}
            <ChevronDown size={13} />
          </button>
        </div>

        {/* expand-in-place panel — grows the card downward, never overlaps */}
        <div className={`fg-expand ${expanded ? 'is-open' : ''}`}>
          <div className="fg-expand-inner px-5 pb-5">
            <p className="mt-2.5 text-xs leading-relaxed text-[var(--fg-ink-faint)]">{group.description}</p>
            <div className="mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-ink-faint)]">
              Examples
            </div>
            <p className="text-xs leading-relaxed text-[var(--fg-ink-soft)]">{group.examples}</p>

            <button
              onClick={(e) => {
                e.stopPropagation();
                openInDrawLab();
              }}
              className="fg-draw-lab-btn mt-3.5"
            >
              <PenTool size={13} /> Open in Draw Lab
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}