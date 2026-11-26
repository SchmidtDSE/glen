/**
 * Small pieces of glen core's start-up (core/main.js), kept here so tests can
 * reach them: main.js imports glen-harness from the CDN, which tests cannot.
 */

/**
 * The map's opening camera from the app's `view`. A view with a center but
 * no zoom opens at zoom 6, as in the full app; with neither, the whole world.
 * @param {Object} [view]
 */
export function initialView(view) {
    return {
        center: view?.center || [0, 20],
        zoom: view?.zoom ?? (view?.center ? 6 : 2),
        pitch: view?.pitch ?? 0,
        bearing: view?.bearing ?? 0,
        globe: view?.globe ?? false,
    };
}

/** The highlight.js theme the full app used, at the same version as the harness's highlight.js. */
export const HIGHLIGHT_THEME = {
    href: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
    integrity: 'sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH',
};

/**
 * Load highlight.js and its SQL grammar, so the chat colours the SQL in tool
 * calls, unless the page already has it. The scripts come from the harness's
 * own list (CHAT_SCRIPTS in glen-harness ui/deps.js), with its versions and
 * integrity hashes; the page's marked and DOMPurify are left alone. A script
 * that fails to load is logged and skipped, since the chat works without it.
 *
 * @param {Array<{src: string, integrity: string, global?: string}>} scripts
 * @param {Object} [opts]
 * @param {Document} [opts.doc]
 * @param {Object} [opts.win] - where the `hljs` global lives
 * @returns {Promise<boolean>} whether anything was loaded
 */
export async function loadHighlighter(scripts, { doc = document, win = globalThis } = {}) {
    if (win.hljs) return false;
    if (!doc.querySelector(`link[href="${HIGHLIGHT_THEME.href}"]`)) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = HIGHLIGHT_THEME.href;
        link.integrity = HIGHLIGHT_THEME.integrity;
        link.crossOrigin = 'anonymous';
        doc.head.appendChild(link);
    }
    for (const s of scripts.filter((x) => x.src.includes('/highlight.js/'))) {
        if (doc.querySelector(`script[src="${s.src}"]`)) continue;
        // The SQL grammar registers itself with hljs, so the scripts load in order.
        await new Promise((resolve) => {
            const el = doc.createElement('script');
            el.src = s.src;
            el.integrity = s.integrity;
            el.crossOrigin = 'anonymous';
            el.onload = resolve;
            el.onerror = () => { console.warn(`[core] Could not load ${s.src}`); resolve(); };
            doc.head.appendChild(el);
        });
    }
    return true;
}

/**
 * Add stylesheets to the page, each just before the page's link to glen's
 * own app/chat.css when it has one, so a sheet keeps the place in the
 * cascade it had when glen shipped a copy of it (SchmidtDSE/glen#510).
 * Otherwise each goes before the first stylesheet, so the page's own
 * stylesheets still win ties. A sheet already on the page is left alone.
 *
 * @param {string[]} hrefs
 * @param {Object} [opts]
 * @param {Document} [opts.doc]
 * @returns {Promise<void>} once every sheet has loaded or failed (never rejects)
 */
