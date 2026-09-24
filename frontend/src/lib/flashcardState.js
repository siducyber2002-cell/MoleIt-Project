// frontend/src/lib/flashcardState.js

// Simple Leitner-box spaced repetition, shared by the Functional Groups
// and Reactions flashcard modes. Each caller passes its own storageKey
// so the two decks track review progress independently in localStorage.

const DEFAULT_STORAGE_KEY = 'flashcard_review_state_v1';

// How long to wait before a card in each box is "due" again.
const BOX_INTERVAL_MS = {
  1: 0,                      // always due — still learning it
  2: 2 * 24 * 60 * 60 * 1000, // 2 days
  3: 5 * 24 * 60 * 60 * 1000, // 5 days
};

const MAX_BOX = 3;
const MIN_BOX = 1;

export function loadReviewState(storageKey = DEFAULT_STORAGE_KEY) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveReviewState(state, storageKey = DEFAULT_STORAGE_KEY) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — fail
    // silently, flashcards still work for the current session.
  }
}

function entryFor(state, cardId) {
  return state[cardId] || { box: MIN_BOX, nextReview: 0 };
}

// A card is "due" if it's never been reviewed, or its box's interval has
// elapsed since the last review.
export function isDue(state, cardId, now = Date.now()) {
  const entry = entryFor(state, cardId);
  return now >= entry.nextReview;
}

// Returns the subset of `cards` that are due for review right now. Falls
// back to the full list if nothing is due yet, so a session always has
// cards to show instead of coming up empty.
export function getDueGroups(cards, state, now = Date.now()) {
  const due = cards.filter((c) => isDue(state, c.id, now));
  return due.length > 0 ? due : cards;
}

// Records a "got it" / "review again" result for a card and returns a new
// state object (does not mutate the input).
export function recordResult(state, cardId, gotIt, now = Date.now()) {
  const prev = entryFor(state, cardId);
  const nextBox = gotIt
    ? Math.min(MAX_BOX, prev.box + 1)
    : MIN_BOX;
  const nextReview = now + BOX_INTERVAL_MS[nextBox];

  return {
    ...state,
    [cardId]: { box: nextBox, nextReview },
  };
}

// Small summary used for a progress readout, e.g. "4 mastered · 6 learning".
export function getBoxStats(cards, state) {
  const stats = { 1: 0, 2: 0, 3: 0, untouched: 0 };
  cards.forEach((c) => {
    const entry = state[c.id];
    if (!entry) {
      stats.untouched += 1;
    } else {
      stats[entry.box] = (stats[entry.box] || 0) + 1;
    }
  });
  return stats;
}