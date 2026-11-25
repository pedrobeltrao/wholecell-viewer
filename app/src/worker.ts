/// <reference lib="webworker" />
// origin: jurkat/viewer/app/src/worker.ts (Jurkat viewer v7): Range/shard fetching, caches, procedural lipids. Changed:
// the tile reader is YCT2 (docs tile_format_v2.md §4: palette + sections), positions are relative to the index grid
// origin, and lipid compositions per membrane come from the cell's features.json (yeast: Zinser 1991 per membrane, ported
// from the yeast viewer lipids.ts; Jurkat: one mammalian composition).
//
// Instance word on the GPU (16 B, the app's internal layout; the YCT2 palette is resolved here):
//   w0 = species (16 bits) | region (8 bits) << 16 | flags bits 0-5 << 24 | qidx (2 bits) << 30;  w1-w3 as YCT2.
// All procedural content is deterministic (seeded by tile and element index).

let base = '', ver = '';
let split: Record<string, number> = {};
let TILE = 200, Q_ORG = 80, QSTEP = 360 / 65535;
let ORIGIN = [0, 0, 0];
let polyQ: Record<number, number> = { 4: 0.005, 5: 0.01, 6: 0.005 };
let bo: Uint32Array, nbArr: Uint32Array, brArr: Float32Array;
let beadXYZ: Float32Array | null = null;
let beadsReady: Promise<void> | null = null;
let ready: Promise<void> | null = null;
let libTag: number | null = null;
// lipid composition per membrane code: cumulative weights over the 7 classes (PI, PE, PC, SM, PS, sterol, other);
// leaflets per membrane code ([-1, 1] bilayer, [1] monolayer)
let LCUM: number[][] = [], LEAF: number[][] = [];
// regions whose instances mask lipids (index.json lipid_mask_regions = the GHOST source set; else regions.json kind membrane)
let MASKREG = new Uint8Array(256);
const CACHE_MAX = 48;
const INV_SQRT2 = 0.70710678;

