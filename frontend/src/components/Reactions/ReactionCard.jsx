// frontend/src/components/Reactions/ReactionCard.jsx
//
// A reaction is now a single, entirely clickable card. The old inline
// "View mechanism (n steps)" accordion is gone — expanding downwards
// blew up the grid height and dropped a grey diagram board into the
// middle of the card. Clicking anywhere on the card now opens
// ReactionDetailModal, which plays the mechanism step by step.

import { ArrowUpRight } from 'lucide-react';

export default function ReactionCard({ reaction, onOpen }) {
  const stepCount = reaction.mechanism_steps?.length || 0;

  const open = () => onOpen?.(reaction);

  return (
    <button
      type="button"
      onClick={open}
      className="group relative flex h-full w-full flex-col self-start overflow-hidden rounded-xl border border-lab-700/80 bg-lab-900/70 p-4 text-left backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-fuchsia-400/50 hover:bg-lab-900 hover:shadow-[0_10px_30px_-12px_rgba(217,70,239,0.45)] focus:outline-none focus-visible:border-fuchsia-400 focus-visible:ring-2 focus-visible:ring-fuchsia-400/40"
    >
      {/* Soft violet wash that lifts on hover — keeps the card on-theme
          with the page's purple background instead of reading as a flat
          grey box. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.07] via-transparent to-fuchsia-500/[0.05] opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

      <div className="relative mb-2 flex items-start justify-between gap-2">
        <h3 className="font-display text-base font-semibold text-lab-100 transition-colors group-hover:text-white">
          {reaction.name}
        </h3>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded-full border border-violet/30 bg-violet/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet">
            {reaction.category}
          </span>
          {reaction.tier === 'advanced' && (
            <span className="rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber">
              Advanced
            </span>
          )}
        </div>
      </div>

      <p className="relative mb-2 font-mono text-xs text-lab-200">{reaction.general_equation}</p>
      {reaction.reagents && (
        <p className="relative text-[11px] text-lab-500">{reaction.reagents}</p>
      )}

      <p className="relative mt-2.5 line-clamp-4 text-xs leading-relaxed text-lab-400">
        {reaction.summary}
      </p>

      {/* Pushed to the bottom so every card in a row lines its call to
          action up, regardless of summary length. */}
      <div className="relative mt-auto flex items-center justify-between gap-2 border-t border-lab-800 pt-3 text-[11px] font-medium">
        <span className="flex items-center gap-1.5 text-fuchsia-400/90 transition-colors group-hover:text-fuchsia-300">
          Click to view full mechanism
          <ArrowUpRight
            size={13}
            className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          />
        </span>
        {stepCount > 0 && (
          <span className="shrink-0 text-lab-500">
            {stepCount} step{stepCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </button>
  );
}