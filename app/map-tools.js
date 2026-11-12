import { createHexTileTools } from './hex-tools.js';
import { createFilterByQueryTool } from './query-filter-tool.js';
import { legendFromPaint } from './legend-helpers.js';
import { describeColor } from './published-styles.js';
import {
    createMapControlTools,
    createProjectionTool,
    PICK_LAYER_NUDGE,
    SQL_HINTS,
} from './map-control-tools.js';

// Re-exported so existing importers keep resolving it here.
export { getCurrentPositionAsync } from './map-control-tools.js';

/**
 * Map Tools - Local tool definitions for the LLM agent
 *
 * Defines the tools the agent uses to control the map and query dataset metadata.
 * Each tool has: name, description, inputSchema, execute function.
 * 
 * Tools:
 *   Map control:
 *     - show_layer / hide_layer
 *     - set_filter / clear_filter
 *     - set_style / reset_style
 *     - get_map_state
 *     - fly_to
 *   Dataset knowledge:
 *     - list_datasets (get_schema and get_stac_details are in catalog-tools.js)
 */

// add_hex_tile_layer and remove_hex_tile_layer are shared with glen core's hex plugin.
export { createHexTileTools } from './hex-tools.js';
// set_time is shared with glen core (#462); re-exported so imports keep working.
export { createSetTimeTool } from './map-control-tools.js';
// render_chart lives in chart-tool.js, shared with glen core's charts plugin.
export { extractJsonArray, createRenderChartTool } from './chart-tool.js';

/**
 * Generate all local tools given the app's MapManager and DatasetCatalog.
 *
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {import('./dataset-catalog.js').DatasetCatalog} catalog
 * @param {import('./mcp-client.js').MCPClient} [mcpClient]
 * @param {{ forwardGeocode: Function }} [geocoder] - optional geocoder backend (see geocoder.js)
 * @param {{ geolocateTool?: boolean }} [options] - opt-in flags for privacy-sensitive tools
 * @returns {Array<Object>} Tool definitions
 */
export function createMapTools(mapManager, catalog, mcpClient, geocoder, options = {}) {
    // The live layer roster is injected once into the system prompt via
    // DatasetCatalog.generatePromptCatalog() (richer: id + title + type +
    // versions + default filters). Tool descriptions deliberately do NOT
    // re-embed it — that was N copies of a strict subset of the same list,
    // frozen at boot and redundant with the catalog (#225). pickLayerNudge
    // stays per-tool: it's the disambiguation rule, not the list.
    const pickLayerNudge = PICK_LAYER_NUDGE;

    return [
        ...createMapControlTools(mapManager, { geocoder, geolocateTool: options.geolocateTool, hints: SQL_HINTS }),

        // ---- Dynamic Hex Tile Layers ----
        ...createHexTileTools(mapManager),

        // ---- Query-driven Filter Tool ---- (shared with glen core: query-filter-tool.js)
        ...(mcpClient ? [createFilterByQueryTool(mapManager, mcpClient, pickLayerNudge)] : []),

        // ---- Dataset Knowledge Tools ----
        // get_schema and get_stac_details live in catalog-tools.js (#441).
        {
            name: 'list_datasets',
            description: 'List all dataset IDs and titles pre-loaded for this app. Paths are in your system prompt; call `get_schema` for column details.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: () => {
                const datasets = catalog.getAll().map(ds => ({
                    id: ds.id,
                    title: ds.title,
                }));
                return JSON.stringify({ success: true, datasets });
            },
        },

        createProjectionTool(mapManager),

        ...createApplyStyleTool(mapManager, catalog, pickLayerNudge),
    ];
}

/**
 * `apply_style` (#440): switch a vector layer to one of the styles its
 * collection publishes. Registered only when some layer has published styles,
 * so an app without them keeps its tool list.
 */
export function createApplyStyleTool(mapManager, catalog, pickLayerNudge = PICK_LAYER_NUDGE) {
    const any = catalog.getAll?.().some(ds => ds.mapLayers?.some(ml => ml.publishedStyles?.length));
    if (!any) return [];
    return [{
        name: 'apply_style',
        description: `Apply one of the styles the data publisher made for a vector layer: its colours, outline, filter and legend together. The system prompt lists each layer's published styles and what each colours by. Prefer a published style over writing your own paint with set_style when one matches the request. reset_style returns to the layer's starting look.

${pickLayerNudge}`,
        inputSchema: {
            type: 'object',
            properties: {
                layer_id: { type: 'string', description: 'Vector layer' },
                style: { type: 'string', description: 'Published style name, as listed in the system prompt' },
            },
            required: ['layer_id', 'style'],
        },
        execute: (args) => JSON.stringify(applyPublishedStyle(mapManager, catalog, args.layer_id, args.style)),
    }];
}

/** Apply a layer's published style by name (or asset key). */
export function applyPublishedStyle(mapManager, catalog, layerId, name) {
    const hit = catalog.findMapLayer?.(layerId);
    if (!hit) return { success: false, error: `Unknown layer: ${layerId}` };
    const styles = hit.layer.publishedStyles || [];
    if (!styles.length) return { success: false, error: `${layerId} has no published styles; use set_style.` };
    const st = styles.find(s => s.name === name || s.key === name);
    if (!st) {
        return { success: false, error: `No style "${name}" for ${layerId}. Published styles: ${styles.map(s => s.name).join(', ')}` };
    }
    const state = mapManager.layers?.get?.(layerId);
    const drawnAs = mapManager.map?.getLayer?.(state?.mapLayerId)?.type || hit.layer.renderType || 'fill';
    if (st.renderType !== drawnAs) {
        return { success: false, error: `Style "${st.name}" draws ${st.renderType} layers but ${layerId} is drawn as ${drawnAs}.` };
    }
    const result = mapManager.applyPublishedStyle(layerId, {
        paint: st.paint, outlinePaint: st.outlinePaint, filter: st.filter, ...legendFromPaint(st.paint),
    });
    if (!result.success) return result;
    return { success: true, layer: layerId, style: st.name, colours_by: describeColor(st.paint) };
}
