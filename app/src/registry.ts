// Cell registry (cells.json, schema wholecell.cells/1; docs viewer_multi_cell.md §2-3): start screen, deep links.
//
//   /                          start screen: one card per registered cell
//   ?cell=<id>                 open that cell (latest build, or &build=<build_id> / alias)
//   ?cell=<id>&data=<url>      registry metadata, data from <url> (preview a build before registering it)
//   ?data=<url>                no registry: <url>/cell.json is the entry
//   ?cells=<url>               another registry (default: cells.json next to the app)
//   &view=<bookmark name|index>, &t=x,y,z&n=nx,ny,nz&w=width[&s=slab]   initial view
// The app holds no list of cells: everything shown here comes from the registry entries.

export interface CellEntry {
  id: string; name: string; organism: { name: string; taxon?: number; strain?: string }; cell_type: string; state: string;
  data_base: string; build: { build_id: string; stamp?: string; stamp_sha256?: string; aliases?: string[] };
  files?: Record<string, string>; thumbnail?: string; stats?: { instances?: number; species?: number; volume_um3?: number };
  licence?: { data?: string; attribution?: string; code?: string }; status?: string; default_bookmark?: string; model_doc?: string;
  sim_defaults?: Record<string, number>; description?: string;
}
export interface Registry { schema: string; cells: CellEntry[]; title?: string; note?: string }

export const DEFAULT_FILES: Record<string, string> = {
  index: 'tiles/index.json', regions: 'regions.json', geometry: 'geometry.json', fields: 'geometry_G.bin',
  meshes: 'organelle_meshes.bin.gz', bookmarks: 'bookmarks.json', model_doc: 'MODEL.md', features: 'features.json',
  library: 'library/types.json', types_tiles: 'types_tiles.bin', attribution: 'attribution.md',
};

const params = () => new URLSearchParams(location.search);
const slash = (u: string) => (u.endsWith('/') ? u : u + '/');
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function registryUrl(): string {
  const q = params().get('cells');
  return new URL(q || 'cells.json', document.baseURI).href;
}

export async function loadRegistry(url = registryUrl()): Promise<Registry> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for the cell registry ${url}`);
  const j = await r.json();
  if (j.schema !== 'wholecell.cells/1' || !Array.isArray(j.cells)) throw new Error(`${url} is not a wholecell.cells/1 registry`);
  for (const c of j.cells) if (!c.id || !c.data_base) throw new Error(`registry entry without id / data_base in ${url}`);
  // data_base is relative to the registry file
  for (const c of j.cells) c.data_base = slash(new URL(c.data_base, url).href);
  return j;
}

/** one cell.json (export/cell.json: {schema, entry}) as a registry entry with data_base = its folder */
async function entryFromData(dataUrl: string): Promise<CellEntry> {
  const base = slash(new URL(dataUrl, document.baseURI).href);
  const r = await fetch(base + 'cell.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${base}cell.json (?data= needs a viewer data folder with cell.json)`);
  const j = await r.json();
  const e: CellEntry = j.entry ?? j;
  e.data_base = base;
  return e;
}

export interface Opened { entry: CellEntry; base: string; files: Record<string, string>; registry: Registry | null }

/** the cell the URL asks for, or null (start screen). Throws with a readable message on a bad link. */
export async function resolveCell(): Promise<{ opened: Opened | null; registry: Registry | null }> {
  const p = params();
  const cellId = p.get('cell'), data = p.get('data'), build = p.get('build');
  let registry: Registry | null = null;
  if (!data || cellId) {
    try { registry = await loadRegistry(); } catch (e) { if (!data) throw e; }
  }
  if (!cellId && !data) return { opened: null, registry };
  let entry: CellEntry | undefined;
  if (cellId && registry) {
    const all = registry.cells.filter(c => c.id === cellId);
    if (!all.length && !data) throw new Error(`No cell "${esc(cellId)}" in the registry (${registry.cells.map(c => esc(c.id)).join(', ')}).`);
    entry = build ? all.find(c => c.build.build_id === build || (c.build.aliases ?? []).includes(build)) : (all.find(c => c.status !== 'archived') ?? all[0]);
    if (all.length && !entry) throw new Error(`Cell "${esc(cellId)}" has no build "${esc(build)}" in the registry.`);
  }
  if (data) {
    const d = await entryFromData(data);
    entry = entry ? { ...entry, data_base: d.data_base, build: d.build ?? entry.build } : d;
  }
  if (!entry) throw new Error('No cell selected.');
  return { opened: { entry, base: slash(entry.data_base), files: { ...DEFAULT_FILES, ...(entry.files ?? {}) }, registry }, registry };
}

