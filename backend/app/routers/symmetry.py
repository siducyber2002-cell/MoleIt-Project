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
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests
from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import symmetry_engine as engine
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



class AnalyzeRequest(BaseModel):
    structure: str = Field(..., description="XYZ, SDF/MOL (V2000/V3000), or PDB text")
    tolerance: float | None = Field(None, ge=0.001, le=1.0)


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
        return run_with_deadline(engine.analyze, structure_text, tolerance or engine.TOL_DEFAULT, timeout=_ANALYSIS_DEADLINE_SECONDS)
    except engine.SymmetryError as e:
        raise BadRequestError(str(e))


@router.get("/demos")
def list_demos():
    logger.info("List symmetry demos requested")
    return ok(200, "Demo structures fetched successfully", demos=engine.DEMOS)


@router.post("/analyze")
def analyze_structure(payload: AnalyzeRequest):
    logger.info("Symmetry analyze requested | chars=%d tol=%s", len(payload.structure), payload.tolerance)
    try:
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


@router.post("/pubchem/structure")
def fetch_pubchem_structure(payload: PubchemRequest):
    """Resolves a compound name or CID and pulls its 3-D SDF conformer,
    exactly like /pubchem below -- but stops there. It does NOT run
    detect_operations()/analyze(), only the cheap parse_structure() pass,
    so the browser can show the real 3-D structure the moment a search
    resolves without also paying for a full symmetry-operation search
    (which scales with atom count/symmetry richness and can be genuinely
    slow) before the user has even asked for a point group. The frontend
    calls this on search, then calls /analyze separately -- with this same
    sourceStructure text -- only when the user clicks "Calculate point
    group".
    """
    query = payload.query.strip()
    logger.info("Symmetry PubChem structure-only fetch requested | query=%r", query)
    try:
        if not query:
            raise BadRequestError("Enter a PubChem compound name or CID.")
        cid_hint = query if query.isdigit() else None
        cid, sdf, quality = run_with_deadline(
            _resolve_and_fetch, query, cid_hint, timeout=_PUBCHEM_DEADLINE_SECONDS
        )
        parsed = engine.parse_structure(sdf)
        formula = {}
        for a in parsed["atoms"]:
            formula[a["el"]] = formula.get(a["el"], 0) + 1
        preview = {
            "pubchemCid": cid,
            "pubchemUrl": f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}",
            "sourceStructure": sdf,
            "structureQuality": quality,
            "atomCount": len(parsed["atoms"]),
            "bondCount": len(parsed["bonds"]),
            "formulaPretty": engine.pretty_formula(formula),
            "atoms": [{"el": a["el"], "x": a["p"][0], "y": a["p"][1], "z": a["p"][2]} for a in parsed["atoms"]],
            "bonds": [[b[0], b[1]] for b in parsed["bonds"]],
        }
        if quality == "2d-fallback":
            preview["structureWarning"] = (
                "PubChem has no 3-D conformer on file for this compound — this is its "
                "flattened 2-D depiction (all atoms at z=0). Calculating the point group "
                "from this will over-report symmetry. Paste a real 3-D structure "
                "(XYZ/SDF/PDB) for a trustworthy result."
            )
        logger.info(
            "Symmetry PubChem structure-only fetch succeeded | cid=%s quality=%s atoms=%d",
            cid, quality, preview["atomCount"],
        )
        return ok(200, "Structure fetched successfully", preview=preview)
    except BadRequestError as e:
        logger.warning("Symmetry PubChem structure-only fetch failed | reason=%s", e)
        return err(400, str(e))
    except UpstreamServiceError as e:
        logger.warning("Symmetry PubChem structure-only upstream error | reason=%s", e)
        return err(502, str(e))
    except UpstreamUnavailableError as e:
        logger.warning("Symmetry PubChem structure-only unavailable | reason=%s", e)
        return err(503, str(e))
    except DeadlineExceeded as e:
        logger.warning("Symmetry PubChem structure-only timed out (deadline exceeded) | reason=%s", e)
        return err(503, "PubChem took too long to respond (likely a network stall). Please try again.")
    except engine.SymmetryError as e:
        logger.warning("Symmetry PubChem structure-only parse failed | reason=%s", e)
        return err(400, str(e))
    except Exception:
        logger.error("Symmetry PubChem structure-only fetch crashed", exc_info=True)
        return err(500, "Internal server error")


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
        cid, sdf, quality = run_with_deadline(
            _resolve_and_fetch, query, cid_hint, timeout=_PUBCHEM_DEADLINE_SECONDS
        )
        result = _run_analysis(sdf, payload.tolerance)
        result["pubchemCid"] = cid
        result["pubchemUrl"] = f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}"
        result["sourceStructure"] = sdf
        result["structureQuality"] = quality
        if quality == "2d-fallback":
            result["structureWarning"] = (
                "PubChem has no 3-D conformer on file for this compound — this "
                "analysis is of PubChem's flattened 2-D depiction (all atoms at "
                "z=0), so the detected point group will over-report symmetry "
                "(e.g. any real tetrahedral center will look artificially planar). "
                "Paste a real 3-D structure (XYZ/SDF/PDB) for a trustworthy result."
            )
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
_PUBCHEM_DEADLINE_SECONDS = 45


