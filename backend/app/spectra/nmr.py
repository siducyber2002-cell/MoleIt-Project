"""Predicts approximate 1H and 13C NMR chemical shifts directly from a
molecule's structure (atoms + bonds). Ported line-for-line from
frontend/src/lib/nmrPredictor.js — the mechanism used to live in the
frontend bundle; it now runs here so every client (web, mobile, any future
API consumer) gets identical predictions from one place instead of
recomputing this rule engine client-side.

This is a rule-based, teaching-level approximation, not a spectral
simulation — see the original nmrPredictor.js's module comment for the
full rationale and the list of real compounds (ethanol, acetic acid,
acetone, benzaldehyde, toluene, ethylamine, aspirin, pyridine, naphthalene,
anthracene, DMSO...) each shift band was checked against by hand. Every
comment below that states a real reference shift is quoting that same
validated data, not a newly-invented number.

Equivalent nuclei are collapsed into one peak using each atom's actual
graph-symmetry class (see `compute_symmetry_classes`), which is what lets
this handle benzene, a monosubstituted ring, a para-disubstituted ring, and
fused polycyclics like naphthalene/anthracene through one code path.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

from .common import (
    Ctx, Neighbor,
    build_context, neighbors_of, is_metal, is_bond_aromatic,
    implicit_h_count, has_any_attached_h, total_attached_h,
    has_double_bond_to, has_triple_bond_to, single_bond_neighbors,
    exocyclic_hetero_single_bond_neighbors, atoms_share_ring,
    is_azide_attachment_nitrogen,
    find_smallest_ring, find_rings_of_size,
    bond_order_value as _bond_order,
    stable_fraction_fnv as stable_fraction,
)

Range = Tuple[float, float]


# ---------------------------------------------------------------------
# Two-spin (AB) second-order analysis
# ---------------------------------------------------------------------
#
# First-order (n+1) splitting only holds when |delta_nu| (the shift
# separation between two coupled partners, in Hz) is large relative to
# J. When it isn't, the textbook doublet/doublet pair collapses into a
# single 4-line AB quartet whose *line positions and intensities* are
# no longer simply "shift +/- J/2" — they follow the closed-form
# two-spin solution of the spin Hamiltonian (Pople, Schneider & Bernstein,
# "High-Resolution Nuclear Magnetic Resonance", 1959, ch. 6), which is
# exact for an isolated two-spin system (no other significant coupling
# partners):
#
#   nu_A, nu_B  = the two shifts, in Hz (shift_ppm * spectrometer_MHz)
#   delta_nu    = nu_A - nu_B
#   C           = sqrt(delta_nu^2 + J^2)              ("effective splitting")
#   nu_bar      = (nu_A + nu_B) / 2                    (band center)
#
#   four line positions (Hz):  nu_bar +/- J/2 +/- C/2
#   intensity ratio outer:inner = (C - J) : (C + J)
#
# As delta_nu >> J, C -> delta_nu and the two outer/inner line pairs
# collapse back onto the ordinary first-order doublets (ratio -> 1:1),
# which is why this is a strict generalization of, not a replacement
# for, the first-order rule — it only changes anything when the
# ratio delta_nu/J is small, which is exactly when first-order breaks
# down anyway.
def ab_quartet_lines(shift_a_ppm: float, shift_b_ppm: float, j_hz: float, freq_mhz: float = 400.0) -> Dict[str, Any]:
    """Closed-form two-spin AB line positions/intensities. Returns ppm
    positions of the 4 lines (high to low field) and the outer:inner
    intensity ratio. `j_hz` should be nonzero; a caller should not call
    this for a pair with no resolvable coupling."""
    j = j_hz if j_hz else 0.01
    nu_a = shift_a_ppm * freq_mhz
    nu_b = shift_b_ppm * freq_mhz
    delta_nu = nu_a - nu_b
    c = (delta_nu ** 2 + j ** 2) ** 0.5
    nu_bar = (nu_a + nu_b) / 2.0
    lines_hz = sorted(
        [nu_bar + j / 2 + c / 2, nu_bar - j / 2 + c / 2, nu_bar + j / 2 - c / 2, nu_bar - j / 2 - c / 2],
        reverse=True,
    )
    lines_ppm = [round(x / freq_mhz, 4) for x in lines_hz]
    outer_inner_ratio = round(abs(c - abs(j)) / (c + abs(j)), 3) if (c + abs(j)) else 1.0
    return {
        'linesPpm': lines_ppm,
        'outerInnerIntensityRatio': outer_inner_ratio,
        'effectiveSplittingHz': round(c, 2),
        'freqMHz': freq_mhz,
    }


# ---------------------------------------------------------------------
# Strained small rings (3- and 4-membered saturated rings)
# ---------------------------------------------------------------------
#
# 5/6-membered saturated rings (cyclohexane, cyclopentane, THF,
# piperidine...) behave close enough to their open-chain analogs that the
# existing open-chain classification below already covers them reasonably
# well. 3- and 4-membered rings are a different story: ring strain
# noticeably changes hybridization and electron distribution, pulling
# shifts well outside what the open-chain rules would predict — most
# strikingly cyclopropane, whose ring protons sit *upfield* of a normal
# alkane CH2 despite having no electron-donating substituent to explain
# that any other way (an anisotropic ring-current-like effect, much like
# benzene's but from the strained, "banana-bond" character of the ring's
# sigma framework rather than a pi system).
#
# For a 4-membered heteroring, the position adjacent to the heteroatom
# ("alpha") and the position across from it ("beta"/C3) are chemically
# distinct enough to need separate ranges (most strikingly oxetane, whose
# alpha C-H sits close to 4.7 ppm — more downfield than most open-chain
# ethers — while its beta C-H sits under 2.7 ppm).
#
# Values below are standard textbook reference ranges for the parent
# ring systems (cyclopropane, ethylene oxide/oxirane, aziridine,
# cyclobutane, oxetane, azetidine, thiirane, thietane), widened slightly
# to cover typical substituted derivatives.

_RING_HETERO_NAME = {
    (3, None): 'Cyclopropane', (3, 'O'): 'Epoxide', (3, 'N'): 'Aziridine', (3, 'S'): 'Thiirane',
    (4, None): 'Cyclobutane', (4, 'O'): 'Oxetane', (4, 'N'): 'Azetidine', (4, 'S'): 'Thietane',
}

# 13C ranges: keyed by (ring size, heteroatom-or-None[, 'alpha'/'beta' for size-4 heterorings])
_RING_C13_RANGES: Dict[Tuple, Range] = {
    (3, None): (-3, 22),
    (3, 'O'): (38, 63),
    (3, 'N'): (17, 37),
    (3, 'S'): (14, 29),
    (4, None): (19, 34),
    (4, 'O', 'alpha'): (69, 83),
    (4, 'O', 'beta'): (19, 31),
    (4, 'N', 'alpha'): (43, 59),
    (4, 'N', 'beta'): (13, 27),
    (4, 'S', 'alpha'): (25, 39),
    (4, 'S', 'beta'): (17, 31),
}

# 1H ranges, same keying.
_RING_H1_RANGES: Dict[Tuple, Range] = {
    (3, None): (-0.3, 1.5),
    (3, 'O'): (2.2, 3.6),
    (3, 'N'): (0.9, 2.4),
    (3, 'S'): (2.0, 2.8),
    (4, None): (1.5, 2.7),
    (4, 'O', 'alpha'): (4.3, 5.0),
    (4, 'O', 'beta'): (2.3, 2.9),
    (4, 'N', 'alpha'): (2.8, 3.8),
    (4, 'N', 'beta'): (1.7, 2.5),
    (4, 'S', 'alpha'): (2.8, 3.6),
    (4, 'S', 'beta'): (1.9, 2.7),
}

# Ring N-H itself (aziridine/azetidine), distinct from an open-chain
# amine N-H — more conformationally locked, so a somewhat narrower
# real-world spread than the generic amineNH bucket.
_RING_NH_RANGES: Dict[int, Range] = {3: (0.4, 1.9), 4: (1.3, 2.7)}


def strained_ring_info(atom_id: str, ctx: Ctx) -> Optional[Dict[str, Any]]:
    """If `atom_id` sits on a 3- or 4-membered non-aromatic ring, returns
    `{ringSize, hetero, position}` (`position` is 'alpha'/'beta' for a
    4-membered heteroring, None otherwise) — or None if it isn't on one,
    or the ring's too large for this special-casing to apply."""
    ring = find_smallest_ring(atom_id, ctx)
    if not ring or len(ring) not in (3, 4):
        return None
    hetero = next((ctx.by_id[rid]['element'] for rid in ring if ctx.by_id[rid]['element'] not in ('C', 'H')), None)
    if hetero is not None and hetero not in ('O', 'N', 'S'):
        return None  # an unusual heteroring (e.g. containing P, Si...) — leave to the generic rules
    position = None
    if len(ring) == 4 and hetero is not None:
        ring_adjacent = {ring[1], ring[-1]}
        is_alpha = any(ctx.by_id[rid]['element'] == hetero for rid in ring_adjacent)
        position = 'alpha' if is_alpha else 'beta'
    return {'ringSize': len(ring), 'hetero': hetero, 'position': position}


def strained_ring_carbon_class(atom_id: str, ctx: Ctx, info: Dict[str, Any]) -> Dict[str, Any]:
    ring_size, hetero, position = info['ringSize'], info['hetero'], info['position']
    range_key = (ring_size, hetero) if position is None else (ring_size, hetero, position)
    c_range = _RING_C13_RANGES[range_key]
    name = _RING_HETERO_NAME[(ring_size, hetero)]
    h_count = total_attached_h(ctx.by_id[atom_id], ctx)
    suffix = {3: 'CH2', 2: 'CH2', 1: 'CH', 0: 'C (no attached H)'}.get(h_count, 'CH')
    pos_note = f' ({position} to ring {hetero})' if position else ''
    key = f"strainedRing_{ring_size}_{hetero or 'C'}_{position or 'x'}_{'H' + str(min(h_count, 2))}"
    return {'key': key, 'label': f'{name} ring carbon{pos_note} ({suffix})', 'range': c_range, 'strainedRing': True}


def strained_ring_hydrogen_class(atom_id: str, ctx: Ctx, info: Dict[str, Any]) -> Dict[str, Any]:
    ring_size, hetero, position = info['ringSize'], info['hetero'], info['position']
    range_key = (ring_size, hetero) if position is None else (ring_size, hetero, position)
    h_range = _RING_H1_RANGES[range_key]
    name = _RING_HETERO_NAME[(ring_size, hetero)]
    pos_note = f' ({position} to ring {hetero})' if position else ''
    key = f"strainedRingH_{ring_size}_{hetero or 'C'}_{position or 'x'}"
    return {'key': key, 'label': f'{name} ring H{pos_note}', 'range': h_range}


# ---------------------------------------------------------------------
# Carbonyl / thiocarbonyl context
# ---------------------------------------------------------------------

def carbonyl_context(atom_id: str, ctx: Ctx) -> Optional[Dict[str, Any]]:
    """True if this carbon has a C=O plus, on the same carbon, an O or N
    single bond too (acid / ester / amide rather than aldehyde/ketone) —
    and which of those it is, including lactone/lactam (ring) and
    urea/carbamate (two flanking heteroatoms) subtypes."""
    if not has_double_bond_to(atom_id, 'O', ctx):
        return None
    hetero_singles = [n for n in neighbors_of(atom_id, ctx) if n.atom['element'] in ('O', 'N') and _bond_order(n.bond) == 1]
    h_count = total_attached_h(ctx.by_id[atom_id], ctx)

    if len(hetero_singles) >= 2:
        els = ''.join(sorted(n.atom['element'] for n in hetero_singles))
        if els == 'NN':
            return {'hasHeteroSingle': True, 'subtype': 'urea', 'hCount': h_count}
        if els == 'NO':
            return {'hasHeteroSingle': True, 'subtype': 'carbamate', 'hCount': h_count}
        # 'OO' (carbonate) falls through to the single-heteroatom branch.

    hetero_single = hetero_singles[0] if hetero_singles else None
    subtype = None
    if hetero_single is not None:
        if hetero_single.atom['element'] == 'N':
            subtype = 'amide'
        else:
            subtype = 'acid' if total_attached_h(hetero_single.atom, ctx) > 0 else 'ester'
        if subtype in ('ester', 'amide') and atoms_share_ring(atom_id, hetero_single.atom['id'], ctx):
            subtype = 'lactone' if subtype == 'ester' else 'lactam'
    return {'hasHeteroSingle': hetero_single is not None, 'subtype': subtype, 'hCount': h_count}


def thiocarbonyl_context(atom_id: str, ctx: Ctx) -> Optional[Dict[str, Any]]:
    """The C=S analog of carbonyl_context."""
    if not has_double_bond_to(atom_id, 'S', ctx):
        return None
    hetero_singles = [n for n in neighbors_of(atom_id, ctx) if n.atom['element'] in ('O', 'N', 'S') and _bond_order(n.bond) == 1]
    h_count = total_attached_h(ctx.by_id[atom_id], ctx)

    if sum(1 for n in hetero_singles if n.atom['element'] == 'N') >= 2:
        return {'hasHeteroSingle': True, 'subtype': 'thiourea', 'hCount': h_count}

    hetero_single = hetero_singles[0] if hetero_singles else None
    subtype = None
    if hetero_single is not None:
        if hetero_single.atom['element'] == 'N':
            subtype = 'thioamide'
        elif hetero_single.atom['element'] == 'S':
            subtype = 'dithioic'
        else:
            subtype = 'thionoester'
    return {'hasHeteroSingle': hetero_single is not None, 'subtype': subtype, 'hCount': h_count}


def oxygen_role(oxygen_atom, source_carbon_id: str, ctx: Ctx) -> str:
    """alcohol / etherAlkyl / etherAryl / esterAlkoxy, for the carbon
    attached to a singly-bonded oxygen."""
    if total_attached_h(oxygen_atom, ctx) > 0:
        return 'alcohol'
    other_c = next(
        (n for n in neighbors_of(oxygen_atom['id'], ctx)
         if n.atom['id'] != source_carbon_id and n.atom['element'] == 'C' and _bond_order(n.bond) == 1),
        None,
    )
    if other_c is None:
        return 'alcohol'
    if carbonyl_context(other_c.atom['id'], ctx):
        return 'esterAlkoxy'
    other_is_aromatic = any(is_bond_aromatic(n.bond) for n in neighbors_of(other_c.atom['id'], ctx))
    return 'etherAryl' if other_is_aromatic else 'etherAlkyl'


