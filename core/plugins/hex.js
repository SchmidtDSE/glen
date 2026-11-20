/**
 * hex.js — glen core plugin: H3 hex tile layers (SchmidtDSE/glen#445), as the
 * full app's `add_hex_tile_layer` and `remove_hex_tile_layer`.
 *
 * The agent builds a tile pyramid with an SQL server's `register_hex_tiles`
 * (from plugins/mcp.js) and draws it with `add_hex_tile_layer`. Two kinds of
 * server work:
 *
 *   - duckdb-mcp serves tiles and metadata.json over https; nothing more is
 *     needed.
 *   - geo-query-wasm, run in a Web Worker by plugins/mcp.js, keeps the
 *     pyramid in the browser and returns `geoquerywasm://…` URLs. This plugin
 *     then registers geo-query-wasm's MapLibre protocol for those tiles and
 *     reads their metadata.json through the worker. Both reach the worker
 *     through the client that registered `register_hex_tiles`, looked up when
 *     a tile is read, so the order of the plugins in the config does not
 *     matter.
 *
 *   "plugins": [{ "url": "…/core/plugins/mcp.js", "options": { … } },
 *               { "url": "…/core/plugins/hex.js", "options": { "geo_query_wasm": "v0.6.0" } }]
 *
 * `geo_query_wasm` is the geo-query-wasm release whose hex protocol module
 * to load, when a worker server is configured; match the worker's.
 *
 * With the controls plugin (plugins/controls.js), a hex layer can be live
 * (SchmidtDSE/glen#426): its SQL uses the controls' {{TOKEN}}s, and glen
 * builds the tiles again when the reader changes one, so the map follows the
 * settings as the charts do. The agent makes one by passing `sql` to
 * `add_hex_tile_layer`; an app lists the ones to draw at start, each an
 * add_hex_tile_layer call with `layer_id`, `sql` and `agg`, and optionally
 * `when`, which hides the layer at other settings as it does a chart:
 *
 *   { "url": "…/core/plugins/hex.js", "options": { "layers": [
 *       { "layer_id": "loss", "display_name": "Tree cover loss", "agg": "SUM",
 *         "sql": "SELECT h8, sum(loss_ha) AS loss_ha FROM … WHERE year BETWEEN {{YEAR_MIN}} AND {{YEAR_MAX}} GROUP BY h8" } ] } }
 */

import { hasControlsPlugin } from './charts.js';

export const DEFAULT_GEO_QUERY_WASM = 'v0.6.0';

/** Whether the app runs an MCP server in a worker (plugins/mcp.js `worker`). */
export function hasWorkerServer(config) {
    return (config?.plugins || []).some((p) => {
        const o = p && typeof p === 'object' ? p.options : null;
        return !!(o?.worker || (Array.isArray(o?.servers) && o.servers.some((s) => s?.worker)));
    });
}

/**
 * The MCP client behind `register_hex_tiles`, read when a tile is requested.
 * geo-query-wasm's helpers take an object whose `client` is the SDK client.
 */
export function liveHexClient(tools) {
    return {
        get client() {
            return tools.tools?.get?.('register_hex_tiles')?.mcpClient?.client || null;
        },
    };
}

const plugin = {
    name: 'hex',

    /** geo-query-wasm's hex protocol module; tests replace this method. */
    async loadHexProtocol(ref) {
        return import(`https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@${ref}/src/hex-protocol.js`);
    },

    async setup(ctx, options = {}) {
        const { createHexTileTools, hexBuildWaiter } = await import('../../app/hex-tools.js');
        // A build still running when its metadata is read is waited for with
        // the server's get_hex_tile_status, if a plugin registered it.
        const waitForBuild = hexBuildWaiter(async (args) => {
            if (!ctx.tools.tools?.get?.('get_hex_tile_status')) throw new Error('no get_hex_tile_status tool');
            const r = await ctx.tools.execute('get_hex_tile_status', args);
            if (!r?.success) throw new Error(String(r?.result ?? 'get_hex_tile_status failed'));
            return r.result;
        });
        let fetchFn;
        if (hasWorkerServer(ctx.config)) {
            const { addHexTileProtocol, hexFetch } = await this.loadHexProtocol(options.geo_query_wasm || DEFAULT_GEO_QUERY_WASM);
            const live = liveHexClient(ctx.tools);
            const maplibre = options.maplibregl || globalThis.maplibregl;
            if (maplibre) addHexTileProtocol(maplibre, live);
            fetchFn = hexFetch(live, (...a) => globalThis.fetch(...a));
        }
        const live = hasControlsPlugin(ctx.config) ? await this.liveLayers(ctx, { fetchFn, waitForBuild }) : null;
        for (const t of createHexTileTools(ctx.map, { ...(fetchFn ? { fetchFn } : {}), waitForBuild, live })) ctx.tools.registerLocal(t);
        if (!live) return;
        ctx.map?.addStateSection?.('live_hex_layers', () => (live.layers.size ? live.describe() : null));
        const layers = Array.isArray(options.layers) ? options.layers : [];
        if (layers.length) {
            ctx.onReady?.(async () => {
                const results = await Promise.all(layers.map((spec) => live.add(spec || {}).catch((err) => ({ success: false, error: err.message }))));
                results.forEach((res, i) => {
                    if (!res.success) console.warn(`[hex] Layer ${layers[i]?.layer_id ?? i} not drawn:`, res.error);
                });
            });
        }
    },

    /** Live hex layers, built through the registered register_hex_tiles tool. */
    async liveLayers(ctx, { fetchFn, waitForBuild }) {
        const [{ LiveHexLayers, parseToolObject }, { resolveHexMetadata }] = await Promise.all([
            import('../../app/live-hex.js'),
            import('../../app/hex-tools.js'),
        ]);
        const register = async (sql, agg) => {
            const tool = ctx.tools.tools?.get?.('register_hex_tiles');
            if (!tool) throw new Error('no register_hex_tiles tool is registered');
            const props = tool.inputSchema?.properties || {};
            const key = 'sql_query' in props || !('sql' in props) ? 'sql_query' : 'sql';
            const r = await ctx.tools.execute('register_hex_tiles', { [key]: sql, agg });
            if (!r?.success) throw new Error(String(r?.result ?? 'register_hex_tiles failed'));
            return parseToolObject(r.result);
        };
        const resolve = (args) => resolveHexMetadata(args, fetchFn || ((...a) => globalThis.fetch(...a)), undefined, waitForBuild);
        return new LiveHexLayers({ map: ctx.map, register, resolve, params: () => ctx.params || null });
    },
};

export default plugin;
