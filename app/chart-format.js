/**
 * chart-format.js — Number formatting by named format, ported from glen-charts'
 * core/format.js (SchmidtDSE/glen#426). The two now change separately.
 *
 * Options, set with setFormatOptions():
 *   nodata        text for a missing value (NULL, NaN, '')        default "—"
 *   pct_decimals  "auto" (one decimal below 10%, else none) or a number   default "auto"
 */

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const opts = { nodata: '—', pct_decimals: 'auto' };

export function setFormatOptions(o = {}) {
    Object.assign(opts, o);
}

export const isMissing = value => value === null || value === undefined || value === '' || (typeof value !== 'string' && Number.isNaN(Number(value)));

export function fmt(value, format = 'num') {
    if (value === null || value === undefined || value === '') return opts.nodata;
    if (format === 'text') return String(value);
    if (Number.isNaN(Number(value))) return opts.nodata;
    const v = Number(value);
    switch (format) {
        case 'int': return nf0.format(v);
        case 'compact': return Math.abs(v) >= 1e4 ? compact.format(v) : nf0.format(v);
        case 'usd': return '$' + (Math.abs(v) >= 1e4 ? compact.format(v) : nf0.format(v));
        case 'pct': return pct(v * 100);            // 0–1 fraction
        case 'pct100': return pct(v);               // already 0–100
        case 'acres': return (Math.abs(v) >= 1e5 ? compact.format(v) : nf0.format(v)) + ' ac';
        case 'km2': return (Math.abs(v) >= 1e5 ? compact.format(v) : Math.abs(v) >= 10 ? nf0.format(v) : nf1.format(v)) + ' km²';
        case 'ha': return (Math.abs(v) >= 1e5 ? compact.format(v) : nf0.format(v)) + ' ha';
        case 'num1': return nf1.format(v);
        case 'num2': return nf2.format(v);
        case 'per1k': return nf1.format(v);
        case 'degC': return (v > 0 ? '+' : '') + nf1.format(v) + ' °C';   // a change
        case 'meters': return v >= 1000 ? nf1.format(v / 1000) + ' km' : nf0.format(Math.round(v / 10) * 10) + ' m';
        case 'tempC': return nf1.format(v) + ' °C';                         // a level
        case 'ordinal': return ordinal(Math.round(v));
        default: return Math.abs(v) >= 1e5 ? compact.format(v) : nf1.format(v);
    }
}

function pct(p) {
    if (p !== 0 && Math.abs(p) < 0.1) return '<0.1%';
    const d = opts.pct_decimals;
    if (d === 'auto') return (Math.abs(p) < 10 ? nf1.format(p) : nf0.format(p)) + '%';
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: Number(d) }).format(p) + '%';
}

export function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = Math.abs(n) % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Short axis-tick formatting. */
export function fmtTick(value, format) {
    if (format === 'usd') return '$' + compact.format(value);
    if (format === 'pct') return nf0.format(value * 100) + '%';
    if (format === 'pct100') return nf0.format(value) + '%';
    if (format === 'degC' || format === 'tempC') return nf1.format(value) + '°';
    return compact.format(value);
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