interface Decoded {
  lo: [number, number, number];
  inst: Uint32Array; ghost: Uint32Array; free: Float32Array;
  verts: Float32Array; normals: Float32Array; tris: Uint32Array; fmem: Uint16Array; vmem: Uint16Array;
}
const cache = new Map<number, Decoded>();
const rawCache = new Map<number, ArrayBuffer>();
let rawBytes = 0, rawMax = 400 * 1048576;
function rawPut(i: number, b: ArrayBuffer) {
  const o = rawCache.get(i); if (o) { rawBytes -= o.byteLength; rawCache.delete(i); }
  rawCache.set(i, b); rawBytes += b.byteLength;
  while (rawBytes > rawMax && rawCache.size > 1) {
    const k = rawCache.keys().next().value!; rawBytes -= rawCache.get(k)!.byteLength; rawCache.delete(k);
  }
}
const vq = () => (ver ? `?v=${encodeURIComponent(ver)}` : '');
async function getBin(path: string): Promise<ArrayBuffer> {
  const np = split[path];
  if (!np) { const r = await fetchRetry(base + path + vq()); if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`); return gunzip(await r.arrayBuffer()); }
  const parts: ArrayBuffer[] = []; let n = 0;
  for (let i = 0; i < np; i++) {
    const r = await fetchRetry(`${base}${path}.${String(i).padStart(3, '0')}${vq()}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}.${i}`);
    const b = await r.arrayBuffer(); parts.push(b); n += b.byteLength;
  }
  const out = new Uint8Array(n); let o = 0;
  for (const b of parts) { out.set(new Uint8Array(b), o); o += b.byteLength; }
  return gunzip(out.buffer);
}
// a tile is the gzip member at bytes [off, off + n) of its block shard: HTTP Range request; a server that ignores Range
// (status 200) or a failed ranged request falls back to the whole shard, cached so its other tiles are sliced locally
const shardCache = new Map<string, Promise<ArrayBuffer>>();
const SHARD_CACHE_MAX = 3;
let rangeOk = true;
function wholeShard(path: string): Promise<ArrayBuffer> {
  let p = shardCache.get(path);
  if (!p) {
    p = fetchRetry(base + path + vq()).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`); return r.arrayBuffer(); });
    p.catch(() => shardCache.delete(path));
    shardCache.set(path, p);
    while (shardCache.size > SHARD_CACHE_MAX) shardCache.delete(shardCache.keys().next().value!);
  }
  return p;
}
// hosts that redirect each request to a CDN (Hugging Face resolve/ -> signed URL): remember the CDN URL per shard
const resolved = new Map<string, { url: string; t: number }>();
const RESOLVED_TTL = 20 * 60 * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, init);
    if ((r.status !== 429 && r.status !== 503) || k >= 4) return r;
    const ra = Number(r.headers.get('retry-after'));
    await sleep(ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** k);
  }
}
const resolving = new Map<string, Promise<unknown>>();
async function rangedFetch(path: string, off: number, n: number): Promise<Response> {
  const hdr = { headers: { Range: `bytes=${off}-${off + n - 1}` } };
  const pend = resolving.get(path);
  if (pend && !resolved.has(path)) await pend.catch(() => null);
  const R = resolved.get(path);
  if (R && performance.now() - R.t < RESOLVED_TTL) {
    const r = await fetchRetry(R.url, hdr);
    if (r.ok) return r;
    resolved.delete(path);
  }
  const p = fetchRetry(base + path + vq(), hdr);
  if (!resolving.has(path)) { resolving.set(path, p); p.finally(() => resolving.delete(path)).catch(() => null); }
  const r = await p;
  if (r.status === 206 && r.redirected && r.url) resolved.set(path, { url: r.url, t: performance.now() });
  return r;
}
async function getTileBytes(m: any): Promise<ArrayBuffer> {
  const { path, off, n } = m.shard as { path: string; off: number; n: number };
  const cached = shardCache.get(path);
  if (cached) return (await cached).slice(off, off + n);
  if (rangeOk) {
    let r: Response | null = null;
    try { r = await rangedFetch(path, off, n); } catch (e) { console.warn('ranged fetch failed, using whole shards', e); rangeOk = false; }
    if (r) {
      if (r.status === 206) return await r.arrayBuffer();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
      const whole = r.arrayBuffer();
      shardCache.set(path, whole);
      while (shardCache.size > SHARD_CACHE_MAX) shardCache.delete(shardCache.keys().next().value!);
      return (await whole).slice(off, off + n);
    }
  }
  return (await wholeShard(path)).slice(off, off + n);
}
async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const u = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (u[0] === 0x1f && u[1] === 0x8b) return await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return buf;
}
async function getDecoded(m: any, info?: { fetched: number }): Promise<Decoded> {
  let D = cache.get(m.idx);
  if (D) { cache.delete(m.idx); cache.set(m.idx, D); return D; }
  let raw = rawCache.get(m.idx);
  if (raw) { rawCache.delete(m.idx); rawCache.set(m.idx, raw); }
  else { raw = await getTileBytes(m); if (info) info.fetched = raw.byteLength; rawPut(m.idx, raw); }
  D = decodeTile(await gunzip(raw), m);
  cache.set(m.idx, D);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return D;
}

