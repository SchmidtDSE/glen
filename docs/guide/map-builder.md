# Map Builder

The map builder makes a GLEN app of public data without a repository, a server or any files to host. You choose the data, the look and a short prompt in a form, and one of our sites runs the app. Each app is a short JSON config; the site supplies the code, the models and the SQL server.

- **GitHub Pages:** <https://schmidtdse.github.io/glen/maps/>. Each visitor enters their own [OpenRouter](https://openrouter.ai) key, which stays in their browser, and SQL runs in the browser with [geo-query-wasm](https://github.com/SchmidtDSE/geo-query-wasm).
- **NRP:** <https://glen.nrp-nautilus.io/>. Visitors need no key: the chat uses open-llm-proxy's public tier, with its rate limits, and SQL runs on the shared geo-query MCP server on the [National Research Platform](https://nationalresearchplatform.org/).

Both run glen's latest release. An app made on one site runs on the other unchanged.

Apps with private data, a server-side key of their own, custom plugins or their own domain still start from [glen-template](https://github.com/SchmidtDSE/glen-template). See [Quick Start](./quickstart).

## Making an app

1. **Starting point.** Start a new app, open one of the examples, upload a `layers-input.json` from an existing app, or paste the link of any hosted app to edit a copy.
2. **Name and welcome.** The title shows in the header, the sidebar and the browser tab. The welcome message and example questions open the chat. The notes on the data are the app's prompt, added after glen's own: a sentence or two on what the data is and who the app is for.
3. **Data.** Enter a STAC or [Portolan](https://www.portolan-sdi.org/registry) catalog URL (GLEN's catalog is filled in) and choose **Browse** to list its collections. Tick the ones to show; each becomes a layer with a name, an optional group and whether it is on at start. A collection can also be added by its `collection.json` URL. glen draws a collection's PMTiles and Cloud-Optimized GeoTIFFs, and the agent's SQL reads its GeoParquet.
4. **Map.** Choose the basemap and colour scheme. Pan the small map and tick **Open on this view** to set the opening view; without one the app opens on the extent of its data.
5. **Tools.** Turn the site's plugins on or off: SQL over the data, charts, settings controls, drawing, geolocation and, on NRP, hex maps.
6. **Config file.** The whole config, editable. Per-layer styles, filters, legends and tooltips from the [configuration reference](./configuration) go here.

The **Open the app** button runs the app as configured, and **Copy link** gives its address.

## Sharing and publishing

An app can be shared in three ways.

| Address | What it holds |
|---|---|
| `…/maps/hosted/map/?c=…` | The whole config, compressed into the link. Nothing is stored anywhere. |
| `…/maps/hosted/map/?config=<url>` | A config file hosted anywhere public that allows cross-origin reads, such as a GitHub raw file or source.coop. |
| `…/maps/a/<name>/` | A published app. |

A link with the config in it works at once, but becomes long for an app with many styled layers; the builder warns past about 6000 characters. Then host the config file and use `?config=`, or publish the app.

To publish, enter a name for the address and choose **Propose on GitHub**. GitHub opens a new file, `hosted/apps/<name>.json`, with the config filled in. Saving it opens a pull request from your fork of [SchmidtDSE/glen](https://github.com/SchmidtDSE/glen). Once it is merged the app is served at `https://schmidtdse.github.io/glen/maps/a/<name>/`, and at `https://glen.nrp-nautilus.io/a/<name>/` after the NRP site restarts.

Adding `?app=<name>`, `?config=<url>` or `?c=…` to the builder's address opens that app for editing.

## App config

An app config takes these settings from [`layers-input.json`](./configuration): `catalog`, `collections`, `max_collections`, `titiler_url`, `view`, `welcome`, `default_basemap`, `custom_basemap`, `links`, `header`, `theme`, `sidebar`, `geocoder`, `s3_sources` and `auto_approve`. It adds four of its own.

| Field | Description |
|---|---|
| `title` | The app's name in the header, the sidebar and the browser tab. |
| `system_prompt` | The app's prompt as text, up to 8000 characters. |
| `plugins` | Plugins by name, such as `["mcp", "charts"]`. Without it the app gets the site's defaults. |
| `data_hosts` | Other hosts the in-browser SQL may read. The hosts of the catalog and collection URLs are allowed without being listed. |

```json
{
  "title": "St. Louis open data",
  "catalog": "https://data.source.coop/tge-labs/st-louis-open-data-mirror/catalog.json",
  "collections": [
    {
      "url": "https://data.source.coop/tge-labs/st-louis-open-data-mirror/urban-development-and-planning/neighborhoods/collection.json",
      "display_name": "Neighborhoods",
      "visible": true,
      "tooltip": ["NHD_NAME"]
    }
  ],
  "plugins": ["mcp", "charts"],
  "system_prompt": "The data are the City of St. Louis open data mirror on source.coop."
}
```

The site sets everything else: the models (`llm`), the MCP servers and which plugin code loads. An uploaded `layers-input.json` keeps the settings above, turns glen's plugin URLs into names and drops the rest, and the builder lists what it dropped.

## Security

Every hosted app shares one web address, and on GitHub Pages that address also holds each visitor's saved key. An app config therefore cannot load a script: plugins are named, not linked, and the site decides what each name loads. Links that would run code (`javascript:` and the like) are removed from a config wherever they appear, and glen puts config text on the page as text, never as HTML. Published apps are reviewed in their pull request.

## Running your own site

The builder and its sites live in the [`hosted/`](https://github.com/SchmidtDSE/glen/tree/main/hosted) folder of the glen repository. A site is the output of `scripts/stage-hosted.sh` on any static server, with its own `hosted/deployment.json`: which plugins it offers and their options, the models, and whether it serves unlisted apps (`"allow_unlisted": false` serves only published ones). `hosted/k8s/` is the NRP site, which serves its models and MCP server through nginx with the keys added server-side, as in glen-template. See `hosted/README.md` for the details.
