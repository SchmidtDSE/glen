import { describe, it, expect, vi, afterEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';
import { createSetTimeTool } from '../app/map-tools.js';
import { resolveFrameSource } from '../app/dataset-catalog.js';

// A map that records sources, layers (in stack order) and paint, and reports
// a source as loaded once the test marks it.
function fakeMap() {
    const sources = new Map();
    const order = ['layer-sst'];
    const layers = new Map([['layer-sst', { id: 'layer-sst', layout: { visibility: 'visible' }, paint: {} }]]);
    const loaded = new Set();
    return {
        sources, layers, order, loaded,
        getSource: (id) => sources.get(id) || null,
        addSource: (id, s) => sources.set(id, s),
        removeSource: (id) => sources.delete(id),
        getLayer: (id) => layers.get(id) || null,
        addLayer: (def, before) => {
            layers.set(def.id, { ...def, layout: { ...def.layout }, paint: { ...def.paint } });
            const i = before ? order.indexOf(before) : order.length;
            order.splice(i < 0 ? order.length : i, 0, def.id);
        },
        removeLayer: (id) => { layers.delete(id); order.splice(order.indexOf(id), 1); },
        setPaintProperty: (id, k, v) => { layers.get(id).paint[k] = v; },
        setLayoutProperty: (id, k, v) => { layers.get(id).layout[k] = v; },
        isSourceLoaded: (id) => loaded.has(id),
        on() {}, off() {},
    };
}

const FRAMES = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].map(d => ({ datetime: d, href: `https://s3/b/sst-${d}.tif` }));

async function makeManager({ visible = true, control = { bind: 'frame', frames: 'sst-frames' } } = {}) {
    const mm = Object.create(MapManager.prototype);
    mm.map = fakeMap();
    mm.layers = new Map([['sst', {
        layerId: 'sst', mapLayerId: 'layer-sst', type: 'raster', displayName: 'SST',
        visible, defaultPaint: { 'raster-opacity': 0.8 }, legendType: null,
    }]]);
    mm._refreshLegend = () => {};
    mm._hasLegend = () => false;
    mm._syncToggleGroupLegends = () => {};
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ frames: FRAMES }) }));
    await mm._registerFramePlayer('sst', {
        control,
        frameSource: { indexUrl: 'https://s3/b/frames.json' },
        frameTileUrl: (href) => `https://titiler/tiles?url=${href}`,
    });
    return mm;
}

afterEach(() => { delete globalThis.fetch; });

