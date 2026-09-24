"""Lightweight structural analysis over the atoms/bonds graph.

Ported from frontend/src/lib/graphAnalysis.js's `countRings` — deliberately
simple (no full SSSR ring-perception algorithm), but enough to give a
useful "how many rings does this molecule have" number. Used by
routers/structure.py (folded into the same /api/structure/analyze
response PropertiesPanel already polls) and by the Autocorrect compound
ranking in routers/compounds.py-adjacent logic (drawn ring count vs a
candidate's ring_count, to prefer the cyclic isomer a student clearly drew
over a chain isomer sharing the same formula).

Note: the frontend file also exported `atomsInRings` (DFS back-edge
detection, for optional ring highlighting) — nothing in the app actually
called it, so it wasn't ported; there's nothing to translate uplift for a
function with zero callers.
"""

from typing import Any, Dict, List

Atom = Dict[str, Any]
Bond = Dict[str, Any]


def count_rings(atoms: List[Atom], bonds: List[Bond]) -> int:
    """Independent ring count via the cyclomatic number:
    rings = edges - nodes + components. Exact for counting the number of
    independent cycles in a graph — what "degree of unsaturation from
    rings" ultimately reduces to."""
    if not atoms:
        return 0

    parent: Dict[str, str] = {a['id']: a['id'] for a in atoms}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    atom_ids = {a['id'] for a in atoms}
    edge_count = 0
    for b in bonds:
        if b.get('from') in atom_ids and b.get('to') in atom_ids:
            union(b['from'], b['to'])
            edge_count += 1

    component_roots = {find(a['id']) for a in atoms}
    rings = edge_count - len(atoms) + len(component_roots)
    return max(0, rings)