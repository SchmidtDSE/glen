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
 */

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
        const { createHexTileTools } = await import('../../app/hex-tools.js');
        let fetchFn;
        if (hasWorkerServer(ctx.config)) {
            const { addHexTileProtocol, hexFetch } = await this.loadHexProtocol(options.geo_query_wasm || DEFAULT_GEO_QUERY_WASM);
            const live = liveHexClient(ctx.tools);
            const maplibre = options.maplibregl || globalThis.maplibregl;
            if (maplibre) addHexTileProtocol(maplibre, live);
            fetchFn = hexFetch(live, (...a) => globalThis.fetch(...a));
        }
        for (const t of createHexTileTools(ctx.map, fetchFn ? { fetchFn } : {})) ctx.tools.registerLocal(t);
    },
};

export default plugin;
