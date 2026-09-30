"""Names the conformer / shape of a 3-D structure from its geometry alone.

Input is what `symmetry_engine.parse_structure` returns (atoms with "el" and "p", plus a bond
list). Output is None when nothing recognisable is found, otherwise

    {"name": "Staggered", "detail": "H-C-C-H dihedral 60 deg"}

Only things that can be read off the coordinates reliably are named:

  * metallocenes / sandwich complexes     -> Eclipsed | Staggered | Twisted
  * single-metal coordination geometry    -> Tetrahedral, Square planar, Trigonal bipyramidal,
                                             Square pyramidal, Octahedral, Trigonal prismatic ...
  * one isolated six-membered ring        -> Chair | Boat | Twist-boat | Half-chair | Envelope
  * one real rotor bond (ethane, butane)  -> Staggered | Eclipsed | Anti | Gauche | Skew ...

Anything else (several rotors, fused rings, ...) returns None rather than a guess.
"""
from __future__ import annotations

import math

import numpy as np

_METALS = {
    "Li", "Na", "K", "Rb", "Cs", "Be", "Mg", "Ca", "Sr", "Ba", "Al", "Ga", "In", "Sn", "Pb", "Bi",
    "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
    "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
    "La", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
}


# ---------------------------------------------------------------- helpers
def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-12 else v


def _angle(a: np.ndarray, b: np.ndarray) -> float:
    return math.degrees(math.acos(float(np.clip(np.dot(_unit(a), _unit(b)), -1.0, 1.0))))


def _dihedral(p0, p1, p2, p3) -> float:
    """Signed dihedral p0-p1-p2-p3 in degrees, range (-180, 180]."""
    b0, b1, b2 = p0 - p1, p2 - p1, p3 - p2
    b1 = _unit(b1)
    v = b0 - np.dot(b0, b1) * b1
    w = b2 - np.dot(b2, b1) * b1
    x = float(np.dot(v, w))
    y = float(np.dot(np.cross(b1, v), w))
    return math.degrees(math.atan2(y, x))


def _plane_normal(pts: np.ndarray) -> np.ndarray:
    c = pts - pts.mean(axis=0)
    return np.linalg.svd(c)[2][-1]


def _in_ring(adj: dict[int, set[int]], a: int, b: int) -> bool:
    """True if the bond a-b lies on a cycle (a and b stay connected without it)."""
    seen, stack = {a}, [a]
    while stack:
        cur = stack.pop()
        for nb in adj[cur]:
            if cur == a and nb == b:
                continue
            if nb == b:
                return True
            if nb not in seen:
                seen.add(nb)
                stack.append(nb)
    return False


# ---------------------------------------------------------------- metallocenes
def _carbon_rings_on_metal(adj, sym, m):
    """Groups of >=5 carbons bonded to metal m that are joined to each other (Cp, benzene, COT ...)."""
    cs = [i for i in adj[m] if sym[i] == "C"]
    groups, seen = [], set()
    for c in cs:
        if c in seen:
            continue
        comp, stack = {c}, [c]
        while stack:
            cur = stack.pop()
            for nb in adj[cur]:
                if nb in cs and nb not in comp:
                    comp.add(nb)
                    stack.append(nb)
        seen |= comp
        if len(comp) >= 5:
            groups.append(sorted(comp))
    return groups


