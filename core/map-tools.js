/**
 * map-tools.js — The local tools of glen core: visual control of the map.
 *
 * Every tool acts on the page; none reads or queries data on a server. They
 * drive glen's MapManager (app/map-manager.js) and read layer metadata from
 * the PortolanCatalog. Extensions add their own tools beside these through
 * the plugin context (see main.js).
 */

import { describeColor } from './portolan.js';

// A paint value that is a number or an expression. `items: {}` keeps a
// grammar-constrained decoder from collapsing the array to [] (glen#243).
const NUM_OR_EXPR = { type: ['number', 'array'], items: {} };

const PICK_LAYER = 'Use a layer_id from the Layers section of the system prompt. Pick the layer by its title, not by guessing from the id.';

const json = (x) => JSON.stringify(x);

/**
 * @param {import('../app/map-manager.js').MapManager} mapManager
 * @param {import('./portolan-catalog.js').PortolanCatalog} catalog
 * @param {Object} [options]
 * @param {{forwardGeocode: Function}|null} [options.geocoder]
 * @returns {Array<Object>} tool definitions for ToolRegistry.registerLocal
 */
export function createCoreMapTools(mapManager, catalog, { geocoder = null } = {}) {
    const unknown = (id) => ({ success: false, error: `Unknown layer: ${id}. Available: ${[...catalog.layers.keys()].join(', ')}` });

    const tools = [
        {
            name: 'show_layer',
            description: `Turn a layer on. Use when the user asks to show, display or add a layer.\n\n${PICK_LAYER}`,
            inputSchema: {
                type: 'object',
                properties: { layer_id: { type: 'string', description: 'Layer to show' } },
                required: ['layer_id'],
            },
            execute: (args) => {
                const r = mapManager.showLayer(args.layer_id);
                if (r.success) mapManager.syncCheckbox(args.layer_id);
                return json(r);
            },
        },
        {
            name: 'hide_layer',
            description: 'Turn a layer off. Use when the user asks to hide, remove or turn off a layer.',
            inputSchema: {
                type: 'object',
                properties: { layer_id: { type: 'string', description: 'Layer to hide' } },
                required: ['layer_id'],
            },
            execute: (args) => {
                const r = mapManager.hideLayer(args.layer_id);
                if (r.success) mapManager.syncCheckbox(args.layer_id);
                return json(r);
            },
        },
        {
            name: 'set_filter',
            description: `Show only the features of a vector layer that match a MapLibre filter expression.

Use the property names listed for the layer in the system prompt, exactly as written (they are case sensitive). Use only values you have seen: the categories a published style lists, values the user gave, or values from describe_layer. Never guess a category.

Expression forms:
- equal: ["==", ["get", "prop"], "value"]
- compare: [">=", ["get", "prop"], 100]
- one of: ["match", ["get", "prop"], ["a", "b"], true, false]
- and / or: ["all", f1, f2] / ["any", f1, f2]
- missing values: ["!", ["has", "prop"]]

Do not use the legacy ["in", "prop", a, b] form; MapLibre ignores it.

${PICK_LAYER}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer to filter' },
                    filter: { type: 'array', items: {}, description: 'MapLibre filter expression' },
                },
                required: ['layer_id', 'filter'],
            },
            execute: (args) => json(mapManager.setFilter(args.layer_id, args.filter)),
        },
        {
            name: 'clear_filter',
            description: 'Remove every filter from a layer, including one it started with, so all features show.',
            inputSchema: {
                type: 'object',
                properties: { layer_id: { type: 'string' } },
                required: ['layer_id'],
            },
            execute: (args) => json(mapManager.clearFilter(args.layer_id)),
        },
        {
            name: 'reset_filter',
            description: 'Return a layer to the filter it had when the app loaded.',
            inputSchema: {
                type: 'object',
                properties: { layer_id: { type: 'string' } },
                required: ['layer_id'],
            },
            execute: (args) => json(mapManager.resetFilter(args.layer_id)),
        },
        {
            name: 'apply_style',
            description: `Apply one of the styles the data publisher made for a vector layer. The system prompt lists each layer's published styles and what each colours by. Prefer a published style over writing your own paint when one matches the request.

${PICK_LAYER}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer' },
                    style: { type: 'string', description: 'Style name, e.g. "categorical" or "graduated"' },
                },
                required: ['layer_id', 'style'],
            },
            execute: (args) => json(applyPublishedStyle(mapManager, catalog, args.layer_id, args.style)),
        },
        {
            name: 'set_style',
            description: `Change the paint of a layer with MapLibre paint properties. Each property name starts with the layer's drawing type: \`fill-\` for polygons, \`line-\` for lines, \`circle-\` for points, \`raster-\` for rasters (only raster-opacity and similar; use set_raster_colormap for raster colours).

Colour by a property:
  categories: {"fill-color": ["match", ["get", "prop"], "a", "#1b9e77", "b", "#d95f02", "#cccccc"]}
  ramp:       {"fill-color": ["interpolate", ["linear"], ["get", "prop"], 0, "#fee6ce", 100, "#e6550d"]}
  classes:    {"fill-color": ["step", ["get", "prop"], "#ffffcc", 10, "#a1dab4", 50, "#253494"]}

Take category values and numeric ranges from the system prompt or describe_layer; never invent them. The legend follows the paint.

A ramp or step paints features that lack the property black. Hide them through the opacity, leaving the colour expression whole so the legend can read it: {"fill-opacity": ["case", ["==", ["typeof", ["get", "prop"]], "number"], 0.6, 0]}.

${PICK_LAYER}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer to style' },
                    style: {
                        type: 'object',
                        description: 'MapLibre paint properties, e.g. {"fill-color": "#ff0000", "fill-opacity": 0.8}. An object, never a string.',
                        properties: {
                            'fill-color': { description: 'Fill colour or expression' },
                            'fill-opacity': { ...NUM_OR_EXPR, description: 'Fill opacity 0–1' },
                            'fill-outline-color': { description: 'Fill outline colour' },
                            'line-color': { description: 'Line colour or expression' },
                            'line-width': { ...NUM_OR_EXPR, description: 'Line width in pixels' },
                            'line-opacity': { ...NUM_OR_EXPR, description: 'Line opacity 0–1' },
                            'circle-color': { description: 'Circle colour or expression' },
                            'circle-radius': { ...NUM_OR_EXPR, description: 'Circle radius in pixels' },
                            'circle-opacity': { ...NUM_OR_EXPR, description: 'Circle opacity 0–1' },
                            'raster-opacity': { ...NUM_OR_EXPR, description: 'Raster opacity 0–1' },
                        },
                        additionalProperties: true,
                    },
                },
                required: ['layer_id', 'style'],
            },
            execute: (args) => json(mapManager.setStyle(args.layer_id, args.style)),
        },
        {
            name: 'reset_style',
            description: 'Return a layer to the paint it had when the app loaded.',
            inputSchema: {
                type: 'object',
                properties: { layer_id: { type: 'string' } },
                required: ['layer_id'],
            },
            execute: (args) => {
                const l = catalog.layers.get(args.layer_id);
                if (l?.kind === 'raster') {
                    return json(setRasterColormap(mapManager, catalog, args.layer_id, { colormap: l.defaultColormap, rescale: l.defaultRescale }));
                }
                return json(mapManager.resetStyle(args.layer_id));
            },
        },
        {
            name: 'set_raster_colormap',
            description: `Recolour a raster (COG) layer: pick a colour map and the value range it spans. Values below the range take the first colour and values above take the last, so narrow the range to show detail in the bulk of the data. The system prompt gives each raster's minimum, maximum and mean.

Colour maps: viridis, magma, inferno, plasma, cividis, ylorrd, ylgnbu, blues, greens, reds, oranges, purples, greys, rdylgn, rdylbu, spectral, rdbu, brbg (append _r to reverse, e.g. viridis_r).`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Raster layer' },
                    colormap: { type: 'string', description: 'Colour map name' },
                    min: { type: 'number', description: 'Value at the first colour' },
                    max: { type: 'number', description: 'Value at the last colour' },
                },
                required: ['layer_id'],
            },
            execute: (args) => {
                const rescale = (args.min != null && args.max != null) ? `${args.min},${args.max}` : undefined;
                return json(setRasterColormap(mapManager, catalog, args.layer_id, { colormap: args.colormap, rescale }));
            },
        },
        {
            name: 'set_tooltip',
            description: 'Choose which feature properties show when the pointer is over a vector layer, in order. Pass [] to turn the tooltip off.',
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string' },
                    fields: { type: 'array', items: { type: 'string' }, description: 'Property names, exactly as listed for the layer' },
                },
                required: ['layer_id', 'fields'],
            },
            execute: (args) => json(mapManager.setTooltip(args.layer_id, args.fields)),
        },
        {
            name: 'reset_tooltip',
            description: 'Return a layer to the tooltip fields it had when the app loaded.',
            inputSchema: {
                type: 'object',
                properties: { layer_id: { type: 'string' } },
                required: ['layer_id'],
            },
            execute: (args) => json(mapManager.resetTooltip(args.layer_id)),
        },
        {
            name: 'set_legend',
            description: 'Label a layer\'s legend: a title, units for a colour bar, or names for category values (keys are the values in the layer\'s match expression, as strings). Colours always follow the paint, so change those with set_style.',
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string' },
                    title: { type: 'string', description: 'Legend heading' },
                    units: { type: 'string', description: 'Unit after a colour bar\'s end values' },
                    labels: { type: 'object', additionalProperties: { type: 'string' }, description: 'Category value → label' },
                    visible: { type: 'boolean', description: 'false hides this legend' },
                },
                required: ['layer_id'],
            },
            execute: (args) => json(mapManager.setLegend(args.layer_id, {
                labels: args.labels, title: args.title, units: args.units, visible: args.visible,
            })),
        },
        {
            name: 'reset_legend',
            description: 'Remove labels, title and units set with set_legend.',
            inputSchema: {
                type: 'object',
                properties: { layer_id: { type: 'string' } },
                required: ['layer_id'],
            },
            execute: (args) => json(mapManager.resetLegend(args.layer_id)),
        },
        {
            name: 'fly_to',
            description: `Move the map. Give one of:
- layer_id: frame the whole extent of that layer's data;
- bbox: [west, south, east, north] in degrees;
- center: [longitude, latitude] (longitude first), with an optional zoom (0–22).
For a named place, call geocode first; never recall coordinates from memory.`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Frame this layer\'s extent' },
                    bbox: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north]' },
                    center: { type: 'array', items: { type: 'number' }, description: '[longitude, latitude]' },
                    zoom: { type: 'number', description: 'Zoom level 0–22' },
                },
            },
            execute: (args) => json(flyTo(mapManager, catalog, args)),
        },
        {
            name: 'get_map_state',
            description: 'Report what the map shows now: each layer\'s visibility, filter, paint and legend, and the view. Use it before changing a layer you have already changed.',
            inputSchema: { type: 'object', properties: {} },
            execute: () => {
                const state = mapManager.getMapState();
                const m = mapManager.map;
                const c = m.getCenter();
                return json({ ...state, view: { center: [round(c.lng, 4), round(c.lat, 4)], zoom: round(m.getZoom(), 2) } });
            },
        },
        {
            name: 'describe_layer',
            description: 'Full metadata for one layer: every feature property with its description, the published styles with the values or range each colours by, raster statistics, license, and links to the publisher\'s README and agent guide.',
            inputSchema: {
                type: 'object',
                properties: { layer_id: { type: 'string' } },
                required: ['layer_id'],
            },
            execute: (args) => {
                const l = catalog.layers.get(args.layer_id);
                if (!l) return json(unknown(args.layer_id));
                return json({ success: true, ...describeLayer(catalog, l) });
            },
        },
    ];

    if (geocoder) {
        tools.push({
            name: 'geocode',
            description: 'Find the coordinates of a named place (address, town, landmark, region). Call it whenever the user names a place, then fly_to the result. Never recall coordinates from memory.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The place, with enough context to be unambiguous' },
                    limit: { type: 'number', description: 'Maximum results (default 5)' },
                },
                required: ['query'],
            },
            execute: async (args) => {
                try {
                    const results = await geocoder.forwardGeocode(args.query, { limit: args.limit ?? 5 });
                    if (!results.length) return json({ success: true, count: 0, results: [], message: `No location found for "${args.query}".` });
                    return json({ success: true, count: results.length, source: results[0].source, results });
                } catch (err) {
                    return json({ success: false, error: `Geocoding failed: ${err.message}` });
                }
            },
        });
    }
    return tools;
}

/** Apply a named published style to a vector layer. */
export function applyPublishedStyle(mapManager, catalog, layerId, name) {
    const l = catalog.layers.get(layerId);
    if (!l) return { success: false, error: `Unknown layer: ${layerId}` };
    if (l.kind !== 'vector') return { success: false, error: `${layerId} is a raster; use set_raster_colormap.` };
    const s = l.styles.get(name);
    if (!s) {
        return { success: false, error: `No style "${name}" for ${layerId}. Published styles: ${[...l.styles.keys()].join(', ') || 'none'}` };
    }
    if (s.renderType !== l.renderType) {
        return { success: false, error: `Style "${name}" draws ${s.renderType} layers but ${layerId} is drawn as ${l.renderType}.` };
    }
    const result = mapManager.setStyle(layerId, s.paint);
    if (!result.success) return result;
    // A style may carry its own filter. Swap it in, and drop the previous
    // style's filter rather than leaving it applied under the new style.
    const state = mapManager.layers.get(layerId);
    const prev = l.activeStyleFilter ?? l.filter;
    if (s.filter) mapManager.setFilter(layerId, s.filter);
    else if (prev && JSON.stringify(state?.filter) === JSON.stringify(prev)) mapManager.clearFilter(layerId);
    l.activeStyleFilter = s.filter || null;
    l.activeStyle = name;
    return { success: true, layer: layerId, style: name, colours_by: describeColor(s.paint) };
}

/** Rebuild a raster layer's tile URL with a new colour map or range. */
export function setRasterColormap(mapManager, catalog, layerId, { colormap, rescale } = {}) {
    const l = catalog.layers.get(layerId);
    if (!l) return { success: false, error: `Unknown layer: ${layerId}` };
    if (l.kind !== 'raster') return { success: false, error: `${layerId} is a vector layer; use set_style or apply_style.` };
    if (l.band?.classes) return { success: false, error: `${layerId} is categorical; its colours come from the publisher's class list.` };
    if (colormap) l.colormap = String(colormap).toLowerCase();
    if (rescale) l.rescale = rescale;
    const state = mapManager.layers.get(layerId);
    if (!state || !mapManager.map.getSource(state.sourceId)) return { success: false, error: `Raster source for ${layerId} is missing.` };
    replaceRasterTiles(mapManager.map, state.sourceId, state.mapLayerId, catalog.rasterTileUrl(l));
    state.colormap = l.colormap;
    state.rescale = l.rescale;
    mapManager._refreshLegend?.(layerId);
    return { success: true, layer: layerId, colormap: l.colormap, range: l.rescale };
}

