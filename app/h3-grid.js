/**
 * h3-grid.js — an H3 grid drawn over the map, so a reader can see what size
 * of H3 cell a raster pixel or a feature corresponds to.
 *
 * The resolution follows the cells' size on screen rather than the zoom
 * alone, so cells look the same size at any latitude. h3-js is loaded, with
 * its integrity hash, the first time the grid is turned on, so a page that
 * never shows the grid never fetches it. One update runs per move, and a
 * view that would need too many cells drops to a coarser resolution.
 *
 * Restored from the v3 full app's h3geo.js (SchmidtDSE/glen#441).
 */

import { mountOverlay, SLOT } from './overlay-rail.js';

const H3_JS = 'https://unpkg.com/h3-js@4.1.0/dist/h3-js.umd.js';
const H3_JS_SRI = 'sha384-nKUDlg+fT0U/eEt4KWP9n034kLe/eVj6k7CVjbu6qfRhJdEyinlGajS9+9AU+UZ5';

/** Smallest edge, in screen pixels, of a cell the grid will draw. */
export const MIN_EDGE_PX = 16;
/** Most cells drawn at once; a view needing more uses a coarser resolution. */
export const MAX_CELLS = 5000;

const EARTH_CIRCUMFERENCE_M = 40075016.686;
const KM_PER_DEG = 111.32;

/** Metres per screen pixel at a zoom and latitude (MapLibre's 512 px tiles). */
export function metresPerPixel(zoom, lat) {
    const c = Math.cos(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    return EARTH_CIRCUMFERENCE_M * c / (512 * 2 ** zoom);
}

/**
 * The finest resolution whose cells are at least MIN_EDGE_PX across on screen.
 * @param {number} zoom
 * @param {number} lat - the view's centre latitude
 * @param {(res: number) => number} edgeKm - average edge length at a resolution
 */
export function gridResolution(zoom, lat, edgeKm) {
    const mpp = metresPerPixel(zoom, lat);
    let res = 0;
    for (let r = 1; r <= 15; r++) {
        if ((edgeKm(r) * 1000) / mpp < MIN_EDGE_PX) break;
        res = r;
    }
    return res;
}

/** Rough number of cells covering a bounding box at a cell area. */
export function estimateCells({ west, south, east, north }, cellKm2) {
    const lonSpan = Math.min(360, east - west);
    const midLat = (north + south) / 2;
    const km2 = (north - south) * KM_PER_DEG * lonSpan * KM_PER_DEG * Math.cos(midLat * Math.PI / 180);
    return Math.ceil(Math.abs(km2) / cellKm2);
}

/** Bounds widened by one cell edge, so cells along the view's edges are drawn. */
export function padBounds({ west, south, east, north }, edgeKm) {
    const dLat = edgeKm / KM_PER_DEG;
    const midLat = (north + south) / 2;
    const dLon = dLat / Math.max(0.05, Math.cos(midLat * Math.PI / 180));
    return { west: west - dLon, south: Math.max(-90, south - dLat), east: east + dLon, north: Math.min(90, north + dLat) };
}

/** Wrap a longitude into [-180, 180]. */
const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * The cells covering the bounds at a resolution. A view half the world wide
 * or more takes every cell, from the base cells.
 */
export function gridCells(h3, bounds, res) {
    const { south, north } = bounds;
    if (res === 0 || bounds.east - bounds.west >= 180) {
        const base = h3.getRes0Cells();
        return res === 0 ? base : base.flatMap(c => h3.cellToChildren(c, res));
    }
    const w = wrap(bounds.west), e = wrap(bounds.east);
    const box = (a, b) => [[north, a], [north, b], [south, b], [south, a], [north, a]];
    // A box across the antimeridian is two boxes.
    const boxes = w > e ? [box(w, 180), box(-180, e)] : [box(w, e)];
    const cells = new Set();
    for (const b of boxes) for (const c of h3.polygonToCells(b, res, false)) cells.add(c);
    return [...cells];
}

/**
 * GeoJSON features for cells. A cell across the antimeridian is drawn on
 * both sides of it, so it shows whichever way the map is panned.
 */
export function cellFeatures(h3, cells, res) {
    const features = [];
    const feature = (h3Index, ring) => ({ type: 'Feature', properties: { h3: h3Index, resolution: res }, geometry: { type: 'Polygon', coordinates: [ring] } });
    for (const c of cells) {
        const ring = h3.cellToBoundary(c, true);
        ring.push(ring[0]);
        const crosses = ring.some((p, i) => i > 0 && Math.abs(p[0] - ring[i - 1][0]) > 180);
        if (!crosses) {
            features.push(feature(c, ring));
        } else {
            features.push(feature(c, ring.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat])));
            features.push(feature(c, ring.map(([lon, lat]) => [lon > 0 ? lon - 360 : lon, lat])));
        }
    }
    return features;
}

/**
 * The resolution and cells to draw for a view: the resolution that suits the
 * zoom and latitude, made coarser until the view needs at most MAX_CELLS.
 */
