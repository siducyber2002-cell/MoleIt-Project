"""Live compound lookups against PubChem's PUG REST API.

PubChem (https://pubchem.ncbi.nlm.nih.gov) is a free, public database run by
the NCBI/NIH. No API key or account is required for PUG REST — it's a plain
HTTP GET API. Their published etiquette guidelines ask clients to stay under
~5 requests/second and ~400 requests/minute per IP, which is irrelevant at
the scale of one user typing a compound name (or drawing a structure) into
the app.

This module resolves either a free-text name or a molecular formula to one
or more PubChem CIDs, pulls core properties + a 3D (falling back to 2D)
structure record, and converts that into the same shape our `Compound`
model / `compounds_seed.json` already use — so a PubChem hit is
indistinguishable from a hand-curated one everywhere else in the app (Draw
Lab, 3D viewer, quiz generator, etc).

Every fetched compound is cached in our own DB (see routers/compounds.py),
so a given name/CID only ever hits PubChem once.
"""
import re
import time
import math
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests

PUG_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
PUG_VIEW_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view"
# (connect_timeout, read_timeout). See routers/symmetry.py for why this is
# split rather than one flat number — a dead/blocked network path fails on
# the connect phase, and a short connect timeout catches that fast instead
# of waiting the full read timeout to find out.
TIMEOUT = (4, 9)
# PUG View's physical-properties record is the slowest single endpoint we
# call (it returns the whole compound "document" as a nested Section tree,
# which we then walk) and, per _fetch_physical_properties below, is
# explicitly best-effort — a normal, expected empty result for most
# compounds. It runs concurrently with everything else now, but giving it
# its own short timeout means one slow/absent PUG View record can't become
# the long pole for the whole fetch; it just comes back empty faster.
PHYSICAL_TIMEOUT = 5
# How much to scale PubChem's real atomic-coordinate units (roughly
# angstroms, ~1.5 per bond) up into the pixel-ish units the Draw Lab's
# structure_2d canvas already uses elsewhere (e.g. a 50px C-O bond).
COORD_SCALE = 38

# A shared, connection-pooling Session instead of bare `requests.get()`.
# Every PubChem call in this module hits the same host — without a shared
# Session, each one of those 6 concurrent calls in _record_from_cid opens
# and TLS-handshakes its own fresh TCP connection to
# pubchem.ncbi.nlm.nih.gov. Reusing a pooled, keep-alive Session lets
# later calls (and later requests from other users) skip that handshake
# entirely, which is a real, consistent latency win on top of running the
# calls concurrently.
_session = requests.Session()
_adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20)
_session.mount("https://", _adapter)


class PubChemNotFoundError(Exception):
    """No PubChem record matches the query."""


class PubChemServiceError(Exception):
    """PubChem reached but returned something we couldn't use."""


# BUG FIX (regression from an earlier fix): retrying is only worth doing
# for a transient blip. This used to retry 3x with growing backoff — fine
# on its own, but every one of the several sequential PubChem calls a
# single request makes (name lookup, then autocomplete, then name lookup
# again, etc.) each independently retried 3x, so a genuinely unreachable
# PubChem multiplied into minutes of waiting before finally failing. Now
# just one retry (2 attempts total) with a short fixed backoff — enough to
# survive a real one-off blip or a 503 "ServerBusy", without turning a hard
# network failure into a multi-minute hang.
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 2
_RETRY_BACKOFF = 0.4  # seconds


def _get(url, **kwargs):
    kwargs.setdefault("timeout", TIMEOUT)
    last_exc = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = _session.get(url, **kwargs)
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < _MAX_ATTEMPTS - 1:
                time.sleep(_RETRY_BACKOFF)
                continue
            raise
        if resp.status_code == 404:
            raise PubChemNotFoundError()
        if resp.status_code in _RETRYABLE_STATUS and attempt < _MAX_ATTEMPTS - 1:
            time.sleep(_RETRY_BACKOFF)
            continue
        resp.raise_for_status()
        return resp
    # Only reachable if every attempt raised a RequestException.
    raise last_exc


def _get_json(url, **kwargs):
    return _get(url, **kwargs).json()


def find_cid(query: str) -> int:
    """Resolve a free-text name (or formula) to a PubChem CID."""
    query = query.strip()
    if not query:
        raise PubChemNotFoundError()

    # Try as a compound name first (covers "aspirin", "ethanol", etc.)
    try:
        data = _get_json(f"{PUG_BASE}/compound/name/{quote(query)}/cids/JSON")
        cids = data.get("IdentifierList", {}).get("CID", [])
        if cids:
            return cids[0]
    except PubChemNotFoundError:
        pass

    # Fall back to autocomplete, in case of a typo or partial name, and
    # retry the winning suggestion as an exact name lookup.
    try:
        sugg = _get_json(
            f"https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/"
            f"{quote(query)}/json?limit=1"
        )
        candidates = sugg.get("dictionary_terms", {}).get("compound", [])
        if candidates:
            data = _get_json(f"{PUG_BASE}/compound/name/{quote(candidates[0])}/cids/JSON")
            cids = data.get("IdentifierList", {}).get("CID", [])
            if cids:
                return cids[0]
    except (PubChemNotFoundError, requests.RequestException):
        pass

    raise PubChemNotFoundError()


_RING_CLOSURE_PERCENT = re.compile(r"%\d{2}")
_RING_CLOSURE_DIGIT = re.compile(r"\d")
_BRACKET_ATOM = re.compile(r"\[[^\]]*\]")
_HYDROGEN_TOKEN = re.compile(r"H(?![a-z])(\d*)")
# FIXED: was `^C(\d*)`, which matched the leading "C" of ANY formula
# starting with a C-element — Cl, Ca, Cs, Cr, Cu, Co, Cd, etc. — not just
# actual carbon, e.g. adjust_hydrogen_count("ClNa", 1) produced the
# garbage formula "CHlNa" instead of "HClNa". The negative lookahead
# means "C" only counts as elemental carbon when it's NOT immediately
# followed by a lowercase letter (which would make it a two-letter
# symbol instead).
_LEADING_CARBON = re.compile(r"^C(?![a-z])(\d*)")
_FORMULA_TOKEN = re.compile(r"([A-Z][a-z]?)(\d*)")


