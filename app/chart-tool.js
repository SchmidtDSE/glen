/**
 * chart-tool.js — The `render_chart` tool (#277), shared by the full app and
 * glen core's charts plugin (core/plugins/charts.js).
 *
 * The tool draws rows the agent passes, or runs a SELECT itself so the rows
 * never pass through the model. Only the SQL engine differs between the apps:
 * the full app's MCP client, or glen core's `query` tool from its MCP plugin.
 */

import { validateChartSpec } from './chart-renderer.js';

/**
 * Parse a JSON array from DuckDB MCP query result text.
 * DuckDB may wrap the array in a markdown table or plain text — we extract
 * by finding the first '[' and last ']' in the response.
 *
 * @param {string} text
 * @returns {Array|null}
 */
export function extractJsonArray(text) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * Run a SELECT (already wrapped to emit `to_json(array_agg(...))`) and
 * return its rows as a parsed array. Shared marshalling for the chart
 * tool: DuckDB's array_agg over zero rows yields SQL NULL (no brackets), so an
 * empty result is reported as `{ ok: true, rows: [] }`, not a parse failure.
 *
 * @returns {Promise<{ok:true, rows:Array}|{ok:false, error:string}>}
 */
async function runJsonArrayQuery(runQuery, wrappedSql) {
    let raw;
    try {
        raw = await runQuery(wrappedSql);
    } catch (err) {
        return { ok: false, error: `SQL execution failed: ${err.message}` };
    }
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text || /\bnull\b/i.test(text.trim().replace(/.*\n/, ''))) {
        return { ok: true, rows: [] };
    }
    const rows = extractJsonArray(text);
    if (!rows) {
        return { ok: false, error: `Could not parse rows from query result. Raw: ${text.substring(0, 300)}` };
    }
    return { ok: true, rows };
}

/**
 * Build the opt-in `render_chart` tool (#277). Registered only when an app
 * sets `charts.enabled` — so apps that don't want charts pay no footprint and
 * the LLM never sees the tool.
 *
 * @param {{ render: Function }} chartRenderer — a ChartRenderer instance
 * @param {import('./mcp-client.js').MCPClient|Function} [query] — for the `sql`
 *   path: the full app's MCP client, whose `query` tool takes `sql_query`, or a
 *   function from SQL to the query tool's result text (glen core's charts
 *   plugin, which runs whichever `query` tool its MCP servers registered)
 * @param {Object} [options]
 * @param {boolean} [options.endpointArgs] - also offer `s3_endpoint` and
 *   `s3_scope`, passed on to the query function, for data on a host other
 *   than the SQL server's default (glen core, whose Portolan data is often on
 *   Google Cloud Storage). The full app leaves them off, so its tool is as before.
 * @returns {Object} a tool definition (name/description/inputSchema/execute)
 */
export function createRenderChartTool(chartRenderer, query, { endpointArgs = false } = {}) {
    const runQuery = typeof query === 'function' ? query
        : query ? (sql) => query.callTool('query', { sql_query: sql }) : null;
    const tool = {
        name: 'render_chart',
        description: `Render query results as a chart in a floating panel. Use when a table or map can't show the shape of the data — e.g. "plot the top 10 countries", "show the distribution", "chart the trend over years".

Chart types:
- bar: ranking / category comparison (x = category, y = value)
- line: time series / trend (x = ordered field e.g. year, y = value)
- scatter: relationship / trade-off (x, y = two numerics)
- histogram: distribution of one numeric (x = the value; bars are counts — omit y)

Provide the data ONE of two ways (if you pass both, sql wins):
- data: an array of row objects you already have, e.g. [{"country":"Brazil","pct":31}, ...]. Best for small, already-aggregated results.
- sql: a SELECT the panel runs itself (rows never pass through the LLM). Best for larger results. Write a plain SELECT — do NOT wrap it in array_agg/to_json.

x / y name the columns to plot; series (optional) splits/colors by a column. Keep result sets small (≈ a few hundred rows max).`,
        inputSchema: {
            type: 'object',
            properties: {
                chart_type: { type: 'string', enum: ['bar', 'line', 'scatter', 'histogram'], description: 'Chart type' },
                title: { type: 'string', description: 'Chart title shown on the panel' },
                data: { type: 'array', items: {}, description: 'Array of row objects to plot. Provide this OR sql.' },
                sql: { type: 'string', description: 'A plain SELECT the panel runs to get rows. Provide this OR data.' },
                x: { type: 'string', description: 'Column for the x axis (category for bar, the value for histogram)' },
                y: { type: 'string', description: 'Column for the y axis (numeric). Omit for histogram.' },
                series: { type: 'string', description: 'Optional column to split/color multiple series' },
                x_label: { type: 'string', description: 'Optional x-axis label (defaults to the x column name)' },
                y_label: { type: 'string', description: 'Optional y-axis label' },
            },
            required: ['chart_type', 'x'],
        },
        execute: async (args) => {
            // Reject a bad spec cheaply, before paying for any SQL round-trip.
            try {
                validateChartSpec(args);
            } catch (err) {
                return JSON.stringify({ success: false, error: err.message });
            }

            let rows;
            if (args.sql) {
                // sql is authoritative when both are supplied — never silently
                // chart a partial inline sample while ignoring the full query.
                if (!runQuery) return JSON.stringify({ success: false, error: 'No SQL engine available for the sql path — pass data instead.' });
                // Aggregate full rows to a JSON array via DuckDB. to_json() is
                // required: DuckDB's native list display is not valid JSON.
                const wrappedSql = `SELECT to_json(array_agg(_chart_rows)) AS rows FROM (${args.sql}) _chart_rows`;
                const endpoint = endpointArgs && args.s3_endpoint
                    ? { s3_endpoint: args.s3_endpoint, ...(args.s3_scope ? { s3_scope: args.s3_scope } : {}) }
                    : null;
                const res = await runJsonArrayQuery((sql) => (endpoint ? runQuery(sql, endpoint) : runQuery(sql)), wrappedSql);
                if (!res.ok) return JSON.stringify({ success: false, error: res.error });
                rows = res.rows;
            } else if (Array.isArray(args.data)) {
                rows = args.data;
            }

            if (!rows || rows.length === 0) {
                return JSON.stringify({
                    success: false,
                    error: args.sql
                        ? 'Query returned no rows — nothing to chart.'
                        : 'No data to chart — provide a non-empty `data` array or a `sql` query that returns rows.',
                });
            }

            try {
                const { id } = await chartRenderer.render(args, rows);
                return JSON.stringify({ success: true, chart_id: id, chart_type: args.chart_type, title: args.title || null, points: rows.length });
            } catch (err) {
                return JSON.stringify({ success: false, error: `Could not render chart: ${err.message}` });
            }
        },
    };
    if (endpointArgs) {
        tool.description += '\n\nWhen get_schema gives a dataset\'s path with s3_endpoint and s3_scope, pass the same two here with sql.';
        tool.inputSchema.properties.s3_endpoint = { type: 'string', description: 'S3 endpoint for the sql path, as get_schema gives it for data on another host' };
        tool.inputSchema.properties.s3_scope = { type: 'string', description: 'S3 scope to go with s3_endpoint' };
    }
    return tool;
}
