"""'Autocorrect' for a drawn structure — a ChemDraw-style "Clean Up
Structure" command. It never touches connectivity: atom identities,
elements, charges, lone pairs, and every bond's endpoints/order/style are
left exactly as drawn. All it recomputes is x/y — so however messy the
angles, overlaps, or squished ring shapes are, running this re-lays the
*same* molecule out with standard bond lengths, regular polygon rings
(including fused/spiro/bridged ring systems), and a natural zig-zag chain
look for everything else.

Ported line-for-line from frontend/src/lib/structureCleanup.js (deleted).
Every exported function there was only ever called from DrawLabPage's
Autocorrect flow (already an async, discretely-triggered action — never
live/per-drag), so this port has no debounce/latency implications the way
the /api/structure/analyze functions in formula.py do.

Verified against the original JS across hundreds of randomly generated
graphs (trees, branches, fused/spiro/bridged multi-ring systems) —
coordinates match to floating-point tolerance.
"""

from __future__ import annotations

import math
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

Atom = Dict[str, Any]
Bond = Dict[str, Any]
Point = Dict[str, float]

BOND_LENGTH = 46.0  # matches ringTemplates.js / smiles_parser.py
RING_GAP = 60.0  # horizontal gap between separate molecule fragments
MIN_SEPARATION = 22.0  # minimum allowed distance between unbonded atoms


def _edge_key(a: str, b: str) -> str:
    return f'{a}|{b}' if a < b else f'{b}|{a}'


def _to_deg(rad: float) -> float:
    return rad * 180 / math.pi


def _to_rad(deg: float) -> float:
    return deg * math.pi / 180


def _regular_polygon_offsets(size: int) -> List[Point]:
    r = BOND_LENGTH / (2 * math.sin(math.pi / size))
    offsets = []
    for i in range(size):
        angle = -math.pi / 2 + i * (2 * math.pi / size)
        offsets.append({'dx': r * math.cos(angle), 'dy': r * math.sin(angle)})
    return offsets


def _centroid(points: List[Point]) -> Point:
    n = len(points) or 1
    sx = sum(p['x'] for p in points)
    sy = sum(p['y'] for p in points)
    return {'x': sx / n, 'y': sy / n}


def _bbox(points: List[Point]) -> Dict[str, float]:
    xs = [p['x'] for p in points]
    ys = [p['y'] for p in points]
    return {'minX': min(xs), 'maxX': max(xs), 'minY': min(ys), 'maxY': max(ys)}


def _split_components(atoms: List[Atom], bonds: List[Bond]) -> List[Dict[str, Any]]:
    """Splits the graph into connected components, each with its own
    atom-id list and the bonds that lie fully inside it."""
    atom_ids = [a['id'] for a in atoms]
    parent = {aid: aid for aid in atom_ids}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    valid_bonds = [b for b in bonds if b.get('from') in parent and b.get('to') in parent]
    for b in valid_bonds:
        union(b['from'], b['to'])

    groups: Dict[str, List[str]] = {}
    for aid in atom_ids:
        root = find(aid)
        groups.setdefault(root, []).append(aid)

    result = []
    for ids in groups.values():
        id_set = set(ids)
        edges = [b for b in valid_bonds if b['from'] in id_set and b['to'] in id_set]
        result.append({'atomIds': ids, 'edges': edges})
    return result


def _build_adjacency(atom_ids: List[str], edges: List[Bond]) -> Dict[str, List[Dict[str, str]]]:
    adj: Dict[str, List[Dict[str, str]]] = {aid: [] for aid in atom_ids}
    for e in edges:
        adj[e['from']].append({'to': e['to'], 'bondId': e['id']})
        adj[e['to']].append({'to': e['from'], 'bondId': e['id']})
    return adj


def _shortest_path_excluding(adj, start: str, end: str, exclude_bond_id: str) -> Optional[List[str]]:
    """Shortest path from start to end that doesn't use the given bond."""
    queue = deque([start])
    visited = {start}
    parent: Dict[str, str] = {}
    while queue:
        cur = queue.popleft()
        if cur == end:
            break
        for n in adj.get(cur, []):
            if n['bondId'] == exclude_bond_id:
                continue
            if n['to'] in visited:
                continue
            visited.add(n['to'])
            parent[n['to']] = cur
            queue.append(n['to'])
    if end not in visited:
        return None
    path = [end]
    cur = end
    while cur != start:
        cur = parent[cur]
        path.append(cur)
    path.reverse()
    return path


