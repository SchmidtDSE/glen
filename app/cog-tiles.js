/**
 * cog-tiles.js — How a COG is drawn: its band settings and its TiTiler tile URL.
 *
 * Shared by the full app (dataset-catalog.js) and glen core
 * (core/portolan-catalog.js), so a raster is drawn the same way in both:
 * scaled bands are unscaled, a class whose value is the nodata value never
 * paints, and an overlong colormap is reported (#441).
 */

/**
 * Normalize a vector layer's `legend_classes` config into the internal
 * categorical-legend shape (`{ name, 'color-hint' }`) the legend renderer
 * expects. Accepts the documented `{ label, color }` form as well as the
 * STAC-style `{ name | value, 'color-hint' }` form so either author style
 * works. Rasters use it too, in place of STAC `classification:classes` (#350).
 * @param {Array<Object>} raw
 * @returns {Array<Object>|null}
 */
export function normalizeLegendClasses(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map(c => ({
        name: c.name ?? c.label ?? (c.value != null ? `Class ${c.value}` : ''),
        'color-hint': c['color-hint'] ?? c.color_hint ?? c.color ?? null,
        ...(c.value != null ? { value: c.value } : {}),
    }));
}

/**
 * Resolve the band-dependent settings of a COG asset from its STAC
 * `bands` (STAC 1.1) or `raster:bands`, and the asset's config.
 *
 * - `bidx` (1-based) picks the band of a multi-band COG (#357); the band's own
 *   `nodata` and `classification:classes` are then read from that band.
 * - Config `legend_classes` overrides the STAC classes (#350). They also build
 *   the TiTiler colormap, so leaving a class out makes it transparent.
 * - A class whose value is the band's nodata is dropped, so fill codes such as
 *   NLCD 250 never paint.
 * - `unscale` asks TiTiler to apply the band's scale and offset, so `rescale`
 *   and the legend are in real units. It defaults to on when STAC gives a
 *   scale other than 1 or an offset other than 0; config `unscale` overrides.
 *
 * @param {Object} asset  STAC asset
 * @param {Object} config asset config from layers-input.json
 * @returns {{bidx:number|null, nodata:*, legendClasses:Array|null, unscale:boolean}}
 */
export function resolveRasterBand(asset, config = {}) {
    const bidx = Number.isInteger(Number(config.bidx)) && Number(config.bidx) >= 1 ? Number(config.bidx) : null;
    const bands = asset?.bands || asset?.['raster:bands'];
    const band = bands?.[(bidx ?? 1) - 1];
    const nodata = config.nodata ?? band?.nodata ?? null;
    let legendClasses = normalizeLegendClasses(config.legend_classes) ?? band?.['classification:classes'] ?? null;
    if (legendClasses && nodata != null) {
        legendClasses = legendClasses.filter(c => c.value == null || String(c.value) !== String(nodata));
    }
    const scale = band?.scale != null ? Number(band.scale) : 1;
    const offset = band?.offset != null ? Number(band.offset) : 0;
    const unscale = typeof config.unscale === 'boolean' ? config.unscale : (scale !== 1 || offset !== 0);
    return { bidx, nodata, legendClasses: legendClasses?.length ? legendClasses : null, unscale };
}

// Past this length a tile URL is at risk of being refused outright by the
// tile server or a proxy (an 832-class inline colormap made 47 kB, #350).
const MAX_TILE_URL = 8000;

/**
 * Build a TiTiler COG tile URL for a raster layer.
 * @param {string} titilerUrl
 * @param {string} cogUrl
 * @param {Object} o { legendType, legendClasses, colormap, rescale, nodata, bidx, unscale }
 * @returns {string}
 */
export function cogTileUrl(titilerUrl, cogUrl, o) {
    let url = `${titilerUrl}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(cogUrl)}`;
    if (o.bidx != null) url += `&bidx=${encodeURIComponent(o.bidx)}`;
    if (o.unscale) url += '&unscale=true';
    if (o.legendType === 'categorical' && o.legendClasses?.length) {
        // Inline colormap from the classes' color hints (STAC "RRGGBB" or config "#RRGGBB").
        const cmap = {};
        for (const cls of o.legendClasses) {
            const h = String(cls['color-hint'] || cls.color_hint || '').replace(/^#/, '');
            if (/^[0-9a-fA-F]{6}$/.test(h) && cls.value != null) {
                cmap[String(cls.value)] = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
            }
        }
        url += `&colormap=${encodeURIComponent(JSON.stringify(cmap))}`;
    } else {
        url += `&colormap_name=${o.colormap || 'reds'}`;
        if (o.rescale) url += `&rescale=${o.rescale}`;
    }
    if (o.nodata != null) url += `&nodata=${encodeURIComponent(o.nodata)}`;
    if (url.length > MAX_TILE_URL) {
        console.warn(`[catalog] Tile URL for ${cogUrl} is ${url.length} characters, so the tile server may refuse it. ` +
            'List only the classes you want in legend_classes to shorten the inline colormap.');
    }
    return url;
}
