"""Builds a real 3-D structure when PubChem only has a flat 2-D depiction.

PubChem does not have a 3-D conformer for every compound (organometallics
such as ferrocene, salts, larger or very flexible molecules are the usual
gaps), and its 2-D fallback has every atom at z=0, which makes any symmetry
analysis meaningless. Instead of giving up, we generate the geometry
ourselves from the connectivity that 2-D record still carries:

  1. RDKit + MMFF94   -- ordinary organic / main-group molecules.
                         ETKDG distance geometry, several conformers when the
                         molecule is flexible, lowest MMFF energy wins.
  2. GFN2-xTB (tblite) -- everything RDKit's force fields cannot describe
                         reliably: metals and organometallics (ferrocene),
                         hypervalent centres (SF6, XeF4, PF5), ion pairs,
                         disconnected fragments. RDKit supplies a rough
                         starting geometry, xTB relaxes it to a real minimum.
                         Several random starts are tried and the lowest energy
                         one is kept.

Both are free, pip-installable and need no external binaries or network.

Public API:
    generate_3d(sdf_text) -> Generated      (raises GenerationError on failure)

A C++ call (RDKit embedding, MMFF) cannot be interrupted from inside a Python
thread, so anything that could plausibly run long -- large, ring-rich or
cage-like molecules, judged by size and ring count only, never by name -- runs
in a child process that is killed when its time budget expires. Small
molecules stay in-process (no start-up cost). Every long Python loop also
enforces its own wall-clock budget.
"""
from __future__ import annotations

import hashlib
import math
import multiprocessing
import threading
import time
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np
from scipy.optimize import linear_sum_assignment
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, rdMolDescriptors

from .logging_config import get_logger

logger = get_logger(__name__)
RDLogger.DisableLog("rdApp.*")

# ---------------------------------------------------------------- limits
MAX_ATOMS_RDKIT = 150        # organic path
MAX_ATOMS_XTB = 70           # xTB path (cost grows quickly with size)
RDKIT_LIGHT_BUDGET_S = 30.0  # RDKit stage, small molecule (in-process)
RDKIT_HEAVY_BUDGET_S = 32.0  # RDKit stage, heavy molecule (killable child). MMFF-capable
                             # molecules have no cheap fallback, so this gets most of the time.
GENERATION_TOTAL_S = 40.0    # whole pipeline; the frontend gives up at 45 s in total
XTB_BUDGET_S = 30.0          # max for all xTB starts together (shrinks if RDKit used time)
# Child-process start-up allowance. "fork" reuses the already-imported RDKit/numpy
# (near-instant); "spawn" must re-import everything, which is slow on a small CPU.
_CHILD_START_METHOD = "fork" if "fork" in multiprocessing.get_all_start_methods() else "spawn"
SPAWN_SLACK_S = 2.0 if _CHILD_START_METHOD == "fork" else 6.0
# Symmetry refinement of force-field geometries (rigid molecules only, see _refine_by_graph).
SYM_REFINE_MAX_RESIDUAL = 0.45      # A: a graph symmetry counts as real if the best rigid motion fits within this
SYM_REFINE_MAX_SHIFT = 0.35         # A: refuse if any atom would move further than this
SYM_REFINE_MAX_BOND_CHANGE = 0.25   # A: refuse if any bond length would change by more than this
SYM_REFINE_MAX_AUTOS = 480          # more skeleton automorphisms than this => degenerate graph, skip
SYM_REFINE_ITERS = 6
SYM_REFINE_MIN_SKELETON = 3         # need a skeleton this big to define a rigid motion
SYM_REFINE_MAX_ATOMS = 150
SYM_REFINE_MIN_S = 2.0              # don't even start with less time than this left
HEAVY_ATOMS = 24             # heavy atoms above this -> run risky stages in a killable child
HEAVY_RINGS = 3              # ring count above this  -> same (cages / fused polycycles)
COMPLEX_SEEDS_PER_TEMPLATE = 5   # different ligand-ring puckerings tried for a metal complex
XTB_STARTS = 4               # random starting geometries tried
XTB_MAX_STEPS = 600
XTB_CONVERGED_GMAX = 5e-4    # Hartree/Bohr: max |gradient| at the final point that counts as a relaxed minimum
XTB_GTOL = 2e-5              # Hartree/Bohr -- tight, so flat torsions (ferrocene rings) settle
RANDOM_SEED = 0xF00D

# Elements the MMFF/ETKDG path handles well. Anything else goes to xTB.
_ORGANIC = {"H", "B", "C", "N", "O", "F", "Si", "P", "S", "Cl", "Br", "I"}
_BOHR = 0.529177210903  # Angstrom per Bohr


class GenerationError(Exception):
    """No trustworthy 3-D geometry could be built. Message is user-facing."""


@dataclass
class Generated:
    text: str      # structure text the symmetry engine can parse (SDF or XYZ)
    fmt: str       # "sdf" | "xyz"
    method: str    # "rdkit" | "xtb"
    note: str      # one line for the UI
    converged: bool = True  # False = xTB returned its best point but the optimisation never converged
    # Other distinct relaxed minima found along the way (coordination complexes only), lowest energy
    # first, INCLUDING the one in `text`: [{"text": xyz, "energy": Eh, "relKJ": kJ/mol above the lowest}]
    alternatives: list = field(default_factory=list)


# ---------------------------------------------------------------- parsing
def _mol_from_sdf(sdf_text: str) -> Chem.Mol:
    """PubChem SDF -> RDKit Mol with explicit hydrogens. Tolerates the odd
    valences/charges organometallic records tend to have."""
    mol = Chem.MolFromMolBlock(sdf_text, removeHs=False, sanitize=True)
    if mol is None:
        mol = Chem.MolFromMolBlock(sdf_text, removeHs=False, sanitize=False)
        if mol is None:
            raise GenerationError("Could not read the compound's connectivity from PubChem.")
        Chem.SanitizeMol(
            mol,
            sanitizeOps=Chem.SANITIZE_ALL ^ Chem.SANITIZE_PROPERTIES ^ Chem.SANITIZE_KEKULIZE,
            catchErrors=True,
        )
        mol.UpdatePropertyCache(strict=False)
    if mol.GetNumAtoms() == 0:
        raise GenerationError("PubChem's record for this compound has no atoms.")
    # Some records ship without hydrogens; the geometry needs them.
    if not any(a.GetAtomicNum() == 1 for a in mol.GetAtoms()):
        mol = Chem.AddHs(mol, addCoords=False)
    mol.RemoveAllConformers()
    return mol


def _symbols(mol: Chem.Mol) -> set[str]:
    return {a.GetSymbol() for a in mol.GetAtoms()}


