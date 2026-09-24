import { useEffect } from 'react';

// ---------------------------------------------------------------------------
// Shared light "lime + ink" theme for the Library page AND the compound detail
// page. Used two ways:
//
//   useLibraryTheme()      — call once at the top of a page. While that page is
//                            mounted it flags <html> with `lib-light` and loads
//                            the typefaces. Undone on unmount.
//   <LibraryThemeStyles /> — render once inside the page. Holds the tokens
//                            (scoped to `.lib-page`) and the <html>-level
//                            rules (scoped to `html.lib-light`), so nothing
//                            leaks to the rest of the app.
// ---------------------------------------------------------------------------

const FONTS_ID = 'moleit-lib-fonts';
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap';

export function useLibraryTheme() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('lib-light');
    if (!document.getElementById(FONTS_ID)) {
      const link = document.createElement('link');
      link.id = FONTS_ID;
      link.rel = 'stylesheet';
      link.href = FONTS_HREF;
      document.head.appendChild(link);
    }
    return () => root.classList.remove('lib-light');
  }, []);
}

export function LibraryThemeStyles() {
  // React 19 hoists this into <head> once and de-duplicates it by `href`.
  return (
    <style href="moleit-lib-theme" precedence="medium">
      {THEME_CSS}
    </style>
  );
}

const THEME_CSS = `
/* ---------------------------------------------------------------
   Light canvas while a Library page is open.
   <html> carries the paper colour; <body> is made transparent so the
   fixed flood (z-index -10) can show above the canvas and beneath the
   content. Removed together with the class on unmount.
   --------------------------------------------------------------- */
html.lib-light {
  background:
    radial-gradient(ellipse 900px 600px at 6% 0%, rgba(204,235,45,0.20), transparent 62%),
    radial-gradient(ellipse 800px 600px at 96% 8%, rgba(111,214,166,0.16), transparent 62%),
    #f4f6ec !important;
  background-attachment: fixed !important;
}
html.lib-light body { background: transparent !important; color: #0e100a; }
html.lib-light ::selection { background: #ccEb2d; color: #0e100a; }

/* The strip at the top of inner pages: wordmark was near-white for the dark theme */
html.lib-light .moleit-logo--dark .text-lab-100 { color: #0e100a; }
html.lib-light .moleit-logo--dark .moleit-logo-shimmer {
  background-image: linear-gradient(100deg, #0891b2 0%, #7c3aed 50%, #0891b2 100%);
  background-size: 200% 100%;
}

/* The round "Menu" button: lime pill with an ink edge, like the reference's "Join us" */
html.lib-light .ix-burger--dark:not(.is-open) {
  background: #ccEb2d;
  color: #0e100a;
  border: 1.5px solid #0e100a;
  box-shadow: 0 4px 0 #0e100a, 0 14px 22px -8px rgba(14,16,10,0.4);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
html.lib-light .ix-burger--dark:not(.is-open):hover { border-color: #0e100a; transform: translateY(-1px); }
html.lib-light .ix-burger--dark:not(.is-open):active { transform: translateY(3px); box-shadow: 0 1px 0 #0e100a; }

/* ---------------- tokens ---------------- */
.lib-page {
  --lib-ink: #0e100a;
  --lib-ink-2: #454a3b;
  --lib-ink-3: #7b816c;
  --lib-lime: #ccEb2d;
  --lib-font-display: 'Space Grotesk', 'Segoe UI', system-ui, sans-serif;
  --lib-font-body: 'Inter', 'Segoe UI', system-ui, sans-serif;
  width: 100%;
  overflow-x: clip;
  color: var(--lib-ink);
  font-family: var(--lib-font-body);
  -webkit-font-smoothing: antialiased;
}
.lib-page a:focus-visible,
.lib-page button:focus-visible,
.lib-page input:focus-visible {
  outline: 3px solid var(--lib-ink);
  outline-offset: 3px;
}
.lib-wrap { width: 100%; max-width: 80rem; margin: 0 auto; padding: 0 1rem; }

/* ---------------- buttons ---------------- */
.lib-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 48px; padding: 0 22px; border-radius: 14px; border: 1.5px solid var(--lib-ink);
  font: 600 15px/1 var(--lib-font-body); text-decoration: none; cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.lib-btn--lime { background: var(--lib-lime); color: var(--lib-ink); box-shadow: 0 4px 0 var(--lib-ink), 0 14px 22px -8px rgba(14,16,10,0.4); }
.lib-btn--white { background: #fff; color: var(--lib-ink); box-shadow: 0 4px 0 var(--lib-ink), 0 14px 22px -8px rgba(14,16,10,0.3); }
.lib-btn--ink { background: var(--lib-ink); color: #fff; box-shadow: 0 4px 0 #3b4029, 0 14px 22px -8px rgba(14,16,10,0.4); }
.lib-btn:hover { transform: translateY(-1px); }
.lib-btn:active { transform: translateY(3px); box-shadow: 0 1px 0 var(--lib-ink); }
.lib-btn:disabled { opacity: 0.65; cursor: progress; transform: none; }

.lib-spin { animation: lib-spin 0.9s linear infinite; }
@keyframes lib-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .lib-spin { animation: none; } }
`;