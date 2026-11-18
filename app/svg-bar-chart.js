/**
 * svg-bar-chart.js — Horizontal bar charts in plain SVG, ported from
 * glen-charts' core/charts.js (SchmidtDSE/glen#426, #391).
 *
 * Bars run across, one row per category, so long names read at sidebar width
 * (wrapped onto up to `label_lines` lines) and rows keep the order the query
 * gave them unless `sort` asks otherwise. Colours come from the validated
 * categorical palette; text and grid lines take the page's tokens, with
 * fallbacks so an exported figure reads without them.
 *
 * spec:
 *   category      row label field
 *   series        [{ field, label, color? }]
 *   stacked       stack series end to end (else grouped)
 *   format        value format (see chart-format.js)
 *   sort          'desc' to sort rows by total
 *   limit         keep the first N rows
 *   label_lines   wrap long row labels onto up to N lines (default 2)
 *   title         the figure's accessible name
 */

import { fmt, fmtTick, escapeHtml, isMissing } from './chart-format.js';

export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#4a3aa7', '#e34948', '#e87ba4', '#008300'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const GRID = 'var(--grid, rgba(0, 0, 0, 0.08))';
const BASELINE = 'var(--line-strong, rgba(0, 0, 0, 0.22))';

/**
 * Turn render_chart's long rows (x, y and an optional series column) into the
 * bar spec and rows: one row per category, in the order categories first
 * appear, with one field per series value.
 *
 * @param {Object} args - render_chart's arguments
 * @param {Array<Object>} rows
 * @returns {{spec: Object, rows: Array<Object>}}
 */
export function barSpecFromChart(args, rows) {
    const base = {
        category: args.x,
        stacked: !!args.stacked,
        format: args.format || 'num',
        label_lines: 2,
        title: args.title || '',
        ...(args.sort === 'desc' && { sort: 'desc' }),
    };
    if (!args.series) {
        return { spec: { ...base, series: [{ field: args.y, label: args.y_label || args.y }] }, rows };
    }
    const cats = new Map();
    const names = [];
    for (const r of rows) {
        const c = String(r[args.x]);
        const s = String(r[args.series]);
        if (!names.includes(s)) names.push(s);
        if (!cats.has(c)) cats.set(c, { [args.x]: r[args.x] });
        cats.get(c)[`__s${names.indexOf(s)}`] = r[args.y];
    }
    return {
        spec: { ...base, series: names.map((n, i) => ({ field: `__s${i}`, label: n })) },
        rows: [...cats.values()],
    };
}

/**
 * Draw a horizontal bar chart into `container`.
 * @param {Element} container
 * @param {Object} spec - see the module comment
 * @param {Array<Object>} rows
 * @param {Object} [opts]
 * @param {number} [opts.width] - draw at this width, for a container not yet laid out
 */
