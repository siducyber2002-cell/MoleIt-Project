import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Brain, CheckCircle2, XCircle, RotateCcw, Trophy, Loader2,
  FlaskConical, Shapes, Atom, Flame, Zap, Clock, Share2, Sparkles,
  ChevronRight, Timer as TimerIcon, Target,
} from 'lucide-react';
import { fetchQuizQuestionsCount, fetchQuizQuestions, fetchQuizHistory, submitQuizAttempt } from '../api/api';
import { useAuth } from '../context/AuthContext';
import ThreeMoleculeViewer from '../components/Viewer3D/ThreeMoleculeViewer';
import MiniStructurePreview from '../components/FunctionalGroups/MiniStructurePreview';
import ThreeStructurePreview from '../components/Viewer3D/ThreeStructurePreview';
import { Reveal, EASE } from '../components/motion/ScrollReveal';

const CATEGORIES = [
  { id: 'all', label: 'Mixed', icon: Brain, blurb: 'A bit of everything' },
  { id: 'compounds', label: 'Compounds', icon: FlaskConical, blurb: 'Names, formulas, SMILES' },
  { id: 'groups', label: 'Functional Groups', icon: Shapes, blurb: 'Reactivity & structure' },
  { id: 'elements', label: 'Elements', icon: Atom, blurb: 'Periodic table data' },
];

const DIFFICULTIES = [
  { id: 'all', label: 'All', copy: 'A mix of every difficulty level.' },
  { id: 'easy', label: 'Easy', copy: 'Recall-level: symbols, names, categories, straightforward counts.' },
  { id: 'normal', label: 'Normal', copy: 'Applied: formulas, molar mass, bond orders, functional groups, formal charge.' },
  { id: 'hard', label: 'Hard', copy: 'Structural reasoning: 2D/SMILES recognition, hybridization, IUPAC naming, degree of unsaturation, NMR signal counts.' },
];

const COUNTS = [5, 10, 15];

const MONO_TYPES = new Set([
  'compoundFormula', 'compoundName', 'compoundSmiles', 'hybridization', 'formalCharge', 'elementSymbol',
  'atomicNumber', 'atomicMass',
]);

const QUESTION_SECONDS = 20;
const TIMEOUT_TOKEN = '__timeout__';

