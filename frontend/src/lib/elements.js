// Full periodic table data used by the Draw Lab: CPK-ish colors, a default
// valence (typical bond count, shown for reference only), and atomic weight
// for formula-weight calculations.

const RAW = [
  [1, 'H', 'Hydrogen', 1.008, 1], [2, 'He', 'Helium', 4.0026, 0],
  [3, 'Li', 'Lithium', 6.94, 1], [4, 'Be', 'Beryllium', 9.0122, 2],
  [5, 'B', 'Boron', 10.81, 3], [6, 'C', 'Carbon', 12.011, 4],
  [7, 'N', 'Nitrogen', 14.007, 3], [8, 'O', 'Oxygen', 15.999, 2],
  [9, 'F', 'Fluorine', 18.998, 1], [10, 'Ne', 'Neon', 20.180, 0],
  [11, 'Na', 'Sodium', 22.990, 1], [12, 'Mg', 'Magnesium', 24.305, 2],
  [13, 'Al', 'Aluminium', 26.982, 3], [14, 'Si', 'Silicon', 28.085, 4],
  [15, 'P', 'Phosphorus', 30.974, 3], [16, 'S', 'Sulfur', 32.06, 2],
  [17, 'Cl', 'Chlorine', 35.45, 1], [18, 'Ar', 'Argon', 39.948, 0],
  [19, 'K', 'Potassium', 39.098, 1], [20, 'Ca', 'Calcium', 40.078, 2],
  [21, 'Sc', 'Scandium', 44.956, 3], [22, 'Ti', 'Titanium', 47.867, 4],
  [23, 'V', 'Vanadium', 50.942, 3], [24, 'Cr', 'Chromium', 51.996, 3],
  [25, 'Mn', 'Manganese', 54.938, 2], [26, 'Fe', 'Iron', 55.845, 2],
  [27, 'Co', 'Cobalt', 58.933, 2], [28, 'Ni', 'Nickel', 58.693, 2],
  [29, 'Cu', 'Copper', 63.546, 2], [30, 'Zn', 'Zinc', 65.38, 2],
  [31, 'Ga', 'Gallium', 69.723, 3], [32, 'Ge', 'Germanium', 72.630, 4],
  [33, 'As', 'Arsenic', 74.922, 3], [34, 'Se', 'Selenium', 78.971, 2],
  [35, 'Br', 'Bromine', 79.904, 1], [36, 'Kr', 'Krypton', 83.798, 0],
  [37, 'Rb', 'Rubidium', 85.468, 1], [38, 'Sr', 'Strontium', 87.62, 2],
  [39, 'Y', 'Yttrium', 88.906, 3], [40, 'Zr', 'Zirconium', 91.224, 4],
  [41, 'Nb', 'Niobium', 92.906, 3], [42, 'Mo', 'Molybdenum', 95.95, 3],
  [43, 'Tc', 'Technetium', 98, 3], [44, 'Ru', 'Ruthenium', 101.07, 3],
  [45, 'Rh', 'Rhodium', 102.91, 3], [46, 'Pd', 'Palladium', 106.42, 2],
  [47, 'Ag', 'Silver', 107.87, 1], [48, 'Cd', 'Cadmium', 112.41, 2],
  [49, 'In', 'Indium', 114.82, 3], [50, 'Sn', 'Tin', 118.71, 4],
  [51, 'Sb', 'Antimony', 121.76, 3], [52, 'Te', 'Tellurium', 127.60, 2],
  [53, 'I', 'Iodine', 126.90, 1], [54, 'Xe', 'Xenon', 131.29, 0],
  [55, 'Cs', 'Cesium', 132.91, 1], [56, 'Ba', 'Barium', 137.33, 2],
  [57, 'La', 'Lanthanum', 138.91, 3], [58, 'Ce', 'Cerium', 140.12, 3],
  [59, 'Pr', 'Praseodymium', 140.91, 3], [60, 'Nd', 'Neodymium', 144.24, 3],
  [61, 'Pm', 'Promethium', 145, 3], [62, 'Sm', 'Samarium', 150.36, 3],
  [63, 'Eu', 'Europium', 151.96, 3], [64, 'Gd', 'Gadolinium', 157.25, 3],
  [65, 'Tb', 'Terbium', 158.93, 3], [66, 'Dy', 'Dysprosium', 162.50, 3],
  [67, 'Ho', 'Holmium', 164.93, 3], [68, 'Er', 'Erbium', 167.26, 3],
  [69, 'Tm', 'Thulium', 168.93, 3], [70, 'Yb', 'Ytterbium', 173.05, 3],
  [71, 'Lu', 'Lutetium', 174.97, 3], [72, 'Hf', 'Hafnium', 178.49, 4],
  [73, 'Ta', 'Tantalum', 180.95, 5], [74, 'W', 'Tungsten', 183.84, 4],
  [75, 'Re', 'Rhenium', 186.21, 4], [76, 'Os', 'Osmium', 190.23, 4],
  [77, 'Ir', 'Iridium', 192.22, 3], [78, 'Pt', 'Platinum', 195.08, 2],
  [79, 'Au', 'Gold', 196.97, 3], [80, 'Hg', 'Mercury', 200.59, 2],
  [81, 'Tl', 'Thallium', 204.38, 1], [82, 'Pb', 'Lead', 207.2, 2],
  [83, 'Bi', 'Bismuth', 208.98, 3], [84, 'Po', 'Polonium', 209, 2],
  [85, 'At', 'Astatine', 210, 1], [86, 'Rn', 'Radon', 222, 0],
  [87, 'Fr', 'Francium', 223, 1], [88, 'Ra', 'Radium', 226, 2],
  [89, 'Ac', 'Actinium', 227, 3], [90, 'Th', 'Thorium', 232.04, 4],
  [91, 'Pa', 'Protactinium', 231.04, 5], [92, 'U', 'Uranium', 238.03, 6],
  [93, 'Np', 'Neptunium', 237, 5], [94, 'Pu', 'Plutonium', 244, 4],
  [95, 'Am', 'Americium', 243, 3], [96, 'Cm', 'Curium', 247, 3],
  [97, 'Bk', 'Berkelium', 247, 3], [98, 'Cf', 'Californium', 251, 3],
  [99, 'Es', 'Einsteinium', 252, 3], [100, 'Fm', 'Fermium', 257, 3],
  [101, 'Md', 'Mendelevium', 258, 3], [102, 'No', 'Nobelium', 259, 2],
  [103, 'Lr', 'Lawrencium', 266, 3], [104, 'Rf', 'Rutherfordium', 267, 4],
  [105, 'Db', 'Dubnium', 268, 5], [106, 'Sg', 'Seaborgium', 269, 6],
  [107, 'Bh', 'Bohrium', 270, 7], [108, 'Hs', 'Hassium', 269, 8],
  [109, 'Mt', 'Meitnerium', 278, 4], [110, 'Ds', 'Darmstadtium', 281, 4],
  [111, 'Rg', 'Roentgenium', 282, 3], [112, 'Cn', 'Copernicium', 285, 2],
  [113, 'Nh', 'Nihonium', 286, 3], [114, 'Fl', 'Flerovium', 289, 4],
  [115, 'Mc', 'Moscovium', 290, 3], [116, 'Lv', 'Livermorium', 293, 2],
  [117, 'Ts', 'Tennessine', 294, 1], [118, 'Og', 'Oganesson', 294, 0],
];

