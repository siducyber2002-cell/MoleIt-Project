// frontend/src/pages/FunctionalGroupsPage.jsx
//
// Functional Groups tab — v2 of the light, editorial "premium SaaS"
// page. Scoped entirely under .fg-page (see FunctionalGroupsPage.css)
// so nothing here leaks into the rest of the app, the same way
// GroupTheoryPage's standalone light theme is scoped under .gt-page.
//
// v2 fixes/changes, see FunctionalGroupsPage.css header for the full
// rationale on each:
//   - flattens the body/html background while mounted, fixing a solid
//     black band that showed above the page (the fix GroupTheoryPage
//     already had for itself, that this page was missing)
//   - deeper contrast, calmer ambient glow
//   - added a flowing animated gradient ribbon behind the hero
//   - card structure diagrams are never covered by the details panel
//     (see FunctionalGroupCard.jsx)
//
// Functionally unchanged from before: same backend fetch, same
// search/tier filtering, same Leitner-box flashcard session driven by
// lib/flashcardState.js.

import { useState, useMemo, useCallback, useEffect } from 'react';
import { Search, Layers, LayoutGrid, RotateCcw, CheckCircle2, XCircle, ArrowLeft, Flame, Loader2, Sparkles } from 'lucide-react';
import FunctionalGroupCard from '../components/FunctionalGroups/FunctionalGroupCard';
import GroupFlashcard from '../components/FunctionalGroups/GroupFlashcard';
import FlowingRibbon from '../components/motion/FlowingRibbon';
import { fetchFunctionalGroups } from '../api/api';
import {
  loadReviewState, saveReviewState, getDueGroups, recordResult, getBoxStats,
} from '../lib/flashcardState';
import './FunctionalGroupsPage.css';