def classify_halide_carbon(halogens: List[Neighbor]) -> Dict[str, Any]:
    """A carbon attached to a halogen: shift does NOT track electronegativity
    monotonically — F deshields most, Cl/Br follow the expected order, but
    I shifts *upfield* of Br (the "heavy atom effect"), an effect that
    compounds for poly-halogenated carbons (opposite direction for I)."""
    counts: Dict[str, int] = {}
    for h in halogens:
        counts[h.atom['element']] = counts.get(h.atom['element'], 0) + 1
    elements = list(counts.keys())
    if len(elements) > 1:
        return {'key': 'cHalideMixed', 'label': 'Carbon attached to more than one type of halogen', 'range': (10, 95)}
    el = elements[0]
    n = counts[el]
    base_ranges = {'F': (65, 95), 'Cl': (35, 55), 'Br': (20, 40), 'I': (-10, 25)}
    labels = {'F': 'fluorine', 'Cl': 'chlorine', 'Br': 'bromine', 'I': 'iodine'}
    lo, hi = base_ranges[el]
    key = f'cHalide{el}' + (f'x{n}' if n > 1 else '')
    label = f"Carbon attached to {(str(n) + ' ') if n > 1 else ''}{labels[el]}{' atoms' if n > 1 else ''}"
    if n == 1:
        return {'key': key, 'label': label, 'range': (lo, hi)}
    extra = n - 1
    if el == 'I':
        rng = (lo - 45 * extra, hi - 10 * extra)
    else:
        rng = (lo + 15 * extra, hi + 20 * extra)
    return {'key': key, 'label': label, 'range': rng}


def grant_paul_shift(atom_id: str, ctx: Ctx) -> float:
    """Grant & Paul's (1964, JACS 86:2984) empirical additivity equation
    for 13C shifts of simple saturated hydrocarbons:
        delta = -2.3 + 9.1*n_alpha + 9.4*n_beta - 2.5*n_gamma + 0.3*n_delta
    where n_alpha/beta/gamma/delta count carbons 1/2/3/4 bonds away
    (BFS on the carbon-only subgraph — the formula's original scope is
    pure hydrocarbons, so heteroatoms aren't part of this count), plus a
    branching ("steric") correction per directly-bonded neighbor based on
    this carbon's own substitution degree and that neighbor's. The
    correction table below was checked by hand against propane,
    isobutane, neopentane, and isopentane's known experimental shifts
    (all matching within about 1 ppm) — the combination is what lets a
    quaternary carbon like neopentane's correctly read *lower* than its
    own methyls despite being bonded to four of them, a well-known
    "self-branching" effect the raw linear terms alone get backwards."""
    dist: Dict[str, int] = {atom_id: 0}
    queue: List[str] = [atom_id]
    qi = 0
    while qi < len(queue):
        cur = queue[qi]
        qi += 1
        if dist[cur] >= 4:
            continue
        for n in neighbors_of(cur, ctx):
            if n.atom['element'] != 'C':
                continue
            if n.atom['id'] not in dist:
                dist[n.atom['id']] = dist[cur] + 1
                queue.append(n.atom['id'])

    n_alpha = sum(1 for d in dist.values() if d == 1)
    n_beta = sum(1 for d in dist.values() if d == 2)
    n_gamma = sum(1 for d in dist.values() if d == 3)
    n_delta = sum(1 for d in dist.values() if d == 4)
    base = -2.3 + 9.1 * n_alpha + 9.4 * n_beta - 2.5 * n_gamma + 0.3 * n_delta

    def carbon_degree(aid: str) -> int:
        return sum(1 for n in neighbors_of(aid, ctx) if n.atom['element'] == 'C')

    own_degree = carbon_degree(atom_id)
    steric_table = {
        (1, 2): 0.0, (1, 3): -1.1, (1, 4): -3.4,
        (2, 1): 0.0, (2, 2): 0.0, (2, 3): -2.5, (2, 4): -7.2,
        (3, 1): 0.0, (3, 2): -3.7, (3, 3): -9.5, (3, 4): -15.0,
        (4, 1): -1.5, (4, 2): -8.4, (4, 3): -15.0, (4, 4): -25.0,
    }
    correction = sum(
        steric_table.get((own_degree, carbon_degree(n.atom['id'])), 0.0)
        for n in neighbors_of(atom_id, ctx) if n.atom['element'] == 'C'
    )
    return base + correction


def classify_carbon(atom_id: str, ctx: Ctx) -> Dict[str, Any]:
    nbrs = neighbors_of(atom_id, ctx)
    is_aromatic = any(is_bond_aromatic(n.bond) for n in nbrs)

    heavy_nbr_count_early = sum(1 for n in nbrs if n.atom['element'] != 'H')
    if heavy_nbr_count_early == 2 and has_double_bond_to(atom_id, 'N', ctx) and has_double_bond_to(atom_id, 'O', ctx):
        return {'key': 'isocyanateC', 'label': 'Isocyanate carbon (N=C=O)', 'range': (120, 130)}
    if heavy_nbr_count_early == 2 and has_double_bond_to(atom_id, 'N', ctx) and has_double_bond_to(atom_id, 'S', ctx):
        return {'key': 'isothiocyanateC', 'label': 'Isothiocyanate carbon (N=C=S)', 'range': (128, 136)}

    carbonyl = carbonyl_context(atom_id, ctx)
    if carbonyl:
        if carbonyl['hasHeteroSingle']:
            subtype = carbonyl['subtype']
            if subtype == 'acid':
                return {'key': 'acidCarbonyl', 'label': 'Carboxylic acid carbon', 'range': (170, 185)}
            if subtype == 'ester':
                return {'key': 'esterCarbonyl', 'label': 'Ester carbon', 'range': (163, 175)}
            if subtype == 'lactone':
                return {'key': 'lactoneCarbonyl', 'label': 'Lactone carbon (cyclic ester)', 'range': (165, 178)}
            if subtype == 'amide':
                return {'key': 'amideCarbonyl', 'label': 'Amide carbon', 'range': (163, 178)}
            if subtype == 'lactam':
                return {'key': 'lactamCarbonyl', 'label': 'Lactam carbon (cyclic amide)', 'range': (165, 180)}
            if subtype == 'urea':
                return {'key': 'ureaCarbonyl', 'label': 'Urea carbon', 'range': (150, 159)}
            if subtype == 'carbamate':
                return {'key': 'carbamateCarbonyl', 'label': 'Carbamate carbon', 'range': (150, 158)}
            return {'key': 'carboxylOrEster', 'label': 'Carbonyl carbon (acid/ester/amide)', 'range': (160, 185)}
        if carbonyl['hCount'] >= 1:
            return {'key': 'aldehyde', 'label': 'Aldehyde carbon', 'range': (190, 205)}
        return {'key': 'ketone', 'label': 'Ketone carbon', 'range': (195, 220)}

    thiocarbonyl = thiocarbonyl_context(atom_id, ctx)
    if thiocarbonyl:
        subtype = thiocarbonyl['subtype']
        if subtype == 'thiourea':
            return {'key': 'thioureaCarbonyl', 'label': 'Thiourea carbon (C=S)', 'range': (181, 187)}
        if subtype == 'thioamide':
            return {'key': 'thioamideCarbonyl', 'label': 'Thioamide/thiourea carbon (C=S)', 'range': (178, 206)}
        if subtype == 'thionoester':
            return {'key': 'thionoesterCarbonyl', 'label': 'Thionoester carbon (C=S)', 'range': (205, 225)}
        if subtype == 'dithioic':
            return {'key': 'dithioicCarbonyl', 'label': 'Dithioic acid/ester carbon (C=S)', 'range': (220, 235)}
        if thiocarbonyl['hCount'] >= 1:
            return {'key': 'thioaldehyde', 'label': 'Thioaldehyde carbon (C=S)', 'range': (225, 245)}
        return {'key': 'thioketone', 'label': 'Thioketone carbon (C=S)', 'range': (225, 275)}

    heavy_nbr_count = sum(1 for n in nbrs if n.atom['element'] != 'H')
    if has_triple_bond_to(atom_id, 'N', ctx) and heavy_nbr_count == 1:
        return {'key': 'nitrile', 'label': 'Nitrile carbon', 'range': (115, 122)}
    if any(n.atom['element'] == 'C' and _bond_order(n.bond) == 3 for n in nbrs):
        return {'key': 'alkyne', 'label': 'Alkyne carbon', 'range': (65, 90)}

    if is_aromatic:
        has_hetero_substituent = (
            len(exocyclic_hetero_single_bond_neighbors(atom_id, 'O', ctx)) > 0
            or len(exocyclic_hetero_single_bond_neighbors(atom_id, 'N', ctx)) > 0
        )
        if has_hetero_substituent:
            return {'key': 'aromaticSubstituted', 'label': 'Aromatic carbon (substituted)', 'range': (144, 163)}
        has_no_attached_h = not has_any_attached_h(ctx.by_id[atom_id], ctx)
        if has_no_attached_h:
            return {'key': 'aromaticQuaternary', 'label': 'Aromatic carbon (no attached H)', 'range': (130, 145)}
        return {'key': 'aromatic', 'label': 'Aromatic carbon', 'range': (115, 135)}

    if any(n.atom['element'] == 'C' and _bond_order(n.bond) == 2 for n in nbrs):
        double_bond_partner = next(n for n in nbrs if n.atom['element'] == 'C' and _bond_order(n.bond) == 2)
        other_substituents = [n for n in nbrs if n.atom['id'] != double_bond_partner.atom['id'] and n.atom['element'] != 'H']
        if len(other_substituents) == 0:
            return {'key': 'alkeneTerminal', 'label': 'Alkene carbon (terminal, =CH2)', 'range': (108, 122)}
        return {'key': 'alkeneSubstituted', 'label': 'Alkene carbon (substituted)', 'range': (122, 145)}

    ring_info = strained_ring_info(atom_id, ctx)
    if ring_info:
        return strained_ring_carbon_class(atom_id, ctx, ring_info)

    metal_neighbor = next((n for n in nbrs if is_metal(n.atom)), None)
    if metal_neighbor:
        return {
            'key': 'organometallicC',
            'label': f"Carbon directly bonded to a metal ({metal_neighbor.atom['element']})",
            'range': (-20, 25),
        }

    azide_neighbor = next((n for n in nbrs if is_azide_attachment_nitrogen(n.atom, ctx)), None)
    if azide_neighbor:
        return {'key': 'cAzide', 'label': 'Carbon attached to an azide nitrogen (-N3)', 'range': (45, 60)}

    boron_neighbor = next((n for n in nbrs if n.atom['element'] == 'B' and _bond_order(n.bond) == 1), None)
    if boron_neighbor:
        return {
            'key': 'cBoron',
            'label': 'Carbon attached to boron (often weak/broadened by quadrupolar B)',
            'range': (5, 30),
        }

    phosphate_alkoxy_o = next(
        (n for n in nbrs if n.atom['element'] == 'O' and _bond_order(n.bond) == 1
         and any(m.atom['element'] == 'P' for m in neighbors_of(n.atom['id'], ctx))),
        None,
    )
    if phosphate_alkoxy_o:
        return {'key': 'cPhosphateAlkoxy', 'label': 'Carbon attached to a phosphate/phosphonate ester oxygen (-O-P(=O)-)', 'range': (58, 68)}

    phosphorus_neighbor = next((n for n in nbrs if n.atom['element'] == 'P' and _bond_order(n.bond) == 1), None)
    if phosphorus_neighbor:
        return {'key': 'cPhosphonate', 'label': 'Carbon directly bonded to phosphorus', 'range': (10, 35)}

    oxygen_singles = single_bond_neighbors(atom_id, 'O', ctx)
    if len(oxygen_singles) >= 2:
        return {'key': 'acetal', 'label': 'Acetal/ketal carbon (bonded to 2 oxygens)', 'range': (90, 112)}
    if oxygen_singles:
        role = oxygen_role(oxygen_singles[0].atom, atom_id, ctx)
        if role == 'esterAlkoxy':
            return {'key': 'cEsterAlkoxy', 'label': 'Ester/carbonate alkoxy carbon (-O-C(=O)-)', 'range': (50, 68)}
        if role == 'etherAryl':
            return {'key': 'cEtherAryl', 'label': 'Aryl ether alkyl carbon (e.g. Ar-O-CH3)', 'range': (54, 59)}
        if role == 'etherAlkyl':
            return {'key': 'cEtherAlkyl', 'label': 'Dialkyl ether carbon', 'range': (58, 80)}
        h_on_carbinol = total_attached_h(ctx.by_id[atom_id], ctx)
        if h_on_carbinol >= 3:
            return {'key': 'cAlcoholMethanol', 'label': 'Alcohol carbon (methanol-type, -CH3OH)', 'range': (48, 54)}
        if h_on_carbinol == 2:
            return {'key': 'cAlcoholPrimary', 'label': 'Primary alcohol carbon (-CH2OH)', 'range': (58, 66)}
        if h_on_carbinol == 1:
            return {'key': 'cAlcoholSecondary', 'label': 'Secondary alcohol carbon (-CHOH-)', 'range': (63, 76)}
        return {'key': 'cAlcoholTertiary', 'label': 'Tertiary alcohol carbon (-C(OH)<)', 'range': (69, 80)}

    if single_bond_neighbors(atom_id, 'N', ctx):
        return {'key': 'cAmine', 'label': 'Carbon attached to nitrogen', 'range': (35, 60)}

    sulfur_singles = single_bond_neighbors(atom_id, 'S', ctx)
    if sulfur_singles:
        double_o_on_s = sum(1 for n in neighbors_of(sulfur_singles[0].atom['id'], ctx) if n.atom['element'] == 'O' and _bond_order(n.bond) == 2)
        if double_o_on_s >= 2:
            return {'key': 'cSulfone', 'label': 'Carbon attached to sulfone sulfur (-SO2-)', 'range': (40, 48)}
        if double_o_on_s == 1:
            return {'key': 'cSulfoxide', 'label': 'Carbon attached to sulfoxide sulfur (-S(=O)-)', 'range': (37, 46)}
        if total_attached_h(sulfur_singles[0].atom, ctx) > 0:
            return {'key': 'cThiol', 'label': 'Carbon attached to thiol sulfur (-SH)', 'range': (12, 30)}
        return {'key': 'cSulfide', 'label': 'Carbon attached to sulfide sulfur (-S-)', 'range': (12, 30)}

    halogens = [n for n in nbrs if n.atom['element'] in ('F', 'Cl', 'Br', 'I')]
    if halogens:
        return classify_halide_carbon(halogens)

    heavy_c_neighbor_count = sum(1 for n in nbrs if n.atom['element'] == 'C')
    if heavy_c_neighbor_count == 0:
        gp = grant_paul_shift(atom_id, ctx)
        return {'key': 'methaneLike', 'label': 'Isolated sp3 carbon', 'range': (gp - 2.5, gp + 2.5)}

    h_on_this_carbon = total_attached_h(ctx.by_id[atom_id], ctx)

    # grant_paul_shift's carbon-counting BFS doesn't distinguish an
    # aromatic ring carbon from a plain alkyl one — and, calibrated
    # against real toluene (CH3: predicted 20.9 vs real 21.3) and
    # ibuprofen (its benzylic ArCH2: predicted 43.8 vs real 45.0), it
    # turns out not to need to: an aromatic ring's carbons simply being
    # *there*, within the same 1/2/3-bond counting the formula already
    # does, reproduces benzylic deshielding well on its own with no
    # separate correction. A carbonyl (or thiocarbonyl) neighbor is a
    # different story — it withdraws electron density well beyond what
    # counting it as "one more alpha carbon" suggests, so it gets an
    # explicit, empirically-calibrated offset on top of the Grant-Paul
    # base rather than a flat range: calibrated against acetone's alpha
    # CH3 (real 30.2) and methyl acetate's acyl CH3 (real 20.6), both of
    # which landed within 1 ppm of their real values using the *same*
    # +14 offset — Grant-Paul's own beta-carbon counting already
    # accounts for the difference between a ketone's alpha position
    # (whose carbonyl carbon has another carbon neighbor to count as
    # beta) and an ester's (whose carbonyl carbon's other neighbor is an
    # oxygen, contributing nothing to the carbon-only count), so no
    # separate hetero/non-hetero split is needed here either.
    carbonyl_neighbor = next((n for n in nbrs if n.atom['element'] == 'C' and carbonyl_context(n.atom['id'], ctx)), None)
    thiocarbonyl_neighbor = next((n for n in nbrs if n.atom['element'] == 'C' and thiocarbonyl_context(n.atom['id'], ctx)), None)

    if carbonyl_neighbor:
        gp = grant_paul_shift(atom_id, ctx) + 14
        suffix = {3: 'CH3', 2: 'CH2', 1: 'CH'}.get(h_on_this_carbon, 'Quaternary')
        return {'key': f'alkyl{suffix}AlphaCarbonyl', 'label': f'{suffix} alpha to a carbonyl', 'range': (gp - 4.5, gp + 4.5), 'grantPaul': True}

    if thiocarbonyl_neighbor:
        gp = grant_paul_shift(atom_id, ctx) + 16
        suffix = {3: 'CH3', 2: 'CH2', 1: 'CH'}.get(h_on_this_carbon, 'Quaternary')
        return {'key': f'alkyl{suffix}AlphaThiocarbonyl', 'label': f'{suffix} alpha to a thiocarbonyl (C=S)', 'range': (gp - 5.5, gp + 5.5), 'grantPaul': True}

    if h_on_this_carbon >= 3:
        gp = grant_paul_shift(atom_id, ctx)
        return {'key': 'alkylCH3', 'label': 'sp3 alkyl carbon (CH3)', 'range': (gp - 3.5, gp + 3.5), 'grantPaul': True}
    if h_on_this_carbon == 2:
        gp = grant_paul_shift(atom_id, ctx)
        return {'key': 'alkylCH2', 'label': 'sp3 alkyl carbon (CH2)', 'range': (gp - 3.5, gp + 3.5), 'grantPaul': True}
    if h_on_this_carbon == 1:
        gp = grant_paul_shift(atom_id, ctx)
        return {'key': 'alkylCH', 'label': 'sp3 alkyl carbon (CH)', 'range': (gp - 4.5, gp + 4.5), 'grantPaul': True}
    gp = grant_paul_shift(atom_id, ctx)
    return {'key': 'alkylQuaternary', 'label': 'sp3 alkyl carbon (quaternary)', 'range': (gp - 5.5, gp + 5.5), 'grantPaul': True}


