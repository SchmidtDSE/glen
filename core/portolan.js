/**
 * portolan.js — Read a Portolan collection into map layers.
 *
 * Pure functions with no fetching and no DOM, so they run under vitest. The
 * I/O lives in portolan-catalog.js.
 *
 * Portolan (https://www.portolan-sdi.org/, spec v0.2.0) is an opinionated
 * profile of STAC for static catalogs. What a map client reads from it:
 *
 *   - Vector tiles: a collection-level link with `rel: pmtiles` whose
 *     `pmtiles:layers` names the source layers (PORTO-FMT-011/012), and/or an
 *     asset with the `visual` role and the PMTiles media type.
 *   - Styles: assets with the `style` role, one of which also carries
 *     `default` (PORTO-CORE-069/070). Each is a complete MapLibre style whose
 *     `sources.data.url` is relative to the style file (PORTO-FMT-015).
 *   - Rasters: a COG asset with the `data` role, its band statistics embedded
 *     in the STAC `bands` (or `raster:bands`) metadata (PORTO-FMT-027).
 *   - Assets with the `source` role are upstream originals, never rendered.
 *
 * Asset keys carry no meaning; everything is found by role and media type.
 */

import { resolveRasterBand } from '../app/cog-tiles.js';

export const PMTILES_TYPE = 'application/vnd.pmtiles';

/** Resolve an href against the document that holds it. */
export function resolveHref(href, baseUrl) {
    if (!href) return null;
    try {
        return new URL(href, baseUrl).href;
    } catch {
        return href;
    }
}

const roles = (asset) => (Array.isArray(asset?.roles) ? asset.roles : []);
const isSource = (asset) => roles(asset).includes('source');

export function isPmtilesAsset(asset) {
    if (!asset || isSource(asset)) return false;
    return String(asset.type || '').includes(PMTILES_TYPE) || /\.pmtiles$/i.test(asset.href || '');
}

export function isCogAsset(asset) {
    if (!asset || isSource(asset)) return false;
    const t = String(asset.type || '').toLowerCase();
    return t.includes('geotiff') || t.startsWith('image/tiff');
}

/**
 * The PMTiles archives a collection offers, deduplicated by URL. A Portolan
 * collection commonly lists the same file twice: as the `rel: pmtiles` link
 * and as a `visual` asset.
 *
 * @param {Object} collection - STAC collection
 * @param {string} collectionUrl - URL the collection was fetched from
 * @returns {Array<{key: string, url: string, layers: string[], title: string|null, columns: Object[]}>}
 *   `columns` is the asset's own `table:columns`, when it has them
 */
export function findVectorSources(collection, collectionUrl) {
    const out = [];
    const byUrl = new Map();
    const add = (key, href, layers, title, columns) => {
        const url = resolveHref(href, collectionUrl);
        if (!url) return;
        const existing = byUrl.get(url);
        if (existing) {
            if (!existing.layers.length && layers?.length) existing.layers = [...layers];
            if (!existing.title && title) existing.title = title;
            if (!existing.columns.length && columns?.length) existing.columns = columns;
            return;
        }
        const entry = { key, url, layers: layers ? [...layers] : [], title: title || null, columns: columns || [] };
        byUrl.set(url, entry);
        out.push(entry);
    };

    for (const link of collection?.links || []) {
        if (link.rel !== 'pmtiles') continue;
        const layers = link['pmtiles:layers'];
        // The link has no key; name it after the file so a second archive
        // gets a distinct, stable layer id.
        const key = (link.href || '').split('/').pop().replace(/\.pmtiles$/i, '') || 'pmtiles';
        add(key, link.href, Array.isArray(layers) ? layers : [], link.title);
    }
    for (const [key, asset] of Object.entries(collection?.assets || {})) {
        if (!isPmtilesAsset(asset)) continue;
        const layers = asset['pmtiles:layers'] || asset['vector:layers'];
        add(key, asset.href, Array.isArray(layers) ? layers : [], asset.title, tableColumns(asset));
    }
    return out;
}

