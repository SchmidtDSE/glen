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
    defaultRescale, styleToLayer, describeColor, describeStyleColours, pmtilesLayerInfo, stylesForFile,
    agentsLink, providerSummary, portolanVersion, collectionColumns,
    rasterBand, selectAssets, layerSettings, itemHref, itemDate, itemMirrorUrl, framesFromItems, withAbsoluteHrefs,
} from './portolan.js';
import { findCollections } from '../app/catalog-tree.js';
import { cogTileUrl, normalizeLegendClasses } from '../app/cog-tiles.js';
import { legendFromPaint } from '../app/legend-helpers.js';

const DEFAULT_TITILER = 'https://titiler.nrp-nautilus.io';
const DEFAULT_FILL = { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 };
const DEFAULT_LINE = { 'line-color': '#1565C0', 'line-width': 1.5 };
const DEFAULT_CIRCLE = { 'circle-color': '#C62828', 'circle-radius': 4, 'circle-opacity': 0.8 };
const TOOLTIP_FIELDS = 4;
// Without an items.parquet mirror a series reads one JSON file per item; past
// this many it reads only the most recent, and says so.
const MAX_SERIES_ITEMS = 400;
const ITEM_FETCHES_AT_ONCE = 8;

/**
 * TiTiler tile URL for a single-band COG, built by the full app's
 * `cogTileUrl` (app/cog-tiles.js) so both apps draw a raster the same way.
 */
