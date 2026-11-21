/**
 * hex-tools.js — `add_hex_tile_layer` and `remove_hex_tile_layer`, shared by
 * the full app (map-tools.js) and glen core's hex plugin (core/plugins/hex.js,
 * SchmidtDSE/glen#445).
 *
 * A hex layer draws the H3 tile pyramid an SQL server built with
 * `register_hex_tiles`. Its colour scale comes from the tileset's
 * metadata.json, read by content hash: the value range per resolution, and
 * whether to spread the ramp on a log scale (`suggested_scale`, #481) unless
 * the call says otherwise. The full app reads it with fetch();
 * glen core passes a fetch that also answers geo-query-wasm's
 * `geoquerywasm:` URLs from the worker.
 */

import { metadataUrlFromTileUrl, HEX_SCALES } from './hex-layer-helpers.js';

/**
 * The scale for a hex layer (#481): the call's `scale` when it names one, else
 * the tileset's `suggested_scale` from metadata.json, else linear. The server
 * suggests log for right-skewed values (finest max over ten times the mean).
 * It never records the `color_scale` the agent gave `register_hex_tiles`,
 * which only restyles the recipe the server returns, so the agent repeats a
 * scale it wants here.
 */
export function chooseHexScale(requested, valueStats) {
    if (HEX_SCALES.includes(requested)) return requested;
    return valueStats?.suggested_scale === 'log' ? 'log' : 'linear';
}

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
// register_hex_tiles waits a few seconds for its build, then returns
// `status: "running"` with the tile URL already set; metadata.json exists only
// once the build is done, and a longer build can take minutes. So a missing
// metadata.json is waited for: with the server's get_hex_tile_status when the
// app has it, else by retrying a 404 or a 5xx for about ten seconds.
const METADATA_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 4000];
const BUILD_WAIT_SECONDS = 30;      // per get_hex_tile_status call, as its description advises
const BUILD_WAIT_ROUNDS = 10;       // about five minutes in all