// thinned uploads (tiles.ts THIN, when the view's tiles exceed the molecule budget): instance i is kept when its hash
// is below the keep fraction, so a sparser subset is contained in every denser one
const keepHash = (i: number) => (Math.imul(i + 1, 0x9E3779B1) >>> 0) / 4294967296;
// slab clip: keep what can be seen in [lo, hi] along n (instances by bounding sphere, beads by position, triangles);
// thin < 1 keeps that fraction of the instances (polymer beads and triangles are kept whole)
function clipTile(D: Decoded, c: { n: number[]; lo: number; hi: number } | null, thin = 1) {
  if (!c && thin >= 1) return { inst: D.inst.slice(), free: D.free.slice(), ib: D.tris.slice() };
  const [nx, ny, nz] = c ? c.n : [0, 0, 0], clo = c ? c.lo : -Infinity, chi = c ? c.hi : Infinity;
  const lo = D.lo, w = D.inst, nI = w.length / 4;
  const keep = new Uint32Array(w.length); let k = 0;
  const ox = lo[0] - Q_ORG, oy = lo[1] - Q_ORG, oz = lo[2] - Q_ORG;
  for (let i = 0; i < nI; i++) {
    if (thin < 1 && keepHash(i) >= thin) continue;
    const w1 = w[4 * i + 1], w2 = w[4 * i + 2];
    if (c) {
      const s = nx * (ox + (w1 & 0xFFFF) * QSTEP) + ny * (oy + (w1 >>> 16) * QSTEP) + nz * (oz + (w2 & 0xFFFF) * QSTEP);
      const br = brArr[w[4 * i] & 0xFFFF];
      if (s + br < clo || s - br > chi) continue;
    }
    keep[4 * k] = w[4 * i]; keep[4 * k + 1] = w1; keep[4 * k + 2] = w2; keep[4 * k + 3] = w[4 * i + 3]; k++;
  }
  if (!c) return { inst: keep.slice(0, 4 * k), free: D.free.slice(), ib: D.tris.slice() };
  const F = D.free, nF = F.length / 4, fo = new Float32Array(F.length); let kf = 0;
  for (let i = 0; i < nF; i++) {
    const s = nx * F[4 * i] + ny * F[4 * i + 1] + nz * F[4 * i + 2];
    if (s >= c.lo - 1.5 && s <= c.hi + 1.5) { fo.set(F.subarray(4 * i, 4 * i + 4), 4 * kf); kf++; }
  }
  const V = D.verts, Tr = D.tris, nT = Tr.length / 3, ib = new Uint32Array(Tr.length); let kt = 0;
  const sv = (j: number) => nx * V[3 * j] + ny * V[3 * j + 1] + nz * V[3 * j + 2];
  for (let t = 0; t < nT; t++) {
    const a = sv(Tr[3 * t]), b = sv(Tr[3 * t + 1]), cc = sv(Tr[3 * t + 2]);
    if (Math.max(a, b, cc) >= c.lo - 1 && Math.min(a, b, cc) <= c.hi + 1) { ib[3 * kt] = Tr[3 * t]; ib[3 * kt + 1] = Tr[3 * t + 1]; ib[3 * kt + 2] = Tr[3 * t + 2]; kt++; }
  }
  return { inst: keep.slice(0, 4 * k), free: fo.slice(0, 4 * kf), ib: ib.slice(0, 3 * kt) };
}

const LIPID_KEYS = ['PI', 'PE', 'PC', 'SM', 'PS', 'sterol', 'other'];
function lipidCum(tab: Record<string, number> | undefined): number[] {
  const w = LIPID_KEYS.map(() => 0);
  if (tab) for (const [k, v] of Object.entries(tab)) {
    if (typeof v !== 'number') continue;
    const i = LIPID_KEYS.indexOf(k); w[i >= 0 ? i : 6] += v;
  }
  w[5] = 0;                                   // sterols are not drawn as headgroups (their weight goes to no class)
  const s = w.reduce((a, b) => a + b, 0) || 1; let c = 0;
  return w.map(x => (c += x / s));
}

async function init(msg: any) {
  base = msg.base; ver = msg.ver ?? ''; split = msg.split ?? {};
  TILE = msg.tileNm; Q_ORG = msg.qOrg; QSTEP = msg.qRange / 65535; ORIGIN = msg.origin;
  if (msg.polyQ) polyQ = { ...polyQ, ...msg.polyQ };
  if (msg.rawBudgetMB) rawMax = msg.rawBudgetMB * 1048576;
  libTag = msg.libTag ?? null;
  const T = msg.types as { bo: number; nb: number; br: number }[], n = T.length;
  bo = new Uint32Array(n); nbArr = new Uint32Array(n); brArr = new Float32Array(n);
  for (let i = 0; i < n; i++) { bo[i] = T[i].bo; nbArr[i] = T[i].nb; brArr[i] = T[i].br; }
  const lip = msg.lipids ?? {};
  LCUM = []; LEAF = [];
  for (const m of msg.membranes ?? []) {
    LCUM[m.code] = lipidCum(lip[m.name] ?? lip.default);
    const lf = String(m.leaflets ?? 'bilayer').toLowerCase();
    LEAF[m.code] = lf === 'none' ? [] : (lf.startsWith('mono') || lf === '1') ? [1] : [-1, 1];
  }
  if (msg.beadQ !== undefined) beadQ = msg.beadQ;
  MASKREG = new Uint8Array(256);
  for (const r of msg.maskRegions ?? []) if (r >= 0 && r < 256) MASKREG[r] = 1;
}
let beadQ = 0.005;
function loadBeads(): Promise<void> {
  if (!beadsReady) beadsReady = (async () => {
    const raw = await getBin('library/beads.bin');
    const i16 = new Int16Array(raw), nB = raw.byteLength / 8;
    beadXYZ = new Float32Array(nB * 3);
    for (let i = 0; i < nB; i++) { beadXYZ[3 * i] = i16[4 * i] * beadQ; beadXYZ[3 * i + 1] = i16[4 * i + 1] * beadQ; beadXYZ[3 * i + 2] = i16[4 * i + 2] * beadQ; }
  })();
  return beadsReady;
}

