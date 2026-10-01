"""Molecular point-group / group-theory analysis.

Everything numerical lives in `symmetry_engine.py`: given a 3-D structure
(XYZ / SDF-MOL / PDB text), it discovers the real symmetry operations by
testing candidate axes/planes against the geometry, classifies the point
group from the resulting operation set, and reduces the 3N Cartesian
representation (character-table projection) into Gamma_trans + Gamma_rot +
Gamma_vib. This router is a thin HTTP wrapper around that engine plus a
PubChem 3-D structure proxy, so the browser never needs to talk to
PubChem directly (no CORS, and it keeps the tolerance/engine logic
server-side rather than duplicated in the client).
"""
import re
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests
from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from .. import symmetry_engine as engine
from .. import symmetry_report as report_builder
from .. import structure_builder
from .. import conformer_naming
from .. import conformer_search
from ..exceptions import BadRequestError, UpstreamServiceError, UpstreamUnavailableError
from ..logging_config import get_logger
from ..net import DeadlineExceeded, run_with_deadline
from ..responses import ok, err

logger = get_logger(__name__)

router = APIRouter(prefix="/api/symmetry", tags=["symmetry"])

PUG_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
# (connect_timeout, read_timeout) instead of one flat number. If PubChem is
# genuinely unreachable (blocked egress, dead route, DNS issue) the TCP
# handshake itself never completes — a flat 12s "timeout" actually meant
# waiting the full 12s per attempt just to learn that, and with retries
# stacked on top of retries (see below) that turned into minutes. A short
# connect timeout fails that case fast; the read timeout stays generous for
# a slow-but-reachable PubChem.
PUBCHEM_TIMEOUT = (4, 9)

# Shared, connection-pooling Session (mirrors pubchem.py) instead of bare
# requests.get() — every call here hits the same PubChem host, so reusing
# one pooled, keep-alive Session skips a fresh TCP/TLS handshake per call.
_session = requests.Session()
_session.mount("https://", requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20))

# BUG FIX (regression from an earlier fix): this router now retries
# transient failures (a dropped connection, PubChem's 503 "ServerBusy")
# instead of dying on the first one — but the previous version retried
# 3x *at this layer*, and _resolve_cid() below calls this layer up to
# three separate times (exact lookup, autocomplete, exact lookup again),
# each of which could ALSO retry 3x — so a genuinely unreachable PubChem
# multiplied out to 9+ full-timeout waits before finally failing, which is
# exactly the multi-minute hang just reported. Fixed two ways: (1) only one
# retry here (2 attempts total, not 3), and (2) _resolve_cid now stops
# immediately the first time it learns PubChem is flat-out unreachable,
# instead of ploughing through the rest of its fallback chain on a network
# path that already just failed.
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 2
_RETRY_BACKOFF_BASE = 0.4  # seconds


def _get_with_retry(url, **kwargs):
    """Shared GET helper for this router: retries transient failures
    (dropped connections, 429/5xx) once, with a short backoff, before
    giving up. Raises UpstreamUnavailableError if PubChem could never be
    reached at all, or returns the final `requests.Response` (which may
    still be a real 4xx — the caller decides what a non-2xx *reachable*
    response means)."""
    kwargs.setdefault("timeout", PUBCHEM_TIMEOUT)
    last_exc = None
    for attempt in range(_MAX_ATTEMPTS):
        t0 = time.monotonic()
        logger.info("_get_with_retry: GET %s (attempt %d/%d) starting", url, attempt + 1, _MAX_ATTEMPTS)
        try:
            resp = _session.get(url, **kwargs)
        except requests.RequestException as exc:
            logger.info(
                "_get_with_retry: GET %s attempt %d raised %s after %.2fs",
                url, attempt + 1, type(exc).__name__, time.monotonic() - t0,
            )
            last_exc = exc
            if attempt < _MAX_ATTEMPTS - 1:
                time.sleep(_RETRY_BACKOFF_BASE)
                continue
            raise UpstreamUnavailableError(
                "Could not reach PubChem (connection failed or timed out repeatedly). "
                "This is a network-reachability problem, not a bad compound name."
            )
        logger.info(
            "_get_with_retry: GET %s attempt %d got status=%s after %.2fs",
            url, attempt + 1, resp.status_code, time.monotonic() - t0,
        )
        if resp.status_code in _RETRYABLE_STATUS and attempt < _MAX_ATTEMPTS - 1:
            time.sleep(_RETRY_BACKOFF_BASE)
            continue
        return resp
    raise UpstreamUnavailableError("Could not reach PubChem.") if last_exc else None



_BLOCK_2D = (
    "This structure has flattened 2-D coordinates (every atom at z=0), so a point group computed from it "
    "would be meaningless. No symmetry analysis was performed -- paste a real 3-D structure (XYZ/SDF/PDB)."
)
_BLOCK_UNCONVERGED = (
    "The automatically generated 3-D geometry did not converge in the xTB optimisation, so it is not a "
    "trustworthy minimum and no symmetry analysis was performed. Paste a real 3-D structure (XYZ/SDF/PDB), "
    "e.g. from a crystal structure or your own optimisation."
)
_BLOCKED_QUALITIES = {
    "2d-fallback": _BLOCK_2D,
    "generated-3d-xtb-unconverged": _BLOCK_UNCONVERGED,
}


