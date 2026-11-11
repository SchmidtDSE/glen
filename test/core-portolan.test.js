import { describe, it, expect, vi } from 'vitest';
import {
    resolveHref, findVectorSources, findStyleAssets, findRasterAssets, rasterBand,
    defaultRescale, styleToLayer, stripGeometryTypeFilter, describeColor,
    pmtilesLayerInfo, normalizeGeometryType, guardMissingValues, styleName,
    portolanVersion, providerSummary, agentsLink, FAINT_OUTLINE, collectionColumns,
    styleSourceFile, stylesForFile, selectAssets, layerSettings, itemHref, itemDate, itemMirrorUrl, framesFromItems,
} from '../core/portolan.js';
import { PortolanCatalog, titilerTileUrl, defaultTooltip, topLevelColumns } from '../core/portolan-catalog.js';

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

    it('keeps every default, one per PMTiles file, defaults first', () => {
        const c = { assets: {
            a: { href: './a.json', roles: ['style', 'default'] },
            extra: { href: './x.json', roles: ['style'] },
            b: { href: './b.json', roles: ['style', 'default'] },
        } };
        expect(findStyleAssets(c, BASE).map(s => [s.key, s.isDefault])).toEqual([['a', true], ['b', true], ['extra', false]]);
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

// #462: a collection's items as one raster time series.
describe('a series of items (#462)', () => {
    const CURL = 'https://example.org/cat/heat/collection.json';
    const tif = (href) => ({ href, type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'],
        bands: [{ nodata: -9999, unit: 'Cel', statistics: { minimum: 10, maximum: 40, mean: 26, stddev: 5 } }, { nodata: -9999 }] });
    const ids = ['heat-2025-06-16', 'heat-2025-06-15', 'heat-2025-06-17'];
    // stac-geoparquet rows: properties at top level, dates as Date objects.
    const rows = ids.map(id => ({ id, datetime: new Date(`${id.slice(5)}T12:00:00Z`), assets: { data: tif(`./${id}.tif`), thumb: { href: './t.jpg', type: 'image/jpeg' } } }));
    const heat = {
        type: 'Collection', id: 'heat', title: 'Daily heat',
        links: ids.map(id => ({ rel: 'item', href: `./${id}/${id}.json` })),
        assets: { 'geoparquet-items': { href: './items.parquet', type: 'application/vnd.apache.parquet', roles: ['collection-mirror'] } },
    };
    const itemJson = (row) => ({ type: 'Feature', id: row.id, properties: { datetime: row.datetime.toISOString() }, assets: row.assets });
    const docs = Object.fromEntries([[CURL, heat], ...rows.map(r => [`https://example.org/cat/heat/${r.id}/${r.id}.json`, itemJson(r)])]);
    const fetchJson = vi.fn(async (u) => { if (!docs[u]) throw new Error(`404 ${u}`); return structuredClone(docs[u]); });
    const control = { bind: 'frame', frames: 'items', frame_ms: 300 };

    it('finds the item mirror and turns items into dated frames, hrefs against each item', () => {
        expect(itemMirrorUrl(heat, CURL)).toBe('https://example.org/cat/heat/items.parquet');
        expect(itemMirrorUrl({ assets: { items: { href: 'x/items.parquet', type: 'application/vnd.apache.parquet' } } }, CURL)).toBe('https://example.org/cat/heat/x/items.parquet');
        expect(itemMirrorUrl({ assets: {} }, CURL)).toBeNull();
        const frames = framesFromItems(rows.map(r => ({ id: r.id, url: itemHref(heat, CURL, r.id), item: r })));
        expect(frames.map(f => [f.datetime, f.href])).toEqual([
            ['2025-06-15', 'https://example.org/cat/heat/heat-2025-06-15/heat-2025-06-15.tif'],
            ['2025-06-16', 'https://example.org/cat/heat/heat-2025-06-16/heat-2025-06-16.tif'],
            ['2025-06-17', 'https://example.org/cat/heat/heat-2025-06-17/heat-2025-06-17.tif'],
        ]);
        expect(framesFromItems([{ id: 'x', url: CURL, item: { properties: {} , assets: { data: tif('a.tif') } } }])).toEqual([]);
    });

    it('reads the mirror once and draws one layer over every date, starting on the latest', async () => {
        fetchJson.mockClear();
        const readItemMirror = vi.fn(async () => structuredClone(rows));
        const c = new PortolanCatalog({ fetchJson, pmtilesMetadata: async () => null, readItemMirror });
        await c.load({ collections: [{ url: CURL, colormap: 'rdylbu_r', rescale: '10,40', control }] });
        expect(readItemMirror).toHaveBeenCalledWith('https://example.org/cat/heat/items.parquet');
        expect(fetchJson).toHaveBeenCalledTimes(1); // the collection only
        const [cfg] = c.getMapLayerConfigs();
        expect(cfg.layerId).toBe('heat');
        expect(cfg.control).toEqual(control);
        expect(cfg.frameSource.frames.map(f => f.datetime)).toEqual(['2025-06-15', '2025-06-16', '2025-06-17']);
        expect(cfg.source.tiles[0]).toContain(encodeURIComponent('heat-2025-06-17.tif'));
        expect(cfg.source.tiles[0]).toContain('bidx=1');
        const frameUrl = cfg.frameTileUrl('https://example.org/cat/heat/heat-2025-06-15/heat-2025-06-15.tif');
        expect(frameUrl).toContain('colormap_name=rdylbu_r');
        expect(frameUrl).toContain('rescale=10,40');
        expect(c.generatePrompt()).toContain('time series of 3 dates from 2025-06-15 to 2025-06-17');
    });

    it('reads the items one by one when the mirror is unreadable', async () => {
        fetchJson.mockClear();
        const c = new PortolanCatalog({ fetchJson, pmtilesMetadata: async () => null, readItemMirror: async () => { throw new Error('no range requests'); } });
        await c.load({ collections: [{ url: CURL, control, bidx: 2 }] });
        expect(fetchJson).toHaveBeenCalledTimes(4);
        const l = c.layers.get('heat/band-2');
        expect(l.series.frames).toHaveLength(3);
        expect(l.band.bidx).toBe(2);
    });

    it('keeps config order when one collection is listed twice', async () => {
        const slowFirst = async (u) => { if (u === CURL) await new Promise(r => setTimeout(r, 0)); return fetchJson(u); };
        let calls = 0;
        const c = new PortolanCatalog({
            fetchJson: async (u) => (u === CURL && calls++ === 0 ? new Promise(r => setTimeout(() => r(structuredClone(heat)), 20)) : slowFirst(u)),
            pmtilesMetadata: async () => null,
            readItemMirror: async () => structuredClone(rows),
        });
        await c.load({ collections: [
            { url: CURL, id: 'series', control },
            { url: CURL, id: 'days', items: ['heat-2025-06-15'] },
        ] });
        expect([...c.datasets.keys()]).toEqual(['series', 'days']);
    });

    it('names a series beside other layers of the collection', async () => {
        const c = new PortolanCatalog({ fetchJson, pmtilesMetadata: async () => null, readItemMirror: async () => structuredClone(rows) });
        await c.load({ collections: [{ url: CURL, control, items: ['heat-2025-06-15'] }] });
        expect(c.datasets.get('heat').layerIds).toEqual(['heat/heat-2025-06-15', 'heat/series']);
    });

    it('reads the top-level column names of a Parquet schema', () => {
        const schema = [
            { name: 'root', num_children: 3 },
            { name: 'id' },
            { name: 'assets', num_children: 1 }, { name: 'data', num_children: 1 }, { name: 'href' },
            { name: 'datetime' },
        ];
        expect(topLevelColumns(schema)).toEqual(['id', 'assets', 'datetime']);
    });
});

// The session export cites the collections a session queried by matching its
// s3:// paths to asset hrefs, which Portolan writes relative.
describe('the catalog as the session export reads it', () => {
    it('gives each collection absolute asset hrefs and keeps the catalog otherwise', async () => {
        const { exportCatalogView } = await import('../core/portolan-catalog.js');
        const { withAbsoluteHrefs } = await import('../core/portolan.js');
        const u = 'https://storage.googleapis.com/b/roads/collection.json';
        expect(withAbsoluteHrefs({ assets: { data: { href: './data.parquet' }, x: null } }, u).assets)
            .toEqual({ data: { href: 'https://storage.googleapis.com/b/roads/data.parquet' }, x: null });
        const raw = { id: 'roads', assets: { data: { href: './data.parquet', type: 'application/vnd.apache.parquet' } } };
        const catalog = { getAll: () => [{ id: 'roads', url: u, _rawStac: raw }], getIds: () => ['roads'] };
        const view = exportCatalogView(catalog);
        expect(view.getAll()[0]._rawStac.assets.data.href).toBe('https://storage.googleapis.com/b/roads/data.parquet');
        expect(raw.assets.data.href).toBe('./data.parquet');
        expect(view.getIds()).toEqual(['roads']);
    });
});

// SchmidtDSE/glen#441: glen core takes the full app's per-layer settings, by
// the names apps already use, so a v3 config carries over.
describe('the full app\'s layer settings in glen core', () => {
    const U = 'https://example.org/cat/w/collection.json';
    const cog = (href, min, max) => ({ href, type: 'image/tiff; application=geotiff', roles: ['data'],
        bands: [{ statistics: { minimum: min, maximum: max } }] });
    const pm = (href, layer) => ({ href, type: 'application/vnd.pmtiles', roles: ['visual'], 'pmtiles:layers': [layer] });
    const col = {
        type: 'Collection', id: 'w', title: 'Watersheds', links: [],
        assets: {
            l3: pm('./l3.pmtiles', 'l3'), l6: pm('./l6.pmtiles', 'l6'),
            y2000: cog('./y2000.tif', 0, 10), y2020: cog('./y2020.tif', 0, 20),
        },
    };
    const meta = async () => ({ vector_layers: [{ id: 'x', fields: { name: 'String' } }], tilestats: { layers: [{ layer: 'x', geometry: 'Polygon' }] } });
    const make = () => new PortolanCatalog({ fetchJson: async () => structuredClone(col), pmtilesMetadata: meta });

    it('reads the full app\'s key names as core\'s, and the group\'s object form', () => {
        expect(layerSettings(
            { group: { name: 'Water', collapsed: true }, tooltip_fields: ['a'] },
            { default_style: { 'line-color': '#00f' }, layer_type: 'line', outline_style: { 'line-width': 2 } },
        )).toEqual({ group: 'Water', group_collapsed: true, tooltip: ['a'], paint: { 'line-color': '#00f' }, render_type: 'line', outline_paint: { 'line-width': 2 } });
    });

    it('draws versions as one layer with a source per version, starting on default_version', async () => {
        const c = make();
        await c.load({ collections: [{ url: U, group: { name: 'Water', collapsed: true }, assets: [
            { id: 'basins', display_name: 'Basins', default_style: { 'fill-color': '#08f' },
              versions: [{ label: 'L3', asset_id: 'l3' }, { label: 'L6', asset_id: 'l6' }], default_version: 'L6' },
            { id: 'years', display_name: 'Rain', colormap: 'blues',
              versions: [{ label: '2000', asset_id: 'y2000' }, { label: '2020', asset_id: 'y2020' }] },
        ] }] });
        const [basins, years] = c.getMapLayerConfigs();
        expect(basins).toMatchObject({ layerId: 'w/basins', displayName: 'Basins', group: 'Water', groupCollapsed: true, defaultVersionIndex: 1, paint: { 'fill-color': '#08f' } });
        expect(basins.source).toBeUndefined();
        expect(basins.versions.map(v => [v.label, v.source.url, v.sourceLayer])).toEqual([
            ['L3', 'pmtiles://https://example.org/cat/w/l3.pmtiles', 'l3'],
            ['L6', 'pmtiles://https://example.org/cat/w/l6.pmtiles', 'l6'],
        ]);
        expect(years.versions.map(v => [v.label, v.rescale])).toEqual([['2000', '0,10'], ['2020', '0,20']]);
        expect(years.versions[1].source.tiles[0]).toContain(encodeURIComponent('y2020.tif'));
        expect(years.versions[1].source.tiles[0]).toContain('colormap_name=blues');
        expect(c.generatePrompt()).toContain('Versions, switched in the layer panel: L3, L6; starts on L6');
    });

    it('takes toggle groups, out-of-panel layers, render type and tooltips by the full app\'s names', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const c = make();
        await c.load({ collections: [{ url: U, sidebar: false, assets: [
            { id: 'l3', layer_type: 'line', tooltip_fields: ['name'], toggle_group: 'Basins', visible: true },
            { id: 'y2000', sidebar: true, toggle_group: 'Basins' },
        ] }] });
        const [l3, y] = c.getMapLayerConfigs();
        expect(l3).toMatchObject({ sidebar: false, toggleGroup: 'Basins', renderType: 'line', tooltipFields: ['name'] });
        expect(y).toMatchObject({ sidebar: true, toggleGroup: 'Basins' });
        expect(warn.mock.calls.some(([m]) => /sidebar.*false.*visible/.test(m))).toBe(true);
        expect(c.generatePrompt()).toContain('Toggle group "Basins"');
        warn.mockRestore();
    });

    it('reports a version asset the collection lacks, and keeps one kind per layer', () => {
        const v = [{ key: 'a', aliases: [], layers: [] }];
        const r = [{ key: 'b' }];
        const { picks, missing } = selectAssets([{ id: 'x', versions: [{ label: 'A', asset_id: 'a' }, { label: 'B', asset_id: 'b' }, { label: 'C', asset_id: 'c' }] }], v, r);
        expect(picks[0]).toMatchObject({ kind: 'versioned', vkind: 'vector' });
        expect(picks[0].members.map(m => m.label)).toEqual(['A']);
        expect(missing).toEqual(['c', 'b (a raster among vector versions)']);
    });
});
