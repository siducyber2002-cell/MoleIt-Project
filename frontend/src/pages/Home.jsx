import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  PenTool,
  Library,
  NotebookPen,
  Box,
  Atom,
  BookOpen,
  ArrowRight,
  ArrowDown,
  Star,
  FlaskConical,
  Activity,
  CheckCircle2,
} from 'lucide-react';
import HeroMolecule from '../components/home/HeroMolecule';
import HeroMarqueeGallery from '../components/HeroMarqueeGallery';
import { Reveal, StaggerGroup, StaggerItem, Word, InlineReveal, EASE } from '../components/motion/ScrollReveal';
import MoleItLogo from '../components/MoleItLogo';
import QuantumOrbitAnimation from '../components/QuantumOrbitAnimation';
import BrandVideoSection from '../components/BrandVideoSection';
import RoadLine from '../components/home/RoadLine';
import CursorDot from '../components/home/CursorDot';
import ReasonStack from '../components/home/ReasonStack';
import { SectionLabel, Mark } from '../components/home/primitives';
import '../components/home/indisea.css';

// A handful of visually interesting compounds for the hero's live 3D
// showpiece — one is picked at random on every load.
const HERO_MOLECULES = [
  {
    name: 'Caffeine',
    molBlock: `
     RDKit          3D

 24 25  0  0  0  0  0  0  0  0999 V2000
   -3.2647    0.0738   -0.9201 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.1471    0.4527   -0.0935 N   0  0  0  0  0  0  0  0  0  0  0  0
   -2.1930    1.2725    1.0031 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.0012    1.4261    1.5456 N   0  0  0  0  0  0  0  0  0  0  0  0
   -0.1742    0.6772    0.7642 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.8468    0.0670   -0.2506 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.2167   -0.7720   -1.2091 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.8324   -1.3174   -2.1202 O   0  0  0  0  0  0  0  0  0  0  0  0
    1.1589   -0.8995   -0.9954 N   0  0  0  0  0  0  0  0  0  0  0  0
    1.8907   -0.2845    0.0423 C   0  0  0  0  0  0  0  0  0  0  0  0
    3.1085   -0.4586    0.1487 O   0  0  0  0  0  0  0  0  0  0  0  0
    1.1802    0.5209    0.9330 N   0  0  0  0  0  0  0  0  0  0  0  0
    1.8584    1.1895    2.0282 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.9180   -1.7314   -1.9083 C   0  0  0  0  0  0  0  0  0  0  0  0
   -3.0737    0.4138   -1.9410 H   0  0  0  0  0  0  0  0  0  0  0  0
   -4.1753    0.5437   -0.5398 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.3698   -1.0134   -0.8864 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.1089    1.7266    1.3605 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.9300    0.9738    2.0370 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.4264    0.8516    2.9756 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.7207    2.2707    1.9271 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.4037   -2.5316   -1.3401 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.6957   -1.1226   -2.3812 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.2954   -2.1781   -2.6873 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  1  0
  3  4  2  0
  4  5  1  0
  5  6  2  0
  6  7  1  0
  7  8  2  0
  7  9  1  0
  9 10  1  0
 10 11  2  0
 10 12  1  0
 12 13  1  0
  9 14  1  0
  6  2  1  0
 12  5  1  0
  1 15  1  0
  1 16  1  0
  1 17  1  0
  3 18  1  0
 13 19  1  0
 13 20  1  0
 13 21  1  0
 14 22  1  0
 14 23  1  0
 14 24  1  0
M  END
`,
  },
  {
    name: 'Aspirin',
    molBlock: `
     RDKit          3D

 21 21  0  0  0  0  0  0  0  0999 V2000
   -2.9451    0.6786   -1.4413 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.6850   -0.0433   -1.0671 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2577   -1.0322   -1.6481 O   0  0  0  0  0  0  0  0  0  0  0  0
   -1.1178    0.5875    0.0337 O   0  0  0  0  0  0  0  0  0  0  0  0
    0.0898    0.0036    0.4233 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0235   -0.8940    1.4964 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.1851   -1.5071    1.9623 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.4106   -1.2174    1.3659 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.4767   -0.3065    0.3074 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.3170    0.3250   -0.1724 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.4999    1.2962   -1.2801 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.5488    1.4995   -1.8672 O   0  0  0  0  0  0  0  0  0  0  0  0
    0.4029    2.0044   -1.5977 O   0  0  0  0  0  0  0  0  0  0  0  0
   -2.7193    1.7213   -1.6787 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.3819    0.2085   -2.3270 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.6647    0.6168   -0.6213 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.9319   -1.1218    1.9612 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.1346   -2.2132    2.7875 H   0  0  0  0  0  0  0  0  0  0  0  0
    3.3180   -1.6980    1.7245 H   0  0  0  0  0  0  0  0  0  0  0  0
    3.4446   -0.0882   -0.1416 H   0  0  0  0  0  0  0  0  0  0  0  0
    0.7162    2.5886   -2.3203 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  2  0
  2  4  1  0
  4  5  1  0
  5  6  2  0
  6  7  1  0
  7  8  2  0
  8  9  1  0
  9 10  2  0
 10 11  1  0
 11 12  2  0
 11 13  1  0
 10  5  1  0
  1 14  1  0
  1 15  1  0
  1 16  1  0
  6 17  1  0
  7 18  1  0
  8 19  1  0
  9 20  1  0
 13 21  1  0
M  END
`,
  },
  {
    name: 'Glucose',
    molBlock: `
     RDKit          3D

 24 24  0  0  0  0  0  0  0  0999 V2000
   -1.8169   -0.6649   -1.4675 O   0  0  0  0  0  0  0  0  0  0  0  0
   -0.5880   -1.1739   -1.9705 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.6502   -0.6994   -1.1851 C   0  0  1  0  0  0  0  0  0  0  0  0
    0.8107    0.7210   -1.3567 O   0  0  0  0  0  0  0  0  0  0  0  0
    0.7156    1.4970   -0.1737 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.5064    2.8483   -0.5749 O   0  0  0  0  0  0  0  0  0  0  0  0
   -0.4582    1.0750    0.7161 C   0  0  2  0  0  0  0  0  0  0  0  0
   -0.6005    1.9350    1.8579 O   0  0  0  0  0  0  0  0  0  0  0  0
   -0.2867   -0.3760    1.1826 C   0  0  1  0  0  0  0  0  0  0  0  0
   -1.5774   -1.0167    1.2095 O   0  0  0  0  0  0  0  0  0  0  0  0
    0.6646   -1.1766    0.2809 C   0  0  2  0  0  0  0  0  0  0  0  0
    1.9955   -1.0205    0.8056 O   0  0  0  0  0  0  0  0  0  0  0  0
   -1.9830   -1.0747   -0.5917 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.5115   -0.8322   -3.0080 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.6473   -2.2673   -1.9785 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.5219   -1.1371   -1.6878 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.6644    1.4801    0.3723 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.0852    2.7673   -1.3445 H   0  0  0  0  0  0  0  0  0  0  0  0
   -1.3941    1.1915    0.1587 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.4134    2.8372    1.5267 H   0  0  0  0  0  0  0  0  0  0  0  0
    0.0856   -0.3989    2.2145 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.0913   -0.5246    1.8822 H   0  0  0  0  0  0  0  0  0  0  0  0
    0.4288   -2.2459    0.3320 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.5927   -1.5931    0.2922 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  1  0
  3  4  1  0
  4  5  1  0
  5  6  1  0
  5  7  1  0
  7  8  1  0
  7  9  1  0
  9 10  1  0
  9 11  1  0
 11 12  1  0
 11  3  1  0
  1 13  1  0
  2 14  1  0
  2 15  1  0
  3 16  1  6
  5 17  1  0
  6 18  1  0
  7 19  1  6
  8 20  1  0
  9 21  1  1
 10 22  1  0
 11 23  1  6
 12 24  1  0
M  END
`,
  },
  {
    name: 'Benzene',
    molBlock: `
     RDKit          3D

 12 12  0  0  0  0  0  0  0  0999 V2000
   -0.4777    0.7800   -0.2680 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.8723    0.1618    0.9185 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0864   -0.3780    1.7759 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.4396   -0.2996    1.4469 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.8342    0.3186    0.2605 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.8756    0.8584   -0.5970 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2245    1.2006   -0.9360 H   0  0  0  0  0  0  0  0  0  0  0  0
   -1.9266    0.1007    1.1748 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.2211   -0.8597    2.7003 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.1864   -0.7202    2.1150 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.8885    0.3797    0.0042 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.1830    1.3401   -1.5213 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  2  0
  3  4  1  0
  4  5  2  0
  5  6  1  0
  6  1  2  0
  1  7  1  0
  2  8  1  0
  3  9  1  0
  4 10  1  0
  5 11  1  0
  6 12  1  0
M  END
`,
  },
  {
    name: 'Ibuprofen',
    molBlock: `
     RDKit          3D

 33 33  0  0  0  0  0  0  0  0999 V2000
   -2.7745    2.0035    0.5659 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.0259    1.7164    1.8680 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.5618    0.4427    2.5229 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.4934    1.7004    1.6887 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0632    0.6330    0.7769 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.4305   -0.6187    1.2844 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.9431   -1.6078    0.4409 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.1043   -1.3657   -0.9301 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.7386   -0.1101   -1.4361 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.2261    0.8778   -0.5915 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.6611   -2.4514   -1.8324 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.9898   -2.0392   -2.4699 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.6665   -2.8577   -2.9040 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.5707   -2.3997   -4.0319 O   0  0  0  0  0  0  0  0  0  0  0  0
   -0.1817   -3.8236   -2.4913 O   0  0  0  0  0  0  0  0  0  0  0  0
   -3.8415    2.1544    0.7633 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.6860    1.1766   -0.1459 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.3939    2.9124    0.0886 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.2477    2.5458    2.5535 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.6236    0.5559    2.7676 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.4675   -0.4255    1.8630 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.0280    0.2281    3.4545 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.0193    1.6001    2.6745 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.1667    2.6817    1.3183 H   0  0  0  0  0  0  0  0  0  0  0  0
    0.3174   -0.8349    2.3445 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.2135   -2.5716    0.8671 H   0  0  0  0  0  0  0  0  0  0  0  0
    0.8451    0.1117   -2.4968 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.0483    1.8423   -1.0131 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.8706   -3.3514   -1.2381 H   0  0  0  0  0  0  0  0  0  0  0  0
    3.3941   -2.8552   -3.0793 H   0  0  0  0  0  0  0  0  0  0  0  0
    3.7312   -1.7887   -1.7031 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.8803   -1.1687   -3.1263 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.7836   -3.9506   -3.2540 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  1  0
  2  4  1  0
  4  5  1  0
  5  6  1  0
  6  7  2  0
  7  8  1  0
  8  9  2  0
  9 10  1  0
  8 11  1  0
 11 12  1  0
 11 13  1  0
 13 14  2  0
 13 15  1  0
 10  5  2  0
  1 16  1  0
  1 17  1  0
  1 18  1  0
  2 19  1  0
  3 20  1  0
  3 21  1  0
  3 22  1  0
  4 23  1  0
  4 24  1  0
  6 25  1  0
  7 26  1  0
  9 27  1  0
 10 28  1  0
 11 29  1  0
 12 30  1  0
 12 31  1  0
 12 32  1  0
 15 33  1  0
M  END
`,
  },
];