def _needs_xtb(mol: Chem.Mol) -> str | None:
    """Reason string if this molecule should skip the force-field path."""
    if not _symbols(mol) <= _ORGANIC:
        return "contains elements MMFF does not cover (metals / heavier main-group)"
    if len(Chem.GetMolFrags(mol)) > 1:
        return "several separate fragments (salt / ion pair / complex)"
    if any(a.GetDegree() > 4 for a in mol.GetAtoms()):
        return "hypervalent centre"
    return None


# ---------------------------------------------------------------- RDKit path
def _is_heavy(mol: Chem.Mol) -> bool:
    """Size/ring-complexity test for "embedding this might take very long":
    many heavy atoms, or many rings (fused polycycles, cages, fullerenes)."""
    try:
        n_rings = rdMolDescriptors.CalcNumRings(mol)
    except Exception:
        n_rings = 0
    return mol.GetNumHeavyAtoms() > HEAVY_ATOMS or n_rings > HEAVY_RINGS


def _embed(mol: Chem.Mol, n_confs: int, seed: int, random_coords: bool, plain_dg: bool = False,
           max_iter: int = 200) -> list[int]:
    params = AllChem.ETKDGv3()
    params.randomSeed = seed
    params.useRandomCoords = random_coords
    if plain_dg:
        # Plain distance geometry: no torsion/knowledge terms. Less pretty for
        # flexible chains, but far more robust for strained ring systems.
        params.useExpTorsionAnglePrefs = False
        params.useBasicKnowledge = False
    params.numThreads = 1
    params.maxIterations = max_iter
    return list(AllChem.EmbedMultipleConfs(mol, n_confs, params))


def _embed_bounded(mol: Chem.Mol, n_confs: int, seed: int, random_coords: bool, plain_dg: bool,
                   deadline: float) -> list[int]:
    """Embedding as many SHORT calls (a few attempts each) instead of one long,
    uninterruptible one: distance-geometry is a randomised search, so restarting
    with fresh seeds is as good as one long run, and the clock is checked
    between calls."""
    k = 0
    while time.monotonic() < deadline:
        ids = _embed(mol, n_confs, seed + 7919 * k, random_coords, plain_dg, max_iter=8)
        if ids:
            return ids
        k += 1
    return []


def _mmff_relax(work: Chem.Mol, ids: list[int], deadline: float) -> tuple[list[int], list[float]]:
    """MMFF-minimise each conformer in short chunks, stopping at the deadline.
    Returns the conformer ids that were processed and their energies."""
    props = AllChem.MMFFGetMoleculeProperties(work)
    if props is None:
        raise GenerationError("No force-field parameters for this molecule.")
    done, energies = [], []
    for cid in ids:
        if done and time.monotonic() > deadline:
            break
        ff = AllChem.MMFFGetMoleculeForceField(work, props, confId=cid)
        if ff is None:
            continue
        ff.Initialize()
        for _ in range(16):  # up to 16 x 500 = 8000 iterations, clock checked per chunk
            if ff.Minimize(maxIts=500) == 0 or time.monotonic() > deadline:
                break
        done.append(cid)
        energies.append(float(ff.CalcEnergy()))
    return done, energies


def _rdkit_build(mol: Chem.Mol, budget: float = RDKIT_LIGHT_BUDGET_S) -> Generated:
    started = time.monotonic()
    deadline = started + budget
    if mol.GetNumAtoms() > MAX_ATOMS_RDKIT:
        raise GenerationError(f"Too large to build a 3-D structure automatically ({mol.GetNumAtoms()} atoms).")
    if not AllChem.MMFFHasAllMoleculeParams(mol):
        raise GenerationError("No force-field parameters for this molecule.")

    heavy = _is_heavy(mol)
    n_rot = rdMolDescriptors.CalcNumRotatableBonds(mol)
    n_confs = 1 if n_rot == 0 else min(30, 6 + 4 * n_rot)
    if heavy:
        n_confs = min(n_confs, 8)  # bound the cost for big molecules

    work = Chem.Mol(mol)
    # (random_coords, plain_dg) strategies, in order. Ring-rich molecules do
    # much better starting from random coordinates than from ETKDG's default
    # eigenvalue embedding, so they try that first.
    ids: list[int] = []
    if heavy:
        strategies = [(True, False), (True, True), (False, False)]
        embed_deadline = started + 0.75 * budget  # keep the rest for MMFF
        for random_coords, plain_dg in strategies:
            now = time.monotonic()
            slice_end = now + 0.6 * max(0.0, embed_deadline - now) if (random_coords, plain_dg) != strategies[-1] else embed_deadline
            ids = _embed_bounded(work, n_confs, RANDOM_SEED, random_coords, plain_dg, slice_end)
            if ids:
                break
        logger.info("structure_builder: heavy embed %s in %.1fs | atoms=%d", "ok" if ids else "failed",
                    time.monotonic() - started, mol.GetNumAtoms())
    else:
        for random_coords, plain_dg in [(False, False), (True, False), (True, True)]:
            ids = _embed(work, n_confs, RANDOM_SEED, random_coords, plain_dg)
            if ids:
                break
    if not ids:
        raise GenerationError("Could not embed this molecule in 3-D.")

    # relax every conformer, keep the lowest-energy one
    done, energies = _mmff_relax(work, list(ids), deadline)
    energies = [e if (not math.isnan(e)) else float("inf") for e in energies]
    if not energies or not math.isfinite(min(energies)):
        raise GenerationError("Force-field optimisation failed for this molecule.")
    best = int(np.argmin(energies))
    conf_id = done[best]
    logger.info("structure_builder: MMFF done in %.1fs | confs=%d", time.monotonic() - started, len(done))

    block = Chem.MolToMolBlock(work, confId=conf_id)
    note = "3-D geometry generated for this compound (RDKit ETKDG + MMFF94)."
    if n_rot > 0:
        note += (f" It is flexible ({n_rot} rotatable bonds): this is the lowest-energy of {len(done)} "
                 "conformers, and other conformers can have a different point group.")
    return Generated(text=block, fmt="sdf", method="rdkit", note=note)


# ---------------------------------------------------------------- xTB path
def _xyz_text(symbols: list[str], coords_ang: np.ndarray, comment: str) -> str:
    lines = [str(len(symbols)), comment]
    lines += [f"{s} {x:.6f} {y:.6f} {z:.6f}" for s, (x, y, z) in zip(symbols, coords_ang)]
    return "\n".join(lines) + "\n"


