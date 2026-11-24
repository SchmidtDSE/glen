/**
 * query-download.js — Download the rows behind a `query` result as CSV or
 * GeoJSON (SchmidtDSE/glen#464), used by core/plugins/downloads.js.
 *
 * The model sees at most 50 rows of a query. A download re-runs the same SQL
 * through the app's `query` tool, so the rows go from the SQL engine to the
 * page and never through the model. In the browser (geo-query-wasm) the tool
 * returns them with `format: "json"`; a server without that format (geo-query)
 * returns them as one JSON cell, as chart SQL does (chart-tool.js).
 *
 * Before the rows, a DESCRIBE of the query gives its columns. 64-bit integers
 * are cast to text, because a JavaScript number would change the last digits
 * of one such as an H3 cell id, and those small enough become numbers again. A
 * GEOMETRY column becomes GeoJSON geometry, or WKT in a CSV.
 */

import { extractJsonArray } from './chart-tool.js';

/** The most rows a download holds; a larger result keeps its first rows. */
export const DOWNLOAD_ROW_LIMIT = 100000;

const WIDE_INTS = /^(BIGINT|UBIGINT|HUGEINT|UHUGEINT)$/i;
const GEOMETRY = /^GEOMETRY\b/i;
const SQL_ARGS = new Set(['sql_query', 'sql', 'query', 'format']);

const quoteId = (name) => `"${String(name).replace(/"/g, '""')}"`;
// A trailing `;` would end the statement inside a wrapper, and a trailing
// `--` comment would swallow its close, hence the newline before `)`.
const body = (sql) => String(sql).replace(/[\s;]+$/, '');
const from = (sql, alias) => `FROM (\n${body(sql)}\n) ${alias}`;

/**
 * A function that runs a SELECT through the app's `query` tool and returns its
 * rows.
 *
 * @param {Object} queryTool - the registered `query` tool, for its arguments
 * @param {(sql: string, extra: Object) => Promise<string>} run - runs SQL
 *   through it (core/run-query.js), passing on the arguments it takes
 * @param {Object} [extra] - the original call's other arguments, such as an
 *   S3 endpoint or scope
 * @returns {(sql: string) => Promise<Object[]>}
 */
export function rowFetcher(queryTool, run, extra = {}) {
    const props = queryTool?.inputSchema?.properties || {};
    const asJson = (props.format?.enum || []).includes('json');
    const pass = Object.fromEntries(Object.entries(extra || {}).filter(([k]) => !SQL_ARGS.has(k)));
    return async (sql) => {
        if (asJson) return parseJsonRows(await run(sql, { ...pass, format: 'json' }));
        return parseCellRows(await run(`SELECT to_json(array_agg(__r)) AS rows ${from(sql, '__r')}`, pass));
    };
}

const textOf = (raw) => (typeof raw === 'string' ? raw : JSON.stringify(raw));

/** Rows from `format: "json"`: the array itself, or `null` for none. */
export function parseJsonRows(raw) {
    const text = textOf(raw).trim();
    let rows;
    try {
        rows = JSON.parse(text);
    } catch {
        throw new Error(text.slice(0, 300) || 'the query returned nothing');
    }
    if (rows == null) return [];
    if (!Array.isArray(rows)) throw new Error(text.slice(0, 300));
    return rows;
}

/** Rows from a markdown table whose one cell holds a JSON array. */
export function parseCellRows(raw) {
    const text = textOf(raw);
    // array_agg over no rows is NULL: an empty cell, or "null".
    const last = text.trim().split('\n').pop().replace(/[|\s]/g, '');
    if (!text.trim() || /^No results found/i.test(text.trim()) || last === '' || /^null$/i.test(last)) return [];
    const rows = extractJsonArray(text);
    if (!rows) throw new Error(text.slice(0, 300));
    return rows;
}

/**
 * The SELECT a download runs: the query's columns with 64-bit integers as
 * text, its first geometry as GeoJSON (for GeoJSON) and any others as WKT,
 * limited to one row more than `limit` so a larger result can be told apart.
 */
