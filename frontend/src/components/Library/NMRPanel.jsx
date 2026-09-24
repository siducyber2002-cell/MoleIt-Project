import { useEffect, useMemo, useState } from 'react';
import { Info, MousePointerClick, Check, Loader2, AlertTriangle } from 'lucide-react';
import { predictNmr } from '../../api/api';
import ThreeStructurePreview from '../Viewer3D/ThreeStructurePreview';

// `rangeMin`/`rangeMax` default to the full 0..maxPpm span (the main
// chart), but can be narrowed to render just a small window — this is
// what makes the same component reusable as a zoomed "expansion" inset
// for a crowded cluster of peaks (see NMRSection below). `indexMap`, when
// given, translates this instance's local peak index (0, 1, 2... within
// whatever subset of peaks it was handed) back to the index in the full,
// original peaks array that `hoverIndex` and `onHover` operate on — so an
// expansion inset showing only 3 of a spectrum's 12 peaks still shares
// hover state correctly with the main chart, the table, and the atom
// highlight, rather than each inset owning its own disconnected 0/1/2.
//
// NOTE: this chart is deliberately dumb about *why* a peak is what it is —
// no in-SVG tooltip. An SVG text box has to guess its own pixel width from
// character counts and can't wrap the way an HTML element can, so a long
// "reason" sentence used to size itself way past the chart's edge and get
// clipped by the page rather than wrapping — the "screen cut" bug. Hover
// detail now lives in exactly one place: the HTML <PeakDetail> panel below
// the chart, which can wrap normally and never overflows.
function Spectrum({ peaks, maxPpm, unit, hoverIndex, onHover, pinnedIndex = null, onTogglePin = null, rangeMin = 0, rangeMax = null, indexMap = null, tickFormat = null, overlapBands = [] }) {
  const width = 640;
  const height = 108;
  const padL = 20;
  const padR = 20;
  const axisY = height - 26;
  const plotWidth = width - padL - padR;
  const lo = rangeMin;
  const hi = rangeMax != null ? rangeMax : maxPpm;
  const span = hi - lo;

  const xFor = (ppm) => padL + ((hi - ppm) / span) * plotWidth;
  const globalIndex = (localI) => (indexMap ? indexMap[localI] : localI);

  // Two (or more) predicted peaks can share the *exact* same shift — most
  // commonly because they share the same textbook range and therefore the
  // same midpoint (e.g. several distinct fused-ring CH assignments all
  // reported as "126–129"). At this component's linear ppm→pixel scale
  // that means they'd draw on top of each other as a single line, even in
  // a zoomed "expansion" inset built specifically to separate a crowded
  // cluster — which is exactly the bug: the table says "N overlapping
  // peaks" but the chart only ever shows however many *distinct x
  // positions* happen to exist.
  //
  // This only changes where a tied peak's line is *drawn*; `p.shift` (the
  // real predicted value shown in the tooltip and the peak table) is
  // completely untouched. Peaks whose true pixel positions would land
  // within `minGapPx` of each other are spread apart, centered on their
  // shared position, by exactly `minGapPx` — enough that each gets its
  // own visible stick without visually misrepresenting peaks that were
  // already comfortably separated.
  const displayX = useMemo(() => computeDisplayX(peaks, (p) => xFor(p.shift)), [peaks, lo, hi]);
  const maxIntegration = Math.max(1, ...peaks.map((p) => p.integration || 1));
  const heightFor = (p) => (p.integration ? 14 + 40 * (p.integration / maxIntegration) : 40);

  const ticks = [];
  let tickStep;
  if (span > 100) tickStep = 20;
  else if (span > 40) tickStep = 5;
  else if (span > 10) tickStep = 2;
  else if (span > 4) tickStep = 1;
  else if (span > 1.5) tickStep = 0.5;
  else if (span > 0.6) tickStep = 0.2;
  else tickStep = 0.1;
  const decimals = tickStep >= 1 ? 0 : tickStep >= 0.2 ? 1 : 2;
  for (let t = Math.ceil(lo / tickStep) * tickStep; t <= hi + 1e-9; t += tickStep) {
    ticks.push(Number(t.toFixed(2)));
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full overflow-visible"
      style={{ height }}
      onMouseLeave={() => onHover(null)}
    >
      <line x1={padL} y1={axisY} x2={width - padR} y2={axisY} stroke="var(--color-lab-700)" strokeWidth={1.5} />
      {overlapBands.map((b, bi) => {
        const bx1 = xFor(b.hiPpm);
        const bx2 = xFor(b.loPpm);
        return (
          <g key={bi}>
            <rect x={bx1} y={8} width={Math.max(2, bx2 - bx1)} height={axisY - 8} fill="var(--color-sky-400, #38bdf8)" opacity={0.08} />
            <text x={(bx1 + bx2) / 2} y={18} textAnchor="middle" fontSize={8} fill="var(--color-sky-300, #7dd3fc)">
               ⌄
            </text>
          </g>
        );
      })}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={xFor(t)} y1={axisY} x2={xFor(t)} y2={axisY + 5} stroke="var(--color-lab-700)" strokeWidth={1} />
          <text x={xFor(t)} y={axisY + 17} textAnchor="middle" fontSize={9.5} fill="var(--color-lab-500)" className="font-mono">
            {tickFormat ? tickFormat(t) : t.toFixed(decimals)}
          </text>
        </g>
      ))}
      <text x={width - padR} y={height - 3} textAnchor="end" fontSize={9.5} fill="var(--color-lab-600)">
        {unit} (ppm) — downfield ←→ upfield
      </text>

      {peaks.map((p, i) => {
        const gi = globalIndex(i);
        const isHovered = hoverIndex === gi;
        const isPinned = pinnedIndex === gi;
        const x = displayX[i];
        const h = heightFor(p) + (isHovered ? 8 : 0); // hovered peak "pops up" a bit taller
        return (
          <g key={i}>
            {/* Generous invisible hit area — the visible line is only 2px
                wide, too thin to reliably hover/tap on its own. Clicking
                it pins the peak's explanation in the panel below (see
                <PeakDetail>) so it survives the mouse moving away. */}
            <rect
              x={x - 7}
              y={axisY - h - 4}
              width={14}
              height={h + 4}
              fill="transparent"
              onMouseEnter={() => onHover(gi)}
              onFocus={() => onHover(gi)}
              onClick={() => onTogglePin && onTogglePin(gi)}
              tabIndex={0}
              style={{ cursor: 'pointer' }}
            />
            <line
              x1={x}
              y1={axisY}
              x2={x}
              y2={axisY - h}
              stroke={isHovered ? 'var(--color-amber-300, #fbbf24)' : 'var(--color-phosphor)'}
              strokeWidth={isHovered ? 3.5 : isPinned ? 3 : 2}
              strokeLinecap="round"
              opacity={isHovered || isPinned ? 1 : 0.85}
              style={{ transition: 'stroke-width 120ms ease, stroke 120ms ease' }}
            />
            {isPinned && <circle cx={x} cy={axisY - h - 6} r={2.6} fill="var(--color-sky-300, #7dd3fc)" />}
          </g>
        );
      })}
    </svg>
  );
}