def classify_hydrogens_on(atom, ctx: Ctx) -> Optional[Dict[str, Any]]:
    """Classifies the implicit hydrogens attached to `atom` — either
    "this H sits on a carbon, classify by that carbon's environment" or,
    for O/N carrying their own H directly, classify by what that
    heteroatom is attached to."""
    if atom['element'] == 'C':
        carbonyl = carbonyl_context(atom['id'], ctx)
        if carbonyl and not carbonyl['hasHeteroSingle'] and carbonyl['hCount'] >= 1:
            return {'key': 'aldehydeH', 'label': 'Aldehyde H', 'range': (9.3, 10.5)}
        if is_aromatic_atom(atom['id'], ctx):
            return {'key': 'aromaticH', 'label': 'Aromatic H', 'range': (6.3, 8.2)}
        if any(n.atom['element'] == 'C' and _bond_order(n.bond) == 2 for n in neighbors_of(atom['id'], ctx)):
            return {'key': 'vinylH', 'label': 'Vinyl (alkene) H', 'range': (4.5, 6.5)}
        if any(n.atom['element'] == 'C' and _bond_order(n.bond) == 3 for n in neighbors_of(atom['id'], ctx)):
            return {'key': 'alkyneH', 'label': 'Alkyne H', 'range': (1.8, 3.1)}
        ring_info = strained_ring_info(atom['id'], ctx)
        if ring_info:
            return strained_ring_hydrogen_class(atom['id'], ctx, ring_info)
        if any(is_metal(n.atom) for n in neighbors_of(atom['id'], ctx)):
            return {'key': 'organometallicH', 'label': 'H on carbon directly bonded to a metal', 'range': (-2.5, 0.6)}
        if any(is_azide_attachment_nitrogen(n.atom, ctx) for n in neighbors_of(atom['id'], ctx)):
            return {'key': 'azideCH', 'label': 'H on carbon attached to an azide nitrogen (-N3)', 'range': (3.1, 3.6)}
        if any(n.atom['element'] == 'B' and _bond_order(n.bond) == 1 for n in neighbors_of(atom['id'], ctx)):
            return {'key': 'bCH', 'label': 'H on carbon bonded to boron', 'range': (0.5, 1.8)}
        phosphate_alkoxy_o = next(
            (n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'O' and _bond_order(n.bond) == 1
             and any(m.atom['element'] == 'P' for m in neighbors_of(n.atom['id'], ctx))),
            None,
        )
        if phosphate_alkoxy_o:
            return {'key': 'opCH', 'label': 'H on carbon attached to a phosphate/phosphonate ester oxygen', 'range': (3.9, 4.3)}
        if any(n.atom['element'] == 'P' and _bond_order(n.bond) == 1 for n in neighbors_of(atom['id'], ctx)):
            return {'key': 'pCH', 'label': 'H on carbon directly bonded to phosphorus', 'range': (1.3, 2.1)}
        if len(single_bond_neighbors(atom['id'], 'O', ctx)) >= 2:
            return {'key': 'acetalH', 'label': 'Acetal/ketal CH (bonded to 2 oxygens)', 'range': (4.5, 5.6)}
        if single_bond_neighbors(atom['id'], 'O', ctx):
            return {'key': 'ocH', 'label': 'H on carbon bonded to O (e.g. -OCH-)', 'range': (3.3, 4.5)}
        if single_bond_neighbors(atom['id'], 'N', ctx):
            return {'key': 'ncH', 'label': 'H on carbon bonded to N', 'range': (2.3, 3.5)}
        if any(single_bond_neighbors(atom['id'], el, ctx) for el in ('F', 'Cl', 'Br', 'I')):
            return {'key': 'haloH', 'label': 'H on carbon bonded to a halogen', 'range': (3.0, 4.2)}

        sulfur_single = next(iter(single_bond_neighbors(atom['id'], 'S', ctx)), None)
        if sulfur_single:
            double_o_on_s = sum(1 for n in neighbors_of(sulfur_single.atom['id'], ctx) if n.atom['element'] == 'O' and _bond_order(n.bond) == 2)
            if double_o_on_s >= 2:
                return {'key': 'sulfoneH', 'label': 'H on carbon bonded to sulfone sulfur (-SO2-)', 'range': (2.8, 3.1)}
            if double_o_on_s == 1:
                return {'key': 'sulfoxideH', 'label': 'H on carbon bonded to sulfoxide sulfur (-S(=O)-)', 'range': (2.4, 2.7)}
            if total_attached_h(sulfur_single.atom, ctx) > 0:
                return {'key': 'thiolCH', 'label': 'H on carbon bonded to thiol sulfur (-SH)', 'range': (1.9, 2.3)}
            return {'key': 'sulfideH', 'label': 'H on carbon bonded to sulfide sulfur (-S-)', 'range': (1.9, 2.3)}

        if any(n.atom['element'] == 'C' and carbonyl_context(n.atom['id'], ctx) for n in neighbors_of(atom['id'], ctx)):
            return {'key': 'alphaCarbonylH', 'label': 'H alpha to a carbonyl', 'range': (2.0, 2.6)}
        if any(n.atom['element'] == 'C' and thiocarbonyl_context(n.atom['id'], ctx) for n in neighbors_of(atom['id'], ctx)):
            return {'key': 'alphaThiocarbonylH', 'label': 'H alpha to a thiocarbonyl (C=S)', 'range': (2.3, 2.8)}

        benzylic = any(
            n.atom['element'] == 'C' and any(is_bond_aromatic(m.bond) for m in neighbors_of(n.atom['id'], ctx))
            for n in neighbors_of(atom['id'], ctx)
        )
        if benzylic:
            return {'key': 'benzylicH', 'label': 'Benzylic H', 'range': (2.2, 2.9)}

        allylic = any(
            n.atom['element'] == 'C' and any(m.atom['element'] == 'C' and _bond_order(m.bond) == 2 for m in neighbors_of(n.atom['id'], ctx))
            for n in neighbors_of(atom['id'], ctx)
        )
        if allylic:
            return {'key': 'allylicH', 'label': 'Allylic H (adjacent to C=C)', 'range': (1.6, 2.3)}

        h = total_attached_h(atom, ctx)
        if h >= 3:
            return {'key': 'terminalCH', 'label': 'Terminal alkyl H (e.g. -CH3)', 'range': (0.85, 1.0)}
        if h == 2:
            return {'key': 'alkylCH2', 'label': 'Alkyl H (-CH2-)', 'range': (1.15, 1.4)}
        return {'key': 'alkylCH', 'label': 'Alkyl H (branch point, >CH-)', 'range': (1.4, 1.7)}

    if atom['element'] == 'O':
        n_neighbor = next((n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'N'), None)
        if n_neighbor and is_nitro_nitrogen(n_neighbor.atom['id'], ctx):
            return None
        boron_neighbor = next((n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'B'), None)
        if boron_neighbor:
            return {'key': 'boronOH', 'label': 'Boronic acid B-OH (variable, exchangeable)', 'range': (4, 8)}
        phosphorus_neighbor = next((n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'P'), None)
        if phosphorus_neighbor:
            return {'key': 'phosphorusOH', 'label': 'Phosphonic/phosphoric acid P-OH (variable, exchangeable)', 'range': (5, 12)}
        carbonyl_neighbor_c = next(
            (n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'C' and _bond_order(n.bond) == 1 and carbonyl_context(n.atom['id'], ctx)),
            None,
        )
        if carbonyl_neighbor_c:
            return {'key': 'acidOH', 'label': 'Carboxylic acid O-H', 'range': (10, 13)}
        aromatic_carbon_neighbor = next((n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'C' and is_aromatic_atom(n.atom['id'], ctx)), None)
        if aromatic_carbon_neighbor:
            if ring_neighbor_has_ewg(aromatic_carbon_neighbor.atom['id'], ctx):
                return {'key': 'hBondedPhenolOH', 'label': 'Phenol O-H, intramolecularly H-bonded (variable)', 'range': (9, 13)}
            return {'key': 'phenolOH', 'label': 'Phenol O-H (variable, exchangeable)', 'range': (4, 10)}
        return {'key': 'alcoholOH', 'label': 'Alcohol O-H (variable, exchangeable)', 'range': (1, 5)}

    if atom['element'] == 'N':
        amide_carbonyl_neighbor = any(n.atom['element'] == 'C' and _bond_order(n.bond) == 1 and carbonyl_context(n.atom['id'], ctx) for n in neighbors_of(atom['id'], ctx))
        if amide_carbonyl_neighbor:
            return {'key': 'amideNH', 'label': 'Amide N-H', 'range': (5, 9)}
        thioamide_carbonyl_neighbor = any(n.atom['element'] == 'C' and _bond_order(n.bond) == 1 and thiocarbonyl_context(n.atom['id'], ctx) for n in neighbors_of(atom['id'], ctx))
        if thioamide_carbonyl_neighbor:
            return {'key': 'thioamideNH', 'label': 'Thioamide N-H (variable, exchangeable)', 'range': (6, 10)}
        sulfonyl_neighbor = next(
            (n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'S' and _bond_order(n.bond) == 1
             and sum(1 for m in neighbors_of(n.atom['id'], ctx) if m.atom['element'] == 'O' and _bond_order(m.bond) == 2) >= 2),
            None,
        )
        if sulfonyl_neighbor:
            return {'key': 'sulfonamideNH', 'label': 'Sulfonamide N-H (variable, exchangeable)', 'range': (4.5, 7.0)}
        aromatic_ring_neighbor = any(is_bond_aromatic(n.bond) for n in neighbors_of(atom['id'], ctx))
        if aromatic_ring_neighbor:
            return {'key': 'aromaticRingNH', 'label': 'Aromatic ring N-H (pyrrole-type, highly variable)', 'range': (5, 11)}
        ring = find_smallest_ring(atom['id'], ctx)
        if ring and len(ring) in _RING_NH_RANGES:
            name = _RING_HETERO_NAME[(len(ring), 'N')]
            return {'key': f'ringNH_{len(ring)}', 'label': f'{name} ring N-H (variable, exchangeable)', 'range': _RING_NH_RANGES[len(ring)]}
        return {'key': 'amineNH', 'label': 'Amine N-H (variable, exchangeable)', 'range': (0.5, 5)}

    if atom['element'] == 'S':
        aromatic_carbon_neighbor = next((n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'C' and is_aromatic_atom(n.atom['id'], ctx)), None)
        if aromatic_carbon_neighbor:
            return {'key': 'thiophenolSH', 'label': 'Thiophenol S-H (variable, exchangeable)', 'range': (3.0, 4.0)}
        return {'key': 'thiolSH', 'label': 'Thiol S-H (variable, exchangeable)', 'range': (1.0, 2.5)}

    return None


