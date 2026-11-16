// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as h3 from 'h3-js';
import {
    gridResolution, metresPerPixel, estimateCells, padBounds, gridCells, cellFeatures, gridFor,
    MIN_EDGE_PX, MAX_CELLS, H3Grid,
} from '../app/h3-grid.js';

const edgeKm = (r) => h3.getHexagonEdgeLengthAvg(r, 'km');

describe('the grid\'s resolution', () => {
    it('picks the finest resolution whose cells are at least MIN_EDGE_PX on screen', () => {
        for (const [zoom, lat] of [[3, 0], [6, 37], [9, 37], [13, 60]]) {
            const res = gridResolution(zoom, lat, edgeKm);
            const px = (r) => edgeKm(r) * 1000 / metresPerPixel(zoom, lat);
            if (res > 0) expect(px(res)).toBeGreaterThanOrEqual(MIN_EDGE_PX);
            if (res < 15) expect(px(res + 1)).toBeLessThan(MIN_EDGE_PX);
        }
    });

    it('matches v3\'s choices at mid-latitudes', () => {
        // v3 mapped zoom to resolution by a table: 6 → 4, 9 → 6, 13 → 9.
        expect(gridResolution(6, 37, edgeKm)).toBe(4);
        expect(gridResolution(9, 37, edgeKm)).toBe(6);
        expect(gridResolution(13, 37, edgeKm)).toBe(9);
    });

    it('draws finer cells at high latitude, where the map stretches', () => {
        expect(gridResolution(6, 65, edgeKm)).toBeGreaterThan(gridResolution(6, 0, edgeKm));
    });
});

describe('the grid\'s cells', () => {
    const california = { west: -124, south: 32, east: -114, north: 42 };

    it('stays under MAX_CELLS by coarsening, even zoomed in on a wide view', () => {
        const { res, cells } = gridFor(h3, { zoom: 9, lat: 37, bounds: california });
        expect(cells.length).toBeLessThanOrEqual(MAX_CELLS * 1.5);
        expect(res).toBeLessThan(gridResolution(9, 37, edgeKm));
        expect(estimateCells(california, h3.getHexagonAreaAvg(res, 'km2'))).toBeLessThanOrEqual(MAX_CELLS);
    });

    it('covers the view\'s edges', () => {
        const res = 5;
        const b = { west: -120, south: 37, east: -119, north: 38 };
        const cells = new Set(gridCells(h3, padBounds(b, edgeKm(res)), res));
        // The cells under the view's corners are all drawn.
        for (const [lat, lon] of [[37, -120], [38, -120], [37, -119], [38, -119]]) {
            expect(cells.has(h3.latLngToCell(lat, lon, res))).toBe(true);
        }
    });

    it('splits a view across the antimeridian, and draws a crossing cell on both sides', () => {
        const res = 3;
        const b = { west: 175, south: -20, east: 185, north: -10 };
        const cells = gridCells(h3, b, res);
        expect(cells).toContain(h3.latLngToCell(-15, 178, res));
        expect(cells).toContain(h3.latLngToCell(-15, -178, res));
        const features = cellFeatures(h3, cells, res);
        const crossing = features.filter(f => f.geometry.coordinates[0].some(([lon]) => lon > 180 || lon < -180));
        expect(crossing.length).toBeGreaterThan(0);
        for (const f of features) {
            const lons = f.geometry.coordinates[0].map(([lon]) => lon);
            expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(180);
        }
    });

    it('takes every cell when the view is half the world or more', () => {
        expect(gridCells(h3, { west: -180, south: -85, east: 180, north: 85 }, 0)).toHaveLength(122);
        expect(gridCells(h3, { west: -200, south: -85, east: 200, north: 85 }, 1)).toHaveLength(842);
    });
});

describe('H3Grid', () => {
    afterEach(() => { delete globalThis.h3; vi.restoreAllMocks(); });

    function fakeMap() {
        const handlers = {};
        const sources = new Map();
        const layers = new Map();
        return {
            handlers, sources, layers,
            getSource: (id) => sources.get(id),
            addSource: (id, s) => sources.set(id, { ...s, setData(d) { this.data = d; } }),
            removeSource: (id) => sources.delete(id),
            getLayer: (id) => layers.get(id),
            addLayer: (l) => layers.set(l.id, l),
            removeLayer: (id) => layers.delete(id),
            on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
            off: (ev, fn) => { handlers[ev] = (handlers[ev] || []).filter(f => f !== fn); },
            getZoom: () => 6,
            getCenter: () => ({ lat: 37 }),
            getBounds: () => ({ getWest: () => -122, getSouth: () => 36, getEast: () => -118, getNorth: () => 38 }),
        };
    }

    it('draws on start, updates only on moveend, and removes everything on stop', async () => {
        globalThis.h3 = h3;
        const map = fakeMap();
        const onUpdate = vi.fn();
        const grid = new H3Grid(map, { onUpdate });
        await grid.start();
        expect(map.sources.get('h3-grid').data.features.length).toBeGreaterThan(0);
        expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: 4 }));
        expect(Object.keys(map.handlers)).toEqual(['moveend']);
        grid.stop();
        expect(map.sources.size + map.layers.size).toBe(0);
        expect(map.handlers.moveend).toEqual([]);
    });

    it('does nothing if turned off while h3-js loads', async () => {
        const map = fakeMap();
        const grid = new H3Grid(map);
        const started = grid.start();   // no global: injects the script tag
        const script = document.head.querySelector('script[src*="h3-js@4.1.0"]');
        expect(script.integrity).toMatch(/^sha384-/);
        grid.stop();
        globalThis.h3 = h3;
        script.onload();
        await started;
        expect(map.sources.size + map.layers.size).toBe(0);
    });
});