// Spreads apart the *drawn* x-position of peaks that would otherwise land
// within `minGapPx` pixels of each other — most commonly true ties (same
// shift value), but also near-ties too close to tell apart as separate
// sticks. Returns an array parallel to `peaks`: displayX[i] is where peak
// i's line should be drawn. Untied peaks are returned at their true xFor
// position, unchanged.
//
// Algorithm: sort peaks by true x, walk left to right grouping any run of
// peaks whose consecutive gap is under minGapPx into one cluster, then lay
// each cluster out on a straight line with exactly minGapPx between
// neighbors, centered on the cluster's average true position. This keeps
// clusters that are already well-separated from each other untouched
// (each is its own cluster) while guaranteeing every peak within a
// cluster gets its own distinct, legible line.
function computeDisplayX(peaks, xFor, minGapPx = 6) {
  const n = peaks.length;
  const displayX = new Array(n);
  if (n === 0) return displayX;
  if (n === 1) {
    displayX[0] = xFor(peaks[0]);
    return displayX;
  }

  const order = peaks.map((p, i) => ({ i, x: xFor(p) })).sort((a, b) => a.x - b.x);
  const flushCluster = (cluster) => {
    if (cluster.length === 1) {
      displayX[cluster[0].i] = cluster[0].x;
      return;
    }
    const center = cluster.reduce((sum, c) => sum + c.x, 0) / cluster.length;
    const start = center - (minGapPx * (cluster.length - 1)) / 2;
    cluster.forEach((c, k) => {
      displayX[c.i] = start + k * minGapPx;
    });
  };

  let cluster = [order[0]];
  for (let k = 1; k < order.length; k++) {
    if (order[k].x - order[k - 1].x < minGapPx) {
      cluster.push(order[k]);
    } else {
      flushCluster(cluster);
      cluster = [order[k]];
    }
  }
  flushCluster(cluster);
  return displayX;
}

