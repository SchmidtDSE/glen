import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LiveHexLayers, liveHexId, parseToolObject } from '../app/live-hex.js';
import { createHexTileTools } from '../app/hex-tools.js';
import { ParamBus } from '../app/params.js';
import { MapManager } from '../app/map-manager.js';

const stats = (max) => ({ by_res: { 8: { min: 0, max } } });

/** A MapManager stand-in recording what live layers do to it. */
function fakeMap() {
    const layers = new Map();
    return {
        layers,
        added: [],
        updated: [],
        status: [],
        addHexTileLayer: vi.fn(function (o) { layers.set(o.layerId, o); this.added.push(o); return { success: true, layer_id: o.layerId }; }),
        updateHexTileLayer: vi.fn(function (id, o) { this.updated.push({ id, ...o }); return { success: true, layer_id: id }; }),
        setLayerStatus(id, s) { this.status.push({ id, ...s }); },
    };
}

/** register_hex_tiles: a tile URL whose hash names the SQL it was given. */
function fakeRegister() {
    let n = 0;
    return vi.fn(async (sql) => ({ status: 'done', tile_url_template: `https://x/tiles/hex/h${++n}/{z}/{x}/{y}.pbf`, bounds: [0, 0, 1, 1], value_stats: { v: stats(n) }, sql }));
}

const resolve = async (args) => ({ valueColumn: args.value_column || 'v', valueStats: args.value_stats || stats(1), bounds: args.bounds, layerName: 'layer' });

describe('live hex layers (SchmidtDSE/glen#426)', () => {
    let bus, map, register, live;
    beforeEach(() => {
        vi.useFakeTimers();
        bus = new ParamBus([{ id: 'years', token: 'YEAR', options: [2001, 2010, 2020] }]);
        map = fakeMap();
        register = fakeRegister();
        live = new LiveHexLayers({ map, register, resolve, params: () => bus, debounceMs: 50 });
    });
    afterEach(() => vi.useRealTimers());

    const spec = { layer_id: 'loss', sql: 'SELECT h8, v FROM t WHERE year = {{YEAR}}', agg: 'SUM', value_column: 'v', display_name: 'Loss' };

    it('builds the tiles at the current settings and draws them under hex-<layer_id>', async () => {
        const res = await live.add(spec);
        expect(res).toMatchObject({ success: true, layer_id: 'hex-loss', live: true, tokens: ['YEAR'] });
        expect(register).toHaveBeenCalledWith('SELECT h8, v FROM t WHERE year = 2001', 'SUM');
        expect(map.added[0]).toMatchObject({ layerId: 'hex-loss', displayName: 'Loss', valueColumn: 'v', tileUrl: expect.stringContaining('/h1/') });
    });

    it('rebuilds the same layer when a control its SQL uses changes', async () => {
        await live.add(spec);
        bus.set('years', 2020);
        expect(map.status.at(-1)).toMatchObject({ id: 'hex-loss', busy: true });
        await vi.advanceTimersByTimeAsync(60);
        expect(register).toHaveBeenLastCalledWith('SELECT h8, v FROM t WHERE year = 2020', 'SUM');
        expect(map.addHexTileLayer).toHaveBeenCalledTimes(1);
        expect(map.updated).toHaveLength(1);
        expect(map.updated[0]).toMatchObject({ id: 'hex-loss', tileUrl: expect.stringContaining('/h2/'), valueStats: stats(2) });
        expect(map.status.at(-1)).toEqual({ id: 'hex-loss' });
    });

    it('waits for the controls to settle, and drops a build a newer one overtook', async () => {
        await live.add(spec);
        let release;
        register.mockImplementationOnce(async () => { await new Promise(r => { release = r; }); return { status: 'done', tile_url_template: 'https://x/tiles/hex/old/{z}/{x}/{y}.pbf' }; });
        bus.set('years', 2010);
        await vi.advanceTimersByTimeAsync(60);           // the slow build starts
        bus.set('years', 2020);
        await vi.advanceTimersByTimeAsync(60);           // the newer one finishes first
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(map.updated).toHaveLength(1);
        expect(map.updated[0].tileUrl).not.toContain('/old/');
    });

    it('stops updating a layer the reader removed', async () => {
        await live.add(spec);
        map.layers.delete('hex-loss');
        bus.set('years', 2020);
        await vi.advanceTimersByTimeAsync(60);
        expect(register).toHaveBeenCalledTimes(1);
        expect(live.has('loss')).toBe(false);
    });

    it('shows why a rebuild failed on the layer row, and keeps the layer', async () => {
        await live.add(spec);
        register.mockRejectedValueOnce(new Error('timed out'));
        bus.set('years', 2020);
        await vi.advanceTimersByTimeAsync(60);
        expect(map.status.at(-1)).toMatchObject({ id: 'hex-loss', error: expect.stringMatching(/timed out/) });
        expect(live.has('loss')).toBe(true);
    });

    it('refuses tokens without controls, and a bad layer_id', async () => {
        const bare = new LiveHexLayers({ map, register, resolve });
        expect(await bare.add(spec)).toMatchObject({ success: false, error: expect.stringMatching(/no controls/) });
        expect(await live.add({ ...spec, layer_id: 'a b' })).toMatchObject({ success: false });
        expect(register).not.toHaveBeenCalled();
    });

    it('draws SQL without tokens once, as a plain hex layer', async () => {
        const res = await live.add({ layer_id: 'all', sql: 'SELECT h8 FROM t' });
        expect(res.success).toBe(true);
        expect(res.live).toBeUndefined();
        expect(register).toHaveBeenCalledWith('SELECT h8 FROM t', 'COUNT');
    });
});

