import { useState, useMemo, useCallback, useEffect } from 'react';
import { Search, Layers, LayoutGrid, RotateCcw, CheckCircle2, XCircle, ArrowLeft, Flame, Loader2 } from 'lucide-react';
import ReactionCard from '../components/Reactions/ReactionCard';
import ReactionFlashcard from '../components/Reactions/ReactionFlashcard';
import ReactionsHero from '../components/Reactions/ReactionsHero';
import ReactionDetailModal from '../components/Reactions/ReactionDetailModal';
import { fetchReactions } from '../api/api';
import {
  loadReviewState, saveReviewState, getDueGroups, recordResult, getBoxStats,
} from '../lib/flashcardState';

const TIERS = [
  { id: 'core', label: 'Core' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'all', label: 'All' },
];

// Separate localStorage key from Functional Groups' review state so the
// two flashcard decks track progress independently.
const REACTIONS_STORAGE_KEY = 'reaction_review_state_v1';

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function ReactionsPage() {
  const [mode, setMode] = useState('browse'); // 'browse' | 'flashcards'
  const [search, setSearch] = useState('');
  const [tier, setTier] = useState('core');
  const [category, setCategory] = useState('all');

  const [allReactions, setAllReactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [reviewState, setReviewState] = useState(() => loadReviewState(REACTIONS_STORAGE_KEY));
  const [queue, setQueue] = useState([]);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [sessionStats, setSessionStats] = useState({ gotIt: 0, again: 0 });
  const [sessionDone, setSessionDone] = useState(false);

  // Reaction whose full detail popup is open — set by tapping a floating
  // card in the hero OR any card in the browse grid (see ReactionsHero /
  // ReactionCard / ReactionDetailModal). The mechanism is only ever shown
  // in this popup; cards themselves never expand inline.
  const [selectedReaction, setSelectedReaction] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchReactions()
      .then((data) => {
        if (!cancelled) setAllReactions(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't load the reaction library. Check your connection and try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const categories = useMemo(
    () => Array.from(new Set(allReactions.map((r) => r.category))).sort(),
    [allReactions]
  );

  const tierReactions = useMemo(() => {
    let list = tier === 'all' ? allReactions : allReactions.filter((r) => r.tier === tier);
    if (category !== 'all') list = list.filter((r) => r.category === category);
    return list;
  }, [allReactions, tier, category]);

  const filtered = useMemo(() => {
    if (!search.trim()) return tierReactions;
    const q = search.trim().toLowerCase();
    return tierReactions.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.general_equation.toLowerCase().includes(q) ||
        r.summary.toLowerCase().includes(q) ||
        (r.reagents || '').toLowerCase().includes(q)
    );
  }, [tierReactions, search]);

  const startSession = useCallback(() => {
    const due = getDueGroups(tierReactions, reviewState);
    setQueue(shuffle(due));
    setSessionIndex(0);
    setFlipped(false);
    setSessionStats({ gotIt: 0, again: 0 });
    setSessionDone(false);
    setMode('flashcards');
  }, [tierReactions, reviewState]);

  const handleAnswer = useCallback((gotIt) => {
    const current = queue[sessionIndex];
    if (!current) return;

    const nextState = recordResult(reviewState, current.id, gotIt);
    setReviewState(nextState);
    saveReviewState(nextState, REACTIONS_STORAGE_KEY);
    setSessionStats((s) => ({ gotIt: s.gotIt + (gotIt ? 1 : 0), again: s.again + (gotIt ? 0 : 1) }));

    const nextIndex = sessionIndex + 1;
    if (nextIndex >= queue.length) {
      setSessionDone(true);
    } else {
      setSessionIndex(nextIndex);
      setFlipped(false);
    }
  }, [queue, sessionIndex, reviewState]);

  const boxStats = useMemo(() => getBoxStats(tierReactions, reviewState), [tierReactions, reviewState]);
  const mastered = boxStats[3] || 0;

  // A handful of reactions to feature as flowing cards in the hero —
  // prefer core-tier reactions so newcomers see the fundamentals first.
  // A spread of reactions to feature in the hero's scrolling columns —
  // one from *every* category first (so Addition, Elimination,
  // Rearrangement, Tautomerization, etc. are all represented, not just
  // whichever categories happened to come first in the raw list), then
  // a second pass fills in more from each category if there's room.
  // Prefers core-tier reactions, but falls back to any tier for a
  // category that has no core-tier example, so a category never gets
  // skipped just because it's advanced-only.
  const heroReactions = useMemo(() => {
    if (!allReactions.length) return [];
    const core = allReactions.filter((r) => r.tier === 'core');
    const pool = core.length > 0 ? core : allReactions;
    const byCategory = new Map();
    pool.forEach((r) => {
      if (!byCategory.has(r.category)) byCategory.set(r.category, []);
      byCategory.get(r.category).push(r);
    });
    // Categories with zero core-tier reactions still need a representative.
    allReactions.forEach((r) => {
      if (!byCategory.has(r.category)) byCategory.set(r.category, [r]);
    });

    const buckets = Array.from(byCategory.values());
    const picked = [];
    const target = Math.max(12, buckets.length * 2);
    let round = 0;
    while (picked.length < target && buckets.some((b) => b.length > round)) {
      buckets.forEach((bucket) => {
        if (bucket[round]) picked.push(bucket[round]);
      });
      round += 1;
    }
    return picked;
  }, [allReactions]);

  return (
    <div className="relative w-full">
      {/* Page-wide ambient purple wash. One fixed layer covering the
          whole viewport, purple from top to bottom — the old version
          faded to near-black (lab-950) by mid-screen, which is what made
          the hero area read as a pitch-black band above a purple lower
          half. Rendered at z-0 with the content at z-10 rather than a
          negative z-index behind an overflow-clipped wrapper, which is
          what produced the hard horizontal seam. */}
      <div className="pointer-events-none fixed inset-0 z-0 bg-[linear-gradient(to_bottom,#170c2b_0%,#150b27_45%,#120a22_100%)]" />
      <div className="pointer-events-none fixed -left-32 -top-40 z-0 h-[32rem] w-[32rem] rounded-full bg-purple-700/25 blur-[150px]" />
      <div className="pointer-events-none fixed -right-24 top-10 z-0 h-[28rem] w-[28rem] rounded-full bg-fuchsia-700/20 blur-[150px]" />
      <div className="pointer-events-none fixed left-1/4 top-1/3 z-0 h-[30rem] w-[30rem] rounded-full bg-violet-700/20 blur-[150px]" />
      <div className="pointer-events-none fixed -bottom-32 right-1/4 z-0 h-[30rem] w-[30rem] rounded-full bg-purple-600/15 blur-[150px]" />

      {/* Content sits above the wash. The horizontal clip lives here, on
          a wrapper that holds no fixed layers. */}
      <div className="relative z-10 mx-auto w-full max-w-7xl overflow-x-clip px-4 py-4 sm:py-8">

        {!loadError && (
          <div className="mb-5 sm:mb-10">
            <ReactionsHero reactions={heroReactions} onSelect={setSelectedReaction} loading={loading} />
          </div>
        )}
        <ReactionDetailModal reaction={selectedReaction} onClose={() => setSelectedReaction(null)} />

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-lab-100">Reactions</h1>
            <p className="mt-1 text-sm text-lab-400">
              Named reactions and mechanisms — open a card to step through the electron-pushing.
            </p>
          </div>

          {mode === 'browse' && !loading && !loadError && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-lab-500">
                <Flame size={14} className="text-amber" />
                {mastered} / {tierReactions.length} mastered
              </div>
              <button
                onClick={startSession}
                disabled={tierReactions.length === 0}
                className="flex items-center gap-1.5 rounded-md border border-fuchsia-400/40 bg-fuchsia-400/10 px-3 py-1.5 text-xs font-medium text-fuchsia-400 hover:bg-fuchsia-400/20 disabled:opacity-40"
              >
                <Layers size={14} /> Flashcards
              </button>
            </div>
          )}
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-24 text-sm text-lab-500">
            <Loader2 size={16} className="animate-spin" /> Loading reaction library…
          </div>
        )}

        {!loading && loadError && (
          <div className="py-24 text-center text-sm text-coral">{loadError}</div>
        )}

        {!loading && !loadError && mode === 'browse' && (
          <>
            <div className="mb-6 flex flex-wrap items-center gap-4">
              <div className="relative max-w-md flex-1">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-lab-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search reactions, reagents…"
                  className="w-full rounded-md border border-lab-700 bg-lab-900 py-2 pl-9 pr-3 text-sm text-lab-100 outline-none focus:border-fuchsia-400"
                />
              </div>

              <div className="flex gap-1 rounded-md border border-lab-700 bg-lab-900 p-1">
                {TIERS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTier(t.id)}
                    className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                      tier === t.id
                        ? 'bg-fuchsia-400/15 text-fuchsia-400'
                        : 'text-lab-400 hover:text-lab-200'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {categories.length > 0 && (
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="rounded-md border border-lab-700 bg-lab-900 px-2.5 py-1.5 text-xs text-lab-300 outline-none focus:border-fuchsia-400"
                >
                  <option value="all">All categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className="py-16 text-center text-sm text-lab-500">No reactions match your search.</div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((r) => (
                  <ReactionCard key={r.id} reaction={r} onOpen={setSelectedReaction} />
                ))}
              </div>
            )}
          </>
        )}

        {!loading && !loadError && mode === 'flashcards' && !sessionDone && queue.length > 0 && (
          <div className="flex flex-col items-center gap-6 py-6">
            <div className="flex w-full max-w-md items-center justify-between text-xs text-lab-500">
              <button onClick={() => setMode('browse')} className="flex items-center gap-1 hover:text-lab-300">
                <ArrowLeft size={13} /> Back to browse
              </button>
              <span>{sessionIndex + 1} / {queue.length}</span>
            </div>

            <div className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-lab-800">
              <div
                className="h-full bg-fuchsia-400 transition-all duration-300"
                style={{ width: `${((sessionIndex) / queue.length) * 100}%` }}
              />
            </div>

            <ReactionFlashcard
              reaction={queue[sessionIndex]}
              flipped={flipped}
              onFlip={() => setFlipped((f) => !f)}
            />

            {flipped ? (
              <div className="flex gap-3">
                <button
                  onClick={() => handleAnswer(false)}
                  className="flex items-center gap-1.5 rounded-md border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-medium text-coral hover:bg-coral/20"
                >
                  <XCircle size={15} /> Review again
                </button>
                <button
                  onClick={() => handleAnswer(true)}
                  className="flex items-center gap-1.5 rounded-md border border-fuchsia-400/40 bg-fuchsia-400/10 px-4 py-2 text-sm font-medium text-fuchsia-400 hover:bg-fuchsia-400/20"
                >
                  <CheckCircle2 size={15} /> Got it
                </button>
              </div>
            ) : (
              <p className="text-xs text-lab-500">Click the card to reveal the mechanism</p>
            )}
          </div>
        )}

        {!loading && !loadError && mode === 'flashcards' && sessionDone && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center">
            <Layers size={32} className="text-fuchsia-400" />
            <h2 className="font-display text-xl font-bold text-lab-100">Session complete</h2>
            <p className="text-sm text-lab-400">
              {sessionStats.gotIt} got it · {sessionStats.again} to review again
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setMode('browse')}
                className="flex items-center gap-1.5 rounded-md border border-lab-700 px-4 py-2 text-sm font-medium text-lab-300 hover:border-fuchsia-400/50 hover:text-fuchsia-400"
              >
                <LayoutGrid size={14} /> Back to browse
              </button>
              <button
                onClick={startSession}
                className="flex items-center gap-1.5 rounded-md border border-fuchsia-400/40 bg-fuchsia-400/10 px-4 py-2 text-sm font-medium text-fuchsia-400 hover:bg-fuchsia-400/20"
              >
                <RotateCcw size={14} /> Study again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}