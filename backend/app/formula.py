"""Molecular formula, molar mass, approximate SMILES derivation, and
valence/formal-charge validation for a drawn structure.

Ported from frontend/src/lib/elements.js's `computeFormula`,
`computeMolarMass`, `deriveSmiles`, `findIonicBondIssues` and
`findValenceIssues` — those used to run entirely client-side, including
for structures that get persisted (DrawLabPage's handleSave sent whatever
the browser computed straight to the backend as `derived_formula`/
`derived_smiles`, with no server-side check at all). This module is now
the single source of truth for that math; see routers/structure.py for
the endpoint that exposes it.

Reuses `bond_order_value` / `is_bond_aromatic` / `kekulize_aromatic_bonds`
from spectra/common.py rather than re-deriving that (nontrivial,
backtracking) Kekulization search a second time — same algorithm the NMR/
IR predictors already rely on for the same "resolve a concrete Kekulé
structure so implicit-H counting on ring heteroatoms is correct" reason.

Atoms/bonds use the same plain-dict shape the rest of this app's
`structure_2d` JSON already uses: an atom is
`{id, element, x, y, charge}` and a bond is `{id, from, to, order, aromatic}`.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .spectra.common import bond_order_value, is_bond_aromatic, kekulize_aromatic_bonds

Atom = Dict[str, Any]
Bond = Dict[str, Any]

# ---------------------------------------------------------------------
# Full periodic table — z, symbol, name, atomic weight, typical valence
# (typical bond count). Mirrors elements.js's RAW array exactly; this
# module additionally needs `weight` (for molar mass) that
# spectra/common.py's own, smaller copy of this table doesn't carry.
# ---------------------------------------------------------------------

_RAW = [
    (1, 'H', 'Hydrogen', 1.008, 1), (2, 'He', 'Helium', 4.0026, 0),
    (3, 'Li', 'Lithium', 6.94, 1), (4, 'Be', 'Beryllium', 9.0122, 2),
    (5, 'B', 'Boron', 10.81, 3), (6, 'C', 'Carbon', 12.011, 4),
    (7, 'N', 'Nitrogen', 14.007, 3), (8, 'O', 'Oxygen', 15.999, 2),
    (9, 'F', 'Fluorine', 18.998, 1), (10, 'Ne', 'Neon', 20.180, 0),
    (11, 'Na', 'Sodium', 22.990, 1), (12, 'Mg', 'Magnesium', 24.305, 2),
    (13, 'Al', 'Aluminium', 26.982, 3), (14, 'Si', 'Silicon', 28.085, 4),
    (15, 'P', 'Phosphorus', 30.974, 3), (16, 'S', 'Sulfur', 32.06, 2),
    (17, 'Cl', 'Chlorine', 35.45, 1), (18, 'Ar', 'Argon', 39.948, 0),
    (19, 'K', 'Potassium', 39.098, 1), (20, 'Ca', 'Calcium', 40.078, 2),
    (21, 'Sc', 'Scandium', 44.956, 3), (22, 'Ti', 'Titanium', 47.867, 4),
    (23, 'V', 'Vanadium', 50.942, 3), (24, 'Cr', 'Chromium', 51.996, 3),
    (25, 'Mn', 'Manganese', 54.938, 2), (26, 'Fe', 'Iron', 55.845, 2),
    (27, 'Co', 'Cobalt', 58.933, 2), (28, 'Ni', 'Nickel', 58.693, 2),
    (29, 'Cu', 'Copper', 63.546, 2), (30, 'Zn', 'Zinc', 65.38, 2),
    (31, 'Ga', 'Gallium', 69.723, 3), (32, 'Ge', 'Germanium', 72.630, 4),
    (33, 'As', 'Arsenic', 74.922, 3), (34, 'Se', 'Selenium', 78.971, 2),
    (35, 'Br', 'Bromine', 79.904, 1), (36, 'Kr', 'Krypton', 83.798, 0),
    (37, 'Rb', 'Rubidium', 85.468, 1), (38, 'Sr', 'Strontium', 87.62, 2),
    (39, 'Y', 'Yttrium', 88.906, 3), (40, 'Zr', 'Zirconium', 91.224, 4),
    (41, 'Nb', 'Niobium', 92.906, 3), (42, 'Mo', 'Molybdenum', 95.95, 3),
    (43, 'Tc', 'Technetium', 98, 3), (44, 'Ru', 'Ruthenium', 101.07, 3),
    (45, 'Rh', 'Rhodium', 102.91, 3), (46, 'Pd', 'Palladium', 106.42, 2),
    (47, 'Ag', 'Silver', 107.87, 1), (48, 'Cd', 'Cadmium', 112.41, 2),
    (49, 'In', 'Indium', 114.82, 3), (50, 'Sn', 'Tin', 118.71, 4),
    (51, 'Sb', 'Antimony', 121.76, 3), (52, 'Te', 'Tellurium', 127.60, 2),
    (53, 'I', 'Iodine', 126.90, 1), (54, 'Xe', 'Xenon', 131.29, 0),
    (55, 'Cs', 'Cesium', 132.91, 1), (56, 'Ba', 'Barium', 137.33, 2),
    (57, 'La', 'Lanthanum', 138.91, 3), (58, 'Ce', 'Cerium', 140.12, 3),
    (59, 'Pr', 'Praseodymium', 140.91, 3), (60, 'Nd', 'Neodymium', 144.24, 3),
    (61, 'Pm', 'Promethium', 145, 3), (62, 'Sm', 'Samarium', 150.36, 3),
    (63, 'Eu', 'Europium', 151.96, 3), (64, 'Gd', 'Gadolinium', 157.25, 3),
    (65, 'Tb', 'Terbium', 158.93, 3), (66, 'Dy', 'Dysprosium', 162.50, 3),
    (67, 'Ho', 'Holmium', 164.93, 3), (68, 'Er', 'Erbium', 167.26, 3),
    (69, 'Tm', 'Thulium', 168.93, 3), (70, 'Yb', 'Ytterbium', 173.05, 3),
    (71, 'Lu', 'Lutetium', 174.97, 3), (72, 'Hf', 'Hafnium', 178.49, 4),
    (73, 'Ta', 'Tantalum', 180.95, 5), (74, 'W', 'Tungsten', 183.84, 4),
    (75, 'Re', 'Rhenium', 186.21, 4), (76, 'Os', 'Osmium', 190.23, 4),
    (77, 'Ir', 'Iridium', 192.22, 3), (78, 'Pt', 'Platinum', 195.08, 2),
    (79, 'Au', 'Gold', 196.97, 3), (80, 'Hg', 'Mercury', 200.59, 2),
    (81, 'Tl', 'Thallium', 204.38, 1), (82, 'Pb', 'Lead', 207.2, 2),
    (83, 'Bi', 'Bismuth', 208.98, 3), (84, 'Po', 'Polonium', 209, 2),
    (85, 'At', 'Astatine', 210, 1), (86, 'Rn', 'Radon', 222, 0),
    (87, 'Fr', 'Francium', 223, 1), (88, 'Ra', 'Radium', 226, 2),
    (89, 'Ac', 'Actinium', 227, 3), (90, 'Th', 'Thorium', 232.04, 4),
    (91, 'Pa', 'Protactinium', 231.04, 5), (92, 'U', 'Uranium', 238.03, 6),
    (93, 'Np', 'Neptunium', 237, 5), (94, 'Pu', 'Plutonium', 244, 4),
    (95, 'Am', 'Americium', 243, 3), (96, 'Cm', 'Curium', 247, 3),
    (97, 'Bk', 'Berkelium', 247, 3), (98, 'Cf', 'Californium', 251, 3),
    (99, 'Es', 'Einsteinium', 252, 3), (100, 'Fm', 'Fermium', 257, 3),
    (101, 'Md', 'Mendelevium', 258, 3), (102, 'No', 'Nobelium', 259, 2),
    (103, 'Lr', 'Lawrencium', 266, 3), (104, 'Rf', 'Rutherfordium', 267, 4),
    (105, 'Db', 'Dubnium', 268, 5), (106, 'Sg', 'Seaborgium', 269, 6),
    (107, 'Bh', 'Bohrium', 270, 7), (108, 'Hs', 'Hassium', 269, 8),
    (109, 'Mt', 'Meitnerium', 278, 4), (110, 'Ds', 'Darmstadtium', 281, 4),
    (111, 'Rg', 'Roentgenium', 282, 3), (112, 'Cn', 'Copernicium', 285, 2),
    (113, 'Nh', 'Nihonium', 286, 3), (114, 'Fl', 'Flerovium', 289, 4),
    (115, 'Mc', 'Moscovium', 290, 3), (116, 'Lv', 'Livermorium', 293, 2),
    (117, 'Ts', 'Tennessine', 294, 1), (118, 'Og', 'Oganesson', 294, 0),
]

_ALKALI = {3, 11, 19, 37, 55, 87}
_ALKALINE = {4, 12, 20, 38, 56, 88}
_POST_TRANSITION = {13, 31, 49, 50, 81, 82, 83, 84, 113, 114, 115, 116}
_METALLOID = {5, 14, 32, 33, 51, 52}
_HALOGEN = {9, 17, 35, 53, 85, 117}
_NOBLE = {2, 10, 18, 36, 54, 86, 118}
_NONMETAL = {1, 6, 7, 8, 15, 16, 34}


def _category_of(z: int) -> str:
    if z in _ALKALI:
        return 'alkali'
    if z in _ALKALINE:
        return 'alkaline'
    if 57 <= z <= 71:
        return 'lanthanide'
    if 89 <= z <= 103:
        return 'actinide'
    if (21 <= z <= 30) or (39 <= z <= 48) or (72 <= z <= 80) or (104 <= z <= 112):
        return 'transition'
    if z in _POST_TRANSITION:
        return 'posttransition'
    if z in _METALLOID:
        return 'metalloid'
    if z in _HALOGEN:
        return 'halogen'
    if z in _NOBLE:
        return 'noble'
    if z in _NONMETAL:
        return 'nonmetal'
    return 'other'


ELEMENTS: Dict[str, Dict[str, Any]] = {
    symbol: {'name': name, 'weight': weight, 'valence': valence, 'category': _category_of(z)}
    for (z, symbol, name, weight, valence) in _RAW
}

# Valence *electrons* (group number) — different from the `valence` field
# above (typical bond count). Needed for formal-charge accounting:
# FC = valenceElectrons - lonePairElectrons - bondingElectrons. Covers the
# main-group elements this app's chemistry actually reaches; left out for
# transition metals and beyond, where simple formal-charge rules don't
# cleanly apply and this module doesn't try to validate them.
VALENCE_ELECTRONS: Dict[str, int] = {
    'H': 1, 'He': 2,
    'Li': 1, 'Be': 2, 'B': 3, 'C': 4, 'N': 5, 'O': 6, 'F': 7, 'Ne': 8,
    'Na': 1, 'Mg': 2, 'Al': 3, 'Si': 4, 'P': 5, 'S': 6, 'Cl': 7, 'Ar': 8,
    'K': 1, 'Ca': 2, 'Br': 7, 'Kr': 8,
    'Rb': 1, 'Sr': 2, 'I': 7, 'Xe': 8,
    'Cs': 1, 'Ba': 2, 'Ra': 2, 'Fr': 1,
}

# Period-2 elements can't expand past an octet (no accessible d-orbitals) —
# unlike period-3-and-below elements (S, P, Cl...), which legitimately can
# (SF6, PCl5, H2SO4).
NO_EXPANDED_OCTET = {'B', 'C', 'N', 'O', 'F'}

# Which side of a bond is "the metal" for ionic-bond detection below.
# Metalloids are deliberately excluded from both sides — B-F, Si-Cl and
# friends are genuinely covalent (BF3, SiCl4), not ionic.
METAL_CATEGORIES = {'alkali', 'alkaline', 'transition', 'posttransition', 'lanthanide', 'actinide'}
NONMETAL_CATEGORIES = {'nonmetal', 'halogen'}

# ---- Real formula-writing conventions (used by compute_formula below) ----
CENTRAL_ATOM_CANDIDATES = ['C', 'S', 'N', 'P', 'Si', 'B', 'Cl', 'Br', 'I']
PNICTOGEN_HYDRIDE_CENTRALS = ['N', 'P', 'As', 'Sb']
BINARY_COVALENT_PRIORITY = ['B', 'Si', 'P', 'N', 'As', 'Sb', 'Te', 'Se', 'S', 'I', 'Br', 'Cl', 'O', 'F']


def element_info(symbol: str) -> Dict[str, Any]:
    return ELEMENTS.get(symbol) or {'name': symbol, 'weight': 0, 'valence': 1, 'category': 'other'}


def valence_electrons_of(symbol: str) -> Optional[int]:
    return VALENCE_ELECTRONS.get(symbol)


def is_metal_symbol(symbol: str) -> bool:
    return element_info(symbol)['category'] in METAL_CATEGORIES


def _order_nonmetal_group(symbols: List[str], is_anion_of_ionic_salt: bool) -> List[str]:
    """Orders a set of non-metal element symbols the way real
    formula-writing convention actually does. `is_anion_of_ionic_salt` is
    true when this is the non-metal remainder of an ionic compound (a
    metal has already been placed first, separately)."""
    has = lambda s: s in symbols  # noqa: E731
    rest = [s for s in symbols if s not in ('H', 'O')]
    central_candidate = next((s for s in rest if s in CENTRAL_ATOM_CANDIDATES), None)

    if is_anion_of_ionic_salt:
        ordered: List[str] = []
        if central_candidate:
            ordered.append(central_candidate)
        ordered += sorted(s for s in rest if s != central_candidate)
        if has('O'):
            ordered.append('O')
        if has('H'):
            ordered.append('H')
        return ordered

    if has('H') and has('O') and central_candidate:
        # Oxoacid: acidic hydrogen(s) first, then the central nonmetal,
        # then oxygen (H2SO4, HNO3, H3PO4, HClO4, H2CO3).
        ordered = ['H', central_candidate] + sorted(s for s in rest if s != central_candidate) + ['O']
        return [s for s in ordered if has(s)]
    if has('H') and has('O'):
        # No recognizable central atom alongside O — water/peroxide-style.
        return ['H', 'O']
    if has('H') and any(has(s) for s in PNICTOGEN_HYDRIDE_CENTRALS):
        # A pnictogen hydride (NH3, PH3) — or its halide salt (NH4Cl) —
        # is written [pnictogen, H, ...anything else].
        central = next(s for s in PNICTOGEN_HYDRIDE_CENTRALS if has(s))
        others = sorted(s for s in rest if s != central)
        return [s for s in ([central, 'H'] + others) if has(s)]
    if has('H'):
        # A simple hydracid / binary hydride (HCl, HBr, HF, HI, H2S).
        return ['H'] + sorted(rest)
    # No hydrogen at all — binary/simple covalent compound between two
    # nonmetals (SF6, PCl5, ICl, SO2, NO2...).
    known = [s for s in symbols if s in BINARY_COVALENT_PRIORITY]
    unknown = sorted(s for s in symbols if s not in BINARY_COVALENT_PRIORITY)
    known.sort(key=BINARY_COVALENT_PRIORITY.index)
    return known + unknown


def resolve_bond_orders(atoms: List[Atom], bonds: List[Bond]) -> Dict[str, float]:
    """The real, single-vs-double-resolved order of every bond — 1/2/3
    for an ordinary bond exactly as drawn, or the Kekulé-resolved order
    for an aromatic one (never a flat 1.5, which is wrong for fused-ring
    bridgeheads and for lone-pair-donating heteroatoms like pyrrole's
    N-H). This is the one piece of Inspector.jsx's old per-click
    computation (kekulizeAromaticBonds/bondOrderValue, formerly
    imported from lib/elements.js) that was genuine chemistry logic
    rather than a plain lookup — it now lives here, and the frontend
    just reads this map instead of resolving it itself."""
    kekule_orders = kekulize_aromatic_bonds(atoms, bonds)
    return {
        b['id']: (kekule_orders.get(b['id'], 1.5) if is_bond_aromatic(b) else bond_order_value(b))
        for b in bonds
    }


def compute_formula(atoms: List[Atom], bonds: List[Bond]) -> str:
    if not atoms:
        return ''
    counts: Dict[str, int] = {}
    real_orders = resolve_bond_orders(atoms, bonds)

    def bond_order_sum(atom_id: str) -> float:
        return sum(real_orders[b['id']] for b in bonds if b.get('from') == atom_id or b.get('to') == atom_id)

    for atom in atoms:
        el = atom['element']
        counts[el] = counts.get(el, 0) + 1

        info = element_info(el)
        used = bond_order_sum(atom['id'])
        charge = atom.get('charge') or 0
        # Implicit-H shorthand only makes sense for a neutral atom — a
        # charged atom is an ion the student is deliberately constructing
        # (same convention find_valence_issues uses below) and is
        # expected to have every bond and lone pair drawn explicitly.
        implicit_h = max(0, info['valence'] - used) if charge == 0 else 0
        if el == 'H':
            implicit_h = 0
        if implicit_h > 0:
            counts['H'] = counts.get('H', 0) + implicit_h

    symbols = [s for s in counts if counts[s] > 0]
    metal_symbols = sorted(s for s in symbols if is_metal_symbol(s))
    nonmetal_symbols = [s for s in symbols if not is_metal_symbol(s)]

    if metal_symbols:
        # Any metal present -> ionic compound: cation element(s) first,
        # then the anion part.
        ordered = metal_symbols + _order_nonmetal_group(nonmetal_symbols, True)
    elif counts.get('C'):
        # No metal, carbon present — Hill notation (C, then H, then
        # alphabetical) is the universal organic/covalent convention.
        ordered = ['C']
        if counts.get('H'):
            ordered.append('H')
        ordered += sorted(s for s in symbols if s not in ('C', 'H'))
    else:
        # No metal, no carbon — some other covalent nonmetal compound.
        ordered = _order_nonmetal_group(nonmetal_symbols, False)

    return ''.join(s if counts[s] == 1 else f'{s}{counts[s]}' for s in ordered)


_FORMULA_TOKEN_RE = re.compile(r'([A-Z][a-z]?)(\d*)')


def compute_molar_mass(atoms: List[Atom], bonds: List[Bond]) -> str:
    formula = compute_formula(atoms, bonds)
    mass = 0.0
    for sym, count_str in _FORMULA_TOKEN_RE.findall(formula):
        if not sym:
            continue
        count = int(count_str) if count_str else 1
        mass += element_info(sym)['weight'] * count
    return f'{mass:.2f} g/mol' if mass else ''


def derive_smiles(atoms: List[Atom], bonds: List[Bond]) -> str:
    """A pragmatic, approximate SMILES generator — mirrors
    elements.js's `deriveSmiles` exactly, quirks included (e.g. once an
    atom has more than one remaining branch, *every* branch from it,
    including the last, is parenthesized — not just the non-last ones)."""
    if not atoms:
        return ''
    by_id = {a['id']: a for a in atoms}
    adj: Dict[str, List[Dict[str, Any]]] = {a['id']: [] for a in atoms}
    for b in bonds:
        order = bond_order_value(b)
        aromatic = bool(b.get('aromatic'))
        if b.get('from') in adj:
            adj[b['from']].append({'to': b.get('to'), 'order': order, 'aromatic': aromatic})
        if b.get('to') in adj:
            adj[b['to']].append({'to': b.get('from'), 'order': order, 'aromatic': aromatic})

    visited: set = set()

    def bond_symbol(order: float, aromatic: bool) -> str:
        if aromatic:
            return ''
        if order == 2:
            return '='
        if order == 3:
            return '#'
        return ''

    heavy_atoms = [a for a in atoms if a['element'] != 'H']
    if not heavy_atoms:
        return 'H' if atoms else ''

    def degree(atom_id: str) -> int:
        return len([n for n in adj.get(atom_id, []) if by_id.get(n['to'], {}).get('element') != 'H'])

    def dfs(atom_id: str, came_from_symbol: str) -> str:
        visited.add(atom_id)
        atom = by_id[atom_id]
        out = (came_from_symbol or '') + atom['element']
        neighbors = [
            n for n in adj.get(atom_id, [])
            if n['to'] not in visited and by_id.get(n['to'], {}).get('element') != 'H'
        ]
        for n in neighbors:
            branch = dfs(n['to'], bond_symbol(n['order'], n['aromatic']))
            out += f'({branch})' if len(neighbors) > 1 else branch
        return out

    start = next((a for a in heavy_atoms if degree(a['id']) <= 1), heavy_atoms[0])
    smiles = dfs(start['id'], '')
    for a in heavy_atoms:
        if a['id'] not in visited:
            smiles += '.' + dfs(a['id'], '')
    return smiles


def find_ionic_bond_issues(atoms: List[Atom], bonds: List[Bond]) -> List[Dict[str, Any]]:
    """Flags any bond drawn between a metal and a nonmetal/halogen as
    ionic, not covalent — those atoms transfer electrons rather than
    share them, so no bond line belongs between them; each should stand
    alone as its own ion. Must run (and be excluded) before
    find_valence_issues' formal-charge math, which assumes every bond is
    a shared electron pair."""
    if not atoms or not bonds:
        return []
    by_id = {a['id']: a for a in atoms}
    issues: List[Dict[str, Any]] = []

    for bond in bonds:
        a = by_id.get(bond.get('from'))
        b = by_id.get(bond.get('to'))
        if not a or not b:
            continue

        cat_a = element_info(a['element'])['category']
        cat_b = element_info(b['element'])['category']
        a_is_metal = cat_a in METAL_CATEGORIES
        b_is_metal = cat_b in METAL_CATEGORIES
        a_is_nonmetal = cat_a in NONMETAL_CATEGORIES
        b_is_nonmetal = cat_b in NONMETAL_CATEGORIES
        is_ionic = (a_is_metal and b_is_nonmetal) or (b_is_metal and a_is_nonmetal)
        if not is_ionic:
            continue

        metal = a if a_is_metal else b
        nonmetal = b if metal is a else a
        message = (
            f"{metal['element']}\u2013{nonmetal['element']} is an ionic bond, not covalent \u2014 "
            f"{metal['element']} and {nonmetal['element']} transfer an electron rather than share one, "
            "so there's no bond line to draw between them. Remove this bond and let each stand alone "
            f"as its own ion ({metal['element']} with 0 lone pairs, {nonmetal['element']} with a full octet \u2014 4 lone pairs)."
        )

        issues.append({'atomId': metal['id'], 'bondId': bond.get('id'), 'element': metal['element'], 'type': 'ionic-bond', 'message': message})
        issues.append({'atomId': nonmetal['id'], 'bondId': bond.get('id'), 'element': nonmetal['element'], 'type': 'ionic-bond', 'message': message})

    return issues


def find_valence_issues(atoms: List[Atom], bonds: List[Bond]) -> List[Dict[str, Any]]:
    """Validates a drawn structure against real chemistry rules: over-
    bonding, formal-charge/lone-pair mismatch, and octet violations for
    period-2 atoms. Ported from elements.js's `findValenceIssues`."""
    if not atoms:
        return []

    ionic_issues = find_ionic_bond_issues(atoms, bonds)
    ionic_atom_ids = {i['atomId'] for i in ionic_issues}
    issues: List[Dict[str, Any]] = list(ionic_issues)

    real_orders = resolve_bond_orders(atoms, bonds)

    for atom in atoms:
        if atom['id'] in ionic_atom_ids:
            continue

        info = element_info(atom['element'])
        used = sum(real_orders[b['id']] for b in bonds if b.get('from') == atom['id'] or b.get('to') == atom['id'])
        charge = atom.get('charge') or 0
        lone_pairs = atom.get('lonePairs') or 0

        # 1. Over-bonded. A flat +1 of headroom for any nonzero charge is
        # a safe bound that doesn't misfire on common textbook ions like
        # NH4+ or H3O+.
        allowed_bonds = info['valence'] + (1 if charge != 0 else 0)
        if used > allowed_bonds:
            charge_label = f'(+{charge})' if charge > 0 else (f'({charge})' if charge else '')
            issues.append({
                'atomId': atom['id'],
                'element': atom['element'],
                'type': 'over-bonded',
                'message': f"{atom['element']}{charge_label} is bonded {used:g}-ways but typically only bonds {allowed_bonds:g}-ways.",
            })
            continue  # an over-bonded atom's formal-charge math won't be meaningful

        # Skeletal structures don't require explicit hydrogens — fill in
        # the same implicit-H convention compute_formula uses, for a
        # neutral atom only (a charged atom is expected to be fully,
        # explicitly drawn).
        implicit_h = max(0, info['valence'] - used) if charge == 0 else 0
        effective_bonds = used + implicit_h

        # 2. Formal-charge consistency: FC = V - 2*lonePairs - bondingElectrons.
        # Skipped for an atom still in its untouched default state (no
        # charge, no lone pairs set) — that's an incomplete placeholder,
        # not a claim about its chemistry yet.
        is_untouched_default = charge == 0 and lone_pairs == 0
        v = valence_electrons_of(atom['element'])
        if v is not None and not is_untouched_default:
            implied_charge = v - lone_pairs * 2 - effective_bonds
            if implied_charge != charge:
                needed_lone_pairs = (v - effective_bonds - charge) / 2
                can_fix_with_lone_pairs = needed_lone_pairs == int(needed_lone_pairs) and 0 <= needed_lone_pairs <= 4

                def charge_label(c: float) -> str:
                    return f'+{c:g}' if c > 0 else f'{c:g}'

                if can_fix_with_lone_pairs:
                    fix = (
                        f'Set its lone pairs to {int(needed_lone_pairs)} to match charge {charge_label(charge)}, '
                        f'or set its charge to {charge_label(implied_charge)} to match its current lone pairs.'
                    )
                else:
                    fix = f'Set its charge to {charge_label(implied_charge)} to match its bonds and lone pairs.'

                issues.append({
                    'atomId': atom['id'],
                    'element': atom['element'],
                    'type': 'formal-charge',
                    'message': (
                        f"{atom['element']} has {used:g} drawn bond{'' if used == 1 else 's'}"
                        f"{f' (+{implicit_h:g} implicit H)' if implicit_h else ''} and {lone_pairs} "
                        f"lone pair{'' if lone_pairs == 1 else 's'}, which implies charge {charge_label(implied_charge)} "
                        f"— but it's set to {charge_label(charge)}. {fix}"
                    ),
                })
                continue

        # 3. Octet exceeded (period-2 elements only).
        if atom['element'] in NO_EXPANDED_OCTET:
            electrons_around = lone_pairs * 2 + effective_bonds * 2
            if electrons_around > 8:
                issues.append({
                    'atomId': atom['id'],
                    'element': atom['element'],
                    'type': 'octet-exceeded',
                    'message': (
                        f"{atom['element']} has {electrons_around:g} electrons around it (from its bonds and "
                        "lone pairs) — period-2 elements can't exceed an octet (8)."
                    ),
                })

    return issues