// ------------------------------------------------------------------ YCT2 tile decoding
const MAGIC_YCT2 = 0x32544359;
const S_PALETTE = 1, S_INST = 2, S_GHOST = 3, S_POLY_MRNA = 4, S_POLY_LINK = 5, S_POLY_EXTRA = 6, S_MESH = 7;
const pad4 = (x: number) => (x + 3) & ~3;

function decodePolylines(buf: ArrayBuffer, off: number, n: number, lo: number[], q: number, kind: number, kinds: Uint16Array | null) {
  const lens = new Uint32Array(buf.slice(off, off + 4 * n)); off += 4 * n;
  let nb = 0; for (let i = 0; i < n; i++) nb += lens[i];
  const st = new Int32Array(buf.slice(off, off + 12 * n)); off += 12 * n;
  const d = new Int8Array(buf, off, Math.max(0, 3 * (nb - n)));
  const out = new Float32Array(4 * nb), outU = new Uint32Array(out.buffer);
  let k = 0, o = 0;
  for (let i = 0; i < n; i++) {
    let x = st[3 * i], y = st[3 * i + 1], z = st[3 * i + 2];
    for (let j = 0; j < lens[i]; j++) {
      if (j > 0) { x += d[3 * k]; y += d[3 * k + 1]; z += d[3 * k + 2]; k++; }
      out[4 * o] = lo[0] + x * q; out[4 * o + 1] = lo[1] + y * q; out[4 * o + 2] = lo[2] + z * q;
      outU[4 * o + 3] = ((kinds ? kinds[i] & 15 : kind) | ((i & 0x7FFF) << 4)) >>> 0;
      o++;
    }
  }
  return out;
}

/** YCT2 instance words -> the app's word layout (species and region resolved through the palette) */
function remap(src: Uint32Array, pal: Uint32Array): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(src.length), n = src.length / 4, np = pal.length / 2;
  for (let i = 0; i < n; i++) {
    const w0 = src[4 * i], pi = w0 & 0xFFFF;
    const sp = pi < np ? pal[2 * pi] : 0, rg = pi < np ? pal[2 * pi + 1] & 0xFFFF : 0;
    out[4 * i] = ((sp & 0xFFFF) | (Math.min(rg, 255) << 16) | (((w0 >>> 16) & 0x3F) << 24) | ((w0 >>> 30) << 30)) >>> 0;
    out[4 * i + 1] = src[4 * i + 1]; out[4 * i + 2] = src[4 * i + 2]; out[4 * i + 3] = src[4 * i + 3];
  }
  return out;
}

