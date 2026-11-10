# glen core

glen core is a small GLEN app: a MapLibre map of the layers in a [Portolan](https://www.portolan-sdi.org/) catalog, and a chat agent that controls the map. It assumes no MCP server and no SQL engine. The agent's tools act on the page: show and hide layers, filter features, apply the publisher's styles or new paint, recolour rasters, label legends, set tooltips and move the view.

Everything else the full app in `app/` does, such as DuckDB queries over MCP, hex layers, charts, drawing, uploads and the session export, is meant to come back as plugins. `plugins/mcp.js` is the first: it adds an MCP server's tools to the map tools.

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
| `colormap`, `rescale`, `opacity` | raster | TiTiler colour map, display range `"min,max"`, and opacity |

## Portolan support

`portolan.js` holds the rules as pure functions, and `portolan-catalog.js` does the fetching.

- Vector tiles come from the collection's `rel: pmtiles` link and `pmtiles:layers`, or from an asset with the `visual` role. The same file listed both ways becomes one layer.
- The geometry type and attribute names come from the PMTiles archive's own metadata, so filters and styles use the names in the tiles.
- Styles come from assets with the `style` role. Each is converted to the one MapLibre layer the core draws for that geometry. The default style sets the starting paint, and the others are offered to the agent by name through `apply_style`. The prompt lists the categories or range each style colours by, so the model filters and restyles on real values.
- A colour ramp cannot interpolate a missing value and paints it black. The core sets the opacity to zero for features without a number in that property, and leaves the colour expression whole so the legend still reads it.
- Rasters are COG assets with the `data` role. The starting display range comes from the band statistics Portolan requires, capped at the mean plus two standard deviations for skewed data. Tiles come from TiTiler, by default the NRP server at `titiler.nrp-nautilus.io`; `titiler_url` points an app at another.
- Assets with the `source` role are the publisher's upstream originals and are never drawn.
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

`plugins/mcp.js` takes one server as above or several as `"servers": [{ "url": …, "headers": …, "prompt": … }, …]`; when two servers list a tool of the same name, the one listed first keeps it. Each server entry can also take `include` or `exclude`, a list of tool names, to register only some of its tools. MCP gives a client no way to ask a server for part of its tool list, so the filter runs here, and the server still offers every tool to other clients. A server that cannot be reached is skipped.

The plugin answers the catalog tools itself. `get_schema` and `get_stac_details` describe a collection the app loaded: its `read_parquet` paths, hex tables, and each table's columns with descriptions and coded values, taken from the collection's `table:columns`. A collection the app does not list is refused, and the servers' own catalog tools (`browse_stac_catalog`, `get_stac_details`, `get_collection`, `get_schema`) are never registered, as in the full app since v3.44.0 (glen#441, `docs/design/data-scope.md`). Paths on a host other than NRP or source.coop carry the `s3_endpoint` and `s3_scope` to pass to `query`; `s3_sources` in the app config adds https → s3 rules, as in the full app.

When the first server is on another origin from the page and its entry sets no `Authorization` header, a visitor can enter their own token for it under ⚙ in the chat, as in the full app ([configuration guide](../docs/guide/configuration.md#a-visitor-s-mcp-token)). If the server refuses the connection at start, the chat says so and opens the settings.

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

The core reuses these modules from `app/` unchanged: `map-control-tools.js` (the map tools both apps share), `catalog-tree.js` (finding collections by id at any depth, in our current STAC and the Portolan layout), `cog-tiles.js` (raster band settings and tile URLs), `map-manager.js` (layers, filters, styles, legend, tooltips), `layout-manager.js` with the header, theme and mobile sheet, `geocoder.js` and `data-page.js`.

## Limitations

- Multi-scene raster collections, with one COG per item, are not drawn yet; only collection-level COGs are.
- Style layers of type `symbol` (labels) are skipped, because labels need a glyph server.
- `map-manager.js` still loads the hex-layer helpers it imports, though the core never adds a hex layer.