def _guard_structure_text(text: str) -> None:
    """Refuses inputs that cannot give a meaningful point group. Detects a 2-D
    molfile from its header dimensionality flag, and our own unconverged-xTB
    marker. Raised as BadRequestError so /analyze answers 400 with the reason."""
    if "NOT-CONVERGED" in text[:400] and "GFN2-xTB" in text[:400]:
        raise BadRequestError(_BLOCK_UNCONVERGED)
    lines = text.splitlines()
    if len(lines) > 3 and re.search(r"\bV[23]000\b", text):
        # molfile line 2 ends with the dimensionality code, e.g. "  -OEChem-093026072220 2D" style
        # headers: ten date digits immediately followed by 2D / 3D. Look at both of the first
        # header lines in case the name line was stripped or left blank.
        for header in lines[:3]:
            m = re.search(r"\d{10}([23])D", header)
            if m:
                if m.group(1) == "2":
                    raise BadRequestError(_BLOCK_2D)
                break


class AnalyzeRequest(BaseModel):
    structure: str = Field(..., description="XYZ, SDF/MOL (V2000/V3000), or PDB text")
    tolerance: float | None = Field(None, ge=0.001, le=1.0)


class ReportRequest(BaseModel):
    structure: str = Field(..., description="The exact structure text the result was calculated from")
    tolerance: float | None = Field(None, ge=0.001, le=1.0)
    pubchemCid: str | None = Field(None, max_length=20, pattern=r"^\d+$", description="Optional PubChem CID, added to the report header")


class GenerateRequest(BaseModel):
    cid: str = Field(..., min_length=1, max_length=20, pattern=r"^\d+$", description="PubChem CID to build a 3-D geometry for")


class ConformerRequest(BaseModel):
    cid: str = Field(..., min_length=1, max_length=20, pattern=r"^\d+$")
    conformerId: str = Field(..., min_length=4, max_length=40, pattern=r"^[0-9A-Za-z_-]+$")


class ConformerNamesRequest(BaseModel):
    cid: str = Field(..., min_length=1, max_length=20, pattern=r"^\d+$")
    conformerIds: list[str] = Field(..., min_length=1, max_length=10)


class PubchemRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Compound name or PubChem CID")
    tolerance: float | None = Field(None, ge=0.001, le=1.0)


# Hard wall-clock cap for the symmetry-detection engine itself. See
# run_with_deadline in net.py -- same pattern, applied here because the
# engine's runtime scales with atom count/symmetry richness and, unlike the
# PubChem network calls, had no bound at all before this.
_ANALYSIS_DEADLINE_SECONDS = 40


def _run_analysis(structure_text: str, tolerance: float | None):
    try:
        # Even with the engine speedups above, a large/unusually symmetric
        # pasted structure (a fullerene, a bigger cluster) could still take
        # a while -- this is the same hard-deadline pattern used for the
        # PubChem network calls, applied to the analysis step itself, which
        # was previously the one part of this endpoint with no cap at all.
        result = run_with_deadline(engine.analyze, structure_text, tolerance or engine.TOL_DEFAULT, timeout=_ANALYSIS_DEADLINE_SECONDS)
    except engine.SymmetryError as e:
        raise BadRequestError(str(e))
    _attach_conformer_name(result, structure_text)
    return result


def _attach_conformer_name(target: dict, structure_text: str, parsed: dict | None = None) -> None:
    """Adds `conformerName` / `conformerDetail` (e.g. "Staggered", "Chair", "Trigonal bipyramidal")
    when the geometry is recognisable. Purely decorative: any failure just leaves the keys out."""
    try:
        named = conformer_naming.name_conformer(parsed or engine.parse_structure(structure_text))
    except Exception:  # noqa: BLE001
        logger.info("Conformer naming skipped", exc_info=True)
        return
    if named:
        target["conformerName"] = named["name"]
        target["conformerDetail"] = named["detail"]


@router.get("/demos")
def list_demos():
    logger.info("List symmetry demos requested")
    return ok(200, "Demo structures fetched successfully", demos=engine.DEMOS)


@router.post("/analyze")
def analyze_structure(payload: AnalyzeRequest):
    logger.info("Symmetry analyze requested | chars=%d tol=%s", len(payload.structure), payload.tolerance)
    try:
        _guard_structure_text(payload.structure)
        result = _run_analysis(payload.structure, payload.tolerance)
        logger.info("Symmetry analyze succeeded | group=%s ops=%s", result["group"], result["orderLabel"] or result["detectedOps"])
        return ok(200, "Structure analyzed successfully", result=result)
    except BadRequestError as e:
        logger.warning("Symmetry analyze failed | reason=%s", e)
        return err(400, str(e))
    except DeadlineExceeded as e:
        logger.warning("Symmetry analyze timed out (deadline exceeded) | reason=%s", e)
        return err(503, "This structure's exact symmetry search took too long (likely a large and/or highly symmetric structure). Try a larger tolerance, or a smaller/simplified structure.")
    except Exception:
        logger.error("Symmetry analyze crashed", exc_info=True)
        return err(500, "Internal server error")


