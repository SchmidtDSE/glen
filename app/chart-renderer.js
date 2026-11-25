/**
 * chart-renderer.js — Opt-in lightweight charting primitive (#277)
 *
 * Turns a query result set into a chart (bar / line / scatter / histogram) on
 * a card in the Charts section of the side panel, newest first
 * (SchmidtDSE/glen#391, #426). Generic, not app-specific: the agent runs a
 * `query`, then hands the rows (or the SQL) to the `render_chart` tool, which
 * calls ChartRenderer.render here.
 *
 * Bar charts are glen-charts' horizontal SVG bars (svg-bar-chart.js): rows keep
 * the order the query gave them, and long names wrap rather than rotate. Line,
 * scatter and histogram are drawn with Observable Plot, loaded lazily from the
 * CDN the first time one is drawn — so apps that don't draw them pay nothing,
 * and downstream apps don't need to add a <script> tag to their index.html.
 *
 * `buildPlotOptions` is pure (Plot is injected) so the mark-selection /
 * channel-mapping logic is unit-tested without a DOM or a network fetch.
 */

// Observable Plot ships as ESM + a UMD bundle whose browser global expects a
// `d3` global, so we load d3 then Plot via SRI-pinned <script> tags — matching
// the opt-in CDN convention in map-draw.js / map-geocoder.js. Lazy: nothing
// loads until the first chart is drawn.
const D3_JS = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js';
const D3_JS_SRI = 'sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i';
const PLOT_JS = 'https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.16/dist/plot.umd.min.js';
const PLOT_JS_SRI = 'sha384-XzQ+KW4LBWHv6FLjiPA1vjDz//oGlY8We4XROgpir5jHgg2+Qvo/6fT5TjbnqyYi';

const CHART_TYPES = ['bar', 'line', 'scatter', 'histogram'];

// Bold, readable defaults. Categorical range is the validated CVD-safe palette
// (dataviz skill, light surface) — assigned in fixed order, never cycled. A
// chart with no `series` uses one confident color instead of Plot's thin
// default. Text stays ink; only marks carry the data color.
const CATEGORICAL = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
const SERIES_1 = '#2a78d6';   // default single-series color (bold blue)
const INK = '#1a1a1a';        // axis / label text
const CHART_FONT = "'Open Sans', system-ui, -apple-system, sans-serif";

import { placeFirst } from './settings-section.js';
import { renderBarChart, barSpecFromChart } from './svg-bar-chart.js';

/** Load a JS script by URL with SRI; resolves when loaded. */
function loadScript(url, integrity) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        if (integrity) {
            s.integrity = integrity;
            s.crossOrigin = 'anonymous';
        }
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(s);
    });
}

/** True when `p` looks like the Observable Plot namespace we need. */
function isPlot(p) {
    return !!p && typeof p.plot === 'function' && typeof p.barY === 'function' && typeof p.binX === 'function';
}

/**
 * Validate a chart spec (pure, no Plot/DOM). Lets the tool reject a bad spec
 * before paying for an MCP/SQL round-trip.
 * @throws if chart_type is unsupported or a required channel is missing
 */
export function validateChartSpec(spec) {
    const type = spec.chart_type;
    if (!CHART_TYPES.includes(type)) {
        throw new Error(`Unsupported chart_type "${type}". Use one of: ${CHART_TYPES.join(', ')}.`);
    }
    if (!spec.x) throw new Error(`chart_type "${type}" requires an x column.`);
    if (type !== 'histogram' && !spec.y) throw new Error(`chart_type "${type}" requires a y column.`);
}

/**
 * Build the Observable Plot options object for a chart spec + rows.
 * Pure: the Plot namespace is passed in, so callers (and tests) control it.
 *
 * @param {Object} Plot — the Observable Plot namespace (barY, lineY, dot, …)
 * @param {Object} spec — { chart_type, x, y, series, x_label, y_label }
 * @param {Array<Object>} rows — result rows
 * @returns {Object} options for Plot.plot()
 * @throws if chart_type is unsupported or required channels are missing
 */