export function titilerTileUrl(titilerUrl, cogUrl, { colormap, rescale, nodata, classes, unscale, bidx } = {}) {
    return cogTileUrl(titilerUrl, cogUrl, {
        legendType: classes?.length ? 'categorical' : null,
        legendClasses: classes || null,
        colormap: colormap || 'viridis',
        rescale,
        nodata,
        unscale,
        bidx: bidx ?? null,
    });
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
        this.readItemMirror = deps.readItemMirror || defaultReadItemMirror;
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
        // Keep config order, which is also map draw order. Entries, not URLs:
        // one collection can be listed twice (a series and some single days).
        const ordered = results.map(r => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
        this.datasets = new Map(ordered.map(d => [d.id, d]));
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
            columns: collectionColumns(collection),
            // The full app's `"group": { "name", "collapsed" }` starts the group folded.
            groupCollapsed: !!(spec.group && typeof spec.group === 'object' && spec.group.collapsed),
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

        const { picks, missing } = selectAssets(spec.assets, vectors, rasters);
        if (missing.length) console.warn(`[Portolan] ${id}: no drawable asset ${missing.map(m => `"${m}"`).join(', ')}`);
        for (const pick of picks) {
            const { kind, src, entry } = pick;
            const settings = layerSettings(spec, entry);
            delete settings.items;
            delete settings.assets;
            if (kind === 'versioned') {
                // A logical layer named by its entry, as in the full app.
                await this._addVersioned(dataset, `${id}/${entry.id}`, entry.display_name || dataset.title, pick, settings, usableStyles);
                continue;
            }
            // The full app's `alias` draws one asset as several layers (other
            // filters or styles of one file), each named by its alias.
            const alias = typeof entry.alias === 'string' && entry.alias.trim() ? entry.alias.trim() : null;
            // A config naming another key of the same file (two STAC assets
            // with one href, drawn twice) gets a layer of its own under that key.
            const key = entry.id != null && String(entry.id) !== src.key ? String(entry.id) : src.key;
            const layerId = alias ? `${id}/${alias}` : (many || key !== src.key ? `${id}/${key}` : id);
            const title = entry.display_name || (many || alias ? (src.title || `${dataset.title} (${key})`) : dataset.title);
            if (kind === 'vector') await this._addVector(dataset, layerId, title, src, settings, usableStyles);
            else this._addRaster(dataset, layerId, title, src, settings);
        }

        if (Array.isArray(spec.items)) await this._addItems(dataset, collection, url, spec, usableStyles);

        if (spec.control?.bind === 'frame' && spec.control.frames === 'items') {
            const seriesId = vectors.length + rasters.length > 0 || Array.isArray(spec.items) ? `${id}/series` : id;
            await this._addSeries(dataset, collection, url, spec, seriesId);
        }

        if (!dataset.layerIds.length) {
            const hasItems = (collection.links || []).some(l => l.rel === 'item');
            console.warn(`[Portolan] ${id}: nothing to draw (no PMTiles link or visual asset, no COG data asset)${hasItems && !spec.items ? '; its data is in items, so list the ones to draw under "items"' : ''}`);
        }
        this.datasets.set(id, dataset);
        return dataset;
    }

    /**
     * Register one PMTiles layer.
     * @param {Object} dataset - the collection's record
     * @param {Object} v - from findVectorSources
     * @param {Object} s - the collection's config with this asset's entry over it
     * @param {Array} usableStyles - the collection's styles, with their documents
     */
    async _addVector(dataset, layerId, title, v, s, usableStyles) {
        if (this._taken(layerId)) return;
        let meta = null;
        if (!v.geojson) {
            try { meta = await this.pmtilesMetadata(v.url); } catch (e) {
                console.warn(`[Portolan] PMTiles metadata for ${v.url} unreadable: ${e.message}`);
            }
        }
        // The style names the source layer too; prefer the catalog's
        // pmtiles:layers, then the style, then the archive itself. A GeoJSON
        // file takes no published style, as in the full app.
        const ownStyles = v.geojson ? [] : stylesForFile(usableStyles, v.url);
        const defaultStyleDoc = ownStyles.find(st => st.isDefault)?.doc;
        const styleSourceLayer = defaultStyleDoc?.layers?.find(l => l['source-layer'])?.['source-layer'];
        const info = pmtilesLayerInfo(meta, v.layers[0] || styleSourceLayer || null);
        // Without the archive's own field list, the asset's table:columns
        // name the feature properties (our current STAC carries them).
        if (!Object.keys(info.fields).length && v.columns.length) {
            info.fields = Object.fromEntries(v.columns
                .filter(c => !/^(geometry|geom|bbox)$/i.test(c.name))
                .map(c => [c.name, c.type || 'unknown']));
        }
        const sourceLayer = v.layers[0] || styleSourceLayer || info.layerName || v.key;

        // Every style converted for this geometry, keyed by name. A render
        // type set in config (the full app's `layer_type`) picks the geometry.
        const forced = ['fill', 'line', 'circle'].includes(s.render_type) ? s.render_type : null;
        const geometry = { fill: 'Polygon', line: 'LineString', circle: 'Point' }[forced] || info.geometryType;
        const namedStyles = new Map();
        for (const st of ownStyles) {
            const converted = styleToLayer(st.doc, geometry);
            if (converted) namedStyles.set(st.name, { ...converted, title: st.title || st.doc?.name || st.name, isDefault: st.isDefault });
        }
        const chosenName = s.style && namedStyles.has(s.style) ? s.style : [...namedStyles.keys()][0];
        const chosen = chosenName ? namedStyles.get(chosenName) : null;
        const renderType = forced || chosen?.renderType || ({ Polygon: 'fill', LineString: 'line', Point: 'circle' }[info.geometryType] || 'fill');
        const paint = s.paint || chosen?.paint || { fill: DEFAULT_FILL, line: DEFAULT_LINE, circle: DEFAULT_CIRCLE }[renderType];

        this.layers.set(layerId, {
            layerId,
            datasetId: dataset.id,
            kind: 'vector',
            title,
            visible: s.visible === true,
            url: v.url,
            sourceLayer,
            // Layers drawn from one file share its source, as the full app's aliases do.
            sourceId: `src-${dataset.id.replace(/[^a-zA-Z0-9]/g, '-')}-${v.key.replace(/[^a-zA-Z0-9]/g, '-')}`,
            geometryType: info.geometryType,
            fields: info.fields,
            renderType,
            paint,
            outlinePaint: s.outline_paint || chosen?.outlinePaint || null,
            filter: s.default_filter || chosen?.filter || null,
            ...panelFields(dataset, s),
            ...vectorLegend(s, s.paint ? null : chosen?.paint),
            geojson: !!v.geojson,
            control: s.control && s.control.bind !== 'frame' ? s.control : null,
            animation: animationFor(s.animation, dataset),
            tooltip: s.tooltip || defaultTooltip(info.fields, paint),
            styles: namedStyles,
            defaultStyle: chosenName || null,
        });
        dataset.layerIds.push(layerId);
        return layerId;
    }

    /**
     * Register one COG layer. A `bidx` in config draws that band, and the
     * layer id gains `/band-<n>` so one COG can be listed once per band. The
     * catalog's render describes band 1, so it is set aside for another band.
     * @param {Object} r - from findRasterAssets
     * @param {Object} s - the collection's config with this asset's entry over it
     */
    _addRaster(dataset, layerId, title, r, s) {
        if (s.bidx != null) layerId = `${layerId}/band-${Number(s.bidx)}`;
        if (this._taken(layerId)) return;
        const otherBand = s.bidx != null && Number(s.bidx) !== 1;
        const render = otherBand ? null : r.render;
        const band = bandFor(r, render, s);
        const colormap = s.colormap || render?.colormap || 'viridis';
        const rescale = s.rescale || render?.rescale || defaultRescale(band);
        this.layers.set(layerId, {
            layerId,
            datasetId: dataset.id,
            kind: 'raster',
            title,
            visible: s.visible === true,
            url: r.url,
            band,
            colormap,
            rescale,
            defaultColormap: colormap,
            defaultRescale: rescale,
            // The full app's default, and its `paint: { "raster-opacity" }` on a raster asset.
            opacity: s.opacity ?? s.paint?.['raster-opacity'] ?? 0.7,
            ...panelFields(dataset, s),
            legendLabel: s.legend_label || null,
            legendType: s.legend_type || null,
        });
        dataset.layerIds.push(layerId);
        return layerId;
    }

    /**
     * Register a collection's items as one raster time series (#462): a
     * collection entry with `control: { bind: "frame", frames: "items" }`.
     * The dates come from the collection's items.parquet mirror when it has
     * one, else from its item links. The layer starts on the latest date and
     * the full app's frame player steps through the rest.
     */
    async _addSeries(dataset, collection, url, spec, layerId) {
        const items = await this._readSeriesItems(collection, url, dataset.id);
        const control = { ...spec.control };
        const frames = framesFromItems(items, control.asset || null);
        if (!frames.length) {
            console.warn(`[Portolan] ${dataset.id}: no dated COG among ${items.length} items, so no time series`);
            return;
        }
        const latest = frames[frames.length - 1];
        const [r] = findRasterAssets({ assets: { [latest.key]: latest.asset }, renders: collection.renders || {} }, latest.href);
        const base = r || { key: latest.key, url: latest.href, title: null, band: rasterBand(latest.asset), render: null, asset: latest.asset };
        base.url = latest.href;
        const settings = layerSettings(spec);
        delete settings.items;
        delete settings.assets;
        const title = spec.display_name || dataset.title;
        const added = this._addRaster(dataset, layerId, title, base, settings);
        const rec = added && this.layers.get(added);
        if (!rec) return;
        rec.series = {
            control,
            frames: frames.map(f => ({ datetime: f.datetime, href: f.href })),
            first: frames[0].datetime,
            last: latest.datetime,
        };
    }

    /**
     * A series' items as `{ id, url, item }`, from the item mirror or the
     * item links. Mirror rows are stac-geoparquet: the properties sit at top
     * level and the asset hrefs are relative to the item's own JSON.
     */
    async _readSeriesItems(collection, url, datasetId) {
        const mirror = itemMirrorUrl(collection, url);
        if (mirror) {
            try {
                const rows = await this.readItemMirror(mirror);
                const items = rows.filter(row => row?.id != null).map(row => ({ id: String(row.id), url: itemHref(collection, url, row.id), item: row }));
                if (items.length) return items;
            } catch (e) {
                console.warn(`[Portolan] ${datasetId}: item mirror ${mirror} unreadable (${e.message}); reading the items one by one`);
            }
        }
        let links = (collection.links || []).filter(l => l.rel === 'item' && typeof l.href === 'string');
        if (links.length > MAX_SERIES_ITEMS) {
            console.warn(`[Portolan] ${datasetId}: ${links.length} items and no item mirror, so only the last ${MAX_SERIES_ITEMS} are read`);
            links = links.slice(-MAX_SERIES_ITEMS);
        }
        const out = new Array(links.length);
        let next = 0;
        const worker = async () => {
            while (next < links.length) {
                const i = next++;
                const itemUrl = resolveHref(links[i].href, url);
                try {
                    const item = await this.fetchJson(itemUrl);
                    out[i] = { id: String(item?.id ?? ''), url: itemUrl, item };
                } catch (e) {
                    console.warn(`[Portolan] ${datasetId}: item ${itemUrl} unreadable: ${e.message}`);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(ITEM_FETCHES_AT_ONCE, links.length) }, worker));
        return out.filter(Boolean);
    }

    /**
     * Register a versioned layer (the full app's `versions`): one panel row
     * with a dropdown over several assets of one kind. The starting version
     * (`default_version`, by label) sets the layer's style; each version keeps
     * its own source, and a raster version its own band and render.
     */
    async _addVersioned(dataset, layerId, title, pick, s, usableStyles) {
        const idx = Math.max(0, pick.members.findIndex(m => m.label === s.default_version));
        const start = pick.members[idx];
        const added = pick.vkind === 'vector'
            ? await this._addVector(dataset, layerId, title, start.src, s, usableStyles)
            : this._addRaster(dataset, layerId, title, start.src, s);
        const rec = added && this.layers.get(added);
        if (!rec) return;
        const versions = [];
        for (const m of pick.members) {
            if (pick.vkind === 'vector') {
                if (m.src.geojson) { versions.push({ label: m.label, url: m.src.url, geojson: true }); continue; }
                let meta = null;
                if (!m.src.layers[0]) {
                    try { meta = await this.pmtilesMetadata(m.src.url); } catch { /* the starting version's layer name is used */ }
                }
                const sourceLayer = m.src.layers[0] || pmtilesLayerInfo(meta, null).layerName || rec.sourceLayer;
                versions.push({ label: m.label, url: m.src.url, sourceLayer });
            } else {
                const otherBand = s.bidx != null && Number(s.bidx) !== 1;
                const render = otherBand ? null : m.src.render;
                const band = bandFor(m.src, render, s);
                versions.push({
                    label: m.label, url: m.src.url, band,
                    colormap: s.colormap || render?.colormap || null,
                    rescale: s.rescale || render?.rescale || defaultRescale(band),
                });
            }
        }
        rec.versions = versions;
        rec.defaultVersionIndex = idx;
    }

    /** True, with a warning, when a layer id is already registered. */
    _taken(layerId) {
        if (!this.layers.has(layerId)) return false;
        console.warn(`[Portolan] ${layerId} is listed twice; the second is skipped`);
        return true;
    }

    /**
     * Register the items a collection entry lists under `items`: ids, or
     * objects with an `id` and that item's settings. Each item's JSON is read
     * once; its COGs and PMTiles are drawn as layers `<collection>/<item>`, or
     * `<collection>/<item>/<asset>` when the item has more than one. An item
     * entry may take `assets` to pick among them, as a collection entry does.
     */
    async _addItems(dataset, collection, url, spec, usableStyles) {
        const entries = spec.items.map(e => (typeof e === 'string' ? { id: e } : { ...(e || {}) })).filter(e => e.id != null);
        const fetched = await Promise.all(entries.map(async (entry) => {
            const itemUrl = itemHref(collection, url, entry.id);
            try {
                return { entry, itemUrl, item: await this.fetchJson(itemUrl) };
            } catch (e) {
                console.warn(`[Portolan] ${dataset.id}: item "${entry.id}" unreadable at ${itemUrl}: ${e.message}`);
                return null;
            }
        }));
        const collectionSettings = { ...spec };
        delete collectionSettings.items;
        delete collectionSettings.assets;
        for (const got of fetched) {
            if (!got?.item) continue;
            const { entry, itemUrl, item } = got;
            // Renders may sit on the collection or on the item itself.
            const withRenders = { ...item, renders: { ...(collection.renders || {}), ...(item.renders || {}) } };
            const vectors = findVectorSources(item, itemUrl);
            const rasters = findRasterAssets(withRenders, itemUrl);
            const itemMany = vectors.length + rasters.length > 1;
            const { picks, missing } = selectAssets(entry.assets, vectors, rasters);
            if (missing.length) console.warn(`[Portolan] ${dataset.id}/${entry.id}: no drawable asset ${missing.map(m => `"${m}"`).join(', ')}`);
            if (!picks.length) console.warn(`[Portolan] ${dataset.id}/${entry.id}: nothing to draw in this item`);
            const date = itemDate(item);
            const itemTitle = entry.display_name || item.properties?.title || (date ? `${dataset.title}, ${date}` : `${dataset.title} (${entry.id})`);
            for (const { kind, src, entry: assetEntry } of picks) {
                const layerId = itemMany ? `${dataset.id}/${entry.id}/${src.key}` : `${dataset.id}/${entry.id}`;
                const title = assetEntry.display_name || (itemMany ? `${itemTitle} (${src.title || src.key})` : itemTitle);
                const itemSettings = { ...entry };
                delete itemSettings.assets;
                const settings = layerSettings(collectionSettings, itemSettings, assetEntry);
                const added = kind === 'vector'
                    ? await this._addVector(dataset, layerId, title, src, settings, usableStyles)
                    : this._addRaster(dataset, layerId, title, src, settings);
                const rec = added && this.layers.get(added);
                if (rec) { rec.itemId = String(entry.id); rec.date = date; }
            }
        }
    }

    /** The tile URL for a raster layer at its current colormap and range. */
    rasterTileUrl(layer, overrides = {}) {
        return titilerTileUrl(this.titilerUrl, layer.url, {
            colormap: overrides.colormap ?? layer.colormap,
            rescale: overrides.rescale ?? layer.rescale,
            nodata: layer.band?.nodata,
            classes: layer.band?.classes,
            unscale: layer.band?.unscale,
            bidx: layer.band?.bidx,
        });
    }

    /** Configs in the shape MapManager.registerLayer takes, in config order. */
    getMapLayerConfigs() {
        const configs = [];
        for (const ds of this.datasets.values()) {
            for (const layerId of ds.layerIds) {
                const l = this.layers.get(layerId);
                if (l.sidebar === false && l.visible) {
                    console.warn(`[Portolan] ${layerId} has "sidebar": false and "visible": true: it draws on load with no panel checkbox, so only the assistant can turn it off.`);
                }
                const base = {
                    layerId,
                    datasetId: ds.id,
                    group: l.group,
                    groupCollapsed: l.groupCollapsed || false,
                    displayName: l.title,
                    defaultVisible: l.visible,
                    sidebar: l.sidebar !== false,
                    toggleGroup: l.toggleGroup || null,
                };
                if (l.kind === 'vector') {
                    configs.push({
                        ...base,
                        type: 'vector',
                        source: l.geojson ? { type: 'geojson', data: l.url } : { type: 'vector', url: `pmtiles://${l.url}` },
                        ...(l.sourceId ? { sourceId: l.sourceId } : {}),
                        ...(l.geojson ? {} : { sourceLayer: l.sourceLayer }),
                        legendLabel: l.legendLabel,
                        legendType: l.legendType,
                        legendClasses: l.legendClasses,
                        legendRange: l.legendRange,
                        legendGradient: l.legendGradient,
                        control: l.control,
                        animation: l.animation,
                        tracksUrl: l.geojson ? l.url : null,
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
                        legendLabel: l.legendLabel || l.band?.unit || null,
                        legendType: l.legendType || (l.band?.classes ? 'categorical' : null),
                        legendClasses: l.band?.classes
                            ? l.band.classes.map(c => ({ value: c.value, name: c.description || c.name || String(c.value), 'color-hint': c.color_hint || c['color-hint'] }))
                            : null,
                        // A series of items plays in the full app's frame player.
                        ...(l.series && {
                            control: l.series.control,
                            frameSource: { frames: l.series.frames },
                            frameTileUrl: (href) => this.rasterTileUrl({ ...l, url: href }),
                        }),
                    });
                }
                // A versioned layer: one source per version, the style shared.
                if (l.versions) {
                    const cfg = configs[configs.length - 1];
                    const safe = layerId.replace(/[^a-zA-Z0-9]/g, '-');
                    cfg.versions = l.versions.map((v, i) => (l.kind === 'vector'
                        ? (v.geojson
                            ? { label: v.label, type: 'vector', sourceId: `src-${safe}-v${i}`, source: { type: 'geojson', data: v.url } }
                            : { label: v.label, type: 'vector', sourceId: `src-${safe}-v${i}`, source: { type: 'vector', url: `pmtiles://${v.url}` }, sourceLayer: v.sourceLayer })
                        : {
                            label: v.label, type: 'raster', colormap: v.colormap, rescale: v.rescale, sourceId: `src-${safe}-v${i}`,
                            source: { type: 'raster', tiles: [this.rasterTileUrl({ ...l, url: v.url, band: v.band, colormap: v.colormap || l.colormap, rescale: v.rescale || l.rescale })], tileSize: 256 },
                        }));
                    cfg.defaultVersionIndex = l.defaultVersionIndex;
                    delete cfg.source;
                }
            }
        }
        return configs;
    }

    getAll() {
        return [...this.datasets.values()];
    }

    /** The ids of the loaded collections, in config order. */
    getIds() {
        return [...this.datasets.keys()];
    }

    /**
     * A loaded collection's STAC by id, for the catalog tools
     * (app/catalog-tools.js). Only collections the app lists resolve: an app
     * sees its own data and nothing else (#441, docs/design/data-scope.md).
     * Portolan has no nested collections, so there are no children to list.
     * The id match ignores case.
     *
     * @returns {Promise<{doc: Object, url: string, children: Array}|null>}
     */
    async resolveStac(id) {
        const want = String(id ?? '').trim();
        const ds = this.datasets.get(want)
            || [...this.datasets.values()].find(d => d.id.toLowerCase() === want.toLowerCase());
        return ds ? { doc: ds.stac, url: ds.url, children: [] } : null;
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
                const panelNotes = () => {
                    if (l.versions) lines.push(`  Versions, switched in the layer panel: ${l.versions.map(v => v.label).join(', ')}; starts on ${l.versions[l.defaultVersionIndex]?.label}`);
                    if (l.toggleGroup) lines.push(`  Toggle group "${l.toggleGroup}": one panel checkbox shows and hides every member together`);
                };
                if (l.kind === 'vector') {
                    lines.push(`- layer_id \`${layerId}\` — vector, ${(l.geometryType || 'unknown geometry').toLowerCase()}, drawn as ${l.renderType}${l.visible ? ', on at start' : ''}`);
                    panelNotes();
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
                            lines.push(`  - \`${name}\`${name === l.defaultStyle ? ' (current at start)' : ''}: ${describeStyleColours(s.paint)}`);
                        }
                    }
                } else {
                    const b = l.band || {};
                    const stats = b.min != null ? `values ${fmt(b.min)} to ${fmt(b.max)}, mean ${fmt(b.mean)}${b.unit ? ` ${b.unit}` : ''}` : 'no statistics published';
                    const where = [
                        l.itemId ? `item \`${l.itemId}\`${l.date ? ` (${l.date})` : ''}` : null,
                        l.series ? `time series of ${l.series.frames.length} dates from ${l.series.first} to ${l.series.last}, one item each, starting on ${l.series.last}; set_time picks the date` : null,
                        b.bidx ? `band ${b.bidx}` : null,
                    ].filter(Boolean).join(', ');
                    lines.push(`- layer_id \`${layerId}\` — raster (COG)${where ? `, ${where}` : ''}, ${stats}; drawn with colormap \`${l.colormap}\` over ${l.rescale || 'the full range'}${l.visible ? ', on at start' : ''}`);
                    panelNotes();
                    if (b.classes) lines.push(`  Classes: ${b.classes.slice(0, 20).map(c => `${c.value}=${c.description || c.name}`).join(', ')}`);
                }
            }
            lines.push('');
        }
        return lines.join('\n');
    }
}

