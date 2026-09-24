"""Structure-level functional-group and named fused-ring scaffold
recognition, operating on the same {atoms, bonds} graph shape the NMR
and IR predictors already use.

Two entry points:

  detect_functional_groups(atoms, bonds) -> [{key, name, atomIds, description}]
      Walks the graph once and reports every standard functional group
      present — amide, lactam, lactone, ester, anhydride, acyl halide,
      carboxylic acid, ketone, aldehyde, thio- analogs, alcohol, phenol,
      ether, amine, nitrile, nitro, azide, isocyanate, halide, thiol,
      sulfide, sulfoxide, sulfone, epoxide/aziridine/thiirane, alkene,
      alkyne, and aromatic/heteroaromatic rings. This deliberately reuses
      the exact same classification helpers nmr.py already relies on
      (`carbonyl_context`, `oxygen_role`, `strained_ring_info`, ...), so
      "lactone" here is the identical graph pattern nmr.py gives its own
      13C shift range — one definition of each group, not two that could
      drift apart.

  detect_named_scaffolds(atoms, bonds) -> [{key, name, atomIds, description}]
      Fused bicyclic natural-product cores that are a *specific relative
      arrangement* of several functional groups, not a functional group
      on their own: coumarin (2H-chromen-2-one), chromone
      (4H-chromen-4-one), and flavone (2-phenylchromen-4-one — a
      chromone bearing an aryl group at C2). detect_functional_groups()
      already correctly tags the lactone/ketone atoms inside these; this
      is the layer that additionally recognizes "this whole fused ring
      IS a coumarin" by checking the carbonyl position, the ring
      alkene, and the ortho-fused benzo ring are all in the exact
      relative arrangement each name requires (isoflavone or any other
      look-alike relative arrangement does NOT match).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from .common import (
    Ctx, build_context, neighbors_of, is_bond_aromatic, is_metal,
    has_double_bond_to, has_triple_bond_to, single_bond_neighbors,
    total_attached_h, bond_order_value as _bond_order,
)
from .nmr import (
    carbonyl_context, thiocarbonyl_context, oxygen_role,
    find_aromatic_rings, is_aromatic_atom, strained_ring_info,
)

Hit = Dict[str, Any]


def _add(hits: List[Hit], key: str, name: str, atom_ids, description: str = '') -> None:
    hits.append({'key': key, 'name': name, 'atomIds': sorted(set(atom_ids)), 'description': description})


def _dedupe(hits: List[Hit]) -> List[Hit]:
    seen: Set[tuple] = set()
    out: List[Hit] = []
    for h in hits:
        sig = (h['key'], tuple(h['atomIds']))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(h)
    return out


# ---------------------------------------------------------------------
# detect_functional_groups
# ---------------------------------------------------------------------

def detect_functional_groups(atoms: List[Dict[str, Any]], bonds: List[Dict[str, Any]]) -> List[Hit]:
    ctx = build_context(atoms, bonds)
    hits: List[Hit] = []
    heavy_atoms = [a for a in atoms if a['element'] != 'H' and not is_metal(a)]

    for atom in heavy_atoms:
        aid = atom['id']
        el = atom['element']
        nbrs = neighbors_of(aid, ctx)

        if el == 'C':
            cx = carbonyl_context(aid, ctx)
            if cx is not None:
                carbonyl_o = next((n for n in nbrs if n.atom['element'] == 'O' and _bond_order(n.bond) == 2), None)
                co_id = carbonyl_o.atom['id'] if carbonyl_o else None
                halogen_n = next((n for n in nbrs if n.atom['element'] in ('F', 'Cl', 'Br', 'I') and _bond_order(n.bond) == 1), None)
                if not cx['hasHeteroSingle'] and halogen_n is not None:
                    _add(hits, 'acylHalide', 'Acyl Halide', [aid, co_id, halogen_n.atom['id']],
                         'C=O directly bonded to a halogen — very reactive toward water, alcohols, and amines.')
                elif not cx['hasHeteroSingle']:
                    if cx['hCount'] >= 1:
                        _add(hits, 'aldehyde', 'Aldehyde', [aid, co_id], 'Carbonyl carbon carrying exactly one H.')
                    else:
                        _add(hits, 'ketone', 'Ketone', [aid, co_id], 'Carbonyl flanked by two carbon groups.')
                else:
                    hetero_n = next(n for n in nbrs if n.atom['element'] in ('O', 'N') and _bond_order(n.bond) == 1)
                    group = [aid, co_id, hetero_n.atom['id']]
                    subtype = cx['subtype']
                    if subtype == 'acid':
                        _add(hits, 'carboxylicAcid', 'Carboxylic Acid', group, 'C=O and C-O-H on the same carbon.')
                    elif subtype == 'ester':
                        other_c = next((n for n in neighbors_of(hetero_n.atom['id'], ctx)
                                         if n.atom['id'] != aid and n.atom['element'] == 'C'), None)
                        if other_c and carbonyl_context(other_c.atom['id'], ctx):
                            _add(hits, 'anhydride', 'Anhydride', group + [other_c.atom['id']],
                                 'Two carbonyls flanking a single oxygen.')
                        else:
                            _add(hits, 'ester', 'Ester', group, 'C=O bonded to an -O-R (not -O-H).')
                    elif subtype == 'lactone':
                        _add(hits, 'lactone', 'Lactone', group, 'A cyclic ester — the C=O and its -O-R sit on the same ring.')
                    elif subtype == 'amide':
                        _add(hits, 'amide', 'Amide', group, 'C=O directly bonded to nitrogen.')
                    elif subtype == 'lactam':
                        _add(hits, 'lactam', 'Lactam', group, 'A cyclic amide — the C=O and its N sit on the same ring.')
                    elif subtype == 'urea':
                        _add(hits, 'urea', 'Urea', group, 'Two nitrogens flanking a single carbonyl.')
                    elif subtype == 'carbamate':
                        _add(hits, 'carbamate', 'Carbamate', group, 'A carbonyl flanked by one O and one N.')

            tx = thiocarbonyl_context(aid, ctx)
            if tx is not None:
                thio_s = next((n for n in nbrs if n.atom['element'] == 'S' and _bond_order(n.bond) == 2), None)
                s_id = thio_s.atom['id'] if thio_s else None
                subtype = tx['subtype']
                if subtype == 'thioamide':
                    n_n = next(n for n in nbrs if n.atom['element'] == 'N' and _bond_order(n.bond) == 1)
                    _add(hits, 'thioamide', 'Thioamide', [aid, s_id, n_n.atom['id']], 'The C=S analog of an amide.')
                elif subtype == 'thiourea':
                    _add(hits, 'thiourea', 'Thiourea', [aid, s_id], 'Two nitrogens flanking a thiocarbonyl.')
                elif subtype == 'dithioic':
                    _add(hits, 'dithioicAcid', 'Dithioic Acid/Ester', [aid, s_id], 'C=S with a second sulfur single-bonded on the same carbon.')
                elif subtype == 'thionoester':
                    _add(hits, 'thionoester', 'Thionoester', [aid, s_id], 'C=S with an -O-R on the same carbon.')

            if has_triple_bond_to(aid, 'N', ctx):
                n_n = next((n for n in nbrs if n.atom['element'] == 'N' and _bond_order(n.bond) == 3), None)
                heavy_nbr_count = sum(1 for n in nbrs if n.atom['element'] != 'H')
                if n_n and heavy_nbr_count == 1:
                    _add(hits, 'nitrile', 'Nitrile', [aid, n_n.atom['id']], 'Carbon triple-bonded to nitrogen.')

            alkyne_partner = next((n for n in nbrs if n.atom['element'] == 'C' and _bond_order(n.bond) == 3), None)
            if alkyne_partner:
                _add(hits, 'alkyne', 'Alkyne', [aid, alkyne_partner.atom['id']], 'Carbon-carbon triple bond.')

            alkene_partner = next((n for n in nbrs if n.atom['element'] == 'C' and _bond_order(n.bond) == 2 and not is_bond_aromatic(n.bond)), None)
            if alkene_partner:
                _add(hits, 'alkene', 'Alkene', [aid, alkene_partner.atom['id']], 'Carbon-carbon double bond (non-aromatic).')

            for o_n in single_bond_neighbors(aid, 'O', ctx):
                role = oxygen_role(o_n.atom, aid, ctx)
                if role == 'alcohol':
                    if is_aromatic_atom(aid, ctx):
                        _add(hits, 'phenol', 'Phenol', [aid, o_n.atom['id']], 'Hydroxyl bonded directly to an aromatic ring carbon.')
                    else:
                        _add(hits, 'alcohol', 'Alcohol', [aid, o_n.atom['id']], 'Hydroxyl bonded to a carbon chain.')
                elif role in ('etherAlkyl', 'etherAryl'):
                    other_c = next((n for n in neighbors_of(o_n.atom['id'], ctx) if n.atom['id'] != aid and n.atom['element'] == 'C'), None)
                    if other_c:
                        _add(hits, 'ether', 'Ether', [aid, o_n.atom['id'], other_c.atom['id']], 'Oxygen sandwiched between two carbons, no O-H.')

            ring_info = strained_ring_info(aid, ctx)
            if ring_info and ring_info['hetero'] in ('O', 'N', 'S') and ring_info['position'] != 'beta':
                hetero_name = {'O': 'Epoxide' if ring_info['ringSize'] == 3 else 'Oxetane',
                                'N': 'Aziridine' if ring_info['ringSize'] == 3 else 'Azetidine',
                                'S': 'Thiirane' if ring_info['ringSize'] == 3 else 'Thietane'}[ring_info['hetero']]
                ring_atoms = [aid] + [n.atom['id'] for n in nbrs if n.atom['element'] != 'H']
                _add(hits, hetero_name.lower(), hetero_name, ring_atoms, f'A strained {ring_info["ringSize"]}-membered ring containing {ring_info["hetero"]}.')

            if cx is None:
                for hal_n in [n for n in nbrs if n.atom['element'] in ('F', 'Cl', 'Br', 'I') and _bond_order(n.bond) == 1]:
                    _add(hits, 'halide', 'Alkyl/Aryl Halide', [aid, hal_n.atom['id']], f"Carbon-halogen ({hal_n.atom['element']}) single bond.")

        elif el == 'N':
            o_dbls = [n for n in nbrs if n.atom['element'] == 'O' and _bond_order(n.bond) == 2]
            c_dbl = next((n for n in nbrs if n.atom['element'] == 'C' and _bond_order(n.bond) == 2), None)
            if len(o_dbls) >= 2:
                _add(hits, 'nitro', 'Nitro', [aid] + [o.atom['id'] for o in o_dbls], 'Nitrogen double-bonded to two oxygens.')
            elif c_dbl is not None and any(n.atom['element'] == 'O' and total_attached_h(n.atom, ctx) > 0 for n in nbrs):
                oh = next(n for n in nbrs if n.atom['element'] == 'O' and total_attached_h(n.atom, ctx) > 0)
                _add(hits, 'oxime', 'Oxime', [aid, c_dbl.atom['id'], oh.atom['id']], 'C=N with an -OH on the nitrogen.')
            elif c_dbl is not None and any(n.atom['element'] == 'N' and n.atom['id'] != aid for n in neighbors_of(c_dbl.atom['id'], ctx)):
                pass  # left to a dedicated hydrazone check if ever needed — rare enough to skip false-positives here
            elif c_dbl is not None:
                _add(hits, 'imine', 'Imine', [aid, c_dbl.atom['id']], 'Carbon-nitrogen double bond.')
            else:
                n_singles = [n for n in nbrs if n.atom['element'] == 'C' and _bond_order(n.bond) == 1]
                if n_singles and not any(carbonyl_context(n.atom['id'], ctx) or thiocarbonyl_context(n.atom['id'], ctx) for n in n_singles):
                    _add(hits, 'amine', 'Amine', [aid], 'Nitrogen with only single bonds, no adjacent carbonyl.')

        elif el == 'S':
            c_nbrs = [n for n in nbrs if n.atom['element'] == 'C' and _bond_order(n.bond) == 1]
            o_dbl_count = sum(1 for n in nbrs if n.atom['element'] == 'O' and _bond_order(n.bond) == 2)
            if c_nbrs:
                if o_dbl_count >= 2:
                    _add(hits, 'sulfone', 'Sulfone', [aid] + [n.atom['id'] for n in c_nbrs], 'Sulfur double-bonded to two oxygens.')
                elif o_dbl_count == 1:
                    _add(hits, 'sulfoxide', 'Sulfoxide', [aid] + [n.atom['id'] for n in c_nbrs], 'Sulfur double-bonded to one oxygen.')
                elif total_attached_h(atom, ctx) > 0:
                    _add(hits, 'thiol', 'Thiol', [aid, c_nbrs[0].atom['id']], 'Carbon bonded to -SH.')
                elif len(c_nbrs) == 2:
                    _add(hits, 'sulfide', 'Thioether (Sulfide)', [aid] + [n.atom['id'] for n in c_nbrs], 'Sulfur sandwiched between two carbons.')

    for ring in find_aromatic_rings(atoms, ctx, 6):
        by_id = {a['id']: a for a in atoms}
        heteros = [rid for rid in ring if by_id[rid]['element'] not in ('C', 'H')]
        if heteros:
            _add(hits, 'heteroaromaticRing', 'Heteroaromatic Ring', ring, f"Aromatic ring containing {', '.join(sorted({by_id[r]['element'] for r in heteros}))}.")
        else:
            _add(hits, 'aromaticRing', 'Aromatic Ring', ring, 'Six-membered ring of delocalized pi electrons.')

    return _dedupe(hits)


# ---------------------------------------------------------------------
# detect_named_scaffolds — coumarin / chromone / flavone
# ---------------------------------------------------------------------

def _find_ring_of_size(start_atom_id: str, ctx: Ctx, size: int) -> Optional[List[str]]:
    """Smallest-effort finder for a ring of exactly `size` heavy atoms
    through `start_atom_id`, walking ANY bond (aromatic included) — a
    permissive counterpart to common.find_smallest_ring, which
    deliberately excludes aromatic bonds and so can never find a ring
    that (like a chromone's pyranone ring) is fused to an aromatic ring
    along one of its own edges."""
    for start_n in neighbors_of(start_atom_id, ctx):
        if start_n.atom['element'] == 'H':
            continue
        target = start_n.atom['id']
        queue: List[List[str]] = [[start_atom_id]]
        visited: Set[str] = {start_atom_id}
        qi = 0
        while qi < len(queue):
            path = queue[qi]
            qi += 1
            cur = path[-1]
            if len(path) >= size:
                continue
            for n in neighbors_of(cur, ctx):
                if n.atom['element'] == 'H':
                    continue
                if cur == start_atom_id and n.atom['id'] == target:
                    continue
                if n.atom['id'] == target and len(path) == size - 1:
                    return path + [target]
                if n.atom['id'] not in visited:
                    visited.add(n.atom['id'])
                    queue.append(path + [n.atom['id']])
    return None


def detect_named_scaffolds(atoms: List[Dict[str, Any]], bonds: List[Dict[str, Any]]) -> List[Hit]:
    ctx = build_context(atoms, bonds)
    by_id = {a['id']: a for a in atoms}
    hits: List[Hit] = []
    aromatic_rings = [set(r) for r in find_aromatic_rings(atoms, ctx, 6) if len(r) == 6]

    ring_oxygens = [
        a for a in atoms
        if a['element'] == 'O'
        and total_attached_h(a, ctx) == 0
        and len(single_bond_neighbors(a['id'], 'C', ctx)) == 2
    ]

    seen_cores: Set[frozenset] = set()

    for o_atom in ring_oxygens:
        ring = _find_ring_of_size(o_atom['id'], ctx, 6)
        if not ring:
            continue
        if any(by_id[rid]['element'] not in ('C', 'O') for rid in ring):
            continue
        if sum(1 for rid in ring if by_id[rid]['element'] == 'O') != 1:
            continue
        core_key = frozenset(ring)
        if core_key in seen_cores:
            continue

        # ring = [O1, C2, C3, C4, C4a, C8a] in walk order (C8a closes
        # back to O1). Find which ortho-fused aromatic ring, if any,
        # C4a/C8a belong to.
        o1, c2, c3, c4, c4a, c8a = ring
        fused_ring = next((ar for ar in aromatic_rings if c4a in ar and c8a in ar), None)
        if fused_ring is None:
            continue  # not benzo-fused — not a chromone/coumarin core

        c2_carbonyl = carbonyl_context(c2, ctx)
        c4_carbonyl = carbonyl_context(c4, ctx)
        c2c3_double = any(n.atom['id'] == c3 for n in neighbors_of(c2, ctx) if _bond_order(n.bond) == 2)
        c3c4_double = any(n.atom['id'] == c4 for n in neighbors_of(c3, ctx) if _bond_order(n.bond) == 2)

        if c2_carbonyl and c2_carbonyl.get('subtype') == 'lactone' and c3c4_double:
            seen_cores.add(core_key)
            _add(hits, 'coumarin', 'Coumarin (2H-chromen-2-one)', ring + list(fused_ring),
                 'Benzo-fused 6-membered lactone with the carbonyl next to the ring oxygen and a C3=C4 alkene — the 2H-chromen-2-one core.')
        elif c4_carbonyl and c4_carbonyl.get('hasHeteroSingle') is False and c2c3_double:
            seen_cores.add(core_key)
            # Flavone check: C2 (adjacent to ring O, part of the C2=C3
            # enone) bears an exocyclic aryl substituent.
            aryl_at_c2 = next(
                (n for n in neighbors_of(c2, ctx)
                 if n.atom['id'] not in ring and n.atom['element'] == 'C'
                 and _bond_order(n.bond) == 1 and is_aromatic_atom(n.atom['id'], ctx)),
                None,
            )
            aryl_at_c3 = next(
                (n for n in neighbors_of(c3, ctx)
                 if n.atom['id'] not in ring and n.atom['element'] == 'C'
                 and _bond_order(n.bond) == 1 and is_aromatic_atom(n.atom['id'], ctx)),
                None,
            )
            if aryl_at_c2:
                _add(hits, 'flavone', 'Flavone (2-phenylchromen-4-one)', ring + list(fused_ring) + [aryl_at_c2.atom['id']],
                     'A chromone (4H-chromen-4-one) bearing an aryl group at C2 — the flavone core common to many plant pigments/flavonoids.')
            elif aryl_at_c3:
                _add(hits, 'isoflavone', 'Isoflavone (3-phenylchromen-4-one)', ring + list(fused_ring) + [aryl_at_c3.atom['id']],
                     'A chromone bearing an aryl group at C3 rather than C2 — the isoflavone core.')
            else:
                _add(hits, 'chromone', 'Chromone (4H-chromen-4-one)', ring + list(fused_ring),
                     'Benzo-fused 6-membered ring with the carbonyl at C4 (away from the ring oxygen) and a C2=C3 alkene.')

    return _dedupe(hits)