"""Finds the distinct conformers of an organic molecule, including the ones PubChem does not list.

PubChem only stores low-energy minima, and often just one of them. Teaching-wise that hides half the
story (ethane has a staggered *and* an eclipsed form, cyclohexane has chair, twist-boat, boat and
half-chair), so this module works the conformers out itself with RDKit + MMFF94:

  * exactly one real rotor bond, no flexible ring (sp3-sp3, or conjugated like butadiene / biphenyl /
    styrene)                               -> 5-degree torsion scan. Every energy minimum AND every
                                               maximum (the eclipsed / syn / anticlinal forms, which are
                                               transition states) becomes a conformer.
  * a lone saturated six-membered ring     -> ETKDG ensemble (chair, twist-boat, axial/equatorial ...) plus
                                               constrained boat and half-chair templates.
  * a lone saturated five-membered ring    -> envelope and twist templates (bare ring) or an ensemble
                                               (substituted ring).
  * anything else that is flexible         -> ETKDG ensemble, minima only (pentane: TT, TG+, G+G- ...).

Everything is best-effort: anything unsupported (metals, salts, rare elements, very floppy molecules)
returns None and the caller keeps whatever it already had. Never raises.
"""
from __future__ import annotations

import logging
import math
import re

import numpy as np

logger = logging.getLogger(__name__)

try:  # RDKit is already a hard dependency of structure_builder, but stay defensive
    from rdkit import Chem
    from rdkit.Chem import AllChem, rdMolAlign, rdMolTransforms
    from rdkit import RDLogger

    RDLogger.DisableLog("rdApp.*")
    _HAVE_RDKIT = True
except Exception:  # noqa: BLE001
    _HAVE_RDKIT = False

from .conformer_naming import name_conformer

_KCAL_TO_KJ = 4.184
_SCAN_STEP = 5              # degrees
_MAX_ATOMS = 70
_MAX_ROTORS_ENSEMBLE = 8
_MIN_BARRIER_KJ = 1.0       # flatter than this = free rotation, nothing worth naming
_TS_WINDOW_KJ = 55.0        # do not list transition states higher than this above the global minimum
_MIN_WINDOW_KJ = 25.0
_RMS_SAME = 0.12            # A, all atoms, symmetry-aware: same conformer
_RMS_SAME_HEAVY = 0.25      # A, heavy atoms only (ensemble path)
_MAX_OUT = 8


# ---------------------------------------------------------------- small helpers
def _heavy_nbrs(atom, exclude: int):
    return [n for n in atom.GetNeighbors() if n.GetIdx() != exclude and n.GetAtomicNum() > 1]


def _others(atom, exclude: int):
    return [n for n in atom.GetNeighbors() if n.GetIdx() != exclude]


def _is_trivial_top(atom, partner: int) -> bool:
    """CH3 / CF3 / NH3+ ... : three or more identical terminal atoms besides the bond partner."""
    others = _others(atom, partner)
    return (len(others) >= 3 and all(o.GetDegree() == 1 for o in others)
            and len({o.GetAtomicNum() for o in others}) == 1)


def _rotors(mol) -> list[tuple[int, int]]:
    """Non-ring single bonds between two sp3 atoms that really define different conformers."""
    out = []
    for b in mol.GetBonds():
        if b.IsInRing() or b.GetBondType() != Chem.BondType.SINGLE:
            continue
        x, y = b.GetBeginAtom(), b.GetEndAtom()
        if x.GetAtomicNum() == 1 or y.GetAtomicNum() == 1:
            continue
        ok = (Chem.HybridizationType.SP3, Chem.HybridizationType.SP2)
        if x.GetHybridization() not in ok or y.GetHybridization() not in ok:
            continue
        if x.GetDegree() < 2 or y.GetDegree() < 2:
            continue
        tx, ty = _is_trivial_top(x, y.GetIdx()), _is_trivial_top(y, x.GetIdx())
        if tx != ty:
            continue  # spinning a methyl on a bigger frame gives the same shape three times
        out.append((x.GetIdx(), y.GetIdx()))
    return out


