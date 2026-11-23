// origin: wholecell/geometry/engines/cellgeom_eval_v1.py (pipeline commit 0a3ba79; kernels field_sdf_o, golgi_sdf,
// face_dist, in_pore_w, in_speckle, crista_lumen, shell_pores, sdf_cer, sdf_prim, smin_c, prims_min, analytic_sdf,
// in_shape, fval, mem_sdfs, label_from), ported to TypeScript (float64) for the viewer.
//
// Generic, table-driven cell geometry: ONE evaluator for every cell. Everything cell-specific comes from the cell's
// geometry.json + geometry_G.bin (written by tools/export_viewer_extras.py, step `geometry`): the flat cellgeom_eval_v1
// vector G (sparse-brick fields resampled for the viewer, procedural sections, the compiled membrane table and label
// rule), the nuclear pores, the analytic primitives and the evaluator's layout constants (slots, row widths, kind codes).
// The WGSL port of the same kernels is generated from the same constants (shaders.ts geometryWGSL).
//
// Deviation from the pipeline kernels (documented, exact for labels): prims and pores are visited through a uniform grid
// of cells over the cell's bounding box (cell lists hold every prim / pore whose influence region, plus a margin, meets
// the cell) instead of the full list. Prims farther than the margin change SDF magnitudes but never a sign or a label
// threshold of the rule tables in use (margin >= 60 nm, smooth-union k <= 30 nm); checked by tools/golden_geometry.mjs.

export interface GeoJson {
  schema: string; cell_id: string; build_id: string; layout: string; evaluator: string;
  G: { file: string; dtype: 'f32' | 'f64'; n: number; sha256?: string; patches?: [number, number][] };   // patches: [index, exact float64 value]
  slots: Record<string, number>; constants?: Record<string, number>;
  pores: number[];
  prims: { type: number[]; params: number[]; cls: number[]; classes: string[]; types?: Record<string, number> };
  fields: { name: string; slot: number; h_nm: number }[];
  membranes: { name: string; code: number; half_thickness_nm?: number; n_side?: any; p_side?: any; display_name?: string; colour?: string; colour_membranes_view?: string; colour_only?: string }[];
  labels: { name: string; code: number; id?: number; display_name?: string; fill?: string | null; description?: string }[];
  clip_planes?: any[]; frame?: any; domain: { enclosing_radius_nm: number; bbox_nm: [number[], number[]] };
  label_rule?: any; resample_check?: any;
}

/** evaluator constant by name: geometry.json "slots" or "constants" (exported from cellgeom_eval_v1, never hard-coded) */
export function konst(geo: GeoJson, name: string): number {
  const v = geo.slots?.[name] ?? geo.constants?.[name];
  if (v === undefined || v === null) throw new Error(`geometry.json lacks evaluator constant ${name}`);
  return Number(v);
}

export interface Grid {
  n: number; lo: [number, number, number]; cs: [number, number, number];   // cells per axis, grid origin, cell size
  primOff: Uint32Array; primIdx: Uint32Array; poreOff: Uint32Array; poreIdx: Uint32Array;
}

export class GeomEval {
  G: Float64Array; geo: GeoJson;
  pores: Float64Array; nPores: number;
  PT: Int32Array; PQ: Float64Array; PC: Int32Array;
  K: Record<string, number> = {};
  grid!: Grid;
  nMem: number; nRow: number; nLab: number;
  tab: number; r0: number; data0: number;
  domainMem = -1; domainRows = 0; exteriorCode = -1; outsideCode = -1;
  bbox: { lo: [number, number, number]; hi: [number, number, number] };
  margin = 60;
  private out = new Float64Array(32);

