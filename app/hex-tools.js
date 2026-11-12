/**
 * hex-tools.js — `add_hex_tile_layer` and `remove_hex_tile_layer`, shared by
 * the full app (map-tools.js) and glen core's hex plugin (core/plugins/hex.js,
 * SchmidtDSE/glen#445).
 *
 * A hex layer draws the H3 tile pyramid an SQL server built with
 * `register_hex_tiles`. Its colour scale comes from the tileset's
 * metadata.json, read by content hash. The full app reads it with fetch();
 * glen core passes a fetch that also answers geo-query-wasm's
 * `geoquerywasm:` URLs from the worker.
 */

import { metadataUrlFromTileUrl } from './hex-layer-helpers.js';

/**
 * Whether a value_stats object is usable for building a hex color ramp (#276):
 * an object with a non-empty `by_res` map.
 */
function isUsableStats(vs) {
    return !!(vs && typeof vs === 'object' && vs.by_res && Object.keys(vs.by_res).length > 0);
}

/**
 * Resolve a hex layer's color-scale metadata (value_column, value_stats, bounds,
 * layer_name) for add_hex_tile_layer (#276).
 *
 * The server already computed these and serves them by content hash, so the LLM
 * should not have to transcribe the large value_stats blob into tool args (where
 * weak models corrupt it — the failure that reopened #276). This prefers usable
 * values the caller supplied, otherwise fetches the sidecar
 * (metadataUrlFromTileUrl) and fills the gaps. If the fetch fails it uses
 * whatever the caller did supply, and returns `{ error }` only when neither
 * source yields the fields the renderer needs — never a silent blank layer.
 */
async function resolveHexMetadata(args, fetchFn = globalThis.fetch) {
    let valueColumn = args.value_column;
    let valueStats = args.value_stats;
    let bounds = (Array.isArray(args.bounds) && args.bounds.length === 4) ? args.bounds : undefined;
    let layerName = args.layer_name;

    // Fast path: the caller already supplied everything the renderer needs — no
    // network round-trip, and back-compat for manual/programmatic callers.
    if (isUsableStats(valueStats) && bounds && valueColumn) {
        return { valueColumn, valueStats, bounds, layerName };
    }

    const metaUrl = metadataUrlFromTileUrl(args.tile_url);
    if (metaUrl && typeof fetchFn === 'function') {
        try {
            const resp = await fetchFn(metaUrl);
            if (resp.ok) {
                const meta = await resp.json();
                valueColumn = valueColumn || meta.value_columns?.[0];
                if (!isUsableStats(valueStats)) valueStats = meta.value_stats?.[valueColumn];
                if (!bounds) {
                    bounds = (Array.isArray(meta.bounds) && meta.bounds.length === 4) ? meta.bounds : undefined;
                }
                layerName = layerName || meta.layer_name;
            }
        } catch { /* fall through to whatever the caller supplied */ }
    }

    // One clear error covering any remaining gap — never a silent blank layer.
    // All three gaps share a root cause: the by-hash fetch didn't deliver and
    // nothing usable was passed explicitly.
    if (!valueColumn || !isUsableStats(valueStats) || !bounds) {
        const missing = [
            !valueColumn && 'value_column',
            !isUsableStats(valueStats) && 'value_stats',
            !bounds && 'bounds',
        ].filter(Boolean).join(', ');
        return { error: `add_hex_tile_layer: could not resolve color-scale metadata (${missing}). `
            + `These are normally fetched from ${metaUrl || 'the tile host'} by content hash; that fetch `
            + `returned nothing usable (ensure the tile host serves metadata.json — mcp-data-server >= v0.8.6), `
            + `and no usable values were passed explicitly.` };
    }
    return { valueColumn, valueStats, bounds, layerName };
}

/**
 * The two hex tile tools.
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {Object} [options]
 * @param {Function} [options.fetchFn] - reads a tileset's metadata.json (default: fetch)
 * @returns {Array<Object>} tool definitions
 */
