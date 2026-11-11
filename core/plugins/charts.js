/**
 * charts.js — glen core plugin: the `render_chart` tool (#277), as in the full
 * app with `charts.enabled` (SchmidtDSE/glen#441).
 *
 * The agent passes rows it already has (`data`), or a SELECT (`sql`) that the
 * panel runs itself so the rows never pass through the model. The `sql` path
 * runs through the `query` tool another plugin registered, such as an MCP
 * server's in plugins/mcp.js, read when a chart is drawn, so the order of the
 * two plugins in the config does not matter. Without one, `data` still works.
 *
 * Observable Plot loads from jsDelivr the first time a chart is drawn, so an
 * app pays nothing until then.
 *
 *   "plugins": [
 *     { "url": "…/core/plugins/mcp.js", "options": { … } },
 *     "…/core/plugins/charts.js"
 *   ]
 */

const plugin = {
    name: 'charts',

    async setup(ctx) {
        const [{ ChartRenderer }, { createRenderChartTool }] = await Promise.all([
            import('../../app/chart-renderer.js'),
            import('../../app/chart-tool.js'),
        ]);
        const renderer = new ChartRenderer();
        // Exposed for other plugins, such as a session export that redraws charts.
        ctx.charts = renderer;
        ctx.tools.registerLocal(createRenderChartTool(renderer, (sql, extra) => runQuery(ctx.tools, sql, extra), { endpointArgs: true }));
    },
};

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

export default plugin;