/**
 * Point a raster layer at a new tile URL. RasterTileSource#setTiles throws
 * inside the renderer in MapLibre 5.22 while tiles are in flight, so remove
 * the layer and source and add them back at the same place in the stack.
 */
function replaceRasterTiles(map, sourceId, mapLayerId, tileUrl) {
    const style = map.getStyle();
    const idx = style.layers.findIndex(x => x.id === mapLayerId);
    const def = style.layers[idx];
    const beforeId = style.layers[idx + 1]?.id;
    const src = style.sources[sourceId];
    map.removeLayer(mapLayerId);
    map.removeSource(sourceId);
    map.addSource(sourceId, { ...src, tiles: [tileUrl] });
    map.addLayer(def, beforeId);
}

/** fly_to: a layer's extent, a bbox, or a centre and zoom. */
export function flyTo(mapManager, catalog, { layer_id, bbox, center, zoom } = {}) {
    if (layer_id) {
        const l = catalog.layers.get(layer_id);
        const ds = l && catalog.datasets.get(l.datasetId);
        if (!ds?.bbox) return { success: false, error: l ? `${layer_id} has no published extent.` : `Unknown layer: ${layer_id}` };
        bbox = ds.bbox.length === 6 ? [ds.bbox[0], ds.bbox[1], ds.bbox[3], ds.bbox[4]] : ds.bbox;
    }
    if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)) {
        const [w, s, e, n] = bbox;
        if (s > n || Math.abs(s) > 90 || Math.abs(n) > 90) return { success: false, error: 'bbox must be [west, south, east, north] in degrees.' };
        mapManager.map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 16 });
        return { success: true, bbox: [w, s, e, n] };
    }
    if (Array.isArray(center) && center.length === 2) {
        if (Math.abs(center[1]) > 90) return { success: false, error: 'center is [longitude, latitude]; the latitude is out of range.' };
        return mapManager.flyTo({ center, zoom });
    }
    return { success: false, error: 'Give layer_id, bbox, or center.' };
}

/** Everything the catalog knows about one layer, for describe_layer. */
export function describeLayer(catalog, l) {
    const ds = catalog.datasets.get(l.datasetId);
    const desc = new Map((ds?.columns || []).map(c => [c.name, c.description]));
    const base = {
        layer_id: l.layerId,
        title: l.title,
        collection: ds?.id,
        description: ds?.description,
        license: ds?.license,
        producers: ds?.producers,
        host: ds?.host,
        portolan_version: ds?.portolanVersion,
        collection_url: ds?.url,
        agents_guide: ds?.agentsUrl,
    };
    if (l.kind === 'raster') {
        return { ...base, kind: 'raster', band: l.band, colormap: l.colormap, range: l.rescale };
    }
    return {
        ...base,
        kind: 'vector',
        geometry: l.geometryType,
        drawn_as: l.renderType,
        properties: Object.entries(l.fields).map(([name, type]) => ({ name, type, description: desc.get(name) || null })),
        styles: [...l.styles.entries()].map(([name, s]) => ({ name, title: s.title, colours_by: describeColor(s.paint) })),
        active_style: l.activeStyle || l.defaultStyle,
    };
}

function round(v, d) {
    const f = 10 ** d;
    return Math.round(v * f) / f;
}
