// Screenshots of named views with procedural lipids (tile MESH sections) and polymer threads (POLY sections), headless
// Chrome on the real GPU (compat mode). Waits until the view's tiles and the lipid detail are loaded.
//
// usage: node tests/mesh_screens.mjs --url http://localhost:8765/ --cells cells.local.json --out DIR
//        --shot cell:view[:file] [--shot ...] [--gpu compat] [--wait 120]
// view = a bookmark name prefix, or t=x,y,z&n=...&w=...&s=... (deep-link parameters)
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const shots = process.argv.flatMap((a, i) => (a === '--shot' ? [process.argv[i + 1]] : []));
const URL0 = arg('url', 'http://localhost:8765/'), CELLS = arg('cells', 'cells.local.json'), GPU = arg('gpu', 'compat');
const OUT = arg('out', 'tests/out'), WAIT = Number(arg('wait', '120')) * 1000;
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;
const flags = ['--headless=new', '--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--enable-features=Vulkan', '--use-angle=vulkan'];
if (GPU === 'compat') flags.push('--use-webgpu-adapter=opengles');
const browser = await chromium.launch({ executablePath: exe, headless: true, args: flags });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const report = [];
for (const s of shots) {
  const [cell, view, file0] = s.split(':');
  const file = file0 || `${cell}_${view.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}.png`;
  const page = await ctx.newPage();
  const errs = []; page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
  const v = view.includes('=') ? '&' + view : `&view=${encodeURIComponent(view)}`;
  await page.goto(`${URL0}?cells=${encodeURIComponent(CELLS)}&offscreen=1${GPU === 'compat' ? '&gpu=compat' : ''}&cell=${cell}${v}`);
  const ok = await page.waitForFunction(() => window.yc && window.yc.ready, null, { timeout: 300000 }).then(() => true, () => false);
  const rec = { cell, view, file, ok, errors: errs };
  if (ok) {
    const t0 = Date.now();
    await page.waitForFunction(() => { const s = window.yc.state(); return s.pending === 0 && s.detailPending === 0 && !s.gpuBusy; }, null, { timeout: WAIT, polling: 1000 }).catch(() => null);
    await page.waitForTimeout(4000);
    await page.waitForFunction(() => { const s = window.yc.state(); return s.pending === 0 && s.detailPending === 0; }, null, { timeout: WAIT, polling: 1000 }).catch(() => null);
    await page.waitForTimeout(2000);
    rec.wait_s = (Date.now() - t0) / 1000;
    rec.state = await page.evaluate(() => { const s = window.yc.state(); return { pending: s.pending, loaded: s.loaded, totals: s.totals, stats: s.stats }; });
    rec.link = await page.evaluate(() => window.yc.viewLink());
    const u = await page.evaluate(() => window.yc.R.snapshot()).catch(() => null);
    if (u) writeFileSync(join(OUT, file), Buffer.from(u.split(',')[1], 'base64'));
    await page.screenshot({ path: join(OUT, file.replace('.png', '_ui.png')) });
  }
  report.push(rec); console.log(JSON.stringify(rec));
  await page.close();
}
await browser.close();
writeFileSync(join(OUT, 'mesh_screens_report.json'), JSON.stringify(report, null, 1));
