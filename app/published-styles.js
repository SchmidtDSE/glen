/**
 * published-styles.js — Read a collection's published MapLibre styles.
 *
 * Pure functions with no fetching and no DOM. A collection publishes styles as
 * assets with the `style` role, one also carrying `default`; each is a
 * complete MapLibre style. These find them, match them to their PMTiles file,
 * turn one into the single layer glen draws, and describe its colours for a
 * prompt.
 *
 * Both apps use them: the full app through dataset-catalog.js and
 * map-tools.js, glen core through core/portolan.js, which re-exports them. They
 * live in app/ because core/ imports app/ and never the other way round.
 */

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
