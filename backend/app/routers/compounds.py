from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
import requests as _requests

from .. import models, schemas, pubchem
from ..database import get_db
from ..exceptions import BadRequestError, NotFoundError, UpstreamServiceError, UpstreamUnavailableError
from ..logging_config import get_logger
from ..responses import ok, err, serialize, serialize_list

logger = get_logger(__name__)

router = APIRouter(prefix="/api/compounds", tags=["compounds"])


@router.get("")
def list_compounds(
    search: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    logger.info("Listing compounds | search=%r category=%r", search, category)
    try:
        q = db.query(models.Compound)
        if search:
            like = f"%{search}%"
            q = q.filter(
                or_(
                    models.Compound.name.ilike(like),
                    models.Compound.common_name.ilike(like),
                    models.Compound.formula.ilike(like),
                )
            )
        if category and category.lower() != "all":
            q = q.filter(models.Compound.category == category)
        results = q.order_by(models.Compound.name.asc()).all()
        logger.info("Listing compounds succeeded | returned=%d row(s)", len(results))
        return ok(200, "Compounds fetched successfully", compounds=serialize_list(schemas.CompoundOut, results))
    except Exception:
        logger.error("Listing compounds crashed | search=%r category=%r", search, category, exc_info=True)
        return err(500, "Internal server error")


@router.get("/categories")
def list_categories(db: Session = Depends(get_db)):
    logger.info("Listing distinct compound categories")
    try:
        rows = db.query(models.Compound.category).distinct().all()
        categories = sorted({r[0] for r in rows})
        logger.info("Listing categories succeeded | count=%d", len(categories))
        return ok(200, "Categories fetched successfully", categories=categories)
    except Exception:
        logger.error("Listing categories crashed", exc_info=True)
        return err(500, "Internal server error")


@router.post("/fetch")
def fetch_external_compound(payload: schemas.CompoundFetchRequest, db: Session = Depends(get_db)):
    """Look up a compound by free-text name. Checks the local library first
    (curated + anything already fetched before); if there's no match, pulls
    it live from PubChem, caches it, and returns the new row."""
    query = (payload.query or "").strip()
    logger.info("Fetch external compound requested | query=%r", query)
    try:
        if not query or len(query) > 200:
            raise BadRequestError("Please provide a compound name to search for.")

        like = f"%{query}%"
        existing = (
            db.query(models.Compound)
            .filter(or_(models.Compound.name.ilike(like), models.Compound.common_name.ilike(like)))
            .order_by(models.Compound.name.asc())
            .first()
        )
        if existing:
            logger.info("Fetch external compound resolved from local library | query=%r id=%s", query, existing.id)
            return ok(200, "Compound fetched successfully", compound=serialize(schemas.CompoundOut, existing))

        try:
            logger.info("Compound not in local library, calling PubChem | query=%r", query)
            record = pubchem.build_compound_record(query)
        except pubchem.PubChemNotFoundError:
            raise NotFoundError(f"PubChem has no record matching \u201c{query}\u201d. Check the spelling, or try the formula.")
        except pubchem.PubChemServiceError as exc:
            raise UpstreamServiceError(f"PubChem returned unusable data: {exc}")
        except _requests.RequestException:
            raise UpstreamUnavailableError("Couldn't reach PubChem right now. Check your connection and try again.")

        if record.get("pubchem_cid"):
            by_cid = (
                db.query(models.Compound)
                .filter(models.Compound.pubchem_cid == record["pubchem_cid"])
                .first()
            )
            if by_cid:
                logger.info(
                    "Fetch external compound resolved to already-cached CID | query=%r cid=%s",
                    query, record["pubchem_cid"],
                )
                return ok(200, "Compound fetched successfully", compound=serialize(schemas.CompoundOut, by_cid))

        row = models.Compound(**record)
        db.add(row)
        db.commit()
        db.refresh(row)
        logger.info("Fetch external compound succeeded, cached new compound | query=%r id=%s", query, row.id)
        return ok(200, "Compound fetched successfully", compound=serialize(schemas.CompoundOut, row))

    except BadRequestError as e:
        logger.warning("Fetch external compound failed: %s | query=%r", e, query)
        return err(400, str(e))
    except NotFoundError as e:
        logger.warning("Fetch external compound failed: %s | query=%r", e, query)
        return err(404, str(e))
    except UpstreamServiceError as e:
        logger.error("Fetch external compound failed: %s | query=%r", e, query)
        return err(502, str(e))
    except UpstreamUnavailableError as e:
        logger.error("Fetch external compound failed: %s | query=%r", e, query, exc_info=True)
        return err(503, str(e))
    except Exception:
        logger.error("Fetch external compound crashed | query=%r", query, exc_info=True)
        return err(500, "Internal server error")


def _ring_count(structure_2d) -> Optional[int]:
    """Cyclomatic-number ring count (edges - atoms + components) — same
    method graphAnalysis.js uses client-side."""
    if not structure_2d:
        return None
    atoms = structure_2d.get("atoms") or []
    bonds = structure_2d.get("bonds") or []
    if not atoms:
        return None
    parent = {a["id"]: a["id"] for a in atoms}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    atom_ids = {a["id"] for a in atoms}
    edge_count = 0
    for b in bonds:
        if b.get("from") in atom_ids and b.get("to") in atom_ids:
            union(b["from"], b["to"])
            edge_count += 1
    components = len({find(a["id"]) for a in atoms})
    return max(0, edge_count - len(atoms) + components)


def _classify_match(query_counts: dict, candidate_counts: dict) -> Optional[str]:
    if not candidate_counts:
        return None
    if candidate_counts == query_counts:
        return "exact"
    non_h_query = {k: v for k, v in query_counts.items() if k != "H"}
    non_h_cand = {k: v for k, v in candidate_counts.items() if k != "H"}
    if non_h_query and non_h_query == non_h_cand:
        return "close"
    return None


@router.get("/match/by-formula")
def match_by_formula(
    formula: str = Query(..., min_length=1, max_length=60),
    db: Session = Depends(get_db),
):
    """'Did you mean...?' suggestions for a molecular formula — powers the
    Draw Lab's structure-recognizing Autocorrect."""
    formula = formula.strip()
    logger.info("Match by formula requested | formula=%r", formula)
    try:
        query_counts = pubchem.parse_formula_counts(formula)
        if not query_counts:
            logger.warning("Match by formula failed: could not parse formula | formula=%r", formula)
            return ok(200, "No matches found for this formula", matches=[])

        all_compounds = db.query(models.Compound).filter(models.Compound.formula.isnot(None)).all()
        results = []
        for c in all_compounds:
            match_type = _classify_match(query_counts, pubchem.parse_formula_counts(c.formula))
            if not match_type:
                continue
            results.append({
                "source": "library",
                "compound_id": c.id,
                "cid": None,
                "name": c.name,
                "formula": c.formula,
                "smiles": c.smiles,
                "formula_match": match_type,
                "ring_count": _ring_count(c.structure_2d),
            })
        results.sort(key=lambda r: 0 if r["formula_match"] == "exact" else 1)

        seen_names = {r["name"].lower() for r in results}
        local_cids = {c.pubchem_cid for c in all_compounds if c.pubchem_cid}
        exact_count = sum(1 for r in results if r["formula_match"] == "exact")
        remaining = max(0, 6 - exact_count)

        if remaining > 0:
            try:
                cids = pubchem.find_cids_by_formula(formula, max_records=remaining + len(local_cids) + 2)
            except Exception as exc:
                logger.warning("PubChem fastformula search failed, continuing with local-only matches | formula=%r error=%s", formula, exc)
                cids = []
            cids = [c for c in cids if str(c) not in local_cids]
            added = 0
            for summary in pubchem.fetch_candidate_summaries(cids):
                if added >= remaining:
                    break
                name = summary["name"]
                if name.lower() in seen_names:
                    continue
                results.insert(exact_count + added, {
                    "source": "pubchem",
                    "compound_id": None,
                    "cid": str(summary["cid"]),
                    "name": name,
                    "formula": summary.get("formula") or formula,
                    "smiles": summary.get("smiles"),
                    "formula_match": "exact",
                    "ring_count": None,
                })
                seen_names.add(name.lower())
                added += 1

        logger.info("Match by formula succeeded | formula=%r results=%d", formula, len(results))
        return ok(200, "Formula matches fetched successfully", matches=results)
    except Exception:
        logger.error("Match by formula crashed | formula=%r", formula, exc_info=True)
        return err(500, "Internal server error")


@router.post("/match/resolve")
def resolve_match(payload: schemas.CompoundMatchResolve, db: Session = Depends(get_db)):
    """Fetches (and caches) the full record for a suggestion the user
    picked from /match/by-formula."""
    logger.info("Resolve match requested | compound_id=%s cid=%s", payload.compound_id, payload.cid)
    try:
        if payload.compound_id:
            c = db.query(models.Compound).filter(models.Compound.id == payload.compound_id).first()
            if not c:
                raise NotFoundError("Compound not found")
            logger.info("Resolve match succeeded from local library | compound_id=%s", payload.compound_id)
            return ok(200, "Compound resolved successfully", compound=serialize(schemas.CompoundOut, c))

        if not payload.cid:
            raise BadRequestError("Provide a compound_id or a PubChem cid")

        existing = db.query(models.Compound).filter(models.Compound.pubchem_cid == str(payload.cid)).first()
        if existing:
            logger.info("Resolve match resolved to already-cached CID | cid=%s", payload.cid)
            return ok(200, "Compound resolved successfully", compound=serialize(schemas.CompoundOut, existing))

        try:
            cid_int = int(payload.cid)
        except ValueError:
            raise BadRequestError("Invalid PubChem cid")

        try:
            record = pubchem.build_compound_record_by_cid(cid_int)
        except pubchem.PubChemNotFoundError:
            raise NotFoundError("PubChem no longer has a record for this compound.")
        except pubchem.PubChemServiceError as exc:
            raise UpstreamServiceError(f"PubChem returned unusable data: {exc}")
        except _requests.RequestException:
            raise UpstreamUnavailableError("Couldn't reach PubChem right now. Check your connection and try again.")

        row = models.Compound(**record)
        db.add(row)
        db.commit()
        db.refresh(row)
        logger.info("Resolve match succeeded, cached new compound | cid=%s id=%s", cid_int, row.id)
        return ok(200, "Compound resolved successfully", compound=serialize(schemas.CompoundOut, row))

    except NotFoundError as e:
        logger.warning("Resolve match failed: %s | compound_id=%s cid=%s", e, payload.compound_id, payload.cid)
        return err(404, str(e))
    except BadRequestError as e:
        logger.warning("Resolve match failed: %s | compound_id=%s cid=%s", e, payload.compound_id, payload.cid)
        return err(400, str(e))
    except UpstreamServiceError as e:
        logger.error("Resolve match failed: %s | cid=%s", e, payload.cid)
        return err(502, str(e))
    except UpstreamUnavailableError as e:
        logger.error("Resolve match failed: %s | cid=%s", e, payload.cid, exc_info=True)
        return err(503, str(e))
    except Exception:
        logger.error("Resolve match crashed | compound_id=%s cid=%s", payload.compound_id, payload.cid, exc_info=True)
        return err(500, "Internal server error")


@router.get("/{compound_id}")
def get_compound(compound_id: str, db: Session = Depends(get_db)):
    logger.info("Get compound requested | compound_id=%s", compound_id)
    try:
        c = db.query(models.Compound).filter(models.Compound.id == compound_id).first()
        if not c:
            raise NotFoundError("Compound not found")
        logger.info("Get compound succeeded | compound_id=%s", compound_id)
        return ok(200, "Compound fetched successfully", compound=serialize(schemas.CompoundOut, c))
    except NotFoundError as e:
        logger.warning("Get compound failed | compound_id=%s reason=%s", compound_id, e)
        return err(404, str(e))
    except Exception:
        logger.error("Get compound crashed | compound_id=%s", compound_id, exc_info=True)
        return err(500, "Internal server error")