// Atom colours for the hero molecule, matched to the page palette:
// charcoal carbon, sky-blue nitrogen, orange oxygen, warm-grey hydrogen.
const HERO_PALETTE = {
  C: '#262626',
  N: '#3bbff7',
  O: '#eea02b',
  H: '#cfc9c1',
  default: '#8a8681',
};

// Two mini "spectra" — one standing in for ¹H NMR, one for ¹³C NMR, the
// two predictions the engine actually produces today.
const BIG_H1_PEAKS = [18, 46, 82, 60, 108, 68, 36, 92, 52, 24];
const BIG_C13_PEAKS = [32, 76, 104, 56, 88, 40, 66];

const SPECTROSCOPY_TABS = [
  { key: '1H', label: '¹H NMR', ready: true },
  { key: '13C', label: '¹³C NMR', ready: true },
  { key: 'IR', label: 'IR', ready: true },
  { key: 'MS', label: 'MS', ready: false },
  { key: 'UVVis', label: 'UV-Vis', ready: false },
];

const CAPABILITY_ITEMS = [
  { label: 'NMR (¹H / ¹³C)', ready: true },
  { label: 'IR', ready: true },
  { label: 'MS', ready: false },
  { label: 'UV-Vis', ready: false },
];

const FEATURES = [
  {
    icon: PenTool,
    title: 'Draw Lab',
    desc: 'Place atoms, cycle bond order, add lone pairs and formal charges — a real chemistry canvas, not a whiteboard.',
    to: '/draw',
    cta: 'Start Drawing',
    rotate: -7,
  },
  {
    icon: Box,
    title: '3D Viewer',
    desc: 'Rotate, zoom and inspect your molecules in stunning 3D, powered by a real interactive rendering engine.',
    to: '/draw',
    cta: 'Open 3D Viewer',
    rotate: -2.5,
  },
  {
    icon: Library,
    title: 'Library',
    desc: 'Explore a curated library of famous compounds, from water to aspirin, each with a real molecular graph.',
    to: '/library',
    cta: 'Browse Library',
    rotate: 2.5,
  },
  {
    icon: NotebookPen,
    title: 'Notes',
    desc: "Save notes alongside any compound, and keep every molecule you've drawn organized and easy to revisit.",
    to: '/notes',
    cta: 'View Notes',
    rotate: 7,
  },
];

