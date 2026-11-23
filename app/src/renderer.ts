// origin: jurkat/viewer/app/src/renderer.ts (Jurkat viewer v7). Changed: palette and fill buffers from the open cell's
// data (data.ts buildPalette, geometry.ts GeomEval), fill shader generated per cell (shaders.ts fillShader).
// WebGPU renderer: GPU-driven culling + LOD selection, sphere impostors, analytic compartment fill, outlines.
import * as S from './shaders';
import { Library, TileIndex, PAL_N } from './data';
import { GeomEval } from './geometry';
import { Camera } from './camera';
import { V3, mul4, inv4, dot } from './math';

export const ID_INST = 0x40000000, ID_LIPID = 0x80000000, ID_FREE = 0xC0000000;

export interface FrameState {
  cutOn: boolean; plane: [number, number, number, number]; slab: number;
  colorMode: number; freeHide: number; highlight: boolean;
  selId: number; shaded: boolean; organelle: boolean; motion: number;
  l0px: number; l1px: number; minpx: number; outline: number;
  showMeshes: boolean; showLipids: boolean; renderScale: number;
  memColors: boolean;   // only membranes shown: the whole cell's membrane surfaces, coloured by enclosed compartment, no cut
}

export interface MeshDraw { slot: number; vb: GPUBuffer; ib: GPUBuffer; nIdx: number; under: boolean }

// ?debug=nofill,nomol: skip passes (diagnostics)
const DEBUG = new Set((new URLSearchParams(location.search).get('debug') ?? '').split(','));
const SU = GPUShaderStage;
const BU = GPUBufferUsage;

export class Renderer {
  device!: GPUDevice; ctx!: GPUCanvasContext; format!: GPUTextureFormat; canvas: HTMLCanvasElement;
  limits: Record<string, number> = {};
  adapterInfo = '';
  // molecule budget (instance pool): 'auto' = medium (8 M), low (4 M) on software / fallback adapters; low 4 M,
  // medium 8 M, high 16 M; always capped by the device's storage-binding limit (16 B per instance)
  detail = 'auto'; detailUsed = 'medium';
  // capacities
  instPages = 0; lipPages = 0; freePages = 0; capL0 = 0; capL1 = 0; capL2 = 0; capLip = 0; capFree = 0;
  maxSlots = 4096;
  // buffers
  uni!: GPUBuffer; inst!: GPUBuffer; pageOrg!: GPUBuffer; typesBuf!: GPUBuffer; typeFlags!: GPUBuffer; palette!: GPUBuffer;
  beads!: GPUBuffer; st!: GPUBuffer; clusters!: GPUBuffer; modes!: GPUBuffer; modeCap = 0;
  counters!: GPUBuffer; list01!: GPUBuffer; listL2!: GPUBuffer; args!: GPUBuffer; cullParams!: GPUBuffer; caps!: GPUBuffer;
  lipPool!: GPUBuffer; lipPagesBuf!: GPUBuffer; lipList!: GPUBuffer; lipParams!: GPUBuffer;
  freePool!: GPUBuffer; freePagesBuf!: GPUBuffer; freeList!: GPUBuffer; freeParams!: GPUBuffer;
  meshUni!: GPUBuffer; tileState!: GPUBuffer;
  fillBufs: GPUBuffer[] = [];
  pickBuf!: GPUBuffer; pickParams!: GPUBuffer; pickOut!: GPUBuffer; statsBuf!: GPUBuffer;
  trSph!: GPUBuffer; trSeg!: GPUBuffer; nTrSph = 0; nTrSeg = 0;     // tracer dynamics overlay (dynamics.ts)
  // pipelines & bind groups
  pipes: Record<string, GPURenderPipeline | GPUComputePipeline> = {} as any;
  bg: Record<string, GPUBindGroup> = {};
  bgl: Record<string, GPUBindGroupLayout> = {};
  colorTex!: GPUTexture; idTex!: GPUTexture; depthTex!: GPUTexture;
  width = 0; height = 0;
  usedInstPages = 0; usedLipPages = 0; usedFreePages = 0;
  pickPending: null | { x: number; y: number; resolve: (r: { id: number; depth: number }) => void } = null;
  pickBusy = false; statsBusy = false;
  stats = { l0: 0, l1: 0, l2: 0, lip: 0, fre: 0, ninst: 0 };
  lastStatsT = 0;
  organelleMeshes: { vb: GPUBuffer; ib: GPUBuffer; nIdx: number; mem: number }[] = [];
  onLost: (msg: string) => void = () => {};