def parse_formula_counts(formula: str) -> dict:
    """'C6H12O6' -> {'C': 6, 'H': 12, 'O': 6}. Normalizes a formula so two
    different notations of the same compound ("NaCl" vs the Draw Lab
    canvas's Hill-order "ClNa") compare equal by element counts instead of
    failing a brittle exact-string match."""
    counts: dict = {}
    if not formula:
        return counts
    for symbol, digits in _FORMULA_TOKEN.findall(formula):
        if not symbol:
            continue
        counts[symbol] = counts.get(symbol, 0) + (int(digits) if digits else 1)
    return counts


def estimate_ring_count(smiles: str | None) -> int:
    """Ring count straight from SMILES ring-closure digits — not a
    heuristic, but exact: every matched pair of ring-closure labels is by
    definition one edge beyond the spanning tree, which is exactly what a
    smallest-set-of-smallest-rings count is. Used to rank "did you mean"
    candidates by how structurally similar they are to what the student
    actually drew (e.g. preferring the six-membered-ring isomer of a
    formula over an open-chain one, when the student clearly drew a ring).
    """
    if not smiles:
        return 0
    # Strip bracket-atom contents first — isotope numbers or charges inside
    # [...] (like [13CH4] or [N+]) can contain digits that aren't ring
    # closure labels.
    stripped = _BRACKET_ATOM.sub("X", smiles)
    percent_closures = _RING_CLOSURE_PERCENT.findall(stripped)
    stripped = _RING_CLOSURE_PERCENT.sub("", stripped)
    single_digits = _RING_CLOSURE_DIGIT.findall(stripped)
    return (len(percent_closures) + len(single_digits)) // 2


def adjust_hydrogen_count(formula: str, delta: int) -> str | None:
    """Returns `formula` with its Hill-notation hydrogen count shifted by
    `delta`, or None if that's not representable (would go negative).
    Backs the "close match" fallback search: the single most common way a
    student's formula is *wrong* is a miscounted hydrogen (one missing or
    extra bond), while the heavy-atom skeleton they drew is correct — so
    when an exact-formula search comes up empty, nearby hydrogen counts are
    the highest-value thing to try next, rather than giving up."""
    m = _HYDROGEN_TOKEN.search(formula)
    if not m:
        if delta <= 0:
            return None
        cmatch = _LEADING_CARBON.match(formula)
        insert_at = cmatch.end() if cmatch else 0
        suffix = str(delta) if delta > 1 else ""
        return formula[:insert_at] + f"H{suffix}" + formula[insert_at:]
    current = int(m.group(1) or "1")
    next_count = current + delta
    if next_count < 0:
        return None
    if next_count == 0:
        return formula[: m.start()] + formula[m.end():]
    replacement = "H" if next_count == 1 else f"H{next_count}"
    return formula[: m.start()] + replacement + formula[m.end():]


def find_cids_by_formula(formula: str, max_records: int = 8) -> list[int]:
    """Exact molecular-formula search — the "did you mean...?" backbone for
    the Draw Lab's structure recognizer: a student's drawing (however
    distorted) reduces to a formula, and this finds real compounds sharing
    it. PubChem's fastformula search can be asynchronous for formulas with
    many hits (it returns a ListKey to poll instead of results directly);
    since this backs an interactive suggestion popover and not a batch job,
    we poll briefly and give up gracefully rather than block the request.
    """
    formula = (formula or "").strip()
    if not formula:
        return []
    url = f"{PUG_BASE}/compound/fastformula/{quote(formula)}/cids/JSON"
    try:
        data = _get_json(url, params={"MaxRecords": max_records})
    except (PubChemNotFoundError, PubChemServiceError, requests.RequestException):
        return []

    cids = data.get("IdentifierList", {}).get("CID")
    if cids:
        return cids[:max_records]

    list_key = data.get("Waiting", {}).get("ListKey")
    if not list_key:
        return []

    for _ in range(4):
        time.sleep(1)
        try:
            poll = _get_json(
                f"{PUG_BASE}/compound/listkey/{list_key}/cids/JSON",
                params={"MaxRecords": max_records},
            )
        except (PubChemNotFoundError, requests.RequestException):
            continue
        cids = poll.get("IdentifierList", {}).get("CID")
        if cids:
            return cids[:max_records]
    return []


def fetch_candidate_summaries(cids: list[int]) -> list[dict]:
    """Lightweight batch lookup — name/formula/SMILES only, no full
    structure — for showing a handful of "did you mean" suggestions
    cheaply (one request covers every CID)."""
    if not cids:
        return []
    id_list = ",".join(str(c) for c in cids)
    props = "MolecularFormula,IUPACName,CanonicalSMILES,Title"
    try:
        data = _get_json(f"{PUG_BASE}/compound/cid/{id_list}/property/{props}/JSON")
    except (PubChemNotFoundError, requests.RequestException):
        return []
    rows = data.get("PropertyTable", {}).get("Properties", [])
    out = []
    for r in rows:
        cid = r.get("CID")
        if cid is None:
            continue
        out.append(
            {
                "cid": cid,
                "name": r.get("Title") or r.get("IUPACName") or f"CID {cid}",
                "formula": r.get("MolecularFormula"),
                "smiles": r.get("IsomericSMILES") or r.get("CanonicalSMILES"),
                "ring_count": estimate_ring_count(r.get("IsomericSMILES") or r.get("CanonicalSMILES")),
            }
        )
    return out


#  The full computed-descriptor set PubChem exposes through the plain
# /property/ table (confirmed current as of PUG REST's documented property
# list). Everything here is a single cheap batched GET — no extra request
# per field — so there's no reason to under-ask and leave an "unknown"
# compound looking sparser than a hand-curated one.
_PROPERTY_FIELDS = (
    "MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,IsomericSMILES,"
    "Title,InChI,InChIKey,XLogP,ExactMass,MonoisotopicMass,TPSA,Complexity,"
    "Charge,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,HeavyAtomCount"
)


