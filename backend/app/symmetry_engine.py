"""Pure-Python port of the point-group detection + representation-theory
engine. Ported 1:1 in logic from the reference molecular-symmetry tool:
- discover the real 3D symmetry operations of a structure by testing
  candidate axes/planes against the geometry (atom-permutation matching,
  tolerance-based),
- classify the resulting operation set into one of the 32 point groups
  (+ the two linear groups) from first principles (rotation orders found,
  presence of i / sigma_h / sigma_v / S_n), not from a lookup table,
- reduce the 3N Cartesian representation against the character table to
  get Gamma_3N -> Gamma_trans + Gamma_rot + Gamma_vib.
No third-party numerical libraries are used (pure math, 3x3 matrices only).
"""
import json
import math
import os
import re

TOL_DEFAULT = 0.08

with open(os.path.join(os.path.dirname(__file__), "symmetry_tables.json"), encoding="utf-8") as f:
    TABLES = json.load(f)

PG_MASS = {
    "H": 1.008, "C": 12.011, "N": 14.007, "O": 15.999, "F": 18.998, "Cl": 35.45,
    "Br": 79.904, "I": 126.904, "S": 32.06, "P": 30.974, "B": 10.81, "Si": 28.085,
    "Fe": 55.845, "Co": 58.933, "Ni": 58.693, "Cu": 63.546, "Zn": 65.38,
    "Pt": 195.084, "Xe": 131.293,
}

# Covalent radii (Angstrom, single-bond, Cordero et al.) used only to *infer*
# bonds when the input format carries none (bare XYZ has no connectivity at
# all — SDF/MOL bond blocks and PDB CONECT records are still read as-is and
# never overridden by this). Two atoms are bonded if their distance is under
# the sum of their radii plus BOND_TOLERANCE, which is generous enough to
# survive DFT-optimized geometries without inventing bonds between
# non-adjacent atoms.
COVALENT_RADIUS = {
    "H": 0.31, "He": 0.28, "Li": 1.28, "Be": 0.96, "B": 0.84, "C": 0.76,
    "N": 0.71, "O": 0.66, "F": 0.57, "Ne": 0.58, "Na": 1.66, "Mg": 1.41,
    "Al": 1.21, "Si": 1.11, "P": 1.07, "S": 1.05, "Cl": 1.02, "Ar": 1.06,
    "K": 2.03, "Ca": 1.76, "Fe": 1.32, "Co": 1.26, "Ni": 1.24, "Cu": 1.32,
    "Zn": 1.22, "Br": 1.20, "I": 1.39, "Xe": 1.40, "Pt": 1.36,
}
BOND_TOLERANCE = 0.40  # Angstrom, added to the summed covalent radii


def infer_bonds_by_distance(atoms):
    """Distance-based fallback connectivity for formats with no explicit
    bonds (plain XYZ). O(n^2) pairwise check — fine at molecule scale."""
    bonds = []
    n = len(atoms)
    for i in range(n):
        ri = COVALENT_RADIUS.get(atoms[i]["el"], 0.77)
        pi = atoms[i]["p"]
        for j in range(i + 1, n):
            rj = COVALENT_RADIUS.get(atoms[j]["el"], 0.77)
            pj = atoms[j]["p"]
            d = math.sqrt((pi[0] - pj[0]) ** 2 + (pi[1] - pj[1]) ** 2 + (pi[2] - pj[2]) ** 2)
            if d <= ri + rj + BOND_TOLERANCE:
                bonds.append([i, j])
    return bonds

PRETTY = {
    "C1": "C\u2081", "Cs": "Cs", "Ci": "Ci", "C2": "C\u2082",
    "C2v": "C\u2082\u1d65", "C3v": "C\u2083\u1d65", "C4v": "C\u2084\u1d65",
    "C5v": "C\u2085\u1d65", "C6v": "C\u2086\u1d65",
    "C2h": "C\u2082\u2095", "C3h": "C\u2083\u2095", "C4h": "C\u2084\u2095",
    "D2": "D\u2082", "D3": "D\u2083", "D4": "D\u2084", "D5": "D\u2085", "D6": "D\u2086",
    "D2h": "D\u2082\u2095", "D3h": "D\u2083\u2095", "D4h": "D\u2084\u2095",
    "D5h": "D\u2085\u2095", "D6h": "D\u2086\u2095",
    "D2d": "D\u2082d", "D3d": "D\u2083d", "D4d": "D\u2084d",
    "Td": "Td", "Th": "Th", "O": "O", "Oh": "O\u2095", "I": "I", "Ih": "I\u2095",
    "Dinfh": "D\u221e\u2095", "Cinfv": "C\u221e\u1d65",
}

# ---------------------------------------------------------------- matrices
def _nrm(v):
    l = math.hypot(v[0], v[1], v[2])
    if l < 1e-12:
        return [0.0, 0.0, 0.0]
    return [v[0] / l, v[1] / l, v[2] / l]

def _mul(A, B):
    return [[A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c] for c in range(3)] for r in range(3)]

def _app(M, p):
    return [M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2],
            M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2],
            M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2]]

I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
INV = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]]

def _transp(M):
    return [[M[r][c] for r in range(3)] for c in range(3)]

def _rotM(axis, t):
    n = _nrm(axis)
    x, y, z = n
    c, s, u = math.cos(t), math.sin(t), 1 - math.cos(t)
    return [[u * x * x + c, u * x * y - s * z, u * x * z + s * y],
            [u * x * y + s * z, u * y * y + c, u * y * z - s * x],
            [u * x * z - s * y, u * y * z + s * x, u * z * z + c]]

def _reflM(v):
    n = _nrm(v)
    x, y, z = n
    return [[1 - 2 * x * x, -2 * x * y, -2 * x * z],
            [-2 * x * y, 1 - 2 * y * y, -2 * y * z],
            [-2 * x * z, -2 * y * z, 1 - 2 * z * z]]

def _trace(M):
    return M[0][0] + M[1][1] + M[2][2]

def _det3(M):
    return (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
            - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
            + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]))

def _mkey(M):
    flat = [x for row in M for x in row]
    return ",".join("0" if abs(x) < 1e-8 else f"{x:.5f}" for x in flat)

# ------------------------------------------------------------- vector math
def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

def _len(a):
    return math.hypot(a[0], a[1], a[2])

def _add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

def _sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def _scale(a, s):
    return [a[0] * s, a[1] * s, a[2] * s]

def _norm(a):
    l = _len(a)
    if l < 1e-10:
        return None
    return _scale(a, 1 / l)

def _canonical(a):
    v = _norm(a)
    if v is None:
        return None
    for i in range(3):
        if abs(v[i]) > 1e-7:
            if v[i] < 0:
                v = _scale(v, -1)
            break
    return v

def _unique_dirs(arr):
    out = []
    for a in arr:
        v = _canonical(a)
        if v is None:
            continue
        if not any(abs(_dot(v, w)) > 0.9995 for w in out):
            out.append(v)
    return out

def _jacobi_sym(A):
    a = [row[:] for row in A]
    V = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    for _ in range(60):
        p, q, m = 0, 1, abs(a[0][1])
        for i in range(3):
            for j in range(i + 1, 3):
                if abs(a[i][j]) > m:
                    m, p, q = abs(a[i][j]), i, j
        if m < 1e-10:
            break
        phi = 0.5 * math.atan2(2 * a[p][q], a[q][q] - a[p][p])
        c, s = math.cos(phi), math.sin(phi)
        for k in range(3):
            apk, aqk = a[p][k], a[q][k]
            a[p][k] = c * apk - s * aqk
            a[q][k] = s * apk + c * aqk
        for k in range(3):
            akp, akq = a[k][p], a[k][q]
            a[k][p] = c * akp - s * akq
            a[k][q] = s * akp + c * akq
        for k in range(3):
            vkp, vkq = V[k][p], V[k][q]
            V[k][p] = c * vkp - s * vkq
            V[k][q] = s * vkp + c * vkq
    ev = [a[0][0], a[1][1], a[2][2]]
    ix = sorted(range(3), key=lambda i: ev[i])
    return {"values": [ev[i] for i in ix], "vectors": [[V[0][i], V[1][i], V[2][i]] for i in ix]}

def _center(atoms):
    sm, c = 0.0, [0.0, 0.0, 0.0]
    for a in atoms:
        m = PG_MASS.get(a["el"], 12)
        sm += m
        c = _add(c, _scale(a["p"], m))
    return _scale(c, 1 / sm) if sm else c

def normalize_mol(atoms):
    c = _center(atoms)
    a = [{"el": x["el"], "p": _sub(x["p"], c)} for x in atoms]
    rms = math.sqrt(sum(_dot(x["p"], x["p"]) for x in a) / max(1, len(a)))
    return {"atoms": a, "center": c, "scale": rms or 1}

# --------------------------------------------------------------- structure parsing
class SymmetryError(Exception):
    pass