def _is_sp2(atom) -> bool:
    return atom.GetHybridization() == Chem.HybridizationType.SP2


def _has_flexible_ring(mol) -> bool:
    """A ring that can pucker (contains an sp3 atom). Aromatic / fully unsaturated rings are rigid."""
    return any(any(mol.GetAtomWithIdx(i).GetHybridization() == Chem.HybridizationType.SP3 for i in ring)
               for ring in mol.GetRingInfo().AtomRings())


def _reference(atom, partner: int):
    """The single atom that defines this end's torsion, or None if the end has several."""
    heavy = _heavy_nbrs(atom, partner)
    if len(heavy) == 1:
        return heavy[0].GetIdx()
    others = _others(atom, partner)
    if not heavy and len(others) == 1:
        return others[0].GetIdx()
    return None


def _xyz(mol, conf_id: int, comment: str) -> str:
    conf = mol.GetConformer(conf_id)
    lines = [str(mol.GetNumAtoms()), comment]
    for a in mol.GetAtoms():
        p = conf.GetAtomPosition(a.GetIdx())
        lines.append(f"{a.GetSymbol():<2} {p.x:12.6f} {p.y:12.6f} {p.z:12.6f}")
    return "\n".join(lines) + "\n"


def _energy(mol, props, conf_id: int) -> float:
    ff = AllChem.MMFFGetMoleculeForceField(mol, props, confId=conf_id)
    return ff.CalcEnergy() * _KCAL_TO_KJ


def _stereo_smiles(mol) -> str | None:
    """Isomeric SMILES read back from the molecule's current 3-D geometry (cis/trans, R/S included)."""
    try:
        c = Chem.Mol(mol)
        Chem.AssignStereochemistryFrom3D(c)
        return Chem.MolToSmiles(Chem.RemoveHs(c))
    except Exception:  # noqa: BLE001
        return None


def _stereo_ok(mol, conf_id: int = -1) -> bool:
    """False if a constrained / random embedding turned the molecule into a different stereoisomer."""
    if not mol.HasProp("_ref"):
        return True
    single = _single(mol, conf_id) if mol.GetNumConformers() > 1 else mol
    return _stereo_smiles(single) == mol.GetProp("_ref")


def _single(mol, cid: int):
    """Copy of mol that carries only conformer `cid`."""
    c = Chem.Mol(mol)
    keep = Chem.Conformer(c.GetConformer(cid))  # copy first: RemoveAllConformers frees the original
    c.RemoveAllConformers()
    c.AddConformer(keep, assignId=True)
    return c


def _rms(mol_a, conf_a: int, mol_b, conf_b: int, heavy_only: bool) -> float:
    """Symmetry-aware RMSD (methyl spins, equivalent hydrogens ...); 99 if it cannot be computed."""
    a, b = _single(mol_a, conf_a), _single(mol_b, conf_b)
    if heavy_only:
        a, b = Chem.RemoveHs(a), Chem.RemoveHs(b)
    try:
        return float(rdMolAlign.GetBestRMS(a, b, maxMatches=20000))
    except Exception:  # noqa: BLE001
        return 99.0


# ---------------------------------------------------------------- building the molecule
def _build(sdf_text: str):
    m = Chem.MolFromMolBlock(sdf_text, removeHs=False, sanitize=True)
    if m is None:
        return None
    if len(Chem.GetMolFrags(m)) != 1:
        return None
    m = Chem.AddHs(m)
    try:  # keep cis/trans and R/S: read them off the 3-D coordinates before the conformer is thrown away
        if m.GetNumConformers() and m.GetConformer().Is3D():
            Chem.AssignStereochemistryFrom3D(m)
    except Exception:  # noqa: BLE001
        pass
    if m.GetNumAtoms() > _MAX_ATOMS or m.GetNumAtoms() < 4:
        return None
    if not AllChem.MMFFHasAllMoleculeParams(m):
        return None
    m.RemoveAllConformers()
    params = AllChem.ETKDGv3()
    params.randomSeed = 20240
    if AllChem.EmbedMolecule(m, params) != 0:
        params.useRandomCoords = True
        if AllChem.EmbedMolecule(m, params) != 0:
            return None
    if AllChem.MMFFOptimizeMolecule(m, maxIters=5000) < 0:
        return None
    ref = _stereo_smiles(m)
    if ref:
        m.SetProp("_ref", ref)
    return m


