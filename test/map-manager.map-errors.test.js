import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * A map that, like MapLibre, reports invalid values through its `error`
 * event instead of throwing. `rejects(prop or 'filter', value)` decides.
 */
function createManager(rejects = () => null) {
    const listeners = new Set();
    const fire = (msg) => listeners.forEach(h => h({ error: new Error(msg) }));
    const calls = { paint: [], filter: [] };
    const map = {
        on: (ev, h) => { if (ev === 'error') listeners.add(h); },
        off: (ev, h) => { if (ev === 'error') listeners.delete(h); },
        getLayer: () => ({ type: 'fill' }),
        setPaintProperty(id, prop, value) {
            const msg = rejects(prop, value);
            if (msg) return fire(msg);
            calls.paint.push({ prop, value });
        },
        setFilter(id, f) {
            const msg = rejects('filter', f);
            if (msg) return fire(msg);
            calls.filter.push({ id, f });
        },
        queryRenderedFeatures: () => [],
    };
    const mm = Object.create(MapManager.prototype);
    mm.map = map;
    mm.layers = new Map([['A', { type: 'vector', mapLayerId: 'layer-A', displayName: 'A', defaultPaint: {}, filter: null }]]);
    mm._refreshLegend = () => {};
    mm._listeners = listeners;
    mm._calls = calls;
    return mm;
}

describe('setStyle rejects a style that is not a paint object (#409)', () => {
    it('rejects an empty string without touching the map', () => {
        const mm = createManager();
        const r = mm.setStyle('A', '');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/empty string/);
        expect(mm._calls.paint).toHaveLength(0);
    });

    it('rejects a whitespace string instead of iterating its characters', () => {
        const mm = createManager();
        const r = mm.setStyle('A', '      ');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/empty string/);
        expect(mm._calls.paint).toHaveLength(0);
    });

    it('rejects an empty object, an array and null', () => {
        const mm = createManager();
        expect(mm.setStyle('A', {}).error).toMatch(/empty object/);
        expect(mm.setStyle('A', ['fill-color']).error).toMatch(/an array/);
        expect(mm.setStyle('A', null).success).toBe(false);
        expect(mm._calls.paint).toHaveLength(0);
    });

    it('parses a JSON string into a paint object', () => {
        const mm = createManager();
        const r = mm.setStyle('A', '{"fill-color": "#ff0000"}');
        expect(r.success).toBe(true);
        expect(mm._calls.paint).toEqual([{ prop: 'fill-color', value: '#ff0000' }]);
    });
});

describe('MapLibre error events become tool failures (#409)', () => {
    it('setStyle reports a value MapLibre rejected and does not record it', () => {
        const mm = createManager((prop) => prop === 'fill-opacity' ? 'fill-opacity: number expected, string found' : null);
        const r = mm.setStyle('A', { 'fill-color': 'red', 'fill-opacity': 'solid' });
        expect(r.success).toBe(false);
        expect(r.updates.find(u => u.property === 'fill-opacity').error).toMatch(/number expected/);
        expect(mm.layers.get('A').currentPaint).toEqual({ 'fill-color': 'red' });
    });

    it('setFilter reports an expression MapLibre rejected and keeps the old filter', () => {
        const mm = createManager((what) => what === 'filter' ? 'filter[2]: Expected number but found string instead.' : null);
        const r = mm.setFilter('A', ['==', ['get', 'reGAP'], '1']);
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/Expected number but found string/);
        expect(mm.layers.get('A').filter).toBe(null);
    });

    it('removes its error listener after the call', () => {
        const mm = createManager();
        mm.setStyle('A', { 'fill-color': 'red' });
        mm.setFilter('A', ['==', ['get', 'x'], 1]);
        expect(mm._listeners.size).toBe(0);
    });
});
