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
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests
from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import symmetry_engine as engine
from ..exceptions import BadRequestError, UpstreamServiceError, UpstreamUnavailableError
from ..logging_config import get_logger
from ..responses import ok, err

logger = get_logger(__name__)

router = APIRouter(prefix="/api/symmetry", tags=["symmetry"])

PUG_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
PUBCHEM_TIMEOUT = 12

# Shared, connection-pooling Session (mirrors pubchem.py) instead of bare
# requests.get() — every call here hits the same PubChem host, so reusing
# one pooled, keep-alive Session skips a fresh TCP/TLS handshake per call.
_session = requests.Session()
_session.mount("https://", requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20))

# BUG FIX: this router used to fire a single bare `_session.get(...)` for
# every PubChem call, with no retry at all — so PubChem's well-documented
# transient "PUGREST.ServerBusy" 503 (or a one-off dropped connection) took
# down the whole lookup on the spot, even though trying again a moment
# later would normally succeed. This mirrors the same retry-with-backoff
# fix applied in pubchem.py.
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 3
_RETRY_BACKOFF_BASE = 0.6  # seconds; doubles each attempt


def _get_with_retry(url, **kwargs):
    """Shared GET helper for this router: retries transient failures
    (dropped connections, 429/5xx) with backoff before giving up. Raises
    UpstreamUnavailableError if PubChem could never be reached at all, or
    returns the final `requests.Response` (which may still be a real 4xx —
    the caller decides what a non-2xx *reachable* response means)."""
    kwargs.setdefault("timeout", PUBCHEM_TIMEOUT)
    last_exc = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = _session.get(url, **kwargs)
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < _MAX_ATTEMPTS - 1:
                time.sleep(_RETRY_BACKOFF_BASE * (2 ** attempt))
                continue
            raise UpstreamUnavailableError("Could not reach PubChem.")
        if resp.status_code in _RETRYABLE_STATUS and attempt < _MAX_ATTEMPTS - 1:
            time.sleep(_RETRY_BACKOFF_BASE * (2 ** attempt))
            continue
        return resp
    raise UpstreamUnavailableError("Could not reach PubChem.") if last_exc else None


class AnalyzeRequest(BaseModel):
    structure: str = Field(..., description="XYZ, SDF/MOL (V2000/V3000), or PDB text")
    tolerance: float | None = Field(None, ge=0.001, le=1.0)


class PubchemRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Compound name or PubChem CID")
    tolerance: float | None = Field(None, ge=0.001, le=1.0)


def _run_analysis(structure_text: str, tolerance: float | None):
    try:
        return engine.analyze(structure_text, tolerance or engine.TOL_DEFAULT)
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
    except Exception:
        logger.error("Symmetry analyze crashed", exc_info=True)
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
        cid = query if query.isdigit() else _resolve_cid(query)
        sdf, quality = _fetch_sdf_with_fallback(cid)
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
    except Exception:
        logger.error("Symmetry PubChem fetch crashed", exc_info=True)
        return err(500, "Internal server error")


def _resolve_cid(name: str) -> str:
    """Exact name lookup first; if PubChem doesn't recognize it verbatim
    (a typo, a partial name, or a synonym it indexes differently), retry
    against its autocomplete suggestion before giving up. Mirrors the same
    two-step resolution the compound-library tab already relies on
    (pubchem.py's find_cid) — this tab was missing that fallback entirely,
    so anything not spelled exactly as PubChem's canonical name failed.

    BUG FIX: this used to let an UpstreamServiceError/UpstreamUnavailableError
    raised by the *exact* lookup propagate straight out of this function,
    which meant a single transient PubChem hiccup on the very first call
    skipped the autocomplete fallback entirely and failed the whole
    request — even though the fallback path existed and would often have
    resolved it fine. Now a transient upstream failure on the exact lookup
    is treated the same as "not found": we still try autocomplete before
    giving up for real.
    """
    cid = None
    try:
        cid = _lookup_cid_exact(name)
    except (UpstreamServiceError, UpstreamUnavailableError):
        logger.warning("Exact PubChem name lookup failed transiently for %r; trying autocomplete", name)
    if cid:
        return cid

    try:
        resp = _get_with_retry(
            f"https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/{quote(name)}/json",
            params={"limit": 1},
        )
    except UpstreamUnavailableError:
        raise UpstreamUnavailableError("Could not reach PubChem.")
    if resp.ok:
        candidates = resp.json().get("dictionary_terms", {}).get("compound", [])
        if candidates:
            try:
                cid = _lookup_cid_exact(candidates[0])
            except (UpstreamServiceError, UpstreamUnavailableError):
                cid = None
            if cid:
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
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_3d = pool.submit(_fetch_sdf, cid, "3d")
        f_2d = pool.submit(_fetch_sdf, cid, "2d")
        sdf_3d = f_3d.result()
        sdf_2d = f_2d.result()
    if sdf_3d:
        return sdf_3d, "3d"
    if sdf_2d:
        return sdf_2d, "2d-fallback"
    raise UpstreamServiceError(f"PubChem has no structure record at all for CID {cid}.")


def _fetch_sdf(cid: str, record_type: str) -> str | None:
    url = f"{PUG_BASE}/compound/cid/{quote(cid)}/SDF"
    resp = _get_with_retry(url, params={"record_type": record_type})
    if resp.status_code == 404:
        return None
    if not resp.ok:
        raise UpstreamServiceError(
            f"PubChem {record_type.upper()} structure lookup failed for CID {cid} (HTTP {resp.status_code})."
        )
    text = resp.text.strip()
    return text or None