const tableColumns = (doc) => (Array.isArray(doc?.['table:columns']) ? doc['table:columns'].filter(c => c?.name) : []);

/**
 * A collection's column descriptions. Portolan puts `table:columns` on the
 * collection; our current STAC puts them on each asset, on purpose (#441).
 * Both are read: the collection's first, then each asset's, the first
 * description of a name winning.
 *
 * @returns {Array<{name: string, type?: string, description?: string}>}
 */
export function collectionColumns(collection) {
    const byName = new Map();
    const docs = [collection, ...Object.values(collection?.assets || {}).filter(a => !isSource(a))];
    for (const doc of docs) {
        for (const c of tableColumns(doc)) {
            const prev = byName.get(c.name);
            if (!prev) byName.set(c.name, { ...c });
            else if (!prev.description && c.description) prev.description = c.description;
        }
    }
    return [...byName.values()];
}

/**
 * The style assets of a collection, the default first.
 *
 * The default is the asset with both `style` and `default` roles; when no
 * asset carries `default` (allowed when there is only one style, and common
 * in v0.1 catalogs), an asset keyed `style` wins, else the first.
 *
 * @returns {Array<{key: string, name: string, title: string|null, url: string, isDefault: boolean}>}
 */
export function findStyleAssets(collection, collectionUrl) {
    const styles = Object.entries(collection?.assets || {})
        .filter(([, a]) => roles(a).includes('style') && !isSource(a))
        .map(([key, a]) => ({
            key,
            name: styleName(key),
            title: a.title || null,
            url: resolveHref(a.href, collectionUrl),
            isDefault: roles(a).includes('default'),
        }));
    if (!styles.length) return styles;
    if (!styles.some(s => s.isDefault)) {
        const pick = styles.find(s => s.key === 'style') || styles[0];
        pick.isDefault = true;
    }
    return [...styles.filter(s => s.isDefault).slice(0, 1), ...styles.filter(s => !s.isDefault)];
}

/**
 * The PMTiles file a style draws, by file name, or null when its sources name
 * no PMTiles archive. Portolan writes the source URL relative to the style
 * file (`pmtiles://../eez.pmtiles`), so the file name is what a style and an
 * asset's href reliably share.
 */
