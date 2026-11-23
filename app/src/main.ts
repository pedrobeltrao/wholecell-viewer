// origin: jurkat/viewer/app/src/main.ts (Jurkat viewer v7), made cell-agnostic: the cell comes from the registry
// (registry.ts), every cell-specific name, colour, class, bookmark and document from the cell's exported data.
import { Renderer, FrameState, ID_INST } from './renderer';
import { Camera, CamState } from './camera';
import { TileManager, LoadedTile } from './tiles';
import { GeomEval, GeoJson, loadGeometry } from './geometry';
import { loadLibrary, loadTileIndex, fetchJson, fetchBin, fetchText, Library, TileIndex, idMatches, moduleColor, initData, setAbsent, isAbsent,
  Region, Features, MolClass, buildPalette, BG_HEX, hexRgb, FIXED_PAL } from './data';
import { V3, dot, norm, cross, sub, add, scale, len } from './math';
import { aboutHtml } from './about';
import { markdownToHtml } from './markdown';
import { Dynamics } from './dynamics';
import { resolveCell, renderStart, startLink, Opened, CellEntry } from './registry';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + ' M' : n >= 1e4 ? (n / 1e3).toFixed(0) + ' k' : n.toLocaleString('en-US');
const fmtNm = (n: number) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 2).replace(/\.?0+$/, '') + ' µm' : (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + ' nm';

declare global { interface Window { yc: any; } }

interface Bookmark { name: string; caption: string; target: V3; normal: V3; up: V3; width: number; slab: number; dynamics?: string }

let lib: Library, idx: TileIndex, geo: GeoJson, ev: GeomEval, bookmarks: Bookmark[], typesTiles: { off: Uint32Array; tiles: Uint32Array } | null = null;
let cell: Opened, entry: CellEntry, regions: Region[] = [], feat: Features = { features: {}, classes: [] };
let regionFlags = new Uint32Array(256);            // per region: bit0 visible, bit1 membrane-embedded (palette w)
const memName = (k: number) => { const m = geo?.membranes.find(x => x.code === k); return m ? (m.display_name ?? m.name) : 'membrane'; };
const labelRec = (k: number) => geo?.labels.find(x => x.code === k);
const regionName = (r: number) => { const x = regions[r]; return x ? (x.display_as || x.name) : `region ${r}`; };
const scopeWord = () => 'in the cell';
let R: Renderer, T: TileManager, dyn: Dynamics;
const cam = new Camera();
const canvas = $<HTMLCanvasElement>('gpu');

const fs: FrameState = {
  cutOn: true, plane: [0, 0, 1, 0], slab: 60, colorMode: 0, freeHide: 0, highlight: false,
  selId: 0, shaded: true, organelle: false, motion: 0, l0px: 1.6, l1px: 2.5, minpx: 0.3, outline: 1, showMeshes: true, showLipids: true, renderScale: 1, memColors: false,
};
let planeFollow = false;
// tracer dynamics (offline validation, jurkat/validate/dynamics.py): UI, keys and "Diffusion" bookmarks only when the
// data folder has dynamics.json (the whole-cell public build has none)
let hasDyn = false;
let dirty = true, lastUpdate = 0, lastFrameT = 0, quality = 'auto';
let typeFlags: Uint32Array<ArrayBuffer>;
// molecule classes with their own Show switch and colours: features.json "classes" of the cell
/** library type indices whose id matches one of the patterns */
function typesMatching(patterns: string[]): number[] {
  const out: number[] = [];
  lib.types.forEach((t, i) => { if (idMatches(t.id, patterns)) out.push(i); });
  return out;
}
let selType = -1;
let selection: any = null;
let tour: { i: number; phase: 'fly' | 'wait' | 'hold'; t: number } | null = null;
let sweep: { t0: number; d0: number; d1: number; dur: number } | null = null;
const frameTimes: number[] = [];

/** molecule budget: ?detail=low|medium|high|auto, else the saved choice (Performance panel), else auto */
function detailPref(): string {
  const ok = ['auto', 'low', 'medium', 'high'];
  const q = new URLSearchParams(location.search).get('detail');
  if (q && ok.includes(q)) return q;
  try { const v = localStorage.getItem('yc.detail'); if (v && ok.includes(v)) return v; } catch { /* storage unavailable */ }
  return 'auto';
}
function setLoading(msg: string, f: number) {
  ($('loading').querySelector('.m') as HTMLElement).textContent = msg;
  ($('loading').querySelector('.pb div') as HTMLElement).style.width = `${Math.round(f * 100)}%`;
}
function fail(msg: string) {
  const e = $('loading').querySelector('.err') as HTMLElement;
  e.style.display = 'block'; e.innerHTML = msg;
  ($('loading').querySelector('.t') as HTMLElement).textContent = 'Could not start the viewer';
}
function toast(msg: string, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout((toast as any)._t); (toast as any)._t = setTimeout(() => (t.style.display = 'none'), ms);
}

// ---------------------------------------------------------------- boot
async function boot() {
  let res;
  try { res = await resolveCell(); }
  catch (e: any) { renderStart(null, String(e?.message || e)); return; }
  if (!res.opened) { renderStart(res.registry); return; }
  cell = res.opened; entry = cell.entry;
  const F = cell.files;
  ($('loading').querySelector('.t') as HTMLElement).textContent = `Loading ${entry.name}…`;
  document.title = `${entry.name} · whole-cell model`;
  if (!('gpu' in navigator)) {
    fail(`This browser does not expose <b>WebGPU</b>. Use a current Chrome or Edge (version 113 or later), or Safari 26 or later.
      On Linux Chrome, enable <code>chrome://flags/#enable-unsafe-webgpu</code> and <code>#enable-vulkan</code>.
      Firefox 141+ supports WebGPU on Windows.<br><br>Also check that the page is served over <code>http://localhost</code>
      (for example <code>python tools/serve.py</code>). Opening the file directly with <code>file://</code> does not work.`);
    return;
  }
  try {
    await initData(cell.base, entry.build?.build_id ?? '');
    setLoading('Loading cell data', 0.02);
    try { feat = await fetchJson(F.features); } catch { feat = { features: {}, classes: [] }; }
    feat.classes ??= []; feat.features ??= {};
    setAbsent(feat.absent);
    const rj = await fetchJson(F.regions);
    regions = rj.regions ?? rj;
    if (regions.some(r => r.id > 255)) throw new Error('more than 256 regions: the viewer instance word holds 8 region bits');
    for (const r of regions) regionFlags[r.id] = 1 | (r.kind === 'membrane' ? 2 : 0);
    setLoading('Loading cell geometry', 0.05);
    const G = await loadGeometry(fetchJson, fetchBin, F.geometry);
    geo = G.geo; ev = G.ev;
    try { bookmarks = await fetchJson(F.bookmarks); } catch { bookmarks = []; }
    if (!bookmarks.length) bookmarks = [defaultBookmark()];
    const B = ev.bbox, diam = Math.max(...[0, 1, 2].map(a => B.hi[a] - B.lo[a]));
    cam.maxDist = Math.max(cam.maxDist, 3 * diam);
    idx = await loadTileIndex();
    lib = await loadLibrary(feat, setLoading);
    if (lib.libTag !== null && idx.libTag !== null && lib.libTag !== idx.libTag) throw new Error(`library/types.json (lib_tag ${lib.libTag}) and tiles (lib_tag ${idx.libTag}) come from different builds`);
    const NT = lib.types.length;
    if (!isAbsent(F.types_tiles)) try {
      const tt = await fetchBin(F.types_tiles);
      typesTiles = { off: new Uint32Array(tt, 0, NT + 1), tiles: new Uint32Array(tt, (NT + 1) * 4) };
    } catch { typesTiles = null; }
    setLoading('Starting WebGPU', 0.7);
    R = new Renderer(canvas);
    R.detail = detailPref();
    R.onLost = (m) => { toast(m, 10000); };
    await R.init(lib, ev, idx, buildPalette(regions, geo, regionFlags, feat));
    typeFlags = new Uint32Array(NT);
    for (const c of feat.classes) {
      const ts = typesMatching(c.patterns);
      if (c.own_switch !== false) for (const i of ts) typeFlags[i] |= 4;
      if (c.no_motion) for (const i of ts) typeFlags[i] |= 8;
    }
    R.device.queue.writeBuffer(R.typeFlags, 0, typeFlags);
    setLoading('Compiling shaders and starting tile streaming', 0.9);
    const nW = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    T = new TileManager(idx, R, lib, ev, nW, { lipids: feat.lipids ?? {}, membranes: geo.membranes, beadQ: 0.005 });
    T.onChange = () => { dirty = true; };
    dyn = new Dynamics(R, () => { dirty = true; }, toast);
    dyn.onRegion = (r) => { const i = bookmarks.findIndex(b => b.dynamics === r); if (i >= 0) { stopTour(); applyBookmark(i); } else dyn.show(r); };
    hasDyn = !!(await dyn.load());
    if (!hasDyn) bookmarks = bookmarks.filter(b => !b.dynamics);
    buildUI();
    applyInitialView();
    $('loading').style.display = 'none';
    requestAnimationFrame(loop);
    window.yc = { R, T, cam, fs, lib, idx, ev, geo, regions, feat, entry, applyBookmark, setType, setModule, pickAt, dyn, bookmarks, setQuality, describe, viewLink, ready: true, state: () => ({ pending: T.pendingForView(), detailPending: T.detInflight, loaded: T.loaded.size, totals: T.totals(), stats: R.stats, cam: { t: cam.target, d: cam.dist }, plane: fs.plane, gpuMs, gpuBusy, dirty }), render: () => { dirty = true; } };
  } catch (e: any) {
    console.error(e);
    fail(`${String(e?.message || e)}<br><br>See the browser console for details. <a href="${startLink()}">Back to the cell list</a>`);
  }
}
function defaultBookmark(): Bookmark {
  const B = ev.bbox, c: V3 = [(B.lo[0] + B.hi[0]) / 2, (B.lo[1] + B.hi[1]) / 2, (B.lo[2] + B.hi[2]) / 2];
  return { name: 'Whole cell', caption: `Section through ${entry.name}.`, target: c, normal: [0, 0, 1], up: [0, 1, 0], width: 0.8 * (B.hi[0] - B.lo[0]), slab: 60 };
}
/** &view=<name|index>, or &t=x,y,z&n=nx,ny,nz&w=width[&s=slab][&u=ux,uy,uz]; else the cell's default bookmark */
function applyInitialView() {
  const q = new URLSearchParams(location.search);
  const nums = (k: string) => (q.get(k) ?? '').split(',').map(Number);
  const t = nums('t'), n = nums('n');
  if (t.length === 3 && t.every(isFinite) && n.length === 3 && n.every(isFinite) && q.get('t')) {
    const up = nums('u'), w = Number(q.get('w') ?? 1000), sl = Number(q.get('s') ?? 60);
    const b: Bookmark = { name: 'Link', caption: '', target: t as V3, normal: n as V3, up: (up.length === 3 && up.every(isFinite) ? up : [0, 1, 0]) as V3, width: w > 0 ? w : 1000, slab: sl > 0 ? sl : 60 };
    if (Math.abs(dot(norm(b.normal), norm(b.up))) > 0.99) b.up = Math.abs(b.normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    bookmarks.push(b); applyBookmark(bookmarks.length - 1, false); bookmarks.pop(); return;
  }
  const qv = q.get('view') ?? entry.default_bookmark ?? null;
  let v0 = 0;
  if (qv !== null) {
    if (!isNaN(Number(qv)) && qv.trim() !== '') v0 = Math.min(bookmarks.length - 1, Math.max(0, Number(qv)));
    else { const k = bookmarks.findIndex(b => b.name.toLowerCase().startsWith(qv.toLowerCase())); v0 = Math.max(0, k); }
  }
  applyBookmark(v0, false);
}
/** a link to the current cell and view */
function viewLink(): string {
  const u = new URL(location.href);
  for (const k of ['view', 't', 'n', 'w', 's', 'u']) u.searchParams.delete(k);
  const r3 = (v: number[]) => v.map(x => Number(x.toFixed(3))).join(',');
  const n = fs.cutOn ? planeN() : cam.fwd;
  u.searchParams.set('t', r3(cam.target)); u.searchParams.set('n', r3(n)); u.searchParams.set('u', r3(cam.up));
  const aspect = canvas.clientWidth / canvas.clientHeight;
  u.searchParams.set('w', String(Math.round(2 * cam.dist * Math.tan(cam.fovy / 2) * aspect))); u.searchParams.set('s', String(Math.round(fs.slab)));
  return u.href;
}

// ---------------------------------------------------------------- plane helpers
function planeN(): V3 { return [fs.plane[0], fs.plane[1], fs.plane[2]]; }
function setPlane(n: V3, d: number) { n = norm(n); fs.plane = [n[0], n[1], n[2], d]; syncPlaneUI(); dirty = true; }
function alignToView() { const n = cam.fwd; setPlane(n, dot(n, cam.target)); }
// move the plane (and the camera with it) along its normal; nudgeStep is the user's fine step in nm
let nudgeStep = 0.5;
try { const s = Number(localStorage.getItem('yc.nudgeStep')); if (s > 0) nudgeStep = s; } catch { /* storage unavailable */ }
function movePlane(s: number) { const n = planeN(); cam.target = add(cam.target, scale(n, s)); setPlane(n, fs.plane[3] + s); }

// ---------------------------------------------------------------- bookmarks / tour
function bookmarkState(b: Bookmark): CamState {
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const n = norm(b.normal);
  let up = norm(sub(b.up, scale(n, dot(b.up, n))));
  return { target: [...b.target] as V3, dist: cam.distForWidth(b.width, aspect), fwd: n, up };
}
function applyBookmark(i: number, animate = true, onDone?: () => void) {
  const b = bookmarks[i];
  if (!b) return;
  if ((fs.organelle || fs.memColors) && i !== 0) setDisplayMode('molecules');
  if (b.dynamics) dyn.show(b.dynamics); else dyn.hide();
  const st = bookmarkState(b);
  const n1 = norm(b.normal), d1 = dot(n1, b.target);
  const n0 = planeN(), d0 = fs.plane[3], s0 = fs.slab;
  fs.cutOn = true; ($('cutOn') as HTMLInputElement).checked = true;
  planeFollow = false; $('followView').classList.remove('on');
  if (!animate) { cam.set(st); setPlane(n1, d1); fs.slab = b.slab; syncPlaneUI(); dirty = true; onDone?.(); return; }
  cam.flyTo(st, 2600, () => { setPlane(n1, d1); fs.slab = b.slab; syncPlaneUI(); onDone?.(); }, (e) => {
    let n = norm(add(scale(n0, 1 - e), scale(n1, e)));
    if (len(add(scale(n0, 1 - e), scale(n1, e))) < 1e-3) n = n1;
    fs.plane = [n[0], n[1], n[2], d0 + (d1 - d0) * e];
    fs.slab = Math.exp(Math.log(s0) + (Math.log(b.slab) - Math.log(s0)) * e);
    syncPlaneUI();
  });
  showCaption(b);
  dirty = true;
}
function showCaption(b: Bookmark | null) {
  const c = $('caption');
  if (!b) { c.style.display = 'none'; return; }
  c.innerHTML = `<b>${b.name}</b>${b.caption}`; c.style.display = 'block';
  clearTimeout((showCaption as any)._t);
  if (!tour) (showCaption as any)._t = setTimeout(() => (c.style.display = 'none'), 9000);
}
function startTour() {
  tour = { i: 0, phase: 'fly', t: performance.now() };
  $('tourBtn').textContent = '■ Stop'; $('tourBtn').classList.add('on');
  applyBookmark(0, true, () => { if (tour) { tour.phase = 'wait'; tour.t = performance.now(); } });
}
function stopTour() {
  tour = null; $('tourBtn').textContent = '▶ Tour'; $('tourBtn').classList.remove('on');
  showCaption(null);
}
function tourStep(now: number) {
  if (!tour) return;
  if (tour.phase === 'wait' && (T.pendingForView() === 0 || now - tour.t > 14000)) { tour.phase = 'hold'; tour.t = now; }
  else if (tour.phase === 'hold' && now - tour.t > 6500) {
    tour.i = (tour.i + 1) % bookmarks.length; tour.phase = 'fly';
    const i = tour.i;
    applyBookmark(i, true, () => { if (tour && tour.i === i) { tour.phase = 'wait'; tour.t = performance.now(); } });
  }
}

// ---------------------------------------------------------------- selection / search
let selModule = -1;
/** highlight every type of one interaction module (legend of the module colouring); -1 clears */
function setModule(m: number) {
  if (selType >= 0) { typeFlags[selType] &= ~1; selType = -1; renderSelType(); }
  selModule = m;
  for (let i = 0; i < typeFlags.length; i++) {
    if (m >= 0 && lib.moduleOf[i] === m) typeFlags[i] |= 1; else typeFlags[i] &= ~1;
  }
  fs.highlight = m >= 0;
  R.device.queue.writeBuffer(R.typeFlags, 0, typeFlags);
  renderLegend();
  dirty = true;
}
function setType(t: number) {
  if (selModule >= 0) setModule(-1);
  if (selType >= 0) typeFlags[selType] &= ~1;
  selType = t;
  if (t >= 0) typeFlags[t] |= 1;
  fs.highlight = t >= 0;
  R.device.queue.writeBuffer(R.typeFlags, 0, typeFlags);
  renderSelType();
  dirty = true;
}
function renderSelType() {
  const el = $('selType');
  if (selType < 0) { el.style.display = 'none'; return; }
  const t = lib.types[selType];
  const loaded = T.countLoaded(selType);
  el.style.display = 'block';
  el.innerHTML = `<div><b>${t.gene}</b> ${t.name}</div>
    <div class="sub" style="margin:3px 0 6px">${fmt(t.copies)} copies ${scopeWord()} · ${fmt(loaded)} in loaded tiles · ${srcLabel(t)}</div>
    <div class="grid2"><button class="small" id="flyNearest">Fly to nearest</button><button class="small" id="clearType">Clear highlight</button></div>`;
  $('flyNearest').onclick = () => flyToNearest(selType);
  $('clearType').onclick = () => setType(-1);
}
function searchTypes(q: string) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out: { i: number; s: number }[] = [];
  lib.types.forEach((t, i) => {
    const g = t.gene.toLowerCase(), id = t.id.toLowerCase(), u = (t.uniprot || '').toLowerCase(), nm = (t.name || '').toLowerCase(), gs = (t.genes || '').toLowerCase();
    let s = 0;
    if (g === q || id === q || u === q) s = 100;
    else if (g.startsWith(q) || id.startsWith(q)) s = 60;
    else if (gs.split(/[;,\s]+/).includes(q)) s = 55;
    else if (nm.includes(q)) s = 30 + (nm.startsWith(q) ? 10 : 0);
    else if (gs.includes(q) || u.startsWith(q) || (t.pdb || '').toLowerCase() === q) s = 20;
    if (s) out.push({ i, s: s + Math.log10(t.copies + 1) });
  });
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, 14).map(x => x.i);
}
function flyToNearest(type: number) {
  let cands: number[] = [];
  if (typesTiles) { for (let k = typesTiles.off[type]; k < typesTiles.off[type + 1]; k++) cands.push(typesTiles.tiles[k]); }
  else cands = [...T.loaded.values()].filter(t => T.nearestInTile(t, type, cam.target) >= 0).map(t => t.idx);   // no types_tiles.bin: loaded tiles only
  if (!cands.length) { toast(typesTiles ? 'No copies of this molecule were placed.' : 'No copy in the loaded tiles (this cell has no types_tiles.bin).'); return; }
  let best = -1, bd = 1e18;
  for (const ti of cands) {
    const c = T.tileCenter(ti);
    const d = len(sub(c, cam.target));
    if (d < bd) { bd = d; best = ti; }
  }
  const c = T.tileCenter(best);
  const t = lib.types[type];
  const width = Math.max(90, t.br * 9);
  const goTo = (tile: LoadedTile) => {
    const k = T.nearestInTile(tile, type, c);
    if (k < 0) return;
    const d = T.decode(tile, k);
    const n = planeN();
    const st = cam.state(); st.target = d.p; st.dist = cam.distForWidth(width, canvas.clientWidth / canvas.clientHeight);
    cam.flyTo(st, 900, () => { setPlane(n, dot(n, d.p) - t.br * 0.4); });
    fs.plane[3] = dot(n, d.p) - t.br * 0.4;
    const pid = T.poolIndex(tile, k);
    select({ kind: 'inst', id: (ID_INST | pid) >>> 0, info: T.instanceAt(pid) });
  };
  const loaded = T.loaded.get(best);
  const n = planeN();
  const st = cam.state(); st.target = c; st.dist = cam.distForWidth(width * 2.5, canvas.clientWidth / canvas.clientHeight);
  fs.cutOn = true; ($('cutOn') as HTMLInputElement).checked = true;
  if (fs.organelle || fs.memColors) setDisplayMode('molecules');
  cam.flyTo(st, 2200, () => {
    setPlane(n, dot(n, c) - 20);
    const L = T.loaded.get(best);
    if (L) goTo(L);
    else {
      const h = (tile: LoadedTile) => { if (tile.idx === best) { T.onTileLoaded.splice(T.onTileLoaded.indexOf(h), 1); goTo(tile); } };
      T.onTileLoaded.push(h);
    }
  });
  setPlane(n, dot(n, c) - 20);
  if (loaded) { /* handled on arrival of flight */ }
}

