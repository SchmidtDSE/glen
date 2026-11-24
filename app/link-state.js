/**
 * link-state.js — the app's link carries what the reader set
 * (SchmidtDSE/glen#506), so a link to a result opens with the same view.
 *
 * The state goes in the query string, beside anything else the page was
 * given (the hash stays free for #data):
 *
 *   ?map=7.25/18.10000/-77.30000         zoom / latitude / longitude
 *   ?map=7.25/18.10000/-77.30000/30/45   … / bearing / pitch, when not 0
 *   &layers=parishes,roads               the catalog layers shown, when they
 *                                        differ from the app's defaults
 *   &years=2005,2020&land=soy            controls not at their defaults
 *                                        (core/plugins/controls.js)
 *
 * Nothing read from a link is trusted: a view outside the world's bounds is
 * dropped, a layer id must be one of the app's, and a control's value must be
 * one of its options (app/params.js), so a hand-edited link cannot reach SQL.
 * The link is rewritten in place with history.replaceState as the state
 * changes; it never adds a history entry.
 */

/** Query keys that belong to core, which a control's id may not use. */
export const RESERVED_LINK_KEYS = new Set(['map', 'layers', 'harness']);

const finite = (s) => (s !== '' && s != null && Number.isFinite(Number(s)) ? Number(s) : null);

/**
 * The view in a link's `map` value, or null when it is missing or malformed.
 * @param {string|null} value - "zoom/lat/lng[/bearing[/pitch]]"
 * @returns {{center: number[], zoom: number, bearing: number, pitch: number}|null}
 */
export function parseMapView(value) {
    if (!value) return null;
    const parts = String(value).split('/');
    if (parts.length < 3 || parts.length > 5) return null;
    const [zoom, lat, lng, bearing = 0, pitch = 0] = parts.map(finite);
    if ([zoom, lat, lng, bearing, pitch].some(v => v === null)) return null;
    if (zoom < 0 || zoom > 24 || Math.abs(lat) > 90 || Math.abs(lng) > 180 || pitch < 0 || pitch > 85) return null;
    return { center: [lng, lat], zoom, bearing, pitch };
}

/** A view as a link's `map` value, rounded to what the zoom can show. */
export function formatMapView({ center, zoom, bearing = 0, pitch = 0 }) {
    // Five decimals is about a metre, enough at street zooms; fewer when zoomed out.
    const digits = zoom < 4 ? 2 : zoom < 8 ? 3 : zoom < 12 ? 4 : 5;
    const round = (v, d) => String(Number(v.toFixed(d)));
    const parts = [round(zoom, 2), round(center[1], digits), round(center[0], digits)];
    const b = Number(bearing.toFixed(1)), p = Number(pitch.toFixed(1));
    if (b || p) parts.push(String(b));
    if (p) parts.push(String(p));
    return parts.join('/');
}

/**
 * The layers a link's `layers` value names, kept to the app's own ids.
 * @param {string|null} value - comma-separated layer ids
 * @param {Iterable<string>} known - the ids the link may name
 * @returns {string[]|null} null when the link names no layers
 */
export function parseLayerList(value, known) {
    if (value == null) return null;
    const ids = new Set(known);
    return String(value).split(',').map(s => s.trim()).filter(id => ids.has(id));
}

/**
 * The link with these keys set, or removed where the value is null, keeping
 * the other keys, the path and the hash. Commas and slashes stay readable.
 * @param {string} href
 * @param {Object<string, string|null>} entries
 */
export function linkWith(href, entries) {
    const url = new URL(href);
    for (const [k, v] of Object.entries(entries)) {
        if (v == null) url.searchParams.delete(k);
        else url.searchParams.set(k, v);
    }
    const q = url.searchParams.toString().replace(/%2C/g, ',').replace(/%2F/g, '/');
    return url.pathname + (q ? `?${q}` : '') + url.hash;
}

/** Rewrite the page's link with these keys (see linkWith), without a history entry. */
export function updateLink(entries, win = globalThis.window) {
    if (!win?.history?.replaceState || !win.location) return;
    const next = linkWith(win.location.href, entries);
    const now = win.location.pathname + win.location.search + win.location.hash;
    if (next !== now) win.history.replaceState(win.history.state, '', next);
}

/** The page's query string as URLSearchParams. */
export function linkParams(win = globalThis.window) {
    return new URLSearchParams(win?.location?.search || '');
}

/**
 * Show the layers a link names and hide the app's other layers, then keep the
 * link's `map` and `layers` up to date as the reader moves the map and turns
 * layers on and off.
 *
 * @param {Object} mapManager - MapManager: map, layers, showLayer, hideLayer,
 *   syncCheckbox and the onVisibilityChange hook
 * @param {string[]} layerIds - the app's catalog layers, the only ones a link names
 * @param {Object} [opts]
 * @param {Window} [opts.win]
 * @returns {{ layers: string[]|null }} the layers the link set, if any
 */
export function bindMapLink(mapManager, layerIds, { win = globalThis.window } = {}) {
    const q = linkParams(win);
    const isOn = id => !!mapManager.layers.get(id)?.visible;
    // What the app shows by default: the link names layers only when they differ.
    const defaults = new Set(layerIds.filter(isOn));
    const wanted = parseLayerList(q.get('layers'), layerIds);
    if (wanted) {
        const on = new Set(wanted);
        for (const id of layerIds) {
            if (on.has(id) === isOn(id)) continue;
            if (on.has(id)) mapManager.showLayer(id); else mapManager.hideLayer(id);
            mapManager.syncCheckbox?.(id);
        }
    }

    const writeLayers = () => {
        const on = layerIds.filter(isOn);
        const same = on.length === defaults.size && on.every(id => defaults.has(id));
        updateLink({ layers: same ? null : on.join(',') }, win);
    };
    const writeView = () => {
        const m = mapManager.map;
        const c = m.getCenter();
        updateLink({ map: formatMapView({ center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() }) }, win);
    };
    mapManager.map.on('moveend', writeView);
    mapManager.onVisibilityChange = writeLayers;
    writeLayers();
    return { layers: wanted };
}
