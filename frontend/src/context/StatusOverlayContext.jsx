// frontend/src/context/StatusOverlayContext.jsx
//
// Big, centered, self-dismissing status popup — for moments that deserve
// more than a small toast pill (logging in, logging out). Sits above
// <Routes> in App.jsx, same trick as ToastContext: firing it right before
// navigate() means it survives the route change and keeps playing out on
// whatever page the user lands on.
//
// Styled to match the homepage's light "paper" theme (see AuthVisuals /
// Login.jsx) rather than the app's dark lab theme, since this can pop up
// over any page, including the light ones.
//
// Usage:
//   const { showStatus } = useStatusOverlay();
//   showStatus({ type: 'success', title: 'Logged Out!', subtitle: 'You have been securely logged out.' });

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, X } from 'lucide-react';

const StatusOverlayContext = createContext(null);

const ACCENTS = {
  success: {
    ring: 'border-[#22c55e]/50',
    glow: 'shadow-[0_0_0_10px_rgba(34,197,94,0.10)]',
    icon: 'text-[#22c55e]',
    Icon: Check,
  },
  error: {
    ring: 'border-coral/60',
    glow: 'shadow-[0_0_0_10px_rgba(251,113,133,0.10)]',
    icon: 'text-coral',
    Icon: X,
  },
};

// Small decorative sparks scattered around the icon ring — only shown for
// "celebratory" moments (logging in) so it doesn't feel identical to the
// plainer logged-out confirmation.
const SPARKS = [
  { x: -46, y: -40, r: 0, delay: 0.15 },
  { x: 48, y: -34, r: 20, delay: 0.22 },
  { x: -52, y: 18, r: -15, delay: 0.3 },
  { x: 50, y: 26, r: 10, delay: 0.18 },
  { x: 0, y: -58, r: 0, delay: 0.26 },
];

export function StatusOverlayProvider({ children }) {
  const [status, setStatus] = useState(null);
  const timerRef = useRef(null);

  // This overlay renders above the site's custom cursor dot (see
  // indisea.css), which would otherwise leave the pointer invisible while
  // it's showing — restore the native cursor for as long as it's up.
  useEffect(() => {
    if (!status) return undefined;
    document.documentElement.classList.add('ix-native-cursor');
    return () => document.documentElement.classList.remove('ix-native-cursor');
  }, [status]);

  const dismissStatus = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setStatus(null);
  }, []);

  const showStatus = useCallback(({ type = 'success', title, subtitle, duration = 1900, sparkle }) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setStatus({ id, type, title, subtitle, sparkle: sparkle ?? type === 'success' });
    timerRef.current = window.setTimeout(() => {
      setStatus((prev) => (prev?.id === id ? null : prev));
    }, duration);
    return id;
  }, []);

  const accent = ACCENTS[status?.type] || ACCENTS.success;
  const Icon = accent.Icon;

  return (
    <StatusOverlayContext.Provider value={{ showStatus, dismissStatus }}>
      {children}

      <AnimatePresence>
        {status && (
          <motion.div
            key="status-overlay-backdrop"
            className="fixed inset-0 z-[500] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            onClick={dismissStatus}
          >
            <motion.div
              key={status.id}
              role="status"
              aria-live="assertive"
              className="relative flex w-full max-w-[300px] flex-col items-center gap-4 rounded-3xl border border-[rgba(38,38,38,0.10)] bg-[#f8f6f3]/95 px-8 py-9 text-center shadow-[0_30px_80px_-20px_rgba(38,38,38,0.35)]"
              initial={{ opacity: 0, scale: 0.85, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: -8, transition: { duration: 0.2 } }}
              transition={{ type: 'spring', stiffness: 340, damping: 24 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={`relative flex h-[72px] w-[72px] items-center justify-center rounded-full border-2 ${accent.ring} ${accent.glow}`}>
                <motion.div
                  initial={{ scale: 0, rotate: -20 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.08, type: 'spring', stiffness: 400, damping: 16 }}
                >
                  <Icon size={32} strokeWidth={2.5} className={accent.icon} />
                </motion.div>

                {status.sparkle &&
                  SPARKS.map((s, i) => (
                    <motion.span
                      key={i}
                      className={`absolute h-2 w-2 rounded-full ${accent.icon} opacity-70`}
                      style={{ left: '50%', top: '50%' }}
                      initial={{ opacity: 0, x: 0, y: 0, scale: 0.3 }}
                      animate={{ opacity: [0, 1, 0], x: s.x, y: s.y, scale: 1, rotate: s.r }}
                      transition={{ duration: 0.9, delay: s.delay, ease: 'easeOut' }}
                    />
                  ))}
              </div>

              <div>
                <h2 className="font-display text-xl font-bold text-[#262626]">{status.title}</h2>
                {status.subtitle && (
                  <p className="mt-1.5 text-sm leading-relaxed text-[#8a8681]">{status.subtitle}</p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </StatusOverlayContext.Provider>
  );
}

export function useStatusOverlay() {
  const ctx = useContext(StatusOverlayContext);
  if (!ctx) throw new Error('useStatusOverlay must be used within StatusOverlayProvider');
  return ctx;
}