# ---------------------------------------------------------------- torsion scan (one rotor)
def _scan(mol, rotor: tuple[int, int], props):
    x, y = rotor
    ax, ay = mol.GetAtomWithIdx(x), mol.GetAtomWithIdx(y)
    a = _reference(ax, y)
    b = _reference(ay, x)
    if a is None:
        heavy = sorted(n.GetIdx() for n in _others(ax, y))
        a = heavy[0]
    if b is None:
        heavy = sorted(n.GetIdx() for n in _others(ay, x))
        b = heavy[0]
    n = 360 // _SCAN_STEP
    work = Chem.Mol(mol)
    conf = work.GetConformer()
    start = rdMolTransforms.GetDihedralDeg(conf, a, x, y, b)
    geoms: list[np.ndarray] = []
    energies: list[float] = []
    angles: list[float] = []

    def constrained_minimise(target: float) -> float:
        rdMolTransforms.SetDihedralDeg(work.GetConformer(), a, x, y, b, target)
        ff = AllChem.MMFFGetMoleculeForceField(work, props)
        ff.MMFFAddTorsionConstraint(a, x, y, b, True, -0.05, 0.05, 2000.0)
        ff.Initialize()
        ff.Minimize(maxIts=4000)
        return _energy(work, props, -1)

    for k in range(n):
        target = start + k * _SCAN_STEP
        e = constrained_minimise(target)
        geoms.append(work.GetConformer().GetPositions().copy())
        energies.append(e)
        angles.append(target)
    return work, (a, x, y, b), np.array(energies), geoms, angles, constrained_minimise


def _with_positions(mol, pos: np.ndarray):
    m = Chem.Mol(mol)
    conf = m.GetConformer()
    for i in range(m.GetNumAtoms()):
        conf.SetAtomPosition(i, [float(v) for v in pos[i]])
    return m


def _dedupe_minima(cands):
    kept = []
    for e, kind, m in sorted(cands, key=lambda t: t[0]):
        if kind == "minimum" and any(
            k2 == "minimum" and abs(e - e2) < 0.6 and _rms(m, -1, m2, -1, heavy_only=False) < _RMS_SAME
            for e2, k2, m2 in kept
        ):
            continue
        kept.append((e, kind, m))
    return kept


def _cluster_by_torsion(items, torsion, keep_low: bool, window: float = 25.0):
    """Keeps one candidate per torsion neighbourhood (lowest energy for minima, highest for maxima).
    Soft side-chain modes (methyl spins ...) make a scan of a stiff conjugated bond throw up extra
    near-duplicate extrema at the same torsion; this folds them back together."""
    kept, angles = [], []
    for e, kind, m in sorted(items, key=lambda t: t[0], reverse=not keep_low):
        phi = torsion(m)
        if any(min(abs(phi - q), 360.0 - abs(phi - q)) < window for q in angles):
            continue
        kept.append((e, kind, m))
        angles.append(phi)
    return kept


def _strip_paren(name: str) -> str:
    return re.sub(r"\s*\(.*?\)\s*$", "", name)


def _dihedral_name(signed: float) -> str:
    phi = abs(signed)
    sign = "+" if signed > 0 else "\u2212"
    if phi >= 150:
        return "Anti"
    if phi >= 90:
        return f"Anticlinal{sign}"
    if phi >= 30:
        return f"Gauche{sign}"
    return "Syn"