export function loadStylesheets(hrefs, { doc = document } = {}) {
    const anchor = doc.querySelector('link[rel="stylesheet"][href$="app/chat.css"]')
        || doc.head.querySelector('link[rel="stylesheet"], style');
    return Promise.all(hrefs.map((href) => {
        if (doc.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return null;
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        const done = new Promise((resolve) => {
            link.onload = resolve;
            link.onerror = () => { console.warn(`[core] Could not load ${href}`); resolve(); };
        });
        if (anchor) anchor.before(link); else doc.head.append(link);
        return done;
    })).then(() => {});
}

/**
 * The libraries glen core needs as page globals, with the versions and
 * integrity hashes apps used to list in their index.html (SchmidtDSE/glen#511,
 * docs/design/page-dependencies.md). marked, DOMPurify and highlight.js come
 * from the harness's own list (CHAT_SCRIPTS); h3-js loads with the hex grid.
 */
export const PAGE_SCRIPTS = [
    {
        global: 'maplibregl',
        src: 'https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.js',
        integrity: 'sha384-U054LTKiMIJKEecR8PKFiUZdvkGWHjfPBnen5hSmR9TwfOfgZmKbskC8Rs9dCm/1',
    },
    {
        global: 'pmtiles',
        src: 'https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js',
        integrity: 'sha384-MjejsnWXHmuz93aE35YWLh5AbS/6ceRB3Vb+ukOwqFzJRTpQ8vvbkLbNV7I0QK4f',
    },
];

export const PAGE_STYLESHEETS = [
    {
        href: 'https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.css',
        integrity: 'sha384-MGCxhspF/+ufueUgol3FDkiAYQbpSNRhBT0VWHJt64U8qIy9qlnXWx8LAbj6niPH',
    },
];

/** glen's own stylesheets, beside this module's release: app/style.css, chat.css and sidebar.css. */
export function glenStylesheets(base = import.meta.url) {
    return ['style.css', 'chat.css', 'sidebar.css'].map((f) => ({ href: new URL(`../app/${f}`, base).href }));
}

const sameUrl = (el, attr, url, doc) => {
    const v = el.getAttribute(attr);
    return v != null && new URL(v, doc.baseURI).href === url;
};

/**
 * Add stylesheets the page does not already link, in order, before the
 * page's first stylesheet or <style>, so the page's own rules still win
 * ties. A sheet the page links, by any relative or absolute spelling, is left
 * where it is. Resolves once the added sheets have loaded or failed.
 *
 * @param {Array<{href: string, integrity?: string}>} sheets
 * @param {Object} [opts]
 * @param {Document} [opts.doc]
 */
export function addStylesheets(sheets, { doc = document } = {}) {
    const anchor = doc.head.querySelector('link[rel="stylesheet"], style');
    const links = [...doc.querySelectorAll('link[rel="stylesheet"]')];
    return Promise.all(sheets.map(({ href, integrity }) => {
        const url = new URL(href, doc.baseURI).href;
        if (links.some((l) => sameUrl(l, 'href', url, doc))) return null;
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        if (integrity) { link.integrity = integrity; link.crossOrigin = 'anonymous'; }
        const done = new Promise((resolve) => {
            link.onload = resolve;
            link.onerror = () => { console.warn(`[core] Could not load ${url}`); resolve(); };
        });
        if (anchor) anchor.before(link); else doc.head.append(link);
        return done;
    })).then(() => {});
}

/**
 * Add script tags, with their integrity hashes, for the libraries the page
 * does not already have (by its global, or a tag with the same src). They
 * download in parallel; an entry with no global (such as highlight.js's SQL
 * grammar) waits for the entry before it, which it registers with. A script
 * that fails is logged, and the promise still resolves; the caller checks
 * the globals it needs.
 *
 * @param {Array<{src: string, integrity: string, global?: string}>} scripts
 * @param {Object} [opts]
 * @param {Document} [opts.doc]
 * @param {Object} [opts.win] - where the globals live
 * @returns {Promise<void>}
 */
export function addScripts(scripts, { doc = document, win = globalThis } = {}) {
    const tags = [...doc.querySelectorAll('script[src]')];
    let prev = Promise.resolve();
    const all = scripts.map((s) => {
        const present = (s.global && win[s.global] !== undefined) || tags.some((t) => sameUrl(t, 'src', s.src, doc));
        const load = () => new Promise((resolve) => {
            const el = doc.createElement('script');
            el.src = s.src;
            el.integrity = s.integrity;
            el.crossOrigin = 'anonymous';
            // Added by script, a tag is async by default; keep the list's order.
            el.async = false;
            el.onload = resolve;
            el.onerror = () => { console.warn(`[core] Could not load ${s.src}`); resolve(); };
            doc.head.appendChild(el);
        });
        const p = present ? Promise.resolve() : (s.global ? load() : prev.then(load));
        prev = p;
        return p;
    });
    return Promise.all(all).then(() => {});
}

/** Copy the deploy-time settings over the static config. */
export function mergeRuntimeConfig(appConfig, runtimeConfig) {
    if (!runtimeConfig) return appConfig;
    // The MCP server's URL and token reach plugins/mcp.js through
    // ctx.runtimeConfig instead. `llm_models` is read only for its endpoint,
    // until every deployment gives `llm_endpoint` (SchmidtDSE/glen#542).
    for (const k of ['llm_endpoint', 'llm_models', 'transcription_model', 'max_tool_calls', 'max_tool_calls_manual', 'geolocate', 'export']) {
        if (runtimeConfig[k] != null) appConfig[k] = runtimeConfig[k];
    }
    return appConfig;
}

export const NO_MODEL_SERVICE = 'This app names no model service, so the chat has no model.';
export const MODEL_SERVICE_UNAVAILABLE = 'The model service did not answer, so the chat has no model. Reload the page to try again.';

/**
 * Which models the chat offers (SchmidtDSE/glen#542). The model service owns
 * the list: behind open-llm-proxy, its `/models` gives the models, the default
 * and each model's settings, and glen names none. The endpoint is
 * `llm_endpoint` from the deployment's config.json (or, until deployments drop
 * it, the first `llm_models` entry's endpoint). An app with `llm.user_provided`
 * takes the visitor's own key and model instead, when it has no model service
 * or the service does not answer.
 *
 * The harness functions are passed in, since tests cannot import the harness.
 * Resolves to `{ source: 'proxy', tier }`, `{ source: 'user' }`, or
 * `{ source: 'none', notice }` with a message for the chat.
 */
export async function resolveModels(config, { applyProxyModelList, buildUserModels, loadUserSettings }) {
    const userProvided = () => {
        delete config.llm_models;
        delete config.llm_model;
        const saved = buildUserModels(config.llm, loadUserSettings());
        if (saved) Object.assign(config, saved);
        config._userProvidedMode = true;
        return { source: 'user' };
    };
    if (!config.llm_endpoint && !config.llm_models?.[0]?.endpoint) {
        if (config.llm?.user_provided) return userProvided();
        return { source: 'none', notice: NO_MODEL_SERVICE };
    }
    try {
        return { source: 'proxy', tier: await applyProxyModelList(config) };
    } catch (err) {
        console.warn('[core] Model list unavailable:', err.message);
        if (config.llm?.user_provided) return userProvided();
        delete config.llm_models;
        delete config.llm_model;
        return { source: 'none', notice: MODEL_SERVICE_UNAVAILABLE };
    }
}
