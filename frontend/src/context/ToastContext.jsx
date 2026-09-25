// frontend/src/context/ToastContext.jsx
//
// Tiny global toast system. Sits above <Routes> in App.jsx so a toast
// fired right before navigate() (e.g. "Login successful" fired on the
// Login page just before redirecting to "/") survives the route change
// and is still shown to the user once they land on the destination page.
//
// Usage:
//   const { showToast } = useToast();
//   showToast('Login successful', 'success');

import { createContext, useCallback, useContext, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, XCircle, Info } from 'lucide-react';

const ToastContext = createContext(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const ACCENTS = {
  success: { border: 'border-phosphor/40', bg: 'bg-lab-900/95', icon: 'text-phosphor' },
  error: { border: 'border-coral/40', bg: 'bg-lab-900/95', icon: 'text-coral' },
  info: { border: 'border-sky-400/40', bg: 'bg-lab-900/95', icon: 'text-sky-300' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message, type = 'success', duration = 2600) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
    return id;
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}

      {/* Fixed, centered near the top on every screen size — clear of the
          70px TopBar and safe-area insets so it never sits under a phone's
          status bar / notch. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top,0px)+84px)] sm:pt-[calc(env(safe-area-inset-top,0px)+20px)]"
      >
        <AnimatePresence>
          {toasts.map((t) => {
            const Icon = ICONS[t.type] || CheckCircle2;
            const accent = ACCENTS[t.type] || ACCENTS.success;
            return (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: -16, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.96, transition: { duration: 0.2 } }}
                transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                onClick={() => dismissToast(t.id)}
                className={`pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-full border ${accent.border} ${accent.bg} px-4 py-2.5 text-sm font-medium text-lab-100 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)] backdrop-blur-md`}
              >
                <Icon size={16} className={`shrink-0 ${accent.icon}`} />
                <span>{t.message}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}