def _resolve_and_fetch(query: str, cid_hint: str | None) -> tuple[str, str, str]:
    """Runs entirely inside run_with_deadline's worker thread. Returns
    (cid, sdf, quality). Any BadRequestError / UpstreamServiceError /
    UpstreamUnavailableError raised inside propagates through unchanged."""
    logger.info("_resolve_and_fetch: starting | query=%r cid_hint=%r thread=%s", query, cid_hint, threading.current_thread().name)
    cid = cid_hint or _resolve_cid(query)
    logger.info("_resolve_and_fetch: cid resolved to %s, fetching SDF", cid)
    sdf, quality = _fetch_sdf_with_fallback(cid)
    logger.info("_resolve_and_fetch: sdf fetched | cid=%s quality=%s len=%d", cid, quality, len(sdf))
    return cid, sdf, quality


def _resolve_cid(name: str) -> str:
    """Exact name lookup first; if PubChem doesn't recognize it verbatim
    (a typo, a partial name, or a synonym it indexes differently), retry
    against its autocomplete suggestion before giving up. Mirrors the same
    two-step resolution the compound-library tab already relies on
    (pubchem.py's find_cid) — this tab was missing that fallback entirely,
    so anything not spelled exactly as PubChem's canonical name failed.

    BUG FIX: previously, the moment PubChem was confirmed *unreachable*
    (not "compound not found" — actually unreachable), this kept going and
    tried the autocomplete endpoint and a second exact lookup anyway, on
    the exact same dead network path, multiplying one timeout into three.
    Now an UpstreamUnavailableError is treated as final immediately — no
    point retrying a fallback over a connection that just failed — while a
    genuine "not found" (a clean 404, PubChem was reachable) still falls
    through to autocomplete as before.
    """
    logger.info("_resolve_cid: starting exact lookup for %r", name)
    try:
        cid = _lookup_cid_exact(name)
    except UpstreamServiceError:
        cid = None  # PubChem answered but with something unusable; still try autocomplete
    # An UpstreamUnavailableError (network truly down) is intentionally not
    # caught here — it propagates straight out and skips the rest of this
    # function, since retrying on the same dead path can't help.
    if cid:
        logger.info("_resolve_cid: exact lookup succeeded | name=%r cid=%s", name, cid)
        return cid

    logger.info("_resolve_cid: exact lookup found nothing, trying autocomplete for %r", name)
    resp = _get_with_retry(
        f"https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/{quote(name)}/json",
        params={"limit": 1},
    )
    if resp.ok:
        candidates = resp.json().get("dictionary_terms", {}).get("compound", [])
        if candidates:
            try:
                cid = _lookup_cid_exact(candidates[0])
            except UpstreamServiceError:
                cid = None
            if cid:
                logger.info("_resolve_cid: autocomplete resolved | name=%r suggestion=%r cid=%s", name, candidates[0], cid)
                return cid

    raise BadRequestError(f"PubChem did not return a compound CID for \u201c{name}\u201d.")


def _lookup_cid_exact(name: str) -> str | None:
    url = f"{PUG_BASE}/compound/name/{quote(name)}/cids/JSON"
    resp = _get_with_retry(url)
    if resp.status_code == 404:
        return None
    if not resp.ok:
        raise UpstreamServiceError(f"PubChem name lookup failed (HTTP {resp.status_code}).")
    cids = resp.json().get("IdentifierList", {}).get("CID", [])
    return str(cids[0]) if cids else None


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