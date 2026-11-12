/**
 * DatasetCatalog - Unified dataset knowledge from STAC
 * 
 * Fetches STAC collections (filtered by app config), and for each collection
 * builds a unified record containing:
 *   - Metadata (title, description, provider, license)
 *   - Parquet/H3 assets (for SQL queries via MCP)
 *   - Visual assets (PMTiles/GeoJSON for vector, COG for raster — for map display)
 *   - Schema (table:columns — for filter/style guidance)
 * 
 * The catalog is the single source of truth for "what data exists"
 * and is injected into both the system prompt and the map layer setup.
 */

import { findCollections, childLinks as stacChildLinks, resolveHref } from './catalog-tree.js';
import { normalizeLegendClasses, resolveRasterBand, cogTileUrl, publishedRender } from './cog-tiles.js';
import { findStyleAssets, styleToLayer, stylesForFile, describeStyleColours } from './published-styles.js';
import { legendFromPaint } from './legend-helpers.js';

export { resolveRasterBand, cogTileUrl };
// Shared with glen core; re-exported so imports keep working.
export { resolveFrameSource } from './raster-frames.js';
import { resolveFrameSource } from './raster-frames.js';

export class DatasetCatalog {
    constructor() {
        /** @type {Map<string, DatasetEntry>} keyed by collection ID */
        this.datasets = new Map();
        /**
         * Raw STAC of sub-collections, keyed by *child* ID. Children are not
         * datasets (they stay out of `datasets`, the layer panel and
         * `list_datasets`), but the prompt tells the model to call
         * `get_stac_details` with a child ID, so `resolveStac` answers for
         * them too. Read at boot one level down, deeper on demand.
         * @type {Map<string, Object>}
         */
        this.childCollections = new Map();
        this.catalogUrl = null;
        this.titilerUrl = null;
        /** @type {Map<string, string>} collection id → the URL it was read from */
        this.stacUrls = new Map();
        /** @type {Map<string, Promise<Object>>} URL → its JSON, read once */
        this._docs = new Map();
        /**
         * True when the root catalog was configured but unreachable, so the
         * catalog loaded without it. Boot continues either way (#335); this is
         * for callers that want to surface or log the degraded state.
         */
        this.degraded = false;
    }

    /**
     * Load and process STAC collections specified in the app config.
     *
     * Never rejects on catalog-fetch failure: after `fetchJson` exhausts its
     * retries the load degrades to whatever resolved (often nothing) and sets
     * `this.degraded`, leaving the agent to reach data through the MCP STAC
     * tools. The root document is fetched only when some collection actually
     * needs traversing to resolve.
     *
     * @param {Object} appConfig - Parsed layers-input.json
     * @param {string} [appConfig.catalog] - STAC catalog URL (only required
     *     when a collection must be resolved by walking the root)
     * @param {string} [appConfig.titiler_url] - TiTiler base URL for COGs
     * @param {Array<Object>} [appConfig.collections] - Collection specs
     */
    async load(appConfig) {
        this.appConfig = appConfig;
        this.catalogUrl = appConfig.catalog;
        this.titilerUrl = appConfig.titiler_url || 'https://titiler.nrp-nautilus.io';

        const collections = appConfig.collections || [];
        this.degraded = false;

        // We'll match against the requested collection IDs
        const requestedIds = new Set(collections.map(c =>
            typeof c === 'string' ? c : c.collection_id
        ));

        // Build options map from collection specs
        const optionsMap = new Map();
        for (const c of collections) {
            if (typeof c === 'object') {
                optionsMap.set(c.collection_id, c);
            }
        }

        // Collections with explicit collection_url are fetched directly — no catalog traversal needed
        const directEntries = collections.filter(c => typeof c === 'object' && c.collection_url);
        const directIds = new Set(directEntries.map(c => c.collection_id));
        const catalogIds = new Set([...requestedIds].filter(id => !directIds.has(id)));

        console.log(`[Catalog] Looking for ${requestedIds.size} collections: ${[...requestedIds].join(', ')}`);

        // Walk the catalog only when something actually needs resolving by id.
        // `collections: []` and configs where every entry carries its own
        // `collection_url` resolve without the root, so an app that declared it
        // needs nothing from that document shouldn't boot-fail when it's down.
        //
        // The walk goes through Catalogs and Collections to any depth (#441),
        // so ids resolve under today's bucket-level Collections and under the
        // Portolan layout alike. It stops once every id is found.
        let found = new Map();
        if (catalogIds.size === 0) {
            console.log('[Catalog] No collections require catalog traversal — skipping root fetch');
        } else if (!this.catalogUrl) {
            this.degraded = true;
            console.warn(`[Catalog] No catalog URL configured; ${catalogIds.size} collection(s) cannot be resolved. Continuing with a degraded catalog.`);
        } else {
            console.log('[Catalog] Loading STAC catalog:', this.catalogUrl);
            try {
                found = await findCollections(this.catalogUrl, catalogIds, {
                    fetchJson: (u) => this.readJson(u),
                    onError: (u, e) => console.warn(`[Catalog] Failed to fetch child: ${u}`, e.message),
                });
            } catch (error) {
                // Degrade rather than throw. fetchJson has already exhausted its
                // retry budget, so this is a sustained outage, not a blip. A
                // degraded app beats a blank page, so callers get an empty
                // catalog instead of a rejected promise.
                this.degraded = true;
                console.warn(`[Catalog] Root catalog unavailable after retries: ${error.message}. Continuing with a degraded catalog — map layers from this catalog will be missing.`);
            }
        }

        const directFetches = directEntries
            .map(async (c) => {
                try {
                    const collection = await this.readJson(c.collection_url);
                    const options = optionsMap.get(c.collection_id) || {};
                    return this.processCollection(collection, options, c.collection_url);
                } catch (error) {
                    console.warn(`[Catalog] Failed to fetch direct collection: ${c.collection_url}`, error.message);
                }
                return null;
            });

        // A collection below the root's children costs a walk on every boot.
        for (const [id, { url, depth }] of found) {
            if (depth > 1) {
                console.warn(`[Catalog] "${id}" is ${depth} levels below the catalog root, so finding it reads much of the catalog on every load. `
                    + `Add "collection_url": "${url}" to its entry in layers-input.json.`);
            }
        }

        const fetchPromises = [...found.entries()].map(async ([id, { url, doc }]) => {
            try {
                return await this.processCollection(doc, optionsMap.get(id) || {}, url);
            } catch (error) {
                console.warn(`[Catalog] Failed to process collection: ${url}`, error.message);
            }
            return null;
        });

        const results = await Promise.allSettled([...directFetches, ...fetchPromises]);
        const loaded = results.filter(r => r.status === 'fulfilled' && r.value).length;

        // Collections register as their reads finish, which varies from one
        // load to the next. Put them back in config order, so the prompt's
        // catalog, list_datasets and the data page are the same on every
        // load, and the cached prompt prefix stays shared between visitors
        // (docs/design/prompt-prefix-stability.md).
        const configOrder = [...requestedIds];
        const sourceIds = [...directEntries.map(c => c.collection_id), ...found.keys()];
        const rank = new Map();
        results.forEach((r, i) => {
            if (r.status === 'fulfilled' && r.value) rank.set(r.value, configOrder.indexOf(sourceIds[i]));
        });
        const last = configOrder.length;
        this.datasets = new Map([...this.datasets.entries()]
            .map((e, i) => ({ e, i, pos: rank.get(e[1]) ?? last }))
            .sort((a, b) => a.pos - b.pos || a.i - b.i)
            .map(x => x.e));
        console.log(`[Catalog] Loaded ${loaded}/${requestedIds.size} collections`);

        // Warn about missing collections
        for (const id of requestedIds) {
            if (!this.datasets.has(id)) {
                console.warn(`[Catalog] Collection not found: ${id}`);
            }
        }
    }