/**
 * The catalog as the session export reads it: the same object, but each
 * collection's raw STAC with absolute asset hrefs, so the report can cite the
 * collections a session queried (Portolan hrefs are relative).
 */
export function exportCatalogView(catalog) {
    return Object.create(catalog, {
        getAll: {
            value: () => catalog.getAll().map(d => ({ ...d, _rawStac: withAbsoluteHrefs(d._rawStac, d.url) })),
        },
    });
}

/**
 * A vector layer's legend, by the full app's rules: `legend_*` in config win;
 * else a legend read from the catalog style's colours (swatches for a
 * `match`, a colorbar for a ramp). Paint set in config gets a legend only
 * when config asks for one, as in the full app.
 */
function vectorLegend(s, catalogPaint) {
    const fromConfig = s.legend_type || s.legend_classes;
    const derived = !fromConfig && catalogPaint ? legendFromPaint(catalogPaint) : { legendType: null, legendClasses: null };
    return {
        legendType: s.legend_type || (s.legend_classes ? 'categorical' : null) || derived.legendType,
        legendClasses: normalizeLegendClasses(s.legend_classes) || derived.legendClasses,
        legendLabel: s.legend_label || null,
        legendRange: Array.isArray(s.legend_range) ? s.legend_range : null,
        legendGradient: Array.isArray(s.legend_gradient) ? s.legend_gradient : null,
    };
}