@router.post("/report")
def export_report(payload: ReportRequest):
    """Builds the downloadable point-group report and returns it as a file.

    The browser sends only the structure text and tolerance; the analysis is
    re-run here and the Markdown is generated server-side
    (symmetry_report.py), so the exported numbers always come straight from
    the engine rather than from whatever the client had in memory. Success
    returns the raw file (Content-Disposition: attachment); failures use the
    usual JSON error shape from responses.err().
    """
    logger.info("Symmetry report export requested | chars=%d tol=%s cid=%s", len(payload.structure), payload.tolerance, payload.pubchemCid)
    try:
        result = _run_analysis(payload.structure, payload.tolerance)
        body = report_builder.build_report_markdown(result, pubchem_cid=payload.pubchemCid)
        filename = report_builder.report_filename(result)
        logger.info("Symmetry report export succeeded | group=%s file=%s bytes=%d", result["group"], filename, len(body))
        return Response(
            content=body.encode("utf-8"),
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Report-Filename": filename,
                # Cross-origin fetches can only read these headers if they're exposed.
                "Access-Control-Expose-Headers": "Content-Disposition, X-Report-Filename",
                "Cache-Control": "no-store",
            },
        )
    except BadRequestError as e:
        logger.warning("Symmetry report export failed | reason=%s", e)
        return err(400, str(e))
    except DeadlineExceeded as e:
        logger.warning("Symmetry report export timed out (deadline exceeded) | reason=%s", e)
        return err(503, "This structure's exact symmetry search took too long (likely a large and/or highly symmetric structure). Try a larger tolerance, or a smaller/simplified structure.")
    except Exception:
        logger.error("Symmetry report export crashed", exc_info=True)
        return err(500, "Internal server error")


def _preview_from_structure(cid: str, text: str, quality: str, note: str | None, warning: str | None,
                            expected_formula: str | None = None) -> dict:
    """Identity-checks a structure and turns it into the atoms/bonds preview the browser draws.
    Never runs the symmetry engine."""
    _verify_structure(cid, text, expected_formula)
    parsed = engine.parse_structure(text)
    formula = {}
    for a in parsed["atoms"]:
        formula[a["el"]] = formula.get(a["el"], 0) + 1
    preview = {
        "pubchemCid": cid,
        "pubchemUrl": f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}",
        "sourceStructure": text,
        "structureQuality": quality,
        "atomCount": len(parsed["atoms"]),
        "bondCount": len(parsed["bonds"]),
        "formulaPretty": engine.pretty_formula(formula),
        "atoms": [{"el": a["el"], "x": a["p"][0], "y": a["p"][1], "z": a["p"][2]} for a in parsed["atoms"]],
        "bonds": [[b[0], b[1]] for b in parsed["bonds"]],
        "analysisBlocked": quality in _BLOCKED_QUALITIES,
    }
    if note:
        preview["structureNote"] = note
    if warning:
        preview["structureWarning"] = warning
    if not preview["analysisBlocked"]:
        _attach_conformer_name(preview, text, parsed)
    return preview


_MAX_PUBCHEM_CONFORMERS = 10


def _fetch_conformer_ids(cid: str) -> list[str]:
    """PubChem's own conformer IDs for a compound (its diverse-conformer list, default first).
    Best-effort: any failure just means no picker is shown."""
    try:
        resp = _get_with_retry(f"{PUG_BASE}/compound/cid/{quote(cid)}/conformers/JSON")
        if not resp.ok:
            return []
        info = resp.json().get("InformationList", {}).get("Information", [])
        ids = info[0].get("ConformerID", []) if info else []
        return [str(i) for i in ids][:_MAX_PUBCHEM_CONFORMERS]
    except Exception:  # noqa: BLE001
        logger.info("PubChem conformer list unavailable | cid=%s", cid, exc_info=True)
        return []


_CONFORMER_SEARCH_SECONDS = 20


def _searched_conformer_options(sdf: str) -> tuple[str, list[dict]] | None:
    """Works out the distinct conformers of an organic molecule itself (torsion scan incl. eclipsed /
    syn transition states, ring shapes, or an ensemble) -- see conformer_search.py. Returns
    (mode, options) or None when the molecule isn't covered or has only one shape."""
    try:
        found = run_with_deadline(conformer_search.find_conformers, sdf, timeout=_CONFORMER_SEARCH_SECONDS)
    except Exception:  # noqa: BLE001
        logger.info("Conformer search unavailable", exc_info=True)
        return None
    if not found:
        return None
    options = []
    for i, c in enumerate(found["conformers"]):
        opt = {"id": f"gen-{i}", "source": "generated", "structure": c["structure"],
               "relEnergyKJ": c["relEnergyKJ"], "kind": c["kind"],
               "label": f"Conformer {i + 1}" + (" (lowest energy)" if i == 0 else f" (+{c['relEnergyKJ']:.1f} kJ/mol)")}
        if c.get("name"):
            opt["name"] = c["name"]
        if c.get("detail"):
            opt["detail"] = c["detail"]
        options.append(opt)
    return found["mode"], options


def _active_option_id(options: list[dict], current_name: str | None) -> str:
    """The chip matching the shape that is currently on screen (falls back to the first)."""
    if current_name:
        minima = [o for o in options if o.get("kind") != "transition state"]
        for o in minima:  # exact name first ("Chair (CH3 equatorial)"), then just the shape word
            if o.get("name") == current_name:
                return o["id"]
        base = current_name.split(" (")[0]
        for o in minima:
            if o.get("name", "").split(" (")[0] == base:
                return o["id"]
    return options[0]["id"]


def _pubchem_conformer_options(ids: list[str]) -> list[dict]:
    if len(ids) < 2:
        return []
    return [
        {"id": cid_, "source": "pubchem",
         "label": f"Conformer {i + 1}" + (" (PubChem default)" if i == 0 else "")}
        for i, cid_ in enumerate(ids)
    ]


def _fetch_conformer_sdf(conformer_id: str) -> str | None:
    resp = _get_with_retry(f"{PUG_BASE}/conformers/{quote(conformer_id)}/SDF")
    if resp.status_code == 404:
        return None
    if not resp.ok:
        raise UpstreamServiceError(f"PubChem conformer lookup failed (HTTP {resp.status_code}).")
    return resp.text.strip() or None