// ---------------------------------------------------------------- picking & inspection
async function pickAt(cx: number, cy: number) {
  const dpr = R.width / canvas.clientWidth;
  return R.pick(cx * dpr, cy * dpr);
}
function srcLabel(t: Library['types'][number]) {
  if (t.src === 'PDB') return 'PDB ' + t.pdb;
  if (t.src === 'AF-multimer') return 'AlphaFold complex';
  if (t.src === 'AF') return t.genes && t.genes.includes(';') ? 'AlphaFold complex' : 'AlphaFold';
  return 'assembly unit';      // pre-placed building blocks (filament subunits, chromatin units) without one source entry
}
/** whether an atomic model can be fetched for the type (PDB entry, or an AlphaFold DB entry by model or UniProt id) */
function hasAtomicModel(t: Library['types'][number]) {
  return (t.src === 'PDB' && !!t.pdb) || !!t.model || (t.src === 'AF' && !!t.uniprot && !(t.genes || '').includes(';'));
}
function describe(id: number): any {
  const cat = id >>> 30;
  if (id === 0) return { kind: 'none', title: 'Outside the cell' };
  if (cat === 1) {
    const info = T.instanceAt(id & 0x3FFFFFFF);
    if (!info) return { kind: 'none', title: '' };
    return { kind: 'inst', id, info, title: lib.types[info.type].gene, sub: regionName(info.region) };
  }
  if (cat === 2) {
    const mem = (id >>> 1) & 15, leaf = id & 1;
    const name = memName(mem);
    const side = leaf ? 'cytoplasmic leaflet' : (mem === R.outerMem ? 'exoplasmic (outer) leaflet' : 'lumenal leaflet');
    return { kind: 'lipid', id, mem, leaf, title: 'Lipid bilayer', sub: `${name} · ${side}` };
  }
  if (cat === 3) {
    const kind = (id >>> 15) & 7, chain = id & 0x7FFF;
    if (kind === 6) return { kind: 'free', id, fk: kind, chain, ...dyn.describe(chain) };     // tracer dynamics overlay
    if (kind === 7) return { kind: 'free', id, fk: kind, chain, title: 'Overview stand-in',     // whole-cell overview (tiles.ts Overview)
      sub: `${regionName(chain & 31)} · one sampled molecule standing for its neighbourhood; zoom in or wait for the molecules to load` };
    const nm = ['mRNA', 'Linker DNA', 'β-1,3-glucan fibril', 'Mannan chain', 'pre-rRNA', 'FG repeats'][kind] ?? 'polymer';
    const sub = ['nucleotide-resolution thread (schematic path)', 'between consecutive nucleosomes, 2 bp per bead', 'procedural, 36 glucose per bead',
      'procedural α-mannan on a cell-wall mannoprotein', 'nascent ribosomal RNA', 'disordered domain of an FG nucleoporin (NSP1, NUP49, NUP57, NUP159), one bead per residue'][kind] ?? '';
    return { kind: 'free', id, fk: kind, chain, title: nm, sub };
  }
  if (id >= 0x200 && id < 0x210) return { kind: 'band', id, title: 'Membrane (cut face)', sub: memName(id - 0x200) };
  if (id >= 0x100 && id < 0x140) {
    const L = labelRec(id - 0x100);
    if (L && L.code === ev.outsideCode) return { kind: 'label', id, title: L.display_name ?? 'Edge of the imaged volume', sub: L.description ?? 'the imaged volume ends here and truncates the cell; this flat face is not a cell surface and has no membrane' };
    return { kind: 'label', id, title: L ? (L.display_name ?? L.name) : 'compartment', sub: 'compartment (not loaded at this distance, or beyond the slab)' };
  }
  return { kind: 'none', title: '' };
}
function select(d: any) {
  selection = d;
  fs.selId = d && d.kind === 'inst' ? d.id >>> 0 : 0;
  renderInspect();
  dirty = true;
}
function renderInspect() {
  const el = $('inspect');
  const d = selection;
  if (!d || d.kind === 'none') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  let h = `<button class="close" id="inspClose">×</button>`;
  if (d.kind === 'inst') {
    const t = lib.types[d.info.type];
    const isPDB = t.src === 'PDB';
    const nb = t.nb, nnt = t.nnt;
    h += `<h2>${t.gene}</h2><div>${t.name}</div><div style="margin-top:6px"><span class="badge ${isPDB ? 'pdb' : 'af'}">${srcLabel(t)}</span>
      ${t.oligomer > 1 ? `<span class="badge" style="background:#666">${t.oligomer}-mer</span>` : ''}</div>
      <div class="kv">
      ${t.genes && t.genes !== t.gene ? `<div>Subunits</div><div style="word-break:break-word">${t.genes.split(/;\s*/).slice(0, 40).join(', ')}${t.genes.split(';').length > 40 ? ' …' : ''}</div>` : ''}
      ${t.uniprot ? `<div>UniProt</div><div>${t.uniprot}</div>` : ''}
      <div>Location</div><div>${regionName(d.info.region)}</div>
      <div>Copies here</div><div>${t.copies.toLocaleString('en-US')} ${scopeWord()}</div>
      <div>Mass</div><div>${(t.mass / 1000).toFixed(1)} kDa</div>
      <div>Residues drawn</div><div>${(nb - nnt).toLocaleString('en-US')} aa${nnt ? ` + ${nnt.toLocaleString('en-US')} nt` : ''}</div>
      <div>Radius</div><div>${t.br.toFixed(1)} nm (Rg ${t.rg.toFixed(1)} nm)</div>
      ${!isPDB && t.plddt_mean != null ? `<div>Mean pLDDT</div><div>${t.plddt_mean.toFixed(1)} (${Math.round((t.plddt_frac_kept ?? 1) * 100)}% of residues kept, pLDDT ≥ 50)</div>` : ''}
      <div>Position</div><div>${d.info.p.map((x: number) => x.toFixed(1)).join(', ')} nm</div>
      </div>
      <div class="grid2"><button class="small" id="loadAtoms"${hasAtomicModel(t) ? '' : ' disabled title="No single PDB or AlphaFold DB entry for this building block"'}>Load atomic model</button><button class="small" id="hlType">Highlight all</button>
      <button class="small" id="centerOn">Center view</button><button class="small" id="hideType">${typeFlags[d.info.type] & 2 ? 'Show' : 'Hide'} this type</button></div>
      <div style="margin-top:9px">${t.uniprot ? `<a href="https://www.uniprot.org/uniprotkb/${t.uniprot}" target="_blank">UniProt</a>` : ''}
      ${isPDB ? `<a href="https://www.rcsb.org/structure/${t.pdb}" target="_blank">RCSB ${t.pdb}</a>` : ''}
      ${hasAtomicModel(t) && !isPDB ? `<a href="https://alphafold.ebi.ac.uk/entry/${t.model || t.uniprot}" target="_blank">AlphaFold DB</a>` : ''}
      ${!t.uniprot && t.genes && !t.genes.includes(';') && /^[A-Z0-9-]+$/.test(t.gene) && !classOf(t.id) && entry.organism?.taxon ? `<a href="https://www.uniprot.org/uniprotkb?query=gene_exact:${encodeURIComponent(t.gene)}+AND+organism_id:${entry.organism.taxon}" target="_blank">UniProt search</a>` : ''}</div>`;
  } else {
    h += `<h2>${d.title}</h2><div class="sub" style="font-size:12.5px">${d.sub || ''}</div>`;
    if (d.kind === 'lipid') {
      const L = feat.lipids ?? {}, m = geo.membranes.find(x => x.code === d.mem), tab = (m && L[m.name]) || L.default || {};
      const comp = Object.entries(tab).filter(([, v]) => typeof v === 'number' && (v as number) > 0).map(([k, v]) => `${k} ${v}%`).join(', ');
      h += `<p class="sub">Lipids are generated in your browser on the mesh of this membrane (${comp || 'composition not given'}${L.source ? `; ${L.source}` : ''}). They sit at 0.65 nm² per lipid and are removed where they would overlap protein.</p>`;
    }
  }
  el.innerHTML = h;
  $('inspClose').onclick = () => select(null);
  if (d.kind === 'inst') {
    $('loadAtoms').onclick = () => openMolstar(d.info.type);
    $('hlType').onclick = () => setType(d.info.type);
    $('centerOn').onclick = () => { const st = cam.state(); st.target = d.info.p; cam.flyTo(st, 700); };
    $('hideType').onclick = () => { typeFlags[d.info.type] ^= 2; R.device.queue.writeBuffer(R.typeFlags, 0, typeFlags); renderInspect(); dirty = true; };
  }
}