def _find_rings(atom_ids: List[str], edges: List[Bond], adj) -> List[List[str]]:
    """Best-effort 'smallest set of smallest rings': for every bond, find
    the shortest cycle it closes, dedupe by atom set, then greedily keep
    the smallest rings until every ring bond is covered by at least one
    chosen ring (target ring count = edges - atoms + 1)."""
    target_count = max(0, len(edges) - len(atom_ids) + 1)
    if target_count == 0:
        return []

    candidates = []
    seen = set()
    for e in edges:
        path = _shortest_path_excluding(adj, e['from'], e['to'], e['id'])
        if not path or len(path) < 3:
            continue
        key = ','.join(sorted(path))
        if key in seen:
            continue
        seen.add(key)
        edge_keys = [_edge_key(path[i], path[(i + 1) % len(path)]) for i in range(len(path))]
        candidates.append({'atoms': path, 'edgeKeys': edge_keys, 'size': len(path)})
    candidates.sort(key=lambda c: c['size'])

    covered = set()
    chosen = []
    for c in candidates:
        if len(chosen) >= target_count:
            break
        adds_coverage = any(k not in covered for k in c['edgeKeys'])
        if adds_coverage:
            chosen.append(c)
            covered.update(c['edgeKeys'])
    return [c['atoms'] for c in chosen]


def _find_bridge_to_placed(ring: List[str], adj, placed: Dict[str, Point]) -> Optional[List[str]]:
    """Shortest path from any already-placed atom to some atom of `ring`,
    used to connect a ring that isn't directly fused/spiro to the
    already-placed structure."""
    ring_set = set(ring)
    queue = deque(placed.keys())
    visited = set(queue)
    parent: Dict[str, str] = {}
    while queue:
        cur = queue.popleft()
        if cur in ring_set and cur not in placed:
            path = [cur]
            p = cur
            while p in parent:
                p = parent[p]
                path.append(p)
            path.reverse()
            return path
        for n in adj.get(cur, []):
            if n['to'] in visited:
                continue
            visited.add(n['to'])
            parent[n['to']] = cur
            queue.append(n['to'])
    return None


def _order_rings(rings: List[List[str]]) -> List[List[str]]:
    """Orders rings so any ring sharing atoms with an already-scheduled
    ring comes right after it — walks a fused-ring system neighbor-by-
    neighbor instead of purely by size."""
    n = len(rings)
    used = [False] * n
    by_size = sorted(range(n), key=lambda i: len(rings[i]))
    ordered_idx: List[int] = []
    while len(ordered_idx) < n:
        next_idx = -1
        if ordered_idx:
            next_idx = next(
                (idx for idx in by_size if not used[idx] and any(
                    any(a in rings[idx] for a in rings[oi]) for oi in ordered_idx
                )),
                -1,
            )
        if next_idx == -1:
            next_idx = next(idx for idx in by_size if not used[idx])
        used[next_idx] = True
        ordered_idx.append(next_idx)
    return [rings[i] for i in ordered_idx]