export function createHexTileTools(mapManager, { fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
    return [
        {
            name: 'add_hex_tile_layer',
            description: `Add a dynamic H3 hex tile layer to the map as an ADDITIVE overlay. Hex layers do not replace existing layers — they sit on top, and existing polygon/raster layers stay visible beneath. Use after calling the MCP \`register_hex_tiles\` tool, which returns a tile URL template + bounds + value columns + per-resolution value stats, or with a ready argument object that another tool's result supplies for this tool (e.g. a species distribution model's \`artifacts.map_layers\`).

Common use cases:
  - Dense point data aggregated per hex (e.g. GBIF occurrence counts per h8 cell).
  - Polygon datasets summarized per hex (e.g. feature count or average attribute).
  - Pre-computed per-cell values (density rasters, model outputs).

Flow (register_hex_tiles):
  1. Call \`register_hex_tiles\` (MCP) with SQL that returns (h3_index [, value1, ...]).
  2. Pass the returned \`tile_url\` to this tool. That is the ONLY required field.
     The color-scale metadata (value_stats, bounds, value_column, layer_name) is
     fetched automatically from the tile host by content hash — do NOT copy the
     \`value_stats\` blob or \`bounds\` array into this call. Transcribing that large
     nested object is error-prone and unnecessary; the server already has it.

Optional inputs:
  - value_column          which value_columns entry to color by (default: first; "count" for agg=COUNT)
  - palette / opacity / display_name / fit_bounds    styling (see below)
  - extrude               true → 3D extruded hexes (value → height + color) and a tilted camera (default false)
  - value_stats / bounds / layer_name    accepted as explicit overrides, but normally OMIT — they are fetched
  - format                ← format ("geojson" or "vector"; defaults to "vector")
  - geojson_url           ← geojson_url (REQUIRED when format="geojson"; ignored otherwise)

register_hex_tiles always builds a vector tile pyramid, so its layers use the default format="vector". format="geojson" is for layers whose producing tool supplies a geojson_url (a single FeatureCollection) — currently the species distribution model's \`artifacts.map_layers\`. When a tool result hands you a ready argument object for add_hex_tile_layer, pass it unchanged: format and geojson_url are NOT in the fetched sidecar, and without them the \`.pbf\` tile_url 404s and the layer renders blank.

Hexes get finer as the user zooms in: the tile server's pyramid serves the appropriate H3 resolution for each zoom level automatically (vector format only). If the user wants a coarser overall view, re-run \`register_hex_tiles\` with the SQL projected to a coarser resolution by wrapping the first column in \`h3_cell_to_parent(<h3_col>, <target_res>)\` — the server auto-detects the H3 resolution from that column.

IMPORTANT: tile_url must be the exact tile URL template the producing tool returned (\`.../tiles/hex/<key>/{z}/{x}/{y}.pbf\`) — the tool rejects other URLs. It supplies the layer's content hash for both formats (the GeoJSON layer still keys off it).

The returned layer_id can be used with show_layer / hide_layer / set_style / set_filter / get_map_state like any other vector layer, and with remove_hex_tile_layer to free the source.`,
            inputSchema: {
                type: 'object',
                properties: {
                    tile_url: { type: 'string', description: 'tile URL template from register_hex_tiles (tile_url_template) or from the producing tool\'s ready argument object — the ONLY required field' },
                    value_column: { type: 'string', description: 'Optional: which column from value_columns to style by (default: first; "count" for agg=COUNT)' },
                    value_stats: {
                        type: 'object',
                        description: 'Optional override — normally OMIT. Fetched automatically by content hash. Shape if passed: { by_res: { "<res>": { min, max } } }.'
                    },
                    bounds: {
                        type: 'array',
                        items: { type: 'number' },
                        description: 'Optional override — normally OMIT. Fetched automatically. [w, s, e, n].'
                    },
                    layer_name: { type: 'string', description: 'Optional override — normally OMIT. Fetched automatically (defaults to "layer"; ignored for format="geojson").' },
                    format: {
                        type: 'string',
                        enum: ['vector', 'geojson'],
                        description: '"vector" (default; all register_hex_tiles layers) reads MVT tiles from tile_url; "geojson" reads the whole FeatureCollection from geojson_url, for tools that supply one.'
                    },
                    geojson_url: { type: 'string', description: 'FeatureCollection URL from the producing tool\'s result — REQUIRED when format="geojson"' },
                    display_name: { type: 'string', description: 'Optional human-readable layer name (default: "Hex: <value_column>")' },
                    palette: {
                        type: 'string',
                        enum: ['viridis', 'ylorrd', 'bluered'],
                        description: 'Color ramp: viridis (sequential default), ylorrd (warm sequential), bluered (diverging)'
                    },
                    opacity: { type: 'number', description: 'Fill opacity 0..1 (default 0.7)' },
                    fit_bounds: { type: 'boolean', description: 'Fly the camera to fit bounds (default true)' },
                    extrude: { type: 'boolean', description: 'Render as 3D extruded hexes — value encoded as height as well as color — and tilt the camera. Default false (flat 2D fill). Use when the user asks for a 3D / extruded / "height" view.' },
                    extrude_max_height: { type: 'number', description: 'Optional height (metres) of the tallest hex when extrude=true. Omit for an auto default scaled to the data extent.' },
                },
                required: ['tile_url'],
            },
            execute: async (args) => {
                const meta = await resolveHexMetadata(args, fetchFn);
                if (meta.error) return JSON.stringify({ success: false, error: meta.error });
                const displayName = args.display_name || `Hex: ${meta.valueColumn}`;
                const result = mapManager.addHexTileLayer({
                    tileUrl: args.tile_url,
                    valueColumn: meta.valueColumn,
                    valueStats: meta.valueStats,
                    bounds: meta.bounds,
                    palette: args.palette || 'viridis',
                    opacity: args.opacity ?? 0.7,
                    displayName,
                    fitBounds: args.fit_bounds !== false,
                    layerName: meta.layerName,
                    format: args.format,
                    geojsonUrl: args.geojson_url,
                    extrude: args.extrude === true,
                    extrudeMaxHeight: args.extrude_max_height,
                });
                return JSON.stringify(result);
            },
        },

        {
            name: 'remove_hex_tile_layer',
            description: `Remove a dynamic hex tile layer previously added via add_hex_tile_layer. Takes a layer_id like "hex-<hash>". Refuses to touch non-hex layers (any id not starting with "hex-"), so curated layers are safe.

Use when the agent is iterating — e.g. user asks to replace one hex analysis with another.`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Hex layer ID, starting with "hex-"' },
                },
                required: ['layer_id'],
            },
            execute: (args) => JSON.stringify(mapManager.removeHexTileLayer(args.layer_id)),
        },
    ];
}
