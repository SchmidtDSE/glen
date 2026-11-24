# Upgrading to v4

In v4, glen is glen core (`core/main.js`) and its plugins. The v3 full app (`app/main.js`) was deleted in v4.0.0 (SchmidtDSE/glen#441). This page lists everything an app has to change to move from v3 to the current v4 release. It collects the steps from the v4.0.0 to v4.0.5 release notes in one place.

An app pinned to a v3 tag keeps working as it is, because jsDelivr serves each tag unchanged. v3 fixes go to the `release-v3.x` branch. Move an app to v4 when you are ready to test it.

## Conversion

`scripts/convert-to-core.mjs` converts an app's `layers-input.json` and `index.html`. Run it from a clone of glen, using the latest v4 tag:

```bash
node scripts/convert-to-core.mjs layers-input.json --ref v4.5.0 > layers-input.core.json
node scripts/convert-to-core.mjs index.html --ref v4.5.0 > index.core.html
```

The script prints a note for every key it moved or dropped. Read them before you replace the old files.

In `index.html`, the module script loads `core/main.js` in place of `app/main.js`, and every glen URL moves to the new tag, including URLs that still name `boettiger-lab/geo-agent`. From v4.5.0, glen core adds MapLibre, PMTiles, h3-js, marked, DOMPurify, highlight.js and glen's stylesheets itself, so the converter removes their tags, with the comment just before each, and the MCP SDK's import map, which v4 does not use. A note names each one it removed. For an earlier tag it keeps them, since those releases need them. Comments elsewhere in the page that describe the old tags are left for you to edit. The same command moves a page already on glen core to a newer tag.

In `layers-input.json`, collections and their layer settings carry over unchanged, because glen core reads them by the same names. The opt-in features become plugins, described in the next section.

The deploy-time `config.json` needs no change. glen core reads `llm_models`, `llm_model`, `transcription_model`, `export`, `geolocate` and the tool-call limits from it, as v3 did. The MCP plugin takes `mcp_server_url` and `mcp_auth_token` from it for the first server.

## Plugins

Every feature beyond the map and its tools is now a plugin. An app lists the plugins it uses in `plugins`, loaded from jsDelivr at the same tag as `core/main.js`. A feature that is not listed is absent. See [Plugins](./configuration#plugins) for each one's options.

| v3 setting | v4 plugin |
|---|---|
| `mcp_url`, `mcp_servers`, or neither | `plugins/mcp.js`. Every v3 app had an MCP server, `duckdb-mcp.nrp-nautilus.io` when it named none, so the converter always adds it with the `geospatial-analyst` prompt. |
| Hex tile tools, always on in v3 | `plugins/hex.js`, always added by the converter |
| `charts` | `plugins/charts.js` |
| `draw_enabled` | `plugins/draw.js` |
| `upload_enabled` and `upload` | `plugins/uploads.js`, with the same settings as its options |
| `geolocate` | `plugins/geolocate.js`, with the same settings as its options |

A `draw_enabled` set only in the deploy-time `config.json` has no effect in v4. List `plugins/draw.js` in `layers-input.json` instead.

The hex grid button, the geocoder search box (`geocoder.search_box`) and the data sources page are part of glen core and need no plugin.

## Settings that changed

| Setting | In v4 |
|---|---|
| `export` | Off unless set. v3 offered the session export by default, so the converter writes `"export": true` unless the app had turned it off. |
| `catalog_index_threshold` | Dropped. glen core's prompt is always the compact index: each collection's id, title and one-sentence summary, and each layer's id and name. `describe_layer` gives a layer's properties, styles, statistics, source and license; `get_schema` gives a collection's columns and data files. |
| `client_header_hosts` | Dropped. glen-harness sends the client header itself. |
| `tool_memo` | Dropped. |
| A collection's `preload` | Dropped. No collection's columns are in the prompt; `get_schema` and `describe_layer` give them on demand. |

## Behaviour changes

The system prompt starts with glen core's short base prompt, then the app's own prompt, then the layer list and the plugins' sections. The layer list names collections and layers only; their columns, styles and data files come from `describe_layer` and `get_schema`. The app's prompt is `system_prompt_url`, or `system-prompt.md` beside the page as in v3. Tool descriptions now say what each tool does, so an app's prompt should describe the app and its data and leave the tools to their descriptions.

The agent, chat and session export come from [glen-harness](https://github.com/SchmidtDSE/glen-harness), which glen core loads at a release tag. `app/mcp-client.js`, the vendored MCP SDK and `SQL_HINTS` in `app/map-control-tools.js` were removed.

Map layer ids are `layer-<layerId>`, with the layer id unchanged. v3 replaced characters such as `/` with `-`. Nothing in glen reads these ids, but code outside glen that looks up a map layer by the old form needs the new one.

Two collections that share an id no longer replace one another. The later one gets a numbered id such as `roads-2`, with a warning in the console. Give each an `id` to choose the names yourself.

`set_filter` converts a filter's values to each field's type in the tiles. A filter that compared a number field with a string, and so matched nothing in v3, now matches.

## Apps converted with v4.0.0 or v4.0.1

The converter in those releases missed two settings. An app converted with them needs two edits to match v3:

- If the app set `geolocate`, add `plugins/geolocate.js` to `plugins`.
- Add `"export": true` unless the app had turned the export off.

The hex grid, the geocoder search box and the position of the export button were restored in later releases and need no config change.

## Checking a converted app

Open the converted app beside the v3 one and compare their layers, legends and styles. Then ask each the same few questions and compare the tools the agent calls and the answers it gives. If anything is missing, file an issue in [SchmidtDSE/glen](https://github.com/SchmidtDSE/glen/issues) that names the app and its v3 tag.