export function buildPlotOptions(Plot, spec, rows) {
    validateChartSpec(spec);
    const type = spec.chart_type;
    const { x, y, series } = spec;

    // A single confident color when there's no `series`; a real grouping paints
    // marks from the categorical range. A string that is a valid CSS color is a
    // constant fill/stroke in Plot; a column name is a channel — so `series`
    // colors by category and `SERIES_1` is a flat bold color.
    const paint = series || SERIES_1;

    let mark;
    switch (type) {
        case 'bar':
            // Filled bars, a 2px surface gap between neighbors (never a stroke).
            mark = Plot.barY(rows, { x, y, fill: paint, insetLeft: 1, insetRight: 1, tip: true });
            break;
        case 'line':
            // A bold 2.5px line reads over the basemap; no per-point markers —
            // those are chart-junk. The tooltip and endpoints carry the points.
            mark = Plot.lineY(rows, { x, y, stroke: paint, strokeWidth: 2.5, strokeLinejoin: 'round', strokeLinecap: 'round', tip: true });
            break;
        case 'scatter':
            // Big FILLED dots with a white surface ring — not small open circles.
            mark = Plot.dot(rows, { x, y, fill: paint, r: 5, stroke: 'white', strokeWidth: 1.5, tip: true });
            break;
        case 'histogram':
            mark = Plot.rectY(rows, Plot.binX({ y: 'count' }, { x, fill: SERIES_1, insetLeft: 1, insetRight: 1, tip: true }));
            break;
    }

    const marks = [];
    // A baseline at y=0 reads more honestly for bars/lines/histograms.
    if (type !== 'scatter') marks.push(Plot.ruleY([0]));
    marks.push(mark);

    // --- de-crowd the x axis ---------------------------------------------
    // Categorical axes overcrowd and overprint the fastest. When there are many
    // bands or long labels, rotate the ticks and reserve room instead of letting
    // Plot stack them on top of each other; cap continuous ticks so numbers
    // don't collide.
    const xVals = rows.map(r => r && r[x]);
    const numericX = xVals.every(v => v == null || typeof v === 'number');
    const distinctX = new Set(xVals).size;
    const longestX = xVals.reduce((m, v) => Math.max(m, String(v ?? '').length), 0);
    const rotateX = !numericX && (distinctX > 6 || longestX > 8);

    const xAxis = { label: spec.x_label ?? x ?? null };
    let marginBottom = 48;
    if (rotateX) {
        xAxis.tickRotate = -35;
        marginBottom = Math.min(120, 48 + Math.round(longestX * 4.5));
    } else if (numericX) {
        xAxis.ticks = 6;
        // Whole-number x values, such as years, get whole-number ticks: no
        // 2021.5 between two years, and a year reads 2021, not 2,021.
        const nums = xVals.filter(v => v != null);
        if (type !== 'histogram' && nums.length && nums.every(Number.isInteger)) {
            const lo = nums.reduce((m, v) => Math.min(m, v), Infinity);
            const hi = nums.reduce((m, v) => Math.max(m, v), -Infinity);
            const step = Math.max(1, Math.ceil((hi - lo) / 6));
            xAxis.ticks = Array.from({ length: Math.floor((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
            if (lo >= 1000 && hi <= 9999) xAxis.tickFormat = 'd';
        }
    }

    // Short SI tick labels (1k, 2.5M) keep the y axis readable and let the left
    // margin stay tight. Only when y is actually quantitative.
    const yVals = type === 'histogram' ? [] : rows.map(r => r && r[y]);
    const numericY = type === 'histogram' || yVals.every(v => v == null || typeof v === 'number');
    const yAxis = { label: spec.y_label ?? (type === 'histogram' ? 'count' : y) ?? null, grid: true };
    if (numericY) yAxis.tickFormat = '~s';

    return {
        marginLeft: 56,
        marginBottom,
        marginTop: 18,
        marginRight: 18,
        // Bigger, bolder type; the whole figure inherits it (axes + legend).
        style: { fontSize: '13px', fontFamily: CHART_FONT, color: INK, background: 'transparent' },
        x: xAxis,
        y: yAxis,
        // histogram bins ignore `series`, so a color legend there would be empty.
        ...(series && type !== 'histogram' && { color: { legend: true, range: CATEGORICAL } }),
        marks,
    };
}

export class ChartRenderer {
    /**
     * @param {Object} [opts]
     * @param {Document} [opts.doc] — injectable for tests
     * @param {Element} [opts.mount] — the side panel the Charts section goes
     *   in: after the Settings section if there is one, else first
     */
    constructor(opts = {}) {
        this.doc = opts.doc !== undefined ? opts.doc : (typeof document !== 'undefined' ? document : null);
        this.mount = opts.mount || null;
        this._plot = null;
        this._seq = 0;
        this._panels = new Map();   // id → card entry
        // id → { spec, rows } for every chart drawn this session, kept after
        // its card closes: the exported report re-draws each one (#388).
        this._charts = new Map();
        this._removeListeners = new Set();
        this._section = null;
        this._list = null;
    }

    /**
     * Lazy-load Observable Plot once (d3 first, then Plot). Reuses a valid
     * preloaded global if present; otherwise injects the SRI-pinned scripts.
     */
    async _loadPlot() {
        if (this._plot) return this._plot;
        if (isPlot(globalThis.Plot)) {
            this._plot = globalThis.Plot;
            return this._plot;
        }
        if (typeof document === 'undefined') {
            throw new Error('Charting requires a browser document to load Observable Plot.');
        }
        if (typeof globalThis.d3 === 'undefined') await loadScript(D3_JS, D3_JS_SRI);
        await loadScript(PLOT_JS, PLOT_JS_SRI);
        if (!isPlot(globalThis.Plot)) {
            throw new Error('Observable Plot loaded but its API was not found on window.Plot.');
        }
        this._plot = globalThis.Plot;
        return this._plot;
    }

    /** The Charts section, made on the first chart. */
    _ensureSection() {
        if (this._section) return this._list;
        const d = this.doc;
        const section = d.createElement('section');
        section.className = 'chart-cards menu-section';
        section.setAttribute('aria-label', 'Charts');
        const title = d.createElement('div');
        title.className = 'section-title';
        title.textContent = 'Charts';
        const list = d.createElement('div');
        list.className = 'chart-cards-list';
        section.append(title, list);
        placeFirst(this.mount || d.body, section);
        this._section = section;
        this._list = list;
        return list;
    }

    /**
     * Render a chart on a card. Returns { id } once mounted. Given the id of a
     * chart already drawn, redraws that chart in place with the new spec and
     * rows (SchmidtDSE/glen#426).
     * @param {Object} spec — see buildPlotOptions
     * @param {Array<Object>} rows
     * @param {Object} [opts]
     * @param {string} [opts.id] - the chart's id: an existing chart to update,
     *   or the id a new chart takes
     * @param {boolean} [opts.removable=true] - give a new card a remove button.
     *   An app's configured charts have none, since nothing could bring one
     *   back; every card folds to its title instead.
     */
    async render(spec, rows, { id: wantId, removable = true } = {}) {
        validateChartSpec(spec);      // reject a bad spec before touching the DOM
        // Plot loads when a chart has rows to draw, not for an empty placeholder
        if (spec.chart_type !== 'bar' && rows?.length) await this._loadPlot();

        const existing = wantId ? this._panels.get(wantId) : null;
        if (existing) {
            existing.spec = spec;
            existing.rows = rows;
            this._charts.set(wantId, { spec, rows });
            this._fillHead(existing);
            this._drawFigure(existing);
            return { id: wantId };
        }
        const id = wantId || `chart-${++this._seq}`;
        if (wantId) ++this._seq;
        this._charts.set(id, { spec, rows });
        if (!this.doc) return { id };   // headless (shouldn't happen in-app)

        const d = this.doc;
        const list = this._ensureSection();
        const card = d.createElement('article');
        card.className = 'card chart chart-card';
        card.dataset.chartId = id;

        const head = d.createElement('div');
        head.className = 'card-head';
        const title = d.createElement('h4');
        title.className = 'chart-card-title';
        const actions = d.createElement('span');
        actions.className = 'chart-card-actions';
        const pop = button(d, 'chart-card-pop', 'Enlarge chart', '⤢');
        pop.addEventListener('click', () => this.enlarge(id));
        const fold = button(d, 'chart-card-fold', 'Fold chart', '▾');
        fold.setAttribute('aria-expanded', 'true');
        fold.addEventListener('click', () => this.setFolded(id, fold.getAttribute('aria-expanded') === 'true'));
        actions.append(pop, fold);
        if (removable) {
            const close = button(d, 'chart-card-close', 'Remove chart', '✕');
            close.addEventListener('click', () => this.remove(id));
            actions.append(close);
        }
        head.append(title, actions);

        const sub = d.createElement('div');
        sub.className = 'sub';
        const body = d.createElement('div');
        body.className = 'chart-card-body';
        const status = d.createElement('div');
        status.className = 'chart-card-status';
        status.setAttribute('role', 'status');
        card.append(head, sub, body, status);
        list.prepend(card);   // newest first

        const entry = { card, title, sub, body, status, fold, spec, rows, observer: null, raf: 0, width: 0 };
        this._fillHead(entry);
        this._drawFigure(entry);

        // Re-draw when the side panel's width changes.
        if (typeof ResizeObserver !== 'undefined') {
            entry.observer = new ResizeObserver(() => {
                if (Math.abs((body.clientWidth || 0) - entry.width) < 2) return;
                if (entry.raf) cancelAnimationFrame(entry.raf);
                entry.raf = requestAnimationFrame(() => this._drawFigure(entry));
            });
            entry.observer.observe(body);
        }

        this._panels.set(id, entry);
        this._syncSection();
        // bring a chart the agent just drew into view; an app's own charts open in place
        if (removable) card.scrollIntoView?.({ block: 'nearest' });
        return { id };
    }

    /**
     * Fold a card to its title, or open it again. A folded card keeps its
     * place and stays live; it redraws at its width when opened.
     */
    setFolded(id, folded) {
        const entry = this._panels.get(id);
        if (!entry) return;
        entry.card.classList.toggle('chart-card--folded', !!folded);
        entry.fold.setAttribute('aria-expanded', String(!folded));
        entry.fold.setAttribute('aria-label', folded ? 'Open chart' : 'Fold chart');
        entry.fold.title = folded ? 'Open chart' : 'Fold chart';
        if (!folded) this._drawFigure(entry);
    }

    _fillHead(entry) {
        const { spec } = entry;
        entry.title.textContent = spec.title || `${cap(spec.chart_type)} chart`;
        // A bar chart's value axis has no label of its own: name it under the title.
        entry.sub.textContent = spec.chart_type === 'bar' ? (spec.y_label || '') : '';
        entry.sub.hidden = !entry.sub.textContent;
    }

    /** (Re)draw an entry's figure at its card's current width. */
    _drawFigure(entry) {
        if (!entry || !entry.body) return;
        const width = Math.max(220, entry.body.clientWidth || 400);
        entry.width = entry.body.clientWidth || 0;
        const figure = this._figure(entry.spec, entry.rows, { width, height: Math.round(Math.min(320, Math.max(200, width * 0.62))) });
        if (figure) entry.body.replaceChildren(figure);
    }

    /** A figure element for a spec and rows, or null on a draw error. */
    _figure(spec, rows, { width, height }) {
        const d = this.doc || (typeof document !== 'undefined' ? document : null);
        try {
            if (spec.chart_type === 'bar') {
                if (!d) return null;
                const box = d.createElement('div');
                box.className = 'chart-figure';
                const bar = barSpecFromChart(spec, rows);
                renderBarChart(box, bar.spec, bar.rows, { width });
                return box;
            }
            if (!this._plot) return null;
            return this._plot.plot({ ...buildPlotOptions(this._plot, spec, rows), width, height });
        } catch {
            return null;   // keep the prior figure on a transient draw error
        }
    }

    /** Show one chart large, in a dialog over the page. */
    enlarge(id) {
        const chart = this._charts.get(id);
        const d = this.doc;
        if (!chart || !d) return;
        const dialog = d.createElement('dialog');
        dialog.className = 'chart-dialog';
        const head = d.createElement('div');
        head.className = 'card-head';
        const title = d.createElement('h4');
        title.textContent = chart.spec.title || `${cap(chart.spec.chart_type)} chart`;
        const close = button(d, 'chart-card-close', 'Close', '✕');
        close.addEventListener('click', () => dialog.close());
        head.append(title, close);
        const body = d.createElement('div');
        body.className = 'chart chart-dialog-body';
        dialog.append(head, body);
        dialog.addEventListener('close', () => dialog.remove());
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
        d.body.appendChild(dialog);
        dialog.showModal?.();
        const width = Math.min(960, Math.max(320, (d.defaultView?.innerWidth || 1000) * 0.8 - 40));
        const figure = this._figure(chart.spec, chart.rows, { width, height: Math.round(width * 0.55) });
        if (figure) body.replaceChildren(figure);
    }

    /**
     * For the session export (glen-harness ChatUI): a chart's SQL at the
     * settings its figure shows, with those settings, when the chart follows
     * the Settings panel's controls; otherwise null. The chart tool provides
     * it (queryForExport), since it holds the charts' SQL and the controls.
     *
     * @param {string} id - the `chart_id` render_chart returned
     * @returns {{sql: string, settings: {label: string, value: string}[]}|null}
     */
    exportQuery(id) {
        try {
            return this.queryForExport?.(id) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * A chart as static markup for the exported report: re-drawn at report
     * width from the spec and rows it was last drawn with, so a closed chart
     * still exports. Data values are written as text nodes, so the markup is
     * escaped by construction. Null when the chart is unknown, or Plot is not
     * loaded for a chart that needs it.
     *
     * @param {string} id - the `chart_id` render_chart returned
     * @param {{width?: number, height?: number}} [size]
     * @returns {string|null}
     */
    exportFigure(id, { width = 780, height = 380 } = {}) {
        const chart = this._charts.get(id);
        if (!chart) return null;
        const fig = this._figure(chart.spec, chart.rows, { width, height });
        if (!fig) return null;
        return chart.spec.chart_type === 'bar' ? fig.innerHTML : fig.outerHTML;
    }

    /**
     * Show that a chart is re-running, or why its last run failed. The figure
     * stays on screen, dimmed while loading, until new rows replace it.
     * @param {string} id
     * @param {{loading?: boolean, error?: string|null}} state
     */
    setStatus(id, { loading = false, error = null } = {}) {
        const entry = this._panels.get(id);
        if (!entry) return;
        entry.card.classList.toggle('chart-card--loading', !!loading);
        entry.card.setAttribute('aria-busy', loading ? 'true' : 'false');
        entry.status.textContent = loading ? 'Updating…' : (error || '');
        entry.status.classList.toggle('chart-card-status--error', !loading && !!error);
        // a chart that never drew shows its error alone
        if (error && !entry.rows.length) entry.body.replaceChildren();
    }

    /** Hide or show a chart's card, as a chart's `when` does. */
    setHidden(id, hidden) {
        const entry = this._panels.get(id);
        if (!entry) return;
        entry.card.hidden = !!hidden;
        if (!hidden) this._drawFigure(entry);   // a hidden card had no width to draw at
        this._syncSection();
    }

    /** Whether a chart's card is open. */
    has(id) {
        return this._panels.has(id);
    }

    /** The open charts, for get_map_state. */
    describe() {
        return [...this._panels.entries()].map(([id, e]) => ({
            chart_id: id,
            title: e.spec.title || null,
            chart_type: e.spec.chart_type,
            rows: e.rows.length,
            ...(e.card.hidden && { hidden: true }),
        }));
    }

    remove(id) {
        const entry = this._panels.get(id);
        if (!entry) return false;
        if (entry.observer) entry.observer.disconnect();
        if (entry.raf) cancelAnimationFrame(entry.raf);
        entry.card.remove();
        this._panels.delete(id);
        this._syncSection();
        for (const fn of this._removeListeners) fn(id);
        return true;
    }

    /** onRemove(fn): fn(id) whenever a chart's card closes. */
    onRemove(fn) {
        this._removeListeners.add(fn);
        return () => this._removeListeners.delete(fn);
    }

    removeAll() {
        for (const id of [...this._panels.keys()]) this.remove(id);
    }

    /** The section shows only while it has a chart to show. */
    _syncSection() {
        if (!this._section) return;
        this._section.hidden = ![...this._panels.values()].some(e => !e.card.hidden);
    }
}

function button(d, className, label, text) {
    const b = d.createElement('button');
    b.type = 'button';
    b.className = className;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.textContent = text;
    return b;
}

function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