# ---------------------------------------------------------------------
# Aromatic ring detection + ring-position refinement
# ---------------------------------------------------------------------

def find_aromatic_rings(atoms: List[Dict[str, Any]], ctx: Ctx, max_size: int = 6) -> List[List[str]]:
    """Simple rings made entirely of aromatic-flagged bonds, as lists of
    atom ids in cyclic order. Small-molecule DFS, dedup'd by atom set."""
    heavy_ids = [a['id'] for a in atoms if a['element'] != 'H' and not is_metal(a)]

    def aromatic_neighbor_ids(atom_id: str) -> List[str]:
        return [n.atom['id'] for n in neighbors_of(atom_id, ctx) if is_bond_aromatic(n.bond) and n.atom['element'] != 'H']

    seen = set()
    rings: List[List[str]] = []

    def dfs(start: str, path: List[str], visited: set):
        last = path[-1]
        for nxt in aromatic_neighbor_ids(last):
            if nxt == start and len(path) >= 3:
                key = ','.join(sorted(path))
                if key not in seen:
                    seen.add(key)
                    rings.append(list(path))
            elif nxt not in visited and len(path) < max_size:
                dfs(start, path + [nxt], visited | {nxt})

    for hid in heavy_ids:
        dfs(hid, [hid], {hid})
    return rings


RING_POSITION_RANGES_BY_CHARACTER: Dict[str, Dict[str, Range]] = {
    'donor': {'ortho': (110, 120), 'meta': (126, 131), 'para': (116, 124)},
    'acceptor': {'ortho': (122, 132), 'meta': (127, 131), 'para': (130, 140)},
    'neutral': {'ortho': (123, 129), 'meta': (126, 130), 'para': (123, 129)},
}
H_RING_POSITION_RANGES_BY_CHARACTER: Dict[str, Dict[str, Range]] = {
    'donor': {'ortho': (6.5, 6.9), 'meta': (7.1, 7.3), 'para': (6.6, 7.0)},
    'acceptor': {'ortho': (7.6, 8.3), 'meta': (7.4, 7.7), 'para': (7.5, 7.8)},
    'neutral': {'ortho': (7.0, 7.3), 'meta': (7.15, 7.35), 'para': (7.0, 7.3)},
}


def is_nitro_nitrogen(nitrogen_atom_id: str, ctx: Ctx) -> bool:
    """Recognizes a nitro group's nitrogen regardless of which resonance
    form it was drawn in — the real fingerprint is exactly two oxygen
    neighbors, each terminal (bonded to nothing else)."""
    oxygen_neighbors = [n for n in neighbors_of(nitrogen_atom_id, ctx) if n.atom['element'] == 'O']
    if len(oxygen_neighbors) != 2:
        return False
    return all(len(neighbors_of(n.atom['id'], ctx)) == 1 for n in oxygen_neighbors)


def substituent_character(ring_carbon_id: str, ctx: Ctx, class_by_atom_id: Dict[str, Dict[str, Any]]) -> str:
    cls = class_by_atom_id.get(ring_carbon_id)
    key = cls['key'] if cls else None
    if key == 'aromaticSubstituted':
        o_hetero = exocyclic_hetero_single_bond_neighbors(ring_carbon_id, 'O', ctx)
        n_hetero = exocyclic_hetero_single_bond_neighbors(ring_carbon_id, 'N', ctx)
        hetero_single = (o_hetero[0] if o_hetero else None) or (n_hetero[0] if n_hetero else None)
        if hetero_single and hetero_single.atom['element'] == 'N' and is_nitro_nitrogen(hetero_single.atom['id'], ctx):
            return 'acceptor'
        return 'donor'
    if key == 'aromaticQuaternary':
        c_neighbor = next((n for n in neighbors_of(ring_carbon_id, ctx) if n.atom['element'] == 'C' and not is_bond_aromatic(n.bond)), None)
        if c_neighbor and (carbonyl_context(c_neighbor.atom['id'], ctx) or has_triple_bond_to(c_neighbor.atom['id'], 'N', ctx)):
            return 'acceptor'
        return 'neutral'
    return 'neutral'


def refine_substituted_ring_positions(atoms, ctx: Ctx, class_by_atom_id: Dict[str, Dict[str, Any]]) -> None:
    """Relabels the non-substituent carbons of a monocyclic, monosubstituted
    or disubstituted 6-membered all-carbon aromatic ring by ortho/meta/para
    position, mutating class_by_atom_id in place."""
    rings = [r for r in find_aromatic_rings(atoms, ctx, 6) if len(r) == 6]
    for ring in rings:
        if any(ctx.by_id[rid]['element'] != 'C' for rid in ring):
            continue
        ring_set = set(ring)
        is_fused = any(
            any(is_bond_aromatic(n.bond) and n.atom['id'] not in ring_set and n.atom['element'] != 'H' for n in neighbors_of(rid, ctx))
            for rid in ring
        )
        if is_fused:
            continue

        substituent_points = [rid for rid in ring if class_by_atom_id.get(rid, {}).get('key') in ('aromaticSubstituted', 'aromaticQuaternary')]
        if len(substituent_points) < 1 or len(substituent_points) > 2:
            continue

        n = len(ring)
        idx_a = ring.index(substituent_points[0])
        idx_b = ring.index(substituent_points[1]) if len(substituent_points) == 2 else None
        char_a = substituent_character(substituent_points[0], ctx, class_by_atom_id)
        char_b = substituent_character(substituent_points[1], ctx, class_by_atom_id) if idx_b is not None else None

        def cyclic_dist(i, j):
            return min(abs(i - j), n - abs(i - j))

        def position_label(dist):
            return 'ortho' if dist == 1 else ('meta' if dist == 2 else 'para')

        for i, rid in enumerate(ring):
            if i == idx_a or i == idx_b:
                continue
            cls = class_by_atom_id.get(rid)
            if not cls or cls['key'] != 'aromatic':
                continue
            dist_a = cyclic_dist(i, idx_a)
            pos_label = position_label(dist_a)
            if idx_b is None:
                class_by_atom_id[rid] = {
                    'key': f'aromaticPos{dist_a}',
                    'label': f'Aromatic CH ({pos_label}, {char_a})',
                    'range': RING_POSITION_RANGES_BY_CHARACTER[char_a][pos_label],
                    'posLabel': pos_label,
                    'character': char_a,
                }
            else:
                dist_b = cyclic_dist(i, idx_b)
                nearer_char = char_b if dist_b < dist_a else char_a
                class_by_atom_id[rid] = {
                    'key': f'aromaticPos{dist_a}_{dist_b}',
                    'label': f'Aromatic CH ({pos_label}-type, ring position {dist_a}-{dist_b})',
                    'range': RING_POSITION_RANGES_BY_CHARACTER[nearer_char][pos_label],
                    'posLabel': pos_label,
                    'character': nearer_char,
                }


def aromatic_neighbors(atom_id: str, ctx: Ctx) -> List[Neighbor]:
    return [n for n in neighbors_of(atom_id, ctx) if is_bond_aromatic(n.bond) and n.atom['element'] != 'H' and not is_metal(n.atom)]


def is_ring_junction_carbon(atom_id: str, ctx: Ctx) -> bool:
    """A true ring-fusion carbon (naphthalene's C4a/C8a...) is bonded to
    three other ring atoms, all via aromatic bonds."""
    return len(aromatic_neighbors(atom_id, ctx)) == 3


FUSED_RING_RANGES_C: Dict[str, Range] = {'alpha': (126, 129), 'beta': (124, 128), 'meso': (130, 134), 'junction': (128, 135)}
FUSED_RING_RANGES_H: Dict[str, Range] = {'alpha': (7.7, 8.1), 'beta': (7.35, 7.55), 'meso': (8.3, 8.5)}


def refine_fused_ring_positions(atoms, ctx: Ctx, class_by_atom_id: Dict[str, Dict[str, Any]]) -> None:
    """Fused all-carbon polycyclics (naphthalene, anthracene): reclassifies
    ring-junction carbons and relabels plain aromatic CH's by alpha/beta/
    meso position (distance to the nearest fusion carbons)."""
    has_junction = any(
        a['element'] != 'H' and not is_metal(a)
        and class_by_atom_id.get(a['id'], {}).get('key') == 'aromaticQuaternary'
        and is_ring_junction_carbon(a['id'], ctx)
        for a in atoms
    )
    if not has_junction:
        return

    for atom in atoms:
        if atom['element'] == 'H' or is_metal(atom):
            continue
        cls = class_by_atom_id.get(atom['id'])
        if not cls:
            continue

        if cls['key'] == 'aromaticQuaternary' and is_ring_junction_carbon(atom['id'], ctx):
            class_by_atom_id[atom['id']] = {
                'key': 'aromaticFusedJunction',
                'label': 'Aromatic ring-fusion carbon (no attached H)',
                'range': FUSED_RING_RANGES_C['junction'],
            }
            continue

        if cls['key'] == 'aromatic':
            junction_neighbors = sum(1 for n in aromatic_neighbors(atom['id'], ctx) if is_ring_junction_carbon(n.atom['id'], ctx))
            pos_label = 'meso' if junction_neighbors >= 2 else ('alpha' if junction_neighbors == 1 else 'beta')
            class_by_atom_id[atom['id']] = {
                'key': f'aromaticFused_{pos_label}',
                'label': f'Aromatic CH (fused-ring {pos_label} position)',
                'range': FUSED_RING_RANGES_C[pos_label],
                'posLabel': pos_label,
                'fused': True,
            }


HETEROAROMATIC_RANGES_C: Dict[str, Dict[str, Range]] = {
    'N6': {'alpha': (147, 152), 'beta': (122, 126), 'gamma': (133, 139)},  # pyridine-type
    'N5': {'alpha': (115, 120), 'beta': (106, 111)},  # pyrrole-type (ring N-H)
    'O5': {'alpha': (140, 145), 'beta': (107, 112)},  # furan-type
    'S5': {'alpha': (123, 127), 'beta': (125, 129)},  # thiophene-type
}
HETEROAROMATIC_RANGES_H: Dict[str, Dict[str, Range]] = {
    'N6': {'alpha': (8.4, 8.7), 'beta': (7.1, 7.35), 'gamma': (7.5, 7.85)},
    'N5': {'alpha': (6.4, 6.8), 'beta': (6.0, 6.3)},
    'O5': {'alpha': (7.2, 7.5), 'beta': (6.2, 6.5)},
    'S5': {'alpha': (7.1, 7.35), 'beta': (6.9, 7.1)},
}


def refine_heteroaromatic_ring_positions(atoms, ctx: Ctx, class_by_atom_id: Dict[str, Dict[str, Any]]) -> None:
    """Single-heteroatom 5- or 6-membered aromatic rings (pyridine,
    pyrrole, furan, thiophene, or a substituted version), not fused to
    another ring — those are handled by refine_fused_heteroaromatic_ring_positions."""
    rings = [r for r in find_aromatic_rings(atoms, ctx, 6) if len(r) in (5, 6)]
    for ring in rings:
        ring_set = set(ring)
        is_fused = any(
            any(is_bond_aromatic(n.bond) and n.atom['id'] not in ring_set and n.atom['element'] != 'H' for n in neighbors_of(rid, ctx))
            for rid in ring
        )
        if is_fused:
            continue

        hetero_spots = [(i, rid) for i, rid in enumerate(ring) if ctx.by_id[rid]['element'] != 'C']
        if len(hetero_spots) != 1:
            continue
        hetero_i, hetero_id = hetero_spots[0]
        hetero_element = ctx.by_id[hetero_id]['element']
        if hetero_element not in ('N', 'O', 'S'):
            continue
        if len(ring) == 6 and hetero_element != 'N':
            continue

        range_key = f'{hetero_element}{len(ring)}'
        c_ranges = HETEROAROMATIC_RANGES_C.get(range_key)
        if not c_ranges:
            continue

        n = len(ring)

        def cyclic_dist(i, j):
            return min(abs(i - j), n - abs(i - j))

        for i, rid in enumerate(ring):
            if i == hetero_i:
                continue
            cls = class_by_atom_id.get(rid)
            if not cls or cls['key'] != 'aromatic':
                continue
            dist = cyclic_dist(i, hetero_i)
            pos_label = 'alpha' if dist == 1 else ('beta' if dist == 2 else 'gamma')
            if pos_label not in c_ranges:
                continue
            class_by_atom_id[rid] = {
                'key': f'heteroaromatic_{range_key}_{pos_label}',
                'label': f'Heteroaromatic CH ({pos_label} to ring {hetero_element})',
                'range': c_ranges[pos_label],
                'heteroaromatic': True,
                'heteroRangeKey': range_key,
                'posLabel': pos_label,
            }


FUSED_HETEROAROMATIC_WIDEN_C = 4
FUSED_HETEROAROMATIC_WIDEN_H = 0.3


def widen_range(rng: Range, amount: float) -> Range:
    return (rng[0] - amount, rng[1] + amount)


FUSED_HETEROCYCLE_NAMES = {'N6': 'Quinoline/isoquinoline', 'N5': 'Indole', 'O5': 'Benzofuran', 'S5': 'Benzothiophene'}