const ALKALI = new Set([3, 11, 19, 37, 55, 87]);
const ALKALINE = new Set([4, 12, 20, 38, 56, 88]);
const POST_TRANSITION = new Set([13, 31, 49, 50, 81, 82, 83, 84, 113, 114, 115, 116]);
const METALLOID = new Set([5, 14, 32, 33, 51, 52]);
const HALOGEN = new Set([9, 17, 35, 53, 85, 117]);
const NOBLE = new Set([2, 10, 18, 36, 54, 86, 118]);
const NONMETAL = new Set([1, 6, 7, 8, 15, 16, 34]);

function categoryOf(z) {
  if (ALKALI.has(z)) return 'alkali';
  if (ALKALINE.has(z)) return 'alkaline';
  if (z >= 57 && z <= 71) return 'lanthanide';
  if (z >= 89 && z <= 103) return 'actinide';
  if ((z >= 21 && z <= 30) || (z >= 39 && z <= 48) || (z >= 72 && z <= 80) || (z >= 104 && z <= 112))
    return 'transition';
  if (POST_TRANSITION.has(z)) return 'posttransition';
  if (METALLOID.has(z)) return 'metalloid';
  if (HALOGEN.has(z)) return 'halogen';
  if (NOBLE.has(z)) return 'noble';
  if (NONMETAL.has(z)) return 'nonmetal';
  return 'other';
}