const STATS = [
  { number: '10K+', label: 'Compounds in Library' },
  { number: '50K+', label: 'Molecules Drawn' },
  { number: '5K+', label: 'Active Students' },
  { number: '99.9%', label: 'Uptime' },
];

const AVATARS = [
  { initials: 'SD', cls: 'bg-[#3bbff7] text-[#262626]' },
  { initials: 'SM', cls: 'bg-[#eea02b] text-[#262626]' },
  { initials: 'RK', cls: 'bg-[#262626] text-[#fafaf9]' },
  { initials: 'AN', cls: 'bg-[#fafaf9] text-[#262626]' },
];

// Splits a string into per-word reveal spans (for kinetic headlines). Must
// sit inside a parent that drives the "hidden"/"show" variants.
function Words({ children }) {
  return String(children)
    .split(' ')
    .map((w, i) => (
      <Fragment key={`${w}-${i}`}>
        {i > 0 && ' '}
        <Word>{w}</Word>
      </Fragment>
    ));
}

function BigSpectrum({ peaks, color, height = 170 }) {
  const width = 640;
  const axisY = height - 34;
  const gap = width / (peaks.length + 1);
  const ticks = [10, 8, 6, 4, 2, 0];
  const xForTick = (t) => (1 - t / 10) * width;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full overflow-visible">
      <line x1={0} y1={axisY} x2={width} y2={axisY} stroke="rgba(38,38,38,0.25)" strokeWidth={1.5} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={xForTick(t)} y1={axisY} x2={xForTick(t)} y2={axisY + 5} stroke="rgba(38,38,38,0.35)" />
          <text x={xForTick(t)} y={axisY + 20} textAnchor="middle" fontSize={12} fill="#8a8681" className="font-mono">
            {t}
          </text>
        </g>
      ))}
      <text x={width} y={height - 4} textAnchor="end" fontSize={12} fill="#8a8681">ppm</text>
      {peaks.map((h, i) => (
        <line
          key={i}
          x1={gap * (i + 1)}
          y1={axisY}
          x2={gap * (i + 1)}
          y2={axisY - h}
          stroke={color}
          strokeWidth={4}
          strokeLinecap="round"
          className="spectrum-peak"
          style={{ animationDelay: `${i * 0.1}s` }}
        />
      ))}
    </svg>
  );
}

