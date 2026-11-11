import { describe, it, expect, vi } from 'vitest';

vi.mock('../app/map-draw.js', () => ({
    MapDraw: class { constructor(map) { this.map = map; } async init() { this.ready = true; } getRegionWKT() { return null; } },
}));
vi.mock('../app/upload-manager.js', () => ({
    POINT_CELL_COLUMNS: ['h10'],
    UploadManager: class { constructor(mm, cfg) { this.mm = mm; this.cfg = cfg; } init() { this.ready = true; } getUploads() { return []; } },
}));

const { default: draw } = await import('../core/plugins/draw.js');
const { default: uploads } = await import('../core/plugins/uploads.js');

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
});