function decodeTile(buf: ArrayBuffer, m: any): Decoded {
  const h = new Uint32Array(buf, 0, 32);
  if (h[0] !== MAGIC_YCT2) throw new Error(`tile ${m.ix},${m.iy},${m.iz}: not YCT2 (magic ${h[0].toString(16)})`);
  if ((h[1] >>> 16) !== 2) throw new Error(`tile format major ${h[1] >>> 16}: this viewer reads YCT2 2.x`);
  if (libTag !== null && h[14] !== 0 && h[14] !== libTag) throw new Error(`tile ${m.ix},${m.iy},${m.iz}: library tag ${h[14]} != ${libTag} (tile and library of different builds)`);
  const t = new Int32Array(buf, 8, 3);
  const lo: [number, number, number] = [ORIGIN[0] + t[0] * TILE, ORIGIN[1] + t[1] * TILE, ORIGIN[2] + t[2] * TILE];
  const nSec = h[12], fl = h[13];
  let pal: Uint32Array = new Uint32Array(0), inst: Uint32Array = new Uint32Array(0), ghost: Uint32Array = new Uint32Array(0);
  const frees: Float32Array[] = [];
  let verts = new Float32Array(0), tris = new Uint32Array(0), fmem = new Uint16Array(0);
  const sec = new Uint32Array(buf, 128, 4 * nSec);
  const secs: [number, number, number, number][] = [];
  for (let s = 0; s < nSec; s++) secs.push([sec[4 * s], sec[4 * s + 1], sec[4 * s + 2], sec[4 * s + 3]]);
  for (const [kind, off, len, count] of secs) {
    if (kind === S_PALETTE) pal = new Uint32Array(buf.slice(off, off + 8 * count));
    else if (kind === S_INST) inst = new Uint32Array(buf.slice(off, off + 16 * count));
    else if (kind === S_GHOST) ghost = new Uint32Array(buf.slice(off, off + 16 * count));
    else if (kind === S_POLY_MRNA || kind === S_POLY_LINK) frees.push(decodePolylines(buf, off, count, lo, polyQ[kind], kind === S_POLY_MRNA ? 0 : 1, null));
    else if (kind === S_POLY_EXTRA) {
      const kinds = new Uint16Array(buf.slice(off, off + 2 * count));
      frees.push(decodePolylines(buf, off + pad4(2 * count), count, lo, polyQ[kind], 0, kinds));
    } else if (kind === S_MESH) {
      const nV = m.nVert, nT = m.nTri; let o = off;
      const v = new Uint16Array(buf.slice(o, o + 6 * nV)); o += pad4(6 * nV);
      verts = new Float32Array(3 * nV);
      for (let i = 0; i < nV; i++) for (let a = 0; a < 3; a++) verts[3 * i + a] = lo[a] - Q_ORG + v[3 * i + a] * QSTEP;
      if (fl & 1) { tris = new Uint32Array(buf.slice(o, o + 12 * nT)); o += 12 * nT; }
      else { tris = Uint32Array.from(new Uint16Array(buf.slice(o, o + 6 * nT))); o += pad4(6 * nT); }
      fmem = new Uint16Array(buf.slice(o, o + 2 * nT));
      void len;
    }
    // unknown kinds (COLUMN 8, future sections) are skipped: forward compatible
  }
  inst = remap(inst, pal); ghost = remap(ghost, pal);
  let nF = 0; for (const f of frees) nF += f.length;
  const free = new Float32Array(nF); { let o = 0; for (const f of frees) { free.set(f, o); o += f.length; } }
  // area-weighted vertex normals (face normals point to the positive-SDF / cytoplasmic side)
  const nV = verts.length / 3, nT = tris.length / 3;
  const normals = new Float32Array(nV * 3), vmem = new Uint16Array(nV);
  for (let f = 0; f < nT; f++) {
    const a = tris[3 * f], b = tris[3 * f + 1], c = tris[3 * f + 2];
    const ux = verts[3 * b] - verts[3 * a], uy = verts[3 * b + 1] - verts[3 * a + 1], uz = verts[3 * b + 2] - verts[3 * a + 2];
    const vx = verts[3 * c] - verts[3 * a], vy = verts[3 * c + 1] - verts[3 * a + 1], vz = verts[3 * c + 2] - verts[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { normals[3 * k] += nx; normals[3 * k + 1] += ny; normals[3 * k + 2] += nz; vmem[k] = fmem[f]; }
  }
  for (let i = 0; i < nV; i++) {
    const l = Math.hypot(normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]) || 1;
    normals[3 * i] /= l; normals[3 * i + 1] /= l; normals[3 * i + 2] /= l;
  }
  return { lo, inst, ghost, free, verts, normals, tris, fmem, vmem };
}