// ---------------------------------------------------------------- Mol*
let molViewer: any = null, molLoading: Promise<void> | null = null;
function loadMolstarLib() {
  if (molLoading) return molLoading;
  const CDN = 'https://cdn.jsdelivr.net/npm/molstar@4.18.0/build/viewer/';
  const load = (base: string) => new Promise<void>((res, rej) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = base + 'molstar.css'; document.head.appendChild(l);
    const s = document.createElement('script'); s.src = base + 'molstar.js'; s.onload = () => res(); s.onerror = () => { l.remove(); s.remove(); rej(new Error('Mol* failed to load')); };
    document.head.appendChild(s);
  });
  // local copy first (offline use); CDN fallback for the single-file preview
  molLoading = (window.__YC_EMBED__ ? load(CDN) : load('molstar/').catch(() => load(CDN))).catch((e) => { molLoading = null; throw e; });
  return molLoading;
}
async function openMolstar(type: number) {
  const t = lib.types[type];
  $('molModal').style.display = 'flex';
  $('molTitle').textContent = `${t.gene} · ${t.name} · loading…`;
  try {
    await loadMolstarLib();
    const molstar = (window as any).molstar;
    if (!molViewer) {
      molViewer = await molstar.Viewer.create('molHost', {
        layoutIsExpanded: false, layoutShowControls: false, layoutShowRemoteState: false, layoutShowSequence: true,
        layoutShowLog: false, layoutShowLeftPanel: false, viewportShowExpand: false, viewportShowSelectionMode: false, viewportShowAnimation: false,
        collapseLeftPanel: true, pdbProvider: 'rcsb', emdbProvider: 'rcsb',
      });
    } else await molViewer.plugin.clear();
    let url = '', link = '';
    if (t.src === 'PDB' && t.pdb) {
      url = `https://files.rcsb.org/download/${t.pdb}-assembly1.cif`; link = `https://www.rcsb.org/structure/${t.pdb}`;
      try { const h = await fetch(url, { method: 'HEAD' }); if (!h.ok) url = `https://files.rcsb.org/download/${t.pdb}.cif`; } catch { url = `https://files.rcsb.org/download/${t.pdb}.cif`; }
    } else {
      const entry = t.model || t.uniprot;   // predicted complexes are AFDB entries of their own
      link = `https://alphafold.ebi.ac.uk/entry/${entry}`;
      try {
        const r = await fetch(`https://alphafold.ebi.ac.uk/api/prediction/${entry}`);
        const j = await r.json(); url = (Array.isArray(j) ? j[0] : j)?.cifUrl;
      } catch { /* fall through */ }
      if (!url) url = t.model ? `https://alphafold.ebi.ac.uk/files/${t.model}-model_v1.cif` : `https://alphafold.ebi.ac.uk/files/AF-${t.uniprot}-F1-model_v6.cif`;
    }
    await molViewer.loadStructureFromUrl(url, 'mmcif', false);
    $('molTitle').textContent = `${t.gene} · ${t.name} · ${t.src === 'PDB' ? 'PDB ' + t.pdb + ' (biological assembly)' : t.model ? `AlphaFold DB predicted ${t.oligomer}-mer (full length, incl. low-pLDDT regions)` : 'AlphaFold DB model (full length, incl. low-pLDDT regions)'}`;
    const a = $<HTMLAnchorElement>('molLink'); a.href = link; a.textContent = 'Open source page';
  } catch (e: any) {
    $('molTitle').textContent = `Could not load the atomic model: ${e?.message || e}. Internet access to RCSB/AlphaFold DB is needed.`;
  }
}