// A believable IR transmittance trace: mostly flat near the top, with
// a handful of downward dips of varying width and depth standing in
// for absorption bands.
function IRLinePreview() {
  const d = [
    'M0,9',
    'L22,9',
    'L27,9 L33,42 L39,9',
    'L58,9',
    'L64,9 L69,28 L74,14 L79,30 L84,12 L89,9',
    'L112,9',
    'L119,9 L125,21 L131,9',
    'L152,9',
    'L158,9 Q166,9 172,32 Q178,42 184,32 Q190,9 196,9',
    'L214,9',
    'L221,9 L228,53 L235,9',
    'L256,9',
    'L262,9 L268,24 L274,9',
    'L300,9',
  ].join(' ');

  return (
    <svg viewBox="0 0 300 60" className="h-[64px] w-full overflow-visible">
      <line x1={0} y1={9} x2={300} y2={9} stroke="rgba(38,38,38,0.18)" strokeWidth={1} strokeDasharray="2 3" />
      <path d={d} fill="none" stroke="#eea02b" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" pathLength="1" className="ir-draw" />
    </svg>
  );
}

// Small "instrument console" readout next to the ready spectra.
function SpectrometerReadout({ activeTab }) {
  const color = activeTab === '1H' ? '#3bbff7' : '#eea02b';
  const fieldLabel = activeTab === '1H' ? '400.13 MHz' : '100.61 MHz';

  return (
    <div className="hidden w-[150px] shrink-0 flex-col items-center justify-center gap-3 rounded-2xl bg-[#f0edea] p-3 sm:flex">
      <div className="relative h-20 w-20">
        <svg viewBox="0 0 100 100" className="h-full w-full">
          <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(38,38,38,0.12)" strokeWidth="4" />
          <circle
            cx="50" cy="50" r="44" fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
            strokeDasharray="70 210" className="dial-sweep"
          />
          <circle cx="50" cy="50" r="3.5" fill={color} className="dial-pulse" />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold uppercase tracking-wide text-[#8a8681]">
          scan
        </span>
      </div>
      <div className="text-center">
        <p className="font-mono text-sm font-semibold text-[#262626]">{fieldLabel}</p>
        <p className="mt-0.5 text-xs text-[#8a8681]">field strength</p>
      </div>
    </div>
  );
}

function CapabilityChecklist() {
  return (
    <div className="ix-panel flex w-full flex-col justify-center gap-2.5 sm:w-44">
      {CAPABILITY_ITEMS.map((item) => (
        <div key={item.label} className="flex items-center gap-2">
          {item.ready ? (
            <CheckCircle2 size={15} className="shrink-0 text-[#1c9bd6]" />
          ) : (
            <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border border-[#eea02b] text-[7px] font-bold text-[#b26a00]">
              …
            </span>
          )}
          <span className={`text-xs font-medium ${item.ready ? 'text-[#262626]' : 'text-[#8a8681]'}`}>{item.label}</span>
          {!item.ready && (
            <span className="ml-auto text-[9px] font-bold uppercase tracking-wide text-[#b26a00]">Soon</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const rootRef = useRef(null);

  const [heroMolecule] = useState(
    () => HERO_MOLECULES[Math.floor(Math.random() * HERO_MOLECULES.length)]
  );

  // Flag <html> as "light homepage" for as long as this page is mounted:
  // paints the warm-paper canvas behind everything (incl. overscroll).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-indisea');
    return () => root.classList.remove('theme-indisea');
  }, []);

  const scrollTo = (id) => (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div ref={rootRef} className="ix">
      {/* ruler + the blue road that follows the scroll */}
      <div className="ix-probe" data-road="probe" aria-hidden="true" />
      <RoadLine rootRef={rootRef} />
      <CursorDot />

      <main className="ix-main">
        {/* ── 01 / HERO — Mole It logo + tagline, orbiting atom inside the ring ── */}
        <section className="ix-hero" id="top">
          <div className="ix-hero__copy">
            <Reveal trigger="mount" direction="none">
              <SectionLabel n={1}>Hero</SectionLabel>
            </Reveal>

            <Reveal trigger="mount" delay={0.1} duration={0.9} className="mt-[clamp(28px,5vh,56px)]">
              <MoleItLogo size="hero" tone="light" />
            </Reveal>

            <StaggerGroup
              as="p"
              trigger="mount"
              stagger={0.03}
              delayChildren={0.45}
              className="ix-hero__tagline"
            >
              <Words>Chemistry stops being flat here —</Words>{' '}
              <Mark>
                <Words>draw it, rotate it, take it apart,</Words>
              </Mark>{' '}
              <Words>and actually see why it works.</Words>
            </StaggerGroup>

            <a href="#wall" onClick={scrollTo('wall')} className="ix-scroll">
              Scroll <ArrowDown size={14} />
            </a>
          </div>

          {/* the ring the road grows out of — the atom sits inside it */}
          <Reveal direction="none" trigger="mount" delay={0.2} className="ix-ring" data-road="ring">
            <div className="ix-ring__orbit">
              <QuantumOrbitAnimation size="100%" tone="light" />
            </div>
          </Reveal>
        </section>

        {/* ── 02 / marquee gallery ── */}
        <section className="ix-sec ix-sec--wall" id="wall">
          {/* bend 1: first turn — left, same spot the old fixed gutter used to sit */}
          <div
            className="ix-bend"
            data-road="bend"
            style={{ top: 'clamp(54px, 9vh, 92px)', left: '30vw' }}
          />
          <div className="ix-sec__head">
            <SectionLabel n={2}>Nine tools, live</SectionLabel>
          </div>
          <Reveal amount={0.1} distance={20}>
            <HeroMarqueeGallery />
          </Reveal>
        </section>

        {/* ── 03 / Spectroscopy Engine ── */}
        <section className="ix-sec" id="spectra">
          {/* bend 2: turn back right, not as far as the ring */}
          <div
            className="ix-bend"
            data-road="bend"
            style={{ top: 'clamp(30px, 5vh, 60px)', left: '50vw' }}
          />
          <div className="ix-grid">
            <div className="ix-grid__label">
              <SectionLabel n={3}>
                Spectroscopy Engine <span className="ix-new">NEW</span>
              </SectionLabel>
            </div>
            <div className="min-w-0">
              <SpectroscopyHero heroMolecule={heroMolecule} />
            </div>
          </div>
        </section>

        {/* ── 04 / the molecular study lab (main hero + 3D showpiece) ── */}
        <section className="ix-sec" id="lab">
          <div className="ix-grid">
            <div className="ix-grid__label">
              <SectionLabel n={4}>Draw it. Understand it. Explore it.</SectionLabel>
            </div>

            <div className="min-w-0">
              <StaggerGroup amount={0.1} stagger={0.12}>
                <motion.h1
                  variants={{ hidden: {}, show: { transition: { staggerChildren: 0.045, delayChildren: 0.1 } } }}
                  className="ix-h1"
                >
                  <Words>A molecular</Words>{' '}
                  <Mark chip>
                    <InlineReveal>study lab,</InlineReveal>
                  </Mark>
                  <br />
                  <Words>built around the</Words>{' '}
                  <Mark chip delay={0.25}>
                    <InlineReveal>draw.</InlineReveal>
                  </Mark>
                </motion.h1>

                <StaggerItem as="p" className="ix-body mt-[clamp(18px,3vh,30px)]">
                  Sketch atoms and bonds directly on canvas, rotate them in 3D, and
                  study a library of famous compounds — all backed by a real
                  molecular graph, not a picture.
                </StaggerItem>

                <StaggerItem as="div" className="ix-actions mt-[clamp(20px,3.6vh,36px)]">
                  <Link to="/draw" className="ix-btn">
                    <FlaskConical size={19} /> Open Draw Lab
                    <ArrowRight size={18} />
                  </Link>
                  <Link to="/library" className="ix-btn ix-btn--ghost">
                    <BookOpen size={19} /> Browse Compounds
                  </Link>
                </StaggerItem>

                <StaggerItem as="div" className="mt-[clamp(20px,3.4vh,34px)] flex items-center gap-4">
                  <div className="flex -space-x-2.5">
                    {AVATARS.map((a, i) => (
                      <span key={a.initials} className={`ix-avatar ${a.cls}`} style={{ zIndex: 4 - i }}>
                        {a.initials}
                      </span>
                    ))}
                  </div>
                  <div>
                    <div className="flex items-center gap-0.5 text-[#eea02b]">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} size={16} fill="currentColor" strokeWidth={0} />
                      ))}
                    </div>
                    <p className="mt-0.5 text-[clamp(12px,1vw,14px)] text-[#4e4e4d]">
                      Loved by 5,000+ students &amp; researchers
                    </p>
                  </div>
                </StaggerItem>

                <StaggerItem as="p" className="ix-credit mt-[clamp(14px,2.4vh,24px)] hidden sm:block">
                  Developed and Designed by Siddhartha Dhar and Subhranil Manna
                </StaggerItem>
              </StaggerGroup>

              {/* live 3D molecule, dressed in floating labels */}
              <div className="relative mt-[clamp(44px,8vh,84px)]">
                <motion.div
                  initial={{ opacity: 0, scale: 0.94 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true, amount: 0.2 }}
                  transition={{ duration: 0.8, ease: EASE }}
                >
                  <HeroMolecule
                    molBlock={heroMolecule.molBlock}
                    name={heroMolecule.name}
                    palette={HERO_PALETTE}
                  />
                </motion.div>

                <Reveal
                  direction="left"
                  delay={0.35}
                  amount={0.2}
                  className="ix-chip absolute -top-3 left-2 z-20 sm:-top-4 sm:left-4"
                >
                  <div className="ix-chip__icon bg-[#3bbff7]/25 text-[#127aad]">
                    <Box size={20} />
                  </div>
                  <div>
                    <p className="ix-chip__title">Rotate in 3D</p>
                    <p className="ix-chip__sub hidden sm:block">Inspect from any angle</p>
                  </div>
                </Reveal>

                <Reveal
                  direction="right"
                  delay={0.5}
                  amount={0.2}
                  className="ix-chip absolute -top-3 right-2 z-20 sm:-top-4 sm:right-4"
                >
                  <div className="ix-chip__icon bg-[#eea02b]/25 text-[#a86200]">
                    <Atom size={20} />
                  </div>
                  <div>
                    <p className="ix-chip__title">
                      <span className="ix-pulse" />
                      Real-time Bonds
                    </p>
                    <p className="ix-chip__sub hidden sm:block">See connections come alive</p>
                  </div>
                </Reveal>

                <Reveal
                  direction="up"
                  delay={0.65}
                  amount={0.2}
                  as={Link}
                  to="/library"
                  className="ix-chip absolute -bottom-3 right-2 z-20 transition hover:-translate-y-0.5 sm:-bottom-4 sm:right-4"
                >
                  <div className="ix-chip__icon bg-[#3bbff7]/25 text-[#127aad]">
                    <BookOpen size={20} />
                  </div>
                  <div>
                    <p className="ix-chip__title">Explore Library</p>
                    <p className="ix-chip__sub hidden sm:block">Thousands of compounds</p>
                  </div>
                </Reveal>
              </div>
            </div>
          </div>
        </section>

        {/* ── 05 / brand reel: full-bleed looping video + chemist quotes ── */}
        <section className="ix-sec" id="reel">
          <div className="ix-sec__head">
            <SectionLabel n={5}>Brand reel</SectionLabel>
          </div>
          <BrandVideoSection />
        </section>

        {/* ── 06 / feature cards + stats ── */}
        <section className="ix-sec" id="features">
          {/* bend 3: turn left again, further than bend 1 */}
          <div
            className="ix-bend"
            data-road="bend"
            style={{ top: 'clamp(30px, 5vh, 60px)', left: '18vw' }}
          />
          <div className="ix-sec__head">
            <SectionLabel n={6}>What you get</SectionLabel>
          </div>

          <StaggerGroup as="div" amount={0.2} stagger={0.1} className="ix-cards">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                className="h-full"
                variants={{
                  hidden: { opacity: 0, y: 70, rotate: f.rotate, scale: 0.9 },
                  show: { opacity: 1, y: 0, rotate: 0, scale: 1, transition: { duration: 0.65, ease: EASE } },
                }}
              >
                <FeatureCard n={String(i + 1).padStart(2, '0')} {...f} />
              </motion.div>
            ))}
          </StaggerGroup>

          <StaggerGroup as="div" amount={0.3} stagger={0.08} className="ix-stats">
            {STATS.map((s) => (
              <StaggerItem key={s.label} className="ix-stat">
                <div className="ix-stat__num">{s.number}</div>
                <div className="ix-stat__label">{s.label}</div>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </section>

        {/* ── 07 / why open the Symmetry Lab — overlapping reason cards ──
             Deliberately breaks from the label-left/content-right .ix-grid
             every other section uses: everything here hugs the left edge. */}
        <section className="ix-sec ix-symlab" id="symmetry-lab">
          <div className="ix-symlab__head">
            <SectionLabel n={7}>Why open the Symmetry Lab</SectionLabel>
            <StaggerGroup amount={0.3} stagger={0.1}>
              <motion.h2
                variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } } }}
                className="ix-h2 mt-[clamp(16px,2.6vh,26px)]"
              >
                <Words>Group theory, made</Words>{' '}
                <Mark chip delay={0.15}>
                  <InlineReveal>visible.</InlineReveal>
                </Mark>
              </motion.h2>
              <StaggerItem as="p" className="ix-body mt-[clamp(18px,3vh,30px)]">
                Paste a structure, find its point group, and watch every
                symmetry operation play out in 3D — here's what that's
                actually good for.
              </StaggerItem>
              <StaggerItem as="div">
                <a
                  href="#symmetry-lab-cards"
                  onClick={scrollTo('symmetry-lab-cards')}
                  className="ix-scroll"
                >
                  Scroll <ArrowDown size={14} />
                </a>
              </StaggerItem>
            </StaggerGroup>
          </div>

          <div id="symmetry-lab-cards" className="mt-[clamp(36px,6vh,64px)]">
            <ReasonStack />
          </div>
        </section>

        {/* ── 08 / closing — where the road ends ── */}
        <section className="ix-sec" id="start">
          <div className="ix-grid">
            <div className="ix-grid__label">
              <SectionLabel n={8}>Start</SectionLabel>
            </div>
            <div className="min-w-0">
              <StaggerGroup amount={0.3} stagger={0.1}>
                <motion.h2
                  variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } } }}
                  className="ix-h2"
                >
                  <Words>Draw it. Understand it.</Words>{' '}
                  <Mark chip delay={0.2}>
                    <InlineReveal>Explore it.</InlineReveal>
                  </Mark>
                </motion.h2>
                <StaggerItem as="div" className="ix-actions mt-[clamp(22px,4vh,40px)]">
                  <Link to="/draw" className="ix-btn">
                    <FlaskConical size={19} /> Open Draw Lab
                    <ArrowRight size={18} />
                  </Link>
                  <Link to="/library" className="ix-btn ix-btn--ghost">
                    <BookOpen size={19} /> Browse Compounds
                  </Link>
                </StaggerItem>
              </StaggerGroup>
            </div>
          </div>

          <div className="ix-finale__end">
            <div className="ix-run" data-road="run2" style={{ top: 0 }} />
            <div className="ix-endring" data-road="end" aria-hidden="true" />
            <p className="ix-road-credit">
              Developed and Designed by <strong>Siddhartha Dhar</strong> and{' '}
              <strong>Subhranil Manna</strong>
            </p>
            <footer className="ix-footer">
              <MoleItLogo size="sm" tone="light" to="/" />
              <div className="ix-footer__row">
                <span>© {new Date().getFullYear()} MoleIt</span>
                <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                  Back to top
                </button>
              </div>
            </footer>
          </div>
        </section>
      </main>
    </div>
  );
}