// ------------------------------------------------------------------ instance pose (mirrors the WGSL)
const i16f = (x: number) => (((x << 16) >> 16) / 32767) * INV_SQRT2;
function instPose(w: Uint32Array, i: number, lo: number[], P: Float64Array) {
  const w0 = w[4 * i], w1 = w[4 * i + 1], w2 = w[4 * i + 2], w3 = w[4 * i + 3];
  P[0] = lo[0] - Q_ORG + (w1 & 0xFFFF) * QSTEP; P[1] = lo[1] - Q_ORG + (w1 >>> 16) * QSTEP; P[2] = lo[2] - Q_ORG + (w2 & 0xFFFF) * QSTEP;
  const a = i16f(w2 >>> 16), b = i16f(w3 & 0xFFFF), c = i16f(w3 >>> 16);
  const big = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
  const qi = w0 >>> 30;
  const q = qi === 0 ? [big, a, b, c] : qi === 1 ? [a, big, b, c] : qi === 2 ? [a, b, big, c] : [a, b, c, big];
  const [qw, qx, qy, qz] = q;
  P[3] = qw * qw + qx * qx - qy * qy - qz * qz; P[4] = 2 * (qx * qy - qw * qz); P[5] = 2 * (qx * qz + qw * qy);
  P[6] = 2 * (qx * qy + qw * qz); P[7] = qw * qw - qx * qx + qy * qy - qz * qz; P[8] = 2 * (qy * qz - qw * qx);
  P[9] = 2 * (qx * qz - qw * qy); P[10] = 2 * (qy * qz + qw * qx); P[11] = qw * qw - qx * qx - qy * qy + qz * qz;
  return { type: w0 & 0xFFFF, region: (w0 >>> 16) & 255, flags: (w0 >>> 24) & 0x3F };
}

class BeadHash {
  h: number; tbl: number; mask: number; start: Uint32Array; pts: Float32Array; inst: Int32Array;
  constructor(xyz: Float32Array, owner: Int32Array, n: number, h: number) {
    this.h = h;
    let tbl = 1; while (tbl < n * 2) tbl <<= 1; tbl = Math.max(tbl, 1024);
    this.tbl = tbl; this.mask = tbl - 1;
    const key = new Uint32Array(n), cnt = new Uint32Array(tbl + 1);
    for (let i = 0; i < n; i++) { key[i] = this.k(Math.floor(xyz[3 * i] / h), Math.floor(xyz[3 * i + 1] / h), Math.floor(xyz[3 * i + 2] / h)); cnt[key[i] + 1]++; }
    for (let i = 0; i < tbl; i++) cnt[i + 1] += cnt[i];
    this.start = cnt.slice();
    this.pts = new Float32Array(n * 3); this.inst = new Int32Array(n);
    const fill = cnt.slice(0, tbl);
    for (let i = 0; i < n; i++) {
      const j = fill[key[i]]++;
      this.pts[3 * j] = xyz[3 * i]; this.pts[3 * j + 1] = xyz[3 * i + 1]; this.pts[3 * j + 2] = xyz[3 * i + 2];
      this.inst[j] = owner[i];
    }
  }
  k(x: number, y: number, z: number) { return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & this.mask; }
  near(x: number, y: number, z: number, r: number, skip = -1): boolean {
    const h = this.h, cx = Math.floor(x / h), cy = Math.floor(y / h), cz = Math.floor(z / h), r2 = r * r;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const key = this.k(cx + dx, cy + dy, cz + dz);
      for (let j = this.start[key], e = this.start[key + 1]; j < e; j++) {
        const ax = this.pts[3 * j] - x, ay = this.pts[3 * j + 1] - y, az = this.pts[3 * j + 2] - z;
        if (ax * ax + ay * ay + az * az < r2 && this.inst[j] !== skip) return true;
      }
    }
    return false;
  }
}
function collectBeads(list: { w: Uint32Array; i: number; lo: number[]; id: number }[]) {
  let n = 0;
  const P = new Float64Array(12), BX = beadXYZ!;
  for (const e of list) n += nbArr[e.w[4 * e.i] & 0xFFFF];
  const xyz = new Float32Array(n * 3), owner = new Int32Array(n);
  let k = 0;
  for (const e of list) {
    const { type } = instPose(e.w, e.i, e.lo, P);
    const b0 = bo[type], nb = nbArr[type];
    for (let j = 0; j < nb; j++) {
      const bx = BX[3 * (b0 + j)], by = BX[3 * (b0 + j) + 1], bz = BX[3 * (b0 + j) + 2];
      xyz[3 * k] = P[0] + P[3] * bx + P[4] * by + P[5] * bz;
      xyz[3 * k + 1] = P[1] + P[6] * bx + P[7] * by + P[8] * bz;
      xyz[3 * k + 2] = P[2] + P[9] * bx + P[10] * by + P[11] * bz;
      owner[k] = e.id; k++;
    }
  }
  return { xyz, owner, n };
}
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash3 = (a: number, b: number, c: number) => {
  let x = Math.imul(a ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(b + 0x632BE5AB, 0xC2B2AE35) ^ Math.imul(c + 0x27D4EB2F, 0x165667B1);
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return x >>> 0;
};
function octEncode(nx: number, ny: number, nz: number) {
  const s = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
  let x = nx / s, y = ny / s;
  if (nz < 0) { const ox = x; x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1); y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1); }
  const ex = Math.max(0, Math.min(255, Math.round((x + 1) * 127.5))), ey = Math.max(0, Math.min(255, Math.round((y + 1) * 127.5)));
  return ex | (ey << 8);
}
const LIPID_AREA = 0.65, MASK_R = 0.95;
interface Range { n: number[]; d: number; lo: number; hi: number; mode: 'slab' | 'shell' }
function sOf(R: Range, x: number, y: number, z: number) { return R.n[0] * x + R.n[1] * y + R.n[2] * z - R.d; }

