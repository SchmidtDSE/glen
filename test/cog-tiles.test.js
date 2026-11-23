import { describe, it, expect, vi } from 'vitest';
import { resolveRasterBand, cogTileUrl, publishedRender, renderClasses, normalizeLegendClasses } from '../app/cog-tiles.js';

// How a COG is drawn: band settings, the TiTiler tile URL and the catalog's
// raster renders. Shared by both apps; glen core's use of them is covered in
// test/core-portolan.test.js.

describe('raster band settings (#357, #350, unscale)', () => {
    const sixBands = {
        href: 'https://x/rap.tif',
        'raster:bands': [1, 2, 3, 4, 5, 6].map(i => ({ nodata: i === 4 ? 255 : 0, 'classification:classes': [{ value: i, 'color-hint': '00ff00' }] })),
    };

    it('reads nodata and classes from the band bidx picks', () => {
        const b = resolveRasterBand(sixBands, { bidx: 4 });
        expect(b.bidx).toBe(4);
        expect(b.nodata).toBe(255);
        expect(b.legendClasses).toEqual([{ value: 4, 'color-hint': '00ff00' }]);
    });

    it('draws band 1 of a multi-band COG when config names no band, or no valid one', () => {
        // TiTiler cannot colour several bands, so without bidx every tile failed.
        expect(resolveRasterBand(sixBands, {}).bidx).toBe(1);
        expect(resolveRasterBand(sixBands, { bidx: 0 }).bidx).toBe(1);
        expect(resolveRasterBand(sixBands, { bidx: 1.5 }).bidx).toBe(1);
        expect(resolveRasterBand(sixBands, {}).nodata).toBe(0);
        expect(cogTileUrl('https://t', 'https://x/rap.tif', resolveRasterBand(sixBands, {}))).toContain('&bidx=1');
    });

    it('leaves bidx off a single-band COG', () => {
        expect(resolveRasterBand({ href: 'x', bands: [{ nodata: 0 }] }, {}).bidx).toBe(null);
        expect(resolveRasterBand({ href: 'x' }, {}).bidx).toBe(null);
    });

    it('config legend_classes replace the STAC classes', () => {
        const asset = { 'raster:bands': [{ 'classification:classes': [
            { value: 1, 'color-hint': 'aa0000' }, { value: 11, 'color-hint': '0000ff' }] }] };
        const b = resolveRasterBand(asset, { legend_classes: [{ value: 1, label: 'Low departure', color: '#aa0000' }] });
        expect(b.legendClasses).toEqual([{ value: 1, name: 'Low departure', 'color-hint': '#aa0000' }]);
    });

    it('drops a class whose value is the band nodata', () => {
        const asset = { 'raster:bands': [{ nodata: 250, 'classification:classes': [
            { value: 11, 'color-hint': '466b9f' }, { value: 250, 'color-hint': '000000' }] }] };
        expect(resolveRasterBand(asset).legendClasses.map(c => c.value)).toEqual([11]);
    });

    it('turns unscale on when STAC gives a scale or offset, and lets config override it', () => {
        const crw = { 'raster:bands': [{ data_type: 'int16', nodata: -32768, scale: 0.01, offset: 0 }] };
        expect(resolveRasterBand(crw).unscale).toBe(true);
        expect(resolveRasterBand(crw, { unscale: false }).unscale).toBe(false);
        expect(resolveRasterBand({ 'raster:bands': [{ scale: 1, offset: 0 }] }).unscale).toBe(false);
        expect(resolveRasterBand({ 'raster:bands': [{ offset: -273.15 }] }).unscale).toBe(true);
        expect(resolveRasterBand({}).unscale).toBe(false);
    });

    it('cogTileUrl carries bidx and unscale', () => {
        const url = cogTileUrl('https://t', 'https://x/a.tif', { colormap: 'rdbu_r', rescale: '-1,4', bidx: 4, unscale: true, nodata: -32768 });
        expect(url).toContain('&bidx=4');
        expect(url).toContain('&unscale=true');
        expect(url).toContain('&rescale=-1,4');
        expect(url).toContain('&nodata=-32768');
    });

    it('cogTileUrl reads #-prefixed config colors into the colormap', () => {
        const url = cogTileUrl('https://t', 'https://x/a.tif', {
            legendType: 'categorical',
            legendClasses: [{ value: 1, 'color-hint': '#ff0000' }, { value: 2, 'color-hint': '00ff00' }],
        });
        const cmap = JSON.parse(decodeURIComponent(url.split('&colormap=')[1]));
        expect(cmap).toEqual({ 1: [255, 0, 0, 255], 2: [0, 255, 0, 255] });
    });

    it('warns when an inline colormap makes the URL too long', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const classes = Array.from({ length: 832 }, (_, i) => ({ value: i, 'color-hint': '123456' }));
        cogTileUrl('https://t', 'https://x/evt.tif', { legendType: 'categorical', legendClasses: classes });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/may refuse it/));
        warn.mockRestore();
    });
});