    /**
     * Process a single STAC collection into a DatasetEntry.
     */
    /**
     * @param {Object} collection - STAC collection JSON
     * @param {Object} [options] - the collection's entry in layers-input.json
     * @param {string} [url] - where it was read; its child hrefs resolve against it
     */
    async processCollection(collection, options = {}, url = null) {
        // Build ordered asset config list.
        // Using an array (not a Map) so the same STAC asset can appear multiple times
        // under different aliases — e.g. one PMTiles split into "fee" and "easement" layers
        // via { id: "pmtiles", alias: "fee", ... } and { id: "pmtiles", alias: "easement", ... }.
        let assetConfigList = null;
        if (Array.isArray(options.assets)) {
            assetConfigList = [];
            for (const a of options.assets) {
                if (typeof a === 'string') {
                    assetConfigList.push({ key: a, assetId: a, config: {} });
                } else if (a && a.id) {
                    const key = a.alias || a.id;
                    assetConfigList.push({ key, assetId: a.id, config: a });
                }
            }
        }

        // Extract parquet assets and columns from this collection
        let parquetAssets = this.extractParquetAssets(collection);
        let columns = this.extractColumns(collection);

        // One-level child expansion: if this collection has child links,
        // fetch them to find additional parquet/hex assets and column schemas
        // that aren't on the parent (e.g. wyoming-wildlife-lands has per-species
        // sub-collections each with h3-parquet assets). Does NOT recurse further.
        const childLinks = (collection.links || []).filter(l => l.rel === 'child');
        let childIds = [];
        const rawChildren = [];
        if (childLinks.length > 0) {
            const childResults = await Promise.allSettled(
                childLinks.map(async (link) => {
                    try {
                        const childUrl = resolveHref(link.href, url || this.catalogUrl);
                        const child = await this.readJson(childUrl);
                        if (child?.id) this.stacUrls.set(child.id, childUrl);
                        return child;
                    } catch (e) {
                        console.warn(`[Catalog] Failed to fetch sub-collection: ${link.href}`, e.message);
                        return null;
                    }
                })
            );
            for (const r of childResults) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                const child = r.value;
                rawChildren.push(child);
                if (child.id) {
                    childIds.push(child.id);
                    this.childCollections.set(child.id, child);
                }
                const childParquet = this.extractParquetAssets(child);
                if (childParquet.length > 0) {
                    parquetAssets = parquetAssets.concat(childParquet);
                }
                // Use child columns if parent has none
                if (columns.length === 0) {
                    columns = this.extractColumns(child);
                }
            }
        }

        const rawGroup = options.group || null;
        const groupName = rawGroup && typeof rawGroup === 'object' ? rawGroup.name : rawGroup;
        const groupCollapsed = rawGroup && typeof rawGroup === 'object' ? rawGroup.collapsed === true : false;

        // Collection-level layer-panel membership (#352). Default true; a
        // per-asset `sidebar` overrides it either way. This is panel membership
        // only — a `sidebar: false` layer is still registered and still
        // addressable by the agent (show_layer, set_style, get_map_state).
        const sidebar = options.sidebar !== false;

        const entry = {
            id: collection.id,
            group: groupName,
            groupCollapsed,
            sidebar,
            title: options.display_name || collection.title || collection.id,
            description: collection.description || '',
            license: collection.license || 'N/A',
            keywords: collection.keywords || [],
            provider: this.extractProvider(collection),
            aboutUrl: this.extractAboutUrl(collection),
            documentationUrl: this.extractDocUrl(collection),

            // Schema from table:columns
            columns,

            // Child collection IDs (for parent container detection)
            childIds,

            // Whether to inject full schema into the prompt catalog
            preload: options.preload === true,

            // Visual assets (for map display) — filtered by config
            mapLayers: this.extractMapLayers(collection, options, assetConfigList),

            // Parquet/H3 assets (for SQL via MCP) — always load all
            parquetAssets,

            // Raw STAC extent
            extent: collection.extent,
            summaries: collection.summaries || {},

            // Raw STAC, for get_schema / get_stac_details and the data page.
            _rawStac: collection,
            _rawChildren: rawChildren.length > 0 ? rawChildren : null,
        };

        await this._applyCatalogStyles(entry.mapLayers, collection, url);

