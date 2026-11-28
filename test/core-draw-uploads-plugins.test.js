import { describe, it, expect, vi } from 'vitest';

vi.mock('../app/map-draw.js', () => ({
    MapDraw: class { constructor(map) { this.map = map; } async init() { this.ready = true; } getRegionWKT() { return null; } },
}));
vi.mock('../app/upload-manager.js', () => ({
    POINT_CELL_COLUMNS: ['h10'],
    UploadManager: class { constructor(mm, cfg, deps) { this.mm = mm; this.cfg = cfg; this.store = deps?.store; } init() { this.ready = true; } getUploads() { return []; } },
    s3UploadStore: (cfg) => ({ verb: 'Uploading', kind: 's3', cfg, put: async () => ({ url: 'https://s3/x' }) }),
    workerUploadStore: (w, loadFiles) => ({ verb: 'Adding', kind: 'browser', put: async () => { await loadFiles(); return { url: '/upload/x.geojson' }; } }),
}));

const { default: draw } = await import('../core/plugins/draw.js');
const { default: uploadsPlugin, chooseStore } = await import('../core/plugins/uploads.js');
const uploads = { ...uploadsPlugin, loadFiles: vi.fn(async () => ({})) };

function ctx() {
    const hooks = [];
    return {
        map: { map: { id: 'maplibre' } },
        tools: { registered: [], registerLocal(t) { this.registered.push(t.name); } },
        onReady: (fn) => hooks.push(fn),
        hooks,
    };
}

describe('glen core draw and uploads plugins (#441)', () => {
    it('draw adds the draw control on the MapLibre map, the tool, and the chat notices', async () => {
        const c = ctx();
        await draw.setup(c, {});
        expect(c.draw).toMatchObject({ ready: true, map: { id: 'maplibre' } });
        expect(c.tools.registered).toEqual(['get_drawn_region']);
        expect(c.hooks).toHaveLength(1);
    });

    it('uploads passes its options to the upload manager and adds the tool and notices', async () => {
        const c = ctx();
        await uploads.setup(c, { max_features: 200 });
        expect(c.uploads).toMatchObject({ ready: true, cfg: { max_features: 200 } });
        expect(c.uploads.mm).toBe(c.map);
        expect(c.tools.registered).toEqual(['get_uploaded_dataset']);
        expect(c.hooks).toHaveLength(1);
    });

    it('uploads go to the SQL worker when there is one, and to S3 otherwise (#463)', async () => {
        const browser = ctx();
        browser.sqlWorker = { get: () => ({}), onStart: () => {} };
        await uploads.setup(browser, { geo_query_wasm: 'v9' });
        expect(await browser.uploads.store.put({ text: '{}', hash: 'x' })).toEqual({ url: '/upload/x.geojson' });
        expect(browser.uploads.store.verb).toBe('Adding');
        expect(uploads.loadFiles).toHaveBeenCalledWith('v9');

        const server = ctx();
        await uploads.setup(server, {});
        expect(server.uploads.store.verb).toBe('Uploading');
        expect(await server.uploads.store.put({ text: '{}', hash: 'x' })).toEqual({ url: 'https://s3/x' });
    });

    it('takes storage from the options, and refuses "browser" with no SQL worker', () => {
        const stores = { s3UploadStore: () => 's3', workerUploadStore: () => 'browser', cfg: {}, loadFiles: () => {} };
        expect(chooseStore({ sqlWorker: {} }, { storage: 's3' }, stores)).toBe('s3');
        expect(() => chooseStore({}, { storage: 'browser' }, stores)).toThrow(/no SQL in the browser/);
        expect(() => chooseStore({}, { storage: 'ftp' }, stores)).toThrow(/"browser" or "s3"/);
    });

    it('fails an upload it cannot place, with the reason', async () => {
        const c = ctx();
        await uploads.setup(c, { storage: 'browser' });
        expect(c.uploads.store.verb).toBe('Adding');
        await expect(c.uploads.store.put({ text: '{}', hash: 'x' })).rejects.toThrow(/no SQL in the browser/);
    });
});