// ---------------------------------------------------------------- display modes
let orgMeshesRequested = false;
function loadOrganelleMeshes() {
  if (orgMeshesRequested) return;
  orgMeshesRequested = true;
  toast('Loading whole-cell organelle surfaces…');
  fetchBin(cell.files.meshes).then(b => { R.uploadOrganelleMeshes(b); dirty = true; }).catch(e => toast(`No organelle surfaces: ${e?.message || e}`));
}
// membranes view = the Show list with only Membranes ticked (fs.memColors); set up with the Show list
let setMembraneView: (on: boolean) => void = () => {};
function syncModeButtons() {
  const mem = fs.memColors && !fs.organelle;
  $('modeSection').classList.toggle('on', !fs.organelle && !mem); $('modeOrg').classList.toggle('on', fs.organelle);
  $('modeMem').classList.toggle('on', mem);
}
function setOrganelle(on: boolean) {
  fs.organelle = on;
  if (on) loadOrganelleMeshes();
  syncModeButtons();
  dirty = true;
}
function setDisplayMode(m: 'molecules' | 'organelles' | 'membranes') {
  if (m !== 'membranes' && fs.memColors) setMembraneView(false);
  setOrganelle(m === 'organelles');
  if (m === 'membranes') setMembraneView(true);
}
function setQuality(q: string) {
  quality = q;
  const P: Record<string, [number, number]> = { low: [2.6, 0.75], med: [1.6, 1], high: [1.0, 1], ultra: [0.6, 1], auto: [1.6, 1] };
  const [l0, sc] = P[q];
  fs.l0px = l0; fs.renderScale = sc; R.resize(sc); dirty = true;
}
function renderLegend() {
  const el = $('legend');
  const sw = (c: string, l: string) => `<div><span class="sw" style="background:${c}"></span>${l}</div>`;
  const m = fs.colorMode;
  if (m === 0) {
    const items = feat.legend?.length ? feat.legend.map(x => sw(x.colour, x.label))
      : [...feat.classes.map(c => sw(c.colour, c.name)), ...regionGroups().map(g => sw(g.colour, g.label))];
    if (hasLipids()) items.push(sw(FIXED_PAL[40], 'lipid head'), sw(FIXED_PAL[41], 'lipid tail'));
    if (feat.features?.open_face) items.push(sw(FIXED_PAL[61], 'flat face: edge of the imaged volume'));
    el.innerHTML = items.join('');
  }
  else if (m === 1) el.innerHTML = sw('#4C8CD9', 'experimental (PDB)') + sw('#F5A84C', 'AlphaFold model');
  else if (m === 2) el.innerHTML = sw('#0053D6', 'pLDDT > 90') + sw('#65CBF3', '70–90') + sw('#FFDB13', '50–70') + sw('#B8B8B8', 'experimental (PDB)');
  else if (m === 3) el.innerHTML = `<div style="grid-column: 1 / 3"><div style="height:8px;border-radius:3px;background:linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725)"></div><div style="display:flex;justify-content:space-between"><span>1</span><span>10³</span><span>10⁶ copies</span></div></div>`;
  else if (m === 6) {
    el.innerHTML = lib.modules.length
      ? '<div class="sub" style="grid-column: 1 / 3">Click a module to highlight it</div>' +
        lib.modules.map((x, i) => `<div class="modsw${selModule === i ? ' on' : ''}" data-m="${i}" title="${x.n} proteins"><span class="sw" style="background:${moduleColor(i)}"></span>${x.label}</div>`).join('') +
        sw('#D1D1CC', 'no module')
      : '<div style="grid-column: 1 / 3">No interaction modules in this build</div>';
    el.querySelectorAll<HTMLElement>('.modsw').forEach(d => d.onclick = () => { const i = Number(d.dataset.m); setModule(selModule === i ? -1 : i); });
  }
  else if (m === 5) el.innerHTML = regions.filter(r => hasRegion(r.id)).map(r => sw(r.colour, regionName(r.id))).join('');
  else el.innerHTML = '';
}
const GROUP_LABEL: Record<string, string> = { soluble: 'Soluble proteins', membrane: 'Membrane proteins', shell: 'Anchored, cortex, lamina', prepass: 'Pre-placed assemblies' };
/** region groups of regions.json ("group"), with the colour of their first region */
function regionGroups(): { key: string; label: string; colour: string; ids: number[] }[] {
  const out = new Map<string, { key: string; label: string; colour: string; ids: number[] }>();
  for (const r of regions) {
    if (!hasRegion(r.id)) continue;
    const k = r.group || r.kind || 'other';
    if (!out.has(k)) out.set(k, { key: k, label: GROUP_LABEL[k] ?? (k[0].toUpperCase() + k.slice(1)), colour: r.colour, ids: [] });
    out.get(k)!.ids.push(r.id);
  }
  return [...out.values()];
}
const hasLipids = () => !!feat.lipid_meshes || (idx && idx.nTri.some(x => x > 0));
const classOf = (id: string): MolClass | undefined => feat.classes.find(c => idMatches(id, c.patterns));