const TIERS = [
  { id: 'core', label: 'Core' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'all', label: 'All' },
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Computes ONE frame size (in the same coordinate units as atom.x/atom.y)
// big enough to fit the widest and tallest molecule in the whole set,
// plus breathing room. This gets passed to every FunctionalGroupCard so
// all of them draw at the same scale (MiniStructurePreview centers each
// molecule inside this shared frame instead of re-fitting itself) — see
// the "structures were different sizes" and "Orthoester got cut off"
// fixes. Deriving it from the real data means it self-adjusts if bigger
// or smaller structures are added later, instead of relying on a guessed
// constant that can go stale.
const FRAME_PADDING = 50;
const MIN_FRAME_WIDTH = 260;
const MIN_FRAME_HEIGHT = 160;

function computeFrameSize(groups) {
  let maxSpanX = 0;
  let maxSpanY = 0;
  for (const g of groups) {
    const atoms = g.structure_2d?.atoms;
    if (!atoms || atoms.length === 0) continue;
    const xs = atoms.map((a) => a.x);
    const ys = atoms.map((a) => a.y);
    maxSpanX = Math.max(maxSpanX, Math.max(...xs) - Math.min(...xs));
    maxSpanY = Math.max(maxSpanY, Math.max(...ys) - Math.min(...ys));
  }
  return {
    width: Math.max(MIN_FRAME_WIDTH, maxSpanX + FRAME_PADDING * 2),
    height: Math.max(MIN_FRAME_HEIGHT, maxSpanY + FRAME_PADDING * 2),
  };
}

export default function FunctionalGroupsPage() {
  const [mode, setMode] = useState('browse'); // 'browse' | 'flashcards'
  const [search, setSearch] = useState('');
  const [tier, setTier] = useState('core'); // 'core' | 'advanced' | 'all'

  // Backend-fetched data (the source of truth is Postgres, seeded from
  // backend/app/data/functional_groups_seed.json on startup).
  const [allGroups, setAllGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Flashcard session state
  const [reviewState, setReviewState] = useState(() => loadReviewState());
  const [queue, setQueue] = useState([]);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [sessionStats, setSessionStats] = useState({ gotIt: 0, again: 0 });
  const [sessionDone, setSessionDone] = useState(false);

  // Flattens the app's default dark "lab" body background to this
  // page's own light background while it's mounted — otherwise that
  // dark colour shows through as a solid band above the page (behind
  // the slim TopBar strip) and on mobile overscroll, since .fg-page
  // itself is only ever as tall as its own content. Restored on
  // unmount. Same fix GroupTheoryPage.css already applies for itself
  // via .gt-light-scroll.
  useEffect(() => {
    document.documentElement.classList.add('fg-light-scroll');
    document.body.classList.add('fg-light-scroll');
    return () => {
      document.documentElement.classList.remove('fg-light-scroll');
      document.body.classList.remove('fg-light-scroll');
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchFunctionalGroups()
      .then((data) => {
        if (!cancelled) setAllGroups(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't load the functional group library. Check your connection and try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Computed once per data load — shared by every card so structures are
  // always drawn at one consistent, non-clipping scale.
  const frameSize = useMemo(() => computeFrameSize(allGroups), [allGroups]);

  const tierGroups = useMemo(() => {
    if (tier === 'all') return allGroups;
    return allGroups.filter((g) => g.tier === tier);
  }, [allGroups, tier]);

  const filtered = useMemo(() => {
    if (!search.trim()) return tierGroups;
    const q = search.trim().toLowerCase();
    return tierGroups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        g.examples.toLowerCase().includes(q) ||
        g.description.toLowerCase().includes(q)
    );
  }, [tierGroups, search]);

  const startSession = useCallback(() => {
    const due = getDueGroups(tierGroups, reviewState);
    setQueue(shuffle(due));
    setSessionIndex(0);
    setFlipped(false);
    setSessionStats({ gotIt: 0, again: 0 });
    setSessionDone(false);
    setMode('flashcards');
  }, [tierGroups, reviewState]);

  const handleAnswer = useCallback((gotIt) => {
    const current = queue[sessionIndex];
    if (!current) return;

    const nextState = recordResult(reviewState, current.id, gotIt);
    setReviewState(nextState);
    saveReviewState(nextState);
    setSessionStats((s) => ({ gotIt: s.gotIt + (gotIt ? 1 : 0), again: s.again + (gotIt ? 0 : 1) }));

    const nextIndex = sessionIndex + 1;
    if (nextIndex >= queue.length) {
      setSessionDone(true);
    } else {
      setSessionIndex(nextIndex);
      setFlipped(false);
    }
  }, [queue, sessionIndex, reviewState]);

  const boxStats = useMemo(() => getBoxStats(tierGroups, reviewState), [tierGroups, reviewState]);
  const mastered = boxStats[3] || 0;

  return (
    <div className="fg-page">
      <div className="fg-orbs" aria-hidden="true">
        <div className="fg-orb fg-orb--violet" />
      </div>

      <div className="fg-content mx-auto w-full max-w-7xl px-4 py-10 sm:py-14">
        {/* ---------- hero ---------- */}
        {/* The ribbon sits as an absolute watermark behind this whole
            block (see .fg-hero-ribbon) and bleeds edge-to-edge across
            the viewport — it used to get clipped because an ancestor
            here had overflow-x:hidden, which cut off everything the
            full-bleed trick pushed outside this column. That's now
            moved up to .fg-page itself (see the CSS), which clips only
            at the true page edge instead of at this narrower column. */}
        <div className="fg-hero">
          <div className="fg-hero-ribbon" aria-hidden="true">
            <FlowingRibbon height={340} opacity={0.4} />
          </div>

          <div className="fg-hero-content mb-2 flex flex-wrap items-end justify-between gap-8 pb-8">
            <div className="max-w-xl">
              <span className="fg-eyebrow mb-4">
                <span className="fg-eyebrow-dot" /> Organic Chemistry · Reference
              </span>
              <h1 className="fg-h1 text-4xl sm:text-5xl">
                Functional <span className="fg-h1-accent">Groups</span>
              </h1>
              <p className="fg-lede mt-4 text-[15px]">
                The building blocks that give molecules their reactivity. Every card
                shows how to recognize it — tap "More details" for examples, or open it
                straight into the Draw Lab.
              </p>
            </div>

            {mode === 'browse' && !loading && !loadError && (
              <div className="flex flex-wrap items-center gap-3">
                <div className="fg-stat">
                  <span className="fg-stat-value">
                    {String(tierGroups.length).padStart(2, '0')}
                  </span>
                  <span className="fg-stat-label">Catalogued</span>
                </div>
                <div className="fg-stat">
                  <span className="fg-stat-value">
                    <Flame size={15} className="text-[var(--fg-amber)]" />
                    {mastered}
                  </span>
                  <span className="fg-stat-label">Mastered</span>
                </div>
                <button
                  onClick={startSession}
                  disabled={tierGroups.length === 0}
                  className="fg-btn-primary"
                >
                  <Layers size={14} /> Flashcards
                </button>
              </div>
            )}
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--fg-ink-faint)]">
            <Loader2 size={16} className="animate-spin" /> Loading functional groups…
          </div>
        )}

        {!loading && loadError && (
          <div className="fg-empty py-16 text-center text-sm text-[var(--fg-rose)]">{loadError}</div>
        )}

        {!loading && !loadError && mode === 'browse' && (
          <>
            <div className="mb-8 flex flex-wrap items-center gap-4">
              <div className="fg-search max-w-md flex-1">
                <Search size={15} className="shrink-0 text-[var(--fg-ink-faint)]" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search groups, examples…"
                />
              </div>

              <div className="fg-segmented">
                {TIERS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTier(t.id)}
                    className={tier === t.id ? 'is-active' : ''}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className="fg-empty py-16 text-center text-sm">No functional groups match your search.</div>
            ) : (
              <div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((g, i) => (
                  <FunctionalGroupCard
                    key={g.id}
                    group={g}
                    index={i}
                    frameWidth={frameSize.width}
                    frameHeight={frameSize.height}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {!loading && !loadError && mode === 'flashcards' && !sessionDone && queue.length > 0 && (
          <div className="flex flex-col items-center gap-6 py-6">
            <div className="flex w-full max-w-md items-center justify-between text-xs text-[var(--fg-ink-faint)]">
              <button onClick={() => setMode('browse')} className="flex items-center gap-1 hover:text-[var(--fg-ink)]">
                <ArrowLeft size={13} /> Back to browse
              </button>
              <span>{sessionIndex + 1} / {queue.length}</span>
            </div>

            <div className="fg-flash-progress-track w-full max-w-md">
              <div
                className="fg-flash-progress-fill"
                style={{ width: `${((sessionIndex) / queue.length) * 100}%` }}
              />
            </div>

            <GroupFlashcard
              group={queue[sessionIndex]}
              flipped={flipped}
              onFlip={() => setFlipped((f) => !f)}
            />

            {flipped ? (
              <div className="flex gap-3">
                <button onClick={() => handleAnswer(false)} className="fg-answer-again">
                  <XCircle size={15} /> Review again
                </button>
                <button onClick={() => handleAnswer(true)} className="fg-answer-good">
                  <CheckCircle2 size={15} /> Got it
                </button>
              </div>
            ) : (
              <p className="text-xs text-[var(--fg-ink-faint)]">Click the card to reveal the answer</p>
            )}
          </div>
        )}

        {!loading && !loadError && mode === 'flashcards' && sessionDone && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--fg-teal-tint)] to-[var(--fg-violet-tint)]">
              <Sparkles size={26} className="text-[var(--fg-teal-soft)]" />
            </div>
            <h2 className="font-display text-xl font-bold text-[var(--fg-ink)]">Session complete</h2>
            <p className="text-sm text-[var(--fg-ink-soft)]">
              {sessionStats.gotIt} got it · {sessionStats.again} to review again
            </p>
            <div className="flex gap-3">
              <button onClick={() => setMode('browse')} className="fg-btn-ghost">
                <LayoutGrid size={14} /> Back to browse
              </button>
              <button onClick={startSession} className="fg-btn-primary">
                <RotateCcw size={14} /> Study again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}