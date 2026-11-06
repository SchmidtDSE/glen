import { describe, it, expect, vi } from 'vitest';
import { applyPublishedStyle, setRasterColormap, flyTo, createCoreMapTools } from '../core/map-tools.js';

function fakeMap() {
    const style = { layers: [{ id: 'bg' }, { id: 'layer-pop', type: 'raster', source: 'src-pop' }, { id: 'top' }], sources: { 'src-pop': { type: 'raster', tiles: ['old'], tileSize: 256 } } };
    return {
        style,
        getStyle: () => structuredClone(style),
        getSource: (id) => style.sources[id],
        removeLayer: vi.fn((id) => { style.layers = style.layers.filter(l => l.id !== id); }),
        removeSource: vi.fn((id) => { delete style.sources[id]; }),
        addSource: vi.fn((id, s) => { style.sources[id] = s; }),
        addLayer: vi.fn((def, before) => {
            const i = style.layers.findIndex(l => l.id === before);
            style.layers.splice(i < 0 ? style.layers.length : i, 0, def);
        }),
        fitBounds: vi.fn(),
    };
}

function setup() {
    const map = fakeMap();
    const states = new Map([
        ['roads', { filter: null }],
        ['pop', { sourceId: 'src-pop', mapLayerId: 'layer-pop' }],
    ]);
    const mapManager = {
        map,
        layers: states,
        setStyle: vi.fn(() => ({ success: true })),
        setFilter: vi.fn((id, f) => { states.get(id).filter = f; return { success: true }; }),
        clearFilter: vi.fn((id) => { states.get(id).filter = null; return { success: true }; }),
        flyTo: vi.fn(() => ({ success: true })),
        _refreshLegend: vi.fn(),
    };
    const catalog = {
        layers: new Map([
            ['roads', {
                layerId: 'roads', datasetId: 'roads', kind: 'vector', renderType: 'circle', filter: null,
                styles: new Map([
                    ['default', { renderType: 'circle', paint: { 'circle-color': '#0aa' }, filter: null }],
                    ['jamaica', { renderType: 'circle', paint: { 'circle-color': '#f00' }, filter: ['==', ['get', 'country'], 'Jamaica'] }],
                    ['fills', { renderType: 'fill', paint: { 'fill-color': '#f00' }, filter: null }],
                ]),
            }],
            ['pop', { layerId: 'pop', datasetId: 'pop', kind: 'raster', url: 'https://h/pop.tif', band: {}, colormap: 'viridis', rescale: '0,10' }],
        ]),
        datasets: new Map([['roads', { bbox: [-78, 17, -76, 19] }], ['pop', { bbox: null }]]),
        rasterTileUrl: (l) => `tiles?cm=${l.colormap}&r=${l.rescale}`,
    };
    return { mapManager, catalog, map, states };
}

describe('apply_style', () => {
    it('applies a published style and swaps its filter in and out', () => {
        const { mapManager, catalog, states } = setup();
        expect(applyPublishedStyle(mapManager, catalog, 'roads', 'jamaica')).toMatchObject({ success: true, style: 'jamaica' });
        expect(states.get('roads').filter).toEqual(['==', ['get', 'country'], 'Jamaica']);
        applyPublishedStyle(mapManager, catalog, 'roads', 'default');
        expect(states.get('roads').filter).toBeNull();
        expect(mapManager.setStyle).toHaveBeenLastCalledWith('roads', { 'circle-color': '#0aa' });
    });

    it('leaves a filter the user set when the style has none', () => {
        const { mapManager, catalog, states } = setup();
        states.get('roads').filter = ['==', ['get', 'Damage'], 'road_damage'];
        applyPublishedStyle(mapManager, catalog, 'roads', 'default');
        expect(states.get('roads').filter).toEqual(['==', ['get', 'Damage'], 'road_damage']);
    });

    it('names the styles that exist when asked for one that does not', () => {
        const { mapManager, catalog } = setup();
        expect(applyPublishedStyle(mapManager, catalog, 'roads', 'nope').error).toContain('default, jamaica, fills');
        expect(applyPublishedStyle(mapManager, catalog, 'roads', 'fills').success).toBe(false);
        expect(applyPublishedStyle(mapManager, catalog, 'pop', 'default').error).toContain('raster');
    });
});

describe('set_raster_colormap', () => {
    it('rebuilds the raster source in place with the new tiles', () => {
        const { mapManager, catalog, map, states } = setup();
        const r = setRasterColormap(mapManager, catalog, 'pop', { colormap: 'Magma', rescale: '0,4' });
        expect(r).toEqual({ success: true, layer: 'pop', colormap: 'magma', range: '0,4' });
        expect(map.style.sources['src-pop'].tiles).toEqual(['tiles?cm=magma&r=0,4']);
        expect(map.style.layers.map(l => l.id)).toEqual(['bg', 'layer-pop', 'top']);
        expect(states.get('pop')).toMatchObject({ colormap: 'magma', rescale: '0,4' });
        expect(mapManager._refreshLegend).toHaveBeenCalledWith('pop');
    });

    it('refuses vector layers', () => {
        const { mapManager, catalog } = setup();
        expect(setRasterColormap(mapManager, catalog, 'roads', { colormap: 'magma' }).success).toBe(false);
    });
});

describe('fly_to', () => {
    it('frames a layer extent, a bbox, or a centre', () => {
        const { mapManager, catalog, map } = setup();
        expect(flyTo(mapManager, catalog, { layer_id: 'roads' }).success).toBe(true);
        expect(map.fitBounds).toHaveBeenCalledWith([[-78, 17], [-76, 19]], expect.any(Object));
        expect(flyTo(mapManager, catalog, { layer_id: 'pop' }).success).toBe(false);
        expect(flyTo(mapManager, catalog, { bbox: [0, 10, 1, 5] }).success).toBe(false);
        flyTo(mapManager, catalog, { center: [-77, 18], zoom: 8 });
        expect(mapManager.flyTo).toHaveBeenCalledWith({ center: [-77, 18], zoom: 8 });
        expect(flyTo(mapManager, catalog, { center: [18, -177] }).success).toBe(false);
        expect(flyTo(mapManager, catalog, {}).success).toBe(false);
    });
});

describe('createCoreMapTools', () => {
    it('offers map tools only, and geocode only with a geocoder', () => {
        const { mapManager, catalog } = setup();
        const names = createCoreMapTools(mapManager, catalog).map(t => t.name);
        expect(names).not.toContain('geocode');
        expect(names.some(n => /sql|query|hex|stac/.test(n))).toBe(false);
        expect(createCoreMapTools(mapManager, catalog, { geocoder: { forwardGeocode: async () => [] } }).map(t => t.name)).toContain('geocode');
    });

    it('keeps array parameters decodable under constrained decoding', () => {
        const { mapManager, catalog } = setup();
        const filter = createCoreMapTools(mapManager, catalog).find(t => t.name === 'set_filter');
        expect(filter.inputSchema.properties.filter.items).toEqual({});
    });
});
