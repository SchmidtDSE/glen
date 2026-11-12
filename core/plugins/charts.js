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

// The query runner is shared with the MCP plugin's filter_by_query.
export { runQuery } from '../run-query.js';
import { runQuery } from '../run-query.js';

export default plugin;