def parse_structure(text):
    t = text.strip()
    if not t:
        raise SymmetryError("No structure was supplied.")
    lines = re.split(r"\r?\n", t)
    atoms, bonds = [], []

    counts_index, counts = -1, None
    for k in range(min(len(lines), 12)):
        line = lines[k] or ""
        if re.search(r"V(?:2000|3000)", line, re.I) and re.match(r"^\s*\d{1,4}\s+\d{1,4}\s+", line.strip()):
            z = line.strip().split()
            counts_index = k
            counts = {"n": int(z[0]), "nb": int(z[1]) if len(z) > 1 and z[1].isdigit() else 0,
                      "version": "V3000" if re.search(r"V3000", line, re.I) else "V2000"}
            break

    if counts_index >= 0:
        n, nb, version = counts["n"], counts["nb"], counts["version"]
        if version == "V2000":
            for i in range(counts_index + 1, min(counts_index + 1 + n, len(lines))):
                line = lines[i]
                try:
                    x, y, zz = float(line[0:10]), float(line[10:20]), float(line[20:30])
                except (ValueError, IndexError):
                    continue
                el_raw = line[31:34].strip() or (line.strip().split() + ["", "", "", ""])[3]
                m = re.match(r"^([A-Za-z]{1,2})", el_raw)
                el = m.group(1) if m else ""
                if el:
                    atoms.append({"el": el, "p": [x, y, zz]})
            for i in range(counts_index + 1 + n, min(counts_index + 1 + n + nb, len(lines))):
                line = lines[i]
                try:
                    a_idx, b_idx = int(line[0:3]) - 1, int(line[3:6]) - 1
                except (ValueError, IndexError):
                    continue
                if 0 <= a_idx < len(atoms) and 0 <= b_idx < len(atoms):
                    bonds.append([a_idx, b_idx])
        else:
            begin_atom = next((i for i, x in enumerate(lines) if re.search(r"M\s+V30\s+BEGIN\s+ATOM", x, re.I)), -1)
            end_atom = next((i for i, x in enumerate(lines) if re.search(r"M\s+V30\s+END\s+ATOM", x, re.I)), -1)
            begin_bond = next((i for i, x in enumerate(lines) if re.search(r"M\s+V30\s+BEGIN\s+BOND", x, re.I)), -1)
            end_bond = next((i for i, x in enumerate(lines) if re.search(r"M\s+V30\s+END\s+BOND", x, re.I)), -1)
            if begin_atom >= 0 and end_atom > begin_atom:
                for i in range(begin_atom + 1, end_atom):
                    z = re.sub(r"^.*M\s+V30\s+", "", lines[i]).strip().split()
                    if len(z) >= 5:
                        try:
                            x, y, zz = float(z[2]), float(z[3]), float(z[4])
                            atoms.append({"el": z[1], "p": [x, y, zz]})
                        except ValueError:
                            pass
            if begin_bond >= 0 and end_bond > begin_bond:
                for i in range(begin_bond + 1, end_bond):
                    z = re.sub(r"^.*M\s+V30\s+", "", lines[i]).strip().split()
                    if len(z) >= 4:
                        try:
                            bonds.append([int(z[2]) - 1, int(z[3]) - 1])
                        except ValueError:
                            pass
        if len(atoms) != n:
            raise SymmetryError(f"SDF counts line says {n} atoms, but only {len(atoms)} valid 3-D atom lines were found.")
    else:
        non_empty = [(i, x) for i, x in enumerate(lines) if x.strip()]
        first = non_empty[0][0] if non_empty else 0
        first_tok = (lines[first] if first < len(lines) else "").strip().split()
        first_tok = first_tok[0] if first_tok else ""
        if re.match(r"^\d+$", first_tok):
            n = int(first_tok)
            i = first + 2
            while i < len(lines) and len(atoms) < n:
                z = lines[i].strip().split()
                if len(z) >= 4:
                    try:
                        x, y, zz = float(z[1]), float(z[2]), float(z[3])
                        m = re.match(r"^([A-Za-z]{1,2})", z[0])
                        atoms.append({"el": m.group(1) if m else z[0], "p": [x, y, zz]})
                    except ValueError:
                        pass
                i += 1
            if len(atoms) != n:
                raise SymmetryError(f"XYZ header says {n} atoms, but only {len(atoms)} valid atom lines were found.")
        else:
            idx_by_serial = {}
            for line in lines:
                if len(line) >= 54 and re.match(r"^(ATOM  |HETATM)", line):
                    el = (line[76:78].strip() or re.sub(r"[0-9]", "", line[12:16]).strip())
                    m = re.match(r"^([A-Za-z]{1,2})", el)
                    el = m.group(1) if m else el
                    try:
                        x, y, z = float(line[30:38]), float(line[38:46]), float(line[46:54])
                    except ValueError:
                        continue
                    if el:
                        idx_by_serial[int(line[6:11])] = len(atoms)
                        atoms.append({"el": el, "p": [x, y, z]})
            for line in lines:
                if line.startswith("CONECT"):
                    ids = [int(line[i:i + 5]) for i in range(6, len(line), 5) if line[i:i + 5].strip().lstrip("-").isdigit()]
                    if ids:
                        a0 = idx_by_serial.get(ids[0])
                        for k in ids[1:]:
                            b0 = idx_by_serial.get(k)
                            if a0 is not None and b0 is not None:
                                bonds.append([a0, b0])
    if len(atoms) < 1:
        raise SymmetryError("Could not parse the structure. Supported formats: XYZ, SDF/MOL and PDB.")
    norm = normalize_mol(atoms)
    seen = {}
    for b in bonds:
        key = tuple(sorted(b))
        seen[key] = list(key)
    # Bare XYZ (and any other input that came in with zero bonds) has no
    # connectivity info at all, so the 3-D viewer would render a cloud of
    # unconnected atoms. Fill in a best-effort bond list from interatomic
    # distances in that case only — explicit SDF/MOL/PDB bonds are never
    # second-guessed.
    if not seen:
        for b in infer_bonds_by_distance(norm["atoms"]):
            key = tuple(sorted(b))
            seen[key] = list(key)
    return {"atoms": norm["atoms"], "center": norm["center"], "scale": norm["scale"], "bonds": list(seen.values())}

# ------------------------------------------------------------ op detection
def _match(atoms, M, tol):
    q = [_app(M, a["p"]) for a in atoms]
    by_el = {}
    for j, a in enumerate(atoms):
        by_el.setdefault(a["el"], []).append(j)
    adj = []
    for i, a in enumerate(atoms):
        cand = by_el.get(a["el"], [])
        # Kuhn's augmenting-path matching only needs SOME candidate list per
        # atom, not a sorted-by-distance one -- existence of a perfect
        # matching (all "ok" below actually checks) doesn't depend on
        # visitation order. The sort here was pure overhead: profiling on a
        # 40-atom, Ih-symmetry structure (dodecahedrane) showed it (plus the
        # tuple-building generator behind it) accounting for roughly half of
        # _match's total cost, since it runs on every one of the several
        # thousand candidate axis/order combinations tested per molecule,
        # most of which fail outright. A plain filter is functionally
        # identical for correctness (verified: identical detected point
        # group and operation count on both a small D6h test case and the
        # dodecahedrane Ih case) and meaningfully cheaper.
        adj.append([j for j in cand if _len(_sub(q[i], atoms[j]["p"])) <= tol])

    match_j = {}

    def dfs(i, seen):
        for j in adj[i]:
            if j in seen:
                continue
            seen.add(j)
            old = match_j.get(j)
            if old is None or dfs(old, seen):
                match_j[j] = i
                return True
        return False

    order = sorted(range(len(atoms)), key=lambda i: len(adj[i]))
    for i in order:
        if not dfs(i, set()):
            return {"ok": False, "maxd": tol}
    mp = [None] * len(atoms)
    for j, i in match_j.items():
        mp[i] = j
    maxd = 0.0
    for i in range(len(mp)):
        maxd = max(maxd, _len(_sub(q[i], atoms[mp[i]]["p"])))
    pair_err = 0.0
    for i in range(len(atoms)):
        for j in range(i + 1, len(atoms)):
            d0 = _len(_sub(atoms[i]["p"], atoms[j]["p"]))
            d1 = _len(_sub(atoms[mp[i]]["p"], atoms[mp[j]]["p"]))
            pair_err = max(pair_err, abs(d0 - d1))
    if pair_err > max(tol * 1.5, 0.01):
        return {"ok": False, "maxd": max(maxd, pair_err)}
    return {"ok": True, "maxd": maxd}

def _is_sym(atoms, M, tol):
    return _match(atoms, M, tol)

def _diagnostic_deviation(atoms, M):
    """Real-valued 'how far off was this candidate', independent of the
    tolerance-gated bipartite matcher above. _match()'s failure path
    returns a placeholder maxd=tol for any candidate that fails outright
    (no same-element atom within tol at all) — accurate for the accept/
    reject decision itself, but useless for reporting "closest miss by X
    Angstrom" (every hard failure would misleadingly read as exactly
    "tol", never more). This does a simple greedy nearest-same-element
    match with no tolerance gate, purely for that diagnostic number —
    never used to accept or reject an operation, only to describe one
    that was already rejected."""
    q = [_app(M, a["p"]) for a in atoms]
    used = set()
    maxd = 0.0
    for i, a in enumerate(atoms):
        best = None
        for j, b in enumerate(atoms):
            if j in used or b["el"] != a["el"]:
                continue
            d = _len(_sub(q[i], b["p"]))
            if best is None or d < best[1]:
                best = (j, d)
        if best is None:
            return None  # no atom of this element at all (shouldn't happen)
        used.add(best[0])
        maxd = max(maxd, best[1])
    return maxd

def _clean_matrix(M):
    r0 = _norm(M[0]) or [1, 0, 0]
    r1 = _sub(M[1], _scale(r0, _dot(M[1], r0)))
    r1 = _norm(r1) or [0, 1, 0]
    r2 = _cross(r0, r1)
    if _det3(M) < 0:
        r2 = _scale(r2, -1)
    return [r0, r1, r2]

def _op_key(M):
    C = _clean_matrix(M)
    flat = [x for row in C for x in row]
    return ",".join("0" if abs(x) < 1e-7 else f"{x:.5f}" for x in flat)

def _add_op(ops, op, atoms, tol):
    r = _is_sym(atoms, op["M"], tol)
    if not r["ok"]:
        return False
    k = _op_key(op["M"])
    if k not in ops:
        merged = dict(op)
        merged["error"] = r["maxd"]
        ops[k] = merged
    return True

def _axis_candidates(atoms):
    dirs = []
    for a in atoms:
        dirs.append(a["p"])
    for i in range(len(atoms)):
        for j in range(i + 1, len(atoms)):
            a, b = atoms[i]["p"], atoms[j]["p"]
            dirs.append(_add(a, b)); dirs.append(_sub(a, b)); dirs.append(_cross(a, b))
    # Triangular-face centroid/normal directions: needed for any polyhedral
    # point group whose Cn axis passes through the middle of a face rather
    # than through any single vertex or any 2-atom combination above — the
    # defining case being an icosahedron's C3 axes (through the centroid of
    # each of its 20 triangular faces, e.g. a real B12H12^2- cluster) or a
    # C60 fullerene's C3 axes (through its 20 hexagonal-ring centroids).
    # Without these, only a partial, geometry-dependent subset of the true
    # C3 axes get found (confirmed: a regular B12 icosahedron was finding
    # only 8 of its 20 C3 rotations and, falling short of the Ih/I
    # detection threshold, was misclassified as Th).
    #
    # A real polyhedral face's vertices are, by definition, mutually close
    # together — so instead of every combination of same-element atoms
    # (cubic in atom count, and C60's 60 carbons alone would be 34,220
    # triples before this molecule has done anything else), each atom only
    # pairs with its own nearest same-element neighbors. That is linear in
    # atom count and still finds every genuine face — a face's vertices
    # are each other's nearest neighbors by construction — while an
    # ordinary large asymmetric organic molecule, which has no faces to
    # find, pays only a small fixed neighbor-search cost per atom.
    NEARBY_K = 4
    by_element = {}
    for a in atoms:
        by_element.setdefault(a["el"], []).append(a["p"])
    for el, pts in by_element.items():
        n = len(pts)
        if n < 3:
            continue
        for i in range(n):
            dists = sorted(range(n), key=lambda j: _len(_sub(pts[j], pts[i])) if j != i else float("inf"))
            neighbors = dists[:NEARBY_K]
            for a in range(len(neighbors)):
                for b in range(a + 1, len(neighbors)):
                    j, k = neighbors[a], neighbors[b]
                    p, q, s = pts[i], pts[j], pts[k]
                    dirs.append(_add(p, _add(q, s)))  # centroid direction
                    dirs.append(_cross(_sub(q, p), _sub(s, p)))  # face normal
    Imat = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]]
    for a in atoms:
        x, y, z = a["p"]
        Imat[0][0] += y * y + z * z
        Imat[1][1] += x * x + z * z
        Imat[2][2] += x * x + y * y
        Imat[0][1] -= x * y
        Imat[0][2] -= x * z
        Imat[1][2] -= y * z
    Imat[1][0] = Imat[0][1]; Imat[2][0] = Imat[0][2]; Imat[2][1] = Imat[1][2]
    eig = _jacobi_sym(Imat)
    for v in eig["vectors"]:
        dirs.append(v)
    ev = eig["vectors"]
    for i in range(3):
        for j in range(i + 1, 3):
            dirs.append(_add(ev[i], ev[j])); dirs.append(_sub(ev[i], ev[j]))
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                dirs.append(_add(_scale(ev[0], sx), _add(_scale(ev[1], sy), _scale(ev[2], sz))))
    return _unique_dirs(dirs)

