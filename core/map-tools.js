/**
 * map-tools.js — The local tools of glen core: visual control of the map.
 *
 * Every tool acts on the page; none reads or queries data on a server. The
 * map-control tools come from app/map-control-tools.js, shared with the full
 * app; this module adds the tools a Portolan catalog makes possible and the
 * description hints that point at them. Extensions add their own tools
 * through the plugin context (see main.js).
 */

import { describeColor } from './portolan.js';
import {
    createMapControlTools,
    createProjectionTool,
    PICK_LAYER_NUDGE,
} from '../app/map-control-tools.js';

/**
 * Descriptions that point the agent at what a Portolan catalog provides:
 * the published styles and describe_layer, and no SQL.
 */
export const PORTOLAN_HINTS = Object.freeze({
    filterValues: 'IMPORTANT: Never guess categorical values used in filters. Use the values a published style lists in your system prompt, values from describe_layer, or values the user gave.',
    styleValues: 'IMPORTANT: For categorical coloring (e.g., a "match" expression), never guess or assume valid values. Use the values a published style lists in your system prompt, values from describe_layer, or values the user gave. Prefer apply_style when a published style matches the request. Raster colors change with set_raster_colormap, not here.',
    tooltipFields: 'Property names must exactly match the feature properties in the vector tiles, as listed for the layer in your system prompt or by describe_layer. Unknown names render nothing (no error).',
});

const json = (x) => JSON.stringify(x);

/**
 * glen's map-control tools, set up for a Portolan catalog, plus the three
 * tools only a Portolan catalog supports: apply_style, set_raster_colormap
 * and describe_layer.
 *
 * @param {import('../app/map-manager.js').MapManager} mapManager
 * @param {import('./portolan-catalog.js').PortolanCatalog} catalog
 * @param {Object} [options]
 * @param {{forwardGeocode: Function}|null} [options.geocoder]
 * @returns {Array<Object>} tool definitions for ToolRegistry.registerLocal
 */
export function createCoreMapTools(mapManager, catalog, { geocoder = null } = {}) {
    const unknown = (id) => ({ success: false, error: `Unknown layer: ${id}. Available: ${[...catalog.layers.keys()].join(', ')}` });

    return [
        ...createMapControlTools(mapManager, {
            geocoder,
            hints: PORTOLAN_HINTS,
            layerExtent: (id) => layerExtent(catalog, id),
            reportView: true,
            // Rasters are TiTiler tiles; their "style" is the colour map in the URL.
            resetStyle: (id) => {
                const l = catalog.layers.get(id);
                if (l?.kind !== 'raster') return undefined;
                return setRasterColormap(mapManager, catalog, id, { colormap: l.defaultColormap, rescale: l.defaultRescale });
            },
        }),
        createProjectionTool(mapManager),
        {
            name: 'apply_style',
            description: `Apply one of the styles the data publisher made for a vector layer. The system prompt lists each layer's published styles and what each colours by. Prefer a published style over writing your own paint when one matches the request.

${PICK_LAYER_NUDGE}`,
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
}

/** A layer's published extent as [w, s, e, n], or null. */
export function layerExtent(catalog, layerId) {
    const l = catalog.layers.get(layerId);
    const b = l && catalog.datasets.get(l.datasetId)?.bbox;
    if (!b) return null;
    return b.length === 6 ? [b[0], b[1], b[3], b[4]] : b;
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
