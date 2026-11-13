import { describe, it, expect, vi } from 'vitest';
import plugin, { hasWorkerServer, liveHexClient } from '../core/plugins/hex.js';

const registry = (extra = {}) => {
    const tools = new Map(Object.entries(extra));
    return { tools, registerLocal: vi.fn((t) => tools.set(t.name, t)) };
};
const mapWith = () => ({ addHexTileLayer: vi.fn(() => ({ success: true, layer_id: 'hex-abc' })), removeHexTileLayer: vi.fn(() => ({ success: true })) });

describe('glen core hex plugin (#445)', () => {
    it('adds the full app\'s two hex tools, reading metadata over https for a server', async () => {
        const ctx = { config: { plugins: [{ url: 'mcp.js', options: { url: 'https://mcp/mcp' } }] }, map: mapWith(), tools: registry() };
        const load = vi.spyOn(plugin, 'loadHexProtocol');
        await plugin.setup(ctx, {});
        expect([...ctx.tools.tools.keys()]).toEqual(['add_hex_tile_layer', 'remove_hex_tile_layer']);
        expect(load).not.toHaveBeenCalled();
        const meta = { value_columns: ['n'], value_stats: { n: { by_res: { 8: { min: 0, max: 9 } } } }, bounds: [0, 0, 1, 1], layer_name: 'layer' };
        const realFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => meta }));
        await ctx.tools.tools.get('add_hex_tile_layer').execute({ tile_url: 'https://mcp/tiles/hex/abc/{z}/{x}/{y}.pbf' });
        expect(globalThis.fetch).toHaveBeenCalledWith('https://mcp/tiles/hex/abc/metadata.json');
        expect(ctx.map.addHexTileLayer.mock.calls[0][0]).toMatchObject({ valueColumn: 'n', bounds: [0, 0, 1, 1] });
        globalThis.fetch = realFetch;
        load.mockRestore();
    });

    it('with a worker server, registers the tile protocol and reads metadata through the worker', async () => {
        const sdk = { readResource: vi.fn() };
        const ctx = {
            config: { plugins: [{ url: 'mcp.js', options: { servers: [{ worker: 'w.js' }] } }] },
            map: mapWith(),
            tools: registry({ register_hex_tiles: { source: 'remote', mcpClient: { client: sdk } } }),
        };
        const addProtocol = vi.fn();
        const meta = { value_columns: ['n'], value_stats: { n: { by_res: { 6: { min: 1, max: 3 } } } }, bounds: [1, 2, 3, 4] };
        let seenClient = null;
        vi.spyOn(plugin, 'loadHexProtocol').mockResolvedValue({
            addHexTileProtocol: (ml, client) => { seenClient = client; ml.addProtocol('geoquerywasm', () => {}); },
            hexFetch: (client) => async (url) => ({ ok: true, json: async () => ({ ...meta, url, from: client.client }) }),
        });
        await plugin.setup(ctx, { maplibregl: { addProtocol } });
        expect(plugin.loadHexProtocol).toHaveBeenCalledWith('v0.6.0');
        expect(addProtocol).toHaveBeenCalledWith('geoquerywasm', expect.any(Function));
        expect(seenClient.client).toBe(sdk);
        await ctx.tools.tools.get('add_hex_tile_layer').execute({ tile_url: 'geoquerywasm://tiles/hex/h1/{z}/{x}/{y}.pbf' });
        expect(ctx.map.addHexTileLayer.mock.calls[0][0]).toMatchObject({ tileUrl: 'geoquerywasm://tiles/hex/h1/{z}/{x}/{y}.pbf', bounds: [1, 2, 3, 4] });
        vi.restoreAllMocks();
    });

    it('finds a worker server in either form, and the client behind register_hex_tiles when asked', () => {
        expect(hasWorkerServer({ plugins: [{ options: { worker: 'w.js' } }] })).toBe(true);
        expect(hasWorkerServer({ plugins: ['x.js', { options: { url: 'https://m' } }] })).toBe(false);
        const tools = registry();
        const live = liveHexClient(tools);
        expect(live.client).toBeNull();
        tools.tools.set('register_hex_tiles', { mcpClient: { client: 'sdk' } });
        expect(live.client).toBe('sdk');
    });
});

