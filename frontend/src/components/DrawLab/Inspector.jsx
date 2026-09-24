import { elementInfo } from '../../lib/elements';

// bondOrders is the resolved (Kekulé-aware) single/double/triple order for
// every bond, keyed by bond id — computed server-side by
// resolve_bond_orders in backend/app/formula.py and passed down from
// DrawLabPage's debounced analyzeStructure call. This component used to
// resolve that itself, per click, via lib/elements.js's (now-removed)
// kekulizeAromaticBonds/bondOrderValue — now it's a plain lookup, same as
// how elementInfo below is a plain lookup rather than a computation.

const STYLE_LABELS = {
  none: '—',
  wedge: 'Wedge (toward viewer)',
  dash: 'Dash (away from viewer)',
  aromatic: 'Aromatic',
};

const ORDER_LABELS = { 1: 'Single', 2: 'Double', 3: 'Triple' };

// A bond's resolved order may briefly be missing from `bondOrders` right
// after an edit, while the debounced backend call is still in flight — for
// a non-aromatic bond that's fine, since its order is drawn/stored
// explicitly (bond.order) and isn't derived from anything; only an
// aromatic bond's split is genuinely unresolved until the backend answers.
function resolvedOrder(bond, bondOrders) {
  if (bondOrders && bond.id in bondOrders) return bondOrders[bond.id];
  const isAromatic = bond.aromatic || bond.style === 'aromatic';
  return isAromatic ? null : bond.order || 1;
}

export default function Inspector({ selection, atoms, bonds, bondOrders = {} }) {
  const emptyState = (
    <div className="border-b border-lab-700 p-3">
      <h3 className="mb-1 font-display text-xs font-semibold uppercase tracking-wider text-lab-400">
        Inspector
      </h3>
      <p className="text-[11px] leading-relaxed text-lab-500">
        Click any atom or bond to see its details here.
      </p>
    </div>
  );

  if (!selection) return emptyState;

  if (selection.type === 'atom') {
    const atom = atoms.find((a) => a.id === selection.id);
    // Falls back to the empty state rather than rendering nothing — this
    // is reachable in normal use (select an atom, then erase it, or undo
    // past it) and previously left a blank gap in the sidebar with no
    // explanation.
    if (!atom) return emptyState;
    const info = elementInfo(atom.element);
    const bondCount = bonds.filter((b) => b.from === atom.id || b.to === atom.id).length;
    const connected = bonds.filter((b) => b.from === atom.id || b.to === atom.id);
    const hasUnresolved = connected.some((b) => resolvedOrder(b, bondOrders) === null);
    const bondOrderSum = connected.reduce((sum, b) => sum + (resolvedOrder(b, bondOrders) ?? 1.5), 0);

    return (
      <div className="border-b border-lab-700 p-3">
        <h3 className="mb-2 font-display text-xs font-semibold uppercase tracking-wider text-lab-400">
          Inspector · Atom
        </h3>
        <div className="mb-2 flex items-center gap-2">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-full border-2 font-mono text-xs font-bold"
            style={{ borderColor: info.color, color: info.color }}
          >
            {atom.element}
          </span>
          <span className="text-sm text-lab-200">{info.name}</span>
        </div>
        <Row label="Formal charge" value={atom.charge ? (atom.charge > 0 ? `+${atom.charge}` : atom.charge) : '0'} />
        <Row label="Lone pairs" value={atom.lonePairs || 0} />
        <Row label="Connections" value={bondCount} />
        <Row label="Bond order sum" value={hasUnresolved ? `${bondOrderSum} (resolving…)` : bondOrderSum} />
        <Row label="Position" value={`${Math.round(atom.x)}, ${Math.round(atom.y)}`} mono />
      </div>
    );
  }

  const bond = bonds.find((b) => b.id === selection.id);
  if (!bond) return emptyState;
  const from = atoms.find((a) => a.id === bond.from);
  const to = atoms.find((a) => a.id === bond.to);
  const style = bond.style || (bond.aromatic ? 'aromatic' : 'none');
  const isAromatic = bond.aromatic || style === 'aromatic';
  // An aromatic bond's stored order field is leftover bookkeeping (from
  // however the ring was drawn or parsed in) — not necessarily the order
  // that resolves for *this specific* bond once the whole ring's Kekulé
  // structure is worked out, so it's not shown as if it were one. The
  // resolved single-vs-double split below is what validation actually
  // used; it's still only one resonance form of a delocalized bond.
  const kekuleOrder = isAromatic ? resolvedOrder(bond, bondOrders) : null;

  return (
    <div className="border-b border-lab-700 p-3">
      <h3 className="mb-2 font-display text-xs font-semibold uppercase tracking-wider text-lab-400">
        Inspector · Bond
      </h3>
      <Row label="Between" value={`${from?.element || '?'} – ${to?.element || '?'}`} mono />
      {isAromatic ? (
        <Row
          label="Order"
          value={
            kekuleOrder ? `Aromatic (drawn as ${ORDER_LABELS[kekuleOrder].toLowerCase()} here)` : 'Aromatic (resolving…)'
          }
        />
      ) : (
        <Row label="Order" value={ORDER_LABELS[bond.order] || 'Single'} />
      )}
      <Row label="Style" value={STYLE_LABELS[style]} />
      <p className="mt-2 text-[10px] leading-relaxed text-lab-500">
        Left-click a bond to cycle single/double/triple. Right-click to cycle wedge → dash → aromatic.
      </p>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="mb-1 flex items-center justify-between text-sm">
      <span className="text-lab-500">{label}</span>
      <span className={`text-lab-200 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}