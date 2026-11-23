"""Viewer extras: everything the unified viewer reads per cell besides the YCT2 tiles (export step `viewer_extras`).

TO BE PORTED into the pipeline as `python -m wholecell export --step viewer_extras` (wholecell/export/viewer_extras.py);
the per-cell display facts in tools/cell_defaults/<cell>.json then move to the cell config (`export.regions`,
`export.labels`, `export.membranes`, `export.classes`, `export.lipids`, `export.bookmarks`, `export.model_doc`,
`export.attribution`). Data contract: README.md "Viewer data folder" and docs/reference/viewer_multi_cell.md.

usage: python tools/export_viewer_extras.py --build <build_dir> --out <viewer_data_dir>
           [--defaults tools/cell_defaults/<cell>.json] [--steps all|link,types_tiles,library,geometry,meshes,bookmarks,
           features,docs,thumb] [--g-budget N] [--workers 24]

Steps (OUT = the cell's data_base):
  link         symlinks to the build's export (tiles/, version.json, encode_meta.json, encode_check.json,
               MANIFEST.sha256); regions.json and cell.json are COPIED with display data / licence filled in
  types_tiles  one pass over every tile (PALETTE + INST of each gzip member): exact instance counts per (species,
               region) and per block the tile holding most copies of each species / region -> types_tiles.bin
               (+ _work/tile_scan.npz, reused by library and bookmarks)
  library      library/types.json (schema wholecell.viewer_types/1), beads.bin, spheretree.bin
  geometry     geometry.json (wholecell.viewer_geometry/1) + geometry_G.bin (cellgeom_eval_v1 G vector with resampled
               fields) + geometry_golden.json (pipeline-evaluated labels / membrane SDFs on the viewer G)
  meshes       organelle_meshes.bin.gz (jenc.organelle_meshes format, membrane = engine membrane code)
  bookmarks    bookmarks.json
  features     features.json (wholecell.viewer_features/1)
  docs         MODEL.md, attribution.md
  thumb        thumb.png (+ thumb.webp)
"""
# origin: library writer, morton order, mesh clipping and bookmark logic adapted from jurkat/viewer/jenc.py and
# jurkat/viewer/jenc_full.py (write_library, morton_order, clip_mesh, organelle_meshes, bookmarks, extra_bookmarks).
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import shutil
import sys
import time
import zlib
from concurrent.futures import ProcessPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LIC_DATA = "CC-BY-NC-4.0"      # Pedro, 2026-11-23: viewer data and generated content
HDR = 128
K_PALETTE, K_INST = 1, 2


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def wjson(path, obj, indent=None):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=indent, separators=None if indent else (",", ":"))
    os.replace(tmp, path)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


class Ctx:
    def __init__(self, a):
        self.b = os.path.abspath(a.build); self.out = os.path.abspath(a.out); self.a = a
        self.exp = os.path.join(self.b, "export"); self.web = os.path.join(self.exp, "web")
        sys.path.insert(0, os.path.join(self.b, "_code"))
        self.cell = json.load(open(os.path.join(self.exp, "cell.json")))["entry"]
        self.cid = self.cell["id"]; self.bid = self.cell["build"]["build_id"]
        dp = a.defaults or os.path.join(HERE, "cell_defaults", f"{self.cid}.json")
        self.D = json.load(open(dp))
        # input paths in the defaults use the pipeline's site placeholders; roots from the same environment overrides
        roots = {"{data_root}": os.environ.get("WHOLECELL_DATA_ROOT"), "{yeast_root}": os.environ.get("WHOLECELL_YEAST_ROOT")}
        for k, v in list(self.D.items()):
            if isinstance(v, str):
                for ph, r in roots.items():
                    if v.startswith(ph):
                        if r:
                            self.D[k] = r.rstrip("/") + v[len(ph):]
                        else:
                            print(f"warning: {k} = {v}: set WHOLECELL_{ph.strip('{}').upper()} to use it")
        self.index = json.load(open(os.path.join(self.web, "tiles", "index.json")))
        self.ids = json.load(open(os.path.join(self.web, "library", "types.json")))["ids"]
        self.regions = json.load(open(os.path.join(self.web, "regions.json")))
        os.makedirs(self.out, exist_ok=True); os.makedirs(os.path.join(self.out, "_work"), exist_ok=True)
        self._pkg = None

    def package(self):
        """(cell, rules, manifest, package dir) of the build's geometry package, loaded with the build's own code"""
        if self._pkg is None:
            from wholecell.geometry import cellgeom, rules as RU
            pj = json.load(open(os.path.join(self.b, "geometry", "package.json")))
            c = cellgeom.load(pj["package_dir"], verify="quick")
            ru = RU.load_rules(pj["rules"])
            self._pkg = (c, ru, c.manifest, pj)
        return self._pkg


# ------------------------------------------------------------------ link
def step_link(C):
    out = C.out
    for name, src in [("tiles", os.path.join(C.web, "tiles")), ("version.json", os.path.join(C.web, "version.json")),
                      ("encode_meta.json", os.path.join(C.web, "encode_meta.json")),
                      ("encode_check.json", os.path.join(C.web, "encode_check.json")),
                      ("export_MANIFEST.sha256", os.path.join(C.web, "MANIFEST.sha256"))]:
        dst = os.path.join(out, name)
        if os.path.lexists(dst):
            os.remove(dst)
        os.symlink(src, dst)
    # regions.json: the export's table with display data (colour, display_as) from the defaults where the config has none
    R = json.loads(json.dumps(C.regions))
    style = C.D.get("regions", {})
    for r in R["regions"]:
        s = style.get(r["name"])
        if s:
            r["colour"] = s["colour"]; r["display_as"] = s["display_as"]
    R["display_source"] = "tools/cell_defaults/%s.json (to be ported to config export.regions)" % C.cid
    wjson(os.path.join(out, "regions.json"), R, indent=1)
    cj = json.load(open(os.path.join(C.exp, "cell.json")))
    e = cj["entry"]
    e["licence"] = dict(e.get("licence") or {}); e["licence"]["data"] = LIC_DATA; e["licence"]["attribution"] = "attribution.md"
    e["files"]["fields"] = "geometry_G.bin"
    e["thumbnail"] = "thumb.png"
    wjson(os.path.join(out, "cell.json"), cj, indent=1)
    log("link: done")