export function styleSourceFile(doc) {
    for (const src of Object.values(doc?.sources || {})) {
        const u = typeof src?.url === 'string' ? src.url : '';
        if (!/^pmtiles:\/\//.test(u) && !/\.pmtiles([?#]|$)/.test(u)) continue;
        return fileName(u.replace(/^pmtiles:\/\//, '')) || null;
    }
    return null;
}

/**
 * Of a collection's styles (each `{ ..., doc }`, default first as
 * {@link findStyleAssets} orders them), the ones that draw the PMTiles file at
 * `fileUrl`, default first. A collection with several archives publishes a
 * style per archive (SVI's county and tract layers, EEZ and high seas), so a
 * layer takes only its own file's styles. A style whose sources name no
 * archive applies to any layer. When none of a layer's styles is the
 * collection's default, its first one is.
 */
export function stylesForFile(styles, fileUrl) {
    const file = fileName(fileUrl);
    const mine = (styles || []).filter(s => {
        const f = styleSourceFile(s.doc);
        return !f || f === file;
    });
    if (!mine.length || mine.some(s => s.isDefault)) return mine;
    return mine.map((s, i) => (i === 0 ? { ...s, isDefault: true } : s));
}

function fileName(url) {
    return String(url || '').split(/[?#]/)[0].split('/').pop();
}

/** A short style name for the agent: "style-categorical" → "categorical", "styles/2025" → "2025". */
export function styleName(key) {
    const k = String(key).replace(/^styles\//, '').replace(/^style[-_]?/, '');
    return k || 'default';
}

/**
 * The COG assets of a collection that hold the data itself.
 *
 * @returns {Array<{key, url, title, band}>} band from {@link rasterBand}
 */
export function findRasterAssets(collection, collectionUrl) {
    return Object.entries(collection?.assets || {})
        .filter(([, a]) => isCogAsset(a) && (roles(a).includes('data') || roles(a).includes('visual')))
        .map(([key, a]) => ({
            key,
            url: resolveHref(a.href, collectionUrl),
            title: a.title || null,
            band: rasterBand(a),
        }));
}

/**
 * Band 1 of a COG asset: nodata, statistics, categorical classes, and
 * whether TiTiler should apply the band's scale and offset.
 * Reads STAC 1.1 `bands` first, then the raster extension's `raster:bands`.
 * nodata, the classes and `unscale` follow the full app's rules
 * (app/cog-tiles.js), so a class whose value is the nodata value is dropped.
 */
export function rasterBand(asset) {
    const band = asset?.bands?.[0] || asset?.['raster:bands']?.[0] || {};
    const stats = band.statistics || {};
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const shared = resolveRasterBand(asset);
    const nodata = shared.nodata ?? asset?.nodata ?? null;
    let classes = shared.legendClasses || asset?.['classification:classes'] || null;
    if (Array.isArray(classes) && nodata != null) classes = classes.filter(c => c.value == null || String(c.value) !== String(nodata));
    return {
        nodata,
        unscale: shared.unscale,
        min: num(stats.minimum),
        max: num(stats.maximum),
        mean: num(stats.mean),
        stddev: num(stats.stddev),
        unit: band.unit || null,
        dataType: band.data_type || null,
        classes: Array.isArray(classes) && classes.length ? classes : null,
    };
}

/**
 * A display range "min,max" for a continuous band, from its statistics.
 *
 * Skewed bands (population, counts) put almost every pixel near the bottom of
 * [min, max], which renders as a flat colour. Capping the top at mean + 2·sd
 * keeps the bulk of the distribution visible; the agent can widen it.
 *
 * @returns {string|null}
 */
export function defaultRescale(band) {
    if (!band || band.min == null || band.max == null) return null;
    let hi = band.max;
    if (band.mean != null && band.stddev != null && band.stddev > 0) {
        hi = Math.min(band.max, band.mean + 2 * band.stddev);
    }
    if (!(hi > band.min)) hi = band.max;
    return `${round(band.min)},${round(hi)}`;
}

function round(v) {
    const a = Math.abs(v);
    const digits = a >= 100 ? 0 : a >= 1 ? 2 : 4;
    return Number(v.toFixed(digits));
}

/** "MultiPolygon" → "Polygon"; anything unknown → null. */
export function normalizeGeometryType(t) {
    const s = String(t || '').toLowerCase();
    if (s.includes('polygon')) return 'Polygon';
    if (s.includes('line')) return 'LineString';
    if (s.includes('point')) return 'Point';
    return null;
}

export const FAINT_OUTLINE = Object.freeze({
    'line-color': 'rgba(0,0,0,0.35)',
    'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.1, 10, 0.4, 14, 1],
});

const RENDER_FOR_GEOMETRY = { Polygon: 'fill', LineString: 'line', Point: 'circle' };

/**
 * Remove `["==", ["geometry-type"], …]` clauses from a filter. Portolan's
 * generated styles carry one fill, one line and one circle layer, each gated
 * on geometry type; the map draws one of them, so the gate is redundant.
 * @returns {Array|null} the filter without them, or null when nothing remains
 */
export function stripGeometryTypeFilter(filter) {
    if (!Array.isArray(filter)) return filter ?? null;
    const isGeomClause = (f) => Array.isArray(f)
        && (f[0] === '==' || f[0] === '!=')
        && Array.isArray(f[1]) && f[1][0] === 'geometry-type';
    if (isGeomClause(filter)) return null;
    // Legacy form: ["==", "$type", "Polygon"]
    if ((filter[0] === '==' || filter[0] === '!=') && filter[1] === '$type') return null;
    if (filter[0] === 'all') {
        const rest = filter.slice(1).map(stripGeometryTypeFilter).filter(f => f != null);
        if (!rest.length) return null;
        return rest.length === 1 ? rest[0] : ['all', ...rest];
    }
    return filter;
}

/**
 * Turn a MapLibre style document into the one layer glen draws for a
 * collection: its type, paint, filter and source layer.
 *
 * Picks the style layer whose type matches the data's geometry (fill for
 * polygons, line for lines, circle for points). A polygon's outline comes
 * from a line layer only when that layer is not gated to LineStrings. Symbol
 * layers are skipped: labels need a glyph server the core does not assume.
 *
 * @param {Object} style - MapLibre style (version 8)
 * @param {string|null} geometryType - 'Polygon' | 'LineString' | 'Point' | null
 * @returns {{renderType: string, paint: Object, outlinePaint: Object|null,
 *            filter: Array|null, sourceLayer: string|null}|null}
 */
export function styleToLayer(style, geometryType = null) {
    const layers = (style?.layers || []).filter(l => ['fill', 'line', 'circle'].includes(l.type));
    if (!layers.length) return null;
    const want = RENDER_FOR_GEOMETRY[geometryType];
    const gatedTo = (l) => {
        const f = l.filter;
        const find = (x) => {
            if (!Array.isArray(x)) return null;
            if ((x[0] === '==') && Array.isArray(x[1]) && x[1][0] === 'geometry-type') return normalizeGeometryType(x[2]);
            if (x[0] === '==' && x[1] === '$type') return normalizeGeometryType(x[2]);
            if (x[0] === 'all') for (const y of x.slice(1)) { const g = find(y); if (g) return g; }
            return null;
        };
        return find(f);
    };
    const main = (want && layers.find(l => l.type === want))
        || layers.find(l => !gatedTo(l) || gatedTo(l) === geometryType)
        || layers[0];

    let outlinePaint = null;
    if (main.type === 'fill') {
        const outline = layers.find(l => l !== main && l.type === 'line'
            && (l['source-layer'] ?? null) === (main['source-layer'] ?? null)
            && !gatedTo(l));
        // A publisher's style without an outline draws none. MapManager would
        // add a fixed dark one, which turns dense small polygons (H3 cells,
        // parcels) black at low zoom, so give a faint one that grows with zoom.
        outlinePaint = outline ? { ...outline.paint } : { ...FAINT_OUTLINE };
    }
    return {
        renderType: main.type,
        paint: guardMissingValues(main.type, { ...(main.paint || {}) }),
        outlinePaint,
        filter: stripGeometryTypeFilter(main.filter),
        sourceLayer: main['source-layer'] || null,
    };
}

/**
 * Hide features that lack the property a colour ramp reads.
 *
 * MapLibre cannot interpolate a missing value; the colour expression fails
 * for that feature and it paints in the fallback colour, black. Vector tiles
 * drop null attributes, so any null in the data does this. Rather than
 * rewrite the colour (the legend reads it), make the opacity zero where the
 * value is not a number.
 *
 * @param {'fill'|'line'|'circle'} type
 * @param {Object} paint
 * @returns {Object} paint, with the opacity guarded when the colour is a ramp
 */
export function guardMissingValues(type, paint) {
    const c = describeColor(paint);
    if (c?.kind !== 'continuous') return paint;
    const key = `${type}-opacity`;
    const opacity = paint[key] ?? 1;
    return {
        ...paint,
        [key]: ['case', ['==', ['typeof', ['get', c.property]], 'number'], opacity, 0],
    };
}

/**
 * What a paint colour expression encodes, for the prompt: the property it
 * reads and either its categories or its range. Lets the model filter and
 * restyle on real values instead of guessing them.
 *
 * @returns {{property: string, kind: 'categorical', values: Array}|
 *           {property: string, kind: 'continuous', range: [number, number]}|null}
 */
export function describeColor(paint) {
    const expr = paint?.['fill-color'] ?? paint?.['circle-color'] ?? paint?.['line-color'];
    if (!Array.isArray(expr)) return null;
    const prop = (x) => (Array.isArray(x) && x[0] === 'get' && typeof x[1] === 'string' ? x[1] : null);
    if (expr[0] === 'match' && prop(expr[1])) {
        const values = [];
        for (let i = 2; i < expr.length - 1; i += 2) {
            const label = expr[i];
            if (Array.isArray(label)) values.push(...label);
            else values.push(label);
        }
        return { property: prop(expr[1]), kind: 'categorical', values };
    }
    if ((expr[0] === 'interpolate' || expr[0] === 'interpolate-hcl' || expr[0] === 'interpolate-lab') && prop(expr[2])) {
        const stops = expr.slice(3).filter((_, i) => i % 2 === 0).filter(v => typeof v === 'number');
        if (stops.length) return { property: prop(expr[2]), kind: 'continuous', range: [Math.min(...stops), Math.max(...stops)] };
    }
    if (expr[0] === 'step' && prop(expr[1])) {
        const stops = expr.slice(3).filter((_, i) => i % 2 === 0).filter(v => typeof v === 'number');
        if (stops.length) return { property: prop(expr[1]), kind: 'continuous', range: [Math.min(...stops), Math.max(...stops)] };
    }
    return null;
}

/**
 * What a style's paint colours by, in a few words for a prompt:
 * "colours by `zone`, values: "A", "B"", "colour ramp on `pop` from 0 to 10",
 * or "single colour". Both apps list published styles with it.
 */
export function describeStyleColours(paint, maxValues = 15) {
    const c = describeColor(paint);
    if (c?.kind === 'categorical') {
        return `colours by \`${c.property}\`, values: ${c.values.slice(0, maxValues).map(v => JSON.stringify(v)).join(', ')}${c.values.length > maxValues ? ', …' : ''}`;
    }
    if (c?.kind === 'continuous') return `colour ramp on \`${c.property}\` from ${c.range[0]} to ${c.range[1]}`;
    return 'single colour';
}

/**
 * Pick the geometry type and attribute fields for one source layer from a
 * PMTiles metadata object (tippecanoe / GDAL layout: `vector_layers` and
 * `tilestats`).
 *
 * @returns {{geometryType: string|null, fields: Object<string,string>, layerName: string|null}}
 */
export function pmtilesLayerInfo(metadata, layerName = null) {
    const vls = Array.isArray(metadata?.vector_layers) ? metadata.vector_layers : [];
    const vl = (layerName && vls.find(l => l.id === layerName)) || vls[0] || null;
    const name = layerName || vl?.id || null;
    const ts = (metadata?.tilestats?.layers || []).find(l => l.layer === name);
    return {
        layerName: name,
        geometryType: normalizeGeometryType(ts?.geometry || vl?.geometry_type || vl?.geometry),
        fields: vl?.fields && typeof vl.fields === 'object' ? { ...vl.fields } : {},
    };
}

/**
 * The collection's link to its agent guide (`rel: agents`, PORTO-CORE-061).
 */
export function agentsLink(collection, collectionUrl) {
    const l = (collection?.links || []).find(x => x.rel === 'agents');
    return l ? resolveHref(l.href, collectionUrl) : null;
}

/** Producer and host names; a mirror's host differs from its producer. */
export function providerSummary(collection) {
    const ps = Array.isArray(collection?.providers) ? collection.providers : [];
    const by = (role) => ps.filter(p => (p.roles || []).includes(role)).map(p => p.name).filter(Boolean);
    return { producers: by('producer'), host: by('host').pop() || null };
}

/** The Portolan spec version a document declares, e.g. "0.2.0". */
export function portolanVersion(doc) {
    for (const ext of doc?.stac_extensions || []) {
        const m = /portolan-sdi\.org\/portolan\/v([\d.]+)\//.exec(ext);
        if (m) return m[1];
    }
    return null;
}