/** procedural lipids on the tile's membrane triangles (needs MESH sections), masked by protein residues */
function genDetail(tileIdx: number, D: Decoded, R: Range) {
  const lipids: number[] = [];
  const stats = { lipCand: 0, lipMasked: 0 };
  if (D.tris.length && R.mode === 'slab' && beadXYZ) {
    const list: { w: Uint32Array; i: number; lo: number[]; id: number }[] = [];
    const nI = D.inst.length / 4, nG = D.ghost.length / 4;
    // lipid maskers: flag bit 0 (near_membrane) or a lipid-mask region (membrane proteins, pores, ...); ghosts = the same
    // set from the 26 neighbour tiles
    for (let i = 0; i < nI; i++) {
      const w0 = D.inst[4 * i];
      if (((w0 >>> 24) & 1) || MASKREG[(w0 >>> 16) & 255]) list.push({ w: D.inst, i, lo: D.lo, id: i });
    }
    for (let i = 0; i < nG; i++) list.push({ w: D.ghost, i, lo: D.lo, id: nI + i });
    const B = collectBeads(list);
    const hash = new BeadHash(B.xyz, B.owner, B.n, 1.0);
    const V = D.verts, N = D.normals, T = D.tris, nT = T.length / 3;
    for (let f = 0; f < nT; f++) {
      const ia = T[3 * f], ib = T[3 * f + 1], ic = T[3 * f + 2];
      const ax = V[3 * ia], ay = V[3 * ia + 1], az = V[3 * ia + 2], bx = V[3 * ib], by = V[3 * ib + 1], bz = V[3 * ib + 2];
      const cx = V[3 * ic], cy = V[3 * ic + 1], cz = V[3 * ic + 2];
      const s0 = sOf(R, ax, ay, az), s1 = sOf(R, bx, by, bz), s2 = sOf(R, cx, cy, cz);
      if (Math.max(s0, s1, s2) < R.lo - 3 || Math.min(s0, s1, s2) > R.hi + 3) continue;
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      const mem = D.fmem[f], cum = LCUM[mem] ?? LCUM[0] ?? lipidCum(undefined);
      for (const sg of LEAF[mem] ?? [-1, 1]) {
        const r = rng(hash3(tileIdx, f, sg + 7));
        const nexp = area / LIPID_AREA;
        const Nn = Math.floor(nexp) + (r() < nexp - Math.floor(nexp) ? 1 : 0);
        if (!Nn) continue;
        const k = Math.ceil(Math.sqrt(Nn)), k2 = k * k;
        const cells = new Uint16Array(k2); for (let i = 0; i < k2; i++) cells[i] = i;
        for (let i = 0; i < Nn; i++) { const j = i + Math.floor(r() * (k2 - i)); const t = cells[i]; cells[i] = cells[j]; cells[j] = t; }
        for (let m = 0; m < Nn; m++) {
          const c = cells[m], row = Math.floor(Math.sqrt(c)), col = c - row * row;
          const jj = col >> 1, up = (col & 1) === 0;
          let p0r, p0s, p1r, p1s, p2r, p2s;
          if (up) { p0r = row; p0s = jj; p1r = row + 1; p1s = jj; p2r = row + 1; p2s = jj + 1; }
          else { p0r = row; p0s = jj; p1r = row + 1; p1s = jj + 1; p2r = row; p2s = jj + 1; }
          let uu = r(), vv = r(); if (uu + vv > 1) { uu = 1 - uu; vv = 1 - vv; }
          const rr = p0r + uu * (p1r - p0r) + vv * (p2r - p0r), ss = p0s + uu * (p1s - p0s) + vv * (p2s - p0s);
          const al = (rr - ss) / k, be = ss / k, ga = 1 - al - be;
          const px = ax + al * ux + be * vx, py = ay + al * uy + be * vy, pz = az + al * uz + be * vz;
          let nx = ga * N[3 * ia] + al * N[3 * ib] + be * N[3 * ic], ny = ga * N[3 * ia + 1] + al * N[3 * ib + 1] + be * N[3 * ic + 1];
          let nz = ga * N[3 * ia + 2] + al * N[3 * ib + 2] + be * N[3 * ic + 2];
          const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
          const u = r();
          let cls = 0; while (cls < 6 && u > cum[cls]) cls++;
          stats.lipCand++;
          const s = sOf(R, px, py, pz);
          if (s < R.lo - 2.5 || s > R.hi + 2.5) continue;
          let hit = false;
          for (const o of [1.95, 1.25, 0.55]) if (hash.near(px + nx * sg * o, py + ny * sg * o, pz + nz * sg * o, MASK_R)) { hit = true; break; }
          if (hit) { stats.lipMasked++; continue; }
          lipids.push(px, py, pz, (octEncode(nx, ny, nz) | (cls << 16) | ((sg > 0 ? 1 : 0) << 19) | ((mem & 15) << 20)) >>> 0);
        }
      }
    }
  }
  const L = new Float32Array(lipids.length), LU = new Uint32Array(L.buffer);
  for (let i = 0; i < lipids.length; i += 4) { L[i] = lipids[i]; L[i + 1] = lipids[i + 1]; L[i + 2] = lipids[i + 2]; LU[i + 3] = lipids[i + 3]; }
  return { lipids: L, free: new Float32Array(0), stats };
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.cmd === 'init') { ready = init(m); await ready; (self as any).postMessage({ cmd: 'ready' }); return; }
    await ready;
    if (m.cmd === 'load') {
      const info = { fetched: 0 }; const T = await getDecoded(m, info);
      const nV = T.verts.length / 3;
      const vb = new Float32Array(nV * 8), vbu = new Uint32Array(vb.buffer);
      for (let i = 0; i < nV; i++) {
        vb[8 * i] = T.verts[3 * i]; vb[8 * i + 1] = T.verts[3 * i + 1]; vb[8 * i + 2] = T.verts[3 * i + 2]; vbu[8 * i + 3] = T.vmem[i];
        vb[8 * i + 4] = T.normals[3 * i]; vb[8 * i + 5] = T.normals[3 * i + 1]; vb[8 * i + 6] = T.normals[3 * i + 2];
      }
      const C = clipTile(T, m.clip ?? null, m.thin ?? 1);
      (self as any).postMessage({ cmd: 'loaded', idx: m.idx, inst: C.inst, free: C.free, vb, ib: C.ib, lo: T.lo, clip: m.clip ?? null, thin: m.thin ?? 1, nFull: T.inst.length / 4, fetched: info.fetched },
        [C.inst.buffer, C.free.buffer, vb.buffer, C.ib.buffer]);
    } else if (m.cmd === 'detail') {
      const D = await getDecoded(m);
      if (D.tris.length) await loadBeads();
      const t0 = performance.now();
      const out = genDetail(m.idx, D, m.range);
      (self as any).postMessage({ cmd: 'detail', idx: m.idx, key: m.key, lipids: out.lipids, free: out.free, stats: out.stats, ms: performance.now() - t0 },
        [out.lipids.buffer, out.free.buffer]);
    }
  } catch (e: any) {
    (self as any).postMessage({ cmd: 'error', idx: m.idx, key: m.key, req: m.cmd, error: String(e && e.stack || e) });
  }
};
