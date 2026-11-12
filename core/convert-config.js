/**
 * convert-config.js — Turn a v3 app's layers-input.json into glen core's
 * (SchmidtDSE/glen#441, the move to glen v4).
 *
 * glen core reads the full app's layer settings by the same names, including
 * `collection_id` and `collection_url`, so collections pass through as they
 * are. What changes is that the opt-in features became plugins: the MCP
 * server (always on in v3, which fell back to duckdb-mcp), charts, drawing
 * and uploads. A few v3 keys have no use in core and are dropped, with a
 * note for each. Pure: no fetching, no DOM.
 *
 * Deploy-time secrets stay in config.json: plugins/mcp.js reads
 * `mcp_server_url` and `mcp_auth_token` from it for the primary server, as
 * the full app does.
 */

/** The full app's MCP server when an app named none (app/mcp-servers.js). */
export const DEFAULT_MCP_URL = 'https://duckdb-mcp.nrp-nautilus.io/mcp';

// v3 keys glen core has no use for, and why.
const DROPPED = Object.freeze({
    catalog_index_threshold: 'glen core always lists every layer in the prompt; get_schema gives the details',
    client_header_hosts: 'the harness sends its client header itself',
    mcp_url: 'now an option of plugins/mcp.js',
    mcp_servers: 'now options of plugins/mcp.js',
    mcp_auth_token: 'now the primary server\'s auth_token in plugins/mcp.js',
    charts: 'now plugins/charts.js',
    draw_enabled: 'now plugins/draw.js',
    upload_enabled: 'now plugins/uploads.js',
    upload: 'now the options of plugins/uploads.js',
});

/**
 * @param {Object} v3 - the app's layers-input.json
 * @param {Object} [options]
 * @param {string} [options.pluginBase] - where the plugin modules are served,
 *   e.g. `https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.0.0/core/plugins`
 * @returns {{config: Object, notes: string[]}} glen core's layers-input.json,
 *   and what changed, for the person running the conversion
 */
export function convertConfig(v3, { pluginBase = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/core/plugins' } = {}) {
    if (!v3 || typeof v3 !== 'object' || Array.isArray(v3)) throw new Error('convertConfig: expected a layers-input.json object');
    const base = pluginBase.replace(/\/$/, '');
    const notes = [];
    const config = {};
    for (const [k, v] of Object.entries(v3)) {
        if (k in DROPPED) continue;
        config[k] = v;
    }
    const plugins = Array.isArray(v3.plugins) ? [...v3.plugins] : [];

    // MCP: every v3 app had a server, the default one if none was named.
    const servers = Array.isArray(v3.mcp_servers) && v3.mcp_servers.length
        ? v3.mcp_servers.map(s => ({ ...s }))
        : [{ url: v3.mcp_url || DEFAULT_MCP_URL }];
    if (v3.mcp_url && Array.isArray(v3.mcp_servers) && v3.mcp_servers.length) servers[0].url = v3.mcp_url;
    if (v3.mcp_auth_token && !servers[0].auth_token) servers[0].auth_token = v3.mcp_auth_token;
    // The full app appends the primary server's analyst prompt.
    if (!servers[0].prompt) servers[0].prompt = 'geospatial-analyst';
    if (!v3.mcp_url && !(Array.isArray(v3.mcp_servers) && v3.mcp_servers.length)) {
        notes.push(`No MCP server was named, so the v3 default (${DEFAULT_MCP_URL}) is written out; a deploy-time mcp_server_url still replaces it.`);
    }
    plugins.push({ url: `${base}/mcp.js`, options: servers.length === 1 ? servers[0] : { servers } });

    // Every v3 app had the hex tile tools.
    plugins.push(`${base}/hex.js`);
    if (v3.charts?.enabled) plugins.push(`${base}/charts.js`);
    if (v3.draw_enabled) plugins.push(`${base}/draw.js`);
    if (v3.upload_enabled) {
        const opts = typeof v3.upload_enabled === 'object' ? v3.upload_enabled : (v3.upload || {});
        plugins.push({ url: `${base}/uploads.js`, options: opts });
    }
    config.plugins = plugins;

    for (const k of Object.keys(v3)) {
        if (k in DROPPED && !/^(mcp_|charts$|draw_enabled$|upload)/.test(k)) notes.push(`Dropped ${k}: ${DROPPED[k]}.`);
    }
    const preload = (v3.collections || []).filter(c => c && typeof c === 'object' && c.preload).map(c => c.collection_id || c.id);
    if (preload.length) notes.push(`preload is ignored in glen core (${preload.join(', ')}): its prompt lists every layer's columns, and get_schema gives the rest.`);
    notes.push('index.html must load glen core (core/main.js) instead of app/main.js; see core/README.md.');
    return { config, notes };
}

/**
 * Point a v3 app's index.html at glen core: its module script loads
 * `core/main.js` instead of `app/main.js`, and every glen URL (the script and
 * the stylesheets, which core shares) moves to the release `ref`. The page's
 * element ids and libraries stay as they are; glen core uses the same ones.
 *
 * @param {string} html
 * @param {string} ref - the glen release to pin, e.g. "v4.0.0"
 * @returns {{html: string, changed: number}} the page, and how many glen URLs changed
 */
export function convertIndexHtml(html, ref) {
    let changed = 0;
    const out = String(html).replace(/(https:\/\/cdn\.jsdelivr\.net\/gh\/SchmidtDSE\/(?:glen|geo-agent))@[^/"']+\/app\/(main\.js|[\w./-]+)/g, (m, repo, path) => {
        changed++;
        return `https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@${ref}/${path === 'main.js' ? 'core/main.js' : `app/${path}`}`;
    });
    return { html: out, changed };
}
