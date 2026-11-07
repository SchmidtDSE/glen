/**
 * MCP plugin for glen core — adds the tools of one or more MCP servers, such
 * as glen's DuckDB server, to the map tools.
 *
 * It shows how the features glen core leaves out come back as extensions.
 * With this plugin the agent can query the GeoParquet `data` assets of the
 * same Portolan collections it draws, and the prompt lists their URLs.
 *
 *   "plugins": [{
 *     "url": "https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/core/plugins/mcp.js",
 *     "options": {
 *       "url": "https://duckdb-mcp.example.org/mcp",
 *       "prompt": "geospatial-analyst",    // optional: an MCP prompt to append
 *       "headers": { "Authorization": "Bearer …" },
 *       "exclude": ["browse_stac_catalog"]  // or "include": ["query"]
 *     }
 *   }]
 *
 * Several servers go in a `servers` list, each entry taking the same keys:
 *
 *   "options": { "servers": [
 *     { "url": "https://duckdb-mcp.example.org/mcp", "exclude": ["browse_stac_catalog"] },
 *     { "url": "https://sdm.example.org/mcp", "include": ["fit_sdm"] }
 *   ] }
 *
 * When two servers list a tool of the same name, the one listed first keeps
 * it. MCP gives a client no way to ask a server for part of its tool list, so
 * `include` and `exclude` filter what this app registers; the server still
 * serves every tool to other clients.
 *
 * A server that cannot be reached leaves the map tools and the other
 * servers' tools working; the plugin logs the failure and goes on.
 */

import { resolveHref } from '../portolan.js';

// The same glen-harness tag as the imports in core/main.js; a test checks.
export const HARNESS_MCP_CLIENT = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.3.0/src/mcp-client.js';

/**
 * The servers to connect to, in rank order, from the plugin options. The
 * single-server keys (`url`, `headers`, `prompt`, `include`, `exclude`) are
 * the shorthand for a one-entry `servers` list; `config.mcp_url` is the
 * fallback URL for that shorthand.
 *
 * @returns {Array<{url: string, headers: Object, prompt?: string,
 *   include?: string[], exclude?: string[]}>}
 */
export function resolveServers(options = {}, config = {}) {
    const listed = Array.isArray(options.servers)
        ? options.servers
        : [{ ...options, url: options.url || config.mcp_url }];
    const servers = listed.filter((s) => s && typeof s.url === 'string' && s.url.trim());
    if (!servers.length) throw new Error('mcp plugin: options.url or options.servers is required');
    return servers.map(({ url, headers, prompt, include, exclude }) => ({
        url, headers: headers || {}, prompt, include, exclude,
    }));
}

export default {
    name: 'mcp',

    /**
     * The harness's MCP client class. It and its vendored SDK load only when
     * this plugin runs. Tests replace this method.
     */
    async loadClient() {
        return (await import(HARNESS_MCP_CLIENT)).MCPClient;
    },

    async setup(ctx, options = {}) {
        const servers = resolveServers(options, ctx.config);
        const MCPClient = await this.loadClient();
        const prompts = [];
        let connected = 0;
        for (const [rank, server] of servers.entries()) {
            const filters = { rank, include: server.include, exclude: server.exclude };
            const client = new MCPClient(server.url, server.headers);
            try {
                await client.connect();
            } catch (err) {
                console.warn(`[mcp plugin] ${server.url} unavailable; continuing without its tools:`, err.message);
                continue;
            }
            const count = ctx.tools.registerRemote(client.getTools(), client, null, filters);
            client.setOnReconnect((tools) => {
                ctx.tools.clearRemote(client);
                ctx.tools.registerRemote(tools, client, null, filters);
            });
            console.log(`[mcp plugin] ${count} tools from ${server.url}`);
            connected++;
            if (server.prompt) {
                try {
                    const text = await client.getPrompt(server.prompt);
                    if (text) prompts.push(text);
                } catch (err) {
                    console.warn(`[mcp plugin] Prompt "${server.prompt}" unavailable:`, err.message);
                }
            }
        }
        if (!connected) throw new Error('mcp plugin: no MCP server could be reached');
        ctx.addPrompt(parquetSection(ctx.catalog));
        for (const text of prompts) ctx.addPrompt(text);
    },
};

/**
 * The GeoParquet and Parquet `data` assets of every loaded collection, so a
 * SQL tool can read the data behind each map layer.
 */
export function parquetSection(catalog) {
    const lines = [
        '## Data files for SQL', '',
        'This app also has SQL tools from an MCP server, so you can compute counts, totals and rankings. '
        + 'Each map layer\'s full data can be read with read_parquet over https:', '',
    ];
    let any = false;
    for (const ds of catalog.getAll()) {
        for (const a of Object.values(ds.stac?.assets || {})) {
            const roles = a.roles || [];
            if (!roles.includes('data') || roles.includes('source')) continue;
            if (!String(a.type || '').includes('parquet')) continue;
            lines.push(`- ${ds.id}: ${resolveHref(a.href, ds.url)}`);
            any = true;
        }
    }
    return any ? lines.join('\n') : '';
}
