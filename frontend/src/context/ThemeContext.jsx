import { createContext, useContext, useEffect, useState } from 'react';

// Single source of truth for the app's light/dark theme. Persisted to
// localStorage so it survives a refresh, and mirrored onto
// <html data-theme="..."> in case any CSS ever wants to key off it.
//
// The homepage (Home.jsx) is the page that actually redraws itself between
// the two themes; the rest of the app was built dark-only and is left as-is
// so nothing that already worked gets disturbed.
const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = window.localStorage.getItem('moleit-theme');
    return saved === 'light' || saved === 'dark' ? saved : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem('moleit-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}