const CATEGORY_COLORS = {
  alkali: '#a78bfa',
  alkaline: '#67e8f9',
  lanthanide: '#f472b6',
  actinide: '#fb7185',
  transition: '#94a3b8',
  posttransition: '#dd7c3f',
  metalloid: '#eab308',
  halogen: '#3fcf6e',
  noble: '#60a5fa',
  nonmetal: '#8b95d9',
  other: '#94a3b8',
};

const CURATED_COLORS = {
  H: '#e8eaed', C: '#6b7280', N: '#5b8def', O: '#f4614b',
  F: '#7ce27c', Cl: '#3fcf6e', Br: '#a5501c', I: '#8b3fd6',
  S: '#f5c518', P: '#f5a524', Na: '#a78bfa', K: '#c084fc',
  Mg: '#5eead4', Ca: '#4ade80', Fe: '#dd7c3f', Zn: '#94a3b8',
  B: '#fca5a5', Si: '#eab308',
};

const CURATED_RADIUS = {
  H: 9, C: 13, N: 12, O: 12, F: 11, Cl: 14, Br: 15, I: 16,
  S: 14, P: 14, Na: 15, K: 16, Mg: 14, Ca: 15, Fe: 14, Zn: 14, B: 12, Si: 14,
};

export const ELEMENTS = {};
export const ELEMENT_ORDER = [];

RAW.forEach(([z, symbol, name, weight, valence]) => {
  const category = categoryOf(z);
  ELEMENTS[symbol] = {
    z,
    name,
    weight,
    valence,
    category,
    color: CURATED_COLORS[symbol] || CATEGORY_COLORS[category],
    radius: CURATED_RADIUS[symbol] || 13,
  };
  ELEMENT_ORDER.push(symbol);
});

export const ELEMENT_SYMBOLS = ELEMENT_ORDER;

export const QUICK_PALETTE = ['C', 'H', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I', 'Na', 'B'];

// NOTE: this file used to hold real chemistry computation —
// computeFormula, computeMolarMass, deriveSmiles, findIonicBondIssues,
// findValenceIssues, bondOrderValue, kekulizeAromaticBonds, and all the
// constants only they needed (VALENCE_ELECTRONS, NO_EXPANDED_OCTET,
// METAL_CATEGORIES, CENTRAL_ATOM_CANDIDATES...). All of it has been
// ported to backend/app/formula.py, the same way lib/nmrPredictor.js and
// lib/irPredictor.js were fully ported to backend/app/spectra/ — it's
// served from POST /api/structure/analyze (see api/api.js's
// analyzeStructure), which DrawLabPage calls on a debounce and passes
// down as props/state to PropertiesPanel and Inspector. What's left
// below is periodic-table lookup data (colors, radii, name, the
// display-only "valence" reference number) and plain atom/bond-id
// counters — no computation, just data and IDs.

export function elementInfo(symbol) {
  return ELEMENTS[symbol] || { name: symbol, color: '#94a3b8', valence: 1, weight: 0, radius: 13, category: 'other' };
}

export function newAtomId(existing) {
  let i = existing.length;
  let id = `a${i}`;
  const ids = new Set(existing.map((a) => a.id));
  while (ids.has(id)) {
    i += 1;
    id = `a${i}`;
  }
  return id;
}

export function newBondId(existing) {
  let i = existing.length;
  let id = `b${i}`;
  const ids = new Set(existing.map((b) => b.id));
  while (ids.has(id)) {
    i += 1;
    id = `b${i}`;
  }
  return id;
}