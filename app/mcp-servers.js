/**
 * Which MCP servers an app connects to (#338).
 *
 * Pure config resolution — no transport, no DOM — so it is testable without
 * the SDK. main.js builds one MCPClient per entry this returns.
 *
 * Two config shapes:
 *   - `mcp_url` (+ `mcp_auth_token`): the single-server shorthand every
 *     existing app uses.
 *   - `mcp_servers: [{ url, auth_token?, optional? }, …]`: several servers.
 *
 * The first entry is the PRIMARY server — the data engine (duckdb-mcp). Only
 * the primary gets the inline-STAC rewriter, the fallback `query` tool, the
 * `geospatial-analyst` prompt, and the local tools that delegate to it
 * (get_schema, render_chart's sql path). The legacy keys always address the
 * primary: `mcp_url` (and config.json's `mcp_server_url`, merged into it)
 * replaces the primary's URL, and `mcp_auth_token` its token. Every other
 * entry is left as configured, so a deployment that injects `mcp_server_url`
 * keeps the extra servers listed in `layers-input.json`.
 */

export const DEFAULT_MCP_URL = 'https://duckdb-mcp.nrp-nautilus.io/mcp';

/**
 * @typedef {Object} McpServerConfig
 * @property {string} url
 * @property {Object<string,string>} headers - per-server request headers (auth)
 * @property {boolean} optional - a failed connection drops only this server's tools
 * @property {boolean} primary - first entry; see module comment
 */

/**
 * @param {Object} appConfig - merged layers-input.json + config.json
 * @param {Object} [opts]
 * @param {string} [opts.userToken] - an MCP token the visitor saved (#442).
 *   Used for the primary only, and only when `userTokenApplies` allows it.
 * @param {string} [opts.pageOrigin] - the page's origin, for `userTokenApplies`
 * @returns {McpServerConfig[]} never empty
 */
export function resolveMcpServers(appConfig = {}, { userToken, pageOrigin } = {}) {
    const entries = resolveEntries(appConfig);
    const token = typeof userToken === 'string' ? userToken.trim() : '';
    if (token && userTokenApplies(entries[0], pageOrigin)) entries[0].auth_token = token;

    return entries.map((s, i) => ({
        url: s.url,
        headers: s.auth_token ? { Authorization: `Bearer ${s.auth_token}` } : {},
        optional: s.optional === true,
        primary: i === 0,
    }));
}

/**
 * Whether a visitor's own MCP token may be sent to this server (#442).
 *
 * Only when the deployment gave it no token, so a deployment's own token
 * always wins, and only when the server is on another origin. A same-origin
 * URL such as `/api/mcp` is the deployment's own relay, which adds the token
 * itself; a header set by the page there would also replace the browser's
 * saved basic-auth credentials (#420).
 *
 * @param {{url: string, auth_token?: string}} server - a primary entry
 * @param {string} [pageOrigin] - defaults to the current page's origin
 */
export function userTokenApplies(server, pageOrigin = globalThis.location?.origin) {
    if (!server?.url || server.auth_token) return false;
    let url;
    try {
        url = new URL(server.url, pageOrigin || undefined);
    } catch {
        return false;
    }
    return !pageOrigin || url.origin !== pageOrigin;
}

/**
 * Whether an MCP connection error is the server refusing our credentials.
 * The SDK reports a non-OK POST as `Error POSTing to endpoint (HTTP 401): …`.
 */
export function isMcpAuthError(err) {
    return /\(HTTP 40[13]\)/.test(String(err?.message || ''));
}

/** The configured entries, legacy keys applied, before any user token. */
function resolveEntries(appConfig) {
    const listed = Array.isArray(appConfig.mcp_servers)
        ? appConfig.mcp_servers.filter(s => {
            const ok = s && typeof s.url === 'string' && s.url.trim();
            if (!ok) console.warn('[main] Ignoring mcp_servers entry without a url:', s);
            return ok;
        })
        : [];
    const entries = listed.length ? listed.map(s => ({ ...s })) : [{}];

    // Legacy keys address the primary only.
    if (appConfig.mcp_url) entries[0].url = appConfig.mcp_url;
    if (appConfig.mcp_auth_token) entries[0].auth_token = appConfig.mcp_auth_token;
    if (!entries[0].url) entries[0].url = DEFAULT_MCP_URL;

    return entries;
}

/**
 * Whether this deployment leaves room for a visitor's own MCP token on the
 * primary server: see `userTokenApplies`.
 */
export function userTokenAllowed(appConfig = {}, pageOrigin) {
    return userTokenApplies(resolveEntries(appConfig)[0], pageOrigin);
}

/** Where a visitor's MCP token is kept in localStorage. */
export const STORAGE_KEY_MCP_TOKEN = 'geo-agent-mcp-token';
