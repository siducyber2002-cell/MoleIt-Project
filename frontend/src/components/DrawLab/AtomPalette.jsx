import { useState, useMemo } from 'react';
import { ELEMENTS, ELEMENT_SYMBOLS, QUICK_PALETTE, elementInfo } from '../../lib/elements';

export default function AtomPalette({ activeElement, setActiveElement }) {
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!showAll) return QUICK_PALETTE;
    if (!search.trim()) return ELEMENT_SYMBOLS;
    const q = search.trim().toLowerCase();
    return ELEMENT_SYMBOLS.filter(
      (sym) => sym.toLowerCase().startsWith(q) || elementInfo(sym).name.toLowerCase().includes(q)
    );
  }, [showAll, search]);

  return (
    <div className="border-b border-lab-700 bg-gradient-to-b from-transparent to-lab-900/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-lab-400">Elements</h3>
        <button
          onClick={() => setShowAll((s) => !s)}
          className="rounded-full bg-phosphor/10 px-2 py-0.5 text-[11px] font-medium text-phosphor transition-colors hover:bg-phosphor/20"
        >
          {showAll ? 'Fewer' : `Periodic table (${ELEMENT_SYMBOLS.length})`}
        </button>
      </div>

      {showAll && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search element or symbol…"
          className="mb-2 w-full rounded-lg border border-lab-700 bg-lab-850 px-2.5 py-1.5 text-xs text-lab-100 shadow-inner outline-none focus:border-phosphor"
        />
      )}

      <div className={`grid grid-cols-4 gap-1.5 ${showAll ? 'max-h-72 overflow-y-auto pr-1' : ''}`}>
        {filtered.map((sym) => {
          const info = elementInfo(sym);
          const active = activeElement === sym;
          return (
            <button
              key={sym}
              onClick={() => setActiveElement(sym)}
              title={info.name}
              style={{
                borderColor: active ? info.color : undefined,
                boxShadow: active ? `0 0 0 1px ${info.color}55, 0 4px 12px -4px ${info.color}66` : undefined,
              }}
              className={`group relative flex flex-col items-center justify-center rounded-lg border py-1.5 font-mono text-sm font-bold transition-all duration-150 ${
                active
                  ? 'bg-lab-800 -translate-y-0.5'
                  : 'border-lab-700 bg-gradient-to-b from-lab-850 to-lab-900 text-lab-200 hover:-translate-y-0.5 hover:border-lab-500 hover:shadow-md'
              }`}
            >
              <span style={{ color: info.color }}>{sym}</span>
              <span className="mt-0.5 text-[9px] font-normal text-lab-500">
                {info.weight ? info.weight.toFixed(1) : ''}
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="col-span-4 py-3 text-center text-xs text-lab-500">No matching element</p>
        )}
      </div>
    </div>
  );
}