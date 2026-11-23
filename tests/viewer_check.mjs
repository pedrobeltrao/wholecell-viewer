// Headless end-to-end check of the viewer with a local Chrome (playwright-core): start screen from the registry, every
// cell opened by deep link (data loading, WGSL compilation, tile streaming), bookmark screenshots, switch-cell link.
//
// usage: node tests/viewer_check.mjs --url http://localhost:8765/ --cells cells.local.json [--gpu swiftshader|compat]
//        [--out DIR] [--views 3] [--wait 90]
// Chrome: CHROME=<path> (default: the playwright cache chromium); on hosts without its system libraries set
// LD_LIBRARY_PATH (e.g. a conda env with glib, nss, atk, ...). --gpu compat uses the real GPU through Chrome's
// OpenGL ES (ANGLE) WebGPU backend in compatibility mode (the only hardware path in headless Chrome without a display).
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const URL0 = arg('url', 'http://localhost:8765/'), CELLS = arg('cells', 'cells.local.json'), GPU = arg('gpu', 'swiftshader');
const OUT = arg('out', 'tests/out'), NVIEWS = Number(arg('views', '3')), WAIT = Number(arg('wait', '90')) * 1000;
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;
const flags = ['--headless=new', '--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--enable-features=Vulkan', '--use-angle=vulkan'];
if (GPU === 'compat') flags.push('--use-webgpu-adapter=opengles');
const browser = await chromium.launch({ executablePath: exe, headless: true, args: flags });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const report = { url: URL0, registry: CELLS, gpu: GPU, start: null, cells: [] };
// offscreen=1: the app composites into a texture (headless Chrome cannot present WebGPU canvases here); yc.R.snapshot() reads it
const q = (extra) => `${URL0}?cells=${encodeURIComponent(CELLS)}&offscreen=1${GPU === 'compat' ? '&gpu=compat' : ''}${extra}`;
const snap = async (page, file) => { const u = await page.evaluate(() => window.yc.R.snapshot()).catch(e => null); if (u) writeFileSync(join(OUT, file), Buffer.from(u.split(',')[1], 'base64')); return !!u; };

// ---- start screen
{
  const page = await ctx.newPage();
  const errs = []; page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
  await page.goto(q(''));
  await page.waitForSelector('#start .card, #start .err', { timeout: 30000 });
  const cards = await page.$$eval('#start .card', cs => cs.map(c => ({ cell: c.dataset.cell, title: c.querySelector('h2')?.textContent, href: c.getAttribute('href'), img: !!c.querySelector('img') })));
  await page.screenshot({ path: join(OUT, 'start.png') });
  report.start = { cards, errors: errs };
  await page.close();
}

// ---- each cell
for (const card of report.start.cards) {
  const id = card.cell, page = await ctx.newPage();
  const errs = [], warns = [];
  page.on('console', m => { const t = m.text(); if (m.type() === 'error') errs.push(t); else if (m.type() === 'warning' && /WGSL|wgsl|\[/.test(t)) warns.push(t); });
  page.on('pageerror', e => errs.push(String(e)));
  const t0 = Date.now();
  await page.goto(q(`&cell=${encodeURIComponent(id)}`));
  const ok = await page.waitForFunction(() => (window.yc && window.yc.ready) || getComputedStyle(document.querySelector('#loading .err')).display === 'block', null, { timeout: 240000 }).then(() => true, () => false);
  const fail = await page.$eval('#loading .err', e => (getComputedStyle(e).display === 'block' ? e.textContent : null));
  const rec = { cell: id, ok: ok && !fail, error: fail, boot_s: (Date.now() - t0) / 1000, views: [], errors: errs, wgsl_warnings: warns };
  if (rec.ok) {
    rec.info = await page.evaluate(() => {
      const y = window.yc;
      return { adapter: y.R.adapterInfo, detail: y.R.detailUsed, types: y.lib.types.length, tiles: y.idx.n, regions: y.regions.length, membranes: y.geo.membranes.length,
        labels: y.geo.labels.length, bookmarks: y.bookmarks.map(b => b.name), classes: y.feat.classes.map(c => c.name), G: y.ev.G.length, domainMem: y.ev.domainMem,
        title: document.getElementById('cellTitle').textContent, showList: [...document.querySelectorAll('#showList .nm')].map(e => e.textContent) };
    });
    const nv = Math.min(NVIEWS, rec.info.bookmarks.length);
    for (let v = 0; v < nv; v++) {
      await page.evaluate((i) => window.yc.applyBookmark(i, false), v);
      const t1 = Date.now();
      await page.waitForFunction(() => { const s = window.yc.state(); return s.pending === 0 && !s.gpuBusy; }, null, { timeout: WAIT, polling: 1000 }).catch(() => null);
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => { const s = window.yc.state(); return { pending: s.pending, loaded: s.loaded, inst: s.totals.inst, drawn: s.stats, gpuMs: s.gpuMs }; });
      const name = rec.info.bookmarks[v];
      const file = `${id}_${v}_${name.replace(/[^A-Za-z0-9]+/g, '_')}.png`;
      await page.screenshot({ path: join(OUT, file) });
      const s3 = await snap(page, file.replace('.png', '_3d.png'));
      rec.views.push({ name, file, snapshot: s3, wait_s: (Date.now() - t1) / 1000, ...st });
    }
    // organelle surfaces view
    await page.evaluate(() => { document.getElementById('modeOrg').click(); window.yc.applyBookmark(0, false); document.getElementById('modeOrg').click(); });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: join(OUT, `${id}_organelles.png`) });
    rec.organelles_snapshot = await snap(page, `${id}_organelles_3d.png`);
    await page.evaluate(() => document.getElementById('modeSection').click());
    rec.device_lost = await page.evaluate(() => Promise.race([window.yc.R.device.lost.then(i => i.message), new Promise(r => setTimeout(() => r(null), 100))]));
    // a pick in the middle of the view
    rec.pick = await page.evaluate(async () => { const c = document.getElementById('gpu'); const r = await window.yc.pickAt(c.clientWidth / 2, c.clientHeight / 2); const d = window.yc.describe(r.id); return { id: r.id, kind: d.kind, title: d.title, sub: d.sub }; });
    // switch cell: back to the start screen
    await page.click('#switchCell');
    await page.waitForSelector('#start .card', { timeout: 30000 }).catch(() => null);
    rec.switch_back_ok = (await page.$$('#start .card')).length === report.start.cards.length;
  } else {
    await page.screenshot({ path: join(OUT, `${id}_error.png`) });
  }
  report.cells.push(rec);
  await page.close();
}
// ---- deep link to a named view of the last cell
if (report.start.cards.length) {
  const c = report.start.cards[report.start.cards.length - 1].cell;
  const page = await ctx.newPage();
  await page.goto(q(`&cell=${c}&view=1`));
  const ok = await page.waitForFunction(() => window.yc && window.yc.ready, null, { timeout: 240000 }).then(() => true, () => false);
  report.deep_link = { cell: c, ok, caption: ok ? await page.$eval('#caption', e => e.textContent) : null };
  await page.close();
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