def _layout_component(atom_ids: List[str], edges: List[Bond]) -> Dict[str, Point]:
    """Lays out one connected component in its own local coordinate space."""
    adj = _build_adjacency(atom_ids, edges)
    placed: Dict[str, Point] = {}
    arrival_angle: Dict[str, float] = {}
    flip_state: Dict[str, bool] = {}

    rings = _order_rings(_find_rings(atom_ids, edges, adj))

    def place_ring(ring: List[str]) -> None:
        already = [aid for aid in ring if aid in placed]
        template = _regular_polygon_offsets(len(ring))

        if not already and placed:
            bridge = _find_bridge_to_placed(ring, adj, placed)
            if bridge and len(bridge) >= 2:
                prev_pos = placed[bridge[0]]
                gc = _centroid(list(placed.values()))
                dir_x = prev_pos['x'] - gc['x']
                dir_y = prev_pos['y'] - gc['y']
                dlen = math.hypot(dir_x, dir_y)
                if dlen < 1e-6:
                    dir_x, dir_y = 1.0, 0.0
                else:
                    dir_x /= dlen
                    dir_y /= dlen
                for k in range(1, len(bridge)):
                    pos = {'x': prev_pos['x'] + dir_x * BOND_LENGTH, 'y': prev_pos['y'] + dir_y * BOND_LENGTH}
                    placed[bridge[k]] = pos
                    prev_pos = pos
                already[:] = [aid for aid in ring if aid in placed]

        if not already:
            if placed:
                base = {'x': max(p['x'] for p in placed.values()) + BOND_LENGTH * 2, 'y': 0.0}
            else:
                base = {'x': 0.0, 'y': 0.0}
            for i, aid in enumerate(ring):
                placed[aid] = {'x': base['x'] + template[i]['dx'], 'y': base['y'] + template[i]['dy']}
            return

        anchor_idx = -1
        for i in range(len(ring)):
            a, b = ring[i], ring[(i + 1) % len(ring)]
            if a in placed and b in placed:
                anchor_idx = i
                break

        if anchor_idx != -1:
            u, v = ring[anchor_idx], ring[(anchor_idx + 1) % len(ring)]
            p1, p2 = placed[u], placed[v]
            tu = template[anchor_idx]
            tv = template[(anchor_idx + 1) % len(ring)]
            template_edge_angle = math.atan2(tv['dy'] - tu['dy'], tv['dx'] - tu['dx'])
            world_edge_angle = math.atan2(p2['y'] - p1['y'], p2['x'] - p1['x'])
            global_centroid = _centroid(list(placed.values()))

            def transform_all(reflect: bool) -> List[Point]:
                result = []
                for i in range(len(ring)):
                    rel = {'x': template[i]['dx'] - tu['dx'], 'y': template[i]['dy'] - tu['dy']}
                    cx = rel['x'] * math.cos(-template_edge_angle) - rel['y'] * math.sin(-template_edge_angle)
                    cy = rel['x'] * math.sin(-template_edge_angle) + rel['y'] * math.cos(-template_edge_angle)
                    if reflect:
                        cy = -cy
                    wx = cx * math.cos(world_edge_angle) - cy * math.sin(world_edge_angle)
                    wy = cx * math.sin(world_edge_angle) + cy * math.cos(world_edge_angle)
                    result.append({'x': p1['x'] + wx, 'y': p1['y'] + wy})
                return result

            opt_a = transform_all(False)
            opt_b = transform_all(True)
            new_idxs = [i for i, aid in enumerate(ring) if aid not in placed]

            def avg_dist(opt: List[Point]) -> float:
                if not new_idxs:
                    return 0.0
                c = _centroid([opt[i] for i in new_idxs])
                return math.hypot(c['x'] - global_centroid['x'], c['y'] - global_centroid['y'])

            chosen = opt_a if avg_dist(opt_a) >= avg_dist(opt_b) else opt_b
            for i, aid in enumerate(ring):
                if aid not in placed:
                    placed[aid] = chosen[i]
            return

        anchor = already[0]
        idx = ring.index(anchor)
        p0 = placed[anchor]
        global_centroid = _centroid(list(placed.values()))
        out_x = p0['x'] - global_centroid['x']
        out_y = p0['y'] - global_centroid['y']
        length = math.hypot(out_x, out_y)
        if length < 1e-6:
            out_x, out_y = 1.0, 0.0
        else:
            out_x /= length
            out_y /= length
        r = BOND_LENGTH / (2 * math.sin(math.pi / len(ring)))
        center = {'x': p0['x'] + out_x * r, 'y': p0['y'] + out_y * r}
        desired_offset_angle = math.atan2(p0['y'] - center['y'], p0['x'] - center['x'])
        template_offset_angle = math.atan2(template[idx]['dy'], template[idx]['dx'])
        rotation = desired_offset_angle - template_offset_angle
        for i, aid in enumerate(ring):
            if aid in placed:
                continue
            dx, dy = template[i]['dx'], template[i]['dy']
            rx = dx * math.cos(rotation) - dy * math.sin(rotation)
            ry = dx * math.sin(rotation) + dy * math.cos(rotation)
            placed[aid] = {'x': center['x'] + rx, 'y': center['y'] + ry}

    for ring in rings:
        place_ring(ring)

    if not placed:
        def degree(aid: str) -> int:
            return len(adj.get(aid, []))

        root = atom_ids[0]
        leaf = next((aid for aid in atom_ids if degree(aid) == 1), None)
        if leaf:
            root = leaf
        else:
            best = -1
            for aid in atom_ids:
                d = degree(aid)
                if d > best:
                    best = d
                    root = aid
        placed[root] = {'x': 0.0, 'y': 0.0}

    queue: deque = deque(placed.keys())
    visited = set(queue)

    def largest_gap(angles_deg: List[float]) -> Dict[str, float]:
        if not angles_deg:
            return {'start': 0.0, 'size': 360.0}
        sorted_a = sorted(angles_deg)
        best = {'start': sorted_a[0], 'size': 0.0}
        for i in range(len(sorted_a)):
            a = sorted_a[i]
            b = sorted_a[(i + 1) % len(sorted_a)]
            size = ((b - a + 360) % 360) or 360
            if size > best['size']:
                best = {'start': a, 'size': size}
        return best

    while queue:
        aid = queue.popleft()
        pos = placed[aid]
        children = [n['to'] for n in adj.get(aid, []) if n['to'] not in visited]
        if not children:
            continue

        occupied = [
            _to_deg(math.atan2(placed[n['to']]['y'] - pos['y'], placed[n['to']]['x'] - pos['x']))
            for n in adj.get(aid, [])
            if n['to'] in placed and n['to'] != aid
        ]

        if len(occupied) <= 1 and len(children) == 1:
            base = occupied[0] + 180 if occupied else arrival_angle.get(aid, 0.0) + 180
            flip = flip_state.get(aid, True)
            angle = base + (58 if flip else -58)
            rad = _to_rad(angle)
            child = children[0]
            placed[child] = {'x': pos['x'] + BOND_LENGTH * math.cos(rad), 'y': pos['y'] + BOND_LENGTH * math.sin(rad)}
            arrival_angle[child] = angle
            flip_state[child] = not flip
            visited.add(child)
            queue.append(child)
        else:
            gap = largest_gap(occupied if occupied else [arrival_angle.get(aid, 0.0)])
            n = len(children)
            for k, child in enumerate(children):
                angle = gap['start'] + (gap['size'] * (k + 1)) / (n + 1)
                rad = _to_rad(angle)
                placed[child] = {'x': pos['x'] + BOND_LENGTH * math.cos(rad), 'y': pos['y'] + BOND_LENGTH * math.sin(rad)}
                arrival_angle[child] = angle
                flip_state[child] = (k % 2 == 0)
                visited.add(child)
                queue.append(child)

    for i, aid in enumerate(atom_ids):
        if aid not in placed:
            placed[aid] = {'x': i * BOND_LENGTH, 'y': 0.0}

    for _ in range(150):
        max_err = 0.0
        for e in edges:
            p1, p2 = placed.get(e['from']), placed.get(e['to'])
            if not p1 or not p2:
                continue
            dx, dy = p2['x'] - p1['x'], p2['y'] - p1['y']
            dist = math.hypot(dx, dy) or 0.0001
            diff = (dist - BOND_LENGTH) / dist
            max_err = max(max_err, abs(dist - BOND_LENGTH))
            off_x, off_y = dx * diff * 0.5, dy * diff * 0.5
            placed[e['from']] = {'x': p1['x'] + off_x, 'y': p1['y'] + off_y}
            placed[e['to']] = {'x': p2['x'] - off_x, 'y': p2['y'] - off_y}
        if max_err < 0.25:
            break

    bonded_pairs = {_edge_key(e['from'], e['to']) for e in edges}
    for i in range(len(atom_ids)):
        for j in range(i + 1, len(atom_ids)):
            a, b = atom_ids[i], atom_ids[j]
            if _edge_key(a, b) in bonded_pairs:
                continue
            pa, pb = placed[a], placed[b]
            dx, dy = pb['x'] - pa['x'], pb['y'] - pa['y']
            dist = math.hypot(dx, dy)
            if MIN_SEPARATION > dist > 0.001:
                push = (MIN_SEPARATION - dist) / 2
                ux, uy = dx / dist, dy / dist
                placed[a] = {'x': pa['x'] - ux * push, 'y': pa['y'] - uy * push}
                placed[b] = {'x': pb['x'] + ux * push, 'y': pb['y'] + uy * push}
            elif dist <= 0.001:
                placed[b] = {'x': pb['x'] + MIN_SEPARATION, 'y': pb['y']}

    return placed