def _error_response(e: Exception, label: str):
    """Shared exception -> HTTP mapping for the structure-only endpoints."""
    if isinstance(e, BadRequestError):
        logger.warning("%s failed | reason=%s", label, e)
        return err(400, str(e))
    if isinstance(e, UpstreamServiceError):
        logger.warning("%s upstream error | reason=%s", label, e)
        return err(502, str(e))
    if isinstance(e, UpstreamUnavailableError):
        logger.warning("%s unavailable | reason=%s", label, e)
        return err(503, str(e))
    if isinstance(e, DeadlineExceeded):
        logger.warning("%s timed out (deadline exceeded) | reason=%s", label, e)
        return err(503, "PubChem took too long to respond (likely a network stall). Please try again.")
    if isinstance(e, engine.SymmetryError):
        logger.warning("%s parse failed | reason=%s", label, e)
        return err(400, str(e))
    logger.error("%s crashed", label, exc_info=e)
    return err(500, "Internal server error")


@router.post("/pubchem/structure")
def fetch_pubchem_structure(payload: PubchemRequest):
    """Resolves a compound name or CID and returns its structure for display -- FAST. It never
    builds a 3-D geometry itself (that can take tens of seconds and used to push this request past
    the browser's 45 s timeout, so the search showed nothing at all).

    - PubChem has a 3-D record: returned with the list of PubChem's other conformers
      (`conformers`), so the UI can offer a choice.
    - PubChem only has a flat 2-D depiction: returned immediately as a display-only preview with
      `needsGeneration: true`; the browser then calls /pubchem/generate3d to build a real geometry.
    The symmetry engine is NOT run here."""
    query = payload.query.strip()
    logger.info("Symmetry PubChem structure-only fetch requested | query=%r", query)
    try:
        if not query:
            raise BadRequestError("Enter a PubChem compound name or CID.")
        cid_hint = query if query.isdigit() else None
        cid, sdf, quality, expected_formula = run_with_deadline(
            _resolve_and_fetch, query, cid_hint, timeout=_PUBCHEM_DEADLINE_SECONDS
        )
        preview = _preview_from_structure(cid, sdf, quality, None, None, expected_formula)
        if quality == "3d":
            options = _pubchem_conformer_options(_fetch_conformer_ids(cid))
            searched = _searched_conformer_options(sdf)
            if searched and (searched[0] in ("scan", "ring") or not options):
                # a full enumeration beats PubChem's short list of minima
                options = searched[1]
                preview["conformers"] = options
                preview["activeConformerId"] = _active_option_id(options, preview.get("conformerName"))
            elif options:
                preview["conformers"] = options
                preview["activeConformerId"] = options[0]["id"]
        else:
            preview["needsGeneration"] = True
        logger.info("Symmetry PubChem structure-only fetch succeeded | cid=%s quality=%s atoms=%d conformers=%d",
                    cid, quality, preview["atomCount"], len(preview.get("conformers", [])))
        return ok(200, "Structure fetched successfully", preview=preview)
    except Exception as e:  # noqa: BLE001
        return _error_response(e, "Symmetry PubChem structure-only fetch")


@router.post("/pubchem/generate3d")
def generate_pubchem_3d(payload: GenerateRequest):
    """Builds a real 3-D geometry for a compound PubChem only has a 2-D depiction of (RDKit for
    ordinary organics, GFN2-xTB for metals / hypervalent centres -- see structure_builder.py).
    Returns the preview like /pubchem/structure. When several distinct relaxed conformers are found
    they come back in `conformers` (each carrying its own coordinates), lowest energy first.
    If nothing trustworthy can be built the 2-D depiction is returned with `analysisBlocked: true`
    and a warning -- never a fake 3-D result."""
    cid = payload.cid
    logger.info("Symmetry PubChem generate3d requested | cid=%s", cid)
    try:
        sdf_2d = run_with_deadline(_fetch_sdf, cid, "2d", timeout=_PUBCHEM_DEADLINE_SECONDS)
        if not sdf_2d:
            raise UpstreamServiceError(f"PubChem has no structure record at all for CID {cid}.")
        text, quality, note, warning, alternatives = _generate_with_alternatives(sdf_2d)
        preview = _preview_from_structure(cid, text, quality, note, warning)
        if len(alternatives) > 1:
            options, kept = [], []  # kept: (name, relKJ) of options already shown
            for alt in alternatives:
                named = None
                try:
                    named = conformer_naming.name_conformer(engine.parse_structure(alt["text"]))
                except Exception:  # noqa: BLE001
                    pass
                name = named["name"] if named else None
                # two relaxed minima with the same name and (almost) the same energy are one conformer
                if name and any(n == name and abs(e - alt["relKJ"]) < 0.5 for n, e in kept):
                    continue
                kept.append((name, alt["relKJ"]))
                i = len(options)
                opt = {"id": f"gen-{i}", "source": "generated", "structure": alt["text"],
                       "relEnergyKJ": round(alt["relKJ"], 2),
                       "label": f"Conformer {i + 1}" + (" (lowest energy)" if i == 0 else f" (+{alt['relKJ']:.1f} kJ/mol)")}
                if named:
                    opt["name"] = named["name"]
                    opt["detail"] = named["detail"]
                options.append(opt)
            if len(options) > 1:
                preview["conformers"] = options
                preview["activeConformerId"] = "gen-0"
        if not preview.get("conformers") and not preview["analysisBlocked"]:
            searched = _searched_conformer_options(sdf_2d)
            if searched:
                preview["conformers"] = searched[1]
                preview["activeConformerId"] = _active_option_id(searched[1], preview.get("conformerName"))
        logger.info("Symmetry PubChem generate3d done | cid=%s quality=%s atoms=%d conformers=%d",
                    cid, quality, preview["atomCount"], len(alternatives))
        return ok(200, "Structure generated", preview=preview)
    except Exception as e:  # noqa: BLE001
        return _error_response(e, "Symmetry PubChem generate3d")