def _scan_conformers(mol, rotor, props):
    work, (a, x, y, b), energies, geoms, angles, redo = _scan(mol, rotor, props)
    n = len(energies)
    emin, emax = float(energies.min()), float(energies.max())
    if emax - emin < _MIN_BARRIER_KJ:
        return None
    eps = 1e-3
    minima, maxima = [], []
    for i in range(n):
        lo, hi, e = energies[(i - 1) % n], energies[(i + 1) % n], energies[i]
        if e <= lo + eps and e <= hi + eps and (e < lo - eps or e < hi - eps):
            minima.append(i)
        if e >= lo - eps and e >= hi - eps and (e > lo + eps or e > hi + eps):
            maxima.append(i)
    if not minima or not maxima:
        return None

    both_refs = _reference(mol.GetAtomWithIdx(x), y) is not None and _reference(mol.GetAtomWithIdx(y), x) is not None
    cands = []  # (energy, kind, mol, comment)

    for i in minima:
        m = _with_positions(work, geoms[i])
        AllChem.MMFFOptimizeMolecule(m, maxIters=5000)
        cands.append((_energy(m, props, -1), "minimum", m))
    for i in maxima:
        # refine the top of the barrier with a 1-degree scan either side
        best_e, best_pos = energies[i], geoms[i]
        tmp = _with_positions(work, geoms[i])
        tw = tmp
        start = angles[i]
        for d in range(-_SCAN_STEP, _SCAN_STEP + 1):
            if d == 0:
                continue
            rdMolTransforms.SetDihedralDeg(tw.GetConformer(), a, x, y, b, start + d)
            ff = AllChem.MMFFGetMoleculeForceField(tw, props)
            ff.MMFFAddTorsionConstraint(a, x, y, b, True, -0.05, 0.05, 2000.0)
            ff.Initialize()
            ff.Minimize(maxIts=4000)
            e = _energy(tw, props, -1)
            if e > best_e:
                best_e, best_pos = e, tw.GetConformer().GetPositions().copy()
        cands.append((best_e, "transition state", _with_positions(work, best_pos)))

    if _is_sp2(mol.GetAtomWithIdx(x)) or _is_sp2(mol.GetAtomWithIdx(y)):
        def tors(m):
            return rdMolTransforms.GetDihedralDeg(m.GetConformer(), a, x, y, b)
        mins = _cluster_by_torsion([c for c in cands if c[1] == "minimum"], tors, True)
        tss = _cluster_by_torsion([c for c in cands if c[1] != "minimum"], tors, False)
        min_angles = [tors(c[2]) for c in mins]
        # a real barrier sits BETWEEN minima; an "extremum" on top of a minimum is a side-chain flip
        tss = [c for c in tss
               if all(min(abs(tors(c[2]) - q), 360.0 - abs(tors(c[2]) - q)) >= 25.0 for q in min_angles)]
        cands = mins + tss

    # drop symmetry-equivalent repeats (3 staggered ethane minima are one conformer)
    kept: list[tuple[float, str, object]] = []
    for e, kind, m in cands:
        dup = False
        for e2, k2, m2 in kept:
            if k2 == kind and abs(e - e2) < 0.5 and _rms(m, -1, m2, -1, heavy_only=False) < _RMS_SAME:
                dup = True
                break
        if not dup:
            kept.append((e, kind, m))
    return kept, emin