describe('raster renders from the catalog (#440)', () => {
    const COG = 'image/tiff; application=geotiff; profile=cloud-optimized';
    const ships = {
        type: 'Collection', id: 'ships', links: [],
        renders: {
            global: { title: 'All vessels', assets: ['global-cog'], colormap_name: 'reds', rescale: [[0, 13500000]], nodata: 0 },
            fishing: { title: 'Fishing', assets: ['fishing-cog'], colormap_name: 'blues', rescale: [[0, 108000]] },
        },
        assets: {
            'global-cog': { href: 'https://x/global.tif', type: COG, roles: ['data'], 'raster:bands': [{ nodata: 2147483647 }] },
            'fishing-cog': { href: 'https://x/fishing.tif', type: COG, roles: ['data'] },
        },
    };
    const landcover = {
        type: 'Collection', id: 'nlcd', links: [],
        renders: { lc: { assets: ['lc-cog'], colormap: { 11: '#466B9F', 21: [222, 197, 197, 255] }, nodata: 250, resampling: 'nearest' } },
        assets: {
            'lc-cog': {
                href: 'https://x/lc.tif', type: COG, roles: ['data'],
                'raster:bands': [{ nodata: 250, 'classification:classes': [
                    { value: 11, name: 'Open Water', color_hint: '000000' },
                    { value: 21, name: 'Developed, Open Space', color_hint: '000000' },
                    { value: 31, name: 'Barren', color_hint: '000000' },
                ] }],
            },
        },
    };

    it("reads the render that names an asset, in config's terms", () => {
        expect(publishedRender(ships, 'global-cog')).toEqual({
            name: 'global', title: 'All vessels', colormap: 'reds', rescale: '0,13500000', nodata: 0, classColours: null,
        });
        expect(publishedRender(ships, 'missing')).toBeNull();
        expect(publishedRender({ assets: {} }, 'x')).toBeNull();
        expect(publishedRender({ renders: { a: { assets: ['x'], rescale: [['lo', 1]] } } }, 'x').rescale).toBeNull();
    });

    it("names a render's categories from the band and takes the render's colours", () => {
        expect(renderClasses({ 11: '#466B9F', 21: [222, 197, 197, 255], 99: 'nope' }, [{ value: 11, name: 'Open Water' }])).toEqual([
            { value: 11, name: 'Open Water', 'color-hint': '466B9F' },
            { value: 21, name: 'Class 21', 'color-hint': 'DEC5C5' },
        ]);
        expect(renderClasses(null)).toBeNull();
    });

    it("names a category by the class's title before its name (SchmidtDSE/glen#528)", () => {
        const classes = [{ value: 11, name: 'open-water', title: 'Open Water' }, { value: 21, name: 'Developed' }];
        expect(renderClasses({ 11: '#466B9F', 21: '#DEC5C5' }, classes).map(c => c.name)).toEqual(['Open Water', 'Developed']);
        expect(normalizeLegendClasses(classes).map(c => c.name)).toEqual(['Open Water', 'Developed']);
    });
});
