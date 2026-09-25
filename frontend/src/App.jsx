import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { FlaskConical } from 'lucide-react';
import { AuthProvider } from './context/AuthContext';
import { StatusOverlayProvider } from './context/StatusOverlayContext';
import SiteMenu from './components/SiteMenu';
import MoleItLogo from './components/MoleItLogo';
import ProtectedRoute from './components/ProtectedRoute';
import SmoothScroll from './components/motion/SmoothScroll';
import Home from './pages/Home';
import DrawLabPage from './pages/DrawLabPage';
import LibraryPage from './pages/LibraryPage';
import CompoundDetailPage from './pages/CompoundDetailPage';
import FunctionalGroupsPage from './pages/FunctionalGroupsPage';
import ReactionsPage from './pages/ReactionsPage';
import GroupTheoryPage from './pages/GroupTheoryPage';
import NotesPage from './pages/NotesPage';
import MyMoleculesPage from './pages/MyMoleculesPage';
import QuizPage from './pages/QuizPage';
import NewsPage from './pages/NewsPage';
import BlogPage from './pages/BlogPage';
import BlogPostPage from './pages/BlogPostPage';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <FlaskConical size={32} className="text-lab-600" />
      <h1 className="font-display text-lg font-semibold text-lab-100">Nothing here</h1>
      <p className="max-w-sm text-sm text-lab-400">
        That page doesn't exist — it may have moved, or the link was mistyped.
      </p>
      <Link
        to="/"
        className="mt-2 rounded-lg bg-gradient-to-b from-phosphor to-phosphor-dim px-4 py-2 text-sm font-semibold text-lab-950 shadow-[0_2px_10px_-2px_rgba(94,234,212,0.5)] transition-all hover:brightness-110"
      >
        Back to Home
      </Link>
    </div>
  );
}

// Slim strip at the top of every inner page: just the brand mark, so there's
// always a way home. All navigation lives in the round "Menu" button
// (SiteMenu). It's 70px tall on purpose — the login / register / reset pages
// size themselves as 100svh minus 70px.
//
// The logo always sits directly on the page background now — no pill/slab
// behind it — same treatment on every inner page as on Login/Register.
// Only the tone flips: "light" (charcoal wordmark) on light-canvas pages,
// "dark" (near-white wordmark) everywhere else on the app's dark theme.
// FunctionalGroupsPage and GroupTheoryPage are both light-canvas pages
// (see fg-light-scroll / gt-light-scroll) but weren't in this list, so the
// near-white "dark" wordmark was rendering on their near-white background —
// invisible. Keep this list in sync with any future light-canvas page.
const LIGHT_CANVAS_PATHS = ['/login', '/register', '/functional-groups', '/group-theory'];

function TopBar() {
  const location = useLocation();
  const isLightCanvas = LIGHT_CANVAS_PATHS.includes(location.pathname);

  return (
    <div className="mx-3 flex h-[70px] items-center sm:mx-4">
      <div className="mx-auto w-full max-w-7xl">
        <MoleItLogo size="sm" to="/" tone={isLightCanvas ? 'light' : 'dark'} />
      </div>
    </div>
  );
}

function AppShell() {
  const location = useLocation();
  const isDrawLab = location.pathname === '/draw';
  // The homepage draws its own layout (logo lockup in the hero) and Draw Lab
  // runs full-screen with its own slim header — neither gets the top strip.
  const isHome = location.pathname === '/';

  return (
    <div className="min-h-screen text-lab-100">
      <SiteMenu />
      {!isDrawLab && !isHome && <TopBar />}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route path="/draw" element={<ProtectedRoute><DrawLabPage /></ProtectedRoute>} />
        <Route path="/library" element={<ProtectedRoute><LibraryPage /></ProtectedRoute>} />
        <Route path="/library/:id" element={<ProtectedRoute><CompoundDetailPage /></ProtectedRoute>} />
        <Route path="/functional-groups" element={<ProtectedRoute><FunctionalGroupsPage /></ProtectedRoute>} />
        <Route path="/reactions" element={<ProtectedRoute><ReactionsPage /></ProtectedRoute>} />
        <Route path="/group-theory" element={<ProtectedRoute><GroupTheoryPage /></ProtectedRoute>} />
        <Route path="/quiz" element={<ProtectedRoute><QuizPage /></ProtectedRoute>} />
        <Route path="/news" element={<ProtectedRoute><NewsPage /></ProtectedRoute>} />
        <Route path="/blog" element={<ProtectedRoute><BlogPage /></ProtectedRoute>} />
        <Route path="/blog/:id" element={<ProtectedRoute><BlogPostPage /></ProtectedRoute>} />
        <Route path="/notes" element={<ProtectedRoute><NotesPage /></ProtectedRoute>} />
        <Route path="/my-molecules" element={<ProtectedRoute><MyMoleculesPage /></ProtectedRoute>} />

        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <StatusOverlayProvider>
          <SmoothScroll>
            <AppShell />
          </SmoothScroll>
        </StatusOverlayProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}