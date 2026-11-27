/**
 * Where glen core loads glen-harness from: jsDelivr at one release tag.
 * core/main.js and plugins/mcp.js both take their harness URLs from here, so
 * a new harness release is this one line (SchmidtDSE/glen#511).
 */
export const HARNESS_TAG = 'v0.10.0';

const RELEASE_BASE = `https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@${HARNESS_TAG}/`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The base URL of the harness, ending in "/". To try an unreleased harness,
 * a page sets `window.GLEN_HARNESS_URL` before it loads main.js, for example
 * to a local glen-harness checkout served at http://localhost:8001/ or to a
 * jsDelivr commit. On localhost, `?harness=<url>` in the page's address does
 * the same. Elsewhere that parameter is ignored: anyone can send a link, and
 * the harness runs as the app, with the visitor's saved keys.
 *
 * @param {Object} [win] - the window (globalThis by default)
 * @returns {string}
 */
export function harnessBase(win = globalThis) {
    const fromPage = win.GLEN_HARNESS_URL;
    const loc = win.location;
    const fromQuery = loc && LOCAL_HOSTS.has(loc.hostname)
        ? new URLSearchParams(loc.search || '').get('harness')
        : null;
    const base = fromPage || fromQuery;
    if (!base) return RELEASE_BASE;
    const href = new URL(base, loc?.href).href;
    return href.endsWith('/') ? href : `${href}/`;
}

/** The URL of one harness module, such as 'src/core.js'. */
export function harnessUrl(path, win = globalThis) {
    return new URL(path, harnessBase(win)).href;
}