def _xtb_optimize(numbers, start_ang, charge, uhf, deadline):
    """L-BFGS geometry optimisation on the GFN2-xTB surface.
    Returns (coords_angstrom, energy_hartree, converged)."""
    from scipy.optimize import minimize
    from tblite.interface import Calculator

    numbers = np.asarray(numbers, dtype=int)
    n = len(numbers)

    def penalty(x):
        """A pure inverse-square repulsion between every atom pair, used only
        when a step lands somewhere so distorted that the SCF itself can't
        converge there. It has no physical meaning -- it exists purely to
        hand L-BFGS a finite energy and a gradient that points back out of
        the clash, so the line search backs off and tries a smaller step
        instead of the whole optimisation aborting on one bad step."""
        p = x.reshape(n, 3)
        diff = p[:, None, :] - p[None, :, :]
        dist = np.linalg.norm(diff, axis=-1)
        np.fill_diagonal(dist, np.inf)
        dist = np.maximum(dist, 0.35)
        e = float(np.sum(1.0 / dist ** 2)) * 5.0 + 50.0
        g = -2.0 * 5.0 * np.sum(diff / dist[:, :, None] ** 4, axis=1)
        return e, g.ravel()

    best_seen = {"e": np.inf, "x": None}  # lowest-energy SCF-converged point visited so far

    def fun(x):
        if time.monotonic() > deadline:
            raise TimeoutError("xTB time budget used up")
        try:
            calc = Calculator("GFN2-xTB", numbers, x.reshape(n, 3), charge=float(charge), uhf=int(uhf))
            calc.set("verbosity", 0)
            r = calc.singlepoint()
            e = float(r.get("energy"))
            if e < best_seen["e"]:
                best_seen["e"], best_seen["x"] = e, np.array(x, dtype=float)
            return e, np.asarray(r.get("gradient"), dtype=float).ravel()
        except Exception:
            return penalty(x)

    x0 = (np.asarray(start_ang, dtype=float) / _BOHR).ravel()
    timed_out = False
    x_final = x0
    try:
        # Restart L-BFGS from wherever it stopped (fresh curvature memory) until the
        # gradient is small, it stalls, or time runs out. One long run is not enough for
        # floppy chelate complexes: scipy often ends a run with "abnormal line search"
        # even though the geometry is essentially relaxed, and a restart cures that.
        tol = XTB_GTOL
        for _round in range(4):
            out = minimize(fun, x_final, jac=True, method="L-BFGS-B",
                           options={"maxiter": XTB_MAX_STEPS, "gtol": tol, "ftol": 1e-13, "maxcor": 30})
            moved = float(np.max(np.abs(out.x - x_final))) if _round else np.inf
            x_final = out.x
            gmax_now = float(np.max(np.abs(out.jac))) if getattr(out, "jac", None) is not None else np.inf
            if gmax_now < XTB_CONVERGED_GMAX / 4 or moved < 1e-6 or time.monotonic() > deadline:
                break
            tol = max(tol / 4, 1e-6)
    except TimeoutError:
        # Out of time budget mid-optimisation. Rather than throw the work away,
        # return the best real xTB point visited so far. Only fail if no SCF ever succeeded.
        if best_seen["x"] is None:
            raise
        timed_out = True
        x_final = best_seen["x"]

    # The final point must be a real, SCF-converged xTB minimum -- if it landed
    # inside the fallback penalty region (or the SCF is unstable right there),
    # this start is a failure, not just "not fully converged".
    calc = Calculator("GFN2-xTB", numbers, x_final.reshape(n, 3), charge=float(charge), uhf=int(uhf))
    calc.set("verbosity", 0)
    r = calc.singlepoint()
    energy = float(r.get("energy"))
    gmax = float(np.max(np.abs(np.asarray(r.get("gradient"), dtype=float))))
    # "Converged" is judged from the actual gradient at the returned geometry, not from
    # scipy's success flag (which is False for a merely-stalled line search).
    converged = gmax < XTB_CONVERGED_GMAX
    logger.info("xtb final: gmax=%.2e Eh/Bohr converged=%s timed_out=%s", gmax, converged, timed_out)
    return x_final.reshape(n, 3) * _BOHR, energy, converged


def _sane(coords: np.ndarray) -> bool:
    """Reject collapsed geometries (two atoms basically on top of each other)."""
    n = len(coords)
    if n < 2:
        return True
    d = np.linalg.norm(coords[:, None, :] - coords[None, :, :], axis=-1)
    d[np.arange(n), np.arange(n)] = np.inf
    return bool(d.min() > 0.55)


def _best_fit_normal(coords: np.ndarray) -> np.ndarray:
    """Unit normal of the plane that best fits a set of points (SVD)."""
    c = coords - coords.mean(axis=0)
    _, _, vt = np.linalg.svd(c)
    return vt[-1]


def _rotation_to_z(normal: np.ndarray) -> np.ndarray:
    """Rotation matrix that carries `normal` onto +z (Rodrigues' formula)."""
    z = np.array([0.0, 0.0, 1.0])
    v = np.cross(normal, z)
    s = np.linalg.norm(v)
    c = float(np.dot(normal, z))
    if s < 1e-10:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (s ** 2))


def _embed_fragment(frag: Chem.Mol, seed: int) -> np.ndarray | None:
    """Local 3-D geometry for one connected fragment, centred on its own centroid."""
    if frag.GetNumAtoms() == 1:
        return np.zeros((1, 3))
    work = Chem.Mol(frag)
    # Fragments come from GetMolFrags(sanitizeFrags=False), so ring info and
    # implicit valences are not initialised yet. Do it here or RDKit raises
    # "RingInfo not initialized" on the MMFF checks below.
    try:
        work.UpdatePropertyCache(strict=False)
        Chem.FastFindRings(work)
    except Exception:
        pass
    params = AllChem.ETKDGv3()
    params.randomSeed = seed
    params.useRandomCoords = True
    params.numThreads = 1
    if AllChem.EmbedMolecule(work, params) != 0:
        return None
    # MMFF polish is optional: if it can't run, keep the raw ETKDG geometry.
    try:
        if AllChem.MMFFHasAllMoleculeParams(work):
            AllChem.MMFFOptimizeMolecule(work, maxIters=2000)
    except Exception:
        pass
    pos = np.array(work.GetConformer().GetPositions())
    return pos - pos.mean(axis=0)


def _fragment_radius(coords: np.ndarray) -> float:
    if len(coords) == 1:
        return 1.5
    return float(np.max(np.linalg.norm(coords - coords.mean(axis=0), axis=1))) + 1.5


