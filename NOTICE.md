# Notices and code origins

Copyright 2026 the authors (P. Beltrao lab, ETH Zurich, and G. Magnusson). Code licensed under the PolyForm
Noncommercial License 1.0.0 (LICENSE.md); commercial licences: Pedro Beltrao (pbeltrao@ethz.ch).

## Origins of the code

| Part | Origin | Notes |
|---|---|---|
| `app/src/*` (renderer, shaders, tiles, worker, camera, main UI, Mol* panel, markdown, dynamics overlay) | Jurkat viewer v7 (`jurkat/viewer/app`, P. Beltrao lab), itself a fork of the yeast viewer (G. Magnusson, `yeast_cell_viewer/web/app`) | made cell-agnostic; YCT2 reader; `// origin:` headers per file |
| `app/src/geometry.ts`, `geometryWGSL` in `app/src/shaders.ts` | `wholecell/geometry/engines/cellgeom_eval_v1.py` (pipeline), whose primitive kernels come from the yeast `cell3d.py` (G. Magnusson) and whose field / section kernels come from the Jurkat `cell3d.py` | TypeScript (float64) and WGSL (float32) ports; golden test `tools/golden_geometry.mjs` |
| yeast lipid compositions (`tools/cell_defaults/yeast.json`) | yeast viewer `lipids.ts` (Zinser et al. 1991) | data, used by the generic lipid code |
| yeast molecule classes, colours, captions (`tools/cell_defaults/yeast.json`) | yeast viewer `data.ts`, `bookmarks.json` | data |
| `tools/export_viewer_extras.py` | `jurkat/viewer/jenc.py`, `jenc_full.py` (library writer, meshes, bookmarks) | to be ported into `wholecell/export` (step `viewer_extras`) |
| `tools/serve.py` | `jurkat/viewer/serve.py` | `--mount` added |

G. Magnusson agreed to the joint repository (PLANNING_NOTES 2026-11-23).

## Third-party software

- Mol* (molstar, MIT licence): loaded at run time from the npm package copy (`app/public/molstar`, not committed) or
  the jsDelivr CDN.
- Build tools: TypeScript (Apache-2.0), Vite (MIT), esbuild (MIT), playwright-core (Apache-2.0, tests only).

## Data

Viewer data are not part of this repository. Their licence (CC BY-NC 4.0) and attribution (PDB, AlphaFold DB, CC BY 4.0;
OpenOrganelle jrc_jurkat-1, CC BY 4.0) are in each cell's `cell.json` and `attribution.md`. No Human Protein Atlas images
are included.