# ---------------------------------------------------------------- ensemble (minima)
def _ensemble(mol, props, n_confs: int):
    m = Chem.Mol(mol)
    m.RemoveAllConformers()
    params = AllChem.ETKDGv3()
    params.randomSeed = 20240
    params.pruneRmsThresh = 0.2
    cids = list(AllChem.EmbedMultipleConfs(m, numConfs=n_confs, params=params))
    if len(cids) < 2:
        return []
    res = AllChem.MMFFOptimizeMoleculeConfs(m, maxIters=3000)
    data = sorted(((res[i][1] * _KCAL_TO_KJ, cid) for i, cid in enumerate(cids)))
    emin = data[0][0]
    kept: list[tuple[float, str, object]] = []
    for e, cid in data:
        if e - emin > _MIN_WINDOW_KJ:
            break
        if not _stereo_ok(m, cid):
            continue
        if any(_rms(m, cid, m2, -1, heavy_only=True) < _RMS_SAME_HEAVY for _, _, m2 in kept):
            continue
        kept.append((e, "minimum", _single(m, cid)))
    return kept


# ---------------------------------------------------------------- six-ring templates (boat, half-chair)
_RING_TEMPLATES = {
    "Boat": ([0, 60, -60, 0, 60, -60], "transition state"),
    "Half-chair": ([0, 15, -45, 60, -45, 15], "transition state"),
    # both chair forms: for a substituted ring they are the ring-flip pair (eq,eq <-> ax,ax)
    "Chair": ([55, -55, 55, -55, 55, -55], "minimum"),
    "Chair ": ([-55, 55, -55, 55, -55, 55], "minimum"),
}


def _saturated_ring(mol, size: int):
    ri = mol.GetRingInfo()
    if ri.NumRings() != 1:
        return None
    ring = list(ri.AtomRings()[0])
    if len(ring) != size:
        return None
    if any(mol.GetAtomWithIdx(i).GetHybridization() != Chem.HybridizationType.SP3 for i in ring):
        return None
    return ring


def _ring_template_conformers(mol, ring, props):
    out = []
    for label, (tors, kind) in _RING_TEMPLATES.items():
        label = label.strip()
        for attempt in range(6):  # a few restarts: the constrained embedding occasionally lands on the mirror
            m = Chem.Mol(mol)
            m.RemoveAllConformers()
            p = AllChem.ETKDGv3()
            p.randomSeed = 7 + attempt
            if AllChem.EmbedMolecule(m, p) != 0:
                continue
            ff = AllChem.MMFFGetMoleculeForceField(m, props)
            for k in range(6):
                i, j, l, n2 = (ring[(k + t) % 6] for t in range(4))
                ff.MMFFAddTorsionConstraint(i, j, l, n2, False, tors[k] - 2.0, tors[k] + 2.0, 800.0)
            ff.Initialize()
            ff.Minimize(maxIts=20000)
            if kind == "minimum":  # relax first: the template only seeds the right chair
                AllChem.MMFFOptimizeMolecule(m, maxIters=5000)
            named = name_conformer(_parsed(m))
            if named and _strip_paren(named["name"]).startswith(label.split("-")[0]) and _stereo_ok(m):
                out.append((_energy(m, props, -1), kind, m))
                break
    return out


def _five_ring_template_conformers(mol, ring, props):
    """Envelope (P = 18 deg) and twist (P = 0 deg) of a bare cyclopentane-type ring (Altona-Sundaralingam)."""
    out = []
    for label, phase in (("Envelope", 18.0), ("Twist", 0.0)):
        tors = [40.0 * math.cos(math.radians(phase + 144.0 * (j - 2))) for j in range(5)]
        for attempt in range(6):
            m = Chem.Mol(mol)
            m.RemoveAllConformers()
            p = AllChem.ETKDGv3()
            p.randomSeed = 11 + attempt
            if AllChem.EmbedMolecule(m, p) != 0:
                continue
            ff = AllChem.MMFFGetMoleculeForceField(m, props)
            for k in range(5):
                i, j, l, n2 = (ring[(k + t) % 5] for t in range(4))
                ff.MMFFAddTorsionConstraint(i, j, l, n2, False, tors[k] - 2.0, tors[k] + 2.0, 800.0)
            ff.Initialize()
            ff.Minimize(maxIts=20000)
            named = name_conformer(_parsed(m))
            if named and named["name"].startswith(label) and _stereo_ok(m):
                out.append((_energy(m, props, -1), "minimum", m))
                break
    return out