def refine_fused_heteroaromatic_ring_positions(atoms, ctx: Ctx, class_by_atom_id: Dict[str, Dict[str, Any]]) -> None:
    """Ortho-fused bicyclic aromatic heterocycles — quinoline/isoquinoline,
    indole, benzofuran, benzothiophene: a plain-benzo ring ortho-fused to a
    single-heteroatom hetero-ring. Run first in the refinement pipeline so
    it claims its atoms before the more general passes."""
    rings = [r for r in find_aromatic_rings(atoms, ctx, 6) if len(r) in (5, 6)]
    for a in range(len(rings)):
        for b in range(a + 1, len(rings)):
            ring_a, ring_b = rings[a], rings[b]
            set_a = set(ring_a)
            shared = [rid for rid in ring_b if rid in set_a]
            if len(shared) != 2:
                continue

            def is_all_carbon_6(ring):
                return len(ring) == 6 and all(ctx.by_id[rid]['element'] == 'C' for rid in ring)

            if is_all_carbon_6(ring_a) and not is_all_carbon_6(ring_b):
                hetero_ring = ring_b
            elif is_all_carbon_6(ring_b) and not is_all_carbon_6(ring_a):
                hetero_ring = ring_a
            else:
                continue

            hetero_spots = [(i, rid) for i, rid in enumerate(hetero_ring) if ctx.by_id[rid]['element'] != 'C']
            if len(hetero_spots) != 1:
                continue
            hetero_i, hetero_id = hetero_spots[0]
            hetero_element = ctx.by_id[hetero_id]['element']
            if hetero_element not in ('N', 'O', 'S'):
                continue
            if len(hetero_ring) == 6 and hetero_element != 'N':
                continue

            range_key = f'{hetero_element}{len(hetero_ring)}'
            base_c_ranges = HETEROAROMATIC_RANGES_C.get(range_key)
            base_h_ranges = HETEROAROMATIC_RANGES_H.get(range_key)
            if not base_c_ranges:
                continue

            n = len(hetero_ring)

            def cyclic_dist(i, j):
                return min(abs(i - j), n - abs(i - j))

            shared_set = set(shared)
            for i, rid in enumerate(hetero_ring):
                if rid in shared_set or i == hetero_i:
                    continue
                cls = class_by_atom_id.get(rid)
                if not cls or cls['key'] != 'aromatic':
                    continue
                dist_hetero = cyclic_dist(i, hetero_i)
                pos_label = 'alpha' if dist_hetero == 1 else ('beta' if dist_hetero == 2 else 'gamma')
                if pos_label not in base_c_ranges:
                    continue
                c_range = widen_range(base_c_ranges[pos_label], FUSED_HETEROAROMATIC_WIDEN_C)
                h_range = widen_range(base_h_ranges[pos_label], FUSED_HETEROAROMATIC_WIDEN_H) if base_h_ranges and pos_label in base_h_ranges else None
                class_by_atom_id[rid] = {
                    'key': f'fusedHeteroaromatic_{range_key}_{pos_label}',
                    'label': f'{FUSED_HETEROCYCLE_NAMES[range_key]}-type CH ({pos_label} to ring {hetero_element})',
                    'range': c_range,
                    'heteroaromatic': True,
                    'fused': True,
                    'heteroRangeKey': range_key,
                    'posLabel': pos_label,
                    'hRange': h_range,
                }


# ---------------------------------------------------------------------
# Named natural-product scaffolds: coumarin, chromone, flavone
# ---------------------------------------------------------------------
#
# Coumarin (2H-chromen-2-one) and chromone (4H-chromen-4-one, the flavone/
# isoflavone parent core) are both a benzo ring ortho-fused to a
# 6-membered, single-oxygen, non-aromatic pyranone ring — same skeleton,
# differing only in *which* ring carbon carries the carbonyl relative to
# the ring oxygen. That structural distinction is exactly what the two
# real chemistries hinge on: coumarin's carbonyl sits directly on the
# ring oxygen (a genuine lactone, conjugated with the C3=C4 alkene), while
# chromone's sits two atoms away, across the ring, giving a
# vinylogous-ester/cross-conjugated-enone character that pushes its
# carbonyl a good 15+ ppm further downfield than coumarin's and its own
# C2-H (a vinyl ether carbon doubling as conjugated-enone beta-carbon)
# unusually far downfield too. A flavone is simply a chromone with an aryl
# group at C2 instead of H — recognized here by checking for exactly that
# substituent, since real flavones (chrysin, apigenin, luteolin...) all
# share this core regardless of their ring-A/ring-B substitution pattern,
# which is why per-flavone-compound hardcoding isn't needed: detecting
# the scaffold once covers the whole family.
#
# Values below were checked against real literature reference shifts for
# these very well-studied natural-product cores (plain coumarin and
# plain flavone/chromone).

def detect_coumarin_chromone_scaffold(atoms, ctx: Ctx) -> Dict[str, Dict[str, Any]]:
    """Returns a map from ring-atom-id to a classification override dict
    for any coumarin or chromone/flavone scaffold found in the molecule.
    Each override carries a 13C `range`, and — for atoms bearing a ring
    proton — an `hRange`/`hKey` pair consumed by predict_nmr's 1H pass."""
    overrides: Dict[str, Dict[str, Any]] = {}
    all_rings = find_rings_of_size(atoms, ctx, 6)
    benzo_rings = [
        r for r in find_aromatic_rings(atoms, ctx, 6)
        if len(r) == 6 and all(ctx.by_id[a]['element'] == 'C' for a in r)
    ]
    if not benzo_rings:
        return overrides

    def cyclic_adjacent(i: int, j: int, n: int) -> bool:
        return abs(i - j) == 1 or abs(i - j) == n - 1

    for ring in all_rings:
        elements = [ctx.by_id[a]['element'] for a in ring]
        if elements.count('O') != 1 or elements.count('C') != 5:
            continue
        ring_set = set(ring)
        o_idx = elements.index('O')

        fusion_atoms = None
        for benzo in benzo_rings:
            shared = [a for a in benzo if a in ring_set]
            if len(shared) == 2:
                i0, i1 = ring.index(shared[0]), ring.index(shared[1])
                if cyclic_adjacent(i0, i1, len(ring)):
                    fusion_atoms = shared
                    break
        if not fusion_atoms:
            continue

        carbonyl_idx = None
        for i, aid in enumerate(ring):
            if ctx.by_id[aid]['element'] != 'C':
                continue
            if any(n.atom['id'] not in ring_set and n.atom['element'] == 'O' and _bond_order(n.bond) == 2 for n in neighbors_of(aid, ctx)):
                carbonyl_idx = i
                break
        if carbonyl_idx is None:
            continue

        n = len(ring)
        fusion_idxs = [ring.index(a) for a in fusion_atoms]
        is_coumarin = cyclic_adjacent(carbonyl_idx, o_idx, n)
        is_chromone = (not is_coumarin) and any(cyclic_adjacent(carbonyl_idx, fi, n) for fi in fusion_idxs)
        if not (is_coumarin or is_chromone):
            continue

        carbonyl_id = ring[carbonyl_idx]
        ring_neighbors_of_carbonyl = [ring[(carbonyl_idx - 1) % n], ring[(carbonyl_idx + 1) % n]]

        if is_coumarin:
            c3_id = next(a for a in ring_neighbors_of_carbonyl if a != ring[o_idx])
            c3_idx = ring.index(c3_id)
            c4_idx = (c3_idx + 1) % n if (c3_idx + 1) % n != carbonyl_idx else (c3_idx - 1) % n
            c4_id = ring[c4_idx]
            overrides[carbonyl_id] = {'key': 'coumarinCarbonyl', 'label': 'Coumarin lactone carbonyl', 'range': (159, 163), 'scaffold': 'coumarin'}
            overrides[c3_id] = {
                'key': 'coumarinC3', 'label': 'Coumarin C3 (alpha to the lactone carbonyl, vinylic)', 'range': (115, 118),
                'scaffold': 'coumarin', 'hRange': (6.15, 6.35), 'hKey': 'coumarinC3H',
            }
            overrides[c4_id] = {
                'key': 'coumarinC4', 'label': 'Coumarin C4 (vinylic, conjugated with the carbonyl through the ring)', 'range': (142, 144.5),
                'scaffold': 'coumarin', 'hRange': (7.55, 7.85), 'hKey': 'coumarinC4H',
            }
        else:
            fusion_adj_idx = next(fi for fi in fusion_idxs if cyclic_adjacent(carbonyl_idx, fi, n))
            c3_id = next(a for a in ring_neighbors_of_carbonyl if ring.index(a) != fusion_adj_idx)
            c3_idx = ring.index(c3_id)
            c2_idx = (c3_idx + 1) % n if (c3_idx + 1) % n != carbonyl_idx else (c3_idx - 1) % n
            c2_id = ring[c2_idx]
            aryl_sub = next(
                (m for m in neighbors_of(c2_id, ctx) if m.atom['id'] not in ring_set and m.atom['element'] == 'C' and any(is_bond_aromatic(k.bond) for k in neighbors_of(m.atom['id'], ctx))),
                None,
            )
            is_flavone = aryl_sub is not None
            scaffold = 'flavone' if is_flavone else 'chromone'

            overrides[carbonyl_id] = {'key': 'chromoneCarbonyl', 'label': f'{"Flavone" if is_flavone else "Chromone"} C4 carbonyl', 'range': (176, 179), 'scaffold': scaffold}
            overrides[c3_id] = {
                'key': 'chromoneC3', 'label': f'{"Flavone" if is_flavone else "Chromone"} C3 (alpha to the carbonyl, vinylic)', 'range': (107, 113),
                'scaffold': scaffold, 'hRange': (6.15, 6.35), 'hKey': 'chromoneC3H',
            }
            if is_flavone:
                overrides[c2_id] = {'key': 'flavoneC2', 'label': 'Flavone C2 (vinyl ether carbon, aryl-substituted, no attached H)', 'range': (163, 164.5), 'scaffold': 'flavone'}
            else:
                overrides[c2_id] = {
                    'key': 'chromoneC2', 'label': 'Chromone C2 (vinyl ether carbon)', 'range': (155, 157.5),
                    'scaffold': 'chromone', 'hRange': (7.7, 8.0), 'hKey': 'chromoneC2H',
                }

    return overrides


# ---------------------------------------------------------------------
# Shift assignment within a shared range
# ---------------------------------------------------------------------

def assign_refined_shifts(groups: List[Dict[str, Any]]) -> None:
    """Assigns each peak's final predicted `shift`, mutating every group in
    place. Peaks sharing an exact [lo,hi] range are grouped into one bucket
    and laid out across evenly-spaced slots spanning the central 80% of the
    range, with a small deterministic per-slot jitter, rather than all
    landing on the flat range midpoint."""
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for g in groups:
        bucket_key = f"{g['range'][0]}|{g['range'][1]}"
        buckets.setdefault(bucket_key, []).append(g)

    def seed_of(g):
        return f"{g['key']}|{','.join(sorted(g.get('atomIds') or []))}"

    for bucket in buckets.values():
        bucket.sort(key=seed_of)
        lo, hi = bucket[0]['range']
        span = hi - lo
        n = len(bucket)
        for k, g in enumerate(bucket):
            if span <= 0:
                g['shift'] = round(lo, 2)
                continue
            jitter = (stable_fraction(seed_of(g)) - 0.5) * 0.06
            slot_center = 0.5 if n == 1 else (k + 0.5) / n
            frac = min(0.92, max(0.08, 0.1 + 0.8 * slot_center + jitter))
            g['shift'] = round(lo + span * frac, 2)