def _fetch_properties(cid: int) -> dict:
    data = _get_json(f"{PUG_BASE}/compound/cid/{cid}/property/{_PROPERTY_FIELDS}/JSON")
    rows = data.get("PropertyTable", {}).get("Properties", [])
    if not rows:
        raise PubChemServiceError("PubChem returned no properties for this CID")
    return rows[0]


def _fetch_description(cid: int) -> str | None:
    try:
        data = _get_json(f"{PUG_BASE}/compound/cid/{cid}/description/JSON")
    except PubChemNotFoundError:
        return None
    for info in data.get("InformationList", {}).get("Information", []):
        if info.get("Description"):
            return info["Description"]
    return None


_CAS_PATTERN = re.compile(r"^\d{2,7}-\d{2}-\d$")


def _fetch_synonyms(cid: int, limit: int = 8) -> tuple[list[str], str | None]:
    """Returns (a handful of display synonyms, CAS registry number or
    None). PubChem doesn't have a dedicated "CAS number" field — CAS
    numbers just show up as synonyms in a recognizable NNN-NN-N shape — so
    this is the standard way every PubChem client (including PubChemPy)
    recovers one."""
    try:
        data = _get_json(f"{PUG_BASE}/compound/cid/{cid}/synonyms/JSON")
    except (PubChemNotFoundError, requests.RequestException):
        return [], None
    info = data.get("InformationList", {}).get("Information", [])
    if not info:
        return [], None
    syns = info[0].get("Synonym", [])
    cas = None
    display = []
    for s in syns[:80]:
        if cas is None and _CAS_PATTERN.match(s):
            cas = s
            continue
        if len(display) < limit:
            display.append(s)
    return display, cas


# ---- Experimental / descriptive physical properties (PUG View) ----
# The plain /property/ table above is entirely *computed* descriptors —
# PubChem has no queryable field for "boiling point" or "what it looks
# like". That data instead lives in PUG View's per-compound "record"
# document, as a tree of Sections or fetched-from-source experimental
# facts (each with its own citation). This walks that tree for the
# handful of headings a student actually wants to see, and normalizes
# each into one short string.
_PHYSICAL_PROPERTY_HEADINGS = {
    "Physical Description": "appearance",
    "Color/Form": "color",
    "Odor": "odor",
    "Melting Point": "melting_point",
    "Boiling Point": "boiling_point",
    "Density": "density",
    "Solubility": "solubility",
    "Vapor Pressure": "vapor_pressure",
    "Flash Point": "flash_point",
    "Stability/Shelf Life": "stability",
}

_TRAILING_CITATION = re.compile(r"\s*\[[^\[\]]{1,80}\]\s*$")


def _clean_pugview_text(text: str) -> str | None:
    if not text:
        return None
    cleaned = text.strip()
    # PubChem's source-attributed facts often end in one or more
    # "[SourceName]" citation tags; strip them repeatedly (there can be
    # more than one) rather than displaying raw citation brackets to a
    # student reading a property table.
    while True:
        stripped = _TRAILING_CITATION.sub("", cleaned).strip()
        if stripped == cleaned:
            break
        cleaned = stripped
    if not cleaned:
        return None
    # A handful of headings (esp. "Physical Description") occasionally
    # return a multi-sentence paragraph pulled from a safety datasheet
    # rather than a short fact; keep it readable in a property row instead
    # of overflowing it.
    if len(cleaned) > 220:
        cleaned = cleaned[:217].rsplit(" ", 1)[0] + "…"
    return cleaned


def _pugview_walk(sections: list, heading: str, out: list) -> None:
    for sec in sections:
        if sec.get("TOCHeading") == heading:
            for info in sec.get("Information", []):
                value = info.get("Value", {}) or {}
                for s in value.get("StringWithMarkup", []) or []:
                    if s.get("String"):
                        out.append(s["String"])
                nums = value.get("Number")
                if nums:
                    unit = value.get("Unit", "")
                    out.extend(f"{n} {unit}".strip() for n in nums)
        if sec.get("Section"):
            _pugview_walk(sec["Section"], heading, out)


def _fetch_physical_properties(cid: int) -> dict:
    """Best-effort experimental property lookup. PUG View simply has no
    entry for most simple/inorganic compounds (or anything obscure) — an
    empty dict here is a normal, expected outcome, not an error, so every
    caller treats these fields as optional."""
    try:
        data = _get_json(f"{PUG_VIEW_BASE}/data/compound/{cid}/JSON", timeout=PHYSICAL_TIMEOUT)
    except (PubChemNotFoundError, PubChemServiceError, requests.RequestException):
        return {}
    sections = data.get("Record", {}).get("Section", [])
    result = {}
    for heading, key in _PHYSICAL_PROPERTY_HEADINGS.items():
        found: list = []
        _pugview_walk(sections, heading, found)
        for raw in found:
            cleaned = _clean_pugview_text(raw)
            if cleaned:
                result[key] = cleaned
                break
    return result


def _fetch_sdf(cid: int, record_type: str) -> str | None:
    try:
        resp = _get(f"{PUG_BASE}/compound/cid/{cid}/SDF", params={"record_type": record_type})
    except PubChemNotFoundError:
        return None
    text = resp.text.strip()
    return text or None


_ATOM_LINE = re.compile(
    r"^\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+([A-Za-z]{1,2})\b"
)
_BOND_LINE = re.compile(r"^\s*(\d+)\s+(\d+)\s+(\d+)")


