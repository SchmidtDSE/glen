/**
 * MCP plugin for glen core — adds the tools of one or more MCP servers, such
 * as glen's DuckDB server, to the map tools.
 *
 * It shows how the features glen core leaves out come back as extensions.
 * With this plugin the agent can query the GeoParquet `data` assets of the
 * same Portolan collections it draws; get_schema gives their paths.
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
 * servers' tools working; the plugin logs the failure and goes on. Each
 * server gets three tries at start, with a short backoff, as in the full app.
 * If the first server still cannot be reached, the chat says so and the plugin
 * registers a stand-in `query` tool on its client: the agent's next query
 * makes the harness reconnect, and the server's own tools replace the
 * stand-in, with no reload.
 *
 * A server whose entry has `optional: true` does not hold up the start: it
 * connects in the background, its tools join when it answers, and a server
 * that never answers is left out without a notice.
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

import { createCatalogTools, MCP_CATALOG_TOOLS } from '../../app/catalog-tools.js';
import { createFilterByQueryTool } from '../../app/query-filter-tool.js';
import { PICK_LAYER_NUDGE } from '../../app/map-control-tools.js';
import { runQuery } from '../run-query.js';

// The same glen-harness tag as the imports in core/main.js; a test checks.
export const HARNESS_MCP_CLIENT = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.5.0/src/mcp-client.js';
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
    return servers.map(({ url, headers, auth_token: token, prompt, include, exclude, worker, worker_config, optional }) => ({
        ...(given(worker)
            ? { url: `worker:${worker}`, worker, worker_config: worker_config || {}, headers: {}, prompt, include, exclude }
            : { url, headers: withToken(headers, token), prompt, include, exclude }),
        ...(optional === true ? { optional: true } : {}),
    }));
}

/** The pause before each retry: 2 s, then 4 s, at most 8 s, as in the full app. */
export const retryDelay = (attempt) => Math.min(2000 * 2 ** attempt, 8000);

/**
 * Connect a client, trying up to `attempts` times with a backoff between
 * tries. A refused token is not retried, since it will not change.
 *
 * @param {Object} client - the harness's MCPClient
 * @param {Object} [opts]
 * @param {number} [opts.attempts=3]
 * @param {(err: Error) => boolean} [opts.isAuthError]
 * @param {(ms: number) => Promise<void>} [opts.wait]
 * @param {string} [opts.label] - the server, for the console
 */
export async function connectWithRetry(client, {
    attempts = 3, isAuthError = () => false, wait = (ms) => new Promise((r) => setTimeout(r, ms)), label = '',
} = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            await client.connect();
            return;
        } catch (err) {
            lastErr = err;
            if (isAuthError(err)) break;
            console.warn(`[mcp plugin] ${label} connect attempt ${i + 1}/${attempts} failed: ${err.message}`);
            if (i < attempts - 1) await wait(retryDelay(i));
        }
    }
    throw lastErr;
}

/**
 * Stands in for the first server's `query` tool when that server cannot be
 * reached at start. Calling it makes the harness reconnect, and the
 * reconnect hook then registers the server's real tools in its place.
 */
export const QUERY_STAND_IN = {
    name: 'query',
    description: 'Execute a read-only SQL query against a DuckDB database that is pre-loaded with H3 geospatial extensions, spatial functions, and httpfs for accessing remote parquet data. The database supports partitioned hive-style parquet files on S3.',
    inputSchema: {
        type: 'object',
        properties: { sql_query: { type: 'string', description: 'The SQL query to execute. Must be a read-only SELECT statement.' } },
        required: ['sql_query'],
    },
};

/**
 * The stand-in's arguments in the shape the server's own `query` takes. The
 * stand-in names its SQL `sql_query`; a server whose `query` names it
 * otherwise (`sql`, say) gets it under that name. Other calls pass through.
 */
export function matchSqlArg(tools, name, args) {
    if (name !== QUERY_STAND_IN.name || !args || !('sql_query' in args)) return args;
    const schema = (tools || []).find(t => t.name === name)?.inputSchema;
    const props = schema?.properties || {};
    if (!schema || 'sql_query' in props) return args;
    const target = (schema.required || []).find(k => props[k]?.type === 'string')
        || Object.keys(props).find(k => props[k]?.type === 'string');
    if (!target) return args;
    const { sql_query, ...rest } = args;
    return { ...rest, [target]: sql_query };
}