def _pack_fragments(mol: Chem.Mol, seed: int) -> np.ndarray | None:
    """Starting geometry for a molecule made of several disconnected pieces
    (ion pairs, and -- the common case in PubChem records -- sandwich /
    half-sandwich organometallics, where the metal carries no explicit bonds
    to the ring(s) at all).

    Single-atom fragments are treated as potential "centres". When there is
    exactly one centre and one or more roughly-planar ring fragments left
    over, they are stacked face-on through that centre (the classic
    metallocene arrangement) -- a good enough starting guess for xTB's local
    optimiser to settle into the real sandwich geometry. Anything else
    (plain ion pairs, several separate small pieces) is arranged as
    well-separated clusters around a common origin instead, which is enough
    to keep xTB from seeing atoms on top of each other; the identity/count
    of symmetry operations does not depend on this initial spacing.
    """
    frag_mols = Chem.GetMolFrags(mol, asMols=True, sanitizeFrags=False)
    frag_idx = Chem.GetMolFrags(mol, asMols=False)
    local = []
    for i, fm in enumerate(frag_mols):
        pos = _embed_fragment(fm, seed + i)
        if pos is None:
            return None
        local.append(pos)

    centres = [i for i, fm in enumerate(frag_mols) if fm.GetNumAtoms() == 1]
    rings = [i for i, fm in enumerate(frag_mols) if fm.GetNumAtoms() >= 3]
    is_planar = {}
    for i in rings:
        c = local[i]
        n = _best_fit_normal(c)
        rms = float(np.sqrt(np.mean((c @ n) ** 2)))
        is_planar[i] = rms < 0.25
    planar_rings = [i for i in rings if is_planar.get(i)]

    n_atoms = mol.GetNumAtoms()
    out = np.zeros((n_atoms, 3))

    if len(centres) == 1 and planar_rings and len(centres) + len(planar_rings) == len(frag_mols):
        centre = centres[0]
        # alternate the rings above/below the centre: +1, -1, +2, -2, ...
        # (the common case is exactly 2 rings -> +1, -1: one on each face of
        # the metal, which is the sandwich arrangement itself)
        offsets = []
        for k in range(len(planar_rings)):
            shell = k // 2 + 1
            offsets.append(shell if k % 2 == 0 else -shell)
        for i, off in zip(planar_rings, offsets):
            coords = local[i]
            normal = _best_fit_normal(coords)
            coords = coords @ _rotation_to_z(normal).T
            heavy = sum(1 for a in frag_idx[i] if mol.GetAtomWithIdx(a).GetAtomicNum() > 1)
            gap = 1.1 + 0.1 * heavy  # rough metal-to-ring-plane guess: ~1.6A for Cp5, ~1.7A for arenes, ~1.9A for COT8
            z = np.sign(off) * abs(off) * gap
            for j, atom_i in enumerate(frag_idx[i]):
                out[atom_i] = coords[j] + np.array([0.0, 0.0, z])
        for j, atom_i in enumerate(frag_idx[centre]):
            out[atom_i] = local[centre][j]
        return out

    # generic fallback: spread fragments around a circle, far enough apart
    # (by their own radius) that nothing clashes, orientation left as embedded
    n_frags = len(frag_mols)
    ring_r = max(4.0, sum(_fragment_radius(c) for c in local) / max(1, n_frags) * n_frags / 2.0)
    for k, (coords, idxs) in enumerate(zip(local, frag_idx)):
        if n_frags == 1:
            centre_xy = np.zeros(3)
        else:
            a = 2 * math.pi * k / n_frags
            centre_xy = np.array([ring_r * math.cos(a), ring_r * math.sin(a), 0.0])
        for j, atom_i in enumerate(idxs):
            out[atom_i] = coords[j] + centre_xy
    return out


# Idealized ligand-direction templates (unit vectors) for a central atom
# bonded only to terminal ("star") ligands. Plain ETKDG distance-geometry
# embedding has no notion of these classic VSEPR shapes, and for a
# 5- or 6-coordinate centre it can hand xTB a starting guess distorted enough
# that the local optimizer relaxes it into the wrong (lower-symmetry, or even
# partly dissociated) minimum instead of the true one -- exactly what
# happened with PCl5 embedding into something that relaxed with two ligands
# pulled halfway off the molecule. Used only as extra starting *guesses*
# alongside the normal random ones; whichever start reaches the lowest real
# xTB energy is what gets kept, so a wrong template can never make the result
# worse than not having it.
def _vsepr_templates(n: int) -> list[np.ndarray]:
    def norm_rows(a):
        a = np.asarray(a, dtype=float)
        return a / np.linalg.norm(a, axis=1, keepdims=True)

    if n == 4:
        return [norm_rows([[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]),  # tetrahedral
                norm_rows([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]])]      # square planar
    if n == 5:
        eq = [[math.cos(a), math.sin(a), 0] for a in (0, 2 * math.pi / 3, 4 * math.pi / 3)]
        tbp = norm_rows(eq + [[0, 0, 1], [0, 0, -1]])
        sp = norm_rows([[1, 0, 0.3], [-1, 0, 0.3], [0, 1, 0.3], [0, -1, 0.3], [0, 0, -1]])
        return [tbp, sp]
    if n == 6:
        return [norm_rows([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]])]  # octahedral
    if n == 7:
        eq = [[math.cos(a), math.sin(a), 0] for a in (2 * math.pi * k / 5 for k in range(5))]
        return [norm_rows(eq + [[0, 0, 1], [0, 0, -1]])]  # pentagonal bipyramidal
    return []


def _star_seeds(mol: Chem.Mol) -> list[np.ndarray]:
    """If this molecule is exactly one central atom bonded to N terminal
    ligands (no ligand-ligand bonds, no other structure), return one
    candidate starting geometry per plausible VSEPR shape for that
    coordination number. Otherwise an empty list -- most molecules (rings,
    chains, anything with more than one heavy centre) aren't this shape,
    and get no seeds here."""
    n = mol.GetNumAtoms()
    centre = None
    for a in mol.GetAtoms():
        if a.GetDegree() == n - 1 and all(nb.GetDegree() == 1 for nb in a.GetNeighbors()):
            centre = a.GetIdx()
            break
    if centre is None or n - 1 < 4:
        return []
    # a rough bond length: covalent radius sum to the first ligand
    from .symmetry_engine import COVALENT_RADIUS
    lig0 = mol.GetAtomWithIdx(centre).GetNeighbors()[0]
    r = COVALENT_RADIUS.get(mol.GetAtomWithIdx(centre).GetSymbol(), 1.3) + COVALENT_RADIUS.get(lig0.GetSymbol(), 0.9)
    ligand_order = [nb.GetIdx() for nb in mol.GetAtomWithIdx(centre).GetNeighbors()]
    seeds = []
    for template in _vsepr_templates(n - 1):
        coords = np.zeros((n, 3))
        for dir_vec, atom_i in zip(template, ligand_order):
            coords[atom_i] = dir_vec * r
        # centre stays at the origin
        seeds.append(coords)
    return seeds


# Elements treated as a coordination centre when they appear as a lone atom in a record.
_METAL_Z = set(range(21, 31)) | set(range(39, 49)) | set(range(57, 81)) | {13, 31, 49, 50, 81, 82, 83}
_DONOR_SYMBOLS = {"N", "O", "S", "P", "As", "Se"}
_HALIDE_SYMBOLS = {"F", "Cl", "Br", "I"}


