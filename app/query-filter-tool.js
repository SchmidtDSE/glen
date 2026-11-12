/**
 * query-filter-tool.js — `filter_by_query`, shared by the full app
 * (map-tools.js) and glen core's MCP plugin (core/plugins/mcp.js).
 *
 * Filters a vector layer to the feature ids an SQL query returns, without
 * passing the ids through the model. Only the SQL engine differs between the
 * apps: the full app's MCP client, or glen core's registered `query` tool.
 */

import { extractJsonArray } from './chart-tool.js';

/**
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {import('./mcp-client.js').MCPClient|Function} query - the full app's
 *   MCP client (its `query` tool takes `sql_query`), or a function from SQL to
 *   the query tool's result text
 * @param {string} pickLayerNudge - the layer-choice hint appended to the description
 * @returns {Object} a tool definition
 */
export function createFilterByQueryTool(mapManager, query, pickLayerNudge) {
    const runQuery = typeof query === 'function' ? query
        : query ? (sql) => query.callTool('query', { sql_query: sql }) : null;
    return {
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
            if (!runQuery) return JSON.stringify({ success: false, error: 'No SQL engine available' });

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
                rawResult = await runQuery(wrappedSql);
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
    };
}
