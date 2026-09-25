// frontend/src/components/LogoutConfirmDialog.jsx
//
// Big, centered "are you sure?" dialog for logging out — replaces the old
// instant logout. Sits above SiteMenu (which itself is z-index up to ~300),
// dead center of the viewport on every screen size.
//
// Styled to match the homepage's light "paper" theme (see AuthVisuals /
// Login.jsx) rather than the app's dark lab theme, since this dialog can
// pop up over any page, including the light ones.

import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { TriangleAlert } from 'lucide-react';

export default function LogoutConfirmDialog({ open, onCancel, onConfirm }) {
  // This dialog renders above the site's custom cursor dot (see
  // indisea.css), which would otherwise leave the pointer invisible while
  // it's open — restore the native cursor for as long as it's up.
  useEffect(() => {
    if (!open) return undefined;
    document.documentElement.classList.add('ix-native-cursor');
    return () => document.documentElement.classList.remove('ix-native-cursor');
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[400] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.2 } }}
          onClick={onCancel}
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
            className="w-full max-w-[320px] rounded-3xl border border-[rgba(38,38,38,0.10)] bg-[#f8f6f3]/95 px-8 py-8 text-center shadow-[0_30px_80px_-20px_rgba(38,38,38,0.35)]"
            initial={{ opacity: 0, scale: 0.85, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: -8, transition: { duration: 0.2 } }}
            transition={{ type: 'spring', stiffness: 340, damping: 24 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto flex h-[72px] w-[72px] items-center justify-center rounded-full border-2 border-[#eea02b]/60 shadow-[0_0_0_10px_rgba(238,160,43,0.10)]">
              <TriangleAlert size={30} strokeWidth={2.25} className="text-[#eea02b]" />
            </div>

            <h2 id="logout-confirm-title" className="mt-4 font-display text-xl font-bold text-[#262626]">
              Logout Confirmation
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-[#8a8681]">
              Are you sure you want to logout?
            </p>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 rounded-xl bg-[#3bbff7] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_20px_-6px_rgba(59,191,247,0.5)] transition-transform hover:brightness-105 active:scale-[0.97]"
              >
                No, Stay
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="flex-1 rounded-xl bg-coral px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_20px_-6px_rgba(251,113,133,0.5)] transition-transform hover:brightness-105 active:scale-[0.97]"
              >
                Yes, Logout!
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}