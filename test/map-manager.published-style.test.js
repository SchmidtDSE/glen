// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';
import { legendFromPaint } from '../app/legend-helpers.js';

/**
 * apply_style (#440) swaps paint, outline, filter and legend together, and
 * reset_style returns to what boot drew.
 */
function createManager(state) {
    const painted = {};
    const filters = {};
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map([[state.layerId, state]]);
    mm._legendItems = new Map();
    mm._legendGroups = new Map();
    mm._hexLegendRefs = new Map();
    mm._legendEl = null;
    mm._legendContent = null;
    mm._ensureLegend = function () {
        if (this._legendEl) return;
        this._legendEl = document.createElement('div');
        this._legendContent = document.createElement('div');
        this._legendEl.appendChild(this._legendContent);
        document.body.appendChild(this._legendEl);
    };
    mm.map = {
        on: () => {}, off: () => {},
        setPaintProperty: (id, prop, value) => { painted[`${id}:${prop}`] = value; },
        setLayoutProperty: () => {},
        setFilter: (id, f) => { filters[id] = f; },
        getLayer: () => ({ type: 'fill' }),
        queryRenderedFeatures: () => [],
    };
    return { mm, painted, filters };
}

const gap = { 'fill-color': ['match', ['get', 'GAP_Sts'], '1', '#26633A', '2', '#3E9C47', '#888888'], 'fill-opacity': 0.7 };
const access = { 'fill-color': ['match', ['get', 'Access'], 'Open', '#1b9e77', 'Closed', '#d95f02', '#cccccc'] };
const ramp = { 'fill-color': ['interpolate', ['linear'], ['get', 'acres'], 0, '#eee', 1000, '#333'] };

function state(overrides = {}) {
    return {
        layerId: 'fee/fee-pmtiles', mapLayerId: 'layer-fee', outlineLayerId: 'layer-fee-outline',
        displayName: 'Fee', visible: true, type: 'vector', group: null,
        defaultPaint: { ...gap }, defaultOutlinePaint: { 'line-color': '#333333', 'line-width': 0.5 },
        filter: null, defaultFilter: null, styleFilter: null,
        legendLabel: null, legendRange: null, legendGradient: null,
        ...legendFromPaint(gap),
        ...overrides,
    };
}

describe('MapManager.applyPublishedStyle', () => {
    it('swaps paint, outline and legend, and reset returns to the start', () => {
        const { mm, painted } = createManager(state());
        const r = mm.applyPublishedStyle('fee/fee-pmtiles', {
            paint: access, outlinePaint: { 'line-color': '#000000' }, ...legendFromPaint(access),
        });
        expect(r.success).toBe(true);
        expect(painted['layer-fee:fill-color'][1]).toEqual(['get', 'Access']);
        expect(painted['layer-fee-outline:line-color']).toBe('#000000');
        expect(mm.describeLegend('fee/fee-pmtiles').legend.classes.map(c => c.value)).toEqual(['Open', 'Closed']);

        mm.resetStyle('fee/fee-pmtiles');
        expect(painted['layer-fee:fill-color'][1]).toEqual(['get', 'GAP_Sts']);
        expect(painted['layer-fee-outline:line-color']).toBe('#333333');
        expect(mm.describeLegend('fee/fee-pmtiles').legend.classes.map(c => c.value)).toEqual(['1', '2']);
    });

    it('gives a ramp a colorbar in place of the swatches', () => {
        const { mm } = createManager(state());
        mm.applyPublishedStyle('fee/fee-pmtiles', { paint: ramp, ...legendFromPaint(ramp) });
        expect(mm.describeLegend('fee/fee-pmtiles').legend.type).toBe('continuous');
    });

    it("swaps a style's filter, keeps one set since, and reset restores the start's", () => {
        const start = ['==', ['get', 'Mang_Type'], 'FED'];
        const { mm, filters } = createManager(state({ filter: start, defaultFilter: start, styleFilter: start }));
        mm.applyPublishedStyle('fee/fee-pmtiles', { paint: access });
        expect(filters['layer-fee']).toBe(null);
        expect(mm.layers.get('fee/fee-pmtiles').filter).toBe(null);

        const own = ['==', ['get', 'Access'], 'Open'];
        const next = ['>', ['get', 'acres'], 10];
        mm.applyPublishedStyle('fee/fee-pmtiles', { paint: ramp, filter: next });
        expect(filters['layer-fee']).toEqual(next);
        mm.setFilter('fee/fee-pmtiles', own);
        mm.applyPublishedStyle('fee/fee-pmtiles', { paint: access });
        expect(mm.layers.get('fee/fee-pmtiles').filter).toEqual(own);

        mm.applyPublishedStyle('fee/fee-pmtiles', { paint: ramp, filter: next });
        mm.resetStyle('fee/fee-pmtiles');
        expect(mm.layers.get('fee/fee-pmtiles').filter).toEqual(start);
    });

    it('refuses a raster layer', () => {
        const { mm } = createManager(state({ type: 'raster' }));
        expect(mm.applyPublishedStyle('fee/fee-pmtiles', { paint: access }).success).toBe(false);
    });
});