def _parse_v2000(sdf_text: str):
    """Minimal V2000 molfile reader -> (atoms, bonds), both 1-indexed by
    original file order. Good enough for the well-formed SDFs PubChem
    emits; doesn't attempt charge blocks, isotopes, or V3000."""
    lines = sdf_text.splitlines()
    # Counts line is the 4th line of a molfile (after title, program, comment).
    if len(lines) < 4:
        raise PubChemServiceError("Malformed SDF from PubChem")
    counts = lines[3]
    try:
        n_atoms = int(counts[0:3])
        n_bonds = int(counts[3:6])
    except ValueError:
        raise PubChemServiceError("Malformed SDF counts line from PubChem")

    atom_lines = lines[4:4 + n_atoms]

    atoms = []
    for line in atom_lines:
        m = _ATOM_LINE.match(line)
        if not m:
            continue
        x, y, z, elem = m.groups()
        atoms.append({"x": float(x), "y": float(y), "z": float(z), "element": elem})

    # Scan forward for bond lines rather than slicing a fixed range —
    # robust to a property block (M  CHG etc.) landing between the atom
    # block and bond block out of strict V2000 order, which some
    # hand-authored mol blocks in this app's own library do.
    bonds = []
    idx = 4 + n_atoms
    while idx < len(lines) and len(bonds) < n_bonds:
        line = lines[idx]
        m = _BOND_LINE.match(line)
        if m and not line.strip().startswith("M"):
            a1, a2, order = (int(g) for g in m.groups())
            bonds.append({"from": a1, "to": a2, "order": order})
        idx += 1

    if len(atoms) != n_atoms:
        raise PubChemServiceError("Could not parse all atoms from PubChem SDF")
    return atoms, bonds


# ---- Geometry & hybridization, computed from real 3D bond angles ----
# PubChem doesn't expose "molecular geometry" or "hybridization" as a
# queryable property — there's no API call that returns "trigonal
# pyramidal". But every compound we fetch already comes with real 3D
# coordinates (the same ones used for the 3D viewer), and VSEPR geometry
# is, by definition, exactly what those coordinates already encode: the
# angles atoms actually sit at. So instead of leaving these fields blank
# for anything that isn't hand-curated, measure them directly.
_METAL_SYMBOLS = {
    "Li", "Na", "K", "Rb", "Cs", "Fr",
    "Be", "Mg", "Ca", "Sr", "Ba", "Ra",
    "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
    "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
    "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
    "Al", "Ga", "In", "Sn", "Tl", "Pb", "Bi", "Po",
}


def _bond_angle_degrees(a, b, c):
    """Angle ABC in degrees, measured at vertex b, from 3D coordinates."""
    v1 = (a[0] - b[0], a[1] - b[1], a[2] - b[2])
    v2 = (c[0] - b[0], c[1] - b[1], c[2] - b[2])
    dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]
    n1 = math.sqrt(sum(x * x for x in v1))
    n2 = math.sqrt(sum(x * x for x in v2))
    if n1 == 0 or n2 == 0:
        return None
    cos_theta = max(-1.0, min(1.0, dot / (n1 * n2)))
    return math.degrees(math.acos(cos_theta))


def _classify_atom_geometry(idx, atoms, adjacency):
    """Returns {element, geometry, hybridization} for one atom, or None if
    it doesn't have a well-defined local shape (fewer than 2 real covalent
    neighbors, or it's a metal)."""
    # A metal-to-nonmetal bond is ionic (a transferred electron, not a
    # shared pair) — it has no hybridization or VSEPR geometry, the same
    # chemistry the Draw Lab's ionic-bond validator is built on. Skip
    # classifying a metal atom itself, and don't let a bond TO a metal
    # count as a real electron domain for the other atom either (a
    # simplified NaOH-style drawing's O shouldn't misread its ionic Na-O
    # "bond" as a genuine covalent domain).
    if atoms[idx]["element"] in _METAL_SYMBOLS:
        return None
    neighbors = [i for i in adjacency.get(idx, []) if atoms[i]["element"] not in _METAL_SYMBOLS]
    n = len(neighbors)
    if n < 2:
        return None

    center = (atoms[idx]["x"], atoms[idx]["y"], atoms[idx]["z"])
    npos = [(atoms[i]["x"], atoms[i]["y"], atoms[i]["z"]) for i in neighbors]
    angles = []
    for i in range(len(npos)):
        for j in range(i + 1, len(npos)):
            a = _bond_angle_degrees(npos[i], center, npos[j])
            if a is not None:
                angles.append(a)
    if not angles:
        return None

    avg = sum(angles) / len(angles)
    angle_sum = sum(angles)

    # Bonded-neighbor count alone undercounts total electron domains when
    # lone pairs are present (water's O has only 2 bonded neighbors but 4
    # total domains). The measured angle is the tell: a genuinely 2-domain
    # linear center reads ~180°; a 2-neighbor center compressed toward
    # ~120° implies a hidden lone pair on an sp2 (3-domain) framework;
    # compressed toward ~109.5° or below implies two hidden lone pairs on
    # an sp3 (4-domain) framework.
    if n == 2:
        if avg >= 170:
            geometry, hybridization = "linear", "sp"
        elif avg >= 118:
            geometry, hybridization = "bent", "sp2"
        else:
            geometry, hybridization = "bent", "sp3"
    elif n == 3:
        # A perfectly planar 3-substituent center sums its three angles to
        # ~360°; a pyramidalized one (sp3, one lone pair, e.g. NH3) sums
        # closer to ~320-330°. Amide-type nitrogens are a well-known real
        # exception — resonance with an adjacent C=O flattens them toward
        # planar despite "looking like" an sp3 amine on paper, and a
        # relaxed 3D structure often lands them in-between (~335-350°)
        # rather than a perfect 360°, which this band accounts for.
        if angle_sum > 335:
            geometry, hybridization = "trigonal planar", "sp2"
        else:
            geometry, hybridization = "trigonal pyramidal", "sp3"
    elif n == 4:
        geometry = "tetrahedral" if 100 <= avg <= 120 else "irregular (4-coordinate)"
        hybridization = "sp3"
    elif n == 5:
        geometry, hybridization = "trigonal bipyramidal", "sp3d"
    elif n == 6:
        geometry, hybridization = "octahedral", "sp3d2"
    else:
        geometry, hybridization = f"{n}-coordinate", None

    # Total electron domains = bonded neighbors + inferred lone pairs.
    # sp -> 2 domains, sp2 -> 3, sp3 -> 4, sp3d -> 5, sp3d2 -> 6; anything
    # beyond n-coordinate with no clean hybridization label has no lone
    # pairs to infer (real hybridization just isn't well-defined there).
    domain_count = {"sp": 2, "sp2": 3, "sp3": 4, "sp3d": 5, "sp3d2": 6}.get(hybridization)
    lone_pairs = max(0, domain_count - n) if domain_count else 0

    reason = _geometry_reason(atoms[idx]["element"], n, lone_pairs, domain_count, geometry)

    return {
        "element": atoms[idx]["element"],
        "geometry": geometry,
        "hybridization": hybridization,
        "bonded_count": n,
        "lone_pairs": lone_pairs,
        "domain_count": domain_count,
        "reason": reason,
    }


