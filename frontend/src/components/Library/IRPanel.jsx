import { useEffect, useId, useMemo, useState } from 'react';
import { Info, MousePointerClick, ChevronDown, Loader2, AlertTriangle } from 'lucide-react';
import { predictIr } from '../../api/api';
import ThreeStructurePreview from '../Viewer3D/ThreeStructurePreview';

// ---------------------------------------------------------------------
// Design intent, since it's easy to accidentally re-derive NMRPanel's
// layout by habit: a real IR spectrum is not a set of sticks — it's a
// %Transmittance curve that dips at each absorption, and organic
// chemists read it by region first ("functional group region" 4000-1500
// cm-1, "fingerprint region" 1500-400 cm-1) before they read it band by
// band. So this file is built around a sampled transmittance curve
// (Beer-Lambert-style multiplicative combination of each band's own
// Gaussian dip) with the two regions shaded and labeled directly on the
// chart, and the band list below is grouped by region as expandable
// cards rather than a single flat data table. Interaction model is
// click-to-expand per card (inline detail), not a persistent shared
// detail panel. No overlap-zoom insets: overlapping bands legitimately
// merge into one deeper combined dip on a real transmittance curve,
// which is itself the correct way to show that they overlap.
// ---------------------------------------------------------------------

const REGION_SPLIT = 1500; // cm-1 — conventional functional-group/fingerprint divide
const AXIS_MIN = 400;
const AXIS_MAX = 4000;

// The 3D structure preview's frame should fit each molecule's actual
// bounding box rather than a fixed guess, so a tall or wide molecule
// doesn't get cropped or rendered too small. Computing it from this
// molecule's own atoms (the same approach FunctionalGroupsPage uses for
// its cards) fixes that for every compound rather than just one.
const FRAME_PADDING = 50;
const MIN_FRAME_WIDTH = 260;
const MIN_FRAME_HEIGHT = 160;

function computeFrameSize(atoms) {
  if (!atoms || atoms.length === 0) return { width: MIN_FRAME_WIDTH, height: MIN_FRAME_HEIGHT };
  const xs = atoms.map((a) => a.x);
  const ys = atoms.map((a) => a.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return {
    width: Math.max(MIN_FRAME_WIDTH, spanX + FRAME_PADDING * 2),
    height: Math.max(MIN_FRAME_HEIGHT, spanY + FRAME_PADDING * 2),
  };
}

const INTENSITY_DEPTH = { strong: 82, medium: 52, weak: 24, variable: 50 };
const SHAPE_SIGMA = { broad: 85, medium: 38, sharp: 14 };

function dipDepthAt(wn, band) {
  const sigma = SHAPE_SIGMA[band.shape] || 30;
  const depth = INTENSITY_DEPTH[band.intensity] || 40;
  const d = wn - band.wavenumber;
  return depth * Math.exp(-(d * d) / (2 * sigma * sigma));
}

/** Exact combined %T at one wavenumber (T_total = ΠT_i, same Beer-Lambert-
 *  style multiplicative combination sampleCurve uses for the drawn line).
 *  Used directly for marker placement so a marker sits precisely on the
 *  curve rather than snapping to whichever of the curve's ~480 sampled
 *  points happens to be closest — that approximation was visibly off for
 *  "sharp" bands, whose narrow sigma is smaller than the sample spacing. */
function combinedTransmittanceAt(wn, bands) {
  let t = 100;
  for (const b of bands) t *= (100 - dipDepthAt(wn, b)) / 100;
  return t;
}

/** Samples the same combined %T curve across the axis, for drawing the
 *  continuous line/area. Each band contributes a Gaussian-shaped
 *  absorption dip (width from its predicted `shape`, depth from its
 *  predicted `intensity`); dips combine multiplicatively, which is also
 *  why several close-together bands legitimately produce one deeper,
 *  wider combined trough rather than needing a separate "zoomed inset"
 *  the way a stick chart would. */
function sampleCurve(bands, steps = 480) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const wn = AXIS_MAX - (i / steps) * (AXIS_MAX - AXIS_MIN);
    points.push({ wn, t: combinedTransmittanceAt(wn, bands) });
  }
  return points;
}