describe('hex metadata a moment after registration', () => {
    it('retries a 404 until the tileset is readable, and gives up on the last', async () => {
        const { createHexTileTools } = await import('../app/hex-tools.js');
        const meta = { value_columns: ['n'], value_stats: { n: { by_res: { 6: { min: 1, max: 2 } } } }, bounds: [0, 0, 1, 1] };
        const responses = [{ ok: false, status: 404 }, { ok: false, status: 404 }, { ok: true, status: 200, json: async () => meta }];
        const fetchFn = vi.fn(async () => responses.shift());
        const mm = mapWith();
        const [add] = createHexTileTools(mm, { fetchFn, retryDelays: [0, 0, 0] });
        const out = JSON.parse(await add.execute({ tile_url: 'https://h/tiles/hex/x/{z}/{x}/{y}.pbf' }));
        expect(out.success).toBe(true);
        expect(fetchFn).toHaveBeenCalledTimes(3);

        const always404 = vi.fn(async () => ({ ok: false, status: 404 }));
        const [add2] = createHexTileTools(mapWith(), { fetchFn: always404, retryDelays: [0, 0] });
        expect(JSON.parse(await add2.execute({ tile_url: 'https://h/tiles/hex/y/{z}/{x}/{y}.pbf' })).success).toBe(false);
        expect(always404).toHaveBeenCalledTimes(3);

        // A 403 is not a race: no retry.
        const forbidden = vi.fn(async () => ({ ok: false, status: 403 }));
        const [add3] = createHexTileTools(mapWith(), { fetchFn: forbidden, retryDelays: [0, 0] });
        await add3.execute({ tile_url: 'https://h/tiles/hex/z/{z}/{x}/{y}.pbf' });
        expect(forbidden).toHaveBeenCalledTimes(1);
    });
});

describe('waiting for a hex build that is still running', () => {
    const meta = { value_columns: ['n'], value_stats: { n: { by_res: { 6: { min: 1, max: 2 } } } }, bounds: [0, 0, 1, 1] };
    const URL_ = 'https://h/tiles/hex/abc123/{z}/{x}/{y}.pbf';

    it('long-polls get_hex_tile_status while it is running, then reads the metadata', async () => {
        const { createHexTileTools, hexBuildWaiter, tilesetHash } = await import('../app/hex-tools.js');
        expect(tilesetHash(URL_)).toBe('abc123');
        const statuses = ['{"status":"running"}', '{"status":"running"}', '{"hash":"abc123","status":"done"}'];
        const callStatus = vi.fn(async () => statuses.shift());
        let built = false;
        const fetchFn = vi.fn(async () => (built ? { ok: true, status: 200, json: async () => meta } : { ok: false, status: 404 }));
        const waitForBuild = hexBuildWaiter(async (args) => { const r = await callStatus(args); if (r.includes('done')) built = true; return r; });
        const [add] = createHexTileTools(mapWith(), { fetchFn, waitForBuild, retryDelays: [0, 0] });
        expect(JSON.parse(await add.execute({ tile_url: URL_ })).success).toBe(true);
        expect(callStatus).toHaveBeenCalledTimes(3);
        expect(callStatus).toHaveBeenCalledWith({ hash: 'abc123', wait_seconds: 30 });
    });

    it('treats a 202 like a build in progress, and reports a failed or endless build', async () => {
        const { createHexTileTools, hexBuildWaiter } = await import('../app/hex-tools.js');
        const fetch202 = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({ status: 'running' }) }));
        const failed = hexBuildWaiter(async () => '{"status":"failed","error":"SQL error"}');
        const [add] = createHexTileTools(mapWith(), { fetchFn: fetch202, waitForBuild: failed, retryDelays: [0] });
        expect(JSON.parse(await add.execute({ tile_url: URL_ })).error).toMatch(/failed: SQL error/);
        const endless = hexBuildWaiter(async () => '{"status":"running"}', { rounds: 2 });
        const [add2] = createHexTileTools(mapWith(), { fetchFn: fetch202, waitForBuild: endless, retryDelays: [0] });
        expect(JSON.parse(await add2.execute({ tile_url: URL_ })).error).toMatch(/still being built/);
    });
});