def _geometry_reason(element: str, bonded_count: int, lone_pairs: int, domain_count, geometry: str) -> str:
    """Plain-English VSEPR explanation of *why* this atom has this shape —
    powers the interactive Bonding tab's hover explanation. Built from the
    same measured domain count that produced the geometry itself, so the
    reason always matches what's actually shown (no separate lookup table
    to fall out of sync)."""
    if not domain_count:
        return (
            f"{element} has {bonded_count} bonded neighbor"
            f"{'s' if bonded_count != 1 else ''}, measured directly from this "
            "structure's 3D coordinates."
        )
    domain_word = "electron domain" if domain_count == 1 else "electron domains"
    if lone_pairs == 0:
        return (
            f"{element} has {domain_count} {domain_word} around it, all of them bonding "
            f"pairs. With nothing else to account for, they spread out as far apart as "
            f"possible, which is exactly the {geometry} arrangement shown here."
        )
    lone_word = "lone pair" if lone_pairs == 1 else "lone pairs"
    return (
        f"{element} has {domain_count} {domain_word} around it — {bonded_count} bonding pair"
        f"{'s' if bonded_count != 1 else ''} and {lone_pairs} {lone_word}. All {domain_count} "
        f"domains still repel each other equally, but only the {bonded_count} bonded atom"
        f"{'s' if bonded_count != 1 else ''} are part of the visible shape, so the lone pair"
        f"{'s' if lone_pairs != 1 else ''} compress the bond angle(s) and the molecule reads as "
        f"{geometry} rather than the full symmetric electron-domain shape."
    )


def compute_geometry_summary(mol_block: str):
    """Measures real 3D bond angles in `mol_block` and returns
    (geometry_desc, hybridization_desc, bonding_notes, geometry_centers) —
    the same three text fields compounds_seed.json hand-writes for curated
    compounds, plus a structured per-atom breakdown (element, geometry,
    hybridization, lone pairs, and a plain-English reason) that the
    interactive Bonding tab uses to explain *why* each shape occurs on
    hover. Works for any valid 3D structure regardless of source, so a
    PubChem-fetched compound gets the same quality of geometry info as a
    curated one. Returns (None, None, None, []) if the structure has no
    atom with a well-defined local shape (e.g. a simple ionic salt like
    NaCl)."""
    try:
        atoms, bonds = _parse_v2000(mol_block)
    except PubChemServiceError:
        return None, None, None, []

    adjacency: dict = {}
    for b in bonds:
        i, j = b["from"] - 1, b["to"] - 1
        adjacency.setdefault(i, []).append(j)
        adjacency.setdefault(j, []).append(i)

    results = []
    for idx in range(len(atoms)):
        if atoms[idx]["element"] == "H":
            continue
        r = _classify_atom_geometry(idx, atoms, adjacency)
        if r:
            results.append(r)

    if not results:
        return None, None, None, []

    groups: dict = {}
    hybrid_counts: dict = {}
    for r in results:
        key = (r["element"], r["geometry"])
        groups[key] = groups.get(key, 0) + 1
        if r["hybridization"]:
            hybrid_counts[r["hybridization"]] = hybrid_counts.get(r["hybridization"], 0) + 1

    geometry_parts = []
    for (elem, geom), count in sorted(groups.items(), key=lambda kv: (-kv[1], kv[0])):
        label = geom[0].upper() + geom[1:]
        geometry_parts.append(f"{label} at {elem}" if count == 1 else f"{label} at {count} {elem} centers")
    geometry_desc = "; ".join(geometry_parts)

    hybridization_desc = ", ".join(
        f"{h} ({hybrid_counts[h]}x)" for h in sorted(hybrid_counts)
    ) if hybrid_counts else None

    bonding_notes = (
        "Geometry and hybridization below are computed directly from this structure's "
        f"3D bond angles (not hand-written): {geometry_desc}."
    )

    # One entry per distinct (element, geometry) group — not one per atom —
    # since a compound with e.g. four equivalent tetrahedral carbons only
    # needs to explain that shape once. Sorted the same way geometry_parts
    # was, so the diagram order matches the text summary order.
    seen_keys = set()
    geometry_centers = []
    for r in results:
        key = (r["element"], r["geometry"])
        if key in seen_keys:
            continue
        seen_keys.add(key)
        geometry_centers.append(
            {
                "element": r["element"],
                "geometry": r["geometry"],
                "hybridization": r["hybridization"],
                "bonded_count": r["bonded_count"],
                "lone_pairs": r["lone_pairs"],
                "domain_count": r["domain_count"],
                "count": groups[key],
                "reason": r["reason"],
            }
        )

    return geometry_desc, hybridization_desc, bonding_notes, geometry_centers


def _find_rings(n_atoms, adjacency, max_size=6):
    """All simple cycles up to `max_size` atoms, as lists of 0-indexed atom
    indices in cyclic (traversal) order. Small-molecule DFS, dedup'd by atom
    set — good enough for the ring sizes (5/6-membered) and molecule sizes
    (teaching-library organics: benzene rings, naphthalene/purine fused
    systems, etc.) this app deals with; not a general SSSR implementation."""
    seen_atom_sets = set()
    rings = []

    def dfs(start, path, visited):
        last = path[-1]
        for nxt in adjacency.get(last, ()):
            if nxt == start and len(path) >= 3:
                key = frozenset(path)
                if key not in seen_atom_sets:
                    seen_atom_sets.add(key)
                    rings.append(list(path))
            elif nxt not in visited and len(path) < max_size:
                dfs(start, path + [nxt], visited | {nxt})

    for atom in range(n_atoms):
        dfs(atom, [atom], {atom})
    return rings


