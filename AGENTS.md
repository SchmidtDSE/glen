# Project Context & Instructions

## Overview
Library for map-based applications with LLM-powered data analysis: glen core, an interactive MapLibre GL JS map with an agent that controls it, and plugins that add SQL queries, charts, drawing, uploads and hex layers. Individual apps (different datasets, branding, deployments) load it from the CDN and provide their own configuration.

## Key Technologies
- **Frontend**: MapLibre GL JS, PMTiles (vectors), COG + TiTiler (rasters), ES modules
- **Data**: Portolan or STAC collections → map layers, with the data's Parquet assets for SQL
- **Analytics** (MCP plugin): SQL queries via MCP (Model Context Protocol) to DuckDB on H3-indexed parquet, on a server or in the browser
- **LLM**: OpenAI-compatible Chat Completions API (multiple models via proxy)
- **Deployment**: App JS/CSS is loaded from jsDelivr CDN. **Every downstream app pins a version tag or commit SHA** — `@main` is no longer used in production or demos. Downstream apps only need a static HTML file — see the [glen-template](https://github.com/SchmidtDSE/glen-template) repo.

## Architecture

Since v4, glen is **glen core** (`core/`) and its plugins (`core/plugins/`), built on a library of shared modules in `app/`. The agent loop, tool registry, chat and session export come from [glen-harness](https://github.com/SchmidtDSE/glen-harness), which `core/main.js` loads from jsDelivr at a release tag. The v3 full app (`app/main.js`, `app/index.html` and 15 modules of its own) was deleted at v4 (SchmidtDSE/glen#441); v3 apps keep loading it from their v3 tags, and `release-v3.x` takes v3 fixes. See `docs/design/v4-layout.md` and `core/README.md`.

### glen core (core/)

A map of the layers in [Portolan](https://www.portolan-sdi.org/) or STAC collections, and an agent whose tools act on the map. It assumes no MCP server or SQL engine; those come from plugins.

- `core/main.js` — Bootstrap: config → catalog + map → map tools → plugins → agent → chat
- `core/portolan.js` — Pure rules for reading a Portolan collection (PMTiles links, style assets, COG band statistics)
- `core/portolan-catalog.js` — Fetches collections, styles and PMTiles metadata; builds MapManager layer configs and the layer list in the prompt
- `core/map-tools.js` — The core's map tools: the shared map-control tools plus `apply_style` (published styles), `set_raster_colormap` and `describe_layer`
- `core/prompt.js` / `core/system-prompt.md` — The prompt's opening: core's short base prompt, then the app's own (`system_prompt_url`, or a `system-prompt.md` beside the page)
- `core/convert-config.js` / `scripts/convert-to-core.mjs` — Converts a v3 app's `layers-input.json` and `index.html` to glen core
- `core/plugins/mcp.js` — MCP servers' tools (over HTTP or in a Web Worker), the local catalog tools and `filter_by_query`
- `core/plugins/charts.js`, `draw.js`, `uploads.js`, `hex.js`, `geolocate.js` — `render_chart`; the draw button and `get_drawn_region`; GeoJSON upload and `get_uploaded_dataset`; hex tile layers; the locate-me button and `get_user_location`

**Prompts stay minimal.** A prompt says what the app and its data are. What a tool does, when to call it and what it returns belong in the tool's own description, never repeated in a prompt, where they go stale. Don't list what the agent cannot do; a plugin that adds a capability should not have to contradict the base prompt.

### Shared modules (app/)

`app/` is glen core's library: map, layout, layer tools and catalog code, plus the stylesheets apps load from the CDN (`style.css`, `chat.css`, `sidebar.css`). `app/` never imports from `core/` (`test/app-imports.test.js`), and every `app/` module must be reached from core or a plugin (`test/core-module-graph.test.js`).

- `map-manager.js` — Creates the MapLibre map, manages layers, filters, styles, legend and tooltips
- `map-control-tools.js` — The agent tools that act only on the map; glen core adds its own beside them
- `catalog-tree.js` — Finds collections by id at any depth, through Catalogs and Collections, so both our current STAC and the Portolan layout resolve (#441)
- `published-styles.js` — A collection's published MapLibre styles: finding them, matching each to its PMTiles file, turning one into the layer glen draws, describing its colours. `core/portolan.js` re-exports them.
- `cog-tiles.js` — How a COG is drawn: band settings (`bidx`, nodata, classes, `unscale` for scaled bands) and the TiTiler tile URL
- `catalog-tools.js` / `stac-details.js` — `get_schema` and `get_stac_details`, answered in the browser from the loaded STAC (registered by `plugins/mcp.js`). Ported from geo-query's `stac.py`, but now the reference: STAC handling is moving out of geo-query and geo-query-wasm into these local tools, so they gain features (such as a collection's STAC items, #462) that `stac.py` does not have. The MCP server's catalog tools are never registered (#441).
- `raster-frames.js` / `frame-player.js` — Raster time series (#421): find a series' dated COGs (STAC frame-list asset, bucket listing or items) and play them, preloading the next frames
- `hex-tools.js`, `query-filter-tool.js`, `chart-tool.js`, `draw-tools.js`, `upload-tools.js` — The tools behind the plugins
- `overlay-rail.js` — Shared bottom-left rail every map-scoped overlay panel mounts into (legend, sliders, H3 resolution badge). New floating panels go here, not onto `document.body` with their own anchors.
- `app-header.js` — Optional app chrome band (logos, top-level nav) in `scrim` or `solid` mode. App-level UI goes here; map-scoped controls go in the overlay rail.
- `layout-manager.js` / `mobile-sheet.js` — The floating or sidebar layout; below 700px the sidebar becomes a bottom sheet with peek/half/full detents. No gesture is bound to the map.
- `h3-grid.js` — The "Hex grid" button and the H3 grid it draws, with h3-js loaded on first use
- `icons.js` — The few inline SVGs shared by the header nav and the chat footer links.
- `theme.js` — Selects the chrome colour scheme (light/dark/auto) as a body class and applies per-app colour overrides inline; the tokens themselves live in `style.css`.
- `dataset-citations.js` — How a dataset is cited, from its STAC record. Used by the data page and the local catalog tools.
- `data-page.js` — The data sources page (#433): every dataset the app loads with its citation, a `<dialog>` opened on the `#data` fragment and linked by default from the header nav and chat footer.

Changes to the shared modules reach every app, so check `/core/` and the preview fixture when they touch layer registration, styling or the layout.

## Design decisions

Settled architectural calls are recorded in `docs/design/` so they aren't re-litigated. Read the relevant note before reopening one of these questions.

- [`docs/design/tool-call-parsing.md`](docs/design/tool-call-parsing.md) — why tool-call dialect recovery (`parseEmbeddedToolCalls` / `looksLikeAttemptedToolCall`, now in glen-harness's `src/agent.js`) lives in the harness and is kept, not moved to the server/proxy or replaced by a library.
- [`docs/design/data-scope.md`](docs/design/data-scope.md) — why which-data-exists is a deployment property rather than a model-supplied tool argument, why the prompt's `discovery` flag is read off the tool registry instead of app config, and why the `query` escape hatch was deliberately left open.
- [`docs/design/prompt-prefix-stability.md`](docs/design/prompt-prefix-stability.md) — why dynamic content stays out of the leading bytes of the request, so prompt-prefix caching keeps paying off.
- [`docs/design/v4-layout.md`](docs/design/v4-layout.md) — why glen core's shared modules stay in `app/`, and why v4 deletes the full app's own modules instead of moving the shared ones.

## Configuration
- `layers-input.json` — An app's static config: catalog, collections, plugins, map view. `core/layers-input.json` is glen core's example; `preview/layers-input.json` is the preview fixture.
- `config.json` — Generated at deploy time by k8s (LLM models + API keys from secrets)
- Both are merged by `core/main.js` at startup; runtime config overrides static config
- **Full configuration reference:** `docs/guide/configuration.md` (the VitePress site is the canonical user docs)

### Asset formats in `layers-input.json`

Each collection's `assets` array supports three formats:

**1. Simple string** — include a STAC asset by ID, using defaults:
```json
"assets": ["cpad-holdings-pmtiles"]
```

**2. Object** — override display name, style, filters, etc.:
```json
"assets": [
  {
    "id": "irrecoverable-total-2018-cog",
    "display_name": "Irrecoverable Carbon (2018)"
  }
]
```

**3. Versioned** — multiple STAC assets behind one logical layer, selectable via dropdown:
```json
"assets": [
  {
    "id": "watersheds",
    "display_name": "Watersheds",
    "versions": [
      { "label": "L3 – Major Basins",   "asset_id": "hydrobasins_level_03" },
      { "label": "L4",                   "asset_id": "hydrobasins_level_04" },
      { "label": "L5",                   "asset_id": "hydrobasins_level_05" },
      { "label": "L6 – Sub-catchments",  "asset_id": "hydrobasins_level_06" }
    ],
    "default_version": "L6 – Sub-catchments"
  }
]
```

When `versions` is present, the layer panel shows one checkbox + a `<select>` dropdown. Switching versions swaps the visible map asset without adding/removing layer entries. The `default_version` matches by label (falls back to first entry if not found). All per-asset config options (`default_style`, `default_filter`, `colormap`, etc.) apply to every version uniformly.

Works for both PMTiles (vector) and COG (raster) assets. All versions must share the same layer type.

## Git workflow — branch protection

The `main` branch is protected: **direct pushes are rejected**. All changes must go through a pull request.

**Committing and pushing changes:**
1. Make changes, then commit:
   ```bash
   git add <files>
   git commit -m "<message>"
   ```
2. Create a feature branch and push:
   ```bash
   git checkout -b <branch-name>
   git push -u origin <branch-name>
   ```
3. The push output includes a PR URL — open it to create the pull request:
   ```
   remote: Create a pull request ... by visiting:
   remote:   https://github.com/SchmidtDSE/glen/pull/new/<branch-name>
   ```
4. After the PR is merged, **always clean up**:
   ```bash
   git checkout main
   git pull
   git branch -d <branch-name>
   ```

> If the user confirms the PR has been merged and asks to "clean up" or "switch back to main", run all three cleanup commands together.

## Deployment

Downstream apps pin a specific jsDelivr ref — either a release tag (`@vX.Y.Z`, preferred) or a commit SHA. `@main` is **not** used by any deployed app; merging a PR here does *not* propagate to downstream apps until those apps bump their pin. Coordinating that bump across the fleet is the job of the private [geo-agent-ops](https://github.com/boettiger-lab/geo-agent-ops) repo.

**Release flow:**
1. Merge feature PRs to `main` here.
2. Cut a release with `gh release create vX.Y.Z --target main --generate-notes` (or edit notes for migration-relevant changes).
3. geo-agent-ops opens PRs against each downstream app to bump its pin.

Because every consumer is pinned, `jsdelivr.net` cache purges are normally unnecessary; the only situation that needs them is a SHA-pinned demo where a force-push rewrote the SHA's content (don't do this).

**Live deployments:**
- [SchmidtDSE/glen-template](https://github.com/SchmidtDSE/glen-template) → canonical starting point for new apps; deployed to GitHub Pages as live demo (pinned to a tag).

Downstream apps serve a static HTML file that loads the pinned app code from jsDelivr at runtime. Two cases are easy to conflate:

- **The library ships a new version here.** Pinned downstream apps are unaffected and need no action — that's the whole point of pinning. Nothing to roll out.
- **A downstream app bumps its own pin.** This *edits the app's `index.html`*, so the new file must be re-served. How depends on the deployment:
  - **GitHub Pages** (e.g. the glen-template demo) — auto-rebuilds on push; nothing further needed.
  - **k8s pods that `git clone` at pod start** (initContainer, e.g. the `padus` deployment of glen-template) — the running pod keeps serving the `index.html` it cloned at startup, so you **must** `kubectl -n biodiversity rollout restart deployment/<name>` for the initContainer to re-clone the new pin. No `kubectl apply` is needed when `index.html` comes from the clone rather than a ConfigMap.
  - **k8s pods serving content from a ConfigMap** (private configmap-based apps) — regenerate and `kubectl apply` the ConfigMap, *then* rollout restart.

## Development
- Local: `python -m http.server 8000` from the repository root, then open `http://localhost:8000/core/`
- Create a local `core/config.json` with LLM model configs for development
- `config.json` is in `.gitignore` — never committed (contains API keys)

### Development dependencies (pnpm)

Node packages are for development only — tests, the docs site, and rebuilding
the vendored bundle. None is served to users. They are installed with pnpm
(version pinned in `package.json`'s `packageManager`; `corepack pnpm install`
fetches it), never npm, because of the supply-chain settings in
`pnpm-workspace.yaml`:

- no dependency runs an install script (`allowBuilds`; a new dependency that
  wants one fails the install until someone decides);
- a version must be a week old before it can be installed (`minimumReleaseAge`);
- a release with weaker provenance than earlier ones is refused (`trustPolicy`).

Don't loosen these to get past an install error; say why in the PR if one has
to change. CI installs with `--frozen-lockfile`.

### Vendored dependencies

glen core imports glen-harness from `cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@<tag>` in `core/main.js`; there is no copy here. Change glen-harness, tag a release, and bump its two URLs in `core/main.js` and `HARNESS_MCP_CLIENT` in `core/plugins/mcp.js` together (a test checks that they agree).

`app/vendor/hyparquet.js` is a **committed build artifact**, pre-bundled with
esbuild so apps have no runtime dependency on a third-party ESM host (#343).
Rebuild with `pnpm run build:vendor`; CI fails if the committed file doesn't
match a fresh build. Never hand-edit it, and see `app/vendor/README.md` before
bumping its version. Every other third-party library stays in the app's
`index.html` as an SRI-hashed `<script>` tag — that split is deliberate, see
#344.

## Testing

- `pnpm test` runs the suite; `pnpm run test:coverage` prints a per-module coverage table.
- Tests live in `test/`; CI runs them on every PR (`.github/workflows/test.yml`).
- The test runner is [vitest](https://vitest.dev/). Browser-bound modules are not in jsdom — they're left to manual verification in deployed apps.

### Reviewing visible changes

Browser-bound modules have no test harness, so UI changes are reviewed by
using them. Publish a live preview of your branch to GitHub Pages and lead with
the URL rather than describing the change — this is how the team reviews the
visible surface, and it has caught bugs no unit test would (a data URI whose
quotes voided a CSS declaration, specificity ties that silently lost, a flex
rule that made a panel unscrollable on a phone).

Invoke the **`deploy-preview`** skill, or see `preview/README.md` for the
fixture and `.github/workflows/gh-pages.yml` for the staging step. In short:

```bash
git push -f origin <branch>:preview/<name>   # only preview/* may deploy
gh workflow run gh-pages.yml --ref main     # main, not your branch — see the skill
```

→ `https://schmidtdse.github.io/glen/preview/<name>/`
(`/preview/` indexes them; every `preview/*` branch is rebuilt on each deploy,
so publishing yours does not take anyone else's offline)

### Module coverage status

When a PR touches a covered module, expect tests to change too. When it touches an uncovered one, verify by hand at `/core/` or on a preview. The agent, chat and export are tested in glen-harness.

| Module | Coverage | What changes here should be tested |
|---|---:|---|
| `app/overlay-rail.js` | 100% | `test/overlay-rail.test.js` — rail creation, slot ordering, mount/remove, per-document mounting |
| `app/app-header.js` | 100% | `test/app-header.test.js` — config resolution, nav derivation from `links`, logo slots, mobile takeover |
| `app/theme.js` | 100% | `test/theme.test.js` — theme resolution, fallback, body class application |
| `app/mobile-sheet.js` | partial | `test/mobile-sheet.test.js` — the pure detent maths (`detentHeights`, `nearestDetent`, `stepDetent`). Drag, tabs and the media-query switch are browser-bound; verify on a phone. |
| `app/raster-frames.js` | 100% | `test/raster-frames.test.js` — frame lists, bucket listing, date windows and steps |
| `app/frame-player.js` | partial | `test/frame-player.test.js` — playback, waiting for frames to load, preloading, ranges; `test/map-manager.time-series.test.js` — the frame layers on the map. The panel is browser-bound; verify on a preview. |
| `app/catalog-tree.js`, `app/stac-details.js`, `app/catalog-tools.js` | covered | `test/catalog-tree.test.js`, `test/stac-details.test.js`, `test/catalog-tools.test.js` — both catalog layouts, depth, scope (no collection outside the config), S3 path rules, a collection's STAC items (#462), its citation section (#482). This renderer is the reference for catalog text, not a copy of geo-query's `stac.py`. |
| `app/dataset-citations.js`, `app/data-page.js` | 100% | `test/data-page.test.js` — the default link and its opt-out, the catalog list with sub-collections, escaping, opening and closing on `#data`. The page's look is browser-bound; verify on a preview. |
| `app/cog-tiles.js` | covered | `test/cog-tiles.test.js` (band settings, tile URLs, catalog renders) and `test/core-portolan.test.js` (the same rules in glen core). |
| `core/portolan.js`, `core/portolan-catalog.js` | covered | `test/core-portolan.test.js` — tile, style and raster discovery, style conversion, the missing-value guard, catalog walk, prompt |
| `core/map-tools.js` | covered | `test/core-map-tools.test.js` — published styles and their filters, raster recolouring, fly_to forms, `set_time` only with a series of items. Rendering is browser-bound; verify at `/core/`. |
| `core/prompt.js` | covered | `test/core-prompt.test.js` — the app's prompt after core's, `system_prompt_url`, no prompt, an SPA's index page, core's own page. |
| `core/main.js` | 0% | Bootstrap — verify by loading `/core/` locally. `test/core-module-graph.test.js` checks that it loads no SQL or chart code at start, and that every `app/` module is reached from core or a plugin. |
| `core/plugins/mcp.js` | covered | `test/core-mcp-plugin.test.js` — server list resolution, rank and filters per server, per-server reconnect, unreachable servers, prompt order, the harness tag matching `core/main.js`, the local catalog tools over Portolan collections (relative hrefs, the collection's column dictionary, no server catalog tools), and servers in a Web Worker (#457). Check a worker change against geo-query-wasm at `/core/`. |
| `core/plugins/charts.js`, `app/chart-tool.js` | covered | `test/core-charts-plugin.test.js` — `render_chart` registered by the core plugin, SQL through the registered `query` tool and its argument name, the error without one; `test/map-tools.test.js` — the tool itself. The panel is browser-bound; verify at `/core/`. |
| `app/draw-tools.js`, `app/upload-tools.js`, `core/plugins/draw.js`, `core/plugins/uploads.js` | covered | `test/draw-upload-tools.test.js` — the two tools and their chat notices; `test/core-draw-uploads-plugins.test.js` — the core plugins' wiring. The draw control and upload button are browser-bound (`map-draw.js`, `upload-manager.js`); verify at `/core/`. |
| `core/convert-config.js`, `scripts/convert-to-core.mjs` | covered | `test/core-convert-config.test.js` — v3 `layers-input.json` and `index.html` to glen core: plugins from the opt-in keys, the default MCP server, dropped keys with notes, and the deploy-time MCP URL and token reaching `plugins/mcp.js`. Check a change against a real app: convert it, then compare its layers with the app on its v3 tag. |
| `app/query-filter-tool.js` | covered | `test/map-tools.test.js` — `filter_by_query` itself; `test/core-mcp-plugin.test.js` — the tool in glen core's MCP plugin, its SQL through the registered `query` tool. |
| `app/hex-tools.js`, `core/plugins/hex.js` | covered | `test/core-hex-plugin.test.js` — the two hex tools in glen core, metadata over https for a server, and with a worker server the tile protocol and metadata read through the client behind `register_hex_tiles`; the `scale` argument and the `suggested_scale` default (SchmidtDSE/glen#481). `test/hex-layer-helpers.test.js` and `test/map-manager.hex.test.js` cover the log ramps and the scale MapManager reports. Drawing is browser-bound; verify at `/core/` with both kinds of server. |
| `app/map-control-tools.js` | covered | `test/map-control-tools.test.js` — default and app hint text, fly_to with and without layer extents, the reset_style hook; `test/map-tools.test.js` — the shared tools' execute paths. |
| `app/animation-manager.js` | partial | `test/animation-manager.test.js` — the pure sampling helpers (`sampleTrack`, `cellBoundary`). MapLibre sublayers and the controls panel are browser-bound; verify visually. |
| `app/map-manager.js` published styles | partial | `test/map-manager.published-style.test.js` — `applyPublishedStyle` swaps paint, outline, filter and legend, and `resetStyle` restores them. The rest of map-manager is in the row below. |
| `app/h3-grid.js` | covered | `test/h3-grid.test.js` — resolution from on-screen cell size (and v3's choices at mid-latitudes), the cell cap, edge padding, the antimeridian, h3-js loaded lazily with SRI. The button is browser-bound; verify on a preview. |
| `core/plugins/geolocate.js` | covered | `test/core-geolocate-plugin.test.js` — the button, `get_user_location` only on `agent_tool`, the app's `geolocate` setting when given no options. |
| `app/filter-types.js` | covered | `test/filter-types.test.js` — filter literals matched to the tile field types (numeric strings against numbers, numbers against strings, `match` labels, `in` lists), and `set_filter` reporting what it changed. |
| `app/map-manager.js`, `app/layout-manager.js`, `app/map-draw.js` | 0% | Browser-bound (DOM, MapLibre). Verify visually on a preview or at `/core/` — no harness yet. |

Overall line coverage is reported on each PR via the coverage workflow.