def _complex_seeds(mol: Chem.Mol) -> list[np.ndarray]:
    """PubChem stores many coordination complexes as an unbonded pile: one bare metal ion
    plus the free ligands ([Co(en)3]3+ is Co3+ and three separate ethylenediamines). Packing
    those on a circle leaves xTB a very long walk to the real complex and it rarely converges.
    Here the metal is placed at the origin, the ligands' donor atoms (N/O/S/P with a lone
    pair, or lone halide ions) are put on an ideal VSEPR polyhedron, chelating donors on cis
    positions, and RDKit's distance geometry fills in the rest of each ligand around those
    fixed points. Returns [] whenever the record doesn't fit that pattern, in which case the
    generic fragment packing is used exactly as before."""
    try:
        frags = Chem.GetMolFrags(mol, asMols=False)
        metals = [f[0] for f in frags if len(f) == 1 and mol.GetAtomWithIdx(f[0]).GetAtomicNum() in _METAL_Z]
        if len(metals) != 1:
            return []
        metal = metals[0]
        donors, ligand_of = [], {}
        for li, f in enumerate(frags):
            if len(f) == 1 and f[0] == metal:
                continue
            for ai in f:
                a = mol.GetAtomWithIdx(ai)
                sym = a.GetSymbol()
                if sym in _DONOR_SYMBOLS and a.GetFormalCharge() <= 0 and a.GetTotalDegree() <= 3 + (1 if sym in ("P", "S") else 0):
                    donors.append(ai); ligand_of[ai] = li
                elif sym in _HALIDE_SYMBOLS and len(f) == 1 and a.GetFormalCharge() < 0:
                    donors.append(ai); ligand_of[ai] = li
        cn = len(donors)
        templates = _vsepr_templates(cn)
        if not templates:
            return []
        dm = Chem.GetDistanceMatrix(mol)
        pairs = [(a, b) for i, a in enumerate(donors) for b in donors[i + 1:]
                 if ligand_of[a] == ligand_of[b] and dm[a][b] <= 4]

        import itertools
        from .symmetry_engine import COVALENT_RADIUS
        seeds = []
        msym = mol.GetAtomWithIdx(metal).GetSymbol()
        for tpl in templates:
            best_perm, best_score = None, np.inf
            for perm in itertools.permutations(range(cn)):
                pos = {d: tpl[perm[i]] for i, d in enumerate(donors)}
                score = 0.0
                for a, b in pairs:
                    ang = math.degrees(math.acos(float(np.clip(np.dot(pos[a], pos[b]), -1, 1))))
                    score += (ang - 90.0) ** 2
                if score < best_score - 1e-9:
                    best_perm, best_score = perm, score
                    if score < 1e-9:
                        break
            # bonded copy with dative donor->metal bonds so ETKDG treats it as one connected complex
            rw = Chem.RWMol(mol)
            for d in donors:
                rw.AddBond(d, metal, Chem.BondType.DATIVE)
            work = rw.GetMol()
            work.UpdatePropertyCache(strict=False)
            Chem.FastFindRings(work)
            cmap = {metal: (0.0, 0.0, 0.0)}
            from rdkit.Geometry import Point3D
            cm = {metal: Point3D(0, 0, 0)}
            for i, d in enumerate(donors):
                r = COVALENT_RADIUS.get(msym, 1.3) + COVALENT_RADIUS.get(mol.GetAtomWithIdx(d).GetSymbol(), 0.9)
                v = tpl[best_perm[i]] * r
                cm[d] = Point3D(float(v[0]), float(v[1]), float(v[2]))
            # random-coordinate embedding collapses the hydrogens onto each other around a fixed
            # metal centre; the default eigenvalue-based start does not.
            for attempt in range(COMPLEX_SEEDS_PER_TEMPLATE * 3):
                if len(seeds) >= COMPLEX_SEEDS_PER_TEMPLATE * (templates.index(tpl) + 1):
                    break
                params = AllChem.ETKDGv3()
                params.randomSeed = RANDOM_SEED + 977 * attempt
                params.useRandomCoords = False
                params.numThreads = 1
                params.SetCoordMap(cm)
                if AllChem.EmbedMolecule(work, params) != 0:
                    continue
                xyz = np.array(work.GetConformer().GetPositions())
                if _sane(xyz):
                    seeds.append(xyz)
        if seeds:
            base = seeds[0]
            extra = []
            # Chelate rings (donor-C-C-donor, e.g. ethylenediamine) can pucker either way (lambda /
            # delta). All-same-hand rings give the textbook D3 complex, mixed ones give C2, and
            # distance geometry always returns the same hand, so start from every count of
            # "+" rings (0..k) explicitly and let xTB relax each one.
            rings = []
            for a, b in pairs:
                path = Chem.GetShortestPath(mol, a, b)
                if len(path) == 4:  # donor, C, C, donor
                    rings.append(tuple(path))
            if 1 <= len(rings) <= 4:
                for plus in range(len(rings) + 1):
                    trial = base.copy()
                    for ri, (d1, c1, c2, d2) in enumerate(rings):
                        sign = 1.0 if ri < plus else -1.0
                        nrm = np.cross(trial[d1] - trial[metal], trial[d2] - trial[metal])
                        ln = np.linalg.norm(nrm)
                        if ln < 1e-6:
                            continue
                        nrm /= ln
                        # push the two backbone carbons (and their hydrogens) to opposite faces of the chelate plane
                        for atom, off in ((c1, +0.45), (c2, -0.45)):
                            shift = sign * off * nrm
                            trial[atom] += shift
                            for nb in mol.GetAtomWithIdx(atom).GetNeighbors():
                                if nb.GetAtomicNum() == 1:
                                    trial[nb.GetIdx()] += shift
                    if _sane(trial):
                        extra.append(trial)
            if extra:
                seeds = extra + seeds[:1]
            else:
                # no chelate rings to pucker: jittered copies (fixed metal) explore nearby minima instead
                rng = np.random.default_rng(RANDOM_SEED)
                movable = np.ones(len(base), dtype=bool)
                movable[metal] = False
                for _ in range(COMPLEX_SEEDS_PER_TEMPLATE * len(templates) * 2):
                    trial = base.copy()
                    trial[movable] += rng.normal(0.0, 0.45, size=(int(movable.sum()), 3))
                    if _sane(trial):
                        seeds.append(trial)
            logger.info("structure_builder: %d coordination-complex seed(s) | metal=%s cn=%d", len(seeds), msym, cn)
        return seeds
    except Exception as exc:  # noqa: BLE001 -- seeding is best-effort; never block the normal path
        logger.info("structure_builder: complex seeding skipped (%s)", exc)
        return []


