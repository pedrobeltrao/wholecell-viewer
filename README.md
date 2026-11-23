# wholecell-viewer

One WebGPU viewer for the whole-cell molecular models of the yeast + human (Jurkat T cell) project, and for future
cells. The start screen lists the cells of a registry (`cells.json`). A cell opens at its default view, and you can
stream its ~10⁷–10⁹ macromolecules at residue resolution around a cut through the cell, inspect molecules and load their
atomic models in Mol*. The app holds no list of cells and no cell-specific facts. Regions, compartment labels,
membranes, colours, the geometry fields and procedural shapes, molecule classes, bookmarks, the model description
(MODEL.md) and licence/attribution are all read from each cell's exported data.

Status: staging repository (prepared locally, not published). Data deposit URLs in `app/public/cells.json` are
placeholders.

## Run locally

Requirements: Node ≥ 20, Python ≥ 3.9, a browser with WebGPU (current Chrome or Edge; Safari 26+; on Linux Chrome
enable `chrome://flags/#enable-unsafe-webgpu` and `#enable-vulkan`).

```sh
cd app
npm install
cp -r node_modules/molstar/build/viewer public/molstar      # local Mol* copy (optional; the CDN is the fallback)
npm run build                                              # type-check + vite build -> app/dist
cd ..
python tools/serve.py app/dist --port 8000 --mount data=/path/to/viewer_data
# open http://localhost:8000/                              (registry app/public/cells.json, deposit URLs)
# or   http://localhost:8000/?cells=cells.local.json      (local registry, see below)
```

`tools/serve.py` is a static server with HTTP Range (the viewer fetches each tile as a byte range of its block shard),
CORS, and `--mount PREFIX=DIR` so the multi-GB data folders need no copying. Any static host with Range support works.

URL parameters:

| URL | Behaviour |
|---|---|
| `/` | start screen: one card per registry entry |
| `?cell=<id>` | open that cell (its default bookmark); `&build=<build_id or alias>` picks an archived build |
| `?cell=<id>&data=<url>` | registry metadata, data from `<url>` (preview a build before registering it) |
| `?data=<url>` | no registry: `<url>/cell.json` is the entry |
| `?cells=<url>` | another registry (default `cells.json` next to the app) |
| `&view=<bookmark name or index>` | initial view; `&t=x,y,z&n=nx,ny,nz&u=ux,uy,uz&w=<nm>&s=<slab nm>` an explicit camera ("Copy view link" writes these) |
| `&detail=low\|medium\|high` | molecule budget on the GPU |

"Switch cell" returns to the start screen; it reloads the page, so the GPU memory of the previous cell is released.

## Add a cell

1. Build the cell with the pipeline (`wholecell`): the `export` stage writes `export/cell.json`, `export/regions.json`
   and the YCT2 tiles `export/web/` (docs/reference/tile_format_v2.md, viewer_multi_cell.md).
2. Write the viewer extras (until this step is ported into `wholecell/export`, it lives here):

   ```sh
   # input paths in tools/cell_defaults/<cell>.json use {data_root} / {yeast_root}: set WHOLECELL_DATA_ROOT / WHOLECELL_YEAST_ROOT
   python tools/export_viewer_extras.py --build <build dir> --out <viewer_data>/<cell id>/<build id> \
          --defaults tools/cell_defaults/<cell id>.json
   python tools/check_viewer_data.py <viewer_data>/<cell id>/<build id>
   node tools/golden_geometry.mjs <viewer_data>/<cell id>/<build id>      # needs: cd tests && npm install
   ```

   Per-cell display facts (label and membrane display names and colours, molecule classes, lipid compositions,
   bookmark specs and captions, MODEL.md source, attribution) are in `tools/cell_defaults/<cell id>.json`. They move
   to the cell config (`export.*`) when the step is ported. A new cell needs a new defaults file, not app code.
3. Register it: `python tools/make_cells_json.py app/public/cells.json <data dir> [...] --data-base <template>`.
   This merges the cells' `cell.json` entries; never edit `cells.json` by hand.

A cell whose geometry needs a new primitive or membrane kind needs that kind added once to the evaluator
(`app/src/geometry.ts` + `geometryWGSL` in `app/src/shaders.ts`, mirrored from `wholecell/geometry/engines/cellgeom_eval_v1.py`).
After that, any cell may use it.

## Viewer data folder (one per cell and build; immutable)