def _parsed(mol) -> dict:
    conf = mol.GetConformer()
    atoms = []
    for a in mol.GetAtoms():
        p = conf.GetAtomPosition(a.GetIdx())
        atoms.append({"el": a.GetSymbol(), "p": [p.x, p.y, p.z]})
    return {"atoms": atoms, "bonds": [(b.GetBeginAtomIdx(), b.GetEndAtomIdx()) for b in mol.GetBonds()]}


# ---------------------------------------------------------------- public
def find_conformers(sdf_text: str) -> dict | None:
    """Returns {"mode": "scan"|"ring"|"ensemble", "conformers": [...]} or None.

    Each conformer: {"structure": xyz text, "relEnergyKJ": float, "kind": "minimum"|"transition state",
                     "name": str | None, "detail": str | None}, minima first (lowest energy first),
    then transition states. Energies are MMFF94, relative to the lowest minimum.
    """
    if not _HAVE_RDKIT:
        return None
    try:
        mol = _build(sdf_text)
        if mol is None:
            return None
        props = AllChem.MMFFGetMoleculeProperties(mol)
        if props is None:
            return None
        rotors = _rotors(mol)
        ring = _saturated_ring(mol, 6)
        ring5 = _saturated_ring(mol, 5)
        has_ring = mol.GetRingInfo().NumRings() > 0
        bare5 = ring5 is not None and all(a.GetDegree() <= 4 and (a.GetIdx() in ring5 or a.GetAtomicNum() == 1)
                                          for a in mol.GetAtoms())

        if len(rotors) == 1 and not _has_flexible_ring(mol):
            scanned = _scan_conformers(mol, rotors[0], props)
            if not scanned:
                return None
            cands, emin = scanned
            mode = "scan"
        elif ring is not None and not rotors:
            cands = _ensemble(mol, props, 40)
            cands += [c for c in _ring_template_conformers(mol, ring, props)]
            mode = "ring"
        elif bare5 and not rotors:
            cands = _five_ring_template_conformers(mol, ring5, props)
            mode = "ring"
        elif 2 <= len(rotors) <= _MAX_ROTORS_ENSEMBLE or (has_ring and rotors) or (ring5 is not None and not bare5):
            cands = _ensemble(mol, props, 12 + 10 * min(len(rotors), 5))
            mode = "ensemble"
        else:
            return None
        if not cands:
            return None
        cands = _dedupe_minima(cands)

        emin = min(e for e, k, _ in cands if k == "minimum") if any(k == "minimum" for _, k, _ in cands) else min(e for e, _, _ in cands)
        ordered = sorted(cands, key=lambda t: (t[1] != "minimum", t[0]))
        n_min = sum(1 for _, k, _ in ordered if k == "minimum")
        rows = []
        for e, kind, m in ordered:
            rel = e - emin
            if kind == "transition state" and rel > _TS_WINDOW_KJ:
                continue
            named = None
            try:
                named = name_conformer(_parsed(m))
            except Exception:  # noqa: BLE001
                named = None
            name = named["name"] if named else None
            detail = named["detail"] if named else None
            if name is None and mode == "scan":
                # rotors name_conformer does not cover (ethanol's C-O, conjugated or ring-ring bonds)
                name, detail = _generic_rotor_name(m, rotors[0], kind)
            rows.append([e, kind, m, name, detail])
        # a name shared by several chips says nothing (ibuprofen: eight "Staggered"): leave those unnamed
        for kd in ("minimum", "transition state"):
            counts: dict = {}
            for r in rows:
                if r[1] == kd and r[3]:
                    counts[r[3]] = counts.get(r[3], 0) + 1
            for r in rows:
                if r[1] == kd and r[3] and counts[r[3]] > 1:
                    r[3] = None
        out = []
        for e, kind, m, name, detail in rows:
            rel = e - emin
            if name and kind == "transition state":
                name = f"{_strip_paren(name)} (transition state)"
                detail = (detail + " \u2013 " if detail else "") + "a saddle point between minima, not a stable structure"
            out.append({
                "structure": _xyz(m, -1, f"MMFF94 {kind}, rel. {rel:.2f} kJ/mol"),
                "relEnergyKJ": round(float(max(rel, 0.0)), 2),
                "kind": kind,
                "name": name,
                "detail": detail,
            })
        out = out[:_MAX_OUT]
        if len(out) < 2 or (n_min < 2 and mode == "ensemble"):
            return None
        return {"mode": mode, "conformers": out}
    except Exception:  # noqa: BLE001
        logger.info("conformer_search failed", exc_info=True)
        return None


