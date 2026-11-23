"""Validate a viewer data folder (one cell build, the data_base of a cells.json entry) against the viewer data contract.

TO BE PORTED into the pipeline as a check of the export step `viewer_extras` (wholecell/validate or wholecell/export).
Needs numpy only (no pipeline code); prints a JSON report, exit status 1 on any failure.

usage: python tools/check_viewer_data.py <viewer_data_dir> [--tiles 200]
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import zlib

import numpy as np

REQUIRED = ["cell.json", "regions.json", "tiles/index.json", "library/types.json", "library/beads.bin", "library/spheretree.bin",
            "types_tiles.bin", "geometry.json", "geometry_G.bin", "organelle_meshes.bin.gz", "bookmarks.json", "features.json",
            "MODEL.md", "attribution.md"]


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("dir"); ap.add_argument("--tiles", type=int, default=200)
    a = ap.parse_args()
    D = a.dir; rep = dict(dir=os.path.abspath(D), checks={}, fail=[])

    def ck(name, ok, info=None):
        rep["checks"][name] = dict(ok=bool(ok), **({"info": info} if info is not None else {}))
        if not ok:
            rep["fail"].append(name)

    J = lambda p: json.load(open(os.path.join(D, p)))  # noqa: E731
    missing = [p for p in REQUIRED if not os.path.exists(os.path.join(D, p))]
    ck("files_present", not missing, missing or None)
    if missing:
        print(json.dumps(rep, indent=1)); sys.exit(1)
    cj = J("cell.json"); e = cj.get("entry", {})
    need = ["id", "name", "organism", "cell_type", "state", "data_base", "build", "files", "licence", "default_bookmark"]
    ck("cell_json_schema", cj.get("schema") == "wholecell.cells/1" and all(k in e for k in need),
       [k for k in need if k not in e] or None)
    ck("cell_json_licence", e.get("licence", {}).get("data") == "CC-BY-NC-4.0", e.get("licence"))
    idx = J("tiles/index.json"); tj = J("library/types.json"); T = tj["types"]
    ck("index_format", idx.get("format") == "YCT2", idx.get("format"))
    ck("types_schema", tj.get("schema") == "wholecell.viewer_types/1")
    ck("types_ids_order", [t["id"] for t in T] == tj["ids"])
    import struct
    tag = struct.unpack("<I", hashlib.sha256(json.dumps(tj["ids"]).encode()).digest()[:4])[0]
    ck("lib_tag", tag == idx["lib_tag"] == tj["lib_tag"], dict(computed=tag, index=idx["lib_tag"], types=tj["lib_tag"]))
    nb = os.path.getsize(os.path.join(D, "library/beads.bin")) // 8
    ck("beads_count", nb == sum(t["nb"] for t in T) == tj["n_beads"], dict(file=nb, sum_nb=sum(t["nb"] for t in T)))
    bo_ok = all(T[i]["bo"] == sum(t["nb"] for t in T[:i]) for i in range(0, len(T), max(1, len(T) // 500)))
    ck("bead_offsets", bo_ok)
    ns = os.path.getsize(os.path.join(D, "library/spheretree.bin")) // 16
    ck("spheretree_count", ns == sum(t["sn"] for t in T) == tj["n_spheres"], dict(file=ns))
    tt = np.fromfile(os.path.join(D, "types_tiles.bin"), "<u4"); NT = len(T)
    off = tt[:NT + 1]; lst = tt[NT + 1:]
    ck("types_tiles", off[0] == 0 and np.all(np.diff(off.astype(np.int64)) >= 0) and off[-1] == len(lst)
       and (len(lst) == 0 or lst.max() < len(idx["tiles"])), dict(entries=int(len(lst))))
    # geometry
    geo = J("geometry.json")
    gp = os.path.join(D, geo["G"]["file"])
    G = np.fromfile(gp, "<f4").astype(np.float64)
    h = hashlib.sha256(open(gp, "rb").read()).hexdigest()
    ck("G_file", len(G) == geo["G"]["n"] and h == geo["G"]["sha256"], dict(n=len(G), sha_ok=h == geo["G"]["sha256"]))
    for i, v in geo["G"]["patches"]:
        G[i] = v
    S = geo["slots"]
    ck("G_layout", G[S["G_LAYOUT"]] == S["LAYOUT_ID"] and G[S["G_TABLES"]] > 0)
    to = int(G[S["G_TABLES"]]); nm = int(G[to])
    ck("n_mems", nm == geo["n_mems"] == len(geo["membranes"]), dict(G=nm, json=geo["n_mems"], membranes=len(geo["membranes"])))
    ck("membrane_codes", [m["code"] for m in geo["membranes"]] == list(range(nm)))
    nr = int(G[to + 2]); r0 = to + S["TH"] + S["MROW"] * int(G[to + 1])
    codes = {int(G[r0 + S["RROW"] * r]) for r in range(nr)}
    lc = {l["code"] for l in geo["labels"]}
    ck("label_codes", codes <= lc, dict(rule_codes=sorted(codes), labels=sorted(lc)))
    offs_ok = all(0 <= G[i] < len(G) and G[i] == int(G[i]) for i in geo["G"]["offset_slots"])
    ck("offset_slots", offs_ok)
    lo, hi = [np.array(x, float) for x in geo["domain"]["bbox_nm"]]
    ck("pores", len(geo["pores"]) % 6 == 0, dict(n=len(geo["pores"]) // 6))
    pr = geo["prims"]
    ck("prims", len(pr["params"]) == 8 * len(pr["type"]) == 8 * len(pr["cls"]), dict(n=len(pr["type"])))
    rc = geo.get("resample_check", {})
    ck("resample_agreement", rc.get("agreement", 0) >= 0.97, rc.get("agreement"))
    # meshes
    with gzip.open(os.path.join(D, "organelle_meshes.bin.gz")) as f:
        buf = f.read()
    n = struct.unpack("<I", buf[:4])[0]; hd = np.frombuffer(buf, "<u4", 3 * n, 4).reshape(n, 3)
    o = 4 + 12 * n; ok = True; info = []
    for m, nv, nf in hd:
        V = np.frombuffer(buf, "<f4", 3 * nv, o); o += 12 * nv
        F = np.frombuffer(buf, "<u4", 3 * nf, o); o += 12 * nf
        ok &= bool(m < nm and (nf == 0 or F.max() < nv))
        info.append([geo["membranes"][m]["name"] if m < nm else int(m), int(nf)])
    ck("meshes", ok and o == len(buf), info)
    # bookmarks
    bm = J("bookmarks.json")
    pad = 500.0
    inb = [b["name"] for b in bm if not (np.all(np.array(b["target"]) >= lo - pad) and np.all(np.array(b["target"]) <= hi + pad))]
    keys = all(all(k in b for k in ("name", "caption", "target", "normal", "up", "width", "slab")) for b in bm)
    ck("bookmarks", keys and not inb and bm and bm[0]["name"] == e.get("default_bookmark"), dict(n=len(bm), outside=inb))
    ft = J("features.json")
    ck("features_schema", ft.get("schema") == "wholecell.viewer_features/1")
    # tiles: palette regions covered by regions.json, species < NT, lib_tag in headers
    R = J("regions.json"); rid = {r["id"] for r in R["regions"]}
    rows = idx["tiles"]; cols = idx["tile_columns"]; rng = np.random.default_rng(0)
    sel = rng.choice(len(rows), min(a.tiles, len(rows)), replace=False)
    bad_r, bad_s, bad_t = set(), 0, 0
    for i in sel:
        r = rows[int(i)]
        with open(os.path.join(D, "tiles", r[cols.index("shard")]), "rb") as f:
            f.seek(r[cols.index("off")]); raw = zlib.decompress(f.read(r[cols.index("gz_bytes")]), 31)
        hh = np.frombuffer(raw, "<u4", 32)
        bad_t += int(hh[14] != idx["lib_tag"] or zlib.crc32(raw) & 0xFFFFFFFF != r[cols.index("crc32")])
        k = int(hh[12]); tab = np.frombuffer(raw, "<u4", 4 * k, 128).reshape(k, 4)
        for kind, oo, ll, cc in tab:
            if kind == 1:
                pal = np.frombuffer(raw, "<u4", ll // 4, oo).reshape(-1, 2)
                bad_r |= set((pal[:, 1] & 0xFFFF).tolist()) - rid
                bad_s += int((pal[:, 0] >= NT).sum())
    ck("tiles_sample", not bad_r and not bad_s and not bad_t, dict(n=len(sel), unknown_regions=sorted(bad_r), bad_species=bad_s, bad_tag_or_crc=bad_t))
    rep["ok"] = not rep["fail"]
    print(json.dumps(rep, indent=1))
    sys.exit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