function SpectroscopyHero({ heroMolecule }) {
  const [activeTab, setActiveTab] = useState('1H');
  const activeMeta = SPECTROSCOPY_TABS.find((t) => t.key === activeTab);

  const paragraph =
    'Sketch it in the Draw Lab or pull it straight from the Library, then predict and explore what it looks like under the instrument — ¹H, ¹³C NMR, and IR today, with more spectra on the way.';

  return (
    <div>
      <StaggerGroup amount={0.25} stagger={0.12}>
        <motion.h2
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } } }}
          className="ix-h2"
        >
          <Words>Predict &amp; explore</Words>{' '}
          <Mark chip>
            <InlineReveal>spectra for any compound</InlineReveal>
          </Mark>{' '}
          <Words>with the Spectroscopy Engine.</Words>
        </motion.h2>

        <motion.p
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.012, delayChildren: 0.5 } } }}
          className="ix-body mt-[clamp(18px,3vh,30px)]"
        >
          {paragraph.split(' ').map((w, i) => (
            <Fragment key={i}>
              {i > 0 && ' '}
              <Word>{w}</Word>
            </Fragment>
          ))}
        </motion.p>

        <StaggerItem as="div" className="ix-actions mt-[clamp(20px,3.6vh,36px)]">
          <Link to={`/library?q=${encodeURIComponent(heroMolecule.name)}`} className="ix-btn">
            <Activity size={19} />
            Try Spectroscopy Engine
            <ArrowRight size={18} />
          </Link>
          <Link to="/library" className="ix-btn ix-btn--ghost">
            <BookOpen size={19} />
            Available in Library
          </Link>
        </StaggerItem>
      </StaggerGroup>

      <Reveal amount={0.15} className="mt-[clamp(36px,7vh,72px)]">
        <div className="flex flex-wrap gap-2">
          {SPECTROSCOPY_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`ix-tab ${activeTab === t.key ? 'is-active' : ''}`}
            >
              {t.label}
              {!t.ready && <span className="text-[9px] font-bold uppercase text-[#b26a00]">soon</span>}
            </button>
          ))}
        </div>

        <div className="ix-panel mt-3 overflow-hidden">
          {activeMeta.ready ? (
            activeTab === 'IR' ? (
              // IR isn't a peak-list spectrum like ¹H/¹³C, so it gets its
              // own transmittance-line layout instead of BigSpectrum + the
              // MHz field-strength dial (which is NMR-specific).
              <div className="px-2 py-6">
                <IRLinePreview />
                <div className="mt-2 flex items-center justify-between text-[10px] text-[#8a8681]">
                  <span>4000</span>
                  <span>3000</span>
                  <span>2000</span>
                  <span>1000</span>
                  <span>cm⁻¹</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <BigSpectrum
                    peaks={activeTab === '1H' ? BIG_H1_PEAKS : BIG_C13_PEAKS}
                    color={activeTab === '1H' ? '#3bbff7' : '#eea02b'}
                    height={150}
                  />
                </div>
                <SpectrometerReadout activeTab={activeTab} />
              </div>
            )
          ) : (
            <div className="flex h-[150px] flex-col items-center justify-center gap-2 text-center">
              <span className="text-sm font-bold uppercase tracking-wide text-[#b26a00]">Coming soon</span>
              <p className="text-base text-[#4e4e4d]">{activeMeta.label} prediction is on the way.</p>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <div className="ix-panel flex-1">
            <IRLinePreview />
            <div className="mt-1.5 flex items-center justify-between text-[9px] text-[#8a8681]">
              <span>4000</span>
              <span>3000</span>
              <span>2000</span>
              <span>1000</span>
              <span>cm⁻¹</span>
            </div>
          </div>
          <CapabilityChecklist />
        </div>
      </Reveal>
    </div>
  );
}

function FeatureCard({ n, icon: Icon, title, desc, to, cta }) {
  return (
    <div className="ix-feature">
      <div className="ix-feature__num">
        <span>{n}</span>
        <span className="ix-feature__icon">
          <Icon size={18} />
        </span>
      </div>
      <h3 className="ix-feature__title">{title}</h3>
      <p className="ix-feature__desc">{desc}</p>
      <Link to={to} className="ix-feature__cta">
        {cta} <ArrowRight size={15} />
      </Link>
    </div>
  );
}