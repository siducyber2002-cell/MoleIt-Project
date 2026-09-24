import { useActionState, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Lock, ArrowRight, AlertCircle, ShieldAlert } from 'lucide-react';
import { resetPassword, extractErrorMessage } from '../api/api';
import MoleItLogo from '../components/MoleItLogo';
import {
  AuthSceneStyles,
  BondField,
  BrandWatermark,
  SubmitButton,
  usePointerParallax,
  useReducedMotionPref,
} from '../components/auth/AuthVisuals';

export default function ResetPassword() {
  const reduceMotion = useReducedMotionPref();
  const stageRef = usePointerParallax(reduceMotion);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [state, formAction] = useActionState(
    async (_prev, formData) => {
      const nextPassword = String(formData.get('password') ?? '');
      const nextConfirm = String(formData.get('confirmPassword') ?? '');

      if (!token) return { error: 'This reset link is missing its token.' };
      if (nextPassword.length < 8) return { error: 'Use at least 8 characters.' };
      if (nextPassword !== nextConfirm) return { error: 'Passwords don\u2019t match.' };

      try {
        await resetPassword({ token, new_password: nextPassword });
        navigate('/login', { replace: true, state: { resetSuccess: true } });
        return { error: null };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Could not reset your password') };
      }
    },
    { error: null },
  );

  if (!token) {
    return (
      <div className="flex h-[calc(100svh-70px)] w-full flex-col items-center justify-center gap-3 px-4 text-center">
        <ShieldAlert size={28} className="text-lab-600" />
        <h1 className="font-display text-lg font-semibold text-lab-100">Invalid reset link</h1>
        <p className="max-w-sm text-sm text-lab-400">
          This link is missing its reset token. Request a new one from the forgot password page.
        </p>
        <Link
          to="/forgot-password"
          className="mt-2 rounded-lg bg-gradient-to-b from-phosphor to-phosphor-dim px-4 py-2 text-sm font-semibold text-lab-950 shadow-[0_2px_10px_-2px_rgba(94,234,212,0.5)] transition-all hover:brightness-110"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      className="relative flex h-[calc(100svh-70px)] w-full items-center justify-center overflow-hidden px-4 py-3"
    >
      <div className="pointer-events-none absolute -left-24 top-1/4 h-[420px] w-[420px] rounded-full bg-violet-600/12 blur-[140px]" />
      <div className="pointer-events-none absolute -right-20 bottom-0 h-[380px] w-[380px] rounded-full bg-cyan-500/[0.07] blur-[140px]" />
      <BrandWatermark className="absolute left-1/2 top-4 -translate-x-1/2 opacity-70" />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-[400px]"
      >
        <div className="relative rounded-[20px] border border-white/10 bg-lab-950/85 p-6 shadow-[0_28px_80px_-20px_rgba(0,0,0,.85)] backdrop-blur-2xl sm:p-7">
          <div className="mb-5 flex flex-col items-center text-center">
            <MoleItLogo size="sm" to="/" />
            <h1 className="mt-4 font-display text-[20px] font-bold leading-tight text-lab-100">
              Set a new password
            </h1>
            <p className="mt-1.5 text-[13px] text-lab-500">
              At least 8 characters. Make it something you&rsquo;ll remember this time.
            </p>
          </div>

          <form action={formAction} className="space-y-3.5" noValidate>
            <BondField
              label="New password"
              name="password"
              type="password"
              icon={Lock}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              accent="violet"
            />
            <BondField
              label="Confirm new password"
              name="confirmPassword"
              type="password"
              icon={Lock}
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              accent="violet"
            />

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

            <SubmitButton pendingLabel="Updating…" icon={ArrowRight} accent="violet">
              Update password
            </SubmitButton>
          </form>

          <p className="mt-5 text-center text-sm text-lab-500">
            <Link to="/login" className="font-medium text-violet-300 hover:underline">
              Back to log in
            </Link>
          </p>
        </div>
      </motion.div>

      <AuthSceneStyles />
    </div>
  );
}