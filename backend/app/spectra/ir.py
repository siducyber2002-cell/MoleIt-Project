"""Predicts approximate IR absorption bands directly from a molecule's
structure (atoms + bonds). Ported line-for-line from
frontend/src/lib/irPredictor.js — see that file's module comment (and
nmr.py's) for the full "derive it, don't look it up" rationale and the
list of real compounds (ethanol, acetic acid, acetone, benzaldehyde,
toluene, benzene, ethylamine, acetonitrile, aspirin) each band was checked
against by hand.

The key structural difference from the NMR predictor: an NMR peak is per
symmetry-distinct atom environment; an IR band is per *type* of bond/
vibrational mode — real spectra don't show three separate O-H stretches
for three different alcohol groups in the same molecule, just one O-H
stretch region. So this groups by functional-group key alone (no symmetry-
class computation needed) and collects every contributing atom/site under
that one band.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

from .common import (
    Ctx, Neighbor,
    build_context, neighbors_of, is_metal, is_bond_aromatic,
    total_attached_h, has_double_bond_to, has_triple_bond_to,
    single_bond_neighbors, atoms_share_ring, find_smallest_ring, find_rings_of_size,
    is_azide_attachment_nitrogen,
    bond_order_value as _bond_order,
    stable_fraction_simple as stable_fraction,
)

Range = Tuple[float, float]


def is_nitro_nitrogen(atom_id: str, ctx: Ctx) -> bool:
    """N with a double bond to one O and a single bond to another O (or
    two formally-1.5-order N-O bonds in a resonance-delocalized drawing)
    and no attached H."""
    atom = ctx.by_id.get(atom_id)
    if not atom or atom['element'] != 'N':
        return False
    if total_attached_h(atom, ctx) > 0:
        return False
    oxygens = [n for n in neighbors_of(atom_id, ctx) if n.atom['element'] == 'O']
    if len(oxygens) < 2:
        return False
    return any(_bond_order(n.bond) == 2 for n in oxygens) or sum(1 for n in oxygens if _bond_order(n.bond) >= 1.5) >= 2


def find_aromatic_six_rings(atoms, ctx: Ctx) -> List[List[str]]:
    """Simple (non-fused, non-bridged) 6-membered all-carbon aromatic
    rings via DFS cycle search along aromatic-flagged bonds. Scoped to
    plain 6-rings only — fused/hetero aromatics fall through to the
    generic, honestly-wide fallback band (see aromaticOopPoly)."""
    rings: List[List[str]] = []
    seen: Set[str] = set()

    def is_aromatic_bond(b):
        return bool(b.get('aromatic') or b.get('style') == 'aromatic')

    for start in atoms:
        if start['element'] != 'C':
            continue
        stack = [(start['id'], [start['id']])]
        while stack:
            current, path = stack.pop()
            if len(path) > 6:
                continue
            for n in neighbors_of(current, ctx):
                if not is_aromatic_bond(n.bond) or n.atom['element'] != 'C':
                    continue
                if n.atom['id'] == start['id'] and len(path) == 6:
                    # NOTE: irPredictor.js's original dedup key is
                    # `path.slice().sort((a,b) => a-b).join(',')` — a
                    # numeric comparator applied to string atom ids like
                    # "a3", which always returns NaN and so (per the
                    # sort spec) leaves the array unchanged. The "sort"
                    # is therefore a no-op, and this key is really just
                    # the *unsorted* discovery-order path — meaning each
                    # of a ring's 2*n rotations/directions gets its own
                    # key and is *not* deduplicated here. Reproduced
                    # faithfully (bug and all) since scan_aromatic_rings
                    # below relies on the resulting duplicate-entries
                    # behavior for its `occurrences` count.
                    key = ','.join(path)
                    if key not in seen:
                        seen.add(key)
                        rings.append(list(path))
                    continue
                if n.atom['id'] not in path:
                    stack.append((n.atom['id'], path + [n.atom['id']]))
    return rings


def classify_ring_substitution(ring: List[str], ctx: Ctx) -> Dict[str, str]:
    """For an aromatic ring given as an ordered atom-id cycle, finds which
    ring positions carry a real exocyclic heavy-atom substituent, then
    classifies the substitution pattern from the positions' pairwise ring
    distance (adjacent = ortho, two apart = meta, opposite = para)."""
    substituent_positions = []
    ring_set = set(ring)
    for idx, atom_id in enumerate(ring):
        has_exocyclic_heavy = any(n.atom['id'] not in ring_set and n.atom['element'] != 'H' for n in neighbors_of(atom_id, ctx))
        if has_exocyclic_heavy:
            substituent_positions.append(idx)
    n = len(ring)
    if len(substituent_positions) == 0:
        return {'pattern': 'unsubstituted'}
    if len(substituent_positions) == 1:
        return {'pattern': 'mono'}
    if len(substituent_positions) == 2:
        raw = abs(substituent_positions[0] - substituent_positions[1])
        dist = min(raw, n - raw)
        if dist == 1:
            return {'pattern': 'ortho'}
        if dist == 2:
            return {'pattern': 'meta'}
        return {'pattern': 'para'}
    return {'pattern': 'poly'}


# ---------------------------------------------------------------------
# Band accumulation
# ---------------------------------------------------------------------

def add_band(bands: Dict[str, Dict[str, Any]], key: str, definition: Dict[str, Any], atom_ids: List[str]) -> None:
    if key not in bands:
        bands[key] = {
            'key': key, 'label': definition['label'], 'range': definition['range'],
            'intensity': definition['intensity'], 'shape': definition['shape'],
            'atomIds': [], 'occurrences': 0,
        }
    b = bands[key]
    for aid in atom_ids:
        if aid not in b['atomIds']:
            b['atomIds'].append(aid)
    b['occurrences'] += 1


def carbonyl_context(atom_id: str, ctx: Ctx) -> Optional[Dict[str, Any]]:
    """Same role as nmr.py's carbonyl_context, extended with the two
    subtypes that matter for IR but weren't distinct enough for NMR shift
    purposes: acylHalide (halogen on the carbonyl carbon) and anhydride
    (the flanking O bridges to a *second* carbonyl carbon)."""
    if not has_double_bond_to(atom_id, 'O', ctx):
        return None
    heavy_nbr_count = sum(1 for n in neighbors_of(atom_id, ctx) if n.atom['element'] != 'H')
    if heavy_nbr_count == 2 and (has_double_bond_to(atom_id, 'N', ctx) or has_double_bond_to(atom_id, 'S', ctx)):
        return None  # a cumulated isocyanate carbon — handled by scan_cumulated_systems instead
    h_count = total_attached_h(ctx.by_id[atom_id], ctx)

    halogen_single = next((n for n in neighbors_of(atom_id, ctx) if n.atom['element'] in ('F', 'Cl', 'Br', 'I') and _bond_order(n.bond) == 1), None)
    if halogen_single:
        return {'subtype': 'acylHalide', 'hCount': h_count, 'halogenAtomId': halogen_single.atom['id']}

    hetero_singles = [n for n in neighbors_of(atom_id, ctx) if n.atom['element'] in ('O', 'N') and _bond_order(n.bond) == 1]

    if len(hetero_singles) >= 2:
        els = ''.join(sorted(n.atom['element'] for n in hetero_singles))
        if els == 'NN':
            return {'subtype': 'urea', 'hCount': h_count}
        if els == 'NO':
            return {'subtype': 'carbamate', 'hCount': h_count}
        if els == 'OO':
            return {'subtype': 'carbonate', 'hCount': h_count}

    hetero_single = hetero_singles[0] if hetero_singles else None
    if not hetero_single:
        return {'subtype': 'aldehyde' if h_count >= 1 else 'ketone', 'hCount': h_count}

    if hetero_single.atom['element'] == 'N':
        subtype = 'lactam' if atoms_share_ring(atom_id, hetero_single.atom['id'], ctx) else 'amide'
        return {'subtype': subtype, 'hCount': h_count, 'heteroAtomId': hetero_single.atom['id']}

    oxygen_atom = hetero_single.atom
    if total_attached_h(oxygen_atom, ctx) > 0:
        return {'subtype': 'acid', 'hCount': h_count, 'heteroAtomId': oxygen_atom['id']}
    other_carbon = next(
        (n for n in neighbors_of(oxygen_atom['id'], ctx) if n.atom['id'] != atom_id and n.atom['element'] == 'C' and _bond_order(n.bond) == 1),
        None,
    )
    if other_carbon and has_double_bond_to(other_carbon.atom['id'], 'O', ctx):
        return {'subtype': 'anhydride', 'hCount': h_count, 'heteroAtomId': oxygen_atom['id'], 'partnerCarbonylId': other_carbon.atom['id']}
    subtype = 'lactone' if atoms_share_ring(atom_id, oxygen_atom['id'], ctx) else 'ester'
    return {'subtype': subtype, 'hCount': h_count, 'heteroAtomId': oxygen_atom['id']}


def is_conjugated_carbonyl(atom_id: str, ctx: Ctx) -> bool:
    """Whether a carbonyl carbon's non-carbonyl, non-heteroatom substituent
    is conjugated (aromatic or part of a C=C) — lowers the C=O stretch by
    roughly 15-30 cm-1 versus the unconjugated value."""
    for n in neighbors_of(atom_id, ctx):
        if n.atom['element'] != 'C' or _bond_order(n.bond) != 1:
            continue
        if any(is_bond_aromatic(n2.bond) for n2 in neighbors_of(n.atom['id'], ctx)) or has_double_bond_to(n.atom['id'], 'C', ctx):
            return True
    return False


def detect_coumarin_chromone_carbonyl(atoms, ctx: Ctx) -> Dict[str, str]:
    """Finds any coumarin (2H-chromen-2-one) or chromone/flavone
    (4H-chromen-4-one) scaffold's ring carbonyl carbon and returns
    `{atomId: 'coumarin' | 'chromone'}`. Same ring-position logic as
    nmr.py's `detect_coumarin_chromone_scaffold` — see that function's
    module comment for the chemistry — but only identifies the carbonyl
    itself, since that's the one atom whose IR band is scaffold-specific
    enough to be worth overriding here (the ring's other C-O-C/C=C bands
    are close enough to their generic classification to leave alone)."""
    result: Dict[str, str] = {}
    all_rings = find_rings_of_size(atoms, ctx, 6)
    benzo_rings = [r for r in find_aromatic_six_rings(atoms, ctx) if len(r) == 6]
    if not benzo_rings:
        return result

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
        if cyclic_adjacent(carbonyl_idx, o_idx, n):
            result[ring[carbonyl_idx]] = 'coumarin'
        elif any(cyclic_adjacent(carbonyl_idx, fi, n) for fi in fusion_idxs):
            result[ring[carbonyl_idx]] = 'chromone'

    return result


def scan_carbonyls(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    handled_anhydride_pairs: Set[str] = set()
    scaffold_carbonyls = detect_coumarin_chromone_carbonyl(atoms, ctx)
    for atom in atoms:
        if atom['element'] != 'C':
            continue
        scaffold = scaffold_carbonyls.get(atom['id'])
        if scaffold == 'coumarin':
            add_band(bands, 'coumarinCO', {'label': 'Coumarin lactone C=O stretch', 'range': (1700, 1730), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
            continue
        if scaffold == 'chromone':
            add_band(bands, 'chromoneCO', {'label': 'Chromone/flavone C=O stretch', 'range': (1650, 1680), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
            continue
        cx = carbonyl_context(atom['id'], ctx)
        if not cx:
            continue
        conjugated = is_conjugated_carbonyl(atom['id'], ctx)
        shift = -18 if conjugated else 0

        subtype = cx['subtype']
        if subtype == 'aldehyde':
            add_band(bands, 'aldehydeCO', {'label': 'Aldehyde C=O stretch', 'range': (1720 + shift, 1740 + shift), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
        elif subtype == 'ketone':
            add_band(bands, 'ketoneCO', {'label': 'Ketone C=O stretch', 'range': (1705 + shift, 1725 + shift), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
        elif subtype == 'acid':
            add_band(bands, 'acidCO', {'label': 'Carboxylic acid C=O stretch', 'range': (1700 + shift, 1725 + shift), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id'], cx['heteroAtomId']])
        elif subtype == 'ester':
            add_band(bands, 'esterCO', {'label': 'Ester C=O stretch', 'range': (1735 + shift, 1750 + shift), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id'], cx['heteroAtomId']])
        elif subtype == 'lactone':
            add_band(bands, 'lactoneCO', {'label': 'Lactone C=O stretch (cyclic ester)', 'range': (1735, 1820), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id'], cx['heteroAtomId']])
        elif subtype == 'amide':
            add_band(bands, 'amideCO', {'label': 'Amide C=O stretch ("amide I")', 'range': (1650 + shift, 1690 + shift), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id'], cx['heteroAtomId']])
        elif subtype == 'lactam':
            add_band(bands, 'lactamCO', {'label': 'Lactam C=O stretch (cyclic amide)', 'range': (1670, 1750), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id'], cx['heteroAtomId']])
        elif subtype == 'urea':
            add_band(bands, 'ureaCO', {'label': 'Urea C=O stretch', 'range': (1630, 1690), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
        elif subtype == 'carbamate':
            add_band(bands, 'carbamateCO', {'label': 'Carbamate C=O stretch', 'range': (1690, 1740), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
        elif subtype == 'carbonate':
            add_band(bands, 'carbonateCO', {'label': 'Carbonate C=O stretch', 'range': (1740, 1790), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
        elif subtype == 'acylHalide':
            add_band(bands, 'acylHalideCO', {'label': 'Acid halide C=O stretch', 'range': (1770, 1815), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id'], cx['halogenAtomId']])
        elif subtype == 'anhydride':
            # NOTE: irPredictor.js's dedup key is
            # `[atom.id, cx.partnerCarbonylId].sort((a,b) => a-b).join('-')`
            # — same numeric-comparator-on-string-ids no-op as elsewhere,
            # so this is really just the unsorted `${atomId}-${partnerId}`
            # pair in that one direction. It never matches the reverse
            # pair `${partnerId}-${atomId}` seen when the loop later
            # visits the *other* carbonyl carbon of the same anhydride,
            # so — bug and all — both carbons fire their own addBand
            # call (hence occurrences=2 for a single anhydride group).
            pair_key = f"{atom['id']}-{cx['partnerCarbonylId']}"
            if pair_key not in handled_anhydride_pairs:
                handled_anhydride_pairs.add(pair_key)
                atom_ids = [atom['id'], cx['partnerCarbonylId'], cx['heteroAtomId']]
                add_band(bands, 'anhydrideCOAsym', {'label': 'Anhydride C=O stretch (asymmetric)', 'range': (1800, 1850), 'intensity': 'strong', 'shape': 'sharp'}, atom_ids)
                add_band(bands, 'anhydrideCOSym', {'label': 'Anhydride C=O stretch (symmetric)', 'range': (1740, 1790), 'intensity': 'strong', 'shape': 'sharp'}, atom_ids)

        if subtype in ('amide', 'lactam') and cx.get('heteroAtomId') is not None:
            n_atom = ctx.by_id[cx['heteroAtomId']]
            n_h = total_attached_h(n_atom, ctx)
            if n_h >= 1:
                add_band(
                    bands, 'amideII',
                    {
                        'label': 'Amide N-H bend + C-N stretch ("amide II")',
                        'range': (1590, 1650) if n_h >= 2 else (1510, 1570),
                        'intensity': 'strong', 'shape': 'medium',
                    },
                    [atom['id'], cx['heteroAtomId']],
                )

        if subtype == 'aldehyde':
            add_band(bands, 'aldehydeCH', {'label': 'Aldehyde C-H stretch (Fermi doublet)', 'range': (2695, 2850), 'intensity': 'weak', 'shape': 'sharp'}, [atom['id']])


def scan_thiocarbonyls(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    for atom in atoms:
        if atom['element'] != 'C' or not has_double_bond_to(atom['id'], 'S', ctx):
            continue
        heavy_nbr_count = sum(1 for n in neighbors_of(atom['id'], ctx) if n.atom['element'] != 'H')
        if heavy_nbr_count == 2 and has_double_bond_to(atom['id'], 'N', ctx):
            continue  # a cumulated isothiocyanate carbon — handled by scan_cumulated_systems instead
        add_band(bands, 'thiocarbonylCS', {'label': 'Thiocarbonyl C=S stretch', 'range': (1050, 1200), 'intensity': 'weak', 'shape': 'medium'}, [atom['id']])


def scan_nitriles_and_imines(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    for atom in atoms:
        if atom['element'] == 'C' and has_triple_bond_to(atom['id'], 'N', ctx):
            add_band(bands, 'nitrileCN', {'label': 'Nitrile C\u2261N stretch', 'range': (2210, 2260), 'intensity': 'medium', 'shape': 'sharp'}, [atom['id']])
        if atom['element'] == 'C' and has_double_bond_to(atom['id'], 'N', ctx) and not has_double_bond_to(atom['id'], 'O', ctx) and not has_double_bond_to(atom['id'], 'S', ctx):
            add_band(bands, 'imineCN', {'label': 'Imine/oxime C=N stretch', 'range': (1630, 1690), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])


def scan_alkenes_and_alkynes(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    seen_bonds: Set[str] = set()
    for atom in atoms:
        if atom['element'] != 'C':
            continue
        for n in neighbors_of(atom['id'], ctx):
            if n.atom['element'] != 'C':
                continue
            # NOTE: irPredictor.js's dedup key is
            # `[atom.id, n.atom.id].sort((a,b) => a-b).join('-')` — the
            # same numeric-sort-on-string-ids no-op described in
            # find_aromatic_six_rings, so this is really just the
            # unsorted `${atomId}-${neighborId}` pair for *this*
            # direction of the bond only. The reverse direction (visited
            # later when the loop reaches the neighbor atom) never
            # matches this key, so — bug and all — every non-aromatic
            # C=C/C\u2261C bond fires its addBand call twice, once from each
            # end (hence occurrences=2 per bond rather than 1).
            bond_key = f"{atom['id']}-{n.atom['id']}"
            if is_bond_aromatic(n.bond):
                continue  # handled separately by scan_aromatic_rings

            if _bond_order(n.bond) == 2 and bond_key not in seen_bonds:
                seen_bonds.add(bond_key)
                add_band(bands, 'alkeneCC', {'label': 'Alkene C=C stretch', 'range': (1620, 1680), 'intensity': 'variable', 'shape': 'medium'}, [atom['id'], n.atom['id']])
            if _bond_order(n.bond) == 3 and bond_key not in seen_bonds:
                seen_bonds.add(bond_key)
                terminal = total_attached_h(atom, ctx) > 0 or total_attached_h(n.atom, ctx) > 0
                if terminal:
                    add_band(bands, 'alkyneTerminalCC', {'label': 'Terminal alkyne C\u2261C stretch', 'range': (2100, 2150), 'intensity': 'medium', 'shape': 'sharp'}, [atom['id'], n.atom['id']])
                    h_bearing = atom if total_attached_h(atom, ctx) > 0 else n.atom
                    add_band(bands, 'alkyneTerminalCH', {'label': 'Terminal alkyne \u2261C-H stretch', 'range': (3260, 3320), 'intensity': 'strong', 'shape': 'sharp'}, [h_bearing['id']])
                else:
                    add_band(bands, 'alkyneInternalCC', {'label': 'Internal alkyne C\u2261C stretch', 'range': (2190, 2260), 'intensity': 'weak', 'shape': 'sharp'}, [atom['id'], n.atom['id']])


def scan_aromatic_rings(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    aromatic_carbon_ids: List[str] = []
    seen_ids: Set[str] = set()
    for atom in atoms:
        if atom['element'] == 'C' and any(is_bond_aromatic(n.bond) for n in neighbors_of(atom['id'], ctx)):
            if atom['id'] not in seen_ids:
                seen_ids.add(atom['id'])
                aromatic_carbon_ids.append(atom['id'])
    if not aromatic_carbon_ids:
        return

    ids_list = aromatic_carbon_ids
    add_band(bands, 'aromaticRingCCHigh', {'label': 'Aromatic ring C=C stretch', 'range': (1580, 1620), 'intensity': 'medium', 'shape': 'sharp'}, ids_list)
    add_band(bands, 'aromaticRingCCLow', {'label': 'Aromatic ring C=C stretch', 'range': (1450, 1510), 'intensity': 'medium', 'shape': 'sharp'}, ids_list)

    aromatic_ch_ids = [aid for aid in ids_list if total_attached_h(ctx.by_id[aid], ctx) > 0]
    if aromatic_ch_ids:
        add_band(bands, 'aromaticCH', {'label': 'Aromatic C-H stretch', 'range': (3000, 3100), 'intensity': 'medium', 'shape': 'medium'}, aromatic_ch_ids)

    rings = find_aromatic_six_rings(atoms, ctx)
    covered_rings: Set[str] = set()
    for ring in rings:
        # Same "sort of string ids is actually a no-op" situation as
        # find_aromatic_six_rings — replicated for the same reason.
        key = ','.join(ring)
        if key in covered_rings:
            continue
        covered_rings.add(key)
        pattern = classify_ring_substitution(ring, ctx)['pattern']
        if pattern == 'unsubstituted':
            add_band(bands, 'aromaticOopUnsub', {'label': 'Aromatic C-H out-of-plane bend (unsubstituted ring)', 'range': (670, 700), 'intensity': 'strong', 'shape': 'sharp'}, ring)
        elif pattern == 'mono':
            add_band(bands, 'aromaticOopMonoA', {'label': 'Aromatic C-H out-of-plane bend (monosubstituted)', 'range': (730, 770), 'intensity': 'strong', 'shape': 'sharp'}, ring)
            add_band(bands, 'aromaticOopMonoB', {'label': 'Aromatic C-H out-of-plane bend (monosubstituted)', 'range': (690, 710), 'intensity': 'strong', 'shape': 'sharp'}, ring)
        elif pattern == 'ortho':
            add_band(bands, 'aromaticOopOrtho', {'label': 'Aromatic C-H out-of-plane bend (ortho-disubstituted)', 'range': (735, 770), 'intensity': 'strong', 'shape': 'sharp'}, ring)
        elif pattern == 'meta':
            add_band(bands, 'aromaticOopMetaA', {'label': 'Aromatic C-H out-of-plane bend (meta-disubstituted)', 'range': (750, 810), 'intensity': 'strong', 'shape': 'sharp'}, ring)
            add_band(bands, 'aromaticOopMetaB', {'label': 'Aromatic C-H out-of-plane bend (meta-disubstituted)', 'range': (680, 730), 'intensity': 'medium', 'shape': 'sharp'}, ring)
        elif pattern == 'para':
            add_band(bands, 'aromaticOopPara', {'label': 'Aromatic C-H out-of-plane bend (para-disubstituted)', 'range': (800, 860), 'intensity': 'strong', 'shape': 'sharp'}, ring)
        else:
            add_band(bands, 'aromaticOopPoly', {'label': 'Aromatic C-H out-of-plane bend (polysubstituted ring)', 'range': (675, 900), 'intensity': 'variable', 'shape': 'medium'}, ring)


def is_acid_oxygen(o_atom, ctx: Ctx) -> bool:
    """Whether a hydroxyl oxygen is a carboxylic/sulfonic acid O-H
    (attached to a carbon/sulfur that itself carries a C=O/S=O) rather
    than a plain alcohol/phenol O-H."""
    return any(
        n.atom['element'] in ('C', 'S') and _bond_order(n.bond) == 1 and (has_double_bond_to(n.atom['id'], 'O', ctx) or has_double_bond_to(n.atom['id'], 'S', ctx))
        for n in neighbors_of(o_atom['id'], ctx)
    )


def is_uncharged_nitro_oxygen(o_atom, ctx: Ctx) -> bool:
    """Guards against a nitro oxygen with a missing formal charge being
    misread as a hydroxyl by the implicit-H math."""
    return any(n.atom['element'] == 'N' and _bond_order(n.bond) == 1 and has_double_bond_to(n.atom['id'], 'O', ctx) for n in neighbors_of(o_atom['id'], ctx))


def scan_heteroatom_hydrogens(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    for atom in atoms:
        h_count = total_attached_h(atom, ctx)
        if h_count == 0:
            continue

        if atom['element'] == 'O':
            if is_uncharged_nitro_oxygen(atom, ctx):
                continue
            if is_acid_oxygen(atom, ctx):
                add_band(bands, 'acidOH', {'label': 'Carboxylic/sulfonic acid O-H stretch', 'range': (2500, 3300), 'intensity': 'medium', 'shape': 'broad'}, [atom['id']])
                add_band(bands, 'acidOHBend', {'label': 'Acid O-H bend + C-O stretch', 'range': (1395, 1440), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
            else:
                add_band(bands, 'alcoholOH', {'label': 'Alcohol/phenol O-H stretch (hydrogen-bonded)', 'range': (3200, 3550), 'intensity': 'strong', 'shape': 'broad'}, [atom['id']])
                add_band(bands, 'alcoholOHBend', {'label': 'Alcohol/phenol O-H bend', 'range': (1330, 1420), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])

        if atom['element'] == 'N':
            is_amide_n = any(n.atom['element'] == 'C' and _bond_order(n.bond) == 1 and has_double_bond_to(n.atom['id'], 'O', ctx) for n in neighbors_of(atom['id'], ctx))
            is_sulfonamide_n = any(
                n.atom['element'] == 'S' and _bond_order(n.bond) == 1
                and sum(1 for m in neighbors_of(n.atom['id'], ctx) if m.atom['element'] == 'O' and _bond_order(m.bond) == 2) >= 2
                for n in neighbors_of(atom['id'], ctx)
            )
            if is_sulfonamide_n:
                add_band(bands, 'sulfonamideNH', {'label': 'Sulfonamide N-H stretch', 'range': (3150, 3400), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
            elif is_amide_n:
                if h_count >= 2:
                    add_band(bands, 'amideNHAsym', {'label': 'Primary amide N-H stretch (asymmetric)', 'range': (3350, 3450), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
                    add_band(bands, 'amideNHSym', {'label': 'Primary amide N-H stretch (symmetric)', 'range': (3180, 3280), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
                else:
                    add_band(bands, 'amideNH', {'label': 'Secondary amide N-H stretch', 'range': (3280, 3320), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
            else:
                if h_count >= 2:
                    add_band(bands, 'amineNHAsym', {'label': 'Primary amine N-H stretch (asymmetric)', 'range': (3400, 3500), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
                    add_band(bands, 'amineNHSym', {'label': 'Primary amine N-H stretch (symmetric)', 'range': (3300, 3400), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
                else:
                    add_band(bands, 'amineNH', {'label': 'Secondary amine N-H stretch', 'range': (3300, 3310), 'intensity': 'weak', 'shape': 'medium'}, [atom['id']])
                add_band(bands, 'amineNHBend', {'label': 'Amine N-H bend (scissoring)', 'range': (1580, 1650), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])

        if atom['element'] == 'S':
            on_aromatic = any(any(is_bond_aromatic(n2.bond) for n2 in neighbors_of(n.atom['id'], ctx)) for n in neighbors_of(atom['id'], ctx))
            add_band(
                bands,
                'thiophenolSH' if on_aromatic else 'thiolSH',
                {'label': 'Thiophenol S-H stretch' if on_aromatic else 'Thiol S-H stretch', 'range': (2550, 2600), 'intensity': 'weak', 'shape': 'sharp'},
                [atom['id']],
            )


def scan_aliphatic_ch(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    """sp3, sp2 (non-aromatic alkene), and general C-H stretches. Aromatic
    C-H and aldehyde C-H are handled by their own, more specific
    detectors since they need extra context this generic pass lacks."""
    for atom in atoms:
        if atom['element'] != 'C':
            continue
        if total_attached_h(atom, ctx) == 0:
            continue
        is_aromatic = any(is_bond_aromatic(n.bond) for n in neighbors_of(atom['id'], ctx))
        if is_aromatic:
            continue
        cx = carbonyl_context(atom['id'], ctx)
        if cx and cx['subtype'] == 'aldehyde':
            continue

        is_vinyl = any(n.atom['element'] == 'C' and _bond_order(n.bond) == 2 for n in neighbors_of(atom['id'], ctx))
        is_alkyne_ch = has_triple_bond_to(atom['id'], 'C', ctx)
        if is_alkyne_ch:
            continue

        # A cyclopropane ring C-H has unusually high s-character (a
        # consequence of the ring's strained "banana bond" geometry),
        # which stiffens the C-H bond enough to push its stretch up into
        # the sp2 region rather than the normal sp3 range below 2960.
        ring = find_smallest_ring(atom['id'], ctx)
        is_cyclopropane_ch = bool(ring and len(ring) == 3 and all(ctx.by_id[rid]['element'] == 'C' for rid in ring))

        if is_vinyl:
            add_band(bands, 'vinylCH', {'label': 'Alkene (vinyl) C-H stretch', 'range': (3020, 3100), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
        elif is_cyclopropane_ch:
            add_band(bands, 'cyclopropaneCH', {'label': 'Cyclopropane ring C-H stretch', 'range': (3000, 3100), 'intensity': 'medium', 'shape': 'medium'}, [atom['id']])
        else:
            add_band(bands, 'alkylCH', {'label': 'sp3 C-H stretch (alkyl)', 'range': (2850, 2960), 'intensity': 'strong', 'shape': 'medium'}, [atom['id']])


def scan_strained_heterorings(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    """Epoxide (oxirane) rings show a well-known, teaching-diagnostic
    three-band ring-stretch signature distinct from a normal ether's
    single C-O-C band — the asymmetric ring stretch near 1250, and a
    second pair (sometimes resolved, sometimes overlapping into one band)
    from 750-950 often described as the ring's symmetric
    stretch/deformation. Aziridine's ring stretches are far weaker and
    less diagnostically reliable at teaching level, so intentionally left
    to its C-N stretch coverage under scan_cn_single_bonds instead of
    adding a speculative band here."""
    seen_rings: Set[str] = set()
    for atom in atoms:
        if atom['element'] != 'O':
            continue
        ring = find_smallest_ring(atom['id'], ctx)
        if not ring or len(ring) != 3:
            continue
        if not all(ctx.by_id[rid]['element'] in ('O', 'C') for rid in ring):
            continue
        key = ','.join(sorted(ring))
        if key in seen_rings:
            continue
        seen_rings.add(key)
        add_band(bands, 'epoxideRingAsym', {'label': 'Epoxide ring C-O-C asymmetric stretch', 'range': (1230, 1260), 'intensity': 'medium', 'shape': 'medium'}, ring)
        add_band(bands, 'epoxideRingSym', {'label': 'Epoxide ring deformation (diagnostic pair)', 'range': (870, 950), 'intensity': 'medium', 'shape': 'medium'}, ring)
        add_band(bands, 'epoxideRingCH2', {'label': 'Epoxide ring deformation (diagnostic pair)', 'range': (750, 840), 'intensity': 'medium', 'shape': 'medium'}, ring)


def scan_halides(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    ranges = {
        'F': {'label': 'C-F stretch', 'range': (1000, 1400), 'intensity': 'strong', 'shape': 'sharp'},
        'Cl': {'label': 'C-Cl stretch', 'range': (600, 800), 'intensity': 'strong', 'shape': 'sharp'},
        'Br': {'label': 'C-Br stretch', 'range': (500, 600), 'intensity': 'strong', 'shape': 'sharp'},
        'I': {'label': 'C-I stretch', 'range': (480, 600), 'intensity': 'strong', 'shape': 'sharp'},
    }
    for atom in atoms:
        if atom['element'] != 'C':
            continue
        for el in ('F', 'Cl', 'Br', 'I'):
            for n in single_bond_neighbors(atom['id'], el, ctx):
                add_band(bands, f'cHalide{el}', ranges[el], [atom['id'], n.atom['id']])


def scan_co_single_bonds(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    """C-O single-bond stretches: ester/carbonate C(=O)-O, ether, and
    alcohol (split by carbinol carbon substitution degree)."""
    for o_atom in atoms:
        if o_atom['element'] != 'O':
            continue
        if total_attached_h(o_atom, ctx) > 0:
            continue
        carbons = [n for n in neighbors_of(o_atom['id'], ctx) if n.atom['element'] == 'C' and _bond_order(n.bond) == 1]
        if len(carbons) < 1:
            continue
        # A 3-membered (epoxide) ring oxygen's C-O-C vibration is already
        # covered, more precisely, by scan_strained_heterorings' dedicated
        # ring-stretch triplet — skip it here to avoid double-reporting
        # the same physical mode as both a generic ether band and an
        # epoxide-specific one.
        ring = find_smallest_ring(o_atom['id'], ctx)
        if ring and len(ring) == 3:
            continue

        carbonyl_partner = next((n for n in carbons if has_double_bond_to(n.atom['id'], 'O', ctx)), None)
        if carbonyl_partner and len(carbons) == 2:
            alkoxy_carbon = next((n for n in carbons if n.atom['id'] != carbonyl_partner.atom['id']), None)
            cx = carbonyl_context(carbonyl_partner.atom['id'], ctx)
            is_carbonate = bool(cx and cx['subtype'] == 'carbonate')
            add_band(
                bands,
                'carbonateCOAsym' if is_carbonate else 'esterCOAsym',
                {'label': 'Carbonate C-O stretch (asymmetric)' if is_carbonate else 'Ester C(=O)-O stretch (asymmetric)', 'range': (1200, 1300), 'intensity': 'strong', 'shape': 'sharp'},
                [o_atom['id'], carbonyl_partner.atom['id']],
            )
            add_band(
                bands,
                'carbonateCOSym' if is_carbonate else 'esterCOSym',
                {
                    'label': 'Carbonate C-O stretch (symmetric)' if is_carbonate else 'Ester O-C(alkyl) stretch (symmetric)',
                    'range': (1000, 1100), 'intensity': 'strong' if is_carbonate else 'medium', 'shape': 'sharp',
                },
                [o_atom['id'], alkoxy_carbon.atom['id'] if alkoxy_carbon else carbonyl_partner.atom['id']],
            )
            continue

        if len(carbons) == 2:
            aryl = any(any(is_bond_aromatic(n2.bond) for n2 in neighbors_of(n.atom['id'], ctx)) for n in carbons)
            add_band(
                bands,
                'etherArylCO' if aryl else 'etherAlkylCO',
                {'label': 'Aryl ether C-O-C stretch' if aryl else 'Dialkyl ether C-O-C stretch', 'range': (1200, 1275) if aryl else (1085, 1150), 'intensity': 'strong', 'shape': 'sharp'},
                [o_atom['id']] + [n.atom['id'] for n in carbons],
            )

    # Alcohol C-OH, split by carbinol-carbon substitution degree.
    for o_atom in atoms:
        if o_atom['element'] != 'O' or total_attached_h(o_atom, ctx) == 0:
            continue
        if is_acid_oxygen(o_atom, ctx):
            continue
        carbon = next((n for n in neighbors_of(o_atom['id'], ctx) if n.atom['element'] == 'C' and _bond_order(n.bond) == 1), None)
        if not carbon:
            continue
        carbon_is_aromatic = any(is_bond_aromatic(n.bond) for n in neighbors_of(carbon.atom['id'], ctx))
        if carbon_is_aromatic:
            add_band(bands, 'phenolCO', {'label': 'Phenol C-O stretch', 'range': (1200, 1260), 'intensity': 'strong', 'shape': 'sharp'}, [o_atom['id'], carbon.atom['id']])
            continue
        degree = sum(1 for n in neighbors_of(carbon.atom['id'], ctx) if n.atom['element'] == 'C')
        if degree >= 3:
            add_band(bands, 'alcoholCOTertiary', {'label': 'Tertiary alcohol C-O stretch', 'range': (1100, 1200), 'intensity': 'strong', 'shape': 'sharp'}, [o_atom['id'], carbon.atom['id']])
        elif degree == 2:
            add_band(bands, 'alcoholCOSecondary', {'label': 'Secondary alcohol C-O stretch', 'range': (1075, 1150), 'intensity': 'strong', 'shape': 'sharp'}, [o_atom['id'], carbon.atom['id']])
        else:
            add_band(bands, 'alcoholCOPrimary', {'label': 'Primary alcohol C-O stretch (or methanol-type)', 'range': (1000, 1075), 'intensity': 'strong', 'shape': 'sharp'}, [o_atom['id'], carbon.atom['id']])


def scan_cn_single_bonds(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    """Amine C-N stretch. Aromatic amines (anilines) sit noticeably higher
    due to conjugation with the ring."""
    for n_atom in atoms:
        if n_atom['element'] != 'N':
            continue
        if has_double_bond_to(n_atom['id'], 'C', ctx) or has_triple_bond_to(n_atom['id'], 'C', ctx):
            continue
        if is_nitro_nitrogen(n_atom['id'], ctx):
            continue
        is_amide_n = any(n.atom['element'] == 'C' and _bond_order(n.bond) == 1 and has_double_bond_to(n.atom['id'], 'O', ctx) for n in neighbors_of(n_atom['id'], ctx))
        if is_amide_n:
            continue
        carbons = [n for n in neighbors_of(n_atom['id'], ctx) if n.atom['element'] == 'C' and _bond_order(n.bond) == 1]
        if not carbons:
            continue
        aromatic = any(any(is_bond_aromatic(n2.bond) for n2 in neighbors_of(n.atom['id'], ctx)) for n in carbons)
        add_band(
            bands,
            'aromaticAmineCN' if aromatic else 'amineCN',
            {'label': 'Aromatic amine C-N stretch' if aromatic else 'Aliphatic amine C-N stretch', 'range': (1250, 1340) if aromatic else (1020, 1250), 'intensity': 'medium', 'shape': 'medium'},
            [n_atom['id']] + [n.atom['id'] for n in carbons],
        )


def scan_nitro_groups(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    for atom in atoms:
        if not is_nitro_nitrogen(atom['id'], ctx):
            continue
        add_band(bands, 'nitroAsym', {'label': 'Nitro group N-O stretch (asymmetric)', 'range': (1500, 1570), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
        add_band(bands, 'nitroSym', {'label': 'Nitro group N-O stretch (symmetric)', 'range': (1300, 1370), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])


def scan_azides(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    for atom in atoms:
        if not is_azide_attachment_nitrogen(atom, ctx):
            continue
        n2 = next(n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'N')
        n3 = next(n for n in neighbors_of(n2.atom['id'], ctx) if n.atom['id'] != atom['id'] and n.atom['element'] == 'N')
        add_band(
            bands, 'azideAsym',
            {'label': 'Azide N3 stretch (asymmetric)', 'range': (2085, 2160), 'intensity': 'strong', 'shape': 'sharp'},
            [atom['id'], n2.atom['id'], n3.atom['id']],
        )


def scan_cumulated_systems(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    """Isocyanate (N=C=O) and isothiocyanate (N=C=S) — a carbon flanked by
    two cumulated double bonds, chemically similar in spirit to CO2's
    central carbon, giving each an unusually high-wavenumber, sharp,
    strong, and highly characteristic stretch."""
    for atom in atoms:
        if atom['element'] != 'C':
            continue
        heavy_nbr_count = sum(1 for n in neighbors_of(atom['id'], ctx) if n.atom['element'] != 'H')
        if heavy_nbr_count != 2:
            continue
        if has_double_bond_to(atom['id'], 'N', ctx) and has_double_bond_to(atom['id'], 'O', ctx):
            add_band(bands, 'isocyanateNCO', {'label': 'Isocyanate N=C=O stretch', 'range': (2250, 2275), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])
        elif has_double_bond_to(atom['id'], 'N', ctx) and has_double_bond_to(atom['id'], 'S', ctx):
            add_band(bands, 'isothiocyanateNCS', {'label': 'Isothiocyanate N=C=S stretch', 'range': (2100, 2150), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']])


def scan_boron(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    for atom in atoms:
        if atom['element'] != 'B':
            continue
        oxygens = single_bond_neighbors(atom['id'], 'O', ctx)
        if not oxygens:
            continue
        add_band(bands, 'boronBO', {'label': 'Boronic acid/ester B-O stretch', 'range': (1310, 1350), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']] + [o.atom['id'] for o in oxygens])
        oh_oxygens = [o for o in oxygens if total_attached_h(o.atom, ctx) > 0]
        if oh_oxygens:
            add_band(bands, 'boronOH', {'label': 'Boronic acid B-OH stretch (overlaps the alcohol/acid O-H region)', 'range': (3150, 3300), 'intensity': 'medium', 'shape': 'broad'}, [o.atom['id'] for o in oh_oxygens])


def scan_phosphorus(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    for atom in atoms:
        if atom['element'] != 'P':
            continue
        oxygen_doubles = [n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'O' and _bond_order(n.bond) == 2]
        if oxygen_doubles:
            add_band(
                bands, 'phosphorylPO',
                {'label': 'Phosphoryl P=O stretch', 'range': (1150, 1300), 'intensity': 'strong', 'shape': 'medium'},
                [atom['id']] + [o.atom['id'] for o in oxygen_doubles],
            )
        oxygen_singles = single_bond_neighbors(atom['id'], 'O', ctx)
        oc_oxygens = [o for o in oxygen_singles if total_attached_h(o.atom, ctx) == 0]
        if oc_oxygens:
            add_band(bands, 'phosphorusPOC', {'label': 'P-O-C stretch', 'range': (995, 1050), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id']] + [o.atom['id'] for o in oc_oxygens])
        oh_oxygens = [o for o in oxygen_singles if total_attached_h(o.atom, ctx) > 0]
        if oh_oxygens:
            add_band(bands, 'phosphorusPOH', {'label': 'Phosphonic/phosphoric acid P-OH stretch (broad)', 'range': (2560, 2700), 'intensity': 'medium', 'shape': 'broad'}, [o.atom['id'] for o in oh_oxygens])


def scan_sulfur_oxides(atoms, ctx: Ctx, bands: Dict[str, Dict[str, Any]]) -> None:
    for atom in atoms:
        if atom['element'] != 'S':
            continue
        oxygen_doubles = [n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'O' and _bond_order(n.bond) == 2]
        if len(oxygen_doubles) == 1:
            add_band(bands, 'sulfoxideSO', {'label': 'Sulfoxide S=O stretch', 'range': (1030, 1070), 'intensity': 'strong', 'shape': 'sharp'}, [atom['id'], oxygen_doubles[0].atom['id']])
        elif len(oxygen_doubles) >= 2:
            ids = [atom['id']] + [n.atom['id'] for n in oxygen_doubles]
            add_band(bands, 'sulfoneSOAsym', {'label': 'Sulfone S=O stretch (asymmetric)', 'range': (1300, 1350), 'intensity': 'strong', 'shape': 'sharp'}, ids)
            add_band(bands, 'sulfoneSOSym', {'label': 'Sulfone S=O stretch (symmetric)', 'range': (1120, 1160), 'intensity': 'strong', 'shape': 'sharp'}, ids)


# ---------------------------------------------------------------------
# Reported-wavenumber assignment, confidence, explanation
# ---------------------------------------------------------------------

def assign_reported_wavenumber(bands: Dict[str, Dict[str, Any]]) -> None:
    for b in bands.values():
        lo, hi = b['range']
        span = hi - lo
        if span <= 0:
            b['wavenumber'] = round(lo)
            continue
        frac = 0.35 + 0.3 * stable_fraction(b['key'])
        b['wavenumber'] = round(lo + span * frac)


def estimate_confidence(key: str, rng: Range, intensity: str) -> Dict[str, Any]:
    width = rng[1] - rng[0]
    h_bond_sensitive = bool(re.match(r'^(acidOH|alcoholOH|amine|amide.*NH|thiol|thiophenol)', key))
    factors: List[str] = []
    if h_bond_sensitive:
        factors.append('Hydrogen-bond sensitive — real position/width shifts with concentration, solvent, and phase')
    if width <= 60:
        factors.append('Narrow, well-established textbook range')
    elif width <= 150:
        factors.append('Moderate-width textbook range')
    else:
        factors.append('Wide textbook range — treat as approximate')
    if intensity == 'variable':
        factors.append('Intensity itself is structure-dependent (can be weak-to-absent for symmetric cases)')

    if h_bond_sensitive:
        value = 0.35 if width > 150 else 0.5
    elif width <= 60:
        value = 0.85
    elif width <= 150:
        value = 0.65
    else:
        value = 0.45
    return {'value': value, 'factors': factors}


def explain_band(key: str) -> Optional[str]:
    """Plain-English "why does it absorb there" — always some version of
    Hooke's law: wavenumber scales with sqrt(force constant / reduced
    mass), so a stronger bond or a lighter attached atom pushes the
    absorption higher, a heavier atom or weaker bond pulls it lower."""
    if re.match(r'^(acidOH|alcoholOH)', key) and 'Bend' not in key:
        return 'O-H is the lightest common stretch (hydrogen has very low mass), which alone would put it very high; hydrogen bonding weakens and lengthens the O-H bond, lowering its force constant and broadening the band into the wide, rounded shape seen here rather than a sharp line.'
    if re.match(r'^(amine|amide).*NH', key) and 'Bend' not in key:
        return 'N-H sits a little below O-H for the same light-atom reason, since nitrogen is slightly less electronegative than oxygen and hydrogen bonds somewhat more weakly here.'
    if key.startswith('thiol') or key.startswith('thiophenol'):
        return "S-H sits far lower than O-H or N-H: sulfur's much larger mass dominates the reduced-mass term in Hooke's law, and sulfur barely hydrogen-bonds, so this band is both lower and notably weaker."
    if key == 'coumarinCO':
        return "Coumarin's lactone carbonyl sits a little below a typical saturated lactone's stretch: conjugation with the ring's C3=C4 alkene donates electron density back into the carbonyl by resonance, softening the C=O bond's force constant."
    if key == 'chromoneCO':
        return "A chromone/flavone carbonyl is pulled unusually low by strong conjugation relayed all the way from the ring oxygen through the C2=C3 alkene to the C=O (a vinylogous-ester arrangement) — softening the C=O bond's force constant more than simple conjugation with just a ring or a single alkene would."
    co_prefixes = ('aldehyde', 'ketone', 'acid', 'ester', 'lactone', 'amide', 'lactam', 'urea', 'carbamate', 'acylHalide', 'anhydride', 'carbonateCO')
    if 'CO' in key and key.startswith(co_prefixes):
        return 'A C=O double bond is short and stiff (high force constant), which is what pushes carbonyl stretches so far up the spectrum relative to any single C-O or C-N bond; conjugation with an adjacent ring or C=C pulls some of that double-bond character away, softening (lowering) it, while ring strain in a small lactone/lactam does the opposite and raises it.'
    if key == 'thiocarbonylCS':
        return "A C=S bond is longer and weaker than C=O (sulfur's larger, more diffuse orbitals overlap less effectively with carbon's), which is why this sits far lower and less predictably than a carbonyl stretch."
    if key == 'nitrileCN':
        return 'A carbon-nitrogen triple bond is even stiffer than a double bond, pushing this well above any C=O or C=C stretch.'
    if key == 'imineCN':
        return "A C=N double bond behaves like a lighter-atom cousin of C=C, sitting in a similar region but shifted somewhat by nitrogen\u2019s lone pair and electronegativity."
    if key.startswith('alkyneTerminal') and key.endswith('CC'):
        return 'A carbon-carbon triple bond is the stiffest common C-C bond, placing this well above a C=C stretch.'
    if key == 'alkyneInternalCC':
        return "The same stiff C\u2261C bond as a terminal alkyne, but with no net change in dipole moment along a symmetric or near-symmetric internal triple bond, which is what makes this band weak or sometimes essentially absent."
    if key == 'alkyneTerminalCH':
        return "An sp carbon\u2019s C-H bond has more s-character than sp2 or sp3 C-H, pulling electron density closer to carbon and stiffening the bond enough to push this stretch unusually high and sharp."
    if key == 'alkeneCC':
        return "A C=C double bond is stiffer than a single C-C bond but far more flexible than a triple bond, placing this stretch between the two; a highly symmetric alkene can show little-to-no absorption here since the vibration barely changes the molecule\u2019s dipole moment."
    if key.startswith('aromaticRingCC'):
        return "The ring's delocalized, partial-double-bond character gives a stiffness between a pure single and pure double C-C bond, and ring symmetry typically produces this pair of bands rather than one."
    if key.startswith('aromaticOop') or 'OopUnsub' in key:
        return 'This is a bending (not stretching) vibration of the ring C-H bonds moving out of the ring plane together; exactly which wavenumber it falls at depends on how many ring positions are substituted and their arrangement, which is why this band is used as a substitution-pattern fingerprint.'
    if key == 'aromaticCH' or key == 'vinylCH':
        return "An sp2 carbon\u2019s C-H bond is slightly stiffer than an sp3 one, which is what places all C-H stretches on sp2 carbons just above 3000 cm\u207b\u00b9 \u2014 the standard dividing line from sp3 C-H below it."
    if key == 'alkylCH':
        return 'A plain sp3 C-H bond sits in the most common IR region for organic compounds \u2014 nearly every organic structure shows this band somewhere, so on its own it is diagnostic of very little.'
    if key == 'cyclopropaneCH':
        return "A cyclopropane ring C-H bond has unusually high s-character (a consequence of the ring's strained \u201cbanana bond\u201d geometry), which stiffens the bond enough to push its stretch up into the sp2 (>3000 cm\u207b\u00b9) region despite the carbon itself being sp3 \u2014 a useful tell that a compound contains a three-membered carbocycle."
    if key.startswith('epoxideRing'):
        return "The epoxide ring's C-O-C bonds are highly strained and their stretching/deformation motions couple together, producing this characteristic set of bands distinct from a normal (unstrained) ether's single C-O-C stretch \u2014 one of the more reliable structural fingerprints in IR."
    if key.startswith('cHalide'):
        return "Heavier halogens (Cl, Br, I) add substantial reduced mass to the C-X vibration, which is what pushes this stretch progressively lower down the spectrum than a C-F bond, even though C-F is actually a fairly strong bond."
    if key == 'phenolCO':
        return "A phenol's C-O bond gets partial double-bond character from conjugation with the aromatic ring (the oxygen's lone pair delocalizes into the ring), which stiffens the bond enough to push this stretch higher and into a narrower range than a typical aliphatic alcohol's C-O."
    if key.startswith('alcoholCO') or key.startswith('ether') or key.startswith('esterCO') or key.startswith('carbonateCO'):
        return 'A single C-O bond is stiffer than a single C-C or C-N bond because oxygen holds its bonding electrons more tightly, placing this stretch in the busy 1000-1300 cm\u207b\u00b9 "fingerprint" region alongside many other single-bond vibrations.'
    if 'CN' in key and (key.startswith('amine') or key.startswith('aromaticAmine')):
        return 'A single C-N bond is generally weaker and lighter than C-O, and this stretch often mixes with other skeletal vibrations, which is why it is a weaker, less reliably diagnostic band than the O-analog.'
    if key.startswith('nitro'):
        return "The nitro group's two N-O bonds are intermediate in bond order (delocalized between single and double), and their coupled asymmetric/symmetric stretching motions are what produce this characteristic strong pair of bands."
    if key.startswith('sulfoxide') or key.startswith('sulfone'):
        return 'A sulfur-oxygen bond in an oxidized sulfur group is highly polar and reasonably stiff, giving a strong, prominent band \u2014 doubled into asymmetric/symmetric bands when two equivalent S=O bonds are present, as in a sulfone.'
    if key == 'sulfonamideNH':
        return "Sits close to an amide N-H's position for a similar reason: the adjacent, strongly electron-withdrawing sulfonyl group weakens the N-H bond by pulling electron density away from the nitrogen."
    if key == 'azideAsym':
        return "The azide group's three nitrogens are strongly conjugated (delocalized across all three, much like carbon dioxide's structure), and the resulting stiff, coupled stretching motion pushes this band unusually high and makes it one of the more instantly recognizable bands in an IR spectrum."
    if key in ('isocyanateNCO', 'isothiocyanateNCS'):
        return "This group is built from two cumulated double bonds sharing one central atom (again, structurally analogous to CO2), and that cumulated-double-bond arrangement is what pushes the stretch this high and makes it so sharp and strong \u2014 among the most recognizable bands in the entire spectrum."
    if key == 'boronBO':
        return "A boron-oxygen bond is short and quite polar (boron's empty p-orbital accepts some electron density from oxygen's lone pair), giving a strong, well-defined stretch in a region only a few other bonds occupy."
    if key == 'boronOH':
        return 'A boronic acid B-OH behaves similarly to an alcohol O-H for the same light-atom, hydrogen-bonding reasons \u2014 which unfortunately also means it is difficult to distinguish from a genuine O-H band without other evidence.'
    if key == 'phosphorylPO':
        return "A phosphorus-oxygen double bond (in reality better described as having significant single-bond character too, from phosphorus's d-orbital-like involvement) is highly polar, giving a strong and very characteristic band \u2014 though its exact position shifts noticeably with what else is attached to the phosphorus, which is why this range is drawn wider than a typical carbonyl's."
    if key == 'phosphorusPOC':
        return 'Similar in kind to a C-O-C ether stretch, but phosphorus\u2019s own electron-withdrawing character (especially with a P=O elsewhere on the same atom) stiffens this bond somewhat differently than a plain alkyl ether would.'
    if key == 'phosphorusPOH':
        return "A phosphonic/phosphoric acid P-OH behaves like a heavier-atom cousin of a carboxylic acid O-H \u2014 strong hydrogen bonding broadens and lowers this stretch far below a free O-H, in the same spirit as the acid O-H band, though centered at a different position."
    return None


# ---------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------

def predict_ir(atoms: List[Dict[str, Any]], bonds: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Predicts IR absorption bands for a structure. Returns
    `{bands: [...]}`, each band shaped as
    `{key, label, range: [low, high], wavenumber, intensity, shape,
    atomIds, occurrences, confidence, confidenceFactors, reason}`,
    sorted by wavenumber descending (high wavenumber on the left, the
    convention real IR spectra are read in)."""
    ctx = build_context(atoms, bonds)
    heavy_atoms = [a for a in atoms if a['element'] != 'H' and not is_metal(a)]

    bands: Dict[str, Dict[str, Any]] = {}

    scan_carbonyls(heavy_atoms, ctx, bands)
    scan_thiocarbonyls(heavy_atoms, ctx, bands)
    scan_nitriles_and_imines(heavy_atoms, ctx, bands)
    scan_alkenes_and_alkynes(heavy_atoms, ctx, bands)
    scan_aromatic_rings(heavy_atoms, ctx, bands)
    scan_strained_heterorings(heavy_atoms, ctx, bands)
    scan_heteroatom_hydrogens(heavy_atoms, ctx, bands)
    scan_aliphatic_ch(heavy_atoms, ctx, bands)
    scan_halides(heavy_atoms, ctx, bands)
    scan_co_single_bonds(heavy_atoms, ctx, bands)
    scan_cn_single_bonds(heavy_atoms, ctx, bands)
    scan_nitro_groups(heavy_atoms, ctx, bands)
    scan_sulfur_oxides(heavy_atoms, ctx, bands)
    scan_azides(heavy_atoms, ctx, bands)
    scan_cumulated_systems(heavy_atoms, ctx, bands)
    scan_boron(heavy_atoms, ctx, bands)
    scan_phosphorus(heavy_atoms, ctx, bands)

    assign_reported_wavenumber(bands)

    out = []
    for b in bands.values():
        confidence_info = estimate_confidence(b['key'], b['range'], b['intensity'])
        out.append({
            **b,
            'confidence': confidence_info['value'],
            'confidenceFactors': confidence_info['factors'],
            'reason': explain_band(b['key']),
        })
    out.sort(key=lambda band: band['wavenumber'], reverse=True)
    return {'bands': out}