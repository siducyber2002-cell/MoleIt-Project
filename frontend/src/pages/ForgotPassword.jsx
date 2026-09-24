import { useActionState, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Mail, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';
import { forgotPassword, extractErrorMessage } from '../api/api';
import MoleItLogo from '../components/MoleItLogo';
import {
  AuthSceneStyles,
  BondField,
  BrandWatermark,
  SubmitButton,
  usePointerParallax,
  useReducedMotionPref,
} from '../components/auth/AuthVisuals';

export default function ForgotPassword() {
  const reduceMotion = useReducedMotionPref();
  const stageRef = usePointerParallax(reduceMotion);
  const [email, setEmail] = useState('');

  const [state, formAction] = useActionState(
    async (_prev, formData) => {
      const nextEmail = String(formData.get('email') ?? '').trim();
      if (!nextEmail) return { error: 'Enter your account email.', resetPath: null, submitted: false };

      try {
        const data = await forgotPassword(nextEmail);
        const resetPath = data.reset_token ? `/reset-password?token=${data.reset_token}` : null;
        return { error: null, resetPath, submitted: true };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Something went wrong'), resetPath: null, submitted: false };
      }
    },
    { error: null, resetPath: null, submitted: false },
  );

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
              Reset your password
            </h1>
            <p className="mt-1.5 text-[13px] text-lab-500">
              Enter the email on your account and we&rsquo;ll get you a reset link.
            </p>
          </div>

          {state.submitted ? (
            <div className="space-y-4">
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-2 rounded-lg border border-phosphor/25 bg-phosphor/[0.07] px-3 py-2.5"
              >
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-phosphor" />
                <p className="text-xs leading-relaxed text-lab-200">
                  If that email is registered, a reset link has been generated below.
                </p>
              </motion.div>

              {state.resetPath && (
                <div className="rounded-lg border border-lab-700 bg-lab-900/60 p-3">
                  <p className="mb-2 text-[11px] uppercase tracking-wide text-lab-500">
                    Your reset link
                  </p>
                  <Link
                    to={state.resetPath}
                    className="flex items-center justify-between gap-2 rounded-md border border-violet/30 bg-violet/10 px-3 py-2 text-xs font-medium text-violet-200 transition-colors hover:border-violet/50"
                  >
                    <span className="truncate">Open reset link</span>
                    <ArrowRight size={13} className="shrink-0" />
                  </Link>
                  <p className="mt-2 text-[11px] leading-relaxed text-lab-600">
                    This link expires in 30 minutes.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <form action={formAction} className="space-y-3.5" noValidate>
              <BondField
                label="Email"
                name="email"
                type="email"
                icon={Mail}
                value={email}
                onChange={setEmail}
                autoComplete="email"
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

              <SubmitButton pendingLabel="Sending…" icon={ArrowRight} accent="violet">
                Send reset link
              </SubmitButton>
            </form>
          )}

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