function ConfidenceDot({ confidence, factors }) {
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.75 ? 'bg-emerald-400' : confidence >= 0.5 ? 'bg-amber-400' : 'bg-rose-400';
  const level = confidence >= 0.75 ? 'High confidence' : confidence >= 0.5 ? 'Moderate confidence' : 'Low confidence — see note';
  const tooltip = [`${level} (~${pct}%)`, ...(factors && factors.length ? factors.map((f) => `• ${f}`) : [])].join('\n');
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`} title={tooltip} />;
}

function splitReasonIntoBullets(reason) {
  if (!reason) return [];
  return reason
    .split(/\s+—\s+|:\s+|;\s+|,\s+(?=which|since|though|so\b)|\.\s+(?=\S)/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s.length > 2)
    .slice(0, 4);
}

/** Fetches the predicted IR bands from the backend (see
 *  backend/app/spectra/ir.py) whenever the structure actually changes. */
function useIrBands(atoms, bonds) {
  const [bands, setBands] = useState([]);
  const [loading, setLoading] = useState(Boolean(atoms && atoms.length > 0));
  const [error, setError] = useState(null);
  const structureKey = useMemo(() => JSON.stringify({ atoms, bonds }), [atoms, bonds]);

  useEffect(() => {
    if (!atoms || atoms.length === 0) {
      setBands([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    predictIr(atoms, bonds || [])
      .then((result) => {
        if (!cancelled) {
          setBands(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.response?.data?.message || 'Could not reach the IR prediction service.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  return { bands, loading, error };
}

/** The big transmittance-style chart. Deliberately roomy (tall viewBox,
 *  generous type) rather than a compact embed — this is meant to be the
 *  centerpiece a person actually reads, not a thumbnail. */
function TransmittanceChart({ bands, hoverKey, onHover, onToggle, expandedKeys, advanced }) {
  const gradId = useId();
  const width = 1000;
  const height = 300;
  const padL = 46;
  const padR = 24;
  const padTop = 34;
  const padBottom = 40;
  const plotW = width - padL - padR;
  const plotH = height - padTop - padBottom;
  const axisY = padTop + plotH;

  const xFor = (wn) => padL + ((AXIS_MAX - wn) / (AXIS_MAX - AXIS_MIN)) * plotW;
  const yForT = (t) => padTop + (1 - t / 100) * plotH;

  const curve = useMemo(() => sampleCurve(bands), [bands]);
  const linePath = useMemo(
    () => curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.wn).toFixed(1)} ${yForT(p.t).toFixed(1)}`).join(' '),
    [curve]
  );
  const areaPath = `${linePath} L ${xFor(AXIS_MIN).toFixed(1)} ${axisY} L ${xFor(AXIS_MAX).toFixed(1)} ${axisY} Z`;

  const splitX = xFor(REGION_SPLIT);
  const ticks = [4000, 3500, 3000, 2500, 2000, 1500, 1000, 400];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full overflow-visible" onMouseLeave={() => onHover(null)}>
      <defs>
        <linearGradient id={`${gradId}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-violet)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-violet)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Fingerprint region shading + the two region labels — the one
          organizing idea a stick chart has no equivalent for. */}
      <rect x={splitX} y={padTop} width={width - padR - splitX} height={plotH} fill="var(--color-violet)" opacity={0.045} />
      <line x1={splitX} y1={padTop} x2={splitX} y2={axisY} stroke="var(--color-violet-400, #a78bfa)" strokeWidth={1} strokeDasharray="3 4" opacity={0.5} />
      <text x={(padL + splitX) / 2} y={padTop - 12} textAnchor="middle" fontSize={10.5} fontWeight={600} letterSpacing="0.06em" fill="var(--color-lab-500)">
        FUNCTIONAL GROUP REGION
      </text>
      <text x={(splitX + width - padR) / 2} y={padTop - 12} textAnchor="middle" fontSize={10.5} fontWeight={600} letterSpacing="0.06em" fill="var(--color-violet-300, #c4b5fd)">
        FINGERPRINT REGION
      </text>

      {/* Optional %T reference lines — instrument-like detail kept out of
          the default view so the basic chart stays clean. */}
      {advanced &&
        [25, 50, 75].map((t) => (
          <g key={t}>
            <line x1={padL} y1={yForT(t)} x2={width - padR} y2={yForT(t)} stroke="var(--color-lab-800)" strokeWidth={1} strokeDasharray="2 5" />
            <text x={padL - 8} y={yForT(t) + 3} textAnchor="end" fontSize={9} fill="var(--color-lab-600)">
              {t}%
            </text>
          </g>
        ))}

      <line x1={padL} y1={axisY} x2={width - padR} y2={axisY} stroke="var(--color-lab-700)" strokeWidth={1.5} />
      <line x1={padL} y1={padTop} x2={padL} y2={axisY} stroke="var(--color-lab-800)" strokeWidth={1} />

      {ticks.map((t) => (
        <g key={t}>
          <line x1={xFor(t)} y1={axisY} x2={xFor(t)} y2={axisY + 5} stroke="var(--color-lab-700)" strokeWidth={1} />
          <text x={xFor(t)} y={axisY + 19} textAnchor="middle" fontSize={11} fill="var(--color-lab-500)" className="font-mono">
            {t}
          </text>
        </g>
      ))}
      <text x={width - padR} y={height - 6} textAnchor="end" fontSize={10.5} fill="var(--color-lab-600)">
        wavenumber (cm⁻¹)
      </text>
      <text x={padL} y={height - 6} fontSize={10.5} fill="var(--color-lab-600)">
        %T (approx.)
      </text>

      <path d={areaPath} fill={`url(#${gradId}-fill)`} />
      <path d={linePath} fill="none" stroke="var(--color-violet-300, #c4b5fd)" strokeWidth={2} strokeLinejoin="round" />

      {bands.map((b) => {
        const x = xFor(b.wavenumber);
        const t = combinedTransmittanceAt(b.wavenumber, bands);
        const y = yForT(t);
        const isActive = hoverKey === b.key || expandedKeys.has(b.key);
        const r = isActive ? 6.5 : 4.5;
        return (
          <g key={b.key}>
            {isActive && <line x1={x} y1={y} x2={x} y2={axisY} stroke="var(--color-violet-300, #c4b5fd)" strokeWidth={1} strokeDasharray="2 4" opacity={0.6} />}
            <circle
              cx={x}
              cy={y}
              r={11}
              fill="transparent"
              onMouseEnter={() => onHover(b.key)}
              onFocus={() => onHover(b.key)}
              onClick={() => onToggle(b.key)}
              tabIndex={0}
              style={{ cursor: 'pointer' }}
            />
            <circle
              cx={x}
              cy={y}
              r={r}
              fill={isActive ? 'var(--color-violet-300, #c4b5fd)' : 'var(--color-lab-950)'}
              stroke="var(--color-violet-300, #c4b5fd)"
              strokeWidth={isActive ? 0 : 1.75}
              strokeDasharray={b.intensity === 'variable' ? '2 2' : undefined}
              style={{ transition: 'r 120ms ease' }}
            />
            {isActive && (
              <g>
                <rect
                  x={Math.min(Math.max(x - 46, padL), width - padR - 92)}
                  y={y > padTop + 40 ? y - 34 : y + 12}
                  width={92}
                  height={22}
                  rx={5}
                  fill="var(--color-lab-900)"
                  stroke="var(--color-violet-400, #a78bfa)"
                  strokeOpacity={0.4}
                />
                <text
                  x={Math.min(Math.max(x, padL + 46), width - padR - 46)}
                  y={y > padTop + 40 ? y - 19 : y + 27}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  className="font-mono"
                  fill="var(--color-violet-200, #ddd6fe)"
                >
                  {b.wavenumber} cm⁻¹
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** One expandable band card. Clicking toggles inline detail — the
 *  interaction is local to the card rather than routed to a shared panel
 *  elsewhere on the page. */
function BandCard({ band, hovered, expanded, advanced, onHover, onToggle }) {
  const bullets = advanced ? splitReasonIntoBullets(band.reason) : [];
  // How tall the little intensity bar renders — strong absorptions fill it,
  // weak ones barely register, matching the same textbook intensity used
  // in the chart's dip depth.
  const intensityBarHeight = { strong: '100%', medium: '65%', weak: '32%', variable: '65%' }[band.intensity] || '50%';
  // "Variable" intensity (e.g. an alkene C=C that can be strong or nearly
  // absent depending on substitution symmetry) gets a striped fill instead
  // of a solid one, as a visual "this one's not fixed" cue. Done as a
  // plain inline style rather than a long arbitrary-value Tailwind class,
  // since a multi-stop gradient with embedded var() fallbacks is easier to
  // read and edit as a real JS object than as one unbroken class string.
  const barStyle =
    band.intensity === 'variable'
      ? {
          height: intensityBarHeight,
          backgroundImage:
            'repeating-linear-gradient(0deg, var(--color-violet-400, #a78bfa) 0px, var(--color-violet-400, #a78bfa) 3px, transparent 3px, transparent 6px)',
        }
      : { height: intensityBarHeight };

  return (
    <div
      className={`overflow-hidden rounded-lg border transition-colors ${
        expanded
          ? 'border-violet-400/50 bg-violet-400/[0.06]'
          : hovered
          ? 'border-violet-400/30 bg-lab-900/70'
          : 'border-lab-800 bg-lab-900/40 hover:border-lab-700'
      }`}
      onMouseEnter={() => onHover(band.key)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        type="button"
        onClick={() => onToggle(band.key)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <div className="flex h-7 w-1 shrink-0 items-end overflow-hidden rounded-full bg-lab-800">
          <div className={`w-full rounded-full ${band.intensity === 'variable' ? '' : 'bg-violet'}`} style={barStyle} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm font-bold text-violet-200">{band.wavenumber}</span>
            <span className="text-[10px] text-lab-500">cm⁻¹</span>
            <span className="truncate text-xs font-medium text-lab-200">{band.label}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9.5px] uppercase tracking-wide text-lab-500">
            <span>{band.intensity}</span>
            <span className="opacity-40">·</span>
            <span>{band.shape}</span>
            <span className="opacity-40">·</span>
            <span className="normal-case">range {band.range[0]}–{band.range[1]} cm⁻¹</span>
          </div>
        </div>
        {advanced && <ConfidenceDot confidence={band.confidence} factors={band.confidenceFactors} />}
        <ChevronDown size={14} className={`shrink-0 text-lab-600 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="border-t border-violet-400/20 px-3.5 py-2.5 text-[11px] leading-relaxed text-lab-400">
          {advanced ? (
            bullets.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4">
                {bullets.map((b, bi) => (
                  <li key={bi}>{b}</li>
                ))}
              </ul>
            )
          ) : (
            band.reason && <p>{band.reason}</p>
          )}
          {advanced && typeof band.confidence === 'number' && (
            <div className="mt-2 flex items-center gap-1.5 border-t border-violet-400/10 pt-2 text-[10.5px] text-lab-500">
              <ConfidenceDot confidence={band.confidence} factors={band.confidenceFactors} />
              Confidence ~{Math.round(band.confidence * 100)}%
              {band.confidenceFactors && band.confidenceFactors.length > 0 ? ` — ${band.confidenceFactors[0]}` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RegionGroup({ title, subtitle, bands, hoverKey, expandedKeys, advanced, onHover, onToggle }) {
  if (bands.length === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-lab-300">{title}</h4>
        <span className="text-[10.5px] text-lab-600">{subtitle}</span>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {bands.map((b) => (
          <BandCard
            key={b.key}
            band={b}
            hovered={hoverKey === b.key}
            expanded={expandedKeys.has(b.key)}
            advanced={advanced}
            onHover={onHover}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

/** Predicted IR absorption spectrum for a compound's structure — a
 *  transmittance-style curve plus a functional-group/fingerprint region
 *  breakdown. Works for any compound with a structure_2d, since the
 *  prediction is computed from atoms/bonds rather than looked up. */
export default function IRPanel({ atoms, bonds }) {
  const [advanced, setAdvanced] = useState(false);
  const [hoverKey, setHoverKey] = useState(null);
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());

  const toggleExpanded = (key) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const { bands, loading, error } = useIrBands(atoms, bonds);

  const activeKey = hoverKey || (expandedKeys.size === 1 ? [...expandedKeys][0] : null);
  const activeBand = activeKey ? bands.find((b) => b.key === activeKey) : null;
  const highlightAtomIds = activeBand ? new Set(activeBand.atomIds || []) : null;
  const hasStructure = atoms && atoms.length > 0 && atoms.every((a) => typeof a.x === 'number' && typeof a.y === 'number');

  const functionalGroupBands = useMemo(() => bands.filter((b) => b.wavenumber >= REGION_SPLIT), [bands]);
  const fingerprintBands = useMemo(() => bands.filter((b) => b.wavenumber < REGION_SPLIT), [bands]);

  const frameSize = useMemo(() => computeFrameSize(atoms), [atoms]);
  // Rendered pixel height follows the frame's own aspect ratio (against a
  // typical content width) rather than a flat guess, so a tall molecule gets
  // a taller box instead of being squeezed into the same 220px every time.
  const previewHeight = Math.min(360, Math.max(190, Math.round((frameSize.height / frameSize.width) * 640)));

  if (!atoms || atoms.length === 0) {
    return <p className="text-sm text-lab-500">No structure available to predict an IR spectrum from.</p>;
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-400/5 p-3.5 text-[11px] leading-relaxed text-rose-300">
        <AlertTriangle size={14} className="shrink-0" />
        {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-violet-400/15 bg-lab-900/30 p-8 text-xs text-lab-500">
        <Loader2 size={14} className="animate-spin" />
        Predicting IR spectrum…
      </div>
    );
  }

  if (bands.length === 0) {
    return (
      <p className="text-sm text-lab-500">
        No IR-active functional groups found — this looks like an ionic or purely inorganic species rather than a
        covalent molecule with recognizable stretching/bending modes.
      </p>
    );
  }

  return (
    <div className="space-y-5 rounded-2xl border border-violet-400/15 bg-gradient-to-b from-violet-400/[0.04] to-transparent p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-sm font-semibold text-lab-100">Predicted IR spectrum</h3>
          <p className="text-[11px] text-lab-500">Click a marker or a band below to see why it absorbs there</p>
        </div>
        <div className="inline-flex items-center gap-0.5 rounded-full border border-violet-400/30 bg-lab-900/60 p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setAdvanced(false)}
            aria-pressed={!advanced}
            className={`rounded-full px-3 py-1 font-medium transition-colors ${
              !advanced ? 'bg-violet text-lab-950' : 'text-lab-400 hover:text-lab-200'
            }`}
          >
            Basic
          </button>
          <button
            type="button"
            onClick={() => setAdvanced(true)}
            aria-pressed={advanced}
            className={`rounded-full px-3 py-1 font-medium transition-colors ${
              advanced ? 'bg-violet text-lab-950' : 'text-lab-400 hover:text-lab-200'
            }`}
          >
            Advanced
          </button>
        </div>
      </div>

      <div className="flex items-start gap-2.5 rounded-xl border border-violet-400/20 bg-violet-400/[0.05] p-3.5 text-[11px] leading-relaxed text-lab-300">
        <Info size={14} className="mt-0.5 shrink-0 text-violet-300" />
        {advanced ? (
          <span>
            The curve is a teaching-level approximation, not a lab measurement: each predicted band contributes a
            Gaussian dip (width from its shape — sharp/medium/broad — depth from its intensity), and overlapping
            dips combine multiplicatively the same way real overlapping absorptions do, so bands that sit close
            together legitimately merge into one deeper trough rather than needing to be pulled apart. The dashed
            reference lines mark 25/50/75% T. Every functional group present is reported as <strong>one</strong>{' '}
            band, matching a real spectrum — three separate alcohol groups still show one O-H stretch region, not
            three. The vertical divider at 1500 cm⁻¹ splits the conventional <strong>functional group region</strong>{' '}
            (bonds to H, and multiple/triple bonds) from the busier <strong>fingerprint region</strong> (mostly
            single-bond stretches and ring/skeletal vibrations) — chemists usually read the two differently, so the
            band list below is grouped the same way. The dot beside a band is a rough confidence indicator; hover it
            for the specific factors (hydrogen-bond sensitivity, textbook range width, whether intensity itself is
            structure-dependent).
          </span>
        ) : (
          <span>
            The curve shows where this compound is predicted to absorb infrared light — each dip is one functional
            group's characteristic vibration. Click a dip, or a band below, to see why it sits where it does.
          </span>
        )}
      </div>

      <div className="rounded-xl border border-lab-800 bg-lab-950/50 p-4">
        <TransmittanceChart
          bands={bands}
          hoverKey={hoverKey}
          onHover={setHoverKey}
          onToggle={toggleExpanded}
          expandedKeys={expandedKeys}
          advanced={advanced}
        />
      </div>

      {hasStructure && (
        <div className="rounded-xl border border-lab-800 bg-lab-950/40 p-4">
          <div className="grid grid-cols-1 gap-3">
            <div>
              <div className="mb-1.5 text-[9.5px] font-medium uppercase tracking-wide text-lab-600">3D structure</div>
              <ThreeStructurePreview
                atoms={atoms}
                bonds={bonds}
                height={previewHeight}
                highlightAtomIds={highlightAtomIds}
                onAtomHover={(atomId) => {
                  const match = bands.find((b) => (b.atomIds || []).includes(atomId));
                  if (match) setHoverKey(match.key);
                }}
                onAtomLeave={() => setHoverKey(null)}
              />
            </div>
          </div>
          {!activeBand && (
            <p className="mt-2 flex items-center justify-center gap-1.5 text-[10.5px] text-lab-600">
              <MousePointerClick size={12} /> Hover an atom in the structure to see which band it contributes to
            </p>
          )}
        </div>
      )}

      <div className="space-y-5">
        <RegionGroup
          title="Functional group region"
          subtitle="4000–1500 cm⁻¹ — mostly X–H stretches and multiple/triple bonds"
          bands={functionalGroupBands}
          hoverKey={hoverKey}
          expandedKeys={expandedKeys}
          advanced={advanced}
          onHover={setHoverKey}
          onToggle={toggleExpanded}
        />
        <RegionGroup
          title="Fingerprint region"
          subtitle="1500–400 cm⁻¹ — single-bond and skeletal vibrations, often molecule-specific"
          bands={fingerprintBands}
          hoverKey={hoverKey}
          expandedKeys={expandedKeys}
          advanced={advanced}
          onHover={setHoverKey}
          onToggle={toggleExpanded}
        />
      </div>
    </div>
  );
}