  constructor(geo: GeoJson, G: Float64Array) {
    this.geo = geo; this.G = G;
    const names = ['G_N', 'G_R', 'G_CRISTAE', 'G_FACE', 'G_ZFACE', 'G_SPECKLE', 'G_GOLGI_CIS', 'G_TABLES', 'S_PERI_W', 'S_CR_W', 'S_CR_GAP',
      'S_CR_JW', 'S_CIS_CLR', 'S_CR_RIM', 'TH', 'MROW', 'RROW', 'FBROW', 'K_FIELD', 'K_WALL', 'K_SHELL_PORES', 'K_INNER_CRISTAE', 'K_GOLGI_CIS',
      'K_PRIMS', 'K_PRIMS_DIFF', 'K_SMOOTH_UNION', 'T_MEM', 'T_FIELD', 'T_FACE', 'T_PORE', 'T_SPECKLE', 'T_SHAPE', 'OP_LT', 'A_SPHERE',
      'A_ELLIPSOID', 'P_SPHERE', 'P_CAPSULE', 'P_PILL', 'P_CERPATCH', 'P_SLOT', 'P_TORUS'];
    for (const n of names) this.K[n] = konst(geo, n);
    const K = this.K;
    this.pores = Float64Array.from(geo.pores ?? []); this.nPores = this.pores.length / 6;
    const pr = geo.prims ?? { type: [], params: [], cls: [], classes: [] };
    this.PT = Int32Array.from(pr.type ?? []); this.PQ = Float64Array.from(pr.params ?? []); this.PC = Int32Array.from(pr.cls ?? []);
    this.tab = G[K.G_TABLES];
    this.nMem = G[this.tab]; this.nRow = G[this.tab + 1]; this.nLab = G[this.tab + 2];
    this.r0 = this.tab + K.TH + K.MROW * this.nRow;
    this.data0 = this.r0 + K.RROW * this.nLab + K.FBROW * G[this.tab + 3];
    const b = geo.domain.bbox_nm;
    this.bbox = { lo: [b[0][0], b[0][1], b[0][2]], hi: [b[1][0], b[1][1], b[1][2]] };
    const code = (n: string) => geo.labels.find(l => l.name === n)?.code ?? -1;
    this.exteriorCode = code('exterior'); this.outsideCode = code('outside_imaged_volume');
    this.findDomain();
    let kmax = 0;
    for (let r = 0; r < this.nRow; r++) { const q = this.tab + K.TH + K.MROW * r; if (G[q] === K.K_SMOOTH_UNION) kmax = Math.max(kmax, G[q + 3]); }
    this.margin = Math.max(60, 2 * kmax + 10);
    this.buildGrid();
  }

  // ---------------------------------------------------------------- domain membrane (exterior boundary)
  /** the membrane of the label row giving 'exterior' (single "<membrane> < 0" test), and the membrane rows it needs */
  findDomain() {
    const G = this.G, K = this.K;
    for (let r = 0; r < this.nLab; r++) {
      const q = this.r0 + K.RROW * r;
      if (G[q] === this.exteriorCode && G[q + 1] === 1 && G[q + 2] === K.T_MEM && G[q + 4] === K.OP_LT && G[q + 5] === 0) { this.domainMem = G[q + 3]; break; }
    }
    if (this.domainMem < 0) return;
    // row index of each membrane code; dependency closure over rows (membrane references in a, p0, p1)
    const rowOf: number[] = []; let i = 0;
    for (let r = 0; r < this.nRow; r++) { const q = this.tab + K.TH + K.MROW * r; if (G[q] !== K.K_SMOOTH_UNION) rowOf[i++] = r; }
    let mask = 0;
    const need = (m: number) => {
      const r = rowOf[m]; if (r === undefined || (mask >> r) & 1) return;
      mask |= 1 << r;
      const q = this.tab + K.TH + K.MROW * r, kind = G[q];
      if (kind === K.K_WALL || kind === K.K_INNER_CRISTAE) need(G[q + 1]);
      if (kind === K.K_GOLGI_CIS) { need(G[q + 3]); need(G[q + 4]); }
      if (kind === K.K_PRIMS && G[q + 3] >= 0) need(G[q + 3]);
      for (let s = 0; s < this.nRow; s++) {           // smooth unions into m
        const qs = this.tab + K.TH + K.MROW * s;
        if (G[qs] === K.K_SMOOTH_UNION && G[qs + 1] === m) mask |= 1 << s;
      }
    };
    need(this.domainMem);
    this.domainRows = mask >>> 0;
  }