describe('raster time series in MapManager (#421)', () => {
    it('replaces the base layer with the latest frame plus preloads, below it in the stack', async () => {
        const mm = await makeManager();
        const { map } = mm;
        expect(map.layers.get('layer-sst').layout.visibility).toBe('none');
        expect(map.order).toEqual(['layer-sst-t2026-01-04', 'layer-sst-t2026-01-01', 'layer-sst-t2026-01-02', 'layer-sst']);
        expect(map.layers.get('layer-sst-t2026-01-04').paint['raster-opacity']).toBe(0.8);
        expect(map.layers.get('layer-sst-t2026-01-01').paint['raster-opacity']).toBe(0);
        expect(map.sources.get('layer-sst-t2026-01-04').tiles[0]).toBe('https://titiler/tiles?url=https://s3/b/sst-2026-01-04.tif');
    });

    it('a hidden layer loads no frames until shown', async () => {
        const mm = await makeManager({ visible: false });
        expect(mm.map.order).toEqual(['layer-sst']);
        mm.showLayer('sst');
        expect(mm.map.layers.get('layer-sst').layout.visibility).toBe('none');
        expect(mm.map.order).toContain('layer-sst-t2026-01-04');
        mm.hideLayer('sst');
        expect(mm.map.order).toEqual(['layer-sst']);
    });

    it('setTime jumps to a date and moves the opacity to that frame', async () => {
        const mm = await makeManager();
        const r = await mm.setTime({ layer_id: 'sst', date: '2026-01-02' });
        expect(r).toMatchObject({ success: true, date: '2026-01-02', frames: 4 });
        expect(mm.map.layers.get('layer-sst-t2026-01-02').paint['raster-opacity']).toBe(0.8);
        // The old frame stays only as a preload, at zero opacity; 1 January is behind and is removed.
        expect(mm.map.layers.get('layer-sst-t2026-01-04').paint['raster-opacity']).toBe(0);
        expect(mm.map.layers.has('layer-sst-t2026-01-01')).toBe(false);
    });

    it('setTime sets the range and step, and plays and stops', async () => {
        const mm = await makeManager();
        let r = await mm.setTime({ layer_id: 'sst', start: '2026-01-02', step: 2, play: true });
        expect(r).toMatchObject({ success: true, first: '2026-01-02', last: '2026-01-04', frames: 2, step: 2, playing: true });
        r = await mm.setTime({ layer_id: 'sst', play: false });
        expect(r.playing).toBe(false);
        mm.layers.get('sst').framePlayer.destroy();
    });

    it('setTime reports an empty range and a non-series layer', async () => {
        const mm = await makeManager();
        expect(await mm.setTime({ layer_id: 'sst', start: '2030-01-01' })).toMatchObject({ success: false, error: /No frames/ });
        mm.layers.set('roads', { type: 'vector', mapLayerId: 'layer-roads' });
        expect(await mm.setTime({ layer_id: 'roads' })).toMatchObject({ success: false, error: /not a time series.*sst/ });
    });

    it('setTime shows a hidden layer', async () => {
        const mm = await makeManager({ visible: false });
        mm.syncCheckbox = vi.fn();
        await mm.setTime({ layer_id: 'sst', date: '2026-01-03' });
        expect(mm.layers.get('sst').visible).toBe(true);
        expect(mm.syncCheckbox).toHaveBeenCalledWith('sst');
        expect(mm.map.layers.get('layer-sst-t2026-01-03').paint['raster-opacity']).toBe(0.8);
    });

    it('reports a frame list that failed to load and keeps the base layer', async () => {
        const mm = Object.create(MapManager.prototype);
        mm.map = fakeMap();
        mm.layers = new Map([['sst', { mapLayerId: 'layer-sst', type: 'raster', visible: true, defaultPaint: {} }]]);
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403 }));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        await mm._registerFramePlayer('sst', { control: {}, frameSource: { indexUrl: 'u' }, frameTileUrl: (h) => h });
        err.mockRestore();
        expect(mm.map.layers.get('layer-sst').layout.visibility).toBe('visible');
        expect(await mm.setTime({ layer_id: 'sst', date: '2026-01-01' })).toMatchObject({ success: false, error: /403/ });
    });

    it('get_map_state describes the series', async () => {
        const mm = await makeManager();
        mm.describeFilter = () => '';
        mm.describeLegend = () => ({ legend: null });
        const state = mm.getMapState().layers.sst;
        expect(state.timeSeries).toMatchObject({ date: '2026-01-04', frames: 4, playing: false });
    });

    it('set_style opacity reaches the frame on screen', async () => {
        const mm = await makeManager();
        mm.setStyle('sst', { 'raster-opacity': 0.3 });
        expect(mm.map.layers.get('layer-sst-t2026-01-04').paint['raster-opacity']).toBe(0.3);
    });

    it('the frame layers move with the layer in the stack', async () => {
        const mm = await makeManager();
        expect(mm._mapSublayersFor('sst')).toEqual(['layer-sst-t2026-01-04', 'layer-sst-t2026-01-01', 'layer-sst-t2026-01-02', 'layer-sst']);
    });
});

describe('set_time tool', () => {
    it('passes its arguments to MapManager.setTime', async () => {
        const mm = { setTime: vi.fn(async (a) => ({ success: true, date: a.date })) };
        const tool = createSetTimeTool(mm);
        expect(tool.name).toBe('set_time');
        expect(tool.inputSchema.required).toEqual(['layer_id']);
        expect(JSON.parse(await tool.execute({ layer_id: 'sst', date: '2026-01-02' }))).toEqual({ success: true, date: '2026-01-02' });
    });
});

describe('resolveFrameSource', () => {
    const asset = { href: 'https://s3/b/d/sst-latest.tif' };
    const assets = { 'sst-frames': { href: 'https://s3/b/d/frames.json' } };

    it('reads a named frame-list asset', () => {
        expect(resolveFrameSource({ bind: 'frame', frames: 'sst-frames' }, asset, assets)).toEqual({ indexUrl: 'https://s3/b/d/frames.json' });
    });

    it('lists the bucket for frames: "list"', () => {
        expect(resolveFrameSource({ bind: 'frame', frames: 'list' }, asset, assets)).toEqual({ listFrom: asset.href });
    });

    it('returns null for other controls and for a missing asset', () => {
        expect(resolveFrameSource({ bind: 'filter' }, asset, assets)).toBe(null);
        expect(resolveFrameSource(null, asset, assets)).toBe(null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveFrameSource({ bind: 'frame', frames: 'nope' }, asset, assets)).toBe(null);
        warn.mockRestore();
    });
});
