import json
import os

from sqlalchemy.orm import Session

from . import models

_DATA_PATH = os.path.join(os.path.dirname(__file__), "data", "compounds_seed.json")

_FIELDS = [
    "common_name", "formula", "category", "smiles", "molar_mass",
    "description", "uses", "structure_2d", "mol_block", "image_hint",
    "iupac_name", "interesting_facts", "geometry", "hybridization", "bonding_notes",
]


def seed_compounds(db: Session):
    """Populate/update the compound library, matched by name.

    This is an upsert, not a one-time seed: existing compounds (matched by
    name) are updated in place — preserving their id, so nothing that
    references a compound (e.g. a note's compound_id) breaks — and any new
    compounds in the JSON file are inserted. This means editing
    compounds_seed.json and restarting the backend is enough to push
    updates to an already-seeded database; no manual SQL or table wipe
    needed for compound data changes.
    """
    with open(_DATA_PATH, "r", encoding="utf-8") as f:
        compounds = json.load(f)

    existing_by_name = {c.name: c for c in db.query(models.Compound).all()}

    inserted = 0
    updated = 0
    for c in compounds:
        row = existing_by_name.get(c["name"])
        if row:
            for field in _FIELDS:
                setattr(row, field, c.get(field))
            # Seed data always wins and is always "curated" — this also
            # reclaims a compound that was previously auto-fetched from
            # PubChem under the exact same name, once someone hand-curates it.
            row.source = "curated"
            row.pubchem_cid = None
            updated += 1
        else:
            row = models.Compound(
                name=c["name"], source="curated", **{f: c.get(f) for f in _FIELDS}
            )
            db.add(row)
            # Keeps a same-named entry appearing again later in this same
            # seed file from being inserted twice — it'll be found here
            # and correctly treated as an update instead.
            existing_by_name[c["name"]] = row
            inserted += 1

    db.commit()
    print(f"Compound library: {inserted} inserted, {updated} updated ({len(compounds)} total in seed file).")


# NOTE: functional_groups and reactions are no longer seeded from JSON on
# startup. Their data now lives directly in Supabase (functional_groups /
# reactions tables) and the routers read straight from there. If you ever
# need to bulk-load new entries again, insert/upsert directly against
# Supabase (SQL or a one-off script) rather than reviving a JSON seeder here.