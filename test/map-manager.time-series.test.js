import { describe, it, expect, vi, afterEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';
import { createSetTimeTool } from '../app/map-tools.js';
import { resolveFrameSource } from '../app/dataset-catalog.js';

// A map that records sources, layers (in stack order) and paint, fires
// `sourcedata` events, and reports a source as loaded once a test finishes
// its tiles with tileDone().
function fakeMap() {
    const sources = new Map();
    const order = ['layer-sst'];
    const layers = new Map([['layer-sst', { id: 'layer-sst', layout: { visibility: 'visible' }, paint: {} }]]);
    const loaded = new Set();
    const handlers = { sourcedata: new Set(), error: new Set(), render: new Set() };
    const map = {
        sources, layers, order, loaded, handlers,
        getSource: (id) => sources.get(id) || null,
        addSource: (id, s) => sources.set(id, s),
        removeSource: (id) => { sources.delete(id); loaded.delete(id); },
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
        on: (ev, h) => handlers[ev]?.add(h),
        off: (ev, h) => handlers[ev]?.delete(h),
        once: (ev, h) => { const w = (e) => { handlers[ev].delete(w); h(e); }; w.inner = h; handlers[ev].add(w); },
        triggerRepaint: () => { map.repaints = (map.repaints || 0) + 1; },
        // The map draws a frame.
        render() { for (const h of [...handlers.render]) h({ type: 'render' }); },
        // A source's tiles finish loading.
        tileDone(id) {
            loaded.add(id);
            for (const h of [...handlers.sourcedata]) h({ type: 'sourcedata', sourceId: id, tile: {} });
            map.render();
        },
        opacity: (id) => layers.get(id)?.paint['raster-opacity'],
    };
    return map;
}

const FRAMES = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06']
    .map(d => ({ datetime: d, href: `https://s3/b/sst-${d}.tif` }));
const id = (d) => `layer-sst-t2026-01-0${d}`;

async function makeManager({ visible = true, control = { bind: 'frame', frames: 'sst-frames', preload: 2 } } = {}) {
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
    it('keeps the base layer up until the first frame has tiles, then hands over', async () => {
        const mm = await makeManager();
        const { map } = mm;
        // The latest frame and two preloads sit below the base layer, all transparent.
        expect(map.order).toEqual([id(6), id(1), id(2), 'layer-sst']);
        expect(map.layers.get('layer-sst').layout.visibility).toBe('visible');
        expect(map.opacity(id(6))).toBe(0);
        expect(map.sources.get(id(6)).tiles[0]).toBe('https://titiler/tiles?url=https://s3/b/sst-2026-01-06.tif');
        map.tileDone(id(6));
        expect(map.opacity(id(6))).toBe(0.8);
        expect(map.layers.get('layer-sst').layout.visibility).toBe('none');
    });

    it('does not count a source as loaded before any tile has finished', async () => {
        const mm = await makeManager();
        mm.map.loaded.add(id(6));   // MapLibre says loaded, but no tile event yet
        await mm.setTime({ layer_id: 'sst', date: '2026-01-06' });
        expect(mm.map.opacity(id(6))).toBe(0);
    });

    it('a jump keeps the old frame on screen until the new one loads', async () => {
        const mm = await makeManager();
        const { map } = mm;
        map.tileDone(id(6));
        await mm.setTime({ layer_id: 'sst', date: '2026-01-03' });
        // 3 January has no tiles yet: 6 January stays up, and is not removed.
        expect(map.opacity(id(6))).toBe(0.8);
        expect(map.opacity(id(3))).toBe(0);
        map.tileDone(id(3));
        expect(map.opacity(id(3))).toBe(0.8);
        // Now that 3 January is up, 6 January is outside the kept frames and goes.
        expect(map.layers.has(id(6))).toBe(false);
        expect(map.order).toEqual([id(3), id(4), id(5), 'layer-sst']);
    });

    it('a second jump before the first loads replaces the pending frame', async () => {
        const mm = await makeManager();
        const { map } = mm;
        map.tileDone(id(6));
        await mm.setTime({ layer_id: 'sst', date: '2026-01-01' });
        await mm.setTime({ layer_id: 'sst', date: '2026-01-04' });
        map.tileDone(id(1));   // the abandoned frame finishing must not take over
        expect(map.opacity(id(1)) ?? 0).toBe(0);
        expect(map.opacity(id(6))).toBe(0.8);
        map.tileDone(id(4));
        expect(map.opacity(id(4))).toBe(0.8);
    });

    it('a jump to a loaded frame swaps at once', async () => {
        const mm = await makeManager();
        const { map } = mm;
        map.tileDone(id(6));
        map.tileDone(id(1));   // a preload
        await mm.setTime({ layer_id: 'sst', date: '2026-01-01' });
        expect(map.opacity(id(1))).toBe(0.8);
        map.render();
        expect(map.layers.has(id(6))).toBe(false);   // swapped out after the render, and outside the kept frames
    });

    it('a failed tile still counts as finished, so playback cannot stall on it', async () => {
        const mm = await makeManager();
        const { map } = mm;
        map.tileDone(id(6));
        await mm.setTime({ layer_id: 'sst', date: '2026-01-02' });
        map.loaded.add(id(2));
        for (const h of map.handlers.error) h({ type: 'error', sourceId: id(2), error: new Error('500') });
        expect(map.opacity(id(2))).toBe(0.8);
    });

    it('hiding the layer hides its frames and keeps them; showing brings the frame back', async () => {
        const mm = await makeManager();
        const { map } = mm;
        map.tileDone(id(6));
        mm.hideLayer('sst');
        expect(map.layers.get(id(6)).layout.visibility).toBe('none');
        expect(map.layers.get('layer-sst').layout.visibility).toBe('none');
        mm.showLayer('sst');
        expect(map.layers.get(id(6)).layout.visibility).toBe('visible');
        expect(map.opacity(id(6))).toBe(0.8);
        expect(map.layers.get('layer-sst').layout.visibility).toBe('none');
    });

    it('a layer that starts hidden loads no frames until shown, then uses the base layer meanwhile', async () => {
        const mm = await makeManager({ visible: false });
        mm.map.layers.get('layer-sst').layout.visibility = 'none';
        expect(mm.map.order).toEqual(['layer-sst']);
        mm.showLayer('sst');
        expect(mm.map.layers.get('layer-sst').layout.visibility).toBe('visible');
        expect(mm.map.order).toContain(id(6));
    });

    it('setTime sets the range and step, and plays and stops', async () => {
        const mm = await makeManager();
        let r = await mm.setTime({ layer_id: 'sst', start: '2026-01-02', step: 2, play: true });
        expect(r).toMatchObject({ success: true, first: '2026-01-02', last: '2026-01-06', frames: 3, step: 2, playing: true });
        r = await mm.setTime({ layer_id: 'sst', play: false });
        expect(r.playing).toBe(false);
        mm.layers.get('sst').framePlayer.destroy();
        expect(mm.map.order).toEqual(['layer-sst']);
        expect(mm.map.handlers.sourcedata.size).toBe(0);
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
        mm.map.tileDone(id(3));
        expect(mm.map.opacity(id(3))).toBe(0.8);
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
        expect(state.timeSeries).toMatchObject({ date: '2026-01-06', frames: 6, playing: false });
    });

    it('set_style opacity reaches the frame on screen', async () => {
        const mm = await makeManager();
        mm.map.tileDone(id(6));
        mm.setStyle('sst', { 'raster-opacity': 0.3 });
        expect(mm.map.opacity(id(6))).toBe(0.3);
    });

    it('the frame layers move with the layer in the stack', async () => {
        const mm = await makeManager();
        expect(mm._mapSublayersFor('sst')).toEqual([id(6), id(1), id(2), 'layer-sst']);
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

describe('frame swap waits for a render (#421)', () => {
    it('the old frame stays drawn until the map has rendered the new one', async () => {
        const mm = await makeManager();
        const { map } = mm;
        map.tileDone(id(6));
        await mm.setTime({ layer_id: 'sst', date: '2026-01-03' });
        // The new frame's tiles finish, but the map has not drawn yet.
        map.loaded.add(id(3));
        for (const h of [...map.handlers.sourcedata]) h({ type: 'sourcedata', sourceId: id(3), tile: {} });
        expect(map.opacity(id(3))).toBe(0.8);
        expect(map.opacity(id(6))).toBe(0.8);    // both up for one render
        expect(map.repaints).toBeGreaterThan(0);
        map.render();
        expect(map.layers.has(id(6))).toBe(false);   // hidden, then removed as outside the kept frames
        expect(map.opacity(id(3))).toBe(0.8);
    });

    it('the base layer stays visible until the first frame has rendered', async () => {
        const mm = await makeManager();
        const { map } = mm;
        map.loaded.add(id(6));
        for (const h of [...map.handlers.sourcedata]) h({ type: 'sourcedata', sourceId: id(6), tile: {} });
        expect(map.layers.get('layer-sst').layout.visibility).toBe('visible');
        map.render();
        expect(map.layers.get('layer-sst').layout.visibility).toBe('none');
    });
});