  // ---------------------------------------------------------------- acceleration grid (prims, pores)
  primBound(i: number): [number, number, number, number] {
    const K = this.K, q = this.PQ, o = 8 * i, t = this.PT[i];
    if (t === K.P_SPHERE) return [q[o], q[o + 1], q[o + 2], q[o + 3]];
    if (t === K.P_CAPSULE) {
      const L = Math.hypot(q[o + 3] - q[o], q[o + 4] - q[o + 1], q[o + 5] - q[o + 2]);
      return [(q[o] + q[o + 3]) / 2, (q[o + 1] + q[o + 4]) / 2, (q[o + 2] + q[o + 5]) / 2, L / 2 + q[o + 6]];
    }
    if (t === K.P_PILL || t === K.P_TORUS) return [q[o], q[o + 1], q[o + 2], q[o + 6] + q[o + 7]];
    if (t === K.P_SLOT) {
      const L = Math.hypot(q[o + 3] - q[o], q[o + 4] - q[o + 1], q[o + 5] - q[o + 2]);
      return [(q[o] + q[o + 3]) / 2, (q[o + 1] + q[o + 4]) / 2, (q[o + 2] + q[o + 5]) / 2, L / 2 + q[o + 7] + q[o + 6]];
    }
    // cER patch (spherical shell patch; as a sheet it follows the reference membrane): cap of half-angle q4 at radius q5,
    // with 400 nm slack for the reference membrane's departure from that sphere
    const th = Math.min(q[o + 4], Math.PI);
    return [q[o] * q[o + 5], q[o + 1] * q[o + 5], q[o + 2] * q[o + 5], 2 * q[o + 5] * Math.sin(th / 2) + q[o + 6] + 400];
  }
  buildGrid() {
    const K = this.K, G = this.G;
    const lo: [number, number, number] = [0, 0, 0], cs: [number, number, number] = [0, 0, 0];
    const ext = Math.max(...[0, 1, 2].map(a => this.bbox.hi[a] - this.bbox.lo[a]));
    const n = Math.max(8, Math.min(64, Math.round(ext / 250)));
    for (let a = 0; a < 3; a++) { lo[a] = this.bbox.lo[a] - 100; cs[a] = (this.bbox.hi[a] - this.bbox.lo[a] + 200) / n; }
    const n3 = n * n * n;
    const cellRange = (c: number, r: number, a: number) => [Math.max(0, Math.floor((c - r - lo[a]) / cs[a])), Math.min(n - 1, Math.floor((c + r - lo[a]) / cs[a]))];
    const lists = (items: [number, number, number, number][]) => {
      const L: number[][] = Array.from({ length: n3 }, () => []);
      items.forEach(([x, y, z, r], k) => {
        const [i0, i1] = cellRange(x, r, 0), [j0, j1] = cellRange(y, r, 1), [l0, l1] = cellRange(z, r, 2);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let l = l0; l <= l1; l++) L[(i * n + j) * n + l].push(k);
      });
      const off = new Uint32Array(n3 + 1); let tot = 0;
      for (let c = 0; c < n3; c++) { off[c] = tot; tot += L[c].length; }
      off[n3] = tot;
      const idx = new Uint32Array(Math.max(1, tot)); let k = 0;
      for (let c = 0; c < n3; c++) for (const v of L[c]) idx[k++] = v;
      return { off, idx };
    };
    const P: [number, number, number, number][] = [];
    for (let i = 0; i < this.PT.length; i++) { const b = this.primBound(i); P.push([b[0], b[1], b[2], b[3] + this.margin]); }
    // pore reach: the largest axial window / channel radius of the shell_pores rows
    let reach = 0;
    for (let r = 0; r < this.nRow; r++) {
      const q = this.tab + K.TH + K.MROW * r;
      if (G[q] === K.K_SHELL_PORES) reach = Math.max(reach, Math.hypot(G[q + 5], G[q + 4] + 0.5 * G[q + 3]) + 2);
    }
    const Q: [number, number, number, number][] = [];
    for (let k = 0; k < this.nPores; k++) Q.push([this.pores[6 * k], this.pores[6 * k + 1], this.pores[6 * k + 2], reach]);
    const a = lists(P), b = lists(Q);
    this.grid = { n, lo, cs, primOff: a.off, primIdx: a.idx, poreOff: b.off, poreIdx: b.idx };
  }
  cellOf(x: number, y: number, z: number): number {
    const g = this.grid, n = g.n;
    const f = (v: number, a: number) => Math.min(n - 1, Math.max(0, Math.floor((v - g.lo[a]) / g.cs[a])));
    return (f(x, 0) * n + f(y, 1)) * n + f(z, 2);
  }

  // ---------------------------------------------------------------- kernels
  fieldO(px: number, py: number, pz: number, o: number): number {
    const G = this.G, h = G[o + 3], B = G[o + 7];
    const fx = (px - G[o]) / h, fy = (py - G[o + 1]) / h, fz = (pz - G[o + 2]) / h;
    const nbx = G[o + 4], nby = G[o + 5], nbz = G[o + 6];
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nbx * B || fy >= nby * B || fz >= nbz * B) return G[o + 9];
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const bx = Math.floor(ix / B), by = Math.floor(iy / B), bz = Math.floor(iz / B);
    const bi = G[G[o + 10] + (bx * nby + by) * nbz + bz];
    if (bi === -1) return -G[o + 8];
    if (bi === -2) return G[o + 9];
    const n1 = B + 1, sx = n1 * n1, sy = n1;
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const b = G[o + 11] + bi * n1 * n1 * n1 + ((ix - bx * B) * n1 + (iy - by * B)) * n1 + (iz - bz * B);
    const c00 = G[b] + (G[b + sx] - G[b]) * tx, c01 = G[b + 1] + (G[b + sx + 1] - G[b + 1]) * tx;
    const c10 = G[b + sy] + (G[b + sx + sy] - G[b + sy]) * tx, c11 = G[b + sy + 1] + (G[b + sx + sy + 1] - G[b + sy + 1]) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }
  nFields() { return this.G[this.K.G_N]; }
  fieldSdf(px: number, py: number, pz: number, k: number) { return this.fieldO(px, py, pz, this.K.G_N + 1 + 12 * k); }
  analytic(px: number, py: number, pz: number, kind: number, o: number): number {
    const G = this.G, dx = px - G[o], dy = py - G[o + 1], dz = pz - G[o + 2];
    if (kind === this.K.A_SPHERE) return Math.sqrt(dx * dx + dy * dy + dz * dz) - G[o + 3];
    const lx = (G[o + 6] * dx + G[o + 7] * dy + G[o + 8] * dz) / G[o + 3];
    const ly = (G[o + 9] * dx + G[o + 10] * dy + G[o + 11] * dz) / G[o + 4];
    const lz = (G[o + 12] * dx + G[o + 13] * dy + G[o + 14] * dz) / G[o + 5];
    const k0 = Math.sqrt(lx * lx + ly * ly + lz * lz);
    const k1 = Math.sqrt((lx / G[o + 3]) ** 2 + (ly / G[o + 4]) ** 2 + (lz / G[o + 5]) ** 2);
    if (k1 < 1e-12) return -Math.min(G[o + 3], G[o + 4], G[o + 5]);
    return k0 * (k0 - 1) / k1;
  }
  /** field slot k, or its analytic fallback when the package lacks the field */
  fval(px: number, py: number, pz: number, k: number): number {
    const G = this.G, K = this.K, nfb = G[this.tab + 3];
    if (nfb > 0) {
      const f0 = this.r0 + K.RROW * this.nLab;
      for (let j = 0; j < nfb; j++) {
        const q = f0 + K.FBROW * j;
        if (G[q] === k) return this.analytic(px, py, pz, G[q + 1], this.data0 + G[q + 2]);
      }
    }
    return this.fieldSdf(px, py, pz, k);
  }
  faceDist(pz: number) { const G = this.G; return G[this.K.G_FACE] > 0 ? pz - G[this.K.G_ZFACE] : 1e9; }
  inPore(px: number, py: number, pz: number, rc: number, zwin: number, cell: number): number {
    const g = this.grid, P = this.pores;
    for (let q = g.poreOff[cell]; q < g.poreOff[cell + 1]; q++) {
      const k = g.poreIdx[q], o = 6 * k;
      const vx = px - P[o], vy = py - P[o + 1], vz = pz - P[o + 2];
      const z = vx * P[o + 3] + vy * P[o + 4] + vz * P[o + 5];
      if (z < -zwin || z > zwin) continue;
      const rx = vx - z * P[o + 3], ry = vy - z * P[o + 4], rz = vz - z * P[o + 5];
      if (rx * rx + ry * ry + rz * rz < rc * rc) return k;
    }
    return -1;
  }
  inSpeckle(px: number, py: number, pz: number): number {
    const G = this.G, o = G[this.K.G_SPECKLE], n = G[o];
    for (let k = 0; k < n; k++) {
      const q = o + 1 + 4 * k, dx = px - G[q], dy = py - G[q + 1], dz = pz - G[q + 2];
      if (dx * dx + dy * dy + dz * dz < G[q + 3] * G[q + 3]) return k;
    }
    return -1;
  }
  cristaLumen(px: number, py: number, pz: number, b: number): number {
    const G = this.G, K = this.K, o = G[K.G_CRISTAE];
    const n = G[o], h = G[o + 4], nx = G[o + 5], ny = G[o + 6], nz = G[o + 7];
    const ix = Math.floor((px - G[o + 1]) / h), iy = Math.floor((py - G[o + 2]) / h), iz = Math.floor((pz - G[o + 3]) / h);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 1e9;
    const k = G[o + 8 + 12 * n + (ix * ny + iy) * nz + iz];
    if (k < 0) return 1e9;
    const q = o + 8 + 12 * k;
    if (G[q + 11] === 0) return 1e9;
    const S = G[q + 4];
    const t = G[q] * px + G[q + 1] * py + G[q + 2] * pz - G[q + 3];
    const u = t - S * Math.floor(t / S + 0.5);
    const slab = Math.abs(u) - G[K.S_CR_W];
    let lam = Math.max(slab, b + G[K.S_CR_GAP]);
    if (G[K.S_CR_RIM] > 0) {
      const r = Math.min(G[K.S_CR_RIM], G[K.S_CR_W]), e = b + G[K.S_CR_GAP];
      const ra = Math.max(slab + r, 0), rb = Math.max(e + r, 0);
      lam = Math.min(-r, lam) + Math.sqrt(ra * ra + rb * rb);
    }
    const w = Math.abs(G[q + 5] * (px - G[q + 8]) + G[q + 6] * (py - G[q + 9]) + G[q + 7] * (pz - G[q + 10])) - G[K.S_CR_JW];
    return Math.min(lam, Math.max(slab, w));
  }
  golgi(px: number, py: number, pz: number, k: number, other: number): number {
    const G = this.G, K = this.K;
    let g = this.fieldSdf(px, py, pz, k);
    if (G[K.G_GOLGI_CIS] > 0 && g < 0 && other > G[K.S_CIS_CLR]) {
      const o = G[K.G_GOLGI_CIS], W = G[o], S = G[o + 1];
      const d = -this.fieldO(px, py, pz, o + 2);
      const v = d - W, w = v - S * Math.floor(v / S + 0.5);
      g = Math.max(g, Math.abs(w) - W);
    }
    return g;
  }
  shellPores(px: number, py: number, pz: number, k: number, pw: number, pr: number, zwin: number, foff: number, cell: number): number {
    let hp = this.fval(px, py, pz, k);
    if (foff !== 0) hp = hp + foff;
    let d = Math.abs(hp) - 0.5 * pw;
    const rc = pr + 0.5 * pw;
    if (Math.abs(hp) < rc + pw) {
      const j = this.inPore(px, py, pz, rc, zwin, cell);
      if (j >= 0) {
        const P = this.pores, o = 6 * j;
        const vx = px - P[o], vy = py - P[o + 1], vz = pz - P[o + 2];
        const z = vx * P[o + 3] + vy * P[o + 4] + vz * P[o + 5];
        const rho = Math.sqrt(Math.max(vx * vx + vy * vy + vz * vz - z * z, 0));
        d = Math.sqrt((rho - rc) ** 2 + hp * hp) - 0.5 * pw;
      }
    }
    return d;
  }
  sdfCer(px: number, py: number, pz: number, o: number, pm: number, Rp: number): number {
    const q = this.PQ, r = Math.sqrt(px * px + py * py + pz * pz);
    let c = (px * q[o] + py * q[o + 1] + pz * q[o + 2]) / Math.max(r, 1e-9);
    c = Math.min(1, Math.max(-1, c));
    const s = Math.max(Math.acos(c) - q[o + 4], 0) * r;
    const dr = (Rp - q[o + 5]) - pm;
    return Math.sqrt(s * s + dr * dr) - q[o + 6];
  }
  sdfPrim(px: number, py: number, pz: number, t: number, o: number): number {
    const K = this.K, q = this.PQ;
    if (t === K.P_SPHERE) { const dx = px - q[o], dy = py - q[o + 1], dz = pz - q[o + 2]; return Math.sqrt(dx * dx + dy * dy + dz * dz) - q[o + 3]; }
    if (t === K.P_CAPSULE) {
      const ax = px - q[o], ay = py - q[o + 1], az = pz - q[o + 2];
      const bx = q[o + 3] - q[o], by = q[o + 4] - q[o + 1], bz = q[o + 5] - q[o + 2];
      const h = Math.min(Math.max((ax * bx + ay * by + az * bz) / (bx * bx + by * by + bz * bz), 0), 1);
      const dx = ax - bx * h, dy = ay - by * h, dz = az - bz * h;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - q[o + 6];
    }
    if (t === K.P_PILL) {
      const vx = px - q[o], vy = py - q[o + 1], vz = pz - q[o + 2];
      const z = vx * q[o + 3] + vy * q[o + 4] + vz * q[o + 5];
      const rx = vx - z * q[o + 3], ry = vy - z * q[o + 4], rz = vz - z * q[o + 5];
      const s = Math.max(Math.sqrt(rx * rx + ry * ry + rz * rz) - q[o + 6], 0);
      return Math.sqrt(s * s + z * z) - q[o + 7];
    }
    if (t === K.P_TORUS) {
      const vx = px - q[o], vy = py - q[o + 1], vz = pz - q[o + 2];
      const h = vx * q[o + 3] + vy * q[o + 4] + vz * q[o + 5];
      const rho = Math.sqrt(Math.max(vx * vx + vy * vy + vz * vz - h * h, 0));
      return Math.sqrt((rho - q[o + 6]) ** 2 + h * h) - q[o + 7];
    }
    if (t === K.P_SLOT) {
      const mx = 0.5 * (q[o] + q[o + 3]), my = 0.5 * (q[o + 1] + q[o + 4]), mz = 0.5 * (q[o + 2] + q[o + 5]);
      const m = Math.sqrt(mx * mx + my * my + mz * mz), ux = mx / m, uy = my / m, uz = mz / m;
      let ex = q[o + 3] - q[o], ey = q[o + 4] - q[o + 1], ez = q[o + 5] - q[o + 2];
      const L = Math.sqrt(ex * ex + ey * ey + ez * ez); ex /= L; ey /= L; ez /= L;
      const vx = px - q[o], vy = py - q[o + 1], vz = pz - q[o + 2];
      const s = Math.min(Math.max(vx * ex + vy * ey + vz * ez, 0), L), h = Math.min(Math.max(vx * ux + vy * uy + vz * uz, 0), q[o + 7]);
      const dx = vx - s * ex - h * ux, dy = vy - s * ey - h * uy, dz = vz - s * ez - h * uz;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - q[o + 6];
    }
    const r = Math.sqrt(px * px + py * py + pz * pz);       // P_CERPATCH as a plain shell patch
    const c = Math.min(Math.max((px * q[o] + py * q[o + 1] + pz * q[o + 2]) / Math.max(r, 1e-9), -1), 1);
    const s = Math.max(Math.acos(c) - q[o + 4], 0) * r, dr = r - q[o + 5];
    return Math.sqrt(s * s + dr * dr) - q[o + 6];
  }
  primsMin(px: number, py: number, pz: number, cls: number, ref: number, refR: number, cell: number): number {
    const g = this.grid, K = this.K;
    let d = 1e9;
    for (let ii = g.primOff[cell]; ii < g.primOff[cell + 1]; ii++) {
      const i = g.primIdx[ii];
      if (this.PC[i] !== cls) continue;
      const v = this.PT[i] === K.P_CERPATCH && refR >= 0 ? this.sdfCer(px, py, pz, 8 * i, ref, refR) : this.sdfPrim(px, py, pz, this.PT[i], 8 * i);
      d = Math.min(d, v);
    }
    return d;
  }
  static sminC(a: number, b: number, k: number, c: number) { const t = Math.max(k - Math.abs(a - b), 0); return Math.min(a, b) - t * t * c; }

  /** membrane SDFs into out[0..nMem) by the membrane table; returns the matrix SDF (aux). rows: bit mask of the rows to
   *  evaluate (all by default; other rows' membranes keep their previous values) */
  memSdfs(px: number, py: number, pz: number, out: Float64Array = this.out, rows = 0xFFFFFFFF): number {
    const G = this.G, K = this.K, cell = this.cellOf(px, py, pz);
    let aux = 0, i = 0;
    for (let r = 0; r < this.nRow; r++) {
      const q = this.tab + K.TH + K.MROW * r, kind = G[q], a = G[q + 1];
      const on = r >= 32 || ((rows >>> r) & 1) === 1;
      if (!on) { if (kind !== K.K_SMOOTH_UNION) i++; continue; }
      if (kind === K.K_FIELD) {
        let v = this.fval(px, py, pz, a);
        v = G[q + 2] < 0 ? -v : v;
        if (G[q + 3] !== 0 || G[q + 4] !== 0) v = v - (G[q + 3] - G[q + 4]);
        out[i] = v;
      } else if (kind === K.K_WALL) out[i] = Math.min(out[a], this.faceDist(pz));
      else if (kind === K.K_SHELL_PORES) out[i] = this.shellPores(px, py, pz, a, G[q + 3], G[q + 4], G[q + 5], G[q + 6], cell);
      else if (kind === K.K_INNER_CRISTAE) {
        let matrix = out[a] + G[q + 3];
        if (G[K.G_CRISTAE] > 0 && matrix < G[K.S_CR_W]) matrix = Math.max(matrix, -this.cristaLumen(px, py, pz, matrix));
        out[i] = -matrix; aux = matrix;
      } else if (kind === K.K_GOLGI_CIS) out[i] = this.golgi(px, py, pz, a, Math.min(out[G[q + 3]], out[G[q + 4]]));
      else if (kind === K.K_PRIMS) {
        const b = G[q + 2], v = b >= 0 ? this.fval(px, py, pz, b) : 1e9, j = G[q + 3];
        const ref = j >= 0 ? out[j] : 0;
        out[i] = Math.min(v, this.primsMin(px, py, pz, a, ref, j >= 0 ? G[q + 4] : -1, cell));
      } else if (kind === K.K_PRIMS_DIFF) {
        const m = Math.max(this.primsMin(px, py, pz, a, 0, -1, cell), -this.primsMin(px, py, pz, G[q + 2], 0, -1, cell));
        out[i] = G[q + 3] < 0 ? -m : m; aux = m;
      }
      if (kind === K.K_SMOOTH_UNION) {
        const d = this.primsMin(px, py, pz, G[q + 2], 0, -1, cell), k = G[q + 3];
        const x = G[q + 4] < 0 ? -out[a] : out[a];
        if (d < x + k) out[a] = G[q + 4] < 0 ? -GeomEval.sminC(x, d, k, G[q + 5]) : GeomEval.sminC(x, d, k, G[q + 5]);
      } else i++;
    }
    return aux;
  }
  labelFrom(px: number, py: number, pz: number, out: Float64Array = this.out): number {
    const G = this.G, K = this.K;
    let fk = -1, fv = 0;
    const cell = this.cellOf(px, py, pz);
    for (let r = 0; r < this.nLab; r++) {
      const q = this.r0 + K.RROW * r;
      let ok = true;
      for (let c = 0; c < G[q + 1]; c++) {
        const t = G[q + 2 + 4 * c], a = G[q + 3 + 4 * c];
        let x: number;
        if (t === K.T_MEM) x = out[a];
        else if (t === K.T_FIELD) {
          if (a !== fk) { fk = a; fv = this.nFields() > a ? this.fval(px, py, pz, a) : 1e9; }
          x = fv;
        } else if (t === K.T_FACE) x = this.faceDist(pz);
        else if (t === K.T_PORE) {
          const m = this.tab + K.TH + K.MROW * a;
          x = this.inPore(px, py, pz, G[m + 4] + 0.5 * G[m + 3], G[m + 5], cell) >= 0 ? -1 : 1;
        } else if (t === K.T_SPECKLE) x = G[K.G_SPECKLE] > 0 && this.inSpeckle(px, py, pz) >= 0 ? -1 : 1;
        else {
          const o = this.data0 + a, wx = px - G[o + 1], wy = py - G[o + 2], wz = pz - G[o + 3];
          x = wx * wx + wy * wy + wz * wz < G[o + 4] * G[o + 4] ? -1 : 1;
        }
        ok = G[q + 4 + 4 * c] === K.OP_LT ? x < G[q + 5 + 4 * c] : x > G[q + 5 + 4 * c];
        if (!ok) break;
      }
      if (ok) return G[q];
    }
    return -1;
  }
  label(x: number, y: number, z: number): number { this.memSdfs(x, y, z, this.out); return this.labelFrom(x, y, z, this.out); }
  /** depth inside the modelled domain (the exterior-boundary membrane SDF; positive inside) */
  domainDepth(x: number, y: number, z: number): number {
    if (this.domainMem < 0) return 1e9;
    this.memSdfs(x, y, z, this.out, this.domainRows);
    return this.out[this.domainMem];
  }
  /** outward normal of the domain boundary near p */
  domainNormal(x: number, y: number, z: number, e = 2): [number, number, number] {
    const d = (a: number, b: number, c: number) => this.domainDepth(a, b, c);
    const gx = d(x - e, y, z) - d(x + e, y, z), gy = d(x, y - e, z) - d(x, y + e, z), gz = d(x, y, z - e) - d(x, y, z + e);
    const l = Math.hypot(gx, gy, gz);
    return l > 1e-9 ? [gx / l, gy / l, gz / l] : [0, 0, 0];
  }
  /** slots of G that hold offsets into G (exact only as integers: above 2^24 float32 cannot hold them) */
  offsetSlots(): number[] {
    const G = this.G, K = this.K, out = [K.G_CRISTAE, K.G_SPECKLE, K.G_GOLGI_CIS, K.G_TABLES];
    for (let k = 0; k < G[K.G_N]; k++) { const h = K.G_N + 1 + 12 * k; out.push(h + 10, h + 11); }
    if (G[K.G_GOLGI_CIS] > 0) { const h = G[K.G_GOLGI_CIS] + 2; out.push(h + 10, h + 11); }
    return out;
  }
  /** the GPU copy of G: float32 values; offset slots hold the offset's u32 bit pattern (WGSL reads them with bitcast) */
  gpuG(): Float32Array<ArrayBuffer> {
    const f = Float32Array.from(this.G), u = new Uint32Array(f.buffer);
    for (const k of this.offsetSlots()) u[k] = this.G[k] >>> 0;
    return f;
  }
}

/** load geometry.json + G (raw little-endian f32/f64, optionally gzip) */
export async function loadGeometry(fetchJson: (p: string) => Promise<any>, fetchBin: (p: string) => Promise<ArrayBuffer>, path = 'geometry.json') {
  const geo: GeoJson = await fetchJson(path);
  if (!geo.G?.file) throw new Error(`${path} has no G (schema ${geo.schema}); this viewer reads wholecell.viewer_geometry/1`);
  const buf = await fetchBin(geo.G.file);
  const G = geo.G.dtype === 'f64' ? new Float64Array(buf) : Float64Array.from(new Float32Array(buf));
  if (geo.G.n && G.length !== geo.G.n) throw new Error(`${geo.G.file}: ${G.length} values, geometry.json says ${geo.G.n}`);
  for (const [i, v] of geo.G.patches ?? []) G[i] = v;          // values float32 cannot hold (offsets, section parameters)
  return { geo, ev: new GeomEval(geo, G) };
}