def _name_pubchem_conformer(conformer_id: str) -> dict | None:
    sdf = _fetch_conformer_sdf(conformer_id)
    if not sdf:
        return None
    return conformer_naming.name_conformer(engine.parse_structure(sdf))


@router.post("/pubchem/conformer-names")
def pubchem_conformer_names(payload: ConformerNamesRequest):
    """Best-effort names (Staggered / Eclipsed / Chair ...) for PubChem's conformer IDs, so the chooser
    can label its chips. Separate from the search on purpose: it downloads every conformer, which
    would slow the search down. Never errors -- missing names are simply left out."""
    ids = [i for i in payload.conformerIds if re.fullmatch(r"[0-9A-Za-z_-]{4,40}", i)][:_MAX_PUBCHEM_CONFORMERS]
    logger.info("Symmetry PubChem conformer names requested | cid=%s n=%d", payload.cid, len(ids))

    def work() -> dict:
        names: dict = {}
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = {i: pool.submit(_name_pubchem_conformer, i) for i in ids}
            for i, fut in futures.items():
                try:
                    named = fut.result()
                except Exception:  # noqa: BLE001
                    named = None
                if named:
                    names[i] = named
        return names

    try:
        names = run_with_deadline(work, timeout=_PUBCHEM_DEADLINE_SECONDS)
    except Exception:  # noqa: BLE001
        logger.info("Symmetry PubChem conformer names unavailable", exc_info=True)
        names = {}
    return ok(200, "Conformer names computed", names=names)


@router.post("/pubchem/conformer")
def fetch_pubchem_conformer(payload: ConformerRequest):
    """One specific PubChem conformer of a compound, as the same kind of preview. The browser calls
    /analyze on the returned `sourceStructure` to get that conformer's point group."""
    logger.info("Symmetry PubChem conformer requested | cid=%s conformer=%s", payload.cid, payload.conformerId)
    try:
        sdf = run_with_deadline(_fetch_conformer_sdf, payload.conformerId, timeout=_PUBCHEM_DEADLINE_SECONDS)
        if not sdf:
            raise BadRequestError("PubChem has no conformer with that ID.")
        preview = _preview_from_structure(payload.cid, sdf, "3d", None, None)
        preview["activeConformerId"] = payload.conformerId
        return ok(200, "Conformer fetched successfully", preview=preview)
    except Exception as e:  # noqa: BLE001
        return _error_response(e, "Symmetry PubChem conformer")


@router.post("/pubchem")
def analyze_from_pubchem(payload: PubchemRequest):
    """Resolves a compound name or CID against PubChem, pulls its 3-D SDF
    conformer, and runs it straight through the same analyze() the paste
    box uses — so a PubChem-fetched structure gets identical treatment to
    a hand-pasted one.

    Not every PubChem record ships a precomputed 3-D conformer (this is
    common for salts, mixtures, polymers, and some larger flexible
    molecules) — previously that made the whole lookup fail outright, even
    for a perfectly valid, resolvable compound. We now fall back to
    PubChem's 2-D depiction rather than erroring out, but a 2-D depiction
    has z=0 for every atom, so a symmetry search over it will systematically
    *over-report* symmetry (any tetrahedral center reads as artificially
    planar). Rather than silently returning a misleading point group, we
    flag the fallback explicitly (`structureQuality` + `structureWarning`)
    so the caller can surface a clear "this reflects a flattened depiction,
    not real 3-D geometry" warning instead of presenting it at face value.
    """
    query = payload.query.strip()
    logger.info("Symmetry PubChem fetch requested | query=%r", query)
    try:
        if not query:
            raise BadRequestError("Enter a PubChem compound name or CID.")
        cid_hint = query if query.isdigit() else None
        # Wrapped in a hard wall-clock deadline -- see net.py. The retry
        # logic in _get_with_retry already bounds each individual HTTP
        # call, but that bound assumes the network layer honors
        # `timeout=` at all; DNS stalls don't. This is the outer safety
        # net that guarantees this endpoint always responds instead of
        # hanging indefinitely (the bug just reported).
        cid, sdf, quality, expected_formula = run_with_deadline(
            _resolve_and_fetch, query, cid_hint, timeout=_PUBCHEM_DEADLINE_SECONDS
        )
        sdf, quality, note, warning = _maybe_generate_3d(sdf, quality)
        # Identity gate: never hand a structure to the symmetry engine unless
        # its formula/atom count matches the compound that was asked for.
        _verify_structure(cid, sdf, expected_formula)
        if quality in _BLOCKED_QUALITIES:
            logger.warning("Symmetry PubChem analysis blocked | cid=%s quality=%s", cid, quality)
            raise BadRequestError(_BLOCKED_QUALITIES[quality])
        result = _run_analysis(sdf, payload.tolerance)
        result["pubchemCid"] = cid
        result["pubchemUrl"] = f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}"
        result["sourceStructure"] = sdf
        result["structureQuality"] = quality
        if note:
            result["structureNote"] = note
        if warning:
            result["structureWarning"] = warning
        logger.info(
            "Symmetry PubChem fetch succeeded | cid=%s group=%s quality=%s",
            cid, result["group"], quality,
        )
        return ok(200, "Structure fetched and analyzed successfully", result=result)
    except BadRequestError as e:
        logger.warning("Symmetry PubChem fetch failed | reason=%s", e)
        return err(400, str(e))
    except UpstreamServiceError as e:
        logger.warning("Symmetry PubChem upstream error | reason=%s", e)
        return err(502, str(e))
    except UpstreamUnavailableError as e:
        logger.warning("Symmetry PubChem unavailable | reason=%s", e)
        return err(503, str(e))
    except DeadlineExceeded as e:
        logger.warning("Symmetry PubChem timed out (deadline exceeded) | reason=%s", e)
        return err(503, "PubChem took too long to respond (likely a network stall). Please try again.")
    except Exception:
        logger.error("Symmetry PubChem fetch crashed", exc_info=True)
        return err(500, "Internal server error")