// Groups peak indices whose x-position (at the *main* chart's linear
// scale) would land within `thresholdPx` of a neighbor — genuinely likely
// to visually coincide, not just "somewhat close." Only clusters of 2+
// peaks are returned; an isolated peak needs no expansion.
function detectOverlapClusters(peaks, xFor, thresholdPx) {
  if (peaks.length < 2) return [];
  const sorted = peaks.map((p, i) => ({ i, x: xFor(p.shift) })).sort((a, b) => a.x - b.x);
  const clusters = [];
  let current = [sorted[0]];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].x - current[current.length - 1].x < thresholdPx) {
      current.push(sorted[k]);
    } else {
      if (current.length > 1) clusters.push(current.map((c) => c.i));
      current = [sorted[k]];
    }
  }
  if (current.length > 1) clusters.push(current.map((c) => c.i));
  return clusters;
}

// Breaks a peak's one-sentence `reason` into short standalone bullets, so
// the detail panel can show "why it shifts there" as a scannable list
// instead of one dense sentence — purely a display-side transform of text
// the backend's NMR predictor (backend/app/spectra/nmr.py) already
// produces, not a second explanation engine. Splits on natural clause
// boundaries (em dash, colon, "since/because") rather than hand-writing a
// bullet list per classification key (there are 80+).
function splitReasonIntoBullets(reason) {
  if (!reason) return [];
  return reason
    .split(/\s+—\s+|:\s+|;\s+|,\s+(?=which|since|though|so\b)|\.\s+(?=\S)/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s.length > 2)
    .slice(0, 4);
}