/** The tileset's content hash, from a `…/tiles/hex/<hash>/{z}/{x}/{y}.pbf` URL. */
export function tilesetHash(tileUrl) {
    const m = String(tileUrl || '').match(/\/tiles\/hex\/([^/]+)\//);
    return m ? m[1] : null;
}

/**
 * Wait for a tileset's build with get_hex_tile_status, long-polling while it
 * reports "running".
 * @param {(args: Object) => Promise<string|Object>} callStatus - runs get_hex_tile_status
 * @returns {(hash: string) => Promise<{status: string, error?: string}>}
 */
export function hexBuildWaiter(callStatus, { rounds = BUILD_WAIT_ROUNDS, waitSeconds = BUILD_WAIT_SECONDS } = {}) {
    return async (hash) => {
        let last = { status: 'unknown' };
        for (let i = 0; i < rounds; i++) {
            let raw;
            try { raw = await callStatus({ hash, wait_seconds: waitSeconds }); } catch (err) { return { status: 'unknown', error: err.message }; }
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            try { last = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return { status: 'unknown' }; }
            if (last?.status !== 'running') return last;
        }
        return last;
    };
}

/** GET the tileset's metadata.json, retrying a 404 or a 5xx with backoff. */
async function fetchMetadata(fetchFn, url, delays = METADATA_RETRY_DELAYS_MS, first = null) {
    let resp = first || await fetchFn(url);
    for (const ms of delays) {
        if (resp?.ok || !(resp?.status === 404 || resp?.status >= 500)) break;
        await new Promise(r => setTimeout(r, ms));
        resp = await fetchFn(url);
    }
    return resp;
}

export async function resolveHexMetadata(args, fetchFn = globalThis.fetch, retryDelays = METADATA_RETRY_DELAYS_MS, waitForBuild = null, { geojson = null } = {}) {
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
    // Why the metadata could not be read, for the error below.
    let failure = null;
    if (metaUrl && typeof fetchFn === 'function') {
        try {
            let resp = await fetchFn(metaUrl);
            // A GeoJSON layer's file is already in hand and gives its own
            // range and bounds, so a missing metadata.json is not waited for:
            // its build is the producing tool's, not register_hex_tiles' (SchmidtDSE/glen#522).
            if (geojson) {
                if (!resp?.ok) { failure = `returned ${resp?.status ?? 'no response'}`; resp = null; }
            } else {
                const hash = tilesetHash(args.tile_url);
                // 404 today; 202 {"status":"running"} once geo-query answers that way
                // during a build (SchmidtDSE/geo-query#500).
                const building = resp?.status === 202 || resp?.status === 404;
                if (building && waitForBuild && hash) {
                    // Still building: wait for it, then read the metadata it writes.
                    const build = await waitForBuild(hash);
                    if (build?.status === 'running') {
                        return { error: `add_hex_tile_layer: the hex tiles for ${hash} are still being built after ${BUILD_WAIT_ROUNDS * BUILD_WAIT_SECONDS / 60} minutes. Call get_hex_tile_status with this hash, and add the layer once it reports done.` };
                    }
                    if (build?.status === 'failed' || build?.status === 'error') {
                        return { error: `add_hex_tile_layer: the hex tile build for ${hash} failed${build.error ? `: ${build.error}` : ''}.` };
                    }
                    resp = await fetchMetadata(fetchFn, metaUrl, retryDelays.slice(0, 2));
                } else if (!resp?.ok) {
                    resp = await fetchMetadata(fetchFn, metaUrl, retryDelays, resp);
                }
            }
            if (resp && !resp.ok) failure = `returned ${resp.status}`;
            if (resp?.ok && resp.status !== 202) {
                const meta = await resp.json();
                valueColumn = valueColumn || meta.value_columns?.[0];
                if (!isUsableStats(valueStats)) valueStats = meta.value_stats?.[valueColumn];
                if (!bounds) {
                    bounds = (Array.isArray(meta.bounds) && meta.bounds.length === 4) ? meta.bounds : undefined;
                }
                layerName = layerName || meta.layer_name;
            }
        } catch (err) {
            // fetch() throws on a network error and on a response the page
            // may not read (CORS); fall through to what the caller supplied.
            failure = `failed (${err?.message || err}): the host is unreachable, or does not let this page read it (CORS)`;
        }
    }

    // A GeoJSON layer fills what is still missing from its own features.
    if (geojson && (!valueColumn || !isUsableStats(valueStats) || !bounds)) {
        const derived = statsFromGeoJson(geojson, valueColumn);
        valueColumn = valueColumn || derived.valueColumn;
        if (!isUsableStats(valueStats)) valueStats = derived.valueStats;
        bounds = bounds || derived.bounds;
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
        const read = metaUrl
            ? `Reading ${metaUrl} ${failure || 'gave no usable values'}.`
            : 'The tile_url names no tileset to read them from.';
        return { error: `add_hex_tile_layer: could not resolve color-scale metadata (${missing}). ${read} `
            + `Check that the producing tool's tiles are reachable; do not make these values up.` };
    }
    return { valueColumn, valueStats, bounds, layerName };
}

/**
 * The value column, its range and the bounds of a GeoJSON hex layer, read
 * from its features when metadata.json cannot be (SchmidtDSE/glen#522). The
 * column is the one asked for, else the first numeric property. The features
 * carry one resolution and no `res`, so the range sits under a single key,
 * which is all the GeoJSON layer's flat ramp reads.
 * @param {Object} fc - a FeatureCollection
 * @param {string} [column]
 * @returns {{valueColumn?: string, valueStats?: Object, bounds?: number[]}}
 */
export function statsFromGeoJson(fc, column) {
    const features = fc?.features || [];
    const valueColumn = column || Object.entries(features.find(f => f?.properties)?.properties || {})
        .find(([, v]) => typeof v === 'number')?.[0];
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number') {
            box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]);
            box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]);
        } else c.forEach(walk);
    };
    for (const f of features) {
        walk(f?.geometry?.coordinates);
        const v = f?.properties?.[valueColumn];
        if (typeof v === 'number' && Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); sum += v; n++; }
    }
    return {
        valueColumn,
        valueStats: n ? { by_res: { 0: { min, max, mean: sum / n } } } : undefined,
        bounds: Number.isFinite(box[0]) ? box : undefined,
    };
}

/**
 * Read a GeoJSON hex layer's FeatureCollection, so a file the page cannot
 * read is reported rather than drawn blank after the tool says it succeeded
 * (SchmidtDSE/glen#522).
 * @returns {Promise<{geojson?: Object, error?: string}>}
 */
export async function readGeoJson(url, fetchFn) {
    const prefix = `add_hex_tile_layer: could not read geojson_url ${url}`;
    let resp;
    try {
        resp = await fetchFn(url);
    } catch (err) {
        return { error: `${prefix}: the request failed (${err?.message || err}). The host is unreachable, or does not let this page read it (CORS).` };
    }
    if (!resp?.ok) return { error: `${prefix}: it returned ${resp?.status ?? 'no response'}.` };
    let geojson;
    try { geojson = await resp.json(); } catch { return { error: `${prefix}: it is not JSON.` }; }
    if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        return { error: `${prefix}: it is not a GeoJSON FeatureCollection.` };
    }
    if (!geojson.features.length) return { error: `${prefix}: it has no features.` };
    return { geojson };
}

/**
 * The two hex tile tools.
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {Object} [options]
 * @param {Function} [options.fetchFn] - reads a tileset's metadata.json (default: fetch)
 * @param {number[]} [options.retryDelays] - waits, in ms, before retrying a 404 or 5xx
 * @param {Function} [options.waitForBuild] - from {@link hexBuildWaiter}: waits for
 *   a build still running when metadata.json is missing
 * @param {import('./live-hex.js').LiveHexLayers} [options.live] - with the controls
 *   plugin: add_hex_tile_layer also takes `sql`, and rebuilds the layer when a
 *   control its SQL uses changes (SchmidtDSE/glen#426)
 * @returns {Array<Object>} tool definitions
 */