def _metallocene(pos, adj, sym):
    for m in range(len(sym)):
        if sym[m] not in _METALS:
            continue
        rings = _carbon_rings_on_metal(adj, sym, m)
        if len(rings) != 2 or len(rings[0]) != len(rings[1]):
            continue
        n = len(rings[0])
        p1, p2 = pos[rings[0]], pos[rings[1]]
        n1, n2 = _plane_normal(p1), _plane_normal(p2)
        if np.dot(n1, n2) < 0:
            n2 = -n2
        if _angle(n1, n2) > 20:  # bent sandwich, not a parallel metallocene
            continue
        axis = _unit(n1 + n2)
        c1, c2 = p1.mean(axis=0), p2.mean(axis=0)
        # metal must sit between the two rings along the axis
        if not (np.dot(c1 - pos[m], axis) * np.dot(c2 - pos[m], axis) < 0):
            continue
        ref = _unit(np.cross(axis, [1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.cross(axis, [0.0, 1.0, 0.0]))
        ref2 = np.cross(axis, ref)

        def phases(pts, c):
            ang = []
            for q in pts:
                v = q - c
                v = v - np.dot(v, axis) * axis
                ang.append(math.atan2(float(np.dot(v, ref2)), float(np.dot(v, ref))))
            # circular mean with period 2*pi/n
            z = sum(complex(math.cos(n * a), math.sin(n * a)) for a in ang)
            return math.atan2(z.imag, z.real) / n  # in (-pi/n, pi/n]

        step = 2 * math.pi / n
        diff = (phases(p2, c2) - phases(p1, c1)) % step
        off = min(diff, step - diff)           # 0 .. step/2
        frac = off / (step / 2)                # 0 eclipsed .. 1 staggered
        deg = math.degrees(off)
        detail = f"{n}-membered rings rotated {deg:.0f}\u00b0 relative to each other (0\u00b0 = eclipsed, {180 / n:.0f}\u00b0 = staggered)"
        if frac < 0.15:
            return {"name": "Eclipsed", "detail": detail}
        if frac > 0.85:
            return {"name": "Staggered", "detail": detail}
        return {"name": "Twisted", "detail": detail}
    return None


# ---------------------------------------------------------------- coordination geometry
def _coordination(pos, adj, sym):
    metals = [i for i in range(len(sym)) if sym[i] in _METALS]
    if len(metals) != 1:
        return None
    m = metals[0]
    nbs = sorted(adj[m])
    cn = len(nbs)
    if cn not in (4, 5, 6):
        return None
    vecs = [pos[i] - pos[m] for i in nbs]
    angs = sorted((_angle(vecs[i], vecs[j]) for i in range(cn) for j in range(i + 1, cn)), reverse=True)
    n_trans = sum(1 for a in angs if a > 160)
    detail = f"{cn}-coordinate {sym[m]} centre, largest ligand-metal-ligand angles {angs[0]:.0f}\u00b0, {angs[1]:.0f}\u00b0"
    if cn == 4:
        if n_trans == 2:
            return {"name": "Square planar", "detail": detail}
        if n_trans == 1:
            return {"name": "Seesaw", "detail": detail}
        if angs[0] < 125 and angs[-1] > 95:
            return {"name": "Tetrahedral", "detail": detail}
        return {"name": "Distorted tetrahedral", "detail": detail}
    if cn == 5:
        beta, alpha = angs[0], angs[1]
        tau = (beta - alpha) / 60.0  # Addison tau-5: 1 = trigonal bipyramid, 0 = square pyramid
        if tau > 0.85:
            return {"name": "Trigonal bipyramidal", "detail": detail}
        if tau < 0.15:
            return {"name": "Square pyramidal", "detail": detail}
        return {"name": "Between trigonal bipyramidal and square pyramidal",
                "detail": f"{detail} (\u03c4\u2085 = {tau:.2f}; 1 = bipyramid, 0 = pyramid)"}
    if n_trans >= 3:
        return {"name": "Octahedral", "detail": detail}
    if n_trans == 0 and angs[0] < 150:
        return {"name": "Trigonal prismatic", "detail": detail}
    return {"name": "Distorted octahedral", "detail": detail}


# ---------------------------------------------------------------- six-membered rings
def _six_rings(adj, heavy):
    """Every simple 6-cycle among heavy atoms (each returned once, in ring order)."""
    rings, seen = [], set()
    for start in heavy:
        stack = [(start, [start])]
        while stack:
            cur, path = stack.pop()
            if len(path) == 6:
                if start in adj[cur]:
                    key = frozenset(path)
                    if key not in seen:
                        seen.add(key)
                        rings.append(path)
                continue
            for nb in adj[cur]:
                if nb in heavy and nb > start and nb not in path:
                    stack.append((nb, path + [nb]))
    return rings


def _six_ring(pos, adj, sym):
    heavy = {i for i in range(len(sym)) if sym[i] != "H"}
    if len(heavy) > 60:
        return None
    n_bonds = sum(1 for i in heavy for j in adj[i] if j in heavy and j > i)
    # connected components of the heavy-atom graph
    comps, left = 0, set(heavy)
    while left:
        comps += 1
        stack = [left.pop()]
        while stack:
            cur = stack.pop()
            for nb in adj[cur]:
                if nb in left:
                    left.discard(nb)
                    stack.append(nb)
    if n_bonds - len(heavy) + comps != 1:  # exactly one independent ring in the whole molecule
        return None
    rings = _six_rings(adj, heavy)
    if len(rings) != 1:
        return None
    ring = rings[0]
    r = pos[ring]
    # order around the ring already follows the cycle
    cen = r.mean(axis=0)
    idx = np.arange(6)
    rp = (r * np.sin(2 * np.pi * idx / 6)[:, None]).sum(axis=0)
    rpp = (r * np.cos(2 * np.pi * idx / 6)[:, None]).sum(axis=0)
    nrm = _unit(np.cross(rp, rpp))
    z = (r - cen) @ nrm
    q2c = math.sqrt(2 / 6) * float((z * np.cos(2 * np.pi * 2 * idx / 6)).sum())
    q2s = -math.sqrt(2 / 6) * float((z * np.sin(2 * np.pi * 2 * idx / 6)).sum())
    q3 = float((z * ((-1.0) ** idx)).sum()) / math.sqrt(6)
    q2 = math.hypot(q2c, q2s)
    big_q = math.hypot(q2, q3)
    if big_q < 0.15:
        return None  # flat (aromatic) ring: nothing to name
    theta = math.degrees(math.atan2(q2, q3))            # 0..180
    phi = math.degrees(math.atan2(q2s, q2c)) % 360.0
    pm = phi % 60.0
    pm = min(pm, 60.0 - pm)                             # 0 .. 30
    detail = f"Cremer-Pople puckering Q = {big_q:.2f} \u00c5, \u03b8 = {theta:.0f}\u00b0, \u03c6 = {phi:.0f}\u00b0"
    if theta <= 25 or theta >= 155:
        return {"name": "Chair", "detail": detail}
    if 75 <= theta <= 105:
        return {"name": "Boat" if pm <= 15 else "Twist-boat", "detail": detail}
    if 35 <= theta <= 65 or 115 <= theta <= 145:
        if pm <= 10:
            return {"name": "Envelope (sofa)", "detail": detail}
        if pm >= 20:
            return {"name": "Half-chair", "detail": detail}
    return {"name": "Distorted ring", "detail": detail}


# ---------------------------------------------------------------- one rotor bond
def _is_sp3_like(pos, adj, sym, i) -> bool:
    deg = len(adj[i])
    if deg == 4:
        return True
    if deg != 3:
        return False
    nb = sorted(adj[i])
    total = sum(_angle(pos[nb[a]] - pos[i], pos[nb[b]] - pos[i]) for a in range(3) for b in range(a + 1, 3))
    return total < 345.0  # planar (sp2) centres sum to ~360


def _trivial_end(adj, sym, x, y) -> bool:
    """x carries only identical terminal atoms besides y (CH3, CF3, NH2 ...)."""
    others = [o for o in adj[x] if o != y]
    return bool(others) and all(len(adj[o]) == 1 for o in others) and len({sym[o] for o in others}) == 1


def _single_rotor(pos, adj, sym):
    rotors = []
    for x in range(len(sym)):
        if sym[x] == "H" or sym[x] in _METALS:
            continue
        for y in adj[x]:
            if y <= x or sym[y] == "H" or sym[y] in _METALS:
                continue
            if len(adj[x]) < 3 or len(adj[y]) < 3:
                continue
            if not (_is_sp3_like(pos, adj, sym, x) and _is_sp3_like(pos, adj, sym, y)):
                continue
            if _in_ring(adj, x, y):
                continue
            tx, ty = _trivial_end(adj, sym, x, y), _trivial_end(adj, sym, y, x)
            if (tx or ty) and not (tx and ty):
                continue  # spinning a methyl on a bigger frame does not define a named conformer
            rotors.append((x, y))
    if len(rotors) != 1:
        return None
    x, y = rotors[0]
    a_side = sorted(o for o in adj[x] if o != y)
    b_side = sorted(o for o in adj[y] if o != x)

    def dih(a, b):
        return _dihedral(pos[a], pos[x], pos[y], pos[b])

    heavy_a = [a for a in a_side if sym[a] != "H"]
    heavy_b = [b for b in b_side if sym[b] != "H"]
    if len(heavy_a) == 1 and len(heavy_b) == 1:
        a, b = heavy_a[0], heavy_b[0]
        phi = abs(dih(a, b))
        detail = f"{sym[a]}\u2013{sym[x]}\u2013{sym[y]}\u2013{sym[b]} dihedral {phi:.0f}\u00b0"
        if phi >= 150:
            return {"name": "Anti (staggered)", "detail": detail}
        if phi >= 90:
            return {"name": "Anticlinal (partly eclipsed)", "detail": detail}
        if phi >= 30:
            return {"name": "Gauche (staggered)", "detail": detail}
        return {"name": "Syn (eclipsed)", "detail": detail}
    # general case: how far the two sets of substituents are from lining up
    t = min(abs(dih(a, b)) for a in a_side for b in b_side)
    t = min(t, 60.0)
    detail = f"{sym[x]}\u2013{sym[y]} torsion offset {t:.0f}\u00b0 (0\u00b0 = eclipsed, 60\u00b0 = staggered)"
    if t <= 15:
        return {"name": "Eclipsed", "detail": detail}
    if t >= 45:
        return {"name": "Staggered", "detail": detail}
    return {"name": "Skew", "detail": detail}


# ---------------------------------------------------------------- public
def name_conformer(parsed: dict) -> dict | None:
    """parsed = symmetry_engine.parse_structure(...). Never raises."""
    try:
        atoms = parsed["atoms"]
        if len(atoms) < 4:
            return None
        sym = [a["el"] for a in atoms]
        pos = np.array([a["p"] for a in atoms], dtype=float)
        adj: dict[int, set[int]] = {i: set() for i in range(len(atoms))}
        for b in parsed["bonds"]:
            i, j = int(b[0]), int(b[1])
            if i != j:
                adj[i].add(j)
                adj[j].add(i)
        for fn in (_metallocene, _coordination, _six_ring, _single_rotor):
            out = fn(pos, adj, sym)
            if out:
                return out
    except Exception:  # noqa: BLE001 -- naming is decoration, never a reason to fail a request
        return None
    return None