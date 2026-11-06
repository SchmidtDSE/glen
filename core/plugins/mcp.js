/**
 * MCP plugin for glen core — adds the tools of an MCP server, such as glen's
 * DuckDB server, to the map tools.
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
 *       "headers": { "Authorization": "Bearer …" }
 *     }
 *   }]
 *
 * A server that cannot be reached leaves the map tools working; the plugin
 * logs the failure and adds nothing.
 */

import { resolveHref } from '../portolan.js';

export default {
    name: 'mcp',

    async setup(ctx, options = {}) {
        const url = options.url || ctx.config.mcp_url;
        if (!url) throw new Error('mcp plugin: options.url is required');
        // The MCP client and its vendored SDK load only when this plugin runs.
        const { MCPClient } = await import('../../app/mcp-client.js');
        const client = new MCPClient(url, options.headers || {});
        await client.connect();
        const tools = client.getTools();
        ctx.tools.registerRemote(tools, client);
        client.setOnReconnect((tools) => {
            ctx.tools.clearRemote();
            ctx.tools.registerRemote(tools, client);
        });
        console.log(`[mcp plugin] ${tools.length} tools from ${url}`);

        ctx.addPrompt(parquetSection(ctx.catalog));
        if (options.prompt) {
            try {
                const text = await client.getPrompt(options.prompt);
                if (text) ctx.addPrompt(text);
            } catch (err) {
                console.warn(`[mcp plugin] Prompt "${options.prompt}" unavailable:`, err.message);
            }
        }
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
