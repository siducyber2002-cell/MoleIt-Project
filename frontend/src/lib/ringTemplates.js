// Ring picker toolbar content (RingPalette). Just the button labels/sizes
// — see components/DrawLab/Toolbar.jsx for where this renders. The
// actual ring-placement math (generateRingStructure) has been ported to
// backend/app/ring_templates.py and is now served from
// POST /api/structure/insert-ring (see api/api.js's insertRing, called
// from components/DrawLab/DrawCanvas.jsx's addRing).

export const RING_TYPES = [
  { id: 'cyclopropane', label: 'Cyclopropane', size: 3, aromatic: false },
  { id: 'cyclobutane', label: 'Cyclobutane', size: 4, aromatic: false },
  { id: 'cyclopentane', label: 'Cyclopentane', size: 5, aromatic: false },
  { id: 'cyclohexane', label: 'Cyclohexane', size: 6, aromatic: false },
  { id: 'benzene', label: 'Benzene', size: 6, aromatic: true },
];