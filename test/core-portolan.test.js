import { describe, it, expect } from 'vitest';
import {
    resolveHref, findVectorSources, findStyleAssets, findRasterAssets, rasterBand,
    defaultRescale, styleToLayer, stripGeometryTypeFilter, describeColor,
    pmtilesLayerInfo, normalizeGeometryType, guardMissingValues, styleName,
    portolanVersion, providerSummary, agentsLink, FAINT_OUTLINE, collectionColumns,
} from '../core/portolan.js';
import { PortolanCatalog, titilerTileUrl, defaultTooltip } from '../core/portolan-catalog.js';

const BASE = 'https://example.org/cat/roads/collection.json';

// The shape CARTO's Portolan publisher writes: one fill, line and circle
// layer, each gated on geometry type.
const generatedStyle = (colour) => ({
    version: 8,
    sources: { data: { type: 'vector', url: '../data.pmtiles' } },
    layers: [
        { id: 'f', type: 'fill', source: 'data', 'source-layer': 'data', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': colour, 'fill-opacity': 0.4 } },
        { id: 'l', type: 'line', source: 'data', 'source-layer': 'data', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': colour, 'line-width': 1 } },
        { id: 'c', type: 'circle', source: 'data', 'source-layer': 'data', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': colour, 'circle-radius': 3 } },
        { id: 's', type: 'symbol', source: 'data', 'source-layer': 'data', layout: { 'text-field': ['get', 'name'] } },
    ],
});

const collection = {
    type: 'Collection',
    id: 'roads',
    title: 'Road damage',
    description: 'Points where roads were damaged.',
    license: 'CC-BY-4.0',
    stac_extensions: ['https://schemas.portolan-sdi.org/portolan/v0.2.0/schema.json'],
    extent: { spatial: { bbox: [[-78, 17, -76, 19]] } },
    providers: [
        { name: 'Response Network', roles: ['producer'] },
        { name: 'CARTO', roles: ['host'], url: 'https://carto.com' },
    ],
    'table:columns': [{ name: 'Damage', type: 'string', description: 'Damage class' }],
    links: [
        { rel: 'pmtiles', href: './data.pmtiles', type: 'application/vnd.pmtiles', 'pmtiles:layers': ['data'] },
        { rel: 'agents', href: './AGENTS.md', type: 'text/markdown' },
    ],
    assets: {
        data: { href: './data.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] },
        visual: { href: './data.pmtiles', type: 'application/vnd.pmtiles', roles: ['visual'] },
        style: { href: './styles/default.json', type: 'application/vnd.mapbox.style+json', roles: ['style', 'default'] },
        'style-categorical': { href: './styles/categorical.json', type: 'application/vnd.mapbox.style+json', roles: ['style'] },
        source_style: { href: 'https://upstream.example/style.json', type: 'application/vnd.mapbox.style+json', roles: ['style', 'source'] },
        source_pm: { href: 'https://upstream.example/x.pmtiles', type: 'application/vnd.pmtiles', roles: ['source'] },
    },
};

describe('findVectorSources', () => {
    it('merges the pmtiles link and the visual asset that point at one file', () => {
        const v = findVectorSources(collection, BASE);
        expect(v).toEqual([{ key: 'data', url: 'https://example.org/cat/roads/data.pmtiles', layers: ['data'], title: null, columns: [] }]);
    });

    it('ignores source-role archives and keeps several distinct archives', () => {
        const c = {
            links: [
                { rel: 'pmtiles', href: 'https://h/a/2025.pmtiles', 'pmtiles:layers': ['fields'] },
                { rel: 'pmtiles', href: 'https://h/b/2024.pmtiles', 'pmtiles:layers': ['2024'] },
            ],
            assets: { up: { href: 'https://h/up.pmtiles', type: 'application/vnd.pmtiles', roles: ['source'] } },
        };
        expect(findVectorSources(c, BASE).map(s => [s.key, s.layers[0]])).toEqual([['2025', 'fields'], ['2024', '2024']]);
    });
});

describe('findStyleAssets', () => {
    it('puts the default first, skips source styles and resolves hrefs', () => {
        const s = findStyleAssets(collection, BASE);
        expect(s.map(x => [x.name, x.isDefault, x.url])).toEqual([
            ['default', true, 'https://example.org/cat/roads/styles/default.json'],
            ['categorical', false, 'https://example.org/cat/roads/styles/categorical.json'],
        ]);
    });

    it('treats the asset keyed style as default when no asset has the default role (v0.1 catalogs)', () => {
        const c = { assets: {
            'style-outline': { href: 'o.json', roles: ['style'] },
            style: { href: 's.json', roles: ['style'] },
        } };
        expect(findStyleAssets(c, BASE)[0].key).toBe('style');
    });

    it('names styles for the agent', () => {
        expect(styleName('style-by-direction')).toBe('by-direction');
        expect(styleName('styles/2025')).toBe('2025');
        expect(styleName('style')).toBe('default');
    });
});

describe('rasters', () => {
    const cog = {
        assets: {
            data: {
                href: './children.tif',
                type: 'image/tiff; application=geotiff; profile=cloud-optimized',
                roles: ['data'],
                bands: [{ nodata: -99999, statistics: { minimum: 2.7, maximum: 29, mean: 8, stddev: 3.25 } }],
            },
            source: { href: 'https://up/x.tif', type: 'image/tiff; application=geotiff', roles: ['source'] },
        },
    };

    it('finds data COGs and reads band statistics', () => {
        const r = findRasterAssets(cog, BASE);
        expect(r).toHaveLength(1);
        expect(r[0].url).toBe('https://example.org/cat/roads/children.tif');
        expect(r[0].band).toMatchObject({ nodata: -99999, min: 2.7, max: 29, mean: 8, stddev: 3.25 });
    });

    it('reads raster:bands when bands is absent', () => {
        expect(rasterBand({ 'raster:bands': [{ nodata: 0, statistics: { minimum: 1, maximum: 5 } }] })).toMatchObject({ nodata: 0, min: 1, max: 5 });
    });

    it('caps a skewed range at mean + 2 sd, and keeps the full range otherwise', () => {
        expect(defaultRescale({ min: 2.7, max: 29, mean: 8, stddev: 3.25 })).toBe('2.7,14.5');
        expect(defaultRescale({ min: 0, max: 10, mean: 5, stddev: 4 })).toBe('0,10');
        expect(defaultRescale({ min: null, max: null })).toBeNull();
    });

    it('builds TiTiler URLs with the colormap, range and nodata', () => {
        const u = titilerTileUrl('https://t', 'https://h/x.tif', { colormap: 'magma', rescale: '0,4', nodata: -99999 });
        expect(u).toBe('https://t/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=https%3A%2F%2Fh%2Fx.tif&colormap_name=magma&rescale=0,4&nodata=-99999');
    });

    it('unscales a scaled band, as the full app does (#441)', () => {
        const crw = { type: 'image/tiff; application=geotiff', roles: ['data'], href: 'dhw.tif',
            'raster:bands': [{ data_type: 'int16', nodata: -32768, scale: 0.01, offset: 0, unit: 'Celsius-weeks' }] };
        const band = rasterBand(crw);
        expect(band.unscale).toBe(true);
        expect(rasterBand({ 'raster:bands': [{ scale: 1, offset: 0 }] }).unscale).toBe(false);
        expect(titilerTileUrl('https://t', 'https://h/x.tif', { colormap: 'ylorrd', rescale: '0,30', unscale: band.unscale })).toContain('&unscale=true');
    });

    it('drops a class whose value is the nodata value', () => {
        const band = rasterBand({ 'raster:bands': [{ nodata: 0, 'classification:classes': [
            { value: 0, description: 'No data', color_hint: '000000' }, { value: 1, description: 'Forest', color_hint: '00FF00' },
        ] }] });
        expect(band.classes.map(c => c.value)).toEqual([1]);
    });

    it('builds an inline colormap for classified rasters', () => {
        const u = titilerTileUrl('https://t', 'https://h/x.tif', { classes: [{ value: 1, color_hint: '00FF00' }] });
        expect(decodeURIComponent(u)).toContain('colormap={"1":[0,255,0,255]}');
    });
});

describe('styleToLayer', () => {
    it('picks the layer for the geometry and drops the geometry gate', () => {
        const pts = styleToLayer(generatedStyle('#f00'), 'Point');
        expect(pts).toMatchObject({ renderType: 'circle', filter: null, sourceLayer: 'data', outlinePaint: null });
        expect(pts.paint['circle-color']).toBe('#f00');
    });

    it('gives a polygon a faint outline when the style has none', () => {
        const poly = styleToLayer(generatedStyle('#0f0'), 'Polygon');
        expect(poly.renderType).toBe('fill');
        expect(poly.outlinePaint).toEqual({ ...FAINT_OUTLINE });
    });

    it('uses an ungated line layer as the outline of a fill', () => {
        const s = { layers: [
            { type: 'fill', 'source-layer': 'p', paint: { 'fill-color': '#abc' } },
            { type: 'line', 'source-layer': 'p', paint: { 'line-color': '#123' } },
        ] };
        expect(styleToLayer(s, 'Polygon').outlinePaint).toEqual({ 'line-color': '#123' });
    });

    it('keeps the non-geometry part of a combined filter', () => {
        const f = ['all', ['==', ['geometry-type'], 'Polygon'], ['>', ['get', 'n'], 3]];
        expect(stripGeometryTypeFilter(f)).toEqual(['>', ['get', 'n'], 3]);
        expect(stripGeometryTypeFilter(['==', '$type', 'Point'])).toBeNull();
    });

    it('hides features missing the property a ramp reads, instead of painting them black', () => {
        const ramp = ['interpolate', ['linear'], ['get', 'share'], 0, '#fee', 1, '#e55'];
        const s = { layers: [{ type: 'fill', paint: { 'fill-color': ramp, 'fill-opacity': 0.4 } }] };
        const out = styleToLayer(s, 'Polygon');
        expect(out.paint['fill-color']).toEqual(ramp);   // the legend still reads it
        expect(out.paint['fill-opacity']).toEqual(['case', ['==', ['typeof', ['get', 'share']], 'number'], 0.4, 0]);
        // Categorical colours are left alone: match has a fallback colour.
        const cat = { 'circle-color': ['match', ['get', 'k'], 'a', '#111', '#ccc'] };
        expect(guardMissingValues('circle', cat)).toBe(cat);
    });

    it('returns null for a style with nothing it can draw', () => {
        expect(styleToLayer({ layers: [{ type: 'symbol' }] }, 'Point')).toBeNull();
    });
});

describe('describeColor', () => {
    it('reads categories from match and ranges from interpolate and step', () => {
        expect(describeColor({ 'fill-color': ['match', ['get', 'k'], 'a', '#1', ['b', 'c'], '#2', '#9'] }))
            .toEqual({ property: 'k', kind: 'categorical', values: ['a', 'b', 'c'] });
        expect(describeColor({ 'line-color': ['interpolate', ['linear'], ['get', 'v'], 0, '#a', 10, '#b'] }))
            .toEqual({ property: 'v', kind: 'continuous', range: [0, 10] });
        expect(describeColor({ 'circle-color': ['step', ['get', 'v'], '#a', 5, '#b', 50, '#c'] }))
            .toEqual({ property: 'v', kind: 'continuous', range: [5, 50] });
        expect(describeColor({ 'fill-color': '#abc' })).toBeNull();
    });
});

describe('metadata helpers', () => {
    it('reads geometry and fields from PMTiles metadata', () => {
        const meta = {
            vector_layers: [{ id: 'data', fields: { Damage: 'String', n: 'Number' } }],
            tilestats: { layers: [{ layer: 'data', geometry: 'MultiPolygon' }] },
        };
        expect(pmtilesLayerInfo(meta)).toEqual({ layerName: 'data', geometryType: 'Polygon', fields: { Damage: 'String', n: 'Number' } });
        expect(pmtilesLayerInfo(null, 'x')).toEqual({ layerName: 'x', geometryType: null, fields: {} });
    });

    it('normalises geometry names', () => {
        expect(normalizeGeometryType('MultiLineString')).toBe('LineString');
        expect(normalizeGeometryType('point')).toBe('Point');
        expect(normalizeGeometryType('')).toBeNull();
    });

    it('reads the spec version, providers and agent guide', () => {
        expect(portolanVersion(collection)).toBe('0.2.0');
        expect(providerSummary(collection)).toEqual({ producers: ['Response Network'], host: 'CARTO' });
        expect(agentsLink(collection, BASE)).toBe('https://example.org/cat/roads/AGENTS.md');
        expect(resolveHref('../x.json', BASE)).toBe('https://example.org/cat/x.json');
    });

    it('picks tooltip fields: a name, then the styled property', () => {
        const fields = { adm0_name: 'String', adm1_name: 'String', code: 'String', T_TL: 'Number' };
        const paint = { 'fill-color': ['interpolate', ['linear'], ['get', 'T_TL'], 0, '#a', 1, '#b'] };
        expect(defaultTooltip(fields, paint)).toEqual(['adm1_name', 'T_TL', 'adm0_name', 'code']);
    });
});

describe('PortolanCatalog', () => {
    const categorical = generatedStyle(['match', ['get', 'Damage'], 'road_damage', '#f28e2b', 'road_blockage', '#76b7b2', '#ccc']);
    const docs = {
        [BASE]: collection,
        'https://example.org/cat/roads/styles/default.json': generatedStyle('#00838f'),
        'https://example.org/cat/roads/styles/categorical.json': categorical,
        'https://example.org/cat/catalog.json': { type: 'Catalog', links: [{ rel: 'child', href: './sub/catalog.json' }] },
        'https://example.org/cat/sub/catalog.json': { type: 'Catalog', links: [{ rel: 'child', href: '../roads/collection.json' }] },
    };
    const deps = {
        fetchJson: async (url) => {
            if (!docs[url]) throw new Error(`404 ${url}`);
            return structuredClone(docs[url]);
        },
        pmtilesMetadata: async () => ({
            vector_layers: [{ id: 'data', fields: { Damage: 'String', country: 'String' } }],
            tilestats: { layers: [{ layer: 'data', geometry: 'Point' }] },
        }),
    };

    it('turns a collection into one vector layer with its published styles', async () => {
        const c = new PortolanCatalog(deps);
        await c.load({ collections: [{ url: BASE, style: 'categorical', visible: true }] });
        const [cfg] = c.getMapLayerConfigs();
        expect(cfg).toMatchObject({
            layerId: 'roads', type: 'vector', renderType: 'circle', sourceLayer: 'data', defaultVisible: true,
            source: { type: 'vector', url: 'pmtiles://https://example.org/cat/roads/data.pmtiles' },
            tooltipFields: ['Damage', 'country'],
        });
        expect(cfg.paint['circle-color'][0]).toBe('match');
        expect([...c.layers.get('roads').styles.keys()]).toEqual(['default', 'categorical']);
        expect(c.getAll()[0]._rawStac.id).toBe('roads');
    });

    it('resolves collection ids by walking sub-catalogs', async () => {
        const c = new PortolanCatalog(deps);
        await c.load({ catalog: 'https://example.org/cat/catalog.json', collections: ['roads'] });
        expect([...c.layers.keys()]).toEqual(['roads']);
    });

    it('writes the layers, properties and style values into the prompt', async () => {
        const c = new PortolanCatalog(deps);
        await c.load({ collections: [BASE] });
        const p = c.generatePrompt();
        expect(p).toContain('layer_id `roads` — vector, point, drawn as circle');
        expect(p).toContain('`Damage` (string): Damage class');
        expect(p).toContain('`categorical`: colours by `Damage`, values: "road_damage", "road_blockage"');
        expect(p).toContain('License: CC-BY-4.0. Source: Response Network; mirrored by CARTO.');
    });

    it('skips a collection it cannot fetch and loads the rest', async () => {
        const c = new PortolanCatalog(deps);
        await c.load({ collections: ['https://example.org/missing/collection.json', BASE] });
        expect([...c.datasets.keys()]).toEqual(['roads']);
    });
});

describe('our current STAC (#441)', () => {
    const URL_ = 'https://s3.example.org/public-cpad/stac-collection.json';
    const cpad = {
        type: 'Collection', id: 'cpad', title: 'CPAD', description: 'Protected areas.',
        assets: {
            'cpad-pmtiles': {
                href: 'https://s3.example.org/public-cpad/cpad.pmtiles', type: 'application/vnd.pmtiles', 'vector:layers': ['cpad'],
                'table:columns': [{ name: 'ACCESS_TYP', type: 'string' }, { name: 'geometry', type: 'binary' }],
            },
            parquet: {
                href: 'https://s3.example.org/public-cpad/cpad.parquet', type: 'application/vnd.apache.parquet',
                'table:columns': [{ name: 'ACCESS_TYP', type: 'string', description: 'Public access' }, { name: 'h8', type: 'string' }],
            },
        },
        links: [],
    };

    it('reads column descriptions from assets as well as the collection', () => {
        expect(collectionColumns(cpad)).toEqual([
            { name: 'ACCESS_TYP', type: 'string', description: 'Public access' },
            { name: 'geometry', type: 'binary' },
            { name: 'h8', type: 'string' },
        ]);
        expect(collectionColumns({ 'table:columns': [{ name: 'a', description: 'x' }], assets: { p: { 'table:columns': [{ name: 'a', description: 'y' }] } } })[0].description).toBe('x');
    });

    it('names feature properties from the asset when the archive gives none, and describes them in the prompt', async () => {
        const c = new PortolanCatalog({ fetchJson: async () => null, pmtilesMetadata: async () => null });
        await c.addCollection(cpad, URL_);
        const layer = c.layers.get('cpad');
        expect(layer.sourceLayer).toBe('cpad');
        expect(layer.fields).toEqual({ ACCESS_TYP: 'string' });
        expect(c.generatePrompt()).toContain('`ACCESS_TYP` (string): Public access');
    });
});

