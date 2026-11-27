(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))i(s);new MutationObserver(s=>{for(const r of s)if(r.type==="childList")for(const o of r.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&i(o)}).observe(document,{childList:!0,subtree:!0});function t(s){const r={};return s.integrity&&(r.integrity=s.integrity),s.referrerPolicy&&(r.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?r.credentials="include":s.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function i(s){if(s.ep)return;s.ep=!0;const r=t(s);fetch(s.href,r)}})();const Y=256,ee=4096,Re=`
const PAGE: u32 = ${Y}u;
const SPAGE: u32 = ${ee}u;
const INV_SQRT2: f32 = 0.70710678;
// draw-list items (list01 .y): bead / sphere-tree offset in the low OFF_BITS bits, (count - 1) above (count <= 64 beads
// per L0 cluster, <= 16 spheres per L1 item: 6 bits). Jurkat: 26-bit offsets (67 M) instead of the yeast 22 bits (4.2 M).
const OFF_BITS: u32 = 26u;
const OFF_MASK: u32 = 0x3FFFFFFu;
struct U {
  proj: mat4x4f,
  view: mat4x4f,          // rotation only (camera-relative)
  invViewProj: mat4x4f,   // camera-relative clip -> world-relative
  eye: vec4f,             // world eye, w = px per nm at unit view depth
  plane: vec4f,           // world n.xyz, d
  planeV: vec4f,          // view-space n.xyz, sEye = dot(n,eye)-d
  cut: vec4f,             // x enabled, y slab thickness, z fog range, w time
  lod: vec4f,             // x L0 bead px, y L1 instance px, z min px for free spheres/lipids, w protein bead radius
  vp: vec4f,              // width, height, 1/w, 1/h
  frustum: array<vec4f, 6>,  // camera-relative planes, inside: dot(n,p)+w >= 0
  modes: vec4u,           // x colorMode, y unused (region visibility: palette w), z hidden free-sphere kinds, w highlightActive
  sel: vec4u,             // x selected id, y selected type+1, z shaded(1), w organelle mode
  misc: vec4f,            // x QSTEP, y nucleic bead radius, z outline strength, w dpr
  cell: vec4f,            // x unused, y outer membrane code (membranes view), z unused, w near
  caps: vec4u,            // x capL0 (offset of L1 items in list01), y motion amount x 1000, z motion cap nm x 1000,
                          // w membranes-only view (whole-cell surfaces, palette 66 + membrane, no cut)
};
@group(0) @binding(0) var<uniform> u: U;
// palette (data.ts): 0..63 fixed, 64 + membrane (organelle mode), 128 + membrane (membranes view), 192 + label (fill),
// 256 + region (instance region colour; w = flags: 1 visible, 2 membrane-embedded)
@group(0) @binding(5) var<storage, read> palette: array<vec4f>;
const PAL_SURF: u32 = 60u; const PAL_FACE: u32 = 61u; const PAL_BG: u32 = 62u;
const PAL_MEM: u32 = 64u; const PAL_MEMONLY: u32 = 128u; const PAL_LABEL: u32 = 192u; const PAL_REGION: u32 = 256u;
fn regionFlags(r: u32) -> u32 { return u32(palette[PAL_REGION + r].w + 0.5); }

fn sPlaneW(p: vec3f) -> f32 { return dot(u.plane.xyz, p + u.eye.xyz) - u.plane.w; }   // p camera-relative

fn hash32(x0: u32) -> u32 {
  var x = x0; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x;
}
fn unpackColor(c: u32) -> vec3f {
  return vec3f(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u)) / 255.0;
}
fn qrot(q: vec4f, v: vec3f) -> vec3f {   // q = (x,y,z,w)
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn sphereInFrustum(c: vec3f, r: f32) -> bool {
  for (var k = 0; k < 6; k++) { if (dot(u.frustum[k].xyz, c) + u.frustum[k].w < -r) { return false; } }
  return true;
}
fn i16f(x: u32) -> f32 { return f32(bitcast<i32>(x << 16u) >> 16u) / 32767.0 * INV_SQRT2; }
`,ui=`
struct TypeInfo {
  beadOff: u32, beadCount: u32, clusterOff: u32, clusterCount: u32,
  stOff: u32, stCount: u32, br: f32, req: f32,
  color0: u32, color1: u32, flags: u32, plddt: f32,
  modeOff: u32, coefOff: u32, nConf: u32,             // pool-ensemble motion modes (nConf 0: none)
  modColor: u32,                                       // packed colour of the STRING interaction module (0: none)
};
struct Inst { t: u32, region: u32, flags: u32, p: vec3f, q: vec4f, seed: u32 };
@group(0) @binding(1) var<storage, read> inst: array<vec4u>;
@group(0) @binding(2) var<storage, read> pageOrg: array<vec4f>;       // xyz origin (camera-relative is computed), w = bitcast count
@group(0) @binding(3) var<storage, read> types: array<TypeInfo>;
@group(0) @binding(4) var<storage, read> typeFlags: array<u32>;       // bit0 highlight, bit1 hidden, bit2 own class, bit3 no motion

fn decodeInst(i: u32) -> Inst {
  let w = inst[i];
  let org = pageOrg[i / PAGE].xyz;
  var o: Inst;
  o.t = w.x & 0xFFFFu;                     // app word (worker.ts): species 16 | region 8 | flags 6 | qidx 2
  let qi = w.x >> 30u;
  o.region = (w.x >> 16u) & 255u;
  o.flags = (w.x >> 24u) & 63u;
  o.p = org + vec3f(f32(w.y & 0xFFFFu), f32(w.y >> 16u), f32(w.z & 0xFFFFu)) * u.misc.x - u.eye.xyz;
  let a = i16f(w.z >> 16u); let b = i16f(w.w & 0xFFFFu); let c = i16f(w.w >> 16u);
  let big = sqrt(max(0.0, 1.0 - a * a - b * b - c * c));
  // stored order (w,x,y,z) with component qi replaced by 'big'
  var q4: vec4f;
  if (qi == 0u) { q4 = vec4f(big, a, b, c); }
  else if (qi == 1u) { q4 = vec4f(a, big, b, c); }
  else if (qi == 2u) { q4 = vec4f(a, b, big, c); }
  else { q4 = vec4f(a, b, c, big); }
  o.q = vec4f(q4.y, q4.z, q4.w, q4.x);    // -> (x,y,z,w)
  o.seed = hash32(w.y ^ hash32(w.z ^ hash32(w.w)));   // stable per instance (tile-relative pose bits)
  return o;
}

// ---- illustrative motion (u.caps.y = amount x 1000; time u.cut.w in s). Not physics: smooth pseudo-random
// rigid-body wobble per instance plus flexing of low-confidence regions, slowed to about 1 Hz.
fn rnd(s: u32, k: u32) -> f32 { return f32(hash32(s ^ (k * 0x9E3779B9u)) & 0xFFFFu) / 65535.0; }
fn wob(s: u32, k: u32, t: f32) -> f32 {          // smooth signal in [-1, 1]
  return 0.6 * sin(t * (0.5 + rnd(s, k)) + 6.2832 * rnd(s, k + 101u))
       + 0.4 * sin(t * (1.1 + 1.3 * rnd(s, k + 211u)) + 6.2832 * rnd(s, k + 307u));
}
fn qmulq(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
fn animInst(I: Inst, br: f32) -> Inst {
  if (u.caps.y == 0u || (typeFlags[I.t] & 8u) != 0u) { return I; }
  var o = I;
  let a = f32(u.caps.y) / 1000.0; let t = u.cut.w; let s = I.seed;
  let sz = max(br, 2.0);
  var dp = a * 0.35 * sqrt(2.0 / sz) * vec3f(wob(s, 1u, t), wob(s, 2u, t), wob(s, 3u, t));   // nm; larger = slower
  var ax = normalize(vec3f(wob(s, 4u, 0.3 * t), wob(s, 5u, 0.3 * t), wob(s, 6u, 0.3 * t)) + vec3f(1e-3));
  if ((regionFlags(I.region) & 2u) != 0u) {     // membrane-embedded region (regions.json kind membrane): stay in the bilayer
    let nrm = qrot(I.q, vec3f(0.0, 0.0, 1.0));
    dp -= nrm * dot(dp, nrm); ax = nrm;
  }
  let h = 0.5 * a * 0.35 / sz * wob(s, 7u, 0.8 * t);  // half-angle: the rim moves about 0.35 nm
  o.p = I.p + dp;
  o.q = qmulq(vec4f(ax * sin(h), cos(h)), I.q);
  return o;
}
// per-bead flexing in the molecule frame, spatially coherent (~5 nm wavelength); amplitude from pLDDT
fn flexBead(b: vec3f, plddt: f32, s: u32) -> vec3f {
  if (u.caps.y == 0u) { return b; }
  var amp = 0.04;
  if (plddt < 254.5) { amp = mix(0.45, 0.04, clamp((plddt - 50.0) / 40.0, 0.0, 1.0)); }
  let t = u.cut.w * 0.9; let k = 1.25;
  let d = vec3f(sin(dot(b, vec3f(k, 0.4, -0.3)) + t * (0.8 + rnd(s, 11u)) + 6.2832 * rnd(s, 12u)),
                sin(dot(b, vec3f(-0.3, k, 0.5)) + t * (0.7 + rnd(s, 13u)) + 6.2832 * rnd(s, 14u)),
                sin(dot(b, vec3f(0.5, -0.2, k)) + t * (0.9 + rnd(s, 15u)) + 6.2832 * rnd(s, 16u)));
  return b + (f32(u.caps.y) / 1000.0) * amp * d;
}
`,Di=Re+ui+`
struct Counters { l0: atomic<u32>, l1: atomic<u32>, l2: atomic<u32>, lip: atomic<u32>, fre: atomic<u32>, ninst: atomic<u32>, p0: u32, p1: u32 };
struct CullParams { numPages: u32, strideX: u32, capL0: u32, capL1: u32, capL2: u32, capLip: u32, capFree: u32, numSPages: u32 };
struct Cluster { c: vec4f, info: vec4u };   // centre xyz, radius; bead offset, count
@group(1) @binding(0) var<storage, read_write> counters: Counters;
@group(1) @binding(1) var<storage, read_write> list01: array<vec2u>;   // [0,capL0) L0 items, [capL0, capL0+capL1) L1 items
@group(1) @binding(2) var<storage, read_write> listL2: array<u32>;
@group(1) @binding(3) var<uniform> cp: CullParams;
@group(1) @binding(4) var<storage, read> clusters: array<Cluster>;

fn visibleClass(t: TypeInfo, region: u32, tf: u32) -> bool {
  if ((tf & 2u) != 0u) { return false; }
  // bit2: molecule classes with their own Show switch (ribosomes, cytoskeleton, ...) ignore the compartment filter
  if ((tf & 4u) == 0u && (regionFlags(region) & 1u) == 0u) { return false; }
  return true;
}

@compute @workgroup_size(64)
fn cullInstances(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * cp.strideX;
  let page = i / PAGE;
  if (page >= cp.numPages) { return; }
  let cnt = bitcast<u32>(pageOrg[page].w);
  if ((i % PAGE) >= cnt) { return; }
  let I = decodeInst(i);
  let T = types[I.t];
  if (!visibleClass(T, I.region, typeFlags[I.t])) { return; }
  let br = T.br;
  if (u.cut.x > 0.5) {
    let s = sPlaneW(I.p);
    if (s < -br || s - br > u.cut.y) { return; }
  }
  if (!sphereInFrustum(I.p, br)) { return; }
  atomicAdd(&counters.ninst, 1u);
  let dist = max(length(I.p), 0.01);
  let pxPerNm = u.eye.w / dist;
  let beadPx = 2.0 * u.lod.w * pxPerNm;
  if (beadPx >= u.lod.x && T.beadCount > 0u) {
    for (var c = 0u; c < T.clusterCount; c++) {
      let CL = clusters[T.clusterOff + c];
      let cs = CL.c;
      let cc = I.p + qrot(I.q, cs.xyz);
      let r = cs.w;
      if (u.cut.x > 0.5) {
        let s = sPlaneW(cc);
        if (s < -r || s - r > u.cut.y) { continue; }
      }
      if (!sphereInFrustum(cc, r)) { continue; }
      let ci = CL.info;
      let k = atomicAdd(&counters.l0, 1u);
      if (k < cp.capL0) { list01[k] = vec2u(i, ci.x | ((ci.y - 1u) << OFF_BITS)); }
    }
  } else if (br * pxPerNm >= u.lod.y && T.stCount > 0u) {
    let n = T.stCount;
    var o = 0u;
    loop {
      if (o >= n) { break; }
      let m = min(16u, n - o);
      let k = atomicAdd(&counters.l1, 1u);
      if (k < cp.capL1) { list01[cp.capL0 + k] = vec2u(i, (T.stOff + o) | ((m - 1u) << OFF_BITS)); }
      o += 16u;
    }
  } else {
    let k = atomicAdd(&counters.l2, 1u);
    if (k < cp.capL2) { listL2[k] = i; }
  }
}
`,ji=Re+`
struct Counters { l0: atomic<u32>, l1: atomic<u32>, l2: atomic<u32>, lip: atomic<u32>, fre: atomic<u32>, ninst: atomic<u32>, p0: u32, p1: u32 };
struct SParams { numPages: u32, strideX: u32, cap: u32, isLipid: u32 };
@group(1) @binding(0) var<storage, read_write> counters: Counters;
@group(1) @binding(1) var<storage, read> spool: array<vec4f>;
@group(1) @binding(2) var<storage, read> spages: array<vec4u>;      // x count, y tile slot, z visible flag
@group(1) @binding(3) var<storage, read_write> slist: array<u32>;
@group(1) @binding(4) var<uniform> sp: SParams;

fn freeRadius(kind: u32, w: u32) -> f32 {
  if (kind == 7u) { return f32((w >> 9u) & 1023u) * 0.1; }   // whole-cell overview stand-in: radius in the record
  if (kind == 0u) { return 0.6; }   // mRNA nucleotide
  if (kind == 1u) { return 1.0; }   // linker DNA (2 bp per bead)
  if (kind == 5u) { return 0.45; }  // disordered protein residue (FG repeats)
  return 0.6;                        // mannan, pre-rRNA
}

@compute @workgroup_size(64)
fn cullSpheres(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * sp.strideX;
  let page = i / SPAGE;
  if (page >= sp.numPages) { return; }
  let pg = spages[page];
  if (pg.z == 0u || (i % SPAGE) >= pg.x) { return; }
  let rec = spool[i];
  let p = rec.xyz - u.eye.xyz;
  var r = 2.6;
  if (sp.isLipid == 0u) {
    let kind = bitcast<u32>(rec.w) & 15u;
    if (kind == 15u) { return; }                 // stand-in hidden: its tile's molecules are loaded (tiles.ts Overview)
    if (((u.modes.z >> kind) & 1u) != 0u) { return; }
    r = freeRadius(kind, bitcast<u32>(rec.w));
  }
  if (u.cut.x > 0.5) {
    let s = sPlaneW(p);
    if (s < -r || s - r > u.cut.y) { return; }
  }
  if (!sphereInFrustum(p, r)) { return; }
  let px = r * u.eye.w / max(length(p), 0.01);
  if (px < u.lod.z) { return; }
  if (sp.isLipid == 1u) {
    let k = atomicAdd(&counters.lip, 1u);
    if (k < sp.cap) { slist[k] = i; }
  } else {
    let k = atomicAdd(&counters.fre, 1u);
    if (k < sp.cap) { slist[k] = i; }
  }
}
`,Hi=`
struct Counters { l0: u32, l1: u32, l2: u32, lip: u32, fre: u32, ninst: u32, p0: u32, p1: u32 };
struct Caps { capL0: u32, capL1: u32, capL2: u32, capLip: u32, capFree: u32, a: u32, b: u32, c: u32 };
@group(0) @binding(0) var<storage, read> counters: Counters;
@group(0) @binding(1) var<storage, read_write> args: array<u32>;
@group(0) @binding(2) var<uniform> caps: Caps;
@compute @workgroup_size(1)
fn main() {
  // drawIndirect args: vertexCount, instanceCount, firstVertex, firstInstance
  args[0] = 384u; args[1] = min(counters.l0, caps.capL0); args[2] = 0u; args[3] = 0u;
  args[4] = 96u;  args[5] = min(counters.l1, caps.capL1); args[6] = 0u; args[7] = 0u;
  args[8] = 6u;   args[9] = min(counters.l2, caps.capL2); args[10] = 0u; args[11] = 0u;
  args[12] = 18u; args[13] = min(counters.lip, caps.capLip); args[14] = 0u; args[15] = 0u;
  args[16] = 6u;  args[17] = min(counters.fre, caps.capFree); args[18] = 0u; args[19] = 0u;
}
`,Bt=`
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) vpos: vec3f,
  @location(1) @interpolate(flat) center: vec3f,
  @location(2) @interpolate(flat) radius: f32,
  @location(3) @interpolate(flat) color: vec3f,
  @location(4) @interpolate(flat) id: u32,
};
struct FOut {
  @location(0) color: vec4f,
  @location(1) id: u32,
  @builtin(frag_depth) depth: f32,
};
const ID_INST: u32 = 0x40000000u;
const ID_LIPID: u32 = 0x80000000u;
const ID_FREE: u32 = 0xC0000000u;

fn emitQuad(cw: vec3f, r: f32, corner: u32, color: vec3f, id: u32) -> VOut {
  var o: VOut;
  let cv = (u.view * vec4f(cw, 1.0)).xyz;
  let d = length(cv);
  o.center = cv; o.radius = r; o.color = color; o.id = id;
  if (r <= 0.0 || d <= r * 1.02 || cv.z > -u.cell.w) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0); o.vpos = vec3f(0.0); return o;
  }
  let k = d / sqrt(d * d - r * r);
  var off = vec2f(-1.0, -1.0);
  if (corner == 1u || corner == 4u) { off = vec2f(1.0, -1.0); }
  else if (corner == 2u || corner == 3u) { off = vec2f(-1.0, 1.0); }
  else if (corner == 5u) { off = vec2f(1.0, 1.0); }
  // billboard perpendicular to the view ray through the centre
  let fwd = cv / d;
  var up0 = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.99) { up0 = vec3f(1.0, 0.0, 0.0); }
  let right = normalize(cross(fwd, up0));
  let up = cross(right, fwd);
  let vp = cv + (right * off.x + up * off.y) * r * k * 1.05;
  o.vpos = vp;
  o.pos = u.proj * vec4f(vp, 1.0);
  return o;
}

fn shadeFrag(in: VOut) -> FOut {
  var o: FOut;
  let rd = normalize(in.vpos);
  let b = dot(rd, in.center);
  let c = dot(in.center, in.center) - in.radius * in.radius;
  var h = b * b - c;
  if (h < 0.0) { discard; }
  h = sqrt(h);
  var t = b - h;
  let t1 = b + h;
  var nrm = (rd * t - in.center) / in.radius;
  var cap = false;
  if (u.cut.x > 0.5) {
    let dn = dot(u.planeV.xyz, rd);
    let s0 = u.planeV.w + t * dn;
    if (s0 < 0.0) {
      if (dn <= 0.0) { discard; }
      let tp = -u.planeV.w / dn;
      if (tp > t1) { discard; }
      t = tp; nrm = -u.planeV.xyz; cap = true;
    }
    if (u.planeV.w + t * dn > u.cut.y) { discard; }
  }
  if (t < u.cell.w) { discard; }
  let p = rd * t;
  let clip = u.proj * vec4f(p, 1.0);
  o.depth = clip.z / clip.w;
  var shade = 1.0;
  // spheres a few pixels wide show only their bright, front-facing centre: fade to the sphere's mean shade there,
  // so residue beads (L0) are not lighter than the larger spheres of the coarser levels at the LOD boundary
  let rpx = in.radius * u.eye.w / max(length(in.center), 1e-3);
  let sharp = smoothstep(0.75, 3.0, rpx);
  if (u.sel.z == 1u) {
    let l = normalize(vec3f(0.35, 0.45, 1.0));
    shade = 0.45 + 0.55 * max(dot(nrm, l), 0.0) + 0.12 * pow(max(nrm.z, 0.0), 8.0);
    shade = mix(0.80, shade, sharp);       // mean over the projected disc: n.l ~ 2/3 l.z, pow(n.z, 8) ~ 1/5
  } else {
    shade = mix(0.977, 0.93 + 0.07 * max(nrm.z, 0.0), sharp);
  }
  if (cap) { shade = 0.9; }
  o.color = vec4f(in.color * shade, 1.0);
  o.id = in.id;
  return o;
}
`,Wi=`

fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3f {
  let k = vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0);
  let p = abs(fract(vec3f(h) + k) * 6.0 - 3.0);
  return v * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), s);
}
fn viridis(t0: f32) -> vec3f {
  let t = clamp(t0, 0.0, 1.0);
  let c0 = vec3f(0.2777, 0.0054, 0.3340); let c1 = vec3f(0.1050, 1.4046, 1.3846);
  let c2 = vec3f(-0.3308, 0.2148, 0.0950); let c3 = vec3f(-4.6342, -5.7991, -19.3324);
  let c4 = vec3f(6.2282, 14.1799, 56.6906); let c5 = vec3f(4.7763, -13.7451, -65.3530);
  let c6 = vec3f(-5.4355, 4.6459, 26.3124);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}
fn plddtColor(p: f32) -> vec3f {
  if (p > 90.0) { return vec3f(0.0, 0.325, 0.839); }
  if (p > 70.0) { return vec3f(0.396, 0.796, 0.953); }
  if (p > 50.0) { return vec3f(1.0, 0.859, 0.075); }
  return vec3f(1.0, 0.490, 0.271);
}
// kind: 0 protein bead, 1 nucleic-acid bead, 2 coarse (sphere tree / single sphere)
fn instColor(I: Inst, T: TypeInfo, kind: u32, plddt: f32, id: u32) -> vec3f {
  let mode = u.modes.x;
  let hj = f32(hash32(I.t * 2654435761u + 17u) & 1023u) / 1023.0;
  var c: vec3f;
  if (mode == 0u) {          // Goodsell compartment palette with per-type lightness jitter
    if (T.color0 != 0u) {
      c = unpackColor(T.color0);
      if (kind == 1u && T.color1 != 0u) { c = unpackColor(T.color1); }
    } else { c = palette[PAL_REGION + I.region].xyz; }
    c = c * (0.93 + 0.14 * hj);
  } else if (mode == 1u) {   // structure source
    if ((T.flags & 1u) != 0u) { c = vec3f(0.30, 0.55, 0.85); } else { c = vec3f(0.96, 0.66, 0.30); }
    if (kind == 1u) { c = c * 0.8; }
  } else if (mode == 2u) {   // pLDDT
    var p = plddt;
    if (kind == 2u) { p = T.plddt; }
    if (p > 100.5 || p < 0.0) { c = vec3f(0.72, 0.72, 0.72); } else { c = plddtColor(p); }
  } else if (mode == 3u) {   // abundance (log10 copies, 1 .. 1e6)
    c = viridis(log(max(f32(T.flags >> 8u), 1.0)) / log(10.0) / 6.0);
  } else if (mode == 4u) {   // random per type
    c = hsv2rgb(hj, 0.55, 0.92);
  } else if (mode == 6u) {   // STRING interaction module
    if (T.modColor != 0u) { c = unpackColor(T.modColor); } else { c = vec3f(0.82, 0.82, 0.80); }
    if (kind == 1u) { c = c * 0.8; }
  } else {                    // compartment only
    c = palette[PAL_REGION + I.region].xyz;
  }
  if (u.modes.w == 1u && (typeFlags[I.t] & 1u) == 0u) {
    let g = dot(c, vec3f(0.3, 0.59, 0.11));
    c = mix(vec3f(g), vec3f(0.93), 0.72);
  }
  if (u.sel.x == id && id != 0u) { c = mix(c, vec3f(1.0, 0.92, 0.2), 0.55); }
  return c;
}
`,zt=Re+ui+Bt+Wi,Ki=zt+`
@group(1) @binding(0) var<storage, read> beads: array<vec4f>;     // xyz, w = bitcast(kind | plddt<<8)
@group(1) @binding(1) var<storage, read> list01: array<vec2u>;
@group(1) @binding(2) var<storage, read> modes: array<u32>;      // per bead 4 x (int8 xyz), then f32 conformer paths
const N_MODES: u32 = 4u;
fn i8x(w: u32, sh: u32) -> f32 { return f32(bitcast<i32>(w << (24u - sh)) >> 24u); }
fn coefAt(T: TypeInfo, k: u32, j: u32) -> f32 { return bitcast<f32>(modes[T.coefOff + (k % T.nConf) * N_MODES + j]); }
// displacement of bead 'local' along the protein's pool-ensemble path: Catmull-Rom through the sampled conformers'
// mode coefficients, about 2 s per conformer, each instance at its own phase
fn modeDisp(T: TypeInfo, local: u32, s: u32) -> vec3f {
  let n = T.nConf;
  let ph = u.cut.w * 0.5 + rnd(s, 21u) * f32(n);
  let k = u32(floor(ph)) % n; let f = fract(ph);
  let f2 = f * f; let f3 = f2 * f;
  var d = vec3f(0.0);
  for (var j = 0u; j < N_MODES; j++) {
    let p0 = coefAt(T, k + n - 1u, j); let p1 = coefAt(T, k, j); let p2 = coefAt(T, k + 1u, j); let p3 = coefAt(T, k + 2u, j);
    let c = 0.5 * (2.0 * p1 + (p2 - p0) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2 + (3.0 * p1 - p0 - 3.0 * p2 + p3) * f3);
    let w = modes[T.modeOff + local * N_MODES + j];
    d += c * vec3f(i8x(w, 0u), i8x(w, 8u), i8x(w, 16u));
  }
  let cap = f32(u.caps.z) / 1000.0;     // nm, largest excursion of one bead (modes.json "cap"; 0 = none)
  let L = length(d);
  if (cap > 0.0 && L > cap) { d *= cap / L; }
  return d * f32(u.caps.y) / 1000.0;
}
@vertex
fn vsL0(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let item = list01[ii];
  let j = vi / 6u; let corner = vi % 6u;
  let cnt = (item.y >> OFF_BITS) + 1u;
  if (j >= cnt) { var o: VOut; o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let I0 = decodeInst(item.x); let T = types[I0.t];
  let I = animInst(I0, T.br);
  let b = beads[(item.y & OFF_MASK) + j];
  let bw = bitcast<u32>(b.w);
  let kind = bw & 255u;
  var r = u.lod.w;
  if (kind == 1u) { r = u.misc.y; }
  let id = ID_INST | item.x;
  let pl = f32((bw >> 8u) & 255u);
  let col = instColor(I, T, kind, pl, id);
  var bp = b.xyz;
  if (u.caps.y > 0u && T.nConf > 0u) { bp = b.xyz + modeDisp(T, (item.y & OFF_MASK) + j - T.beadOff, I.seed); }
  else if ((typeFlags[I.t] & 8u) == 0u) { bp = flexBead(b.xyz, select(255.0, pl, kind == 0u), I.seed); }
  return emitQuad(I.p + qrot(I.q, bp), r, corner, col, id);
}
@fragment
fn fsMain(in: VOut) -> FOut { return shadeFrag(in); }
`,Vi=zt+`
@group(1) @binding(0) var<storage, read> stSpheres: array<vec4f>; // xyz r
@group(1) @binding(1) var<storage, read> list01: array<vec2u>;
@vertex
fn vsL1(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let item = list01[u.caps.x + ii];
  let j = vi / 6u; let corner = vi % 6u;
  let cnt = (item.y >> OFF_BITS) + 1u;
  if (j >= cnt) { var o: VOut; o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let I0 = decodeInst(item.x); let T = types[I0.t];
  let I = animInst(I0, T.br);
  let s = stSpheres[(item.y & OFF_MASK) + j];
  let id = ID_INST | item.x;
  // sphere-tree spheres are padded for collision; shrink slightly for display
  return emitQuad(I.p + qrot(I.q, s.xyz), s.w * 0.9, corner, instColor(I, T, 2u, -1.0, id), id);
}
@fragment
fn fsMain(in: VOut) -> FOut { return shadeFrag(in); }
`,Yi=zt+`
@group(1) @binding(0) var<storage, read> listL2: array<u32>;
@vertex
fn vsL2(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let i = listL2[ii];
  let I0 = decodeInst(i); let T = types[I0.t];
  let I = animInst(I0, T.br);
  let id = ID_INST | i;
  return emitQuad(I.p, T.req, vi, instColor(I, T, 2u, -1.0, id), id);
}
@fragment
fn fsMain(in: VOut) -> FOut { return shadeFrag(in); }
`,Xi=Re+Bt+`
@group(1) @binding(0) var<storage, read> spool: array<vec4f>;
@group(1) @binding(1) var<storage, read> spages: array<vec4u>;
@group(1) @binding(2) var<storage, read> slist: array<u32>;

fn octDecode(e: vec2f) -> vec3f {
  var v = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) { let xy = (1.0 - abs(v.yx)) * select(vec2f(-1.0), vec2f(1.0), v.xy >= vec2f(0.0)); v = vec3f(xy, v.z); }
  return normalize(v);
}

// lipid record: xyz = midsurface point, w = bits: oct normal (8+8), class (3) <<16, leaflet sign <<19, membrane (4) <<20
@vertex
fn vsLipid(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let i = slist[ii];
  let rec = spool[i];
  let w = bitcast<u32>(rec.w);
  let n0 = octDecode(vec2f(f32(w & 255u), f32((w >> 8u) & 255u)) / 127.5 - 1.0);
  let cls = (w >> 16u) & 7u;
  let sgn = select(-1.0, 1.0, ((w >> 19u) & 1u) == 1u);
  let mem = (w >> 20u) & 15u;
  let j = vi / 6u; let corner = vi % 6u;
  var off = 1.95; var r = 0.55;
  var col = palette[40u].xyz;                  // head
  if (cls == 5u) {                              // ergosterol: two beads, rigid ring system
    col = palette[42u].xyz;
    if (j == 0u) { off = 1.55; r = 0.45; } else if (j == 1u) { off = 0.75; r = 0.45; } else { r = 0.0; }
  } else {
    col = palette[32u + cls].xyz;
    if (j == 1u) { off = 1.25; r = 0.45; col = palette[41u].xyz; }
    else if (j == 2u) { off = 0.55; r = 0.45; col = palette[41u].xyz; }
  }
  let slot = spages[i / SPAGE].y;
  let id = ID_LIPID | (slot << 5u) | (mem << 1u) | select(0u, 1u, sgn > 0.0);
  let p = rec.xyz - u.eye.xyz + n0 * sgn * off;
  return emitQuad(p, r, corner, col, id);
}

// free sphere record: xyz, w = bits: kind (4) | chain (15) << 4
@vertex
fn vsFree(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let i = slist[ii];
  let rec = spool[i];
  let w = bitcast<u32>(rec.w);
  let kind = w & 15u;
  let chain = (w >> 4u) & 0x7FFFu;
  var r = 0.6;
  if (kind == 1u) { r = 1.0; } else if (kind == 2u) { r = 0.75; } else if (kind == 5u) { r = 0.45; }
  let hj = f32(hash32(chain * 747796405u + kind) & 255u) / 255.0;
  var col = palette[48u + min(kind, 6u)].xyz * (0.94 + 0.12 * hj);
  if (kind == 7u) {                              // overview stand-in: radius and instance region in the record
    r = f32((w >> 9u) & 1023u) * 0.1;
    let h2 = f32(hash32(bitcast<u32>(rec.x) ^ hash32(bitcast<u32>(rec.z))) & 255u) / 255.0;
    col = palette[PAL_REGION + ((w >> 4u) & 31u)].xyz * (0.9 + 0.2 * h2);
  }
  let slot = spages[i / SPAGE].y;
  let id = ID_FREE | ((slot & 0xFFFu) << 18u) | ((kind & 7u) << 15u) | chain;
  var p = rec.xyz;
  if (u.caps.y > 0u && kind != 7u) {     // illustrative motion: FG repeats and mRNA most, wall polysaccharides and DNA little
    var amps = array<f32, 6>(0.25, 0.08, 0.06, 0.25, 0.25, 0.5);
    let amp = amps[min(kind, 5u)] * f32(u.caps.y) / 1000.0;
    let t = u.cut.w; let ph = 6.2832 * f32(hash32(chain * 2654435761u + kind) & 1023u) / 1023.0;
    p += amp * vec3f(sin(dot(p, vec3f(0.9, 0.3, -0.2)) + 1.1 * t + ph), sin(dot(p, vec3f(-0.2, 0.9, 0.4)) + 0.9 * t + 2.0 * ph),
                     sin(dot(p, vec3f(0.3, -0.3, 0.9)) + 1.3 * t + 3.0 * ph));
  }
  return emitQuad(p - u.eye.xyz, r, vi, col, id);
}

@fragment
fn fsMain(in: VOut) -> FOut { return shadeFrag(in); }
`,Qi=Re+Bt+`
@group(1) @binding(0) var<storage, read> tsph: array<vec4f>;
@vertex
fn vsTracer(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let a = tsph[2u * ii]; let b = tsph[2u * ii + 1u];
  return emitQuad(a.xyz - u.eye.xyz, a.w, vi, b.xyz, bitcast<u32>(b.w));
}
@fragment
fn fsMain(in: VOut) -> FOut { return shadeFrag(in); }
`,Zi=Re+`
@group(1) @binding(0) var<storage, read> tseg: array<vec4f>;
struct LOut { @builtin(position) pos: vec4f, @location(0) color: vec3f, @location(1) pv: vec3f, @location(2) @interpolate(flat) clip: f32 };
struct LF { @location(0) color: vec4f, @location(1) id: u32 };
@vertex
fn vsLine(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LOut {
  let A = tseg[3u * ii]; let B = tseg[3u * ii + 1u];
  var o: LOut; o.color = tseg[3u * ii + 2u].xyz; o.clip = B.w;
  var a = (u.view * vec4f(A.xyz - u.eye.xyz, 1.0)).xyz;
  var b = (u.view * vec4f(B.xyz - u.eye.xyz, 1.0)).xyz;
  let zn = -u.cell.w * 1.01;
  if (a.z > zn && b.z > zn) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  if (a.z > zn) { a = mix(b, a, (zn - b.z) / (a.z - b.z)); }
  if (b.z > zn) { b = mix(a, b, (zn - a.z) / (b.z - a.z)); }
  let pa = u.proj * vec4f(a, 1.0); let pb = u.proj * vec4f(b, 1.0);
  var dir = (pb.xy / pb.w - pa.xy / pa.w) * u.vp.xy;
  if (dot(dir, dir) < 1e-8) { dir = vec2f(1.0, 0.0); }
  let nrm = normalize(vec2f(-dir.y, dir.x)) * A.w * u.misc.w * u.vp.zw;   // half width in NDC
  let c = vi % 6u;
  let useB = c == 1u || c == 4u || c == 5u;
  let side = select(-1.0, 1.0, c == 2u || c == 3u || c == 5u);
  let p = select(pa, pb, useB);
  o.pv = select(a, b, useB);
  o.pos = vec4f(p.xy + nrm * side * p.w, p.z, p.w);
  return o;
}
@fragment
fn fsLine(in: LOut) -> LF {
  if (in.clip > 0.5 && u.cut.x > 0.5) {
    let s = u.planeV.w + dot(u.planeV.xyz, in.pv);
    if (s < 0.0 || s > u.cut.y) { discard; }
  }
  var o: LF; o.color = vec4f(in.color, 1.0); o.id = 0u;
  return o;
}
`,Ji=Re+`
struct MP { slot: u32, organelle: u32, offset0: f32, offset1: f32 };   // organelle: 0 tile, 1 organelle mode, 2 under lipids, 3 membranes only
@group(1) @binding(0) var<uniform> mp: MP;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) prel: vec3f,
  @location(1) nrm: vec3f,
  @location(2) @interpolate(flat) mem: u32,
  @location(3) @interpolate(flat) leaf: u32,
};
@vertex
fn vsMesh(@location(0) p: vec4f, @location(1) n: vec4f, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let mem = bitcast<u32>(p.w);
  let off = select(mp.offset0, mp.offset1, ii == 1u);    // two leaflets (Jurkat: no lipid-droplet monolayer)
  let pr = p.xyz + n.xyz * off - u.eye.xyz;
  o.prel = pr; o.nrm = n.xyz; o.mem = mem; o.leaf = ii;
  o.pos = u.proj * (u.view * vec4f(pr, 1.0));
  return o;
}
struct FOut { @location(0) color: vec4f, @location(1) id: u32 };
@fragment
fn fsMesh(in: VOut, @builtin(front_facing) ff: bool) -> FOut {
  var o: FOut;
  let outside = !ff;      // membrane triangles are wound inward (tiles3d marching cubes): the outside is the back face
  // membranes only: the plasma membrane is seen from inside (its outside dropped) so the organelles show through it
  if (mp.organelle == 3u && in.mem == u32(u.cell.y) && outside) { discard; }
  if (u.cut.x > 0.5) {
    let s = sPlaneW(in.prel);
    if (s < 0.0 || (mp.organelle != 1u && s > u.cut.y)) { discard; }
  }
  let vn = normalize((u.view * vec4f(in.nrm, 0.0)).xyz);
  var c = palette[41u].xyz;
  if (mp.organelle == 1u) { c = palette[PAL_MEM + in.mem].xyz; } else if (mp.organelle == 3u) { c = palette[PAL_MEMONLY + in.mem].xyz; }
  let l = abs(vn.z);
  var shade = 0.82 + 0.18 * l;
  if (mp.organelle == 1u || mp.organelle == 3u) { shade = 0.55 + 0.45 * l; if (!outside) { shade *= 0.8; } }
  o.color = vec4f(c * shade, 1.0);
  o.id = 0x80000000u | (mp.slot << 5u) | (in.mem << 1u) | in.leaf;
  return o;
}
`,es=["G_N","G_CRISTAE","G_FACE","G_ZFACE","G_SPECKLE","G_GOLGI_CIS","S_CR_W","S_CR_GAP","S_CR_JW","S_CIS_CLR","S_CR_RIM","TH","MROW","RROW","FBROW","K_FIELD","K_WALL","K_SHELL_PORES","K_INNER_CRISTAE","K_GOLGI_CIS","K_PRIMS","K_PRIMS_DIFF","K_SMOOTH_UNION","T_MEM","T_FIELD","T_FACE","T_PORE","T_SPECKLE","T_SHAPE","OP_LT","A_SPHERE","P_SPHERE","P_CAPSULE","P_PILL","P_CERPATCH","P_SLOT","P_TORUS"];function ts(n){return`
${es.map(t=>{if(n[t]===void 0)throw new Error(`geometry constant ${t} missing`);return`const ${t}: u32 = ${n[t]|0}u;`}).join(`
`)}
struct Prim { q0: vec4f, q1: vec4f, tc: vec4u };      // 8 params, type, class
struct Geo {
  bboxLo: vec4f, bboxHi: vec4f,       // cell bounding box (rays are clipped to it)
  gridLo: vec4f, gridCs: vec4f,       // acceleration grid origin (w = cells per axis), cell size
  tg0: vec4f, tg1: vec4f, tg2: vec4f, // tile-state grid: origin xyz + tile nm; min ijk; dims
  info: vec4u,                        // n membranes, domain membrane (0xFFFFFFFF none), domain row mask, membrane rows
  info2: vec4u,                       // label rows, exterior code, outside-imaged-volume code (0xFFFFFFFF none), band mask
  tabs: vec4u,                        // tables offset, label rows offset, data offset, fallback rows offset
};
@group(1) @binding(0) var<storage, read> prims: array<Prim>;
@group(1) @binding(1) var<storage, read> pores: array<vec4f>;      // per pore: centre, unit axis
@group(1) @binding(2) var<storage, read> gridOff: array<u32>;      // prim list offsets (n^3+1), then pore list offsets
@group(1) @binding(3) var<storage, read> gridIdx: array<u32>;
@group(1) @binding(4) var<uniform> geo: Geo;
@group(1) @binding(5) var<storage, read> tileState: array<u32>;    // bit0 molecules loaded, bit1 stand-ins
@group(1) @binding(6) var<storage, read> G: array<f32>;            // cellgeom_eval_v1 vector (geometry_G.bin)

const NONE: u32 = 0xFFFFFFFFu;
fn gu(k: u32) -> u32 { return u32(G[k]); }
fn gi(k: u32) -> i32 { return i32(round(G[k])); }
fn gofs(k: u32) -> u32 { return bitcast<u32>(G[k]); }   // offset slots (geometry.ts offsetSlots): u32 bit patterns
fn fieldO(p: vec3f, o: u32) -> f32 {
  let h = G[o + 3u]; let B = gu(o + 7u);
  let f = (p - vec3f(G[o], G[o + 1u], G[o + 2u])) / h;
  let nb = vec3u(gu(o + 4u), gu(o + 5u), gu(o + 6u));
  if (any(f < vec3f(0.0)) || any(f >= vec3f(nb * B))) { return G[o + 9u]; }
  let ii = vec3u(floor(f)); let bb = ii / B;
  let bi = gi(gofs(o + 10u) + (bb.x * nb.y + bb.y) * nb.z + bb.z);
  if (bi == -1) { return -G[o + 8u]; }
  if (bi == -2) { return G[o + 9u]; }
  let n1 = B + 1u; let sx = n1 * n1; let sy = n1;
  let t = f - vec3f(ii); let l = ii - bb * B;
  let b = gofs(o + 11u) + u32(bi) * n1 * n1 * n1 + (l.x * n1 + l.y) * n1 + l.z;
  let c00 = mix(G[b], G[b + sx], t.x); let c01 = mix(G[b + 1u], G[b + sx + 1u], t.x);
  let c10 = mix(G[b + sy], G[b + sx + sy], t.x); let c11 = mix(G[b + sy + 1u], G[b + sx + sy + 1u], t.x);
  return mix(mix(c00, c10, t.y), mix(c01, c11, t.y), t.z);
}
fn analytic(p: vec3f, kind: u32, o: u32) -> f32 {
  let d = p - vec3f(G[o], G[o + 1u], G[o + 2u]);
  if (kind == A_SPHERE) { return length(d) - G[o + 3u]; }
  let ax = vec3f(G[o + 3u], G[o + 4u], G[o + 5u]);
  let l = vec3f(dot(vec3f(G[o + 6u], G[o + 7u], G[o + 8u]), d), dot(vec3f(G[o + 9u], G[o + 10u], G[o + 11u]), d),
                dot(vec3f(G[o + 12u], G[o + 13u], G[o + 14u]), d)) / ax;
  let k0 = length(l); let k1 = length(l / ax);
  if (k1 < 1e-12) { return -min(ax.x, min(ax.y, ax.z)); }
  return k0 * (k0 - 1.0) / k1;
}
fn fval(p: vec3f, k: u32) -> f32 {
  let nfb = gu(geo.tabs.x + 3u);
  for (var j = 0u; j < nfb; j++) {
    let q = geo.tabs.w + FBROW * j;
    if (gu(q) == k) { return analytic(p, gu(q + 1u), geo.tabs.z + gu(q + 2u)); }
  }
  return fieldO(p, G_N + 1u + 12u * k);
}
fn faceDist(p: vec3f) -> f32 { if (G[G_FACE] > 0.0) { return p.z - G[G_ZFACE]; } return 1e9; }
fn gridCell(p: vec3f) -> u32 {
  let n = u32(geo.gridLo.w);
  let g = clamp(vec3i(floor((p - geo.gridLo.xyz) / geo.gridCs.xyz)), vec3i(0), vec3i(i32(n) - 1));
  return (u32(g.x) * n + u32(g.y)) * n + u32(g.z);
}
fn inPore(p: vec3f, rc: f32, zwin: f32, cell: u32) -> i32 {
  let n = u32(geo.gridLo.w); let n3 = n * n * n;
  let a = gridOff[n3 + 1u + cell]; let b = gridOff[n3 + 1u + cell + 1u];
  for (var k = a; k < b; k++) {
    let i = gridIdx[k];
    let v = p - pores[2u * i].xyz; let nn = pores[2u * i + 1u].xyz;
    let z = dot(v, nn);
    if (z < -zwin || z > zwin) { continue; }
    let r = v - z * nn;
    if (dot(r, r) < rc * rc) { return i32(i); }
  }
  return -1;
}
fn inSpeckle(p: vec3f) -> bool {
  let o = gofs(G_SPECKLE); let n = gu(o);
  for (var k = 0u; k < n; k++) {
    let q = o + 1u + 4u * k; let v = p - vec3f(G[q], G[q + 1u], G[q + 2u]);
    if (dot(v, v) < G[q + 3u] * G[q + 3u]) { return true; }
  }
  return false;
}
fn cristaLumen(p: vec3f, b: f32) -> f32 {
  let o = gofs(G_CRISTAE); let n = gu(o); let h = G[o + 4u];
  let dims = vec3i(gi(o + 5u), gi(o + 6u), gi(o + 7u));
  let c = vec3i(floor((p - vec3f(G[o + 1u], G[o + 2u], G[o + 3u])) / h));
  if (any(c < vec3i(0)) || any(c >= dims)) { return 1e9; }
  let k = gi(o + 8u + 12u * n + u32((c.x * dims.y + c.y) * dims.z + c.z));
  if (k < 0) { return 1e9; }
  let q = o + 8u + 12u * u32(k);
  if (G[q + 11u] == 0.0) { return 1e9; }
  let S = G[q + 4u];
  let t = dot(vec3f(G[q], G[q + 1u], G[q + 2u]), p) - G[q + 3u];
  let uu = t - S * floor(t / S + 0.5);
  let slab = abs(uu) - G[S_CR_W];
  var lam = max(slab, b + G[S_CR_GAP]);
  if (G[S_CR_RIM] > 0.0) {
    let r = min(G[S_CR_RIM], G[S_CR_W]); let e = b + G[S_CR_GAP];
    let ra = max(slab + r, 0.0); let rb = max(e + r, 0.0);
    lam = min(-r, lam) + sqrt(ra * ra + rb * rb);
  }
  let w = abs(dot(vec3f(G[q + 5u], G[q + 6u], G[q + 7u]), p - vec3f(G[q + 8u], G[q + 9u], G[q + 10u]))) - G[S_CR_JW];
  return min(lam, max(slab, w));
}
fn golgi(p: vec3f, k: u32, other: f32) -> f32 {
  var g = fieldO(p, G_N + 1u + 12u * k);
  if (gofs(G_GOLGI_CIS) > 0u && g < 0.0 && other > G[S_CIS_CLR]) {
    let o = gofs(G_GOLGI_CIS); let W = G[o]; let S = G[o + 1u];
    let v = -fieldO(p, o + 2u) - W;
    let w = v - S * floor(v / S + 0.5);
    g = max(g, abs(w) - W);
  }
  return g;
}
fn shellPores(p: vec3f, k: u32, pw: f32, pr: f32, zwin: f32, foff: f32, cell: u32) -> f32 {
  let hp = fval(p, k) + foff;
  var d = abs(hp) - 0.5 * pw;
  let rc = pr + 0.5 * pw;
  if (abs(hp) < rc + pw) {
    let j = inPore(p, rc, zwin, cell);
    if (j >= 0) {
      let v = p - pores[2u * u32(j)].xyz; let z = dot(v, pores[2u * u32(j) + 1u].xyz);
      let rho = sqrt(max(dot(v, v) - z * z, 0.0));
      d = sqrt((rho - rc) * (rho - rc) + hp * hp) - 0.5 * pw;
    }
  }
  return d;
}
fn sdfCer(p: vec3f, P: Prim, pm: f32, Rp: f32) -> f32 {
  let r = length(p);
  let c = clamp(dot(p, P.q0.xyz) / max(r, 1e-9), -1.0, 1.0);
  let s = max(acos(c) - P.q1.x, 0.0) * r;
  let dr = (Rp - P.q1.y) - pm;
  return sqrt(s * s + dr * dr) - P.q1.z;
}
fn sdfPrim(p: vec3f, P: Prim) -> f32 {
  let t = P.tc.x; let a = P.q0.xyz;
  if (t == P_SPHERE) { return length(p - a) - P.q0.w; }
  if (t == P_CAPSULE) {
    let b = vec3f(P.q0.w, P.q1.x, P.q1.y) - a; let v = p - a;
    let h = clamp(dot(v, b) / dot(b, b), 0.0, 1.0);
    return length(v - b * h) - P.q1.z;
  }
  if (t == P_PILL) {
    let nn = vec3f(P.q0.w, P.q1.x, P.q1.y); let v = p - a; let z = dot(v, nn);
    let s = max(length(v - z * nn) - P.q1.z, 0.0);
    return sqrt(s * s + z * z) - P.q1.w;
  }
  if (t == P_TORUS) {
    let nn = vec3f(P.q0.w, P.q1.x, P.q1.y); let v = p - a; let h = dot(v, nn);
    let rho = sqrt(max(dot(v, v) - h * h, 0.0));
    return sqrt((rho - P.q1.z) * (rho - P.q1.z) + h * h) - P.q1.w;
  }
  if (t == P_SLOT) {
    let b = vec3f(P.q0.w, P.q1.x, P.q1.y);
    let uu = normalize(0.5 * (a + b));
    let L = length(b - a); let e = (b - a) / L;
    let v = p - a;
    let s = clamp(dot(v, e), 0.0, L); let h = clamp(dot(v, uu), 0.0, P.q1.w);
    return length(v - s * e - h * uu) - P.q1.z;
  }
  let r = length(p);                                    // P_CERPATCH as a plain shell patch
  let c = clamp(dot(p, a) / max(r, 1e-9), -1.0, 1.0);
  let s = max(acos(c) - P.q1.x, 0.0) * r; let dr = r - P.q1.y;
  return sqrt(s * s + dr * dr) - P.q1.z;
}
fn primsMin(p: vec3f, cls: u32, refv: f32, refR: f32, cell: u32) -> f32 {
  var d = 1e9;
  let a = gridOff[cell]; let b = gridOff[cell + 1u];
  for (var k = a; k < b; k++) {
    let P = prims[gridIdx[k]];
    if (P.tc.y != cls) { continue; }
    if (P.tc.x == P_CERPATCH && refR >= 0.0) { d = min(d, sdfCer(p, P, refv, refR)); } else { d = min(d, sdfPrim(p, P)); }
  }
  return d;
}
fn sminC(a: f32, b: f32, k: f32, c: f32) -> f32 { let t = max(k - abs(a - b), 0.0); return min(a, b) - t * t * c; }
struct MemOut { d: array<f32, 16>, aux: f32, cell: u32 };
// membrane table (rows: bit mask of the rows to evaluate; the others keep 1e9)
fn memEval(p: vec3f, rows: u32) -> MemOut {
  var m: MemOut;
  for (var k = 0u; k < 16u; k++) { m.d[k] = 1e9; }
  m.aux = 0.0;
  let cell = gridCell(p); m.cell = cell;
  var i = 0u;
  for (var r = 0u; r < geo.info.w; r++) {
    let q = geo.tabs.x + TH + MROW * r; let kind = gu(q); let a = gu(q + 1u);
    if (r < 32u && ((rows >> r) & 1u) == 0u) { if (kind != K_SMOOTH_UNION) { i++; } continue; }
    if (kind == K_SMOOTH_UNION) {
      let d = primsMin(p, gu(q + 2u), 0.0, -1.0, cell); let k = G[q + 3u];
      var x = m.d[a]; if (G[q + 4u] < 0.0) { x = -x; }
      if (d < x + k) { let s = sminC(x, d, k, G[q + 5u]); m.d[a] = select(s, -s, G[q + 4u] < 0.0); }
      continue;
    }
    var v = 1e9;
    if (kind == K_FIELD) {
      v = fval(p, a); if (G[q + 2u] < 0.0) { v = -v; }
      if (G[q + 3u] != 0.0 || G[q + 4u] != 0.0) { v = v - (G[q + 3u] - G[q + 4u]); }
    } else if (kind == K_WALL) { v = min(m.d[a], faceDist(p)); }
    else if (kind == K_SHELL_PORES) { v = shellPores(p, a, G[q + 3u], G[q + 4u], G[q + 5u], G[q + 6u], cell); }
    else if (kind == K_INNER_CRISTAE) {
      var mx = m.d[a] + G[q + 3u];
      if (gofs(G_CRISTAE) > 0u && mx < G[S_CR_W]) { mx = max(mx, -cristaLumen(p, mx)); }
      v = -mx; m.aux = mx;
    } else if (kind == K_GOLGI_CIS) { v = golgi(p, a, min(m.d[gu(q + 3u)], m.d[gu(q + 4u)])); }
    else if (kind == K_PRIMS) {
      let b = gi(q + 2u); var base = 1e9; if (b >= 0) { base = fval(p, u32(b)); }
      let j = gi(q + 3u);
      if (j >= 0) { v = min(base, primsMin(p, a, m.d[u32(j)], G[q + 4u], cell)); } else { v = min(base, primsMin(p, a, 0.0, -1.0, cell)); }
    } else if (kind == K_PRIMS_DIFF) {
      let mm = max(primsMin(p, a, 0.0, -1.0, cell), -primsMin(p, gu(q + 2u), 0.0, -1.0, cell));
      v = select(mm, -mm, G[q + 3u] < 0.0); m.aux = mm;
    }
    m.d[i] = v; i++;
  }
  return m;
}
fn labelOf(p: vec3f, m: MemOut) -> u32 {
  var fk = NONE; var fv = 0.0;
  for (var r = 0u; r < geo.info2.x; r++) {
    let q = geo.tabs.y + RROW * r;
    var ok = true;
    let nc = gu(q + 1u);
    for (var c = 0u; c < nc; c++) {
      let t = gu(q + 2u + 4u * c); let a = gu(q + 3u + 4u * c);
      var x = 0.0;
      if (t == T_MEM) { x = m.d[a]; }
      else if (t == T_FIELD) {
        if (a != fk) { fk = a; fv = 1e9; if (G[G_N] > f32(a) + 0.5) { fv = fval(p, a); } }
        x = fv;
      } else if (t == T_FACE) { x = faceDist(p); }
      else if (t == T_PORE) {
        let mq = geo.tabs.x + TH + MROW * a;
        x = select(1.0, -1.0, inPore(p, G[mq + 4u] + 0.5 * G[mq + 3u], G[mq + 5u], m.cell) >= 0);
      } else if (t == T_SPECKLE) { x = select(1.0, -1.0, gofs(G_SPECKLE) > 0u && inSpeckle(p)); }
      else {
        let o = geo.tabs.z + a; let w = p - vec3f(G[o + 1u], G[o + 2u], G[o + 3u]);
        x = select(1.0, -1.0, dot(w, w) < G[o + 4u] * G[o + 4u]);
      }
      if (gu(q + 4u + 4u * c) == OP_LT) { ok = x < G[q + 5u + 4u * c]; } else { ok = x > G[q + 5u + 4u * c]; }
      if (!ok) { break; }
    }
    if (ok) { return gu(q); }
  }
  return NONE;
}
fn domainDepth(p: vec3f) -> f32 {
  if (geo.info.y == NONE) { return 1e9; }
  let m = memEval(p, geo.info.z);
  return m.d[geo.info.y];
}
`}function is(n){return Re+ts(n)+`
fn tileLoaded(p: vec3f) -> bool {
  let g = vec3i(floor((p - geo.tg0.xyz) / geo.tg0.w)) - vec3i(geo.tg1.xyz);
  let dims = vec3i(geo.tg2.xyz);
  if (any(g < vec3i(0)) || any(g >= dims)) { return false; }
  return (tileState[(u32(g.x) * u32(dims.y) + u32(g.y)) * u32(dims.z) + u32(g.z)] & 3u) != 0u;
}
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex
fn vsFill(@builtin(vertex_index) vi: u32) -> VO {
  var o: VO;
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  o.pos = vec4f(xy, 0.0, 1.0); o.ndc = xy;
  return o;
}
struct FOut { @location(0) color: vec4f, @location(1) id: u32, @builtin(frag_depth) depth: f32 };
fn bg() -> vec4f { return vec4f(palette[PAL_BG].xyz, 1.0); }
fn shadeLabel(p: vec3f, o: ptr<function, FOut>, bands: bool) {
  let m = memEval(p, 0xFFFFFFFFu);
  let lab = labelOf(p, m);
  if (lab == NONE || lab >= 64u || lab == geo.info2.z) { (*o).color = bg(); (*o).id = 0x100u + (lab & 63u); return; }
  let f = palette[PAL_LABEL + lab];
  var c = f.xyz;
  if (f.w < 0.5) { c = palette[PAL_BG].xyz; }
  var id = 0x100u + lab;
  if (bands) {
    for (var k = 0u; k < geo.info.x; k++) {
      if (((geo.info2.w >> k) & 1u) != 0u && abs(m.d[k]) < 2.5) { c = palette[41u].xyz; id = 0x200u + k; }
    }
    // open face (clip plane of an EM crop): a grey line where the section meets the edge of the imaged volume
    if (G[G_FACE] > 0.0) {
      let wf = max(4.0, 2.0 * length(p - u.eye.xyz) / u.eye.w);
      if (faceDist(p) < wf && lab != geo.info2.y) { c = palette[PAL_FACE].xyz; id = 0x100u + (geo.info2.z & 63u); }
    }
  }
  (*o).color = vec4f(c, 1.0);
  (*o).id = id;
}
fn fillDepth(pv0: vec3f) -> f32 {
  let clip = u.proj * vec4f((u.view * vec4f(pv0, 1.0)).xyz, 1.0);
  return clamp(clip.z / clip.w, 0.0, 1.0);
}
@fragment
fn fsFill(in: VO) -> FOut {
  var o: FOut;
  let pw = u.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let rd = normalize(pw.xyz / pw.w);
  let eye = u.eye.xyz;
  o.color = bg(); o.id = 0u; o.depth = 0.0;
  if (u.caps.w == 1u) { return o; }                   // membranes-only view (meshes only)
  let rs = select(rd, vec3f(1e-9), abs(rd) < vec3f(1e-9));
  let ta = (geo.bboxLo.xyz - eye) / rs; let tb = (geo.bboxHi.xyz - eye) / rs;
  let tmn = min(ta, tb); let tmx = max(ta, tb);
  let tn = max(max(tmn.x, tmn.y), tmn.z); let t1 = min(min(tmx.x, tmx.y), tmx.z);
  if (t1 <= max(tn, 0.0)) { return o; }
  var t0 = max(tn, 0.0);
  var onCut = false;
  var tEnd = t1;
  if (u.cut.x > 0.5) {
    let dn = dot(u.plane.xyz, rd);
    let sE = u.planeV.w;
    if (abs(dn) < 1e-6) { if (sE < 0.0) { return o; } }
    else {
      let tp = -sE / dn;
      if (dn > 0.0) { if (tp > t1) { return o; } if (tp > t0) { t0 = tp; onCut = true; } }
      else { if (tp < t0) { return o; } tEnd = min(t1, tp); }
    }
  }
  if (u.sel.w == 1u && !onCut) { return o; }          // organelle mode: cut face only (meshes provide the rest)
  var t = t0;
  var p = eye + rd * t;
  if (onCut && domainDepth(p) >= 0.0) {
    let inSlab = u.cut.x < 0.5 || dot(u.plane.xyz, p) - u.plane.w < u.cut.y;
    if (u.sel.w == 0u && tileLoaded(p) && inSlab) {
      t = t + u.cut.y / max(dot(u.plane.xyz, rd), 0.05);   // molecules drawn here: compartment backdrop behind the slab
      if (t >= tEnd) { return o; }
      p = eye + rd * t;
    }
    shadeLabel(p, &o, true);
    o.depth = fillDepth(rd * t);
    return o;
  }
  // outside the domain: trace the domain boundary (cell surface, or the flat open face of an EM crop)
  if (!onCut && domainDepth(eye) > 0.0) { return o; }
  var hit = false;
  for (var k = 0; k < 160; k++) {
    let d = -domainDepth(p);
    if (d < 0.25) { hit = true; break; }
    t = t + max(d, 0.5);
    if (t >= tEnd) { return o; }
    p = eye + rd * t;
  }
  if (!hit) { return o; }
  let ps = p;
  let e = 10.0;
  let g = vec3f(domainDepth(ps + vec3f(e, 0.0, 0.0)) - domainDepth(ps - vec3f(e, 0.0, 0.0)),
                domainDepth(ps + vec3f(0.0, e, 0.0)) - domainDepth(ps - vec3f(0.0, e, 0.0)),
                domainDepth(ps + vec3f(0.0, 0.0, e)) - domainDepth(ps - vec3f(0.0, 0.0, e)));
  var nn = -rd;
  if (dot(g, g) > 1e-6) { nn = -normalize(g); }
  let vn = (u.view * vec4f(nn, 0.0)).xyz;
  var shade = 0.93 + 0.07 * max(vn.z, 0.0);
  if (u.sel.z == 1u) {
    let l = normalize(vec3f(0.35, 0.45, 1.0));
    shade = 0.5 + 0.5 * max(dot(vn, l), 0.0) + 0.06 * pow(max(vn.z, 0.0), 8.0);
  }
  o.color = vec4f(palette[PAL_SURF].xyz * shade, 1.0);
  o.id = 0x200u + geo.info.y;
  if (G[G_FACE] > 0.0 && faceDist(ps) < 0.75) {        // the open face (edge of the imaged volume, no membrane)
    o.color = vec4f(palette[PAL_FACE].xyz * (0.9 + 0.1 * max(vn.z, 0.0)), 1.0);
    o.id = 0x100u + (geo.info2.z & 63u);
  }
  o.depth = fillDepth(rd * t);
  return o;
}
`}const ss=`
@group(0) @binding(0) var idTex: texture_2d<u32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var<uniform> px: vec4u;
@group(0) @binding(3) var<storage, read_write> outp: array<u32, 4>;
@compute @workgroup_size(1)
fn main() {
  let p = vec2i(px.xy);
  outp[0] = textureLoad(idTex, p, 0).x;
  outp[1] = bitcast<u32>(textureLoad(depthTex, p, 0));
}
`,ns=Re+`
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var idTex: texture_2d<u32>;
@group(1) @binding(2) var depthTex: texture_depth_2d;
struct VO { @builtin(position) pos: vec4f };
@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> VO {
  var o: VO;
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  o.pos = vec4f(xy, 0.0, 1.0);
  return o;
}
fn viewPos(px: vec2i, d: f32) -> vec3f {
  let ndc = vec2f((f32(px.x) + 0.5) * u.vp.z * 2.0 - 1.0, 1.0 - (f32(px.y) + 0.5) * u.vp.w * 2.0);
  let w = u.invViewProj * vec4f(ndc, max(d, 1e-7), 1.0);
  return w.xyz / w.w;
}
@fragment
fn fsComposite(in: VO) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy);
  let dims = vec2i(textureDimensions(colorTex));
  var c = textureLoad(colorTex, px, 0).xyz;
  let id = textureLoad(idTex, px, 0).x;
  let d = textureLoad(depthTex, px, 0);
  let cat = id >> 30u;
  if (d <= 0.0) { return vec4f(c, 1.0); }
  let prel = viewPos(px, d);
  let dist = length(prel);
  let pxPerNm = u.eye.w / max(dist, 1e-3);
  // depth cue behind the cut face (Goodsell-style darkening with depth)
  if (u.cut.x > 0.5 && cat != 0u && u.sel.w == 0u) {
    let s = sPlaneW(prel);
    let f = smoothstep(0.0, u.cut.z, s);
    c = mix(c, c * vec3f(0.55, 0.56, 0.62), f * 0.8);
  }
  // outlines at molecule (id) boundaries; strength fades when molecules are only a few pixels wide
  let rad = i32(max(1.0, round(u.misc.w)));
  var edge = 0.0;
  var selEdge = 0.0;
  let offs = array<vec2i, 4>(vec2i(rad, 0), vec2i(-rad, 0), vec2i(0, rad), vec2i(0, -rad));
  for (var k = 0; k < 4; k++) {
    let q = clamp(px + offs[k], vec2i(0), dims - vec2i(1));
    let id2 = textureLoad(idTex, q, 0).x;
    if (id2 != id) {
      let d2 = textureLoad(depthTex, q, 0);
      if (cat == 0u) { if ((id2 >> 30u) == 0u) { edge = 1.0; } }
      else if (d2 <= d * 1.0005 || (id2 >> 30u) == 0u) { edge = 1.0; }
      if (u.sel.x != 0u && (id2 == u.sel.x || id == u.sel.x)) { selEdge = 1.0; }
    }
  }
  var strength = u.misc.z;
  if (cat == 1u) { strength *= smoothstep(0.6, 2.5, pxPerNm); }
  else if (cat == 2u) { strength *= 0.55 * smoothstep(1.5, 6.0, pxPerNm); }
  else if (cat == 3u) { strength *= 0.7 * smoothstep(1.5, 5.0, pxPerNm); }
  else { strength *= 0.35; }
  c = mix(c, c * 0.18, edge * strength);
  if (selEdge > 0.0) { c = vec3f(1.0, 0.85, 0.1); }
  return vec4f(c, 1.0);
}
`,N=(n,e)=>[n[0]+e[0],n[1]+e[1],n[2]+e[2]],ge=(n,e)=>[n[0]-e[0],n[1]-e[1],n[2]-e[2]],R=(n,e)=>[n[0]*e,n[1]*e,n[2]*e],W=(n,e)=>n[0]*e[0]+n[1]*e[1]+n[2]*e[2],Ee=(n,e)=>[n[1]*e[2]-n[2]*e[1],n[2]*e[0]-n[0]*e[2],n[0]*e[1]-n[1]*e[0]],Ce=n=>Math.hypot(n[0],n[1],n[2]),Q=n=>{const e=Ce(n)||1;return[n[0]/e,n[1]/e,n[2]/e]},Ct=(n,e,t)=>[n[0]+(e[0]-n[0])*t,n[1]+(e[1]-n[1])*t,n[2]+(e[2]-n[2])*t];function nt(n,e,t){const i=Math.cos(t),s=Math.sin(t),r=Ee(e,n),o=W(e,n)*(1-i);return[n[0]*i+r[0]*s+e[0]*o,n[1]*i+r[1]*s+e[1]*o,n[2]*i+r[2]*s+e[2]*o]}function rs(n,e){const t=new Float32Array(16);for(let i=0;i<4;i++)for(let s=0;s<4;s++){let r=0;for(let o=0;o<4;o++)r+=n[o*4+s]*e[i*4+o];t[i*4+s]=r}return t}function os(n){const e=Array.from(n),t=new Float32Array(16),[i,s,r,o,a,c,l,u,p,d,b,g,m,f,y,x]=e,A=i*c-s*a,k=i*l-r*a,E=i*u-o*a,P=s*l-r*c,L=s*u-o*c,T=r*u-o*l,h=p*f-d*m,M=p*y-b*m,v=p*x-g*m,C=d*y-b*f,I=d*x-g*f,F=b*x-g*y;let G=A*F-k*I+E*C+P*v-L*M+T*h;return G&&(G=1/G,t[0]=(c*F-l*I+u*C)*G,t[1]=(r*I-s*F-o*C)*G,t[2]=(f*T-y*L+x*P)*G,t[3]=(b*L-d*T-g*P)*G,t[4]=(l*v-a*F-u*M)*G,t[5]=(i*F-r*v+o*M)*G,t[6]=(y*E-m*T-x*k)*G,t[7]=(p*T-b*E+g*k)*G,t[8]=(a*I-c*v+u*h)*G,t[9]=(s*v-i*I-o*h)*G,t[10]=(m*L-f*E+x*A)*G,t[11]=(d*E-p*L-g*A)*G,t[12]=(c*M-a*C-l*h)*G,t[13]=(i*C-s*M+r*h)*G,t[14]=(f*k-m*P-y*A)*G,t[15]=(p*P-d*k+b*A)*G),t}function Pt(n){const e=parseInt(n.replace("#",""),16);return(e>>16&255|(e>>8&255)<<8|(e&255)<<16|4278190080)>>>0}function as(n){return n<.5?4*n*n*n:1-Math.pow(-2*n+2,3)/2}const ce={base:"",ver:"",split:{},absent:new Set},di=n=>n?`?v=${encodeURIComponent(n)}`:"";async function ls(n,e){ce.base=n.endsWith("/")?n:n+"/",ce.ver=e;try{const t=await fetch(ce.base+"split.json"+di(e));ce.split=t.ok?await t.json():{}}catch{ce.split={}}}function cs(n){ce.absent=new Set(n??[])}const De=n=>ce.absent.has(n);function us(n){const e=atob(n),t=new Uint8Array(e.length);for(let i=0;i<e.length;i++)t[i]=e.charCodeAt(i);return t}async function ft(n){const e=new Uint8Array(n,0,Math.min(2,n.byteLength));if(e[0]===31&&e[1]===139){const t=new DecompressionStream("gzip"),i=new Blob([n]).stream().pipeThrough(t);return await new Response(i).arrayBuffer()}return n}async function Kt(n,e){for(let t=0;;t++){const i=await fetch(n,e);if(i.status!==429&&i.status!==503||t>=4)return i;const s=Number(i.headers.get("retry-after"));await new Promise(r=>setTimeout(r,s>0?Math.min(s,30)*1e3:1e3*2**t))}}async function $e(n,e){const t=window.__YC_EMBED__;if(t&&t[n]!==void 0)return ft(us(t[n]).buffer);const i=ce.split[n],s=d=>ce.base+d+di(ce.ver);if(i){const d=[];let b=0;for(let f=0;f<i;f++){const y=await Kt(s(`${n}.${String(f).padStart(3,"0")}`));if(!y.ok)throw new Error(`HTTP ${y.status} for ${n}.${f}`);const x=await y.arrayBuffer();d.push(x),b+=x.byteLength,e?.(f+1,i)}const g=new Uint8Array(b);let m=0;for(const f of d)g.set(new Uint8Array(f),m),m+=f.byteLength;return ft(g.buffer)}const r=await Kt(s(n));if(!r.ok)throw new Error(`HTTP ${r.status} for ${ce.base}${n}`);if(!e||!r.body)return ft(await r.arrayBuffer());const o=Number(r.headers.get("content-length")||0),a=r.body.getReader(),c=[];let l=0;for(;;){const{done:d,value:b}=await a.read();if(d)break;c.push(b),l+=b.length,e(l,o)}const u=new Uint8Array(l);let p=0;for(const d of c)u.set(d,p),p+=d.length;return ft(u.buffer)}async function Fe(n){const e=await $e(n);return JSON.parse(new TextDecoder().decode(e))}async function ds(n){return new TextDecoder().decode(await $e(n))}const fs=60,fi=62,hs=64,ps=128,ms=192,gs=256,hi=512,rt={32:"#F3C643",33:"#F0BC3C",34:"#F6D15E",35:"#EAB542",36:"#EFA83A",37:"#E7A93C",38:"#F2CA55",39:"#E8873A",40:"#F3C643",41:"#F8E3A0",42:"#E7A93C",48:"#B0437A",49:"#E07636",50:"#CDA866",51:"#C3C27A",52:"#C9558F",53:"#7CC6C2",54:"#E2D6A8",55:"#9B8BC4",60:"#D3DFEE",61:"#8D939C",62:"#F6F1E7"},pi=rt[fi];function mi(n){if(!n||n[0]!=="#")return[.85,.85,.85];const e=parseInt(n.slice(1,7),16);return[(e>>16&255)/255,(e>>8&255)/255,(e&255)/255]}function gi(n,e,t,i){const s=new Float32Array(hi*4),r=(a,c,l=1)=>{const u=mi(c);s.set([u[0],u[1],u[2],l],4*a)};for(const[a,c]of Object.entries(rt))r(Number(a),c);const o=i?.special_colours??{};o.cell_surface&&r(fs,o.cell_surface),o.membrane_band&&r(41,o.membrane_band),o.backdrop&&r(fi,o.backdrop);for(const a of e.membranes)a.code<0||a.code>=64||(r(hs+a.code,a.colour??"#B5653F"),r(ps+a.code,a.colour_only??a.colour_membranes_view??a.colour??"#B5653F"));for(const a of e.labels)a.code>=0&&a.code<64&&r(ms+a.code,a.fill??pi,a.fill?1:0);for(const a of n)a.id>=0&&a.id<256&&r(gs+a.id,a.colour,t[a.id]);return s}function bi(n,e){return e.some(t=>t.endsWith("*")?n.startsWith(t.slice(0,-1)):n===t)}function bs(n,e){let t,i=-1;const s=(r,o,a)=>{const c=r.endsWith("*")?e.startsWith(r.slice(0,-1)):e===r,l=(r.endsWith("*")?r.length-1:1e6)+a;c&&l>i&&(t=o,i=l)};for(const r of n.type_colours??[])s(r.pattern,r,.5);for(const r of n.classes??[])for(const o of r.patterns)s(o,r,0);return t}function yi(n){const e=n*137.508%360,t=.62,i=[.58,.44,.7][n%3],s=r=>{const o=(r+e/30)%12;return i-t*Math.min(i,1-i)*Math.max(-1,Math.min(o-3,9-o,1))};return"#"+[s(0),s(8),s(4)].map(r=>Math.round(r*255).toString(16).padStart(2,"0")).join("")}async function ys(n,e){e("Loading structure index",.12);const t=await Fe("library/types.json"),i=t.types;if(!Array.isArray(i)||!i.length||i[0].nb===void 0)throw new Error("library/types.json has no bead offsets: the cell needs the viewer library (tools/export_viewer_extras.py, step library)");if(i.length>65535)throw new Error(`${i.length} species: the viewer's instance word holds 65,535`);const s=t.bead_q;e("Loading residue coordinates",.15);const r=await $e("library/beads.bin",(v,C)=>e("Loading residue coordinates",.15+.4*(C?v/C:0))),o=new Float32Array(await $e("library/spheretree.bin"));let a=new Uint32Array(4),c={},l=0;if(!De("library/modes.json"))try{const v=await Fe("library/modes.json");a=new Uint32Array(await $e("library/modes.bin")),c=v.types,l=v.cap??1.5}catch{}let u=[],p={};if(!De("library/organisation.json"))try{const v=await Fe("library/organisation.json");u=v.modules,p=v.types}catch{}e("Building level-of-detail clusters",.58);const d=r.byteLength/8,b=new Int16Array(r),g=new Uint8Array(r),m=new Float32Array(d*4),f=new Uint32Array(m.buffer);for(let v=0;v<d;v++)m[4*v]=b[4*v]*s,m[4*v+1]=b[4*v+1]*s,m[4*v+2]=b[4*v+2]*s,f[4*v+3]=g[8*v+6]|g[8*v+7]<<8;let y=0;for(const v of i)y+=Math.ceil(v.nb/64);const x=new ArrayBuffer(Math.max(1,y)*32),A=new Float32Array(x),k=new Uint32Array(x),E=new ArrayBuffer(i.length*64),P=new Uint32Array(E),L=new Float32Array(E);let T=0;i.forEach((v,C)=>{const I=T;for(let K=0;K<v.nb;K+=64){const ue=Math.min(64,v.nb-K),Te=v.bo+K;let qe=1e9,Be=1e9,Ue=1e9,Xe=-1e9,Qe=-1e9,Ze=-1e9;for(let le=0;le<ue;le++){const D=4*(Te+le),Z=m[D],oe=m[D+1],ye=m[D+2];Z<qe&&(qe=Z),Z>Xe&&(Xe=Z),oe<Be&&(Be=oe),oe>Qe&&(Qe=oe),ye<Ue&&(Ue=ye),ye>Ze&&(Ze=ye)}const ct=(qe+Xe)/2,ut=(Be+Qe)/2,dt=(Ue+Ze)/2;let re=0;for(let le=0;le<ue;le++){const D=4*(Te+le);re=Math.max(re,Math.hypot(m[D]-ct,m[D+1]-ut,m[D+2]-dt))}A[8*T]=ct,A[8*T+1]=ut,A[8*T+2]=dt,A[8*T+3]=re+.85+(c[C]?.[3]??0),k[8*T+4]=Te,k[8*T+5]=ue,T++}const F=bs(n,v.id),G=v.src==="PDB";P[16*C+0]=v.bo,P[16*C+1]=v.nb,P[16*C+2]=I,P[16*C+3]=T-I,P[16*C+4]=v.so,P[16*C+5]=v.sn,L[16*C+6]=v.br,L[16*C+7]=Math.sqrt(5/3)*(v.rg||v.br/1.6),P[16*C+8]=F?Pt(F.colour):0,P[16*C+9]=F&&F.colour2?Pt(F.colour2):0,P[16*C+10]=((G?1:0)|Math.min(v.copies||0,16777215)<<8)>>>0,L[16*C+11]=G?255:v.plddt_mean??255;const j=c[C];j&&(P[16*C+12]=j[0],P[16*C+13]=j[1],P[16*C+14]=j[2]),P[16*C+15]=p[C]!==void 0?Pt(yi(p[C])):0});const h=new Map;i.forEach((v,C)=>h.set(v.id,C));const M=new Int32Array(i.length).fill(-1);for(const[v,C]of Object.entries(p))M[Number(v)]=C;return{types:i,beads:m,st:o,clusters:x,typeInfo:E,modes:a,modeCap:l,modules:u,moduleOf:M,nClusters:y,byId:h,libTag:t.lib_tag??null}}async function vs(){const n=await Fe("tiles/index.json");if(n.format!=="YCT2")throw new Error(`tiles/index.json format ${n.format??"(none)"}: this viewer reads YCT2 (convert YCT1 exports, tile_format_v2.md §8)`);const e=n.tile_columns,t=n.tiles,i=t.length,s=d=>e.indexOf(d),r=(d,b)=>{const g=new d(i),m=s(b);if(m<0)return g;for(let f=0;f<i;f++)g[f]=t[f][m];return g},o=n.grid,a=[o.min_ijk[0],o.min_ijk[1],o.min_ijk[2]],c=[o.max_ijk[0]-a[0]+1,o.max_ijk[1]-a[1]+1,o.max_ijk[2]-a[2]+1],l={n:i,ix:r(Int32Array,"ix"),iy:r(Int32Array,"iy"),iz:r(Int32Array,"iz"),nInst:r(Uint32Array,"n_inst"),nGhost:r(Uint32Array,"n_ghost"),nPoly:r(Uint32Array,"n_poly_beads"),nVert:r(Uint32Array,"n_vert"),nTri:r(Uint32Array,"n_tri"),gz:r(Uint32Array,"gz_bytes"),labelMask:r(Uint32Array,"label_mask"),off:new Float64Array(i),shard:new Array(i),key:new Map,tileNm:n.tile_nm,qOrg:n.q_org,qRange:n.q_range,origin:o.origin_nm,min:a,dims:c,blockTiles:n.block_tiles??5,libTag:n.lib_tag??null,buildTag:n.build_tag??null,flagBits:n.flag_bits??[],polyQ:{},lipidMask:Array.isArray(n.lipid_mask_regions)?n.lipid_mask_regions:null,sections:n.sections_written??[]};for(const[d,b]of Object.entries(n.polyline_kinds??{})){const g=Number(b?.poly_q);g>0&&(l.polyQ[Number(d)]=g)}const u=s("off"),p=s("shard");for(let d=0;d<i;d++)l.off[d]=t[d][u],l.shard[d]="tiles/"+t[d][p];for(let d=0;d<i;d++)l.key.set(vi(l,l.ix[d],l.iy[d],l.iz[d]),d);return l}function vi(n,e,t,i){const s=e-n.min[0],r=t-n.min[1],o=i-n.min[2];return s<0||r<0||o<0||s>=n.dims[0]||r>=n.dims[1]||o>=n.dims[2]?-1:(s*n.dims[1]+r)*n.dims[2]+o}const ws=1073741824,xs=3221225472,Vt=new Set((new URLSearchParams(location.search).get("debug")??"").split(",")),U=GPUShaderStage,O=GPUBufferUsage;class Ms{device;ctx;format;canvas;limits={};adapterInfo="";detail="auto";detailUsed="medium";instPages=0;lipPages=0;freePages=0;capL0=0;capL1=0;capL2=0;capLip=0;capFree=0;maxSlots=4096;uni;inst;pageOrg;typesBuf;typeFlags;palette;beads;st;clusters;modes;modeCap=0;counters;list01;listL2;args;cullParams;caps;lipPool;lipPagesBuf;lipList;lipParams;freePool;freePagesBuf;freeList;freeParams;meshUni;tileState;fillBufs=[];pickBuf;pickParams;pickOut;statsBuf;trSph;trSeg;nTrSph=0;nTrSeg=0;pipes={};bg={};bgl={};colorTex;idTex;depthTex;width=0;height=0;usedInstPages=0;usedLipPages=0;usedFreePages=0;pickPending=null;pickBusy=!1;statsBusy=!1;stats={l0:0,l1:0,l2:0,lip:0,fre:0,ninst:0};lastStatsT=0;organelleMeshes=[];onLost=()=>{};offscreen=new URLSearchParams(location.search).get("offscreen")==="1";offTex=null;constructor(e){this.canvas=e}async snapshot(){if(!this.offTex)throw new Error("snapshot() needs ?offscreen=1");const e=this.width,t=this.height,i=Math.ceil(e*4/256)*256,s=this.device.createBuffer({size:i*t,usage:O.COPY_DST|O.MAP_READ}),r=this.device.createCommandEncoder();r.copyTextureToBuffer({texture:this.offTex},{buffer:s,bytesPerRow:i},[e,t]),this.device.queue.submit([r.finish()]),await s.mapAsync(GPUMapMode.READ);const o=new Uint8Array(s.getMappedRange()),a=new ImageData(e,t);for(let l=0;l<t;l++)a.data.set(o.subarray(l*i,l*i+4*e),4*e*l);s.unmap(),s.destroy();const c=document.createElement("canvas");return c.width=e,c.height=t,c.getContext("2d").putImageData(a,0,0),c.toDataURL("image/png")}qstep=360/65535;outerMem=0;async init(e,t,i,s){if(this.qstep=i.qRange/65535,!("gpu"in navigator))throw new Error("WebGPU is not available in this browser.");const r=new URLSearchParams(location.search).get("gpu")==="compat",o=await navigator.gpu.requestAdapter({powerPreference:"high-performance",...r?{featureLevel:"compatibility"}:{}});if(!o)throw new Error("No WebGPU adapter found (GPU blocked or unsupported).");try{const x=o.info||{};this.adapterInfo=[x.vendor,x.architecture,x.device,x.description].filter(Boolean).join(" ")}catch{}const a=o.limits,c={maxStorageBufferBindingSize:Math.min(a.maxStorageBufferBindingSize,2**31-4),maxBufferSize:Math.min(a.maxBufferSize,2**31-4),maxComputeWorkgroupsPerDimension:a.maxComputeWorkgroupsPerDimension};for(const x of["maxStorageBuffersPerShaderStage","maxStorageBuffersInVertexStage","maxStorageBuffersInFragmentStage","maxStorageTexturesInFragmentStage"])typeof a[x]=="number"&&(c[x]=a[x]);this.device=await o.requestDevice({requiredLimits:c}),this.device.lost.then(x=>this.onLost(`GPU device lost: ${x.message}`)),this.device.addEventListener("uncapturederror",x=>console.error("WebGPU error:",x.error?.message)),this.limits={...c};const l=this.device.limits.maxStorageBufferBindingSize,u=e.beads.byteLength/16,p=e.st.byteLength/16;if(e.beads.byteLength>l||e.st.byteLength>l)throw new Error(`The structure library (${(e.beads.byteLength/1048576).toFixed(0)} MB) exceeds this GPU's storage buffer limit (${(l/1048576).toFixed(0)} MB).`);if(u>=2**26||p>=2**26)throw new Error(`Too many library beads (${u}) or spheres (${p}) for 26-bit draw-list offsets.`);if(t.G.length*4>l)throw new Error(`The cell geometry (${(t.G.length*4/1048576).toFixed(0)} MB) exceeds this GPU's storage buffer limit (${(l/1048576).toFixed(0)} MB).`);const d=x=>Math.min(x,Math.floor(l/16));let b=this.detail;b==="auto"&&(b=!!o.isFallbackAdapter||!!o.info?.isFallbackAdapter||/swiftshader|llvmpipe|software/i.test(this.adapterInfo)?"low":"medium");const g={low:4,medium:8,high:16}[b]??8;this.instPages=Math.floor(d(g*1024*1024)/Y),this.detailUsed=`${b} (${(this.instPages*Y/1048576).toFixed(0)} M)`,this.lipPages=Math.floor(d(8*1024*1024)/ee),this.freePages=Math.floor(d(10*1024*1024)/ee),this.capL0=Math.min(4*1024*1024,Math.floor(l/8)-2*1024*1024),this.capL1=2*1024*1024,this.capL2=Math.min(8*1024*1024,Math.floor(l/4)),this.capLip=this.lipPages*ee,this.capFree=this.freePages*ee,this.offscreen?this.format="rgba8unorm":(this.ctx=this.canvas.getContext("webgpu"),this.format=navigator.gpu.getPreferredCanvasFormat(),this.ctx.configure({device:this.device,format:this.format,alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}));const m=this.device,f=(x,A,k)=>m.createBuffer({size:Math.max(16,Math.ceil(x/16)*16),usage:A,label:k}),y=O.STORAGE|O.COPY_DST;this.uni=f(512,O.UNIFORM|O.COPY_DST,"uniforms"),this.inst=f(this.instPages*Y*16,y,"instances"),this.pageOrg=f(this.instPages*16,y,"pageOrg"),this.typesBuf=f(e.typeInfo.byteLength,y,"types"),this.typeFlags=f(e.types.length*4,y,"typeFlags"),this.palette=f(hi*16,y,"palette"),this.beads=f(e.beads.byteLength,y,"beads"),this.modes=f(Math.max(16,e.modes.byteLength),y,"modes"),this.modeCap=e.modeCap,this.st=f(e.st.byteLength,y,"spheretree"),this.clusters=f(e.clusters.byteLength,y,"clusters"),m.queue.writeBuffer(this.typesBuf,0,e.typeInfo),m.queue.writeBuffer(this.palette,0,s),m.queue.writeBuffer(this.beads,0,e.beads),m.queue.writeBuffer(this.modes,0,e.modes),m.queue.writeBuffer(this.st,0,e.st),m.queue.writeBuffer(this.clusters,0,e.clusters),this.counters=f(32,O.STORAGE|O.COPY_DST|O.COPY_SRC,"counters"),this.list01=f((this.capL0+this.capL1)*8,O.STORAGE,"list01"),this.listL2=f(this.capL2*4,O.STORAGE,"listL2"),this.args=f(80,O.STORAGE|O.INDIRECT,"args"),this.cullParams=f(32,O.UNIFORM|O.COPY_DST,"cullParams"),this.caps=f(32,O.UNIFORM|O.COPY_DST,"caps"),m.queue.writeBuffer(this.caps,0,new Uint32Array([this.capL0,this.capL1,this.capL2,this.capLip,this.capFree,0,0,0])),this.lipPool=f(this.lipPages*ee*16,y,"lipidPool"),this.lipPagesBuf=f(this.lipPages*16,y,"lipidPages"),this.lipList=f(this.capLip*4,O.STORAGE,"lipidList"),this.lipParams=f(16,O.UNIFORM|O.COPY_DST,"lipParams"),this.freePool=f(this.freePages*ee*16,y,"freePool"),this.freePagesBuf=f(this.freePages*16,y,"freePages"),this.freeList=f(this.capFree*4,O.STORAGE,"freeList"),this.freeParams=f(16,O.UNIFORM|O.COPY_DST,"freeParams"),this.meshUni=f(256*(this.maxSlots+16),O.UNIFORM|O.COPY_DST,"meshUniforms"),this.tileState=f(i.dims[0]*i.dims[1]*i.dims[2]*4,y,"tileState"),this.pickBuf=m.createBuffer({size:16,usage:O.MAP_READ|O.COPY_DST}),this.pickParams=f(16,O.UNIFORM|O.COPY_DST,"pickParams"),this.pickOut=f(16,O.STORAGE|O.COPY_SRC,"pickOut"),this.statsBuf=m.createBuffer({size:32,usage:O.MAP_READ|O.COPY_DST}),this.trSph=f(32*1024,y,"tracers"),this.trSeg=f(48*4096,y,"tracerLines"),this.initFill(t,i),await this.initPipelines(t),this.resize()}setPalette(e){this.device.queue.writeBuffer(this.palette,0,e)}initFill(e,t){const i=this.device,s=e.K,r=e.G,o=e.PT.length,a=new ArrayBuffer(Math.max(1,o)*48),c=new Float32Array(a),l=new Uint32Array(a);for(let P=0;P<o;P++){for(let L=0;L<8;L++)c[12*P+L]=e.PQ[8*P+L];l[12*P+8]=e.PT[P],l[12*P+9]=e.PC[P]}const u=new Float32Array(Math.max(1,e.nPores)*8);for(let P=0;P<e.nPores;P++)for(let L=0;L<3;L++)u[8*P+L]=e.pores[6*P+L],u[8*P+4+L]=e.pores[6*P+3+L];const p=e.grid,d=p.primIdx.length,b=new Uint32Array(p.primOff.length+p.poreOff.length);b.set(p.primOff,0);for(let P=0;P<p.poreOff.length;P++)b[p.primOff.length+P]=p.poreOff[P]+d;const g=new Uint32Array(d+p.poreIdx.length+1);g.set(p.primIdx,0),g.set(p.poreIdx,d);let m=0,f=0;for(let P=0;P<e.nRow;P++){const L=r[e.tab+s.TH+s.MROW*P];L!==s.K_SMOOTH_UNION&&(L!==s.K_WALL&&f<32&&(m|=1<<f),f++)}const y=new ArrayBuffer(160),x=new Float32Array(y),A=new Uint32Array(y);x.set([...e.bbox.lo,0,...e.bbox.hi,0,...p.lo,p.n,...p.cs,e.nPores,...t.origin,t.tileNm,...t.min,0,...t.dims,0],0);const k=4294967295;A.set([e.nMem,e.domainMem>=0?e.domainMem:k,e.domainRows>>>0,e.nRow],28),A.set([e.nLab,e.exteriorCode>=0?e.exteriorCode:k,e.outsideCode>=0?e.outsideCode:k,m>>>0],32),A.set([e.tab,e.r0,e.data0,e.r0+s.RROW*e.nLab],36);const E=(P,L)=>{const T=i.createBuffer({size:Math.ceil(P.byteLength/16)*16+16,usage:L|O.COPY_DST});return i.queue.writeBuffer(T,0,P),T};this.fillBufs=[E(a,O.STORAGE),E(u,O.STORAGE),E(b,O.STORAGE),E(g,O.STORAGE),E(y,O.UNIFORM),E(e.gpuG(),O.STORAGE)]}async initPipelines(e){const t=this.device,i=(D,Z)=>({binding:D,visibility:Z,buffer:{type:"read-only-storage"}}),s=D=>({binding:D,visibility:U.COMPUTE,buffer:{type:"storage"}}),r=(D,Z,oe=!1)=>({binding:D,visibility:Z,buffer:{type:"uniform",hasDynamicOffset:oe}}),o=U.COMPUTE|U.VERTEX|U.FRAGMENT,a=U.COMPUTE|U.VERTEX,c=U.VERTEX|U.FRAGMENT,l=D=>t.createBindGroupLayout({entries:D});this.bgl.g0=l([r(0,o),i(1,a),i(2,a),i(3,a),i(4,a),i(5,o)]),this.bgl.cull=l([s(0),s(1),s(2),r(3,U.COMPUTE),i(4,U.COMPUTE)]),this.bgl.cullS=l([s(0),i(1,U.COMPUTE),i(2,U.COMPUTE),s(3),r(4,U.COMPUTE)]),this.bgl.fin=l([i(0,U.COMPUTE),s(1),r(2,U.COMPUTE)]),this.bgl.l0=l([i(0,U.VERTEX),i(1,U.VERTEX),i(2,U.VERTEX)]),this.bgl.l2=l([i(0,U.VERTEX)]),this.bgl.sph=l([i(0,U.VERTEX),i(1,U.VERTEX),i(2,U.VERTEX)]),this.bgl.mesh=l([r(0,c,!0)]),this.bgl.tr=l([i(0,U.VERTEX)]),this.bgl.fill=l([i(0,U.FRAGMENT),i(1,U.FRAGMENT),i(2,U.FRAGMENT),i(3,U.FRAGMENT),r(4,U.FRAGMENT),i(5,U.FRAGMENT),i(6,U.FRAGMENT)]),this.bgl.comp=l([{binding:0,visibility:U.FRAGMENT,texture:{sampleType:"unfilterable-float"}},{binding:1,visibility:U.FRAGMENT,texture:{sampleType:"uint"}},{binding:2,visibility:U.FRAGMENT,texture:{sampleType:"depth"}}]),this.bgl.pick=l([{binding:0,visibility:U.COMPUTE,texture:{sampleType:"uint"}},{binding:1,visibility:U.COMPUTE,texture:{sampleType:"depth"}},r(2,U.COMPUTE),s(3)]);const u=(...D)=>t.createPipelineLayout({bindGroupLayouts:D}),p=new URLSearchParams(location.search).get("gpu")==="compat",d=async(D,Z)=>{p&&(D=D.replace(/@interpolate\(flat\)/g,"@interpolate(flat, either)").replace(/textureLoad\(depthTex, ([a-z0-9]+), 0\)/g,"select(0.5, 0.5, $1.x == 0)").replace("var strength = u.misc.z;","var strength = 0.0;").replace("if (u.cut.x > 0.5 && cat != 0u && u.sel.w == 0u) {","if (false) {"));const oe=t.createShaderModule({code:D,label:Z}),ye=await oe.getCompilationInfo(),ve=ye.messages.filter(We=>We.type==="error");for(const We of ye.messages)(We.type==="error"?console.error:console.warn)(`[${Z}] ${We.lineNum}:${We.linePos} ${We.message}`);if(ve.length)throw new Error(`WGSL compile error in ${Z}: ${ve[0].lineNum}:${ve[0].linePos} ${ve[0].message}`);return oe},b=await d(Di,"cull"),g=await d(ji,"cullSpheres"),m=await d(Hi,"finalize"),f=await d(Ki,"drawL0"),y=await d(Vi,"drawL1"),x=await d(Yi,"drawL2"),A=await d(Xi,"drawSpheres"),k=await d(Ji,"mesh"),E=await d(is(e.K),"fill"),P=await d(ns,"composite"),L=await d(ss,"pick"),T=await d(Qi,"tracers"),h=await d(Zi,"lines"),M=(D,Z,oe)=>t.createComputePipelineAsync({layout:oe,compute:{module:D,entryPoint:Z}}),v=[{format:"rgba8unorm"},{format:"r32uint"}],C=(D="greater")=>({format:"depth32float",depthWriteEnabled:!0,depthCompare:D}),I=(D,Z,oe,ye,ve={})=>t.createRenderPipelineAsync({layout:ye,vertex:{module:D,entryPoint:Z,...ve.vertex?{buffers:ve.vertex.buffers}:{}},fragment:{module:D,entryPoint:oe,targets:v},primitive:{topology:"triangle-list",cullMode:"none"},depthStencil:ve.depthStencil??C()}),F=this.bgl.g0,[G,j,K,ue,Te,qe,Be,Ue,Xe,Qe,Ze,ct,ut,dt]=await Promise.all([M(b,"cullInstances",u(F,this.bgl.cull)),M(g,"cullSpheres",u(F,this.bgl.cullS)),M(m,"main",u(this.bgl.fin)),I(f,"vsL0","fsMain",u(F,this.bgl.l0)),I(y,"vsL1","fsMain",u(F,this.bgl.l0)),I(x,"vsL2","fsMain",u(F,this.bgl.l2)),I(A,"vsLipid","fsMain",u(F,this.bgl.sph)),I(A,"vsFree","fsMain",u(F,this.bgl.sph)),I(k,"vsMesh","fsMesh",u(F,this.bgl.mesh),{vertex:{buffers:[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:"float32x4"},{shaderLocation:1,offset:16,format:"float32x4"}]}]}}),I(E,"vsFill","fsFill",u(F,this.bgl.fill),{depthStencil:C("always")}),t.createRenderPipelineAsync({layout:u(F,this.bgl.comp),vertex:{module:P,entryPoint:"vsFull"},fragment:{module:P,entryPoint:"fsComposite",targets:[{format:this.format}]},primitive:{topology:"triangle-list"}}),M(L,"main",u(this.bgl.pick)),I(T,"vsTracer","fsMain",u(F,this.bgl.tr)),t.createRenderPipelineAsync({layout:u(F,this.bgl.tr),vertex:{module:h,entryPoint:"vsLine"},fragment:{module:h,entryPoint:"fsLine",targets:[{format:"rgba8unorm"},{format:"r32uint",writeMask:p?GPUColorWrite.ALL:0}]},primitive:{topology:"triangle-list",cullMode:"none"},depthStencil:{format:"depth32float",depthWriteEnabled:!1,depthCompare:"greater"}})]);Object.assign(this.pipes,{cull:G,cullS:j,fin:K,l0:ue,l1:Te,l2:qe,lip:Be,fre:Ue,mesh:Xe,fill:Qe,comp:Ze,pick:ct,tr:ut,line:dt});const re=(D,Z,oe=[])=>t.createBindGroup({layout:D,entries:Z.map((ye,ve)=>({binding:ve,resource:{buffer:ye,size:oe[ve]}}))});this.bg.g0=re(F,[this.uni,this.inst,this.pageOrg,this.typesBuf,this.typeFlags,this.palette]),this.bg.cull=re(this.bgl.cull,[this.counters,this.list01,this.listL2,this.cullParams,this.clusters]),this.bg.cullLip=re(this.bgl.cullS,[this.counters,this.lipPool,this.lipPagesBuf,this.lipList,this.lipParams]),this.bg.cullFree=re(this.bgl.cullS,[this.counters,this.freePool,this.freePagesBuf,this.freeList,this.freeParams]),this.bg.fin=re(this.bgl.fin,[this.counters,this.args,this.caps]),this.bg.l0=re(this.bgl.l0,[this.beads,this.list01,this.modes]),this.bg.l1=re(this.bgl.l0,[this.st,this.list01,this.modes]),this.bg.l2=re(this.bgl.l2,[this.listL2]),this.bg.lip=re(this.bgl.sph,[this.lipPool,this.lipPagesBuf,this.lipList]),this.bg.fre=re(this.bgl.sph,[this.freePool,this.freePagesBuf,this.freeList]),this.bg.mesh=t.createBindGroup({layout:this.bgl.mesh,entries:[{binding:0,resource:{buffer:this.meshUni,size:16}}]});const le=this.fillBufs;this.bg.fill=re(this.bgl.fill,[le[0],le[1],le[2],le[3],le[4],this.tileState,le[5]]),this.trBindGroups()}trBindGroups(){this.bg.tr=this.device.createBindGroup({layout:this.bgl.tr,entries:[{binding:0,resource:{buffer:this.trSph}}]}),this.bg.line=this.device.createBindGroup({layout:this.bgl.tr,entries:[{binding:0,resource:{buffer:this.trSeg}}]})}setTracers(e,t,i,s){const r=this.device,o=(l,u)=>l.size>=u?l:(l.destroy(),r.createBuffer({size:Math.ceil(u*1.5/16)*16,usage:O.STORAGE|O.COPY_DST,label:l.label})),a=this.trSph,c=this.trSeg;this.trSph=o(a,t*32),this.trSeg=o(c,s*48),(a!==this.trSph||c!==this.trSeg)&&this.trBindGroups(),t&&r.queue.writeBuffer(this.trSph,0,e,0,t*8),s&&r.queue.writeBuffer(this.trSeg,0,i,0,s*12),this.nTrSph=t,this.nTrSeg=s}resize(e=1){const t=Math.min(window.devicePixelRatio||1,2)*e,i=Math.max(1,Math.floor(this.canvas.clientWidth*t)),s=Math.max(1,Math.floor(this.canvas.clientHeight*t));if(i===this.width&&s===this.height&&this.colorTex)return;this.canvas.width=i,this.canvas.height=s,this.width=i,this.height=s,this.colorTex?.destroy(),this.idTex?.destroy(),this.depthTex?.destroy(),this.offTex?.destroy();const r=GPUTextureUsage;this.offscreen&&(this.offTex=this.device.createTexture({size:[i,s],format:"rgba8unorm",usage:r.RENDER_ATTACHMENT|r.COPY_SRC})),this.colorTex=this.device.createTexture({size:[i,s],format:"rgba8unorm",usage:r.RENDER_ATTACHMENT|r.TEXTURE_BINDING}),this.idTex=this.device.createTexture({size:[i,s],format:"r32uint",usage:r.RENDER_ATTACHMENT|r.TEXTURE_BINDING|r.COPY_SRC}),this.depthTex=this.device.createTexture({size:[i,s],format:"depth32float",usage:r.RENDER_ATTACHMENT|r.TEXTURE_BINDING|r.COPY_SRC}),this.bg.comp=this.device.createBindGroup({layout:this.bgl.comp,entries:[{binding:0,resource:this.colorTex.createView()},{binding:1,resource:this.idTex.createView()},{binding:2,resource:this.depthTex.createView()}]}),this.bg.pick=this.device.createBindGroup({layout:this.bgl.pick,entries:[{binding:0,resource:this.idTex.createView()},{binding:1,resource:this.depthTex.createView()},{binding:2,resource:{buffer:this.pickParams}},{binding:3,resource:{buffer:this.pickOut}}]})}writeUniforms(e,t){const i=this.width/this.height,s=e.viewRot(),r=e.proj(i),o=rs(r,s),a=os(o),c=e.eye,l=new ArrayBuffer(512),u=new Float32Array(l),p=new Uint32Array(l),d=t.memColors&&!t.organelle;u.set(r,0),u.set(s,16),u.set(a,32);const b=e.pxPerNmAtUnit(this.height);u.set([c[0],c[1],c[2],b],48);const g=[t.plane[0],t.plane[1],t.plane[2]];u.set([g[0],g[1],g[2],t.plane[3]],52);const m=[s[0]*g[0]+s[4]*g[1]+s[8]*g[2],s[1]*g[0]+s[5]*g[1]+s[9]*g[2],s[2]*g[0]+s[6]*g[1]+s[10]*g[2]];u.set([m[0],m[1],m[2],W(g,c)-t.plane[3]],56),u.set([t.cutOn&&!d?1:0,t.slab,Math.min(400,Math.max(20,t.slab)),performance.now()/1e3],60),u.set([t.l0px,t.l1px,t.minpx,.6],64),u.set([this.width,this.height,1/this.width,1/this.height],68),u.set(e.frustum(i),72),p.set([t.colorMode,0,t.freeHide,t.highlight?1:0],96),p.set([t.selId>>>0,0,t.shaded?1:0,t.organelle?1:0],100),u.set([this.qstep,.8,t.outline,Math.min(window.devicePixelRatio||1,2)*t.renderScale],104),u.set([0,this.outerMem,0,e.near()],108),p.set([this.capL0,Math.round(t.motion*1e3),Math.round(this.modeCap*1e3),d?1:0],112),this.device.queue.writeBuffer(this.uni,0,l,0,464)}frame(e,t,i,s){const r=this.device;this.writeUniforms(e,t);const o=r.createCommandEncoder();o.clearBuffer(this.counters);const a=t.memColors&&!t.organelle,c=!t.organelle&&!a&&!Vt.has("nomol");if(c){const g=o.beginComputePass();g.setBindGroup(0,this.bg.g0);const m=(f,y,x)=>{const A=Math.ceil(f/64),k=Math.min(A,65535),E=Math.ceil(A/k);return r.queue.writeBuffer(y,0,x(k*64)),[k,E]};if(this.usedInstPages>0){const[f,y]=m(this.usedInstPages*Y,this.cullParams,x=>new Uint32Array([this.usedInstPages,x,this.capL0,this.capL1,this.capL2,this.capLip,this.capFree,0]).buffer);g.setPipeline(this.pipes.cull),g.setBindGroup(1,this.bg.cull),g.dispatchWorkgroups(f,y)}if(this.usedLipPages>0&&t.showLipids){const[f,y]=m(this.usedLipPages*ee,this.lipParams,x=>new Uint32Array([this.usedLipPages,x,this.capLip,1]).buffer);g.setPipeline(this.pipes.cullS),g.setBindGroup(1,this.bg.cullLip),g.dispatchWorkgroups(f,y)}if(this.usedFreePages>0){const[f,y]=m(this.usedFreePages*ee,this.freeParams,x=>new Uint32Array([this.usedFreePages,x,this.capFree,0]).buffer);g.setPipeline(this.pipes.cullS),g.setBindGroup(1,this.bg.cullFree),g.dispatchWorkgroups(f,y)}g.setPipeline(this.pipes.fin),g.setBindGroup(0,this.bg.fin),g.dispatchWorkgroups(1),g.end()}const l=o.beginRenderPass({colorAttachments:[{view:this.colorTex.createView(),loadOp:"clear",storeOp:"store",clearValue:{r:.965,g:.945,b:.906,a:1}},{view:this.idTex.createView(),loadOp:"clear",storeOp:"store",clearValue:{r:0,g:0,b:0,a:0}}],depthStencilAttachment:{view:this.depthTex.createView(),depthLoadOp:"clear",depthStoreOp:"store",depthClearValue:0}});if(l.setBindGroup(0,this.bg.g0),Vt.has("nofill")||(l.setPipeline(this.pipes.fill),l.setBindGroup(1,this.bg.fill),l.draw(3)),t.organelle||a){l.setPipeline(this.pipes.mesh);const g=this.maxSlots;r.queue.writeBuffer(this.meshUni,g*256,new Uint32Array([0,t.organelle?1:3,0,0]));for(const m of this.organelleMeshes)l.setBindGroup(1,this.bg.mesh,[g*256]),l.setVertexBuffer(0,m.vb),l.setIndexBuffer(m.ib,"uint32"),l.drawIndexed(m.nIdx,1)}else if(t.showMeshes&&i.length){l.setPipeline(this.pipes.mesh);for(const g of i)l.setBindGroup(1,this.bg.mesh,[g.slot*256]),l.setVertexBuffer(0,g.vb),l.setIndexBuffer(g.ib,"uint32"),l.drawIndexed(g.nIdx,2)}c&&(l.setPipeline(this.pipes.l2),l.setBindGroup(1,this.bg.l2),l.drawIndirect(this.args,32),l.setPipeline(this.pipes.l1),l.setBindGroup(1,this.bg.l1),l.drawIndirect(this.args,16),l.setPipeline(this.pipes.l0),l.setBindGroup(1,this.bg.l0),l.drawIndirect(this.args,0),t.showLipids&&(l.setPipeline(this.pipes.lip),l.setBindGroup(1,this.bg.lip),l.drawIndirect(this.args,48)),l.setPipeline(this.pipes.fre),l.setBindGroup(1,this.bg.fre),l.drawIndirect(this.args,64),this.nTrSph&&(l.setPipeline(this.pipes.tr),l.setBindGroup(1,this.bg.tr),l.draw(6,this.nTrSph)),this.nTrSeg&&(l.setPipeline(this.pipes.line),l.setBindGroup(1,this.bg.line),l.draw(6,this.nTrSeg))),l.end();const u=this.offscreen?this.offTex:this.ctx.getCurrentTexture(),p=o.beginRenderPass({colorAttachments:[{view:u.createView(),loadOp:"clear",storeOp:"store",clearValue:{r:1,g:1,b:1,a:1}}]});p.setPipeline(this.pipes.comp),p.setBindGroup(0,this.bg.g0),p.setBindGroup(1,this.bg.comp),p.draw(3),p.end();let d=null;if(this.pickPending&&!this.pickBusy){d=this.pickPending,this.pickPending=null;const g=Math.max(0,Math.min(this.width-1,Math.floor(d.x))),m=Math.max(0,Math.min(this.height-1,Math.floor(d.y)));r.queue.writeBuffer(this.pickParams,0,new Uint32Array([g,m,0,0]));const f=o.beginComputePass();f.setPipeline(this.pipes.pick),f.setBindGroup(0,this.bg.pick),f.dispatchWorkgroups(1),f.end(),o.copyBufferToBuffer(this.pickOut,0,this.pickBuf,0,16)}let b=!1;if(s&&!this.statsBusy&&c&&(o.copyBufferToBuffer(this.counters,0,this.statsBuf,0,32),b=!0),r.queue.submit([o.finish()]),d){this.pickBusy=!0;const g=d;this.pickBuf.mapAsync(GPUMapMode.READ).then(()=>{const m=this.pickBuf.getMappedRange(0,8),f=new Uint32Array(m)[0],y=new Float32Array(m)[1];this.pickBuf.unmap(),this.pickBusy=!1,g.resolve({id:f>>>0,depth:y})}).catch(()=>{this.pickBusy=!1})}b&&(this.statsBusy=!0,this.statsBuf.mapAsync(GPUMapMode.READ).then(()=>{const g=new Uint32Array(this.statsBuf.getMappedRange());this.stats={l0:g[0],l1:g[1],l2:g[2],lip:g[3],fre:g[4],ninst:g[5]},this.statsBuf.unmap(),this.statsBusy=!1}).catch(()=>{this.statsBusy=!1}))}pick(e,t){return new Promise(i=>{this.pickPending={x:e,y:t,resolve:i}})}setMeshSlot(e,t){const i=new ArrayBuffer(16),s=new Uint32Array(i),r=new Float32Array(i);s[0]=e,s[1]=t?2:0,r[2]=t?-1:-1.9,r[3]=t?1:1.9,this.device.queue.writeBuffer(this.meshUni,e*256,i)}uploadOrganelleMeshes(e){const t=this.device,i=new Uint32Array(e,0,1)[0],s=new Uint32Array(e,4,i*3);let r=4+i*12;for(const a of this.organelleMeshes)a.vb.destroy(),a.ib.destroy();this.organelleMeshes=[];let o=-1;for(let a=0;a<i;a++){const c=s[3*a],l=s[3*a+1],u=s[3*a+2],p=new Float32Array(e.slice(r,r+l*12));r+=l*12;const d=new Uint32Array(e.slice(r,r+u*12));r+=u*12;const b=new Float32Array(l*3);let g=1/0,m=-1/0;for(let k=0;k<l;k++)g=Math.min(g,p[3*k]),m=Math.max(m,p[3*k]);m-g>o&&(o=m-g,this.outerMem=c);for(let k=0;k<u;k++){const E=d[3*k],P=d[3*k+1],L=d[3*k+2],T=p[3*P]-p[3*E],h=p[3*P+1]-p[3*E+1],M=p[3*P+2]-p[3*E+2],v=p[3*L]-p[3*E],C=p[3*L+1]-p[3*E+1],I=p[3*L+2]-p[3*E+2],F=h*I-M*C,G=M*v-T*I,j=T*C-h*v;for(const K of[E,P,L])b[3*K]+=F,b[3*K+1]+=G,b[3*K+2]+=j}const f=new Float32Array(l*8),y=new Uint32Array(f.buffer);for(let k=0;k<l;k++){const E=Math.hypot(b[3*k],b[3*k+1],b[3*k+2])||1;f[8*k]=p[3*k],f[8*k+1]=p[3*k+1],f[8*k+2]=p[3*k+2],y[8*k+3]=c,f[8*k+4]=b[3*k]/E,f[8*k+5]=b[3*k+1]/E,f[8*k+6]=b[3*k+2]/E}const x=t.createBuffer({size:f.byteLength,usage:O.VERTEX|O.COPY_DST});t.queue.writeBuffer(x,0,f);const A=t.createBuffer({size:Math.ceil(d.byteLength/4)*4,usage:O.INDEX|O.COPY_DST});t.queue.writeBuffer(A,0,d),this.organelleMeshes.push({vb:x,ib:A,nIdx:u*3,mem:c})}}gpuMemoryMB(){return[this.inst,this.pageOrg,this.beads,this.st,this.clusters,this.list01,this.listL2,this.lipPool,this.lipList,this.freePool,this.freeList,this.meshUni].reduce((t,i)=>t+i.size,0)/1048576+this.width*this.height*12/1048576}}class Ps{target=[0,0,0];dist=3e3;fwd=[0,0,-1];up=[0,1,0];fovy=35*Math.PI/180;minDist=1.5;maxDist=25e3;anim=null;get right(){return Q(Ee(this.fwd,this.up))}get eye(){return ge(this.target,R(this.fwd,this.dist))}orthonormalize(){this.fwd=Q(this.fwd);const e=Q(Ee(this.fwd,this.up));this.up=Q(Ee(e,this.fwd))}orbit(e,t){const i=this.right;this.fwd=nt(this.fwd,this.up,-e),this.fwd=nt(this.fwd,i,-t),this.up=nt(this.up,i,-t),this.orthonormalize()}roll(e){this.up=nt(this.up,this.fwd,e),this.orthonormalize()}pan(e,t,i){const s=1/i;this.target=N(this.target,N(R(this.right,-e*s),R(this.up,t*s)))}zoom(e){this.dist=Math.min(this.maxDist,Math.max(this.minDist,this.dist*e))}fly(e){this.target=N(this.target,e)}pxPerNmAtUnit(e){return e/(2*Math.tan(this.fovy/2))}distForWidth(e,t){return e/(2*Math.tan(this.fovy/2)*Math.min(t,1))}near(){return Math.min(5,Math.max(.02,this.dist*.004))}viewRot(){const e=this.right,t=this.up,i=this.fwd,s=new Float32Array(16);return s[0]=e[0],s[4]=e[1],s[8]=e[2],s[1]=t[0],s[5]=t[1],s[9]=t[2],s[2]=-i[0],s[6]=-i[1],s[10]=-i[2],s[15]=1,s}proj(e){const t=1/Math.tan(this.fovy/2),i=new Float32Array(16);return i[0]=t/e,i[5]=t,i[11]=-1,i[14]=this.near(),i}frustum(e){const t=Math.tan(this.fovy/2),i=t*e,s=this.right,r=this.up,o=this.fwd,a=(l,u=0)=>{const p=Q(l);return[p[0],p[1],p[2],u]},c=[...a(N(s,R(o,i))),...a(N(R(s,-1),R(o,i))),...a(N(r,R(o,t))),...a(N(R(r,-1),R(o,t))),o[0],o[1],o[2],-this.near(),0,0,0,1];return new Float32Array(c)}ray(e,t,i){const s=Math.tan(this.fovy/2),r=s*i,o=(e*2-1)*r,a=(1-t*2)*s;return Q(N(this.fwd,N(R(this.right,o),R(this.up,a))))}state(){return{target:[...this.target],dist:this.dist,fwd:[...this.fwd],up:[...this.up]}}set(e){this.target=[...e.target],this.dist=e.dist,this.fwd=[...e.fwd],this.up=[...e.up],this.orthonormalize()}flyTo(e,t=1800,i,s){this.anim={t0:performance.now(),dur:t,a:this.state(),b:e,onDone:i,onStep:s}}step(e){if(!this.anim)return!1;const t=this.anim;let i=Math.min(1,(e-t.t0)/t.dur);const s=as(i),r=Math.log(t.a.dist),o=Math.log(t.b.dist),a=Math.hypot(...ge(t.b.target,t.a.target)),c=Math.log(Math.max(t.a.dist,t.b.dist,a*1.2)),l=Math.max(0,c-Math.max(r,o)),u=r+(o-r)*s+l*Math.sin(Math.PI*s);this.target=Ct(t.a.target,t.b.target,s),this.dist=Math.exp(u),this.fwd=Ls(t.a.fwd,t.b.fwd,s);let p=t.a.up;return this.up=Q(Ct(p,t.b.up,s)),Math.abs(W(this.up,this.fwd))>.98&&(this.up=Q(Ee(Ee(this.fwd,t.b.up),this.fwd))),this.orthonormalize(),t.onStep?.(s),i>=1&&(this.anim=null,t.onDone?.()),!0}}function Ls(n,e,t){const i=Math.max(-1,Math.min(1,W(n,e))),s=Math.acos(i);if(s<1e-4)return Q(Ct(n,e,t));if(s>Math.PI-.001){const o=Q(Ee(n,Math.abs(n[0])<.9?[1,0,0]:[0,1,0]));return nt(n,o,Math.PI*t)}const r=Math.sin(s);return Q(N(R(n,Math.sin((1-t)*s)/r),R(e,Math.sin(t*s)/r)))}const wi='let et="",Nt="",ne={},wt=200,O=80,q=360/65535,yt=[0,0,0],Mt={4:.005,5:.01,6:.005},Pt,At,Qt,Y=null,Ct=null,Ot=null,dt=null,gt=[],Vt=[],Yt=new Uint8Array(256);const he=48,ue=.70710678,P=new Map,_=new Map;let ct=0,re=400*1048576;function we(e,t){const n=_.get(e);for(n&&(ct-=n.byteLength,_.delete(e)),_.set(e,t),ct+=t.byteLength;ct>re&&_.size>1;){const r=_.keys().next().value;ct-=_.get(r).byteLength,_.delete(r)}}const bt=()=>Nt?`?v=${encodeURIComponent(Nt)}`:"";async function ye(e){const t=ne[e];if(!t){const a=await nt(et+e+bt());if(!a.ok)throw new Error(`HTTP ${a.status} ${e}`);return jt(await a.arrayBuffer())}const n=[];let r=0;for(let a=0;a<t;a++){const i=await nt(`${et}${e}.${String(a).padStart(3,"0")}${bt()}`);if(!i.ok)throw new Error(`HTTP ${i.status} ${e}.${a}`);const l=await i.arrayBuffer();n.push(l),r+=l.byteLength}const s=new Uint8Array(r);let o=0;for(const a of n)s.set(new Uint8Array(a),o),o+=a.byteLength;return jt(s.buffer)}const B=new Map,se=3;let Wt=!0;function de(e){let t=B.get(e);if(!t)for(t=nt(et+e+bt()).then(n=>{if(!n.ok)throw new Error(`HTTP ${n.status} ${e}`);return n.arrayBuffer()}),t.catch(()=>B.delete(e)),B.set(e,t);B.size>se;)B.delete(B.keys().next().value);return t}const ft=new Map,pe=1200*1e3,Me=e=>new Promise(t=>setTimeout(t,e));async function nt(e,t){for(let n=0;;n++){const r=await fetch(e,t);if(r.status!==429&&r.status!==503||n>=4)return r;const s=Number(r.headers.get("retry-after"));await Me(s>0?Math.min(s,30)*1e3:1e3*2**n)}}const ht=new Map;async function Ae(e,t,n){const r={headers:{Range:`bytes=${t}-${t+n-1}`}},s=ht.get(e);s&&!ft.has(e)&&await s.catch(()=>null);const o=ft.get(e);if(o&&performance.now()-o.t<pe){const l=await nt(o.url,r);if(l.ok)return l;ft.delete(e)}const a=nt(et+e+bt(),r);ht.has(e)||(ht.set(e,a),a.finally(()=>ht.delete(e)).catch(()=>null));const i=await a;return i.status===206&&i.redirected&&i.url&&ft.set(e,{url:i.url,t:performance.now()}),i}async function ge(e){const{path:t,off:n,n:r}=e.shard,s=B.get(t);if(s)return(await s).slice(n,n+r);if(Wt){let o=null;try{o=await Ae(t,n,r)}catch(a){console.warn("ranged fetch failed, using whole shards",a),Wt=!1}if(o){if(o.status===206)return await o.arrayBuffer();if(!o.ok)throw new Error(`HTTP ${o.status} ${t}`);const a=o.arrayBuffer();for(B.set(t,a);B.size>se;)B.delete(B.keys().next().value);return(await a).slice(n,n+r)}}return(await de(t)).slice(n,n+r)}async function jt(e){const t=new Uint8Array(e,0,Math.min(2,e.byteLength));return t[0]===31&&t[1]===139?await new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer():e}async function Zt(e,t){let n=P.get(e.idx);if(n)return P.delete(e.idx),P.set(e.idx,n),n;let r=_.get(e.idx);for(r?(_.delete(e.idx),_.set(e.idx,r)):(r=await ge(e),t&&(t.fetched=r.byteLength),we(e.idx,r)),n=Le(await jt(r),e),P.set(e.idx,n);P.size>he;)P.delete(P.keys().next().value);return n}const be=e=>(Math.imul(e+1,2654435761)>>>0)/4294967296;function me(e,t,n=1){if(!t&&n>=1)return{inst:e.inst.slice(),free:e.free.slice(),ib:e.tris.slice()};const[r,s,o]=t?t.n:[0,0,0],a=t?t.lo:-1/0,i=t?t.hi:1/0,l=e.lo,c=e.inst,g=c.length/4,f=new Uint32Array(c.length);let y=0;const b=l[0]-O,p=l[1]-O,d=l[2]-O;for(let w=0;w<g;w++){if(n<1&&be(w)>=n)continue;const x=c[4*w+1],m=c[4*w+2];if(t){const I=r*(b+(x&65535)*q)+s*(p+(x>>>16)*q)+o*(d+(m&65535)*q),L=Qt[c[4*w]&65535];if(I+L<a||I-L>i)continue}f[4*y]=c[4*w],f[4*y+1]=x,f[4*y+2]=m,f[4*y+3]=c[4*w+3],y++}if(!t)return{inst:f.slice(0,4*y),free:e.free.slice(),ib:e.tris.slice()};const h=e.free,A=h.length/4,k=new Float32Array(h.length);let U=0;for(let w=0;w<A;w++){const x=r*h[4*w]+s*h[4*w+1]+o*h[4*w+2];x>=t.lo-1.5&&x<=t.hi+1.5&&(k.set(h.subarray(4*w,4*w+4),4*U),U++)}const T=e.verts,S=e.tris,u=S.length/3,M=new Uint32Array(S.length);let E=0;const v=w=>r*T[3*w]+s*T[3*w+1]+o*T[3*w+2];for(let w=0;w<u;w++){const x=v(S[3*w]),m=v(S[3*w+1]),I=v(S[3*w+2]);Math.max(x,m,I)>=t.lo-1&&Math.min(x,m,I)<=t.hi+1&&(M[3*E]=S[3*w],M[3*E+1]=S[3*w+1],M[3*E+2]=S[3*w+2],E++)}return{inst:f.slice(0,4*y),free:k.slice(0,4*U),ib:M.slice(0,3*E)}}const Jt=["PI","PE","PC","SM","PS","sterol","other"];function oe(e){const t=Jt.map(()=>0);if(e)for(const[s,o]of Object.entries(e)){if(typeof o!="number")continue;const a=Jt.indexOf(s);t[a>=0?a:6]+=o}t[5]=0;const n=t.reduce((s,o)=>s+o,0)||1;let r=0;return t.map(s=>r+=s/n)}async function xe(e){et=e.base,Nt=e.ver??"",ne=e.split??{},wt=e.tileNm,O=e.qOrg,q=e.qRange/65535,yt=e.origin,e.polyQ&&(Mt={...Mt,...e.polyQ}),e.rawBudgetMB&&(re=e.rawBudgetMB*1048576),dt=e.libTag??null;const t=e.types,n=t.length;Pt=new Uint32Array(n),At=new Uint32Array(n),Qt=new Float32Array(n);for(let s=0;s<n;s++)Pt[s]=t[s].bo,At[s]=t[s].nb,Qt[s]=t[s].br;const r=e.lipids??{};gt=[],Vt=[];for(const s of e.membranes??[]){gt[s.code]=oe(r[s.name]??r.default);const o=String(s.leaflets??"bilayer").toLowerCase();Vt[s.code]=o==="none"?[]:o.startsWith("mono")||o==="1"?[1]:[-1,1]}e.beadQ!==void 0&&(pt=e.beadQ),Yt=new Uint8Array(256);for(const s of e.maskRegions??[])s>=0&&s<256&&(Yt[s]=1)}let pt=.005;function ke(){return Ct||(Ct=(async()=>{const e=await ye("library/beads.bin"),t=new Int16Array(e),n=e.byteLength/8;Y=new Float32Array(n*3);for(let r=0;r<n;r++)Y[3*r]=t[4*r]*pt,Y[3*r+1]=t[4*r+1]*pt,Y[3*r+2]=t[4*r+2]*pt})()),Ct}const Ue=844383065,Te=1,ve=2,Se=3,Dt=4,$e=5,Ee=6,Ie=7,qt=e=>e+3&-4;function te(e,t,n,r,s,o,a){const i=new Uint32Array(e.slice(t,t+4*n));t+=4*n;let l=0;for(let d=0;d<n;d++)l+=i[d];const c=new Int32Array(e.slice(t,t+12*n));t+=12*n;const g=new Int8Array(e,t,Math.max(0,3*(l-n))),f=new Float32Array(4*l),y=new Uint32Array(f.buffer);let b=0,p=0;for(let d=0;d<n;d++){let h=c[3*d],A=c[3*d+1],k=c[3*d+2];for(let U=0;U<i[d];U++)U>0&&(h+=g[3*b],A+=g[3*b+1],k+=g[3*b+2],b++),f[4*p]=r[0]+h*s,f[4*p+1]=r[1]+A*s,f[4*p+2]=r[2]+k*s,y[4*p+3]=((a?a[d]&15:o)|(d&32767)<<4)>>>0,p++}return f}function ee(e,t){const n=new Uint32Array(e.length),r=e.length/4,s=t.length/2;for(let o=0;o<r;o++){const a=e[4*o],i=a&65535,l=i<s?t[2*i]:0,c=i<s?t[2*i+1]&65535:0;n[4*o]=(l&65535|Math.min(c,255)<<16|(a>>>16&63)<<24|a>>>30<<30)>>>0,n[4*o+1]=e[4*o+1],n[4*o+2]=e[4*o+2],n[4*o+3]=e[4*o+3]}return n}function Le(e,t){const n=new Uint32Array(e,0,32);if(n[0]!==Ue)throw new Error(`tile ${t.ix},${t.iy},${t.iz}: not YCT2 (magic ${n[0].toString(16)})`);if(n[1]>>>16!==2)throw new Error(`tile format major ${n[1]>>>16}: this viewer reads YCT2 2.x`);if(dt!==null&&n[14]!==0&&n[14]!==dt)throw new Error(`tile ${t.ix},${t.iy},${t.iz}: library tag ${n[14]} != ${dt} (tile and library of different builds)`);const r=new Int32Array(e,8,3),s=[yt[0]+r[0]*wt,yt[1]+r[1]*wt,yt[2]+r[2]*wt],o=n[12],a=n[13];let i=new Uint32Array(0),l=new Uint32Array(0),c=new Uint32Array(0);const g=[];let f=new Float32Array(0),y=new Uint32Array(0),b=new Uint16Array(0);const p=new Uint32Array(e,128,4*o),d=[];for(let u=0;u<o;u++)d.push([p[4*u],p[4*u+1],p[4*u+2],p[4*u+3]]);for(const[u,M,E,v]of d)if(u===Te)i=new Uint32Array(e.slice(M,M+8*v));else if(u===ve)l=new Uint32Array(e.slice(M,M+16*v));else if(u===Se)c=new Uint32Array(e.slice(M,M+16*v));else if(u===Dt||u===$e)g.push(te(e,M,v,s,Mt[u],u===Dt?0:1,null));else if(u===Ee){const w=new Uint16Array(e.slice(M,M+2*v));g.push(te(e,M+qt(2*v),v,s,Mt[u],0,w))}else if(u===Ie){const w=t.nVert,x=t.nTri;let m=M;const I=new Uint16Array(e.slice(m,m+6*w));m+=qt(6*w),f=new Float32Array(3*w);for(let L=0;L<w;L++)for(let z=0;z<3;z++)f[3*L+z]=s[z]-O+I[3*L+z]*q;a&1?(y=new Uint32Array(e.slice(m,m+12*x)),m+=12*x):(y=Uint32Array.from(new Uint16Array(e.slice(m,m+6*x))),m+=qt(6*x)),b=new Uint16Array(e.slice(m,m+2*x))}l=ee(l,i),c=ee(c,i);let h=0;for(const u of g)h+=u.length;const A=new Float32Array(h);{let u=0;for(const M of g)A.set(M,u),u+=M.length}const k=f.length/3,U=y.length/3,T=new Float32Array(k*3),S=new Uint16Array(k);for(let u=0;u<U;u++){const M=y[3*u],E=y[3*u+1],v=y[3*u+2],w=f[3*E]-f[3*M],x=f[3*E+1]-f[3*M+1],m=f[3*E+2]-f[3*M+2],I=f[3*v]-f[3*M],L=f[3*v+1]-f[3*M+1],z=f[3*v+2]-f[3*M+2],j=x*z-m*L,R=m*I-w*z,G=w*L-x*I;for(const C of[M,E,v])T[3*C]+=j,T[3*C+1]+=R,T[3*C+2]+=G,S[C]=b[u]}for(let u=0;u<k;u++){const M=Math.hypot(T[3*u],T[3*u+1],T[3*u+2])||1;T[3*u]/=M,T[3*u+1]/=M,T[3*u+2]/=M}return{lo:s,inst:l,ghost:c,free:A,verts:f,normals:T,tris:y,fmem:b,vmem:S}}const Ht=e=>(e<<16>>16)/32767*ue;function ze(e,t,n,r){const s=e[4*t],o=e[4*t+1],a=e[4*t+2],i=e[4*t+3];r[0]=n[0]-O+(o&65535)*q,r[1]=n[1]-O+(o>>>16)*q,r[2]=n[2]-O+(a&65535)*q;const l=Ht(a>>>16),c=Ht(i&65535),g=Ht(i>>>16),f=Math.sqrt(Math.max(0,1-l*l-c*c-g*g)),y=s>>>30,b=y===0?[f,l,c,g]:y===1?[l,f,c,g]:y===2?[l,c,f,g]:[l,c,g,f],[p,d,h,A]=b;return r[3]=p*p+d*d-h*h-A*A,r[4]=2*(d*h-p*A),r[5]=2*(d*A+p*h),r[6]=2*(d*h+p*A),r[7]=p*p-d*d+h*h-A*A,r[8]=2*(h*A-p*d),r[9]=2*(d*A-p*h),r[10]=2*(h*A+p*d),r[11]=p*p-d*d-h*h+A*A,{type:s&65535,region:s>>>16&255,flags:s>>>24&63}}class Be{h;tbl;mask;start;pts;inst;constructor(t,n,r,s){this.h=s;let o=1;for(;o<r*2;)o<<=1;o=Math.max(o,1024),this.tbl=o,this.mask=o-1;const a=new Uint32Array(r),i=new Uint32Array(o+1);for(let c=0;c<r;c++)a[c]=this.k(Math.floor(t[3*c]/s),Math.floor(t[3*c+1]/s),Math.floor(t[3*c+2]/s)),i[a[c]+1]++;for(let c=0;c<o;c++)i[c+1]+=i[c];this.start=i.slice(),this.pts=new Float32Array(r*3),this.inst=new Int32Array(r);const l=i.slice(0,o);for(let c=0;c<r;c++){const g=l[a[c]]++;this.pts[3*g]=t[3*c],this.pts[3*g+1]=t[3*c+1],this.pts[3*g+2]=t[3*c+2],this.inst[g]=n[c]}}k(t,n,r){return(Math.imul(t,73856093)^Math.imul(n,19349663)^Math.imul(r,83492791))&this.mask}near(t,n,r,s,o=-1){const a=this.h,i=Math.floor(t/a),l=Math.floor(n/a),c=Math.floor(r/a),g=s*s;for(let f=-1;f<=1;f++)for(let y=-1;y<=1;y++)for(let b=-1;b<=1;b++){const p=this.k(i+f,l+y,c+b);for(let d=this.start[p],h=this.start[p+1];d<h;d++){const A=this.pts[3*d]-t,k=this.pts[3*d+1]-n,U=this.pts[3*d+2]-r;if(A*A+k*k+U*U<g&&this.inst[d]!==o)return!0}}return!1}}function Fe(e){let t=0;const n=new Float64Array(12),r=Y;for(const i of e)t+=At[i.w[4*i.i]&65535];const s=new Float32Array(t*3),o=new Int32Array(t);let a=0;for(const i of e){const{type:l}=ze(i.w,i.i,i.lo,n),c=Pt[l],g=At[l];for(let f=0;f<g;f++){const y=r[3*(c+f)],b=r[3*(c+f)+1],p=r[3*(c+f)+2];s[3*a]=n[0]+n[3]*y+n[4]*b+n[5]*p,s[3*a+1]=n[1]+n[6]*y+n[7]*b+n[8]*p,s[3*a+2]=n[2]+n[9]*y+n[10]*b+n[11]*p,o[a]=i.id,a++}}return{xyz:s,owner:o,n:t}}function _e(e){let t=e>>>0;return()=>{t=t+1831565813>>>0;let n=t;return n=Math.imul(n^n>>>15,n|1),n^=n+Math.imul(n^n>>>7,n|61),((n^n>>>14)>>>0)/4294967296}}const Ce=(e,t,n)=>{let r=Math.imul(e^2654435769,2246822507)^Math.imul(t+1663821227,3266489909)^Math.imul(n+668265263,374761393);return r^=r>>>16,r=Math.imul(r,2146121005),r^=r>>>15,r=Math.imul(r,2221713035),r^=r>>>16,r>>>0};function Oe(e,t,n){const r=Math.abs(e)+Math.abs(t)+Math.abs(n)||1;let s=e/r,o=t/r;if(n<0){const l=s;s=(1-Math.abs(o))*(l>=0?1:-1),o=(1-Math.abs(l))*(o>=0?1:-1)}const a=Math.max(0,Math.min(255,Math.round((s+1)*127.5))),i=Math.max(0,Math.min(255,Math.round((o+1)*127.5)));return a|i<<8}const qe=.65,He=.95;function ut(e,t,n,r){return e.n[0]*t+e.n[1]*n+e.n[2]*r-e.d}function Ne(e,t,n){const r=[],s={lipCand:0,lipMasked:0};if(t.tris.length&&n.mode==="slab"&&Y){const i=[],l=t.inst.length/4,c=t.ghost.length/4;for(let h=0;h<l;h++){const A=t.inst[4*h];(A>>>24&1||Yt[A>>>16&255])&&i.push({w:t.inst,i:h,lo:t.lo,id:h})}for(let h=0;h<c;h++)i.push({w:t.ghost,i:h,lo:t.lo,id:l+h});const g=Fe(i),f=new Be(g.xyz,g.owner,g.n,1),y=t.verts,b=t.normals,p=t.tris,d=p.length/3;for(let h=0;h<d;h++){const A=p[3*h],k=p[3*h+1],U=p[3*h+2],T=y[3*A],S=y[3*A+1],u=y[3*A+2],M=y[3*k],E=y[3*k+1],v=y[3*k+2],w=y[3*U],x=y[3*U+1],m=y[3*U+2],I=ut(n,T,S,u),L=ut(n,M,E,v),z=ut(n,w,x,m);if(Math.max(I,L,z)<n.lo-3||Math.min(I,L,z)>n.hi+3)continue;const j=M-T,R=E-S,G=v-u,C=w-T,mt=x-S,xt=m-u,ie=.5*Math.hypot(R*xt-G*mt,G*C-j*xt,j*mt-R*C),kt=t.fmem[h],ae=gt[kt]??gt[0]??oe(void 0);for(const X of Vt[kt]??[-1,1]){const K=_e(Ce(e,h,X+7)),Ut=ie/qe,rt=Math.floor(Ut)+(K()<Ut-Math.floor(Ut)?1:0);if(!rt)continue;const st=Math.ceil(Math.sqrt(rt)),Tt=st*st,Q=new Uint16Array(Tt);for(let $=0;$<Tt;$++)Q[$]=$;for(let $=0;$<rt;$++){const W=$+Math.floor(K()*(Tt-$)),F=Q[$];Q[$]=Q[W],Q[W]=F}for(let $=0;$<rt;$++){const W=Q[$],F=Math.floor(Math.sqrt(W)),Rt=W-F*F,V=Rt>>1,le=(Rt&1)===0;let Z,J,vt,St,$t,Et;le?(Z=F,J=V,vt=F+1,St=V,$t=F+1,Et=V+1):(Z=F,J=V,vt=F+1,St=V+1,$t=F,Et=V+1);let D=K(),tt=K();D+tt>1&&(D=1-D,tt=1-tt);const ce=Z+D*(vt-Z)+tt*($t-Z),Gt=J+D*(St-J)+tt*(Et-J),H=(ce-Gt)/st,N=Gt/st,It=1-H-N,Lt=T+H*j+N*C,zt=S+H*R+N*mt,Bt=u+H*G+N*xt;let ot=It*b[3*A]+H*b[3*k]+N*b[3*U],it=It*b[3*A+1]+H*b[3*k+1]+N*b[3*U+1],at=It*b[3*A+2]+H*b[3*k+2]+N*b[3*U+2];const Ft=Math.hypot(ot,it,at)||1;ot/=Ft,it/=Ft,at/=Ft;const fe=K();let lt=0;for(;lt<6&&fe>ae[lt];)lt++;s.lipCand++;const Xt=ut(n,Lt,zt,Bt);if(Xt<n.lo-2.5||Xt>n.hi+2.5)continue;let Kt=!1;for(const _t of[1.95,1.25,.55])if(f.near(Lt+ot*X*_t,zt+it*X*_t,Bt+at*X*_t,He)){Kt=!0;break}if(Kt){s.lipMasked++;continue}r.push(Lt,zt,Bt,(Oe(ot,it,at)|lt<<16|(X>0?1:0)<<19|(kt&15)<<20)>>>0)}}}}const o=new Float32Array(r.length),a=new Uint32Array(o.buffer);for(let i=0;i<r.length;i+=4)o[i]=r[i],o[i+1]=r[i+1],o[i+2]=r[i+2],a[i+3]=r[i+3];return{lipids:o,free:new Float32Array(0),stats:s}}self.onmessage=async e=>{const t=e.data;try{if(t.cmd==="init"){Ot=xe(t),await Ot,self.postMessage({cmd:"ready"});return}if(await Ot,t.cmd==="load"){const n={fetched:0},r=await Zt(t,n),s=r.verts.length/3,o=new Float32Array(s*8),a=new Uint32Array(o.buffer);for(let l=0;l<s;l++)o[8*l]=r.verts[3*l],o[8*l+1]=r.verts[3*l+1],o[8*l+2]=r.verts[3*l+2],a[8*l+3]=r.vmem[l],o[8*l+4]=r.normals[3*l],o[8*l+5]=r.normals[3*l+1],o[8*l+6]=r.normals[3*l+2];const i=me(r,t.clip??null,t.thin??1);self.postMessage({cmd:"loaded",idx:t.idx,inst:i.inst,free:i.free,vb:o,ib:i.ib,lo:r.lo,clip:t.clip??null,thin:t.thin??1,nFull:r.inst.length/4,fetched:n.fetched},[i.inst.buffer,i.free.buffer,o.buffer,i.ib.buffer])}else if(t.cmd==="detail"){const n=await Zt(t);n.tris.length&&await ke();const r=performance.now(),s=Ne(t.idx,n,t.range);self.postMessage({cmd:"detail",idx:t.idx,key:t.key,lipids:s.lipids,free:s.free,stats:s.stats,ms:performance.now()-r},[s.lipids.buffer,s.free.buffer])}}catch(n){self.postMessage({cmd:"error",idx:t.idx,key:t.key,req:t.cmd,error:String(n&&n.stack||n)})}};\n',Yt=typeof self<"u"&&self.Blob&&new Blob(["URL.revokeObjectURL(import.meta.url);",wi],{type:"text/javascript;charset=utf-8"});function ks(n){let e;try{if(e=Yt&&(self.URL||self.webkitURL).createObjectURL(Yt),!e)throw"";const t=new Worker(e,{type:"module",name:n?.name});return t.addEventListener("error",()=>{(self.URL||self.webkitURL).revokeObjectURL(e)}),t}catch{return new Worker("data:text/javascript;charset=utf-8,"+encodeURIComponent(wi),{type:"module",name:n?.name})}}const Je=70,Xt=60,Qt=[100,60,30,15,6],_s=250,Lt=[1,.75,.55,.4,.3,.22,.16,.12];class kt{used;n;count=0;high=0;first=0;constructor(e){this.n=e,this.used=new Uint8Array(e)}alloc(e){if(e<=0)return[];if(this.n-this.count<e)return null;const t=[];let i=this.first;for(;i<this.n&&t.length<e;i++)this.used[i]||(this.used[i]=1,t.push(i));return this.first=i,this.count+=e,this.high=Math.max(this.high,t[t.length-1]+1),t}free(e){for(const t of e)this.used[t]&&(this.used[t]=0,this.count--,t<this.first&&(this.first=t));for(;this.high>0&&!this.used[this.high-1];)this.high--}get freeCount(){return this.n-this.count}}class Ss{idx;r;lib;ev;TILE;HALF_DIAG;workers=[];state;loaded=new Map;instA;lipA;freeA;slots=[];pageTile;pageLocal;tileState;desired=[];desiredSet=new Set;inflight=0;maxInflight=12;clipNow=null;planeKey="";planeT=0;thinNow=1;secWant=0;secHave=0;detInflight=0;maxDetInflight=3;frameNo=0;onChange=()=>{};onTileLoaded=[];bytesLoaded=0;tilesLoadedTotal=0;starved=!1;detailStats={lipids:0};detailEnabled=!0;lastLoadErr="";shellRange=null;deepAt=Xt;outAt=-Je;whole=!0;constructor(e,t,i,s,r,o){this.idx=e,this.r=t,this.lib=i,this.ev=s,this.TILE=e.tileNm,this.HALF_DIAG=e.tileNm*Math.sqrt(3)/2,this.state=new Uint8Array(e.n),this.tileState=new Uint32Array(e.dims[0]*e.dims[1]*e.dims[2]),this.instA=new kt(t.instPages),this.lipA=new kt(t.lipPages),this.freeA=new kt(t.freePages);for(let a=t.maxSlots-1;a>=0;a--)this.slots.push(a);this.pageTile=new Int32Array(t.instPages).fill(-1),this.pageLocal=new Uint32Array(t.instPages);for(let a=0;a<r;a++){const c=new ks;c.onmessage=l=>this.onMessage(l.data),c.postMessage({cmd:"init",base:ce.base,ver:ce.ver,split:ce.split,tileNm:e.tileNm,qOrg:e.qOrg,qRange:e.qRange,origin:e.origin,libTag:e.libTag,rawBudgetMB:Math.round(Ts()/r),polyQ:e.polyQ,types:i.types.map(l=>({bo:l.bo,nb:l.nb,br:l.br})),...o}),this.workers.push(c)}this.maxInflight=16}tileMsg(e){const t={idx:e,ix:this.idx.ix[e],iy:this.idx.iy[e],iz:this.idx.iz[e],nVert:this.idx.nVert[e],nTri:this.idx.nTri[e],shard:{path:this.idx.shard[e],off:this.idx.off[e],n:this.idx.gz[e]}};return this.clipNow&&(t.clip=this.clipNow),this.thinNow<1&&(t.thin=this.thinNow),t}workerFor(e){const t=this.idx.shard[e];let i=0;for(let s=0;s<t.length;s++)i=Math.imul(i,31)+t.charCodeAt(s)>>>0;return this.workers[i%this.workers.length]}covered(e){if(Math.abs(e.thin-this.thinNow)>1e-6)return!1;const t=this.clipNow;if(!t)return e.clip===null;if(!e.clip)return!0;const i=e.clip.n,s=t.d,r=t.d+t.slab;return i[0]*t.n[0]+i[1]*t.n[1]+i[2]*t.n[2]>.99995&&e.clip.lo<=s+.5&&e.clip.hi>=r-.5}cost(e,t=this.clipNow,i=this.thinNow){const s=this.loaded.get(e);if(s&&i===this.thinNow&&this.covered(s))return s.nInst;const r=this.idx.nInst[e]*i;if(!t)return Math.ceil(r);const o=this.tileCenter(e),a=W(t.n,o),c=this.TILE/2*(Math.abs(t.n[0])+Math.abs(t.n[1])+Math.abs(t.n[2])),l=Math.min(t.hi+10,a+c)-Math.max(t.lo-10,a-c);return Math.ceil(r*Math.max(0,Math.min(1,l/(2*c))))}setTileBits(e,t,i,s,r){const o=vi(this.idx,e,t,i);if(o<0)return;const a=this.tileState[o]&~r|s;a!==this.tileState[o]&&(this.tileState[o]=a,this.r.device.queue.writeBuffer(this.r.tileState,o*4,this.tileState,o,1))}tileCenter(e){const t=this.idx.origin,i=this.TILE;return[t[0]+(this.idx.ix[e]+.5)*i,t[1]+(this.idx.iy[e]+.5)*i,t[2]+(this.idx.iz[e]+.5)*i]}update(e,t,i,s,r,o,a){if(this.frameNo++,o){this.desired=[],this.desiredSet.clear();return}const c=e.eye,l=e.frustum(t),u=this.idx.n,p=[s[0],s[1],s[2]],d=L=>({n:p,lo:s[3]-L,hi:s[3]+r+L,d:s[3],slab:r});this.clipNow=this.whole&&i?d(Qt[0]):null;const b=i?`${s.join(",")},${r}`:"off",g=performance.now();b!==this.planeKey&&(this.planeKey=b,this.planeT=g);const m=this.TILE/2*(Math.abs(p[0])+Math.abs(p[1])+Math.abs(p[2])),f=[];for(let L=0;L<u;L++){const T=this.tileCenter(L),h=ge(T,c),M=this.HALF_DIAG+Je;let v=!0;for(let C=0;C<5;C++)if(l[4*C]*h[0]+l[4*C+1]*h[1]+l[4*C+2]*h[2]+l[4*C+3]<-M){v=!1;break}if(v){if(i){const C=W(p,T)-s[3];if(C+m+Je<0||C-m-Je>r)continue}else{const C=this.tileShellRange();if(C[5*L]>this.deepAt||C[5*L+1]<this.outAt)continue;const I=ge(c,T),F=5*L+2;if(C[F]*I[0]+C[F+1]*I[1]+C[F+2]*I[2]<-300)continue}f.push({i:L,d:this.whole&&i?Ce(ge(T,e.target))+.1*Ce(h):Ce(h)})}}f.sort((L,T)=>L.d-T.d);let y=this.r.instPages*Y*.94,x=this.r.maxSlots-8;if(this.clipNow)for(const L of Qt){const T=d(L);let h=0;for(const M of f)h+=this.cost(M.i,T,1)+Y/2;if(this.clipNow=T,h<=.9*y)break}const A=L=>{let T=0;for(const h of f)T+=Math.ceil(this.cost(h.i,this.clipNow,L)/Y);return T*Y};let k=1;if(f.length<=x&&A(1)>y){k=Lt[Lt.length-1];for(const L of Lt)if(A(L)<=y){k=L;break}}k>this.thinNow&&A(k)>.95*y&&(k=this.thinNow),k!==this.thinNow&&(this.thinNow=k,this.planeT=g);const E=g-this.planeT>_s,P=[];for(const L of f){const T=this.cost(L.i);if(T>y||x<=0){this.starved=!0;break}y-=Math.ceil(T/Y)*Y,x--,P.push(L.i)}P.length===f.length&&(this.starved=!1),this.desired=P,this.desiredSet=new Set(P),this.secWant=f.length,this.secHave=0;for(const L of f){const T=this.loaded.get(L.i);T&&this.covered(T)&&this.secHave++}for(const L of P){const T=this.loaded.get(L);T&&(T.lastUsed=this.frameNo)}for(const L of P){if(this.inflight>=this.maxInflight)break;if(this.state[L]===0)this.state[L]=1,this.inflight++,this.workerFor(L).postMessage({cmd:"load",...this.tileMsg(L)});else if(this.state[L]===2){const T=this.loaded.get(L);if(T.reclip||this.covered(T))continue;const h=this.clipNow;if(!E&&!(h&&T.clip&&(T.clip.hi<h.d||T.clip.lo>h.d+h.slab)))continue;T.reclip=!0,this.inflight++,this.workerFor(L).postMessage({cmd:"load",...this.tileMsg(L)})}}this.updateDetail(e,i,s,r,a)}tileShellRange(){if(this.shellRange)return this.shellRange;const e=this.idx.n,t=new Float32Array(5*e),i=this.TILE,s=this.idx.origin,r=this.ev;for(let l=0;l<e;l++){const u=s[0]+this.idx.ix[l]*i,p=s[1]+this.idx.iy[l]*i,d=s[2]+this.idx.iz[l]*i;let b=1/0,g=-1/0;for(let f=0;f<=2;f++)for(let y=0;y<=2;y++)for(let x=0;x<=2;x++){const A=r.domainDepth(u+i/2*f,p+i/2*y,d+i/2*x);b=Math.min(b,A),g=Math.max(g,A)}const m=r.domainNormal(u+i/2,p+i/2,d+i/2,60);t[5*l]=b,t[5*l+1]=g,t.set(m,5*l+2)}let o=-1/0,a=1/0;for(let l=0;l<e;l++)o=Math.max(o,t[5*l+1]),a=Math.min(a,t[5*l]);const c=this.HALF_DIAG/2;return this.deepAt=Math.min(Xt+c,o-.5),this.outAt=Math.max(-c-Je,a+.5),this.shellRange=t}updateDetail(e,t,i,s,r){if(!this.detailEnabled)return;const o=e.eye,a=e.pxPerNmAtUnit(r),c=[i[0],i[1],i[2]],l=Math.min(s,250),u=[];for(const d of this.desired){const b=this.loaded.get(d);if(!b||this.idx.nTri[d]===0)continue;const g=this.tileCenter(d),m=Math.max(1,Ce(ge(g,o))-this.HALF_DIAG);a/m*.55<.8||t&&u.push({t:b,d:m})}u.sort((d,b)=>d.d-b.d);const p=new Set(u.slice(0,40).map(d=>d.t.idx));for(const d of this.loaded.values())d.det&&!p.has(d.idx)&&!d.detPending&&this.dropDetail(d);for(const{t:d}of u.slice(0,40)){if(this.detInflight>=this.maxDetInflight)break;if(d.detPending)continue;const b=d.det;let g=!1;if(b&&(t?g=!b.shell&&W(b.n,c)>.99985&&b.a<=i[3]+.5&&b.b>=i[3]+l-.5:g=b.shell),g)continue;const m=Math.max(10,.35*l),f=t?{n:c,d:i[3],lo:-m,hi:l+m,mode:"slab"}:{n:c,d:i[3],lo:0,hi:0,mode:"shell"};d.detPending=!0,this.detInflight++;const y=t?`${i[3]-m}|${i[3]+l+m}`:"shell";d._req={n:c,a:i[3]-m,b:i[3]+l+m,shell:!t},this.workerFor(d.idx).postMessage({cmd:"detail",...this.tileMsg(d.idx),key:y,range:f})}}dropDetail(e){this.lipA.free(e.lipPages),this.freeA.free(e.detPages),this.clearSPages(this.r.lipPagesBuf,e.lipPages),this.clearSPages(this.r.freePagesBuf,e.detPages),e.lipPages=[],e.detPages=[],e.nLip=0,e.nDet=0,e.det=null,e.underMesh&&(e.underMesh=!1,this.r.setMeshSlot(e.slot,!1)),this.syncHigh()}clearSPages(e,t){const i=new Uint32Array(4);for(const s of t)this.r.device.queue.writeBuffer(e,s*16,i)}syncHigh(){this.r.usedInstPages=this.instA.high,this.r.usedLipPages=this.lipA.high,this.r.usedFreePages=this.freeA.high}evictOne(e){let t=null;for(const i of this.loaded.values())i.idx===e||this.desiredSet.has(i.idx)||(!t||i.lastUsed<t.lastUsed)&&(t=i);return t?(this.evict(t),!0):!1}evict(e){const t=this.r.device.queue,i=new Float32Array(4);for(const s of e.pages)t.writeBuffer(this.r.pageOrg,s*16,i),this.pageTile[s]=-1;this.instA.free(e.pages),this.freeA.free(e.basePages),this.clearSPages(this.r.freePagesBuf,e.basePages),this.lipA.free(e.lipPages),this.clearSPages(this.r.lipPagesBuf,e.lipPages),this.freeA.free(e.detPages),this.clearSPages(this.r.freePagesBuf,e.detPages),e.vb?.destroy(),e.ib?.destroy(),this.slots.push(e.slot),this.loaded.delete(e.idx),this.state[e.idx]=0,this.setTileBits(this.idx.ix[e.idx],this.idx.iy[e.idx],this.idx.iz[e.idx],0,1),this.syncHigh()}allocWithEvict(e,t,i){let s=e.alloc(t);for(;!s&&this.evictOne(i);)s=e.alloc(t);return s}onMessage(e){if(e.cmd!=="ready"){if(e.cmd==="error"){if(console.warn("worker error",e.req,e.idx,e.error),this.lastLoadErr=String(e.error).split(`
`)[0],e.req==="load"){this.inflight--;const t=this.loaded.get(e.idx);t?t.reclip=!1:this.state[e.idx]=0}if(e.req==="detail"){this.detInflight--;const t=this.loaded.get(e.idx);t&&(t.detPending=!1)}return}e.cmd==="loaded"&&(this.inflight--,this.onLoaded(e)),e.cmd==="detail"&&(this.detInflight--,this.onDetail(e))}}onLoaded(e){const t=e.idx,i=this.loaded.get(t);if(!this.desiredSet.has(t)){i?i.reclip=!1:this.state[t]=0,this.onChange();return}i&&this.evict(i);const s=e.inst,r=s.length/4,o=this.r.device.queue;this.slots.length||this.evictOne(t);const a=this.allocWithEvict(this.instA,Math.ceil(r/Y),t);if(!a||!this.slots.length){this.state[t]=0,this.starved=!0,a&&this.instA.free(a);return}const c=this.slots.pop(),l=e.lo,u=new ArrayBuffer(16),p=new Float32Array(u),d=new Uint32Array(u),b=this.idx.qOrg;p[0]=l[0]-b,p[1]=l[1]-b,p[2]=l[2]-b,a.forEach((P,L)=>{const T=Math.min(Y,r-L*Y);o.writeBuffer(this.r.inst,P*Y*16,s.buffer,L*Y*16,T*16),d[3]=T,o.writeBuffer(this.r.pageOrg,P*16,u),this.pageTile[P]=t,this.pageLocal[P]=L*Y});const g=e.free,m=g.length/4;let f=[],y=!1;if(m){const P=this.allocWithEvict(this.freeA,Math.ceil(m/ee),t);P?(f=P,this.writeSpheres(this.r.freePool,this.r.freePagesBuf,P,g,c)):y=!0}let x=null,A=null;const k=e.ib.length;k&&(x=this.r.device.createBuffer({size:e.vb.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),o.writeBuffer(x,0,e.vb),A=this.r.device.createBuffer({size:Math.ceil(e.ib.byteLength/4)*4,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST}),o.writeBuffer(A,0,e.ib),this.r.setMeshSlot(c,!1));const E={idx:t,slot:c,lo:l,inst:s,nInst:r,pages:a,basePages:f,nBase:m,lipPages:[],detPages:[],nLip:0,nDet:0,vb:x,ib:A,nIdx:k,lastUsed:this.frameNo,det:null,detPending:!1,underMesh:!1,baseFreeMissing:y,clip:e.clip??null,reclip:!1,nFull:e.nFull??r,thin:e.thin??1};this.loaded.set(t,E),this.state[t]=2,this.setTileBits(this.idx.ix[t],this.idx.iy[t],this.idx.iz[t],1,0),this.bytesLoaded+=e.fetched??this.idx.gz[t],this.tilesLoadedTotal++,this.syncHigh();for(const P of this.onTileLoaded.slice())P(E);this.onChange()}writeSpheres(e,t,i,s,r){const o=this.r.device.queue,a=s.length/4;i.forEach((c,l)=>{const u=Math.min(ee,a-l*ee);o.writeBuffer(e,c*ee*16,s.buffer,s.byteOffset+l*ee*16,u*16),o.writeBuffer(t,c*16,new Uint32Array([u,r,1,0]))})}onDetail(e){const t=this.loaded.get(e.idx),i=t&&t._req;if(!t||!i)return;t.detPending=!1,this.lipA.free(t.lipPages),this.clearSPages(this.r.lipPagesBuf,t.lipPages),this.freeA.free(t.detPages),this.clearSPages(this.r.freePagesBuf,t.detPages),t.lipPages=[],t.detPages=[];const s=e.lipids,r=e.free,o=s.length/4,a=r.length/4;if(o){const l=this.lipA.alloc(Math.ceil(o/ee))??this.freeDetailSpace(this.lipA,Math.ceil(o/ee),t.idx);l&&(t.lipPages=l,this.writeSpheres(this.r.lipPool,this.r.lipPagesBuf,l,s,t.slot))}if(a){const l=this.freeA.alloc(Math.ceil(a/ee))??this.freeDetailSpace(this.freeA,Math.ceil(a/ee),t.idx);l&&(t.detPages=l,this.writeSpheres(this.r.freePool,this.r.freePagesBuf,l,r,t.slot))}t.nLip=t.lipPages.length?o:0,t.nDet=t.detPages.length?a:0,t.det={n:i.n,a:i.a,b:i.b,shell:i.shell};const c=t.nLip>0;c!==t.underMesh&&t.nIdx&&(t.underMesh=c,this.r.setMeshSlot(t.slot,c)),this.detailStats.lipids+=e.stats.lipCand,this.syncHigh(),this.onChange()}freeDetailSpace(e,t,i){const s=[...this.loaded.values()].filter(r=>r.idx!==i&&(r.lipPages.length||r.detPages.length)&&!this.desiredSet.has(r.idx));for(const r of s){this.dropDetail(r);const o=e.alloc(t);if(o)return o}return null}meshDraws(){const e=[];for(const t of this.loaded.values())t.nIdx&&t.vb&&t.ib&&e.push({slot:t.slot,vb:t.vb,ib:t.ib,nIdx:t.nIdx,under:t.underMesh});return e}instanceAt(e){const t=Math.floor(e/Y),i=this.pageTile[t];if(i<0)return null;const s=this.loaded.get(i);if(!s)return null;const r=this.pageLocal[t]+e%Y;return{t:s,local:r,...this.decode(s,r)}}decode(e,t){const i=e.inst,s=i[4*t],r=i[4*t+1],o=i[4*t+2],a=this.idx.qRange/65535,c=this.idx.qOrg,l=[e.lo[0]-c+(r&65535)*a,e.lo[1]-c+(r>>>16)*a,e.lo[2]-c+(o&65535)*a];return{type:s&65535,region:s>>>16&255,flags:s>>>24&63,p:l}}poolIndex(e,t){return e.pages[Math.floor(t/Y)]*Y+t%Y}tileBySlot(e){for(const t of this.loaded.values())if(t.slot===e)return t;return null}countLoaded(e){let t=0;for(const i of this.loaded.values()){const s=i.inst;for(let r=0;r<i.nInst;r++)(s[4*r]&65535)===e&&t++}return t}nearestInTile(e,t,i){let s=-1,r=1e18;for(let o=0;o<e.nInst;o++){if((e.inst[4*o]&65535)!==t)continue;const a=this.decode(e,o),c=(a.p[0]-i[0])**2+(a.p[1]-i[1])**2+(a.p[2]-i[2])**2;c<r&&(r=c,s=o)}return s}totals(){let e=0,t=0,i=0,s=0;for(const r of this.loaded.values())e+=r.nInst,t+=r.nLip,i+=r.nBase+r.nDet,s+=r.nIdx/3;return{tiles:this.loaded.size,inst:e,lip:t,free:i,mesh:s,inflight:this.inflight+this.detInflight,desired:this.desired.length,ovBlocks:0,ovSpheres:0,secWant:this.secWant,secHave:this.secHave,clipMargin:this.clipNow?this.clipNow.d-this.clipNow.lo:null,instCap:Math.floor(this.r.instPages*Y*.94),thin:this.thinNow}}pendingForView(){let e=0;for(const i of this.desired)(this.state[i]!==2||this.clipNow&&!this.covered(this.loaded.get(i)))&&e++;let t=0;for(const i of this.loaded.values())i.detPending&&t++;return e+t}}function Ts(){const n=navigator.deviceMemory;return Math.max(200,Math.min(500,Math.round((n??8)*64)))}function As(n,e){const t=n.slots?.[e]??n.constants?.[e];if(t==null)throw new Error(`geometry.json lacks evaluator constant ${e}`);return Number(t)}class gt{G;geo;pores;nPores;PT;PQ;PC;K={};grid;nMem;nRow;nLab;tab;r0;data0;domainMem=-1;domainRows=0;exteriorCode=-1;outsideCode=-1;bbox;margin=60;out=new Float64Array(32);constructor(e,t){this.geo=e,this.G=t;const i=["G_N","G_R","G_CRISTAE","G_FACE","G_ZFACE","G_SPECKLE","G_GOLGI_CIS","G_TABLES","S_PERI_W","S_CR_W","S_CR_GAP","S_CR_JW","S_CIS_CLR","S_CR_RIM","TH","MROW","RROW","FBROW","K_FIELD","K_WALL","K_SHELL_PORES","K_INNER_CRISTAE","K_GOLGI_CIS","K_PRIMS","K_PRIMS_DIFF","K_SMOOTH_UNION","T_MEM","T_FIELD","T_FACE","T_PORE","T_SPECKLE","T_SHAPE","OP_LT","A_SPHERE","A_ELLIPSOID","P_SPHERE","P_CAPSULE","P_PILL","P_CERPATCH","P_SLOT","P_TORUS"];for(const l of i)this.K[l]=As(e,l);const s=this.K;this.pores=Float64Array.from(e.pores??[]),this.nPores=this.pores.length/6;const r=e.prims??{type:[],params:[],cls:[]};this.PT=Int32Array.from(r.type??[]),this.PQ=Float64Array.from(r.params??[]),this.PC=Int32Array.from(r.cls??[]),this.tab=t[s.G_TABLES],this.nMem=t[this.tab],this.nRow=t[this.tab+1],this.nLab=t[this.tab+2],this.r0=this.tab+s.TH+s.MROW*this.nRow,this.data0=this.r0+s.RROW*this.nLab+s.FBROW*t[this.tab+3];const o=e.domain.bbox_nm;this.bbox={lo:[o[0][0],o[0][1],o[0][2]],hi:[o[1][0],o[1][1],o[1][2]]};const a=l=>e.labels.find(u=>u.name===l)?.code??-1;this.exteriorCode=a("exterior"),this.outsideCode=a("outside_imaged_volume"),this.findDomain();let c=0;for(let l=0;l<this.nRow;l++){const u=this.tab+s.TH+s.MROW*l;t[u]===s.K_SMOOTH_UNION&&(c=Math.max(c,t[u+3]))}this.margin=Math.max(60,2*c+10),this.buildGrid()}findDomain(){const e=this.G,t=this.K;for(let a=0;a<this.nLab;a++){const c=this.r0+t.RROW*a;if(e[c]===this.exteriorCode&&e[c+1]===1&&e[c+2]===t.T_MEM&&e[c+4]===t.OP_LT&&e[c+5]===0){this.domainMem=e[c+3];break}}if(this.domainMem<0)return;const i=[];let s=0;for(let a=0;a<this.nRow;a++){const c=this.tab+t.TH+t.MROW*a;e[c]!==t.K_SMOOTH_UNION&&(i[s++]=a)}let r=0;const o=a=>{const c=i[a];if(c===void 0||r>>c&1)return;r|=1<<c;const l=this.tab+t.TH+t.MROW*c,u=e[l];(u===t.K_WALL||u===t.K_INNER_CRISTAE)&&o(e[l+1]),u===t.K_GOLGI_CIS&&(o(e[l+3]),o(e[l+4])),u===t.K_PRIMS&&e[l+3]>=0&&o(e[l+3]);for(let p=0;p<this.nRow;p++){const d=this.tab+t.TH+t.MROW*p;e[d]===t.K_SMOOTH_UNION&&e[d+1]===a&&(r|=1<<p)}};o(this.domainMem),this.domainRows=r>>>0}primBound(e){const t=this.K,i=this.PQ,s=8*e,r=this.PT[e];if(r===t.P_SPHERE)return[i[s],i[s+1],i[s+2],i[s+3]];if(r===t.P_CAPSULE){const a=Math.hypot(i[s+3]-i[s],i[s+4]-i[s+1],i[s+5]-i[s+2]);return[(i[s]+i[s+3])/2,(i[s+1]+i[s+4])/2,(i[s+2]+i[s+5])/2,a/2+i[s+6]]}if(r===t.P_PILL||r===t.P_TORUS)return[i[s],i[s+1],i[s+2],i[s+6]+i[s+7]];if(r===t.P_SLOT){const a=Math.hypot(i[s+3]-i[s],i[s+4]-i[s+1],i[s+5]-i[s+2]);return[(i[s]+i[s+3])/2,(i[s+1]+i[s+4])/2,(i[s+2]+i[s+5])/2,a/2+i[s+7]+i[s+6]]}const o=Math.min(i[s+4],Math.PI);return[i[s]*i[s+5],i[s+1]*i[s+5],i[s+2]*i[s+5],2*i[s+5]*Math.sin(o/2)+i[s+6]+400]}buildGrid(){const e=this.K,t=this.G,i=[0,0,0],s=[0,0,0],r=Math.max(...[0,1,2].map(m=>this.bbox.hi[m]-this.bbox.lo[m])),o=Math.max(8,Math.min(64,Math.round(r/250)));for(let m=0;m<3;m++)i[m]=this.bbox.lo[m]-100,s[m]=(this.bbox.hi[m]-this.bbox.lo[m]+200)/o;const a=o*o*o,c=(m,f,y)=>[Math.max(0,Math.floor((m-f-i[y])/s[y])),Math.min(o-1,Math.floor((m+f-i[y])/s[y]))],l=m=>{const f=Array.from({length:a},()=>[]);m.forEach(([E,P,L,T],h)=>{const[M,v]=c(E,T,0),[C,I]=c(P,T,1),[F,G]=c(L,T,2);for(let j=M;j<=v;j++)for(let K=C;K<=I;K++)for(let ue=F;ue<=G;ue++)f[(j*o+K)*o+ue].push(h)});const y=new Uint32Array(a+1);let x=0;for(let E=0;E<a;E++)y[E]=x,x+=f[E].length;y[a]=x;const A=new Uint32Array(Math.max(1,x));let k=0;for(let E=0;E<a;E++)for(const P of f[E])A[k++]=P;return{off:y,idx:A}},u=[];for(let m=0;m<this.PT.length;m++){const f=this.primBound(m);u.push([f[0],f[1],f[2],f[3]+this.margin])}let p=0;for(let m=0;m<this.nRow;m++){const f=this.tab+e.TH+e.MROW*m;t[f]===e.K_SHELL_PORES&&(p=Math.max(p,Math.hypot(t[f+5],t[f+4]+.5*t[f+3])+2))}const d=[];for(let m=0;m<this.nPores;m++)d.push([this.pores[6*m],this.pores[6*m+1],this.pores[6*m+2],p]);const b=l(u),g=l(d);this.grid={n:o,lo:i,cs:s,primOff:b.off,primIdx:b.idx,poreOff:g.off,poreIdx:g.idx}}cellOf(e,t,i){const s=this.grid,r=s.n,o=(a,c)=>Math.min(r-1,Math.max(0,Math.floor((a-s.lo[c])/s.cs[c])));return(o(e,0)*r+o(t,1))*r+o(i,2)}fieldO(e,t,i,s){const r=this.G,o=r[s+3],a=r[s+7],c=(e-r[s])/o,l=(t-r[s+1])/o,u=(i-r[s+2])/o,p=r[s+4],d=r[s+5],b=r[s+6];if(c<0||l<0||u<0||c>=p*a||l>=d*a||u>=b*a)return r[s+9];const g=Math.floor(c),m=Math.floor(l),f=Math.floor(u),y=Math.floor(g/a),x=Math.floor(m/a),A=Math.floor(f/a),k=r[r[s+10]+(y*d+x)*b+A];if(k===-1)return-r[s+8];if(k===-2)return r[s+9];const E=a+1,P=E*E,L=E,T=c-g,h=l-m,M=u-f,v=r[s+11]+k*E*E*E+((g-y*a)*E+(m-x*a))*E+(f-A*a),C=r[v]+(r[v+P]-r[v])*T,I=r[v+1]+(r[v+P+1]-r[v+1])*T,F=r[v+L]+(r[v+P+L]-r[v+L])*T,G=r[v+L+1]+(r[v+P+L+1]-r[v+L+1])*T,j=C+(F-C)*h,K=I+(G-I)*h;return j+(K-j)*M}nFields(){return this.G[this.K.G_N]}fieldSdf(e,t,i,s){return this.fieldO(e,t,i,this.K.G_N+1+12*s)}analytic(e,t,i,s,r){const o=this.G,a=e-o[r],c=t-o[r+1],l=i-o[r+2];if(s===this.K.A_SPHERE)return Math.sqrt(a*a+c*c+l*l)-o[r+3];const u=(o[r+6]*a+o[r+7]*c+o[r+8]*l)/o[r+3],p=(o[r+9]*a+o[r+10]*c+o[r+11]*l)/o[r+4],d=(o[r+12]*a+o[r+13]*c+o[r+14]*l)/o[r+5],b=Math.sqrt(u*u+p*p+d*d),g=Math.sqrt((u/o[r+3])**2+(p/o[r+4])**2+(d/o[r+5])**2);return g<1e-12?-Math.min(o[r+3],o[r+4],o[r+5]):b*(b-1)/g}fval(e,t,i,s){const r=this.G,o=this.K,a=r[this.tab+3];if(a>0){const c=this.r0+o.RROW*this.nLab;for(let l=0;l<a;l++){const u=c+o.FBROW*l;if(r[u]===s)return this.analytic(e,t,i,r[u+1],this.data0+r[u+2])}}return this.fieldSdf(e,t,i,s)}faceDist(e){const t=this.G;return t[this.K.G_FACE]>0?e-t[this.K.G_ZFACE]:1e9}inPore(e,t,i,s,r,o){const a=this.grid,c=this.pores;for(let l=a.poreOff[o];l<a.poreOff[o+1];l++){const u=a.poreIdx[l],p=6*u,d=e-c[p],b=t-c[p+1],g=i-c[p+2],m=d*c[p+3]+b*c[p+4]+g*c[p+5];if(m<-r||m>r)continue;const f=d-m*c[p+3],y=b-m*c[p+4],x=g-m*c[p+5];if(f*f+y*y+x*x<s*s)return u}return-1}inSpeckle(e,t,i){const s=this.G,r=s[this.K.G_SPECKLE],o=s[r];for(let a=0;a<o;a++){const c=r+1+4*a,l=e-s[c],u=t-s[c+1],p=i-s[c+2];if(l*l+u*u+p*p<s[c+3]*s[c+3])return a}return-1}cristaLumen(e,t,i,s){const r=this.G,o=this.K,a=r[o.G_CRISTAE],c=r[a],l=r[a+4],u=r[a+5],p=r[a+6],d=r[a+7],b=Math.floor((e-r[a+1])/l),g=Math.floor((t-r[a+2])/l),m=Math.floor((i-r[a+3])/l);if(b<0||g<0||m<0||b>=u||g>=p||m>=d)return 1e9;const f=r[a+8+12*c+(b*p+g)*d+m];if(f<0)return 1e9;const y=a+8+12*f;if(r[y+11]===0)return 1e9;const x=r[y+4],A=r[y]*e+r[y+1]*t+r[y+2]*i-r[y+3],k=A-x*Math.floor(A/x+.5),E=Math.abs(k)-r[o.S_CR_W];let P=Math.max(E,s+r[o.S_CR_GAP]);if(r[o.S_CR_RIM]>0){const T=Math.min(r[o.S_CR_RIM],r[o.S_CR_W]),h=s+r[o.S_CR_GAP],M=Math.max(E+T,0),v=Math.max(h+T,0);P=Math.min(-T,P)+Math.sqrt(M*M+v*v)}const L=Math.abs(r[y+5]*(e-r[y+8])+r[y+6]*(t-r[y+9])+r[y+7]*(i-r[y+10]))-r[o.S_CR_JW];return Math.min(P,Math.max(E,L))}golgi(e,t,i,s,r){const o=this.G,a=this.K;let c=this.fieldSdf(e,t,i,s);if(o[a.G_GOLGI_CIS]>0&&c<0&&r>o[a.S_CIS_CLR]){const l=o[a.G_GOLGI_CIS],u=o[l],p=o[l+1],b=-this.fieldO(e,t,i,l+2)-u,g=b-p*Math.floor(b/p+.5);c=Math.max(c,Math.abs(g)-u)}return c}shellPores(e,t,i,s,r,o,a,c,l){let u=this.fval(e,t,i,s);c!==0&&(u=u+c);let p=Math.abs(u)-.5*r;const d=o+.5*r;if(Math.abs(u)<d+r){const b=this.inPore(e,t,i,d,a,l);if(b>=0){const g=this.pores,m=6*b,f=e-g[m],y=t-g[m+1],x=i-g[m+2],A=f*g[m+3]+y*g[m+4]+x*g[m+5],k=Math.sqrt(Math.max(f*f+y*y+x*x-A*A,0));p=Math.sqrt((k-d)**2+u*u)-.5*r}}return p}sdfCer(e,t,i,s,r,o){const a=this.PQ,c=Math.sqrt(e*e+t*t+i*i);let l=(e*a[s]+t*a[s+1]+i*a[s+2])/Math.max(c,1e-9);l=Math.min(1,Math.max(-1,l));const u=Math.max(Math.acos(l)-a[s+4],0)*c,p=o-a[s+5]-r;return Math.sqrt(u*u+p*p)-a[s+6]}sdfPrim(e,t,i,s,r){const o=this.K,a=this.PQ;if(s===o.P_SPHERE){const d=e-a[r],b=t-a[r+1],g=i-a[r+2];return Math.sqrt(d*d+b*b+g*g)-a[r+3]}if(s===o.P_CAPSULE){const d=e-a[r],b=t-a[r+1],g=i-a[r+2],m=a[r+3]-a[r],f=a[r+4]-a[r+1],y=a[r+5]-a[r+2],x=Math.min(Math.max((d*m+b*f+g*y)/(m*m+f*f+y*y),0),1),A=d-m*x,k=b-f*x,E=g-y*x;return Math.sqrt(A*A+k*k+E*E)-a[r+6]}if(s===o.P_PILL){const d=e-a[r],b=t-a[r+1],g=i-a[r+2],m=d*a[r+3]+b*a[r+4]+g*a[r+5],f=d-m*a[r+3],y=b-m*a[r+4],x=g-m*a[r+5],A=Math.max(Math.sqrt(f*f+y*y+x*x)-a[r+6],0);return Math.sqrt(A*A+m*m)-a[r+7]}if(s===o.P_TORUS){const d=e-a[r],b=t-a[r+1],g=i-a[r+2],m=d*a[r+3]+b*a[r+4]+g*a[r+5],f=Math.sqrt(Math.max(d*d+b*b+g*g-m*m,0));return Math.sqrt((f-a[r+6])**2+m*m)-a[r+7]}if(s===o.P_SLOT){const d=.5*(a[r]+a[r+3]),b=.5*(a[r+1]+a[r+4]),g=.5*(a[r+2]+a[r+5]),m=Math.sqrt(d*d+b*b+g*g),f=d/m,y=b/m,x=g/m;let A=a[r+3]-a[r],k=a[r+4]-a[r+1],E=a[r+5]-a[r+2];const P=Math.sqrt(A*A+k*k+E*E);A/=P,k/=P,E/=P;const L=e-a[r],T=t-a[r+1],h=i-a[r+2],M=Math.min(Math.max(L*A+T*k+h*E,0),P),v=Math.min(Math.max(L*f+T*y+h*x,0),a[r+7]),C=L-M*A-v*f,I=T-M*k-v*y,F=h-M*E-v*x;return Math.sqrt(C*C+I*I+F*F)-a[r+6]}const c=Math.sqrt(e*e+t*t+i*i),l=Math.min(Math.max((e*a[r]+t*a[r+1]+i*a[r+2])/Math.max(c,1e-9),-1),1),u=Math.max(Math.acos(l)-a[r+4],0)*c,p=c-a[r+5];return Math.sqrt(u*u+p*p)-a[r+6]}primsMin(e,t,i,s,r,o,a){const c=this.grid,l=this.K;let u=1e9;for(let p=c.primOff[a];p<c.primOff[a+1];p++){const d=c.primIdx[p];if(this.PC[d]!==s)continue;const b=this.PT[d]===l.P_CERPATCH&&o>=0?this.sdfCer(e,t,i,8*d,r,o):this.sdfPrim(e,t,i,this.PT[d],8*d);u=Math.min(u,b)}return u}static sminC(e,t,i,s){const r=Math.max(i-Math.abs(e-t),0);return Math.min(e,t)-r*r*s}memSdfs(e,t,i,s=this.out,r=4294967295){const o=this.G,a=this.K,c=this.cellOf(e,t,i);let l=0,u=0;for(let p=0;p<this.nRow;p++){const d=this.tab+a.TH+a.MROW*p,b=o[d],g=o[d+1];if(!(p>=32||(r>>>p&1)===1)){b!==a.K_SMOOTH_UNION&&u++;continue}if(b===a.K_FIELD){let f=this.fval(e,t,i,g);f=o[d+2]<0?-f:f,(o[d+3]!==0||o[d+4]!==0)&&(f=f-(o[d+3]-o[d+4])),s[u]=f}else if(b===a.K_WALL)s[u]=Math.min(s[g],this.faceDist(i));else if(b===a.K_SHELL_PORES)s[u]=this.shellPores(e,t,i,g,o[d+3],o[d+4],o[d+5],o[d+6],c);else if(b===a.K_INNER_CRISTAE){let f=s[g]+o[d+3];o[a.G_CRISTAE]>0&&f<o[a.S_CR_W]&&(f=Math.max(f,-this.cristaLumen(e,t,i,f))),s[u]=-f,l=f}else if(b===a.K_GOLGI_CIS)s[u]=this.golgi(e,t,i,g,Math.min(s[o[d+3]],s[o[d+4]]));else if(b===a.K_PRIMS){const f=o[d+2],y=f>=0?this.fval(e,t,i,f):1e9,x=o[d+3],A=x>=0?s[x]:0;s[u]=Math.min(y,this.primsMin(e,t,i,g,A,x>=0?o[d+4]:-1,c))}else if(b===a.K_PRIMS_DIFF){const f=Math.max(this.primsMin(e,t,i,g,0,-1,c),-this.primsMin(e,t,i,o[d+2],0,-1,c));s[u]=o[d+3]<0?-f:f,l=f}if(b===a.K_SMOOTH_UNION){const f=this.primsMin(e,t,i,o[d+2],0,-1,c),y=o[d+3],x=o[d+4]<0?-s[g]:s[g];f<x+y&&(s[g]=o[d+4]<0?-gt.sminC(x,f,y,o[d+5]):gt.sminC(x,f,y,o[d+5]))}else u++}return l}labelFrom(e,t,i,s=this.out){const r=this.G,o=this.K;let a=-1,c=0;const l=this.cellOf(e,t,i);for(let u=0;u<this.nLab;u++){const p=this.r0+o.RROW*u;let d=!0;for(let b=0;b<r[p+1];b++){const g=r[p+2+4*b],m=r[p+3+4*b];let f;if(g===o.T_MEM)f=s[m];else if(g===o.T_FIELD)m!==a&&(a=m,c=this.nFields()>m?this.fval(e,t,i,m):1e9),f=c;else if(g===o.T_FACE)f=this.faceDist(i);else if(g===o.T_PORE){const y=this.tab+o.TH+o.MROW*m;f=this.inPore(e,t,i,r[y+4]+.5*r[y+3],r[y+5],l)>=0?-1:1}else if(g===o.T_SPECKLE)f=r[o.G_SPECKLE]>0&&this.inSpeckle(e,t,i)>=0?-1:1;else{const y=this.data0+m,x=e-r[y+1],A=t-r[y+2],k=i-r[y+3];f=x*x+A*A+k*k<r[y+4]*r[y+4]?-1:1}if(d=r[p+4+4*b]===o.OP_LT?f<r[p+5+4*b]:f>r[p+5+4*b],!d)break}if(d)return r[p]}return-1}label(e,t,i){return this.memSdfs(e,t,i,this.out),this.labelFrom(e,t,i,this.out)}domainDepth(e,t,i){return this.domainMem<0?1e9:(this.memSdfs(e,t,i,this.out,this.domainRows),this.out[this.domainMem])}domainNormal(e,t,i,s=2){const r=(u,p,d)=>this.domainDepth(u,p,d),o=r(e-s,t,i)-r(e+s,t,i),a=r(e,t-s,i)-r(e,t+s,i),c=r(e,t,i-s)-r(e,t,i+s),l=Math.hypot(o,a,c);return l>1e-9?[o/l,a/l,c/l]:[0,0,0]}offsetSlots(){const e=this.G,t=this.K,i=[t.G_CRISTAE,t.G_SPECKLE,t.G_GOLGI_CIS,t.G_TABLES];for(let s=0;s<e[t.G_N];s++){const r=t.G_N+1+12*s;i.push(r+10,r+11)}if(e[t.G_GOLGI_CIS]>0){const s=e[t.G_GOLGI_CIS]+2;i.push(s+10,s+11)}return i}gpuG(){const e=Float32Array.from(this.G),t=new Uint32Array(e.buffer);for(const i of this.offsetSlots())t[i]=this.G[i]>>>0;return e}}async function Es(n,e,t="geometry.json"){const i=await n(t);if(!i.G?.file)throw new Error(`${t} has no G (schema ${i.schema}); this viewer reads wholecell.viewer_geometry/1`);const s=await e(i.G.file),r=i.G.dtype==="f64"?new Float64Array(s):Float64Array.from(new Float32Array(s));if(i.G.n&&r.length!==i.G.n)throw new Error(`${i.G.file}: ${r.length} values, geometry.json says ${i.G.n}`);for(const[o,a]of i.G.patches??[])r[o]=a;return{geo:i,ev:new gt(i,r)}}const fe=n=>String(n??"").replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e]),Zt=n=>n===void 0?"?":n>=1e6?`${(n/1e6).toFixed(n>=1e8?0:1)} million`:n.toLocaleString("en-US");function Cs(n,e,t,i){const s=n.stats??{},r=!!e.features?.open_face,o=n.licence??{};return`
<h2>About this model</h2>
<p><b>${fe(n.name)}</b> (<i>${fe(n.organism?.name)}</i>${n.organism?.strain?` ${fe(n.organism.strain)}`:""}; ${fe(n.cell_type)}; ${fe(n.state)}):
a molecular model of the whole cell with ${Zt(s.instances??i.nInst)} macromolecules of ${(s.species??i.nTypes).toLocaleString("en-US")} species${s.volume_um3?` in ${s.volume_um3} µm³`:""},
streamed at residue resolution around the part you look at.</p>
<p>Every macromolecule is drawn from its experimental (PDB) or predicted (AlphaFold DB) coordinates, at one bead per
amino-acid residue or nucleotide when it is large enough on screen; further away, molecules switch to a sphere-tree
stand-in and then to one sphere each. Click a molecule to inspect it and to load its full-atom model in Mol*.</p>
<h3>Colours and controls</h3>
<ul>
<li>Cut faces are coloured by compartment (the cell's geometry: ${fe(t.length)} placement regions, compartments evaluated
exactly from the cell's distance fields and rule table), with membranes as light bands.</li>
${r?`<li><b>Flat face = edge of the imaged volume.</b> The EM data end there and truncate the cell; the face has no membrane
and is drawn in flat grey (a grey line on cut faces).</li>`:""}
<li>Molecules are coloured by the compartment they were placed in; named assemblies (${fe(e.classes.map(a=>a.name.toLowerCase()).join(", ")||"none")})
have their own colours and Show switches; Colour by: Compartment lists every region.</li>
${i.hasLipids?"<li>Lipids are generated in the browser near the camera on each membrane, with the composition given by the cell data.</li>":"<li>Membranes are drawn as surfaces and cut-face bands (this export has no per-tile membrane meshes, so no procedural lipids).</li>"}
</ul>
<h3>Build and licence</h3>
<div class="kvs">
<div>Build</div><div><code>${fe(n.build?.build_id)}</code>${(n.build?.aliases??[]).length?` (alias ${fe(n.build.aliases.join(", "))})`:""}</div>
${n.build?.stamp_sha256?`<div>Build stamp</div><div><code>${fe(n.build.stamp_sha256.slice(0,16))}…</code></div>`:""}
<div>Data licence</div><div>${fe(o.data??"not stated")}${o.attribution?' · <a href="#" id="aboutAttribution" style="color:#8fc3ff">attribution</a>':""}</div>
<div>Status</div><div>${fe(n.status??"published")}</div>
${i.resample?`<div>Geometry</div><div>viewer fields resampled; compartment labels agree with the build geometry at ${(100*(i.resample.agreement??0)).toFixed(2)}% of ${Zt(i.resample.n)} test points</div>`:""}
</div>
<p>More detail is under <a href="#" id="aboutToModel" style="color:#8fc3ff">Model details</a>. <a href="#" id="aboutSwitch" style="color:#8fc3ff">Switch cell</a>.</p>
`}const Jt=n=>n.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");function ht(n){const e=[];return n=n.replace(/`([^`]+)`/g,(t,i)=>`\0${e.push(Jt(i))-1}\0`),n=Jt(n).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(t,i,s)=>`<a href="${s}" target="_blank" rel="noopener">${i}</a>`).replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>").replace(/\*([^*\s][^*]*)\*/g,"<i>$1</i>"),n.replace(/\u0000(\d+)\u0000/g,(t,i)=>`<code>${e[+i]}</code>`)}const _t=/^([-*]|\d+\.)\s+/,St=n=>n.length-n.trimStart().length,ei=n=>n.trim().replace(/^\||\|$/g,"").split("|").map(e=>e.trim());function xi(n){let e="",t=0;for(;t<n.length;){const i=n[t],s=i.trim();if(!s){t++;continue}let r;if(r=s.match(/^(#{1,6})\s+(.*)$/)){e+=`<h${r[1].length}>${ht(r[2])}</h${r[1].length}>`,t++;continue}if(/^-{3,}$/.test(s)){e+="<hr>",t++;continue}if(s.startsWith("|")&&t+1<n.length&&/^\|[\s|:-]+\|$/.test(n[t+1].trim())){const a=ei(s);t+=2;let c="";for(;t<n.length&&n[t].trim().startsWith("|");)c+=`<tr>${ei(n[t]).map(l=>`<td>${ht(l)}</td>`).join("")}</tr>`,t++;e+=`<table><thead><tr>${a.map(l=>`<th>${ht(l)}</th>`).join("")}</tr></thead><tbody>${c}</tbody></table>`;continue}if(r=s.match(_t)){const a=/\d/.test(r[1]),c=St(i);let l="";for(;t<n.length;){const u=n[t],p=u.trim().match(_t);if(!p||St(u)!==c||/\d/.test(p[1])!==a)break;const d=c+p[0].length,b=[u.slice(d)];for(t++;t<n.length&&(!n[t].trim()||St(n[t])>=d);)b.push(n[t].slice(d)),t++;for(;b.length&&!b[b.length-1].trim();)b.pop();const g=xi(b),m=g.match(/^<p>((?:(?!<p>)[\s\S])*)<\/p>$/);l+=`<li>${m?m[1]:g}</li>`}e+=a?`<ol>${l}</ol>`:`<ul>${l}</ul>`;continue}const o=[];for(;t<n.length&&n[t].trim()&&!/^(#{1,6}\s|\||-{3,}$)/.test(n[t].trim())&&!_t.test(n[t].trim());)o.push(n[t++].trim());e+=`<p>${ht(o.join(" "))}</p>`}return e}function Fs(n){return xi(n.replace(/\r\n/g,`
`).split(`
`))}const pt=[[.22,.9,.16],[.93,.16,.8],[.15,.7,1],[1,.72,.08]],Is=[.965,.945,.906],Os=[.95,.5,0],$s=[5,15,30,60,150],Gs=n=>"#"+n.map(e=>Math.round(e*255).toString(16).padStart(2,"0")).join(""),et=n=>n<1e3?`${n.toFixed(0)} ns`:`${(n/1e3).toFixed(n<1e4?2:1)} µs`,Pe=n=>document.getElementById(n),Rs=(xs|6<<15)>>>0;class Bs{constructor(e,t,i){this.R=e,this.onChange=t,this.toast=i}data=null;loading=null;set=0;f=0;playing=!1;visible=!1;speed=30;which=-1;trail=50;token=0;el=Pe("dynPanel");onRegion=e=>{this.show(e)};load(){return this.loading??=Promise.resolve(De("dynamics.json")).then(e=>e?null:Fe("dynamics.json")).then(e=>this.data=e?.sets?.length?e:null).catch(()=>null)}get cur(){return this.data.sets[this.set]}nFrames(e=this.cur){return Math.min(...e.tracers.map(t=>t.q?Math.floor(t.q.length/(3*t.n)):t.frames))}async show(e){const t=++this.token,i=await this.load();if(t!==this.token)return;if(!i){this.toast("No dynamics data in this build");return}let s=i.sets.findIndex(r=>r.region===e);s<0&&(s=Math.min(this.set,i.sets.length-1));try{await Promise.all(i.sets[s].tracers.filter(r=>!r.q).map(async r=>{r.q=new Uint16Array(await $e(r.file))}))}catch(r){t===this.token&&this.toast(`Could not load the tracer trajectories: ${r?.message||r}`);return}t===this.token&&((s!==this.set||!this.visible)&&(this.f=0,s!==this.set&&(this.which=-1)),this.set=s,this.visible=!0,this.playing=!0,this.renderPanel(),this.upload(),this.onChange())}hide(){this.token++,this.visible&&(this.visible=!1,this.playing=!1,this.el.style.display="none",this.R.setTracers(new Float32Array(0),0,new Float32Array(0),0),this.onChange())}toggle(e){this.visible?this.hide():this.show(e)}setPlaying(e){this.visible&&(this.playing=e,this.syncPanel(),this.onChange())}tick(e){return!this.visible||!this.playing?!1:(this.f+=Math.min(e,100)/1e3*this.speed,this.f>this.nFrames()-1&&(this.f=0),this.upload(),this.syncPanel(),!0)}describe(e){const t=this.data?.sets[this.set]?.tracers[e>>12];return t?{title:`${t.name} tracer`,sub:`inert probe, r = ${t.radius_nm} nm, diffusing in the frozen ${this.cur.region} crowd${t.D_over_D0!=null?` (D/D₀ ${t.D_over_D0.toFixed(2)})`:""}`}:{title:"Tracer",sub:""}}upload(){const e=this.data,t=this.cur,i=e.box_nm/e.quant,s=t.box_lo,r=this.nFrames(),o=Math.min(Math.floor(this.f),r-1),a=this.f-o,c=Math.min(o+1,r-1),l=t.tracers.map((A,k)=>[A,k]).filter(([A,k])=>A.q&&(this.which<0||this.which===k)),u=Math.min(this.trail,o),p=l.reduce((A,[k])=>A+k.n,0),d=new Float32Array(p*8),b=new Uint32Array(d.buffer),g=new Float32Array((12+p*(u+1))*12);let m=0,f=0;const y=(A,k,E,P,L,T,h,M,v)=>{g.set([A,k,E,h,P,L,T,M,v[0],v[1],v[2],0],12*f++)};for(const[A,k]of l){const E=A.q,P=A.n,L=pt[k%pt.length],T=(h,M,v)=>s[v]+E[(h*P+M)*3+v]*i;for(let h=0;h<P;h++){const M=T(o,h,0)*(1-a)+T(c,h,0)*a,v=T(o,h,1)*(1-a)+T(c,h,1)*a,C=T(o,h,2)*(1-a)+T(c,h,2)*a;d.set([M,v,C,A.radius_nm,L[0],L[1],L[2]],8*m),b[8*m+7]=(Rs|k<<12|h)>>>0,m++;let I=M,F=v,G=C;for(let j=o;j>=o-u;j--){const K=T(j,h,0),ue=T(j,h,1),Te=T(j,h,2),qe=Math.min(1,(this.f-j)/Math.max(1,this.trail))*.8;(I!==K||F!==ue||G!==Te)&&y(I,F,G,K,ue,Te,1.6,1,L.map((Be,Ue)=>Be+(Is[Ue]-Be)*qe)),I=K,F=ue,G=Te}}}const x=e.box_nm;for(let A=0;A<8;A++)for(const k of[1,2,4])if(!(A&k)){const E=T=>[0,1,2].map(h=>s[h]+(T>>h&1)*x),[P,L]=[E(A),E(A|k)];y(P[0],P[1],P[2],L[0],L[1],L[2],1.5,0,Os)}this.R.setTracers(d,m,g,f)}renderPanel(){const e=this.data,t=this.cur,i=this.el,s=this.nFrames();i.innerHTML=`<button class="close" id="dynClose" title="Hide (G)">×</button>
      <div class="dh">Tracer dynamics <span>· ${t.region}, ${e.box_nm} nm box${t.phi!=null?`, crowding φ ${t.phi.toFixed(2)}`:""}</span></div>
      <div class="row"><button class="small" id="dynPlay" title="Play / pause (K)"></button><input type="range" id="dynFrame" min="0" max="${s-1}" step="1"><span class="val" id="dynT"></span></div>
      <div class="row"><label>Speed</label><select id="dynSpeed">${$s.map(l=>`<option value="${l}">${l} frames/s · ${et(l*e.frame_ns)} per s</option>`).join("")}</select></div>
      <div class="row"><label>Tracers</label><div class="seg" id="dynWhich" style="flex:1">${t.tracers.map((l,u)=>`<button data-w="${u}">${l.name}</button>`).join("")}<button data-w="-1">${t.tracers.length>2?"All":"Both"}</button></div></div>
      ${e.sets.length>1?`<div class="row"><label>Region</label><select id="dynSet">${e.sets.map((l,u)=>`<option value="${u}">${l.region}</option>`).join("")}</select></div>`:""}
      <div class="row"><label>Trails</label><select id="dynTrail"><option value="0">Off</option><option value="10">10 frames (${et(10*e.frame_ns)})</option><option value="50">50 frames (${et(50*e.frame_ns)})</option><option value="200">200 frames (${et(200*e.frame_ns)})</option></select></div>
      <div class="dl">${t.tracers.map((l,u)=>`<div><span class="sw" style="background:${Gs(pt[u%pt.length])}"></span>${l.name}</div><div>r ${l.radius_nm} nm</div><div>${l.n} tracers</div><div>D/D₀ ${l.D_over_D0!=null?l.D_over_D0.toFixed(2):"–"}</div>`).join("")}</div>
      <div class="sub">Brownian dynamics among frozen crowders, ${e.frame_ns} ns per frame. D/D₀: long-time diffusion relative to water. Spheres at the probe radius; orange: simulation box.</div>`,i.style.display="block",Pe("dynClose").onclick=()=>this.hide(),Pe("dynPlay").onclick=()=>this.setPlaying(!this.playing);const r=Pe("dynFrame");r.oninput=()=>{this.f=Number(r.value),this.playing=!1,this.upload(),this.syncPanel(),this.onChange()},r.onchange=()=>r.blur();const o=Pe("dynSpeed");o.value=String(this.speed),o.onchange=()=>{this.speed=Number(o.value),o.blur()},i.querySelectorAll("#dynWhich button").forEach(l=>l.onclick=()=>{this.which=Number(l.dataset.w),this.upload(),this.syncPanel(),this.onChange()});const a=Pe("dynTrail");a.value=String(this.trail),a.onchange=()=>{this.trail=Number(a.value),a.blur(),this.upload(),this.onChange()};const c=document.getElementById("dynSet");c&&(c.value=String(this.set),c.onchange=()=>{c.blur(),this.onRegion(e.sets[Number(c.value)].region)}),this.syncPanel()}syncPanel(){if(!this.visible)return;const e=this.data,t=Math.floor(this.f);Pe("dynPlay").textContent=this.playing?"❚❚":"▶",Pe("dynFrame").value=String(t),Pe("dynT").textContent=`${t} · ${et(this.f*e.frame_ns)}`,Pe("dynT").title=`frame ${t} of ${this.nFrames()-1} (${e.frame_ns} ns per frame)`,this.el.querySelectorAll("#dynWhich button").forEach(i=>i.classList.toggle("on",Number(i.dataset.w)===this.which))}}const zs={index:"tiles/index.json",regions:"regions.json",geometry:"geometry.json",fields:"geometry_G.bin",meshes:"organelle_meshes.bin.gz",bookmarks:"bookmarks.json",model_doc:"MODEL.md",features:"features.json",library:"library/types.json",types_tiles:"types_tiles.bin",attribution:"attribution.md"},Mi=()=>new URLSearchParams(location.search),qt=n=>n.endsWith("/")?n:n+"/",J=n=>String(n??"").replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e]);function qs(){const n=Mi().get("cells");return new URL(n||"cells.json",document.baseURI).href}async function Us(n=qs()){const e=await fetch(n,{cache:"no-store"});if(!e.ok)throw new Error(`HTTP ${e.status} for the cell registry ${n}`);const t=await e.json();if(t.schema!=="wholecell.cells/1"||!Array.isArray(t.cells))throw new Error(`${n} is not a wholecell.cells/1 registry`);for(const i of t.cells)if(!i.id||!i.data_base)throw new Error(`registry entry without id / data_base in ${n}`);for(const i of t.cells)i.data_base=qt(new URL(i.data_base,n).href);return t}async function Ns(n){const e=qt(new URL(n,document.baseURI).href),t=await fetch(e+"cell.json",{cache:"no-store"});if(!t.ok)throw new Error(`HTTP ${t.status} for ${e}cell.json (?data= needs a viewer data folder with cell.json)`);const i=await t.json(),s=i.entry??i;return s.data_base=e,s}async function Ds(){const n=Mi(),e=n.get("cell"),t=n.get("data"),i=n.get("build");let s=null;if(!t||e)try{s=await Us()}catch(o){if(!t)throw o}if(!e&&!t)return{opened:null,registry:s};let r;if(e&&s){const o=s.cells.filter(a=>a.id===e);if(!o.length&&!t)throw new Error(`No cell "${J(e)}" in the registry (${s.cells.map(a=>J(a.id)).join(", ")}).`);if(r=i?o.find(a=>a.build.build_id===i||(a.build.aliases??[]).includes(i)):o.find(a=>a.status!=="archived")??o[0],o.length&&!r)throw new Error(`Cell "${J(e)}" has no build "${J(i)}" in the registry.`)}if(t){const o=await Ns(t);r=r?{...r,data_base:o.data_base,build:o.build??r.build}:o}if(!r)throw new Error("No cell selected.");return{opened:{entry:r,base:qt(r.data_base),files:{...zs,...r.files??{}},registry:s},registry:s}}const js=n=>n===void 0?"":n>=1e6?`${(n/1e6).toFixed(n>=1e8?0:1)} M`:n>=1e3?`${(n/1e3).toFixed(0)} k`:String(n);function Hs(n,e){const t=new URL(location.href),i=t.searchParams.get("cells");return t.search="",i&&t.searchParams.set("cells",i),t.searchParams.set("cell",n),e&&t.searchParams.set("build",e),t.href}function Ft(){const n=new URL(location.href),e=n.searchParams.get("cells");return n.search="",e&&n.searchParams.set("cells",e),n.href}function ti(n,e){const t=document.getElementById("start");document.getElementById("loading").style.display="none",t.style.display="flex",document.title=n?.title??"Whole-cell models";const i=(n?.cells??[]).filter(s=>s.status!=="hidden").map(s=>{const r=s.thumbnail?`<img src="${J(s.data_base+s.thumbnail)}" alt="" onerror="this.style.display='none'">`:"",o=s.stats??{},a=s.licence?.data?`<span class="lic">data ${J(s.licence.data)}</span>`:"",c=s.status&&s.status!=="published"?`<span class="status">${J(s.status)}</span>`:"";return`<a class="card" href="${J(Hs(s.id,s.build.build_id))}" data-cell="${J(s.id)}">
      <div class="thumb">${r}</div>
      <div class="body"><h2>${J(s.name)}</h2>
        <div class="org"><i>${J(s.organism?.name)}</i>${s.organism?.strain?` ${J(s.organism.strain)}`:""} · ${J(s.cell_type)}</div>
        <div class="state">${J(s.state)}</div>
        <div class="stats">${o.instances?`${js(o.instances)} macromolecules`:""}${o.species?` · ${o.species.toLocaleString("en-US")} species`:""}${o.volume_um3?` · ${o.volume_um3} µm³`:""}</div>
        <div class="meta">build ${J(s.build.build_id)}${(s.build.aliases??[]).length?` (${J(s.build.aliases.join(", "))})`:""} ${c} ${a}</div>
      </div></a>`}).join("");t.innerHTML=`<div class="inner">
    <h1>${J(n?.title??"Whole-cell models")}</h1>
    <div class="lead">Choose a cell. Every macromolecule is drawn from its PDB or AlphaFold structure; the view streams the molecules around a cut through the cell.</div>
    ${e?`<div class="err">${e}</div>`:""}
    <div class="cards">${i||(e?"":'<div class="err">The registry lists no cells.</div>')}</div>
    ${n?.note?`<div class="note">${J(n.note)}</div>`:""}
    <div class="note">Needs a browser with WebGPU (current Chrome or Edge; Safari 26+). Deep link: <code>?cell=&lt;id&gt;</code>, <code>&amp;view=&lt;bookmark&gt;</code>.</div>
  </div>`}const w=n=>document.getElementById(n),he=n=>n>=1e6?(n/1e6).toFixed(n>=1e7?1:2)+" M":n>=1e4?(n/1e3).toFixed(0)+" k":n.toLocaleString("en-US"),Pi=n=>n>=1e3?(n/1e3).toFixed(n>=1e4?0:2).replace(/\.?0+$/,"")+" µm":(n>=10?n.toFixed(0):n.toFixed(1))+" nm";let V,ae,ke,me,te,Ne=null,Ie,ne,de=[],X={features:{},classes:[]},Ke=new Uint32Array(256);const ii=n=>{const e=ke?.membranes.find(t=>t.code===n);return e?e.display_name??e.name:"membrane"},Ws=n=>ke?.labels.find(e=>e.code===n),ot=n=>{const e=de[n];return e?e.display_as||e.name:`region ${n}`},Li=()=>"in the cell";let B,z,se;const S=new Ps,q=w("gpu"),_={cutOn:!0,plane:[0,0,1,0],slab:60,colorMode:0,freeHide:0,highlight:!1,selId:0,shaded:!0,organelle:!1,motion:0,l0px:1.6,l1px:2.5,minpx:.3,outline:1,showMeshes:!0,showLipids:!0,renderScale:1,memColors:!1};let ze=!1,je=!1,$=!0,Ut=0,Tt=0,ki="auto",ie;function Nt(n){const e=[];return V.types.forEach((t,i)=>{bi(t.id,n)&&e.push(i)}),e}let xe=-1,_i=null,H=null,we=null;const pe=[];function Ks(){const n=["auto","low","medium","high"],e=new URLSearchParams(location.search).get("detail");if(e&&n.includes(e))return e;try{const t=localStorage.getItem("yc.detail");if(t&&n.includes(t))return t}catch{}return"auto"}function tt(n,e){w("loading").querySelector(".m").textContent=n,w("loading").querySelector(".pb div").style.width=`${Math.round(e*100)}%`}function si(n){const e=w("loading").querySelector(".err");e.style.display="block",e.innerHTML=n,w("loading").querySelector(".t").textContent="Could not start the viewer"}function Se(n,e=2200){const t=w("toast");t.textContent=n,t.style.display="block",clearTimeout(Se._t),Se._t=setTimeout(()=>t.style.display="none",e)}async function Vs(){let n;try{n=await Ds()}catch(t){ti(null,String(t?.message||t));return}if(!n.opened){ti(n.registry);return}Ie=n.opened,ne=Ie.entry;const e=Ie.files;if(w("loading").querySelector(".t").textContent=`Loading ${ne.name}…`,document.title=`${ne.name} · whole-cell model`,!("gpu"in navigator)){si(`This browser does not expose <b>WebGPU</b>. Use a current Chrome or Edge (version 113 or later), or Safari 26 or later.
      On Linux Chrome, enable <code>chrome://flags/#enable-unsafe-webgpu</code> and <code>#enable-vulkan</code>.
      Firefox 141+ supports WebGPU on Windows.<br><br>Also check that the page is served over <code>http://localhost</code>
      (for example <code>python tools/serve.py</code>). Opening the file directly with <code>file://</code> does not work.`);return}try{await ls(Ie.base,ne.build?.build_id??""),tt("Loading cell data",.02);try{X=await Fe(e.features)}catch{X={features:{},classes:[]}}X.classes??=[],X.features??={},cs(X.absent);const t=await Fe(e.regions);if(de=t.regions??t,de.some(l=>l.id>255))throw new Error("more than 256 regions: the viewer instance word holds 8 region bits");for(const l of de)Ke[l.id]=1|(l.kind==="membrane"?2:0);tt("Loading cell geometry",.05);const i=await Es(Fe,$e,e.geometry);ke=i.geo,me=i.ev;try{te=await Fe(e.bookmarks)}catch{te=[]}te.length||(te=[Ys()]);const s=me.bbox,r=Math.max(...[0,1,2].map(l=>s.hi[l]-s.lo[l]));if(S.maxDist=Math.max(S.maxDist,3*r),ae=await vs(),V=await ys(X,tt),V.libTag!==null&&ae.libTag!==null&&V.libTag!==ae.libTag)throw new Error(`library/types.json (lib_tag ${V.libTag}) and tiles (lib_tag ${ae.libTag}) come from different builds`);const o=V.types.length;if(!De(e.types_tiles))try{const l=await $e(e.types_tiles);Ne={off:new Uint32Array(l,0,o+1),tiles:new Uint32Array(l,(o+1)*4)}}catch{Ne=null}tt("Starting WebGPU",.7),B=new Ms(q),B.detail=Ks(),B.onLost=l=>{Se(l,1e4)},await B.init(V,me,ae,gi(de,ke,Ke,X)),ie=new Uint32Array(o);for(const l of X.classes){const u=Nt(l.patterns);if(l.own_switch!==!1)for(const p of u)ie[p]|=4;if(l.no_motion)for(const p of u)ie[p]|=8}B.device.queue.writeBuffer(B.typeFlags,0,ie),tt("Compiling shaders and starting tile streaming",.9);const a=Math.max(2,Math.min(4,(navigator.hardwareConcurrency||4)-1)),c=ae.lipidMask??de.filter(l=>l.kind==="membrane").map(l=>l.id);z=new Ss(ae,B,V,me,a,{lipids:X.lipids??{},membranes:ke.membranes,beadQ:.005,maskRegions:c}),z.onChange=()=>{$=!0},se=new Bs(B,()=>{$=!0},Se),se.onRegion=l=>{const u=te.findIndex(p=>p.dynamics===l);u>=0?(Oe(),Ge(u)):se.show(l)},je=!!await se.load(),je||(te=te.filter(l=>!l.dynamics)),on(),Xs(),w("loading").style.display="none",requestAnimationFrame(Ni),window.yc={R:B,T:z,cam:S,fs:_,lib:V,idx:ae,ev:me,geo:ke,regions:de,feat:X,entry:ne,applyBookmark:Ge,setType:Ye,setModule:Mt,pickAt:vt,dyn:se,bookmarks:te,setQuality:Oi,describe:jt,viewLink:Si,ready:!0,state:()=>({pending:z.pendingForView(),detailPending:z.detInflight,loaded:z.loaded.size,totals:z.totals(),stats:B.stats,cam:{t:S.target,d:S.dist},plane:_.plane,gpuMs:zi,gpuBusy:xt,dirty:$}),render:()=>{$=!0}}}catch(t){console.error(t),si(`${String(t?.message||t)}<br><br>See the browser console for details. <a href="${Ft()}">Back to the cell list</a>`)}}function Ys(){const n=me.bbox,e=[(n.lo[0]+n.hi[0])/2,(n.lo[1]+n.hi[1])/2,(n.lo[2]+n.hi[2])/2];return{name:"Whole cell",caption:`Section through ${ne.name}.`,target:e,normal:[0,0,1],up:[0,1,0],width:.8*(n.hi[0]-n.lo[0]),slab:60}}function Xs(){const n=new URLSearchParams(location.search),e=o=>(n.get(o)??"").split(",").map(Number),t=e("t"),i=e("n");if(t.length===3&&t.every(isFinite)&&i.length===3&&i.every(isFinite)&&n.get("t")){const o=e("u"),a=Number(n.get("w")??1e3),c=Number(n.get("s")??60),l={name:"Link",caption:"",target:t,normal:i,up:o.length===3&&o.every(isFinite)?o:[0,1,0],width:a>0?a:1e3,slab:c>0?c:60};Math.abs(W(Q(l.normal),Q(l.up)))>.99&&(l.up=Math.abs(l.normal[2])<.9?[0,0,1]:[0,1,0]),te.push(l),Ge(te.length-1,!1),te.pop();return}const s=n.get("view")??ne.default_bookmark??null;let r=0;if(s!==null)if(!isNaN(Number(s))&&s.trim()!=="")r=Math.min(te.length-1,Math.max(0,Number(s)));else{const o=te.findIndex(a=>a.name.toLowerCase().startsWith(s.toLowerCase()));r=Math.max(0,o)}Ge(r,!1)}function Si(){const n=new URL(location.href);for(const s of["view","t","n","w","s","u"])n.searchParams.delete(s);const e=s=>s.map(r=>Number(r.toFixed(3))).join(","),t=_.cutOn?be():S.fwd;n.searchParams.set("t",e(S.target)),n.searchParams.set("n",e(t)),n.searchParams.set("u",e(S.up));const i=q.clientWidth/q.clientHeight;return n.searchParams.set("w",String(Math.round(2*S.dist*Math.tan(S.fovy/2)*i))),n.searchParams.set("s",String(Math.round(_.slab))),n.href}function be(){return[_.plane[0],_.plane[1],_.plane[2]]}function Me(n,e){n=Q(n),_.plane=[n[0],n[1],n[2],e],_e(),$=!0}function Ve(){const n=S.fwd;Me(n,W(n,S.target))}let Le=.5;try{const n=Number(localStorage.getItem("yc.nudgeStep"));n>0&&(Le=n)}catch{}function bt(n){const e=be();S.target=N(S.target,R(e,n)),Me(e,_.plane[3]+n)}function Qs(n){const e=q.clientWidth/q.clientHeight,t=Q(n.normal);let i=Q(ge(n.up,R(t,W(n.up,t))));return{target:[...n.target],dist:S.distForWidth(n.width,e),fwd:t,up:i}}function Ge(n,e=!0,t){const i=te[n];if(!i)return;(_.organelle||_.memColors)&&n!==0&&He("molecules"),i.dynamics?se.show(i.dynamics):se.hide();const s=Qs(i),r=Q(i.normal),o=W(r,i.target),a=be(),c=_.plane[3],l=_.slab;if(_.cutOn=!0,w("cutOn").checked=!0,ze=!1,w("followView").classList.remove("on"),!e){S.set(s),Me(r,o),_.slab=i.slab,_e(),$=!0,t?.();return}S.flyTo(s,2600,()=>{Me(r,o),_.slab=i.slab,_e(),t?.()},u=>{let p=Q(N(R(a,1-u),R(r,u)));Ce(N(R(a,1-u),R(r,u)))<.001&&(p=r),_.plane=[p[0],p[1],p[2],c+(o-c)*u],_.slab=Math.exp(Math.log(l)+(Math.log(i.slab)-Math.log(l))*u),_e()}),yt(i),$=!0}function yt(n){const e=w("caption");if(!n){e.style.display="none";return}e.innerHTML=`<b>${n.name}</b>${n.caption}`,e.style.display="block",clearTimeout(yt._t),H||(yt._t=setTimeout(()=>e.style.display="none",9e3))}function Ti(){H={i:0,phase:"fly",t:performance.now()},w("tourBtn").textContent="■ Stop",w("tourBtn").classList.add("on"),Ge(0,!0,()=>{H&&(H.phase="wait",H.t=performance.now())})}function Oe(){H=null,w("tourBtn").textContent="▶ Tour",w("tourBtn").classList.remove("on"),yt(null)}function Zs(n){if(H){if(H.phase==="wait"&&(z.pendingForView()===0||n-H.t>14e3))H.phase="hold",H.t=n;else if(H.phase==="hold"&&n-H.t>6500){H.i=(H.i+1)%te.length,H.phase="fly";const e=H.i;Ge(e,!0,()=>{H&&H.i===e&&(H.phase="wait",H.t=performance.now())})}}}let at=-1;function Mt(n){xe>=0&&(ie[xe]&=-2,xe=-1,Dt()),at=n;for(let e=0;e<ie.length;e++)n>=0&&V.moduleOf[e]===n?ie[e]|=1:ie[e]&=-2;_.highlight=n>=0,B.device.queue.writeBuffer(B.typeFlags,0,ie),Ot(),$=!0}function Ye(n){at>=0&&Mt(-1),xe>=0&&(ie[xe]&=-2),xe=n,n>=0&&(ie[n]|=1),_.highlight=n>=0,B.device.queue.writeBuffer(B.typeFlags,0,ie),Dt(),$=!0}function Dt(){const n=w("selType");if(xe<0){n.style.display="none";return}const e=V.types[xe],t=z.countLoaded(xe);n.style.display="block",n.innerHTML=`<div><b>${e.gene}</b> ${e.name}</div>
    <div class="sub" style="margin:3px 0 6px">${he(e.copies)} copies ${Li()} · ${he(t)} in loaded tiles · ${Ei(e)}</div>
    <div class="grid2"><button class="small" id="flyNearest">Fly to nearest</button><button class="small" id="clearType">Clear highlight</button></div>`,w("flyNearest").onclick=()=>Ai(xe),w("clearType").onclick=()=>Ye(-1)}function Js(n){if(n=n.trim().toLowerCase(),!n)return[];const e=[];return V.types.forEach((t,i)=>{const s=t.gene.toLowerCase(),r=t.id.toLowerCase(),o=(t.uniprot||"").toLowerCase(),a=(t.name||"").toLowerCase(),c=(t.genes||"").toLowerCase();let l=0;s===n||r===n||o===n?l=100:s.startsWith(n)||r.startsWith(n)?l=60:c.split(/[;,\s]+/).includes(n)?l=55:a.includes(n)?l=30+(a.startsWith(n)?10:0):(c.includes(n)||o.startsWith(n)||(t.pdb||"").toLowerCase()===n)&&(l=20),l&&e.push({i,s:l+Math.log10(t.copies+1)})}),e.sort((t,i)=>i.s-t.s),e.slice(0,14).map(t=>t.i)}function Ai(n){let e=[];if(Ne)for(let u=Ne.off[n];u<Ne.off[n+1];u++)e.push(Ne.tiles[u]);else e=[...z.loaded.values()].filter(u=>z.nearestInTile(u,n,S.target)>=0).map(u=>u.idx);if(!e.length){Se(Ne?"No copies of this molecule were placed.":"No copy in the loaded tiles (this cell has no types_tiles.bin).");return}let t=-1,i=1e18;for(const u of e){const p=z.tileCenter(u),d=Ce(ge(p,S.target));d<i&&(i=d,t=u)}const s=z.tileCenter(t),r=V.types[n],o=Math.max(90,r.br*9),a=u=>{const p=z.nearestInTile(u,n,s);if(p<0)return;const d=z.decode(u,p),b=be(),g=S.state();g.target=d.p,g.dist=S.distForWidth(o,q.clientWidth/q.clientHeight),S.flyTo(g,900,()=>{Me(b,W(b,d.p)-r.br*.4)}),_.plane[3]=W(b,d.p)-r.br*.4;const m=z.poolIndex(u,p);wt({kind:"inst",id:(ws|m)>>>0,info:z.instanceAt(m)})};z.loaded.get(t);const c=be(),l=S.state();l.target=s,l.dist=S.distForWidth(o*2.5,q.clientWidth/q.clientHeight),_.cutOn=!0,w("cutOn").checked=!0,(_.organelle||_.memColors)&&He("molecules"),S.flyTo(l,2200,()=>{Me(c,W(c,s)-20);const u=z.loaded.get(t);if(u)a(u);else{const p=d=>{d.idx===t&&(z.onTileLoaded.splice(z.onTileLoaded.indexOf(p),1),a(d))};z.onTileLoaded.push(p)}}),Me(c,W(c,s)-20)}async function vt(n,e){const t=B.width/q.clientWidth;return B.pick(n*t,e*t)}function Ei(n){return n.src==="PDB"?"PDB "+n.pdb:n.src==="AF-multimer"?"AlphaFold complex":n.src==="AF"?n.genes&&n.genes.includes(";")?"AlphaFold complex":"AlphaFold":"assembly unit"}function ni(n){return n.src==="PDB"&&!!n.pdb||!!n.model||n.src==="AF"&&!!n.uniprot&&!(n.genes||"").includes(";")}function jt(n){const e=n>>>30;if(n===0)return{kind:"none",title:"Outside the cell"};if(e===1){const t=z.instanceAt(n&1073741823);return t?{kind:"inst",id:n,info:t,title:V.types[t.type].gene,sub:ot(t.region)}:{kind:"none",title:""}}if(e===2){const t=n>>>1&15,i=n&1,s=ii(t),r=i?"cytoplasmic leaflet":t===B.outerMem?"exoplasmic (outer) leaflet":"lumenal leaflet";return{kind:"lipid",id:n,mem:t,leaf:i,title:"Lipid bilayer",sub:`${s} · ${r}`}}if(e===3){const t=n>>>15&7,i=n&32767;if(t===6)return{kind:"free",id:n,fk:t,chain:i,...se.describe(i)};if(t===7)return{kind:"free",id:n,fk:t,chain:i,title:"Overview stand-in",sub:`${ot(i&31)} · one sampled molecule standing for its neighbourhood; zoom in or wait for the molecules to load`};const s=["mRNA","Linker DNA","β-1,3-glucan fibril","Mannan chain","pre-rRNA","FG repeats"][t]??"polymer",r=["nucleotide-resolution thread (schematic path)","between consecutive nucleosomes, 2 bp per bead","procedural, 36 glucose per bead","procedural α-mannan on a cell-wall mannoprotein","nascent ribosomal RNA","disordered domain of an FG nucleoporin (NSP1, NUP49, NUP57, NUP159), one bead per residue"][t]??"";return{kind:"free",id:n,fk:t,chain:i,title:s,sub:r}}if(n>=512&&n<528)return{kind:"band",id:n,title:"Membrane (cut face)",sub:ii(n-512)};if(n>=256&&n<320){const t=Ws(n-256);return t&&t.code===me.outsideCode?{kind:"label",id:n,title:t.display_name??"Edge of the imaged volume",sub:t.description??"the imaged volume ends here and truncates the cell; this flat face is not a cell surface and has no membrane"}:{kind:"label",id:n,title:t?t.display_name??t.name:"compartment",sub:"compartment (not loaded at this distance, or beyond the slab)"}}return{kind:"none",title:""}}function wt(n){_i=n,_.selId=n&&n.kind==="inst"?n.id>>>0:0,Ci(),$=!0}function Ci(){const n=w("inspect"),e=_i;if(!e||e.kind==="none"){n.style.display="none";return}n.style.display="block";let t='<button class="close" id="inspClose">×</button>';if(e.kind==="inst"){const i=V.types[e.info.type],s=i.src==="PDB",r=i.nb,o=i.nnt;t+=`<h2>${i.gene}</h2><div>${i.name}</div><div style="margin-top:6px"><span class="badge ${s?"pdb":"af"}">${Ei(i)}</span>
      ${i.oligomer>1?`<span class="badge" style="background:#666">${i.oligomer}-mer</span>`:""}</div>
      <div class="kv">
      ${i.genes&&i.genes!==i.gene?`<div>Subunits</div><div style="word-break:break-word">${i.genes.split(/;\s*/).slice(0,40).join(", ")}${i.genes.split(";").length>40?" …":""}</div>`:""}
      ${i.uniprot?`<div>UniProt</div><div>${i.uniprot}</div>`:""}
      <div>Location</div><div>${ot(e.info.region)}</div>
      <div>Copies here</div><div>${i.copies.toLocaleString("en-US")} ${Li()}</div>
      <div>Mass</div><div>${(i.mass/1e3).toFixed(1)} kDa</div>
      <div>Residues drawn</div><div>${(r-o).toLocaleString("en-US")} aa${o?` + ${o.toLocaleString("en-US")} nt`:""}</div>
      <div>Radius</div><div>${i.br.toFixed(1)} nm (Rg ${i.rg.toFixed(1)} nm)</div>
      ${!s&&i.plddt_mean!=null?`<div>Mean pLDDT</div><div>${i.plddt_mean.toFixed(1)} (${Math.round((i.plddt_frac_kept??1)*100)}% of residues kept, pLDDT ≥ 50)</div>`:""}
      <div>Position</div><div>${e.info.p.map(a=>a.toFixed(1)).join(", ")} nm</div>
      </div>
      <div class="grid2"><button class="small" id="loadAtoms"${ni(i)?"":' disabled title="No single PDB or AlphaFold DB entry for this building block"'}>Load atomic model</button><button class="small" id="hlType">Highlight all</button>
      <button class="small" id="centerOn">Center view</button><button class="small" id="hideType">${ie[e.info.type]&2?"Show":"Hide"} this type</button></div>
      <div style="margin-top:9px">${i.uniprot?`<a href="https://www.uniprot.org/uniprotkb/${i.uniprot}" target="_blank">UniProt</a>`:""}
      ${s?`<a href="https://www.rcsb.org/structure/${i.pdb}" target="_blank">RCSB ${i.pdb}</a>`:""}
      ${ni(i)&&!s?`<a href="https://alphafold.ebi.ac.uk/entry/${i.model||i.uniprot}" target="_blank">AlphaFold DB</a>`:""}
      ${!i.uniprot&&i.genes&&!i.genes.includes(";")&&/^[A-Z0-9-]+$/.test(i.gene)&&!rn(i.id)&&ne.organism?.taxon?`<a href="https://www.uniprot.org/uniprotkb?query=gene_exact:${encodeURIComponent(i.gene)}+AND+organism_id:${ne.organism.taxon}" target="_blank">UniProt search</a>`:""}</div>`}else if(t+=`<h2>${e.title}</h2><div class="sub" style="font-size:12.5px">${e.sub||""}</div>`,e.kind==="lipid"){const i=X.lipids??{},s=ke.membranes.find(a=>a.code===e.mem),r=s&&i[s.name]||i.default||{},o=Object.entries(r).filter(([,a])=>typeof a=="number"&&a>0).map(([a,c])=>`${a} ${c}%`).join(", ");t+=`<p class="sub">Lipids are generated in your browser on the mesh of this membrane (${o||"composition not given"}${i.source?`; ${i.source}`:""}). They sit at 0.65 nm² per lipid and are removed where they would overlap protein.</p>`}n.innerHTML=t,w("inspClose").onclick=()=>wt(null),e.kind==="inst"&&(w("loadAtoms").onclick=()=>tn(e.info.type),w("hlType").onclick=()=>Ye(e.info.type),w("centerOn").onclick=()=>{const i=S.state();i.target=e.info.p,S.flyTo(i,700)},w("hideType").onclick=()=>{ie[e.info.type]^=2,B.device.queue.writeBuffer(B.typeFlags,0,ie),Ci(),$=!0})}let mt=null,it=null;function en(){if(it)return it;const n="https://cdn.jsdelivr.net/npm/molstar@4.18.0/build/viewer/",e=t=>new Promise((i,s)=>{const r=document.createElement("link");r.rel="stylesheet",r.href=t+"molstar.css",document.head.appendChild(r);const o=document.createElement("script");o.src=t+"molstar.js",o.onload=()=>i(),o.onerror=()=>{r.remove(),o.remove(),s(new Error("Mol* failed to load"))},document.head.appendChild(o)});return it=(window.__YC_EMBED__?e(n):e("molstar/").catch(()=>e(n))).catch(t=>{throw it=null,t}),it}async function tn(n){const e=V.types[n];w("molModal").style.display="flex",w("molTitle").textContent=`${e.gene} · ${e.name} · loading…`;try{await en();const t=window.molstar;mt?await mt.plugin.clear():mt=await t.Viewer.create("molHost",{layoutIsExpanded:!1,layoutShowControls:!1,layoutShowRemoteState:!1,layoutShowSequence:!0,layoutShowLog:!1,layoutShowLeftPanel:!1,viewportShowExpand:!1,viewportShowSelectionMode:!1,viewportShowAnimation:!1,collapseLeftPanel:!0,pdbProvider:"rcsb",emdbProvider:"rcsb"});let i="",s="";if(e.src==="PDB"&&e.pdb){i=`https://files.rcsb.org/download/${e.pdb}-assembly1.cif`,s=`https://www.rcsb.org/structure/${e.pdb}`;try{(await fetch(i,{method:"HEAD"})).ok||(i=`https://files.rcsb.org/download/${e.pdb}.cif`)}catch{i=`https://files.rcsb.org/download/${e.pdb}.cif`}}else{const o=e.model||e.uniprot;s=`https://alphafold.ebi.ac.uk/entry/${o}`;try{const c=await(await fetch(`https://alphafold.ebi.ac.uk/api/prediction/${o}`)).json();i=(Array.isArray(c)?c[0]:c)?.cifUrl}catch{}i||(i=e.model?`https://alphafold.ebi.ac.uk/files/${e.model}-model_v1.cif`:`https://alphafold.ebi.ac.uk/files/AF-${e.uniprot}-F1-model_v6.cif`)}await mt.loadStructureFromUrl(i,"mmcif",!1),w("molTitle").textContent=`${e.gene} · ${e.name} · ${e.src==="PDB"?"PDB "+e.pdb+" (biological assembly)":e.model?`AlphaFold DB predicted ${e.oligomer}-mer (full length, incl. low-pLDDT regions)`:"AlphaFold DB model (full length, incl. low-pLDDT regions)"}`;const r=w("molLink");r.href=s,r.textContent="Open source page"}catch(t){w("molTitle").textContent=`Could not load the atomic model: ${t?.message||t}. Internet access to RCSB/AlphaFold DB is needed.`}}let ri=!1;function Fi(){ri||(ri=!0,Se("Loading whole-cell organelle surfaces…"),$e(Ie.files.meshes).then(n=>{B.uploadOrganelleMeshes(n),$=!0}).catch(n=>Se(`No organelle surfaces: ${n?.message||n}`)))}let It=()=>{};function Ii(){const n=_.memColors&&!_.organelle;w("modeSection").classList.toggle("on",!_.organelle&&!n),w("modeOrg").classList.toggle("on",_.organelle),w("modeMem").classList.toggle("on",n)}function sn(n){_.organelle=n,n&&Fi(),Ii(),$=!0}function He(n){n!=="membranes"&&_.memColors&&It(!1),sn(n==="organelles"),n==="membranes"&&It(!0)}function Oi(n){ki=n;const e={low:[2.6,.75],med:[1.6,1],high:[1,1],ultra:[.6,1],auto:[1.6,1]},[t,i]=e[n];_.l0px=t,_.renderScale=i,B.resize(i),$=!0}function Ot(){const n=w("legend"),e=(i,s)=>`<div><span class="sw" style="background:${i}"></span>${s}</div>`,t=_.colorMode;if(t===0){const i=X.legend?.length?X.legend.map(s=>e(s.colour,s.label)):[...X.classes.map(s=>e(s.colour,s.name)),...$i().map(s=>e(s.colour,s.label))];$t()&&i.push(e(rt[40],"lipid head"),e(rt[41],"lipid tail")),X.features?.open_face&&i.push(e(rt[61],"flat face: edge of the imaged volume")),n.innerHTML=i.join("")}else t===1?n.innerHTML=e("#4C8CD9","experimental (PDB)")+e("#F5A84C","AlphaFold model"):t===2?n.innerHTML=e("#0053D6","pLDDT > 90")+e("#65CBF3","70–90")+e("#FFDB13","50–70")+e("#B8B8B8","experimental (PDB)"):t===3?n.innerHTML='<div style="grid-column: 1 / 3"><div style="height:8px;border-radius:3px;background:linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725)"></div><div style="display:flex;justify-content:space-between"><span>1</span><span>10³</span><span>10⁶ copies</span></div></div>':t===6?(n.innerHTML=V.modules.length?'<div class="sub" style="grid-column: 1 / 3">Click a module to highlight it</div>'+V.modules.map((i,s)=>`<div class="modsw${at===s?" on":""}" data-m="${s}" title="${i.n} proteins"><span class="sw" style="background:${yi(s)}"></span>${i.label}</div>`).join("")+e("#D1D1CC","no module"):'<div style="grid-column: 1 / 3">No interaction modules in this build</div>',n.querySelectorAll(".modsw").forEach(i=>i.onclick=()=>{const s=Number(i.dataset.m);Mt(at===s?-1:s)})):t===5?n.innerHTML=de.filter(i=>lt(i.id)).map(i=>e(i.colour,ot(i.id))).join(""):n.innerHTML=""}const nn={soluble:"Soluble proteins",membrane:"Membrane proteins",shell:"Anchored, cortex, lamina",prepass:"Pre-placed assemblies"};function $i(){const n=new Map;for(const e of de){if(!lt(e.id))continue;const t=e.group||e.kind||"other";n.has(t)||n.set(t,{key:t,label:nn[t]??t[0].toUpperCase()+t.slice(1),colour:e.colour,ids:[]}),n.get(t).ids.push(e.id)}return[...n.values()]}const $t=()=>!!X.lipid_meshes||ae&&ae.nTri.some(n=>n>0),rn=n=>X.classes.find(e=>bi(n,e.patterns));function Ht(){return{lo:[...me.bbox.lo],hi:[...me.bbox.hi]}}function Gi(n){const e=Ht();let t=1/0,i=-1/0;for(let s=0;s<8;s++){const r=[s&1?e.hi[0]:e.lo[0],s&2?e.hi[1]:e.lo[1],s&4?e.hi[2]:e.lo[2]],o=W(n,r);t=Math.min(t,o),i=Math.max(i,o)}return[Math.floor(t-100),Math.ceil(i+100)]}function _e(){const n=_.plane[3],[e,t]=Gi(be()),i=w("planeD");i.min=String(e),i.max=String(t),i.value=String(Math.round(n)),w("planeDv").textContent=`${Number(n.toFixed(Le<.5?2:1))} nm`;const s=_.slab;w("slab").value=String(Math.round(Math.log(s/5)/Math.log(4400/5)*1e3)),w("slabv").textContent=Pi(s),["axX","axY","axZ"].forEach((r,o)=>w(r).classList.toggle("on",Math.abs(_.plane[o])>.999)),Gt=!0}function on(){const n=V.types.length;let e=0;for(const h of V.types)e+=h.copies;let t=0;for(let h=0;h<ae.n;h++)t+=ae.nInst[h];e||(e=t),w("cellTitle").textContent=ne.name,w("cellSub").innerHTML=`<i>${ne.organism?.name??""}</i> · ${ne.cell_type??""} · ${ne.state??""}`,w("subCount").textContent=`${(t/1e6).toFixed(t>1e8?0:1)} M macromolecules of ${n.toLocaleString("en-US")} species in the whole cell (${ae.n.toLocaleString("en-US")} tiles, streamed around the view), each a PDB or AlphaFold structure`,w("switchCell").onclick=()=>{location.href=Ft()},w("copyLink").onclick=()=>{const h=Si();history.replaceState(null,"",h),navigator.clipboard?.writeText(h).then(()=>Se("Link to this view copied"),()=>Se("Link in the address bar"))};const i=w("colorMode"),s=h=>{const M=i.querySelector(`option[value="${h}"]`);M&&M.remove()};if(V.types.every(h=>h.plddt_mean==null)&&s("2"),V.modules.length||s("6"),De(Ie.files.meshes)&&(w("modeOrg").disabled=!0,w("modeOrg").title="This cell has no organelle surfaces",w("modeMem").disabled=!0,w("modeMem").title="This cell has no organelle surfaces"),!$t()){const h=w("detailOn").parentElement;h.style.display="none"}const r=w("views");if(te.forEach((h,M)=>{const v=document.createElement("button");v.textContent=`${(M+1)%10===0&&M<10?0:M<9?M+1:""}${M<10?" · ":""}${h.name}`,v.title=h.caption,v.onclick=()=>{Oe(),Ge(M)},r.appendChild(v)}),w("tourBtn").onclick=()=>H?Oe():Ti(),document.querySelectorAll(".dynHelp").forEach(h=>h.style.display=je?"":"none"),je){const h=document.createElement("button");h.className="small",h.textContent="Dynamics",h.title="Show / hide the tracer diffusion example (G)",h.onclick=()=>Ri(),w("tourBtn").parentElement.prepend(h," ")}const o=w("search"),a=w("results");let c=0,l=[];const u=()=>{a.innerHTML=l.map((h,M)=>{const v=V.types[h];return`<div data-i="${h}" class="${M===c?"act":""}"><span class="nm"><b>${v.gene}</b> ${v.name}</span><span class="n">${he(v.copies)}</span></div>`}).join(""),a.querySelectorAll("div").forEach(h=>h.addEventListener("click",()=>{Ye(Number(h.dataset.i)),l=[],u(),o.value=""}))};o.addEventListener("input",()=>{l=Js(o.value),c=0,u()}),o.addEventListener("keydown",h=>{h.key==="ArrowDown"?(c=Math.min(l.length-1,c+1),u(),h.preventDefault()):h.key==="ArrowUp"?(c=Math.max(0,c-1),u(),h.preventDefault()):h.key==="Enter"&&l.length?(Ye(l[c]),Ai(l[c]),l=[],u(),o.value="",o.blur()):h.key==="Escape"&&(l=[],u(),o.blur()),h.stopPropagation()}),w("cutOn").onchange=h=>{_.cutOn=h.target.checked,$=!0};const p=h=>()=>{const M=[0,0,0];M[h]=W(S.fwd,[h===0?1:0,h===1?1:0,h===2?1:0])>=0?1:-1,_.cutOn=!0,w("cutOn").checked=!0,Me(M,W(M,S.target))};w("axX").onclick=p(0),w("axY").onclick=p(1),w("axZ").onclick=p(2),w("alignView").onclick=()=>{_.cutOn=!0,w("cutOn").checked=!0,Ve()},w("followView").onclick=()=>{ze=!ze,w("followView").classList.toggle("on",ze),ze&&Ve()},w("planeD").oninput=h=>{const M=Number(h.target.value),v=be(),C=M-_.plane[3];S.target=N(S.target,R(v,C)),Me(v,M)};const d=w("nudgeStep");[...d.options].some(h=>Number(h.value)===Le)&&(d.value=String(Le)),d.onchange=()=>{Le=Number(d.value),_e(),d.blur();try{localStorage.setItem("yc.nudgeStep",String(Le))}catch{}};for(const[h,M]of[["nudgeBack",-1],["nudgeFwd",1]]){const v=w(h);let C=0,I=0;const F=()=>{clearTimeout(C),clearInterval(I)};v.addEventListener("pointerdown",G=>{G.preventDefault(),F(),we=null,w("sweepBtn").classList.remove("on"),bt(M*Le),C=window.setTimeout(()=>{I=window.setInterval(()=>bt(M*Le),60)},400)});for(const G of["pointerup","pointerleave","pointercancel"])v.addEventListener(G,F)}w("slab").oninput=h=>{const M=Number(h.target.value)/1e3;_.slab=5*Math.pow(4400/5,M),_e(),$=!0},w("sweepBtn").onclick=()=>{if(we){we=null,w("sweepBtn").classList.remove("on");return}const h=be();_.cutOn=!0,w("cutOn").checked=!0;const[M,v]=Gi(h);we={t0:performance.now(),d0:M,d1:v,dur:Math.max(3e4,(v-M)/4400*3e4/2)},S.target=N(S.target,R(h,M-_.plane[3])),w("sweepBtn").classList.add("on")},w("flipBtn").onclick=()=>{const h=be(),M=S.state(),v=S.target,C=R(h,-1);Me(C,-_.plane[3]),M.fwd=R(M.fwd,-1),M.target=v,S.flyTo(M,1200)},w("modeSection").onclick=()=>He("molecules"),w("modeOrg").onclick=()=>He("organelles"),w("modeMem").onclick=()=>He("membranes"),w("colorMode").onchange=h=>{_.colorMode=Number(h.target.value),_.colorMode!==6&&at>=0&&Mt(-1),Ot(),$=!0},w("shaded").onchange=h=>{_.shaded=h.target.checked,$=!0},w("motion").onchange=h=>{_.motion=Number(h.target.value),h.target.blur(),$=!0},w("outlines").onchange=h=>{_.outline=h.target.checked?1:0,$=!0},Ot();const b=w("showList"),g=h=>h.reduce((M,v)=>M+v,0),m=g(ae.nTri)>0,f=[...X.classes.filter(h=>h.own_switch!==!1&&Nt(h.patterns).length>0).map(h=>[h.name,h.colour,M=>an(h.patterns,!M)]),g(ae.nPoly)>0&&["Polymers (RNA, DNA)","#B0437A",h=>{oi(0,h),oi(1,h)}],m&&["Lipids","#F3C643",h=>{_.showLipids=h,$=!0}],["Membranes","#F8E3A0",h=>{_.showMeshes=h,$=!0}],...$i().map(h=>[h.label,h.colour,M=>At(h.ids,M)])].filter(Boolean),y=[],x=de.map(h=>h.id),A=f.findIndex(([h])=>h==="Membranes"),k=()=>{_.memColors=y.every((h,M)=>h.checked===(M===A))&&!De(Ie.files.meshes),_.memColors&&Fi(),Ii(),$=!0},E=h=>{f.forEach(([,,v],C)=>{y[C].checked=h(C),v(h(C))});const M=f.every((v,C)=>h(C));At(x,M),k()};f.forEach(([h,M,v],C)=>{const I=document.createElement("label");I.className="chk",I.innerHTML=`<input type="checkbox" checked><span class="sw" style="background:${M}"></span><span class="nm">${h}</span><a class="only" title="Show only ${h.toLowerCase()}">only</a>`;const F=I.querySelector("input");y.push(F),F.onchange=()=>{v(F.checked),k()},I.querySelector(".only").onclick=G=>{G.preventDefault(),G.stopPropagation(),E(j=>j===C)},b.appendChild(I)}),It=h=>E(h?(M=>M===A):(()=>!0)),w("showAll").onclick=()=>E(()=>!0),w("hideAll").onclick=()=>E(()=>!1);const P=w("regionList");de.forEach(h=>{if(!lt(h.id))return;const M=document.createElement("label");M.className="chk",M.innerHTML=`<input type="checkbox" checked data-r="${h.id}"><span class="sw" style="background:${h.colour}"></span>${ot(h.id)}`,M.querySelector("input").onchange=v=>At([h.id],v.target.checked),P.appendChild(M)}),w("quality").onchange=h=>Oi(h.target.value);const L=w("detailBudget");L.value=B.detail,L.title=`Molecules kept on the GPU at once (now ${B.detailUsed}). Changing it reloads the page.`,L.onchange=()=>{try{localStorage.setItem("yc.detail",L.value)}catch{}const h=new URL(location.href);h.searchParams.delete("detail"),location.href=h.href},w("detailOn").onchange=h=>{if(z.detailEnabled=h.target.checked,!z.detailEnabled)for(const M of z.loaded.values())M.det&&z.dropDetail(M);$=!0},w("shotBtn").onclick=Bi,w("helpBtn").onclick=()=>w("helpModal").style.display="flex",w("aboutBtn").onclick=()=>w("aboutModal").style.display="flex",w("aboutBody").innerHTML=Cs(ne,X,de,{nTypes:n,nInst:t,hasLipids:$t(),resample:ke.resample_check});{const h=Ht(),M=Math.max(h.hi[0]-h.lo[0],h.hi[1]-h.lo[1],h.hi[2]-h.lo[2])/1e3;w("zoomHelp").textContent=`Zoom (from the whole cell, about ${M.toFixed(M<10?1:0)} µm across, down to single residues; molecules stream in around the view centre)`}const T=async(h,M)=>{if(w("modelModal").style.display="flex",!h||De(h)){w("modelBody").innerHTML=`<h1>${M}</h1><p>This cell's data include no ${M.toLowerCase()}.</p>`;return}w("modelBody").innerHTML="<p>Loading…</p>";try{let v=await ds(h);je||(v=v.replace(/\n## Dynamics example[\s\S]*?(?=\n## |$)/,`
`)),w("modelBody").innerHTML=Fs(v)}catch(v){w("modelBody").innerHTML=`<p>Could not load ${h}: ${v?.message||v}</p>`}};w("modelBtn").onclick=()=>T(Ie.files.model_doc,"Model details"),w("aboutModal").addEventListener("click",h=>{const M=h.target.id;M==="aboutToModel"&&(h.preventDefault(),w("aboutModal").style.display="none",w("modelBtn").click()),M==="aboutAttribution"&&(h.preventDefault(),w("aboutModal").style.display="none",T(ne.licence?.attribution??Ie.files.attribution,"Attribution")),M==="aboutSwitch"&&(h.preventDefault(),location.href=Ft())}),document.querySelectorAll(".modal").forEach(h=>h.addEventListener("click",M=>{(M.target===h||M.target.classList.contains("close"))&&(h.style.display="none")})),w("molClose").onclick=()=>w("molModal").style.display="none",w("panelToggle").onclick=()=>{w("panel").classList.toggle("collapsed"),w("panelToggle").textContent=w("panel").classList.contains("collapsed")?"›":"‹"},_e(),Wt(),cn()}function Ri(){if(se.visible){se.hide();return}const n=te.findIndex(e=>e.dynamics&&(!se.data||e.dynamics===se.cur.region));n>=0?(Oe(),Ge(n)):se.show()}function an(n,e){for(const t of Nt(n))e?ie[t]|=2:ie[t]&=-3;B.device.queue.writeBuffer(B.typeFlags,0,ie),$=!0}function oi(n,e){e?_.freeHide&=~(1<<n):_.freeHide|=1<<n,$=!0}function lt(n){const e=lt.cache??(lt.cache=new Set(V.types.flatMap(t=>Object.keys(t.regions??{}).map(Number))));return e.size===0||e.has(n)}function At(n,e){for(const t of n)e?Ke[t]|=1:Ke[t]&=-2;B.setPalette(gi(de,ke,Ke,X)),document.querySelectorAll("#regionList input").forEach(t=>{t.checked=(Ke[Number(t.dataset.r)]&1)===1}),$=!0}function Wt(){let n=null;const e=new Set;q.addEventListener("contextmenu",i=>i.preventDefault()),q.addEventListener("pointerdown",i=>{q.setPointerCapture(i.pointerId),q.focus(),n={x:i.clientX,y:i.clientY,btn:i.button,moved:0,shift:i.shiftKey},q.classList.add("dragging"),H&&Oe()}),q.addEventListener("pointermove",i=>{if(!n){ln(i.clientX,i.clientY);return}const s=i.clientX-n.x,r=i.clientY-n.y;if(n.x=i.clientX,n.y=i.clientY,n.moved+=Math.abs(s)+Math.abs(r),n.btn===2||n.btn===1||n.shift){const o=S.pxPerNmAtUnit(q.clientHeight)/S.dist;S.pan(s,r,o)}else S.orbit(s*.005,r*.005),ze&&Ve();S.anim=null,$=!0});const t=i=>{if(!n)return;const s=n.moved<4&&n.btn===0;n=null,q.classList.remove("dragging"),s&&vt(i.offsetX,i.offsetY).then(r=>{const o=jt(r.id);wt(o.kind==="inst"||o.kind==="lipid"||o.kind==="free"||o.kind==="band"?o:null)})};q.addEventListener("pointerup",t),q.addEventListener("pointercancel",t),q.addEventListener("dblclick",i=>{vt(i.offsetX,i.offsetY).then(s=>{if(s.depth<=0)return;const r=S.near(),o=r/s.depth,a=q.clientWidth/q.clientHeight,c=S.ray(i.offsetX/q.clientWidth,i.offsetY/q.clientHeight,a),l=o/W(c,S.fwd),u=N(S.eye,R(c,l)),p=S.state();p.target=u,p.dist=Math.max(S.minDist*4,S.dist*.55),S.flyTo(p,900)})}),q.addEventListener("wheel",i=>{i.preventDefault();const s=i.deltaY||i.deltaX,r=i.deltaMode===1?s*30:s;if(i.altKey)bt(Math.sign(r)*Le*Math.min(4,Math.abs(r)/100));else if(i.shiftKey){const o=be(),a=Math.max(1,Math.min(_.slab,S.dist*.05))*Math.sign(r)*Math.min(4,Math.abs(r)/60+.5);S.target=N(S.target,R(o,a)),Me(o,_.plane[3]+a)}else{const o=Math.exp(r*.0015*(i.metaKey?.125:1)),a=q.clientWidth/q.clientHeight,c=S.ray(i.offsetX/q.clientWidth,i.offsetY/q.clientHeight,a),l=S.dist,u=N(S.eye,R(c,l/W(c,S.fwd))),p=S.dist;S.zoom(o);const d=1-S.dist/p;S.target=N(S.target,R(ge(u,S.target),d))}S.anim=null,H&&Oe(),$=!0},{passive:!1}),window.addEventListener("keydown",i=>{if(i.target.tagName==="INPUT"||i.target.tagName==="SELECT")return;const s=i.key.toLowerCase();if(e.add(s),s==="c")_.cutOn=!_.cutOn,w("cutOn").checked=_.cutOn,$=!0;else if(s==="v")_.cutOn=!0,w("cutOn").checked=!0,Ve();else if(s==="[")_.slab=Math.max(5,_.slab/1.25),_e(),$=!0;else if(s==="]")_.slab=Math.min(4400,_.slab*1.25),_e(),$=!0;else if(s===","||s==="."||i.code==="Comma"||i.code==="Period"){const r=s==="."||i.code==="Period";bt((r?1:-1)*(i.altKey?Le:Math.max(2,_.slab*.25)))}else if(s==="o")He(_.organelle?"molecules":"organelles");else if(s==="m")He(_.memColors&&!_.organelle?"molecules":"membranes");else if(s==="t")H?Oe():Ti();else if(s==="p")Bi();else if(s==="g"&&je)Ri();else if(s==="k"&&je&&se.visible)se.setPlaying(!se.playing);else if(s==="escape")wt(null),Ye(-1);else if(/^[0-9]$/.test(s)){const r=s==="0"?9:Number(s)-1;r<te.length&&(Oe(),Ge(r))}}),window.addEventListener("keyup",i=>e.delete(i.key.toLowerCase())),window.addEventListener("blur",()=>e.clear()),Wt.keys=e,window.addEventListener("resize",()=>{B.resize(_.renderScale),$=!0})}let ai=0,Et=!1;function ln(n,e){const t=performance.now();Et||t-ai<90||(ai=t,Et=!0,$=!0,vt(n,e).then(i=>{Et=!1;const s=jt(i.id),r=w("hover");if(!s.title||s.kind==="none"){r.style.display="none";return}let o=`<b>${s.title}</b>`;if(s.kind==="inst"){const a=V.types[s.info.type];o+=` · ${a.name} <span style="color:#aaa">· ${s.sub}</span>`}else o+=` <span style="color:#aaa">· ${s.sub}</span>`;r.innerHTML=o,r.style.display="block",r.style.left=`${n+14}px`,r.style.top=`${e+12}px`}))}q.addEventListener("pointerleave",()=>w("hover").style.display="none");let Gt=!0,li=0,Ae=null;const st={data:null};function cn(){const n=w("minimap");n.addEventListener("click",e=>{if(!Ae)return;const t=n.getBoundingClientRect(),i=((e.clientX-t.left)/t.width*2-1)*Ae.ext,s=(1-(e.clientY-t.top)/t.height*2)*Ae.ext,r=N(Ae.c,N(R(Ae.u,i),R(Ae.v,s))),o=S.state();o.target=r,S.flyTo(o,1200),H&&Oe()})}function Rt(n){const e=w("minimap"),t=e.getContext("2d"),i=e.width,s=e.height,r=_.cutOn?be():S.fwd,o=_.cutOn?_.plane[3]:W(S.fwd,S.target);if(Gt&&n-li>250){Gt=!1,li=n;let f=ge(S.right,R(r,W(S.right,r)));Ce(f)<.001&&(f=Q(Ee(r,[0,0,1]))),f=Q(f);let y=Ee(r,f);W(y,S.up)<0&&(y=R(y,-1));const x=Ht(),A=.55*Math.max(x.hi[0]-x.lo[0],x.hi[1]-x.lo[1],x.hi[2]-x.lo[2]),k=[(x.lo[0]+x.hi[0])/2,(x.lo[1]+x.hi[1])/2,(x.lo[2]+x.hi[2])/2],E=N(R(r,o),ge(k,R(r,W(r,k))));Ae={u:f,v:y,c:E,ext:A};const P=120,L=t.createImageData(P,P),T=[],h=new Set([me.exteriorCode,me.outsideCode]);for(const M of ke.labels)T[M.code]=mi(M.fill??pi).map(v=>Math.round(v*255)),M.fill||h.add(M.code);for(let M=0;M<P;M++)for(let v=0;v<P;v++){const C=((v+.5)/P*2-1)*A,I=(1-(M+.5)/P*2)*A,F=N(E,N(R(f,C),R(y,I))),G=me.label(F[0],F[1],F[2]),j=T[G]??[200,200,200],K=4*(M*P+v);L.data[K]=j[0],L.data[K+1]=j[1],L.data[K+2]=j[2],L.data[K+3]=h.has(G)||G<0?0:255}st.data=L}if(!st.data||!Ae)return;const a=Rt.tmp||(Rt.tmp=document.createElement("canvas"));a.width=st.data.width,a.height=st.data.height,a.getContext("2d").putImageData(st.data,0,0),t.clearRect(0,0,i,s),t.imageSmoothingEnabled=!0,t.drawImage(a,0,0,i,s);const c=Ae,l=f=>{const y=ge(f,c.c);return[(W(y,c.u)/c.ext+1)/2*i,(1-W(y,c.v)/c.ext)/2*s]},u=q.clientWidth/q.clientHeight,p=S.dist*Math.tan(S.fovy/2),d=p*u,b=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([f,y])=>l(N(S.target,N(R(S.right,f*d),R(S.up,y*p)))));t.strokeStyle="#FF9400",t.lineWidth=3,t.beginPath(),b.forEach(([f,y],x)=>x?t.lineTo(f,y):t.moveTo(f,y)),t.closePath(),t.stroke();const[g,m]=l(S.target);t.fillStyle="#FF9400",t.beginPath(),t.arc(g,m,5,0,7),t.fill(),w("mmLabel").textContent=_.cutOn?`plane ${Math.round(o)} nm`:"view plane"}function Bi(){const n=_.renderScale;B.resize(2*n),_.renderScale=2*n,qi(!0),q.toBlob(e=>{if(e){const t=document.createElement("a");t.href=URL.createObjectURL(e),t.download=`${ne.id}_${new Date().toISOString().replace(/[:.]/g,"-").slice(0,19)}.png`,t.click(),setTimeout(()=>URL.revokeObjectURL(t.href),5e3)}_.renderScale=n,B.resize(n),$=!0},"image/png"),Se("Screenshot saved (2× resolution)")}function un(){const n=z.totals(),e=B.stats,t=pe.length>3?1e3/(pe.reduce((l,u)=>l+u)/pe.length):0,i=z.pendingForView();w("hud").innerHTML=`<b>${he(n.inst)}</b> molecules in ${n.tiles} tiles${i?` · <span style="color:#FF9400">streaming ${i}</span>`:""}${z.starved?` · <span style="color:#FF9400">budget of ${he(n.instCap)} molecules reached (thinner slab or higher Detail loads more)</span>`:""}${z.whole&&_.cutOn&&n.secWant?` · section ${Math.round(100*n.secHave/n.secWant)}% of ${n.secWant} tiles`:""}${n.thin<1?` · <span style="color:#FF9400">${Math.round(100*n.thin)}% of the molecules per tile (budget; zoom in or raise Detail for all)</span>`:""}${n.ovSpheres?` · ${he(n.ovSpheres)} stand-ins`:""}<br>
    drawn: <b>${he(e.ninst)}</b> in view · ${he(e.l0*64)} residue beads (≤) · ${he(e.l1*16)} LOD1 · ${he(e.l2)} LOD2 · ${he(e.lip)} lipids · ${he(e.fre)} polymer beads<br>
    ${t?`${t.toFixed(0)} fps · `:""}LOD bead ≥ ${_.l0px.toFixed(1)} px · GPU pools ${B.gpuMemoryMB().toFixed(0)} MB · ${(z.bytesLoaded/1048576).toFixed(0)} MB streamed${B.adapterInfo?" · "+B.adapterInfo:""}`;const s=B.width/q.clientWidth,r=S.pxPerNmAtUnit(B.height)/S.dist/s,o=120/r,a=Math.pow(10,Math.floor(Math.log10(o))),c=[1,2,5,10].map(l=>l*a).reduce((l,u)=>Math.abs(u-o)<Math.abs(l-o)?u:l);w("scalebar").querySelector(".bar").style.width=`${c*r}px`,w("scalebar").querySelector("span").textContent=Pi(c)}let zi=0,xt=!1;function qi(n=!1){const e=performance.now();B.frame(S,_,z.meshDraws(),n||e-B.lastStatsT>400),B.lastStatsT=performance.now(),xt=!0,B.device.queue.onSubmittedWorkDone().then(()=>{zi=performance.now()-e,xt=!1})}let ci=0;function Ui(){z.update(S,q.clientWidth/q.clientHeight,_.cutOn,_.plane,_.slab,_.organelle||_.memColors,B.height),Ut=performance.now(),(z.inflight||z.detInflight)&&($=!0)}setInterval(()=>{z&&performance.now()-Ut>150&&Ui()},150);function Ni(n){requestAnimationFrame(Ni);const e=Tt?n-Tt:16;Tt=n;const t=Wt.keys;if(t&&t.size){const i=S.dist*.9*e/1e3;let s=[0,0,0];t.has("w")&&(s=N(s,R(S.fwd,i))),t.has("s")&&(s=N(s,R(S.fwd,-i))),t.has("a")&&(s=N(s,R(S.right,-i))),t.has("d")&&(s=N(s,R(S.right,i))),t.has("q")&&(s=N(s,R(S.up,-i))),t.has("e")&&(s=N(s,R(S.up,i))),t.has("z")&&S.roll(-e*.0015),t.has("x")&&S.roll(e*.0015),(Ce(s)>0||t.has("z")||t.has("x"))&&(S.fly(s),$=!0,ze&&Ve())}if(S.step(n)&&($=!0,ze&&!H&&Ve()),we){const i=Math.min(1,(n-we.t0)/we.dur),s=be(),r=we.d0+(we.d1-we.d0)*i;S.target=N(S.target,R(s,r-_.plane[3])),_.plane[3]=r,_e(),i>=1&&(we=null,w("sweepBtn").classList.remove("on")),$=!0}if(Zs(n),_.motion>0&&($=!0),se.tick(e)&&($=!0),n-Ut>90&&Ui(),$&&!xt){if($=!1,qi(),pe.push(e),pe.length>30&&pe.shift(),ki==="auto"&&pe.length>=20){const i=pe.reduce((s,r)=>s+r)/pe.length;i>45&&_.l0px<3.5?(_.l0px=Math.min(3.5,_.l0px*1.15),pe.length=0):i<22&&_.l0px>.9&&(_.l0px=Math.max(.9,_.l0px/1.1),pe.length=0)}setTimeout(()=>{$=$||B.statsBusy},0)}else $||(pe.length=0);n-ci>300&&(ci=n,un(),Rt(n),xe>=0&&z.inflight&&Dt())}Vs();
