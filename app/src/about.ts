// About panel, built from the open cell's registry entry, features.json and regions.json (no per-cell text in the app;
// the cell's own description is its MODEL.md, shown under "Model details").
import type { CellEntry } from './registry';
import type { Features, Region } from './data';

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n?: number) => (n === undefined ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} million` : n.toLocaleString('en-US'));

export function aboutHtml(e: CellEntry, feat: Features, regions: Region[], extra: { nTypes: number; nInst: number; hasLipids: boolean; resample?: any }) {
  const st = e.stats ?? {};
  const faceOn = !!feat.features?.open_face;
  const lic = e.licence ?? {};
  return `
<h2>About this model</h2>
<p><b>${esc(e.name)}</b> (<i>${esc(e.organism?.name)}</i>${e.organism?.strain ? ` ${esc(e.organism.strain)}` : ''}; ${esc(e.cell_type)}; ${esc(e.state)}):
a molecular model of the whole cell with ${fmt(st.instances ?? extra.nInst)} macromolecules of ${(st.species ?? extra.nTypes).toLocaleString('en-US')} species${st.volume_um3 ? ` in ${st.volume_um3} µm³` : ''},
streamed at residue resolution around the part you look at.</p>
<p>Every macromolecule is drawn from its experimental (PDB) or predicted (AlphaFold DB) coordinates, at one bead per
amino-acid residue or nucleotide when it is large enough on screen; further away, molecules switch to a sphere-tree
stand-in and then to one sphere each. Click a molecule to inspect it and to load its full-atom model in Mol*.</p>
<h3>Colours and controls</h3>
<ul>
<li>Cut faces are coloured by compartment (the cell's geometry: ${esc(regions.length)} placement regions, compartments evaluated
exactly from the cell's distance fields and rule table), with membranes as light bands.</li>
${faceOn ? `<li><b>Flat face = edge of the imaged volume.</b> The EM data end there and truncate the cell; the face has no membrane
and is drawn in flat grey (a grey line on cut faces).</li>` : ''}
<li>Molecules are coloured by the compartment they were placed in; named assemblies (${esc(feat.classes.map(c => c.name.toLowerCase()).join(', ') || 'none')})
have their own colours and Show switches; Colour by: Compartment lists every region.</li>
${extra.hasLipids ? '<li>Lipids are generated in the browser near the camera on each membrane, with the composition given by the cell data.</li>'
    : '<li>Membranes are drawn as surfaces and cut-face bands (this export has no per-tile membrane meshes, so no procedural lipids).</li>'}
</ul>
<h3>Build and licence</h3>
<div class="kvs">
<div>Build</div><div><code>${esc(e.build?.build_id)}</code>${(e.build?.aliases ?? []).length ? ` (alias ${esc(e.build.aliases!.join(', '))})` : ''}</div>
${e.build?.stamp_sha256 ? `<div>Build stamp</div><div><code>${esc(e.build.stamp_sha256.slice(0, 16))}…</code></div>` : ''}
<div>Data licence</div><div>${esc(lic.data ?? 'not stated')}${lic.attribution ? ` · <a href="#" id="aboutAttribution" style="color:#8fc3ff">attribution</a>` : ''}</div>
<div>Status</div><div>${esc(e.status ?? 'published')}</div>
${extra.resample ? `<div>Geometry</div><div>viewer fields resampled; compartment labels agree with the build geometry at ${(100 * (extra.resample.agreement ?? 0)).toFixed(2)}% of ${fmt(extra.resample.n)} test points</div>` : ''}
</div>
<p>More detail is under <a href="#" id="aboutToModel" style="color:#8fc3ff">Model details</a>. <a href="#" id="aboutSwitch" style="color:#8fc3ff">Switch cell</a>.</p>
`;
}