def aromatic_multiplicity_for(carbon_cls: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Typical (teaching-level) representative J values for an aromatic-
    type proton whose ring position is already resolved."""
    if not carbon_cls or not carbon_cls.get('posLabel'):
        return None
    if carbon_cls.get('heteroaromatic'):
        hrk = carbon_cls.get('heteroRangeKey')
        if hrk and hrk.endswith('6'):
            if carbon_cls['posLabel'] == 'alpha':
                return {'multiplicity': 'dd', 'jHz': [4.9, 1.8]}
            if carbon_cls['posLabel'] == 'beta':
                return {'multiplicity': 'dd', 'jHz': [7.7, 4.9]}
            if carbon_cls['posLabel'] == 'gamma':
                return {'multiplicity': 't', 'jHz': [7.7, 7.7]}
        return {'multiplicity': 'd', 'jHz': [3.4]}
    if carbon_cls.get('fused'):
        if carbon_cls['posLabel'] == 'meso':
            return {'multiplicity': 's', 'jHz': []}
        return {'multiplicity': 'dd', 'jHz': [8.0, 1.1]}
    if carbon_cls['posLabel'] == 'ortho':
        return {'multiplicity': 'ddd', 'jHz': [7.8, 1.4, 0.5]}
    if carbon_cls['posLabel'] == 'meta':
        return {'multiplicity': 'ddd', 'jHz': [7.6, 7.6, 1.4]}
    if carbon_cls['posLabel'] == 'para':
        return {'multiplicity': 't', 'jHz': [7.5, 7.5]}
    return None


def is_aromatic_atom(atom_id: str, ctx: Ctx) -> bool:
    return any(is_bond_aromatic(n.bond) for n in neighbors_of(atom_id, ctx))


def ring_neighbor_has_ewg(ring_carbon_id: str, ctx: Ctx) -> bool:
    """Does either ring neighbor of this aromatic carbon carry an
    electron-withdrawing substituent (carbonyl or nitrile) close enough to
    intramolecularly H-bond with an O-H on this carbon (the
    salicylaldehyde/salicylic-acid picture)?"""
    ring_neighbors = [n for n in neighbors_of(ring_carbon_id, ctx) if is_bond_aromatic(n.bond)]
    for rn in ring_neighbors:
        substituent = next((m for m in neighbors_of(rn.atom['id'], ctx) if m.atom['element'] == 'C' and not is_bond_aromatic(m.bond)), None)
        if not substituent:
            continue
        if carbonyl_context(substituent.atom['id'], ctx) or has_triple_bond_to(substituent.atom['id'], 'N', ctx):
            return True
    return False


def compute_symmetry_classes(atoms, ctx: Ctx) -> Dict[str, int]:
    """Iterative color refinement (1-D Weisfeiler-Leman / Morgan-algorithm
    style) — tells genuinely graph-symmetry-equivalent atoms apart from
    atoms that merely share a coarse classification. Returns a map from
    atom id to an opaque color-class integer; only equality between two
    atoms' colors is meaningful."""
    heavy_atoms = [a for a in atoms if a['element'] != 'H' and not is_metal(a)]
    heavy_neighbors = {
        a['id']: [n for n in neighbors_of(a['id'], ctx) if n.atom['element'] != 'H' and not is_metal(n.atom)]
        for a in heavy_atoms
    }

    def bond_tag(n: Neighbor) -> str:
        # Aromatic bonds always tag 'a' regardless of raw Kekulé order —
        # a Kekulé structure's specific single/double placement is a
        # drawing artifact, not a real chemical distinction, and keeping
        # the raw order here would fracture real symmetry-equivalent atoms
        # (e.g. anthracene's two "meso-adjacent" alpha carbons) into
        # different colors depending on which resonance form was drawn.
        if is_bond_aromatic(n.bond):
            return 'a'
        return str(_bond_order(n.bond))

    def intern(raw_by_id: Dict[str, str]):
        id_of: Dict[str, int] = {}
        result: Dict[str, int] = {}
        for atom in heavy_atoms:
            raw = raw_by_id[atom['id']]
            if raw not in id_of:
                id_of[raw] = len(id_of)
            result[atom['id']] = id_of[raw]
        return result, len(id_of)

    initial_raw = {}
    for atom in heavy_atoms:
        bond_sig = ','.join(sorted(bond_tag(n) for n in heavy_neighbors.get(atom['id'], [])))
        initial_raw[atom['id']] = f"{atom['element']}|{atom.get('charge') or 0}|H{total_attached_h(atom, ctx)}|[{bond_sig}]"
    colors, class_count = intern(initial_raw)

    for _round in range(len(heavy_atoms)):
        raw_by_id = {}
        for atom in heavy_atoms:
            nbr_sig = ','.join(sorted(f"{colors[n.atom['id']]}~{bond_tag(n)}" for n in heavy_neighbors.get(atom['id'], [])))
            raw_by_id[atom['id']] = f"{colors[atom['id']]}::{nbr_sig}"
        next_colors, next_class_count = intern(raw_by_id)
        if next_class_count == class_count:
            break
        colors, class_count = next_colors, next_class_count

    return colors


def group_signature(cls: Dict[str, Any], atom_id: str, symmetry_classes: Dict[str, int]) -> str:
    return f"{cls['key']}|{symmetry_classes.get(atom_id)}"


def dept_carbon_type(h_count: int) -> str:
    if h_count >= 3:
        return 'CH3'
    if h_count == 2:
        return 'CH2'
    if h_count == 1:
        return 'CH'
    return 'C (no attached H)'


# ---------------------------------------------------------------------
# Explanations + confidence
# ---------------------------------------------------------------------

_EXPLAIN_EXACT: Dict[str, str] = {
    'acidOH': 'Very deshielded: a carboxylic acid O-H is pulled downfield by resonance with the adjacent C=O and by strong hydrogen bonding — one of the most downfield common proton environments.',
    'hBondedPhenolOH': "Deshielded like a phenol O-H (the oxygen's lone pair delocalizes into the ring), and pulled further downfield by intramolecular hydrogen bonding to a nearby group.",
    'phenolOH': "Deshielded relative to a plain alcohol because the phenolic oxygen's lone pair is partly delocalized into the aromatic ring.",
    'alcoholOH': 'A plain alcohol O-H — its position is variable since it exchanges rapidly with trace water and hydrogen-bonds to solvent.',
    'thioamideNH': "Deshielded even further than a plain amide N-H: C=S's weaker pi-bond pushes more double-bond character onto the C-N bond than C=O does.",
    'amideNH': 'Deshielded by the adjacent C=O: resonance gives the N-H significant double-bond character, pulling electron density away from the proton.',
    'aromaticRingNH': "This N-H's lone pair is part of the ring's own aromatic pi system (pyrrole-type), giving it amide-like deshielding.",
    'amineNH': 'A plain amine N-H — nitrogen is only mildly electronegative, so this is not strongly deshielded, and its exact position is unpredictable since it exchanges readily.',
    'thiophenolSH': "Deshielded like a phenol O-H, for the same ring-conjugation reason, though sulfur's lower electronegativity keeps it less downfield than an O-H would be.",
    'thiolSH': 'A plain thiol S-H — sulfur is far less electronegative than oxygen, so this sits notably upfield of an alcohol O-H; its position is still variable since it exchanges.',
    'alphaCarbonylH': "Deshielded because it's alpha (directly attached) to a carbonyl carbon — the electron-withdrawing C=O pulls electron density away through the sigma bond.",
    'alphaThiocarbonylH': "Deshielded because it's alpha to a thiocarbonyl (C=S) carbon — the sulfur analog of the same alpha-to-carbonyl effect.",
    'lactoneCarbonyl': 'A lactone (cyclic ester) carbonyl — the same resonance-withdrawal picture as an open-chain ester, with ring size shifting the exact real-world position a bit further (small, strained rings sit further downfield).',
    'lactamCarbonyl': 'A lactam (cyclic amide) carbonyl — the same resonance-withdrawal picture as an open-chain amide, with ring strain in smaller rings (e.g. a beta-lactam) pulling it further from the open-chain value.',
    'ureaCarbonyl': 'A urea carbonyl, flanked by two nitrogens instead of one — the second nitrogen donates extra electron density by resonance, shielding it further upfield than a plain amide carbonyl.',
    'carbamateCarbonyl': 'A carbamate carbonyl, flanked by both a nitrogen and an oxygen — sits between a plain ester and a plain amide carbonyl for the same resonance-donation reason.',
    'thioureaCarbonyl': "A thiourea carbonyl (C=S flanked by two nitrogens) — the second nitrogen's extra resonance donation keeps this a bit further upfield than a plain thioamide.",
    'aldehydeH': "Strongly deshielded: the aldehyde proton is both attached directly to the sp2 carbonyl carbon and effectively alpha to the C=O's electron withdrawal — the two effects combine.",
    'nitrile': 'The nitrile carbon is deshielded by the C\u2261N triple bond, though somewhat less than a carbonyl carbon since the extra bonds go to nitrogen rather than the more electronegative oxygen.',
    'acetal': 'Deshielded well past a normal C-O carbon because this carbon is flanked by *two* electronegative oxygens at once — their inductive pull compounds.',
    'acetalH': 'Deshielded because the carbon this proton sits on is flanked by two electronegative oxygens at once (an acetal carbon) — their inductive pull compounds.',
    'aromaticSubstituted': 'This is the ring carbon a substituent is directly attached to — still deshielded by the aromatic ring current, with the substituent shifting it further one way or the other.',
    'aromaticQuaternary': 'This is the ring carbon a substituent is directly attached to — still deshielded by the aromatic ring current, with the substituent shifting it further one way or the other.',
    'aromatic': "Deshielded by the aromatic ring current: the ring's delocalized pi-electrons circulate under the external magnetic field and generate a local field that reinforces it at this position.",
    'aromaticH': "Deshielded by the aromatic ring current: the ring's delocalized pi-electrons circulate under the external magnetic field and generate a local field that reinforces it at this position.",
    'allylicH': "Deshielded by being directly attached to a C=C double bond's pi system — a smaller, non-cyclic version of the same anisotropic effect a benzylic proton feels from an aromatic ring.",
    'vinylH': "Deshielded by the same pi-electron effect a C=C double bond produces — similar in kind to an aromatic ring's, just weaker.",
    'alkyneH': "An exception to the usual pattern: the triple bond's cylindrical magnetic anisotropy actually *shields* this proton, so it sits upfield of a typical vinyl proton despite the extra unsaturation.",
    'alkyne': 'An sp carbon: the triple bond puts this carbon in its own comparatively narrow range, distinct from sp2 (alkene/aromatic) or sp3 carbons.',
    'benzylicH': "Deshielded by being directly attached to an aromatic ring — some of the ring's anisotropic effect reaches this position even though it isn't on the ring itself.",
    'cAmine': "Deshielded by the directly attached nitrogen's electronegativity — a smaller effect than the oxygen case above, since nitrogen is less electronegative.",
    'ncH': "Deshielded by the directly attached nitrogen's electronegativity — a smaller effect than the oxygen case above, since nitrogen is less electronegative.",
}


def explain_peak(key: str) -> Optional[str]:
    """A short, plain-English "why does it appear there" explanation for a
    peak's classification key, matched specific-to-general (an 80+-key
    space, so pattern-matched by prefix/substring rather than hand-written
    per exact key)."""
    if key in _EXPLAIN_EXACT:
        return _EXPLAIN_EXACT[key]
    if key.startswith('alkylCH3AlphaCarbonyl') or re.match(r'^alkyl(CH2|CH|Quaternary)AlphaCarbonyl', key):
        return "Deshielded because it's alpha (directly attached) to a carbonyl carbon — the electron-withdrawing C=O pulls electron density away through the sigma bond."
    if re.match(r'^alkyl(CH3|CH2|CH|Quaternary)AlphaThiocarbonyl', key):
        return "Deshielded because it's alpha to a thiocarbonyl (C=S) carbon — the sulfur analog of the same alpha-to-carbonyl effect."
    if key in ('ketone', 'esterCarbonyl', 'acidCarbonyl', 'amideCarbonyl', 'carboxylOrEster', 'aldehyde'):
        return 'This is the carbonyl carbon itself — the C=O double bond strongly deshields it, pushing the signal far downfield, among the most downfield of all common carbon environments.'
    if key in ('thioamideCarbonyl', 'thionoesterCarbonyl', 'dithioicCarbonyl', 'thioketone', 'thioaldehyde'):
        return 'This is a thiocarbonyl (C=S) carbon — sulfur is less electronegative than oxygen, which changes the details, but the C=S double bond still pushes this carbon extremely far downfield.'
    if key == 'coumarinCarbonyl':
        return "Coumarin's lactone carbonyl — deshielded like any ester/lactone carbonyl, but sitting a bit upfield of a typical saturated lactone since it's conjugated with the ring's C3=C4 alkene, which donates some electron density back in by resonance."
    if key in ('coumarinC3', 'coumarinC3H'):
        return "Shielded relative to a typical alkene carbon: conjugation with the adjacent lactone carbonyl pulls electron density toward the carbonyl oxygen and away from this position, the same resonance-donation effect that shields the alpha-carbon of any alpha,beta-unsaturated carbonyl."
    if key in ('coumarinC4', 'coumarinC4H'):
        return "Deshielded well past a typical alkene carbon: it's the beta-carbon of an alpha,beta-unsaturated lactone (the electron-poor end of that conjugated system) *and* directly attached to the aromatic ring, so both effects push it downfield together."
    if key == 'chromoneCarbonyl':
        return "A chromone/flavone C4 carbonyl sits well downfield of even a typical ketone: the ring oxygen's lone pair conjugates all the way through the C2=C3 alkene to the carbonyl (a vinylogous-ester arrangement, similar in spirit to an amide's resonance but relayed through an extra double bond), pulling significant positive character onto this carbon."
    if key in ('chromoneC2', 'chromoneC2H', 'flavoneC2'):
        return "This carbon is both a vinyl ether carbon (attached to the ring oxygen) and the far end of that same vinylogous-ester conjugation with the C4 carbonyl — both effects deshield it, pushing it well past where either alone would."
    if key in ('chromoneC3', 'chromoneC3H'):
        return "Shielded relative to a typical alkene carbon by the same resonance-donation effect coumarin's C3 shows — sitting alpha to the carbonyl in a cross-conjugated system that pushes electron density onto this position."

    if 'fusedHeteroaromatic' in key:
        return "Deshielded by the aromatic ring current, set mainly by proximity to the ring heteroatom (the same effect as a lone heteroaromatic ring), with the second, fused ring adding a further, smaller ring-current contribution of its own on top — which is also why this prediction is treated as a wider, less certain band than the lone-ring case."
    if key.startswith('heteroaromatic_') or 'heteroaromatic' in key:
        return "Deshielded by the aromatic ring current (like benzene), with the exact shift further set by how close this position sits to the ring's own heteroatom — closer positions are pulled further downfield."
    if key.startswith('aromaticFused'):
        return 'Deshielded by the aromatic ring current, shifted further by sitting on a fused polycyclic ring rather than an isolated benzene ring.'
    if key == 'aromatic' or key == 'aromaticH' or key.startswith('aromaticPos') or key.startswith('aromaticH_'):
        return "Deshielded by the aromatic ring current: the ring's delocalized pi-electrons circulate under the external magnetic field and generate a local field that reinforces it at this position."

    if key.startswith('alkene'):
        return "Deshielded by the C=C pi bond's own (weaker, non-cyclic) version of the ring-current effect."

    if key == 'cHalideI' or key.startswith('cHalideIx'):
        return "Iodine is the exception to 'more electronegative = more downfield': its large, polarizable electron cloud contributes a shielding effect (the 'heavy atom effect') that outweighs its inductive withdrawal, pulling this carbon upfield of even a C-Br carbon."
    if key.startswith('cHalide') or key == 'haloH':
        return "Deshielded by the attached halogen's electronegativity pulling electron density away through the sigma bond — heavier halogens (Br, I) shield somewhat via their own size, which is why iodine in particular breaks the simple pattern (see its own note)."

    if key in ('cAlcoholMethanol', 'cAlcoholPrimary', 'cAlcoholSecondary', 'cAlcoholTertiary', 'cEtherAryl', 'cEtherAlkyl', 'cEsterAlkoxy', 'ocH'):
        return 'Deshielded by the directly attached, highly electronegative oxygen pulling electron density away through the sigma bond.'
    if key in ('cSulfoxide', 'cSulfone', 'sulfoxideH', 'sulfoneH'):
        return 'Deshielded by the attached sulfur, and more strongly than a plain sulfide since the oxidized sulfur (S=O) pulls significantly more electron density away.'
    if key in ('cSulfide', 'cThiol', 'sulfideH', 'thiolCH'):
        return 'Mildly deshielded by the attached sulfur — sulfur is only modestly electronegative, so this shift is smaller than the oxygen (alcohol/ether) analog.'

    if key in ('alkylCH3', 'alkylCH2', 'alkylCH', 'alkylQuaternary'):
        return 'A plain sp3 hydrocarbon environment — with no nearby electronegative atom or pi system pulling electron density away, it sits well upfield (shielded). The specific position within that broad "alkyl" region is set mainly by how many other carbons sit nearby (1, 2, and 3 bonds away each nudge it downfield by a different, well-established amount) and by how heavily branched this carbon and its immediate neighbors are — a highly branched carbon systematically reads lower than a simple carbon-counting sum alone would suggest.'
    if key in ('terminalCH', 'methaneLike'):
        return 'A plain sp3 hydrocarbon environment — with no nearby electronegative atom or pi system pulling electron density away, it sits well upfield (shielded).'

    if key.startswith('strainedRing'):
        if '_O_' in key:
            return "Ring strain in this 3- or 4-membered oxygen heterocycle changes the C-O bond's electronic character enough to shift it away from where an open-chain ether/alcohol carbon of the same substitution would fall — most strikingly in a 4-membered ring, where the position directly next to the oxygen sits unusually far downfield."
        if '_N_' in key:
            return "Ring strain in this 3- or 4-membered nitrogen heterocycle shifts this carbon away from a typical open-chain amine carbon's position, in the same way ring strain affects the oxygen analog."
        if '_S_' in key:
            return "Ring strain in this 3- or 4-membered sulfur heterocycle shifts this carbon somewhat from a typical open-chain sulfide carbon's position."
        return "Ring strain changes this carbon's hybridization and electron distribution enough to place it well outside the normal open-chain sp3 range — most notably in cyclopropane, whose ring protons are actually shielded (pushed upfield) despite the ring's own strain, an anisotropic effect similar in spirit to (though mechanistically different from) an aromatic ring current."
    if key == 'organometallicC' or key == 'organometallicH':
        return "A carbon-metal bond is far more ionic/electron-rich than a carbon-hydrogen or carbon-carbon bond, which shields this position dramatically — pushing it well upfield of even a plain alkane, sometimes past 0 ppm entirely. Real values vary enormously with the specific metal, solvent, and aggregation state, so treat this range as only a rough indicator."
    if key in ('cAzide', 'azideCH'):
        return "Deshielded by the attached azide nitrogen's electronegativity, similarly to (and a bit more strongly than) a plain amine-attached carbon, since the conjugated N=N=N system withdraws more electron density than a lone amine nitrogen would."
    if key in ('cBoron', 'bCH'):
        return "Boron is less electronegative than carbon, so a C-B bond donates electron density toward carbon rather than withdrawing it — the opposite direction from most heteroatom substituents — though in practice the carbon signal itself is often broadened or weakened by boron's quadrupolar nucleus, making this one of the less reliably observed predictions here."
    if key in ('cPhosphonate', 'pCH'):
        return 'A carbon-phosphorus bond is polarized similarly to (though more weakly than) a carbon-nitrogen bond; real phosphorus-containing compounds also show a large, characteristic carbon-phosphorus coupling in the actual spectrum that this prediction does not model.'
    if key in ('cPhosphateAlkoxy', 'opCH'):
        return "Deshielded by the attached, highly electronegative oxygen — chemically similar to an ester's alkoxy carbon, since the oxygen sits between this carbon and phosphorus's own electron-withdrawing P=O in much the same donor-acceptor arrangement an ester's C-O-C(=O) has."
    if key in ('isocyanateC', 'isothiocyanateC'):
        return 'This carbon sits between two cumulated double bonds (like carbon dioxide\u2019s central carbon), which places it in its own narrow, distinctive range separate from a normal carbonyl, nitrile, or alkene carbon.'
    if key == 'sulfonamideNH':
        return 'Deshielded similarly to an amide N-H: the adjacent, strongly electron-withdrawing sulfonyl group (-SO2-) pulls electron density away from the proton in the same resonance-withdrawal sense a carbonyl does for an amide.'
    if key.startswith('ringNH'):
        return "This N-H sits on a strained 3- or 4-membered ring, which locks its geometry more than an open-chain amine's freely-rotating N-H does, giving it a somewhat narrower typical range."
    if key == 'boronOH':
        return "A boronic acid B-OH behaves similarly to an alcohol O-H for the same light-atom, hydrogen-bonding reasons, though boron's empty p-orbital and lower electronegativity shift the exact position and typical range somewhat from a plain alcohol's."
    if key == 'phosphorusOH':
        return "A phosphonic/phosphoric acid P-OH is deshielded by resonance with the adjacent P=O, similarly to how a carboxylic acid O-H is deshielded by its C=O — the same underlying mechanism, on a different central atom."

    return None


def estimate_confidence(key: str, rng: Range) -> Dict[str, Any]:
    """A rough 0-1 "how safe a bet is this" score per peak, plus the short
    list of reasons behind it. Dragged down by being an exchangeable
    O-H/N-H/S-H, or by simply having a wide predicted range."""
    width = rng[1] - rng[0]
    exchangeable = bool(re.search(r'(OH|NH|SH)$', key))
    factors: List[str] = []
    if exchangeable:
        factors.append('Exchangeable proton — real position is solvent/concentration/temperature dependent')
    if width <= 6:
        factors.append('Narrow, well-established textbook range')
    elif width <= 12:
        factors.append('Moderate-width textbook range')
    elif width <= 20:
        factors.append('Wide textbook range — treat as approximate')
    else:
        factors.append('Very wide catch-all range — a rough hedge, not a precise prediction')
    if re.match(r'^(aromaticFused|heteroaromatic_|aromaticPos|fusedHeteroaromatic)', key):
        factors.append('Ring-position-specific correction applied, not a generic aromatic bucket')
    elif re.match(r'^(cHalide|cSulf|cEster|cEther|cAlcohol|lactone|lactam|urea|carbamate|thiourea)', key, re.IGNORECASE):
        factors.append('Functional-group-specific correction applied')

    if exchangeable:
        value = 0.3 if width > 6 else 0.45
    elif width <= 6:
        value = 0.85
    elif width <= 12:
        value = 0.7
    elif width <= 20:
        value = 0.55
    else:
        value = 0.4
    return {'value': value, 'factors': factors}


def typical_one_bond_ch_coupling(key: str) -> int:
    if 'aromatic' in key or 'heteroaromatic' in key or key.startswith('alkene') or key == 'aldehyde':
        return 160
    if key == 'alkyne':
        return 250
    if key in ('coumarinC3', 'coumarinC4', 'chromoneC2', 'chromoneC3'):
        return 160
    return 125


def multiplicity_name(n: int) -> str:
    return {0: 's', 1: 'd', 2: 't', 3: 'q', 4: 'quintet', 5: 'sextet', 6: 'septet'}.get(n, 'm')


def predict_multiplicity(atom_id: str, ctx: Ctx, symmetry_classes: Dict[str, int]) -> Dict[str, Any]:
    """First-order multiplicity for one representative atom of an 1H peak
    group, with compound splitting (dd, dt, td, ddd...) — each vicinal
    neighbor is its own coupling group unless two neighbors share a
    symmetry class."""
    group_size_by_sym_class: Dict[int, int] = {}
    ungrouped_sizes: List[int] = []
    for n in neighbors_of(atom_id, ctx):
        if n.atom['element'] != 'C':
            continue
        if _bond_order(n.bond) != 1:
            continue
        if is_aromatic_atom(n.atom['id'], ctx):
            continue
        h_count = total_attached_h(n.atom, ctx)
        if h_count == 0:
            continue
        sym_class = symmetry_classes.get(n.atom['id']) if symmetry_classes else None
        if sym_class is not None:
            group_size_by_sym_class[sym_class] = group_size_by_sym_class.get(sym_class, 0) + h_count
        else:
            ungrouped_sizes.append(h_count)

    group_sizes = sorted(list(group_size_by_sym_class.values()) + ungrouped_sizes, reverse=True)
    multiplicity = combo_multiplicity_name(group_sizes)
    if len(group_sizes) == 0:
        return {'multiplicity': multiplicity, 'jHz': []}
    typical_j_ladder = [8, 6, 4, 3, 2]
    j_hz = [typical_j_ladder[min(i, len(typical_j_ladder) - 1)] for i in range(len(group_sizes))]
    return {'multiplicity': multiplicity, 'jHz': j_hz}


def combo_multiplicity_name(group_sizes: List[int]) -> str:
    if len(group_sizes) == 0:
        return 's'
    if len(group_sizes) == 1:
        return multiplicity_name(group_sizes[0])
    letters = {1: 'd', 2: 't', 3: 'q'}
    if all(n in letters for n in group_sizes):
        return ''.join(letters[n] for n in group_sizes)
    words = {1: 'doublet', 2: 'triplet', 3: 'quartet', 4: 'quintet', 5: 'sextet', 6: 'septet'}

    def word_for(n):
        return words.get(n, 'multiplet')

    return ' of '.join(word_for(n) if i == 0 else f'{word_for(n)}s' for i, n in enumerate(group_sizes))


SOLVENT_EXCHANGEABLE_OVERRIDES_DMSO: Dict[str, Range] = {
    'alcoholOH': (4.0, 5.5),
    'phenolOH': (9.0, 10.0),
    'hBondedPhenolOH': (10.5, 13.0),
    'acidOH': (12.0, 13.5),
    'amideNH': (7.3, 8.5),
    'thioamideNH': (9.0, 10.5),
    'amineNH': (0.5, 4.0),
    'aromaticRingNH': (10.5, 11.5),
    'thiolSH': (1.0, 2.6),
    'thiophenolSH': (3.0, 4.2),
}


def apply_solvent_to_exchangeable(h1_groups: Dict[str, Dict[str, Any]], solvent: Optional[str]) -> None:
    """CDCl3 (default) is unchanged; DMSO overrides exchangeable-proton
    ranges to well-documented DMSO-d6 values; D2O flags them as
    exchanged-out (the classic "D2O shake") rather than inventing a shift
    for a signal that, in a real D2O spectrum, isn't there."""
    if not solvent or solvent == 'CDCl3':
        return
    for g in h1_groups.values():
        if not re.search(r'(OH|NH|SH)$', g['key']):
            continue
        if solvent == 'D2O':
            g['exchangesOut'] = True
            continue
        if solvent == 'DMSO':
            override = SOLVENT_EXCHANGEABLE_OVERRIDES_DMSO.get(g['key'])
            if override:
                g['range'] = override


# ---------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------

def find_stereocenter_candidates(atoms: List[Dict[str, Any]], ctx: Ctx, symmetry_classes: Dict[str, int]) -> List[str]:
    """A 2D-graph-only ("L1+L2", per the reference architecture this
    follows) approximation of stereocenter detection: a saturated
    (all-single-bond, non-aromatic) carbon with exactly four substituents
    — counting implicit/explicit H as one substituent each — where no two
    substituents share a symmetry-class color (heavy neighbors) or there
    is at most one H. This is a standard simplified stand-in for full
    CIP-rule stereocenter assignment; it doesn't need 3D coordinates or
    R/S assignment to usefully flag "this position is probably chiral"
    for the diastereotopic-CH2 warning below, which is the only thing
    that needs it here."""
    candidates = []
    for atom in atoms:
        if atom['element'] != 'C' or is_metal(atom):
            continue
        if any(is_bond_aromatic(n.bond) or _bond_order(n.bond) != 1 for n in neighbors_of(atom['id'], ctx)):
            continue
        h_count = total_attached_h(atom, ctx)
        if h_count >= 2:
            continue  # two identical H substituents rules out a stereocenter
        heavy_neighbors = [n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] != 'H']
        if h_count + len(heavy_neighbors) != 4:
            continue
        heavy_colors = [symmetry_classes.get(n.atom['id']) for n in heavy_neighbors]
        if len(set(heavy_colors)) == len(heavy_colors):
            candidates.append(atom['id'])
    return candidates