// ---------------------------------------------------------------- UI construction
/** box holding the model: the cell's bounding box (geometry.json domain.bbox_nm) */
function modelBox(): { lo: V3; hi: V3 } { return { lo: [...ev.bbox.lo] as V3, hi: [...ev.bbox.hi] as V3 }; }
/** range of the plane offset d = n . p over the model box (+ 100 nm) for normal n: the Position slider and the sweep */
function planeRange(n: V3): [number, number] {
  const B = modelBox(); let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 8; k++) {
    const p: V3 = [k & 1 ? B.hi[0] : B.lo[0], k & 2 ? B.hi[1] : B.lo[1], k & 4 ? B.hi[2] : B.lo[2]];
    const v = dot(n, p); lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return [Math.floor(lo - 100), Math.ceil(hi + 100)];
}
function syncPlaneUI() {
  const d = fs.plane[3];
  const [rlo, rhi] = planeRange(planeN()), pd = $('planeD') as HTMLInputElement;
  pd.min = String(rlo); pd.max = String(rhi);           // the slider follows the plane normal (axis buttons, Align to view)
  pd.value = String(Math.round(d));
  $('planeDv').textContent = `${Number(d.toFixed(nudgeStep < 0.5 ? 2 : 1))} nm`;
  const s = fs.slab;
  ($('slab') as HTMLInputElement).value = String(Math.round(Math.log(s / 5) / Math.log(4400 / 5) * 1000));
  $('slabv').textContent = fmtNm(s);
  ['axX', 'axY', 'axZ'].forEach((id, k) => $(id).classList.toggle('on', Math.abs(fs.plane[k]) > 0.999));
  mmDirty = true;
}
function buildUI() {
  const NT = lib.types.length;
  let total = 0; for (const t of lib.types) total += t.copies;
  let nInst = 0; for (let i = 0; i < idx.n; i++) nInst += idx.nInst[i];
  if (!total) total = nInst;
  $('cellTitle').textContent = entry.name;
  $('cellSub').innerHTML = `<i>${entry.organism?.name ?? ''}</i> · ${entry.cell_type ?? ''} · ${entry.state ?? ''}`;
  $('subCount').textContent = `${(nInst / 1e6).toFixed(nInst > 1e8 ? 0 : 1)} M macromolecules of ${NT.toLocaleString('en-US')} species in the whole cell (${idx.n.toLocaleString('en-US')} tiles, streamed around the view), each a PDB or AlphaFold structure`;
  $('switchCell').onclick = () => { location.href = startLink(); };
  $('copyLink').onclick = () => {
    const l = viewLink();
    history.replaceState(null, '', l);
    navigator.clipboard?.writeText(l).then(() => toast('Link to this view copied'), () => toast('Link in the address bar'));
  };
  // options the cell's data do not support: hidden
  const cm = $<HTMLSelectElement>('colorMode');
  const hideOpt = (v: string) => { const o = cm.querySelector(`option[value="${v}"]`) as HTMLOptionElement | null; if (o) o.remove(); };
  if (lib.types.every(t => t.plddt_mean == null)) hideOpt('2');      // no pLDDT in this build
  if (!lib.modules.length) hideOpt('6');                              // no organisation.json
  if (isAbsent(cell.files.meshes)) {
    ($('modeOrg') as HTMLButtonElement).disabled = true; $('modeOrg').title = 'This cell has no organelle surfaces';
    ($('modeMem') as HTMLButtonElement).disabled = true; $('modeMem').title = 'This cell has no organelle surfaces';
  }
  if (!hasLipids()) { const d = $('detailOn').parentElement as HTMLElement; d.style.display = 'none'; }
  // views
  const v = $('views');
  bookmarks.forEach((b, i) => {
    const btn = document.createElement('button'); btn.textContent = `${(i + 1) % 10 === 0 && i < 10 ? 0 : i < 9 ? i + 1 : ''}${i < 10 ? ' · ' : ''}${b.name}`;
    btn.title = b.caption; btn.onclick = () => { stopTour(); applyBookmark(i); };
    v.appendChild(btn);
  });
  $('tourBtn').onclick = () => (tour ? stopTour() : startTour());
  document.querySelectorAll('.dynHelp').forEach(e => ((e as HTMLElement).style.display = hasDyn ? '' : 'none'));
  if (hasDyn) {      // tracer dynamics example in this build (dynamics.json present; trajectories are fetched on first use)
    const db = document.createElement('button'); db.className = 'small'; db.textContent = 'Dynamics'; db.title = 'Show / hide the tracer diffusion example (G)';
    db.onclick = () => toggleDynamics(); $('tourBtn').parentElement!.prepend(db, ' ');
  }
  // search
  const inp = $<HTMLInputElement>('search'), res = $('results');
  let act = 0, cur: number[] = [];
  const draw = () => {
    res.innerHTML = cur.map((i, k) => { const t = lib.types[i]; return `<div data-i="${i}" class="${k === act ? 'act' : ''}"><span class="nm"><b>${t.gene}</b> ${t.name}</span><span class="n">${fmt(t.copies)}</span></div>`; }).join('');
    res.querySelectorAll('div').forEach(d => d.addEventListener('click', () => { setType(Number((d as HTMLElement).dataset.i)); cur = []; draw(); inp.value = ''; }));
  };
  inp.addEventListener('input', () => { cur = searchTypes(inp.value); act = 0; draw(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { act = Math.min(cur.length - 1, act + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { act = Math.max(0, act - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && cur.length) { setType(cur[act]); flyToNearest(cur[act]); cur = []; draw(); inp.value = ''; inp.blur(); }
    else if (e.key === 'Escape') { cur = []; draw(); inp.blur(); }
    e.stopPropagation();
  });
  // cut
  $<HTMLInputElement>('cutOn').onchange = (e) => { fs.cutOn = (e.target as HTMLInputElement).checked; dirty = true; };
  const ax = (k: number) => () => { const n: V3 = [0, 0, 0]; n[k] = dot(cam.fwd, [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]) >= 0 ? 1 : -1; fs.cutOn = true; ($('cutOn') as HTMLInputElement).checked = true; setPlane(n, dot(n, cam.target)); };
  $('axX').onclick = ax(0); $('axY').onclick = ax(1); $('axZ').onclick = ax(2);
  $('alignView').onclick = () => { fs.cutOn = true; ($('cutOn') as HTMLInputElement).checked = true; alignToView(); };
  $('followView').onclick = () => { planeFollow = !planeFollow; $('followView').classList.toggle('on', planeFollow); if (planeFollow) alignToView(); };
  $<HTMLInputElement>('planeD').oninput = (e) => { const d = Number((e.target as HTMLInputElement).value); const n = planeN(); const dd = d - fs.plane[3]; cam.target = add(cam.target, scale(n, dd)); setPlane(n, d); };
  const stepSel = $<HTMLSelectElement>('nudgeStep');
  if ([...stepSel.options].some(o => Number(o.value) === nudgeStep)) stepSel.value = String(nudgeStep);
  stepSel.onchange = () => {
    nudgeStep = Number(stepSel.value); syncPlaneUI(); stepSel.blur();
    try { localStorage.setItem('yc.nudgeStep', String(nudgeStep)); } catch { /* storage unavailable */ }
  };
  // -/+ buttons: one step per click, repeating while held
  for (const [id, sgn] of [['nudgeBack', -1], ['nudgeFwd', 1]] as const) {
    const b = $(id); let t0 = 0, t1 = 0;
    const stop = () => { clearTimeout(t0); clearInterval(t1); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); stop(); sweep = null; $('sweepBtn').classList.remove('on');
      movePlane(sgn * nudgeStep);
      t0 = window.setTimeout(() => { t1 = window.setInterval(() => movePlane(sgn * nudgeStep), 60); }, 400);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
  }
  $<HTMLInputElement>('slab').oninput =(e) => { const x = Number((e.target as HTMLInputElement).value) / 1000; fs.slab = 5 * Math.pow(4400 / 5, x); syncPlaneUI(); dirty = true; };
  $('sweepBtn').onclick = () => {
    if (sweep) { sweep = null; $('sweepBtn').classList.remove('on'); return; }
    const n = planeN(); fs.cutOn = true; ($('cutOn') as HTMLInputElement).checked = true;
    const [d0, d1] = planeRange(n);
    sweep = { t0: performance.now(), d0, d1, dur: Math.max(30000, (d1 - d0) / 4400 * 30000 / 2) };
    cam.target = add(cam.target, scale(n, d0 - fs.plane[3]));
    $('sweepBtn').classList.add('on');
  };
  $('flipBtn').onclick = () => { const n = planeN(); const st = cam.state(); const tgt = cam.target; const nn = scale(n, -1) as V3; setPlane(nn, -fs.plane[3]);
    st.fwd = scale(st.fwd, -1) as V3; st.target = tgt; cam.flyTo(st, 1200); };
  // display
  $('modeSection').onclick = () => setDisplayMode('molecules');
  $('modeOrg').onclick = () => setDisplayMode('organelles');
  $('modeMem').onclick = () => setDisplayMode('membranes');
  $<HTMLSelectElement>('colorMode').onchange = (e) => {
    fs.colorMode = Number((e.target as HTMLSelectElement).value);
    if (fs.colorMode !== 6 && selModule >= 0) setModule(-1);
    renderLegend(); dirty = true;
  };
  $<HTMLInputElement>('shaded').onchange = (e) => { fs.shaded = (e.target as HTMLInputElement).checked; dirty = true; };
  $<HTMLSelectElement>('motion').onchange = (e) => { fs.motion = Number((e.target as HTMLSelectElement).value); (e.target as HTMLElement).blur(); dirty = true; };
  $<HTMLInputElement>('outlines').onchange = (e) => { fs.outline = (e.target as HTMLInputElement).checked ? 1 : 0; dirty = true; };
  renderLegend();
  // show list: named classes have their own switch (and ignore the compartment filter); "only" hides everything else
  const show = $('showList');
  const sumIdx = (a: Uint32Array) => a.reduce((x, y) => x + y, 0);
  const tileMeshes = sumIdx(idx.nTri) > 0;
  const classes: [string, string, (on: boolean) => void][] = ([
    ...feat.classes.filter(c => c.own_switch !== false && typesMatching(c.patterns).length > 0).map(c => [c.name, c.colour, (on: boolean) => setTypeHidden(c.patterns, !on)]),
    sumIdx(idx.nPoly) > 0 && ['Polymers (RNA, DNA)', '#B0437A', (on: boolean) => { setFree(0, on); setFree(1, on); }],
    tileMeshes && ['Lipids', '#F3C643', (on: boolean) => { fs.showLipids = on; dirty = true; }],
    ['Membranes', '#F8E3A0', (on: boolean) => { fs.showMeshes = on; dirty = true; }],
    ...regionGroups().map(g => [g.label, g.colour, (on: boolean) => setRegions(g.ids, on)]),
  ] as any[]).filter(Boolean);
  const boxes: HTMLInputElement[] = [];
  const allRegions = regions.map(r => r.id);
  const mem = classes.findIndex(([name]) => name === 'Membranes');
  const syncMemColors = () => {
    fs.memColors = boxes.every((b, k) => b.checked === (k === mem)) && !isAbsent(cell.files.meshes);
    if (fs.memColors) loadOrganelleMeshes();
    syncModeButtons();
    dirty = true;
  };
  const setAll = (on: (k: number) => boolean) => {
    classes.forEach(([, , f], k) => { boxes[k].checked = on(k); f(on(k)); });
    const regionsOn = classes.every((_, k) => on(k));
    setRegions(allRegions, regionsOn);
    syncMemColors();
  };
  classes.forEach(([name, col, f], k) => {
    const l = document.createElement('label'); l.className = 'chk';
    l.innerHTML = `<input type="checkbox" checked><span class="sw" style="background:${col}"></span><span class="nm">${name}</span><a class="only" title="Show only ${name.toLowerCase()}">only</a>`;
    const box = l.querySelector('input') as HTMLInputElement; boxes.push(box);
    box.onchange = () => { f(box.checked); syncMemColors(); };
    (l.querySelector('.only') as HTMLElement).onclick = (e) => { e.preventDefault(); e.stopPropagation(); setAll(j => j === k); };
    show.appendChild(l);
  });
  setMembraneView = (on) => setAll(on ? (j => j === mem) : (() => true));
  $('showAll').onclick = () => setAll(() => true);
  $('hideAll').onclick = () => setAll(() => false);
  const rl = $('regionList');
  regions.forEach(r => {
    if (!hasRegion(r.id)) return;                                // regions without placed copies
    const l = document.createElement('label'); l.className = 'chk';
    l.innerHTML = `<input type="checkbox" checked data-r="${r.id}"><span class="sw" style="background:${r.colour}"></span>${regionName(r.id)}`;
    (l.querySelector('input') as HTMLInputElement).onchange = (e) => setRegions([r.id], (e.target as HTMLInputElement).checked);
    rl.appendChild(l);
  });
  $<HTMLSelectElement>('quality').onchange = (e) => setQuality((e.target as HTMLSelectElement).value);
  const dsel = $<HTMLSelectElement>('detailBudget');
  dsel.value = R.detail; dsel.title = `Molecules kept on the GPU at once (now ${R.detailUsed}). Changing it reloads the page.`;
  dsel.onchange = () => {
    try { localStorage.setItem('yc.detail', dsel.value); } catch { /* storage unavailable */ }
    const u = new URL(location.href); u.searchParams.delete('detail'); location.href = u.href;
  };
  $<HTMLInputElement>('detailOn').onchange = (e) => {
    T.detailEnabled = (e.target as HTMLInputElement).checked;
    if (!T.detailEnabled) for (const t of T.loaded.values()) if (t.det) T.dropDetail(t);
    dirty = true;
  };
  $('shotBtn').onclick = screenshot;
  $('helpBtn').onclick = () => ($('helpModal').style.display = 'flex');
  $('aboutBtn').onclick = () => ($('aboutModal').style.display = 'flex');
  $('aboutBody').innerHTML = aboutHtml(entry, feat, regions, { nTypes: NT, nInst, hasLipids: hasLipids(), resample: geo.resample_check });
  {
    const B = modelBox(), L = Math.max(B.hi[0] - B.lo[0], B.hi[1] - B.lo[1], B.hi[2] - B.lo[2]) / 1000;
    $('zoomHelp').textContent = `Zoom (from the whole cell, about ${L.toFixed(L < 10 ? 1 : 0)} µm across, down to single residues; molecules stream in around the view centre)`;
  }
  const showDoc = async (file: string | undefined, title: string) => {
    $('modelModal').style.display = 'flex';
    if (!file || isAbsent(file)) { $('modelBody').innerHTML = `<h1>${title}</h1><p>This cell's data include no ${title.toLowerCase()}.</p>`; return; }
    $('modelBody').innerHTML = '<p>Loading…</p>';
    try {
      let md = await fetchText(file);
      if (!hasDyn) md = md.replace(/\n## Dynamics example[\s\S]*?(?=\n## |$)/, '\n');   // the offline tracer example: only for builds that ship it
      $('modelBody').innerHTML = markdownToHtml(md);
    } catch (e: any) { $('modelBody').innerHTML = `<p>Could not load ${file}: ${e?.message || e}</p>`; }
  };
  $('modelBtn').onclick = () => showDoc(cell.files.model_doc, 'Model details');
  $('aboutModal').addEventListener('click', (e) => {   // links inside the About text
    const id = (e.target as HTMLElement).id;
    if (id === 'aboutToModel') { e.preventDefault(); $('aboutModal').style.display = 'none'; $('modelBtn').click(); }
    if (id === 'aboutAttribution') { e.preventDefault(); $('aboutModal').style.display = 'none'; showDoc(entry.licence?.attribution ?? cell.files.attribution, 'Attribution'); }
    if (id === 'aboutSwitch') { e.preventDefault(); location.href = startLink(); }
  });
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => {
    if (e.target === m || (e.target as HTMLElement).classList.contains('close')) (m as HTMLElement).style.display = 'none';
  }));
  $('molClose').onclick = () => ($('molModal').style.display = 'none');
  $('panelToggle').onclick = () => { $('panel').classList.toggle('collapsed'); $('panelToggle').textContent = $('panel').classList.contains('collapsed') ? '›' : '‹'; };
  syncPlaneUI();
  setupInput();
  setupMinimap();
}
function toggleDynamics() {
  if (dyn.visible) { dyn.hide(); return; }
  const i = bookmarks.findIndex(b => b.dynamics && (!dyn.data || b.dynamics === dyn.cur.region));
  if (i >= 0) { stopTour(); applyBookmark(i); } else dyn.show();
}
function setTypeHidden(ids: string[], hidden: boolean) {
  for (const i of typesMatching(ids)) { if (hidden) typeFlags[i] |= 2; else typeFlags[i] &= ~2; }
  R.device.queue.writeBuffer(R.typeFlags, 0, typeFlags); dirty = true;
}
function setFree(kind: number, on: boolean) { if (on) fs.freeHide &= ~(1 << kind); else fs.freeHide |= 1 << kind; dirty = true; }
/** true if any library type has copies in region i (types.json 'regions'), or the library carries no per-region counts */
function hasRegion(i: number): boolean {
  const c = (hasRegion as any).cache ?? ((hasRegion as any).cache = new Set<number>(lib.types.flatMap(t => Object.keys(t.regions ?? {}).map(Number))));
  return c.size === 0 || c.has(i);
}
function setRegions(rs: number[], on: boolean) {
  for (const r of rs) { if (on) regionFlags[r] |= 1; else regionFlags[r] &= ~1; }
  R.setPalette(buildPalette(regions, geo, regionFlags, feat));
  document.querySelectorAll<HTMLInputElement>('#regionList input').forEach(inp => { inp.checked = (regionFlags[Number(inp.dataset.r)] & 1) === 1; });
  dirty = true;
}

// ---------------------------------------------------------------- input
function setupInput() {
  let drag: null | { x: number; y: number; btn: number; moved: number; shift: boolean } = null;
  const keys = new Set<string>();
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId); canvas.focus();
    drag = { x: e.clientX, y: e.clientY, btn: e.button, moved: 0, shift: e.shiftKey };
    canvas.classList.add('dragging');
    if (tour) stopTour();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) { hover(e.clientX, e.clientY); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.btn === 2 || drag.btn === 1 || drag.shift) {
      const pxPerNm = cam.pxPerNmAtUnit(canvas.clientHeight) / cam.dist;
      cam.pan(dx, dy, pxPerNm);
    } else {
      cam.orbit(dx * 0.005, dy * 0.005);
      if (planeFollow) alignToView();
    }
    cam.anim = null; dirty = true;
  });
  const end = (e: PointerEvent) => {
    if (!drag) return;
    const wasClick = drag.moved < 4 && drag.btn === 0;
    drag = null; canvas.classList.remove('dragging');
    if (wasClick) {
      pickAt(e.offsetX, e.offsetY).then(r => { const d = describe(r.id); select(d.kind === 'inst' || d.kind === 'lipid' || d.kind === 'free' || d.kind === 'band' ? d : null); });
    }
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    pickAt(e.offsetX, e.offsetY).then(r => {
      if (r.depth <= 0) return;
      const near = cam.near(), zv = near / r.depth;   // view-space distance along -z
      const aspect = canvas.clientWidth / canvas.clientHeight;
      const ray = cam.ray(e.offsetX / canvas.clientWidth, e.offsetY / canvas.clientHeight, aspect);
      const t = zv / dot(ray, cam.fwd);
      const p = add(cam.eye, scale(ray, t));
      const st = cam.state(); st.target = p; st.dist = Math.max(cam.minDist * 4, cam.dist * 0.55);
      cam.flyTo(st, 900);
    });
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // macOS turns Shift+wheel on a mouse into horizontal scrolling: use whichever axis moved
    const raw = e.deltaY || e.deltaX;
    const dy = e.deltaMode === 1 ? raw * 30 : raw;
    if (e.altKey) {
      // fine cut-plane step: one fine step per mouse-wheel notch (~100 px), proportional for trackpads, at most 4 per event
      movePlane(Math.sign(dy) * nudgeStep * Math.min(4, Math.abs(dy) / 100));
    } else if (e.shiftKey) {
      const n = planeN(), step = Math.max(1, Math.min(fs.slab, cam.dist * 0.05)) * Math.sign(dy) * Math.min(4, Math.abs(dy) / 60 + 0.5);
      cam.target = add(cam.target, scale(n, step)); setPlane(n, fs.plane[3] + step);
    } else {
      // zoom towards the cursor (Cmd: 8x slower; Ctrl is left alone because trackpad pinch arrives as Ctrl+wheel)
      const f = Math.exp(dy * 0.0015 * (e.metaKey ? 0.125 : 1));
      const aspect = canvas.clientWidth / canvas.clientHeight;
      const ray = cam.ray(e.offsetX / canvas.clientWidth, e.offsetY / canvas.clientHeight, aspect);
      const tgtDepth = cam.dist;
      const pc = add(cam.eye, scale(ray, tgtDepth / dot(ray, cam.fwd)));
      const old = cam.dist; cam.zoom(f);
      const k = 1 - cam.dist / old;
      cam.target = add(cam.target, scale(sub(pc, cam.target), k));
    }
    cam.anim = null; if (tour) stopTour(); dirty = true;
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === 'c') { fs.cutOn = !fs.cutOn; ($('cutOn') as HTMLInputElement).checked = fs.cutOn; dirty = true; }
    else if (k === 'v') { fs.cutOn = true; ($('cutOn') as HTMLInputElement).checked = true; alignToView(); }
    else if (k === '[') { fs.slab = Math.max(5, fs.slab / 1.25); syncPlaneUI(); dirty = true; }
    else if (k === ']') { fs.slab = Math.min(4400, fs.slab * 1.25); syncPlaneUI(); dirty = true; }
    else if (k === ',' || k === '.' || e.code === 'Comma' || e.code === 'Period') {   // Alt: one fine step (Option changes e.key on macOS)
      const fwd = k === '.' || e.code === 'Period';
      movePlane((fwd ? 1 : -1) * (e.altKey ? nudgeStep : Math.max(2, fs.slab * 0.25))); }
    else if (k === 'o') setDisplayMode(fs.organelle ? 'molecules' : 'organelles');
    else if (k === 'm') setDisplayMode(fs.memColors && !fs.organelle ? 'molecules' : 'membranes');
    else if (k === 't') (tour ? stopTour() : startTour());
    else if (k === 'p') screenshot();
    else if (k === 'g' && hasDyn) toggleDynamics();
    else if (k === 'k' && hasDyn && dyn.visible) dyn.setPlaying(!dyn.playing);
    else if (k === 'escape') { select(null); setType(-1); }
    else if (/^[0-9]$/.test(k)) { const i = k === '0' ? 9 : Number(k) - 1; if (i < bookmarks.length) { stopTour(); applyBookmark(i); } }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());
  (setupInput as any).keys = keys;
  window.addEventListener('resize', () => { R.resize(fs.renderScale); dirty = true; });
}
let hoverT = 0, hoverBusy = false;
function hover(x: number, y: number) {
  const now = performance.now();
  if (hoverBusy || now - hoverT < 90) return;
  hoverT = now; hoverBusy = true;
  dirty = true;
  pickAt(x, y).then(r => {
    hoverBusy = false;
    const d = describe(r.id), el = $('hover');
    if (!d.title || d.kind === 'none') { el.style.display = 'none'; return; }
    let txt = `<b>${d.title}</b>`;
    if (d.kind === 'inst') { const t = lib.types[d.info.type]; txt += ` · ${t.name} <span style="color:#aaa">· ${d.sub}</span>`; }
    else txt += ` <span style="color:#aaa">· ${d.sub}</span>`;
    el.innerHTML = txt; el.style.display = 'block';
    el.style.left = `${x + 14}px`; el.style.top = `${y + 12}px`;
  });
}
canvas.addEventListener('pointerleave', () => ($('hover').style.display = 'none'));