# Hard wall-clock cap for the whole resolve-name-to-CID + fetch-SDF chain.
_PUBCHEM_DEADLINE_SECONDS = 30

# Separate budget for 3-D generation (RDKit/xTB), applied only when PubChem's
# own fetch came back 2-D-only. Kept apart from _PUBCHEM_DEADLINE_SECONDS
# above so a slow-but-working PubChem round trip can never eat into the time
# generation gets, and vice versa -- these are two independent stages with
# two independent failure modes.
# Must stay under the browser's timeout for this call and above structure_builder.GENERATION_TOTAL_S (40).
_GENERATION_DEADLINE_SECONDS = 44


def _generate_with_alternatives(sdf: str) -> tuple[str, str, str | None, str | None, list[dict]]:
    """Tries to build a real 3-D structure from a 2-D PubChem record.
    Returns (text, quality, note, warning, alternatives). On success: the generated text,
    quality "generated-3d-<method>" (suffix "-unconverged" and a blocking warning if the xTB
    optimisation never converged), and any distinct alternative conformers. On failure: the
    original 2-D sdf, quality "2d-fallback" and a warning -- analysis stays blocked."""
    warning = (
        "PubChem has no 3-D conformer on file for this compound, and an automatic 3-D structure "
        "could not be generated for it either, so only its flattened 2-D depiction is available "
        "(all atoms at z=0). No point group can be computed from that -- paste a real 3-D structure "
        "(XYZ/SDF/PDB) instead."
    )
    try:
        gen = run_with_deadline(structure_builder.generate_3d, sdf, timeout=_GENERATION_DEADLINE_SECONDS)
        logger.info("Symmetry PubChem 3-D generation succeeded | method=%s converged=%s alts=%d",
                    gen.method, gen.converged, len(gen.alternatives))
        if not gen.converged:
            return gen.text, f"generated-3d-{gen.method}-unconverged", gen.note, _BLOCK_UNCONVERGED, []
        return gen.text, f"generated-3d-{gen.method}", gen.note, None, gen.alternatives
    except structure_builder.GenerationError as e:
        logger.info("Symmetry PubChem 3-D generation declined | reason=%s", e)
        return sdf, "2d-fallback", None, f"{warning} ({e})", []
    except DeadlineExceeded:
        logger.warning("Symmetry PubChem 3-D generation timed out")
        return sdf, "2d-fallback", None, warning, []
    except Exception:
        logger.error("Symmetry PubChem 3-D generation crashed", exc_info=True)
        return sdf, "2d-fallback", None, warning, []


def _maybe_generate_3d(sdf: str, quality: str) -> tuple[str, str, str | None, str | None]:
    """Used by the one-shot /pubchem endpoint: generation only when PubChem had 2-D only."""
    if quality != "2d-fallback":
        return sdf, quality, None, None
    text, q, note, warning, _alts = _generate_with_alternatives(sdf)
    return text, q, note, warning


# ---- Compound identity resolution -----------------------------------------
# RULE: the compound that gets analysed must be the compound that was asked
# for. PubChem's autocomplete endpoint returns *something* for almost any
# string ("sulfur pentafluoride chloride" -> "Sulfur pentafluoride", which is
# actually S2F10, a completely different molecule), so an autocomplete
# suggestion is NEVER used as the answer -- at most it is shown to the user
# as a "did you mean" hint inside the error message. A compound is only
# resolved when:
#   1. the query is a CID, or
#   2. PubChem's exact name/synonym lookup maps it, or
#   3. the query is a molecular formula and PubChem's exact formula search
#      finds it (and the fetched structure is then checked against it).
# After the structure is fetched/generated, _verify_structure() also checks
# its atom counts against PubChem's own MolecularFormula for that CID.

_SUBSCRIPT_DIGITS = str.maketrans("\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089", "0123456789")
_FORMULA_TOKEN = re.compile(r"([A-Z][a-z]?)(\d*)")
_FORMULA_FULL = re.compile(r"(?:[A-Z][a-z]?\d*)+")
_ELEMENT_SYMBOLS = frozenset(
    "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn "
    "Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce "
    "Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn "
    "Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl "
    "Mc Lv Ts Og".split()
)
_FORMULA_POLL_ATTEMPTS = 3


def _normalize_formula_query(query: str) -> str | None:
    """'SF5Cl' / 'SF\u2085Cl' -> 'SF5Cl' when the text is a syntactically valid
    molecular formula made only of real element symbols; otherwise None (so
    ordinary names like 'aspirin' are never mistaken for formulas)."""
    q = (query or "").strip().translate(_SUBSCRIPT_DIGITS).replace(" ", "")
    if not q or not _FORMULA_FULL.fullmatch(q):
        return None
    if any(sym not in _ELEMENT_SYMBOLS for sym, _ in _FORMULA_TOKEN.findall(q)):
        return None
    return q


