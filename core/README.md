# glen core

glen core is a small GLEN app: a MapLibre map of the layers in a [Portolan](https://www.portolan-sdi.org/) catalog, and a chat agent that controls the map. It assumes no MCP server and no SQL engine. The agent's tools act on the page: show and hide layers, filter features, apply the publisher's styles or new paint, recolour rasters, label legends, set tooltips and move the view.

Everything else the full app in `app/` does comes back as plugins: `plugins/mcp.js` adds MCP servers' tools, such as DuckDB queries, to the map tools, `plugins/charts.js` adds charts, and `plugins/draw.js` and `plugins/uploads.js` add drawing and uploads. Hex layers are still to come. The session export is a config setting (see below).

## Use

A downstream app serves `index.html`, `layers-input.json` and, optionally, `config.json`. Its `index.html` loads the core from jsDelivr pinned to a tag or commit, and the styles from `app/` at the same ref:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/app/style.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/app/chat.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/app/sidebar.css">
<script type="module" src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/core/main.js"></script>
```

The page also needs MapLibre, PMTiles, marked and DOMPurify. `core/index.html` lists them with their integrity hashes; it does not load h3-js or highlight.js, which the core does not use. [glen-portolan-template](https://github.com/SchmidtDSE/glen-portolan-template) is a complete example and the starting point for a new app.

Run it locally from the repository root with `python -m http.server 8000` and open `http://localhost:8000/core/`. The example configuration shows Jamaica after Hurricane Melissa.

## Configuration

`layers-input.json` takes the same chrome, model and welcome settings as the full app (`sidebar`, `header`, `theme`, `llm`, `llm_models`, `welcome`, `view`, `default_basemap`, `geocoder`, `auto_approve`). As in the full app, when every model is served by open-llm-proxy the model picker shows the models the app's key may use, and a user who brings their own key can name any model. Data comes from Portolan collections:

```json
{
  "catalog": "https://example.org/catalog.json",
  "collections": [
    "https://example.org/roads/collection.json",
    "parishes",
    {
      "url": "https://example.org/population/collection.json",
      "display_name": "Population at 100 m",
      "visible": true,
      "group": "People",
      "style": "graduated",
      "tooltip": ["name", "population"],
      "colormap": "magma",
      "rescale": "0,50"
    }
  ],
  "titiler_url": "https://titiler.nrp-nautilus.io"
}
```

A collection can be named by URL or, when `catalog` is set, by id. With `catalog` and no `collections`, the core loads every collection under the root, up to `max_collections` (default 25). Without `view`, the map opens on the extent of the loaded data.

| Key | Applies to | Meaning |
|---|---|---|
| `url` | all | The collection's `collection.json` |
| `id` | all | Layer id to use instead of the collection id |
| `display_name` | all | Name in the layer panel and legend |
| `visible` | all | On when the app opens |
| `group` | all | Layer panel group |
| `style` | vector | Name of the published style to start with (default: the one with the `default` role) |
| `paint`, `default_filter` | vector | MapLibre paint and filter to use instead of the published style's |
| `tooltip` | vector | Properties shown on hover |
| `colormap`, `rescale`, `opacity` | raster | TiTiler colour map, display range `"min,max"`, and opacity (default 0.7, as in the full app; the full app's `paint: { "raster-opacity" }` also works) |
| `bidx` | raster | Band of a multi-band COG to draw (default 1). The catalog's render describes band 1, so another band starts from its own statistics |
| `assets` | all | The collection's assets to draw, in this order: asset keys, or objects with an `id` and any of the keys above for that asset alone. Without it every drawable asset is drawn |
| `items` | all | Items of the collection to draw: item ids, or objects with an `id` and any of the keys above, `assets` included, for that item alone |
| `control` | raster | `{ "bind": "frame", "frames": "items" }` draws every item of the collection as one time series, with the full app's player and its other `control` settings (`window`, `start`, `end`, `step`, `frame_ms`, `default`, `loop`, `label`) and `"asset"` to name the item asset when an item has several COGs |

Collection and asset entries also take the full app's layer settings, by the full app's names, so an app's config carries over: `versions` and `default_version` for one layer with a dropdown over several assets, `toggle_group` for layers that share one panel checkbox, `sidebar: false` for a layer the agent can show but the panel does not list, `group` as `{ "name", "collapsed" }`, `default_style`, `outline_style`, `tooltip_fields` and `layer_type`, read as `paint`, an outline, `tooltip` and the render type, the `legend_*` keys, a slider `control`, a trajectory `animation`, and a raster's `nodata`, `unscale` and `legend_classes`. GeoJSON assets are drawn whole, as in the full app. See the full app's [configuration guide](../docs/guide/configuration.md) for each.

Keys on a collection entry apply to all of its layers; an entry under `assets` or `items` overrides them for its own layers. Layer ids are `<collection>/<asset>` when the collection has more than one drawable asset, whichever of them `assets` keeps, so an id does not change with the selection. An item's layer is `<collection>/<item>`, or `<collection>/<item>/<asset>` when the item has more than one drawable asset. A layer whose entry sets `bidx` adds `/band-<n>`, so one COG can be listed once per band.

A collection whose data is in items, such as a daily raster series, draws nothing until its entry lists the items to draw, or plays them as a time series:

```json
{
  "url": "https://example.org/heat/daily-cog/collection.json",
  "colormap": "rdylbu_r",
  "rescale": "10,40",
  "items": [
    { "id": "tmax-tmin-2025-07-01", "display_name": "Tmax, 1 July", "visible": true },
    { "id": "tmax-tmin-2025-07-01", "bidx": 3, "display_name": "Tmax anomaly, 1 July", "colormap": "rdbu_r", "rescale": "-10,10" }
  ]
}
```

```json
{
  "url": "https://example.org/heat/daily-cog/collection.json",
  "display_name": "Daily Tmax",
  "colormap": "rdylbu_r",
  "rescale": "10,40",
  "control": { "bind": "frame", "frames": "items", "frame_ms": 500 }
}
```

## Moving a v3 app to glen core

`scripts/convert-to-core.mjs` converts an app's two files:

```bash
node scripts/convert-to-core.mjs layers-input.json --ref <glen tag> > layers-input.core.json
node scripts/convert-to-core.mjs index.html --ref <glen tag> > index.core.html
```

glen core reads the full app's layer settings by the same names, `collection_id` and `collection_url` included, so collections pass through unchanged. The opt-in features become plugins: the MCP server (every v3 app had one, `duckdb-mcp.nrp-nautilus.io` when it named none), with its `geospatial-analyst` prompt; `charts`; `draw_enabled`; and `upload_enabled` with its settings. `catalog_index_threshold`, `client_header_hosts` and collections' `preload` are dropped, with a note for each. The page's module script loads `core/main.js`, and its glen URLs move to the release.

The deploy-time `config.json` needs no change: `plugins/mcp.js` takes `mcp_server_url` and `mcp_auth_token` from it for the first server, and core reads `llm_models`, `llm_model`, `transcription_model`, `geolocate`, `export` and the tool-call limits, as the full app does. A `draw_enabled` set only in `config.json` has no effect in core; list `plugins/draw.js` instead.

## Session export

`"export": true` adds the full app's session export: a button under the chat that downloads the session as an HTML report, with each question, the SQL that answered it, a snapshot of the map, the charts drawn, and a Data sources section citing the datasets the session queried or showed. The report comes from glen-harness, which loads it on first use, and it takes the same `export` settings as the full app ([configuration guide](../docs/guide/configuration.md)). It is off by default, since a map-only app has little to report. With `plugins/charts.js` the report redraws the session's charts. A dataset counts as queried when a query read one of its Parquet assets; Portolan writes those hrefs relative to the collection, so core resolves them before the report matches them.

## Portolan support

`portolan.js` holds the rules as pure functions, and `portolan-catalog.js` does the fetching.

- Vector tiles come from the collection's `rel: pmtiles` link and `pmtiles:layers`, or from an asset with the `visual` role. The same file listed both ways becomes one layer.
- The geometry type and attribute names come from the PMTiles archive's own metadata, so filters and styles use the names in the tiles.
- Styles come from assets with the `style` role. Each is converted to the one MapLibre layer the core draws for that geometry. The default style sets the starting paint, and the others are offered to the agent by name through `apply_style`. The prompt lists the categories or range each style colours by, so the model filters and restyles on real values.
- A colour ramp cannot interpolate a missing value and paints it black. The core sets the opacity to zero for features without a number in that property, and leaves the colour expression whole so the legend still reads it.
- Rasters are COG assets with the `data` role. The starting display range comes from the band statistics Portolan requires, capped at the mean plus two standard deviations for skewed data. Tiles come from TiTiler, by default the NRP server at `titiler.nrp-nautilus.io`; `titiler_url` points an app at another.
- Assets with the `source` role are the publisher's upstream originals and are never drawn.
- Items are read one JSON file each, found through the collection's `item` links by file or folder name, or in a folder named for the item beside the collection. Their COGs and PMTiles are drawn as the collection's are, and the prompt gives each item layer its item id and date. Renders on the item or the collection apply to its COGs.
- A time series of items reads the collection's `items.parquet` mirror (the `collection-mirror` asset) in one request, with the vendored hyparquet loaded only then. Without a readable mirror it reads each item's JSON, up to the 400 most recent. The layer starts on the latest date, and `set_time`, registered only when an app has a series, moves it. Its colour map and range come from config and stay the same on every date, so `set_raster_colormap` leaves a series alone.
- A band with a `scale` or `offset` is drawn in real units: TiTiler applies them (`unscale`), as in the full app. A class whose value is the band's nodata value is never drawn or listed.
- Column descriptions (`table:columns`) are read from the collection and from each asset. Portolan puts them on the collection; our current STAC puts them on each asset. When a PMTiles archive's metadata cannot be read, the asset's `table:columns` name the feature properties.

## Plugins

A plugin is an ES module whose default export is `{ name, setup(ctx, options) }`. List it in `layers-input.json`:

```json
"plugins": [
  { "url": "https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/core/plugins/mcp.js",
    "options": { "url": "https://duckdb-mcp.example.org/mcp" } }
]
```

Each server entry may also give `auth_token`, sent to that server alone as a bearer token, as in the full app's `mcp_servers`; the deploy-time `config.json` sets the first server's URL and token with `mcp_server_url` and `mcp_auth_token`. `plugins/mcp.js` takes one server as above or several as `"servers": [{ "url": …, "headers": …, "prompt": … }, …]`; when two servers list a tool of the same name, the one listed first keeps it. Each server entry can also take `include` or `exclude`, a list of tool names, to register only some of its tools. MCP gives a client no way to ask a server for part of its tool list, so the filter runs here, and the server still offers every tool to other clients. A server that cannot be reached is skipped.

A server can also run in the page, in a Web Worker, such as [geo-query-wasm](https://github.com/SchmidtDSE/geo-query-wasm), which runs geo-query's tools on DuckDB-wasm in the visitor's browser. Its entry takes `worker`, the path of a worker file the app serves, in place of `url`, and `worker_config`, which the worker receives as JSON in a `config` search parameter:

```json
"servers": [{ "worker": "geo-query-worker.js", "worker_config": { "discovery": false }, "include": ["query"] }]
```

A page may start a Worker only from its own origin, so the app serves that file. For geo-query-wasm it is one line, `import 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@<commit>/src/worker.js';`. The path is relative to the page. A worker entry takes the same rank, filters and prompt as a URL entry, and never offers a visitor token. A worker that fails to load is skipped like a server that cannot be reached. geo-query-wasm limits what SQL may read with two lists in `worker_config`. `allowedDirectories` covers the paths a query reads: by default any `s3://` path, and `https://` only on NRP and source.coop. `allowedEndpoints` covers the S3 hosts a query may name with `s3_endpoint`, which is how `get_schema` points the model at a host other than NRP or source.coop: by default NRP, minio.carlboettiger.info and AWS S3. So a collection on Google Cloud Storage needs `"allowedEndpoints": ["s3-west.nrp-nautilus.io", "storage.googleapis.com"]`. A list given in `worker_config` replaces geo-query-wasm's default list rather than adding to it.

The plugin answers the catalog tools itself. `get_schema` and `get_stac_details` describe a collection the app loaded: its `read_parquet` paths, hex tables, and each table's columns with descriptions and coded values, taken from the collection's `table:columns`. A collection the app does not list is refused, and the servers' own catalog tools (`browse_stac_catalog`, `get_stac_details`, `get_collection`, `get_schema`) are never registered, as in the full app since v3.44.0 (glen#441, `docs/design/data-scope.md`). Paths on a host other than NRP or source.coop carry the `s3_endpoint` and `s3_scope` to pass to `query`; `s3_sources` in the app config adds https → s3 rules, as in the full app.

When the first server is on another origin from the page and its entry sets no `Authorization` header, a visitor can enter their own token for it under ⚙ in the chat, as in the full app ([configuration guide](../docs/guide/configuration.md#a-visitor-s-mcp-token)). If the server refuses the connection at start, the chat says so and opens the settings.

`plugins/charts.js` adds the full app's `render_chart` tool: bar, line, scatter and histogram charts in a floating panel. The agent passes rows it has, or a SELECT that the panel runs through the `query` tool of an SQL server added with `plugins/mcp.js`, so the rows never pass through the model. Without such a server, charts from rows still work. Observable Plot loads from jsDelivr the first time a chart is drawn.

```json
"plugins": [
  { "url": "https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/core/plugins/mcp.js", "options": { "url": "…" } },
  "https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/core/plugins/charts.js"
]
```

`plugins/draw.js` adds the full app's polygon draw button and the `get_drawn_region` tool, which returns the drawn region as WKT with an H3 resolution to join it at. `plugins/uploads.js` adds the full app's GeoJSON upload: polygons or points, sent from the browser to S3, with the `get_uploaded_dataset` tool, which gives the agent the file's URL and never its geometry. Its options are the full app's upload settings (`bucket_url`, `prefix`, `max_bytes`, `max_features`, `max_point_features`, `ingest_url`; see the [configuration guide](../docs/guide/configuration.md#geojson-upload-optional)). Both tell the chat when a region is drawn or a file arrives. Both answers are meant for SQL, so these plugins go with an SQL server from `plugins/mcp.js`.

```json
"plugins": [
  { "url": "…/core/plugins/mcp.js", "options": { "url": "…" } },
  "…/core/plugins/draw.js",
  { "url": "…/core/plugins/uploads.js", "options": { "max_features": 200 } }
]
```

`setup` runs after the map and the map tools exist and before the agent is built. It receives:

| Field | What it is |
|---|---|
| `ctx.config` | The merged app configuration |
| `ctx.map` | glen's `MapManager` |
| `ctx.catalog` | The `PortolanCatalog` with `datasets` and `layers` |
| `ctx.tools` | The harness `ToolRegistry`; call `registerLocal` or `registerRemote` |
| `ctx.addPrompt(text)` | Adds a section to the system prompt |
| `ctx.onReady(fn)` | Runs `fn({ agent, ui })` once the agent and chat exist |

A plugin that throws is logged and skipped, and the map and its tools keep working. Prompt text should stay the same for a deployment, so that providers can cache the prompt prefix (see `docs/design/prompt-prefix-stability.md`).

## Harness

The agent loop, tool registry and chat come from [glen-harness](https://github.com/SchmidtDSE/glen-harness). `main.js` imports them from jsDelivr at a release tag, the same way apps load glen, so glen keeps no copy. It imports the `src/core.js` entry, which leaves out the MCP client, and turns the session export off unless the config sets `export`; the harness loads the export only if it runs. To move to a new harness release, change the tag in both import URLs in `main.js` and in `HARNESS_MCP_CLIENT` in `plugins/mcp.js`; a test checks that the three agree.

## Modules

| Module | What it does |
|---|---|
| `main.js` | Bootstrap: config, Portolan catalog, map, map tools, plugins, agent, chat |
| `portolan.js` | Pure rules for reading a Portolan collection: tiles, styles, rasters, metadata |
| `portolan-catalog.js` | Fetches collections, styles and PMTiles metadata; builds layer configs and the prompt |
| `map-tools.js` | The shared map-control tools from `app/map-control-tools.js`, with Portolan wording, plus `apply_style`, `set_raster_colormap` and `describe_layer` |
| `system-prompt.md` | The base prompt; an app can replace it with `system_prompt_url` |
| `plugins/mcp.js` | Plugin that adds the tools of one or more MCP servers, filtered by `include` or `exclude`, and the collections' GeoParquet URLs |
| `plugins/charts.js` | Plugin that adds `render_chart`, with SQL run through the registered `query` tool |
| `plugins/draw.js` | Plugin that adds the polygon draw button and `get_drawn_region` |
| `plugins/uploads.js` | Plugin that adds the GeoJSON upload and `get_uploaded_dataset` |

The core reuses these modules from `app/` unchanged: `map-control-tools.js` (the map tools both apps share), `catalog-tree.js` (finding collections by id at any depth, in our current STAC and the Portolan layout), `cog-tiles.js` (raster band settings and tile URLs), `map-manager.js` (layers, filters, styles, legend, tooltips), `layout-manager.js` with the header, theme and mobile sheet, `geocoder.js` and `data-page.js`.

## Limitations

- Tiled products whose items make up one mosaic (GHSL) need a mosaic layer, which is not done yet.
- Style layers of type `symbol` (labels) are skipped, because labels need a glyph server.
- `map-manager.js` still loads the hex-layer helpers it imports, though the core never adds a hex layer.