// Confidence renders as a small dot rather than a raw number in the row
// itself — a 0.62 vs 0.71 distinction isn't meaningful at this app's
// rule-based tier, but "this one is much shakier than that one" is (per
// the spec's "never present a peak as an exact fact" guidance). The exact
// percentage — and now the short list of *why* — is still one hover away
// via the native title tooltip, rather than removed from the UI entirely.
function ConfidenceDot({ confidence, factors }) {
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.75 ? 'bg-emerald-400' : confidence >= 0.5 ? 'bg-amber-400' : 'bg-rose-400';
  const level = confidence >= 0.75 ? 'High confidence' : confidence >= 0.5 ? 'Moderate confidence' : 'Low confidence — see warning';
  const tooltip = [`${level} (~${pct}%)`, ...(factors && factors.length ? factors.map((f) => `• ${f}`) : [])].join('\n');
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`} title={tooltip} />;
}

// The single, shared "why it shifts there" readout — replaces two things
// the old layout showed at once for the same hovered peak (an in-chart
// tooltip AND a second description next to the structure preview). Now
// there's exactly one of these per spectrum, always in the same place,
// and it drives off the same hoverIndex the chart/table/structure share.
function PeakDetail({ peak, advanced, unit, pinned }) {
  if (!peak) {
    return (
      <div className="flex min-h-[84px] items-center justify-center gap-1.5 rounded-xl border border-dashed border-lab-700 px-4 text-center text-[11px] text-lab-500">
        <MousePointerClick size={13} className="shrink-0 text-lab-600" />
        Hover a peak, row, or atom to preview why it shifts there — click a row's checkbox to pin the explanation here.
      </div>
    );
  }

  const bullets = advanced ? splitReasonIntoBullets(peak.reason) : [];

  return (
    <div className="rounded-xl border border-phosphor/30 bg-phosphor/[0.06] p-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-mono text-lg font-bold leading-none text-phosphor">
          {peak.shift.toFixed(2)} <span className="text-xs font-semibold">{unit} ppm</span>
        </span>
        <span className="text-xs font-medium text-lab-200">{peak.label}</span>
        <span className="text-[10.5px] text-lab-500">textbook range {peak.range[0]}–{peak.range[1]} ppm</span>
        {pinned && (
          <span className="ml-auto rounded-full border border-phosphor/40 bg-phosphor/10 px-1.5 py-0.5 text-[9px] font-medium text-phosphor">
            Pinned
          </span>
        )}
      </div>

      {advanced ? (
        bullets.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-lab-400">
            {bullets.map((b, bi) => (
              <li key={bi}>{b}</li>
            ))}
          </ul>
        )
      ) : (
        peak.reason && <p className="mt-1.5 text-[11px] leading-relaxed text-lab-400">{peak.reason}</p>
      )}

      {peak.warnings && peak.warnings.length > 0 && (
        <p className="mt-1.5 text-[10.5px] italic leading-snug text-amber-300/80">{peak.warnings.join(' ')}</p>
      )}

      {advanced && typeof peak.confidence === 'number' && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-phosphor/10 pt-2 text-[10.5px] text-lab-500">
          <ConfidenceDot confidence={peak.confidence} factors={peak.confidenceFactors} />
          Confidence ~{Math.round(peak.confidence * 100)}%
          {peak.confidenceFactors && peak.confidenceFactors.length > 0 ? ` — ${peak.confidenceFactors[0]}` : ''}
        </div>
      )}
    </div>
  );
}

function PeakTable({ peaks, showIntegration, showMultiplicity, showDept, hoverIndex, onHoverRow, pinnedIndex, onTogglePin, nucleusSymbol, advanced }) {
  return (
    <div className="overflow-hidden rounded-xl border border-lab-800">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-[11px]">
          <thead>
            <tr className="border-b border-lab-800 bg-lab-900/60 text-lab-500">
              <th className="w-8 px-3 py-2" title="Pin this peak's explanation below">
                &nbsp;
              </th>
              <th className="px-2 py-2 font-medium uppercase tracking-wide" title="Signal order, downfield → upfield — not an IUPAC atom number">
                #
              </th>
              <th className="px-2 py-2 font-medium uppercase tracking-wide">Shift (ppm)</th>
              {showIntegration && <th className="px-2 py-2 font-medium uppercase tracking-wide">Nuclei</th>}
              {showMultiplicity && <th className="px-2 py-2 font-medium uppercase tracking-wide">Mult. (J, Hz)</th>}
              {showDept && <th className="px-2 py-2 font-medium uppercase tracking-wide">Type</th>}
              <th className="px-2 py-2 font-medium uppercase tracking-wide">Likely assignment</th>
              <th className="w-6 px-2 py-2">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {peaks.map((p, i) => {
              const isPinned = pinnedIndex === i;
              return (
                <tr
                  key={i}
                  className={`cursor-pointer border-t align-top transition-colors ${
                    isPinned
                      ? 'border-phosphor/40 bg-phosphor/[0.07]'
                      : hoverIndex === i
                      ? 'border-lab-700 bg-amber-400/10'
                      : 'border-lab-800/70 hover:bg-lab-800/40'
                  }`}
                  onMouseEnter={() => onHoverRow && onHoverRow(i)}
                  onMouseLeave={() => onHoverRow && onHoverRow(null)}
                  onClick={() => onTogglePin && onTogglePin(i)}
                >
                  <td className="px-3 py-2">
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                        isPinned ? 'border-phosphor bg-phosphor text-lab-950' : 'border-lab-600 text-transparent'
                      }`}
                    >
                      <Check size={11} strokeWidth={3} />
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-lab-500">
                    {nucleusSymbol}{i + 1}
                  </td>
                  <td className="px-2 py-2 font-mono text-phosphor">
                    {typeof p.shift === 'number' ? p.shift.toFixed(2) : p.shift}
                    <div className="font-sans text-[9.5px] text-lab-500">range {p.range[0]}–{p.range[1]}</div>
                  </td>
                  {showIntegration && (
                    <td className="px-2 py-2 text-lab-300">
                      {p.integration}H
                      <div className="text-[9.5px] text-lab-500">∫ {Number(p.integration).toFixed(2)}</div>
                    </td>
                  )}
                  {showMultiplicity && (
                    <td className="px-2 py-2 font-mono text-lab-300">
                      {p.multiplicity}
                      {p.jHz && p.jHz.length > 0 ? ` (${p.jHz.join(', ')})` : ''}
                    </td>
                  )}
                  {showDept && <td className="px-2 py-2 text-lab-300">{p.carbonType}</td>}
                  <td className="px-2 py-2 text-lab-300">
                    {p.label}
                    {(p.diastereotopic || p.secondOrder) && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {p.diastereotopic && (
                          <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-300" title="Near a detected stereocenter — the two CH2 protons may not really be equivalent">
                            diastereotopic
                          </span>
                        )}
                        {p.secondOrder && (
                          <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-300" title={`Textbook-expected multiplicity: ${p.reportedMultiplicity || 'n/a'} — shift separation from its coupling partner is small relative to J`}>
                            second-order
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {advanced && typeof p.confidence === 'number' && <ConfidenceDot confidence={p.confidence} factors={p.confidenceFactors} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One spectrum's worth of chart + table + linked structure preview + a
 *  single shared detail readout, all sharing one hover state: hovering a
 *  peak on the chart, a row in the table, or an atom on the structure all
 *  highlight the same thing everywhere else, and the detail panel below
 *  updates to match. `atoms`/`bonds` are the full molecule (not just the
 *  atoms in this spectrum) so the structure preview always shows the
 *  whole compound with the relevant part picked out.
 *
 *  Peaks that would visually coincide on the main chart's linear scale
 *  (two shifts 0.05 ppm apart can be under a pixel apart at this width)
 *  get their own zoomed "expansion" inset underneath — a second small
 *  chart showing just that narrow ppm window stretched across the full
 *  width, so each peak that was invisible or merged on the main scale
 *  gets real, visible separation. This is the same "expansion" concept
 *  real NMR software uses for crowded regions, rather than trying to
 *  redraw the whole axis non-linearly (which would misrepresent every
 *  other peak's position to fix a problem that's local to one cluster). */
function NMRSection({ peaks, maxPpm, unit, nucleusSymbol, atoms, bonds, showIntegration, showMultiplicity, showDept, advanced }) {
  const [previewIndex, setPreviewIndex] = useState(null); // hover/focus — transient, wins while active
  const [pinnedIndex, setPinnedIndex] = useState(null); // checkbox click — persists past hover
  const activeIndex = previewIndex !== null ? previewIndex : pinnedIndex;
  const togglePin = (i) => setPinnedIndex((cur) => (cur === i ? null : i));

  const peakIndexByAtomId = useMemo(() => {
    const m = new Map();
    peaks.forEach((p, i) => (p.atomIds || []).forEach((id) => m.set(id, i)));
    return m;
  }, [peaks]);

  const active = activeIndex !== null ? peaks[activeIndex] : null;
  const highlightAtomIds = active ? new Set(active.atomIds || []) : null;
  const hasStructure = atoms && atoms.length > 0 && atoms.every((a) => typeof a.x === 'number' && typeof a.y === 'number');

  const clusters = useMemo(() => {
    const width = 640;
    const padL = 20;
    const padR = 20;
    const plotWidth = width - padL - padR;
    const xForMain = (ppm) => padL + (1 - ppm / maxPpm) * plotWidth;
    const OVERLAP_THRESHOLD_PX = 16; // roughly one peak-line's worth of breathing room
    return detectOverlapClusters(peaks, xForMain, OVERLAP_THRESHOLD_PX).map((idxs) => {
      const shifts = idxs.map((i) => peaks[i].shift);
      const lo = Math.min(...shifts);
      const hi = Math.max(...shifts);
      // A little absolute padding around the cluster's own span so the
      // outermost peaks aren't drawn right at the inset's edge — scaled
      // to the spectrum type, since a "close" cluster means something
      // very different at 13-ppm-wide 1H scale vs 220-ppm-wide 13C scale.
      const pad = Math.max((hi - lo) * 0.4, maxPpm > 20 ? 1.5 : 0.15);
      return { idxs, rangeMin: Math.max(0, lo - pad), rangeMax: hi + pad };
    });
  }, [peaks, maxPpm]);

  const overlapBands = advanced ? clusters.map((c) => ({ loPpm: c.rangeMin, hiPpm: c.rangeMax })) : [];

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-lab-800 bg-lab-950/40 p-3.5">
        <Spectrum
          peaks={peaks}
          maxPpm={maxPpm}
          unit={unit}
          hoverIndex={previewIndex}
          onHover={setPreviewIndex}
          pinnedIndex={pinnedIndex}
          onTogglePin={togglePin}
          overlapBands={overlapBands}
        />

        {advanced && clusters.length > 0 && (
          <div className="mt-3 space-y-2.5 border-t border-lab-800 pt-3">
            {clusters.map((c, ci) => {
              // The true spread of the signals themselves (not the padded
              // inset window) is the number that actually matters to the
              // reader: "4 signals overlap within 0.08 ppm" says why they
              // needed zooming in on at all.
              const shifts = c.idxs.map((i) => peaks[i].shift);
              const trueSpan = Math.max(...shifts) - Math.min(...shifts);
              return (
                <div key={ci} className="rounded-lg border border-sky-400/20 bg-sky-400/5 p-2.5">
                  <div className="mb-1 text-[9.5px] font-medium uppercase tracking-wide text-sky-300/80">
                    {c.idxs.length} signals overlap within {trueSpan.toFixed(2)} {unit} ppm — zoom generated automatically
                  </div>
                  <Spectrum
                    peaks={c.idxs.map((i) => peaks[i])}
                    indexMap={c.idxs}
                    maxPpm={maxPpm}
                    rangeMin={c.rangeMin}
                    rangeMax={c.rangeMax}
                    unit={unit}
                    hoverIndex={previewIndex}
                    onHover={setPreviewIndex}
                    pinnedIndex={pinnedIndex}
                    onTogglePin={togglePin}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* `items-start` (rather than grid's default stretch) is the fix for
          the structure card inheriting the peak table's full height and
          sitting mostly blank underneath a small, centered molecule — the
          card now sizes to its own content instead. The structure column
          is also given real width (not a cramped fixed 180px) so it reads
          as a proper panel, not an afterthought squeezed into the corner. */}
      <div className={hasStructure ? 'grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,38%)]' : ''}>
        <PeakTable
          peaks={peaks}
          showIntegration={showIntegration}
          showMultiplicity={showMultiplicity}
          showDept={showDept}
          hoverIndex={previewIndex}
          onHoverRow={setPreviewIndex}
          pinnedIndex={pinnedIndex}
          onTogglePin={togglePin}
          nucleusSymbol={nucleusSymbol}
          advanced={advanced}
        />
        {hasStructure && (
          <div className="space-y-3">
            <div className="rounded-xl border border-lab-800 bg-lab-950/40 p-3">
              <div className="mb-1.5 text-[9.5px] font-medium uppercase tracking-wide text-lab-600">3D structure</div>
              <ThreeStructurePreview
                atoms={atoms}
                bonds={bonds}
                height={220}
                highlightAtomIds={highlightAtomIds}
                onAtomHover={(atomId) => {
                  const idx = peakIndexByAtomId.get(atomId);
                  if (idx !== undefined) setPreviewIndex(idx);
                }}
                onAtomLeave={() => setPreviewIndex(null)}
              />
            </div>
          </div>
        )}
      </div>

      <PeakDetail peak={active} advanced={advanced} unit={unit} pinned={pinnedIndex !== null && pinnedIndex === activeIndex} />
    </div>
  );
}

/** Predicted 1H and 13C NMR display for a compound's structure. Works for
 *  any compound with a structure_2d — curated library entries, anything
 *  pulled live from PubChem, or a molecule drawn from scratch — since the
 *  prediction is computed from atoms/bonds rather than looked up. */
export default function NMRPanel({ atoms, bonds }) {
  const [advanced, setAdvanced] = useState(false);
  const [peaks, setPeaks] = useState(null); // null = still loading
  const [error, setError] = useState(null);

  // Stable-ish dependency key so we don't refetch every render when the
  // parent passes new-but-equivalent array references.
  const structureKey = useMemo(() => JSON.stringify({ atoms, bonds }), [atoms, bonds]);

  useEffect(() => {
    if (!atoms || atoms.length === 0) {
      setPeaks({ h1: [], c13: [] });
      setError(null);
      return;
    }
    let cancelled = false;
    setPeaks(null);
    setError(null);
    predictNmr(atoms, bonds || [])
      .then((result) => {
        if (!cancelled) setPeaks(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.response?.data?.message || 'Could not reach the NMR prediction service.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  if (!atoms || atoms.length === 0) {
    return <p className="text-sm text-lab-500">No structure available to predict NMR shifts from.</p>;
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-400/5 p-3.5 text-[11px] leading-relaxed text-rose-300">
        <AlertTriangle size={14} className="shrink-0" />
        {error}
      </div>
    );
  }

  if (peaks === null) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-lab-900/30 p-8 text-xs text-lab-500">
        <Loader2 size={14} className="animate-spin" />
        Predicting NMR spectrum…
      </div>
    );
  }

  const { h1, c13 } = peaks;

  if (h1.length === 0 && c13.length === 0) {
    return (
      <p className="text-sm text-lab-500">
        No organic NMR-active environments found — this looks like an ionic or purely inorganic species rather
        than a covalent molecule.
      </p>
    );
  }

  return (
    <div className="space-y-6 rounded-2xl border border-white/10 bg-lab-900/30 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-sm font-semibold text-lab-100">Predicted NMR</h3>
        <div className="inline-flex items-center gap-0.5 rounded-full border border-lab-700 bg-lab-900/60 p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setAdvanced(false)}
            aria-pressed={!advanced}
            className={`rounded-full px-3 py-1 font-medium transition-colors ${
              !advanced ? 'bg-phosphor text-lab-950' : 'text-lab-400 hover:text-lab-200'
            }`}
          >
            Basic
          </button>
          <button
            type="button"
            onClick={() => setAdvanced(true)}
            aria-pressed={advanced}
            className={`rounded-full px-3 py-1 font-medium transition-colors ${
              advanced ? 'bg-phosphor text-lab-950' : 'text-lab-400 hover:text-lab-200'
            }`}
          >
            Advanced
          </button>
        </div>
      </div>

      <div className="flex items-start gap-2.5 rounded-xl border border-sky-400/25 bg-sky-400/5 p-3.5 text-[11px] leading-relaxed text-lab-300">
        <Info size={14} className="mt-0.5 shrink-0 text-sky-300" />
        {advanced ? (
          <span>
            Predicted from this compound's structure using standard chemical-shift and first-order n+1 coupling
            rules — a teaching-level approximation, not a lab measurement. Each peak's shift is a specific,
            deterministic point placed within its real textbook range (the range itself is always shown alongside
            it) rather than always the flat range midpoint, so distinct environments that share a range still read
            as distinct numbers and distinct lines on the chart. The "#" column numbers signals in spectral order
            (downfield → upfield) — a reading aid, not an IUPAC atom number, since that would need full structure
            canonicalization this predictor doesn't attempt. Symmetric protons/carbons (like a -CH3 group, or a
            monosubstituted benzene ring) are shown as one combined peak, the same simplification most courses
            make. Multiplicities can be compound (dd, td, ddd...) when a proton couples to two or more
            non-equivalent neighboring groups — including, now, representative J's for aromatic/heteroaromatic ring
            positions once the position (ortho/meta/para, alpha/beta/gamma-to-heteroatom, fused alpha/beta/meso) is
            resolved, not just a flat n+1 count. Peaks too close together to tell apart on the main scale get their
            own zoomed-in "expansion" strip underneath, the same convention real NMR software uses for crowded
            regions. Hover (or tap) a peak, table row, or atom — they're linked, and highlighting one highlights
            the others along with a short breakdown below the chart of why it shifts there. The dot beside each row
            is a rough confidence indicator; hover it for the exact percentage and the specific factors behind it
            (exchangeable proton, textbook range width, whether a functional-group- or ring-position-specific
            correction applied).
          </span>
        ) : (
          <span>
            Predicted from this compound's structure using standard chemical-shift rules — a teaching-level
            approximation, not a lab measurement. Each stick on the chart is a predicted signal; hover (or tap) a
            peak, table row, or atom to see what it's assigned to below the chart. Switch to <strong>Advanced</strong>{' '}
            for integration, multiplicity/J values, DEPT carbon type, confidence scoring, and zoomed-in views of
            overlapping signals.
          </span>
        )}
      </div>

      {peaks.warnings && peaks.warnings.length > 0 && (
        <div className="space-y-2">
          {peaks.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3.5 text-[11px] leading-relaxed text-amber-200">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {h1.length > 0 && (
        <div>
          <h4 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-lab-400">Predicted ¹H NMR</h4>
          <NMRSection
            peaks={h1}
            maxPpm={13}
            unit="¹H"
            nucleusSymbol="H"
            atoms={atoms}
            bonds={bonds}
            showIntegration={advanced}
            showMultiplicity={advanced}
            advanced={advanced}
          />
        </div>
      )}

      {c13.length > 0 && (
        <div>
          <h4 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-lab-400">Predicted ¹³C NMR</h4>
          <NMRSection
            peaks={c13}
            maxPpm={220}
            unit="¹³C"
            nucleusSymbol="C"
            atoms={atoms}
            bonds={bonds}
            showIntegration={false}
            showMultiplicity={advanced}
            showDept={advanced}
            advanced={advanced}
          />
        </div>
      )}
    </div>
  );
}