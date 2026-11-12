/**
 * run-query.js — Run SQL through the `query` tool another plugin registered
 * (an MCP server's, from plugins/mcp.js), for glen core's tools that run SQL
 * themselves: render_chart's `sql` path and filter_by_query.
 */

/**
 * Run SQL through whichever `query` tool is registered, naming the SQL
 * argument as that tool's schema does (`sql_query` on geo-query, `sql` on
 * some servers).
 *
 * @param {Object} tools - the harness ToolRegistry
 * @param {string} sql
 * @param {Object} [extra] - `s3_endpoint` and `s3_scope`, passed when the
 *   query tool takes them
 * @returns {Promise<string>} the tool's result text
 */
export async function runQuery(tools, sql, extra = null) {
    const tool = tools.tools?.get?.('query');
    if (!tool) throw new Error('no query tool is registered; pass data instead, or add an SQL server with plugins/mcp.js');
    const props = tool.inputSchema?.properties || {};
    const key = 'sql_query' in props || !('sql' in props) ? 'sql_query' : 'sql';
    const pass = Object.fromEntries(Object.entries(extra || {}).filter(([k]) => k in props));
    const res = await tools.execute('query', { [key]: sql, ...pass });
    if (!res?.success) throw new Error(String(res?.result ?? 'query failed'));
    return res.result;
}
