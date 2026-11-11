# Project Context & Instructions

## Overview
Core library for map-based applications with LLM-powered data analysis. Interactive MapLibre GL JS map with an agentic chatbot for natural language data queries and map control. Individual apps (different datasets, branding, deployments) import this library from the CDN and provide their own configuration.

## Key Technologies
- **Frontend**: MapLibre GL JS, PMTiles (vectors), COG + TiTiler (rasters), ES modules
- **Data**: STAC catalog → unified dataset records with visual + parquet assets
- **Analytics**: SQL queries via MCP (Model Context Protocol) to DuckDB on H3-indexed parquet
- **LLM**: OpenAI-compatible Chat Completions API (multiple models via proxy)
- **Deployment**: App JS/CSS is loaded from jsDelivr CDN. **Every downstream app pins a version tag or commit SHA** — `@main` is no longer used in production or demos. Downstream apps only need a static HTML file — see the [glen-template](https://github.com/SchmidtDSE/glen-template) repo.

## Architecture (app/ modules)
- `main.js` — Bootstrap: loads config, initializes catalog → map → tools → agent → UI
- `dataset-catalog.js` — Fetches STAC collections, builds unified records
- `catalog-tree.js` — Finds collections by id at any depth, through Catalogs and Collections, so both our current STAC and the Portolan layout resolve (#441). Shared with glen core.
- `published-styles.js` — A collection's published MapLibre styles: finding them, matching each to its PMTiles file, turning one into the layer glen draws, describing its colours. Shared with glen core, which re-exports them from `core/portolan.js`. `app/` never imports from `core/`; the preview serves `app/` on its own, so such an import breaks it (`test/app-imports.test.js`).
- `cog-tiles.js` — How a COG is drawn: band settings (`bidx`, nodata, classes, `unscale` for scaled bands) and the TiTiler tile URL. Shared with glen core, so a raster draws the same in both apps.
- `catalog-tools.js` / `stac-details.js` — `get_schema` and `get_stac_details`, answered in the browser from the loaded STAC. Ported from geo-query's `stac.py`, but now the reference: STAC handling is moving out of geo-query and geo-query-wasm into these local tools, so they gain features (such as a collection's STAC items, #462) that `stac.py` does not have. The MCP server's catalog tools are never registered (#441).
- `map-manager.js` — Creates MapLibre map, manages layers/filters/styles
- `overlay-rail.js` — Shared bottom-left rail every map-scoped overlay panel mounts into (legend, sliders, H3 resolution badge). New floating panels go here, not onto `document.body` with their own anchors.
- `app-header.js` — Optional app chrome band (logos, top-level nav) in `scrim` or `solid` mode. App-level UI goes here; map-scoped controls go in the overlay rail.
- `mobile-sheet.js` — Below 700px the sidebar becomes a bottom sheet with peek/half/full detents. No gesture is bound to the map.
- `icons.js` — The few inline SVGs shared by the header nav and the chat footer links.
- `theme.js` — Selects the chrome colour scheme (light/dark/auto) as a body class and applies per-app colour overrides inline; the tokens themselves live in `style.css`.
- `map-tools.js` — the local tools the LLM agent can call (map control, styling, legends, geocoding)
- `raster-frames.js` / `frame-player.js` — Raster time series (#421): find a series' dated COGs (STAC frame-list asset or bucket listing) and play them, preloading the next frames
- `tool-registry.js` — Unified dispatch for local + remote (MCP) tools
- `mcp-client.js` — MCP transport wrapper (connect once, lazy reconnect)
- `mcp-servers.js` — Resolves which MCP servers an app connects to (`mcp_url` shorthand or `mcp_servers` list; the first is primary), and whether a visitor's own MCP token may be sent to the primary (#442)
- `agent.js` — LLM orchestration loop (agentic tool-use cycle)
- `llm-auth.js` — The `Authorization` header for LLM requests: none when `api_key` is unset, so basic-auth deployments keep working
- `llm-models.js` — Which models the picker offers: the open-llm-proxy's tier list when the app is served through it (#444), and a bring-your-own-key user's own model id (#443)
- `chat-ui.js` — Chat UI with collapsible tool-call blocks
- `dataset-citations.js` — How a dataset is cited, from its STAC record. Shared by the export's Data sources section and the data page, so the two cannot drift.
- `data-page.js` — The data sources page (#433): every dataset the app loads with its citation, a `<dialog>` opened on the `#data` fragment and linked by default from the header nav and chat footer.
- `export-report.js` — The exported session report: builds a Quarto-style HTML document from the session record ChatUI keeps (no DOM). Also holds the export helpers (setup block, R/Python wrappers, credential scrub, map embed).

## glen core (core/)

`core/` is a smaller app built from the same pieces: a map of the layers in [Portolan](https://www.portolan-sdi.org/) collections and an agent whose tools act only on the map. It assumes no MCP server or SQL engine; those return as plugins (`core/plugins/mcp.js`). It reuses `app/map-manager.js`, `app/layout-manager.js`, `app/geocoder.js`, `app/data-page.js`, `app/catalog-tree.js` and `app/cog-tiles.js` unchanged, and loads glen-harness from jsDelivr at a release tag for the agent and chat. Its map tools come from `app/map-control-tools.js`, which the full app's `map-tools.js` also uses, so a map tool is defined once. See `core/README.md`. Changes to the shared `app/` modules reach both apps, so check a core app too when they touch layer registration, styling or the layout.

- `core/main.js` — Bootstrap: config → Portolan catalog + map → map tools → plugins → agent → chat
- `core/portolan.js` — Pure rules for reading a Portolan collection (PMTiles links, style assets, COG band statistics)
- `core/portolan-catalog.js` — Fetches collections, styles and PMTiles metadata; builds MapManager layer configs and the prompt
- `core/map-tools.js` — The core's map tools, including `apply_style` (published styles) and `set_raster_colormap`

## Design decisions

Settled architectural calls are recorded in `docs/design/` so they aren't re-litigated. Read the relevant note before reopening one of these questions.

- [`docs/design/tool-call-parsing.md`](docs/design/tool-call-parsing.md) — why tool-call dialect recovery (`parseEmbeddedToolCalls` / `looksLikeAttemptedToolCall` in `app/agent.js`) lives in the harness and is kept, not moved to the server/proxy or replaced by a library.
- [`docs/design/data-scope.md`](docs/design/data-scope.md) — why which-data-exists is a deployment property rather than a model-supplied tool argument, why the prompt's `discovery` flag is read off the tool registry instead of app config, and why the `query` escape hatch was deliberately left open.
- [`docs/design/prompt-prefix-stability.md`](docs/design/prompt-prefix-stability.md) — why dynamic content stays out of the leading bytes of the request, so prompt-prefix caching keeps paying off.

## Configuration
- `app/layers-input.json` — Static config: STAC catalog URL, collection IDs, map view
- `config.json` — Generated at deploy time by k8s (LLM models + API keys from secrets)
- Both are merged by `main.js` at startup; runtime config overrides static config
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
- Local: `cd app && python -m http.server 8000`
- Create a local `app/config.json` with LLM model configs for development
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

glen core imports glen-harness from `cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@<tag>` in `core/main.js`; there is no copy here. Change glen-harness, tag a release, and bump both URLs together.

`app/vendor/mcp-sdk.js` is a **committed build artifact** — the MCP SDK,
pre-bundled with esbuild so the app has no runtime dependency on a third-party
ESM host (#343). Rebuild with `pnpm run build:vendor`; CI fails if the committed
file doesn't match a fresh build. Never hand-edit it, and see
`app/vendor/README.md` before bumping the SDK version. Every other third-party
library stays in the app's `index.html` as an SRI-hashed `<script>` tag — that
split is deliberate, see #344.

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

When a PR touches a covered module, expect tests to change too. When it touches an uncovered one, verify by hand on a representative downstream app.

| Module | Coverage | What changes here should be tested |
|---|---:|---|
| `app/llm-auth.js` | 100% | `test/llm-auth.test.js` — no `Authorization` header without a key (basic-auth deployments, #420) |
| `app/llm-models.js` | 100% | `test/llm-models.test.js` — tier list vs config, fallbacks, BYOK model id; `test/chat-ui-model-settings.test.js` — the settings panel field |
| `app/transcriber.js` | 100% | `test/transcriber.test.js` — endpoint resolution, error paths, abort signal |
| `app/overlay-rail.js` | 100% | `test/overlay-rail.test.js` — rail creation, slot ordering, mount/remove, per-document mounting |
| `app/app-header.js` | 100% | `test/app-header.test.js` — config resolution, nav derivation from `links`, logo slots, mobile takeover |
| `app/theme.js` | 100% | `test/theme.test.js` — theme resolution, fallback, body class application |
| `app/mobile-sheet.js` | partial | `test/mobile-sheet.test.js` — the pure detent maths (`detentHeights`, `nearestDetent`, `stepDetent`). Drag, tabs and the media-query switch are browser-bound; verify on a phone. |
| `app/mcp-client.js` | 99% | `test/mcp-client.test.js` — connect / reconnect / callTool retry / resources / prompts |
| `app/mcp-servers.js` | 100% | `test/mcp-servers.test.js` — `mcp_url` / `mcp_servers` resolution, primary override, optional flag, when a visitor's token applies (#442); `test/chat-ui-mcp-token.test.js` — the token field |
| `app/tool-registry.js` | 98% | `test/tool-registry.test.js` — registration, dispatch, argsRewriter, schema cleaning, per-server clear and collisions |
| `app/raster-frames.js` | 100% | `test/raster-frames.test.js` — frame lists, bucket listing, date windows and steps |
| `app/frame-player.js` | partial | `test/frame-player.test.js` — playback, waiting for frames to load, preloading, ranges; `test/map-manager.time-series.test.js` — the frame layers on the map. The panel is browser-bound; verify on a preview. |
| `app/map-tools.js` | 98% | `test/map-tools.test.js` — local-tool execute paths, `apply_style` (#440) |
| `app/catalog-tree.js`, `app/stac-details.js`, `app/catalog-tools.js` | covered | `test/catalog-tree.test.js`, `test/stac-details.test.js`, `test/catalog-tools.test.js` — both catalog layouts, depth, scope (no collection outside the config), S3 path rules, a collection's STAC items (#462). This renderer is the reference for catalog text, not a copy of geo-query's `stac.py`. |
| `app/dataset-citations.js`, `app/data-page.js` | 100% | `test/data-page.test.js` — the default link and its opt-out, the catalog list with sub-collections, escaping, opening and closing on `#data`. The page's look is browser-bound; verify on a preview. |
| `app/export-report.js` | 99% | `test/export-report.test.js`, `test/chat-export*.test.js` — step classification, report shape, disclosure, the ChatUI session record. Regenerate `preview/sample-export.html` after a change. |
| `app/cog-tiles.js` | covered | `test/dataset-catalog.test.js` (band settings, tile URLs) and `test/core-portolan.test.js` (the same rules in glen core). |
| `app/dataset-catalog.js` | 89% | `test/dataset-catalog.test.js` — STAC parsing, layer config shape, prompt rendering |
| `app/agent.js` | 48% | `test/agent-retry.test.js` — retry / abort / timeout. The conversation loop is uncovered (tested manually). |
| `core/portolan.js`, `core/portolan-catalog.js` | covered | `test/core-portolan.test.js` — tile, style and raster discovery, style conversion, the missing-value guard, catalog walk, prompt |
| `core/map-tools.js` | covered | `test/core-map-tools.test.js` — published styles and their filters, raster recolouring, fly_to forms, `set_time` only with a series of items. Rendering is browser-bound; verify at `/core/`. |
| `core/main.js` | 0% | Bootstrap — verify by loading `/core/` locally. `test/core-module-graph.test.js` checks that it loads no MCP, SQL or export code. |
| `core/plugins/mcp.js` | covered | `test/core-mcp-plugin.test.js` — server list resolution, rank and filters per server, per-server reconnect, unreachable servers, prompt order, the harness tag matching `core/main.js`, the local catalog tools over Portolan collections (relative hrefs, the collection's column dictionary, no server catalog tools), and servers in a Web Worker (#457). Check a worker change against geo-query-wasm at `/core/`. |
| `app/map-control-tools.js` | covered | `test/map-control-tools.test.js` — default and SQL hint text, fly_to with and without layer extents, the reset_style hook. The full app's tool text must not change; compare `createMapTools` output before and after. |
| `app/main.js` | 0% | Bootstrap — verify by loading the app locally. |
| `app/animation-manager.js` | partial | `test/animation-manager.test.js` — the pure sampling helpers (`sampleTrack`, `cellBoundary`). MapLibre sublayers and the controls panel are browser-bound; verify visually. |
| `app/map-manager.js` published styles | partial | `test/map-manager.published-style.test.js` — `applyPublishedStyle` swaps paint, outline, filter and legend, and `resetStyle` restores them. The rest of map-manager is in the row below. |
| `app/chat-ui.js`, `app/map-manager.js`, `app/layout-manager.js`, `app/map-draw.js`, `app/h3geo.js`, `app/voice-input.js` | 0% | Browser-bound (DOM, MapLibre, MediaRecorder). Verify visually in a deployed app — no harness yet. |

Overall line coverage is reported on each PR via the coverage workflow.

