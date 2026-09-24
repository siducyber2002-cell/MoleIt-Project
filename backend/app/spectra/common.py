"""Shared structural-analysis helpers for the NMR and IR predictors.

Ported from frontend/src/lib/elements.js (the `elementInfo`/`bondOrderValue`/
`kekulizeAromaticBonds` subset those two predictors need) and the small
buildContext/neighborsOf/isMetal/implicitHCount/... block that
nmrPredictor.js and irPredictor.js each carried as an identical private
copy. Kept here once instead, since Python has no equivalent need for the
frontend's own "no imports, pass elementInfo/bondOrderValue in" dependency
injection trick (that existed so those two files stayed trivially testable
independent of the rest of the frontend bundle).

Atoms/bonds use the same plain-dict shape the rest of this app's
`structure_2d` JSON already uses: an atom is
`{id, element, x, y, charge}` and a bond is `{id, from, to, order, aromatic}`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

Atom = Dict[str, Any]
Bond = Dict[str, Any]

# ---------------------------------------------------------------------
# elements.js subset: only `category` (for isMetal) and `valence` (for
# implicit-H filling) are ever read by the two predictors, so only that
# subset is reproduced here rather than the full periodic-table/formula/
# color/radius data elements.js also carries for the Draw Lab UI.
# ---------------------------------------------------------------------

_RAW = [
    # (atomic number, symbol, valence)
    (1, 'H', 1), (2, 'He', 0),
    (3, 'Li', 1), (4, 'Be', 2), (5, 'B', 3), (6, 'C', 4), (7, 'N', 3), (8, 'O', 2),
    (9, 'F', 1), (10, 'Ne', 0), (11, 'Na', 1), (12, 'Mg', 2), (13, 'Al', 3), (14, 'Si', 4),
    (15, 'P', 3), (16, 'S', 2), (17, 'Cl', 1), (18, 'Ar', 0), (19, 'K', 1), (20, 'Ca', 2),
    (21, 'Sc', 3), (22, 'Ti', 4), (23, 'V', 3), (24, 'Cr', 3), (25, 'Mn', 2), (26, 'Fe', 2),
    (27, 'Co', 2), (28, 'Ni', 2), (29, 'Cu', 2), (30, 'Zn', 2), (31, 'Ga', 3), (32, 'Ge', 4),
    (33, 'As', 3), (34, 'Se', 2), (35, 'Br', 1), (36, 'Kr', 0), (37, 'Rb', 1), (38, 'Sr', 2),
    (39, 'Y', 3), (40, 'Zr', 4), (41, 'Nb', 3), (42, 'Mo', 3), (43, 'Tc', 3), (44, 'Ru', 3),
    (45, 'Rh', 3), (46, 'Pd', 2), (47, 'Ag', 1), (48, 'Cd', 2), (49, 'In', 3), (50, 'Sn', 4),
    (51, 'Sb', 3), (52, 'Te', 2), (53, 'I', 1), (54, 'Xe', 0), (55, 'Cs', 1), (56, 'Ba', 2),
    (57, 'La', 3), (58, 'Ce', 3), (59, 'Pr', 3), (60, 'Nd', 3), (61, 'Pm', 3), (62, 'Sm', 3),
    (63, 'Eu', 3), (64, 'Gd', 3), (65, 'Tb', 3), (66, 'Dy', 3), (67, 'Ho', 3), (68, 'Er', 3),
    (69, 'Tm', 3), (70, 'Yb', 3), (71, 'Lu', 3), (72, 'Hf', 4), (73, 'Ta', 5), (74, 'W', 4),
    (75, 'Re', 4), (76, 'Os', 4), (77, 'Ir', 3), (78, 'Pt', 2), (79, 'Au', 3), (80, 'Hg', 2),
    (81, 'Tl', 1), (82, 'Pb', 2), (83, 'Bi', 3), (84, 'Po', 2), (85, 'At', 1), (86, 'Rn', 0),
    (87, 'Fr', 1), (88, 'Ra', 2), (89, 'Ac', 3), (90, 'Th', 4), (91, 'Pa', 5), (92, 'U', 6),
    (93, 'Np', 5), (94, 'Pu', 4), (95, 'Am', 3), (96, 'Cm', 3), (97, 'Bk', 3), (98, 'Cf', 3),
    (99, 'Es', 3), (100, 'Fm', 3), (101, 'Md', 3), (102, 'No', 2), (103, 'Lr', 3), (104, 'Rf', 4),
    (105, 'Db', 5), (106, 'Sg', 6), (107, 'Bh', 7), (108, 'Hs', 8), (109, 'Mt', 4), (110, 'Ds', 4),
    (111, 'Rg', 3), (112, 'Cn', 2), (113, 'Nh', 3), (114, 'Fl', 4), (115, 'Mc', 3), (116, 'Lv', 2),
    (117, 'Ts', 1), (118, 'Og', 0),
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


_ELEMENTS: Dict[str, Dict[str, Any]] = {
    symbol: {'valence': valence, 'category': _category_of(z)} for (z, symbol, valence) in _RAW
}

METAL_CATEGORIES = {'alkali', 'alkaline', 'transition', 'posttransition', 'lanthanide', 'actinide'}


def element_info(symbol: str) -> Dict[str, Any]:
    return _ELEMENTS.get(symbol) or {'valence': 1, 'category': 'other'}


def is_bond_aromatic(bond: Bond) -> bool:
    return bool(bond.get('aromatic') or bond.get('style') == 'aromatic')


def bond_order_value(bond: Bond) -> float:
    """Mirrors elements.js's bondOrderValue: an aromatic-flagged bond is
    treated as order 1.5 regardless of whatever raw `order` happens to be
    stored, so implicit-H filling/valence math is correct across this
    app's two on-disk aromatic-ring conventions (alternating Kekulé
    orders, or a flattened order=1 with just the aromatic flag set)."""
    if is_bond_aromatic(bond):
        return 1.5
    return bond.get('order') or 1


def real_bond_order(bond: Bond, kekule_orders: Dict[str, int]) -> float:
    """`bond_order_value`, but using a resolved Kekulé order for an
    aromatic bond instead of the flat 1.5 approximation, for the
    implicit-H-counting contexts where that distinction actually matters
    (see `kekulize_aromatic_bonds`'s doc comment, just below)."""
    if is_bond_aromatic(bond):
        return kekule_orders.get(bond['id'], 1.5)
    return bond_order_value(bond)


# A hard cap on how many times the Kekulization backtracking search can
# recurse per molecule. The search is a legitimate bounded DFS (depth is
# capped by the number of candidate atoms, and pruning cuts off branches
# that can't beat the best found so far) so this should never be needed
# in practice for any real organic teaching molecule — but a prediction
# request hanging the server is a much worse failure mode than an
# extremely large, pathological structure getting a merely-suboptimal
# (rather than exhaustively-optimal) Kekulé resolution, so the cap exists
# purely as a defense-in-depth backstop.
_KEKULIZE_VISIT_CAP = 200_000


def kekulize_aromatic_bonds(atoms: List[Atom], bonds: List[Bond]) -> Dict[str, int]:
    """Resolves a concrete Kekulé single/double assignment for every
    aromatic-flagged bond, instead of the flat "1.5 per aromatic bond"
    approximation `bond_order_value` uses elsewhere. That flat
    approximation is fine for most purposes but is WRONG for implicit-H
    counting on a ring heteroatom: it can't tell a pyridine-type N
    (fills its last valence slot with a ring double bond, no H) apart
    from a pyrrole-type N (fills it with an implicit H instead, donating
    its lone pair to the ring aromaticity) — both look identical from
    flat connectivity alone. Ported from frontend/src/lib/elements.js's
    `kekulizeAromaticBonds`, which this app's own formula/valence-
    checking code was fixed to use for the same reason (previously
    computing pyrrole as C4H4N instead of the correct C4H5N). Returns a
    map from aromatic bond id to its resolved order (1 or 2); non-
    aromatic bonds aren't included."""
    by_id = {a['id']: a for a in atoms}
    aromatic_bonds = [b for b in bonds if is_bond_aromatic(b)]
    resolved: Dict[str, int] = {}
    if not aromatic_bonds:
        return resolved

    arom_by_atom: Dict[str, List[Bond]] = {}
    for b in aromatic_bonds:
        arom_by_atom.setdefault(b['from'], []).append(b)
        arom_by_atom.setdefault(b['to'], []).append(b)

    # A candidate "needs a double bond somewhere among its aromatic
    # bonds" if treating every one of its aromatic bonds as single
    # wouldn't yet fill its normal valence. This correctly excludes a
    # plain divalent heteroatom with two ring bonds (furan's O,
    # thiophene's S — already at valence 2, no room left) but can't yet
    # tell apart a pyridine-type vs. pyrrole-type trivalent ring N —
    # that ambiguity is resolved by the matching search below, not here.
    candidate: Set[str] = set()
    for atom_id, bonds_here in arom_by_atom.items():
        atom = by_id.get(atom_id)
        if not atom:
            continue
        info = element_info(atom['element'])
        charge = atom.get('charge') or 0
        non_arom_used = sum(
            bond_order_value(b) for b in bonds
            if not is_bond_aromatic(b) and (b['from'] == atom_id or b['to'] == atom_id)
        )
        single_sum = non_arom_used + len(bonds_here)
        allowed = info['valence'] + (1 if charge != 0 else 0)
        if single_sum < allowed:
            candidate.add(atom_id)

    candidate_edges = [b for b in aromatic_bonds if b['from'] in candidate and b['to'] in candidate]
    edges_by_atom: Dict[str, List[Bond]] = {}
    for b in candidate_edges:
        edges_by_atom.setdefault(b['from'], []).append(b)
        edges_by_atom.setdefault(b['to'], []).append(b)

    # Maximum (not perfect) matching — an odd-membered aromatic ring
    # (furan, pyrrole, imidazole...) can never pair off every candidate
    # atom, and whichever one is left unmatched is exactly the
    # lone-pair-donating heteroatom. Candidates are visited in
    # fewest-options-first order (fail-fast/MRV); for a carbon, "try to
    # match" is attempted before "leave it unmatched", but for a
    # heteroatom the order flips — so that among several equal-size
    # matchings, the search settles on the chemically normal one
    # (carbons paired off, ring heteroatoms left as lone-pair donors)
    # without having to special-case any specific element. A heteroatom
    # topologically forced into the matching (pyridine's N) still ends
    # up matched regardless of this preference, since leaving it out
    # would lower the achievable maximum and the search only keeps the
    # best score found.
    def sort_key(aid: str):
        d = len(edges_by_atom.get(aid, []))
        is_c = by_id.get(aid, {}).get('element') == 'C'
        return (d, 0 if is_c else 1)

    order = sorted(candidate, key=sort_key)

    matched: Set[str] = set()
    matched_bond_ids: Set[str] = set()
    # Track not just matching *size* but how many non-carbon atoms ended
    # up matched, as a tie-break — see the note below on why size alone
    # isn't enough to pin down a unique, chemically-correct answer.
    best = {'size': 0, 'bonds': set(), 'hetero_matched': 0}
    visits = [0]

    def hetero_matched_count() -> int:
        return sum(1 for aid in matched if by_id.get(aid, {}).get('element') != 'C')

    def search(idx: int) -> None:
        visits[0] += 1
        if visits[0] > _KEKULIZE_VISIT_CAP:
            return
        cur_size = len(matched)
        if cur_size >= best['size']:
            cur_hetero = hetero_matched_count()
            # Among matchings of the same (maximum) size, several
            # different choices of *which* atoms end up matched are often
            # possible — a plain "first maximum matching found" pick is
            # order-dependent on incidental bond-list ordering and isn't
            # guaranteed to prefer leaving a heteroatom unmatched just
            # from visiting carbons first (a carbon's first candidate
            # bond can easily be the one to a heteroatom neighbor). So
            # ties are broken explicitly and deterministically instead:
            # prefer whichever maximum matching leaves the *most*
            # non-carbon atoms unmatched, since an unmatched ring
            # heteroatom is exactly the chemically normal
            # lone-pair-donating case (pyrrole's N, furan's O...) that
            # this whole function exists to detect correctly.
            if cur_size > best['size'] or cur_hetero < best['hetero_matched']:
                best['size'] = cur_size
                best['bonds'] = set(matched_bond_ids)
                best['hetero_matched'] = cur_hetero
        if idx >= len(order):
            return
        upper_bound = cur_size + (len(order) - idx)
        if upper_bound < best['size']:
            return

        atom_id = order[idx]
        if atom_id in matched:
            search(idx + 1)
            return
        is_carbon = by_id.get(atom_id, {}).get('element') == 'C'
        options = [
            b for b in edges_by_atom.get(atom_id, [])
            if (b['to'] if b['from'] == atom_id else b['from']) not in matched
        ]

        def try_matching():
            for b in options:
                if visits[0] > _KEKULIZE_VISIT_CAP:
                    return
                other = b['to'] if b['from'] == atom_id else b['from']
                matched.add(atom_id)
                matched.add(other)
                matched_bond_ids.add(b['id'])
                search(idx + 1)
                matched.discard(atom_id)
                matched.discard(other)
                matched_bond_ids.discard(b['id'])

        def try_skipping():
            search(idx + 1)

        if is_carbon:
            try_matching()
            try_skipping()
        else:
            try_skipping()
            try_matching()

    search(0)

    for b in aromatic_bonds:
        resolved[b['id']] = 2 if b['id'] in best['bonds'] else 1
    return resolved


# ---------------------------------------------------------------------
# Graph context — identical to the private `buildContext`/`neighborsOf`/
# `isMetal`/`implicitHCount`/`totalAttachedH`/`hasDoubleBondTo`/
# `hasTripleBondTo`/`singleBondNeighbors`/`exocyclicHeteroSingleBondNeighbors`/
# `atomsShareRing` block duplicated at the top of both nmrPredictor.js and
# irPredictor.js.
# ---------------------------------------------------------------------


class Ctx:
    __slots__ = ('by_id', 'bonds_of', 'kekule_orders')

    def __init__(self, by_id: Dict[str, Atom], bonds_of: Dict[str, List[Bond]], kekule_orders: Dict[str, int]):
        self.by_id = by_id
        self.bonds_of = bonds_of
        self.kekule_orders = kekule_orders


def build_context(atoms: List[Atom], bonds: List[Bond]) -> Ctx:
    by_id = {a['id']: a for a in atoms}
    bonds_of: Dict[str, List[Bond]] = {a['id']: [] for a in atoms}
    for b in bonds:
        if b.get('from') in bonds_of:
            bonds_of[b['from']].append(b)
        if b.get('to') in bonds_of:
            bonds_of[b['to']].append(b)
    return Ctx(by_id, bonds_of, kekulize_aromatic_bonds(atoms, bonds))


class Neighbor:
    __slots__ = ('atom', 'bond')

    def __init__(self, atom: Atom, bond: Bond):
        self.atom = atom
        self.bond = bond


def neighbors_of(atom_id: str, ctx: Ctx) -> List[Neighbor]:
    result = []
    for b in ctx.bonds_of.get(atom_id, []):
        other_id = b['to'] if b.get('from') == atom_id else b.get('from')
        atom = ctx.by_id.get(other_id)
        if atom is not None:
            result.append(Neighbor(atom, b))
    return result


def is_metal(atom: Atom) -> bool:
    return element_info(atom['element'])['category'] in METAL_CATEGORIES


def implicit_h_count(atom: Atom, ctx: Ctx) -> int:
    """How many implicit hydrogens a non-H atom carries — same convention
    as computeFormula's neutral-atom case: only applies to neutral atoms,
    a charged atom is assumed already fully, explicitly drawn. Uses each
    aromatic bond's resolved Kekulé order (see `kekulize_aromatic_bonds`)
    rather than a flat 1.5 — needed to correctly distinguish a
    pyridine-type ring nitrogen (no implicit H) from a pyrrole-type one
    (needs an implicit N-H), which look identical without it."""
    if atom['element'] == 'H' or is_metal(atom):
        return 0
    if (atom.get('charge') or 0) != 0:
        return 0
    info = element_info(atom['element'])
    used = sum(real_bond_order(n.bond, ctx.kekule_orders) for n in neighbors_of(atom['id'], ctx))
    return max(0, info['valence'] - used)


def total_attached_h(atom: Atom, ctx: Ctx) -> int:
    """True attached-H count whether drawn explicitly (every PubChem-
    derived structure) or left implicit (hand-curated library entries,
    Draw Lab structures)."""
    explicit_h = sum(1 for n in neighbors_of(atom['id'], ctx) if n.atom['element'] == 'H')
    return explicit_h + implicit_h_count(atom, ctx)


def has_any_attached_h(atom: Atom, ctx: Ctx) -> bool:
    return total_attached_h(atom, ctx) > 0


def has_double_bond_to(atom_id: str, target_element: str, ctx: Ctx) -> bool:
    return any(n.atom['element'] == target_element and bond_order_value(n.bond) == 2 for n in neighbors_of(atom_id, ctx))


def has_triple_bond_to(atom_id: str, target_element: str, ctx: Ctx) -> bool:
    return any(n.atom['element'] == target_element and bond_order_value(n.bond) == 3 for n in neighbors_of(atom_id, ctx))


def single_bond_neighbors(atom_id: str, target_element: str, ctx: Ctx) -> List[Neighbor]:
    return [n for n in neighbors_of(atom_id, ctx) if n.atom['element'] == target_element and bond_order_value(n.bond) == 1]


def exocyclic_hetero_single_bond_neighbors(atom_id: str, target_element: str, ctx: Ctx) -> List[Neighbor]:
    """Excludes a ring heteroatom's own (formally-single, Kekulé-necessary)
    ring bonds from counting as a real exocyclic substituent — see the
    long comment on this function in the original nmrPredictor.js for why
    that distinction matters for ring-position classification."""
    return [
        n for n in neighbors_of(atom_id, ctx)
        if n.atom['element'] == target_element and bond_order_value(n.bond) == 1 and not is_bond_aromatic(n.bond)
    ]


def atoms_share_ring(atom_id_a: str, atom_id_b: str, ctx: Ctx, max_ring_size: int = 8) -> bool:
    """Whether two directly-bonded heavy atoms also have a second,
    independent path connecting them through the rest of the heavy-atom
    graph — i.e. whether that direct bond sits on a ring. Plain BFS from
    A, skipping the direct A-B bond on the first step."""
    queue = [(atom_id_a, 0)]
    visited: Set[str] = {atom_id_a}
    qi = 0
    while qi < len(queue):
        atom_id, depth = queue[qi]
        qi += 1
        if depth >= max_ring_size:
            continue
        for n in neighbors_of(atom_id, ctx):
            if n.atom['element'] == 'H':
                continue
            if atom_id == atom_id_a and n.atom['id'] == atom_id_b:
                continue
            if n.atom['id'] == atom_id_b:
                return True
            if n.atom['id'] not in visited:
                visited.add(n.atom['id'])
                queue.append((n.atom['id'], depth + 1))
    return False


def find_smallest_ring(atom_id: str, ctx: Ctx, max_size: int = 8) -> Optional[List[str]]:
    """The smallest ring (by atom count) that `atom_id` sits on, as an
    ordered list of atom ids starting and conceptually closing back on
    itself (ring[0] is `atom_id`; ring[1] and ring[-1] are its two
    ring-adjacent neighbors), or None if it's not on any non-aromatic ring
    up to `max_size`. Aromatic bonds are excluded from the walk — aromatic
    rings are handled by their own, dedicated logic elsewhere; this exists
    for classifying strained small (3-/4-membered) saturated rings
    (cyclopropane, epoxide, aziridine, cyclobutane, oxetane...), whose
    chemistry is distinct enough from both open-chain and 5/6-membered
    ring analogs to need their own shift ranges."""
    best: Optional[List[str]] = None
    for start_n in neighbors_of(atom_id, ctx):
        if start_n.atom['element'] == 'H' or is_metal(start_n.atom) or is_bond_aromatic(start_n.bond):
            continue
        target = start_n.atom['id']
        queue: List[Tuple[str, List[str]]] = [(atom_id, [atom_id])]
        visited: Set[str] = {atom_id}
        qi = 0
        found = None
        while qi < len(queue):
            cur, path = queue[qi]
            qi += 1
            if len(path) > max_size:
                continue
            for n in neighbors_of(cur, ctx):
                if n.atom['element'] == 'H' or is_metal(n.atom) or is_bond_aromatic(n.bond):
                    continue
                if cur == atom_id and n.atom['id'] == target:
                    continue  # skip the direct bond itself on the first step
                if n.atom['id'] == target:
                    found = path + [target]
                    break
                if n.atom['id'] not in visited:
                    visited.add(n.atom['id'])
                    queue.append((n.atom['id'], path + [n.atom['id']]))
            if found:
                break
        if found and (best is None or len(found) < len(best)):
            best = found
    return best


def find_rings_of_size(atoms: List[Atom], ctx: Ctx, size: int) -> List[List[str]]:
    """All simple rings of exactly `size` heavy atoms, walking *any* bond
    type (aromatic or not) — unlike `find_aromatic_rings` (aromatic bonds
    only) and `find_smallest_ring` (non-aromatic bonds only), neither of
    which can see a ring like a coumarin/chromone's pyranone ring: it's
    built from ordinary single/double bonds itself, but shares one edge
    with (and is typically drawn with that one shared edge flagged as)
    the aromatic benzo ring it's ortho-fused to. Small-molecule DFS,
    dedup'd by atom set, same approach as `find_aromatic_rings`."""
    heavy_ids = [a['id'] for a in atoms if a['element'] != 'H' and not is_metal(a)]

    def heavy_neighbor_ids(atom_id: str) -> List[str]:
        return [n.atom['id'] for n in neighbors_of(atom_id, ctx) if n.atom['element'] != 'H' and not is_metal(n.atom)]

    seen: Set[str] = set()
    rings: List[List[str]] = []

    def dfs(start: str, path: List[str], visited: set):
        last = path[-1]
        for nxt in heavy_neighbor_ids(last):
            if nxt == start and len(path) == size:
                key = ','.join(sorted(path))
                if key not in seen:
                    seen.add(key)
                    rings.append(list(path))
            elif nxt not in visited and len(path) < size:
                dfs(start, path + [nxt], visited | {nxt})

    for hid in heavy_ids:
        dfs(hid, [hid], {hid})
    return rings


def is_azide_attachment_nitrogen(atom: Atom, ctx: Ctx) -> bool:
    """Whether `atom` is the point-of-attachment nitrogen of an azide
    group (R-N=N=N / R-N3, whichever resonance/bond-order form it was
    drawn in). Detected purely by connectivity — this N has exactly one
    non-nitrogen heavy neighbor plus a chain of exactly two more
    nitrogens, the middle one otherwise bare and the terminal one
    otherwise bare too — rather than by matching a specific bond-order
    pattern, the same approach is_nitro_nitrogen uses for the same
    reason (a real structure might have the azide drawn in any of its
    resonance forms)."""
    if atom['element'] != 'N':
        return False
    heavy = [n for n in neighbors_of(atom['id'], ctx) if n.atom['element'] != 'H']
    n_nbrs = [n for n in heavy if n.atom['element'] == 'N']
    non_n_nbrs = [n for n in heavy if n.atom['element'] != 'N']
    if len(n_nbrs) != 1 or len(non_n_nbrs) != 1:
        return False
    n2 = n_nbrs[0].atom
    n2_heavy = [n for n in neighbors_of(n2['id'], ctx) if n.atom['element'] != 'H' and n.atom['id'] != atom['id']]
    n2_n_nbrs = [n for n in n2_heavy if n.atom['element'] == 'N']
    n2_other = [n for n in n2_heavy if n.atom['element'] != 'N']
    if len(n2_n_nbrs) != 1 or len(n2_other) != 0:
        return False
    n3 = n2_n_nbrs[0].atom
    n3_heavy = [n for n in neighbors_of(n3['id'], ctx) if n.atom['element'] != 'H' and n.atom['id'] != n2['id']]
    return len(n3_heavy) == 0


def stable_fraction_fnv(s: str) -> float:
    """FNV-1a-based deterministic [0,1) fraction — matches nmrPredictor.js's
    `stableFraction` exactly (32-bit arithmetic, Math.imul semantics)."""
    h = 2166136261
    for ch in s:
        h = h ^ ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return (h % 10000) / 10000


def stable_fraction_simple(s: str) -> float:
    """Matches irPredictor.js's own (different, simpler) `stableFraction`:
    hash = (hash * 31 + charCode) >>> 0."""
    h = 0
    for ch in s:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return (h % 10000) / 10000