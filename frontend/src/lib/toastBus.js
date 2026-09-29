// frontend/src/lib/toastBus.js
//
// Tiny publish/subscribe channel between non-React code (the axios response
// interceptor in api/api.js) and the React <ToastProvider> that renders the
// toasts (context/ToastContext.jsx). The interceptor can't call a hook, so it
// emits here and the provider listens.

const listeners = new Set();

export function subscribeToasts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitToast(toast) {
  listeners.forEach((listener) => {
    try {
      listener(toast);
    } catch {
      // a broken listener must never break the request that triggered it
    }
  });
}