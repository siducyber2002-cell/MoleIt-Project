import { useState } from 'react';
import {
  Circle, Minus, Eraser, Sparkles,
  Plus, Undo2, Redo2, Save, Trash2, Download, Maximize2, Hexagon,
  ShieldCheck, ShieldAlert, X, MousePointer2, Hand, Wand2,
} from 'lucide-react';
import { RING_TYPES } from '../../lib/ringTemplates';

// Grouped so related tools sit together with a divider between clusters —
// build (draw the skeleton) · navigate (select/pan) · annotate (lone
// pairs & formal charge) · destructive (erase) — instead of one
// undifferentiated row.
const TOOL_GROUPS = [
  [
    { id: 'atom', label: 'Atom', icon: Circle, hint: 'Click to place · drag to bond or move', tone: 'phosphor' },
    { id: 'bond', label: 'Bond', icon: Minus, hint: 'Drag to bond · left-click cycles order · right-click cycles wedge/dash/aromatic', tone: 'phosphor' },
    { id: 'ring', label: 'Ring', icon: Hexagon, hint: 'Click canvas to drop a ring', tone: 'sky' },
  ],
  [
    { id: 'select', label: 'Select', icon: MousePointer2, hint: 'Drag to box-select atoms · drag the selection to move it · Delete to remove', tone: 'sky' },
    { id: 'pan', label: 'Pan', icon: Hand, hint: 'Drag anywhere to move the canvas (or just hold Space)', tone: 'slate' },
  ],
  [
    { id: 'lonepair', label: 'Lone pair', icon: Sparkles, hint: 'Click an atom to add a lone pair', tone: 'violet' },
    { id: 'charge+', label: 'Charge', icon: Plus, hint: 'Click an atom to add +1 charge', tone: 'amber' },
    { id: 'charge-', label: 'Charge', icon: Minus, hint: 'Click an atom to add −1 charge', tone: 'amber' },
  ],
  [
    { id: 'erase', label: 'Erase', icon: Eraser, hint: 'Click or drag across atoms/bonds', tone: 'coral' },
  ],
];

const TONE_CLASSES = {
  phosphor: 'from-phosphor/25 to-phosphor/5 text-phosphor ring-phosphor/40',
  sky: 'from-sky-400/25 to-sky-400/5 text-sky-300 ring-sky-400/40',
  violet: 'from-violet/25 to-violet/5 text-violet ring-violet/40',
  amber: 'from-amber/25 to-amber/5 text-amber ring-amber/40',
  coral: 'from-coral/25 to-coral/5 text-coral ring-coral/40',
  slate: 'from-lab-400/25 to-lab-400/5 text-lab-200 ring-lab-400/40',
};

function ToolDivider() {
  return <div className="mx-0.5 h-6 w-px shrink-0 bg-lab-700" aria-hidden="true" />;
}

