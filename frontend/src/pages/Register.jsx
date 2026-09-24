import {
  useActionState,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useTransition,
} from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { User, Mail, Lock, ArrowRight, ArrowLeft, Check, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { extractErrorMessage } from '../api/api';
import MoleItLogo from '../components/MoleItLogo';
import {
  AuthSceneStyles,
  BondField,
  BrandWatermark,
  SubmitButton,
  usePointerParallax,
  useReducedMotionPref,
} from '../components/auth/AuthVisuals';

const STEPS = [
  {
    key: 'name',
    label: 'Name',
    title: 'What should we call you?',
    caption: 'Shown on your notes and saved structures.',
    field: { label: 'Full name', icon: User, type: 'text', autoComplete: 'name' },
    validate: (v) => (v.trim().length < 2 ? 'Please enter your name.' : null),
  },
  {
    key: 'email',
    label: 'Email',
    title: 'Where can we reach you?',
    caption: "We'll only use this to sign you in.",
    field: { label: 'Email address', icon: Mail, type: 'email', autoComplete: 'email' },
    validate: (v) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? null : 'That email address looks incomplete.',
  },
  {
    key: 'password',
    label: 'Password',
    title: 'Lock it down',
    caption: 'At least 8 characters. Mix in a number and a symbol.',
    field: { label: 'Password', icon: Lock, type: 'password', autoComplete: 'new-password' },
    validate: (v) => (v.length < 8 ? 'Use at least 8 characters.' : null),
  },
];

const initialState = {
  step: 0,
  direction: 1,
  values: { name: '', email: '', password: '' },
  errors: {},
};

function wizardReducer(state, action) {
  switch (action.type) {
    case 'change': {
      const { errors } = state;
      const nextErrors = errors[action.key] ? { ...errors, [action.key]: null } : errors;
      return {
        ...state,
        values: { ...state.values, [action.key]: action.value },
        errors: nextErrors,
      };
    }
    case 'next': {
      const current = STEPS[state.step];
      const message = current.validate(state.values[current.key]);
      if (message) {
        return { ...state, errors: { ...state.errors, [current.key]: message } };
      }
      if (state.step >= STEPS.length - 1) return state;
      return { ...state, step: state.step + 1, direction: 1 };
    }
    case 'back':
      if (state.step === 0) return state;
      return { ...state, step: state.step - 1, direction: -1 };
    case 'goto':
      if (action.step > state.step) return state;
      return { ...state, step: action.step, direction: -1 };
    case 'fail':
      return { ...state, errors: { ...state.errors, form: action.message } };
    case 'clearFormError':
      return state.errors.form ? { ...state, errors: { ...state.errors, form: null } } : state;
    default:
      return state;
  }
}

const STRENGTH_LABELS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
const STRENGTH_COLORS = [
  'rgba(38,38,38,.15)',
  'var(--color-coral)',
  'var(--color-amber)',
  '#3bbff7',
  '#1f6d49',
];

function scorePassword(pw) {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return Math.min(score, 4);
}

const panelVariants = {
  enter: (dir) => ({ opacity: 0, x: dir > 0 ? 44 : -44, filter: 'blur(6px)' }),
  center: {
    opacity: 1,
    x: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.38, ease: [0.22, 1, 0.36, 1] },
  },
  exit: (dir) => ({
    opacity: 0,
    x: dir > 0 ? -44 : 44,
    filter: 'blur(6px)',
    transition: { duration: 0.26, ease: [0.4, 0, 1, 1] },
  }),
};