def _plane_candidates(atoms, axes, all_dirs=None):
    # `axes` is the (small, symmetry-confirmed) set whose pairs get cross-
    # multiplied — O(len(axes)^2), so this only stays cheap because `axes`
    # is small. `all_dirs`, if given, is included individually (O(n), not
    # squared) so genuine plane-normal candidates from the full raw pool —
    # e.g. the Cs case of one mirror plane and no confirmed rotation axis —
    # are never lost, only the quadratic *pairing* of that full pool is.
    ns = list(all_dirs if all_dirs is not None else axes)
    for i in range(len(atoms)):
        for j in range(i + 1, len(atoms)):
            ns.append(_cross(atoms[i]["p"], atoms[j]["p"]))
    for i in range(len(axes)):
        for j in range(i + 1, len(axes)):
            ns.append(_cross(axes[i], axes[j]))
    return _unique_dirs(ns)

def detect_operations(atoms, tol):
    ops = {}
    _add_op(ops, {"label": "E", "kind": "E", "M": I3}, atoms, tol)
    R = normalize_mol(atoms)["atoms"]
    axis_dirs = _axis_candidates(R)
    # n_max previously scaled with atom count (up to 24), so every extra
    # atom in a real molecule meant testing rotation orders up to C24 and
    # improper rotations up to S48 for every candidate axis — chemically
    # pointless (no ordinary molecule has a genuine proper rotation axis
    # above ~C8-C10; icosahedral symmetry, the highest commonly seen, tops
    # out at C5) and the dominant remaining cost on larger, mostly-
    # asymmetric real molecules. Capping this at a fixed, generously-safe
    # ceiling — independent of atom count — keeps every point group this
    # engine actually classifies (up to Ih, whose highest axis is C5)
    # fully covered while cutting runtime on larger structures dramatically.
    n_max = max(2, min(len(R), 10))

    # Axes that survive the rotational-symmetry test are genuine symmetry
    # elements of this molecule; axis_dirs itself is just an unfiltered pool
    # of *geometric guesses* (every atom position, every pairwise sum/
    # difference/cross-product, inertia eigenvectors...) most of which are
    # not real symmetry axes at all. For a highly symmetric molecule that
    # pool collapses to a handful of directions after dedup; for an
    # ordinary asymmetric organic molecule (dozens of atoms, no exact
    # symmetry) almost none of it collapses, so it stays large.
    confirmed_axes = []

    # For every rotation/reflection/improper-rotation order actually tested,
    # keep the single best (lowest-deviation) candidate seen — whether or
    # not it ended up passing. For an order that never passes, this is
    # exactly "how close did the molecule come, and by how much did it
    # miss" (e.g. "C4 rejected: closest candidate off by 0.42 \u00c5"), a
    # diagnostic a plain pass/fail list can't give.
    best_miss = {}
    def _track(key, maxd, M, **extra):
        cur = best_miss.get(key)
        if cur is None or maxd < cur["maxd"]:
            best_miss[key] = dict(maxd=maxd, M=M, **extra)

    for axis in axis_dirs:
        for n in range(2, n_max + 1):
            M = _rotM(axis, 2 * math.pi / n)
            r = _is_sym(R, M, tol)
            _track(f"C{n}", r["maxd"], M, axis=axis)
            if r["ok"]:
                _add_op(ops, {"label": f"C{n}", "kind": "C", "axis": axis, "n": n, "theta": 2 * math.pi / n, "M": M}, R, tol)
                confirmed_axes.append(axis)
                for k in range(2, n):
                    Mk = _rotM(axis, 2 * math.pi * k / n)
                    if _is_sym(R, Mk, tol)["ok"]:
                        _add_op(ops, {"label": f"C{n}^{k}", "kind": "C", "axis": axis, "n": n, "k": k,
                                      "theta": 2 * math.pi * k / n, "M": Mk}, R, tol)
    inv_test = _is_sym(R, INV, tol)
    _track("i", inv_test["maxd"], INV)
    if inv_test["ok"]:
        _add_op(ops, {"label": "i", "kind": "i", "M": INV}, R, tol)
    # _plane_candidates cross-multiplies every *pair* of axes it's handed to
    # guess mirror-plane normals — that step is O(k^2) in the size of that
    # axis list. Feeding it the full raw axis_dirs pool (which can run into
    # the hundreds for a real, mostly-asymmetric molecule) made this blow up
    # to minutes of runtime on ordinary drug-sized molecules. Real mirror
    # planes are overwhelmingly related to *actual* symmetry axes, so
    # restrict the cross-product step to confirmed_axes (small — bounded by
    # how much real symmetry the molecule has, never by its atom count) and
    # let the individual raw directions and per-atom-pair cross products
    # (both still O(n) / O(n^2), always cheap) keep covering the Cs-type
    # case of a single mirror plane with no rotation axis at all.
    # confirmed_axes may legitimately be empty (an asymmetric molecule with
    # no rotation axes at all, e.g. plain Cs or C1) — that must NOT fall
    # back to the full raw pool, or it reintroduces the exact blow-up this
    # is fixing. An empty axis list here just means "skip the axis-pair
    # cross-product enhancement"; all_dirs still covers the base case.
    planes = _plane_candidates(R, confirmed_axes, all_dirs=axis_dirs)
    for normal in planes:
        M = _reflM(normal)
        r = _is_sym(R, M, tol)
        _track("sigma", r["maxd"], M, normal=normal)
        if r["ok"]:
            _add_op(ops, {"label": "sigma", "kind": "M", "normal": normal, "M": M}, R, tol)
    for axis in axis_dirs:
        for n in range(2, n_max * 2 + 1):
            theta = 2 * math.pi / n
            M = _mul(_reflM(axis), _rotM(axis, theta))
            r = _is_sym(R, M, tol)
            _track(f"S{n}", r["maxd"], M, axis=axis)
            if r["ok"]:
                _add_op(ops, {"label": f"S{n}", "kind": "S", "axis": axis, "n": n, "theta": theta, "M": M}, R, tol)
    for o in [o for o in list(ops.values()) if o["kind"] == "S"]:
        P = I3
        for k in range(1, 2 * o["n"] + 1):
            P = _mul(P, o["M"])
            if _is_sym(R, P, tol)["ok"]:
                _add_op(ops, {"label": f"{o['label']}^{k}", "kind": "S", "axis": o["axis"], "n": o["n"], "k": k,
                              "theta": 2 * math.pi * k / o["n"], "M": P}, R, tol)

    all_ops = []
    for o in ops.values():
        d = _det3(o["M"])
        # "error" (the real match deviation for this confirmed operation,
        # set by _add_op below) was never carried over into this list —
        # classify()'s max_error calculation reads o.get("error", 0) on
        # *this* list, so it was silently always defaulting to 0 no matter
        # how loose the actual matches were. That's the "Max match error"
        # stat the UI has always shown as 0.0000 \u00c5 regardless of input.
        all_ops.append({"M": o["M"], "det": 1 if d > 0 else -1, "trace": _trace(o["M"]), "error": o.get("error", 0)})
    result = classify(R, all_ops, tol)
    result["all"] = all_ops
    result["base_ops"] = len(all_ops)

    # A rejected-test entry is only useful for a kind/order that never
    # succeeded on *any* candidate (if a real C3 axis was found, reporting
    # "C3 also failed on some other candidate axis" is noise, not insight).
    confirmed_labels = set()
    for o in ops.values():
        if o["kind"] == "C":
            confirmed_labels.add(f"C{o['n']}")
        elif o["kind"] == "S":
            confirmed_labels.add(f"S{o['n']}")
        elif o["kind"] == "M":
            confirmed_labels.add("sigma")
        elif o["kind"] == "i":
            confirmed_labels.add("i")
    rejected = []
    for key, info in best_miss.items():
        if key in confirmed_labels:
            continue
        # info["maxd"] may be the tolerance-gated matcher's placeholder
        # (returned whenever no valid element-preserving match exists at
        # all — a hard topological rejection, not a "close miss"), which
        # would misreport every such case as exactly "off by tol". Only a
        # handful of these ever reach here (one per tested order/kind), so
        # recomputing a real, ungated deviation for just the finalists is
        # cheap and gives an honest number instead of a repeated constant.
        real = _diagnostic_deviation(R, info["M"])
        error = real if real is not None else info["maxd"]
        entry = {
            "label": {"sigma": "\u03c3 (mirror plane)", "i": "i (inversion)"}.get(key, key),
            "errorAngstrom": round(error, 4),
        }
        if "axis" in info:
            entry["axis"] = info["axis"]
        if "normal" in info:
            entry["normal"] = info["normal"]
        rejected.append(entry)
    rejected.sort(key=lambda x: x["errorAngstrom"])
    # Cap the list: only the orders closest to passing are informative
    # ("C4 missed by 0.42 \u00c5" is worth showing; "C9 missed by 3.8 \u00c5"
    # on a molecule with no business having a C9 axis is just clutter).
    result["rejectedTests"] = rejected[:8]
    return result