def _detect_aromatic_bonds(atoms, bonds):
    """PubChem's 2D SDF encodes aromatic rings as an explicit Kekulé
    structure — alternating bond orders 1/2 around the ring — rather than
    molfile's dedicated aromatic bond-order value (4). Relying on `order ==
    4` alone (as this used to) means real aromatic rings from PubChem are
    silently missed and fall through to being read as plain alkenes
    downstream (NMR prediction, bond-order quiz questions, etc.).

    This detects them the same way a chemist would read a Kekulé drawing,
    atom by atom rather than ring by ring: find each 5- or 6-membered ring,
    and call a ring atom "aromatic-capable" if it has exactly one double
    bond total (a plain sp2 ring carbon/nitrogen, e.g. pyridine's N) or zero
    double bonds and is N/O/S (a furan/pyrrole/thiophene-style atom that
    contributes a lone pair to the pi system instead of a double bond). A
    ring is aromatic if every one of its atoms qualifies.

    Checking the *atom's total* double-bond count (not just this ring's two
    edges) rather than counting doubles per ring is what makes this work for
    fused systems (naphthalene, indole, purines like caffeine's bicyclic
    core): at a fusion atom, the Kekulé structure puts that atom's one
    double bond on whichever of its two rings "owns" it in that drawing, so
    the *other* ring only contributes 2 of its own 3 double bonds directly —
    counting per-ring would wrongly reject that ring, even though the atom
    is genuinely sp2/aromatic for both.

    Returns the set of aromatic bonds as frozenset({0-indexed atom a,
    0-indexed atom b}) pairs.
    """
    n_atoms = len(atoms)
    adjacency: dict = {}
    bond_order = {}
    for b in bonds:
        i, j = b["from"] - 1, b["to"] - 1
        adjacency.setdefault(i, []).append(j)
        adjacency.setdefault(j, []).append(i)
        bond_order[frozenset((i, j))] = b["order"]

    rings = [r for r in _find_rings(n_atoms, adjacency, max_size=6) if len(r) in (5, 6)]

    # A double bond only counts toward an atom's aromaticity if it's a ring
    # bond (possibly of a *different* fused ring the atom also belongs to) —
    # an exocyclic double bond, like the C=O on a quinone ring carbon, does
    # NOT make that atom a lone-pair/pi-system contributor to the ring; it
    # makes the ring a plain (non-aromatic) cyclohexadiene-dione instead.
    ring_edges = set()
    for ring in rings:
        size = len(ring)
        ring_edges.update(frozenset((ring[i], ring[(i + 1) % size])) for i in range(size))

    double_bond_count = {i: 0 for i in range(n_atoms)}
    has_triple_bond = {i: False for i in range(n_atoms)}
    for pair, order in bond_order.items():
        if order == 2 and pair not in ring_edges:
            continue  # exocyclic double bond - doesn't count toward ring aromaticity
        for atom_idx in pair:
            if order == 2:
                double_bond_count[atom_idx] += 1
            elif order == 3:
                has_triple_bond[atom_idx] = True

    lone_pair_donors = {"N", "O", "S"}

    def atom_is_aromatic_capable(atom_idx):
        if has_triple_bond[atom_idx]:
            return False
        doubles = double_bond_count[atom_idx]
        if doubles == 1:
            return True
        if doubles == 0 and atoms[atom_idx]["element"] in lone_pair_donors:
            return True
        return False

    aromatic_pairs = set()
    for ring in rings:
        size = len(ring)
        ring_bond_pairs = [frozenset((ring[i], ring[(i + 1) % size])) for i in range(size)]
        orders = [bond_order.get(pair) for pair in ring_bond_pairs]
        if any(o not in (1, 2) for o in orders):
            continue
        if any(orders[i] == 2 and orders[(i + 1) % size] == 2 for i in range(size)):
            continue  # cumulated double bonds aren't an aromatic Kekulé pattern
        if not all(atom_is_aromatic_capable(a) for a in ring):
            continue
        aromatic_pairs.update(ring_bond_pairs)
    return aromatic_pairs


def _molblock_to_structure_2d(sdf_2d: str) -> dict:
    """Build the app's {atoms:[{id,element,x,y}], bonds:[{id,from,to,order,aromatic}]}
    shape (used by the Draw Lab canvas / quiz 2D questions) from a 2D SDF."""
    atoms, bonds = _parse_v2000(sdf_2d)
    aromatic_pairs = _detect_aromatic_bonds(atoms, bonds)
    out_atoms = [
        {
            "id": f"a{i}",
            "element": a["element"],
            "x": round(a["x"] * COORD_SCALE, 2),
            # SDF/molfile Y is up; screen space is down, so flip it.
            "y": round(-a["y"] * COORD_SCALE, 2),
        }
        for i, a in enumerate(atoms)
    ]
    out_bonds = [
        {
            "id": f"b{i}",
            "from": f"a{b['from'] - 1}",
            "to": f"a{b['to'] - 1}",
            "order": 1 if b["order"] == 4 else b["order"],
            "aromatic": b["order"] == 4
            or frozenset((b["from"] - 1, b["to"] - 1)) in aromatic_pairs,
        }
        for i, b in enumerate(bonds)
    ]
    return {"atoms": out_atoms, "bonds": out_bonds}


def _clean_mol_block(sdf_text: str) -> str:
    """PubChem SDFs can bundle trailing '> <TAG>' data fields and an
    end-of-record '$$$$' marker after 'M  END' — strip everything from
    'M  END' onward except that line itself, since downstream code (and
    3Dmol.js) only wants the connection table."""
    idx = sdf_text.find("M  END")
    if idx == -1:
        return sdf_text
    return sdf_text[: idx + len("M  END")] + "\n"