/** The chat notice when the first server cannot be reached at start. */
export const SQL_UNAVAILABLE_NOTICE = 'The data server could not be reached, so SQL queries will fail until it comes back.';

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

    /** Waits between connection attempts. Tests replace this. */
    wait(ms) {
        return new Promise((r) => setTimeout(r, ms));
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
        const primary = { client: null, authFailed: false, down: null };
        if (offerToken) {
            ctx.onReady(({ ui }) => ui.enableMcpToken?.({
                authFailed: primary.authFailed,
                apply: async (value) => {
                    // A server that refused us at start registers its tools
                    // through the reconnect hook once the new token works.
                    await primary.client.setHeaders(token.withUserToken(servers[0].headers, value));
                    await primary.client.reconnect();
                },
            }));
        }
        for (const t of createCatalogTools(ctx.catalog, { s3Sources: ctx.config?.s3_sources })) ctx.tools.registerLocal(t);
        // The full app's filter_by_query, its SQL run through the servers' `query`.
        if (ctx.map) ctx.tools.registerLocal(createFilterByQueryTool(ctx.map, (sql) => runQuery(ctx.tools, sql), PICK_LAYER_NUDGE));
        // A server's own catalog tools would replace the local ones and reach
        // beyond this app's collections.
        const computeOnly = (tools) => tools.filter((t) => !MCP_CATALOG_TOOLS.includes(t.name));
        const register = (client, tools, filters) => ctx.tools.registerRemote(computeOnly(tools), client, null, filters);
        // Required servers connect side by side, optional ones in the
        // background; each one's prompt keeps its rank in the system prompt.
        const clients = [];
        for (const [rank, server] of servers.entries()) {
            const headers = rank === 0 && offerToken
                ? token.withUserToken(server.headers, token.loadMcpToken())
                : server.headers;
            clients.push(server.worker
                ? await this.workerClient(MCPClient, server)
                : new MCPClient(server.url, headers));
        }
        primary.client = clients[0];
        const required = await Promise.all(servers.map(async (server, rank) => {
            const filters = { rank, include: server.include, exclude: server.exclude };
            const client = clients[rank];
            // The harness calls this after each reconnect, including the first
            // successful one after a failed start.
            client.setOnReconnect((tools) => {
                ctx.tools.clearRemote(client);
                const n = register(client, tools, filters);
                console.log(`[mcp plugin] ${n} tools from ${server.url} after reconnect`);
            });
            const connect = (attempts) => connectWithRetry(client, {
                attempts, isAuthError: token.isMcpAuthError, wait: (ms) => this.wait(ms), label: server.url,
            });
            if (server.optional) {
                connect(1)
                    .then(() => console.log(`[mcp plugin] ${register(client, client.getTools(), filters)} tools from optional server ${server.url}`))
                    .catch((err) => console.warn(`[mcp plugin] Optional server ${server.url} unavailable; its tools are left out:`, err.message));
                return null;
            }
            try {
                await connect(3);
            } catch (err) {
                console.warn(`[mcp plugin] ${server.url} unavailable; continuing without its tools:`, err.message);
                if (rank !== 0) return null;
                if (offerToken && token.isMcpAuthError(err)) primary.authFailed = true;
                else ctx.onReady(({ ui }) => ui.addMessage?.('system', SQL_UNAVAILABLE_NOTICE));
                primary.down = filters;
                return null;
            }
            console.log(`[mcp plugin] ${register(client, client.getTools(), filters)} tools from ${server.url}`);
            if (!server.prompt) return null;
            try {
                return await client.getPrompt(server.prompt);
            } catch (err) {
                console.warn(`[mcp plugin] Prompt "${server.prompt}" unavailable:`, err.message);
                return null;
            }
        }));
        const prompts = required.filter(Boolean);
        // The stand-in for the first server's tools, unless another server
        // already answers `query`.
        if (primary.down && !ctx.tools.tools?.has?.('query')) {
            register(primary.client, [QUERY_STAND_IN], primary.down);
            // A call through the stand-in reconnects first, so the server's
            // own tools are known before its arguments are sent.
            const client = primary.client;
            const callTool = client.callTool.bind(client);
            client.callTool = async (name, args) => {
                if (name === QUERY_STAND_IN.name) {
                    await client.ensureConnected?.();
                    args = matchSqlArg(client.getTools?.(), name, args);
                }
                return callTool(name, args);
            };
        }
        // The data files' paths are get_schema's, not the prompt's.
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