def autocorrect_structure(atoms: List[Atom], bonds: List[Bond]) -> Dict[str, Any]:
    """Recomputes clean 2D coordinates for the whole molecule from its
    existing connectivity. Only x/y move. Disconnected fragments are laid
    out independently and arranged side by side."""
    if not atoms:
        return {'atoms': atoms, 'bonds': bonds}

    components = _split_components(atoms, bonds)
    positioned: Dict[str, Point] = {}
    cursor_x = 0.0

    for comp in components:
        local = _layout_component(comp['atomIds'], comp['edges'])
        box = _bbox(list(local.values()))
        width = box['maxX'] - box['minX']
        center_y = (box['minY'] + box['maxY']) / 2
        shift_x = cursor_x - box['minX']
        for aid in comp['atomIds']:
            p = local[aid]
            positioned[aid] = {'x': p['x'] + shift_x, 'y': p['y'] - center_y}
        cursor_x += width + RING_GAP

    overall = _bbox(list(positioned.values()))
    dx = 300 - (overall['minX'] + overall['maxX']) / 2
    dy = 220 - (overall['minY'] + overall['maxY']) / 2

    next_atoms = []
    for a in atoms:
        p = positioned.get(a['id'])
        if not p:
            next_atoms.append(a)
        else:
            next_atoms.append({**a, 'x': p['x'] + dx, 'y': p['y'] + dy})

    return {'atoms': next_atoms, 'bonds': bonds}