def _formula_counts(formula: str) -> dict[str, int]:
    """Element counts from a formula string such as 'C6H12O6', 'C2H3O2-'
    (charge ignored) or 'CuSO4.5H2O' (hydrate multiplier applied)."""
    counts: dict[str, int] = {}
    for part in (formula or "").split("."):
        part = part.strip()
        m = re.match(r"^(\d+)(.*)$", part)
        mult, body = (int(m.group(1)), m.group(2)) if m else (1, part)
        body = re.sub(r"[+-]\d*$", "", body)
        for sym, n in _FORMULA_TOKEN.findall(body):
            counts[sym] = counts.get(sym, 0) + mult * (int(n) if n else 1)
    return counts


def _pretty_counts(counts: dict[str, int]) -> str:
    """Hill-ordered display string: C first, H second, rest alphabetical
    (or fully alphabetical when there is no carbon)."""
    keys = sorted(counts)
    if "C" in counts:
        keys = ["C"] + (["H"] if "H" in counts else []) + [k for k in keys if k not in ("C", "H")]
    return "".join(f"{k}{counts[k] if counts[k] > 1 else ''}" for k in keys)


def _resolve_and_fetch(query: str, cid_hint: str | None) -> tuple[str, str, str, str | None]:
    """Runs entirely inside run_with_deadline's worker thread. Returns
    (cid, sdf, quality, expected_formula). expected_formula is only set when
    the CID came from a formula search, so the fetched structure can be
    checked against exactly what was typed. Any BadRequestError /
    UpstreamServiceError / UpstreamUnavailableError raised inside propagates
    through unchanged."""
    logger.info("_resolve_and_fetch: starting | query=%r cid_hint=%r thread=%s", query, cid_hint, threading.current_thread().name)
    if cid_hint:
        cid, expected_formula = cid_hint, None
    else:
        cid, expected_formula = _resolve_cid(query)
    logger.info("_resolve_and_fetch: cid resolved to %s, fetching SDF", cid)
    sdf, quality = _fetch_sdf_with_fallback(cid)
    logger.info("_resolve_and_fetch: sdf fetched | cid=%s quality=%s len=%d", cid, quality, len(sdf))
    return cid, sdf, quality, expected_formula


def _resolve_cid(name: str) -> tuple[str, str | None]:
    """Resolves a name/formula to (cid, expected_formula) using ONLY exact
    identity matches -- see the RULE comment above. Raises BadRequestError
    (with non-binding "did you mean" hints) when nothing matches exactly.

    An UpstreamUnavailableError (PubChem unreachable) still propagates
    straight out, as before: no point trying a fallback over a dead path.
    """
    name = name.translate(_SUBSCRIPT_DIGITS)  # "SF\u2085Cl" -> "SF5Cl"; subscripts are never part of a real name
    logger.info("_resolve_cid: starting exact lookup for %r", name)
    try:
        cid = _lookup_cid_exact(name)
    except UpstreamServiceError:
        cid = None
    if cid:
        logger.info("_resolve_cid: exact name lookup succeeded | name=%r cid=%s", name, cid)
        return cid, None

    formula = _normalize_formula_query(name)
    if formula:
        logger.info("_resolve_cid: name lookup missed, trying exact formula search | formula=%s", formula)
        cids = _lookup_cids_by_formula(formula)
        if cids:
            if len(cids) > 1:
                logger.info("_resolve_cid: formula %s matched %d records, using first | cids=%s", formula, len(cids), cids)
            logger.info("_resolve_cid: formula search succeeded | formula=%s cid=%s", formula, cids[0])
            return cids[0], formula

    suggestions = _autocomplete_suggestions(name)
    logger.warning("_resolve_cid: NO exact match | query=%r suggestions(not used)=%s", name, suggestions)
    msg = f"PubChem has no compound that exactly matches \u201c{name}\u201d, so nothing was analysed."
    if suggestions:
        msg += (
            " Similar PubChem names (suggestions only \u2014 NOT used, they may be different molecules): "
            + ", ".join(suggestions) + "."
        )
    msg += " Try PubChem's exact name, the molecular formula (e.g. SF5Cl), or a CID."
    raise BadRequestError(msg)


def _autocomplete_suggestions(name: str, limit: int = 5) -> list[str]:
    """Non-binding 'did you mean' hints for the error message. Never used to
    pick a compound; any failure here just means no hints."""
    try:
        resp = _get_with_retry(
            f"https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/{quote(name)}/json",
            params={"limit": limit},
        )
        if not resp.ok:
            return []
        return [str(c) for c in resp.json().get("dictionary_terms", {}).get("compound", [])][:limit]
    except (UpstreamUnavailableError, ValueError):
        return []


def _lookup_cid_exact(name: str) -> str | None:
    url = f"{PUG_BASE}/compound/name/{quote(name)}/cids/JSON"
    resp = _get_with_retry(url)
    if resp.status_code == 404:
        return None
    if not resp.ok:
        raise UpstreamServiceError(f"PubChem name lookup failed (HTTP {resp.status_code}).")
    cids = resp.json().get("IdentifierList", {}).get("CID", [])
    return str(cids[0]) if cids else None


