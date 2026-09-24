import { useActionState, useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Mail, Lock, ArrowRight, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { extractErrorMessage } from '../api/api';
import MoleItLogo from '../components/MoleItLogo';
import {
  AuthSceneStyles,
  BondField,
  BrandWatermark,
  MoleculeScene,
  SubmitButton,
  usePointerParallax,
  useReducedMotionPref,
} from '../components/auth/AuthVisuals';

const sceneVariants = {
  hidden: { opacity: 0, scale: 0.92 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.8, ease: [0.22, 1, 0.36, 1] } },
};

const formVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07, delayChildren: 0.1 } },
};

const rowVariants = {
  hidden: { opacity: 0, y: 16, filter: 'blur(4px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
  },
};

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const reduceMotion = useReducedMotionPref();
  const stageRef = usePointerParallax(reduceMotion);

  // Flag <html> as "light homepage" for as long as this page is mounted —
  // same warm-paper canvas the homepage uses, swapped in for the old dark
  // pitch background.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-indisea');
    return () => root.classList.remove('theme-indisea');
  }, []);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [state, formAction] = useActionState(
    async (_prev, formData) => {
      const nextEmail = String(formData.get('email') ?? '').trim();
      const nextPassword = String(formData.get('password') ?? '');

      if (!nextEmail || !nextPassword) {
        return { error: 'Enter both your email and password.' };
      }

      try {
        await login(nextEmail, nextPassword);
        navigate(location.state?.from || '/', { replace: true });
        return { error: null };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Login failed') };
      }
    },
    { error: null },
  );

  return (
    <div className="relative flex h-[calc(100svh-70px)] w-full overflow-hidden">
      {/* ---------------- Left: brand scene ---------------- */}
      <motion.div
        ref={stageRef}
        variants={sceneVariants}
        initial="hidden"
        animate="show"
        className="relative hidden w-[52%] shrink-0 items-center justify-center overflow-hidden border-r border-[rgba(38,38,38,0.08)] lg:flex"
      >
        <div className="pointer-events-none absolute -left-28 -top-24 h-[460px] w-[460px] rounded-full bg-[#3bbff7]/10 blur-[130px]" />
        <div className="pointer-events-none absolute -bottom-32 -right-16 h-[420px] w-[420px] rounded-full bg-[#eea02b]/12 blur-[130px]" />

        <BrandWatermark className="absolute left-1/2 top-[14%] -translate-x-1/2" />

        <div className="relative z-10 flex w-full flex-col items-center">
          <MoleculeScene />

          <div className="mt-8 max-w-sm px-10 text-center">
            <h2 className="font-display text-[22px] font-bold leading-snug text-[#262626]">
              Pick up right where you left off
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#4e4e4d]">
              Saved structures, spectra, notes and quiz streaks — all still
              sitting exactly where you left them.
            </p>
          </div>
        </div>
      </motion.div>

      {/* ---------------- Right: form ---------------- */}
      <div className="relative flex w-full flex-1 items-center justify-center overflow-y-auto px-5 py-6 sm:px-10">
        <div className="pointer-events-none absolute right-0 top-1/3 h-[300px] w-[300px] rounded-full bg-[#eea02b]/[0.07] blur-[120px] lg:hidden" />

        <motion.div
          variants={formVariants}
          initial="hidden"
          animate="show"
          className="relative w-full max-w-[370px]"
        >
          <motion.div variants={rowVariants} className="mb-9">
            <MoleItLogo size="sm" to="/" tone="light" className="mb-7" />
            <h1 className="font-display text-[28px] font-bold leading-tight text-[#262626]">
              Welcome back
            </h1>
            <p className="mt-1.5 text-sm text-[#8a8681]">
              Log in to keep building your molecule library.
            </p>
          </motion.div>

          <form action={formAction} className="space-y-3.5" noValidate>
            <motion.div variants={rowVariants}>
              <BondField
                label="Email"
                name="email"
                type="email"
                icon={Mail}
                value={email}
                onChange={setEmail}
                autoComplete="email"
                accent="phosphor"
              />
            </motion.div>

            <motion.div variants={rowVariants}>
              <BondField
                label="Password"
                name="password"
                type="password"
                icon={Lock}
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                accent="phosphor"
              />
            </motion.div>

            <motion.div variants={rowVariants} className="flex justify-end">
              <Link
                to="/forgot-password"
                className="text-xs font-medium text-[#8a8681] transition-colors hover:text-[#3bbff7]"
              >
                Forgot password?
              </Link>
            </motion.div>

            {state.error && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-2 rounded-lg border border-coral/25 bg-coral/[0.07] px-3 py-2"
              >
                <AlertCircle size={14} className="mt-0.5 shrink-0 text-coral" />
                <p className="text-xs leading-relaxed text-coral">{state.error}</p>
              </motion.div>
            )}

            <motion.div variants={rowVariants} className="pt-1.5">
              <SubmitButton pendingLabel="Logging in…" icon={ArrowRight} accent="phosphor">
                Log in
              </SubmitButton>
            </motion.div>
          </form>

          <motion.div variants={rowVariants} className="mt-7">
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-[rgba(38,38,38,0.12)]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8a8681]">
                new here
              </span>
              <span className="h-px flex-1 bg-[rgba(38,38,38,0.12)]" />
            </div>
            <Link
              to="/register"
              className="group mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-[rgba(38,38,38,0.14)] bg-white/60 px-4 py-2.5 text-sm font-medium text-[#4e4e4d] transition-colors hover:border-[#3bbff7]/50 hover:text-[#262626]"
            >
              Create an account
              <ArrowRight size={14} className="text-[#8a8681] transition-transform group-hover:translate-x-0.5" />
            </Link>
          </motion.div>
        </motion.div>
      </div>

      <AuthSceneStyles />
    </div>
  );
}