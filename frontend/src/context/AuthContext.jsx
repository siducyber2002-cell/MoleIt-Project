import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { fetchMe, loginUser, registerUser } from '../api/api';

const AuthContext = createContext(null);

// Read whatever we already know about the user, synchronously, before the
// first paint — so a hard refresh on a protected page doesn't have to sit
// on a blank spinner until the network call comes back. We still revalidate
// with the server in the background (see the effect below); this is only
// what we render *while* that's in flight.
function readCachedUser() {
  try {
    const raw = localStorage.getItem('molapp_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheUser(user) {
  if (user) localStorage.setItem('molapp_user', JSON.stringify(user));
  else localStorage.removeItem('molapp_user');
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(readCachedUser);
  // Only block rendering with the spinner when we have a token but genuinely
  // nothing cached to show yet (e.g. first-ever login redirect). If we
  // already have a cached user, skip the spinner entirely — the page renders
  // immediately with that, and the background fetchMe() below quietly
  // corrects it (or logs out) if the session turned out to be stale.
  const [loading, setLoading] = useState(() => {
    const token = localStorage.getItem('molapp_token');
    return Boolean(token) && !readCachedUser();
  });

  useEffect(() => {
    const token = localStorage.getItem('molapp_token');
    if (!token) {
      setLoading(false);
      return;
    }
    fetchMe()
      .then((freshUser) => {
        setUser(freshUser);
        cacheUser(freshUser);
      })
      .catch(() => {
        localStorage.removeItem('molapp_token');
        cacheUser(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await loginUser({ email, password });
    localStorage.setItem('molapp_token', data.access_token);
    cacheUser(data.user);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (name, email, password) => {
    const data = await registerUser({ name, email, password });
    localStorage.setItem('molapp_token', data.access_token);
    cacheUser(data.user);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('molapp_token');
    cacheUser(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}