"""Reaction-mechanism preparation and auditing.

All the *logic* for the Reactions tab lives here so the frontend only has to
draw what it is handed (same split as formula.py / spectra/ for the Draw Lab).

Reaction rows in Supabase store each mechanism step as::

    {title, description, atoms: [{id, element, x, y, charge, label?}],
     bonds: [{id, from, to, order}], arrows: [{from, to, bend?}]}

``prepare_step`` takes one raw step and returns a draw-ready one:

    atoms   -> repaired, each with ``label``, ``r`` (radius), ``pseudo``
    bonds   -> repaired, each with ``lines`` (pre-computed line segments,
               so double / triple / aromatic bonds need no maths client-side)
    arrows  -> repaired, each with ``d`` (SVG path of the shaft) and ``head``
               (arrowhead polygon points), already trimmed to the atom edges
    view_box -> ready-to-use SVG viewBox that contains atoms AND arrow curves
    issues  -> human-readable list of everything that had to be fixed

``audit_step`` inspects the RAW step (before repair) and reports ERROR / WARN
findings including valence overflow, which is what GET /api/reactions/audit
serves so every reaction can be checked in one call.

Failure handling (same conventions as the routers): this module never lets
one malformed step take down a whole reaction. ``prepare_step`` and
``audit_reaction`` catch anything unexpected per step, log it with a full
traceback (reaction/step position included) to logs/error.log, and return a
safe placeholder / ERROR finding instead of raising. Routine data repairs are
returned in ``issues`` and logged by the router, which knows the reaction id.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from .formula import ELEMENTS
from .logging_config import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------- constants

# Labels that are legitimately not periodic-table symbols.
PSEUDO = {"R", "R'", 'R"', "Ar", "Nu", "E", "X", "L", "M", "Y", "Z", "e", "e-", "e\u207b"}

BOND_WORDS = {"single": 1, "double": 2, "triple": 3, "aromatic": 1.5}

# Circle radius used when drawing an atom (kept identical to what the
# frontend used to hard-code in elements.js CURATED_RADIUS).
CURATED_RADIUS = {
    "H": 9, "C": 13, "N": 12, "O": 12, "F": 11, "Cl": 14, "Br": 15, "I": 16,
    "S": 14, "P": 14, "Na": 15, "K": 16, "Mg": 14, "Ca": 15, "Fe": 14, "Zn": 14,
    "B": 12, "Si": 14,
}

# Max total bond order for a NEUTRAL atom. Only overflow is flagged, since
# mechanism drawings usually leave hydrogens implicit.
MAX_VALENCE = {"H": 1, "B": 3, "C": 4, "N": 3, "O": 2, "F": 1, "Cl": 1, "Br": 1, "I": 1}

# viewBox / arrow geometry
PAD = 26.0
MIN_W = 170.0
MIN_H = 110.0
HEAD_LEN = 9.0
HEAD_HALF = 4.5
BOND_GAP = 3.5


# ------------------------------------------------------------------ helpers

def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    if isinstance(v, str):
        try:
            f = float(v.strip())
            return f if math.isfinite(f) else None
        except ValueError:
            return None
    return None


def _r2(v: float) -> float:
    return round(v, 2)


def atom_label(atom: Dict[str, Any]) -> str:
    raw = atom.get("label")
    if raw is None:
        raw = atom.get("element", "?")
    raw = str(raw)
    return "e\u207b" if raw in ("e-", "e\u207b") else raw


def atom_radius(atom: Dict[str, Any]) -> float:
    label = atom_label(atom)
    element = atom.get("element", "")
    if len(label) >= 3:
        return 19.0
    if len(label) == 2:
        return 16.0
    if element in PSEUDO:
        return 14.0
    return float(CURATED_RADIUS.get(element, 13))


def _normalize_element(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if s in PSEUDO or s in ELEMENTS:
        return s
    fixed = s[:1].upper() + s[1:].lower()  # "c" -> "C", "CL" -> "Cl"
    if fixed in ELEMENTS:
        return fixed
    return s  # custom label ("H+", "OH"); drawn with neutral styling


def _normalize_order(raw: Any) -> float:
    if isinstance(raw, bool):
        return 1
    if isinstance(raw, (int, float)):
        if raw == 1.5:
            return 1.5
        return min(3, max(1, int(round(raw))))
    if isinstance(raw, str):
        k = raw.strip().lower()
        if k in BOND_WORDS:
            return BOND_WORDS[k]
        n = _num(k)
        if n is not None:
            return _normalize_order(n)
    return 1


# ------------------------------------------------------------ atom repair

def _relax_overlaps(atoms: List[Dict[str, Any]], issues: List[str]) -> None:
    """Push atoms that sit on top of each other apart (in place). Only
    overlapping pairs move, and only as far as needed, so correctly authored
    geometry is left alone."""
    moved = False
    for _ in range(30):
        any_push = False
        for i in range(len(atoms)):
            for j in range(i + 1, len(atoms)):
                a, b = atoms[i], atoms[j]
                min_d = atom_radius(a) + atom_radius(b) + 6
                dx, dy = b["x"] - a["x"], b["y"] - a["y"]
                d = math.hypot(dx, dy)
                if d >= min_d:
                    continue
                if d < 0.01:
                    ang = (j * 2.399963) % (math.pi * 2)
                    dx, dy, d = math.cos(ang), math.sin(ang), 1.0
                push = (min_d - d) / 2 + 0.5
                ux, uy = dx / d, dy / d
                a["x"] -= ux * push
                a["y"] -= uy * push
                b["x"] += ux * push
                b["y"] += uy * push
                any_push = True
                moved = True
        if not any_push:
            break
    if moved:
        issues.append("overlapping atoms were nudged apart")


# ------------------------------------------------------------ arrow maths

def _unit(dx: float, dy: float) -> Tuple[float, float]:
    length = math.hypot(dx, dy) or 1.0
    return dx / length, dy / length


def _head_points(tip: Tuple[float, float], u: Tuple[float, float]) -> str:
    bx, by = tip[0] - u[0] * HEAD_LEN, tip[1] - u[1] * HEAD_LEN
    px, py = -u[1] * HEAD_HALF, u[0] * HEAD_HALF
    pts = [(tip[0], tip[1]), (bx + px, by + py), (bx - px, by - py)]
    return " ".join(f"{_r2(x)},{_r2(y)}" for x, y in pts)


def _resolve_end(ref: str, atom_by_id: Dict[str, Dict], bond_by_id: Dict[str, Dict]):
    a = atom_by_id.get(ref)
    if a:
        return a["x"], a["y"], a["r"]
    b = bond_by_id.get(ref)
    if b:
        f, t = atom_by_id.get(b["from"]), atom_by_id.get(b["to"])
        if f and t:
            return (f["x"] + t["x"]) / 2, (f["y"] + t["y"]) / 2, 0.0
    return None


def _build_arrow(p0, p1, side: int) -> Dict[str, Any]:
    """Curved electron-pushing arrow from p0 to p1 = (x, y, atom_radius).

    The shaft leaves/arrives along the curve's own tangent and stops at the
    atom's EDGE (not its centre), so the head is never hidden under an atom
    disc. A start == end arrow becomes a small loop (lone pair)."""
    x0, y0, r0 = p0
    x1, y1, r1 = p1
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)

    if length < 1:
        top = y0 - r0 - 1
        s = (x0 - 7, top)
        e = (x0 + 7, top)
        c1 = (x0 - 28, top - 36)
        c2 = (x0 + 28, top - 36)
        u = _unit(e[0] - c2[0], e[1] - c2[1])
        shaft_end = (e[0] - u[0] * (HEAD_LEN - 2), e[1] - u[1] * (HEAD_LEN - 2))
        return {
            "d": f"M {_r2(s[0])} {_r2(s[1])} C {_r2(c1[0])} {_r2(c1[1])} {_r2(c2[0])} {_r2(c2[1])} "
                 f"{_r2(shaft_end[0])} {_r2(shaft_end[1])}",
            "head": _head_points(e, u),
            "peak": (x0, top - 27),
        }

    nx, ny = -dy / length, dx / length
    off = min(46.0, max(18.0, length * 0.45)) * side
    c = ((x0 + x1) / 2 + nx * off, (y0 + y1) / 2 + ny * off)

    us = _unit(c[0] - x0, c[1] - y0)
    ue = _unit(c[0] - x1, c[1] - y1)  # from the target back toward the control point
    start_gap = r0 + 3 if r0 > 0 else 0.0
    end_gap = r1 + 4 if r1 > 0 else 2.0
    s = (x0 + us[0] * start_gap, y0 + us[1] * start_gap)
    tip = (x1 + ue[0] * end_gap, y1 + ue[1] * end_gap)
    dir_in = (-ue[0], -ue[1])
    shaft_end = (tip[0] - dir_in[0] * (HEAD_LEN - 2), tip[1] - dir_in[1] * (HEAD_LEN - 2))

    return {
        "d": f"M {_r2(s[0])} {_r2(s[1])} Q {_r2(c[0])} {_r2(c[1])} {_r2(shaft_end[0])} {_r2(shaft_end[1])}",
        "head": _head_points(tip, dir_in),
        "peak": (0.25 * s[0] + 0.5 * c[0] + 0.25 * tip[0], 0.25 * s[1] + 0.5 * c[1] + 0.25 * tip[1]),
    }


# ------------------------------------------------------------ bond lines

def _bond_lines(a: Dict, b: Dict, order: float) -> List[Dict[str, Any]]:
    dx, dy = b["x"] - a["x"], b["y"] - a["y"]
    length = math.hypot(dx, dy)
    if length < 0.5:
        return []
    ux, uy = -dy / length, dx / length

    def off(k: float, dash: Optional[str] = None) -> Dict[str, Any]:
        line = {
            "x1": _r2(a["x"] + ux * k), "y1": _r2(a["y"] + uy * k),
            "x2": _r2(b["x"] + ux * k), "y2": _r2(b["y"] + uy * k),
        }
        if dash:
            line["dash"] = dash
        return line

    if order == 2:
        return [off(BOND_GAP), off(-BOND_GAP)]
    if order == 3:
        return [off(0), off(BOND_GAP * 1.6), off(-BOND_GAP * 1.6)]
    if order == 1.5:
        return [off(0), off(BOND_GAP * 1.4, "4 3")]
    return [off(0)]


# ------------------------------------------------------------ public: prepare

def _prepare_step_unsafe(step: Any) -> Dict[str, Any]:
    """Raw mechanism step -> repaired, geometry-complete step. May raise on
    data nobody anticipated; use prepare_step() which contains that."""
    step = step if isinstance(step, dict) else {}
    issues: List[str] = []
    raw_atoms = step.get("atoms") if isinstance(step.get("atoms"), list) else []
    raw_bonds = step.get("bonds") if isinstance(step.get("bonds"), list) else []
    raw_arrows = step.get("arrows") if isinstance(step.get("arrows"), list) else []

    # ---- atoms
    seen: set = set()
    atoms: List[Dict[str, Any]] = []
    for i, a in enumerate(raw_atoms):
        if not isinstance(a, dict):
            issues.append(f"atom #{i} is not an object")
            continue
        aid = str(a["id"]) if a.get("id") is not None else f"__auto_a{i}"
        if a.get("id") is None:
            issues.append(f"atom #{i} has no id")
        if aid in seen:
            issues.append(f'duplicate atom id "{aid}" (second one dropped)')
            continue
        x, y = _num(a.get("x")), _num(a.get("y"))
        if x is None or y is None:
            issues.append(f'atom "{aid}" has invalid coordinates')
            continue
        raw_el = a.get("element", a.get("symbol", a.get("label")))
        element = _normalize_element(raw_el)
        if not element:
            issues.append(f'atom "{aid}" has no element')
            continue
        if element != a.get("element"):
            issues.append(f'atom "{aid}" element "{a.get("element")}" normalised to "{element}"')
        charge = _num(a.get("charge"))
        seen.add(aid)
        atoms.append({
            "id": aid, "element": element, "x": x, "y": y,
            "charge": int(charge) if charge else 0,
            **({"label": a["label"]} if a.get("label") is not None else {}),
        })
    _relax_overlaps(atoms, issues)
    for a in atoms:
        a["label"] = atom_label(a)
        a["r"] = atom_radius(a)
        a["pseudo"] = a["element"] in PSEUDO or a["element"] not in ELEMENTS
        a["x"], a["y"] = _r2(a["x"]), _r2(a["y"])
    atom_by_id = {a["id"]: a for a in atoms}

    # ---- bonds
    bonds: List[Dict[str, Any]] = []
    bond_ids: set = set()
    pair_seen: set = set()
    for i, b in enumerate(raw_bonds):
        if not isinstance(b, dict):
            continue
        f = str(b["from"]) if b.get("from") is not None else None
        t = str(b["to"]) if b.get("to") is not None else None
        bid_label = b.get("id", f"#{i}")
        if f not in atom_by_id or t not in atom_by_id:
            issues.append(f"bond {bid_label} points at missing atom ({f} -> {t})")
            continue
        if f == t:
            issues.append(f"bond {bid_label} connects an atom to itself")
            continue
        key = "|".join(sorted((f, t)))
        if key in pair_seen:
            issues.append(f"duplicate bond between {f} and {t} (second one dropped)")
            continue
        pair_seen.add(key)
        bid = str(b["id"]) if b.get("id") is not None else f"__auto_b{i}"
        if bid in bond_ids:
            bid = f"{bid}__{i}"
        bond_ids.add(bid)
        order = _normalize_order(b.get("order", 1))
        bonds.append({
            "id": bid, "from": f, "to": t, "order": order,
            "lines": _bond_lines(atom_by_id[f], atom_by_id[t], order),
        })
    bond_by_id = {b["id"]: b for b in bonds}

    # ---- arrows
    arrows: List[Dict[str, Any]] = []
    peaks: List[Tuple[float, float]] = []
    pair_count: Dict[str, int] = {}
    for i, ar in enumerate(raw_arrows):
        if not isinstance(ar, dict):
            issues.append(f"arrow #{i} is not an object")
            continue
        f = str(ar["from"]) if ar.get("from") is not None else None
        t = str(ar["to"]) if ar.get("to") is not None else None
        p0 = _resolve_end(f, atom_by_id, bond_by_id) if f else None
        p1 = _resolve_end(t, atom_by_id, bond_by_id) if t else None
        if not p0 or not p1:
            issues.append(f"arrow #{i} references something that is not an atom or bond id ({f} -> {t})")
            continue
        n = pair_count.get(f"{f}>{t}", 0)
        pair_count[f"{f}>{t}"] = n + 1
        bend = _num(ar.get("bend"))
        side = (1 if bend > 0 else -1) if bend else (1 if n % 2 == 0 else -1)
        shape = _build_arrow(p0, p1, side)
        peaks.append(shape.pop("peak"))
        arrows.append({"from": f, "to": t, **shape})

    # ---- viewBox containing atoms + arrow curves
    if not atoms:
        view_box = "0 0 100 100"
    else:
        min_x = min(a["x"] - a["r"] - 4 for a in atoms)
        max_x = max(a["x"] + a["r"] + 4 for a in atoms)
        min_y = min(a["y"] - a["r"] - 4 for a in atoms)
        max_y = max(a["y"] + a["r"] + 4 for a in atoms)
        for px, py in peaks:
            min_x, max_x = min(min_x, px - 6), max(max_x, px + 6)
            min_y, max_y = min(min_y, py - 6), max(max_y, py + 6)
        w = max(max_x - min_x + PAD * 2, MIN_W)
        h = max(max_y - min_y + PAD * 2, MIN_H)
        cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
        view_box = f"{_r2(cx - w / 2)} {_r2(cy - h / 2)} {_r2(w)} {_r2(h)}"

    return {
        "title": step.get("title") or "",
        "description": step.get("description") or "",
        "atoms": atoms,
        "bonds": bonds,
        "arrows": arrows,
        "view_box": view_box,
        "issues": issues,
    }


def _fallback_step(step: Any, reason: str) -> Dict[str, Any]:
    """Empty-but-valid step so the frontend still renders the title and
    description (and shows the issue) instead of the whole reaction failing."""
    src = step if isinstance(step, dict) else {}
    return {
        "title": str(src.get("title") or ""),
        "description": str(src.get("description") or ""),
        "atoms": [],
        "bonds": [],
        "arrows": [],
        "view_box": "0 0 100 100",
        "issues": [reason],
    }


def prepare_step(step: Any, index: Optional[int] = None) -> Dict[str, Any]:
    """Safe wrapper around _prepare_step_unsafe. `index` is the 1-based step
    position, used only to make the log line point at the right step."""
    try:
        return _prepare_step_unsafe(step)
    except Exception:
        title = step.get("title") if isinstance(step, dict) else None
        logger.error(
            "Mechanism step prepare crashed | step=%s title=%r",
            index if index is not None else "?", title, exc_info=True,
        )
        return _fallback_step(step, "step could not be processed (internal error) - see server log")


def prepare_mechanism(steps: Any) -> List[Dict[str, Any]]:
    if steps is None:
        return []
    if not isinstance(steps, list):
        logger.warning("Mechanism prepare skipped | mechanism_steps is %s, expected a list", type(steps).__name__)
        return []
    return [prepare_step(s, n) for n, s in enumerate(steps, 1)]


# ------------------------------------------------------------ public: audit

def audit_step(step: Any) -> List[Tuple[str, str]]:
    """Inspect a RAW step. Returns [(severity, message)], severity being
    'ERROR' (draws wrongly as stored; the API repairs most of these at
    request time but the row should still be fixed) or 'WARN'."""
    out: List[Tuple[str, str]] = []
    if not isinstance(step, dict):
        return [("ERROR", "step is not an object")]
    atoms = step.get("atoms") or []
    bonds = step.get("bonds") or []
    arrows = step.get("arrows") or []

    if not atoms:
        return [("ERROR", "step has no atoms")]
    if not step.get("title"):
        out.append(("WARN", "step has no title"))
    if not step.get("description"):
        out.append(("WARN", "step has no description"))

    ids: Dict[str, Dict[str, Any]] = {}
    for i, a in enumerate(atoms):
        if not isinstance(a, dict):
            out.append(("ERROR", f"atom #{i} is not an object"))
            continue
        if a.get("id") is None:
            out.append(("ERROR", f"atom #{i} has no id"))
            continue
        aid = str(a["id"])
        if aid in ids:
            out.append(("ERROR", f'duplicate atom id "{aid}"'))
            continue
        el = a.get("element")
        if not el:
            out.append(("ERROR", f'atom "{aid}" has no element'))
        elif el not in ELEMENTS and el not in PSEUDO:
            fixed = str(el)[:1].upper() + str(el)[1:].lower()
            if fixed in ELEMENTS:
                out.append(("ERROR", f'atom "{aid}" element "{el}" should be "{fixed}"'))
            else:
                out.append(("WARN", f'atom "{aid}" has unrecognised element "{el}"'))
        x, y = _num(a.get("x")), _num(a.get("y"))
        if x is None or y is None:
            out.append(("ERROR", f'atom "{aid}" has non-numeric coordinates ({a.get("x")!r}, {a.get("y")!r})'))
            continue
        ids[aid] = {**a, "x": x, "y": y}

    items = list(ids.items())
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            (ia, a), (ib, b) = items[i], items[j]
            d = math.hypot(a["x"] - b["x"], a["y"] - b["y"])
            need = atom_radius(a) + atom_radius(b)
            if d < need:
                sev = "ERROR" if d < 1 else "WARN"
                out.append((sev, f'atoms "{ia}" ({a.get("element")}) and "{ib}" ({b.get("element")}) overlap (distance {d:.1f})'))

    bond_ids: Dict[str, Dict] = {}
    seen_pairs: set = set()
    valence = {aid: 0.0 for aid in ids}
    for i, b in enumerate(bonds):
        if not isinstance(b, dict):
            out.append(("ERROR", f"bond #{i} is not an object"))
            continue
        bid = b.get("id", f"#{i}")
        f = None if b.get("from") is None else str(b["from"])
        t = None if b.get("to") is None else str(b["to"])
        if f not in ids or t not in ids:
            out.append(("ERROR", f"bond {bid} points at a missing atom ({f} -> {t})"))
            continue
        if f == t:
            out.append(("ERROR", f"bond {bid} connects atom {f} to itself"))
            continue
        pair = tuple(sorted((f, t)))
        if pair in seen_pairs:
            out.append(("ERROR", f"duplicate bond between {f} and {t}"))
            continue
        seen_pairs.add(pair)
        if str(bid) in bond_ids:
            out.append(("WARN", f'duplicate bond id "{bid}"'))
        bond_ids[str(bid)] = b
        raw_order = b.get("order", 1)
        order = _num(raw_order)
        if order is None and isinstance(raw_order, str):
            order = BOND_WORDS.get(raw_order.strip().lower())
        if order not in (1, 2, 3, 1.5):
            out.append(("ERROR", f"bond {bid} has invalid order {raw_order!r}"))
            order = 1
        valence[f] += order
        valence[t] += order

    for aid, total in valence.items():
        a = ids[aid]
        el = a.get("element")
        if el not in MAX_VALENCE:
            continue
        charge = int(_num(a.get("charge")) or 0)
        mx = MAX_VALENCE[el]
        if el == "C" and charge != 0:
            mx = 3
        elif el in ("N", "O", "B"):
            mx += 1 if charge > 0 else -1 if charge < 0 else 0
        if total > mx:
            out.append(("ERROR", f'atom "{aid}" ({el}, charge {charge:+d}) has bond order sum {total:g} > max {mx}'))

    for i, ar in enumerate(arrows):
        if not isinstance(ar, dict):
            out.append(("ERROR", f"arrow #{i} is not an object"))
            continue
        f = None if ar.get("from") is None else str(ar["from"])
        t = None if ar.get("to") is None else str(ar["to"])
        for label, ref in (("from", f), ("to", t)):
            if ref is None or (ref not in ids and ref not in bond_ids):
                out.append(("ERROR", f"arrow #{i} {label} = {ref!r} is not an atom or bond id in this step"))
        if f is not None and f == t:
            out.append(("WARN", f"arrow #{i} starts and ends on {f} (drawn as a small loop)"))

    return out


def audit_reaction(steps: Any) -> List[Dict[str, Any]]:
    """Findings for one reaction's whole mechanism, as JSON-ready dicts."""
    findings: List[Dict[str, Any]] = []
    if not isinstance(steps, list) or not steps:
        return [{"severity": "WARN", "step": None, "message": "reaction has no mechanism steps"}]
    for n, st in enumerate(steps, 1):
        try:
            for sev, msg in audit_step(st):
                findings.append({"severity": sev, "step": n, "message": msg})
        except Exception:
            logger.error("Mechanism step audit crashed | step=%d", n, exc_info=True)
            findings.append({
                "severity": "ERROR", "step": n,
                "message": "audit could not process this step (internal error) - see server log",
            })
    return findings