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
 * The catalog's published look for a COG asset: the first of the
 * collection's renders (the STAC render extension) that names the asset.
 * `colormap_name`, the first `rescale` range and `nodata` become the config
 * keys of the same names; a categorical `colormap` (value → colour) is
 * returned as `classColours`. Null when no render names the asset.
 *
 * @param {Object} collection STAC collection
 * @param {string} assetKey   the COG asset's key in the collection
 * @returns {{name:string, title:string|null, colormap:string|null,
 *   rescale:string|null, nodata:*, classColours:Object|null}|null}
 */
export function publishedRender(collection, assetKey) {
    const entry = Object.entries(collection?.renders || {})
        .find(([, r]) => Array.isArray(r?.assets) && r.assets.includes(assetKey));
    if (!entry) return null;
    const [name, r] = entry;
    const range = Array.isArray(r.rescale?.[0]) && r.rescale[0].length === 2
        && r.rescale[0].every(v => v !== null && v !== '' && Number.isFinite(Number(v)))
        ? r.rescale[0].map(Number).join(',') : null;
    return {
        name,
        title: r.title || null,
        colormap: typeof r.colormap_name === 'string' && r.colormap_name ? r.colormap_name : null,
        rescale: range,
        nodata: r.nodata ?? null,
        classColours: r.colormap && typeof r.colormap === 'object' && !Array.isArray(r.colormap) ? r.colormap : null,
    };
}

/** "RRGGBB" from "#RRGGBB", "RRGGBB" or [r, g, b(, a)]; null otherwise. */
function hexColour(c) {
    if (Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
        return c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    const h = String(c ?? '').replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(h) ? h : null;
}

/**
 * Legend classes from a render's categorical colormap, in its order and
 * colours, named from the band's classes where they share a value. A value
 * the render leaves out is not drawn.
 */
export function renderClasses(classColours, bandClasses = null) {
    if (!classColours) return null;
    const names = new Map((bandClasses || []).map(c => [String(c.value), c.name]));
    const out = [];
    for (const [v, colour] of Object.entries(classColours)) {
        const hex = hexColour(colour);
        if (!hex) continue;
        const n = Number(v);
        out.push({ value: v !== '' && Number.isFinite(n) ? n : v, name: names.get(String(v)) ?? `Class ${v}`, 'color-hint': hex });
    }
    return out.length ? out : null;
}

/**
 * Resolve the band-dependent settings of a COG asset from its STAC
 * `bands` (STAC 1.1) or `raster:bands`, and the asset's config.
 *
 * - `bidx` (1-based) picks the band of a multi-band COG (#357); the band's own
 *   `nodata` and `classification:classes` are then read from that band.
 *   A COG whose STAC lists more than one band and whose config names none
 *   draws band 1, since TiTiler cannot apply a colour map to several bands.
 * - Config `legend_classes` overrides the STAC classes (#350). They also build
 *   the TiTiler colormap, so leaving a class out makes it transparent.
 * - A class whose value is the band's nodata is dropped, so fill codes such as
 *   NLCD 250 never paint.
 * - `unscale` asks TiTiler to apply the band's scale and offset, so `rescale`
 *   and the legend are in real units. It defaults to on when STAC gives a
 *   scale other than 1 or an offset other than 0; config `unscale` overrides.
 *
 * - A published render (`publishedRender`) comes between the two: its
 *   `nodata` and categorical colours win over the band's, and config wins
 *   over the render.
 *
 * @param {Object} asset  STAC asset
 * @param {Object} config asset config from layers-input.json
 * @param {Object|null} render the asset's published render, if any
 * @returns {{bidx:number|null, nodata:*, legendClasses:Array|null, unscale:boolean}}
 */
export function resolveRasterBand(asset, config = {}, render = null) {
    const bands = asset?.bands || asset?.['raster:bands'];
    // TiTiler colours one band only; a multi-band COG with no band named in
    // config draws band 1 rather than failing every tile.
    const bidx = Number.isInteger(Number(config.bidx)) && Number(config.bidx) >= 1 ? Number(config.bidx)
        : (Array.isArray(bands) && bands.length > 1 ? 1 : null);
    const band = bands?.[(bidx ?? 1) - 1];
    const nodata = config.nodata ?? render?.nodata ?? band?.nodata ?? null;
    const bandClasses = band?.['classification:classes'] ?? null;
    let legendClasses = normalizeLegendClasses(config.legend_classes)
        ?? renderClasses(render?.classColours, bandClasses) ?? bandClasses;
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