describe('add_hex_tile_layer with sql', () => {
    it('takes sql, agg and layer_id only when given live layers', async () => {
        const plain = createHexTileTools({})[0];
        expect(plain.inputSchema.properties.sql).toBeUndefined();
        expect(plain.inputSchema.required).toEqual(['tile_url']);

        const map = fakeMap();
        const live = new LiveHexLayers({ map, register: fakeRegister(), resolve });
        const [add, remove] = createHexTileTools(map, { live });
        expect(add.inputSchema.properties.sql).toBeDefined();
        expect(add.inputSchema.required).toEqual([]);
        const res = JSON.parse(await add.execute({ sql: 'SELECT h8 FROM t', layer_id: 'pts' }));
        expect(res).toMatchObject({ success: true, layer_id: 'hex-pts' });
        expect(JSON.parse(await add.execute({})).success).toBe(false);

        map.removeHexTileLayer = (id) => ({ success: true, layer_id: id });
        await remove.execute({ layer_id: 'hex-pts' });
        expect(live.has('pts')).toBe(false);
    });
});

describe('helpers', () => {
    it('names the layer and reads a tool result', () => {
        expect(liveHexId('loss')).toBe('hex-loss');
        expect(liveHexId('hex-loss')).toBe('hex-loss');
        expect(parseToolObject('note\n{"status":"done"}')).toEqual({ status: 'done' });
        expect(parseToolObject('no json')).toBe(null);
    });
});

describe('MapManager.updateHexTileLayer', () => {
    function manager() {
        const sources = new Map();
        const paint = [];
        const mm = Object.create(MapManager.prototype);
        mm.layers = new Map();
        mm._showLegend = () => {};
        mm._refreshLegend = vi.fn();
        mm.map = {
            addSource(id, s) { sources.set(id, { ...s, setTiles(t) { this.tiles = t; } }); },
            getSource(id) { return sources.get(id); },
            addLayer() {}, setLayoutProperty() {}, setPaintProperty(id, k, v) { paint.push([id, k, v]); },
            on() {}, off() {}, fitBounds() {},
        };
        return { mm, sources, paint };
    }

    it('keeps the id and points the source at the new tiles, with a new colour scale', () => {
        const { mm, sources, paint } = manager();
        const add = mm.addHexTileLayer({ layerId: 'hex-loss', tileUrl: 'https://x/tiles/hex/a/{z}/{x}/{y}.pbf', valueColumn: 'v', valueStats: stats(1), bounds: [0, 0, 1, 1], palette: 'viridis', opacity: 0.7, displayName: 'Loss', fitBounds: false });
        expect(add).toMatchObject({ success: true, layer_id: 'hex-loss' });
        const res = mm.updateHexTileLayer('hex-loss', { tileUrl: 'https://x/tiles/hex/b/{z}/{x}/{y}.pbf', valueColumn: 'v', valueStats: stats(9) });
        expect(res).toMatchObject({ success: true, layer_id: 'hex-loss' });
        expect(sources.get('hex-loss').tiles).toEqual(['https://x/tiles/hex/b/{z}/{x}/{y}.pbf']);
        expect(paint.some(([id, k]) => id === 'hex-loss' && k === 'fill-color')).toBe(true);
        expect(mm.layers.get('hex-loss').hexValueStats).toEqual(stats(9));
        expect(mm._refreshLegend).toHaveBeenCalledWith('hex-loss');
    });

    it('refuses a layer id that is not a hex id, and an unknown layer', () => {
        const { mm } = manager();
        expect(mm.addHexTileLayer({ layerId: 'loss', tileUrl: 'https://x/tiles/hex/a/{z}/{x}/{y}.pbf', valueColumn: 'v', valueStats: stats(1) }).success).toBe(false);
        expect(mm.updateHexTileLayer('hex-none', { tileUrl: 'https://x/tiles/hex/a/{z}/{x}/{y}.pbf', valueColumn: 'v', valueStats: stats(1) }).success).toBe(false);
    });
});