def _xtb_build(mol: Chem.Mol, budget: float = XTB_BUDGET_S) -> Generated:
    n = mol.GetNumAtoms()
    frags = Chem.GetMolFrags(mol, asMols=True, sanitizeFrags=False)
    if len(frags) > 1 and all(f.GetNumAtoms() == 1 for f in frags):
        # A handful of bare, unbonded ions (NaCl, KBr, ...) -- there is no
        # single well-defined molecular geometry here to begin with (real
        # NaCl is an extended ionic lattice, not a molecule), so no amount of
        # optimizing will produce a meaningful "point group". Said plainly
        # and immediately, rather than spending the whole xTB time budget
        # fighting what is anyway an ill-posed gas-phase SCF at a stretched
        # bond before failing the same way.
        raise GenerationError(
            "This looks like a set of separate ions (a salt), which doesn't have one well-defined "
            "molecular geometry to assign a point group to -- try a molecular compound instead."
        )
    if n > MAX_ATOMS_XTB:
        raise GenerationError(f"Too large to relax automatically ({n} atoms) — paste a 3-D structure instead.")
    symbols = [a.GetSymbol() for a in mol.GetAtoms()]
    numbers = [a.GetAtomicNum() for a in mol.GetAtoms()]
    charge = int(sum(a.GetFormalCharge() for a in mol.GetAtoms()))
    n_elec = sum(numbers) - charge
    uhf = n_elec % 2  # closed shell, or a doublet for an odd electron count
    n_frags = len(Chem.GetMolFrags(mol))

    if any(z > 86 for z in numbers):
        raise GenerationError("GFN2-xTB does not cover these elements.")

    star_seeds = _star_seeds(mol) if n_frags == 1 else _complex_seeds(mol)
    if star_seeds:
        logger.info("structure_builder: %d template start(s) queued | atoms=%d", len(star_seeds), n)

    started = time.monotonic()
    deadline = started + budget
    best = None  # (energy, coords, converged)
    found = []   # every sane, converged minimum: (energy, coords)
    total_starts = len(star_seeds) + XTB_STARTS
    for k in range(total_starts):
        if time.monotonic() > deadline:
            break
        if k < len(star_seeds):
            start = star_seeds[k]
        elif n_frags > 1:
            start = _pack_fragments(mol, RANDOM_SEED + 101 * k)
            if start is None:
                continue
        else:
            work = Chem.Mol(mol)
            params = AllChem.ETKDGv3()
            params.randomSeed = RANDOM_SEED + 101 * k
            params.useRandomCoords = True
            params.numThreads = 1
            params.maxIterations = 100
            if AllChem.EmbedMolecule(work, params) != 0:
                logger.info("xtb start %d skipped: RDKit could not embed a starting geometry", k)
                continue
            start = np.array(work.GetConformer().GetPositions())
        try:
            coords, energy, ok = _xtb_optimize(numbers, start, charge, uhf, deadline)
        except TimeoutError:
            break
        except Exception as exc:  # SCF failure etc. -- just try the next start
            logger.info("xtb start %d failed: %s", k, exc)
            continue
        if not _sane(coords):
            continue
        logger.info("xtb start %d: E=%.6f Eh converged=%s", k, energy, ok)
        if ok:
            found.append((energy, coords))
        if best is None or energy < best[0] - 1e-7:
            best = (energy, coords, ok)
        if k >= 1 and best is not None and abs(energy - best[0]) < 1e-5 and best[2] and not (n_frags > 1 and star_seeds):
            break
        if n_frags > 1 and star_seeds and k >= len(star_seeds) - 1 and best is not None and best[2]:
            break  # every purpose-built coordination seed has been tried; random packing adds nothing
        if best is not None and best[2] and (time.monotonic() - started) > 0.4 * budget:
            break  # a converged result already cost a lot of the budget (slow host)

    if best is None:
        raise GenerationError("Could not relax a 3-D structure for this compound automatically.")

    energy, coords, ok = best
    note = ("3-D geometry generated for this compound and relaxed with GFN2-xTB "
            "(semi-empirical, gas phase) because PubChem has no 3-D conformer.")
    if not ok:
        note += " The optimisation did not fully converge, so treat borderline symmetry with caution."
    # The marker rides in the XYZ comment line so /analyze can refuse this text later
    # without any extra flag from the frontend.
    comment = f"GFN2-xTB relaxed, E={energy:.6f} Eh" + ("" if ok else " NOT-CONVERGED")
    text = _xyz_text(symbols, coords, comment)
    alternatives = []
    if n_frags > 1 and star_seeds and found:
        distinct = []
        for e, c in sorted(found, key=lambda t: t[0]):
            if all(abs(e - e0) > 1e-5 for e0, _ in distinct):  # same energy = same minimum (or its mirror image)
                distinct.append((e, c))
        e_min = distinct[0][0]
        alternatives = [
            {"text": _xyz_text(symbols, c, f"GFN2-xTB relaxed, E={e:.6f} Eh"), "energy": e,
             "relKJ": (e - e_min) * 2625.4996}
            for e, c in distinct[:6]
            if (e - e_min) * 2625.4996 < 60.0   # ignore distorted high-energy minima
        ]
        if len(alternatives) > 1:
            note += f" {len(alternatives)} distinct relaxed conformers were found -- pick one to analyse."
    return Generated(text=text, fmt="xyz", method="xtb", note=note, converged=bool(ok), alternatives=alternatives)


# ---------------------------------------------------------------- symmetry refinement
# Why: force fields see the *Kekule* bond pattern of the input record. For rigid
# conjugated systems (fullerenes, polycyclic aromatics...) that pattern is an
# arbitrary resonance form with LOWER symmetry than the real molecule, so the
# relaxed geometry carries a distortion (0.05-0.2 A) that reads as e.g. D2
# instead of Ih at a normal tolerance. Guessing the intended symmetry from the
# distorted geometry does not work (it is not reliably detectable at any one
# tolerance), so use the molecular GRAPH instead: its automorphisms (bond
# orders ignored) say which atoms are equivalent; for each one fit the best
# rigid motion, keep only those the geometry approximately supports, and
# project the geometry onto that group. Only rigid molecules are touched, and
# every step is guarded (fit residual, atom shift, bond-length change, group
# closure) so an unsupported symmetry leaves the geometry exactly as it was.
def _graph_automorphisms(labels, edges, cap, deadline):
    """All automorphisms of a vertex-labelled graph (edge orders IGNORED, so
    resonance forms cannot matter). Backtracking seeded by colour refinement.
    Returns a list of permutations (vertex i -> perm[i]) or None when there
    are more than `cap` of them or time ran out."""
    n = len(labels)
    adj = [set() for _ in range(n)]
    for i, j in edges:
        adj[i].add(j); adj[j].add(i)
    color = [hash((str(labels[i]), len(adj[i]))) for i in range(n)]
    for _ in range(n):
        new = [hash((color[i], tuple(sorted(color[j] for j in adj[i])))) for i in range(n)]
        stable = len(set(new)) == len(set(color))
        color = new
        if stable:
            break
    size = {}
    for c in color:
        size[c] = size.get(c, 0) + 1
    order, seen = [], [False] * n
    for s0 in sorted(range(n), key=lambda v: (size[color[v]], v)):
        if seen[s0]:
            continue
        seen[s0] = True
        q = [s0]
        while q:
            v = q.pop(0)
            order.append(v)
            for u in sorted(adj[v]):
                if not seen[u]:
                    seen[u] = True
                    q.append(u)
    by_color = {}
    for v in range(n):
        by_color.setdefault(color[v], []).append(v)
    img, used, out, over = [-1] * n, [False] * n, [], [False]

    def extend(k):
        if over[0]:
            return
        if k == n:
            out.append(tuple(img))
            if len(out) > cap:
                over[0] = True
            return
        if time.monotonic() > deadline:
            over[0] = True
            return
        v = order[k]
        mapped = [u for u in adj[v] if img[u] >= 0]
        cands = adj[img[mapped[0]]] if mapped else by_color[color[v]]
        for w in sorted(cands):
            if used[w] or color[w] != color[v]:
                continue
            if any(img[u] not in adj[w] for u in mapped):
                continue
            if sum(1 for x in adj[w] if used[x]) != len(mapped):
                continue
            img[v], used[w] = w, True
            extend(k + 1)
            img[v], used[w] = -1, False
            if over[0]:
                return

    extend(0)
    return None if over[0] else out