export function downloadSql(sql, columns, kind, limit = DOWNLOAD_ROW_LIMIT) {
    const geometry = columns.find(c => GEOMETRY.test(c.column_type))?.column_name;
    const replace = [];
    for (const { column_name: name, column_type: type } of columns) {
        const q = quoteId(name);
        if (WIDE_INTS.test(type)) replace.push(`CAST(${q} AS VARCHAR) AS ${q}`);
        else if (GEOMETRY.test(type)) {
            replace.push(kind === 'geojson' && name === geometry ? `ST_AsGeoJSON(${q}) AS ${q}` : `ST_AsText(${q}) AS ${q}`);
        }
    }
    const select = replace.length ? `SELECT * REPLACE (${replace.join(', ')})` : 'SELECT *';
    return `${select} ${from(sql, '__d')} LIMIT ${Math.floor(limit) + 1}`;
}

/**
 * 64-bit integers come back as text (downloadSql). Those a JavaScript number
 * holds exactly, such as counts, become numbers again; larger ones, such as
 * H3 cell ids, stay text so no digit changes.
 */
export function restoreSafeIntegers(rows, columns) {
    if (!columns.length) return rows;
    for (const r of rows) {
        for (const c of columns) {
            const v = r[c];
            if (typeof v === 'string' && /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v))) r[c] = Number(v);
        }
    }
    return rows;
}

const csvCell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV text, with a header row, in the query's column order. */
export function toCsv(rows, columns) {
    const cols = columns?.length ? columns : [...new Set(rows.flatMap(r => Object.keys(r)))];
    const lines = [cols.map(csvCell).join(',')];
    for (const r of rows) lines.push(cols.map(c => csvCell(r[c])).join(','));
    return lines.join('\r\n') + '\r\n';
}

/** A GeoJSON FeatureCollection with `geometry` as each feature's geometry. */
export function toGeoJson(rows, geometry) {
    const features = rows.map((r) => {
        let geom = r[geometry] ?? null;
        if (typeof geom === 'string') {
            try { geom = JSON.parse(geom); } catch { geom = null; }
        }
        const { [geometry]: _, ...properties } = r;
        return { type: 'Feature', geometry: geom, properties };
    });
    return JSON.stringify({ type: 'FeatureCollection', features });
}

/**
 * Run a query again for a download and build the file.
 *
 * @param {(sql: string) => Promise<Object[]>} fetchRows - from rowFetcher
 * @param {string} sql - the query the agent ran
 * @param {'csv'|'geojson'} kind
 * @returns {Promise<{ok: true, text: string, rows: number, truncated: boolean, mime: string, ext: string}
 *   | {ok: false, error: string}>}
 */
export async function buildDownload(fetchRows, sql, kind, { limit = DOWNLOAD_ROW_LIMIT } = {}) {
    try {
        const columns = await fetchRows(`DESCRIBE SELECT * ${from(sql, '__d')}`);
        if (!columns.length) return { ok: false, error: 'The query has no columns.' };
        const geometry = columns.find(c => GEOMETRY.test(c.column_type))?.column_name;
        if (kind === 'geojson' && !geometry) {
            return { ok: false, error: 'This result has no geometry column, so it cannot be GeoJSON. The CSV has every column.' };
        }
        const rows = await fetchRows(downloadSql(sql, columns, kind, limit));
        const truncated = rows.length > limit;
        if (truncated) rows.length = limit;
        restoreSafeIntegers(rows, columns.filter(c => WIDE_INTS.test(c.column_type)).map(c => c.column_name));
        return kind === 'geojson'
            ? { ok: true, text: toGeoJson(rows, geometry), rows: rows.length, truncated, mime: 'application/geo+json', ext: 'geojson' }
            : { ok: true, text: toCsv(rows, columns.map(c => c.column_name)), rows: rows.length, truncated, mime: 'text/csv', ext: 'csv' };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/** Whether a tool result is a `query` that returned rows, worth a download. */
export function isDownloadable(result) {
    if (!result || result.name !== 'query' || result.success === false || !result.sqlQuery) return false;
    const text = textOf(result.result ?? '').trim();
    return !!text && !/^(No results found|SQL Error|Error\b|Query timed out)/i.test(text);
}
