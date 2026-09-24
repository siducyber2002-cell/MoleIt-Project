import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { fetchMe, loginUser, registerUser } from '../api/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('molapp_token');
    if (!token) {
      setLoading(false);
      return;
    }
    fetchMe()
      .then(setUser)
      .catch(() => localStorage.removeItem('molapp_token'))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await loginUser({ email, password });
    localStorage.setItem('molapp_token', data.access_token);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (name, email, password) => {
    const data = await registerUser({ name, email, password });
    localStorage.setItem('molapp_token', data.access_token);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('molapp_token');
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