# ------------------------------------------------------------------ tile scan (types_tiles + exact counts)
def _scan_shard(args):
    path, rows = args          # rows: [(tile_index, off, n)]
    buf = open(path, "rb").read()
    keys_all, cnt_all, tiles_all = [], [], []
    for ti, off, n in rows:
        raw = zlib.decompress(buf[off:off + n], 31)
        h = np.frombuffer(raw, "<u4", HDR // 4)
        ns = int(h[12])
        tab = np.frombuffer(raw, "<u4", ns * 4, HDR).reshape(ns, 4)
        pal = inst = None
        for k, o, l, c in tab:
            if k == K_PALETTE:
                pal = np.frombuffer(raw, "<u4", l // 4, o).reshape(-1, 2)
            elif k == K_INST:
                inst = np.frombuffer(raw, "<u4", l // 4, o).reshape(-1, 4)
        if pal is None or inst is None or not len(inst):
            continue
        c = np.bincount(inst[:, 0] & 0xFFFF, minlength=len(pal))
        keys_all.append((pal[:, 0].astype(np.uint64) << np.uint64(16)) | (pal[:, 1] & 0xFFFF).astype(np.uint64))
        cnt_all.append(c.astype(np.int64)); tiles_all.append(np.full(len(pal), ti, np.int64))
    if not keys_all:
        return np.zeros(0, np.uint64), np.zeros(0, np.int64), np.zeros(0, np.int64)
    return np.concatenate(keys_all), np.concatenate(cnt_all), np.concatenate(tiles_all)


def tile_scan(C):
    f = os.path.join(C.out, "_work", "tile_scan.npz")
    if os.path.exists(f):
        z = np.load(f)
        return {k: z[k] for k in z.files}
    T = C.index["tiles"]; cols = C.index["tile_columns"]
    ci = {k: cols.index(k) for k in ("shard", "off", "gz_bytes")}
    by = {}
    for i, r in enumerate(T):
        by.setdefault(r[ci["shard"]], []).append((i, int(r[ci["off"]]), int(r[ci["gz_bytes"]])))
    jobs = [(os.path.join(C.web, "tiles", s), rows) for s, rows in by.items()]
    jobs.sort(key=lambda j: -sum(r[2] for r in j[1]))
    t0 = time.time(); K, N, TI = [], [], []
    with ProcessPoolExecutor(C.a.workers) as ex:
        for k, (a, b, c) in enumerate(ex.map(_scan_shard, jobs, chunksize=1)):
            K.append(a); N.append(b); TI.append(c)
            if k % 100 == 0:
                log(f"  tile scan {k}/{len(jobs)} shards, {time.time() - t0:.0f} s")
    K = np.concatenate(K); N = np.concatenate(N); TI = np.concatenate(TI)
    np.savez(f, key=K, n=N, tile=TI)
    log(f"tile scan: {len(T)} tiles, {N.sum():,} instances, {time.time() - t0:.0f} s")
    return dict(key=K, n=N, tile=TI)


def _best_per_block(C, sel_key, n, tile):
    """per (sel_key, block): the tile with most copies -> dict sel_key -> list of (count, tile)"""
    T = C.index["tiles"]; bt = C.index["block_tiles"]
    ijk = np.array([r[:3] for r in T], np.int64)
    blk = np.floor_divide(ijk[tile], bt)
    bkey = ((blk[:, 0] + 512) * 1024 + (blk[:, 1] + 512)) * 1024 + (blk[:, 2] + 512)
    o = np.lexsort((-n, bkey, sel_key))
    sk, bk = sel_key[o], bkey[o]
    first = np.r_[True, (sk[1:] != sk[:-1]) | (bk[1:] != bk[:-1])]
    out = {}
    for s, c, t in zip(sk[first].tolist(), n[o][first].tolist(), tile[o][first].tolist()):
        out.setdefault(s, []).append((c, t))
    return out


def step_types_tiles(C):
    S = tile_scan(C)
    sp = (S["key"] >> np.uint64(16)).astype(np.int64)
    best = _best_per_block(C, sp, S["n"], S["tile"])
    NT = len(C.ids); rng = np.random.default_rng(0)
    offs = np.zeros(NT + 1, np.uint32); lists = []
    for i in range(NT):
        l = np.array(sorted(t for _, t in best.get(i, [])), np.uint32)
        if len(l) > 256:
            l = np.sort(rng.choice(l, 256, replace=False))
        lists.append(l); offs[i + 1] = offs[i] + len(l)
    with open(os.path.join(C.out, "types_tiles.bin"), "wb") as f:
        f.write(offs.astype("<u4").tobytes()); f.write(np.concatenate(lists).astype("<u4").tobytes())
    log(f"types_tiles: {int(offs[-1]):,} entries, {sum(1 for l in lists if len(l) == 0)} types without tiles")


# ------------------------------------------------------------------ library
def morton_order(b):
    # origin: jurkat/viewer/jenc.py morton_order
    lo, hi = b.min(0), b.max(0); g = ((b - lo) / np.maximum(hi - lo, 1e-6) * 1023).astype(np.uint64)

    def spread(x):
        x = (x | (x << np.uint64(16))) & np.uint64(0x030000FF); x = (x | (x << np.uint64(8))) & np.uint64(0x0300F00F)
        x = (x | (x << np.uint64(4))) & np.uint64(0x030C30C3); x = (x | (x << np.uint64(2))) & np.uint64(0x09249249)
        return x
    code = spread(g[:, 0]) | (spread(g[:, 1]) << np.uint64(1)) | (spread(g[:, 2]) << np.uint64(2))
    return np.argsort(code, kind="stable")


def _load_lib(path):
    z = np.load(path)
    b = z["beads"].astype(np.float64)
    k = z["kind"].astype(np.uint8) if "kind" in z.files else np.zeros(len(b), np.uint8)
    st = np.c_[z["st_c"], z["st_r"]].astype(np.float32)
    meta = {}
    for key in ("src", "pdb", "predictor", "membrane", "plddt_frac_kept", "plddt_mean"):
        if key in z.files:
            v = z[key]
            meta[key] = v.item() if v.shape == () else None
    if "plddt" in z.files and len(z["plddt"]) == len(b):
        meta["_plddt"] = np.asarray(z["plddt"], np.float64)
    if len(b):
        o = morton_order(b); b, k = b[o], k[o]
        if "_plddt" in meta:
            meta["_plddt"] = meta["_plddt"][o]
    return b, k, st, meta


def coarsen_plan(nbeads, budget):
    # origin: jurkat/viewer/jenc_full.py coarsen_plan
    stride = np.ones(len(nbeads), np.int64)
    tot = lambda: int(np.ceil(nbeads / stride).sum())  # noqa: E731
    if tot() <= budget:
        return stride
    order = np.argsort(-nbeads)
    for s in (2, 3, 4, 6, 8, 12, 16):
        for i in order:
            if tot() <= budget:
                return stride
            if nbeads[i] < 20000:
                break
            stride[i] = max(stride[i], s)
    return stride


def _species_meta(C):
    import pandas as pd
    S = pd.read_csv(os.path.join(C.b, "inventory", "species.tsv"), sep="\t", dtype=str).set_index("species_id")
    names = {}
    up = C.D.get("uniprot_names")
    if up and os.path.exists(up):
        U = pd.read_csv(up, sep="\t", usecols=["Entry", "Protein names"], dtype=str)
        names = dict(zip(U["Entry"], U["Protein names"]))
    old = {}
    tm = C.D.get("types_meta")
    if tm and os.path.exists(tm):            # read-only yeast viewer library (names, pLDDT, oligomer by id)
        for t in json.load(open(tm))["types"]:
            old[t["id"]] = t
    return S, names, old


def lib_dir(C):
    """structure library folder as wholecell.validate.common.Inputs.lib_dir: config validate.lib_dir ({build} = build
    folder; yeast: engine/lib = the sealed library plus assembly / pre-placed entries) > library.dir > library/lib"""
    cfg = json.load(open(os.path.join(C.b, "config.resolved.json")))
    p = (cfg.get("validate") or {}).get("lib_dir") or (cfg.get("library") or {}).get("dir")
    return str(p).replace("{build}", C.b) if p else os.path.join(C.b, "library", "lib")


def step_library(C):
    S0 = tile_scan(C)
    sp = (S0["key"] >> np.uint64(16)).astype(np.int64); rg = (S0["key"] & np.uint64(0xFFFF)).astype(np.int64)
    NT = len(C.ids)
    copies = np.bincount(sp, weights=S0["n"], minlength=NT).astype(np.int64)
    rkey = sp * 65536 + rg
    uk, inv = np.unique(rkey, return_inverse=True)
    rc = np.bincount(inv, weights=S0["n"]).astype(np.int64)
    regs = [dict() for _ in range(NT)]
    for k, c in zip(uk.tolist(), rc.tolist()):
        regs[k // 65536][str(k % 65536)] = int(c)
    exp_types = json.load(open(os.path.join(C.web, "library", "types.json")))["types"]
    S, names, old = _species_meta(C)
    libdir = lib_dir(C)
    t0 = time.time()
    with ProcessPoolExecutor(min(C.a.workers, 16)) as ex:
        libs = list(ex.map(_load_lib, [os.path.join(libdir, f"{i}.npz") for i in C.ids], chunksize=16))
    log(f"library: loaded {NT} npz in {time.time() - t0:.0f} s")
    nb = np.array([len(l[0]) for l in libs], np.int64)
    stride = coarsen_plan(nb, 1 << 24)
    q = 0.005
    B_, K_, P_, ST, types = [], [], [], [], []; bo = so = 0
    for i, lid in enumerate(C.ids):
        b, k, st, meta = libs[i]
        if stride[i] > 1:
            b, k = b[::stride[i]], k[::stride[i]]
            if "_plddt" in meta:
                meta["_plddt"] = meta["_plddt"][::stride[i]]
        qb = np.round(b / q); assert np.abs(qb).max(initial=0) < 32767, lid
        B_.append(qb.astype(np.int16)); K_.append(k)
        pl = np.full(len(b), 255, np.uint8)
        if "_plddt" in meta:
            pl = np.clip(np.round(meta["_plddt"]), 0, 254).astype(np.uint8)
        P_.append(pl); ST.append(st)
        row = S.loc[lid] if lid in S.index else None
        if isinstance(row, __import__("pandas").DataFrame):
            row = row.iloc[0]
        g = lambda c: (row[c] if row is not None and isinstance(row.get(c), str) else "")  # noqa: E731
        ss = g("struct_src"); skind, _, sval = ss.partition(":")
        genes = g("genes") or lid
        ups = [u for u in g("uniprots").split(";") if u]
        kind = g("kind")
        o = old.get(lid, {})
        if skind == "pdb":
            src, pdb, model = "PDB", sval.upper(), ""
        elif skind == "afdb_complex":
            src, pdb, model = "AF-multimer", "", sval
        elif skind.startswith("afdb"):
            src, pdb, model = "AF", "", ""
        else:
            src = meta.get("src") or o.get("src") or "prepass"; pdb = (meta.get("pdb") or o.get("pdb") or "").upper(); model = ""
            if src.startswith("pdb"):
                src = "PDB"
        acc = ups[0] if len(ups) == 1 else (sval if skind == "afdb_monomer" else (o.get("uniprot") or ""))
        nm = names.get(acc) if acc else None
        nm = nm.split(" (")[0] if isinstance(nm, str) else (o.get("name") or g("display_name") or lid)
        gene = (genes.split(";")[0] if kind == "protein" else lid) if row is not None else (o.get("gene") or lid)
        try:
            olig = int(float(g("n_chains"))) if g("n_chains") else int(o.get("oligomer", 1))
        except ValueError:
            olig = 1
        et = exp_types[i]; assert et["name"] == lid
        pm = meta.get("plddt_mean", o.get("plddt_mean"))
        pf = meta.get("plddt_frac_kept", o.get("plddt_frac_kept"))
        t = dict(id=lid, name=nm, gene=gene, genes=genes, uniprot=acc, src=src, pdb=pdb, oligomer=olig,
                 nb=int(len(b)), nnt=int((k == 1).sum()), bo=int(bo), so=int(so), sn=int(len(st)),
                 br=round(float(et["br_nm"] if et.get("br_nm") is not None else 0.0), 3),
                 rg=round(float(np.sqrt(((b - b.mean(0)) ** 2).sum(1).mean())) if len(b) else 0.0, 3),
                 mass=round(float(et["mass_da"] or 0.0)), plddt_mean=(round(float(pm), 1) if pm is not None else None),
                 plddt_frac_kept=(round(float(pf), 3) if pf is not None else None), copies=int(copies[i]), regions=regs[i])
        if model:
            t["model"] = model
        if et.get("prepass"):
            t["prepass"] = True
        if stride[i] > 1:
            t["bead_stride"] = int(stride[i])
        types.append(t)
        bo += len(b); so += len(st)
    # names of oligomer / heteromer units without their own entry: from the subunit types (display only)
    import re
    byid = {t["id"]: t for t in types}
    for t in types:
        if t["name"] != t["id"]:
            continue
        base = re.sub(r"_(oligo|x\d+|afx\d+)$", "", t["id"])
        if base != t["id"] and base in byid and byid[base]["name"] != base:
            t["name"] = byid[base]["name"] + (" (homo-oligomer)" if t["oligomer"] != 1 or "oligo" in t["id"] else "")
        elif t["id"] + "_oligo" in byid and byid[t["id"] + "_oligo"]["name"] != t["id"] + "_oligo":
            t["name"] = byid[t["id"] + "_oligo"]["name"]
        elif ";" in t["genes"]:
            t["name"] = "complex of " + ", ".join(t["genes"].split(";")[:6]) + (" ..." if t["genes"].count(";") > 5 else "")
    B_ = np.concatenate(B_); K_ = np.concatenate(K_); P_ = np.concatenate(P_)
    os.makedirs(os.path.join(C.out, "library"), exist_ok=True)
    rec = np.zeros(len(B_), dtype=[("x", "<i2"), ("y", "<i2"), ("z", "<i2"), ("k", "u1"), ("p", "u1")])
    rec["x"], rec["y"], rec["z"], rec["k"], rec["p"] = B_[:, 0], B_[:, 1], B_[:, 2], K_, P_
    rec.tofile(os.path.join(C.out, "library", "beads.bin"))
    np.concatenate(ST).astype("<f4").tofile(os.path.join(C.out, "library", "spheretree.bin"))
    wjson(os.path.join(C.out, "library", "types.json"),
          dict(schema="wholecell.viewer_types/1", ids=C.ids, lib_tag=C.index["lib_tag"], bead_q=q, n_beads=int(len(B_)),
               n_spheres=int(so), copies_source="exact instance counts of the YCT2 tiles (palette x INST)",
               coarsened=int((stride > 1).sum()), types=types))
    n_nometa = sum(1 for t in types if t["name"] == t["id"])
    log(f"library: {NT} types, {len(B_):,} beads, {so:,} spheres, {int((stride > 1).sum())} coarsened, "
        f"{n_nometa} types without a protein name, total copies {int(copies.sum()):,}")


# ------------------------------------------------------------------ geometry
def _subsample_field(h10, idx, data, s, reband=None):
    """brick grid kept; every s-th node (exact values); reband: bricks whose |values| all exceed reband become -1/-2
    (clamps set to reband)"""
    h10 = np.array(h10, np.float64); idx = np.array(idx, np.float64); B = int(h10[7])
    nst = int((idx >= 0).sum())
    D = np.asarray(data, np.float64).reshape(nst, B + 1, B + 1, B + 1)
    if s > 1:
        assert B % s == 0
        D = D[:, ::s, ::s, ::s]
    if reband:
        flat = D.reshape(nst, -1)
        mn = np.abs(flat).min(1)
        keep = mn < reband
        sgn_in = flat.max(1) < 0
        slot_old = idx.astype(np.int64)
        pos = np.flatnonzero(slot_old >= 0)          # index positions in order of slot
        order = slot_old[pos]
        new_slot = -np.ones(nst, np.int64); new_slot[keep] = np.arange(int(keep.sum()))
        ni = slot_old.copy()
        for p, sl in zip(pos.tolist(), order.tolist()):
            ni[p] = new_slot[sl] if keep[sl] else (-1 if sgn_in[sl] else -2)
        idx = ni.astype(np.float64)
        D = D[keep]
        h10[8] = min(h10[8], reband); h10[9] = min(h10[9], reband)
        D = np.clip(D, -h10[8], h10[9])
    h10[3] *= s; h10[7] = B // s
    return h10, idx, D.ravel()


def _coarsen_cristae(cr, f):
    """cristae section (n, origin, h, dims, n x 12 params, dense id grid) with the id grid coarsened f x (per coarse
    voxel the largest child id, so a voxel inside any mitochondrion keeps an id)"""
    cr = np.asarray(cr, np.float64)
    if f <= 1:
        return cr
    n = int(cr[0]); dims = cr[5:8].astype(int)
    par = cr[8:8 + 12 * n]; g = cr[8 + 12 * n:].reshape(dims)
    nd = -(-dims // f)
    pad = np.full(nd * f, -1.0); pad[:dims[0], :dims[1], :dims[2]] = g
    gc = pad.reshape(nd[0], f, nd[1], f, nd[2], f).max(axis=(1, 3, 5))
    return np.r_[n, cr[1:4], cr[4] * f, nd.astype(np.float64), par, gc.ravel()]


def _points(cell, ev, rng, n, bbox, near=None, band=60.0):
    lo, hi = bbox
    U = rng.uniform(lo, hi, size=(n // 2, 3))
    out = [U]; need = n - n // 2
    while need > 0:
        P = rng.uniform(lo, hi, size=(max(need * 20, 100000), 3))
        M = cell.mems(P)
        k = np.abs(M).min(1) < band
        out.append(P[k][:need]); need -= int(k.sum())
    return np.concatenate(out)[:n]


def geometry_consts(ev):
    names = ["G_N", "G_R", "G_CRISTAE", "G_FACE", "G_ZFACE", "G_SPECKLE", "G_GOLGI_CIS", "G_LAYOUT", "G_TABLES",
             "S_PERI_W", "S_IMS_W", "S_PORE_R", "S_HALF", "S_CR_W", "S_CR_GAP", "S_CR_JW", "S_CIS_CLR", "S_PORE_ZWIN",
             "S_PORE_LW", "S_MEM_HALF", "S_CR_RIM", "S_N_MEM_HALF", "TH", "MROW", "RROW", "NCOND", "FBROW", "NMEM_MAX",
             "K_FIELD", "K_WALL", "K_SHELL_PORES", "K_INNER_CRISTAE", "K_GOLGI_CIS", "K_PRIMS", "K_PRIMS_DIFF", "K_SMOOTH_UNION",
             "T_MEM", "T_FIELD", "T_FACE", "T_PORE", "T_SPECKLE", "T_SHAPE", "OP_LT", "OP_GT", "A_SPHERE", "A_ELLIPSOID",
             "A_BALL", "P_SPHERE", "P_CAPSULE", "P_PILL", "P_CERPATCH", "P_SLOT", "P_TORUS", "CLEAR_THICKNESS", "CLEAR_PLAIN",
             "LAYOUT_ID"]
    return {k: (float(getattr(ev, k)) if isinstance(getattr(ev, k), float) else int(getattr(ev, k))) for k in names}


def offset_slots(G, ev):
    """indices of G holding integer offsets (absolute G positions): header section offsets, field headers 10/11,
    golgi_cis field header 10/11; the app reads them as u32 on the GPU"""
    out = [ev.G_CRISTAE, ev.G_SPECKLE, ev.G_GOLGI_CIS, ev.G_TABLES]
    nf = int(G[ev.G_N])
    for k in range(nf):
        o = ev.G_N + 1 + 12 * k
        out += [o + 10, o + 11]
    if G[ev.G_GOLGI_CIS] > 0:
        o = int(G[ev.G_GOLGI_CIS]) + 2
        out += [o + 10, o + 11]
    return sorted(out)


def build_viewer_G(C):
    from wholecell.geometry import rules as RU
    from wholecell.geometry.engines import cellgeom_eval_v1 as ev
    cell, ru, man, pj = C.package()
    gd = C.D.get("geometry", {})
    P = ev.split_legacy_G(cell.G, g_n=ev.G_N)
    slot_name = {f["slot"]: n for n, f in man["fields"].items()}
    sub = gd.get("subsample", {}); reb = gd.get("reband_nm")
    fields = []; finfo = []
    for k, (h10, idx, data) in enumerate(P["fields"]):
        nm = slot_name.get(k, f"slot{k}"); s = int(sub.get(nm, 1))
        empty = man["fields"].get(nm, {}).get("empty", False)
        if empty or int(np.prod(h10[4:7])) == 0:
            fields.append((h10, idx, data)); finfo.append(dict(name=nm, slot=k, empty=True)); continue
        h2, i2, d2 = _subsample_field(h10, idx, data, s, reb)
        fields.append((h2, i2, d2))
        finfo.append(dict(name=nm, slot=k, h_nm_source=float(h10[3]), h_nm=float(h2[3]), subsample=s,
                          reband_nm=reb, bricks_stored=int((i2 >= 0).sum()), bricks_stored_source=int((idx >= 0).sum()),
                          n_values=int(len(i2) + len(d2))))
    gc = P["golgi_cis"]
    if gc is not None:
        W, S_, (h10, idx, data) = gc
        gs = int(gd.get("golgi_cis_subsample", 1))
        h2, i2, d2 = _subsample_field(h10, idx, data, gs, None)
        gc = (W, S_, (h2, i2, d2))
        finfo.append(dict(name="golgi_cis (deep Golgi field of the cisternae section)", h_nm_source=float(h10[3]),
                          h_nm=float(h2[3]), subsample=gs, n_values=int(len(i2) + len(d2))))
    cr = P["cristae"]
    if cr is not None:
        cr = _coarsen_cristae(cr, int(gd.get("cristae_coarsen", 1)))
    params = ev.params_from_G(cell.G)
    tables = RU.compile_for_manifest(ru, man, pj["package_dir"])
    Gv = ev.build_G(P["R"], fields, params=params, face=P["face"], cristae=cr, speckle=P["speckle"], golgi_cis=gc,
                    tables=tables)
    return Gv, finfo, dict(cristae=None if cr is None else int(len(cr)), speckle=None if P["speckle"] is None else int(len(P["speckle"])))


def step_geometry(C):
    from wholecell.geometry.engines import cellgeom_eval_v1 as ev
    from wholecell.geometry import rules as RU
    cell, ru, man, pj = C.package()
    t0 = time.time()
    Gv, finfo, secs = build_viewer_G(C)
    n = len(Gv)
    log(f"geometry: viewer G {n:,} values ({n * 4 / 1e6:.0f} MB f32), package G {len(cell.G):,}; sections {secs}")
    if n > C.a.g_budget:
        log(f"WARNING: viewer G {n:,} > budget {C.a.g_budget:,}")
    G32 = Gv.astype("<f4")
    bad = np.flatnonzero(G32.astype(np.float64) != Gv)
    patches = [[int(i), float(Gv[i])] for i in bad]
    Gstore = G32.astype(np.float64)
    Gstore[bad] = Gv[bad]                       # what the app reconstructs (f32 file + exact patches)
    assert np.array_equal(Gstore, Gv)
    gpath = os.path.join(C.out, "geometry_G.bin")
    G32.tofile(gpath)
    offs = offset_slots(Gv, ev)
    vc = ev.Cell(Gstore, cell.pores)
    if len(cell.PT):
        vc.set_prims(cell.PT, cell.PQ, cell.PC)
    # bbox: cell field grid
    cf = man["fields"]; c0 = cf["cell"]
    lo = np.array(c0["origin_nm"], float); hi = lo + np.array(c0["bricks"], float) * c0["h_nm"] * c0["brick"]
    rng = np.random.default_rng(20261123)
    Pts = _points(cell, ev, rng, 200000, (lo, hi))
    La = cell.labels(Pts); Lb = vc.labels(Pts)
    code2name = {L["engine_code"]: L["name"] for L in man["labels"] if L.get("engine_code") is not None}
    per = {}
    for c in np.unique(La):
        m = La == c
        per[code2name.get(int(c), str(c))] = dict(n=int(m.sum()), agreement=round(float((Lb[m] == c).mean()), 5))
    agree = float((La == Lb).mean())
    log(f"geometry: resample label agreement {agree:.5f} on {len(Pts)} points")
    # golden points for the app's evaluator (TS / WGSL) on the stored viewer G
    rng = np.random.default_rng(7)
    Pg = _points(vc, ev, rng, 20000, (lo, hi))
    Lg = vc.labels(Pg); Mg = vc.mems64(Pg)
    wjson(os.path.join(C.out, "geometry_golden.json"), dict(
        schema="wholecell.viewer_geometry_golden/1", note="labels (engine codes) and membrane SDFs (nm) of the pipeline's numba "
        "kernels (cellgeom_eval_v1, fastmath) on the stored viewer G (geometry_G.bin as float32 + patches); points: half uniform "
        "in the bbox, half within 60 nm of a membrane", n=len(Pg), points=np.round(Pg, 4).ravel().tolist(),
        labels=Lg.astype(int).tolist(), mems=np.round(Mg, 5).ravel().tolist(), n_mems=int(Mg.shape[1])))
    D = C.D
    mems = []
    for m in sorted(man["membranes"], key=lambda x: x["engine_code"]):
        s = D.get("membranes", {}).get(m["name"], {})
        mems.append(dict(name=m["name"], code=m["engine_code"], half_thickness_nm=m.get("half_thickness_nm"),
                         n_side=m.get("n_side"), p_side=m.get("p_side"), leaflets=m.get("leaflets"), go=m.get("go"),
                         display_name=s.get("display_name", m["name"]), colour=s.get("colour", "#B0B0B0"),
                         colour_membranes_view=s.get("colour_membranes_view", s.get("colour", "#B0B0B0"))))
    labels = []
    for L in sorted([L for L in man["labels"] if L.get("engine_code") is not None], key=lambda x: x["engine_code"]):
        s = D.get("labels", {}).get(L["name"], {})
        labels.append(dict(name=L["name"], code=L["engine_code"], id=L["id"], go=L.get("go"),
                           display_name=s.get("display_name", L["name"].replace("_", " ")), fill=s.get("fill", "#EEEEEE")))
    frame = {k: v for k, v in man.get("frame", {}).items() if k != "source_affines"}
    prims = dict(type=[int(x) for x in cell.PT], params=[float(x) for x in np.asarray(cell.PQ).ravel()],
                 cls=[int(x) for x in cell.PC], classes=list((man.get("prims") or {}).get("classes", [])),
                 types={k: int(v) for k, v in ev.PRIM_TYPES.items()})
    rows = []
    for m in ru["membranes"]:
        rows.append("membrane " + json.dumps({k: v for k, v in m.items()}))
    for r in RU.active_rows(ru, RU.package_present(man)):
        rows.append("label %s if %s" % (r["label"], " and ".join(r.get("if", [])) or "always"))
    geo = dict(schema="wholecell.viewer_geometry/1", cell_id=C.cid, build_id=C.bid, package_id=man["package_id"],
               manifest_sha256=pj["manifest_sha256"], layout=man["engine"]["name"], evaluator="cellgeom_eval_v1",
               layout_id=int(ev.LAYOUT_ID), rules_sha256=pj.get("rules_sha256"),
               G=dict(file="geometry_G.bin", dtype="f32", n=n, sha256=sha256(gpath), patches=patches,
                      offset_slots=offs, note="float32 file; patches = [index, exact value] for values float32 cannot hold "
                      "(apply to a Float64Array copy); offset_slots = G indices holding integer offsets (u32 on the GPU)"),
               slots=geometry_consts(ev), n_mems=int(ev.n_mems(Gv)),
               params={k: v for k, v in ev.params_from_G(Gv).items()},
               pores=[round(float(x), 5) for x in np.asarray(cell.pores).ravel()],
               prims=prims, fields=finfo, sections=secs, membranes=mems, labels=labels,
               clip_planes=man.get("domain", {}).get("clip_planes", []), frame=frame,
               domain=dict(enclosing_radius_nm=float(man.get("domain", {}).get("enclosing_radius_nm", Gv[0])),
                           bbox_nm=[lo.tolist(), hi.tolist()]),
               label_rule=rows,
               resample_check=dict(n=int(len(Pts)), agreement=round(agree, 5), per_label=per,
                                   note="labels of the viewer G vs the package G (pipeline kernels); points half uniform in "
                                        "the bbox, half within 60 nm of a membrane"))
    wjson(os.path.join(C.out, "geometry.json"), geo, indent=None)
    log(f"geometry: done in {time.time() - t0:.0f} s; {len(patches)} patches, {len(offs)} offset slots")


# ------------------------------------------------------------------ meshes
def clip_mesh(V_, F_, zf):
    # origin: jurkat/viewer/jenc.py clip_mesh
    if zf is None or not len(F_):
        return V_, F_
    keep = V_[F_].mean(1)[:, 2] >= zf
    F_ = F_[keep]
    used = np.zeros(len(V_), bool); used[F_.ravel()] = True
    remap = np.cumsum(used) - 1
    return V_[used], remap[F_].astype(F_.dtype)


def step_meshes(C):
    # origin: jurkat/viewer/jenc.py organelle_meshes (whole-cell membrane meshes at h nm, clipped at the open face)
    from skimage.measure import marching_cubes
    from wholecell.geometry.engines import cellgeom_eval_v1 as ev
    cell, ru, man, pj = C.package()
    gd = C.D.get("geometry", {}); h = float(gd.get("mesh_h_nm", 64))
    c0 = man["fields"]["cell"]
    lo = np.array(c0["origin_nm"], float) - h; hi = lo + np.array(c0["bricks"], float) * c0["h_nm"] * c0["brick"] + 3 * h
    gx, gy, gz = [np.arange(lo[a], hi[a], h) for a in range(3)]
    nm_ = ev.n_mems(cell.G)
    S = np.empty((len(gx), len(gy), len(gz), nm_), np.float32)
    t0 = time.time()
    Y, Z = np.meshgrid(gy, gz, indexing="ij")
    for i, x in enumerate(gx):
        P = np.c_[np.full(Y.size, x), Y.ravel(), Z.ravel()]
        S[i] = cell.mems(P).reshape(len(gy), len(gz), nm_)
    log(f"meshes: {S.shape} grid evaluated in {time.time() - t0:.0f} s")
    code = {m["name"]: m["engine_code"] for m in man["membranes"]}
    if gd.get("golgi_mesh_blob") and "GOLGI" in code and cell.G[ev.G_GOLGI_CIS] > 0:
        k = man["fields"]["golgi"]["slot"]
        for i, x in enumerate(gx):
            P = np.c_[np.full(Y.size, x), Y.ravel(), Z.ravel()]
            S[i, :, :, code["GOLGI"]] = ev.field_points(P, cell.G, k).reshape(len(gy), len(gz))
    zf = float(cell.G[ev.G_ZFACE]) if cell.G[ev.G_FACE] > 0 else None
    skip = set(gd.get("mesh_skip", []))
    res = []
    for m in sorted(man["membranes"], key=lambda x: x["engine_code"]):
        if m["name"] in skip:
            continue
        s = S[..., m["engine_code"]]
        s = np.minimum(s, 1e3)
        if not (s.min() < 0 < s.max()):
            continue
        V_, F_, _, _ = marching_cubes(s, 0.0, spacing=(h, h, h))
        V_ = V_ + lo
        V_, F_ = clip_mesh(V_, F_, zf)
        if len(F_):
            res.append((m["engine_code"], V_.astype("<f4"), F_.astype("<u4"), m["name"]))
    with gzip.open(os.path.join(C.out, "organelle_meshes.bin.gz"), "wb", compresslevel=6) as f:
        hdr = np.zeros(1 + 3 * len(res), np.uint32); hdr[0] = len(res)
        for i, (mc, V_, F_, _) in enumerate(res):
            hdr[1 + 3 * i:4 + 3 * i] = [mc, len(V_), len(F_)]
        f.write(hdr.tobytes())
        for _, V_, F_, _ in res:
            f.write(V_.tobytes()); f.write(F_.tobytes())
    log("meshes: " + ", ".join(f"{n} {len(F_):,} tris" for _, _, F_, n in res) + f" ({time.time() - t0:.0f} s)")


# ------------------------------------------------------------------ bookmarks
def _unit(v):
    v = np.asarray(v, float); return v / np.linalg.norm(v)


def _rnd(b):
    for k in ("target", "normal", "up"):
        b[k] = [round(float(x), 3) for x in b[k]]
    return b


def step_bookmarks(C):
    from wholecell.geometry.engines import cellgeom_eval_v1 as ev
    cell, ru, man, pj = C.package()
    c0 = man["fields"]["cell"]
    lo = np.array(c0["origin_nm"], float); hi = lo + np.array(c0["bricks"], float) * c0["h_nm"] * c0["brick"]
    mcode = {m["name"]: m["engine_code"] for m in man["membranes"]}
    lcode = {L["name"]: L["engine_code"] for L in man["labels"] if L.get("engine_code") is not None}
    step = float(C.D.get("bookmark_grid_nm", 100.0 if C.cid != "jurkat" else 150.0))
    g = [np.arange(lo[a] + step / 2, hi[a], step) for a in range(3)]
    Pg = np.stack(np.meshgrid(*g, indexing="ij"), -1).reshape(-1, 3)
    Lg = cell.labels(Pg); Mg = cell.mems(Pg)
    inside = Lg != lcode.get("exterior", 0)
    if "outside_imaged_volume" in lcode:
        inside &= Lg != lcode["outside_imaged_volume"]
    ctr = Pg[inside].mean(0)
    v7 = {}
    if C.D.get("bookmarks_v7") and os.path.exists(C.D["bookmarks_v7"]):
        v7 = {b["name"]: b for b in json.load(open(C.D["bookmarks_v7"]))}
    tot = int(json.load(open(os.path.join(C.b, "pack", "summary.json"))).get("instances") or C.cell["stats"].get("instances") or 0)
    lab = lambda p: int(cell.labels(np.asarray(p, float)[None])[0])  # noqa: E731
    name_of = {v: k for k, v in lcode.items()}

    def grad(p, m, e=4.0):
        gg = np.array([cell.mems((p + d)[None])[0, m] - cell.mems((p - d)[None])[0, m] for d in np.eye(3) * e])
        return _unit(gg)

    S = None
    out, notes = [], []
    for spec in C.D.get("bookmarks", []):
        k = spec["kind"]; nm = spec["name"]
        b = dict(name=nm, caption=spec.get("caption", ""), width=spec.get("width", 300), slab=spec.get("slab", 40))
        if spec.get("show"):
            b["show"] = spec["show"]
        try:
            if k == "whole_cell":
                ext = hi - lo
                b.update(target=((lo + hi) / 2).tolist(), normal=[0, 0, 1], up=[0, 1, 0], width=round(float(0.75 * max(ext[0], ext[1])), 1),
                         caption=spec["caption"].replace("{instances_m}", f"{tot / 1e6:.0f}" if tot > 5e7 else f"{tot / 1e6:.1f}"))
                if "outside_imaged_volume" in lcode:   # Jurkat: section through the centre of mass (z = 0 is inside the cell)
                    b["target"] = [float(ctr[0]), float(ctr[1]), 0.0]
            elif k == "copy":
                src = v7.get(nm)
                if not src:
                    raise ValueError("no source bookmark")
                b.update({kk: src[kk] for kk in ("caption", "target", "normal", "up", "width", "slab")})
                got = name_of.get(lab(src["target"]), "?")
                ok = not spec.get("expect") or got in spec["expect"]
                notes.append(f"{nm}: copied from v7 (same model frame; label at target {got}{'' if ok else ' -- UNEXPECTED'})")
            elif k == "membrane":
                m = mcode[spec["membrane"]]
                d = np.abs(Mg[:, m]); cand = np.flatnonzero((d < 30) & inside)
                # a point on the membrane facing -y of the cell (reproducible; exposed like the yeast views)
                ref = ctr + np.array([0.0, -1.0, 0.0]) * 1e5
                p = Pg[cand[np.argmin(np.linalg.norm(Pg[cand] - ref, axis=1))]]
                u = grad(p, m)
                p = p - u * cell.mems(p[None])[0, m]            # onto the surface
                if spec.get("view") == "face":
                    b.update(target=p, normal=-u, up=_unit(np.cross(u, [0.3, 0.5, 0.8])))
                else:
                    b.update(target=p, normal=_unit(np.cross(u, [0.3, 0.5, 0.8])), up=u)
            elif k == "label":
                c = lcode[spec["label"]]; cand = np.flatnonzero(Lg == c)
                if not len(cand):
                    raise ValueError("label absent")
                dep = np.full(len(cand), 1e9)
                for mn in spec.get("depth", []):
                    dep = np.minimum(dep, np.abs(Mg[cand, mcode[mn]]))
                p = Pg[cand[np.argmax(dep)]]
                b.update(target=p, normal=[0, 0, 1], up=[0, 1, 0])
            elif k == "pore":
                pr = np.asarray(cell.pores)
                near = next((x["target"] for x in out if x["name"] == spec.get("near")), ctr)
                j = int(np.argmin(np.linalg.norm(pr[:, :3] - np.asarray(near), axis=1)))
                u = _unit(pr[j, 3:6])
                b.update(target=pr[j, :3], normal=-u, up=_unit(np.cross(u, [0.3, 0.5, 0.8])))
            elif k == "prim":
                ci = man["prims"]["classes"].index(spec["prim_class"])
                sel = np.flatnonzero(np.asarray(cell.PC) == ci)
                if not len(sel):
                    raise ValueError("no prims of this class")
                Q = np.asarray(cell.PQ)[sel]
                cen = Q[:, :3]
                j = int(np.argmin(cen[:, 1]))                # the one facing -y
                p = cen[j]; u = _unit(p - ctr)
                if int(cell.PT[sel[j]]) == ev.P_TORUS:
                    u = _unit(Q[j, 3:6]) * np.sign(np.dot(Q[j, 3:6], p - ctr) or 1)
                b.update(target=p, normal=-u, up=_unit(np.cross(u, [0.3, 0.5, 0.8])))
            elif k == "region":
                if S is None:
                    S = tile_scan(C)
                rid = next(r["id"] for r in C.regions["regions"] if r["name"] == spec["region"])
                rg = (S["key"] & np.uint64(0xFFFF)).astype(np.int64)
                m = rg == rid
                if not m.any():
                    raise ValueError("region has no instances")
                tiles = S["tile"][m]; cnt = S["n"][m]
                ut, inv = np.unique(tiles, return_inverse=True); tc = np.bincount(inv, weights=cnt)
                want = [lcode[x] for x in spec.get("in_labels", [])]
                p = None
                for ti in ut[np.argsort(-tc)][:40].tolist():
                    p, nrm = _region_instance(C, int(ti), rid, ctr, cell if want else None, want)
                    if p is not None:
                        break
                if p is None:
                    raise ValueError("no instance in the wanted labels")
                u = _unit(nrm)
                if spec.get("view") == "face":
                    b.update(target=p, normal=-u, up=_unit(np.cross(u, [0.3, 0.5, 0.8])))
                else:
                    b.update(target=p, normal=_unit(np.cross(u, [0.3, 0.5, 0.8])), up=u)
            elif k == "clip_plane":
                cp = next(c for c in man["domain"]["clip_planes"] if c["name"] == spec["plane"])
                zf = float(cp["point"][2])
                b.update(target=[float(ctr[0]), float(ctr[1]), zf + 2500.0], normal=[0, 1, 0], up=[0, 0, 1],
                         width=round(1.2 * float(cell.G[0]), 1))
            else:
                raise ValueError(f"unknown kind {k}")
        except Exception as e:  # noqa: BLE001
            notes.append(f"{nm}: SKIPPED ({e})"); continue
        if k != "copy":
            notes.append(f"{nm}: {k} -> label at target {name_of.get(lab(b['target']), '?')}")
        out.append(_rnd(b))
    wjson(os.path.join(C.out, "bookmarks.json"), out, indent=1)
    wjson(os.path.join(C.out, "_work", "bookmarks_notes.json"), notes, indent=1)
    log(f"bookmarks: {len(out)}"); [log("  " + n) for n in notes]


def _region_instance(C, ti, rid, ctr, cell=None, want=()):
    """position of the instance of region rid nearest its tile centre, and the outward direction from the cell centre"""
    from wholecell.export import yct2
    r = C.index["tiles"][ti]; cols = C.index["tile_columns"]
    path = os.path.join(C.web, "tiles", r[cols.index("shard")]); off = int(r[cols.index("off")]); n = int(r[cols.index("gz_bytes")])
    with open(path, "rb") as f:
        f.seek(off); raw = zlib.decompress(f.read(n), 31)
    D = yct2.decode_tile(raw)
    org = np.asarray(C.index["grid"]["origin_nm"], float)
    pos = org + D["lo_rel"] + D["pos_rel"]
    m = D["region"] == rid
    pc = org + (np.asarray(D["ijk"]) + 0.5) * C.index["tile_nm"]
    P = pos[m]
    if cell is not None and len(P):
        P = P[np.isin(cell.labels(P), list(want))]
    if not len(P):
        return None, None
    p = P[np.argmin(np.linalg.norm(P - pc, axis=1))]
    return p, p - ctr


# ------------------------------------------------------------------ features
def step_features(C):
    D = C.D
    cell, ru, man, pj = C.package()
    feats = dict(D.get("features", {}))
    if "open_face" in feats and not any(c["name"] == feats["open_face"]["clip_plane"] for c in man.get("domain", {}).get("clip_planes", [])):
        feats.pop("open_face")
    absent = [p for p in ("library/modes.json", "library/organisation.json", "dynamics.json", "overview")
              if not os.path.exists(os.path.join(C.out, p))]
    legend = [dict(label=c["name"], colour=c["colour"], kind="class") for c in D.get("classes", [])]
    wjson(os.path.join(C.out, "features.json"), dict(
        schema="wholecell.viewer_features/1", cell_id=C.cid, build_id=C.bid, features=feats,
        classes=D.get("classes", []), type_colours=D.get("type_colours", []), legend=legend, lipids=D.get("lipids", {}),
        special_colours=D.get("special_colours", {}), absent=absent, polylines=False, lipid_meshes=False,
        ghosts=False, overview=False,
        notes="tiles carry PALETTE + INST only (export not_written: GHOST, POLY, MESH, COLUMN, LOD1 overview): no procedural "
              "lipids on tile meshes, no mRNA / linker DNA threads, no overview stand-ins"), indent=1)
    log(f"features: {list(feats)}; {len(D.get('classes', []))} classes; absent {absent}")


# ------------------------------------------------------------------ docs
def step_docs(C):
    D = C.D
    md = open(D["model_doc"]).read()
    note = D.get("model_note", "").replace("{build_id}", C.bid)
    open(os.path.join(C.out, "MODEL.md"), "w").write(f"> **Build shown:** {note}\n\n{md}")
    A = D.get("attribution", {})
    txt = [f"# {A.get('title', C.cid)}: data licence and attribution", "",
           f"Build `{C.bid}` (cell `{C.cid}`). Authors: {A.get('authors', '')}.", "",
           "## Licence", "",
           "The viewer data in this folder (tiles, library, geometry, meshes, bookmarks, documents and every other generated file) "
           "are licensed under the Creative Commons Attribution-NonCommercial 4.0 International licence (CC BY-NC 4.0, "
           "https://creativecommons.org/licenses/by-nc/4.0/). Commercial use requires a separate licence: contact "
           "Pedro Beltrao (pbeltrao@ethz.ch).", "",
           "## Sources", ""] + [f"- {s}" for s in A.get("sources", [])] + [
           "", "Third-party data keep their own licences (listed above); attribute them when you reuse the corresponding parts. "
           "No Human Protein Atlas images are included.", ""]
    open(os.path.join(C.out, "attribution.md"), "w").write("\n".join(txt))
    log("docs: MODEL.md, attribution.md")


# ------------------------------------------------------------------ thumb
def step_thumb(C):
    from PIL import Image
    from wholecell.geometry.engines import cellgeom_eval_v1 as ev
    geo = json.load(open(os.path.join(C.out, "geometry.json")))
    G = np.fromfile(os.path.join(C.out, "geometry_G.bin"), "<f4").astype(np.float64)
    for i, v in geo["G"]["patches"]:
        G[i] = v
    cell = ev.Cell(G, np.asarray(geo["pores"], float).reshape(-1, 6))
    pr = geo["prims"]
    if pr["type"]:
        cell.set_prims(np.array(pr["type"]), np.array(pr["params"]).reshape(-1, 8), np.array(pr["cls"]))
    lo, hi = [np.array(x, float) for x in geo["domain"]["bbox_nm"]]
    W, H = 480, 360
    c = (lo + hi) / 2
    if any(cp["name"] == "open_face" for cp in geo["clip_planes"]):
        c[2] = 0.0
    ext = max((hi - lo)[0] / W, (hi - lo)[1] / H) * 1.04
    xs = c[0] + (np.arange(W) + 0.5 - W / 2) * ext; ys = c[1] - (np.arange(H) + 0.5 - H / 2) * ext
    X, Y = np.meshgrid(xs, ys)
    P = np.c_[X.ravel(), Y.ravel(), np.full(X.size, c[2])]
    L = cell.labels(P).reshape(H, W)
    fill = {l["code"]: l["fill"] for l in geo["labels"]}
    img = np.zeros((H, W, 4), np.uint8)
    for code, col in fill.items():
        v = int(col[1:], 16); m = L == code
        img[m] = [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255]
    for nm in ("exterior", "outside_imaged_volume"):
        for l in geo["labels"]:
            if l["name"] == nm:
                img[L == l["code"]] = 0
    # membranes as dark lines: label changes between neighbours
    edge = np.zeros((H, W), bool)
    edge[:, 1:] |= L[:, 1:] != L[:, :-1]; edge[1:, :] |= L[1:, :] != L[:-1, :]
    img[edge & (img[..., 3] > 0)] = [70, 70, 80, 255]
    im = Image.fromarray(img, "RGBA")
    im.save(os.path.join(C.out, "thumb.png"))
    try:
        im.save(os.path.join(C.out, "thumb.webp"), quality=85)
    except Exception as e:  # noqa: BLE001
        log("thumb: no webp", e)
    log("thumb: done")


STEPS = ["link", "types_tiles", "library", "geometry", "meshes", "bookmarks", "features", "docs", "thumb"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--defaults"); ap.add_argument("--steps", default="all")
    ap.add_argument("--g-budget", type=int, default=16_000_000); ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()
    C = Ctx(a)
    steps = STEPS if a.steps == "all" else a.steps.split(",")
    t0 = time.time()
    for s in steps:
        t = time.time()
        globals()[f"step_{s}"](C)
        log(f"== {s} {time.time() - t:.0f} s")
    log(f"all done in {time.time() - t0:.0f} s -> {C.out}")


if __name__ == "__main__":
    main()
