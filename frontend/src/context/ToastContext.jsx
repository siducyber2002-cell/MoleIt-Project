// frontend/src/context/ToastContext.jsx
//
// Error toasts for failed API calls. Every non-2xx response (and every
// network failure / timeout) shows one small card with:
//
//   - the status code               e.g. 404, 502, TIMEOUT
//   - the backend's errorCode       e.g. NOT_FOUND, UPSTREAM_ERROR
//   - the message
//   - the endpoint that failed      e.g. POST /api/compounds/fetch
//   - the request id                grep it in backend logs/app.log
//
// Rendered top-right of the screen. So you can tell at a glance WHICH api is
// failing and why. Success responses never show a toast.
//
// The card content comes straight from the backend's standard error envelope
// (see backend/app/responses.py); api/api.js builds the toast object in its
// response interceptor and emits it through lib/toastBus.js.
//
// Repeated identical failures (same endpoint + status + errorCode within a
// few seconds) collapse into one card with a x2 / x3 counter, so a polling
// request or a retry storm can't bury the screen.
//
// Opt out for a single request:   api.get(url, { skipErrorToast: true })
// Manual toast from a component:   const { pushToast } = useToast();

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, X } from 'lucide-react';
import { subscribeToasts } from '../lib/toastBus';

const ToastContext = createContext(null);

const MAX_VISIBLE = 4;
const AUTO_DISMISS_MS = 9000;
const DEDUPE_WINDOW_MS = 4000;

function toneFor(status) {
  const code = Number(status);
  // 4xx = the request was refused (amber); 5xx / network / timeout = the
  // service is failing (coral).
  if (code >= 400 && code < 500) {
    return { chip: 'bg-amber-400/15 text-amber-300 border-amber-400/40', bar: 'bg-amber-400' };
  }
  return { chip: 'bg-coral/15 text-coral border-coral/40', bar: 'bg-coral' };
}

function Toast({ toast, onClose }) {
  const [copied, setCopied] = useState(false);
  const tone = toneFor(toast.status);

  const copyDetails = async () => {
    const details = {
      status: toast.status,
      errorCode: toast.errorCode,
      message: toast.message,
      endpoint: toast.endpoint,
      request_id: toast.requestId,
      timestamp: toast.timestamp,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(details, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (insecure context / permissions) — nothing useful to do
    }
  };

  return (
    <motion.div
      layout
      role="alert"
      className="pointer-events-auto relative overflow-hidden rounded-xl border border-lab-700 bg-lab-900/95 py-3 pl-4 pr-3 text-left shadow-[0_18px_50px_-15px_rgba(0,0,0,0.7)] backdrop-blur"
      initial={{ opacity: 0, x: 40, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} />

      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-semibold ${tone.chip}`}>
            {toast.status}
          </span>
          <span className="font-mono text-[11px] font-medium tracking-wide text-lab-300">{toast.errorCode}</span>
          {toast.count > 1 && (
            <span className="rounded-full bg-lab-700 px-1.5 py-0.5 font-mono text-[10px] text-lab-100">
              ×{toast.count}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={copyDetails}
          aria-label="Copy error details"
          title="Copy error details"
          className="rounded-md p-1 text-lab-400 transition-colors hover:bg-lab-700 hover:text-lab-100"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          type="button"
          onClick={() => onClose(toast.id)}
          aria-label="Dismiss"
          className="rounded-md p-1 text-lab-400 transition-colors hover:bg-lab-700 hover:text-lab-100"
        >
          <X size={14} />
        </button>
      </div>

      <p className="mt-1.5 pr-1 text-sm leading-snug text-lab-100">{toast.message}</p>

      <p className="mt-1.5 break-all font-mono text-[11px] text-phosphor-dim">{toast.endpoint}</p>
      {toast.requestId && (
        <p className="mt-0.5 font-mono text-[10px] text-lab-500">request_id: {toast.requestId}</p>
      )}
    </motion.div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const lastSeen = useRef(new Map()); // dedupe key -> { id, at }

  const dismissToast = useCallback((id) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const scheduleDismiss = useCallback(
    (id) => {
      const existing = timers.current.get(id);
      if (existing) window.clearTimeout(existing);
      timers.current.set(id, window.setTimeout(() => dismissToast(id), AUTO_DISMISS_MS));
    },
    [dismissToast]
  );

  const pushToast = useCallback(
    (incoming) => {
      const key = `${incoming.endpoint}|${incoming.status}|${incoming.errorCode}`;
      const now = Date.now();
      const seen = lastSeen.current.get(key);

      // Same failure again within the window: bump the counter on the card
      // that's already showing instead of stacking another one.
      if (seen && now - seen.at < DEDUPE_WINDOW_MS) {
        seen.at = now;
        setToasts((prev) => prev.map((t) => (t.id === seen.id ? { ...t, count: t.count + 1 } : t)));
        scheduleDismiss(seen.id);
        return;
      }

      const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      lastSeen.current.set(key, { id, at: now });
      setToasts((prev) => [...prev, { ...incoming, id, count: 1 }].slice(-MAX_VISIBLE));
      scheduleDismiss(id);
    },
    [scheduleDismiss]
  );

  // Listen for toasts emitted by the axios interceptor (lib/toastBus.js).
  useEffect(() => subscribeToasts(pushToast), [pushToast]);

  // Clear any pending timers on unmount.
  useEffect(() => {
    const active = timers.current;
    return () => active.forEach((t) => window.clearTimeout(t));
  }, []);

  // The site's custom cursor dot hides the native pointer, which would make
  // the copy / dismiss buttons awkward to hit. Same fix StatusOverlayContext
  // uses: restore the native cursor while any toast is on screen.
  useEffect(() => {
    if (toasts.length === 0) return undefined;
    document.documentElement.classList.add('ix-native-cursor');
    return () => document.documentElement.classList.remove('ix-native-cursor');
  }, [toasts.length]);

  return (
    <ToastContext.Provider value={{ pushToast, dismissToast }}>
      {children}
      <div
        aria-live="assertive"
        className="pointer-events-none fixed top-4 right-4 z-[600] flex w-[min(92vw,380px)] flex-col gap-2"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <Toast key={t.id} toast={t} onClose={dismissToast} />
          ))}
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