export function gridFor(h3, { zoom, lat, bounds }) {
    let res = gridResolution(zoom, lat, (r) => h3.getHexagonEdgeLengthAvg(r, 'km'));
    while (res > 0 && estimateCells(bounds, h3.getHexagonAreaAvg(res, 'km2')) > MAX_CELLS) res--;
    const padded = padBounds(bounds, h3.getHexagonEdgeLengthAvg(res, 'km'));
    return { res, cells: gridCells(h3, padded, res) };
}

let h3Promise = null;

/** h3-js: the page's global if it loaded one, else loaded now with SRI. */
export function loadH3() {
    if (globalThis.h3) return Promise.resolve(globalThis.h3);
    h3Promise ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = H3_JS;
        s.integrity = H3_JS_SRI;
        s.crossOrigin = 'anonymous';
        s.onload = () => (globalThis.h3 ? resolve(globalThis.h3) : reject(new Error('h3-js loaded without a global')));
        s.onerror = () => { h3Promise = null; reject(new Error(`Failed to load ${H3_JS}`)); };
        document.head.appendChild(s);
    });
    return h3Promise;
}

export class H3Grid {
    /**
     * @param {Object} map - the MapLibre map
     * @param {Object} [opts]
     * @param {(info: {resolution: number, count: number}) => void} [opts.onUpdate]
     */
    constructor(map, { onUpdate = () => {} } = {}) {
        this.map = map;
        this.onUpdate = onUpdate;
        this.sourceId = 'h3-grid';
        this.fillId = 'h3-grid-fill';
        this.lineId = 'h3-grid-outline';
        this.active = false;
        this._pending = false;
        // 'moveend' also fires after a zoom, so it is the only event needed.
        this._onMove = () => this._schedule();
    }

    async start() {
        this.active = true;
        const h3 = await loadH3();
        if (!this.active) return;   // turned off while h3-js loaded
        this.h3 = h3;
        const map = this.map;
        if (!map.getSource(this.sourceId)) map.addSource(this.sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        if (!map.getLayer(this.fillId)) map.addLayer({ id: this.fillId, type: 'fill', source: this.sourceId, paint: { 'fill-color': '#007cbf', 'fill-opacity': 0.05, 'fill-outline-color': 'rgba(0,0,0,0)' } });
        if (!map.getLayer(this.lineId)) map.addLayer({ id: this.lineId, type: 'line', source: this.sourceId, paint: { 'line-color': '#333333', 'line-width': 1, 'line-opacity': 0.35 } });
        map.on('moveend', this._onMove);
        this.update();
    }

    stop() {
        this.active = false;
        const map = this.map;
        map.off('moveend', this._onMove);
        if (map.getLayer(this.lineId)) map.removeLayer(this.lineId);
        if (map.getLayer(this.fillId)) map.removeLayer(this.fillId);
        if (map.getSource(this.sourceId)) map.removeSource(this.sourceId);
    }

    /** One update per frame, however many moves end in it. */
    _schedule() {
        if (this._pending) return;
        this._pending = true;
        requestAnimationFrame(() => { this._pending = false; this.update(); });
    }

    update() {
        if (!this.active || !this.h3) return;
        const src = this.map.getSource(this.sourceId);
        if (!src) return;
        const b = this.map.getBounds();
        const view = {
            zoom: this.map.getZoom(),
            lat: this.map.getCenter().lat,
            bounds: { west: b.getWest(), south: Math.max(-90, b.getSouth()), east: b.getEast(), north: Math.min(90, b.getNorth()) },
        };
        try {
            const { res, cells } = gridFor(this.h3, view);
            src.setData({ type: 'FeatureCollection', features: cellFeatures(this.h3, cells, res) });
            this.onUpdate({ resolution: res, count: cells.length });
        } catch (err) {
            console.error('[H3Grid] Update failed:', err);
        }
    }
}

const HEX_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5z"/></svg>';

/**
 * The "Hex grid" button, off at start: beside the globe button in the layer
 * panel, or in the overlay rail when there is no panel. While the grid is on,
 * a badge in the rail names its resolution.
 * @param {Object} map - the MapLibre map
 * @returns {{ button: HTMLButtonElement, grid: H3Grid }}
 */
export function mountH3GridToggle(map, doc = document) {
    const badge = doc.createElement('span');
    badge.id = 'h3-res-badge';
    const grid = new H3Grid(map, { onUpdate: ({ resolution }) => { badge.textContent = `H3 res ${resolution}`; } });

    const btn = doc.createElement('button');
    btn.id = 'h3-toggle';
    btn.className = 'panel-btn';
    btn.title = 'Toggle H3 hex grid';
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = HEX_ICON;
    btn.append(' Hex grid');
    const globeBtn = doc.getElementById('globe-btn');
    if (globeBtn) globeBtn.after(btn);
    else mountOverlay(btn, SLOT.HEX_TOGGLE, doc);

    btn.addEventListener('click', () => {
        const on = !grid.active;
        btn.setAttribute('aria-pressed', String(on));
        btn.classList.toggle('active', on);
        if (on) {
            mountOverlay(badge, SLOT.HEX_BADGE, doc);
            grid.start().catch((err) => {
                console.error('[H3Grid] Could not start:', err.message);
                grid.stop();
                btn.setAttribute('aria-pressed', 'false');
                btn.classList.remove('active');
                badge.remove();
            });
        } else {
            grid.stop();
            badge.remove();
        }
    });
    return { button: btn, grid };
}
