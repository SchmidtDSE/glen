import { describe, it, expect, vi } from 'vitest';
import { createMapControlTools, createProjectionTool, SQL_HINTS, DEFAULT_HINTS } from '../app/map-control-tools.js';
import { createMapTools } from '../app/map-tools.js';

const SQL_WORDS = /get_stac_details|get_schema|SELECT DISTINCT|read_parquet|\bSQL\b/;

function stubMap() {
    return {
        flyTo: vi.fn(() => ({ success: true })),
        resetStyle: vi.fn(() => ({ success: true, reset: 'map' })),
        getMapState: vi.fn(() => ({ layers: {} })),
        map: { fitBounds: vi.fn(), getCenter: () => ({ lng: -77.123456, lat: 18.5 }), getZoom: () => 8.123 },
    };
}

describe('createMapControlTools', () => {
    it('describes values without SQL or STAC tools by default', () => {
        const text = createMapControlTools(stubMap(), { geocoder: { forwardGeocode: async () => [] } })
            .map(t => t.description).join('\n');
        expect(text).not.toMatch(SQL_WORDS);
    });

    it('gives the full app its SQL wording through SQL_HINTS', () => {
        const full = createMapTools(stubMap(), { get: () => null, getIds: () => [], getAll: () => [] }, null, { forwardGeocode: async () => [] });
        const byName = Object.fromEntries(full.map(t => [t.name, t.description]));
        expect(byName.set_filter).toContain(SQL_HINTS.filterValues);
        expect(byName.set_style).toContain(SQL_HINTS.styleValues);
        expect(byName.fly_to).toBe(SQL_HINTS.flyTo);
        expect(byName.geocode).toBe(SQL_HINTS.geocode);
        expect(byName.set_filter).not.toContain(DEFAULT_HINTS.filterValues);
    });

    it('passes fly_to through unchanged without a layer extent', () => {
        const mm = stubMap();
        const fly = createMapControlTools(mm).find(t => t.name === 'fly_to');
        expect(fly.inputSchema.required).toEqual(['center']);
        fly.execute({ center: [1, 2], zoom: 5 });
        expect(mm.flyTo).toHaveBeenCalledWith({ center: [1, 2], zoom: 5 });
    });

    it('frames a layer or bbox when given a layer extent', () => {
        const mm = stubMap();
        const fly = createMapControlTools(mm, { layerExtent: (id) => (id === 'a' ? [0, 1, 2, 3] : null) })
            .find(t => t.name === 'fly_to');
        expect(JSON.parse(fly.execute({ layer_id: 'a' }))).toEqual({ success: true, bbox: [0, 1, 2, 3] });
        expect(mm.map.fitBounds).toHaveBeenCalledWith([[0, 1], [2, 3]], expect.any(Object));
        expect(JSON.parse(fly.execute({ layer_id: 'b' })).success).toBe(false);
    });

    it('lets the host reset layers MapManager cannot', () => {
        const mm = stubMap();
        const reset = createMapControlTools(mm, { resetStyle: (id) => (id === 'r' ? { success: true, reset: 'host' } : undefined) })
            .find(t => t.name === 'reset_style');
        expect(JSON.parse(reset.execute({ layer_id: 'r' })).reset).toBe('host');
        expect(JSON.parse(reset.execute({ layer_id: 'v' })).reset).toBe('map');
    });

    it('adds the view to get_map_state on request', () => {
        const state = createMapControlTools(stubMap(), { reportView: true }).find(t => t.name === 'get_map_state');
        expect(JSON.parse(state.execute({})).view).toEqual({ center: [-77.1235, 18.5], zoom: 8.12 });
    });

    it('offers geolocation only on opt-in, and the projection tool alone', () => {
        expect(createMapControlTools(stubMap()).map(t => t.name)).not.toContain('get_user_location');
        expect(createMapControlTools(stubMap(), { geolocateTool: true }).map(t => t.name)).toContain('get_user_location');
        expect(createProjectionTool(stubMap()).name).toBe('set_projection');
    });
});
