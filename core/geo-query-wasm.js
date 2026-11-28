/**
 * geo-query-wasm — the release whose modules glen core's plugins load beside
 * an app's geo-query-wasm worker: the hex tile protocol (plugins/hex.js) and
 * the visitor-file helpers (plugins/uploads.js). Each plugin's
 * `geo_query_wasm` option overrides it, and should name the release the app's
 * worker file imports, since the two talk to each other.
 */

export const DEFAULT_GEO_QUERY_WASM = 'v0.8.0';

/** A file of a geo-query-wasm release on jsDelivr. */
export function geoQueryWasmUrl(ref, path) {
    return `https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@${ref}/${path}`;
}