def _order_of_rotation(M):
    d = 1 if round(_det3(M)) > 0 else -1
    c = (_trace(M) - 1) / 2 if d > 0 else (_trace(M) + 1) / 2
    c = max(-1, min(1, c))
    th = math.acos(c)
    if th < 1e-6:
        return 1
    if d < 0:
        raw = 2 * math.pi / th
        n = max(2, round(raw))
        return n if abs(raw - n) < 1e-3 else None
    # For a proper rotation, the true group-theoretic order is the
    # smallest q such that q*theta is a whole multiple of 360 degrees —
    # NOT just whether theta itself equals 360/q for some integer q. That
    # narrower check only recognizes a rotation's "primitive" power
    # (k=1, and by folding k=n-1) and silently misses every other
    # non-trivial power such as C5^2/C5^3 (theta=144/216 degrees, neither
    # of which is 360/n for a whole n) even though both are genuine
    # order-5 elements. Confirmed impact: this made c5-type element
    # counts for the icosahedral point groups undercount by half — I/Ih
    # detection still worked here only because its threshold happened to
    # be low enough to pass anyway on the undercounted total, not because
    # the count was actually right. Any Cn/Dn-family group with n=5 (the
    # first n where non-edge powers don't coincidentally fold back onto
    # the primitive angle) was silently affected the same way.
    frac = th / (2 * math.pi)
    for q in range(2, 25):
        p = frac * q
        if abs(p - round(p)) < 1e-3 and round(p) >= 1:
            return q
    return None

def _rotation_axis(M):
    x, y, z = M[2][1] - M[1][2], M[0][2] - M[2][0], M[1][0] - M[0][1]
    v = _norm([x, y, z])
    if v:
        return v
    # The antisymmetric-vector trick above is zero for the identity AND for
    # any exact 180 degree rotation (sin(180 deg) = 0), so a real C2 axis
    # still needs recovering here via the 1-D nullspace of (M - I). But
    # this function is sometimes reached for matrices that aren't a proper
    # rotation at all (a pure reflection, where M-I has a 2-D nullspace —
    # the whole mirror plane, not a line), and in that case every row of
    # (M-I) is parallel, every pairwise cross product is ~0, and `best`
    # was silently left at its hardcoded initial guess [1,0,0] — a bogus
    # axis returned as if it were real. Callers that do
    # `_rotation_axis(M) or _plane_normal(M)` to tell rotations from
    # reflections apart (e.g. matching a detected mirror to the correct
    # sigma_h/sigma_v/sigma_d table column) would then always take this
    # meaningless [1,0,0] and never fall through to the correct
    # _plane_normal(M) — confirmed: this was silently corrupting sigma_h
    # selection for planar molecules like benzene (its true sigma_h, the
    # ring plane itself with all 12 atoms unmoved, was being replaced by
    # an arbitrary sigma_v/sigma_d candidate). Only trust this fallback
    # when a genuinely nonzero cross product was actually found.
    rows = [[M[0][0] - 1, M[0][1], M[0][2]], [M[1][0], M[1][1] - 1, M[1][2]], [M[2][0], M[2][1], M[2][2] - 1]]
    best, bl = None, 0
    for i in range(3):
        for j in range(i + 1, 3):
            c = _cross(rows[i], rows[j])
            if _len(c) > bl:
                bl = _len(c)
                best = _canonical(c)
    return best if bl > 1e-6 else None

def _plane_normal(M):
    rows = [[M[0][0] - 1, M[0][1], M[0][2]], [M[1][0], M[1][1] - 1, M[1][2]], [M[2][0], M[2][1], M[2][2] - 1]]
    for r in rows:
        v = _norm(r)
        if v and _len(r) > 1e-5:
            return v
    return None

def classify(atoms, all_ops, tol):
    trace = []  # human-readable decision-tree log — why this point group,
                # not just what it is (built alongside the actual logic
                # below, not reconstructed after the fact, so it can never
                # drift out of sync with what the classifier really did).
    proper = [o for o in all_ops if o["det"] > 0]
    improper = [o for o in all_ops if o["det"] < 0]
    non_id = [o for o in proper if abs(o["trace"] - 3) > 1e-4]
    orders = [x for x in (_order_of_rotation(o["M"]) for o in non_id) if x]
    unique = sorted(set(orders), reverse=True)
    inv = any(abs(o["trace"] + 3) < 1e-3 for o in improper)
    refl = sum(1 for o in improper if abs(o["trace"] - 1) < 1e-3)
    impro_rot = sum(1 for o in improper if abs(o["trace"] - 1) > 1e-3 and abs(o["trace"] + 3) > 1e-3)
    trace.append(f"Found {len(proper)-1} non-trivial proper rotation(s), {refl} mirror plane(s), "
                 f"{impro_rot} improper rotation(s) (S\u2099, n>2), inversion center: {'yes' if inv else 'no'}.")

    max_cross = 0.0
    for i in range(len(atoms)):
        for j in range(i + 1, len(atoms)):
            for k in range(j + 1, len(atoms)):
                max_cross = max(max_cross, _len(_cross(atoms[j]["p"], atoms[k]["p"])))
    scale = max(1.0, math.sqrt(sum(_dot(a["p"], a["p"]) for a in atoms)))
    linear = max_cross < tol * 2 * scale

    if linear:
        symmetric_end = len(atoms) > 1 and _match(atoms, INV, tol)["ok"]
        trace.append("All atoms fall on one line \u2192 linear molecule. "
                      f"Checked for a center of inversion: {'found' if symmetric_end else 'not found'} "
                      f"\u2192 {'D\u221eh' if symmetric_end else 'C\u221ev'} "
                      f"({'symmetric ends, e.g. CO\u2082' if symmetric_end else 'asymmetric ends, e.g. HCN'}).")
        return {"group": "Dinfh" if symmetric_end else "Cinfv", "order": "inf", "ops": len(all_ops), "inv": inv,
                "refl": refl, "improRot": impro_rot, "unique": unique, "linear": True, "tol": tol, "maxError": 0,
                "decisionTrace": trace}

    max_n = unique[0] if unique else 1
    trace.append(f"Not linear. Highest-order rotation axis found: {'none' if max_n <= 1 else f'C{max_n}'}.")

    def count_order(n):
        return sum(1 for o in non_id if _order_of_rotation(o["M"]) == n)

    c2, c3, c4, c5 = count_order(2), count_order(3), count_order(4), count_order(5)
    if c5 >= 12 and c3 >= 20:
        group = "Ih" if inv else "I"
        trace.append(f"{c5} C5 axes and {c3} C3 axes \u2192 icosahedral rotation subgroup. "
                     f"Inversion center {'present' if inv else 'absent'} \u2192 {group}.")
    elif c4 >= 6 and c3 >= 8 and c2 >= 6:
        group = "Oh" if inv else "O"
        trace.append(f"{c4} C4 axes, {c3} C3 axes, {c2} C2 axes \u2192 octahedral rotation subgroup. "
                     f"Inversion center {'present' if inv else 'absent'} \u2192 {group}.")
    elif c3 >= 4 and c2 >= 3:
        # Rotation subgroup of the tetrahedral family (4 C3 axes, 3 C2 axes,
        # order 12) is shared by three distinct point groups: T (chiral,
        # rotations only), Td (+ 6 sigma_d + 6 S4, order 24, e.g. CH4), and
        # Th (+ i + 4 S6 + 3 sigma_h, order 24, e.g. some octahedral-ligand
        # cages). Inversion alone only tells Th apart from the rest — Td and
        # T both lack i, and were previously conflated (any non-centrosymmetric
        # molecule with this rotation subgroup was always reported as Td, even
        # a genuinely chiral T-symmetry one with no mirror planes at all).
        trace.append(f"{c3} C3 axes and {c2} C2 axes \u2192 tetrahedral rotation subgroup (T, Td, or Th).")
        if inv:
            group = "Th"
            trace.append("Inversion center present \u2192 Th.")
        elif refl > 0 or impro_rot > 0:
            group = "Td"
            trace.append(f"No inversion, but {refl} mirror plane(s)/{impro_rot} S\u2099 found \u2192 Td (e.g. CH\u2084).")
        else:
            group = "T"
            trace.append("No inversion, no mirror planes, no S\u2099 \u2192 purely chiral T.")
    else:
        principal = None
        if max_n > 1:
            for o in proper:
                n = _order_of_rotation(o["M"])
                if n == max_n:
                    principal = _rotation_axis(o["M"])
                    break
        perp_c2 = 0
        if principal:
            perp_c2 = sum(1 for o in proper if _order_of_rotation(o["M"]) == 2 and abs(_dot(_rotation_axis(o["M"]), principal)) < 0.08)
        has_sigma_h = principal is not None and any(
            abs(o["trace"] - 1) < 1e-3 and _plane_normal(o["M"]) and abs(_dot(_plane_normal(o["M"]), principal)) > 0.96
            for o in improper)
        has_sigma_v = principal is not None and any(
            abs(o["trace"] - 1) < 1e-3 and _plane_normal(o["M"]) and abs(_dot(_plane_normal(o["M"]), principal)) < 0.15
            for o in improper)
        has_sn = impro_rot > 0
        if max_n <= 1:
            group = "Ci" if inv else ("Cs" if refl else "C1")
            trace.append("No rotation axis at all. " +
                         ("Inversion center only \u2192 Ci." if inv else
                          ("One mirror plane, nothing else \u2192 Cs." if refl else
                           "No symmetry elements beyond identity \u2192 C1 (asymmetric).")))
        elif perp_c2 >= max(2, max_n - 1):
            trace.append(f"Found {perp_c2} C2 axis/axes perpendicular to the principal C{max_n} \u2192 dihedral family (D{max_n}). "
                         f"Checked for \u03c3h (mirror \u22a5 principal axis): {'found' if has_sigma_h else 'not found'}.")
            if has_sigma_h:
                group = f"D{max_n}h"
                trace.append(f"\u03c3h present \u2192 D{max_n}h (e.g. BF\u2083 is D3h, XeF\u2084 is D4h).")
            else:
                trace.append(f"No \u03c3h. Checked for S{2*max_n} or \u03c3d (diagonal mirrors): "
                             f"{'found' if (has_sn or has_sigma_v) else 'not found'}.")
                if has_sn or has_sigma_v:
                    group = f"D{max_n}d"
                    trace.append(f"S{2*max_n}/\u03c3d present, no \u03c3h \u2192 D{max_n}d (staggered, e.g. ethane is D3d).")
                else:
                    group = f"D{max_n}"
                    trace.append(f"No mirrors of any kind \u2192 purely chiral D{max_n} (e.g. a propeller-shaped complex).")
        else:
            trace.append(f"Perpendicular C2 axes ({perp_c2}) don't reach the D{max_n} threshold \u2192 not dihedral; "
                         f"checking single-axis (Cn-family) cases around the principal C{max_n}.")
            if inv and max_n % 2 == 0 and not has_sigma_v:
                group = f"C{max_n}h"
                trace.append(f"Even-order axis (C{max_n}) with an inversion center and no \u03c3v \u2192 C{max_n}h.")
            elif has_sigma_h:
                group = f"C{max_n}h"
                trace.append(f"\u03c3h found (mirror \u22a5 the C{max_n} axis) \u2192 C{max_n}h.")
            elif has_sigma_v:
                group = f"C{max_n}v"
                trace.append(f"\u03c3v found (mirror containing the C{max_n} axis) \u2192 C{max_n}v (e.g. NH\u2083 is C3v, H\u2082O is C2v).")
            elif has_sn:
                group = f"S{2 * max_n}"
                trace.append(f"No mirrors, but an S{2*max_n} improper rotation was found \u2192 S{2*max_n}.")
            else:
                group = f"C{max_n}"
                trace.append(f"Only the bare C{max_n} axis, no mirrors, no S\u2099 \u2192 purely chiral C{max_n}.")

    max_error = max((o.get("error", 0) for o in all_ops), default=0)
    return {"group": group, "order": len(all_ops), "ops": len(all_ops), "inv": inv, "refl": refl,
            "improRot": impro_rot, "unique": unique, "linear": False, "tol": tol, "maxError": max_error,
            "decisionTrace": trace}

