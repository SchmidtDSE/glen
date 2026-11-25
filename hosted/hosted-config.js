/**
 * hosted-config.js — The rules of the hosted app (hosted/): which settings an
 * app may give, how they join the deployment's own, and how an app's config
 * travels in a link.
 *
 * A hosted app is a config, not a copy of glen. Its author gives the data
 * (a catalog, collections), how the map and chat look, a short prompt and
 * which of the deployment's plugins to turn on. The deployment
 * (deployment.json) gives everything that runs code or spends money: the
 * plugin modules and where they load from, the MCP servers, the models and
 * keys. Every hosted app shares one origin, and with it the visitor's saved
 * API key, so no app may name a script of its own.
 *
 * Pure functions, so they are tested in node (test/hosted-config.test.js).
 */

/** An app's name in its path, /a/<slug>/. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * The settings a hosted app may give, as layers-input.json names them
 * (docs/guide/configuration.md), plus `title`, `plugins` by name and
 * `data_hosts`. Anything else is the deployment's.
 */
export const APP_KEYS = [
    'title', 'catalog', 'collections', 'max_collections', 'titiler_url', 'view',
    'welcome', 'default_basemap', 'custom_basemap', 'links', 'header', 'theme',
    'sidebar', 'geocoder', 'system_prompt', 'plugins', 'data_hosts', 's3_sources',
    'auto_approve',
];

/** Longest app prompt, in characters. The prompt says what the data is, briefly. */
export const MAX_PROMPT = 8000;

/** Schemes that run code where a URL is expected. */
const UNSAFE_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

/** A plugin's name from a glen plugin URL: …/core/plugins/charts.js → charts. */
export function pluginName(spec) {
    if (typeof spec === 'string' && /^[a-z][a-z0-9_-]*$/.test(spec)) return spec;
    const url = typeof spec === 'string' ? spec : spec?.url;
    return (typeof url === 'string' && url.match(/(?:^|\/)core\/plugins\/([a-z][a-z0-9_-]*)\.js$/)?.[1]) || null;
}

/**
 * Keep what a hosted app may set and say what was left out. Takes an app
 * config or a whole layers-input.json, whose plugin URLs become names.
 * @param {Object} input
 * @returns {{config: Object, notes: string[]}}
 */
export function sanitizeAppConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('An app config is a JSON object.');
    const notes = [];
    const config = {};
    for (const [k, v] of Object.entries(input)) {
        if (APP_KEYS.includes(k)) config[k] = v;
        else notes.push(`"${k}" is set by the deployment here, so it was left out.`);
    }
    if (config.plugins !== undefined) {
        const names = [];
        for (const p of [].concat(config.plugins)) {
            const name = pluginName(p);
            if (name && !names.includes(name)) names.push(name);
            if (!name) notes.push(`Plugin ${JSON.stringify(typeof p === 'object' ? p?.url : p)} is not one of glen's, so it was left out.`);
            else if (typeof p === 'object' && p.options && Object.keys(p.options).length) notes.push(`Plugin "${name}" takes the deployment's options; its own were left out.`);
        }
        config.plugins = names;
    }
    if (config.system_prompt != null) {
        if (typeof config.system_prompt !== 'string') {
            notes.push('"system_prompt" is text; it was left out.');
            delete config.system_prompt;
        } else if (config.system_prompt.length > MAX_PROMPT) {
            notes.push(`"system_prompt" was cut to ${MAX_PROMPT} characters.`);
            config.system_prompt = config.system_prompt.slice(0, MAX_PROMPT);
        }
    }
    if (config.data_hosts !== undefined) {
        const hosts = [].concat(config.data_hosts).filter(h => typeof h === 'string' && /^[a-z0-9.-]+(:\d+)?$/i.test(h));
        if (hosts.length !== [].concat(config.data_hosts).length) notes.push('"data_hosts" takes host names only; the others were left out.');
        config.data_hosts = hosts.map(h => h.toLowerCase());
    }
    stripUnsafe(config, '', notes);
    return { config, notes };
}

/** Drop strings that would run code as a link, wherever they are. */
function stripUnsafe(node, path, notes) {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
        const here = path ? `${path}.${k}` : k;
        if (typeof v === 'string' && UNSAFE_URL.test(v)) {
            notes.push(`${here} is a script URL; it was left out.`);
            if (Array.isArray(node)) node[k] = null; else delete node[k];
        } else stripUnsafe(v, here, notes);
    }
}

/** https://host/ for each place the app's data lives, for the in-browser SQL's allowlist. */
export function dataOrigins(app) {
    const urls = [app.catalog, ...(app.collections || []).map(c => (typeof c === 'string' ? c : c?.url || c?.collection_url))];
    const origins = new Set();
    for (const u of urls) {
        try {
            const url = new URL(u);
            if (url.protocol === 'https:') origins.add(`${url.origin}/`);
        } catch { /* an id, not a URL */ }
    }
    for (const h of app.data_hosts || []) origins.add(`https://${h}/`);
    return [...origins];
}