def apply_tetrahedral_wedges(atoms: List[Atom], bonds: List[Bond]) -> List[Bond]:
    """Standard textbook convention for a genuine tetrahedral 'hub' atom —
    one with exactly four plain single bonds, every one to a terminal
    (degree-1) atom. Two of its four bonds become one wedge and one dash;
    the other two stay plain lines. Run after autocorrect_structure so the
    angles measured are the clean ones."""
    pos_by_id = {a['id']: a for a in atoms}
    degree_map: Dict[str, int] = {}
    for b in bonds:
        degree_map[b['from']] = degree_map.get(b['from'], 0) + 1
        degree_map[b['to']] = degree_map.get(b['to'], 0) + 1

    def neighbors_of(aid: str) -> List[Dict[str, Any]]:
        return [
            {'bond': b, 'otherId': b['to'] if b['from'] == aid else b['from']}
            for b in bonds if b['from'] == aid or b['to'] == aid
        ]

    next_bonds = [dict(b) for b in bonds]
    bond_by_id = {b['id']: b for b in next_bonds}

    for atom in atoms:
        if degree_map.get(atom['id'], 0) != 4:
            continue
        nbrs = neighbors_of(atom['id'])
        if len(nbrs) != 4:
            continue
        all_terminal = all(degree_map.get(n['otherId'], 0) == 1 for n in nbrs)
        all_plain_single = all(
            n['bond'].get('order') == 1 and (not n['bond'].get('style') or n['bond']['style'] == 'none')
            and not n['bond'].get('aromatic')
            for n in nbrs
        )
        if not all_terminal or not all_plain_single:
            continue

        center = pos_by_id[atom['id']]
        with_angle = sorted(
            (
                {**n, 'angle': math.atan2(pos_by_id[n['otherId']]['y'] - center['y'], pos_by_id[n['otherId']]['x'] - center['x'])}
                for n in nbrs
            ),
            key=lambda n: n['angle'],
        )

        base = with_angle[0]['angle']
        dash_idx = 1
        best_diff = -1.0
        for i in range(1, len(with_angle)):
            diff = abs(((with_angle[i]['angle'] - base + math.pi * 3) % (math.pi * 2)) - math.pi)
            if best_diff == -1 or diff < best_diff:
                best_diff = diff
                dash_idx = i

        wedge_bond = bond_by_id[with_angle[0]['bond']['id']]
        dash_bond = bond_by_id[with_angle[dash_idx]['bond']['id']]
        # The narrow end belongs at the stereocenter.
        if wedge_bond['to'] == atom['id']:
            wedge_bond['from'], wedge_bond['to'] = wedge_bond['to'], wedge_bond['from']
        if dash_bond['to'] == atom['id']:
            dash_bond['from'], dash_bond['to'] = dash_bond['to'], dash_bond['from']
        wedge_bond['style'] = 'wedge'
        dash_bond['style'] = 'dash'

    return next_bonds