export function createHexTileTools(mapManager, { fetchFn = (...a) => globalThis.fetch(...a), retryDelays = METADATA_RETRY_DELAYS_MS, waitForBuild = null, live = null } = {}) {
    const tools = [
        {
            name: 'add_hex_tile_layer',
            description: `Add an H3 hex tile layer to the map, on top of the layers already shown. Pass the tile_url that the MCP tool \`register_hex_tiles\` returned. When another tool's result supplies a ready argument object for this tool (such as a species distribution model's \`artifacts.map_layers\`), pass that object unchanged.

tile_url is the only required argument. value_stats, bounds and layer_name are fetched from the tile host by the tileset's content hash, so leave them out rather than copying them from register_hex_tiles' result.

register_hex_tiles layers use the default format="vector". format="geojson" and geojson_url come only from a producing tool that supplies a geojson_url. They are not in the fetched metadata, so without them that layer renders blank.

The result's \`scale\` is the scale actually drawn; report that one to the user.

The returned layer_id works with show_layer, hide_layer, set_style, set_filter, get_map_state and remove_hex_tile_layer.`,
            inputSchema: {
                type: 'object',
                properties: {
                    tile_url: { type: 'string', description: 'The exact tile URL template (.../tiles/hex/<key>/{z}/{x}/{y}.pbf) from register_hex_tiles or from the producing tool\'s ready argument object. Other URLs are rejected.' },
                    value_column: { type: 'string', description: 'Optional: which column from value_columns to style by (default: first; "count" for agg=COUNT)' },
                    value_stats: {
                        type: 'object',
                        description: 'Leave out: fetched by content hash.'
                    },
                    bounds: {
                        type: 'array',
                        items: { type: 'number' },
                        description: 'Leave out: fetched by content hash.'
                    },
                    layer_name: { type: 'string', description: 'Leave out: fetched by content hash.' },
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
                    scale: {
                        type: 'string',
                        enum: HEX_SCALES,
                        description: 'How color (and height when extruded) spreads over the values. Omit to use the tileset\'s suggested_scale, or pass the color_scale you gave register_hex_tiles, which this tool does not see.'
                    },
                },
                required: ['tile_url'],
            },
            execute: async (args) => {
                let geojson = null;
                if (args.format === 'geojson') {
                    if (!args.geojson_url) return JSON.stringify({ success: false, error: 'format "geojson" requires geojson_url from the producing tool\'s result' });
                    const read = await readGeoJson(args.geojson_url, fetchFn);
                    if (read.error) return JSON.stringify({ success: false, error: read.error });
                    geojson = read.geojson;
                }
                const meta = await resolveHexMetadata(args, fetchFn, retryDelays, waitForBuild, { geojson });
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
                    geojsonData: geojson,
                    extrude: args.extrude === true,
                    extrudeMaxHeight: args.extrude_max_height,
                    scale: chooseHexScale(args.scale, meta.valueStats),
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
            execute: (args) => {
                const res = mapManager.removeHexTileLayer(args.layer_id);
                if (res.success) live?.untrack(args.layer_id);
                return JSON.stringify(res);
            },
        },
    ];
    if (live) addLiveHex(tools[0], live);
    return tools;
}

/**
 * Let add_hex_tile_layer take the SQL instead of a tile URL: glen registers
 * the tiles itself, and rebuilds them when a control the SQL uses changes.
 */
function addLiveHex(tool, live) {
    tool.description += `

Live hex layers: instead of tile_url, pass \`sql\` (the SELECT you would give register_hex_tiles; it may use the controls' {{TOKEN}}s), \`agg\` and a \`layer_id\`. This tool registers the tiles itself and builds them again whenever the reader changes a control the SQL uses, so the map follows the settings as a chart does. Call again with the same layer_id to replace its SQL or styling.`;
    const props = tool.inputSchema.properties;
    props.tile_url.description += ' Omit it when you pass sql.';
    props.sql = { type: 'string', description: 'Live layer: the register_hex_tiles SELECT (first column an H3 index), which may use {{TOKEN}}s. Replaces tile_url.' };
    props.agg = { type: 'string', enum: ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COUNT_DISTINCT'], description: 'Live layer: register_hex_tiles\' aggregation (default COUNT).' };
    props.layer_id = { type: 'string', description: 'Live layer: its id (letters, digits, "_" and "-"); the layer is drawn as hex-<layer_id>.' };
    tool.inputSchema.required = [];
    const execute = tool.execute;
    tool.execute = async (args = {}) => {
        if (args.sql) return JSON.stringify(await live.add(args));
        if (!args.tile_url) return JSON.stringify({ success: false, error: 'Pass tile_url from register_hex_tiles, or sql and layer_id for a live layer.' });
        return execute(args);
    };
}