export default function QuizPage() {
  const { user } = useAuth();
  const [phase, setPhase] = useState('setup');
  const [poolLoading, setPoolLoading] = useState(true);
  const [poolError, setPoolError] = useState(false);
  const [totalAvailable, setTotalAvailable] = useState(0);
  const [available, setAvailable] = useState(0);
  const [startingQuiz, setStartingQuiz] = useState(false);
  const [startError, setStartError] = useState(false);

  const [category, setCategory] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [count, setCount] = useState(5);

  const [questions, setQuestions] = useState([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);

  // Gamification state
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [points, setPoints] = useState(0);
  const [lastAward, setLastAward] = useState(null); // { id, amount, ok }
  const [startedAt, setStartedAt] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [savingResult, setSavingResult] = useState(false);
  const [resultSaveError, setResultSaveError] = useState(false);

  useEffect(() => {
    setPoolLoading(true);
    fetchQuizQuestionsCount({ category: 'all', difficulty: 'all' })
      .then(setTotalAvailable)
      .catch(() => setPoolError(true))
      .finally(() => setPoolLoading(false));
  }, []);

  // Re-check how many questions match the current filters every time the
  // user changes category/difficulty on the setup screen.
  useEffect(() => {
    let cancelled = false;
    fetchQuizQuestionsCount({ category, difficulty })
      .then((n) => {
        if (!cancelled) setAvailable(n);
      })
      .catch(() => {
        if (!cancelled) setAvailable(0);
      });
    return () => {
      cancelled = true;
    };
  }, [category, difficulty]);

  const loadHistory = useCallback(() => {
    if (!user) return;
    fetchQuizHistory()
      .then(setHistory)
      .finally(() => setHistoryLoaded(true));
  }, [user]);

  useEffect(() => {
    if (user && !historyLoaded) loadHistory();
  }, [user, historyLoaded, loadHistory]);

  const bestPastScorePct = useMemo(() => {
    if (!history.length) return null;
    return Math.max(...history.map((h) => Math.round((h.score / h.total) * 100)));
  }, [history]);

  const startQuiz = async () => {
    setStartingQuiz(true);
    setStartError(false);
    try {
      const picked = await fetchQuizQuestions({ category, difficulty, limit: count });
      setQuestions(picked);
      setIndex(0);
      setSelected(null);
      setScore(0);
      setStreak(0);
      setBestStreak(0);
      setPoints(0);
      setLastAward(null);
      setResultSaveError(false);
      setStartedAt(Date.now());
      setPhase('active');
    } catch {
      setStartError(true);
    } finally {
      setStartingQuiz(false);
    }
  };

  const handleAnswer = (option, timeLeft = 0) => {
    if (selected) return;
    setSelected(option);

    const correct = option === questions[index].answer;
    if (correct) {
      const streakBonus = Math.min(streak, 8) * 10;
      const speedBonus = Math.round(timeLeft * 4);
      const gained = 100 + streakBonus + speedBonus;
      setScore((s) => s + 1);
      setPoints((p) => p + gained);
      setStreak((s) => {
        const next = s + 1;
        setBestStreak((b) => Math.max(b, next));
        return next;
      });
      setLastAward({ id: `${index}-${Date.now()}`, amount: gained, ok: true });
    } else {
      setStreak(0);
      setLastAward({ id: `${index}-${Date.now()}`, amount: 0, ok: false });
    }
  };

  const nextQuestion = async () => {
    if (index + 1 < questions.length) {
      setIndex((i) => i + 1);
      setSelected(null);
    } else {
      setElapsedMs(startedAt ? Date.now() - startedAt : 0);
      setPhase('results');
      if (user) {
        setSavingResult(true);
        try {
          await submitQuizAttempt({ score, total: questions.length, category });
          loadHistory();
        } catch {
          setResultSaveError(true);
        } finally {
          setSavingResult(false);
        }
      }
    }
  };

  const retry = () => setPhase('setup');

  if (poolLoading) {
    return (
      <div className="flex h-[calc(100svh-58px)] items-center justify-center text-lab-500">
        <Loader2 size={20} className="mr-2 animate-spin" /> Loading question bank…
      </div>
    );
  }

  if (poolError) {
    return (
      <div className="flex h-[calc(100svh-58px)] flex-col items-center justify-center gap-2 px-4 text-center text-lab-500">
        <Brain size={24} className="text-lab-600" />
        <p className="text-sm">Couldn't load the question bank — check your connection and refresh.</p>
      </div>
    );
  }

  return (
    <div className="relative overflow-x-hidden">
      {phase === 'setup' && (
        <HeroHeader
          bestPastScorePct={bestPastScorePct}
          totalAvailable={totalAvailable}
          attemptsCount={history.length}
        />
      )}

      <div className="mx-auto max-w-3xl px-4 pb-14 pt-8">
        {phase !== 'setup' && (
          <div className="mb-6 flex items-center gap-2">
            <Brain size={22} className="text-phosphor" />
            <h1 className="font-display text-2xl font-bold text-lab-100">Quiz Mode</h1>
          </div>
        )}

        {phase === 'setup' && (
          <SetupScreen
            category={category}
            setCategory={setCategory}
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            count={count}
            setCount={setCount}
            available={available}
            starting={startingQuiz}
            startError={startError}
            onStart={startQuiz}
            user={user}
            history={history}
          />
        )}

        {phase === 'active' && questions.length > 0 && (
          <ActiveScreen
            key={index}
            question={questions[index]}
            index={index}
            total={questions.length}
            score={score}
            streak={streak}
            points={points}
            lastAward={lastAward}
            selected={selected}
            onAnswer={handleAnswer}
            onNext={nextQuestion}
          />
        )}

        {phase === 'results' && (
          <ResultsScreen
            score={score}
            total={questions.length}
            points={points}
            bestStreak={bestStreak}
            elapsedMs={elapsedMs}
            savingResult={savingResult}
            resultSaveError={resultSaveError}
            onRetry={retry}
            user={user}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Hero header — big glowing intro shown above the setup screen       */
/* ------------------------------------------------------------------ */
function HeroHeader({ bestPastScorePct, totalAvailable, attemptsCount }) {
  return (
    <div className="relative overflow-hidden border-b border-lab-800">
      <div className="pointer-events-none absolute inset-0 grid-paper opacity-40" />
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-phosphor/20 blur-[100px] quiz-glow-pulse" />
      <div
        className="pointer-events-none absolute -right-20 top-10 h-64 w-64 rounded-full bg-violet/20 blur-[100px] quiz-glow-pulse"
        style={{ animationDelay: '0.8s' }}
      />
      <div
        className="pointer-events-none absolute bottom-0 left-1/2 h-56 w-[36rem] -translate-x-1/2 rounded-full bg-amber/10 blur-[110px] quiz-glow-pulse"
        style={{ animationDelay: '1.6s' }}
      />

      <div className="relative mx-auto max-w-3xl px-4 pb-10 pt-14 text-center">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto mb-5 inline-flex items-center gap-1.5 rounded-full border border-phosphor/30 bg-phosphor/10 px-3 py-1 text-xs font-semibold text-phosphor"
        >
          <Sparkles size={12} /> Adaptive practice, generated from your library
        </motion.div>

        <Reveal as="h1" trigger="mount" duration={0.6}>
          <span className="font-display text-4xl font-bold leading-tight text-lab-100 sm:text-5xl">
            How well do you know
            <br />
            your <span className="flash-line">molecules?</span>
          </span>
        </Reveal>

        <Reveal as="p" trigger="mount" delay={0.12} className="mx-auto mt-4 max-w-lg text-sm text-lab-400 sm:text-base">
          Race the clock, build a streak, and chase your best score across compounds,
          functional groups, and the periodic table.
        </Reveal>

        <Reveal as="div" trigger="mount" delay={0.24} className="mx-auto mt-8 grid max-w-md grid-cols-3 gap-3">
          <StatChip icon={Brain} label="Questions" value={totalAvailable} />
          <StatChip icon={Trophy} label="Best score" value={bestPastScorePct != null ? `${bestPastScorePct}%` : '—'} />
          <StatChip icon={Target} label="Attempts" value={attemptsCount} />
        </Reveal>
      </div>
    </div>
  );
}

function StatChip({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-lab-700 bg-lab-900/70 px-3 py-3 backdrop-blur-sm">
      <Icon size={15} className="mx-auto mb-1 text-phosphor" />
      <div className="font-display text-lg font-bold text-lab-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-lab-500">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Setup screen                                                       */
/* ------------------------------------------------------------------ */
function SetupScreen({ category, setCategory, difficulty, setDifficulty, count, setCount, available, starting, startError, onStart, user, history }) {
  return (
    <div>
      <div className="mb-6">
        <h3 className="mb-2.5 font-display text-xs font-semibold uppercase tracking-wider text-lab-400">
          Category
        </h3>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {CATEGORIES.map((c) => {
            const Icon = c.icon;
            const active = category === c.id;
            return (
              <motion.button
                key={c.id}
                onClick={() => setCategory(c.id)}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
                className={`relative overflow-hidden rounded-xl border p-3.5 text-left transition-colors ${
                  active
                    ? 'border-phosphor bg-phosphor/10 text-phosphor'
                    : 'border-lab-700 bg-lab-900/60 text-lab-300 hover:border-lab-500'
                }`}
              >
                {active && (
                  <motion.div
                    layoutId="category-glow"
                    className="pointer-events-none absolute inset-0 bg-phosphor/5"
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
                  />
                )}
                <Icon size={17} className="mb-1.5" />
                <div className="font-display text-sm font-semibold">{c.label}</div>
                <div className="mt-0.5 text-[11px] text-lab-500">{c.blurb}</div>
              </motion.button>
            );
          })}
        </div>
      </div>

      <div className="mb-6">
        <h3 className="mb-2.5 font-display text-xs font-semibold uppercase tracking-wider text-lab-400">
          Difficulty
        </h3>
        <div className="flex flex-wrap gap-2">
          {DIFFICULTIES.map((d) => {
            const active = difficulty === d.id;
            return (
              <motion.button
                key={d.id}
                onClick={() => setDifficulty(d.id)}
                whileTap={{ scale: 0.96 }}
                className={`rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'border-phosphor bg-phosphor/10 text-phosphor'
                    : 'border-lab-700 text-lab-300 hover:border-lab-500'
                }`}
              >
                {d.label}
              </motion.button>
            );
          })}
        </div>
        <AnimatePresence mode="wait">
          <motion.p
            key={difficulty}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-2 text-xs text-lab-500"
          >
            {DIFFICULTIES.find((d) => d.id === difficulty)?.copy}
          </motion.p>
        </AnimatePresence>
      </div>

      <div className="mb-7">
        <h3 className="mb-2.5 font-display text-xs font-semibold uppercase tracking-wider text-lab-400">
          Number of questions
        </h3>
        <div className="flex gap-2">
          {COUNTS.map((n) => (
            <motion.button
              key={n}
              onClick={() => setCount(n)}
              whileTap={{ scale: 0.94 }}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                count === n
                  ? 'border-phosphor bg-phosphor/10 text-phosphor'
                  : 'border-lab-700 text-lab-300 hover:border-lab-500'
              }`}
            >
              {n}
            </motion.button>
          ))}
        </div>
        <p className="mt-2 text-xs text-lab-500">{available} questions available with these filters.</p>
      </div>

      <motion.button
        onClick={onStart}
        disabled={available === 0 || starting}
        whileHover={available > 0 && !starting ? { scale: 1.015 } : {}}
        whileTap={available > 0 && !starting ? { scale: 0.98 } : {}}
        className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-phosphor px-5 py-3.5 text-sm font-semibold text-lab-950 shadow-[0_0_24px_-6px_rgba(94,234,212,0.6)] transition-opacity hover:bg-phosphor-dim disabled:opacity-40 disabled:shadow-none sm:text-base"
      >
        {starting ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Loading questions…
          </>
        ) : (
          <>
            <Zap size={16} className="transition-transform group-hover:scale-110" /> Start Quiz
            <ChevronRight size={16} className="transition-transform group-hover:translate-x-0.5" />
          </>
        )}
      </motion.button>

      {startError && (
        <p className="mt-2 text-center text-xs text-coral">Couldn't load questions — try again.</p>
      )}

      {!user && (
        <p className="mt-3 text-xs text-lab-500">
          <Link to="/login" className="text-phosphor hover:underline">Log in</Link> to save your scores and track progress over time.
        </p>
      )}

      {user && history.length > 0 && (
        <div className="mt-9">
          <h3 className="mb-2 font-display text-xs font-semibold uppercase tracking-wider text-lab-400">
            Recent attempts
          </h3>
          <div className="space-y-1.5">
            {history.slice(0, 5).map((h) => {
              const pct = Math.round((h.score / h.total) * 100);
              return (
                <div
                  key={h.id}
                  className="flex items-center justify-between rounded-md border border-lab-700 bg-lab-900 px-3 py-2 text-sm"
                >
                  <span className="text-lab-300">
                    {h.score}/{h.total} <span className="text-lab-500">({pct}%)</span>
                  </span>
                  <span className="text-xs text-lab-500">
                    {new Date(h.created_at).toLocaleDateString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Active quiz screen                                                 */
/* ------------------------------------------------------------------ */
function ActiveScreen({ question, index, total, score, streak, points, lastAward, selected, onAnswer, onNext }) {
  const isMono = question.mono || MONO_TYPES.has(question.type);
  const [timeLeft, setTimeLeft] = useState(QUESTION_SECONDS);
  const timeLeftRef = useRef(timeLeft);
  timeLeftRef.current = timeLeft;

  useEffect(() => {
    setTimeLeft(QUESTION_SECONDS);
    const tick = setInterval(() => {
      setTimeLeft((t) => (t > 0 ? t - 1 : 0));
    }, 1000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);

  useEffect(() => {
    if (timeLeft === 0 && !selected) {
      onAnswer(TIMEOUT_TOKEN, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft]);

  // keyboard shortcuts: 1-4 to pick, Enter/Space to advance
  useEffect(() => {
    const handler = (e) => {
      if (!selected && ['1', '2', '3', '4'].includes(e.key)) {
        const opt = question.options[Number(e.key) - 1];
        if (opt) onAnswer(opt, timeLeftRef.current);
      }
      if (selected && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, question]);

  const pct = timeLeft / QUESTION_SECONDS;
  const ringColor = pct > 0.5 ? 'var(--color-phosphor)' : pct > 0.2 ? 'var(--color-amber)' : 'var(--color-coral)';
  const circumference = 2 * Math.PI * 15.5;

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ duration: 0.28, ease: EASE }}
    >
      <div className="mb-3 flex items-center justify-between text-xs text-lab-500">
        <span>Question {index + 1} of {total}</span>
        <div className="flex items-center gap-3">
          {streak > 1 && (
            <motion.span
              key={streak}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="flex items-center gap-1 font-semibold text-amber"
            >
              <Flame size={13} /> {streak}x streak
            </motion.span>
          )}
          <span className="flex items-center gap-1 font-semibold text-phosphor">
            <Zap size={12} /> {points} pts
          </span>
          <span>Score: {score}</span>
        </div>
      </div>

      <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-lab-800">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-phosphor-dim to-phosphor"
          initial={{ width: `${(index / total) * 100}%` }}
          animate={{ width: `${(index / total) * 100}%` }}
          transition={{ duration: 0.4, ease: EASE }}
        />
      </div>

      <div className="relative mt-6 overflow-hidden rounded-xl border border-lab-700 bg-lab-900 p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="font-display text-lg font-semibold text-lab-100">{question.prompt}</p>
            {question.subPrompt && (
              <p className="mt-1 text-xs italic text-lab-500">"{question.subPrompt}"</p>
            )}
          </div>

          {/* Countdown ring */}
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center">
            <svg width="44" height="44" viewBox="0 0 36 36" className="-rotate-90">
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--color-lab-800)" strokeWidth="3" />
              <circle
                cx="18" cy="18" r="15.5" fill="none"
                stroke={ringColor}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - pct)}
                style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
              />
            </svg>
            <span className="absolute font-mono text-[11px] font-semibold text-lab-200">{timeLeft}</span>
          </div>
        </div>

        {question.molBlock && (
          <div className="mb-4">
            <ThreeMoleculeViewer molBlock={question.molBlock} height={220} />
          </div>
        )}
        {question.structure && (
          <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <MiniStructurePreview
              atoms={question.structure.atoms}
              bonds={question.structure.bonds}
              height={140}
              highlightBondId={question.highlightBondId}
            />
            <ThreeStructurePreview
              atoms={question.structure.atoms}
              bonds={question.structure.bonds}
              height={140}
              highlightBondAtomIds={(() => {
                // ThreeStructurePreview highlights atoms, not bonds directly (a
                // "highlighted bond" is approximated in 3D by coloring its
                // two endpoint atoms and the connecting rod between them.
                const bond = question.structure.bonds.find((b) => b.id === question.highlightBondId);
                return bond ? [bond.from, bond.to] : null;
              })()}
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {question.options.map((opt, i) => {
            const isCorrect = opt === question.answer;
            const isSelected = opt === selected;
            const wasTimeout = selected === TIMEOUT_TOKEN;
            let stateClasses = 'border-lab-700 hover:border-lab-500 text-lab-200';
            if (selected) {
              if (isCorrect) stateClasses = 'border-phosphor bg-phosphor/10 text-phosphor';
              else if (isSelected) stateClasses = 'border-coral bg-coral/10 text-coral quiz-shake';
              else stateClasses = 'border-lab-800 text-lab-600';
            }
            return (
              <motion.button
                key={opt}
                onClick={() => onAnswer(opt, timeLeftRef.current)}
                disabled={!!selected}
                whileHover={!selected ? { y: -1.5 } : {}}
                whileTap={!selected ? { scale: 0.98 } : {}}
                className={`relative flex items-center justify-between rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors ${stateClasses}`}
              >
                <span className="flex items-center gap-2">
                  <span className="rounded border border-current/30 px-1.5 py-0.5 font-mono text-[10px] opacity-60">{i + 1}</span>
                  <span className={isMono ? 'font-mono' : ''}>{opt}</span>
                </span>
                {selected && isCorrect && <CheckCircle2 size={16} className="quiz-pop-in" />}
                {selected && isSelected && !isCorrect && !wasTimeout && <XCircle size={16} />}
              </motion.button>
            );
          })}
        </div>

        {selected === TIMEOUT_TOKEN && (
          <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-coral">
            <TimerIcon size={13} /> Time's up — streak reset.
          </p>
        )}

        {/* Floating award toast */}
        <AnimatePresence>
          {lastAward && lastAward.ok && selected && (
            <motion.div
              key={lastAward.id}
              initial={{ opacity: 0, y: 0, scale: 0.8 }}
              animate={{ opacity: 1, y: -10, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5 }}
              className="pointer-events-none absolute right-5 top-5 rounded-full bg-phosphor/15 px-2.5 py-1 text-xs font-bold text-phosphor"
            >
              +{lastAward.amount}
            </motion.div>
          )}
        </AnimatePresence>

        {selected && <ConfettiBurst active={lastAward?.ok} keyProp={lastAward?.id} />}

        {selected && (
          <motion.button
            onClick={onNext}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-md bg-phosphor px-4 py-2.5 text-sm font-semibold text-lab-950 hover:bg-phosphor-dim"
          >
            {index + 1 < total ? 'Next question' : 'See results'} <ChevronRight size={15} />
          </motion.button>
        )}

        {!selected && (
          <p className="mt-3 text-center text-[11px] text-lab-600">
            Tip: press <span className="font-mono text-lab-400">1–4</span> to answer instantly
          </p>
        )}
      </div>
    </motion.div>
  );
}

function ConfettiBurst({ active, keyProp }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        id: i,
        left: 5 + Math.random() * 90,
        delay: Math.random() * 0.15,
        color: ['var(--color-phosphor)', 'var(--color-amber)', 'var(--color-violet)', 'var(--color-coral)'][i % 4],
      })),
    [keyProp],
  );
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-8 h-40 overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="quiz-confetti-piece absolute h-2 w-2 rounded-sm"
          style={{ left: `${p.left}%`, top: 0, background: p.color, animationDelay: `${p.delay}s` }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Results screen                                                     */
/* ------------------------------------------------------------------ */
function ResultsScreen({ score, total, points, bestStreak, elapsedMs, savingResult, resultSaveError, onRetry, user }) {
  const pct = Math.round((score / total) * 100);
  const grade = pct === 100 ? 'S' : pct >= 85 ? 'A' : pct >= 70 ? 'B' : pct >= 50 ? 'C' : 'D';
  const message =
    pct === 100 ? 'Perfect score!' : pct >= 70 ? 'Nice work!' : pct >= 40 ? 'Good effort — keep practicing.' : "Worth another pass — you'll get it.";
  const seconds = Math.round((elapsedMs || 0) / 1000);

  const [animatedPct, setAnimatedPct] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let raf;
    const duration = 900;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      setAnimatedPct(Math.round(pct * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [pct]);

  const share = async () => {
    const text = `I scored ${score}/${total} (${pct}%) on the molecular study quiz — best streak ${bestStreak}x!`;
    try {
      if (navigator.share) {
        await navigator.share({ text });
      } else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      /* user cancelled share — ignore */
    }
  };

  const ringCircumference = 2 * Math.PI * 54;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
      className="relative overflow-hidden rounded-xl border border-lab-700 bg-lab-900 p-8 text-center"
    >
      <div className="pointer-events-none absolute -top-16 left-1/2 h-48 w-72 -translate-x-1/2 rounded-full bg-phosphor/10 blur-[90px]" />

      {pct >= 70 && <ConfettiBurst active keyProp="results" />}

      <div className="relative mx-auto mb-4 h-32 w-32">
        <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
          <circle cx="64" cy="64" r="54" fill="none" stroke="var(--color-lab-800)" strokeWidth="8" />
          <circle
            cx="64" cy="64" r="54" fill="none"
            stroke="var(--color-phosphor)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            strokeDashoffset={ringCircumference * (1 - animatedPct / 100)}
            style={{ transition: 'stroke-dashoffset 0.1s linear' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-3xl font-bold text-lab-100">{animatedPct}%</span>
          <span className="font-display text-xs font-semibold text-phosphor">Grade {grade}</span>
        </div>
      </div>

      <Trophy size={22} className="mx-auto mb-2 text-amber" />
      <h2 className="font-display text-2xl font-bold text-lab-100">{score} / {total}</h2>
      <p className="mt-1 text-sm text-lab-400">{message}</p>

      <div className="mx-auto mt-6 grid max-w-sm grid-cols-3 gap-2.5">
        <MiniStat icon={Zap} label="Points" value={points} />
        <MiniStat icon={Flame} label="Best streak" value={`${bestStreak}x`} />
        <MiniStat icon={Clock} label="Time" value={`${seconds}s`} />
      </div>

      {user && (
        <p className={`mt-4 text-xs ${resultSaveError ? 'text-coral' : 'text-lab-500'}`}>
          {savingResult
            ? 'Saving your score…'
            : resultSaveError
            ? "Couldn't save your score to your history — your result above is still accurate."
            : 'Score saved to your history.'}
        </p>
      )}

      <div className="mt-6 flex flex-col justify-center gap-2.5 sm:flex-row">
        <motion.button
          onClick={onRetry}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="flex items-center justify-center gap-1.5 rounded-md bg-phosphor px-5 py-2.5 text-sm font-semibold text-lab-950 hover:bg-phosphor-dim"
        >
          <RotateCcw size={15} /> Try another quiz
        </motion.button>
        <motion.button
          onClick={share}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="flex items-center justify-center gap-1.5 rounded-md border border-lab-700 px-5 py-2.5 text-sm font-semibold text-lab-200 hover:border-lab-500"
        >
          <Share2 size={15} /> {copied ? 'Copied!' : 'Share result'}
        </motion.button>
      </div>
    </motion.div>
  );
}

function MiniStat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg border border-lab-700 bg-lab-950/60 px-2 py-2.5">
      <Icon size={14} className="mx-auto mb-1 text-phosphor" />
      <div className="font-display text-sm font-bold text-lab-100">{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-lab-500">{label}</div>
    </div>
  );
}