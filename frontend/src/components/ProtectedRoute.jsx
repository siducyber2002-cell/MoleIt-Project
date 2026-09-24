import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Gates any route that needs a logged-in user. The homepage stays public
// (it's never wrapped in this), but every navbar destination — Draw Lab,
// Library, Quiz, Notes, etc. — is. While AuthContext is still resolving
// the stored token we show a small spinner instead of bouncing to /login,
// so a refresh on a protected page doesn't flash the login screen for a
// user who's actually already signed in.
export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-lab-700 border-t-phosphor" />
      </div>
    );
  }

  if (!user) {
    // Remember where they were headed so Login can send them back after
    // they sign in, instead of always dropping them on /draw.
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return children;
}