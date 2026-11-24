// origin: jurkat/viewer/app/src/data.ts (Jurkat viewer v7), made cell-agnostic: the data base comes from the cell
// registry (registry.ts), regions / colours / molecule classes come from the cell's regions.json and features.json.
//
// Data access for ONE cell (fetch with retries, gzip, optional split parts) and library preparation.
import { packColor } from './math';

declare global { interface Window { __YC_EMBED__?: Record<string, string>; } }

/** the open cell's data location and cache key (set once by initData before anything is fetched) */
export const ctx = { base: '', ver: '', split: {} as Record<string, number>, absent: new Set<string>() };

export const verQuery = (v: string) => (v ? `?v=${encodeURIComponent(v)}` : '');

/** point every data request at one cell's data folder; the build id is the cache key (immutable folders) */
export async function initData(base: string, ver: string) {
  ctx.base = base.endsWith('/') ? base : base + '/';
  ctx.ver = ver;
  try {
    const r = await fetch(ctx.base + 'split.json' + verQuery(ver));
    ctx.split = r.ok ? await r.json() : {};
  } catch { ctx.split = {}; }
}
export function setAbsent(list: string[] | undefined) { ctx.absent = new Set(list ?? []); }
/** optional files the cell declares absent (features.json "absent"): never requested */
export const isAbsent = (path: string) => ctx.absent.has(path);

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gunzipIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const u8 = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }
  return buf;
}

/** fetch with retries on 429 / 503 (rate-limited hosts such as Hugging Face): Retry-After or 1, 2, 4, 8 s */
export async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, init);
    if ((r.status !== 429 && r.status !== 503) || k >= 4) return r;
    const ra = Number(r.headers.get('retry-after'));
    await new Promise(res => setTimeout(res, ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** k));
  }
}
export async function fetchBin(path: string, onProgress?: (n: number, total: number) => void): Promise<ArrayBuffer> {
  const emb = window.__YC_EMBED__;
  if (emb && emb[path] !== undefined) return gunzipIfNeeded(b64ToBytes(emb[path]).buffer as ArrayBuffer);
  const np = ctx.split[path];
  const url = (p: string) => ctx.base + p + verQuery(ctx.ver);
  if (np) {   // split.json {path: n_parts}: hosts with a per-file size limit get large files as path.000, path.001, ...
    const parts: ArrayBuffer[] = []; let n = 0;
    for (let i = 0; i < np; i++) {
      const r = await fetchRetry(url(`${path}.${String(i).padStart(3, '0')}`));
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}.${i}`);
      const b = await r.arrayBuffer(); parts.push(b); n += b.byteLength; onProgress?.(i + 1, np);
    }
    const out = new Uint8Array(n); let o = 0;
    for (const b of parts) { out.set(new Uint8Array(b), o); o += b.byteLength; }
    return gunzipIfNeeded(out.buffer);
  }
  const r = await fetchRetry(url(path));
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${ctx.base}${path}`);
  if (!onProgress || !r.body) return gunzipIfNeeded(await r.arrayBuffer());
  const total = Number(r.headers.get('content-length') || 0);
  const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length; onProgress(n, total);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return gunzipIfNeeded(out.buffer);
}
export async function fetchJson(path: string): Promise<any> {
  const b = await fetchBin(path);
  return JSON.parse(new TextDecoder().decode(b));
}
export async function fetchText(path: string): Promise<string> {
  return new TextDecoder().decode(await fetchBin(path));
}

// ---------------------------------------------------------------- per-cell tables
export interface Region { id: number; name: string; kind: string; display_as: string; colour: string; group: string; geometry_refs?: any }
/** molecule class of features.json: own Show switch, special colours, no illustrative motion */
export interface MolClass { key: string; name: string; colour: string; colour2?: string; patterns: string[]; own_switch?: boolean; no_motion?: boolean }
export interface Features {
  schema?: string; features: Record<string, any>; classes: MolClass[]; lipids?: Record<string, any>;
  legend?: { label: string; colour: string; kind?: string }[]; absent?: string[]; polylines?: boolean; lipid_meshes?: boolean;
  type_colours?: { pattern: string; colour: string; colour2?: string | null; cls?: string }[];   // per type-id colours (no own switch)
  special_colours?: { cell_surface?: string; membrane_band?: string; backdrop?: string };
}

