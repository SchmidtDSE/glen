import { describe, it, expect, vi } from 'vitest';
import { createDrawnRegionTool, wireDrawNotices } from '../app/draw-tools.js';
import { createUploadedDatasetTool, wireUploadNotices } from '../app/upload-tools.js';

const chat = () => ({ agent: { messages: [] }, ui: { addMessage: vi.fn() }, target: new EventTarget() });

describe('draw tools (shared by the full app and glen core)', () => {
    it('returns the region as WKT, or says none is drawn', () => {
        const drawn = createDrawnRegionTool({ getRegionWKT: () => 'POLYGON((0 0,1 0,1 1,0 0))', getSuggestedH3Resolution: () => 7 });
        expect(JSON.parse(drawn.execute())).toMatchObject({ success: true, wkt: 'POLYGON((0 0,1 0,1 1,0 0))', suggested_h3_resolution: 7 });
        expect(JSON.parse(createDrawnRegionTool({ getRegionWKT: () => null }).execute()).success).toBe(false);
    });

    it('tells the chat, and keeps one draw note in the agent history', () => {
        const c = chat();
        wireDrawNotices(c);
        c.target.dispatchEvent(new Event('region-drawn'));
        c.target.dispatchEvent(new Event('region-cleared'));
        c.target.dispatchEvent(new Event('region-drawn'));
        expect(c.ui.addMessage).toHaveBeenCalledTimes(3);
        expect(c.agent.messages).toHaveLength(1);
        expect(c.agent.messages[0].content).toMatch(/^\[The user has drawn a region/);
    });
});

describe('upload tools (shared by the full app and glen core)', () => {
    it('returns the uploads\' URLs and a point upload\'s SQL source, never the geometry', () => {
        const tool = createUploadedDatasetTool({ getUploads: () => [
            { url: 'https://s3/u/a.geojson', displayName: 'Park', kind: 'polygon', geometryType: 'Polygon', featureCount: 1, propertyKeys: ['name'] },
            { url: 'https://s3/u/b.geojson', displayName: 'Sightings', kind: 'point', featureCount: 40, sqlSource: '(SELECT 1)' },
        ] }, ['h10', 'h0']);
        const out = JSON.parse(tool.execute());
        expect(out.datasets.map(d => d.url)).toEqual(['https://s3/u/a.geojson', 'https://s3/u/b.geojson']);
        expect(out.datasets[1]).toMatchObject({ sql_source: '(SELECT 1)', cell_columns: ['h10', 'h0'] });
        expect(out.hint).toMatch(/Boundaries:.*Points:/);
        expect(JSON.parse(createUploadedDatasetTool({ getUploads: () => [] }, []).execute()).success).toBe(false);
    });

    it('tells the chat about an upload or a failure, and nudges the agent', () => {
        const c = chat();
        wireUploadNotices(c);
        c.target.dispatchEvent(new CustomEvent('geojson-uploaded', { detail: { displayName: 'Sightings', kind: 'point', featureCount: 40 } }));
        c.target.dispatchEvent(new CustomEvent('geojson-upload-error', { detail: { message: 'too big' } }));
        expect(c.ui.addMessage.mock.calls.map(x => x[1])).toEqual([
            'Uploaded "Sightings" (40 points) to the map. Ask me anything about these points.',
            'Upload failed: too big',
        ]);
        expect(c.agent.messages[0].content).toMatch(/uploaded a set of points/);
    });
});