def _closed_under_composition(perms):
    A = np.array(perms, dtype=np.int32)
    keys = {row.tobytes() for row in A}
    for a in A:
        for row in a[A]:                                  # (a o b)(i) = a[b[i]] for every b
            if row.tobytes() not in keys:
                return False
    return True


def _refine_by_graph(pos, els, bonds, budget):
    """Nudge a force-field geometry onto the symmetry its molecular graph says
    it should have. Returns (new_pos, info); info None = left untouched."""
    deadline = time.monotonic() + budget
    pos = np.asarray(pos, dtype=float)
    els = [str(x) for x in els]
    n = len(pos)
    nbrs = [[] for _ in range(n)]
    for i, j in bonds:
        nbrs[i].append(j); nbrs[j].append(i)
    is_leaf = [len(nbrs[i]) == 1 for i in range(n)]
    skel = [i for i in range(n) if not is_leaf[i]]
    if len(skel) < SYM_REFINE_MIN_SKELETON:
        return pos, None
    sk_pos = {a: k for k, a in enumerate(skel)}
    leaves_of = {a: sorted(u for u in nbrs[a] if is_leaf[u]) for a in skel}
    labels = [(els[a], tuple(sorted(els[u] for u in leaves_of[a]))) for a in skel]
    sk_edges = [(sk_pos[i], sk_pos[j]) for i, j in bonds if not is_leaf[i] and not is_leaf[j]]
    autos = _graph_automorphisms(labels, sk_edges, SYM_REFINE_MAX_AUTOS, deadline)
    if not autos or len(autos) <= 1:
        return pos, None

    def fit(cur, auto):
        """Full atom permutation for one skeleton automorphism (terminal atoms
        assigned by geometry) plus the best orthogonal map R and its residual."""
        mapping = {a: skel[auto[k]] for k, a in enumerate(skel)}
        Ps = cur[skel]
        Qs = cur[[mapping[a] for a in skel]]
        U, _, Vt = np.linalg.svd(Ps.T @ Qs)
        R = U @ Vt
        perm = np.arange(n)
        for a in skel:
            perm[a] = mapping[a]
            L, T = leaves_of[a], leaves_of[mapping[a]]
            if len(L) == 1:
                perm[L[0]] = T[0]
            elif len(L) > 1:
                cost = np.linalg.norm((cur[L] @ R)[:, None, :] - cur[T][None, :, :], axis=2)
                cost += 1e3 * (np.array([els[x] for x in L])[:, None] != np.array([els[x] for x in T])[None, :])
                rows, cols = linear_sum_assignment(cost)
                for r, c in zip(rows, cols):
                    perm[L[r]] = T[c]
        U, _, Vt = np.linalg.svd(cur.T @ cur[perm])
        R = U @ Vt
        return perm, R, float(np.linalg.norm(cur @ R - cur[perm], axis=1).max())

    P0 = pos - pos.mean(axis=0)
    cur = P0.copy()

    # Near-planar molecules: a rotation and the same rotation combined with a
    # flip through the molecular plane fit equally well, so noise would pick
    # between them at random and leave a small symmetric pucker. Offer both
    # as candidates; the flip is only valid if the molecule really is planar.
    evals, evecs = np.linalg.eigh(np.cov(P0.T))
    normal = evecs[:, 0]
    flip = None
    if np.abs(P0 @ normal).max() * 2.0 <= SYM_REFINE_MAX_RESIDUAL:
        flip = np.eye(3) - 2.0 * np.outer(normal, normal)

    keep = None
    for _ in range(SYM_REFINE_ITERS):
        if time.monotonic() > deadline:
            break
        cands = []                                           # (auto index, perm, R, residual)
        for i, a in enumerate(autos):
            perm, R, res = fit(cur, a)
            cands.append((i, perm, R, res))
            if flip is not None:
                R2 = R @ flip
                cands.append((i, perm, R2, float(np.linalg.norm(cur @ R2 - cur[perm], axis=1).max())))
        if keep is None:
            keep = [k for k, c in enumerate(cands) if c[3] <= SYM_REFINE_MAX_RESIDUAL]
            good = sorted({cands[k][0] for k in keep})
            if len(keep) <= 1 or len(good) <= 1 or not _closed_under_composition([autos[i] for i in good]):
                return pos, None                            # geometry only half-supports this symmetry
        new = np.zeros_like(cur)
        for k in keep:
            _, perm, R, _ = cands[k]
            new += cur[perm] @ R.T                           # p_i ~= R^-1 applied to p_perm(i)
        new /= len(keep)
        if np.linalg.norm(new - P0, axis=1).max() > SYM_REFINE_MAX_SHIFT:
            return pos, None
        step = np.linalg.norm(new - cur, axis=1).max()
        cur = new
        if step < 1e-6:
            break
    if keep is None:
        return pos, None
    shift = float(np.linalg.norm(cur - P0, axis=1).max())
    for i, j in bonds:
        if abs(np.linalg.norm(cur[i] - cur[j]) - np.linalg.norm(P0[i] - P0[j])) > SYM_REFINE_MAX_BOND_CHANGE:
            return pos, None
    return cur + pos.mean(axis=0), {"ops": len({cands[k][0] for k in keep}), "shift": shift}


