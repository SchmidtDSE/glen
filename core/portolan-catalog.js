/**
 * portolan-catalog.js — Load Portolan collections into map layer configs.
 *
 * Config (layers-input.json):
 *
 *   "catalog": "https://…/catalog.json",        // optional root
 *   "collections": [
 *     "https://…/parishes/collection.json",      // a collection by URL
 *     "road-blockages",                          // or by id, found under `catalog`
 *     { "url": "https://…/children-0-19/collection.json",
 *       "display_name": "Children 0–19", "visible": true,
 *       "style": "graduated",                    // a named Portolan style
 *       "colormap": "viridis", "rescale": "0,20",// rasters
 *       "tooltip": ["adm1_name", "share_damaged"],
 *       "group": "Population" }
 *   ]
 *
 * With `catalog` and no `collections`, every collection under the root is
 * loaded, up to `max_collections` (default 25).
 *
 * Each renderable thing in a collection becomes one layer: a PMTiles archive
 * (vector) or a COG (raster). A collection with one becomes a layer whose id is
 * the collection id; a collection with several gets `<collection>/<key>` ids.
 */

import {
    resolveHref, findVectorSources, findStyleAssets, findRasterAssets,
    defaultRescale, styleToLayer, describeColor, pmtilesLayerInfo,
    agentsLink, providerSummary, portolanVersion,
} from './portolan.js';
import { findCollections } from '../app/catalog-tree.js';

const DEFAULT_TITILER = 'https://titiler.nrp-nautilus.io';
const DEFAULT_FILL = { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 };
const DEFAULT_LINE = { 'line-color': '#1565C0', 'line-width': 1.5 };
const DEFAULT_CIRCLE = { 'circle-color': '#C62828', 'circle-radius': 4, 'circle-opacity': 0.8 };
const TOOLTIP_FIELDS = 4;

/**
 * TiTiler tile URL for a single-band COG. Kept here rather than imported from
 * app/dataset-catalog.js so the core does not load the full STAC catalog
 * module; the query parameters match glen's cogTileUrl.
 */