def pretty(g):
    return PRETTY.get(g, g)

def expected_order(g):
    if g in ("C1", "Cs", "Ci"):
        return 1 if g == "C1" else 2
    if g in ("Cinfv", "Dinfh"):
        return "inf"
    m = re.match(r"^C(\d+)$", g)
    if m:
        return int(m.group(1))
    m = re.match(r"^C(\d+)[vh]$", g)
    if m:
        return 2 * int(re.search(r"\d+", g).group())
    m = re.match(r"^S(\d+)$", g)
    if m:
        return int(m.group(1))
    m = re.match(r"^D(\d+)$", g)
    if m:
        return 2 * int(m.group(1))
    m = re.match(r"^D(\d+)[hd]$", g)
    if m:
        return 4 * int(re.search(r"\d+", g).group())
    if g == "T":
        return 12
    if g in ("Td", "Th", "O"):
        return 24
    if g == "Oh":
        return 48
    if g == "I":
        return 60
    if g == "Ih":
        return 120
    return "?"

def pretty_formula(formula):
    return "".join(f"{el}{n if n > 1 else ''}" for el, n in formula.items())

def op_stats(mol_atoms, op):
    d = 1 if _det3(op["M"]) > 0 else -1
    c = (_trace(op["M"]) - 1) / 2 if d > 0 else (_trace(op["M"]) + 1) / 2
    c = max(-1, min(1, c))
    th = round(math.degrees(math.acos(c)))
    fixed = 0
    for a in mol_atoms:
        q = _app(op["M"], a["p"])
        if math.hypot(q[0] - a["p"][0], q[1] - a["p"][1], q[2] - a["p"][2]) < 0.02:
            fixed += 1
    contrib = fixed * ((1 if d > 0 else -1) + 2 * math.cos(math.radians(th)))
    return {"det": d, "th": th, "fixed": fixed, "contrib": contrib}

def _op_angle_deg(M):
    """Actual rotation angle carried by M, read off its trace (same formula
    op_stats() uses for class matching) rather than assumed from a class
    order n — a Cn^k for k>1 has the same n as Cn^1 but a different real
    angle, and the frontend needs the real one to animate the operation
    correctly rather than just spin by 360/n every time."""
    d = 1 if round(_det3(M)) > 0 else -1
    c = (_trace(M) - 1) / 2 if d > 0 else (_trace(M) + 1) / 2
    c = max(-1, min(1, c))
    return math.degrees(math.acos(c))


def operation_objects(result):
    out = []
    for i, o in enumerate(result.get("all", [])):
        d, tr = o["det"], o["trace"]
        if i == 0:
            out.append({"label": "E", "kind": "E", "M": I3})
            continue
        if d > 0:
            axis = _rotation_axis(o["M"]) or [0, 0, 1]
            n = _order_of_rotation(o["M"]) or 2
            out.append({"label": f"C{n} [{i}]", "kind": "C", "axis": axis, "n": n,
                        "angle": _op_angle_deg(o["M"]), "M": o["M"]})
            continue
        if abs(tr + 3) < 1e-3:
            out.append({"label": "i", "kind": "i", "M": o["M"]})
            continue
        if abs(tr - 1) < 1e-3:
            out.append({"label": f"sigma [{i}]", "kind": "M", "normal": _plane_normal(o["M"]) or [0, 0, 1], "M": o["M"]})
            continue
        axis = _rotation_axis(o["M"]) or [0, 0, 1]
        n = _order_of_rotation(o["M"]) or 2
        out.append({"label": f"S{n} [{i}]", "kind": "S", "axis": axis, "n": n,
                    "angle": _op_angle_deg(o["M"]), "M": o["M"]})
    return out

def _as_int(x):
    r = round(x)
    return r if abs(x - r) < 1e-6 else x

def fmt_gamma(T, arr):
    parts = []
    for i, ir in enumerate(T["irreps"]):
        n = _as_int(arr[i])
        if n:
            parts.append(f"{n if n > 1 else ''}{ir['n']}")
    return " + ".join(parts) if parts else "\u2014"

def derive_representation(parsed_atoms, result):
    group = result["group"]
    T = TABLES.get(group)
    ops = operation_objects(result)
    if not T:
        return {"group": group, "T": None, "ops": ops, "analysis": None}
    info = []
    for o in ops:
        st = op_stats(parsed_atoms, o)
        info.append({"op": o, "det": st["det"], "th": st["th"], "fixed": st["fixed"], "chi": st["contrib"]})

    principal = None
    bn = 1
    for x in info:
        if x["det"] > 0:
            n = _order_of_rotation(x["op"]["M"]) or 1
            if n > bn:
                bn = n
                principal = _rotation_axis(x["op"]["M"])

    def axis_of(x):
        return _rotation_axis(x["op"]["M"]) or _plane_normal(x["op"]["M"]) or [0, 0, 0]

    used = set()

    def pick_for_column(col):
        cand = [x for i, x in enumerate(info) if x["det"] == col["det"] and x["th"] == col["th"] and id(x) not in used]
        if not cand:
            return None
        if col["label"] == "C\u2082" and principal:
            # Want the candidate whose axis is most ALIGNED with the
            # principal axis (the true principal C2, e.g. C4^2 in D4h) —
            # i.e. the largest |dot|, not the smallest. Sorting ascending
            # on |dot| (as this used to) picks the most PERPENDICULAR
            # candidate instead — silently swapping in a C2' axis for the
            # principal C2 slot whenever both exist with the same det/th
            # (D4h, D6h, C4h, C6h, ...). That one swapped operation then
            # corrupts every downstream vibrational-mode count for the
            # whole molecule, not just that one class — confirmed by e.g.
            # XeF4 (D4h) previously reducing to 17 Cartesian degrees of
            # freedom instead of the correct 3N=15.
            cand.sort(key=lambda x: -abs(_dot(axis_of(x), principal)))
        elif col["label"] == "\u03c3h" and principal:
            # Same fix: sigma_h's normal should be most PARALLEL to the
            # principal axis (that's what makes it "horizontal"), so this
            # also wants descending, not ascending, |dot|.
            cand.sort(key=lambda x: -abs(_dot(axis_of(x), principal)))
        elif col.get("fix") == "hi":
            cand.sort(key=lambda x: -x["fixed"])
        elif col.get("fix") == "lo":
            cand.sort(key=lambda x: x["fixed"])
        elif col.get("fix") == "md":
            avg = sum(x["fixed"] for x in cand) / len(cand)
            cand.sort(key=lambda x: abs(x["fixed"] - avg))
        return cand[0]

    reps = []
    for col in T["cols"]:
        x = pick_for_column(col)
        if x is None:
            return {"group": group, "T": T, "ops": ops, "analysis": None,
                    "error": f"Could not find a detected representative for class {col['label']}"}
        used.add(id(x))
        reps.append(x)

    chi = [x["chi"] for x in reps]
    h = T["h"]

    def reduce(v):
        # Matches JS `Math.round` semantics (round-half-up), not Python's
        # banker's rounding — for borderline .5 cases (which show up when a
        # class-column representative is ambiguous, e.g. two axis-tied C2
        # classes in D4h/D6h-type groups) the two conventions can disagree,
        # and matching the reference tool's behaviour here is what "same
        # logic" means for this engine.
        #
        # Most tables' "E"/"T" rows are genuinely irreducible (the standard
        # projection formula n_i = (1/h)*sum(g*chi*chi_i) is exact for
        # them). But for point groups built on an abelian rotation subgroup
        # (plain Cn, Cnh, Sn, and T/Th) the conventional real "E" row shown
        # in every textbook is actually the SUM of two separate complex
        # 1-D irreps (Ea+Eb) folded into one real row for display — a
        # deliberate, standard simplification, but it means that row's own
        # orthogonality norm is 2h, not h. Reusing h there silently doubles
        # the reported multiplicity of every degenerate mode. Each such row
        # carries an explicit "norm" override in the table data; irreps
        # without one keep using the table's true group order h.
        out = []
        for ir in T["irreps"]:
            s = sum(T["cols"][j]["g"] * ir["x"][j] * v[j] for j in range(len(T["cols"])))
            out.append(int(math.floor(s / ir.get("norm", h) + 0.5)))
        return out

    n3N = reduce(chi)
    trans = [_as_int(len(ir["lin"]) / ir["x"][0]) if ir.get("lin") else 0 for ir in T["irreps"]]
    rot = [_as_int(len(ir["rot"]) / ir["x"][0]) if ir.get("rot") else 0 for ir in T["irreps"]]
    vib = [_as_int(n3N[i] - trans[i] - rot[i]) for i in range(len(n3N))]

    class_rows = []
    for j, col in enumerate(T["cols"]):
        class_rows.append({
            "label": col["label"], "size": col["g"], "chiGamma3N": round(chi[j], 4),
            "characters": [ir["x"][j] for ir in T["irreps"]],
        })

    # --- Representation validation -----------------------------------
    # The standard sanity checks any group-theory textbook worked example
    # runs by hand: does Gamma_3N really account for all 3N Cartesian
    # degrees of freedom, and does Gamma_trans + Gamma_rot + Gamma_vib
    # really add back up to Gamma_3N, irrep by irrep (not just in total —
    # a wrong-but-matching-total split would still be a bug). Surfacing
    # this explicitly means a broken reduction fails loudly instead of
    # quietly shipping a wrong mode count.
    dims = [ir["x"][0] for ir in T["irreps"]]
    n_atoms = len(parsed_atoms)
    gamma3N_dim = sum(m * d for m, d in zip(n3N, dims))
    trans_dim = sum(m * d for m, d in zip(trans, dims))
    rot_dim = sum(m * d for m, d in zip(rot, dims))
    vib_dim = sum(m * d for m, d in zip(vib, dims))
    expected_dim = 3 * n_atoms
    expected_rot = 2 if result.get("linear") else 3
    per_irrep_ok = all(n3N[i] == trans[i] + rot[i] + vib[i] for i in range(len(n3N)))
    validation = {
        "gamma3NDimension": gamma3N_dim,
        "expectedDimension": expected_dim,
        "gamma3NMatchesAtomCount": gamma3N_dim == expected_dim,
        "transDimension": trans_dim,
        "expectedTransDimension": 3,
        "rotDimension": rot_dim,
        "expectedRotDimension": expected_rot,
        "vibDimension": vib_dim,
        "expectedVibDimension": expected_dim - 3 - expected_rot,
        "decompositionConsistent": per_irrep_ok and (trans_dim + rot_dim + vib_dim == gamma3N_dim),
    }

    # --- IR / Raman activity ------------------------------------------
    # An irrep is IR-active iff it transforms as x, y, or z ("lin" tag —
    # a fundamental can only absorb IR light if the vibration changes the
    # dipole moment, which is exactly what transforming as a translation
    # means). It's Raman-active iff it transforms as a quadratic function
    # ("quad" tag — polarizability, not dipole, is what Raman couples to).
    # A mode that's neither is spectroscopically silent; one that's both
    # (common in non-centrosymmetric groups) is IR *and* Raman active,
    # unlike centrosymmetric groups where mutual exclusion applies.
    spectroscopy = []
    for i, ir in enumerate(T["irreps"]):
        if vib[i] <= 0:
            continue
        ir_active = bool(ir.get("lin"))
        raman_active = bool(ir.get("quad"))
        spectroscopy.append({
            "irrep": ir["n"], "count": vib[i], "dimension": dims[i],
            "irActive": ir_active, "ramanActive": raman_active,
            "silent": not ir_active and not raman_active,
        })

    return {
        "group": group, "T": T, "ops": ops,
        "analysis": {
            "h": h, "numIrreps": len(T["irreps"]),
            "chi": chi, "n3N": n3N, "trans": trans, "rot": rot, "vib": vib,
            "gamma3N": fmt_gamma(T, n3N),
            "gammaTrans": fmt_gamma(T, trans),
            "gammaRot": fmt_gamma(T, rot),
            "gammaVib": fmt_gamma(T, vib),
            "classRows": class_rows,
            "validation": validation,
            "spectroscopy": spectroscopy,
        },
    }