def bond_distance(start_id: str, target_ids: Set[str], ctx: Ctx, max_dist: int = 4) -> Optional[int]:
    """Shortest heavy-atom bond-count distance from `start_id` to any id
    in `target_ids`, or None if none is within `max_dist`."""
    if start_id in target_ids:
        return 0
    visited = {start_id}
    frontier = [start_id]
    dist = 0
    while frontier and dist < max_dist:
        dist += 1
        next_frontier = []
        for aid in frontier:
            for n in neighbors_of(aid, ctx):
                if n.atom['element'] == 'H' or is_metal(n.atom):
                    continue
                if n.atom['id'] in target_ids:
                    return dist
                if n.atom['id'] not in visited:
                    visited.add(n.atom['id'])
                    next_frontier.append(n.atom['id'])
        frontier = next_frontier
    return None


def predict_nmr(atoms: List[Dict[str, Any]], bonds: List[Dict[str, Any]], solvent: str = 'CDCl3') -> Dict[str, List[Dict[str, Any]]]:
    """Predicts 1H and 13C NMR peaks for a structure. `solvent` is
    'CDCl3' (default), 'DMSO', or 'D2O'. Returns `{h1: [...], c13: [...]}`,
    each peak shaped as
    `{key, label, range: [low, high], shift, atomIds, confidence, reason,
    integration?, multiplicity?, jHz?, carbonType?, exchangesOut?}`,
    sorted by shift descending (downfield to upfield, as real spectra are
    read)."""
    ctx = build_context(atoms, bonds)
    heavy_atoms = [a for a in atoms if a['element'] != 'H' and not is_metal(a)]

    h1_groups: Dict[str, Dict[str, Any]] = {}
    c13_groups: Dict[str, Dict[str, Any]] = {}

    # Classify every carbon first, then refine plain-aromatic
    # classifications into ortho/meta/para (or alpha/beta/gamma-to-
    # heteroatom, or fused alpha/beta/meso) before grouping into peaks.
    # refine_fused_heteroaromatic_ring_positions runs first since it's the
    # most specific pass and needs to claim its atoms before the more
    # general passes get to them.
    carbon_class_by_id: Dict[str, Dict[str, Any]] = {}
    for atom in heavy_atoms:
        if atom['element'] == 'C':
            carbon_class_by_id[atom['id']] = classify_carbon(atom['id'], ctx)
    refine_fused_heteroaromatic_ring_positions(atoms, ctx, carbon_class_by_id)
    refine_substituted_ring_positions(atoms, ctx, carbon_class_by_id)
    refine_fused_ring_positions(atoms, ctx, carbon_class_by_id)
    refine_heteroaromatic_ring_positions(atoms, ctx, carbon_class_by_id)
    carbon_class_by_id.update(detect_coumarin_chromone_scaffold(atoms, ctx))

    symmetry_classes = compute_symmetry_classes(atoms, ctx)

    for atom in heavy_atoms:
        if atom['element'] == 'C':
            cls = carbon_class_by_id[atom['id']]
            sig = group_signature(cls, atom['id'], symmetry_classes)
            if sig not in c13_groups:
                h_on_carbon = total_attached_h(atom, ctx)
                multiplicity = multiplicity_name(h_on_carbon)
                j_hz = [typical_one_bond_ch_coupling(cls['key'])] if h_on_carbon > 0 else []
                c13_groups[sig] = {**cls, 'atomIds': [], 'carbonType': dept_carbon_type(h_on_carbon), 'multiplicity': multiplicity, 'jHz': j_hz}
            c13_groups[sig]['atomIds'].append(atom['id'])

        h_count = total_attached_h(atom, ctx)
        if h_count > 0:
            cls = classify_hydrogens_on(atom, ctx)
            carbon_cls = carbon_class_by_id.get(atom['id']) if atom['element'] == 'C' else None
            if carbon_cls and carbon_cls.get('hKey'):
                # A coumarin/chromone/flavone scaffold vinyl proton (C2-H/
                # C3-H/C4-H) — these sit on an ordinary, non-aromatic C=C
                # bond, so classify_hydrogens_on above would have already
                # tagged them the generic 'vinylH' rather than 'aromaticH',
                # missing the ring-position-aware override block below
                # entirely. Checked first, ahead of that block, since it
                # applies regardless of what classify_hydrogens_on decided.
                cls = {'key': carbon_cls['hKey'], 'label': carbon_cls['label'].replace('C2 (', 'H on C2 (').replace('C3 (', 'H on C3 (').replace('C4 (', 'H on C4 ('), 'range': carbon_cls['hRange']}
            elif cls and cls['key'] == 'aromaticH' and atom['element'] == 'C':
                if carbon_cls and carbon_cls.get('heteroaromatic') and carbon_cls.get('fused') and carbon_cls.get('posLabel'):
                    cls = {
                        'key': f"aromaticH_{carbon_cls['key']}",
                        'label': f"{FUSED_HETEROCYCLE_NAMES[carbon_cls['heteroRangeKey']]}-type H ({carbon_cls['posLabel']} to ring heteroatom)",
                        'range': carbon_cls['hRange'],
                    }
                elif carbon_cls and carbon_cls.get('fused') and carbon_cls.get('posLabel'):
                    cls = {
                        'key': f"aromaticH_{carbon_cls['key']}",
                        'label': f"Aromatic H (fused-ring {carbon_cls['posLabel']} position)",
                        'range': FUSED_RING_RANGES_H[carbon_cls['posLabel']],
                    }
                elif carbon_cls and carbon_cls.get('heteroaromatic') and carbon_cls.get('posLabel'):
                    cls = {
                        'key': f"aromaticH_{carbon_cls['key']}",
                        'label': f"Heteroaromatic H ({carbon_cls['posLabel']} to ring heteroatom)",
                        'range': HETEROAROMATIC_RANGES_H[carbon_cls['heteroRangeKey']][carbon_cls['posLabel']],
                    }
                elif carbon_cls and carbon_cls.get('posLabel'):
                    is_pair_position = '_' in carbon_cls['key']
                    pair_suffix = carbon_cls['key'].replace('aromaticPos', '').replace('_', '-') if is_pair_position else None
                    cls = {
                        'key': f"aromaticH_{carbon_cls['key']}",
                        'label': f"Aromatic H ({carbon_cls['posLabel']}{f'-type, ring position {pair_suffix}' if is_pair_position else ''})",
                        'range': H_RING_POSITION_RANGES_BY_CHARACTER[carbon_cls['character']][carbon_cls['posLabel']],
                    }
            if cls:
                sig = group_signature(cls, atom['id'], symmetry_classes)
                if sig not in h1_groups:
                    if re.search(r'(OH|NH|SH)$', cls['key']):
                        mult_info = {'multiplicity': 'br s', 'jHz': []}
                    elif cls['key'].startswith('aromaticH'):
                        mult_info = aromatic_multiplicity_for(carbon_cls) or {'multiplicity': 'm', 'jHz': []}
                    elif cls['key'] in ('coumarinC3H', 'coumarinC4H'):
                        # Coumarin's C3-H/C4-H couple to *each other* across
                        # the ring C3=C4 double bond — not caught by
                        # predict_multiplicity below (it only looks at
                        # single-bonded vicinal CH neighbors, the sp3 case),
                        # so given explicitly: a large, characteristic
                        # vicinal-alkene J, each appearing as a doublet.
                        mult_info = {'multiplicity': 'd', 'jHz': [9.6]}
                    elif cls['key'] == 'chromoneC2H':
                        mult_info = {'multiplicity': 'd', 'jHz': [6.0]}
                    elif cls['key'] == 'chromoneC3H':
                        # A flavone's C2 is aryl-substituted (no C2-H), so
                        # its C3-H has no vicinal ring partner to couple to
                        # — a genuine singlet, unlike plain chromone's C3-H
                        # (which does couple to C2-H).
                        mult_info = {'multiplicity': 's', 'jHz': []} if carbon_cls.get('scaffold') == 'flavone' else {'multiplicity': 'd', 'jHz': [6.0]}
                    elif cls['key'] == 'vinylH':
                        mult_info = {'multiplicity': 'm', 'jHz': []}
                    else:
                        mult_info = predict_multiplicity(atom['id'], ctx, symmetry_classes)
                    h1_groups[sig] = {**cls, **mult_info, 'atomIds': [], 'integration': 0}
                g = h1_groups[sig]
                g['atomIds'].append(atom['id'])
                g['integration'] += h_count

    apply_solvent_to_exchangeable(h1_groups, solvent)

    warnings: List[str] = []

    # --- Diastereotopic-proton warning (L1+L2 level: no 3D/R-S needed) ---
    stereocenters = find_stereocenter_candidates(atoms, ctx, symmetry_classes)
    if stereocenters:
        stereocenter_set = set(stereocenters)
        flagged_any = False
        for g in h1_groups.values():
            rep_atom = ctx.by_id.get(g['atomIds'][0]) if g.get('atomIds') else None
            if not rep_atom or rep_atom['element'] != 'C' or total_attached_h(rep_atom, ctx) != 2:
                continue
            dist = bond_distance(rep_atom['id'], stereocenter_set, ctx, max_dist=4)
            if dist is None:
                continue
            g['diastereotopic'] = True
            g['confidence'] = min(g.get('confidence', 0.7), 0.45)
            flagged_any = True
        if flagged_any:
            warnings.append(
                'This structure contains at least one stereocenter (detected from its 2D graph, not full CIP/3D '
                'analysis). CH2 groups near it are marked "diastereotopic": their two protons are not chemically '
                'equivalent and can show different shifts and couplings, even though this predictor still reports '
                'them as one merged peak for simplicity.'
            )

    # --- Second-order / strongly-coupled warning ---
    # Real multiplicities are only cleanly first-order (n+1) when the
    # chemical-shift separation between coupled partners is large
    # relative to J; when it isn't, the textbook splitting pattern
    # breaks down. Using each peak's own *final* predicted shift (only
    # available now, after assign_refined_shifts below) and a standard
    # teaching-lab reference frequency, flag pairs where that ratio gets
    # too small rather than confidently asserting a clean multiplet.
    _DEFAULT_FREQ_MHZ = 400.0
    atom_to_h1_sig: Dict[str, str] = {}
    for sig, g in h1_groups.items():
        for aid in g['atomIds']:
            atom_to_h1_sig[aid] = sig

    def flag_second_order(h1_list: List[Dict[str, Any]]) -> None:
        by_atom_shift: Dict[str, float] = {}
        for g in h1_list:
            for aid in g['atomIds']:
                by_atom_shift[aid] = g['shift']
        atom_ids_by_group_id: Dict[int, Set[str]] = {id(g): set(g['atomIds']) for g in h1_list}
        flagged_second_order = False
        for g in h1_list:
            mult = g.get('multiplicity')
            if not mult or mult in ('s', 'br s', 'm') or g.get('exchangesOut'):
                continue
            if re.search(r'(OH|NH|SH)$', g['key']):
                continue
            j_list = g.get('jHz') or []
            if not j_list:
                continue
            own_atom_ids = atom_ids_by_group_id[id(g)]
            rep_atom_id = g['atomIds'][0]
            min_ratio = None
            min_ratio_partner_atom_id = None
            min_ratio_partner_shift = None
            for n in neighbors_of(rep_atom_id, ctx):
                if n.atom['id'] in own_atom_ids:
                    continue  # a symmetry-equivalent partner isn't a real coupling comparison
                if n.atom['element'] != 'C' or _bond_order(n.bond) != 1:
                    continue
                if is_aromatic_atom(n.atom['id'], ctx):
                    continue
                if total_attached_h(n.atom, ctx) == 0:
                    continue
                partner_shift = by_atom_shift.get(n.atom['id'])
                if partner_shift is None:
                    continue
                delta_hz = abs(g['shift'] - partner_shift) * _DEFAULT_FREQ_MHZ
                j = j_list[0] if j_list[0] else 8
                if j <= 0:
                    continue
                ratio = delta_hz / j
                if min_ratio is None or ratio < min_ratio:
                    min_ratio = ratio
                    min_ratio_partner_atom_id = n.atom['id']
                    min_ratio_partner_shift = partner_shift
            if min_ratio is not None and min_ratio < 4:
                g['secondOrder'] = True
                g['reportedMultiplicity'] = mult
                g['multiplicity'] = 'm (second-order)'
                g['confidence'] = min(g.get('confidence', 0.7), 0.4)
                flagged_second_order = True

                # Isolated two-spin case: exactly one coupling partner
                # group, whose own only non-equivalent coupling partner
                # is this group — i.e. a true AB pair, not one leg of a
                # larger (ABX/AMX-scale) spin system. Only then is the
                # closed-form two-spin solution exact, so only then do
                # we attach it.
                own_sig = atom_to_h1_sig.get(rep_atom_id)
                partner_sig = atom_to_h1_sig.get(min_ratio_partner_atom_id) if min_ratio_partner_atom_id else None
                partner_group = next((pg for pg in h1_list if id(pg) != id(g) and atom_to_h1_sig.get(pg['atomIds'][0]) == partner_sig), None) if partner_sig else None
                if own_sig is not None and partner_group is not None:
                    partner_own_ids = set(partner_group['atomIds'])
                    # "Isolated pair" = every non-equivalent coupling
                    # partner of the partner's own protons resolves back
                    # to this same group. If the partner also couples to
                    # some third, distinct group, this is really the edge
                    # of a larger (ABX/AMX-scale) spin system, where the
                    # two-spin closed form is no longer exact — so it's
                    # left as the generic "second-order" flag instead of
                    # attaching a wrong AB quartet.
                    partner_partner_sigs = {
                        atom_to_h1_sig[n.atom['id']]
                        for aid in partner_own_ids
                        for n in neighbors_of(aid, ctx)
                        if n.atom['id'] not in partner_own_ids
                        and n.atom['element'] == 'C' and _bond_order(n.bond) == 1
                        and not is_aromatic_atom(n.atom['id'], ctx)
                        and total_attached_h(n.atom, ctx) > 0
                        and n.atom['id'] in atom_to_h1_sig
                    }
                    if partner_partner_sigs == {own_sig}:
                        j_for_ab = j_list[0] if j_list and j_list[0] else 8.0
                        g['abQuartet'] = ab_quartet_lines(g['shift'], min_ratio_partner_shift, j_for_ab, _DEFAULT_FREQ_MHZ)
        if flagged_second_order:
            any_ab = any(g.get('abQuartet') for g in h1_list)
            ab_note = (
                ' Where the pair is an isolated two-spin system, the actual 4-line AB quartet positions and '
                'intensity ratio are computed (see that peak\'s confidence factors) rather than left as a bare flag.'
                if any_ab else ''
            )
            warnings.append(
                'Some signals are close enough in shift to their coupling partner(s), relative to the predicted J, '
                f'that the simple first-order (n+1) splitting rule likely breaks down (assuming a {_DEFAULT_FREQ_MHZ:.0f} MHz '
                'instrument) — these are shown as "m (second-order)" with their textbook-expected multiplicity noted '
                f'separately, rather than a confidently wrong clean multiplet.{ab_note}'
            )

    def to_sorted_peaks(groups: Dict[str, Dict[str, Any]], is_h1: bool = False) -> List[Dict[str, Any]]:
        lst = list(groups.values())
        assign_refined_shifts(lst)
        if is_h1:
            flag_second_order(lst)
        out = []
        for g in lst:
            confidence_info = estimate_confidence(g['key'], g['range'])
            base_confidence = min(confidence_info['value'], g['confidence']) if 'confidence' in g else confidence_info['value']
            factors = list(confidence_info['factors'])
            if g.get('diastereotopic'):
                factors.append('Near a detected stereocenter — the two CH2 protons may not really be equivalent')
            if g.get('secondOrder'):
                factors.append('Shift separation from its coupling partner is small relative to J — likely second-order')
            if g.get('abQuartet'):
                ab = g['abQuartet']
                factors.append(
                    f"Isolated two-spin (AB) system — exact 4-line positions ~{ab['linesPpm']} ppm, "
                    f"outer:inner intensity ratio ~{ab['outerInnerIntensityRatio']}:1 (Pople-Schneider-Bernstein "
                    f"closed form, not just a flag)"
                )
            out.append({
                **g,
                'confidence': base_confidence,
                'confidenceFactors': factors,
                'reason': explain_peak(g['key']),
            })
        out.sort(key=lambda p: p['shift'], reverse=True)
        return out

    result = {'h1': to_sorted_peaks(h1_groups, is_h1=True), 'c13': to_sorted_peaks(c13_groups)}
    if warnings:
        result['warnings'] = warnings
    return result