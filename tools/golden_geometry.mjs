// Golden test of the viewer's geometry evaluator (app/src/geometry.ts) against the pipeline's numba kernels
// (cellgeom_eval_v1), on the exact viewer G of a cell: labels must agree exactly; membrane SDFs within TOL nm where
// |d| < the prim margin (farther prims are skipped by the viewer's acceleration grid, see geometry.ts).
// Reference points: <data>/geometry_golden.json (tools/export_viewer_extras.py, step geometry).
//
// usage: node tools/golden_geometry.mjs <viewer data dir> [<viewer data dir> ...]     (needs esbuild: cd tests && npm install)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', 'tests', 'package.json'));
const esbuild = require('esbuild');
const out = esbuild.buildSync({ entryPoints: [join(HERE, '..', 'app', 'src', 'geometry.ts')], bundle: true, format: 'esm', write: false, platform: 'neutral' });
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const TOL = 1e-3;
let failed = false;
for (const dir of process.argv.slice(2)) {
  const geo = JSON.parse(readFileSync(join(dir, 'geometry.json'), 'utf8'));
  const buf = readFileSync(join(dir, geo.G.file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const G = geo.G.dtype === 'f64' ? new Float64Array(ab) : Float64Array.from(new Float32Array(ab));
  for (const [i, v] of geo.G.patches ?? []) G[i] = v;
  const t0 = Date.now();
  const ev = new mod.GeomEval(geo, G);
  const gold = JSON.parse(readFileSync(join(dir, 'geometry_golden.json'), 'utf8'));
  const P = gold.points, L = gold.labels, M = gold.mems, nm = gold.n_mems, n = L.length;
  const memOut = new Float64Array(32);
  let labOk = 0, sdfN = 0, sdfBad = 0, maxErr = 0; const bad = [];
  const conf = {};
  for (let i = 0; i < n; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    ev.memSdfs(x, y, z, memOut);
    const lab = ev.labelFrom(x, y, z, memOut);
    if (lab === L[i]) labOk++; else { if (bad.length < 8) bad.push({ i, p: [x, y, z], ts: lab, py: L[i] }); const k = `${L[i]}->${lab}`; conf[k] = (conf[k] ?? 0) + 1; }
    for (let m = 0; m < nm; m++) {
      const r = M[nm * i + m];
      if (Math.abs(r) >= ev.margin) continue;
      sdfN++;
      const e = Math.abs(memOut[m] - r);
      if (e > maxErr) maxErr = e;
      if (e > TOL) sdfBad++;
    }
  }
  // domain depth (rows subset) must equal the full evaluation of the domain membrane
  let domBad = 0;
  if (ev.domainMem >= 0) for (let i = 0; i < Math.min(n, 2000); i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    ev.memSdfs(x, y, z, memOut); const full = memOut[ev.domainMem];
    if (Math.abs(ev.domainDepth(x, y, z) - full) > 1e-9) domBad++;
  }
  const rep = { cell: geo.cell_id, build: geo.build_id, n, labels_equal: labOk, label_agreement: labOk / n, sdf_checked: sdfN, sdf_over_tol: sdfBad,
    max_sdf_err_nm: Number(maxErr.toExponential(3)), domain_rows_mismatch: domBad, domain_membrane: ev.domainMem, margin_nm: ev.margin,
    grid: { n: ev.grid.n, prim_refs: ev.grid.primIdx.length, pore_refs: ev.grid.poreIdx.length }, ms: Date.now() - t0, mismatches: conf, examples: bad };
  console.log(JSON.stringify(rep, null, 1));
  if (labOk !== n || sdfBad > 0 || domBad > 0) failed = true;
}
process.exit(failed ? 1 : 0);
