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
 *       "include": ["query"]               // or "exclude": [...]
 *     }
 *   }]
 *
 * Several servers go in a `servers` list, each entry taking the same keys:
 *
 *   "options": { "servers": [
 *     { "url": "https://duckdb-mcp.example.org/mcp" },
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
 *
 * The agent's catalog tools, `get_schema` and `get_stac_details`, are answered
 * in the browser from the collections the app loaded: `read_parquet` paths,
 * hex tables, and each table's columns with descriptions and coded values.
 * The servers' own catalog tools (`browse_stac_catalog`, `get_stac_details`,
 * `get_collection`, `get_schema`) are never registered, because they could
 * read collections the app does not list (glen#441, as in the full app).
 * `s3_sources` in the app config adds https → s3 path rules, as there.
 *
 * A server can also run in the page, in a Web Worker, such as geo-query-wasm.
 * Its entry takes `worker`, a file the app serves, in place of `url`, and
 * `worker_config`; core/README.md describes both.
 *
 * When the first server is on another origin and its entry has no
 * Authorization header, a visitor can enter their own token for it in the
 * chat's settings (glen#442). It is saved in their browser and sent to that
 * server only. If the server refuses the connection at start, the chat says
 * so and opens the settings.
 */

import { resolveHref } from '../portolan.js';
import { createCatalogTools, MCP_CATALOG_TOOLS } from '../../app/catalog-tools.js';

// The same glen-harness tag as the imports in core/main.js; a test checks.
export const HARNESS_MCP_CLIENT = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.4.0/src/mcp-client.js';
const HARNESS_POST_MESSAGE = new URL('post-message-transport.js', HARNESS_MCP_CLIENT).href;

/**
 * The servers to connect to, in rank order, from the plugin options. The
 * single-server keys (`url`, `headers`, `prompt`, `include`, `exclude`) are
 * the shorthand for a one-entry `servers` list; `config.mcp_url` is the
 * fallback URL for that shorthand. An entry with `worker` names a worker
 * file in place of a URL; `url` is then its label, `worker:<path>`.
 *
 * @returns {Array<{url: string, headers: Object, prompt?: string,
 *   include?: string[], exclude?: string[], worker?: string,
 *   worker_config?: Object}>}
 */
export function resolveServers(options = {}, config = {}, runtime = {}) {
    let listed = Array.isArray(options.servers)
        ? options.servers.map((s) => ({ ...s }))
        : [{ ...options, url: options.worker ? undefined : (options.url || config.mcp_url) }];
    // The deploy-time config.json addresses the primary (first) server, as in
    // the full app: `mcp_server_url` replaces its URL and `mcp_auth_token`
    // its token, so a deployment's secret never sits in layers-input.json.
    if (listed[0] && !listed[0].worker) {
        if (runtime?.mcp_server_url) listed[0].url = runtime.mcp_server_url;
        if (runtime?.mcp_auth_token) listed[0].auth_token = runtime.mcp_auth_token;
    }
    const given = (v) => typeof v === 'string' && v.trim();
    const servers = listed.filter((s) => s && (given(s.worker) || given(s.url)));
    if (!servers.length) throw new Error('mcp plugin: options.url, options.worker or options.servers is required');
    const both = servers.find((s) => given(s.url) && given(s.worker));
    if (both) throw new Error(`mcp plugin: a server takes url or worker, not both (${both.url}, ${both.worker})`);
    // The full app's `auth_token` is a bearer token for that server alone.
    const withToken = (headers, token) => (token && !Object.keys(headers || {}).some((k) => k.toLowerCase() === 'authorization')
        ? { ...(headers || {}), Authorization: `Bearer ${token}` } : (headers || {}));
    return servers.map(({ url, headers, auth_token: token, prompt, include, exclude, worker, worker_config }) => (given(worker)
        ? { url: `worker:${worker}`, worker, worker_config: worker_config || {}, headers: {}, prompt, include, exclude }
        : { url, headers: withToken(headers, token), prompt, include, exclude }));
}

/** The URL a worker entry starts from: its path against the page, with its configuration. */
export function workerUrl(server, base) {
    const url = new URL(server.worker, base);
    url.searchParams.set('config', JSON.stringify(server.worker_config || {}));
    return url;
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

    /** The harness's postMessage transport, from the same tag. Tests replace this. */
    async loadTransport() {
        return (await import(HARNESS_POST_MESSAGE)).PostMessageTransport;
    },

    /** Starts a worker entry's Worker. Tests replace this. */
    startWorker(server) {
        const worker = new Worker(workerUrl(server, document.baseURI), { type: 'module' });
        // A file that fails to load fires a plain Event, with no message.
        worker.addEventListener('error', (e) => console.error(`[mcp plugin] ${server.url} error:`, e.message ?? 'worker failed to load'));
        return worker;
    },

    /** The harness's token helpers (glen#442), from the same module. Tests replace this. */
    async loadTokenHelpers() {
        const { userTokenApplies, withUserToken, isMcpAuthError, loadMcpToken } = await import(HARNESS_MCP_CLIENT);
        return { userTokenApplies, withUserToken, isMcpAuthError, loadMcpToken };
    },

    async setup(ctx, options = {}) {
        const servers = resolveServers(options, ctx.config, ctx.runtimeConfig || {});
        const MCPClient = await this.loadClient();
        const token = await this.loadTokenHelpers();
        // Only the first server takes a visitor's token.
        const offerToken = !servers[0].worker && token.userTokenApplies(servers[0]);
        const primary = { client: null, authFailed: false };
        if (offerToken) {
            ctx.onReady(({ ui }) => ui.enableMcpToken?.({
                authFailed: primary.authFailed,
                apply: async (value) => {
                    // A server that refused us at start has no tools here yet;
                    // starting over registers them with the new token.
                    if (!primary.client) { window.location.reload(); return; }
                    await primary.client.setHeaders(token.withUserToken(servers[0].headers, value));
                    await primary.client.reconnect();
                },
            }));
        }
        for (const t of createCatalogTools(ctx.catalog, { s3Sources: ctx.config?.s3_sources })) ctx.tools.registerLocal(t);
        // A server's own catalog tools would replace the local ones and reach
        // beyond this app's collections.
        const computeOnly = (tools) => tools.filter((t) => !MCP_CATALOG_TOOLS.includes(t.name));
        const prompts = [];
        let connected = 0;
        for (const [rank, server] of servers.entries()) {
            const filters = { rank, include: server.include, exclude: server.exclude };
            const headers = rank === 0 && offerToken
                ? token.withUserToken(server.headers, token.loadMcpToken())
                : server.headers;
            const client = server.worker
                ? await this.workerClient(MCPClient, server)
                : new MCPClient(server.url, headers);
            try {
                await client.connect();
            } catch (err) {
                if (rank === 0 && offerToken && token.isMcpAuthError(err)) primary.authFailed = true;
                console.warn(`[mcp plugin] ${server.url} unavailable; continuing without its tools:`, err.message);
                continue;
            }
            if (rank === 0) primary.client = client;
            const count = ctx.tools.registerRemote(computeOnly(client.getTools()), client, null, filters);
            client.setOnReconnect((tools) => {
                ctx.tools.clearRemote(client);
                ctx.tools.registerRemote(computeOnly(tools), client, null, filters);
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

    /**
     * A client for a server in a Web Worker. The worker starts once; each
     * connect and reconnect opens a fresh transport over it. A worker that
     * fails before it answers (its file is missing, or its imports fail) is
     * dropped and its transport closed, so the connect fails at once instead
     * of waiting out the request timeout; the next reconnect starts a new one.
     * So does a worker that gave no answer over its last connection.
     */
    async workerClient(MCPClient, server) {
        const PostMessageTransport = await this.loadTransport();
        let worker = null;
        let last = null;
        const transport = () => {
            // A worker that never answered the last connection over it may
            // be stuck without an error; replace it rather than wait again.
            // A worker busy with a long query that sends nothing for the
            // whole connect timeout is replaced too, and that query is lost.
            // The harness reconnects only after a network or timeout error,
            // so this is rare.
            if (worker && last && !last.heard) { worker.terminate?.(); worker = null; }
            worker ??= this.startWorker(server);
            const w = worker;
            const t = new PostMessageTransport(w);
            const mine = last = { heard: false };
            w.addEventListener('message', () => { mine.heard = true; }, { once: true });
            const failed = () => {
                if (worker === w) worker = null;
                w.terminate?.();
                t.close();
            };
            w.addEventListener('error', failed, { once: true });
            w.addEventListener('message', () => w.removeEventListener('error', failed), { once: true });
            return t;
        };
        return new MCPClient(server.url, {}, { transport });
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
        + 'Each map layer\'s full data can be read with read_parquet over https. '
        + 'Call get_schema with a collection id before your first query against it, for its columns, coded values and read_parquet paths:', '',
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