        if (url) this.stacUrls.set(collection.id, url);
        this.datasets.set(collection.id, entry);
        console.log(`[Catalog] Registered: ${entry.id} (${entry.mapLayers.length} map layers, ${entry.parquetAssets.length} parquet assets)`);
        return entry;
    }

    /**
     * Soft-validate configured `asset.id`s against the STAC collection's asset keys (#177).
     *
     * Emits a single, informative `console.warn` per configured id that doesn't match a
     * STAC asset key, naming the collection, the offending id, and the keys that *are*
     * available. Warn-only by design: drift is tolerated because an asset may be added
     * later, and the asset-id-as-source-layer fallback can still render a mismatched id —
     * but that silent key-drift is exactly what's expensive to debug in the field, so we
     * surface it in dev logs. The `versions` form validates each version's `asset_id`
     * (the logical `id` of a versioned entry is not itself a STAC key, so it's skipped).
     *
     * @param {Object} collection - STAC collection (reads `.id` and `.assets`)
     * @param {Array<{assetId: string, config: Object}>} assetConfigList
     * @private
     */
    _validateAssetIds(collection, assetConfigList) {
        const available = Object.keys(collection.assets || {});
        const availableSet = new Set(available);
        const warnMissing = (id) => console.warn(
            `[Catalog] Asset id "${id}" configured for collection "${collection.id}" ` +
            `does not match any STAC asset key. Available: ${available.join(', ') || '(none)'}`
        );

        for (const { assetId, config } of assetConfigList) {
            if (config.versions && Array.isArray(config.versions)) {
                for (const v of config.versions) {
                    if (v.asset_id && !availableSet.has(v.asset_id)) warnMissing(v.asset_id);
                }
            } else if (!availableSet.has(assetId)) {
                warnMissing(assetId);
            }
        }
    }

    /**
     * Extract map-displayable assets (PMTiles, GeoJSON, and COGs).
     * Each becomes a potential map layer.
     *
     * When assetConfigList is provided (filtered mode), iterates the config entries
     * in order — supporting multiple logical layers from one STAC asset via alias.
     * When null, all visual assets from the STAC collection are included.
     *
     * @param {Object} collection - STAC collection
     * @param {Object} options - Collection-level options
     * @param {Array|null} assetConfigList - Ordered list of {key, assetId, config}
     */
    extractMapLayers(collection, options = {}, assetConfigList = null) {
        const layers = [];
        const stacAssets = collection.assets || {};

        if (assetConfigList) {
            // Soft-validate configured asset ids against STAC keys before building (#177)
            this._validateAssetIds(collection, assetConfigList);

            // Filtered mode: iterate config entries so aliases and ordering are respected
            for (const { key, assetId, config } of assetConfigList) {

                // Asset-level group is always a plain string (group reassignment).
                // Tolerate object form { name } for robustness, but ignore collapsed
                // — collapsed is a group-level concern, set on the collection's group.
                const rawAssetGroup = config.group || null;
                const assetGroup = rawAssetGroup && typeof rawAssetGroup === 'object'
                    ? rawAssetGroup.name : rawAssetGroup;

                // Per-asset layer-panel membership (#352). Tri-state: a boolean
                // overrides the collection-level `sidebar`; null inherits it.
                const assetSidebar = typeof config.sidebar === 'boolean' ? config.sidebar : null;

                // Shared panel row (#349): layers with the same `toggle_group`
                // render as one checkbox that drives every member. Each member
                // stays its own layer — own source, stretch and legend entry.
                const toggleGroup = typeof config.toggle_group === 'string' && config.toggle_group.trim()
                    ? config.toggle_group.trim() : null;

                // ── Versioned asset: multiple STAC assets behind one logical layer ──
                if (config.versions && Array.isArray(config.versions)) {
                    const versions = [];
                    for (const v of config.versions) {
                        const vAsset = stacAssets[v.asset_id];
                        if (!vAsset) continue;
                        const vType = vAsset.type || '';
                        if (vType.includes('pmtiles')) {
                            versions.push({
                                label: v.label,
                                assetId: v.asset_id,
                                layerType: 'vector',
                                url: vAsset.href,
                                sourceLayer: vAsset['vector:layers']?.[0] || vAsset['pmtiles:layer'] || v.asset_id,
                                description: vAsset.description || '',
                            });
                        } else if (vType.includes('geotiff') || vType.includes('tiff')) {
                            // Each version takes its own published render (#440);
                            // config set on the layer still wins for every version.
                            const render = publishedRender(collection, v.asset_id);
                            versions.push({
                                label: v.label,
                                assetId: v.asset_id,
                                layerType: 'raster',
                                cogUrl: vAsset.href,
                                ...resolveRasterBand(vAsset, config, render),
                                colormap: config.colormap || options.colormap || render?.colormap || null,
                                rescale: config.rescale || options.rescale || render?.rescale || null,
                                categorical: !!render?.classColours,
                                description: vAsset.description || '',
                            });
                        } else if (vType.includes('geo+json') || vAsset.href?.endsWith('.geojson')) {
                            versions.push({
                                label: v.label,
                                assetId: v.asset_id,
                                layerType: 'vector',
                                sourceType: 'geojson',
                                url: vAsset.href,
                                description: vAsset.description || '',
                            });
                        }
                    }
                    if (versions.length === 0) continue;

                    // Resolve default version index
                    const defaultLabel = config.default_version;
                    let defaultIndex = defaultLabel
                        ? versions.findIndex(v => v.label === defaultLabel)
                        : -1;
                    if (defaultIndex < 0) defaultIndex = 0;

                    // All versions must share a layer type (vector or raster)
                    const layerType = versions[0].layerType;
                    const startVersion = versions[defaultIndex];

                    layers.push({
                        assetId: key,
                        layerType,
                        group: assetGroup,
                        sidebar: assetSidebar,
                        toggleGroup,
                        title: config.display_name || collection.title || key,
                        description: versions[defaultIndex].description || '',
                        defaultStyle: config.default_style || null,
                        outlineStyle: config.outline_style || null,
                        renderType: config.layer_type || null,
                        tooltipFields: config.tooltip_fields || null,
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                        colormap: startVersion.colormap || config.colormap || options.colormap || 'reds',
                        rescale: startVersion.rescale || config.rescale || options.rescale || null,
                        paint: config.paint || null,
                        legendLabel: config.legend_label || null,
                        legendType: config.legend_type || (startVersion.categorical ? 'categorical' : null),
                        legendClasses: normalizeLegendClasses(config.legend_classes)
                            ?? (startVersion.categorical ? startVersion.legendClasses : null),
                        legendRange: config.legend_range || null,
                        legendGradient: config.legend_gradient || null,
                        control: config.control || null,
                        // Versioned metadata
                        versions,
                        defaultVersionIndex: defaultIndex,
                    });
                    continue;
                }

                // ── Standard (non-versioned) asset ──
                const asset = stacAssets[assetId];
                if (!asset) continue;

                const type = asset.type || '';

                if (type.includes('pmtiles')) {
                    layers.push({
                        assetId: key,
                        sourceAssetId: assetId,  // original STAC key — used to share one MapLibre source across aliases
                        layerType: 'vector',
                        styleName: typeof config.style === 'string' ? config.style : null,
                        group: assetGroup,
                        sidebar: assetSidebar,
                        toggleGroup,
                        title: config.display_name || asset.title || assetId,
                        url: asset.href,
                        sourceLayer: asset['vector:layers']?.[0] || asset['pmtiles:layer'] || assetId,
                        description: asset.description || '',
                        defaultStyle: config.default_style || null,
                        outlineStyle: config.outline_style || null,
                        renderType: config.layer_type || null,
                        tooltipFields: config.tooltip_fields || null,
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                        legendLabel: config.legend_label || null,
                        legendType: config.legend_type || null,
                        legendClasses: normalizeLegendClasses(config.legend_classes),
                        legendRange: config.legend_range || null,
                        legendGradient: config.legend_gradient || null,
                        control: config.control || null,
                    });
                } else if (type.includes('geotiff') || type.includes('tiff')) {
                    // The catalog's published render is the starting look;
                    // config keys still win where set (#440).
                    const render = publishedRender(collection, assetId);
                    const band = resolveRasterBand(asset, config, render);
                    layers.push({
                        assetId: key,
                        layerType: 'raster',
                        group: assetGroup,
                        sidebar: assetSidebar,
                        toggleGroup,
                        title: config.display_name || asset.title || assetId,
                        cogUrl: asset.href,
                        colormap: config.colormap || options.colormap || render?.colormap || 'reds',
                        rescale: config.rescale || options.rescale || render?.rescale || null,
                        catalogRender: render?.name || null,
                        paint: config.paint || null,
                        legendLabel: config.legend_label || null,
                        legendType: config.legend_type || (render?.classColours && band.legendClasses ? 'categorical' : null),
                        legendClasses: band.legendClasses,
                        nodata: band.nodata,
                        bidx: band.bidx,
                        unscale: band.unscale,
                        description: asset.description || '',
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                        control: config.control || null,
                        frameSource: resolveFrameSource(config.control, asset, stacAssets),
                    });
                } else if (type.includes('geo+json') || asset.href?.endsWith('.geojson')) {
                    // Resolve static_positions_asset reference (another STAC asset
                    // in this same collection) to a URL, so MapManager doesn't
                    // need to know about STAC.
                    let animation = null;
                    if (config.animation && typeof config.animation === 'object') {
                        animation = { ...config.animation };
                        const staticKey = config.animation.static_positions_asset;
                        if (staticKey && stacAssets[staticKey]?.href) {
                            animation.static_positions_url = stacAssets[staticKey].href;
                        }
                    }
                    layers.push({
                        assetId: key,
                        sourceAssetId: assetId,
                        layerType: 'vector',
                        sourceType: 'geojson',
                        group: assetGroup,
                        sidebar: assetSidebar,
                        toggleGroup,
                        title: config.display_name || asset.title || assetId,
                        url: asset.href,
                        description: asset.description || '',
                        defaultStyle: config.default_style || null,
                        outlineStyle: config.outline_style || null,
                        renderType: config.layer_type || null,
                        tooltipFields: config.tooltip_fields || null,
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                        legendLabel: config.legend_label || null,
                        legendType: config.legend_type || null,
                        legendClasses: normalizeLegendClasses(config.legend_classes),
                        legendRange: config.legend_range || null,
                        legendGradient: config.legend_gradient || null,
                        animation,
                        control: config.control || null,
                    });
                }
            }
        } else {
            // Unfiltered mode: include all visual assets from the STAC collection
            for (const [assetId, asset] of Object.entries(stacAssets)) {
                const type = asset.type || '';

                if (type.includes('pmtiles')) {
                    layers.push({
                        assetId,
                        layerType: 'vector',
                        title: asset.title || assetId,
                        url: asset.href,
                        sourceLayer: asset['vector:layers']?.[0] || asset['pmtiles:layer'] || assetId,
                        description: asset.description || '',
                        defaultStyle: null,
                        tooltipFields: null,
                        defaultVisible: false,
                        defaultFilter: null,
                    });
                } else if (type.includes('geotiff') || type.includes('tiff')) {
                    const render = publishedRender(collection, assetId);
                    const band = resolveRasterBand(asset, {}, render);
                    layers.push({
                        assetId,
                        layerType: 'raster',
                        title: asset.title || assetId,
                        cogUrl: asset.href,
                        colormap: options.colormap || render?.colormap || 'reds',
                        rescale: options.rescale || render?.rescale || null,
                        catalogRender: render?.name || null,
                        ...(render?.classColours && band.legendClasses ? { legendType: 'categorical' } : {}),
                        ...band,
                        description: asset.description || '',
                        defaultVisible: false,
                        defaultFilter: null,
                    });
                } else if (type.includes('geo+json') || asset.href?.endsWith('.geojson')) {
                    layers.push({
                        assetId,
                        layerType: 'vector',
                        sourceType: 'geojson',
                        title: asset.title || assetId,
                        url: asset.href,
                        description: asset.description || '',
                        defaultStyle: null,
                        tooltipFields: null,
                        defaultVisible: false,
                        defaultFilter: null,
                    });
                }
            }
        }

        return layers;
    }

    /**
     * Start a PMTiles layer from the collection's published MapLibre style
     * when its config gives no paint (#440).
     *
     * The catalog publishes style assets (Portolan `style` role; data-workflows
     * #881/#887). A layer whose config sets `default_style` keeps it, so apps
     * that style their layers change nothing and read nothing more. A layer
     * without one takes its PMTiles file's default style, or the published style
     * its config names with `"style": "<name>"`. A collection with several
     * archives publishes styles per archive, matched to a layer by the file its
     * style's source names (a versioned layer by its starting version's); the name may be the style's
     * short name (`fee-gap-sts`) or its asset key (`style-fee-gap-sts`). The
     * style also gives the outline, the filter and, unless config declares a
     * legend, a categorical or continuous legend read from its paint. Config
     * keys (`outline_style`, `layer_type`, `default_filter`, `legend_*`) still
     * win where set. The conversion is glen core's (`styleToLayer`), so a style
     * draws the same in both apps.
     *
     * @param {Array<Object>} mapLayers - this collection's layers, changed in place
     * @param {Object} collection - STAC collection JSON
     * @param {string|null} url - where it was read, to resolve style hrefs
     */
    async _applyCatalogStyles(mapLayers, collection, url) {
        const vectors = mapLayers.filter(ml => ml.layerType === 'vector' && ml.sourceType !== 'geojson');
        if (!vectors.length) return;
        const found = findStyleAssets(collection, url || this.catalogUrl);
        if (!found.length) return;
        // Read every style once: a collection with several PMTiles archives
        // publishes a style per archive, and the source each style names is
        // what says which layer it belongs to. Layers styled by config read
        // them too, for apply_style and the prompt.
        const styles = (await Promise.all(found.map(async (st) => {
            try { return { ...st, doc: await this.readJson(st.url) }; } catch (err) {
                console.warn(`[Catalog] Style ${st.url} unreadable: ${err.message}`);
                return null;
            }
        }))).filter(Boolean);
        const GEOMETRY = { line: 'LineString', circle: 'Point', fill: 'Polygon' };
        for (const ml of vectors) {
            const fileUrl = ml.url || ml.versions?.[ml.defaultVersionIndex || 0]?.url;
            const geometry = GEOMETRY[ml.renderType] || null;
            const published = [];
            for (const st of stylesForFile(styles, fileUrl)) {
                const layer = styleToLayer(st.doc, geometry);
                if (layer) published.push({ name: st.name, key: st.key, title: st.title || st.doc?.name || st.name, isDefault: st.isDefault, ...layer });
            }
            if (!published.length) continue;
            ml.publishedStyles = published;
            if (ml.defaultStyle) continue;

            const named = ml.styleName
                ? published.find(st => st.name === ml.styleName || st.key === ml.styleName)
                : null;
            if (ml.styleName && !named) {
                console.warn(`[Catalog] ${collection.id}/${ml.assetId}: no published style "${ml.styleName}"; `
                    + `using the default. Published: ${published.map(st => st.name).join(', ')}`);
            }
            const pick = named || published.find(st => st.isDefault) || published[0];
            ml.defaultStyle = pick.paint;
            ml.catalogStyle = pick.name;
            if (!ml.renderType && pick.renderType !== 'fill') ml.renderType = pick.renderType;
            if (!ml.outlineStyle && pick.outlinePaint) ml.outlineStyle = pick.outlinePaint;
            if (!ml.defaultFilter && pick.filter) {
                ml.defaultFilter = pick.filter;
                ml.styleFilter = pick.filter;
            }
            if (!ml.legendType) {
                const legend = legendFromPaint(pick.paint);
                if (legend.legendType) Object.assign(ml, legend);
            }
        }
    }

    /**
     * Extract parquet/H3 hex assets for SQL queries.
     * All parquet assets are always loaded (no filtering) so the
     * AI agent / DuckDB can query any available data.
     * @param {Object} collection
     */
    extractParquetAssets(collection) {
        const assets = [];
        const rawAssets = collection.assets || {};

        for (const [assetId, asset] of Object.entries(rawAssets)) {
            const type = asset.type || '';
            const href = asset.href || '';

            if (type.includes('parquet') || href.endsWith('.parquet') || href.endsWith('/hex/') || href.endsWith('/hex//')) {
                // Convert HTTPS URL to S3 path for DuckDB
                let s3Path = href;
                if (href.startsWith('https://s3-west.nrp-nautilus.io/')) {
                    s3Path = href.replace('https://s3-west.nrp-nautilus.io/', 's3://');
                }
                // Add wildcard for partitioned directories
                if (s3Path.endsWith('/') || s3Path.endsWith('//')) {
                    s3Path = s3Path.replace(/\/+$/, '') + '/**';
                }

                assets.push({
                    assetId,
                    title: asset.title || assetId,
                    s3Path,
                    originalUrl: href,
                    isPartitioned: href.endsWith('/') || href.endsWith('//'),
                    description: asset.description || '',
                });
            }
        }

        return assets;
    }

    /**
     * Extract table:columns for schema info (feeds map tooltips, legends,
     * layer `columns`, and `isParentContainer` detection).
     *
     * Reads the **per-asset** `table:columns` off the queryable parquet assets
     * — the canonical location the catalog/publisher standard is standardizing
     * on (#311) — then appends the collection-level `table:columns` as a
     * lower-priority trailer. This mirrors the MCP `get_stac_details` renderer
     * (the LLM's schema channel: per-asset columns + a collection-level trailer)
     * so both channels read the same STAC fields.
     *
     * Columns are unioned, preferring the H3 **hex** asset (the primary query
     * target per the MCP's query-optimization guidance), then the flat
     * GeoParquet, then the collection-level trailer — so richer per-asset
     * definitions win on name collisions while the trailer fills any gaps.
     * Geometry columns are dropped; names are deduped. A column's missing
     * description or coded values are filled by name from the collection's
     * `table:columns`, then from any asset: under the Portolan layout the
     * collection holds the one column dictionary (PORTO-FMT-046) and an
     * asset may list only names and types (PORTO-FMT-048, #441).
     *
     * Why keep the collection-level trailer rather than reading per-asset only:
     * the catalog is mid-migration (data-workflows #404/#369 backfill). Some
     * collections are already per-asset-only (e.g. wdpa — no collection block,
     * every asset carries columns → per-asset is the *only* source, and reading
     * it here fixes what the old collection-only code silently dropped to `[]`).
     * Others have not been backfilled yet: their flat-parquet asset carries no
     * per-asset block and the hex asset lists only join keys, so the display
     * columns still live only in the collection-level block. Unioning both means
     * no dataset loses columns during the transition, and when the collection
     * block is finally retired the per-asset union already carries everything —
     * no consumer left behind.
     */
    extractColumns(collection) {
        const assets = collection.assets || {};

        // Rank an asset for collision preference: hex (H3-aware, primary query
        // target) > flat parquet (query target) > anything else.
        const rank = (asset) => {
            const href = asset.href || '';
            const type = asset.type || '';
            if (href.includes('/hex/') || Object.keys(asset).some(k => k.startsWith('h3:'))) return 0;
            if (type.includes('parquet') || href.includes('.parquet')) return 1;
            return 2;
        };

        // Per-asset blocks from the queryable parquet assets, hex first.
        const queryable = Object.values(assets)
            .filter(a => {
                if (!Array.isArray(a['table:columns']) || a['table:columns'].length === 0) return false;
                const type = a.type || '';
                const href = a.href || '';
                return type.includes('parquet') || href.includes('.parquet') || href.includes('/hex/');
            })
            .sort((a, b) => rank(a) - rank(b));

        // Descriptions and coded values by name, from the collection (where
        // Portolan puts them, PORTO-FMT-046) and then from any asset. A
        // per-asset list may carry only names and types (#441).
        const dictionary = new Map();
        for (const c of [...(collection['table:columns'] || []), ...Object.values(assets).flatMap(a => a['table:columns'] || [])]) {
            if (!c?.name) continue;
            const d = dictionary.get(c.name) || {};
            if (!d.description && c.description) d.description = c.description;
            if (!d.values?.length && c.values?.length) d.values = c.values;
            dictionary.set(c.name, d);
        }

        // Union: per-asset first (canonical), collection-level block as the trailer.
        const raw = [
            ...queryable.flatMap(a => a['table:columns']),
            ...(collection['table:columns'] || []),
        ];

        const seen = new Set();
        const columns = [];
        for (const col of raw) {
            const name = col.name;
            if (!name || ['geometry', 'geom'].includes(name.toLowerCase())) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            const values = col.values?.length ? col.values : dictionary.get(name)?.values;
            columns.push({
                name,
                type: col.type || 'string',
                description: col.description || dictionary.get(name)?.description || '',
                ...(values?.length ? { values } : {}),
            });
        }
        return columns;
    }

    extractProvider(collection) {
        const producers = (collection.providers || []).filter(p =>
            (p.roles || []).includes('producer')
        );
        return producers[0]?.name || 'Unknown';
    }

    extractAboutUrl(collection) {
        const about = (collection.links || []).find(l => l.rel === 'about');
        return about?.href || null;
    }

    extractDocUrl(collection) {
        const doc = (collection.links || []).find(l =>
            l.rel === 'describedby' || l.rel === 'documentation'
        );
        return doc?.href || null;
    }

    // ---- Public API ----

    /**
     * Get a dataset entry by collection ID.
     * @param {string} id
     * @returns {DatasetEntry|null}
     */
    get(id) {
        return this.datasets.get(id) || null;
    }

    /**
     * Get all dataset IDs.
     * @returns {string[]}
     */
    getIds() {
        return [...this.datasets.keys()];
    }

    /**
     * Get all dataset entries.
     * @returns {DatasetEntry[]}
     */
    getAll() {
        return [...this.datasets.values()];
    }

    /**
     * Find the STAC for a collection the app may read: a configured dataset,
     * or any collection below one. Children read at boot answer at once;
     * deeper ones are read on demand and kept. Nothing outside the configured
     * collections is ever searched (#441: an app knows only the collections
     * its layers-input.json lists).
     *
     * An id that matches no collection exactly is matched without regard to
     * case, as the MCP server did.
     *
     * @param {string} id
     * @returns {Promise<{doc: Object, url: string|null, children: Object[]}|null>}
     */
    async resolveStac(id) {
        if (!id) return null;
        let doc = this.datasets.get(id)?._rawStac || this.childCollections.get(id) || null;
        if (!doc) {
            const lower = String(id).toLowerCase();
            const known = [...this.datasets.keys(), ...this.childCollections.keys()].find(k => k.toLowerCase() === lower);
            if (known) return this.resolveStac(known);
            doc = await this._findBelowDatasets(id);
        }
        if (!doc) return null;
        const url = this.stacUrls.get(doc.id) || null;
        return { doc, url, children: await this._readChildren(doc, url) };
    }

    /** Search below each configured collection for an id, deepest last. @private */
    async _findBelowDatasets(id) {
        for (const ds of this.datasets.values()) {
            const url = this.stacUrls.get(ds.id);
            if (!url || !(ds._rawStac.links || []).some(l => l.rel === 'child')) continue;
            let hit;
            try {
                hit = (await findCollections(url, [id], { fetchJson: (u) => this.readJson(u) })).get(id);
            } catch { continue; }
            if (hit) {
                this.stacUrls.set(id, hit.url);
                this.childCollections.set(id, hit.doc);
                return hit.doc;
            }
        }
        return null;
    }

    /** A collection's sub-collections and sub-catalogs, read once. @private */
    async _readChildren(doc, url) {
        const held = this.datasets.get(doc.id)?._rawChildren;
        if (held) return held;
        const links = stacChildLinks(doc, url || this.catalogUrl);
        const read = await Promise.all(links.map(async (l) => {
            try {
                const child = await this.readJson(l.href);
                if (child?.id) {
                    this.stacUrls.set(child.id, l.href);
                    if (!this.childCollections.has(child.id)) this.childCollections.set(child.id, child);
                }
                return child;
            } catch (e) {
                console.warn(`[Catalog] Failed to fetch sub-collection: ${l.href}`, e.message);
                return null;
            }
        }));
        return read.filter(Boolean);
    }

    /**
     * Generate a text summary of all datasets for injection into the LLM system prompt.
     *
     * Two renderings (#294): a **full** front-load (title + Collection ID + full
     * description + provider + `read_parquet` paths + map layers) for small apps,
     * and a **compact index** (id + title + one-line summary + layer ids) above a
     * dataset-count threshold. The compact form drops the description, paths,
     * provider, and about-url — all of which arrive via `get_schema(dataset_id)`,
     * a call the model already makes before every query — so a large catalog's
     * ~34k-token cold prompt shrinks with zero added round-trips. Column schemas
     * are never front-loaded in either mode (they come from get_schema).
     *
     * @param {Object} [options]
     * @param {number} [options.compactAbove=8] - Use the compact index when the
     *   catalog has more than this many datasets. Small apps stay on the full
     *   front-load where the byte cost is negligible.
     * @param {boolean} [options.discovery=true] - Whether a dataset-discovery
     *   tool (`browse_stac_catalog`) is actually registered. Pass the registry's
     *   answer, not a config flag, so the prompt can never advertise a tool the
     *   model doesn't have — or stay silent about one it does (#354).
     */
    generatePromptCatalog(options = {}) {
        const compactAbove = options.compactAbove ?? 8;
        const discovery = options.discovery !== false;
        return this.datasets.size > compactAbove
            ? this._renderCompactCatalog(discovery)
            : this._renderFullCatalog(discovery);
    }

    /**
     * Closing line about data *outside* the configured set. With no discovery
     * tool registered, naming the closed door is what stops the model burning
     * turns on a tool that isn't there — the MCP server's own `query`
     * description still opens with "call `browse_stac_catalog` first", and we
     * can't edit that from here.
     * @private
     */
    _discoveryNote(discovery) {
        return discovery
            ? 'Use `browse_stac_catalog` / `get_stac_details` only for datasets not in this list.\n'
            : 'This app has no dataset-discovery tools, and this list is all the data it can reach. '
              + 'If asked about anything outside it, say so plainly rather than searching for it.\n';
    }

    /** Full front-load: every dataset's description, paths, provider, map layers. @private */
    _renderFullCatalog(discovery = true) {
        const preamble = 'The following datasets are pre-loaded for this app. Paths are shown below — use them directly in SQL. Call `get_schema(dataset_id)` before your first SQL query against a dataset to get column names and coded values.\n'
            + (discovery ? '' : this._discoveryNote(false));
        const sections = [preamble];

        for (const ds of this.datasets.values()) {
            // Parent container: has children but no own columns — render as directory node
            const isParentContainer = ds.columns.length === 0 && ds.childIds.length > 0;
            if (isParentContainer) {
                let section = `### ${ds.title}\n`;
                section += `**Collection ID:** ${ds.id}\n`;
                section += `**Description:** ${ds.description}\n`;
                const listed = ds.childIds.slice(0, 20);
                section += `Sub-datasets — call \`get_stac_details\` with one of these IDs:\n`;
                section += `  ${listed.join(', ')}\n`;
                if (ds.childIds.length > 20) {
                    section += `  (${ds.childIds.length - 20} more — call \`get_stac_details("${ds.id}")\` for the full list)\n`;
                }
                sections.push(section);
                continue;
            }

            let section = `### ${ds.title}\n`;
            section += `**Collection ID:** ${ds.id}\n`;
            section += `**Description:** ${ds.description}\n`;
            section += `**Provider:** ${ds.provider}\n`;

            // SQL assets with actual paths
            section += this._renderSqlPaths(ds);

            // Map layers for visualization
            if (ds.mapLayers.length > 0) {
                section += `\n**Map Layers (use with map tools):**\n`;
                for (const ml of ds.mapLayers) {
                    const layerId = `${ds.id}/${ml.assetId}`;
                    let layerLine = `- layer_id: \`${layerId}\` — ${ml.title} (${ml.layerType})`;
                    if (ml.versions?.length > 1) {
                        const labels = ml.versions.map(v => v.label).join(', ');
                        layerLine += ` [versions: ${labels}]`;
                    }
                    if (ml.toggleGroup) {
                        layerLine += ` [toggle group "${ml.toggleGroup}": one panel checkbox shows/hides every member together]`;
                    }
                    if (ml.defaultFilter) {
                        layerLine += ` [default filter: ${JSON.stringify(ml.defaultFilter)}]`;
                    }
                    if (ml.catalogStyle && this._stylesOnOffer(ml)) {
                        layerLine += ` [starts as published style \`${ml.catalogStyle}\`]`;
                    }
                    section += layerLine + '\n';
                }
                for (const g of this._styleGroups(ds)) {
                    section += `\n**Published styles (apply with apply_style) for ${this._styleGroupTarget(ds, g)}:**\n`;
                    for (const st of g.styles) section += `- \`${st.name}\`: ${describeStyleColours(st.paint)}\n`;
                }
            }

            if (ds.aboutUrl) {
                section += `\n**More info:** ${ds.aboutUrl}\n`;
            }

            sections.push(section);
        }

        return sections.join('\n---\n\n');
    }

    /**
     * A layer's published styles, when apply_style has something to offer:
     * one that isn't what the layer draws at start. Null otherwise, so a layer
     * whose only style is already on the map adds nothing to the prompt.
     * @private
     */
    _stylesOnOffer(ml) {
        const styles = ml.publishedStyles || [];
        return styles.some(st => st.name !== ml.catalogStyle) ? styles : null;
    }

    /**
     * A dataset's layers with published styles on offer, grouped by the set of
     * styles they share, so alias layers over one archive (one per attribute)
     * list their styles once rather than once each.
     * @private
     * @returns {Array<{layerIds: string[], styles: Object[]}>}
     */
    _styleGroups(ds) {
        const groups = new Map();
        for (const ml of ds.mapLayers) {
            const styles = this._stylesOnOffer(ml);
            if (!styles) continue;
            const sig = styles.map(st => st.name).join('\n');
            if (!groups.has(sig)) groups.set(sig, { layerIds: [], styles });
            groups.get(sig).layerIds.push(`${ds.id}/${ml.assetId}`);
        }
        return [...groups.values()];
    }

    /** Which layers a style group is for, in the fewest words. @private */
    _styleGroupTarget(ds, g) {
        if (g.layerIds.length === ds.mapLayers.length) return g.layerIds.length === 1 ? 'this layer' : 'each layer above';
        if (g.layerIds.length === 1) return `\`${g.layerIds[0]}\``;
        return g.layerIds.map(id => `\`${id}\``).join(', ');
    }

    /**
     * A map layer by its `<collection>/<asset>` id, with its dataset.
     * @returns {{dataset: Object, layer: Object}|null}
     */
    findMapLayer(layerId) {
        for (const ds of this.datasets.values()) {
            const layer = ds.mapLayers?.find(ml => `${ds.id}/${ml.assetId}` === layerId);
            if (layer) return { dataset: ds, layer };
        }
        return null;
    }

    /**
     * Compact index for large catalogs (#294): one line per dataset —
     * `id — title — one-line summary` (+ map layer ids for map datasets). The
     * full description, `read_parquet` paths, provider, and about-url are
     * intentionally omitted; they arrive via `get_schema(dataset_id)`, which the
     * model calls before querying. This reinforces the get-schema-first flow
     * (AGENTS.md: never guess S3 paths) while cutting the cold-prompt bytes.
     * @private
     */
    _renderCompactCatalog(discovery = true) {
        const preamble = 'The datasets pre-loaded for this app are indexed below as `id` — title — summary. '
            + 'Before querying a dataset, call `get_schema(dataset_id)`: it returns the `read_parquet()` path, '
            + 'column names, types, coded values, and the full description. '
            + this._discoveryNote(discovery);
        const lines = [preamble];

        for (const ds of this.datasets.values()) {
            const isParentContainer = ds.columns.length === 0 && ds.childIds.length > 0;
            if (isParentContainer) {
                const listed = ds.childIds.slice(0, 20).join(', ');
                const more = ds.childIds.length > 20
                    ? ` (+${ds.childIds.length - 20} more via get_stac_details("${ds.id}"))`
                    : '';
                lines.push(`- \`${ds.id}\` — **${ds.title}** — container; sub-datasets: ${listed}${more}`);
                continue;
            }

            const summary = this._oneLine(ds.description);
            let line = `- \`${ds.id}\` — **${ds.title}**${summary ? ` — ${summary}` : ''}`;
            if (ds.mapLayers.length > 0) {
                // A layer's styles go inline; a set several layers share
                // (alias layers over one archive) gets one line of its own.
                const groups = this._styleGroups(ds);
                const shared = groups.filter(g => g.layerIds.length > 1);
                const names = (styles, start) => styles.map(st => `\`${st.name}\`${st.name === start ? ' (on at start)' : ''}`).join(', ');
                const layers = ds.mapLayers
                    .map(ml => {
                        const id = `${ds.id}/${ml.assetId}`;
                        const styles = this._stylesOnOffer(ml);
                        let extra = '';
                        if (styles && shared.some(g => g.layerIds.includes(id))) {
                            if (ml.catalogStyle) extra = `, starts as \`${ml.catalogStyle}\``;
                        } else if (styles) {
                            extra = `; published styles: ${names(styles, ml.catalogStyle)}`;
                        }
                        return `\`${id}\` (${ml.layerType}${extra})`;
                    })
                    .join(', ');
                line += `\n  map layers: ${layers}`;
                for (const g of shared) {
                    line += `\n  published styles for ${this._styleGroupTarget(ds, g)} (apply_style): ${names(g.styles, null)}`;
                }
            }
            lines.push(line);
        }

        return lines.join('\n');
    }

    /**
     * A compact one-line stand-in for a dataset description: the first sentence
     * if it's a reasonable length, else the collapsed text, capped. Full text is
     * available via get_schema, so this only needs to help the model *select* a
     * dataset. @private
     */
    _oneLine(text, cap = 160) {
        if (!text) return '';
        const collapsed = text.replace(/\s+/g, ' ').trim();
        const sentence = collapsed.match(/^(.{12,}?[.!?])(\s|$)/);
        let s = sentence ? sentence[1] : collapsed;
        if (s.length > cap) s = s.slice(0, cap - 1).trimEnd() + '…';
        return s;
    }

    /**
     * Render SQL asset paths only (no columns) for the system prompt.
     * Uses the client-direct parquetAssets extracted during load().
     * @private
     */
    _renderSqlPaths(ds) {
        if (ds.parquetAssets.length === 0) return '';
        let out = '\n**SQL assets:**\n';
        for (const pa of ds.parquetAssets) {
            out += `- ${pa.title}: \`read_parquet('${pa.s3Path}')\`\n`;
        }
        return out;
    }

    /**
     * Generate a flat list of all map layer IDs and their configs.
     * Used by MapManager to create layers.
     * 
     * @returns {Array<{layerId: string, datasetId: string, config: Object}>}
     */
    getMapLayerConfigs() {
        const configs = [];

        // Iterate in the order specified by appConfig.collections so that
        // layer insertion order on the map matches the user's config order.
        const orderedIds = this.appConfig?.collections
            ? this.appConfig.collections.map(c => typeof c === 'string' ? c : c.collection_id)
            : [...this.datasets.keys()];

        for (const id of orderedIds) {
            const ds = this.datasets.get(id);
            if (!ds) continue;
            for (const ml of ds.mapLayers) {
                const layerId = `${ds.id}/${ml.assetId}`;

                // Panel membership (#352): asset-level `sidebar` wins, else the
                // collection's, else true. Only the panel row is suppressed —
                // the layer is registered and stays agent-addressable.
                const sidebar = ml.sidebar ?? ds.sidebar ?? true;
                if (!sidebar && ml.defaultVisible) {
                    console.warn(
                        `[Catalog] Layer "${layerId}" is configured "sidebar": false with ` +
                        `"visible": true — it draws on load but has no panel checkbox, ` +
                        `so only the assistant can turn it off.`
                    );
                }

                // ── Versioned layer: build per-version configs for MapManager ──
                if (ml.versions && ml.versions.length > 0) {
                    const versionConfigs = ml.versions.map(v => {
                        if (v.layerType === 'vector' && v.sourceType === 'geojson') {
                            const srcKey = v.assetId.replace(/[^a-zA-Z0-9]/g, '-');
                            return {
                                label: v.label,
                                type: 'vector',
                                sourceId: `src-${ds.id.replace(/[^a-zA-Z0-9]/g, '-')}-${srcKey}`,
                                source: { type: 'geojson', data: v.url },
                            };
                        } else if (v.layerType === 'vector') {
                            const srcKey = v.assetId.replace(/[^a-zA-Z0-9]/g, '-');
                            return {
                                label: v.label,
                                type: 'vector',
                                sourceId: `src-${ds.id.replace(/[^a-zA-Z0-9]/g, '-')}-${srcKey}`,
                                source: { type: 'vector', url: `pmtiles://${v.url}` },
                                sourceLayer: v.sourceLayer,
                            };
                        } else {
                            const tilesUrl = cogTileUrl(this.titilerUrl, v.cogUrl, {
                                legendType: ml.legendType,
                                legendClasses: v.legendClasses,
                                colormap: v.colormap || ml.colormap,
                                rescale: v.rescale || ml.rescale,
                                nodata: v.nodata,
                                bidx: v.bidx,
                                unscale: v.unscale,
                            });
                            return {
                                label: v.label,
                                type: 'raster',
                                colormap: v.colormap || null,
                                rescale: v.rescale || null,
                                sourceId: `src-${ds.id.replace(/[^a-zA-Z0-9]/g, '-')}-${v.assetId.replace(/[^a-zA-Z0-9]/g, '-')}`,
                                source: { type: 'raster', tiles: [tilesUrl], tileSize: 256 },
                            };
                        }
                    });

                    configs.push({
                        layerId,
                        datasetId: ds.id,
                        group: ml.group || ds.group,
                        groupCollapsed: ds.groupCollapsed || false,
                        sidebar,
                        toggleGroup: ml.toggleGroup || null,
                        displayName: ml.title,
                        type: ml.layerType,
                        paint: ml.defaultStyle || (ml.layerType === 'raster'
                            ? (ml.paint || { 'raster-opacity': 0.7 })
                            : { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 }),
                        outlinePaint: ml.outlineStyle || null,
                        renderType: ml.renderType || null,
                        columns: ds.columns,
                        tooltipFields: ml.tooltipFields || null,
                        defaultVisible: ml.defaultVisible || false,
                        defaultFilter: ml.defaultFilter || null,
                        ...(ml.styleFilter && { styleFilter: ml.styleFilter }),
                        colormap: ml.colormap || null,
                        rescale: ml.rescale || null,
                        legendLabel: ml.legendLabel || null,
                        legendType: ml.legendType || null,
                        legendClasses: ml.legendClasses || null,
                        legendRange: ml.legendRange || null,
                        legendGradient: ml.legendGradient || null,
                        control: ml.control || null,
                        // Versioned metadata
                        versions: versionConfigs,
                        defaultVersionIndex: ml.defaultVersionIndex,
                    });
                    continue;
                }

                // ── Standard (non-versioned) layer ──
                if (ml.layerType === 'vector') {
                    // Use original STAC asset key for source ID so alias layers share one source
                    const sourceAssetKey = (ml.sourceAssetId || ml.assetId).replace(/[^a-zA-Z0-9]/g, '-');
                    const sharedSourceId = `src-${ds.id.replace(/[^a-zA-Z0-9]/g, '-')}-${sourceAssetKey}`;

                    const isGeoJson = ml.sourceType === 'geojson';
                    const layerConfig = {
                        layerId,
                        datasetId: ds.id,
                        group: ml.group || ds.group,
                        groupCollapsed: ds.groupCollapsed || false,
                        sidebar,
                        toggleGroup: ml.toggleGroup || null,
                        displayName: ml.title,
                        type: 'vector',
                        sourceId: sharedSourceId,
                        source: isGeoJson
                            ? { type: 'geojson', data: ml.url }
                            : { type: 'vector', url: `pmtiles://${ml.url}` },
                        paint: ml.defaultStyle || { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 },
                        outlinePaint: ml.outlineStyle || null,
                        renderType: ml.renderType || null,
                        columns: ds.columns,
                        tooltipFields: ml.tooltipFields || null,
                        defaultVisible: ml.defaultVisible || false,
                        defaultFilter: ml.defaultFilter || null,
                        ...(ml.styleFilter && { styleFilter: ml.styleFilter }),
                        legendLabel: ml.legendLabel || null,
                        legendType: ml.legendType || null,
                        legendClasses: ml.legendClasses || null,
                        legendRange: ml.legendRange || null,
                        legendGradient: ml.legendGradient || null,
                        animation: ml.animation || null,
                        control: ml.control || null,
                        tracksUrl: isGeoJson ? ml.url : null,
                    };
                    if (!isGeoJson) layerConfig.sourceLayer = ml.sourceLayer;

                    configs.push(layerConfig);
                } else if (ml.layerType === 'raster') {
                    const tilesUrl = cogTileUrl(this.titilerUrl, ml.cogUrl, ml);

                    configs.push({
                        layerId,
                        datasetId: ds.id,
                        group: ml.group || ds.group,
                        groupCollapsed: ds.groupCollapsed || false,
                        sidebar,
                        toggleGroup: ml.toggleGroup || null,
                        displayName: ml.title,
                        type: 'raster',
                        defaultVisible: ml.defaultVisible || false,
                        colormap: ml.colormap,
                        rescale: ml.rescale,
                        legendLabel: ml.legendLabel,
                        legendType: ml.legendType,
                        legendClasses: ml.legendClasses,
                        source: {
                            type: 'raster',
                            tiles: [tilesUrl],
                            tileSize: 256,
                        },
                        paint: ml.paint || { 'raster-opacity': 0.7 },
                        columns: [], // rasters don't have filterable columns
                        // A time series (#421): where its frames are listed, and
                        // the tile URL for any one frame, styled like the layer.
                        ...(ml.frameSource && {
                            control: ml.control,
                            frameSource: ml.frameSource,
                            frameTileUrl: (href) => cogTileUrl(this.titilerUrl, href, ml),
                        }),
                    });
                }
            }
        }

        return configs;
    }

    // ---- Utilities ----

    /**
     * fetchJson, once per URL. The boot walk, the child expansion and later
     * lookups share it, so no STAC document is read twice. A failed read is
     * forgotten, so a later call tries again.
     */
    readJson(url) {
        if (!this._docs.has(url)) {
            const p = this.fetchJson(url);
            this._docs.set(url, p);
            p.catch(() => this._docs.delete(url));
        }
        return this._docs.get(url);
    }

    async fetchJson(url, { attempts = 3, baseDelayMs = 300 } = {}) {
        // The catalog fetch is on the boot critical path, so a single transient
        // blip on the object store (a 5xx, a network drop) must not take the
        // whole app down. Retry transient failures with exponential backoff;
        // permanent failures (4xx, malformed JSON) still fail fast. Mirrors the
        // transient-vs-permanent split in agent.js._isTransientLLMError.
        for (let attempt = 1; ; attempt++) {
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    const err = new Error(`HTTP ${response.status}: ${url}`);
                    err.status = response.status;
                    throw err;
                }
                return await response.json();
            } catch (error) {
                if (attempt >= attempts || !this._isTransientFetchError(error)) throw error;
                const delayMs = baseDelayMs * 2 ** (attempt - 1);
                console.warn(`[Catalog] Transient fetch error for ${url} (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    /**
     * Classify a fetch failure as transient (worth retrying) or permanent.
     * Retry on: network errors (surface as TypeError), HTTP 5xx.
     * Skip on: HTTP 4xx (bad/missing URL), JSON parse errors, anything else.
     */
    _isTransientFetchError(error) {
        if (error.name === 'TypeError') return true;
        if (typeof error.status === 'number' && error.status >= 500 && error.status < 600) return true;
        return false;
    }
}