export function renderBarChart(container, spec, rows, { width } = {}) {
    const doc = container.ownerDocument;
    container.replaceChildren();
    if (!rows || !rows.length) {
        const empty = doc.createElement('div');
        empty.className = 'sub';
        empty.textContent = 'No rows to chart.';
        container.appendChild(empty);
        return;
    }
    const series = spec.series.map((s, i) => ({ ...s, color: s.color || PALETTE[i % PALETTE.length] }));
    let data = rows.map(r => ({
        cat: r[spec.category],
        vals: series.map(s => (isMissing(r[s.field]) ? null : Number(r[s.field]))),   // null = no data, not drawn
    }));
    if (spec.sort === 'desc') data.sort((a, b) => sum(b.vals) - sum(a.vals));
    if (spec.limit) data = data.slice(0, spec.limit);

    if (series.length > 1) {
        const lg = doc.createElement('div');
        lg.className = 'legend-row';
        lg.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${escapeHtml(s.label)}</span>`).join('');
        container.appendChild(lg);
    }

    // draw at the container's real pixel width so text stays at its CSS size
    const W = Math.max(280, Math.round(width || container.clientWidth || 480));
    const labelW = Math.min(spec.label_width || 150, Math.round(W * (spec.label_width ? 0.45 : 0.34)));
    const valueW = 64;
    let rowH = spec.stacked || series.length === 1 ? 24 : 12 * series.length + 12;
    const barArea = W - labelW - valueW;
    const maxChars = Math.max(8, Math.floor((labelW - 10) / 6.4));   // ~6.4px per char at 11.5px
    const lines = Math.max(1, spec.label_lines || 1);
    if (lines > 1 && data.some(d => String(d.cat).length > maxChars)) rowH = Math.max(rowH, 13 * lines + 6);
    const top = 4, axisH = 18;
    const H = top + data.length * rowH + axisH;

    let max = 0;
    for (const d of data) {
        max = Math.max(max, spec.stacked ? sum(d.vals) : Math.max(0, ...d.vals.map(v => v ?? 0)));
    }
    if (max <= 0) max = 1;
    const ticks = niceTicks(max, 4);
    max = ticks[ticks.length - 1];
    const x = v => labelW + (v / max) * barArea;

    const svg = el(doc, 'svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': spec.title || '' });

    for (const t of ticks) {
        svg.appendChild(el(doc, 'line', { x1: x(t), x2: x(t), y1: top, y2: H - axisH, stroke: GRID }));
        const tx = el(doc, 'text', { x: x(t), y: H - 4, 'text-anchor': 'middle' });
        tx.textContent = fmtTick(t, spec.format);
        svg.appendChild(tx);
    }

    data.forEach((d, i) => {
        const y0 = top + i * rowH;
        svg.appendChild(rowLabel(doc, String(d.cat), labelW - 8, y0 + rowH / 2, maxChars, lines));

        if (spec.stacked) {
            let acc = 0;
            const segs = d.vals.map((v, k) => ({ v, k })).filter(s => s.v > 0);   // null and 0 draw nothing
            segs.forEach((s, j) => {
                const x0 = x(acc), x1 = x(acc + s.v);
                const isLast = j === segs.length - 1;
                const w = Math.max(0, x1 - x0 - (isLast ? 0 : 2));
                svg.appendChild(bar(doc, x0, y0 + 5, w, rowH - 10, series[s.k].color, isLast,
                    `${d.cat} · ${series[s.k].label}: ${fmt(s.v, spec.format)}`));
                acc += s.v;
            });
            const vt = el(doc, 'text', { x: x(acc) + 5, y: y0 + rowH / 2 + 4, class: 'val' });
            vt.textContent = fmt(acc, spec.format);
            svg.appendChild(vt);
        } else {
            const bh = series.length === 1 ? rowH - 10 : 10;
            d.vals.forEach((v, k) => {
                const yy = series.length === 1 ? y0 + 5 : y0 + 6 + k * 12;
                if (v === null) {
                    const vt = el(doc, 'text', { x: x(0) + 5, y: yy + bh - 1, class: 'nodata' });
                    vt.textContent = fmt(null);
                    svg.appendChild(vt);
                    return;
                }
                svg.appendChild(bar(doc, x(0), yy, Math.max(0, x(v) - x(0)), bh, series[k].color, true,
                    `${d.cat} · ${series[k].label}: ${fmt(v, spec.format)}`));
                const vt = el(doc, 'text', { x: x(v) + 5, y: yy + bh - 1, class: 'val' });
                vt.textContent = fmt(v, spec.format);
                svg.appendChild(vt);
            });
        }
    });

    svg.appendChild(el(doc, 'line', { x1: x(0), x2: x(0), y1: top, y2: H - axisH, stroke: BASELINE }));
    container.appendChild(svg);
}

/** A bar with a 4px rounded data end, square at the baseline; its <title> is the tooltip. */
function bar(doc, x, y, w, h, color, roundEnd, tip) {
    const r = roundEnd ? Math.min(4, w / 2, h / 2) : 0;
    const d = `M${x},${y} h${Math.max(0, w - r)} ${r ? `a${r},${r} 0 0 1 ${r},${r}` : ''} v${h - 2 * r} ${r ? `a${r},${r} 0 0 1 ${-r},${r}` : ''} h${-Math.max(0, w - r)} z`;
    const p = el(doc, 'path', { d, fill: color });
    p.appendChild(titleEl(doc, tip));
    return p;
}

export function niceTicks(max, n) {
    const raw = max / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const out = [];
    for (let v = 0; v <= max + step * 0.999; v += step) out.push(+v.toPrecision(12));
    return out;
}

function el(doc, tag, attrs = {}) {
    const n = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
}

/**
 * A right-aligned row label centred on y: wrapped at spaces onto up to
 * `lines` lines, the last one truncated with an ellipsis, and the full text
 * as a tooltip when anything was cut.
 */
export function rowLabel(doc, text, x, y, maxChars, lines = 1) {
    const out = [];
    let rest = text.trim();
    while (rest && out.length < lines) {
        if (rest.length <= maxChars) { out.push(rest); rest = ''; break; }
        if (out.length === lines - 1) { out.push(rest.slice(0, maxChars - 1) + '…'); rest = '…'; break; }
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut <= 0) cut = maxChars;
        out.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    const lab = el(doc, 'text', { x, y: y + 4 - (out.length - 1) * 6.5, 'text-anchor': 'end' });
    if (out.length === 1) lab.textContent = out[0];
    else out.forEach((t, i) => { const ts = el(doc, 'tspan', { x, dy: i ? 13 : 0 }); ts.textContent = t; lab.appendChild(ts); });
    if (rest) lab.appendChild(titleEl(doc, text));
    return lab;
}

function titleEl(doc, text) {
    const t = el(doc, 'title');
    t.textContent = text;
    return t;
}

const sum = a => a.reduce((s, v) => s + (v ?? 0), 0);
