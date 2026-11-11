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

import { resolveRasterBand, publishedRender } from '../app/cog-tiles.js';
import { resolveHref, normalizeGeometryType } from '../app/published-styles.js';

export {
    resolveHref,
    findStyleAssets,
    styleSourceFile,
    stylesForFile,
    styleName,
    normalizeGeometryType,
    FAINT_OUTLINE,
    stripGeometryTypeFilter,
    styleToLayer,
    guardMissingValues,
    describeColor,
    describeStyleColours,
} from '../app/published-styles.js';

export const PMTILES_TYPE = 'application/vnd.pmtiles';

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
 * @returns {Array<{key: string, aliases: string[], url: string, layers: string[], title: string|null, columns: Object[]}>}
 *   `columns` is the asset's own `table:columns`, when it has them; `aliases`
 *   are other keys the same archive is listed under
 */
export function findVectorSources(collection, collectionUrl) {
    const out = [];
    const byUrl = new Map();
    const add = (key, href, layers, title, columns) => {
        const url = resolveHref(href, collectionUrl);
        if (!url) return;
        const existing = byUrl.get(url);
        if (existing) {
            // The same archive listed twice (link and asset) answers to both keys.
            if (key !== existing.key && !existing.aliases.includes(key)) existing.aliases.push(key);
            if (!existing.layers.length && layers?.length) existing.layers = [...layers];
            if (!existing.title && title) existing.title = title;
            if (!existing.columns.length && columns?.length) existing.columns = columns;
            return;
        }
        const entry = { key, aliases: [], url, layers: layers ? [...layers] : [], title: title || null, columns: columns || [] };
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
 * The COG assets of a collection that hold the data itself.
 *
 * @returns {Array<{key, url, title, band, render, asset}>} band 1 from
 *   {@link rasterBand}; `asset` lets a config pick another band
 */
export function findRasterAssets(collection, collectionUrl) {
    return Object.entries(collection?.assets || {})
        .filter(([, a]) => isCogAsset(a) && (roles(a).includes('data') || roles(a).includes('visual')))
        .map(([key, a]) => {
            const render = publishedRender(collection, key);
            return {
                key,
                url: resolveHref(a.href, collectionUrl),
                title: a.title || null,
                band: rasterBand(a, render),
                // The catalog's published look, as in the full app (#440).
                render,
                asset: a,
            };
        });
}

/**
 * One band of a COG asset (band 1 unless `bidx` names another): nodata,
 * statistics, categorical classes, and whether TiTiler should apply the
 * band's scale and offset.
 * Reads STAC 1.1 `bands` first, then the raster extension's `raster:bands`.
 * nodata, the classes and `unscale` follow the full app's rules
 * (app/cog-tiles.js), so a class whose value is the nodata value is dropped,
 * and a published render's nodata and class colours win over the band's.
 */
export function rasterBand(asset, render = null, bidx = null) {
    const i = Number.isInteger(Number(bidx)) && Number(bidx) >= 1 ? Number(bidx) : null;
    const band = asset?.bands?.[(i ?? 1) - 1] || asset?.['raster:bands']?.[(i ?? 1) - 1] || {};
    const stats = band.statistics || {};
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const shared = resolveRasterBand(asset, i ? { bidx: i } : {}, render);
    const nodata = shared.nodata ?? asset?.nodata ?? null;
    let classes = shared.legendClasses || asset?.['classification:classes'] || null;
    if (Array.isArray(classes) && nodata != null) classes = classes.filter(c => c.value == null || String(c.value) !== String(nodata));
    return {
        bidx: shared.bidx,
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
 * The drawable assets a collection entry asks for, in the entry's order, each
 * with its own config entry. Without an `assets` list every drawable asset is
 * drawn, vectors first, with no per-asset config, as before.
 *
 * @param {Array<string|Object>|undefined} entries - `assets` from config: asset
 *   keys, or objects with an `id` and that asset's settings
 * @param {Array} vectors - from {@link findVectorSources}
 * @param {Array} rasters - from {@link findRasterAssets}
 * @returns {{picks: Array<{kind: 'vector'|'raster', src: Object, entry: Object}>, missing: string[]}}
 */
export function selectAssets(entries, vectors, rasters) {
    if (!Array.isArray(entries)) {
        return {
            picks: [
                ...vectors.map(src => ({ kind: 'vector', src, entry: {} })),
                ...rasters.map(src => ({ kind: 'raster', src, entry: {} })),
            ],
            missing: [],
        };
    }
    const picks = [];
    const missing = [];
    for (const raw of entries) {
        const entry = typeof raw === 'string' ? { id: raw } : { ...(raw || {}) };
        const v = vectors.find(x => x.key === entry.id || x.aliases?.includes(entry.id));
        const r = !v && rasters.find(x => x.key === entry.id);
        if (v) picks.push({ kind: 'vector', src: v, entry });
        else if (r) picks.push({ kind: 'raster', src: r, entry });
        else missing.push(String(entry.id));
    }
    return { picks, missing };
}

/**
 * Where a collection's item lives. The collection's `item` links are matched
 * on the file name (`…/tmax-2025-06-15.json`) or a folder named for the item
 * (`…/tmax-2025-06-15/item.json`); with no matching link the item is looked for
 * in a folder of its own beside the collection, where Portolan puts it.
 *
 * @returns {string} the item's URL
 */
export function itemHref(collection, collectionUrl, itemId) {
    const id = String(itemId);
    for (const l of collection?.links || []) {
        if (l.rel !== 'item' || typeof l.href !== 'string') continue;
        const parts = l.href.split(/[?#]/)[0].split('/');
        const file = parts[parts.length - 1].replace(/\.json$/i, '');
        if (file === id || parts.slice(0, -1).includes(id)) return resolveHref(l.href, collectionUrl);
    }
    return resolveHref(`./${encodeURIComponent(id)}/${encodeURIComponent(id)}.json`, collectionUrl);
}

/** An item's date for the prompt and titles: its `datetime`, else its start. */
export function itemDate(item) {
    const p = item?.properties || {};
    const d = p.datetime || p.start_datetime || null;
    return typeof d === 'string' ? d.slice(0, 10) : null;
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
