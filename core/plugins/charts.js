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
 * With the controls plugin (plugins/controls.js), a chart's `sql` may use the
 * controls' {{TOKEN}}s, and the chart re-runs when the reader changes one
 * (SchmidtDSE/glen#426). The app's config may list charts to draw at start,
 * each a render_chart call with an optional `chart_id` and `when`:
 *
 *   "plugins": [
 *     { "url": "…/core/plugins/mcp.js", "options": { … } },
 *     { "url": "…/core/plugins/controls.js", "options": { "controls": [ … ] } },
 *     { "url": "…/core/plugins/charts.js", "options": { "charts": [
 *         { "chart_id": "loss-by-year", "chart_type": "line", "title": "Tree cover loss by year",
 *           "sql": "SELECT year, sum(loss_ha) AS loss_ha FROM … WHERE year BETWEEN {{YEAR_MIN}} AND {{YEAR_MAX}} GROUP BY year ORDER BY year",
 *           "x": "year", "y": "loss_ha" } ] } }
 *   ]
 */

/** Whether the app's config loads the controls plugin. */
export function hasControlsPlugin(config) {
    return (config?.plugins || []).some((p) => /(^|\/)controls\.js(\?|$)/.test(typeof p === 'string' ? p : p?.url || ''));
}

const plugin = {
    name: 'charts',

    async setup(ctx, options = {}) {
        const [{ ChartRenderer }, { createRenderChartTool }] = await Promise.all([
            import('../../app/chart-renderer.js'),
            import('../../app/chart-tool.js'),
        ]);
        const renderer = new ChartRenderer();
        // Exposed for other plugins, such as a session export that redraws charts.
        ctx.charts = renderer;
        // The controls plugin's ParamBus, read when a chart is drawn, so the
        // order of the two plugins in the config does not matter.
        const params = hasControlsPlugin(ctx.config) ? () => ctx.params || null : null;
        const tool = createRenderChartTool(renderer, (sql, extra) => runQuery(ctx.tools, sql, extra), { endpointArgs: true, params });
        ctx.tools.registerLocal(tool);
        // get_map_state lists the open charts, and which re-run with the controls.
        ctx.map?.addStateSection?.('charts', () => {
            const open = renderer.describe();
            if (!open.length) return null;
            return open.map(c => (tool.live.has(c.chart_id) ? { ...c, live: true, tokens: [...tool.live.charts.get(c.chart_id).used] } : c));
        });

        const charts = Array.isArray(options.charts) ? options.charts : [];
        if (charts.length) {
            ctx.onReady?.(async () => {
                for (const spec of charts) {
                    const { when, ...args } = spec || {};
                    const res = await tool.draw(args, { when: when || null });
                    if (!res.success) console.warn(`[charts] Chart ${args.chart_id || args.title || ''} not drawn:`, res.error);
                }
            });
        }
    },
};

// The query runner is shared with the MCP plugin's filter_by_query.
export { runQuery } from '../run-query.js';
import { runQuery } from '../run-query.js';

export default plugin;
