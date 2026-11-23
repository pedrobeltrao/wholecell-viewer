"""Merge per-build cell.json files (export/cell.json of wholecell builds, or a viewer data folder's cell.json) into one
viewer registry cells.json (schema wholecell.cells/1, docs/reference/viewer_multi_cell.md §2). Never edit cells.json by
hand: re-run this.

To be ported into the pipeline repo (wholecell/export, deploy step `cells_registry`).

usage:
  python tools/make_cells_json.py OUT.json CELLDIR [CELLDIR ...] --data-base TEMPLATE [--title T] [--note N] [--status S]

CELLDIR: a folder with cell.json ({"schema": "wholecell.cells/1", "entry": {...}}) -- an export/ folder or a viewer data
folder. TEMPLATE: data_base of each entry with {id} and {build_id} placeholders, relative to OUT.json or absolute, e.g.
  local test:  data/{id}/{build_id}/          (served with tools/serve.py --mount data=<viewer_data root>)
  release:     https://huggingface.co/datasets/<org>/<repo>/resolve/<rev>/{id}/{build_id}/   (placeholder until deposit)
"""
import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("cells", nargs="+")
    ap.add_argument("--data-base", required=True)
    ap.add_argument("--title", default="Whole-cell models")
    ap.add_argument("--note", default="")
    ap.add_argument("--status", default=None, help="override every entry's status (e.g. preview)")
    ap.add_argument("--licence-data", default=None, help="override every entry's licence.data (e.g. CC-BY-NC-4.0)")
    a = ap.parse_args()
    cells = []
    for d in a.cells:
        f = os.path.join(d, "cell.json")
        j = json.load(open(f))
        if j.get("schema") != "wholecell.cells/1":
            sys.exit(f"{f}: schema {j.get('schema')!r} is not wholecell.cells/1")
        e = dict(j["entry"])
        for k in ("id", "name", "organism", "cell_type", "state", "build"):
            if k not in e:
                sys.exit(f"{f}: entry lacks required field {k!r}")
        e["data_base"] = a.data_base.format(id=e["id"], build_id=e["build"]["build_id"])
        if a.status:
            e["status"] = a.status
        if a.licence_data:
            e.setdefault("licence", {})["data"] = a.licence_data
        e.setdefault("licence", {}).setdefault("attribution", "attribution.md")
        e["files"] = {**e.get("files", {}), "fields": "geometry_G.bin", "types_tiles": "types_tiles.bin", "attribution": "attribution.md"}
        if e.get("thumbnail") == "thumb.webp" and os.path.exists(os.path.join(d, "thumb.png")) and not os.path.exists(os.path.join(d, "thumb.webp")):
            e["thumbnail"] = "thumb.png"
        cells.append(e)
    ids = [(c["id"], c["build"]["build_id"]) for c in cells]
    if len(set(ids)) != len(ids):
        sys.exit(f"duplicate (id, build_id) in {ids}")
    reg = {"schema": "wholecell.cells/1", "title": a.title, "cells": cells}
    if a.note:
        reg["note"] = a.note
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(reg, open(a.out, "w"), indent=1)
    print(f"{a.out}: {len(cells)} cells: {', '.join(f'{i} ({b})' for i, b in ids)}")


if __name__ == "__main__":
    main()