def _find_carboxyl_and_free_amine(atoms, bonds):
    """Scans a parsed structure for (a) a genuine carboxylic acid carbon
    (C double-bonded to one O and single-bonded to another) and (b) a
    'free' amine nitrogen — one that is NOT part of an amide (bonded to a
    carbonyl carbon) and NOT a nitrile nitrogen. Together these two are
    exactly the alpha-amino-acid signature (an -NH2 and a -COOH on the
    same small skeleton), which is a real structural fact, not a guess."""
    adjacency = {}
    for b in bonds:
        i, j = b["from"] - 1, b["to"] - 1
        adjacency.setdefault(i, []).append((j, b["order"]))
        adjacency.setdefault(j, []).append((i, b["order"]))

    def neighbors(idx):
        return [(atoms[j]["element"], order) for j, order in adjacency.get(idx, [])]

    has_carboxyl = False
    has_free_amine = False
    for idx, atom in enumerate(atoms):
        el = atom["element"]
        nbrs = neighbors(idx)
        if el == "C":
            dbl_o = any(e == "O" and order == 2 for e, order in nbrs)
            sgl_o = any(e == "O" and order == 1 for e, order in nbrs)
            if dbl_o and sgl_o:
                has_carboxyl = True
        elif el == "N":
            if any(order == 3 for _, order in nbrs):
                continue  # nitrile nitrogen
            bonded_to_carbonyl = False
            for j, order in adjacency.get(idx, []):
                if order == 1 and atoms[j]["element"] == "C":
                    c_nbrs = neighbors(j)
                    if any(e == "O" and o == 2 for e, o in c_nbrs):
                        bonded_to_carbonyl = True
                        break
            if not bonded_to_carbonyl:
                has_free_amine = True
    return has_carboxyl, has_free_amine


# Matches the curated library's own category taxonomy (compounds_seed.json)
# so a PubChem-fetched compound and a hand-curated one are classified on
# the same terms in the Library filters and the quiz's "which category"
# question. This is a heuristic, structure/stoichiometry-based classifier
# (real functional-group presence and real formula ratios — not a lookup
# table of names), so it can label anything PubChem returns, not just a
# fixed list. It intentionally does NOT attempt "Pharmaceuticals",
# "Biochemistry", or "Famous Molecules" — those are curatorial/contextual
# judgments (why a compound matters), not something derivable from
# structure alone, so guessing at them would be exactly the kind of
# fabricated-but-confident label this fix is meant to eliminate. A
# PubChem compound that doesn't match a specific bucket below correctly
# falls back to the broad, always-true Organic/Inorganic split.
def _has_mineral_oxoacid_pattern(atoms, bonds):
    """True if a nonmetal center (S, N, P, or a halogen) has both a
    double-bonded O and a single-bonded O that itself carries an H -- the
    structural signature every real mineral oxoacid shares (HNO3, HNO2,
    H2SO4, H3PO4, HClO...). This is deliberately structural rather than
    formula-based: a formula-only rule ("has H, O, and N/S/P/halogen") also
    matches compounds that plainly aren't acids -- hydroxylamine (NH2OH) has
    exactly that element set but no N=O bond at all, so it's a base/
    reducing agent, not an acid; the same formula-only rule would wrongly
    call it one."""
    oxoacid_centers = {"S", "N", "P", "Cl", "Br", "I"}
    adjacency = {}
    for b in bonds:
        i, j = b["from"] - 1, b["to"] - 1
        adjacency.setdefault(i, []).append((j, b["order"]))
        adjacency.setdefault(j, []).append((i, b["order"]))

    def neighbors(idx):
        return [(atoms[j]["element"], order) for j, order in adjacency.get(idx, [])]

    for idx, atom in enumerate(atoms):
        if atom["element"] not in oxoacid_centers:
            continue
        nbrs = neighbors(idx)
        has_double_o = any(e == "O" and order == 2 for e, order in nbrs)
        oh_oxygens = [j for j, order in adjacency.get(idx, []) if order == 1 and atoms[j]["element"] == "O"]
        has_single_o_with_h = any(
            any(atoms[k]["element"] == "H" for k, _ in adjacency.get(o_idx, [])) for o_idx in oh_oxygens
        )
        if has_double_o and has_single_o_with_h:
            return True
    return False


def classify_category(formula: str, mol_block: str | None) -> str:
    counts = parse_formula_counts(formula)
    if not counts:
        return "Inorganic"

    elements = set(counts.keys())
    has_carbon = counts.get("C", 0) > 0
    metals_present = elements & _METAL_SYMBOLS

    # Metal hydroxide (NaOH, KOH, Ca(OH)2, ...): only metal + O + H, one H
    # per O — exactly the hydroxide ion's stoichiometry.
    non_metal_non_o_h = elements - metals_present - {"O", "H"}
    if (
        metals_present
        and not non_metal_non_o_h
        and counts.get("O", 0) >= 1
        and counts.get("H", 0) == counts.get("O", 0)
    ):
        return "Bases"

    parsed_atoms = parsed_bonds = None
    if mol_block:
        try:
            parsed_atoms, parsed_bonds = _parse_v2000(mol_block)
        except PubChemServiceError:
            pass

    has_carboxyl = has_free_amine = False
    if parsed_atoms is not None:
        has_carboxyl, has_free_amine = _find_carboxyl_and_free_amine(parsed_atoms, parsed_bonds)

    if has_carboxyl and has_free_amine:
        return "Amino Acids"

    if has_carboxyl:
        return "Acids"

    # Simple mineral acids with no carbon: a genuine oxoacid center (S, N,
    # P, or a halogen bonded to both a double-bonded O and a single-bonded
    # O carrying an H — H2SO4, HNO3, H3PO4...) checked structurally when a
    # mol block is available, since the formula alone can't distinguish a
    # real oxoacid from something like hydroxylamine (NH2OH) which has the
    # same element set but no N=O bond and isn't an acid at all. Falls back
    # to the formula-only heuristic only when no structure is available.
    if not has_carbon and counts.get("H", 0) >= 1:
        if parsed_atoms is not None:
            if _has_mineral_oxoacid_pattern(parsed_atoms, parsed_bonds):
                return "Acids"
        else:
            oxoacid_formers = elements & {"S", "N", "P", "C", "Cl", "Br", "I"}
            if oxoacid_formers and counts.get("O", 0) >= 1:
                return "Acids"
        if (elements & {"F", "Cl", "Br", "I"}) and elements <= {"H", "F", "Cl", "Br", "I"}:
            return "Acids"

    # Carbohydrate stoichiometry Cx(H2O)y: hydrogen count is exactly
    # twice the oxygen count, with real ring/chain carbon and oxygen
    # content (not just e.g. CO2's coincidental 0:0 case).
    if has_carbon and counts.get("O", 0) >= 3 and counts.get("C", 0) >= 3:
        if counts.get("H", 0) == 2 * counts.get("O", 0):
            return "Carbohydrates"

    return "Organic" if has_carbon else "Inorganic"


