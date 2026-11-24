/**
 * downloads.js — glen core plugin: buttons under each `query` result in the
 * chat that download its rows as CSV or GeoJSON (SchmidtDSE/glen#464).
 *
 * The model sees at most 50 rows of a query. A button re-runs the same SQL
 * through the app's `query` tool (another plugin's, such as plugins/mcp.js),
 * with the call's S3 endpoint and scope, and writes the file in the browser,
 * so the rows never pass through the model. A download holds at most
 * `max_rows` rows (100,000 by default) and says so when the result had more.
 *
 *   "plugins": [
 *     { "url": "…/core/plugins/mcp.js", "options": { … } },
 *     { "url": "…/core/plugins/downloads.js", "options": { "max_rows": 100000 } }
 *   ]
 *
 * GeoJSON needs a GEOMETRY column in the result; the button says so when there
 * is none. The buttons need glen-harness v0.6.0 or later (ChatUI.addResultAction).
 */

import { runQuery } from '../run-query.js';

/**
 * The buttons for one tool result, or null when it is not a query with rows.
 *
 * @param {Object} result - a tool result as ChatUI shows it
 * @param {Object} deps
 * @param {Object} deps.tools - the tool registry
 * @param {Object} deps.lib - app/query-download.js
 * @param {Document} deps.doc
 * @param {(text: string, filename: string, mime: string) => void} deps.save
 * @param {number} [deps.limit]
 * @param {() => Date} [deps.now]
 * @returns {Element[]|null}
 */
export function downloadButtons(result, { tools, lib, doc, save, limit, now = () => new Date() }) {
    if (!lib.isDownloadable(result)) return null;
    const queryTool = tools.tools?.get?.('query');
    if (!queryTool) return null;
    const fetchRows = lib.rowFetcher(queryTool, (sql, extra) => runQuery(tools, sql, extra), result.args || {});
    const note = doc.createElement('span');
    note.className = 'download-note';
    note.setAttribute('role', 'status');

    const button = (kind, label) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'download-button';
        b.textContent = label;
        b.title = `Download every row of this query as ${label}`;
        b.addEventListener('click', async () => {
            if (b.disabled) return;
            b.disabled = true;
            note.textContent = 'Preparing…';
            const res = await lib.buildDownload(fetchRows, result.sqlQuery, kind, limit ? { limit } : {});
            b.disabled = false;
            if (!res.ok) {
                note.textContent = res.error;
                return;
            }
            save(res.text, `${fileStem(now())}.${res.ext}`, res.mime);
            const n = res.rows.toLocaleString('en-US');
            note.textContent = res.truncated
                ? `The first ${n} rows; the result has more.`
                : `${n} ${res.rows === 1 ? 'row' : 'rows'}.`;
        });
        return b;
    };
    return [button('csv', 'CSV'), button('geojson', 'GeoJSON'), note];
}

/** "query-2026-11-24-1830": the file name, from the time of the download. */
export function fileStem(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `query-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/** Offer text as a file to save. */
export function saveText(text, filename, mime, doc = document) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

const plugin = {
    name: 'downloads',

    async setup(ctx, options = {}) {
        const lib = await import('../../app/query-download.js');
        const limit = Number.isFinite(options.max_rows) && options.max_rows > 0 ? Math.floor(options.max_rows) : lib.DOWNLOAD_ROW_LIMIT;
        ctx.onReady?.(({ ui }) => {
            if (typeof ui?.addResultAction !== 'function') {
                console.warn('[downloads] This glen-harness has no ChatUI.addResultAction (v0.6.0 or later); no download buttons.');
                return;
            }
            const doc = typeof document !== 'undefined' ? document : null;
            if (!doc) return;
            ui.addResultAction((result) => downloadButtons(result, {
                tools: ctx.tools, lib, doc, limit, save: (text, name, mime) => saveText(text, name, mime, doc),
            }));
        });
    },
};

export default plugin;