// ---------------------------------------------------------------- minimap (analytic section through the cut plane)
let mmDirty = true, mmLastT = 0;
let mmBasis: { u: V3; v: V3; c: V3; ext: number } | null = null;
const mmImg: { data: ImageData | null } = { data: null };
function setupMinimap() {
  const c = $<HTMLCanvasElement>('minimap');
  c.addEventListener('click', (e) => {
    if (!mmBasis) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width * 2 - 1) * mmBasis.ext, y = (1 - (e.clientY - r.top) / r.height * 2) * mmBasis.ext;
    const p = add(mmBasis.c, add(scale(mmBasis.u, x), scale(mmBasis.v, y)));
    const st = cam.state(); st.target = p; cam.flyTo(st, 1200);
    if (tour) stopTour();
  });
}
function updateMinimap(now: number) {
  const c = $<HTMLCanvasElement>('minimap'), g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  const n: V3 = fs.cutOn ? planeN() : cam.fwd;
  const d = fs.cutOn ? fs.plane[3] : dot(cam.fwd, cam.target);
  if (mmDirty && now - mmLastT > 250) {
    mmDirty = false; mmLastT = now;
    let u = sub(cam.right, scale(n, dot(cam.right, n)));
    if (len(u) < 1e-3) u = norm(cross(n, [0, 0, 1])); u = norm(u);
    let v = cross(n, u); if (dot(v, cam.up) < 0) v = scale(v, -1) as V3;
    const MB = modelBox(), ext = 0.55 * Math.max(MB.hi[0] - MB.lo[0], MB.hi[1] - MB.lo[1], MB.hi[2] - MB.lo[2]);
    const mid: V3 = [(MB.lo[0] + MB.hi[0]) / 2, (MB.lo[1] + MB.hi[1]) / 2, (MB.lo[2] + MB.hi[2]) / 2];
    const c0 = add(scale(n, d), sub(mid, scale(n, dot(n, mid)))) as V3;   // plane point closest to the box centre
    mmBasis = { u, v, c: c0, ext };
    const N = 120, img = g.createImageData(N, N);
    // label fill colours of geometry.json (labels without a fill, the exterior and the outside of the imaged volume: transparent)
    const cols: number[][] = [], clear = new Set<number>([ev.exteriorCode, ev.outsideCode]);
    for (const L of geo.labels) { cols[L.code] = hexRgb(L.fill ?? BG_HEX).map(v => Math.round(v * 255)); if (!L.fill) clear.add(L.code); }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N * 2 - 1) * ext, y = (1 - (j + 0.5) / N * 2) * ext;
      const p = add(c0, add(scale(u, x), scale(v, y)));
      const lab = ev.label(p[0], p[1], p[2]);
      const col = cols[lab] ?? [200, 200, 200], o = 4 * (j * N + i);
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = clear.has(lab) || lab < 0 ? 0 : 255;
    }
    mmImg.data = img;
  }
  if (!mmImg.data || !mmBasis) return;
  const tmp = (updateMinimap as any).tmp || ((updateMinimap as any).tmp = document.createElement('canvas'));
  tmp.width = mmImg.data.width; tmp.height = mmImg.data.height; tmp.getContext('2d')!.putImageData(mmImg.data, 0, 0);
  g.clearRect(0, 0, W, H); g.imageSmoothingEnabled = true; g.drawImage(tmp, 0, 0, W, H);
  // view footprint at the target
  const B = mmBasis, toPx = (p: V3) => { const q = sub(p, B.c); return [(dot(q, B.u) / B.ext + 1) / 2 * W, (1 - dot(q, B.v) / B.ext) / 2 * H]; };
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const hh = cam.dist * Math.tan(cam.fovy / 2), hw = hh * aspect;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => toPx(add(cam.target, add(scale(cam.right, a * hw), scale(cam.up, b * hh)))));
  g.strokeStyle = '#FF9400'; g.lineWidth = 3; g.beginPath();
  corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
  const [tx, ty] = toPx(cam.target);
  g.fillStyle = '#FF9400'; g.beginPath(); g.arc(tx, ty, 5, 0, 7); g.fill();
  $('mmLabel').textContent = fs.cutOn ? `plane ${Math.round(d)} nm` : 'view plane';
}

