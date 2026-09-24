import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Globe2, Loader2, AlertCircle, RotateCcw, CheckCircle2 } from 'lucide-react';
import CompoundCard from '../components/Library/CompoundCard';
import CompoundOrbitHero from '../components/Library/CompoundOrbitHero';
import { useLibraryTheme, LibraryThemeStyles } from '../components/Library/libTheme';
import { fetchCompounds, fetchCompoundCategories, fetchExternalCompound, extractErrorMessage } from '../api/api';

// PubChem is queried automatically when a search finds nothing in the local
// library. Two guards keep that from firing on every keystroke:
//  - the query must be at least this long, and
//  - the user must have stopped typing for this long (on top of the 200ms
//    debounce on the local search itself).
const PUBCHEM_MIN_CHARS = 3;
const PUBCHEM_DELAY_MS = 500;

export default function LibraryPage() {
  const [searchParams] = useSearchParams();
  const [compounds, setCompounds] = useState([]);
  const [spotlight, setSpotlight] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [category, setCategory] = useState('All');
  const [loading, setLoading] = useState(true);

  // PubChem lookup state: status is 'idle' | 'loading' | 'error'.
  const [pubchem, setPubchem] = useState({ status: 'idle', query: '', error: null });
  const [fetchedName, setFetchedName] = useState(null); // shown in the "saved to your library" note
  const fetchToken = useRef(0); // lets a newer search cancel an older in-flight lookup
  const failedQueries = useRef(new Set()); // don't hammer PubChem with a query that already failed

  // Light theme for this page only (see libTheme.jsx)
  useLibraryTheme();

  // Keep the filter in sync if the navbar search is used again while
  // already on this page (e.g. searching a second term without navigating away).
  useEffect(() => {
    const q = searchParams.get('q') || '';
    setSearch(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const load = useCallback(() => {
    setLoading(true);
    fetchCompounds({ search: search || undefined, category: category === 'All' ? undefined : category })
      .then(setCompounds)
      .finally(() => setLoading(false));
  }, [search, category]);

  useEffect(() => {
    fetchCompoundCategories().then((cats) => setCategories(['All', ...cats]));
    fetchCompounds({}).then(setSpotlight);
  }, []);

  // Any change to the search or filter cancels whatever PubChem lookup was
  // running and clears the previous lookup's messages.
  useEffect(() => {
    fetchToken.current += 1;
    setPubchem({ status: 'idle', query: '', error: null });
    setFetchedName(null);
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const searchText = search.trim();

  const runPubchemFetch = useCallback((query) => {
    const q = query.trim();
    if (!q) return;
    const token = ++fetchToken.current;
    failedQueries.current.delete(q.toLowerCase());
    setPubchem({ status: 'loading', query: q, error: null });
    fetchExternalCompound(q)
      .then((compound) => {
        if (token !== fetchToken.current) return; // the user has searched for something else since
        // The backend has already saved it to the library; show it right here,
        // and refresh the category list + hero cards in case it added anything new.
        setCompounds([compound]);
        setFetchedName(compound.name);
        setPubchem({ status: 'idle', query: '', error: null });
        fetchCompoundCategories().then((cats) => setCategories(['All', ...cats]));
        fetchCompounds({}).then(setSpotlight);
      })
      .catch((err) => {
        if (token !== fetchToken.current) return;
        failedQueries.current.add(q.toLowerCase());
        setPubchem({
          status: 'error',
          query: q,
          error: extractErrorMessage(err, 'Could not fetch that compound from PubChem. Try a different spelling.'),
        });
      });
  }, []);

  // No local match -> go straight to PubChem, no extra click.
  const wantsPubchem =
    !loading &&
    compounds.length === 0 &&
    searchText.length >= PUBCHEM_MIN_CHARS &&
    !failedQueries.current.has(searchText.toLowerCase());

  useEffect(() => {
    if (!wantsPubchem || pubchem.status === 'loading') return undefined;
    const t = setTimeout(() => runPubchemFetch(searchText), PUBCHEM_DELAY_MS);
    return () => clearTimeout(t);
  }, [wantsPubchem, pubchem.status, searchText, runPubchemFetch]);

  // Enter skips the wait
  const onSearchKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    if (!loading && compounds.length === 0 && searchText) runPubchemFetch(searchText);
  };

  const lookingUp = pubchem.status === 'loading' || wantsPubchem;
  const lookupLabel = pubchem.status === 'loading' ? pubchem.query : searchText;

  return (
    <div className="lib-page">
      <LibraryThemeStyles />

      {/* Zone 1 — the hero: glass tank, outlet pipes, floating compound cards */}
      <section className="lib-zone-hero">
        <div className="lib-wrap">
          <CompoundOrbitHero compounds={spotlight} />
        </div>
      </section>

      {/* Zone 2 — search, filters and the compound grid, sitting on the liquid */}
      <section className="lib-zone-solution">
        <div className="lib-wrap lib-browse" id="lib-browse">
          <div className="lib-toolbar">
            <div className="lib-search">
              <span className="lib-search-icon" aria-hidden="true">
                <Search size={17} strokeWidth={2.4} />
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder="Search by name or formula — or any molecule on PubChem"
                aria-label="Search compounds by name or formula"
              />
            </div>
            <div className="lib-chips" role="group" aria-label="Filter by category">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  aria-pressed={category === c}
                  className={`lib-chip ${category === c ? 'is-active' : ''}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="lib-loading">
              <Loader2 size={18} className="lib-spin" /> Loading compounds…
            </div>
          ) : compounds.length > 0 ? (
            <>
              {fetchedName && (
                <p className="lib-fetched" role="status">
                  <CheckCircle2 size={16} strokeWidth={2.4} />
                  <span>
                    Fetched <strong>{fetchedName}</strong> from PubChem and saved it to your library.
                  </span>
                </p>
              )}
              <div className="lib-grid">
                {compounds.map((c) => (
                  <CompoundCard key={c.id} compound={c} />
                ))}
              </div>
            </>
          ) : lookingUp ? (
            <div className="lib-lookup" role="status" aria-live="polite">
              <div className="lib-skel" aria-hidden="true">
                <span className="lib-skel-slab lib-skel-slab--2" />
                <span className="lib-skel-slab lib-skel-slab--1" />
                <span className="lib-skel-face">
                  <span className="lib-skel-bar lib-skel-bar--chip" />
                  <span className="lib-skel-bar lib-skel-bar--title" />
                  <span className="lib-skel-bar lib-skel-bar--formula" />
                  <span className="lib-skel-bar" />
                  <span className="lib-skel-bar lib-skel-bar--short" />
                </span>
              </div>
              <p className="lib-lookup-title">
                <Globe2 size={16} /> Looking up “{lookupLabel}” on PubChem…
              </p>
              <p className="lib-empty-note">
                Not in your library yet, so we’re pulling the structure, formula and properties straight from PubChem.
              </p>
            </div>
          ) : pubchem.status === 'error' ? (
            <div className="lib-empty">
              <p className="lib-empty-title">
                <AlertCircle size={16} /> {pubchem.error}
              </p>
              <button type="button" className="lib-btn lib-btn--lime" onClick={() => runPubchemFetch(pubchem.query)}>
                <RotateCcw size={16} strokeWidth={2.4} /> Try “{pubchem.query}” again
              </button>
            </div>
          ) : (
            <div className="lib-empty">
              <p className="lib-empty-title">
                {searchText ? `No compounds in your library match “${searchText}”.` : 'No compounds to show.'}
              </p>
              {searchText.length > 0 && searchText.length < PUBCHEM_MIN_CHARS && (
                <p className="lib-empty-note">Keep typing — PubChem is searched automatically from {PUBCHEM_MIN_CHARS} letters.</p>
              )}
            </div>
          )}
        </div>
      </section>

      <style>{`
        .lib-zone-hero { position: relative; }
        .lib-zone-solution { position: relative; min-height: 80vh; }
        .lib-browse { padding-top: 12px; padding-bottom: 72px; scroll-margin-top: 16px; }

        /* ---------------- search + filters ---------------- */
        .lib-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 18px 20px; margin: 4px 0 40px; }
        .lib-search { position: relative; flex: 1 1 300px; }
        .lib-search input {
          width: 100%; height: 54px; padding: 0 20px 0 62px; border-radius: 999px;
          border: 1.5px solid var(--lib-ink); background: #fff; color: var(--lib-ink);
          font: 500 15px/1 var(--lib-font-body);
          box-shadow: inset 0 3px 5px rgba(14,16,10,0.07), 0 4px 0 var(--lib-ink), 0 16px 24px -12px rgba(70,95,10,0.5);
          transition: box-shadow 0.15s ease;
          text-overflow: ellipsis;
        }
        .lib-search input::placeholder { color: var(--lib-ink-3); }
        .lib-search input:focus { outline: none; box-shadow: inset 0 3px 5px rgba(14,16,10,0.07), 0 4px 0 var(--lib-ink), 0 0 0 5px rgba(204,235,45,0.75); }
        .lib-search-icon {
          position: absolute; left: 9px; top: 50%; width: 36px; height: 36px; margin-top: -18px;
          display: grid; place-items: center; border-radius: 50%; pointer-events: none;
          background: var(--lib-lime); color: var(--lib-ink); border: 1.5px solid var(--lib-ink);
          box-shadow: 0 2px 0 var(--lib-ink);
        }
        .lib-chips { display: flex; flex-wrap: wrap; gap: 12px 10px; }
        .lib-chip {
          padding: 10px 17px; border-radius: 999px; border: 1.5px solid rgba(14,16,10,0.55);
          background: #fff; color: var(--lib-ink-2); cursor: pointer;
          font: 600 13px/1 var(--lib-font-body);
          box-shadow: 0 3px 0 rgba(14,16,10,0.55), 0 10px 14px -8px rgba(70,95,10,0.4);
          transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
        }
        .lib-chip:hover { transform: translateY(-1px); color: var(--lib-ink); box-shadow: 0 4px 0 rgba(14,16,10,0.55), 0 12px 16px -8px rgba(70,95,10,0.45); }
        .lib-chip:active { transform: translateY(2px); box-shadow: 0 1px 0 rgba(14,16,10,0.55); }
        .lib-chip.is-active { background: var(--lib-lime); color: var(--lib-ink); border-color: var(--lib-ink); box-shadow: 0 3px 0 var(--lib-ink), 0 10px 14px -8px rgba(14,16,10,0.45); }

        /* ---------------- grid + states ---------------- */
        .lib-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 40px 30px; padding: 6px 10px 0 4px; }
        @media (min-width: 640px) { .lib-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (min-width: 1024px) { .lib-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }

        .lib-fetched {
          display: flex; align-items: center; gap: 9px; margin: 0 0 30px; padding: 12px 16px; width: fit-content; max-width: 100%;
          border-radius: 14px; border: 1.5px solid var(--lib-ink); background: #f3fbc4; color: var(--lib-ink);
          font: 500 14px/1.4 var(--lib-font-body); box-shadow: 0 3px 0 var(--lib-ink);
        }
        .lib-fetched svg { flex: none; color: #4f6b00; }

        .lib-loading {
          display: flex; align-items: center; justify-content: center; gap: 10px; padding: 72px 0;
          font: 600 14px/1 var(--lib-font-body); color: var(--lib-ink-2);
        }

        .lib-empty {
          display: flex; flex-direction: column; align-items: center; padding: 48px 24px; text-align: center;
          border-radius: 28px; border: 1.5px solid var(--lib-ink); background: linear-gradient(180deg, #fff, #f4f8e8);
          box-shadow: 0 4px 0 #dbe5b9, 0 8px 0 #cfdba6, 0 12px 0 var(--lib-ink), 0 34px 44px -20px rgba(70,95,10,0.5);
        }
        .lib-empty-title { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 0 0 22px; font: 600 15px/1.4 var(--lib-font-body); color: var(--lib-ink-2); }
        .lib-empty-note { max-width: 26rem; margin: 18px 0 0; font: 400 12.5px/1.55 var(--lib-font-body); color: var(--lib-ink-3); text-align: center; }

        /* PubChem lookup in progress: a skeleton card with the same 3D slabs as a real one */
        .lib-lookup { display: flex; flex-direction: column; align-items: center; padding: 20px 0 8px; }
        .lib-skel { position: relative; width: min(360px, 100%); margin-bottom: 34px; transform: perspective(1100px) rotateX(6deg) rotateY(-9deg); }
        .lib-skel-slab { position: absolute; inset: 0; border-radius: 24px; border: 1.5px solid rgba(14,16,10,0.55); }
        .lib-skel-slab--1 { background: #c9e62c; transform: translate(4px, 6px); }
        .lib-skel-slab--2 { background: #a3c018; transform: translate(8px, 12px); }
        .lib-skel-face {
          position: relative; display: flex; flex-direction: column; gap: 14px; padding: 22px 22px 24px; border-radius: 24px;
          background: linear-gradient(160deg, #fff, #f7faee); border: 1.5px solid var(--lib-ink);
        }
        .lib-skel-bar {
          display: block; height: 12px; border-radius: 999px; background: #e6ecd2; position: relative; overflow: hidden;
        }
        .lib-skel-bar::after {
          content: ''; position: absolute; inset: 0; transform: translateX(-100%);
          background: linear-gradient(90deg, transparent, rgba(204,235,45,0.85), transparent);
          animation: lib-skel-sweep 1.4s ease-in-out infinite;
        }
        .lib-skel-bar--chip { width: 34%; height: 22px; }
        .lib-skel-bar--title { width: 62%; height: 20px; margin-top: 6px; }
        .lib-skel-bar--formula { width: 40%; height: 34px; border-radius: 12px; }
        .lib-skel-bar--short { width: 70%; }
        @keyframes lib-skel-sweep { to { transform: translateX(100%); } }
        .lib-lookup-title { display: flex; align-items: center; gap: 8px; margin: 0; font: 600 15px/1.4 var(--lib-font-body); color: var(--lib-ink); text-align: center; }

        @media (prefers-reduced-motion: reduce) {
          .lib-skel-bar::after { animation: none; }
        }
      `}</style>
    </div>
  );
}