  offscreen = new URLSearchParams(location.search).get('offscreen') === '1';
  offTex: GPUTexture | null = null;
  constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; }
  /** PNG data URL of the last composited frame (offscreen mode) */
  async snapshot(): Promise<string> {
    if (!this.offTex) throw new Error('snapshot() needs ?offscreen=1');
    const w = this.width, h = this.height, bpr = Math.ceil(w * 4 / 256) * 256;
    const buf = this.device.createBuffer({ size: bpr * h, usage: BU.COPY_DST | BU.MAP_READ });
    const e = this.device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: this.offTex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    this.device.queue.submit([e.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()), img = new ImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(src.subarray(y * bpr, y * bpr + 4 * w), 4 * w * y);
    buf.unmap(); buf.destroy();
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d')!.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  qstep = 360 / 65535; outerMem = 0;
  async init(lib: Library, ev: GeomEval, idx: TileIndex, palette: Float32Array<ArrayBuffer>) {
    this.qstep = idx.qRange / 65535;
    if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
    // ?gpu=compat: a compatibility-mode adapter (e.g. Chrome's OpenGL ES backend; used by the headless GPU test)
    const compat = new URLSearchParams(location.search).get('gpu') === 'compat';
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', ...(compat ? { featureLevel: 'compatibility' } : {}) } as any);
    if (!adapter) throw new Error('No WebGPU adapter found (GPU blocked or unsupported).');
    try {
      const info: any = (adapter as any).info || {};
      this.adapterInfo = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
    } catch { /* ignore */ }
    const L = adapter.limits;
    const want: Record<string, number> = {
      maxStorageBufferBindingSize: Math.min(L.maxStorageBufferBindingSize, 2 ** 31 - 4),
      maxBufferSize: Math.min(L.maxBufferSize, 2 ** 31 - 4),
      maxComputeWorkgroupsPerDimension: L.maxComputeWorkgroupsPerDimension,
    };
    // storage buffers per stage at the adapter's maximum (compatibility-mode adapters default to fewer, or none in vertex shaders)
    for (const k of ['maxStorageBuffersPerShaderStage', 'maxStorageBuffersInVertexStage', 'maxStorageBuffersInFragmentStage', 'maxStorageTexturesInFragmentStage'])
      if (typeof (L as any)[k] === 'number') want[k] = (L as any)[k];
    this.device = await adapter.requestDevice({ requiredLimits: want });
    this.device.lost.then(i => this.onLost(`GPU device lost: ${i.message}`));
    this.device.addEventListener('uncapturederror', (e: any) => console.error('WebGPU error:', e.error?.message));
    this.limits = { ...want };
    const maxBind = this.device.limits.maxStorageBufferBindingSize;
    // the residue library is one storage buffer (16 B per bead); draw lists address it with 26-bit offsets (shaders.ts OFF_BITS)
    const nBeads = lib.beads.byteLength / 16, nSph = lib.st.byteLength / 16;
    if (lib.beads.byteLength > maxBind || lib.st.byteLength > maxBind)
      throw new Error(`The structure library (${(lib.beads.byteLength / 1048576).toFixed(0)} MB) exceeds this GPU's storage buffer limit (${(maxBind / 1048576).toFixed(0)} MB).`);
    if (nBeads >= 2 ** 26 || nSph >= 2 ** 26) throw new Error(`Too many library beads (${nBeads}) or spheres (${nSph}) for 26-bit draw-list offsets.`);
    if (ev.G.length * 4 > maxBind)                  // the cell geometry vector is one storage buffer
      throw new Error(`The cell geometry (${(ev.G.length * 4 / 1048576).toFixed(0)} MB) exceeds this GPU's storage buffer limit (${(maxBind / 1048576).toFixed(0)} MB).`);
    // capacities sized to the device (16 B per instance / sphere record)
    const capRecords = (want: number) => Math.min(want, Math.floor(maxBind / 16));
    let lvl = this.detail;
    if (lvl === 'auto') {
      const soft = !!(adapter as any).isFallbackAdapter || !!(adapter as any).info?.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(this.adapterInfo);
      lvl = soft ? 'low' : 'medium';
    }
    const wantM = ({ low: 4, medium: 8, high: 16 } as Record<string, number>)[lvl] ?? 8;
    this.instPages = Math.floor(capRecords(wantM * 1024 * 1024) / S.PAGE);
    this.detailUsed = `${lvl} (${(this.instPages * S.PAGE / 1048576).toFixed(0)} M)`;
    this.lipPages = Math.floor(capRecords(8 * 1024 * 1024) / S.SPAGE);
    this.freePages = Math.floor(capRecords(10 * 1024 * 1024) / S.SPAGE);
    this.capL0 = Math.min(4 * 1024 * 1024, Math.floor(maxBind / 8) - 2 * 1024 * 1024);
    this.capL1 = 2 * 1024 * 1024;
    this.capL2 = Math.min(8 * 1024 * 1024, Math.floor(maxBind / 4));
    this.capLip = this.lipPages * S.SPAGE; this.capFree = this.freePages * S.SPAGE;

    if (this.offscreen) this.format = 'rgba8unorm';   // ?offscreen=1 (headless tests): composite into a texture, read back by snapshot()
    else {
      this.ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    }
    const d = this.device;
    const mk = (size: number, usage: number, label: string) => d.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage, label });
    const STO = BU.STORAGE | BU.COPY_DST;
    this.uni = mk(512, BU.UNIFORM | BU.COPY_DST, 'uniforms');
    this.inst = mk(this.instPages * S.PAGE * 16, STO, 'instances');
    this.pageOrg = mk(this.instPages * 16, STO, 'pageOrg');
    this.typesBuf = mk(lib.typeInfo.byteLength, STO, 'types');
    this.typeFlags = mk(lib.types.length * 4, STO, 'typeFlags');
    this.palette = mk(PAL_N * 16, STO, 'palette');
    this.beads = mk(lib.beads.byteLength, STO, 'beads');
    this.modes = mk(Math.max(16, lib.modes.byteLength), STO, 'modes'); this.modeCap = lib.modeCap;
    this.st = mk(lib.st.byteLength, STO, 'spheretree');
    this.clusters = mk(lib.clusters.byteLength, STO, 'clusters');
    d.queue.writeBuffer(this.typesBuf, 0, lib.typeInfo);
    d.queue.writeBuffer(this.palette, 0, palette);
    d.queue.writeBuffer(this.beads, 0, lib.beads);
    d.queue.writeBuffer(this.modes, 0, lib.modes);
    d.queue.writeBuffer(this.st, 0, lib.st);
    d.queue.writeBuffer(this.clusters, 0, lib.clusters);
    this.counters = mk(32, BU.STORAGE | BU.COPY_DST | BU.COPY_SRC, 'counters');
    this.list01 = mk((this.capL0 + this.capL1) * 8, BU.STORAGE, 'list01');
    this.listL2 = mk(this.capL2 * 4, BU.STORAGE, 'listL2');
    this.args = mk(20 * 4, BU.STORAGE | BU.INDIRECT, 'args');
    this.cullParams = mk(32, BU.UNIFORM | BU.COPY_DST, 'cullParams');
    this.caps = mk(32, BU.UNIFORM | BU.COPY_DST, 'caps');
    d.queue.writeBuffer(this.caps, 0, new Uint32Array([this.capL0, this.capL1, this.capL2, this.capLip, this.capFree, 0, 0, 0]));
    this.lipPool = mk(this.lipPages * S.SPAGE * 16, STO, 'lipidPool');
    this.lipPagesBuf = mk(this.lipPages * 16, STO, 'lipidPages');
    this.lipList = mk(this.capLip * 4, BU.STORAGE, 'lipidList');
    this.lipParams = mk(16, BU.UNIFORM | BU.COPY_DST, 'lipParams');
    this.freePool = mk(this.freePages * S.SPAGE * 16, STO, 'freePool');
    this.freePagesBuf = mk(this.freePages * 16, STO, 'freePages');
    this.freeList = mk(this.capFree * 4, BU.STORAGE, 'freeList');
    this.freeParams = mk(16, BU.UNIFORM | BU.COPY_DST, 'freeParams');
    this.meshUni = mk(256 * (this.maxSlots + 16), BU.UNIFORM | BU.COPY_DST, 'meshUniforms');
    this.tileState = mk(idx.dims[0] * idx.dims[1] * idx.dims[2] * 4, STO, 'tileState');     // index.json grid min..max
    this.pickBuf = d.createBuffer({ size: 16, usage: BU.MAP_READ | BU.COPY_DST });
    this.pickParams = mk(16, BU.UNIFORM | BU.COPY_DST, 'pickParams');
    this.pickOut = mk(16, BU.STORAGE | BU.COPY_SRC, 'pickOut');
    this.statsBuf = d.createBuffer({ size: 32, usage: BU.MAP_READ | BU.COPY_DST });
    this.trSph = mk(32 * 1024, STO, 'tracers'); this.trSeg = mk(48 * 4096, STO, 'tracerLines');
    this.initFill(ev, idx);
    await this.initPipelines(ev);
    this.resize();
  }

  setPalette(pal: Float32Array<ArrayBuffer>) { this.device.queue.writeBuffer(this.palette, 0, pal); }

  initFill(ev: GeomEval, idx: TileIndex) {
    const d = this.device, K = ev.K, G = ev.G;
    const nP = ev.PT.length;
    const prims = new ArrayBuffer(Math.max(1, nP) * 48), pf = new Float32Array(prims), pu = new Uint32Array(prims);
    for (let i = 0; i < nP; i++) {
      for (let k = 0; k < 8; k++) pf[12 * i + k] = ev.PQ[8 * i + k];
      pu[12 * i + 8] = ev.PT[i]; pu[12 * i + 9] = ev.PC[i];
    }
    const pores = new Float32Array(Math.max(1, ev.nPores) * 8);
    for (let i = 0; i < ev.nPores; i++) for (let k = 0; k < 3; k++) { pores[8 * i + k] = ev.pores[6 * i + k]; pores[8 * i + 4 + k] = ev.pores[6 * i + 3 + k]; }
    const g = ev.grid, nPI = g.primIdx.length;
    const off = new Uint32Array(g.primOff.length + g.poreOff.length);
    off.set(g.primOff, 0);
    for (let i = 0; i < g.poreOff.length; i++) off[g.primOff.length + i] = g.poreOff[i] + nPI;
    const gidx = new Uint32Array(nPI + g.poreIdx.length + 1);
    gidx.set(g.primIdx, 0); gidx.set(g.poreIdx, nPI);
    // membranes drawn as bands on the cut face: every membrane except domain walls (K_WALL duplicates another membrane)
    let band = 0, mi = 0;
    for (let r = 0; r < ev.nRow; r++) {
      const kind = G[ev.tab + K.TH + K.MROW * r];
      if (kind === K.K_SMOOTH_UNION) continue;
      if (kind !== K.K_WALL && mi < 32) band |= 1 << mi;
      mi++;
    }
    const gb = new ArrayBuffer(160), gf = new Float32Array(gb), gu = new Uint32Array(gb);
    gf.set([...ev.bbox.lo, 0, ...ev.bbox.hi, 0, ...g.lo, g.n, ...g.cs, ev.nPores, ...idx.origin, idx.tileNm, ...idx.min, 0, ...idx.dims, 0], 0);
    const NONE = 0xFFFFFFFF;
    gu.set([ev.nMem, ev.domainMem >= 0 ? ev.domainMem : NONE, ev.domainRows >>> 0, ev.nRow], 28);
    gu.set([ev.nLab, ev.exteriorCode >= 0 ? ev.exteriorCode : NONE, ev.outsideCode >= 0 ? ev.outsideCode : NONE, band >>> 0], 32);
    gu.set([ev.tab, ev.r0, ev.data0, ev.r0 + K.RROW * ev.nLab], 36);
    const mkd = (data: ArrayBufferView | ArrayBuffer, usage: number) => {
      const b = d.createBuffer({ size: Math.ceil((data as any).byteLength / 16) * 16 + 16, usage: usage | BU.COPY_DST });
      d.queue.writeBuffer(b, 0, data as any); return b;
    };
    this.fillBufs = [mkd(prims, BU.STORAGE), mkd(pores, BU.STORAGE), mkd(off, BU.STORAGE), mkd(gidx, BU.STORAGE), mkd(gb, BU.UNIFORM),
      mkd(ev.gpuG(), BU.STORAGE)];
  }

  async initPipelines(ev: GeomEval) {
    const d = this.device;
    const ro = (b: number, vis: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: vis, buffer: { type: 'read-only-storage' } });
    const rw = (b: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: SU.COMPUTE, buffer: { type: 'storage' } });
    const un = (b: number, vis: number, dyn = false): GPUBindGroupLayoutEntry => ({ binding: b, visibility: vis, buffer: { type: 'uniform', hasDynamicOffset: dyn } });
    const ALL = SU.COMPUTE | SU.VERTEX | SU.FRAGMENT, CV = SU.COMPUTE | SU.VERTEX, VF = SU.VERTEX | SU.FRAGMENT;
    const L = (entries: GPUBindGroupLayoutEntry[]) => d.createBindGroupLayout({ entries });
    this.bgl.g0 = L([un(0, ALL), ro(1, CV), ro(2, CV), ro(3, CV), ro(4, CV), ro(5, ALL)]);
    this.bgl.cull = L([rw(0), rw(1), rw(2), un(3, SU.COMPUTE), ro(4, SU.COMPUTE)]);
    this.bgl.cullS = L([rw(0), ro(1, SU.COMPUTE), ro(2, SU.COMPUTE), rw(3), un(4, SU.COMPUTE)]);
    this.bgl.fin = L([ro(0, SU.COMPUTE), rw(1), un(2, SU.COMPUTE)]);
    this.bgl.l0 = L([ro(0, SU.VERTEX), ro(1, SU.VERTEX), ro(2, SU.VERTEX)]);   // L0 and L1: beads or spheres, list, modes
    this.bgl.l2 = L([ro(0, SU.VERTEX)]);
    this.bgl.sph = L([ro(0, SU.VERTEX), ro(1, SU.VERTEX), ro(2, SU.VERTEX)]);
    this.bgl.mesh = L([un(0, VF, true)]);
    this.bgl.tr = L([ro(0, SU.VERTEX)]);
    this.bgl.fill = L([ro(0, SU.FRAGMENT), ro(1, SU.FRAGMENT), ro(2, SU.FRAGMENT), ro(3, SU.FRAGMENT), un(4, SU.FRAGMENT), ro(5, SU.FRAGMENT), ro(6, SU.FRAGMENT)]);
    this.bgl.comp = L([
      { binding: 0, visibility: SU.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: SU.FRAGMENT, texture: { sampleType: 'uint' } },
      { binding: 2, visibility: SU.FRAGMENT, texture: { sampleType: 'depth' } },
    ]);
    this.bgl.pick = L([
      { binding: 0, visibility: SU.COMPUTE, texture: { sampleType: 'uint' } },
      { binding: 1, visibility: SU.COMPUTE, texture: { sampleType: 'depth' } },
      un(2, SU.COMPUTE), rw(3),
    ]);
    const PL = (...g: GPUBindGroupLayout[]) => d.createPipelineLayout({ bindGroupLayouts: g });
    const compat = new URLSearchParams(location.search).get('gpu') === 'compat';
    const mod = async (code: string, label: string) => {
      // compatibility mode (test harness, ?gpu=compat): no 'first' interpolation sampling, no textureLoad of depth textures
      // (the composite then has no depth: outlines from ids only, no depth cue; pick returns depth 0)
      if (compat) code = code.replace(/@interpolate\(flat\)/g, '@interpolate(flat, either)')
        .replace(/textureLoad\(depthTex, ([a-z0-9]+), 0\)/g, 'select(0.5, 0.5, $1.x == 0)')
        .replace('var strength = u.misc.z;', 'var strength = 0.0;').replace('if (u.cut.x > 0.5 && cat != 0u && u.sel.w == 0u) {', 'if (false) {');
      const m = d.createShaderModule({ code, label });
      const info = await m.getCompilationInfo();
      const errs = info.messages.filter(x => x.type === 'error');
      for (const e of info.messages) (e.type === 'error' ? console.error : console.warn)(`[${label}] ${e.lineNum}:${e.linePos} ${e.message}`);
      if (errs.length) throw new Error(`WGSL compile error in ${label}: ${errs[0].lineNum}:${errs[0].linePos} ${errs[0].message}`);
      return m;
    };
    const mCull = await mod(S.CULL, 'cull'), mCullS = await mod(S.CULL_SPHERES, 'cullSpheres'), mFin = await mod(S.FINALIZE, 'finalize');
    const mL0 = await mod(S.DRAW_L0, 'drawL0'), mL1 = await mod(S.DRAW_L1, 'drawL1'), mL2 = await mod(S.DRAW_L2, 'drawL2');
    const mSph = await mod(S.DRAW_SPHERES, 'drawSpheres'), mMesh = await mod(S.DRAW_MESH, 'mesh'), mFill = await mod(S.fillShader(ev.K), 'fill');
    const mComp = await mod(S.COMPOSITE, 'composite'), mPick = await mod(S.PICK, 'pick');
    const mTr = await mod(S.DRAW_TRACERS, 'tracers'), mLine = await mod(S.DRAW_LINES, 'lines');
    const comp = (m: GPUShaderModule, ep: string, layout: GPUPipelineLayout) =>
      d.createComputePipelineAsync({ layout, compute: { module: m, entryPoint: ep } });
    const gTargets: GPUColorTargetState[] = [{ format: 'rgba8unorm' }, { format: 'r32uint' }];
    const depth = (cmp: GPUCompareFunction = 'greater'): GPUDepthStencilState => ({ format: 'depth32float', depthWriteEnabled: true, depthCompare: cmp });
    const rp = (m: GPUShaderModule, vs: string, fs: string, layout: GPUPipelineLayout, extra: Partial<GPURenderPipelineDescriptor> = {}) =>
      d.createRenderPipelineAsync({
        layout, vertex: { module: m, entryPoint: vs, ...(extra.vertex ? { buffers: (extra.vertex as any).buffers } : {}) },
        fragment: { module: m, entryPoint: fs, targets: gTargets }, primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: extra.depthStencil ?? depth(),
      });
    const g0 = this.bgl.g0;
    const [cull, cullS, fin, l0, l1, l2, lip, fre, mesh, fill, compP, pick, tr, line] = await Promise.all([
      comp(mCull, 'cullInstances', PL(g0, this.bgl.cull)),
      comp(mCullS, 'cullSpheres', PL(g0, this.bgl.cullS)),
      comp(mFin, 'main', PL(this.bgl.fin)),
      rp(mL0, 'vsL0', 'fsMain', PL(g0, this.bgl.l0)),
      rp(mL1, 'vsL1', 'fsMain', PL(g0, this.bgl.l0)),
      rp(mL2, 'vsL2', 'fsMain', PL(g0, this.bgl.l2)),
      rp(mSph, 'vsLipid', 'fsMain', PL(g0, this.bgl.sph)),
      rp(mSph, 'vsFree', 'fsMain', PL(g0, this.bgl.sph)),
      rp(mMesh, 'vsMesh', 'fsMesh', PL(g0, this.bgl.mesh), {
        vertex: { buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }] }] } as any,
      }),
      rp(mFill, 'vsFill', 'fsFill', PL(g0, this.bgl.fill), { depthStencil: depth('always') }),
      d.createRenderPipelineAsync({
        layout: PL(g0, this.bgl.comp), vertex: { module: mComp, entryPoint: 'vsFull' },
        fragment: { module: mComp, entryPoint: 'fsComposite', targets: [{ format: this.format }] }, primitive: { topology: 'triangle-list' },
      }),
      comp(mPick, 'main', PL(this.bgl.pick)),
      rp(mTr, 'vsTracer', 'fsMain', PL(g0, this.bgl.tr)),
      d.createRenderPipelineAsync({     // lines: colour only (ids and depth stay those of the molecules behind)
        layout: PL(g0, this.bgl.tr), vertex: { module: mLine, entryPoint: 'vsLine' },
        fragment: { module: mLine, entryPoint: 'fsLine', targets: [{ format: 'rgba8unorm' }, { format: 'r32uint', writeMask: compat ? GPUColorWrite.ALL : 0 }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater' },
      }),
    ]);
    Object.assign(this.pipes, { cull, cullS, fin, l0, l1, l2, lip, fre, mesh, fill, comp: compP, pick, tr, line });
    const B = (layout: GPUBindGroupLayout, bufs: GPUBuffer[], sizes: (number | undefined)[] = []) => d.createBindGroup({
      layout, entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b, size: sizes[i] } })),
    });
    this.bg.g0 = B(g0, [this.uni, this.inst, this.pageOrg, this.typesBuf, this.typeFlags, this.palette]);
    this.bg.cull = B(this.bgl.cull, [this.counters, this.list01, this.listL2, this.cullParams, this.clusters]);
    this.bg.cullLip = B(this.bgl.cullS, [this.counters, this.lipPool, this.lipPagesBuf, this.lipList, this.lipParams]);
    this.bg.cullFree = B(this.bgl.cullS, [this.counters, this.freePool, this.freePagesBuf, this.freeList, this.freeParams]);
    this.bg.fin = B(this.bgl.fin, [this.counters, this.args, this.caps]);
    this.bg.l0 = B(this.bgl.l0, [this.beads, this.list01, this.modes]);
    this.bg.l1 = B(this.bgl.l0, [this.st, this.list01, this.modes]);
    this.bg.l2 = B(this.bgl.l2, [this.listL2]);
    this.bg.lip = B(this.bgl.sph, [this.lipPool, this.lipPagesBuf, this.lipList]);
    this.bg.fre = B(this.bgl.sph, [this.freePool, this.freePagesBuf, this.freeList]);
    this.bg.mesh = d.createBindGroup({ layout: this.bgl.mesh, entries: [{ binding: 0, resource: { buffer: this.meshUni, size: 16 } }] });
    const fb = this.fillBufs;
    this.bg.fill = B(this.bgl.fill, [fb[0], fb[1], fb[2], fb[3], fb[4], this.tileState, fb[5]]);
    this.trBindGroups();
  }
  trBindGroups() {
    this.bg.tr = this.device.createBindGroup({ layout: this.bgl.tr, entries: [{ binding: 0, resource: { buffer: this.trSph } }] });
    this.bg.line = this.device.createBindGroup({ layout: this.bgl.tr, entries: [{ binding: 0, resource: { buffer: this.trSeg } }] });
  }
  /** tracer spheres (8 floats each: xyz r, rgb, id bits) and line segments (12 floats: a xyz width px, b xyz clip, rgb -) */
  setTracers(sph: Float32Array<ArrayBuffer>, nS: number, seg: Float32Array<ArrayBuffer>, nG: number) {
    const d = this.device;
    const grow = (b: GPUBuffer, bytes: number) => b.size >= bytes ? b
      : (b.destroy(), d.createBuffer({ size: Math.ceil(bytes * 1.5 / 16) * 16, usage: BU.STORAGE | BU.COPY_DST, label: b.label }));
    const s0 = this.trSph, g0 = this.trSeg;
    this.trSph = grow(s0, nS * 32); this.trSeg = grow(g0, nG * 48);
    if (s0 !== this.trSph || g0 !== this.trSeg) this.trBindGroups();
    if (nS) d.queue.writeBuffer(this.trSph, 0, sph, 0, nS * 8);
    if (nG) d.queue.writeBuffer(this.trSeg, 0, seg, 0, nG * 12);
    this.nTrSph = nS; this.nTrSeg = nG;
  }

  resize(scale = 1) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height && this.colorTex) return;
    this.canvas.width = w; this.canvas.height = h; this.width = w; this.height = h;
    this.colorTex?.destroy(); this.idTex?.destroy(); this.depthTex?.destroy(); this.offTex?.destroy();
    const U = GPUTextureUsage;
    if (this.offscreen) this.offTex = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: U.RENDER_ATTACHMENT | U.COPY_SRC });
    this.colorTex = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
    this.idTex = this.device.createTexture({ size: [w, h], format: 'r32uint', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC });
    this.depthTex = this.device.createTexture({ size: [w, h], format: 'depth32float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC });
    this.bg.comp = this.device.createBindGroup({
      layout: this.bgl.comp, entries: [
        { binding: 0, resource: this.colorTex.createView() }, { binding: 1, resource: this.idTex.createView() },
        { binding: 2, resource: this.depthTex.createView() }],
    });
    this.bg.pick = this.device.createBindGroup({
      layout: this.bgl.pick, entries: [
        { binding: 0, resource: this.idTex.createView() }, { binding: 1, resource: this.depthTex.createView() },
        { binding: 2, resource: { buffer: this.pickParams } }, { binding: 3, resource: { buffer: this.pickOut } }],
    });
  }

  // ---------------------------------------------------------------- uniforms
  writeUniforms(cam: Camera, fs: FrameState) {
    const aspect = this.width / this.height;
    const view = cam.viewRot(), proj = cam.proj(aspect);
    const vp = mul4(proj, view), ivp = inv4(vp);
    const eye = cam.eye;
    const buf = new ArrayBuffer(512), f = new Float32Array(buf), u = new Uint32Array(buf);
    const memView = fs.memColors && !fs.organelle;
    f.set(proj, 0); f.set(view, 16); f.set(ivp, 32);
    const pxu = cam.pxPerNmAtUnit(this.height);
    f.set([eye[0], eye[1], eye[2], pxu], 48);
    const n: V3 = [fs.plane[0], fs.plane[1], fs.plane[2]];
    f.set([n[0], n[1], n[2], fs.plane[3]], 52);
    const nv = [view[0] * n[0] + view[4] * n[1] + view[8] * n[2], view[1] * n[0] + view[5] * n[1] + view[9] * n[2], view[2] * n[0] + view[6] * n[1] + view[10] * n[2]];
    f.set([nv[0], nv[1], nv[2], dot(n, eye) - fs.plane[3]], 56);
    f.set([fs.cutOn && !memView ? 1 : 0, fs.slab, Math.min(400, Math.max(20, fs.slab)), performance.now() / 1000], 60);
    f.set([fs.l0px, fs.l1px, fs.minpx, 0.6], 64);
    f.set([this.width, this.height, 1 / this.width, 1 / this.height], 68);
    f.set(cam.frustum(aspect), 72);
    u.set([fs.colorMode, 0, fs.freeHide, fs.highlight ? 1 : 0], 96);
    u.set([fs.selId >>> 0, 0, fs.shaded ? 1 : 0, fs.organelle ? 1 : 0], 100);
    f.set([this.qstep, 0.8, fs.outline, Math.min(window.devicePixelRatio || 1, 2) * fs.renderScale], 104);
    f.set([0, this.outerMem, 0, cam.near()], 108);
    u.set([this.capL0, Math.round(fs.motion * 1000), Math.round(this.modeCap * 1000), memView ? 1 : 0], 112);
    this.device.queue.writeBuffer(this.uni, 0, buf, 0, 464);
  }

  // ---------------------------------------------------------------- frame
  frame(cam: Camera, fs: FrameState, meshes: MeshDraw[], wantStats: boolean) {
    const d = this.device;
    this.writeUniforms(cam, fs);
    const enc = d.createCommandEncoder();
    enc.clearBuffer(this.counters);
    const memView = fs.memColors && !fs.organelle;      // membranes only: whole-cell surfaces instead of tiles
    const drawMolecules = !fs.organelle && !memView && !DEBUG.has('nomol');
    if (drawMolecules) {
      const cp = enc.beginComputePass();
      cp.setBindGroup(0, this.bg.g0);
      const dispatch = (threads: number, params: GPUBuffer, write: (strideX: number) => ArrayBuffer) => {
        const groups = Math.ceil(threads / 64);
        const gx = Math.min(groups, 65535), gy = Math.ceil(groups / gx);
        d.queue.writeBuffer(params, 0, write(gx * 64));
        return [gx, gy];
      };
      if (this.usedInstPages > 0) {
        const [gx, gy] = dispatch(this.usedInstPages * S.PAGE, this.cullParams, sx =>
          new Uint32Array([this.usedInstPages, sx, this.capL0, this.capL1, this.capL2, this.capLip, this.capFree, 0]).buffer);
        cp.setPipeline(this.pipes.cull as GPUComputePipeline); cp.setBindGroup(1, this.bg.cull); cp.dispatchWorkgroups(gx, gy);
      }
      if (this.usedLipPages > 0 && fs.showLipids) {
        const [gx, gy] = dispatch(this.usedLipPages * S.SPAGE, this.lipParams, sx => new Uint32Array([this.usedLipPages, sx, this.capLip, 1]).buffer);
        cp.setPipeline(this.pipes.cullS as GPUComputePipeline); cp.setBindGroup(1, this.bg.cullLip); cp.dispatchWorkgroups(gx, gy);
      }
      if (this.usedFreePages > 0) {
        const [gx, gy] = dispatch(this.usedFreePages * S.SPAGE, this.freeParams, sx => new Uint32Array([this.usedFreePages, sx, this.capFree, 0]).buffer);
        cp.setPipeline(this.pipes.cullS as GPUComputePipeline); cp.setBindGroup(1, this.bg.cullFree); cp.dispatchWorkgroups(gx, gy);
      }
      cp.setPipeline(this.pipes.fin as GPUComputePipeline); cp.setBindGroup(0, this.bg.fin); cp.dispatchWorkgroups(1);
      cp.end();
    }
    const rp = enc.beginRenderPass({
      colorAttachments: [
        { view: this.colorTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.965, g: 0.945, b: 0.906, a: 1 } },
        { view: this.idTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      depthStencilAttachment: { view: this.depthTex.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
    });
    rp.setBindGroup(0, this.bg.g0);
    if (!DEBUG.has('nofill')) { rp.setPipeline(this.pipes.fill as GPURenderPipeline); rp.setBindGroup(1, this.bg.fill); rp.draw(3); }
    // membranes
    if (fs.organelle || memView) {
      rp.setPipeline(this.pipes.mesh as GPURenderPipeline);
      const slot = this.maxSlots;   // reserved uniform slot for organelle meshes
      d.queue.writeBuffer(this.meshUni, slot * 256, new Uint32Array([0, fs.organelle ? 1 : 3, 0, 0]));
      for (const m of this.organelleMeshes) {
        rp.setBindGroup(1, this.bg.mesh, [slot * 256]);
        rp.setVertexBuffer(0, m.vb); rp.setIndexBuffer(m.ib, 'uint32'); rp.drawIndexed(m.nIdx, 1);
      }
    } else if (fs.showMeshes && meshes.length) {
      rp.setPipeline(this.pipes.mesh as GPURenderPipeline);
      for (const m of meshes) {
        rp.setBindGroup(1, this.bg.mesh, [m.slot * 256]);
        rp.setVertexBuffer(0, m.vb); rp.setIndexBuffer(m.ib, 'uint32'); rp.drawIndexed(m.nIdx, 2);
      }
    }
    if (drawMolecules) {
      rp.setPipeline(this.pipes.l2 as GPURenderPipeline); rp.setBindGroup(1, this.bg.l2); rp.drawIndirect(this.args, 32);
      rp.setPipeline(this.pipes.l1 as GPURenderPipeline); rp.setBindGroup(1, this.bg.l1); rp.drawIndirect(this.args, 16);
      rp.setPipeline(this.pipes.l0 as GPURenderPipeline); rp.setBindGroup(1, this.bg.l0); rp.drawIndirect(this.args, 0);
      if (fs.showLipids) { rp.setPipeline(this.pipes.lip as GPURenderPipeline); rp.setBindGroup(1, this.bg.lip); rp.drawIndirect(this.args, 48); }
      rp.setPipeline(this.pipes.fre as GPURenderPipeline); rp.setBindGroup(1, this.bg.fre); rp.drawIndirect(this.args, 64);
      if (this.nTrSph) { rp.setPipeline(this.pipes.tr as GPURenderPipeline); rp.setBindGroup(1, this.bg.tr); rp.draw(6, this.nTrSph); }
      if (this.nTrSeg) { rp.setPipeline(this.pipes.line as GPURenderPipeline); rp.setBindGroup(1, this.bg.line); rp.draw(6, this.nTrSeg); }
    }
    rp.end();
    const out = this.offscreen ? this.offTex! : this.ctx.getCurrentTexture();
    const cpass = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 1, b: 1, a: 1 } }] });
    cpass.setPipeline(this.pipes.comp as GPURenderPipeline); cpass.setBindGroup(0, this.bg.g0); cpass.setBindGroup(1, this.bg.comp); cpass.draw(3);
    cpass.end();
    let pick = null as null | NonNullable<Renderer['pickPending']>;
    if (this.pickPending && !this.pickBusy) {
      pick = this.pickPending; this.pickPending = null;
      const x = Math.max(0, Math.min(this.width - 1, Math.floor(pick.x))), y = Math.max(0, Math.min(this.height - 1, Math.floor(pick.y)));
      d.queue.writeBuffer(this.pickParams, 0, new Uint32Array([x, y, 0, 0]));
      const pp = enc.beginComputePass();
      pp.setPipeline(this.pipes.pick as GPUComputePipeline); pp.setBindGroup(0, this.bg.pick); pp.dispatchWorkgroups(1); pp.end();
      enc.copyBufferToBuffer(this.pickOut, 0, this.pickBuf, 0, 16);
    }
    let doStats = false;
    if (wantStats && !this.statsBusy && drawMolecules) { enc.copyBufferToBuffer(this.counters, 0, this.statsBuf, 0, 32); doStats = true; }
    d.queue.submit([enc.finish()]);
    if (pick) {
      this.pickBusy = true;
      const p = pick;
      this.pickBuf.mapAsync(GPUMapMode.READ).then(() => {
        const r = this.pickBuf.getMappedRange(0, 8);
        const a = new Uint32Array(r)[0], dep = new Float32Array(r)[1];
        this.pickBuf.unmap(); this.pickBusy = false;
        p.resolve({ id: a >>> 0, depth: dep });
      }).catch(() => { this.pickBusy = false; });
    }
    if (doStats) {
      this.statsBusy = true;
      this.statsBuf.mapAsync(GPUMapMode.READ).then(() => {
        const a = new Uint32Array(this.statsBuf.getMappedRange());
        this.stats = { l0: a[0], l1: a[1], l2: a[2], lip: a[3], fre: a[4], ninst: a[5] };
        this.statsBuf.unmap(); this.statsBusy = false;
      }).catch(() => { this.statsBusy = false; });
    }
  }

  pick(x: number, y: number): Promise<{ id: number; depth: number }> {
    return new Promise(res => { this.pickPending = { x, y, resolve: res }; });
  }

  setMeshSlot(slot: number, under: boolean) {
    const a = new ArrayBuffer(16), u = new Uint32Array(a), f = new Float32Array(a);
    u[0] = slot; u[1] = under ? 2 : 0; f[2] = under ? -1.0 : -1.9; f[3] = under ? 1.0 : 1.9;
    this.device.queue.writeBuffer(this.meshUni, slot * 256, a);
  }

  uploadOrganelleMeshes(buf: ArrayBuffer) {
    const d = this.device;
    const h = new Uint32Array(buf, 0, 1)[0];
    const hdr = new Uint32Array(buf, 4, h * 3);
    let off = 4 + h * 12;
    for (const m of this.organelleMeshes) { m.vb.destroy(); m.ib.destroy(); }
    this.organelleMeshes = [];
    let bestExt = -1;
    for (let k = 0; k < h; k++) {
      const mem = hdr[3 * k], nV = hdr[3 * k + 1], nT = hdr[3 * k + 2];
      const V = new Float32Array(buf.slice(off, off + nV * 12)); off += nV * 12;
      const T = new Uint32Array(buf.slice(off, off + nT * 12)); off += nT * 12;
      const N = new Float32Array(nV * 3);
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < nV; i++) { mn = Math.min(mn, V[3 * i]); mx = Math.max(mx, V[3 * i]); }
      if (mx - mn > bestExt) { bestExt = mx - mn; this.outerMem = mem; }   // the outermost surface (seen from inside in the membranes view)
      for (let f = 0; f < nT; f++) {
        const a = T[3 * f], b = T[3 * f + 1], c = T[3 * f + 2];
        const ux = V[3 * b] - V[3 * a], uy = V[3 * b + 1] - V[3 * a + 1], uz = V[3 * b + 2] - V[3 * a + 2];
        const vx = V[3 * c] - V[3 * a], vy = V[3 * c + 1] - V[3 * a + 1], vz = V[3 * c + 2] - V[3 * a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const i of [a, b, c]) { N[3 * i] += nx; N[3 * i + 1] += ny; N[3 * i + 2] += nz; }
      }
      const vb = new Float32Array(nV * 8), vu = new Uint32Array(vb.buffer);
      for (let i = 0; i < nV; i++) {
        const l = Math.hypot(N[3 * i], N[3 * i + 1], N[3 * i + 2]) || 1;
        vb[8 * i] = V[3 * i]; vb[8 * i + 1] = V[3 * i + 1]; vb[8 * i + 2] = V[3 * i + 2]; vu[8 * i + 3] = mem;
        vb[8 * i + 4] = N[3 * i] / l; vb[8 * i + 5] = N[3 * i + 1] / l; vb[8 * i + 6] = N[3 * i + 2] / l;
      }
      const g = d.createBuffer({ size: vb.byteLength, usage: BU.VERTEX | BU.COPY_DST }); d.queue.writeBuffer(g, 0, vb);
      const ib = d.createBuffer({ size: Math.ceil(T.byteLength / 4) * 4, usage: BU.INDEX | BU.COPY_DST }); d.queue.writeBuffer(ib, 0, T);
      this.organelleMeshes.push({ vb: g, ib, nIdx: nT * 3, mem });
    }
  }
  gpuMemoryMB() {
    const b = [this.inst, this.pageOrg, this.beads, this.st, this.clusters, this.list01, this.listL2, this.lipPool, this.lipList, this.freePool, this.freeList, this.meshUni];
    return b.reduce((s, x) => s + x.size, 0) / 1048576 + (this.width * this.height * 12) / 1048576;
  }
}