def _record_from_cid(cid: int, *, query_for_common_name: str | None = None) -> dict:
    """Shared by both name-based and CID-based resolution: given a CID we
    already trust, pulls properties/description/structure and builds a
    dict with the same keys as a row in compounds_seed.json.

    The six PubChem lookups below (properties, description, 3D SDF, 2D
    SDF, synonyms, PUG View physical properties) are all independent of
    each other -- none needs another's result -- so they used to be fired
    off one after another, each paying its own full network round trip.
    Firing them concurrently instead means the whole function takes
    roughly as long as the single slowest call (usually PUG View) rather
    than the sum of all six, which was regularly pushing a single fetch
    past 45-60s and blowing through the frontend's axios timeout even
    though PubChem itself was answering every request just fine.
    """
    with ThreadPoolExecutor(max_workers=6) as pool:
        f_props = pool.submit(_fetch_properties, cid)
        f_description = pool.submit(_fetch_description, cid)
        f_sdf_3d = pool.submit(_fetch_sdf, cid, "3d")
        f_sdf_2d = pool.submit(_fetch_sdf, cid, "2d")
        f_synonyms = pool.submit(_fetch_synonyms, cid)
        f_physical = pool.submit(_fetch_physical_properties, cid)

        props = f_props.result()
        description = f_description.result()
        sdf_3d = f_sdf_3d.result()
        sdf_2d = f_sdf_2d.result()
        synonyms, cas_number = f_synonyms.result()
        physical = f_physical.result()

    if not sdf_3d and not sdf_2d:
        raise PubChemServiceError("PubChem has no structure record for this compound")

    mol_block = _clean_mol_block(sdf_3d or sdf_2d)
    structure_2d = _molblock_to_structure_2d(sdf_2d) if sdf_2d else {"atoms": [], "bonds": []}

    # Only measure geometry off genuine 3D coordinates — a 2D depiction
    # (the fallback when PubChem has no 3D conformer for this compound)
    # has z=0 for every atom and often simplifies bond angles for visual
    # clarity (e.g. drawing a tetrahedral center's bonds at a flat 120°),
    # which would misclassify it.
    geometry_desc = hybridization_desc = bonding_notes = None
    geometry_centers: list = []
    if sdf_3d:
        geometry_desc, hybridization_desc, bonding_notes, geometry_centers = compute_geometry_summary(sdf_3d)

    name = props.get("Title") or (query_for_common_name or "").strip().title() or f"CID {cid}"
    formula = props.get("MolecularFormula") or "?"
    molar_mass = props.get("MolecularWeight")
    molar_mass_str = f"{molar_mass} g/mol" if molar_mass else None
    common_name = None
    if query_for_common_name and query_for_common_name.strip().lower() != name.lower():
        common_name = query_for_common_name.strip().title()

    return {
        "name": name,
        "common_name": common_name,
        "category": classify_category(formula, mol_block),
        "smiles": props.get("IsomericSMILES") or props.get("CanonicalSMILES"),
        "formula": formula,
        "molar_mass": molar_mass_str,
        "description": description or f"A compound fetched live from PubChem (CID {cid}).",
        "uses": None,
        "structure_2d": structure_2d,
        "mol_block": mol_block,
        "image_hint": None,
        "iupac_name": props.get("IUPACName"),
        "interesting_facts": None,
        "geometry": geometry_desc,
        "hybridization": hybridization_desc,
        "bonding_notes": bonding_notes,
        "geometry_centers": geometry_centers,
        "source": "pubchem",
        "pubchem_cid": str(cid),
        # Identifiers
        "inchi": props.get("InChI"),
        "inchikey": props.get("InChIKey"),
        "cas_number": cas_number,
        "synonyms": synonyms,
        # Computed descriptors (straight from PubChem's property table)
        "xlogp": str(props["XLogP"]) if props.get("XLogP") is not None else None,
        "exact_mass": f"{props['ExactMass']} g/mol" if props.get("ExactMass") is not None else None,
        "monoisotopic_mass": f"{props['MonoisotopicMass']} g/mol" if props.get("MonoisotopicMass") is not None else None,
        "tpsa": f"{props['TPSA']} Å²" if props.get("TPSA") is not None else None,
        "complexity": str(props["Complexity"]) if props.get("Complexity") is not None else None,
        "charge": int(props["Charge"]) if props.get("Charge") is not None else None,
        "h_bond_donor_count": props.get("HBondDonorCount"),
        "h_bond_acceptor_count": props.get("HBondAcceptorCount"),
        "rotatable_bond_count": props.get("RotatableBondCount"),
        "heavy_atom_count": props.get("HeavyAtomCount"),
        # Experimental / descriptive physical properties (PUG View, best-effort)
        "appearance": physical.get("appearance") or physical.get("color"),
        "odor": physical.get("odor"),
        "melting_point": physical.get("melting_point"),
        "boiling_point": physical.get("boiling_point"),
        "density": physical.get("density"),
        "solubility": physical.get("solubility"),
        "vapor_pressure": physical.get("vapor_pressure"),
        "flash_point": physical.get("flash_point"),
        "stability": physical.get("stability"),
    }


def build_compound_record(query: str) -> dict:
    """Resolve `query` (a free-text name) against PubChem and return a dict
    with the same keys as a row in compounds_seed.json, ready to hand to
    the Compound model."""
    cid = find_cid(query)
    return _record_from_cid(cid, query_for_common_name=query)


def build_compound_record_by_cid(cid: int) -> dict:
    """Same as build_compound_record, but for when we already know exactly
    which CID we want (e.g. the user picked one of several "did you
    mean...?" suggestions) instead of resolving a name that could be
    ambiguous."""
    return _record_from_cid(cid)