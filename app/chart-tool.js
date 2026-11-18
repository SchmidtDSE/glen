/**
 * chart-tool.js — The `render_chart` tool (#277), shared by the full app and
 * glen core's charts plugin (core/plugins/charts.js).
 *
 * The tool draws rows the agent passes, or runs a SELECT itself so the rows
 * never pass through the model. Only the SQL engine differs between the apps:
 * the full app's MCP client, or glen core's `query` tool from its MCP plugin.
 */

import { validateChartSpec } from './chart-renderer.js';
import { expand, tokensIn, matchesWhen, fillText } from './params.js';

const CHART_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEBOUNCE_MS = 300;

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
 * Charts whose SQL uses param tokens, re-run when a control changes one of
 * them (SchmidtDSE/glen#426). A change waits for the controls to settle
 * (`debounceMs`), the panel shows that it is updating, and a run that a newer
 * one overtook is dropped. A chart with `when` is hidden at settings it does
 * not apply to, and re-runs when it is shown again if a token changed while
 * it was hidden.
 */
export class LiveCharts {
    /**
     * @param {Object} opts
     * @param {Object} opts.renderer - a ChartRenderer
     * @param {(sql: string, args: Object) => Promise<{ok: boolean, rows?: Array, error?: string}>} opts.fetchRows
     * @param {() => Object|null} opts.params - the ParamBus, or null
     * @param {number} [opts.debounceMs]
     */
    constructor({ renderer, fetchRows, params, debounceMs = DEBOUNCE_MS }) {
        this.renderer = renderer;
        this.fetchRows = fetchRows;
        this.params = params;
        this.debounceMs = debounceMs;
        this.charts = new Map();   // id → { args, used, when, seq, timer, stale }
        this._unsub = null;
        renderer.onRemove?.((id) => this.untrack(id));
    }

    track(id, args, { when = null, stale = false } = {}) {
        const prev = this.charts.get(id);
        if (prev?.timer) clearTimeout(prev.timer);
        this.charts.set(id, { args, used: new Set([...tokensIn(args.sql), ...labelTokens(args)]), when, seq: prev?.seq || 0, timer: null, stale });
        this._subscribe();
        this._applyWhen(id);
    }

    untrack(id) {
        const c = this.charts.get(id);
        if (c?.timer) clearTimeout(c.timer);
        this.charts.delete(id);
    }

    has(id) {
        return this.charts.has(id);
    }

    /** Whether a chart's `when` holds at the current settings. */
    applies(id) {
        const c = this.charts.get(id);
        const bus = this.params?.();
        return !c?.when || !bus || matchesWhen(c.when, bus.params, bus.values);
    }

    _subscribe() {
        const bus = this.params?.();
        if (this._unsub || !bus) return;
        this._unsub = bus.subscribe((changed) => this._onChange(changed));
    }

    _onChange(changed) {
        for (const [id, c] of this.charts) {
            const touched = [...c.used].some(t => changed.has(t));
            if (touched) c.stale = true;
            this._applyWhen(id);
        }
    }

    _applyWhen(id) {
        const c = this.charts.get(id);
        if (!c) return;
        const shown = this.applies(id);
        this.renderer.setHidden?.(id, !shown);
        if (shown && c.stale) this._schedule(id);
    }

    _schedule(id) {
        const c = this.charts.get(id);
        if (!c) return;
        c.stale = false;
        if (c.timer) clearTimeout(c.timer);
        this.renderer.setStatus?.(id, { loading: true });
        c.timer = setTimeout(() => { c.timer = null; this.run(id); }, this.debounceMs);
    }

    /** Re-run a chart's SQL at the current settings and redraw it in place. */
    async run(id) {
        const c = this.charts.get(id);
        if (!c) return;
        const seq = ++c.seq;
        this.renderer.setStatus?.(id, { loading: true });
        const tokens = this.params?.()?.tokens() || {};
        if (!c.args.sql) {
            // labels only: redraw the rows already drawn
            const rows = this.renderer._charts?.get(id)?.rows || c.args.data || [];
            await this.renderer.render(chartSpec(c.args, tokens), rows, { id });
            this.renderer.setStatus?.(id, {});
            return;
        }
        let sql;
        try {
            sql = expand(c.args.sql, tokens, `chart ${id}`);
        } catch (err) {
            this.renderer.setStatus?.(id, { error: err.message });
            return;
        }
        const res = await this.fetchRows(sql, c.args);
        if (this.charts.get(id) !== c || c.seq !== seq) return;   // removed, or a newer run started
        if (!res.ok) {
            this.renderer.setStatus?.(id, { error: res.error });
            return;
        }
        try {
            await this.renderer.render(chartSpec(c.args, tokens), res.rows, { id });
            this.renderer.setStatus?.(id, { error: res.rows.length ? null : 'No rows at these settings.' });
        } catch (err) {
            this.renderer.setStatus?.(id, { error: `Could not redraw: ${err.message}` });
        }
    }
}

const LABEL_FIELDS = ['title', 'x_label', 'y_label'];

/** The text fields of a chart that may use tokens, as in a y label naming the unit. */
function labelTokens(args) {
    const out = new Set();
    for (const k of LABEL_FIELDS) for (const t of tokensIn(args[k])) out.add(t);
    return out;
}

/** The spec the renderer keeps: the call without its inline data, its labels filled. */
function chartSpec(args, tokens = null) {
    const { data, ...spec } = args;
    if (tokens) for (const k of LABEL_FIELDS) if (typeof spec[k] === 'string') spec[k] = fillText(spec[k], tokens);
    return spec;
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
 * @param {() => Object|null} [options.params] - the app's ParamBus, read when a
 *   chart is drawn (glen core's controls plugin). With it, `sql` may use the
 *   controls' {{TOKEN}}s and the chart re-runs when one changes.
 * @param {number} [options.debounceMs] - how long a live chart waits for the
 *   controls to settle before it re-runs
 * @returns {Object} a tool definition (name/description/inputSchema/execute),
 *   with `drawConfigured(args, {when})` for charts an app's config lists and
 *   `live`, the LiveCharts that re-runs them
 */
export function createRenderChartTool(chartRenderer, query, { endpointArgs = false, params = null, debounceMs } = {}) {
    const runQuery = typeof query === 'function' ? query
        : query ? (sql) => query.callTool('query', { sql_query: sql }) : null;

    // Aggregate full rows to a JSON array via DuckDB. to_json() is required:
    // DuckDB's native list display is not valid JSON.
    const fetchRows = (sql, args) => {
        if (!runQuery) return Promise.resolve({ ok: false, error: 'No SQL engine available for the sql path — pass data instead.' });
        const wrappedSql = `SELECT to_json(array_agg(_chart_rows)) AS rows FROM (${sql}) _chart_rows`;
        const endpoint = endpointArgs && args.s3_endpoint
            ? { s3_endpoint: args.s3_endpoint, ...(args.s3_scope ? { s3_scope: args.s3_scope } : {}) }
            : null;
        return runJsonArrayQuery((q) => (endpoint ? runQuery(q, endpoint) : runQuery(q)), wrappedSql);
    };
    const live = new LiveCharts({ renderer: chartRenderer, fetchRows, params, debounceMs });

    /**
     * A chart the app's config lists, whose query failed: open it with the
     * error shown, and keep it live so the next change of a control it uses
     * tries again. The reader sees the chart is missing and why.
     */
    const drawConfigured = async (args, { when = null } = {}) => {
        // A chart hidden by its `when` waits to run until it is shown, so it
        // does not hold up the SQL engine for the charts on screen.
        const bus = params?.();
        if (when && args.sql && args.chart_id && bus && !matchesWhen(when, bus.params, bus.values)) {
            try {
                validateChartSpec(args);
                const { id } = await chartRenderer.render(chartSpec(args, bus.tokens()), [], { id: String(args.chart_id) });
                live.track(id, args, { when, stale: true });
                return { success: true, chart_id: id, deferred: true };
            } catch (err) {
                return { success: false, error: err.message };
            }
        }
        const res = await draw(args, { when });
        if (res.success || !args.sql || !args.chart_id) return res;
        try {
            validateChartSpec(args);
            const { id } = await chartRenderer.render(chartSpec(args, params?.()?.tokens() || null), [], { id: String(args.chart_id) });
            live.track(id, args, { when });
            chartRenderer.setStatus?.(id, { error: res.error });
        } catch { /* a bad spec stays undrawn */ }
        return res;
    };

    const draw = async (args, { when = null } = {}) => {
        // Reject a bad spec cheaply, before paying for any SQL round-trip.
        try {
            validateChartSpec(args);
        } catch (err) {
            return { success: false, error: err.message };
        }
        if (args.chart_id != null && !CHART_ID_RE.test(String(args.chart_id))) {
            return { success: false, error: 'chart_id takes letters, digits, "_" and "-".' };
        }

        let rows;
        const sqlTokens = args.sql ? tokensIn(args.sql) : new Set();
        const used = new Set([...sqlTokens, ...labelTokens(args)]);
        const bus = used.size ? params?.() : null;
        if (sqlTokens.size && !bus) {
            return { success: false, error: `sql uses ${[...sqlTokens].map(t => `{{${t}}}`).join(', ')}, but this app has no controls to set them.` };
        }
        const tokens = bus ? bus.tokens() : null;
        if (args.sql) {
            // sql is authoritative when both are supplied — never silently
            // chart a partial inline sample while ignoring the full query.
            let sql = args.sql;
            if (sqlTokens.size) {
                try {
                    sql = expand(args.sql, tokens, 'sql');
                } catch (err) {
                    return { success: false, error: err.message };
                }
            }
            const res = await fetchRows(sql, args);
            if (!res.ok) return { success: false, error: res.error };
            rows = res.rows;
        } else if (Array.isArray(args.data)) {
            rows = args.data;
        }

        if (!rows || (rows.length === 0 && !sqlTokens.size)) {
            return {
                success: false,
                error: args.sql
                    ? 'Query returned no rows — nothing to chart.'
                    : 'No data to chart — provide a non-empty `data` array or a `sql` query that returns rows.',
            };
        }

        let id;
        try {
            ({ id } = await chartRenderer.render(chartSpec(args, tokens), rows, args.chart_id ? { id: String(args.chart_id) } : {}));
        } catch (err) {
            return { success: false, error: `Could not render chart: ${err.message}` };
        }
        if ((used.size && bus) || when) live.track(id, args, { when });
        else live.untrack(id);
        chartRenderer.setStatus?.(id, { error: rows.length ? null : 'No rows at these settings.' });
        return {
            success: true, chart_id: id, chart_type: args.chart_type, title: args.title || null, points: rows.length,
            ...(used.size && bus && { live: true, tokens: [...used] }),
        };
    };

    const tool = {
        name: 'render_chart',
        description: `Render query results as a chart on a card in the side panel. Use when a table or map can't show the shape of the data — e.g. "plot the top 10 countries", "show the distribution", "chart the trend over years".

Chart types:
- bar: ranking / category comparison (x = category, y = value). Bars run across, one row per category, in the order of the rows (ORDER BY in sql), or largest first with sort "desc". With series, stacked: true stacks the series in each row.
- line: time series / trend (x = ordered field e.g. year, y = value)
- scatter: relationship / trade-off (x, y = two numerics)
- histogram: distribution of one numeric (x = the value; bars are counts — omit y)

Provide the data ONE of two ways (if you pass both, sql wins):
- data: an array of row objects you already have, e.g. [{"country":"Brazil","pct":31}, ...]. Best for small, already-aggregated results.
- sql: a SELECT the panel runs itself (rows never pass through the LLM). Best for larger results. Write a plain SELECT — do NOT wrap it in array_agg/to_json.

x / y name the columns to plot; series (optional) splits/colors by a column. Keep result sets small (≈ a few hundred rows max).

Pass the chart_id of a chart already drawn to change it in place instead of opening another.${params ? `

sql, title and the axis labels may use the {{TOKEN}}s of the app's controls (get_map_state lists them under controls). The chart then re-runs whenever the reader changes one of those controls.` : ''}`,
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
                stacked: { type: 'boolean', description: 'bar with series: stack the series in each row instead of grouping them' },
                sort: { type: 'string', enum: ['desc'], description: 'bar: largest first, instead of row order' },
                format: { type: 'string', enum: ['num', 'num1', 'num2', 'int', 'compact', 'pct', 'pct100', 'usd', 'km2', 'ha', 'acres'], description: 'bar: how values are written. pct takes 0–1, pct100 takes 0–100.' },
                chart_id: { type: 'string', description: 'Optional: the id of a chart to update in place (as a previous call returned), or an id for a new chart' },
            },
            required: ['chart_type', 'x'],
        },
        execute: async (args) => JSON.stringify(await draw(args)),
        draw,
        drawConfigured,
        live,
    };
    if (endpointArgs) {
        tool.description += '\n\nWhen get_schema gives a dataset\'s path with s3_endpoint and s3_scope, pass the same two here with sql.';
        tool.inputSchema.properties.s3_endpoint = { type: 'string', description: 'S3 endpoint for the sql path, as get_schema gives it for data on another host' };
        tool.inputSchema.properties.s3_scope = { type: 'string', description: 'S3 scope to go with s3_endpoint' };
    }
    return tool;
}