| File | Written by | Content |
|---|---|---|
| `cell.json` | export `cell_entry` (+ extras: licence) | registry entry (`wholecell.cells/1`) |
| `regions.json` | export `regions` (+ extras: display names, colours) | placement regions: id, name, kind, display_as, colour, group |
| `tiles/index.json`, `tiles/s_*.bin` | export `tiles_v2` | YCT2 stream tiles (palette + instances), gzip members per block shard |
| `library/types.json`, `beads.bin`, `spheretree.bin` | extras `library` | species (same `ids` order and `lib_tag` as the tiles), residue beads, sphere trees |
| `types_tiles.bin` | extras `types_tiles` | per species up to 256 tiles holding it (fly to nearest copy) |
| `geometry.json`, `geometry_G.bin` | extras `geometry` | the cell geometry as one `cellgeom_eval_v1` vector G (fields resampled for the viewer, sections, compiled membrane table and label rule) + pores, prims, membrane and label tables with display data, evaluator constants |
| `geometry_golden.json` | extras `geometry` | reference labels / membrane SDFs of the pipeline kernels on G (test only) |
| `organelle_meshes.bin.gz` | extras `meshes` | whole-cell membrane surfaces (organelle and membranes views) |
| `bookmarks.json` | extras `bookmarks` | guided views |
| `features.json` | extras `features` | per-cell feature switches (open face, cell wall, ...), molecule classes and colours, lipid compositions, absent files |
| `MODEL.md`, `attribution.md`, `thumb.png` | extras `docs`, `thumb` | model description (About → Model details), attribution, start-screen thumbnail |

The compartment geometry is evaluated by one table-driven evaluator for every cell. In TypeScript it is used for the
section map and picking; in WGSL for the cut-face fill. Both are ports of the pipeline's `cellgeom_eval_v1` kernels.
`tools/golden_geometry.mjs` checks the TypeScript evaluator against the pipeline kernels on 20,000 points per cell.

## Data hosting

Tiles are ~13 GB (Jurkat) and ~0.4 GB (yeast) per build and are never committed. Each build is deposited as one
immutable folder `<cell id>/<build id>/` (Hugging Face dataset or Zenodo), and the registry's `data_base` points to it.
The host must allow CORS and HTTP Range requests (Hugging Face `resolve/` URLs do). The app is a static site (GitHub
Pages or any static host). Until the deposit exists, `app/public/cells.json` carries placeholder URLs
(`DEPOSIT-ORG/DEPOSIT-REPO`), and local testing uses `cells.local.json` (written by `make_cells_json.py`, not committed).

## Tests

- `npm run typecheck` / `npm run build` (in `app/`).
- `node tools/golden_geometry.mjs <data dir>...`: TypeScript geometry evaluator against the pipeline (labels must be
  identical).
- `python tools/check_viewer_data.py <data dir>`: data contract of a viewer data folder.
- `node tests/viewer_check.mjs --url http://localhost:8000/ --cells cells.local.json [--gpu swiftshader|compat]`
  (after `cd tests && npm install`): headless Chrome opens the start screen and every cell, compiles the WGSL, streams
  tiles, and saves screenshots and a report to `tests/out/`.

## Licence

Code: PolyForm Noncommercial License 1.0.0 (`LICENSE.md`).
Required Notice: Commercial use of this software requires a separate agreement with the Beltrao lab and ETH Zurich (see COMMERCIAL.md).
Commercial use needs a separate agreement with the Beltrao lab and ETH Zurich: contact Pedro Beltrao (pbeltrao@ethz.ch).

Viewer data and other generated content (tiles, libraries, geometry exports, bookmarks, documents): CC BY-NC 4.0, as
stated in each cell's `cell.json` and `attribution.md`. The structures come from the PDB and AlphaFold DB (CC BY 4.0);
the Jurkat cell geometry comes from OpenOrganelle jrc_jurkat-1 (CC BY 4.0). No Human Protein Atlas images are included
in this repository or in the viewer data.

Third-party code: Mol* (MIT) is loaded at run time, from a local copy of the npm package or from the jsDelivr CDN.
Ported code carries `origin:` headers naming its source: the Jurkat viewer (jurkat/viewer/app), the yeast viewer
(G. Magnusson, yeast_cell_viewer) and the pipeline's geometry evaluator (wholecell). See NOTICE.md.