/**
 * The full app's trajectory `animation` block, with `static_positions_asset`
 * (another asset of the collection) resolved to its URL.
 */
function animationFor(animation, dataset) {
    if (!animation || typeof animation !== 'object') return null;
    const out = { ...animation };
    const key = animation.static_positions_asset;
    const href = key && dataset.stac?.assets?.[key]?.href;
    if (href) out.static_positions_url = resolveHref(href, dataset.url);
    return out;
}

/** A COG's band, with the layer's band settings applied when it has any. */
function bandFor(src, render, s) {
    const custom = s.bidx != null || s.nodata != null || s.legend_classes || typeof s.unscale === 'boolean';
    return custom ? rasterBand(src.asset, render, s) : src.band;
}

/**
 * A layer's place in the panel: its group (and whether that group starts
 * folded), whether it has a panel row at all (`sidebar`), and the toggle
 * group whose one row it shares, as in the full app.
 */
function panelFields(dataset, s) {
    return {
        group: s.group || null,
        groupCollapsed: dataset.groupCollapsed || s.group_collapsed || false,
        sidebar: s.sidebar !== false,
        toggleGroup: typeof s.toggle_group === 'string' && s.toggle_group.trim() ? s.toggle_group.trim() : null,
    };
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

/**
 * Read a stac-geoparquet item mirror with the vendored hyparquet, loaded only
 * now. Only the columns a series needs are read, of those the file has.
 * Byte ranges first; a host that refuses them gets one plain download.
 */
async function defaultReadItemMirror(url) {
    const { parquetReadObjects, parquetMetadataAsync, asyncBufferFromUrl } = await import('../app/vendor/hyparquet.js');
    let file;
    try {
        file = await asyncBufferFromUrl({ url });
    } catch {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} for ${url}`);
        file = await res.arrayBuffer();
    }
    const metadata = await parquetMetadataAsync(file);
    const have = new Set(topLevelColumns(metadata.schema));
    const columns = ['id', 'datetime', 'start_datetime', 'assets'].filter(c => have.has(c));
    return parquetReadObjects({ file, metadata, columns });
}

/** The top-level column names of a Parquet schema (a flattened tree). */
export function topLevelColumns(schema) {
    const names = [];
    const skip = (i) => {
        const n = schema[i]?.num_children || 0;
        let j = i + 1;
        for (let k = 0; k < n; k++) j = skip(j);
        return j;
    };
    let i = 1;
    const roots = schema?.[0]?.num_children || 0;
    for (let k = 0; k < roots && i < schema.length; k++) {
        names.push(schema[i].name);
        i = skip(i);
    }
    return names;
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