const fmtN = (n?: number) => (n === undefined ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} k` : String(n));

/** link that opens a cell (keeps ?cells= so a custom registry survives the round trip) */
export function cellLink(id: string, build?: string): string {
  const u = new URL(location.href);
  const keep = u.searchParams.get('cells');
  u.search = '';
  if (keep) u.searchParams.set('cells', keep);
  u.searchParams.set('cell', id);
  if (build) u.searchParams.set('build', build);
  return u.href;
}
export function startLink(): string {
  const u = new URL(location.href);
  const keep = u.searchParams.get('cells');
  u.search = '';
  if (keep) u.searchParams.set('cells', keep);
  return u.href;
}

/** the start screen: cards built from the registry entries */
export function renderStart(reg: Registry | null, err?: string) {
  const host = document.getElementById('start')!;
  document.getElementById('loading')!.style.display = 'none';
  host.style.display = 'flex';
  document.title = reg?.title ?? 'Whole-cell models';
  const cards = (reg?.cells ?? []).filter(c => c.status !== 'hidden').map(c => {
    const thumb = c.thumbnail ? `<img src="${esc(c.data_base + c.thumbnail)}" alt="" onerror="this.style.display='none'">` : '';
    const st = c.stats ?? {};
    const lic = c.licence?.data ? `<span class="lic">data ${esc(c.licence.data)}</span>` : '';
    const status = c.status && c.status !== 'published' ? `<span class="status">${esc(c.status)}</span>` : '';
    return `<a class="card" href="${esc(cellLink(c.id, c.build.build_id))}" data-cell="${esc(c.id)}">
      <div class="thumb">${thumb}</div>
      <div class="body"><h2>${esc(c.name)}</h2>
        <div class="org"><i>${esc(c.organism?.name)}</i>${c.organism?.strain ? ` ${esc(c.organism.strain)}` : ''} · ${esc(c.cell_type)}</div>
        <div class="state">${esc(c.state)}</div>
        <div class="stats">${st.instances ? `${fmtN(st.instances)} macromolecules` : ''}${st.species ? ` · ${st.species.toLocaleString('en-US')} species` : ''}${st.volume_um3 ? ` · ${st.volume_um3} µm³` : ''}</div>
        <div class="meta">build ${esc(c.build.build_id)}${(c.build.aliases ?? []).length ? ` (${esc(c.build.aliases!.join(', '))})` : ''} ${status} ${lic}</div>
      </div></a>`;
  }).join('');
  host.innerHTML = `<div class="inner">
    <h1>${esc(reg?.title ?? 'Whole-cell models')}</h1>
    <div class="lead">Choose a cell. Every macromolecule is drawn from its PDB or AlphaFold structure; the view streams the molecules around a cut through the cell.</div>
    ${err ? `<div class="err">${err}</div>` : ''}
    <div class="cards">${cards || (err ? '' : '<div class="err">The registry lists no cells.</div>')}</div>
    ${reg?.note ? `<div class="note">${esc(reg.note)}</div>` : ''}
    <div class="note">Needs a browser with WebGPU (current Chrome or Edge; Safari 26+). Deep link: <code>?cell=&lt;id&gt;</code>, <code>&amp;view=&lt;bookmark&gt;</code>.</div>
  </div>`;
}