def _lookup_cids_by_formula(formula: str, max_records: int = 5) -> list[str]:
    """PubChem exact molecular-formula search. fastformula can answer
    asynchronously (a ListKey to poll); we poll briefly then give up."""
    url = f"{PUG_BASE}/compound/fastformula/{quote(formula)}/cids/JSON"
    resp = _get_with_retry(url, params={"MaxRecords": max_records})
    if not resp.ok:
        logger.info("_lookup_cids_by_formula: status=%s for %s", resp.status_code, formula)
        return []
    data = resp.json()
    cids = data.get("IdentifierList", {}).get("CID")
    if cids:
        return [str(c) for c in cids[:max_records]]
    list_key = data.get("Waiting", {}).get("ListKey")
    if not list_key:
        return []
    for _ in range(_FORMULA_POLL_ATTEMPTS):
        time.sleep(1)
        poll = _get_with_retry(
            f"{PUG_BASE}/compound/listkey/{list_key}/cids/JSON", params={"MaxRecords": max_records}
        )
        if poll.ok:
            cids = poll.json().get("IdentifierList", {}).get("CID")
            if cids:
                return [str(c) for c in cids[:max_records]]
    return []


def _fetch_record_formula(cid: str) -> str | None:
    """PubChem's own MolecularFormula for this CID, or None if unavailable
    (a failed check is logged and skipped, never treated as a mismatch)."""
    try:
        resp = _get_with_retry(f"{PUG_BASE}/compound/cid/{quote(cid)}/property/MolecularFormula/JSON")
        if not resp.ok:
            logger.warning("_fetch_record_formula: HTTP %s for cid=%s", resp.status_code, cid)
            return None
        props = resp.json().get("PropertyTable", {}).get("Properties", [])
        return props[0].get("MolecularFormula") if props else None
    except (UpstreamUnavailableError, ValueError):
        logger.warning("_fetch_record_formula: could not fetch formula for cid=%s", cid)
        return None


def _verify_structure(cid: str, sdf: str, expected_formula: str | None) -> None:
    """Final identity gate, run on the exact text that will be analysed
    (including a generated 3-D structure). Compares the structure's element
    counts against (a) the formula the user typed, when the CID came from a
    formula search, and (b) PubChem's MolecularFormula for that CID. Any
    mismatch raises BadRequestError -- we refuse rather than analyse a
    different molecule."""
    parsed = engine.parse_structure(sdf)
    got: dict[str, int] = {}
    for a in parsed["atoms"]:
        el = a["el"].capitalize()
        el = "H" if el in ("D", "T") else el
        got[el] = got.get(el, 0) + 1
    got_label = f"{_pretty_counts(got)} ({sum(got.values())} atoms)"

    if expected_formula:
        want = _formula_counts(expected_formula)
        if want != got:
            logger.warning("_verify_structure: MISMATCH vs query formula | cid=%s want=%s got=%s", cid, want, got)
            raise BadRequestError(
                f"Structure mismatch: you searched {_pretty_counts(want)}, but the structure obtained "
                f"for PubChem CID {cid} is {got_label}. Nothing was analysed."
            )

    record = _fetch_record_formula(cid)
    if record:
        want = _formula_counts(record)
        if want != got:
            logger.warning("_verify_structure: MISMATCH vs PubChem record | cid=%s record=%s got=%s", cid, want, got)
            raise BadRequestError(
                f"Structure mismatch: PubChem CID {cid} is {_pretty_counts(want)}, but the structure "
                f"obtained is {got_label}. Nothing was analysed."
            )
    logger.info("_verify_structure: OK | cid=%s formula=%s", cid, _pretty_counts(got))


def _fetch_sdf_with_fallback(cid: str) -> tuple[str, str]:
    """Returns (sdf_text, quality) where quality is "3d" (real geometry,
    safe for symmetry analysis) or "2d-fallback" (flattened depiction,
    caller must warn). Only raises when PubChem has neither.

    Fetches the 3-D and 2-D records concurrently rather than trying 3-D,
    waiting for it to fail, and only then starting the 2-D request — a
    missing 3-D conformer is a common, expected case (not an error), and
    the old sequential version paid a full request's worth of latency for
    every compound that hit that fallback path.
    """
    logger.info("_fetch_sdf_with_fallback: submitting 3d+2d fetches for cid=%s", cid)
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_3d = pool.submit(_fetch_sdf, cid, "3d")
        f_2d = pool.submit(_fetch_sdf, cid, "2d")
        sdf_3d = f_3d.result()
        logger.info("_fetch_sdf_with_fallback: 3d result in | cid=%s got=%s", cid, bool(sdf_3d))
        sdf_2d = f_2d.result()
        logger.info("_fetch_sdf_with_fallback: 2d result in | cid=%s got=%s", cid, bool(sdf_2d))
    if sdf_3d:
        return sdf_3d, "3d"
    if sdf_2d:
        return sdf_2d, "2d-fallback"
    raise UpstreamServiceError(f"PubChem has no structure record at all for CID {cid}.")


def _fetch_sdf(cid: str, record_type: str) -> str | None:
    logger.info("_fetch_sdf: starting | cid=%s type=%s thread=%s", cid, record_type, threading.current_thread().name)
    url = f"{PUG_BASE}/compound/cid/{quote(cid)}/SDF"
    resp = _get_with_retry(url, params={"record_type": record_type})
    if resp.status_code == 404:
        logger.info("_fetch_sdf: 404 (no %s record) | cid=%s", record_type, cid)
        return None
    if not resp.ok:
        raise UpstreamServiceError(
            f"PubChem {record_type.upper()} structure lookup failed for CID {cid} (HTTP {resp.status_code})."
        )
    text = resp.text.strip()
    logger.info("_fetch_sdf: done | cid=%s type=%s chars=%d", cid, record_type, len(text))
    return text or None