export default function Register() {
  const { register } = useAuth();
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

  const [state, dispatch] = useReducer(wizardReducer, initialState);
  const [isStepping, startStepTransition] = useTransition();
  const inputRef = useRef(null);

  const step = STEPS[state.step];
  const isLast = state.step === STEPS.length - 1;
  const value = state.values[step.key];

  const deferredPassword = useDeferredValue(state.values.password);
  const strength = useMemo(() => scorePassword(deferredPassword), [deferredPassword]);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [state.step]);

  const goNext = () => startStepTransition(() => dispatch({ type: 'next' }));
  const goBack = () => startStepTransition(() => dispatch({ type: 'back' }));

  const [formState, formAction] = useActionState(
    async () => {
      const { name, email, password } = state.values;

      for (const candidate of STEPS) {
        const message = candidate.validate(state.values[candidate.key]);
        if (message) return { error: message };
      }

      try {
        await register(name.trim(), email.trim(), password);
        navigate(location.state?.from || '/', { replace: true });
        return { error: null };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Registration failed') };
      }
    },
    { error: null },
  );

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !isLast) {
      event.preventDefault();
      goNext();
    }
  };

  return (
    <div
      ref={stageRef}
      className="relative flex h-[calc(100svh-70px)] w-full items-center justify-center overflow-hidden px-4 py-3"
    >
      <div className="pointer-events-none absolute -left-24 top-1/4 h-[420px] w-[420px] rounded-full bg-[#eea02b]/12 blur-[140px]" />
      <div className="pointer-events-none absolute -right-20 bottom-0 h-[380px] w-[380px] rounded-full bg-[#3bbff7]/[0.07] blur-[140px]" />
      <BrandWatermark className="absolute left-1/2 top-4 -translate-x-1/2 opacity-70" />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(38,38,38,.08) 1px, transparent 0)',
          backgroundSize: '46px 46px',
          transform: 'translate3d(calc(var(--px, 0) * -14px), calc(var(--py, 0) * -14px), 0)',
          maskImage: 'radial-gradient(ellipse at center, black, transparent 72%)',
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-[400px]"
        style={{
          transform: 'translate3d(calc(var(--px, 0) * 6px), calc(var(--py, 0) * 5px), 0)',
        }}
      >
        <div className="register-frame pointer-events-none absolute -inset-px rounded-[20px]" />

        <div className="relative max-h-[calc(100svh-70px-1.5rem)] overflow-y-auto rounded-[20px] border border-[rgba(38,38,38,0.08)] bg-white/85 p-5 shadow-[0_28px_80px_-20px_rgba(38,38,38,.22)] backdrop-blur-2xl [scrollbar-width:none] sm:p-6 [&::-webkit-scrollbar]:hidden">
          <div className="mb-5 flex flex-col items-center text-center">
            <MoleItLogo size="sm" to="/" tone="light" />
            <h1 className="mt-4 font-display text-[20px] font-bold leading-tight text-[#262626]">
              Build your account
            </h1>
            <p className="mt-1.5 text-[13px] text-[#8a8681]">
              Three quick steps and the lab is yours.
            </p>
          </div>

          <ChainProgress
            current={state.step}
            onJump={(i) => startStepTransition(() => dispatch({ type: 'goto', step: i }))}
          />

          <form action={formAction} onKeyDown={handleKeyDown} className="mt-5" noValidate>
            <div className="relative min-h-[112px]">
              <AnimatePresence mode="wait" custom={state.direction} initial={false}>
                <motion.div
                  key={step.key}
                  custom={state.direction}
                  variants={reduceMotion ? undefined : panelVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  className="w-full"
                >
                  <p className="mb-4 font-display text-[15px] font-semibold text-[#262626]">
                    {step.title}
                  </p>

                  <BondField
                    label={step.field.label}
                    name={step.key}
                    type={step.field.type}
                    icon={step.field.icon}
                    value={value}
                    onChange={(next) => dispatch({ type: 'change', key: step.key, value: next })}
                    autoComplete={step.field.autoComplete}
                    accent="violet"
                    inputRef={inputRef}
                    error={state.errors[step.key] || null}
                    hint={state.errors[step.key] ? null : step.caption}
                  />

                  {isLast && state.values.password.length > 0 && (
                    <StrengthMeter score={strength} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            {(formState.error || state.errors.form) && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-3 flex items-start gap-2 rounded-lg border border-coral/25 bg-coral/[0.07] px-3 py-2"
              >
                <AlertCircle size={14} className="mt-0.5 shrink-0 text-coral" />
                <p className="text-xs leading-relaxed text-coral">
                  {formState.error || state.errors.form}
                </p>
              </motion.div>
            )}

            <div className="mt-4 flex items-center gap-2.5">
              {state.step > 0 && (
                <button
                  type="button"
                  onClick={goBack}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[rgba(38,38,38,0.16)] px-3.5 py-2.5 text-sm font-medium text-[#8a8681] transition-colors hover:border-[rgba(38,38,38,0.3)] hover:text-[#262626]"
                >
                  <ArrowLeft size={14} />
                  Back
                </button>
              )}

              {isLast ? (
                <SubmitButton pendingLabel="Creating account…" accent="violet" icon={Check}>
                  Create account
                </SubmitButton>
              ) : (
                <button
                  type="button"
                  onClick={goNext}
                  disabled={isStepping}
                  className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-[#eea02b] to-[#3bbff7] px-4 py-2.5 text-sm font-semibold text-[#262626] shadow-[0_0_26px_-8px_rgba(238,160,43,.5)] transition-transform duration-150 active:scale-[0.985] disabled:opacity-70"
                >
                  Continue
                  <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
                </button>
              )}
            </div>
          </form>

          <p className="mt-4 text-center text-sm text-[#8a8681]">
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-[#eea02b] hover:underline">
              Log in
            </Link>
          </p>
        </div>
      </motion.div>

      <AuthSceneStyles />

      <style>{`
        @property --frame-angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        .register-frame {
          background: conic-gradient(
            from var(--frame-angle, 0deg),
            transparent 0deg,
            #eea02b 60deg,
            #3bbff7 120deg,
            transparent 200deg,
            transparent 360deg
          );
          filter: blur(7px);
          opacity: .5;
          animation: register-frame-spin 7s linear infinite;
        }
        @keyframes register-frame-spin {
          from { --frame-angle: 0deg; }
          to { --frame-angle: 360deg; }
        }
        @media (prefers-reduced-motion: reduce) {
          .register-frame { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

function ChainProgress({ current, onJump }) {
  return (
    <div className="flex items-start justify-center">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={s.key} className="flex items-start">
            {i > 0 && (
              <span className="relative mx-2 mt-[11px] h-[2px] w-10 shrink-0 self-start overflow-hidden rounded-full bg-[rgba(38,38,38,0.12)]">
                <motion.span
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#eea02b] to-[#3bbff7]"
                  initial={false}
                  animate={{ width: i <= current ? '100%' : '0%' }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                />
              </span>
            )}

            <button
              type="button"
              onClick={() => i < current && onJump(i)}
              disabled={i >= current}
              aria-label={`Step ${i + 1}: ${s.label}`}
              aria-current={active ? 'step' : undefined}
              className={`flex flex-col items-center gap-1.5 ${i < current ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <motion.span
                initial={false}
                animate={{
                  scale: active ? 1.18 : 1,
                  boxShadow: active
                    ? '0 0 0 4px rgba(238,160,43,.16), 0 0 16px -2px rgba(238,160,43,.7)'
                    : '0 0 0 0 rgba(238,160,43,0)',
                }}
                transition={{ type: 'spring', stiffness: 320, damping: 22 }}
                className="flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold"
                style={{
                  borderColor: done || active ? 'rgba(238,160,43,.75)' : 'rgba(38,38,38,0.16)',
                  background: done
                    ? '#eea02b'
                    : active
                      ? 'rgba(238,160,43,.16)'
                      : 'transparent',
                  color: done
                    ? '#262626'
                    : active
                      ? '#c9860f'
                      : '#8a8681',
                }}
              >
                {done ? <Check size={12} strokeWidth={3} /> : i + 1}
              </motion.span>
              <span
                className="font-mono text-[9px] uppercase tracking-[0.12em] transition-colors"
                style={{ color: active ? '#262626' : '#8a8681' }}
              >
                {s.label}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function StrengthMeter({ score }) {
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-3">
      <div className="flex gap-1">
        {Array.from({ length: 4 }, (_, i) => (
          <motion.span
            key={i}
            className="h-1 flex-1 rounded-full"
            initial={false}
            animate={{ backgroundColor: i < score ? STRENGTH_COLORS[score] : 'rgba(38,38,38,.1)' }}
            transition={{ duration: 0.25, delay: i * 0.04 }}
          />
        ))}
      </div>
      <span className="mt-1.5 block text-[11px] text-[#8a8681]">
        Strength: <span style={{ color: STRENGTH_COLORS[score] }}>{STRENGTH_LABELS[score]}</span>
      </span>
    </motion.div>
  );
}