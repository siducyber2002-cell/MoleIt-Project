import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import MoleItLogo from './MoleItLogo';
import MenuCursor from './MenuCursor';
import './home/indisea.css';

// The one navigation for the whole app: a round "Menu" button that opens a
// full-screen menu. It replaces the old dark navbar on every page.
//
// The button adapts to where it sits so each page keeps its own look:
//   home     — outlined ink circle on the paper page (auto-inverts over dark areas)
//   dark     — solid dark pill, readable on the dark lab pages AND the light
//              Group Theory page
//   compact  — smaller pill that fits inside Draw Lab's slim header
const LINKS = [
  { to: '/', label: 'Home', hint: 'Back to the start' },
  { to: '/draw', label: 'Draw Lab', hint: 'Sketch molecules' },
  { to: '/library', label: 'Library', hint: '10K+ compounds' },
  { to: '/functional-groups', label: 'Groups', hint: 'Flashcard drills' },
  { to: '/reactions', label: 'Reactions', hint: 'Step-by-step mechanisms' },
  { to: '/group-theory', label: 'Group Theory', hint: 'Symmetry & point groups' },
  { to: '/quiz', label: 'Quiz', hint: 'Test yourself' },
  { to: '/news', label: 'News', hint: 'Latest research' },
  { to: '/blog', label: 'Blog', hint: 'Stories & study notes' },
  { to: '/my-molecules', label: 'My Molecules', hint: 'Your saved drawings' },
  { to: '/notes', label: 'Notes', hint: 'Save & revisit' },
];

const EASE = [0.16, 1, 0.3, 1];

function isActive(pathname, to) {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

export default function SiteMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState({ x: 0, y: 0, r: 0 });
  const burgerRef = useRef(null);
  const menuRef = useRef(null);

  const variant = pathname === '/' ? 'home' : pathname === '/draw' ? 'compact' : 'dark';

  const toggle = useCallback(() => {
    setOpen((was) => {
      if (!was && burgerRef.current) {
        const b = burgerRef.current.getBoundingClientRect();
        const x = b.right - b.height / 2;
        const y = b.top + b.height / 2;
        const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) + 12;
        setOrigin({ x, y, r });
      }
      return !was;
    });
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // any route change closes the menu
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // lock page scroll while open + close on Escape
  useEffect(() => {
    if (!open) return undefined;
    const root = document.documentElement;
    root.classList.add('ix-menu-open');

    const stop = (e) => {
      // let the menu scroll itself if its content is taller than the screen
      const menu = menuRef.current;
      if (menu && menu.scrollHeight > menu.clientHeight + 1) return;
      e.preventDefault();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const menu = menuRef.current;
    menu?.addEventListener('wheel', stop, { passive: false });
    menu?.addEventListener('touchmove', stop, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      root.classList.remove('ix-menu-open');
      menu?.removeEventListener('wheel', stop);
      menu?.removeEventListener('touchmove', stop);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : null;

  return (
    <>
      <button
        ref={burgerRef}
        type="button"
        className={`ix-burger ix-burger--${variant} ${open ? 'is-open' : ''}`}
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="ix-burger__label">{open ? 'Close' : 'Menu'}</span>
        <span className="ix-burger__circle" aria-hidden="true">
          <span className="ix-burger__bars">
            <i />
            <i />
          </span>
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            key="menu"
            className="ix-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
            data-lenis-prevent
            initial={{ clipPath: `circle(0px at ${origin.x}px ${origin.y}px)` }}
            animate={{ clipPath: `circle(${origin.r}px at ${origin.x}px ${origin.y}px)` }}
            exit={{ clipPath: `circle(0px at ${origin.x}px ${origin.y}px)` }}
            transition={{ duration: 0.7, ease: EASE }}
          >
            <div className="ix-menu__top">
              <MoleItLogo size="sm" to="/" />
            </div>

            <motion.ul
              className="ix-menu__list"
              initial="hidden"
              animate="show"
              variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04, delayChildren: 0.26 } } }}
            >
              {LINKS.map((item, i) => (
                <motion.li
                  key={item.to}
                  variants={{
                    hidden: { opacity: 0, y: 24 },
                    show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
                  }}
                >
                  <Link
                    to={item.to}
                    className="ix-menu__link"
                    onClick={close}
                    aria-current={isActive(pathname, item.to) ? 'page' : undefined}
                  >
                    <sup>{String(i + 1).padStart(2, '0')}</sup>
                    <span className="ix-menu__label">{item.label}</span>
                    <small className="ix-menu__hint">{item.hint}</small>
                  </Link>
                </motion.li>
              ))}
            </motion.ul>

            <div className="ix-menu__foot">
              <span>Developed and Designed by Siddhartha Dhar and Subhranil Manna</span>
              {user ? (
                <div className="ix-menu__auth">
                  <span className="ix-menu__who">
                    <b>{initials}</b>
                    {user.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      logout();
                      navigate('/');
                    }}
                  >
                    Log out
                  </button>
                </div>
              ) : (
                <div className="ix-menu__auth">
                  <Link to="/login" onClick={close}>
                    Log in
                  </Link>
                  <Link to="/register" onClick={close}>
                    Sign up
                  </Link>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* visible pointer above the menu (the page's own cursor sits underneath it) */}
      {open && <MenuCursor />}
    </>
  );
}