const unique = (xs) => [...new Set(xs)];

/**
 * One plugin entry for core, from the deployment's definition of the name:
 * its URL and any worker resolved against the deployment file, and the app's
 * data hosts added to a worker's SQL allowlist.
 */
function pluginSpec(def, base, app) {
    const options = structuredClone(def.options || {});
    for (const server of options.servers || []) {
        if (!server.worker) continue;
        server.worker = new URL(server.worker, base).href;
        const wc = server.worker_config ||= {};
        if (Array.isArray(wc.allowedDirectories)) wc.allowedDirectories = unique([...wc.allowedDirectories, ...dataOrigins(app)]);
        if (Array.isArray(wc.allowedEndpoints)) wc.allowedEndpoints = unique([...wc.allowedEndpoints, ...(app.data_hosts || [])]);
    }
    return { url: new URL(def.url, base).href, options };
}

/**
 * The config glen core starts with: the deployment's defaults, the app's
 * settings over them, then what only the deployment sets.
 * @param {Object} app - a sanitized app config
 * @param {Object} deployment - deployment.json
 * @param {Object} opts
 * @param {string} opts.base - the URL deployment.json was read from
 * @returns {{config: Object, skipped: string[]}} skipped: plugin names this deployment lacks
 */
export function buildCoreConfig(app, deployment, { base }) {
    const { title, plugins, data_hosts: _hosts, ...settings } = app;
    const defaults = structuredClone(deployment.defaults || {});
    const config = { ...defaults, ...settings };
    config.sidebar = { ...(defaults.sidebar || {}), ...(settings.sidebar || {}) };
    if (title) config.sidebar.title = title;
    config.system_prompt = typeof app.system_prompt === 'string' ? app.system_prompt : '';
    config.titiler_url = app.titiler_url || deployment.titiler_url || defaults.titiler_url;
    if (deployment.llm) config.llm = structuredClone(deployment.llm);
    else delete config.llm;
    const skipped = [];
    config.plugins = [];
    for (const name of plugins ?? deployment.default_plugins ?? []) {
        const def = deployment.plugins?.[name];
        if (def) config.plugins.push(pluginSpec(def, base, app));
        else skipped.push(name);
    }
    return { config, skipped };
}

/* ── Links ─────────────────────────────────────────────────────────────── */

function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** An app config as the `c` parameter of a link: deflated JSON, base64url. */
export async function encodeConfig(app) {
    return toBase64Url(await pipe(new TextEncoder().encode(JSON.stringify(app)), new CompressionStream('deflate-raw')));
}

/** The app config in a link's `c` parameter. */
export async function decodeConfig(param) {
    let text;
    try {
        text = new TextDecoder().decode(await pipe(fromBase64Url(param), new DecompressionStream('deflate-raw')));
    } catch {
        throw new Error('The app in this link is cut short or damaged.');
    }
    return JSON.parse(text);
}

/**
 * Where a page's app config comes from:
 *   /a/<slug>/ or ?app=<slug> — the deployment's registry of apps
 *   ?config=<url>            — any public JSON file
 *   ?c=<encoded>             — the config itself, in the link
 * @param {{pathname: string, search: string}} loc
 */
export function configSource({ pathname = '', search = '' }) {
    const params = new URLSearchParams(search);
    if (params.get('c')) return { kind: 'inline', value: params.get('c') };
    if (params.get('config')) return { kind: 'url', value: params.get('config') };
    const slug = params.get('app') || pathname.match(/\/a\/([^/]+)\/?(?:index\.html)?$/)?.[1];
    if (slug) return SLUG.test(slug) ? { kind: 'slug', value: slug } : { kind: 'bad', value: slug };
    return { kind: 'none' };
}

/* ── Publishing ────────────────────────────────────────────────────────── */

/** A slug from an app's title: "St. Louis open data" → st-louis-open-data. */
export function slugify(title) {
    return String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

/**
 * A link that opens GitHub's new-file form with the app's config filled in.
 * Someone without write access gets a fork and a pull request, so every
 * published app is reviewed before it is served.
 * @param {string} repo - owner/name
 * @param {string} registryPath - the registry's folder in the repo, e.g. hosted/apps
 * @param {string} slug
 * @param {Object} app
 */
export function proposalUrl(repo, registryPath, slug, app, branch = 'main') {
    const url = new URL(`https://github.com/${repo}/new/${branch}/${registryPath.replace(/^\/+|\/+$/g, '')}`);
    url.searchParams.set('filename', `${slug}.json`);
    url.searchParams.set('value', `${JSON.stringify(app, null, 4)}\n`);
    return url.href;
}