export default function Toolbar({
  activeTool, setActiveTool,
  onUndo, onRedo, canUndo, canRedo, onClear, onSave, onExport, saving,
  atomScale, setAtomScale,
  ringType, setRingType,
  eraserSize, setEraserSize,
  validationIssues = [],
  onAutocorrect,
  hasAtoms = false,
  hasSelection = false,
}) {
  const [showValidate, setShowValidate] = useState(false);
  const hasIssues = validationIssues.length > 0;
  return (
    <div className="flex flex-col border-b border-lab-700 bg-gradient-to-b from-lab-900 to-lab-900/70 shadow-[0_1px_0_0_rgba(94,234,212,0.06)]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl border border-lab-700 bg-lab-850/80 p-1 shadow-inner">
          {TOOL_GROUPS.map((group, gi) => (
            <div key={gi} className="flex shrink-0 items-center gap-1">
              {gi > 0 && <ToolDivider />}
              {group.map((t) => {
                const Icon = t.icon;
                const active = activeTool === t.id;
                return (
                  <button
                    key={t.id}
                    title={t.hint}
                    onClick={() => setActiveTool(t.id)}
                    className={`group relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-150 ${
                      active
                        ? `bg-gradient-to-b ${TONE_CLASSES[t.tone]} ring-1 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.5)] scale-[1.03]`
                        : 'text-lab-300 hover:bg-lab-800 hover:text-lab-100 hover:-translate-y-px'
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-transform group-hover:scale-110 ${
                        active ? '' : 'opacity-80'
                      }`}
                    >
                      <Icon size={14} />
                    </span>
                    <span className="hidden sm:inline">{t.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-lab-700 bg-lab-850/80 px-2.5 py-1.5 shadow-inner">
          <Maximize2 size={13} className="shrink-0 text-lab-400" />
          <input
            type="range"
            min="0.6"
            max="2"
            step="0.1"
            value={atomScale}
            onChange={(e) => setAtomScale(parseFloat(e.target.value))}
            title={`Atom size: ${atomScale.toFixed(1)}x`}
            className="w-20 accent-phosphor"
          />
          <span className="w-8 shrink-0 text-[10px] font-mono text-lab-400">{atomScale.toFixed(1)}x</span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <IconButton title="Undo" onClick={onUndo} disabled={!canUndo}><Undo2 size={15} /></IconButton>
          <IconButton title="Redo" onClick={onRedo} disabled={!canRedo}><Redo2 size={15} /></IconButton>
          <IconButton title="Clear canvas" onClick={onClear} tone="coral"><Trash2 size={15} /></IconButton>
        </div>

        <button
          onClick={onAutocorrect}
          disabled={!hasAtoms}
          title={
            hasSelection
              ? "Autocorrect the selected atoms: suggests the real compound that matches their formula, or just cleans up the geometry if you'd rather keep what you drew"
              : "Autocorrect: suggests the real compound that matches your drawing's formula (tip: box-select part of it with Select first to autocorrect just that piece), or just cleans up the geometry"
          }
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-sky-400/30 bg-sky-400/5 px-2.5 py-1.5 text-xs font-medium text-sky-300 shadow-sm transition-all hover:-translate-y-px hover:border-sky-400/50 disabled:opacity-30 disabled:hover:translate-y-0"
        >
          <Wand2 size={14} className="shrink-0" />
          <span className="hidden sm:inline">Autocorrect</span>
        </button>

        <div className="relative shrink-0">
          <button
            onClick={() => setShowValidate((v) => !v)}
            title="Validate structure"
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-sm transition-all hover:-translate-y-px ${
              hasIssues
                ? 'border-coral/40 bg-coral/10 text-coral hover:border-coral/60'
                : 'border-phosphor/30 bg-phosphor/5 text-phosphor hover:border-phosphor/50'
            }`}
          >
            {hasIssues ? <ShieldAlert size={14} className="shrink-0" /> : <ShieldCheck size={14} className="shrink-0" />}
            <span className="hidden sm:inline">
              {hasIssues ? `${validationIssues.length} issue${validationIssues.length === 1 ? '' : 's'}` : 'Valid'}
            </span>
          </button>

          {showValidate && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowValidate(false)} />
              <div className="absolute left-0 z-20 mt-2 w-72 rounded-xl border border-lab-700 bg-lab-900 p-3 shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-display text-xs font-semibold uppercase tracking-wider text-lab-300">
                    Structure validation
                  </span>
                  <button onClick={() => setShowValidate(false)} className="text-lab-500 hover:text-lab-200">
                    <X size={13} />
                  </button>
                </div>
                {hasIssues ? (
                  <ul className="space-y-1.5">
                    {validationIssues.map((issue) => (
                      <li key={issue.atomId} className="rounded-md border border-coral/20 bg-coral/5 px-2.5 py-1.5 text-[11px] leading-snug text-lab-200">
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] leading-relaxed text-lab-400">
                    Checks every atom's bonds, lone pairs, and formal charge against real
                    chemistry rules — not just bond count. This is a solid sanity check,
                    not full quantum-chemical validation.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            onClick={onExport}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-lab-700 bg-lab-850/60 px-3 py-1.5 text-xs font-medium text-lab-300 shadow-sm transition-all hover:border-lab-600 hover:text-lab-100 hover:-translate-y-px"
          >
            <Download size={14} className="shrink-0" />
            Export
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-gradient-to-b from-phosphor to-phosphor-dim px-3.5 py-1.5 text-xs font-semibold text-lab-950 shadow-[0_2px_10px_-2px_rgba(94,234,212,0.5)] transition-all hover:brightness-110 hover:-translate-y-px disabled:opacity-60 disabled:translate-y-0"
          >
            <Save size={14} className="shrink-0" />
            {saving ? 'Saving…' : 'Save molecule'}
          </button>
        </div>
      </div>

      {activeTool === 'ring' && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-lab-800 px-3 py-2">
          <span className="mr-1 shrink-0 text-[11px] uppercase tracking-wide text-lab-500">Ring:</span>
          {RING_TYPES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRingType(r.id)}
              className={`shrink-0 whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                ringType === r.id
                  ? 'border-sky-400/50 bg-sky-400/10 text-sky-300'
                  : 'border-lab-700 text-lab-300 hover:border-lab-500'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {activeTool === 'erase' && (
        <div className="flex items-center gap-2 border-t border-lab-800 px-3 py-2">
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-lab-500">Eraser size:</span>
          <input
            type="range"
            min="10"
            max="45"
            step="1"
            value={eraserSize}
            onChange={(e) => setEraserSize(parseInt(e.target.value, 10))}
            className="w-32 accent-coral"
          />
          <span className="w-8 shrink-0 text-[10px] font-mono text-lab-400">{eraserSize}px</span>
        </div>
      )}
    </div>
  );
}

function IconButton({ children, disabled, tone, ...props }) {
  return (
    <button
      {...props}
      disabled={disabled}
      className={`shrink-0 rounded-lg border border-lab-700 bg-lab-850/60 p-1.5 text-lab-300 shadow-sm transition-all hover:-translate-y-px disabled:opacity-30 disabled:hover:translate-y-0 ${
        tone === 'coral' ? 'hover:border-coral/50 hover:text-coral' : 'hover:border-lab-600 hover:text-lab-100'
      }`}
    >
      {children}
    </button>
  );
}