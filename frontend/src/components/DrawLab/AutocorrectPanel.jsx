import { Wand2, Loader2, X, Sparkles, CheckCircle2 } from 'lucide-react';

const SOURCE_LABEL = {
  library: 'In your library',
  pubchem: 'PubChem',
};

/** The "did you mean...?" popover shown after clicking Autocorrect. Its
 *  formula-matched candidates come from the backend (local library +
 *  live PubChem formula search); picking one swaps the drawn structure
 *  for that compound's real, correct one. "Just clean up the geometry"
 *  is always available as a no-identification fallback, and is what runs
 *  automatically if nothing matched. */
export default function AutocorrectPanel({
  open,
  loading,
  error,
  formula,
  cropped,
  hasBoundaryBonds,
  candidates,
  onPick,
  resolvingKey,
  onCleanupOnly,
  onClose,
}) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-lab-950/60 backdrop-blur-[2px] pt-14">
      <div className="w-[min(92vw,26rem)] rounded-xl border border-lab-700 bg-lab-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-lab-800 px-4 py-3">
          <span className="flex items-center gap-2 font-display text-xs font-semibold uppercase tracking-wider text-lab-300">
            <Wand2 size={14} className="text-sky-300" />
            Autocorrect
          </span>
          <button onClick={onClose} className="text-lab-500 hover:text-lab-200">
            <X size={15} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="mb-3 text-[11px] leading-relaxed text-lab-400">
            {cropped ? 'Looking at the atoms you selected — ' : 'Looking at your whole drawing — '}
            detected formula{' '}
            <span className="rounded bg-lab-800 px-1.5 py-0.5 font-mono text-phosphor">{formula || '—'}</span>.
          </p>

          {hasBoundaryBonds && (
            <p className="mb-3 rounded-md border border-amber/25 bg-amber/5 px-2.5 py-2 text-[11px] leading-snug text-lab-300">
              This selection is still bonded to atoms outside it. Swapping to a suggested compound will
              disconnect it from the rest of your drawing — cleaning up the geometry instead won't.
            </p>
          )}

          {loading && (
            <div className="flex items-center gap-2 py-4 text-xs text-lab-400">
              <Loader2 size={14} className="animate-spin" />
              Checking the library and PubChem for a match…
            </div>
          )}

          {!loading && error && (
            <p className="mb-3 rounded-md border border-coral/25 bg-coral/5 px-2.5 py-2 text-[11px] leading-snug text-lab-300">
              {error}
            </p>
          )}

          {!loading && !error && candidates && candidates.length > 0 && (
            <>
              {candidates.some((c) => c.formula_match !== 'close') && (
                <>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-lab-500">
                    Did you mean…
                  </p>
                  <ul className="mb-3 space-y-1.5">
                    {candidates
                      .filter((c) => c.formula_match !== 'close')
                      .map((c) => (
                        <CandidateRow key={c.compound_id || c.cid || c.name} c={c} onPick={onPick} resolvingKey={resolvingKey} />
                      ))}
                  </ul>
                </>
              )}
              {candidates.some((c) => c.formula_match === 'close') && (
                <>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-lab-500">
                    {candidates.some((c) => c.formula_match !== 'close')
                      ? 'Close formula matches (a hydrogen or two off)'
                      : "Nothing matches that formula exactly — closest formulas found"}
                  </p>
                  <ul className="space-y-1.5">
                    {candidates
                      .filter((c) => c.formula_match === 'close')
                      .map((c) => (
                        <CandidateRow key={c.compound_id || c.cid || c.name} c={c} onPick={onPick} resolvingKey={resolvingKey} />
                      ))}
                  </ul>
                </>
              )}
            </>
          )}

          {!loading && !error && candidates && candidates.length === 0 && (
            <p className="mb-3 rounded-md border border-lab-700 bg-lab-850/60 px-2.5 py-2 text-[11px] leading-snug text-lab-400">
              No compound in the library or on PubChem is close to that formula. You can still clean up the
              geometry below.
            </p>
          )}
        </div>

        <div className="border-t border-lab-800 px-4 py-3">
          <button
            onClick={onCleanupOnly}
            disabled={!!resolvingKey}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-lab-700 bg-lab-850/60 px-3 py-2 text-xs font-medium text-lab-300 transition-all hover:border-lab-600 hover:text-lab-100 disabled:opacity-50"
          >
            <Sparkles size={13} />
            Just clean up the geometry — keep what I drew
          </button>
        </div>
      </div>
    </div>
  );
}

function CandidateRow({ c, onPick, resolvingKey }) {
  const key = c.compound_id || c.cid || c.name;
  const resolving = resolvingKey === key;
  return (
    <li>
      <button
        onClick={() => onPick(c)}
        disabled={!!resolvingKey}
        className="flex w-full items-center justify-between rounded-lg border border-lab-700 bg-lab-850/60 px-3 py-2 text-left transition-all hover:border-sky-400/50 hover:bg-sky-400/5 disabled:opacity-50"
      >
        <span>
          <span className="block text-sm font-medium text-lab-100">{c.name}</span>
          <span className="block font-mono text-[11px] text-lab-500">
            {c.formula}
            {typeof c.ring_count === 'number' && ` · ${c.ring_count} ring${c.ring_count === 1 ? '' : 's'}`}
            {' · '}
            {SOURCE_LABEL[c.source] || c.source}
          </span>
        </span>
        {resolving ? (
          <Loader2 size={15} className="animate-spin text-sky-300" />
        ) : (
          <CheckCircle2 size={15} className="text-lab-600" />
        )}
      </button>
    </li>
  );
}