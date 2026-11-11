import { validateChartSpec } from './chart-renderer.js';
import { metadataUrlFromTileUrl } from './hex-layer-helpers.js';
import { legendFromPaint } from './legend-helpers.js';
import { describeColor } from '../core/portolan.js';
import {
    createMapControlTools,
    createProjectionTool,
    PICK_LAYER_NUDGE,
    SQL_HINTS,
} from './map-control-tools.js';

// Re-exported so existing importers keep resolving it here.
export { getCurrentPositionAsync } from './map-control-tools.js';

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
async function resolveHexMetadata(args) {
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
    if (metaUrl && typeof fetch === 'function') {
        try {
            const resp = await fetch(metaUrl);
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
 * Map Tools - Local tool definitions for the LLM agent
 *
 * Defines the tools the agent uses to control the map and query dataset metadata.
 * Each tool has: name, description, inputSchema, execute function.
 * 
 * Tools:
 *   Map control:
 *     - show_layer / hide_layer
 *     - set_filter / clear_filter
 *     - set_style / reset_style
 *     - get_map_state
 *     - fly_to
 *   Dataset knowledge:
 *     - list_datasets (get_schema and get_stac_details are in catalog-tools.js)
 */

/**
 * Parse a JSON array from DuckDB MCP query result text.
 * DuckDB may wrap the array in a markdown table or plain text — we extract
 * by finding the first '[' and last ']' in the response.
 *
 * @param {string} text
 * @returns {Array|null}
 */
export function extractJsonArray(text) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * Generate all local tools given the app's MapManager and DatasetCatalog.
 *
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {import('./dataset-catalog.js').DatasetCatalog} catalog
 * @param {import('./mcp-client.js').MCPClient} [mcpClient]
 * @param {{ forwardGeocode: Function }} [geocoder] - optional geocoder backend (see geocoder.js)
 * @param {{ geolocateTool?: boolean }} [options] - opt-in flags for privacy-sensitive tools
 * @returns {Array<Object>} Tool definitions
 */
export function createMapTools(mapManager, catalog, mcpClient, geocoder, options = {}) {
    // The live layer roster is injected once into the system prompt via
    // DatasetCatalog.generatePromptCatalog() (richer: id + title + type +
    // versions + default filters). Tool descriptions deliberately do NOT
    // re-embed it — that was N copies of a strict subset of the same list,
    // frozen at boot and redundant with the catalog (#225). pickLayerNudge
    // stays per-tool: it's the disambiguation rule, not the list.
    const pickLayerNudge = PICK_LAYER_NUDGE;

    return [
        ...createMapControlTools(mapManager, { geocoder, geolocateTool: options.geolocateTool, hints: SQL_HINTS }),

        // ---- Dynamic Hex Tile Layers ----
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
                const meta = await resolveHexMetadata(args);
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

        // ---- Query-driven Filter Tool ----
        ...(mcpClient ? [{
            name: 'filter_by_query',
            description: `Filter a vector layer to features whose ID property matches the results of a SQL query — without passing thousands of IDs through the LLM.

Use this instead of set_filter when:
- The matching set comes from an MCP SQL query (e.g. "show parcels inside protected areas", "highlight counties above median income")
- The result set could be large (hundreds to tens of thousands of features)

How it works:
1. Executes your SQL via the MCP query tool
2. Extracts the ID column
3. Applies a MapLibre filter programmatically — IDs never pass through the LLM output

Parameters:
- layer_id: the vector layer to filter (must already be loaded)
- sql: a SELECT query returning ONE column — the feature ID values to keep. Alias that column to match id_property exactly. Example: SELECT GEOID FROM read_parquet('s3://...') WHERE ...
- id_property: the property name in the vector tile features to match against. Check get_stac_details for the correct column — CNG-processed datasets use "_cng_fid"; source datasets vary (e.g. "OBJECTID", "HOLDING_ID").

IMPORTANT: The sql must return only the id column — no extra columns. Write it as a plain SELECT, not wrapped in array_agg.

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID to filter' },
                    sql: { type: 'string', description: 'SELECT query returning a single column of ID values to keep' },
                    id_property: { type: 'string', description: 'Feature property name in the vector tile to match against — check get_stac_details (CNG-processed datasets use "_cng_fid"; source datasets vary)' },
                },
                required: ['layer_id', 'sql', 'id_property'],
            },
            execute: async (args) => {
                if (!mcpClient) return JSON.stringify({ success: false, error: 'MCP client not available' });

                // Wrap user SQL to aggregate non-null IDs into a JSON array via DuckDB.
                // to_json() is required because DuckDB's native array display format
                // (space-separated, no commas — e.g. "[ 1  2  3]") is not valid JSON,
                // so without it the extractJsonArray() call below fails to parse.
                const col = args.id_property;
                // col is quoted into wrappedSql — restrict to plain identifier chars.
                if (!/^[A-Za-z0-9_]+$/.test(col || '')) {
                    return JSON.stringify({
                        success: false,
                        error: `Invalid id_property "${col}" — must contain only letters, digits, or underscores. Check get_stac_details for the feature ID column name.`,
                    });
                }
                const wrappedSql = `SELECT to_json(array_agg("${col}") FILTER (WHERE "${col}" IS NOT NULL)) AS ids FROM (${args.sql}) _filter_subquery`;

                let rawResult;
                try {
                    rawResult = await mcpClient.callTool('query', { sql_query: wrappedSql });
                } catch (err) {
                    return JSON.stringify({ success: false, error: `SQL execution failed: ${err.message}` });
                }

                // DuckDB returns NULL (not []) when no rows match — treat as empty
                if (!rawResult || /\bnull\b/i.test(rawResult.trim().replace(/.*\n/, ''))) {
                    return JSON.stringify({ success: true, idCount: 0, featuresInView: 0, message: 'Query matched no features — filter not applied.' });
                }

                const ids = extractJsonArray(rawResult);
                if (!ids) {
                    return JSON.stringify({
                        success: false,
                        error: `Could not parse ID list from query result. Check that id_property ("${col}") exactly matches the column name in the SQL output — verify via get_stac_details (CNG-processed datasets use "_cng_fid"). Raw: ${rawResult.substring(0, 300)}`
                    });
                }
                if (ids.length === 0) {
                    return JSON.stringify({ success: true, idCount: 0, featuresInView: 0, message: 'Query matched no features — filter not applied.' });
                }

                const filter = ['in', ['get', col], ['literal', ids]];
                const result = mapManager.setFilter(args.layer_id, filter);
                return JSON.stringify({ ...result, idCount: ids.length });
            },
        }] : []),

        // ---- Dataset Knowledge Tools ----
        // get_schema and get_stac_details live in catalog-tools.js (#441).
        {
            name: 'list_datasets',
            description: 'List all dataset IDs and titles pre-loaded for this app. Paths are in your system prompt; call `get_schema` for column details.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: () => {
                const datasets = catalog.getAll().map(ds => ({
                    id: ds.id,
                    title: ds.title,
                }));
                return JSON.stringify({ success: true, datasets });
            },
        },

        createProjectionTool(mapManager),

        ...createApplyStyleTool(mapManager, catalog, pickLayerNudge),
    ];
}

/**
 * Build the opt-in `render_chart` tool (#277). Registered only when an app
 * sets `charts.enabled` — so apps that don't want charts pay no footprint and
 * the LLM never sees the tool.
 *
 * @param {{ render: Function }} chartRenderer — a ChartRenderer instance
 * @param {import('./mcp-client.js').MCPClient} [mcpClient] — for the `sql` path
 * @returns {Object} a tool definition (name/description/inputSchema/execute)
 */
/**
 * Run a SELECT (already wrapped to emit `to_json(array_agg(...))`) through MCP
 * and return its rows as a parsed array. Shared marshalling for the chart
 * tool: DuckDB's array_agg over zero rows yields SQL NULL (no brackets), so an
 * empty result is reported as `{ ok: true, rows: [] }`, not a parse failure.
 *
 * @returns {Promise<{ok:true, rows:Array}|{ok:false, error:string}>}
 */
async function runJsonArrayQuery(mcpClient, wrappedSql) {
    let raw;
    try {
        raw = await mcpClient.callTool('query', { sql_query: wrappedSql });
    } catch (err) {
        return { ok: false, error: `SQL execution failed: ${err.message}` };
    }
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text || /\bnull\b/i.test(text.trim().replace(/.*\n/, ''))) {
        return { ok: true, rows: [] };
    }
    const rows = extractJsonArray(text);
    if (!rows) {
        return { ok: false, error: `Could not parse rows from query result. Raw: ${text.substring(0, 300)}` };
    }
    return { ok: true, rows };
}

export function createRenderChartTool(chartRenderer, mcpClient) {
    return {
        name: 'render_chart',
        description: `Render query results as a chart in a floating panel. Use when a table or map can't show the shape of the data — e.g. "plot the top 10 countries", "show the distribution", "chart the trend over years".

Chart types:
- bar: ranking / category comparison (x = category, y = value)
- line: time series / trend (x = ordered field e.g. year, y = value)
- scatter: relationship / trade-off (x, y = two numerics)
- histogram: distribution of one numeric (x = the value; bars are counts — omit y)

Provide the data ONE of two ways (if you pass both, sql wins):
- data: an array of row objects you already have, e.g. [{"country":"Brazil","pct":31}, ...]. Best for small, already-aggregated results.
- sql: a SELECT the panel runs itself (rows never pass through the LLM). Best for larger results. Write a plain SELECT — do NOT wrap it in array_agg/to_json.

x / y name the columns to plot; series (optional) splits/colors by a column. Keep result sets small (≈ a few hundred rows max).`,
        inputSchema: {
            type: 'object',
            properties: {
                chart_type: { type: 'string', enum: ['bar', 'line', 'scatter', 'histogram'], description: 'Chart type' },
                title: { type: 'string', description: 'Chart title shown on the panel' },
                data: { type: 'array', items: {}, description: 'Array of row objects to plot. Provide this OR sql.' },
                sql: { type: 'string', description: 'A plain SELECT the panel runs to get rows. Provide this OR data.' },
                x: { type: 'string', description: 'Column for the x axis (category for bar, the value for histogram)' },
                y: { type: 'string', description: 'Column for the y axis (numeric). Omit for histogram.' },
                series: { type: 'string', description: 'Optional column to split/color multiple series' },
                x_label: { type: 'string', description: 'Optional x-axis label (defaults to the x column name)' },
                y_label: { type: 'string', description: 'Optional y-axis label' },
            },
            required: ['chart_type', 'x'],
        },
        execute: async (args) => {
            // Reject a bad spec cheaply, before paying for any SQL round-trip.
            try {
                validateChartSpec(args);
            } catch (err) {
                return JSON.stringify({ success: false, error: err.message });
            }

            let rows;
            if (args.sql) {
                // sql is authoritative when both are supplied — never silently
                // chart a partial inline sample while ignoring the full query.
                if (!mcpClient) return JSON.stringify({ success: false, error: 'MCP client not available for the sql path — pass data instead.' });
                // Aggregate full rows to a JSON array via DuckDB. to_json() is
                // required: DuckDB's native list display is not valid JSON.
                const wrappedSql = `SELECT to_json(array_agg(_chart_rows)) AS rows FROM (${args.sql}) _chart_rows`;
                const res = await runJsonArrayQuery(mcpClient, wrappedSql);
                if (!res.ok) return JSON.stringify({ success: false, error: res.error });
                rows = res.rows;
            } else if (Array.isArray(args.data)) {
                rows = args.data;
            }

            if (!rows || rows.length === 0) {
                return JSON.stringify({
                    success: false,
                    error: args.sql
                        ? 'Query returned no rows — nothing to chart.'
                        : 'No data to chart — provide a non-empty `data` array or a `sql` query that returns rows.',
                });
            }

            try {
                const { id } = await chartRenderer.render(args, rows);
                return JSON.stringify({ success: true, chart_id: id, chart_type: args.chart_type, title: args.title || null, points: rows.length });
            } catch (err) {
                return JSON.stringify({ success: false, error: `Could not render chart: ${err.message}` });
            }
        },
    };
}

/**
 * Build the `set_time` tool for raster time series (#421). Registered only
 * when the app has a layer with a frame control, so other apps' prompts carry
 * no extra schema.
 *
 * @param {import('./map-manager.js').MapManager} mapManager
 * @returns {Object} a tool definition
 */
export function createSetTimeTool(mapManager) {
    return {
        name: 'set_time',
        description: `Set the date shown by a time-series raster layer, choose which dates it plays, and start or stop playback. Time-series layers report a \`timeSeries\` block in get_map_state, with the date on screen and the first and last dates available.

Use it when the user asks for a date ("show SST anomaly on 1 March"), a period ("animate the last three months", "play 2015 to 2016"), a speed, or to stop the animation.

- date: jump to the frame nearest this date (YYYY-MM-DD, or YYYY-MM for monthly series).
- start / end: the first and last dates to play. Giving either replaces the layer's configured window.
- step: play every Nth frame (e.g. 4 for every fourth day). The most recent frame is always kept.
- frame_ms: how long each frame is shown, in milliseconds.
- play: true to start playback, false to stop.

The layer is shown if it is hidden. The result gives the date on screen and the range now playing; report those rather than the dates you asked for, since a date snaps to the nearest available frame.`,
        inputSchema: {
            type: 'object',
            properties: {
                layer_id: { type: 'string', description: 'Time-series raster layer ID' },
                date: { type: 'string', description: 'Date to show, YYYY-MM-DD or YYYY-MM' },
                start: { type: 'string', description: 'First date to play' },
                end: { type: 'string', description: 'Last date to play' },
                step: { type: 'integer', description: 'Play every Nth frame' },
                frame_ms: { type: 'integer', description: 'Milliseconds each frame is shown' },
                play: { type: 'boolean', description: 'true to start playback, false to stop' },
            },
            required: ['layer_id'],
        },
        execute: async (args) => JSON.stringify(await mapManager.setTime(args)),
    };
}

/**
 * `apply_style` (#440): switch a vector layer to one of the styles its
 * collection publishes. Registered only when some layer has published styles,
 * so an app without them keeps its tool list.
 */
export function createApplyStyleTool(mapManager, catalog, pickLayerNudge = PICK_LAYER_NUDGE) {
    const any = catalog.getAll?.().some(ds => ds.mapLayers?.some(ml => ml.publishedStyles?.length));
    if (!any) return [];
    return [{
        name: 'apply_style',
        description: `Apply one of the styles the data publisher made for a vector layer: its colours, outline, filter and legend together. The system prompt lists each layer's published styles and what each colours by. Prefer a published style over writing your own paint with set_style when one matches the request. reset_style returns to the layer's starting look.

${pickLayerNudge}`,
        inputSchema: {
            type: 'object',
            properties: {
                layer_id: { type: 'string', description: 'Vector layer' },
                style: { type: 'string', description: 'Published style name, as listed in the system prompt' },
            },
            required: ['layer_id', 'style'],
        },
        execute: (args) => JSON.stringify(applyPublishedStyle(mapManager, catalog, args.layer_id, args.style)),
    }];
}

/** Apply a layer's published style by name (or asset key). */
export function applyPublishedStyle(mapManager, catalog, layerId, name) {
    const hit = catalog.findMapLayer?.(layerId);
    if (!hit) return { success: false, error: `Unknown layer: ${layerId}` };
    const styles = hit.layer.publishedStyles || [];
    if (!styles.length) return { success: false, error: `${layerId} has no published styles; use set_style.` };
    const st = styles.find(s => s.name === name || s.key === name);
    if (!st) {
        return { success: false, error: `No style "${name}" for ${layerId}. Published styles: ${styles.map(s => s.name).join(', ')}` };
    }
    const state = mapManager.layers?.get?.(layerId);
    const drawnAs = mapManager.map?.getLayer?.(state?.mapLayerId)?.type || hit.layer.renderType || 'fill';
    if (st.renderType !== drawnAs) {
        return { success: false, error: `Style "${st.name}" draws ${st.renderType} layers but ${layerId} is drawn as ${drawnAs}.` };
    }
    const result = mapManager.applyPublishedStyle(layerId, {
        paint: st.paint, outlinePaint: st.outlinePaint, filter: st.filter, ...legendFromPaint(st.paint),
    });
    if (!result.success) return result;
    return { success: true, layer: layerId, style: st.name, colours_by: describeColor(st.paint) };
}
