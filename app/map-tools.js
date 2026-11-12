import { extractJsonArray } from './chart-tool.js';
import { createHexTileTools } from './hex-tools.js';
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

        // ---- Query-driven Filter Tool ----
        ...(mcpClient ? [{
            name: 'filter_by_query',
            description: `Filter a vector layer to features whose ID property matches the results of a SQL query — without passing thousands of IDs through the LLM.

Use this instead of set_filter when:
- The matching set comes from an MCP SQL query (e.g. "show parcels inside protected areas", "highlight counties above median income")
- The result set could be large (hundreds to tens of thousands of features)

How it works:
1. Executes your SQL via the MCP query tool
2. Extracts the ID column
3. Applies a MapLibre filter programmatically — IDs never pass through the LLM output

Parameters:
- layer_id: the vector layer to filter (must already be loaded)
- sql: a SELECT query returning ONE column — the feature ID values to keep. Alias that column to match id_property exactly. Example: SELECT GEOID FROM read_parquet('s3://...') WHERE ...
- id_property: the property name in the vector tile features to match against. Check get_stac_details for the correct column — CNG-processed datasets use "_cng_fid"; source datasets vary (e.g. "OBJECTID", "HOLDING_ID").

IMPORTANT: The sql must return only the id column — no extra columns. Write it as a plain SELECT, not wrapped in array_agg.

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID to filter' },
                    sql: { type: 'string', description: 'SELECT query returning a single column of ID values to keep' },
                    id_property: { type: 'string', description: 'Feature property name in the vector tile to match against — check get_stac_details (CNG-processed datasets use "_cng_fid"; source datasets vary)' },
                },
                required: ['layer_id', 'sql', 'id_property'],
            },
            execute: async (args) => {
                if (!mcpClient) return JSON.stringify({ success: false, error: 'MCP client not available' });

                // Wrap user SQL to aggregate non-null IDs into a JSON array via DuckDB.
                // to_json() is required because DuckDB's native array display format
                // (space-separated, no commas — e.g. "[ 1  2  3]") is not valid JSON,
                // so without it the extractJsonArray() call below fails to parse.
                const col = args.id_property;
                // col is quoted into wrappedSql — restrict to plain identifier chars.
                if (!/^[A-Za-z0-9_]+$/.test(col || '')) {
                    return JSON.stringify({
                        success: false,
                        error: `Invalid id_property "${col}" — must contain only letters, digits, or underscores. Check get_stac_details for the feature ID column name.`,
                    });
                }
                const wrappedSql = `SELECT to_json(array_agg("${col}") FILTER (WHERE "${col}" IS NOT NULL)) AS ids FROM (${args.sql}) _filter_subquery`;

                let rawResult;
                try {
                    rawResult = await mcpClient.callTool('query', { sql_query: wrappedSql });
                } catch (err) {
                    return JSON.stringify({ success: false, error: `SQL execution failed: ${err.message}` });
                }

                // DuckDB returns NULL (not []) when no rows match — treat as empty
                if (!rawResult || /\bnull\b/i.test(rawResult.trim().replace(/.*\n/, ''))) {
                    return JSON.stringify({ success: true, idCount: 0, featuresInView: 0, message: 'Query matched no features — filter not applied.' });
                }

                const ids = extractJsonArray(rawResult);
                if (!ids) {
                    return JSON.stringify({
                        success: false,
                        error: `Could not parse ID list from query result. Check that id_property ("${col}") exactly matches the column name in the SQL output — verify via get_stac_details (CNG-processed datasets use "_cng_fid"). Raw: ${rawResult.substring(0, 300)}`
                    });
                }
                if (ids.length === 0) {
                    return JSON.stringify({ success: true, idCount: 0, featuresInView: 0, message: 'Query matched no features — filter not applied.' });
                }

                const filter = ['in', ['get', col], ['literal', ids]];
                const result = mapManager.setFilter(args.layer_id, filter);
                return JSON.stringify({ ...result, idCount: ids.length });
            },
        }] : []),

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