DEMOS = [
    {"key": "water", "label": "Water (H\u2082O)", "group": "C2v",
     "xyz": "3\nwater\nO 0 0 0\nH 0.757 0.586 0\nH -0.757 0.586 0"},
    {"key": "ammonia", "label": "Ammonia (NH\u2083)", "group": "C3v",
     "xyz": "4\nammonia\nN 0.0000 0.0000 0.0000\nH 0.0000 0.9377 -0.3816\n"
            "H 0.8121 -0.4689 -0.3816\nH -0.8121 -0.4689 -0.3816"},
    {"key": "methane", "label": "Methane (CH\u2084)", "group": "Td",
     "xyz": "5\nmethane\nC 0 0 0\nH 0.629 0.629 0.629\nH 0.629 -0.629 -0.629\n"
            "H -0.629 0.629 -0.629\nH -0.629 -0.629 0.629"},
    {"key": "bf3", "label": "Boron trifluoride (BF\u2083)", "group": "D3h",
     "xyz": "4\nBF3\nB 0 0 0\nF 1.30 0 0\nF -0.65 1.1258 0\nF -0.65 -1.1258 0"},
    {"key": "xef4", "label": "Xenon tetrafluoride (XeF\u2084)", "group": "D4h",
     "xyz": "5\nXeF4\nXe 0 0 0\nF 1.95 0 0\nF -1.95 0 0\nF 0 1.95 0\nF 0 -1.95 0"},
    {"key": "benzene", "label": "Benzene (C\u2086H\u2086)", "group": "D6h",
     "xyz": "12\nbenzene\nC 1.396 0 0\nC 0.698 1.209 0\nC -0.698 1.209 0\nC -1.396 0 0\n"
            "C -0.698 -1.209 0\nC 0.698 -1.209 0\nH 2.479 0 0\nH 1.240 2.147 0\n"
            "H -1.240 2.147 0\nH -2.479 0 0\nH -1.240 -2.147 0\nH 1.240 -2.147 0"},
    {"key": "sf6", "label": "Sulfur hexafluoride (SF\u2086)", "group": "Oh",
     "xyz": "7\nSF6\nS 0 0 0\nF 0 0 1.56\nF 0 0 -1.56\nF 0 1.56 0\nF 0 -1.56 0\nF 1.56 0 0\nF -1.56 0 0"},
    {"key": "ethylene", "label": "Ethylene (C\u2082H\u2084)", "group": "D2h",
     "xyz": "6\nethylene\nC 0.665 0 0\nC -0.665 0 0\nH 1.22 0.92 0\nH 1.22 -0.92 0\n"
            "H -1.22 0.92 0\nH -1.22 -0.92 0"},
    {"key": "co2", "label": "Carbon dioxide (CO\u2082)", "group": "Dinfh",
     "xyz": "3\nCO2\nO 0 0 1.16\nC 0 0 0\nO 0 0 -1.16"},
    {"key": "hcn", "label": "Hydrogen cyanide (HCN)", "group": "Cinfv",
     "xyz": "3\nHCN\nH 0 0 1.664\nC 0 0 0.664\nN 0 0 -0.502"},
]


# ------------------------------------------------------------ linear molecules
# A linear molecule's point group (D\u221eh / C\u221ev) is infinite, so it can't be
# handled by the finite-group machinery above: that path only ever sees the
# handful of C2..C24 "rotations" the discretised axis search happens to pass
# (which is why CO2 used to report a meaningless "28 / inf" operation count,
# with bogus C3/C5 axes and no representation reduction at all).
#
# Instead this section does what a textbook does for linear molecules:
#   * report the genuine, infinite operation classes (C\u221e, \u221e\u03c3v, i, S\u221e, \u221eC2'),
#     and hand the viewer a small *representative* set of them to draw;
#   * reduce \u0393_3N analytically, using the (infinite) character tables of
#     D\u221eh / C\u221ev, from just two numbers: how many atoms sit on the inversion
#     centre (n0) and how many symmetric off-centre pairs there are (p).
INF = "\u221e"
PHI = "\u03c6"

# (label, class size) for each class, then per-irrep rows of characters, and
# which Cartesian functions transform as that irrep (for \u0393_trans / \u0393_rot).
LINEAR_TABLES = {
    "Dinfh": {
        "cols": [("E", 1), (f"2C{INF}({PHI})", 2), (f"{INF}\u03c3v", INF),
                 ("i", 1), (f"2S{INF}({PHI})", 2), (f"{INF}C2", INF)],
        "irreps": [
            ("\u03a3g\u207a", [1, 1, 1, 1, 1, 1], None, None, True),
            ("\u03a3g\u207b", [1, 1, -1, 1, 1, -1], None, ["Rz"], False),
            ("\u03a0g", [2, f"2cos{PHI}", 0, 2, f"-2cos{PHI}", 0], None, ["Rx", "Ry"], True),
            ("\u0394g", [2, f"2cos2{PHI}", 0, 2, f"2cos2{PHI}", 0], None, None, True),
            ("\u03a3u\u207a", [1, 1, 1, -1, -1, -1], ["z"], None, False),
            ("\u03a3u\u207b", [1, 1, -1, -1, -1, 1], None, None, False),
            ("\u03a0u", [2, f"2cos{PHI}", 0, -2, f"2cos{PHI}", 0], ["x", "y"], None, False),
            ("\u0394u", [2, f"2cos2{PHI}", 0, -2, f"-2cos2{PHI}", 0], None, None, False),
        ],
    },
    "Cinfv": {
        "cols": [("E", 1), (f"2C{INF}({PHI})", 2), (f"{INF}\u03c3v", INF)],
        "irreps": [
            ("\u03a3\u207a", [1, 1, 1], ["z"], None, True),
            ("\u03a3\u207b", [1, 1, -1], None, ["Rz"], False),
            ("\u03a0", [2, f"2cos{PHI}", 0], ["x", "y"], ["Rx", "Ry"], True),
            ("\u0394", [2, f"2cos2{PHI}", 0], None, None, True),
        ],
    },
}


def _fmt_multiplicities(names, mult):
    parts = [f"{m if m > 1 else ''}{n}" for n, m in zip(names, mult) if m]
    return " + ".join(parts) if parts else "\u2014"


def _perp_pair(axis):
    helper = [1, 0, 0] if abs(axis[0]) < 0.9 else [0, 1, 0]
    u = _norm(_cross(axis, helper))
    v = _norm(_cross(axis, u))
    return u, v


