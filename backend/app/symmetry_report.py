"""Builds the downloadable point-group report (Markdown) for the Group Theory tab.

The report is generated here, on the server, from a fresh `symmetry_engine.analyze()`
result -- the browser only sends the structure text + tolerance and receives the
finished file. That keeps the export in sync with the engine (no client-side copy of
the formatting logic to drift) and means the numbers in the file are never whatever
the client happened to have in memory.

Public API:
    build_report_markdown(result, pubchem_cid=None) -> str
    report_filename(result) -> str
"""
import re
from datetime import datetime, timezone

_ANGSTROM = "\u00c5"


def _num(v) -> str:
    """6.0 -> '6', 1.5 -> '1.5' (character values come back from the engine as floats)."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _yes_no(flag) -> str:
    return "yes" if flag else "no"


def report_filename(result: dict) -> str:
    """symmetry-report-<formula>.md, filesystem/header safe (ASCII only)."""
    raw = result.get("formulaPretty") or "structure"
    slug = re.sub(r"[^A-Za-z0-9]+", "-", raw).strip("-") or "structure"
    return f"symmetry-report-{slug}.md"


def build_report_markdown(result: dict, pubchem_cid: str | None = None) -> str:
    lines: list[str] = []
    add = lines.append

    group = result.get("groupPretty") or result.get("group") or "?"
    desc = result.get("groupDescription")

    add(f"# Symmetry report \u2014 {group}")
    add("")
    add(f"**Formula:** {result.get('formulaPretty', '?')}  ")
    add(f"**Atoms:** {result.get('atomCount', '?')}  ")
    group_line = f"{group} \u2014 {desc}" if desc else group
    add(f"**Point group:** {group_line}  ")
    if pubchem_cid:
        add(f"**Source:** PubChem CID {pubchem_cid} (https://pubchem.ncbi.nlm.nih.gov/compound/{pubchem_cid})  ")
    add(f"**Generated:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    add("")

    # ---- detection summary ----
    add("## Detection summary")
    add("")
    if result.get("orderLabel"):
        order = f"{result['orderLabel']} (infinite)"
    else:
        order = f"{result.get('detectedOps')} / {result.get('expectedOrder')}"
    add(f"- Group order: {order}")
    add(f"- Inversion center: {_yes_no(result.get('inversion'))}")
    add(f"- Mirror planes: {result.get('mirrorCount')}")
    add(f"- Improper rotations: {result.get('improperRotationCount')}")
    orders = result.get("rotationalOrders") or []
    add(f"- Rotational orders found: {', '.join(str(o) for o in orders) if orders else 'none'}")
    add(f"- Linear molecule: {_yes_no(result.get('linear'))}")
    add(f"- Tolerance used: {result.get('tolerance')} {_ANGSTROM}")
    add(f"- Worst match error: {result.get('maxError')} {_ANGSTROM}")
    if isinstance(result.get("symmetryScore"), (int, float)):
        add(f"- Symmetry score: {result['symmetryScore']}%")
    if result.get("toleranceStable") is not None:
        add(f"- Stable under small tolerance changes: {_yes_no(result['toleranceStable'])}")
    if result.get("closestHigherSymmetry"):
        add(f"- Closest higher-symmetry (idealized) group: {result['closestHigherSymmetry']}")
    if result.get("distortionWarning"):
        add(f"- \u26a0\ufe0f {result['distortionWarning']}")
    if result.get("structureWarning"):
        add(f"- \u26a0\ufe0f {result['structureWarning']}")
    add("")

    # ---- operations ----
    ops = result.get("operations") or []
    if ops:
        by_kind: dict[str, list[str]] = {}
        for op in ops:
            by_kind.setdefault(op.get("kind", "?"), []).append(op.get("label", "?"))
        kind_names = {"E": "Identity", "C": "Rotations", "i": "Inversion", "M": "Mirror planes", "S": "Improper rotations"}
        add("## Symmetry operations found")
        add("")
        for kind, labels in by_kind.items():
            add(f"- **{kind_names.get(kind, kind)}** ({len(labels)}): {', '.join(labels)}")
        add("")

    # ---- decision trace ----
    trace = result.get("decisionTrace") or []
    if trace:
        add("## Why this point group")
        add("")
        for i, line in enumerate(trace, start=1):
            add(f"{i}. {line}")
        add("")

    # ---- rejected tests ----
    rejected = result.get("rejectedTests") or []
    if rejected:
        add("## Symmetry tests that did not pass")
        add("")
        add("| Element tested | Closest miss |")
        add("|---|---|")
        for t in rejected:
            add(f"| {t.get('label')} | {t.get('errorAngstrom')} {_ANGSTROM} |")
        add("")

    # ---- representation reduction ----
    rep = result.get("representation")
    if rep:
        add("## Representation reduction")
        add("")
        add(f"- \u0393(3N) = {rep.get('gamma3N')}")
        add(f"- \u0393(trans) = {rep.get('gammaTrans')}")
        add(f"- \u0393(rot) = {rep.get('gammaRot')}")
        add(f"- **\u0393(vib) = {rep.get('gammaVib')}**")
        add("")

        val = rep.get("validation")
        if val:
            good = val.get("gamma3NMatchesAtomCount") and val.get("decompositionConsistent")
            verdict = " \u2713" if good else " \u2014 mismatch, treat this result with caution"
            add(
                f"- Validation: \u0393(3N) accounts for {val.get('gamma3NDimension')}/{val.get('expectedDimension')} "
                f"Cartesian degrees of freedom{verdict}."
            )
            add("")

        table = result.get("characterTable")
        rows = rep.get("classRows") or []
        if table and rows:
            irreps = table.get("irreps") or []
            add("### Character table and \u0393(3N)")
            add("")
            header = ["Class", "Size", "\u03c7(\u0393\u2083\u2099)"] + [ir.get("name", "?") for ir in irreps]
            add("| " + " | ".join(header) + " |")
            add("|" + "|".join(["---"] * len(header)) + "|")
            for row in rows:
                cells = [str(row.get("label")), str(row.get("size")), _num(row.get("chiGamma3N"))]
                cells += [_num(c) for c in (row.get("characters") or [])]
                add("| " + " | ".join(cells) + " |")
            add("")

        spectro = rep.get("spectroscopy") or []
        if spectro:
            add("### IR / Raman activity")
            add("")
            add("| Irrep | Modes | IR active | Raman active |")
            add("|---|---|---|---|")
            for s in spectro:
                raman = _yes_no(s.get("ramanActive")) + (" (silent)" if s.get("silent") else "")
                add(f"| {s.get('irrep')} | {s.get('count')} | {_yes_no(s.get('irActive'))} | {raman} |")
            add("")

        if rep.get("note"):
            add(f"> {rep['note']}")
            add("")
    elif result.get("representationError"):
        add("## Representation reduction")
        add("")
        add(f"Not available: {result['representationError']}")
        add("")

    add("---")
    add(f"*Generated by the Group Theory tab \u00b7 tolerance {result.get('tolerance')} {_ANGSTROM}*")
    add("")
    return "\n".join(lines)