def _end_reference(m, atom, partner: int):
    """(reference atom index, kind) for one end of a rotor.
    kind: "single" (unique substituent), "carbonyl" (the C=O oxygen of an acid / amide / ester carbon)
          or "twofold" (flat centre with two equivalent substituents, e.g. an aryl carbon)."""
    ref = _reference(atom, partner)
    if ref is not None:
        return ref, "single"
    heavy = _heavy_nbrs(atom, partner)
    if _is_sp2(atom) and len(heavy) == 2:
        for h in heavy:
            if h.GetAtomicNum() == 8 and h.GetDegree() == 1:
                return h.GetIdx(), "carbonyl"
        if heavy[0].GetAtomicNum() == heavy[1].GetAtomicNum():
            return min(h.GetIdx() for h in heavy), "twofold"
    return None, None


def _generic_rotor_name(m, rotor, kind):
    """Names a rotor name_conformer does not cover: heteroatom ends (ethanol), conjugated bonds
    (s-trans / s-cis butadiene, acids), flat-ring bonds (biphenyl, styrene, phenol, anisole)."""
    try:
        x, y = rotor
        ax, ay = m.GetAtomWithIdx(x), m.GetAtomWithIdx(y)
        conj = _is_sp2(ax) or _is_sp2(ay)
        a, ka = _end_reference(m, ax, y)
        b, kb = _end_reference(m, ay, x)
        if a is None or b is None:
            return None, None
        conf = m.GetConformer()
        sy = m.GetAtomWithIdx
        phi = rdMolTransforms.GetDihedralDeg(conf, a, x, y, b)
        detail = f"{sy(a).GetSymbol()}\u2013{sy(x).GetSymbol()}\u2013{sy(y).GetSymbol()}\u2013{sy(b).GetSymbol()} dihedral {phi:+.0f}\u00b0"
        if "twofold" in (ka, kb):
            fold = ((phi + 90.0) % 180.0) - 90.0           # (-90, 90]: 2-fold symmetric, handedness kept
            detail = f"twist about the {sy(x).GetSymbol()}\u2013{sy(y).GetSymbol()} bond {fold:+.0f}\u00b0 (0\u00b0 = coplanar, 90\u00b0 = perpendicular)"
            if abs(fold) <= 10:
                return "Planar", detail
            if abs(fold) >= 80:
                return "Perpendicular", detail
            return "Twisted" + ("+" if fold > 0 else "\u2212"), detail
        sign = "+" if phi > 0 else "\u2212"
        if "carbonyl" in (ka, kb):
            return ("s-cis (Z)" if abs(phi) <= 90 else "s-trans (E)"), detail
        if conj:
            if abs(phi) >= 150:
                return "s-trans", detail
            if abs(phi) <= 30:
                return "s-cis", detail
            if 80 <= abs(phi) <= 100 or (kind == "transition state" and 60 <= abs(phi) <= 120):
                return f"Perpendicular{sign}", detail
            return f"Skew{sign}", detail
        name = _dihedral_name(phi)
        if kind == "minimum":
            name += " (staggered)"
        return name, detail
    except Exception:  # noqa: BLE001
        return None, None