def linear_symmetry(atoms, result, tol):
    """Operations to draw + \u0393 reduction for a linear molecule (>= 2 atoms).

    `atoms` are the parsed atoms (original coordinates); `result` is the
    classify() output already known to say group in {Dinfh, Cinfv}."""
    group = result["group"]
    R = normalize_mol(atoms)["atoms"]                    # centred on the engine's own centre
    far = max(R, key=lambda a: _len(a["p"]))
    axis = _canonical(_norm(far["p"]))
    n_atoms = len(R)
    on_centre = sum(1 for a in R if abs(_dot(a["p"], axis)) < max(tol, 0.02))
    dinfh = group == "Dinfh"
    pairs = (n_atoms - on_centre) // 2

    # ---- representative operations for the viewer -------------------------
    u, v = _perp_pair(axis)
    ops = [
        {"label": "E", "kind": "E"},
        {"label": f"C{INF} [1]", "kind": "C", "axis": axis, "n": 0, "orderLabel": INF, "angle": 180.0},
        {"label": "\u03c3v [1]", "kind": "M", "normal": u},
        {"label": "\u03c3v [2]", "kind": "M", "normal": v},
    ]
    if dinfh:
        ops += [
            {"label": "i", "kind": "i"},
            {"label": "\u03c3h", "kind": "M", "normal": axis},
            {"label": "C2' [1]", "kind": "C", "axis": u, "n": 2, "angle": 180.0},
            {"label": "C2' [2]", "kind": "C", "axis": v, "n": 2, "angle": 180.0},
            {"label": f"S{INF} [1]", "kind": "S", "axis": axis, "n": 0, "orderLabel": INF, "angle": 90.0},
        ]

    # ---- \u0393_3N by symmetry species -----------------------------------------
    T = LINEAR_TABLES[group]
    names = [ir[0] for ir in T["irreps"]]
    idx = {n: i for i, n in enumerate(names)}
    n3N = [0] * len(names)
    if dinfh:
        # each symmetric pair: z-shifts -> \u03a3g\u207a + \u03a3u\u207a, xy-shifts -> \u03a0g + \u03a0u;
        # each atom on the centre: z -> \u03a3u\u207a, xy -> \u03a0u.
        n3N[idx["\u03a3g\u207a"]] += pairs
        n3N[idx["\u03a3u\u207a"]] += pairs + on_centre
        n3N[idx["\u03a0g"]] += pairs
        n3N[idx["\u03a0u"]] += pairs + on_centre
        trans = [0] * len(names)
        trans[idx["\u03a3u\u207a"]] = 1
        trans[idx["\u03a0u"]] = 1
        rot = [0] * len(names)
        rot[idx["\u03a0g"]] = 1
    else:
        n3N[idx["\u03a3\u207a"]] = n_atoms
        n3N[idx["\u03a0"]] = n_atoms
        trans = [0] * len(names)
        trans[idx["\u03a3\u207a"]] = 1
        trans[idx["\u03a0"]] = 1
        rot = [0] * len(names)
        rot[idx["\u03a0"]] = 1
    vib = [a - b - c for a, b, c in zip(n3N, trans, rot)]

    def cf(n, body):            # "3(1+2cos\u03c6)" style, or 0 when no atom contributes
        return f"{n}({body})" if n else 0

    N = n_atoms
    if dinfh:
        chi = [3 * N, cf(N, f"1+2cos{PHI}"), N, -3 * on_centre, cf(on_centre, f"\u22121+2cos{PHI}"), -on_centre]
    else:
        chi = [3 * N, cf(N, f"1+2cos{PHI}"), N]

    class_rows = [
        {"label": lab, "size": size, "chiGamma3N": chi[j], "characters": [ir[1][j] for ir in T["irreps"]]}
        for j, (lab, size) in enumerate(T["cols"])
    ]

    # Same validation + IR/Raman-activity treatment as the finite-group
    # path (derive_representation) — linear molecules use this separate,
    # analytically-solved code path instead of the general reduce()
    # formula (there's no finite class list to sum over for an infinite
    # group), but the sanity checks and spectroscopy summary mean the
    # same thing here and are just as worth surfacing.
    dims = [ir[1][0] for ir in T["irreps"]]
    gamma3N_dim = sum(m * d for m, d in zip(n3N, dims))
    trans_dim = sum(m * d for m, d in zip(trans, dims))
    rot_dim = sum(m * d for m, d in zip(rot, dims))
    vib_dim = sum(m * d for m, d in zip(vib, dims))
    expected_dim = 3 * N
    per_irrep_ok = all(n3N[i] == trans[i] + rot[i] + vib[i] for i in range(len(n3N)))
    validation = {
        "gamma3NDimension": gamma3N_dim,
        "expectedDimension": expected_dim,
        "gamma3NMatchesAtomCount": gamma3N_dim == expected_dim,
        "transDimension": trans_dim,
        "expectedTransDimension": 3,
        "rotDimension": rot_dim,
        "expectedRotDimension": 2,  # linear molecules: only 2 rotational d.o.f. (spin about the axis isn't a real rotation)
        "vibDimension": vib_dim,
        "expectedVibDimension": expected_dim - 5,
        "decompositionConsistent": per_irrep_ok and (trans_dim + rot_dim + vib_dim == gamma3N_dim),
    }
    spectroscopy = []
    for i, ir in enumerate(T["irreps"]):
        if vib[i] <= 0:
            continue
        name, _chars, lin_tag, _rot_tag, quad_tag = ir
        spectroscopy.append({
            "irrep": name, "count": vib[i], "dimension": dims[i],
            "irActive": bool(lin_tag), "ramanActive": bool(quad_tag),
            "silent": not lin_tag and not quad_tag,
        })

    representation = {
        "h": INF, "numIrreps": len(names),
        "chi": chi, "n3N": n3N, "trans": trans, "rot": rot, "vib": vib,
        "gamma3N": _fmt_multiplicities(names, n3N),
        "gammaTrans": _fmt_multiplicities(names, trans),
        "gammaRot": _fmt_multiplicities(names, rot),
        "gammaVib": _fmt_multiplicities(names, vib),
        "classRows": class_rows,
        "validation": validation,
        "spectroscopy": spectroscopy,
        "note": (
            "A linear molecule has an infinite point group, so the table lists its classes with "
            f"angle-dependent characters (\u03c6 is the rotation angle) and \u0393\u2083\u2099 is reduced analytically: "
            f"{on_centre} atom(s) on the centre and {pairs} symmetric pair(s) give it directly "
            "(z-displacements span \u03a3 species, x/y-displacements span \u03a0 species). "
            "Only the first few irreps (\u03a3, \u03a0, \u0394) are shown; the reduction never needs higher ones."
            if dinfh else
            "A linear molecule has an infinite point group, so the table lists its classes with "
            f"angle-dependent characters (\u03c6 is the rotation angle) and \u0393\u2083\u2099 is reduced analytically: "
            "every atom lies on the axis, so each contributes one \u03a3\u207a (z) and one \u03a0 (x/y) displacement. "
            "Only the first few irreps (\u03a3, \u03a0, \u0394) are shown; the reduction never needs higher ones."
        ),
    }
    table = {
        "h": INF,
        "cols": [{"label": lab, "size": size} for lab, size in T["cols"]],
        "irreps": [{"name": n, "characters": x, "linear": lin, "rotational": rt, "quadratic": bool(qd)}
                   for n, x, lin, rt, qd in T["irreps"]],
    }
    return {
        "ops": ops, "table": table, "representation": representation,
        "rotationalOrders": [INF, 2] if dinfh else [INF],
        "mirrorCount": INF, "improperRotationCount": INF if dinfh else 0,
    }


POINT_GROUP_INFO = {
    "C1": "No symmetry at all beyond the identity — every atom is in a chemically unique position. Most real, flexible organic molecules (including nearly all drugs) land here once you look at an actual 3-D conformer.",
    "Cs": "A single mirror plane and nothing else. Common for molecules that are almost, but not quite, symmetric — e.g. a planar molecule with one substituent breaking an otherwise-present axis.",
    "Ci": "Only a center of inversion. Genuinely rare as the *full* symmetry of a real molecule (usually a higher group is also present), e.g. meso-tartaric acid in one conformation.",
    "C2": "A single 2-fold rotation axis, no mirrors. Example: hydrogen peroxide (H2O2) in its skewed gas-phase conformation.",
    "C3": "A single 3-fold rotation axis, no mirrors — chiral. Example: a propeller-twisted triarylphosphine.",
    "C4": "A single 4-fold rotation axis, no mirrors — chiral.",
    "C5": "A single 5-fold rotation axis, no mirrors — chiral.",
    "C6": "A single 6-fold rotation axis, no mirrors — chiral.",
    "C2v": "A C2 axis plus two mirror planes containing it. The classic bent-triatomic group. Example: water (H2O).",
    "C3v": "A C3 axis plus three mirror planes containing it. Example: ammonia (NH3), or any simple trigonal-pyramidal molecule.",
    "C4v": "A C4 axis plus four mirror planes. Example: a square-pyramidal molecule like BrF5, or xenon oxytetrafluoride.",
    "C5v": "A C5 axis plus five mirror planes.",
    "C6v": "A C6 axis plus six mirror planes.",
    "C2h": "A C2 axis, a mirror plane perpendicular to it, and (as a consequence) an inversion center. Example: trans-1,2-dichloroethylene.",
    "C3h": "A C3 axis with a horizontal mirror plane, no vertical mirrors. Example: boric acid B(OH)3 in its planar propeller form.",
    "C4h": "A C4 axis with a horizontal mirror plane and an inversion center.",
    "C5h": "A C5 axis with a horizontal mirror plane.",
    "C6h": "A C6 axis with a horizontal mirror plane and an inversion center.",
    "D2": "Three mutually perpendicular C2 axes, no mirrors at all — chiral. Rare as a molecule's full symmetry (twistane is a classic example).",
    "D3": "A C3 axis plus three perpendicular C2 axes, no mirrors — chiral. Example: tris-chelate complexes like [Cr(en)3]3+.",
    "D4": "A C4 axis plus four perpendicular C2 axes, no mirrors — chiral.",
    "D5": "A C5 axis plus five perpendicular C2 axes, no mirrors — chiral.",
    "D6": "A C6 axis plus six perpendicular C2 axes, no mirrors — chiral.",
    "D2h": "D2's three perpendicular C2 axes plus a mirror plane perpendicular to each one, and an inversion center. Example: ethylene (C2H4).",
    "D3h": "A C3 axis, three perpendicular C2 axes, and a horizontal mirror plane (plus vertical ones). Example: boron trifluoride (BF3), or trigonal-bipyramidal PCl5.",
    "D4h": "A C4 axis, four perpendicular C2 axes, and a horizontal mirror plane. Example: square-planar XeF4 or [PtCl4]2-.",
    "D5h": "A C5 axis with a horizontal mirror plane. Example: eclipsed ferrocene, or the cyclopentadienide ion.",
    "D6h": "A C6 axis with a horizontal mirror plane. Example: benzene (C6H6).",
    "D2d": "D2's axes plus dihedral (diagonal) mirror planes instead of a horizontal one, and an S4 axis. Example: allene (H2C=C=CH2).",
    "D3d": "D3's axes with diagonal mirrors and an S6 axis, no horizontal mirror. Example: staggered ethane (C2H6).",
    "D4d": "D4's axes with diagonal mirrors and an S8 axis. Example: staggered (rotated) ferrocene-type sandwich geometry.",
    "D5d": "D5's axes with diagonal mirrors and an S10 axis. Example: staggered ferrocene.",
    "D6d": "D6's axes with diagonal mirrors and an S12 axis.",
    "S4": "A single S4 improper rotation axis and nothing else (no separate mirror plane, no inversion). Example: certain spiro compounds.",
    "S6": "A single S6 improper rotation axis, equivalent to a C3 axis plus an inversion center.",
    "S8": "A single S8 improper rotation axis.",
    "T": "The pure rotation subgroup of a tetrahedron (4 C3 + 3 C2 axes), no mirrors at all — chiral. Rare; arises in some propeller-twisted tetrahedral metal complexes.",
    "Td": "Full tetrahedral symmetry — the 4 C3/3 C2 axes of T, plus 6 mirror planes and 3 S4 axes, no inversion center. Example: methane (CH4), or any regular tetrahedral AB4 molecule.",
    "Th": "T's rotation axes plus an inversion center, 3 mirror planes, and S6 axes — but not the full mirror set of Td. Uncommon; seen in some octahedral-cage/cluster compounds.",
    "O": "The pure rotation subgroup of an octahedron (3 C4 + 4 C3 + 6 C2 axes), no mirrors — chiral. Rare as a real molecule's exact symmetry.",
    "Oh": "Full octahedral symmetry. Example: sulfur hexafluoride (SF6), or any regular octahedral AB6 molecule.",
    "I": "The pure rotation subgroup of an icosahedron (6 C5 + 10 C3 + 15 C2 axes), no mirrors — chiral.",
    "Ih": "Full icosahedral symmetry, the highest symmetry commonly discussed in chemistry. Example: buckminsterfullerene (C60), or dodecahedrane.",
    "Cinfv": "Linear with no center of symmetry — one end is chemically different from the other. Example: hydrogen cyanide (HCN), or carbon monoxide (CO).",
    "Dinfh": "Linear with a center of symmetry — both ends are equivalent. Example: carbon dioxide (CO2), or any homonuclear diatomic like N2.",
}