// Palette (storage buffer shared by the shaders; 512 vec4). Layout is part of the app, colours are cell data:
//   0..63    fixed app colours (lipid classes 32..39, lipid head 40 / tail 41 / sterol 42, free-sphere kinds 48..55,
//            traced cell surface 60, open face 61, background 62)
//   64..127  organelle-mode membrane colours (64 + engine membrane code)      geometry.json membranes[].colour
//   128..191 membranes-only view colours (128 + code)                          geometry.json membranes[].colour_only
//   192..255 compartment fill colours (192 + engine label code)                geometry.json labels[].fill
//   256..511 instance region colours (256 + region id), w = flags (1 visible, 2 membrane-embedded)   regions.json
export const PAL_SURF = 60, PAL_FACE = 61, PAL_BG = 62, PAL_MEM = 64, PAL_MEMONLY = 128, PAL_LABEL = 192, PAL_REGION = 256, PAL_N = 512;
export const FIXED_PAL: Record<number, string> = {
  32: '#F3C643', 33: '#F0BC3C', 34: '#F6D15E', 35: '#EAB542', 36: '#EFA83A', 37: '#E7A93C', 38: '#F2CA55', 39: '#E8873A',
  40: '#F3C643', 41: '#F8E3A0', 42: '#E7A93C',
  48: '#B0437A', 49: '#E07636', 50: '#CDA866', 51: '#C3C27A', 52: '#C9558F', 53: '#7CC6C2', 54: '#E2D6A8', 55: '#9B8BC4',
  60: '#D3DFEE', 61: '#8D939C', 62: '#F6F1E7',
};
export const BG_HEX = FIXED_PAL[PAL_BG];
export function hexRgb(h: string | null | undefined): [number, number, number] {
  if (!h || h[0] !== '#') return [0.85, 0.85, 0.85];
  const v = parseInt(h.slice(1, 7), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
/** palette for one cell; regionFlags[r]: bit0 visible, bit1 membrane-embedded */
export function buildPalette(regions: Region[], geo: { membranes: any[]; labels: any[] }, regionFlags: Uint32Array, feat?: Features): Float32Array<ArrayBuffer> {
  const a = new Float32Array(PAL_N * 4);
  const put = (i: number, h: string | null | undefined, w = 1) => { const c = hexRgb(h); a.set([c[0], c[1], c[2], w], 4 * i); };
  for (const [k, h] of Object.entries(FIXED_PAL)) put(Number(k), h);
  const sc = feat?.special_colours ?? {};
  if (sc.cell_surface) put(PAL_SURF, sc.cell_surface);
  if (sc.membrane_band) put(41, sc.membrane_band);
  if (sc.backdrop) put(PAL_BG, sc.backdrop);
  for (const m of geo.membranes) {
    if (m.code < 0 || m.code >= 64) continue;
    put(PAL_MEM + m.code, m.colour ?? '#B5653F');
    put(PAL_MEMONLY + m.code, m.colour_only ?? m.colour_membranes_view ?? m.colour ?? '#B5653F');
  }
  for (const L of geo.labels) if (L.code >= 0 && L.code < 64) put(PAL_LABEL + L.code, L.fill ?? BG_HEX, L.fill ? 1 : 0);
  for (const r of regions) if (r.id >= 0 && r.id < 256) put(PAL_REGION + r.id, r.colour, regionFlags[r.id]);
  return a;
}

export function idMatches(id: string, patterns: string[]): boolean {
  return patterns.some(p => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p));
}
/** special colours of a library type id: features.json type_colours, then the class colours (exact patterns win over
 *  prefixes ending in '*'; the longest prefix wins) */
export function colourFor(feat: Features, id: string): { colour: string; colour2?: string | null } | undefined {
  let best: { colour: string; colour2?: string | null } | undefined, bl = -1;
  const consider = (p: string, c: { colour: string; colour2?: string | null }, bonus: number) => {
    const ok = p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p;
    const l = (p.endsWith('*') ? p.length - 1 : 1e6) + bonus;
    if (ok && l > bl) { best = c; bl = l; }
  };
  for (const t of feat.type_colours ?? []) consider(t.pattern, t, 0.5);
  for (const c of feat.classes ?? []) for (const p of c.patterns) consider(p, c, 0);
  return best;
}

/** colour of interaction module i: golden-angle hues, three lightness levels */
export function moduleColor(i: number): string {
  const h = (i * 137.508) % 360, s = 0.62, l = [0.58, 0.44, 0.70][i % 3];
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

export interface TypeRec {
  id: string; gene: string; genes: string; uniprot: string; name: string; src: string; pdb: string;
  oligomer: number; nb: number; nnt: number; bo: number; so: number; sn: number; br: number; rg: number;
  mass: number; plddt_mean: number | null; plddt_frac_kept: number | null; copies: number; regions: Record<string, number>;
  model?: string; bead_stride?: number;
}

export interface Library {
  types: TypeRec[];
  beads: Float32Array<ArrayBuffer>;         // vec4 per bead: xyz, w = bits(kind | plddt << 8)
  st: Float32Array<ArrayBuffer>;            // sphere tree xyzr
  clusters: ArrayBuffer;       // per cluster: vec4f centre/radius + vec4u (offset, count, 0, 0)
  typeInfo: ArrayBuffer;       // 16 x u32 per type
  modes: Uint32Array<ArrayBuffer>;          // conformational motion modes (library/modes.bin; one zero word when absent)
  modeCap: number;
  modules: { label: string; n: number }[];
  moduleOf: Int32Array;
  nClusters: number;
  byId: Map<string, number>;
  libTag: number | null;
}

export async function loadLibrary(feat: Features, progress: (msg: string, f: number) => void): Promise<Library> {
  progress('Loading structure index', 0.12);
  const tj = await fetchJson('library/types.json');
  const types: TypeRec[] = tj.types;
  if (!Array.isArray(types) || !types.length || types[0].nb === undefined)
    throw new Error('library/types.json has no bead offsets: the cell needs the viewer library (tools/export_viewer_extras.py, step library)');
  if (types.length > 65535) throw new Error(`${types.length} species: the viewer's instance word holds 65,535`);
  const q = tj.bead_q as number;
  progress('Loading residue coordinates', 0.15);
  const raw = await fetchBin('library/beads.bin', (n, t) => progress('Loading residue coordinates', 0.15 + 0.4 * (t ? n / t : 0)));
  const st = new Float32Array(await fetchBin('library/spheretree.bin'));
  let modes = new Uint32Array(4), modeIdx: Record<string, number[]> = {}, modeCap = 0;
  if (!isAbsent('library/modes.json')) try {
    const mj = await fetchJson('library/modes.json');
    modes = new Uint32Array(await fetchBin('library/modes.bin')); modeIdx = mj.types; modeCap = mj.cap ?? 1.5;
  } catch { /* no modes in this build */ }
  let modules: { label: string; n: number }[] = [], modOf: Record<string, number> = {};
  if (!isAbsent('library/organisation.json')) try {
    const oj = await fetchJson('library/organisation.json');
    modules = oj.modules; modOf = oj.types;
  } catch { /* no organisation layer in this build */ }
  progress('Building level-of-detail clusters', 0.58);
  const nB = raw.byteLength / 8;
  const i16 = new Int16Array(raw), u8 = new Uint8Array(raw);
  const beads = new Float32Array(nB * 4), bu = new Uint32Array(beads.buffer);
  for (let i = 0; i < nB; i++) {
    beads[4 * i] = i16[4 * i] * q; beads[4 * i + 1] = i16[4 * i + 1] * q; beads[4 * i + 2] = i16[4 * i + 2] * q;
    bu[4 * i + 3] = u8[8 * i + 6] | (u8[8 * i + 7] << 8);
  }
  let nC = 0;
  for (const t of types) nC += Math.ceil(t.nb / 64);
  const clusters = new ArrayBuffer(Math.max(1, nC) * 32), cf = new Float32Array(clusters), cu = new Uint32Array(clusters);
  const typeInfo = new ArrayBuffer(types.length * 64), tu = new Uint32Array(typeInfo), tf = new Float32Array(typeInfo);
  let c = 0;
  types.forEach((t, ti) => {
    const c0 = c;
    for (let o = 0; o < t.nb; o += 64) {
      const n = Math.min(64, t.nb - o), b0 = t.bo + o;
      let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
      for (let k = 0; k < n; k++) {
        const j = 4 * (b0 + k), x = beads[j], y = beads[j + 1], z = beads[j + 2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, cz = (mnz + mxz) / 2;
      let r = 0;
      for (let k = 0; k < n; k++) {
        const j = 4 * (b0 + k);
        r = Math.max(r, Math.hypot(beads[j] - cx, beads[j + 1] - cy, beads[j + 2] - cz));
      }
      cf[8 * c] = cx; cf[8 * c + 1] = cy; cf[8 * c + 2] = cz; cf[8 * c + 3] = r + 0.85 + (modeIdx[ti]?.[3] ?? 0);
      cu[8 * c + 4] = b0; cu[8 * c + 5] = n;
      c++;
    }
    const sp = colourFor(feat, t.id);
    const isPDB = t.src === 'PDB';
    tu[16 * ti + 0] = t.bo; tu[16 * ti + 1] = t.nb; tu[16 * ti + 2] = c0; tu[16 * ti + 3] = c - c0;
    tu[16 * ti + 4] = t.so; tu[16 * ti + 5] = t.sn;
    tf[16 * ti + 6] = t.br; tf[16 * ti + 7] = Math.sqrt(5 / 3) * (t.rg || t.br / 1.6);
    tu[16 * ti + 8] = sp ? packColor(sp.colour) : 0; tu[16 * ti + 9] = sp && sp.colour2 ? packColor(sp.colour2) : 0;
    tu[16 * ti + 10] = ((isPDB ? 1 : 0) | (Math.min(t.copies || 0, 0xFFFFFF) << 8)) >>> 0;
    tf[16 * ti + 11] = isPDB ? 255 : (t.plddt_mean ?? 255);
    const mi = modeIdx[ti];
    if (mi) { tu[16 * ti + 12] = mi[0]; tu[16 * ti + 13] = mi[1]; tu[16 * ti + 14] = mi[2]; }
    tu[16 * ti + 15] = modOf[ti] !== undefined ? packColor(moduleColor(modOf[ti])) : 0;
  });
  const byId = new Map<string, number>();
  types.forEach((t, i) => byId.set(t.id, i));
  const moduleOf = new Int32Array(types.length).fill(-1);
  for (const [ti, m] of Object.entries(modOf)) moduleOf[Number(ti)] = m;
  return { types, beads, st, clusters, typeInfo, modes, modeCap, modules, moduleOf, nClusters: nC, byId, libTag: tj.lib_tag ?? null };
}

// ---------------------------------------------------------------- tile index (YCT2, tile_format_v2.md §6)
export interface TileIndex {
  n: number; ix: Int32Array; iy: Int32Array; iz: Int32Array; nInst: Uint32Array; nGhost: Uint32Array;
  nPoly: Uint32Array; nVert: Uint32Array; nTri: Uint32Array; gz: Uint32Array; labelMask: Uint32Array;
  off: Float64Array; shard: string[]; key: Map<number, number>;
  tileNm: number; qOrg: number; qRange: number; origin: [number, number, number];
  min: [number, number, number]; dims: [number, number, number]; blockTiles: number;
  libTag: number | null; buildTag: number | null; flagBits: { bit: number; name: string }[];
  /** poly_q (nm) per POLY section kind (index.json polyline_kinds), and the lipid-mask region ids (GHOST source set) */
  polyQ: Record<number, number>; lipidMask: number[] | null; sections: string[];
}
export async function loadTileIndex(): Promise<TileIndex> {
  const j = await fetchJson('tiles/index.json');
  if (j.format !== 'YCT2') throw new Error(`tiles/index.json format ${j.format ?? '(none)'}: this viewer reads YCT2 (convert YCT1 exports, tile_format_v2.md §8)`);
  const cols: string[] = j.tile_columns; const T: any[][] = j.tiles; const n = T.length;
  const ci = (k: string) => cols.indexOf(k);
  const mk = <A extends Int32Array | Uint32Array>(C: new (n: number) => A, k: string) => {
    const a = new C(n), c = ci(k); if (c < 0) return a;
    for (let i = 0; i < n; i++) a[i] = T[i][c]; return a;
  };
  const g = j.grid;
  const min: [number, number, number] = [g.min_ijk[0], g.min_ijk[1], g.min_ijk[2]];
  const dims: [number, number, number] = [g.max_ijk[0] - min[0] + 1, g.max_ijk[1] - min[1] + 1, g.max_ijk[2] - min[2] + 1];
  const idx: TileIndex = {
    n, ix: mk(Int32Array, 'ix'), iy: mk(Int32Array, 'iy'), iz: mk(Int32Array, 'iz'),
    nInst: mk(Uint32Array, 'n_inst'), nGhost: mk(Uint32Array, 'n_ghost'), nPoly: mk(Uint32Array, 'n_poly_beads'),
    nVert: mk(Uint32Array, 'n_vert'), nTri: mk(Uint32Array, 'n_tri'), gz: mk(Uint32Array, 'gz_bytes'),
    labelMask: mk(Uint32Array, 'label_mask'), off: new Float64Array(n), shard: new Array(n), key: new Map(),
    tileNm: j.tile_nm, qOrg: j.q_org, qRange: j.q_range, origin: g.origin_nm, min, dims, blockTiles: j.block_tiles ?? 5,
    libTag: j.lib_tag ?? null, buildTag: j.build_tag ?? null, flagBits: j.flag_bits ?? [],
    polyQ: {}, lipidMask: Array.isArray(j.lipid_mask_regions) ? j.lipid_mask_regions : null,
    sections: j.sections_written ?? [],
  };
  for (const [k, v] of Object.entries(j.polyline_kinds ?? {})) { const q = Number((v as any)?.poly_q); if (q > 0) idx.polyQ[Number(k)] = q; }
  const co = ci('off'), cs = ci('shard');
  for (let i = 0; i < n; i++) { idx.off[i] = T[i][co]; idx.shard[i] = 'tiles/' + T[i][cs]; }
  for (let i = 0; i < n; i++) idx.key.set(tkey(idx, idx.ix[i], idx.iy[i], idx.iz[i]), i);
  return idx;
}
/** index of tile (ix, iy, iz) in the tile-state grid (min_ijk .. max_ijk of index.json), -1 outside */
export function tkey(idx: { min: number[]; dims: number[] }, ix: number, iy: number, iz: number): number {
  const a = ix - idx.min[0], b = iy - idx.min[1], c = iz - idx.min[2];
  if (a < 0 || b < 0 || c < 0 || a >= idx.dims[0] || b >= idx.dims[1] || c >= idx.dims[2]) return -1;
  return (a * idx.dims[1] + b) * idx.dims[2] + c;
}