def _generate_next_id(existing: List[Dict[str, Any]], prefix: str) -> str:
    ids = {x['id'] for x in existing}
    i = len(existing)
    id_ = f'{prefix}{i}'
    while id_ in ids:
        i += 1
        id_ = f'{prefix}{i}'
    return id_


def remap_structure_ids(
    new_atoms: List[Atom], new_bonds: List[Bond], existing_atoms: List[Atom], existing_bonds: List[Bond]
) -> Dict[str, Any]:
    """Renumbers a freshly-parsed fragment's atom/bond ids so they can't
    collide with whatever's already on the canvas."""
    id_map: Dict[str, str] = {}
    running_atoms = list(existing_atoms)
    for a in new_atoms:
        new_id = _generate_next_id(running_atoms, 'a')
        id_map[a['id']] = new_id
        running_atoms.append({'id': new_id})

    running_bonds = list(existing_bonds)
    bond_id_map: Dict[str, str] = {}
    for b in new_bonds:
        new_id = _generate_next_id(running_bonds, 'b')
        bond_id_map[b['id']] = new_id
        running_bonds.append({'id': new_id})

    remapped_atoms = [{**a, 'id': id_map[a['id']]} for a in new_atoms]
    remapped_bonds = [
        {
            **b,
            'id': bond_id_map[b['id']],
            'from': id_map.get(b['from'], b['from']),
            'to': id_map.get(b['to'], b['to']),
        }
        for b in new_bonds
    ]
    return {'atoms': remapped_atoms, 'bonds': remapped_bonds}


def recenter_structure(atoms: List[Atom], target_center: Point) -> List[Atom]:
    """Positions a freshly generated fragment (already laid out by
    autocorrect_structure, so it's centered near (300,220)) so its
    centroid lands at `target_center` instead."""
    if not atoms:
        return atoms
    box = _bbox([{'x': a['x'], 'y': a['y']} for a in atoms])
    cur_center_x = (box['minX'] + box['maxX']) / 2
    cur_center_y = (box['minY'] + box['maxY']) / 2
    dx = target_center['x'] - cur_center_x
    dy = target_center['y'] - cur_center_y
    return [{**a, 'x': a['x'] + dx, 'y': a['y'] + dy} for a in atoms]


def expand_isolated_atom_hydrogens(atoms: List[Atom], bonds: List[Bond]) -> Dict[str, Any]:
    """A SMILES parse (and this app's library data) follows the normal
    skeletal convention — implicit hydrogens aren't drawn as atoms. That's
    right for anything with at least one explicit heavy-atom bond, but a
    'hydride'-type molecule whose *entire* structure is implicit hydrogens
    (methane, ammonia, water) parses down to a single bare, unbonded atom.
    This expands hydrogens only for atoms that end up with zero explicit
    bonds. Run before autocorrect_structure. Uses app.formula.element_info
    for each atom's typical valence — same table lib/elements.js's
    elementInfo used, so the H counts this produces are unchanged."""
    from .formula import element_info

    bond_count: Dict[str, int] = {}
    for b in bonds:
        bond_count[b['from']] = bond_count.get(b['from'], 0) + 1
        bond_count[b['to']] = bond_count.get(b['to'], 0) + 1

    next_atoms = list(atoms)
    next_bonds = list(bonds)

    for atom in atoms:
        if atom['element'] == 'H':
            continue
        if bond_count.get(atom['id']):
            continue
        h_count = element_info(atom['element'])['valence'] or 0
        if h_count <= 0:
            continue
        for k in range(h_count):
            angle = (k * 2 * math.pi) / h_count
            h_id = _generate_next_id(next_atoms, 'a')
            next_atoms.append({
                'id': h_id, 'element': 'H',
                'x': atom['x'] + BOND_LENGTH * math.cos(angle),
                'y': atom['y'] + BOND_LENGTH * math.sin(angle),
                'charge': 0, 'lonePairs': 0,
            })
            b_id = _generate_next_id(next_bonds, 'b')
            next_bonds.append({'id': b_id, 'from': atom['id'], 'to': h_id, 'order': 1, 'aromatic': False, 'style': 'none'})

    return {'atoms': next_atoms, 'bonds': next_bonds}