def _refine_block(block: str, budget: float) -> tuple[str, str]:
    """Refine an SDF block's geometry; returns (block, note). Never raises:
    on any problem the original block comes back with an empty note."""
    try:
        m = Chem.MolFromMolBlock(block, sanitize=False, removeHs=False)
        if m is None or m.GetNumAtoms() < 3 or m.GetNumConformers() == 0:
            return block, ""
        conf = m.GetConformer()
        pos = np.array(conf.GetPositions(), dtype=float)
        els = [a.GetSymbol() for a in m.GetAtoms()]
        bonds = [(b.GetBeginAtomIdx(), b.GetEndAtomIdx()) for b in m.GetBonds()]
        new, info = _refine_by_graph(pos, els, bonds, budget)
        if info is None or info["shift"] < 0.005:
            return block, ""
        from rdkit.Geometry import Point3D
        for i, (x, y, z) in enumerate(new):
            conf.SetAtomPosition(i, Point3D(float(x), float(y), float(z)))
        note = (f" Geometry was refined onto the symmetry of its molecular graph (largest atom shift "
                f"{info['shift']:.2f} A): force-field results for rigid conjugated molecules depend on the "
                "arbitrary alternating-bond pattern in the input record, which slightly breaks the real symmetry.")
        return Chem.MolToMolBlock(m), note
    except Exception as exc:  # noqa: BLE001 -- refinement is strictly best-effort
        logger.info("structure_builder: symmetry refinement skipped (%s: %s)", type(exc).__name__, exc)
        return block, ""


# ---------------------------------------------------------------- killable stages
def _stage_worker(conn, stage: str, sdf_text: str, budget: float) -> None:
    """Child-process entry point (must be module-level so 'spawn' can import it)."""
    try:
        mol = _mol_from_sdf(sdf_text)
        gen = _rdkit_build(mol, budget) if stage == "rdkit" else _xtb_build(mol, budget)
        conn.send(("ok", (gen.text, gen.fmt, gen.method, gen.note, gen.converged, gen.alternatives)))
    except GenerationError as exc:
        conn.send(("gen", str(exc)))
    except BaseException as exc:  # noqa: BLE001 -- report anything back to the parent
        conn.send(("err", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def _run_stage(stage: str, sdf_text: str, budget: float, hard_timeout: float) -> Generated:
    """Run one stage in a child process and kill it if it overruns."""
    ctx = multiprocessing.get_context(_CHILD_START_METHOD)
    recv, send = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_stage_worker, args=(send, stage, sdf_text, budget), daemon=True)
    proc.start()
    send.close()
    status, payload = "timeout", None
    try:
        if recv.poll(hard_timeout):
            try:
                status, payload = recv.recv()
            except EOFError:
                status, payload = "err", "worker exited without a result"
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(timeout=2)
        recv.close()
    if status == "ok":
        text, fmt, method, note, converged, alternatives = payload
        return Generated(text=text, fmt=fmt, method=method, note=note, converged=converged, alternatives=alternatives)
    if status == "gen":
        raise GenerationError(payload)
    if status == "timeout":
        logger.info("structure_builder: %s stage killed after %.0fs", stage, hard_timeout)
        raise GenerationError("Building a 3-D structure for this compound took too long.")
    logger.info("structure_builder: %s stage failed in child | %s", stage, payload)
    raise GenerationError("Could not build a 3-D structure for this compound automatically.")


# ---------------------------------------------------------------- public
def _maybe_refine(gen: Generated, mol: Chem.Mol, heavy: bool, t0: float) -> Generated:
    """Best-effort symmetry refinement of a force-field geometry (rigid molecules
    only -- flexible ones have no single "true" symmetric shape). Takes
    milliseconds and enforces its own deadline, so it runs in-process; any
    failure or shortage of time returns the unrefined geometry."""
    try:
        if (gen.method != "rdkit" or mol.GetNumAtoms() > SYM_REFINE_MAX_ATOMS
                or rdMolDescriptors.CalcNumRotatableBonds(mol) > 0):
            return gen
        remaining = GENERATION_TOTAL_S - (time.monotonic() - t0) - 1.0
        if remaining < SYM_REFINE_MIN_S:
            logger.info("structure_builder: symmetry refinement skipped (%.1fs left)", remaining)
            return gen
        t = time.monotonic()
        text, note = _refine_block(gen.text, min(remaining, 10.0))
        logger.info("structure_builder: symmetry refinement %s in %.2fs",
                    "applied" if note else "made no change", time.monotonic() - t)
        return Generated(text=text, fmt=gen.fmt, method=gen.method, note=gen.note + note) if note else gen
    except Exception as exc:  # noqa: BLE001
        logger.info("structure_builder: symmetry refinement failed (%s)", exc)
        return gen


@lru_cache(maxsize=128)
def _generate_cached(digest: str, sdf_text: str) -> Generated:  # digest is just the cache key
    t0 = time.monotonic()
    mol = _mol_from_sdf(sdf_text)
    reason = _needs_xtb(mol)
    heavy = _is_heavy(mol)
    if reason is None:
        try:
            if heavy:
                gen = _run_stage("rdkit", sdf_text, RDKIT_HEAVY_BUDGET_S, RDKIT_HEAVY_BUDGET_S + SPAWN_SLACK_S)
            else:
                gen = _rdkit_build(mol, RDKIT_LIGHT_BUDGET_S)
            logger.info("structure_builder: RDKit succeeded | atoms=%d", mol.GetNumAtoms())
            return _maybe_refine(gen, mol, heavy, t0)
        except GenerationError as exc:
            logger.info("structure_builder: RDKit path failed (%s), trying xTB", exc)
    else:
        logger.info("structure_builder: skipping RDKit force field | %s", reason)

    remaining = GENERATION_TOTAL_S - (time.monotonic() - t0)
    budget = min(XTB_BUDGET_S, remaining - (SPAWN_SLACK_S if heavy else 2.0))
    if budget < 5.0:
        raise GenerationError("Building a 3-D structure for this compound took too long.")
    if heavy:
        gen = _run_stage("xtb", sdf_text, budget, budget + SPAWN_SLACK_S)
    else:
        gen = _xtb_build(mol, budget)
    logger.info("structure_builder: xTB succeeded | atoms=%d", mol.GetNumAtoms())
    return gen


_inflight_guard = threading.Lock()
_inflight_locks: dict[str, threading.Lock] = {}


def generate_3d(sdf_text: str) -> Generated:
    """Build a 3-D structure from a (2-D) PubChem SDF. Raises GenerationError.

    Serialised per structure: lru_cache does not coalesce concurrent calls, so a
    double click (or an abandoned-but-still-running job from a timed-out request)
    used to start a second identical xTB run that fought the first for CPU. The
    second caller now waits and then hits the cache."""
    digest = hashlib.sha1(sdf_text.encode("utf-8", "ignore")).hexdigest()
    with _inflight_guard:
        lock = _inflight_locks.setdefault(digest, threading.Lock())
    with lock:
        return _generate_cached(digest, sdf_text)