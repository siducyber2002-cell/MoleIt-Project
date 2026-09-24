import { useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { importSmiles, extractErrorMessage } from '../../api/api';

// formula/molarMass/smiles/ringCount are all computed server-side now
// (see DrawLabPage's debounced call to api/api.js's analyzeStructure,
// which hits POST /api/structure/analyze — backend/app/formula.py and
// backend/app/graph_analysis.py) and passed down as props, instead of
// this component computing them itself with lib/elements.js's and
// lib/graphAnalysis.js's (both now deleted) computeFormula/
// computeMolarMass/deriveSmiles/countRings. SMILES import likewise now
// calls POST /api/structure/from-smiles (backend/app/smiles_parser.py)
// instead of the old lib/smilesParser.js (also deleted).
export default function PropertiesPanel({
  atoms,
  bonds,
  name,
  setName,
  formula,
  molarMass,
  smiles,
  ringCount = 0,
  analyzing = false,
  valenceIssues = [],
  onImportSmiles,
}) {
  const [smilesInput, setSmilesInput] = useState('');
  const [smilesError, setSmilesError] = useState('');
  const [importing, setImporting] = useState(false);

  const handleImport = async () => {
    if (!smilesInput.trim() || importing) return;
    setSmilesError('');
    setImporting(true);
    try {
      const structure = await importSmiles(smilesInput);
      onImportSmiles?.(structure, smilesInput.trim());
      setSmilesInput('');
    } catch (err) {
      setSmilesError(extractErrorMessage(err, 'Could not parse that SMILES.'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <h3 className="mb-2 font-display text-xs font-semibold uppercase tracking-wider text-lab-400">
        Molecule
      </h3>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Untitled molecule"
        className="mb-3 w-full rounded-md border border-lab-700 bg-lab-850 px-2.5 py-1.5 text-sm text-lab-100 outline-none focus:border-phosphor"
      />

      <Stat label="Atoms" value={atoms.length} />
      <Stat label="Bonds" value={bonds.length} />
      <Stat label="Rings" value={analyzing && !ringCount ? '…' : ringCount} />
      <Stat label="Formula" value={analyzing && !formula ? '…' : formula || '—'} mono highlight />
      <Stat label="Molar mass" value={analyzing && !molarMass ? '…' : molarMass || '—'} />
      <div className="mt-3">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-lab-500">SMILES (approx.)</div>
        <div className="rounded-md border border-lab-700 bg-lab-850 px-2.5 py-2 font-mono text-xs text-phosphor break-all">
          {analyzing && !smiles ? '…' : smiles || '—'}
        </div>
      </div>

      {valenceIssues.length > 0 && (
        <div className="mt-3 rounded-md border border-coral/30 bg-coral/5 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-coral">
            <AlertTriangle size={12} /> Structure warnings ({valenceIssues.length})
          </div>
          <ul className="space-y-1">
            {valenceIssues.map((issue) => (
              <li key={issue.atomId} className="text-[11px] leading-snug text-lab-300">
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-lab-500">
          <Sparkles size={11} /> Import from SMILES
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={smilesInput}
            onChange={(e) => { setSmilesInput(e.target.value); setSmilesError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleImport(); }}
            placeholder="e.g. CC(=O)Oc1ccccc1C(=O)O"
            className="min-w-0 flex-1 rounded-md border border-lab-700 bg-lab-850 px-2.5 py-1.5 font-mono text-xs text-lab-100 outline-none focus:border-phosphor"
          />
          <button
            onClick={handleImport}
            disabled={!smilesInput.trim() || importing}
            className="flex shrink-0 items-center gap-1 rounded-md bg-phosphor px-2.5 py-1.5 text-[11px] font-semibold text-lab-950 hover:bg-phosphor-dim disabled:opacity-40"
          >
            {importing ? '…' : 'Generate'}
          </button>
        </div>
        {smilesError && (
          <p className="mt-1.5 text-[11px] leading-snug text-coral">{smilesError}</p>
        )}
        <p className="mt-1.5 text-[10px] leading-relaxed text-lab-600">
          Best for chains, branches and single rings — very complex fused ring
          systems may need a manual bond-order tweak or two after import.
        </p>
      </div>

      <div className="mt-4 rounded-md border border-dashed border-lab-700 p-2.5 text-[11px] leading-relaxed text-lab-500">
        Tip: pick an element, click empty canvas to place it, then drag from an
        atom to grow the chain. Cycle bond order by clicking a bond, or use the
        bond-order buttons above before drawing.
      </div>
    </div>
  );
}

function Stat({ label, value, mono, highlight }) {
  return (
    <div className="mb-1.5 flex items-center justify-between text-sm">
      <span className="text-lab-500">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${highlight ? 'text-phosphor font-semibold' : 'text-lab-200'}`}>
        {value}
      </span>
    </div>
  );
}