export function titilerTileUrl(titilerUrl, cogUrl, { colormap, rescale, nodata, classes } = {}) {
    let url = `${titilerUrl}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(cogUrl)}`;
    if (classes?.length) {
        const cmap = {};
        for (const c of classes) {
            const h = String(c.color_hint || c['color-hint'] || '').replace(/^#/, '');
            if (/^[0-9a-fA-F]{6}$/.test(h) && c.value != null) {
                cmap[String(c.value)] = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
            }
        }
        url += `&colormap=${encodeURIComponent(JSON.stringify(cmap))}`;
    } else {
        url += `&colormap_name=${encodeURIComponent(colormap || 'viridis')}`;
        if (rescale) url += `&rescale=${encodeURIComponent(rescale)}`;
    }
    if (nodata != null) url += `&nodata=${encodeURIComponent(nodata)}`;
    return url;
}

/** Read a PMTiles archive's metadata through the page's pmtiles global. */
async function browserPmtilesMetadata(url) {
    if (typeof pmtiles === 'undefined') return null;
    // eslint-disable-next-line no-undef
    const p = new pmtiles.PMTiles(url);
    return p.getMetadata();
}

export class PortolanCatalog {
    /**
     * @param {Object} [deps] - injectable for tests
     * @param {(url: string) => Promise<Object>} [deps.fetchJson]
     * @param {(url: string) => Promise<Object|null>} [deps.pmtilesMetadata]
     */
    constructor(deps = {}) {
        this.fetchJson = deps.fetchJson || defaultFetchJson;
        this.pmtilesMetadata = deps.pmtilesMetadata || browserPmtilesMetadata;
        /** @type {Map<string, Object>} collection id → dataset record */
        this.datasets = new Map();
        /** @type {Map<string, Object>} layer id → layer record */
        this.layers = new Map();
        this.titilerUrl = DEFAULT_TITILER;
    }

    async load(appConfig = {}) {
        this.appConfig = appConfig;
        this.titilerUrl = (appConfig.titiler_url || DEFAULT_TITILER).replace(/\/$/, '');
        const specs = (appConfig.collections || []).map(c => (typeof c === 'string' ? { ref: c } : { ...c, ref: c.url || c.collection_url || c.id || c.collection_id }));

        // Ids (not URLs) are resolved by walking the root catalog once.
        const needWalk = !specs.length || specs.some(s => !isUrl(s.ref));
        let found = new Map();
        if (needWalk && appConfig.catalog) {
            found = await this._walk(appConfig.catalog, appConfig.max_collections ?? 25, !specs.length ? null : new Set(specs.filter(s => !isUrl(s.ref)).map(s => s.ref)));
        }
        const targets = specs.length
            ? specs.map(s => ({ spec: s, url: isUrl(s.ref) ? s.ref : found.get(s.ref) }))
            : [...found.values()].map(url => ({ spec: {}, url }));

        const results = await Promise.allSettled(targets.map(async ({ spec, url }) => {
            if (!url) {
                console.warn(`[Portolan] Collection "${spec.ref}" not found under ${appConfig.catalog || '(no catalog configured)'}`);
                return null;
            }
            const collection = await this.fetchJson(url);
            return this.addCollection(collection, url, spec);
        }));
        for (const r of results) {
            if (r.status === 'rejected') console.warn('[Portolan] Failed to load a collection:', r.reason?.message || r.reason);
        }
        // Keep config order, which is also map draw order.
        const order = targets.map(t => t.url);
        this.datasets = new Map([...this.datasets.entries()].sort((a, b) => order.indexOf(a[1].url) - order.indexOf(b[1].url)));
        console.log(`[Portolan] ${this.datasets.size} collections, ${this.layers.size} layers`);
    }

    /**
     * Walk a catalog (and its sub-catalogs) for collection URLs.
     * @param {Set<string>|null} wanted - ids to find, or null for all
     * @returns {Promise<Map<string, string>>} id → collection URL
     */
    async _walk(rootUrl, limit, wanted) {
        // Ids are found at any depth, through Catalogs and Collections alike,
        // so they resolve under our bucket-level Collections as well as the
        // Portolan layout (#441).
        if (wanted) {
            try {
                const found = await findCollections(rootUrl, wanted, {
                    fetchJson: this.fetchJson,
                    onError: (u, e) => console.warn(`[Portolan] Could not read ${u}: ${e.message}`),
                });
                return new Map([...found].map(([id, hit]) => [id, hit.url]));
            } catch (e) {
                console.warn(`[Portolan] Could not read ${rootUrl}: ${e.message}`);
                return new Map();
            }
        }
        const out = new Map();
        const queue = [rootUrl];
        const seen = new Set();
        while (queue.length && out.size < limit) {
            const url = queue.shift();
            if (seen.has(url)) continue;
            seen.add(url);
            let doc;
            try { doc = await this.fetchJson(url); } catch (e) {
                console.warn(`[Portolan] Could not read ${url}: ${e.message}`);
                continue;
            }
            if (doc.type === 'Collection') {
                out.set(doc.id, url);
                continue;
            }
            for (const l of doc.links || []) {
                if (l.rel === 'child') queue.push(resolveHref(l.href, url));
            }
        }
        return out;
    }

    /**
     * Register one collection and its layers.
     * @param {Object} collection - STAC collection JSON
     * @param {string} url - where it was fetched from (hrefs resolve against it)
     * @param {Object} [spec] - the collection's entry in config
     */
    async addCollection(collection, url, spec = {}) {
        const id = spec.id || collection.id;
        const vectors = findVectorSources(collection, url);
        const rasters = findRasterAssets(collection, url);
        const styles = findStyleAssets(collection, url);
        const many = vectors.length + rasters.length > 1;
        const providers = providerSummary(collection);

        const dataset = {
            id,
            url,
            title: spec.display_name || collection.title || id,
            description: collection.description || '',
            license: collection.license || null,
            portolanVersion: portolanVersion(collection),
            producers: providers.producers,
            host: providers.host,
            agentsUrl: agentsLink(collection, url),
            bbox: collection.extent?.spatial?.bbox?.[0] || null,
            columns: Array.isArray(collection['table:columns']) ? collection['table:columns'] : [],
            layerIds: [],
            stac: collection,
            // glen's data page and citations read the raw record under this name.
            _rawStac: collection,
        };

        // Styles are small JSON documents; read all of them so the agent can
        // switch between them without a round trip.
        const styleDocs = await Promise.all(styles.map(async s => {
            try { return { ...s, doc: await this.fetchJson(s.url) }; } catch (e) {
                console.warn(`[Portolan] Style ${s.url} unreadable: ${e.message}`);
                return null;
            }
        }));
        const usableStyles = styleDocs.filter(Boolean);

        for (const v of vectors) {
            const layerId = many ? `${id}/${v.key}` : id;
            let meta = null;
            try { meta = await this.pmtilesMetadata(v.url); } catch (e) {
                console.warn(`[Portolan] PMTiles metadata for ${v.url} unreadable: ${e.message}`);
            }
            // The style names the source layer too; prefer the catalog's
            // pmtiles:layers, then the style, then the archive itself.
            const defaultStyleDoc = usableStyles.find(s => s.isDefault)?.doc;
            const styleSourceLayer = defaultStyleDoc?.layers?.find(l => l['source-layer'])?.['source-layer'];
            const info = pmtilesLayerInfo(meta, v.layers[0] || styleSourceLayer || null);
            const sourceLayer = v.layers[0] || styleSourceLayer || info.layerName || v.key;

            // Every style converted for this geometry, keyed by name.
            const namedStyles = new Map();
            for (const s of usableStyles) {
                const converted = styleToLayer(s.doc, info.geometryType);
                if (converted) namedStyles.set(s.name, { ...converted, title: s.title || s.doc?.name || s.name, isDefault: s.isDefault });
            }
            const chosenName = spec.style && namedStyles.has(spec.style) ? spec.style : [...namedStyles.keys()][0];
            const chosen = chosenName ? namedStyles.get(chosenName) : null;
            const renderType = chosen?.renderType || ({ Polygon: 'fill', LineString: 'line', Point: 'circle' }[info.geometryType] || 'fill');
            const paint = spec.paint || chosen?.paint || { fill: DEFAULT_FILL, line: DEFAULT_LINE, circle: DEFAULT_CIRCLE }[renderType];

            this.layers.set(layerId, {
                layerId,
                datasetId: id,
                kind: 'vector',
                title: many ? (v.title || `${dataset.title} (${v.key})`) : dataset.title,
                group: spec.group || null,
                visible: spec.visible === true,
                url: v.url,
                sourceLayer,
                geometryType: info.geometryType,
                fields: info.fields,
                renderType,
                paint,
                outlinePaint: chosen?.outlinePaint || null,
                filter: spec.default_filter || chosen?.filter || null,
                tooltip: spec.tooltip || defaultTooltip(info.fields, paint),
                styles: namedStyles,
                defaultStyle: chosenName || null,
            });
            dataset.layerIds.push(layerId);
        }

        for (const r of rasters) {
            const layerId = many ? `${id}/${r.key}` : id;
            const colormap = spec.colormap || 'viridis';
            const rescale = spec.rescale || defaultRescale(r.band);
            this.layers.set(layerId, {
                layerId,
                datasetId: id,
                kind: 'raster',
                title: many ? (r.title || `${dataset.title} (${r.key})`) : dataset.title,
                group: spec.group || null,
                visible: spec.visible === true,
                url: r.url,
                band: r.band,
                colormap,
                rescale,
                defaultColormap: colormap,
                defaultRescale: rescale,
                opacity: spec.opacity ?? 0.8,
            });
            dataset.layerIds.push(layerId);
        }

        if (!dataset.layerIds.length) {
            console.warn(`[Portolan] ${id}: nothing to draw (no PMTiles link or visual asset, no COG data asset)`);
        }
        this.datasets.set(id, dataset);
        return dataset;
    }

    /** The tile URL for a raster layer at its current colormap and range. */
    rasterTileUrl(layer, overrides = {}) {
        return titilerTileUrl(this.titilerUrl, layer.url, {
            colormap: overrides.colormap ?? layer.colormap,
            rescale: overrides.rescale ?? layer.rescale,
            nodata: layer.band?.nodata,
            classes: layer.band?.classes,
        });
    }

    /** Configs in the shape MapManager.registerLayer takes, in config order. */
    getMapLayerConfigs() {
        const configs = [];
        for (const ds of this.datasets.values()) {
            for (const layerId of ds.layerIds) {
                const l = this.layers.get(layerId);
                const base = {
                    layerId,
                    datasetId: ds.id,
                    group: l.group,
                    displayName: l.title,
                    defaultVisible: l.visible,
                    sidebar: true,
                };
                if (l.kind === 'vector') {
                    configs.push({
                        ...base,
                        type: 'vector',
                        source: {
                            type: 'vector',
                            url: `pmtiles://${l.url}`,
                        },
                        sourceLayer: l.sourceLayer,
                        renderType: l.renderType === 'fill' ? null : l.renderType,
                        paint: l.paint,
                        outlinePaint: l.outlinePaint,
                        defaultFilter: l.filter,
                        columns: Object.entries(l.fields).map(([name, type]) => ({ name, type })),
                        tooltipFields: l.tooltip,
                    });
                } else {
                    configs.push({
                        ...base,
                        type: 'raster',
                        source: { type: 'raster', tiles: [this.rasterTileUrl(l)], tileSize: 256 },
                        paint: { 'raster-opacity': l.opacity },
                        colormap: l.colormap,
                        rescale: l.rescale,
                        legendLabel: l.band?.unit || null,
                        legendType: l.band?.classes ? 'categorical' : null,
                        legendClasses: l.band?.classes
                            ? l.band.classes.map(c => ({ value: c.value, name: c.description || c.name || String(c.value), 'color-hint': c.color_hint || c['color-hint'] }))
                            : null,
                    });
                }
            }
        }
        return configs;
    }

    getAll() {
        return [...this.datasets.values()];
    }

    /**
     * The catalog section of the system prompt. Static for a deployment, so
     * it can sit in the cached prompt prefix (docs/design/prompt-prefix-stability.md).
     */
    generatePrompt() {
        const lines = ['## Layers', ''];
        for (const ds of this.datasets.values()) {
            const src = [ds.producers.join(', '), ds.host && !ds.producers.includes(ds.host) ? `mirrored by ${ds.host}` : null].filter(Boolean).join('; ');
            lines.push(`### ${ds.title}`);
            lines.push(oneLine(ds.description, 300));
            lines.push(`License: ${ds.license || 'not stated'}${src ? `. Source: ${src}` : ''}.`);
            const colDesc = new Map(ds.columns.map(c => [c.name, c.description]));
            for (const layerId of ds.layerIds) {
                const l = this.layers.get(layerId);
                lines.push('');
                if (l.kind === 'vector') {
                    lines.push(`- layer_id \`${layerId}\` — vector, ${(l.geometryType || 'unknown geometry').toLowerCase()}, drawn as ${l.renderType}${l.visible ? ', on at start' : ''}`);
                    const fields = Object.entries(l.fields);
                    if (fields.length) {
                        lines.push('  Feature properties (exact names for filters, styles and tooltips):');
                        for (const [name, type] of fields.slice(0, 30)) {
                            const d = colDesc.get(name);
                            lines.push(`  - \`${name}\` (${String(type).toLowerCase()})${d ? `: ${oneLine(d, 120)}` : ''}`);
                        }
                        if (fields.length > 30) lines.push(`  - …and ${fields.length - 30} more (call describe_layer)`);
                    }
                    if (l.styles.size) {
                        lines.push('  Published styles (apply with apply_style):');
                        for (const [name, s] of l.styles) {
                            const c = describeColor(s.paint);
                            let what = 'single colour';
                            if (c?.kind === 'categorical') what = `colours by \`${c.property}\`, values: ${c.values.slice(0, 15).map(v => JSON.stringify(v)).join(', ')}${c.values.length > 15 ? ', …' : ''}`;
                            else if (c?.kind === 'continuous') what = `colour ramp on \`${c.property}\` from ${c.range[0]} to ${c.range[1]}`;
                            lines.push(`  - \`${name}\`${name === l.defaultStyle ? ' (current at start)' : ''}: ${what}`);
                        }
                    }
                } else {
                    const b = l.band || {};
                    const stats = b.min != null ? `values ${fmt(b.min)} to ${fmt(b.max)}, mean ${fmt(b.mean)}${b.unit ? ` ${b.unit}` : ''}` : 'no statistics published';
                    lines.push(`- layer_id \`${layerId}\` — raster (COG), ${stats}; drawn with colormap \`${l.colormap}\` over ${l.rescale || 'the full range'}${l.visible ? ', on at start' : ''}`);
                    if (b.classes) lines.push(`  Classes: ${b.classes.slice(0, 20).map(c => `${c.value}=${c.description || c.name}`).join(', ')}`);
                }
            }
            lines.push('');
        }
        return lines.join('\n');
    }
}

/**
 * Hover fields when config names none: a name-like field to say which
 * feature this is, then the property the style colours by, then other text
 * fields, up to four.
 */
export function defaultTooltip(fields, paint) {
    const names = Object.keys(fields || {});
    const isText = (n) => /string/i.test(String(fields[n]));
    const out = [];
    const push = (n) => { if (n && !out.includes(n) && out.length < TOOLTIP_FIELDS) out.push(n); };
    // The finest admin level wins: adm1_name says more than adm0_name.
    const level = (n) => Number(/adm(\d)/i.exec(n)?.[1] ?? -1);
    push(names.filter(n => isText(n) && /(^|_)(name|title|label)(_|$)|name$/i.test(n))
        .sort((a, b) => level(b) - level(a))[0]);
    push(describeColor(paint)?.property);
    for (const n of names.filter(isText)) push(n);
    for (const n of names) push(n);
    return out;
}

function isUrl(s) {
    return typeof s === 'string' && /^https?:\/\//.test(s);
}

function oneLine(text, cap) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

function fmt(v) {
    if (v == null) return '?';
    return Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : Number(v.toFixed(2)).toString();
}

async function defaultFetchJson(url) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
            return await res.json();
        } catch (e) {
            lastErr = e;
            await new Promise(r => setTimeout(r, 500 * (i + 1)));
        }
    }
    throw lastErr;
}