def _tolerance_scan(atoms, base_tol, base_group):
    """A few extra tolerance passes around the one actually used, answering two
    related, high-value questions cheaply:
      - stability: does the SAME point group hold up under small tolerance
        changes, or is the classification sitting right on a knife's edge —
        a real sign the geometry is noisy/borderline rather than a clean read?
      - closest higher symmetry: would a modestly looser tolerance reveal a
        higher-symmetry idealized structure this one is close to? Exactly the
        situation with a real (e.g. PubChem-optimized) geometry that's a
        slightly-distorted version of some textbook-symmetric shape.
    Bounded to modest atom counts and at most 3 extra detect_operations calls,
    so it stays cheap even though each call itself isn't free.
    """
    n_atoms = len(atoms)
    # Was `> 50`. The extra passes are up to 3 more full detect_operations()
    # calls on top of the one analyze() already did -- cheap on genuinely
    # small teaching molecules (water, benzene, SF6...) but for a 40-atom,
    # Ih-symmetry structure like dodecahedrane this was measured taking the
    # request from ~4s to ~15s+ (and considerably more under Render's
    # slower/shared CPU), which is what was actually behind the "PubChem
    # fetch hangs on Dodecahedrane/adamantane" reports -- not a network
    # issue at all, just this doing 4x the work for anything past a modest
    # atom count. Lowered to 20 so it still runs for every demo/teaching
    # molecule (all well under 20 atoms) but skips itself -- losing only the
    # toleranceStable / closestHigherSymmetry diagnostics, not the point
    # group itself -- for larger structures where it was the actual cost.
    if n_atoms > 20 or base_tol <= 0:
        return {"stable": None, "closestHigherSymmetry": None}
    base_order = expected_order(base_group)
    if isinstance(base_order, str):  # linear molecules use a separate analytic path
        return {"stable": None, "closestHigherSymmetry": None}

    tighter = detect_operations(atoms, max(0.001, base_tol * 0.5))
    looser2 = detect_operations(atoms, min(0.6, base_tol * 2))
    stable = (tighter["group"] == base_group) and (looser2["group"] == base_group)

    closest = None
    for r, mult in ((looser2, 2), (None, 4)):
        t = min(0.6, base_tol * mult)
        if r is None:
            r = detect_operations(atoms, t)
        order = expected_order(r["group"])
        if not isinstance(order, str) and r["group"] != base_group and order > base_order:
            closest = {
                "group": r["group"],
                "groupPretty": pretty(r["group"]),
                "toleranceNeeded": round(t, 4),
                "maxErrorAtThatTolerance": round(r.get("maxError", 0), 4),
            }
            break
    return {"stable": stable, "closestHigherSymmetry": closest}

def analyze(text, tol=TOL_DEFAULT):
    tol = max(0.001, min(1, tol or TOL_DEFAULT))
    parsed = parse_structure(text)
    result = detect_operations(parsed["atoms"], tol)
    formula = {}
    for a in parsed["atoms"]:
        formula[a["el"]] = formula.get(a["el"], 0) + 1
    result["formula"] = formula
    # Linear molecules (infinite point group) take a dedicated analytic path — see
    # linear_symmetry() above — instead of the finite-group operation search.
    lin = linear_symmetry(parsed["atoms"], result, tol) if (result["linear"] and len(parsed["atoms"]) >= 2) else None
    deriv = {"ops": lin["ops"], "T": None, "analysis": None} if lin else derive_representation(parsed["atoms"], result)
    center = _center(parsed["atoms"])
    tol_scan = _tolerance_scan(parsed["atoms"], tol, result["group"])

    response = {
        "group": result["group"],
        "groupPretty": pretty(result["group"]),
        "formula": formula,
        "formulaPretty": pretty_formula(formula),
        "expectedOrder": expected_order(result["group"]),
        "detectedOps": len(lin["ops"]) if lin else result["ops"],
        "orderLabel": INF if lin else None,   # infinite groups: the UI shows this instead of "n / expected"
        "tolerance": tol,
        "inversion": result["inv"],
        "mirrorCount": lin["mirrorCount"] if lin else result["refl"],
        "improperRotationCount": lin["improperRotationCount"] if lin else result["improRot"],
        "rotationalOrders": lin["rotationalOrders"] if lin else result["unique"],
        "linear": result["linear"],
        "maxError": round(result.get("maxError", 0), 5),
        # Symmetry score: how cleanly the detected operations actually held,
        # relative to how much slack the tolerance allowed. 100% means every
        # matched atom landed essentially exactly on its symmetry-equivalent
        # position (maxError \u2248 0); it falls toward 0% as the worst-matching
        # detected operation approaches the tolerance limit itself — i.e. a
        # low score doesn't mean "wrong point group", it means "this
        # geometry is noisy/distorted enough that some of what's reported
        # is close to being a coin flip at this tolerance."
        "symmetryScore": round(max(0.0, 100.0 * (1 - result.get("maxError", 0) / tol)), 1),
        "distortionWarning": (
            f"This structure is a bit rough: the worst-matching detected symmetry element is off by "
            f"{round(result.get('maxError', 0), 3)} \u00c5, which is over half your {tol} \u00c5 tolerance. "
            "The point group is probably still right, but a couple of the finer operations "
            "(especially higher-order axes or mirrors) could be borderline — try a stricter "
            "tolerance to see if the same group holds up, or use a cleaner/idealized geometry if you have one."
            if (not result.get("linear")) and tol > 0 and result.get("maxError", 0) > 0.5 * tol
            else None
        ),
        "groupDescription": POINT_GROUP_INFO.get(result["group"]),
        # Tolerance-scan diagnostics: is this classification stable under
        # small tolerance changes, and — separately — is there a
        # higher-symmetry idealized point group this geometry is a close,
        # slightly-distorted version of? Both None for linear molecules and
        # for larger structures where the extra passes aren't worth the cost.
        "toleranceStable": tol_scan["stable"],
        "closestHigherSymmetry": tol_scan["closestHigherSymmetry"],
        "atomCount": len(parsed["atoms"]),
        "bondCount": len(parsed["bonds"]),
        "atoms": [{"el": a["el"], "x": a["p"][0], "y": a["p"][1], "z": a["p"][2]} for a in parsed["atoms"]],
        "bonds": [[b[0], b[1]] for b in parsed["bonds"]],
        # Mass-weighted centroid of the *original* (untranslated) coordinates
        # above, so the frontend can place axis/plane overlays without having
        # to recompute a center-of-mass itself (and risk it disagreeing with
        # the one the engine used internally to find these operations).
        "center": {"x": center[0], "y": center[1], "z": center[2]},
        "operations": [
            {
                "label": o["label"],
                "kind": o["kind"],
                # Direction vectors only (unaffected by the translate-only
                # normalization used internally), so these line up directly
                # with the "atoms"/"center" coordinates above. C/S carry an
                # axis, M carries a plane normal; E/i need neither (i is
                # symmetric about "center" itself).
                **({"axis": o["axis"]} if "axis" in o else {}),
                **({"normal": o["normal"]} if "normal" in o else {}),
                **({"n": o["n"]} if "n" in o else {}),
                # Real rotation angle (see _op_angle_deg) — lets the
                # frontend animate Cn^k / Sn^k operations at their actual
                # angle instead of assuming k=1's angle for every power.
                **({"angle": o["angle"]} if "angle" in o else {}),
                **({"orderLabel": o["orderLabel"]} if "orderLabel" in o else {}),
            }
            for o in deriv["ops"]
        ],
        "characterTable": None,
        "representation": None,
        # Why this point group, step by step — built inline in classify()
        # itself as each decision is made, not reconstructed afterward, so
        # it can't drift out of sync with the actual classification logic.
        "decisionTrace": result.get("decisionTrace", []),
        # Symmetry tests that were tried and failed, closest-miss first —
        # e.g. "C4 rejected: closest candidate off by 0.42 \u00c5" — for
        # operations that never passed on *any* candidate axis/plane.
        "rejectedTests": result.get("rejectedTests", []),
    }
    if deriv.get("T"):
        response["characterTable"] = {
            "h": deriv["T"]["h"],
            "cols": [{"label": c["label"], "size": c["g"]} for c in deriv["T"]["cols"]],
            "irreps": [{"name": ir["n"], "characters": ir["x"], "linear": ir.get("lin"), "rotational": ir.get("rot")}
                       for ir in deriv["T"]["irreps"]],
        }
    if lin:
        response["characterTable"] = lin["table"]
        response["representation"] = lin["representation"]
    elif deriv.get("analysis"):
        response["representation"] = deriv["analysis"]
    elif deriv.get("error"):
        response["representationError"] = deriv["error"]
    return response