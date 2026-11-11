import { describe, it, expect } from 'vitest';
import {
    resolveHref, findVectorSources, findStyleAssets, findRasterAssets, rasterBand,
    defaultRescale, styleToLayer, stripGeometryTypeFilter, describeColor,
    pmtilesLayerInfo, normalizeGeometryType, guardMissingValues, styleName,
    portolanVersion, providerSummary, agentsLink, FAINT_OUTLINE, collectionColumns,
    styleSourceFile, stylesForFile, selectAssets, itemHref, itemDate,
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
        expect(v).toEqual([{ key: 'data', aliases: ['visual'], url: 'https://example.org/cat/roads/data.pmtiles', layers: ['data'], title: null, columns: [] }]);
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

describe('styles per PMTiles file', () => {
    const style = (url) => ({ version: 8, sources: { data: { type: 'vector', url } }, layers: [] });
    const styles = [
        { name: 'county', isDefault: true, doc: style('pmtiles://../SVI2022_US_county.pmtiles') },
        { name: 'tract', isDefault: false, doc: style('pmtiles://../SVI2022_US_tract.pmtiles') },
        { name: 'tract-pct', isDefault: false, doc: style('pmtiles://../SVI2022_US_tract.pmtiles') },
        { name: 'any', isDefault: false, doc: { version: 8, sources: {}, layers: [] } },
    ];

    it('reads the archive a style draws from its source', () => {
        expect(styleSourceFile(style('pmtiles://../level_03/hydrobasins_level_03.pmtiles'))).toBe('hydrobasins_level_03.pmtiles');
        expect(styleSourceFile(style('../data.pmtiles'))).toBe('data.pmtiles');
        expect(styleSourceFile(style('https://tiles.example/{z}/{x}/{y}.mvt'))).toBe(null);
        expect(styleSourceFile({ sources: {} })).toBe(null);
    });

    it("gives a layer only its own file's styles, default first", () => {
        const county = stylesForFile(styles, 'https://s3.example/svi/SVI2022_US_county.pmtiles');
        expect(county.map(s => [s.name, s.isDefault])).toEqual([['county', true], ['any', false]]);
        const tract = stylesForFile(styles, 'https://s3.example/svi/SVI2022_US_tract.pmtiles');
        expect(tract.map(s => [s.name, s.isDefault])).toEqual([['tract', true], ['tract-pct', false], ['any', false]]);
        expect(stylesForFile(styles, 'https://s3.example/other.pmtiles').map(s => s.name)).toEqual(['any']);
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

    it("takes a COG's published render and its nodata (#440)", () => {
        const withRender = { ...cog, renders: { kids: { assets: ['data'], colormap_name: 'magma', rescale: [[0, 12]], nodata: 0 } } };
        const [r] = findRasterAssets(withRender, BASE);
        expect(r.render).toMatchObject({ name: 'kids', colormap: 'magma', rescale: '0,12' });
        expect(r.band.nodata).toBe(0);
        expect(findRasterAssets(cog, BASE)[0].render).toBeNull();
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

    it("draws a raster with its collection's published render (#440)", async () => {
        const url = 'https://example.org/cat/kids/collection.json';
        const kids = {
            type: 'Collection', id: 'kids', links: [],
            renders: { kids: { assets: ['data'], colormap_name: 'magma', rescale: [[0, 12]], nodata: 0 } },
            assets: { data: { href: './children.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'],
                bands: [{ nodata: -99999, statistics: { minimum: 0, maximum: 29 } }] } },
        };
        const c = new PortolanCatalog({ ...deps, fetchJson: async (u) => (u === url ? structuredClone(kids) : deps.fetchJson(u)) });
        await c.load({ collections: [url] });
        const tiles = decodeURIComponent(c.getMapLayerConfigs()[0].source.tiles[0]);
        expect(tiles).toContain('colormap_name=magma&rescale=0,12&nodata=0');
    });

        it("draws each archive of a collection with that archive's own styles", async () => {
        const two = {
            type: 'Collection', id: 'svi', links: [],
            assets: {
                county: { href: './county.pmtiles', type: 'application/vnd.pmtiles', roles: ['data'] },
                tract: { href: './tract.pmtiles', type: 'application/vnd.pmtiles', roles: ['data'] },
                'style-county': { href: './styles/county.json', type: 'application/vnd.mapbox.style+json', roles: ['style', 'default'] },
                'style-tract': { href: './styles/tract.json', type: 'application/vnd.mapbox.style+json', roles: ['style'] },
            },
        };
        const at = (colour, file) => ({ ...generatedStyle(colour), sources: { data: { type: 'vector', url: `pmtiles://../${file}` } } });
        const url = 'https://example.org/cat/svi/collection.json';
        const more = {
            [url]: two,
            'https://example.org/cat/svi/styles/county.json': at('#111111', 'county.pmtiles'),
            'https://example.org/cat/svi/styles/tract.json': at('#222222', 'tract.pmtiles'),
        };
        const c = new PortolanCatalog({ ...deps, fetchJson: async (u) => structuredClone(more[u]) });
        await c.load({ collections: [url] });
        expect(c.layers.get('svi/county').paint['circle-color']).toBe('#111111');
        expect(c.layers.get('svi/tract').paint['circle-color']).toBe('#222222');
        expect([...c.layers.get('svi/tract').styles.keys()]).toEqual(['tract']);
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


// #462: choosing a collection's assets, and drawing COGs that live in items.
describe('assets and items of a collection (#462)', () => {
    const CURL = 'https://example.org/cat/heat/collection.json';
    const cog = (href, bands) => ({ href, type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'], bands });
    const threeBands = [
        { name: 'tmax_c', nodata: -9999, unit: 'Cel', statistics: { minimum: 10, maximum: 40, mean: 26, stddev: 5 } },
        { name: 'tmin_c', nodata: -9999, unit: 'Cel', statistics: { minimum: 3, maximum: 25, mean: 15, stddev: 3 } },
        { name: 'tmax_anom_c', nodata: -9999, unit: 'Cel', statistics: { minimum: -8, maximum: 12, mean: 2, stddev: 3 } },
    ];
    const item = (id, date) => ({
        type: 'Feature', id, properties: { datetime: `${date}T12:00:00Z`, title: `Daily Tmax, ${date}` },
        assets: { data: cog(`./${id}.tif`, threeBands), thumbnail: { href: `./${id}.jpg`, type: 'image/jpeg', roles: ['thumbnail'] } },
        links: [],
    });
    const heat = {
        type: 'Collection', id: 'heat', title: 'Daily heat',
        links: [
            { rel: 'item', href: './heat-2025-06-15/heat-2025-06-15.json' },
            { rel: 'item', href: './other/heat-2025-06-16.json' },
        ],
        assets: { mirror: { href: './items.parquet', type: 'application/vnd.apache.parquet', roles: ['collection-mirror'] } },
    };
    const docs = {
        [CURL]: heat,
        'https://example.org/cat/heat/heat-2025-06-15/heat-2025-06-15.json': item('heat-2025-06-15', '2025-06-15'),
        'https://example.org/cat/heat/other/heat-2025-06-16.json': item('heat-2025-06-16', '2025-06-16'),
        'https://example.org/cat/heat/heat-2025-06-17/heat-2025-06-17.json': item('heat-2025-06-17', '2025-06-17'),
    };
    const deps = {
        fetchJson: async (u) => { if (!docs[u]) throw new Error(`404 ${u}`); return structuredClone(docs[u]); },
        pmtilesMetadata: async () => null,
    };

    it('finds an item by its link, by a folder named for it, or beside the collection', () => {
        expect(itemHref(heat, CURL, 'heat-2025-06-15')).toBe('https://example.org/cat/heat/heat-2025-06-15/heat-2025-06-15.json');
        expect(itemHref(heat, CURL, 'heat-2025-06-16')).toBe('https://example.org/cat/heat/other/heat-2025-06-16.json');
        expect(itemHref(heat, CURL, 'heat-2025-06-17')).toBe('https://example.org/cat/heat/heat-2025-06-17/heat-2025-06-17.json');
        expect(itemDate({ properties: { start_datetime: '2025-06-01T00:00:00Z', datetime: null } })).toBe('2025-06-01');
        expect(itemDate({})).toBeNull();
    });

    it('selects assets in config order, by key or by the second key of a merged archive', () => {
        const vectors = findVectorSources(collection, BASE);
        const rasters = [{ key: 'pop', url: 'x' }];
        const { picks, missing } = selectAssets(['pop', { id: 'visual', display_name: 'Roads' }, 'nope'], vectors, rasters);
        expect(picks.map(p => [p.kind, p.src.key, p.entry.display_name])).toEqual([['raster', 'pop', undefined], ['vector', 'data', 'Roads']]);
        expect(missing).toEqual(['nope']);
        expect(selectAssets(undefined, vectors, rasters).picks.map(p => p.kind)).toEqual(['vector', 'raster']);
    });

    it('draws the items a collection entry lists, each with its own settings', async () => {
        const c = new PortolanCatalog(deps);
        await c.load({ collections: [{ url: CURL, colormap: 'reds', items: [
            'heat-2025-06-15',
            { id: 'heat-2025-06-16', display_name: 'Heat on 16 June', visible: true, colormap: 'magma', rescale: '15,40' },
        ] }] });
        expect(c.datasets.get('heat').layerIds).toEqual(['heat/heat-2025-06-15', 'heat/heat-2025-06-16']);
        const [a, b] = c.getMapLayerConfigs();
        expect(a).toMatchObject({ displayName: 'Daily Tmax, 2025-06-15', defaultVisible: false, colormap: 'reds', rescale: '10,36' });
        expect(a.source.tiles[0]).toContain(encodeURIComponent('https://example.org/cat/heat/heat-2025-06-15/heat-2025-06-15.tif'));
        expect(b).toMatchObject({ displayName: 'Heat on 16 June', defaultVisible: true, colormap: 'magma', rescale: '15,40' });
        expect(c.generatePrompt()).toContain('`heat/heat-2025-06-16` — raster (COG), item `heat-2025-06-16` (2025-06-16)');
    });

    it('draws another band of an item COG when the entry names one', async () => {
        const c = new PortolanCatalog(deps);
        await c.load({ collections: [{ url: CURL, items: [
            'heat-2025-06-15',
            { id: 'heat-2025-06-15', bidx: 3, colormap: 'rdbu_r' },
            'heat-2025-06-15',
        ] }] });
        // One COG listed once per band; the repeated plain listing is skipped.
        expect(c.datasets.get('heat').layerIds).toEqual(['heat/heat-2025-06-15', 'heat/heat-2025-06-15/band-3']);
        const l = c.layers.get('heat/heat-2025-06-15/band-3');
        expect(l).toMatchObject({ itemId: 'heat-2025-06-15', date: '2025-06-15' });
        expect(l.band).toMatchObject({ bidx: 3, min: -8, max: 12 });
        expect(c.getMapLayerConfigs()[1].source.tiles[0]).toContain('bidx=3');
        // A three-band COG with no band named draws band 1: TiTiler colours one band.
        expect(c.getMapLayerConfigs()[0].source.tiles[0]).toContain('bidx=1');
        expect(c.generatePrompt()).toContain('band 3');
    });

    it('skips an item it cannot read and draws the rest', async () => {
        const c = new PortolanCatalog(deps);
        await c.load({ collections: [{ url: CURL, items: ['missing-day', 'heat-2025-06-17'] }] });
        expect(c.datasets.get('heat').layerIds).toEqual(['heat/heat-2025-06-17']);
    });

    it('draws no items unless config lists them', async () => {
        const c = new PortolanCatalog(deps);
        await c.load({ collections: [{ url: CURL }] });
        expect(c.layers.size).toBe(0);
    });

    it('keeps only the assets a collection entry lists, in its order, with their own settings', async () => {
        const two = {
            type: 'Collection', id: 'two', title: 'Two', links: [],
            assets: {
                pop: cog('./pop.tif', [threeBands[0]]),
                zones: { href: './zones.pmtiles', type: 'application/vnd.pmtiles', roles: ['visual'] },
                idx: cog('./idx.tif', [threeBands[1]]),
            },
        };
        const u = 'https://example.org/cat/two/collection.json';
        const c = new PortolanCatalog({ fetchJson: async () => structuredClone(two), pmtilesMetadata: async () => null });
        await c.load({ collections: [{ url: u, opacity: 0.5, assets: [
            { id: 'idx', display_name: 'Index', opacity: 0.9, visible: true },
            'zones',
        ] }] });
        // Ids keep the asset key, as when every asset is drawn.
        expect(c.datasets.get('two').layerIds).toEqual(['two/idx', 'two/zones']);
        const [idx, zones] = c.getMapLayerConfigs();
        expect(idx).toMatchObject({ displayName: 'Index', defaultVisible: true, paint: { 'raster-opacity': 0.9 } });
        expect(zones).toMatchObject({ type: 'vector', displayName: 'Two (zones)' });
        expect(c.layers.has('two/pop')).toBe(false);
    });
});