// ---------------------------------------------------------------- screenshot
function screenshot() {
  const sc = fs.renderScale;
  R.resize(2 * sc);
  fs.renderScale = 2 * sc;
  renderNow(true);
  canvas.toBlob((b) => {
    if (b) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(b);
      a.download = `${entry.id}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    fs.renderScale = sc; R.resize(sc); dirty = true;
  }, 'image/png');
  toast('Screenshot saved (2× resolution)');
}

// ---------------------------------------------------------------- HUD / scale bar
function updateHUD() {
  const tt = T.totals(), s = R.stats;
  const fps = frameTimes.length > 3 ? 1000 / (frameTimes.reduce((a, b) => a + b) / frameTimes.length) : 0;
  const pend = T.pendingForView();
  $('hud').innerHTML = `<b>${fmt(tt.inst)}</b> molecules in ${tt.tiles} tiles${pend ? ` · <span style="color:#FF9400">streaming ${pend}</span>` : ''}${T.starved ? ` · <span style="color:#FF9400">budget of ${fmt(tt.instCap)} molecules reached (thinner slab or higher Detail loads more)</span>` : ''}${T.whole && fs.cutOn && tt.secWant ? ` · section ${Math.round(100 * tt.secHave / tt.secWant)}% of ${tt.secWant} tiles` : ''}${tt.ovSpheres ? ` · ${fmt(tt.ovSpheres)} stand-ins` : ''}<br>
    drawn: <b>${fmt(s.ninst)}</b> in view · ${fmt(s.l0 * 64)} residue beads (≤) · ${fmt(s.l1 * 16)} LOD1 · ${fmt(s.l2)} LOD2 · ${fmt(s.lip)} lipids · ${fmt(s.fre)} polymer beads<br>
    ${fps ? `${fps.toFixed(0)} fps · ` : ''}LOD bead ≥ ${fs.l0px.toFixed(1)} px · GPU pools ${R.gpuMemoryMB().toFixed(0)} MB · ${(T.bytesLoaded / 1048576).toFixed(0)} MB streamed${R.adapterInfo ? ' · ' + R.adapterInfo : ''}`;
  // scale bar
  const dpr = R.width / canvas.clientWidth;
  const pxPerNm = cam.pxPerNmAtUnit(R.height) / cam.dist / dpr;
  const target = 120 / pxPerNm;
  const p10 = Math.pow(10, Math.floor(Math.log10(target)));
  const nice = [1, 2, 5, 10].map(m => m * p10).reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
  ($('scalebar').querySelector('.bar') as HTMLElement).style.width = `${nice * pxPerNm}px`;
  ($('scalebar').querySelector('span') as HTMLElement).textContent = fmtNm(nice);
}

// ---------------------------------------------------------------- main loop
let gpuMs = 0, gpuBusy = false;
function renderNow(force = false) {
  const t0 = performance.now();
  R.frame(cam, fs, T.meshDraws(), force || t0 - R.lastStatsT > 400);
  R.lastStatsT = performance.now();
  gpuBusy = true;
  R.device.queue.onSubmittedWorkDone().then(() => { gpuMs = performance.now() - t0; gpuBusy = false; });
}
let hudT = 0;
function tileTick() {
  T.update(cam, canvas.clientWidth / canvas.clientHeight, fs.cutOn, fs.plane, fs.slab, fs.organelle || fs.memColors, R.height);
  lastUpdate = performance.now();
  if (T.inflight || T.detInflight) dirty = true;
}
// streaming must not be throttled by requestAnimationFrame when frames are slow
setInterval(() => { if (T && performance.now() - lastUpdate > 150) tileTick(); }, 150);
function loop(now: number) {
  requestAnimationFrame(loop);
  const dt = lastFrameT ? now - lastFrameT : 16; lastFrameT = now;
  // keyboard flight
  const keys: Set<string> = (setupInput as any).keys;
  if (keys && keys.size) {
    const sp = cam.dist * 0.9 * dt / 1000;
    let mv: V3 = [0, 0, 0];
    if (keys.has('w')) mv = add(mv, scale(cam.fwd, sp)); if (keys.has('s')) mv = add(mv, scale(cam.fwd, -sp));
    if (keys.has('a')) mv = add(mv, scale(cam.right, -sp)); if (keys.has('d')) mv = add(mv, scale(cam.right, sp));
    if (keys.has('q')) mv = add(mv, scale(cam.up, -sp)); if (keys.has('e')) mv = add(mv, scale(cam.up, sp));
    if (keys.has('z')) cam.roll(-dt * 0.0015); if (keys.has('x')) cam.roll(dt * 0.0015);
    if (len(mv) > 0 || keys.has('z') || keys.has('x')) { cam.fly(mv); dirty = true; if (planeFollow) alignToView(); }
  }
  if (cam.step(now)) { dirty = true; if (planeFollow && !tour) alignToView(); }
  if (sweep) {
    const e = Math.min(1, (now - sweep.t0) / sweep.dur);
    const n = planeN(), d = sweep.d0 + (sweep.d1 - sweep.d0) * e;
    cam.target = add(cam.target, scale(n, d - fs.plane[3])); fs.plane[3] = d; syncPlaneUI();
    if (e >= 1) { sweep = null; $('sweepBtn').classList.remove('on'); }
    dirty = true;
  }
  tourStep(now);
  if (fs.motion > 0) dirty = true;          // illustrative motion: redraw every frame
  if (dyn.tick(dt)) dirty = true;           // tracer dynamics playing
  if (now - lastUpdate > 90) tileTick();
  if (dirty && !gpuBusy) {
    dirty = false;
    renderNow();
    frameTimes.push(dt); if (frameTimes.length > 30) frameTimes.shift();
    // adaptive quality while interacting
    if (quality === 'auto' && frameTimes.length >= 20) {
      const avg = frameTimes.reduce((a, b) => a + b) / frameTimes.length;
      if (avg > 45 && fs.l0px < 3.5) { fs.l0px = Math.min(3.5, fs.l0px * 1.15); frameTimes.length = 0; }
      else if (avg < 22 && fs.l0px > 0.9) { fs.l0px = Math.max(0.9, fs.l0px / 1.1); frameTimes.length = 0; }
    }
    setTimeout(() => { dirty = dirty || R.statsBusy; }, 0);
  } else if (!dirty) frameTimes.length = 0;
  if (now - hudT > 300) { hudT = now; updateHUD(); updateMinimap(now); if (selType >= 0 && T.inflight) renderSelType(); }
}

boot();
