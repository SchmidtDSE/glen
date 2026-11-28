/**
 * uploads.js — glen core plugin: let a visitor upload a GeoJSON of polygons
 * or points and ask about it, as the full app does with `upload_enabled`
 * (SchmidtDSE/glen#441).
 *
 * Adds the full app's upload button and map drop target (app/upload-manager.js),
 * the `get_uploaded_dataset` tool, and the chat notices (app/upload-tools.js).
 * The file never passes through the model; the agent gets only where it is
 * and reads it with the SQL server's `query` tool, so this plugin needs an
 * SQL server from plugins/mcp.js. Where the file goes depends on where that
 * SQL runs:
 *
 *   - In the browser (a geo-query-wasm worker server): the file goes to the
 *     worker and SQL reads it under /upload/ (SchmidtDSE/glen#463). It is
 *     stored nowhere and never leaves the visitor's browser.
 *   - On a server: the file is PUT to a public S3 bucket and SQL reads its URL,
 *     as in the full app.
 *
 * `storage` chooses: "browser", "s3", or, by default, the browser when
 * plugins/mcp.js runs a worker server and S3 otherwise. The other options are
 * the full app's upload settings (bucket, prefix, size caps, ingest link), and
 * `geo_query_wasm`, the geo-query-wasm release whose file helpers to load
 * (match the worker's); see docs/guide/configuration.md.
 *
 *   "plugins": [{ "url": "…/core/plugins/uploads.js", "options": {} }]
 */

import { DEFAULT_GEO_QUERY_WASM, geoQueryWasmUrl } from '../geo-query-wasm.js';

/**
 * Where uploads go, chosen at the first upload so the order of the plugins
 * in the config does not matter: plugins/mcp.js sets `ctx.sqlWorker` when it
 * runs a worker server.
 */
export function chooseStore(ctx, options, { s3UploadStore, workerUploadStore, cfg, loadFiles }) {
    const storage = options.storage || (ctx.sqlWorker ? 'browser' : 's3');
    if (storage === 's3') return s3UploadStore(cfg);
    if (storage !== 'browser') throw new Error(`uploads plugin: storage must be "browser" or "s3", not "${storage}"`);
    if (!ctx.sqlWorker) throw new Error('this app runs no SQL in the browser to give the file to');
    return workerUploadStore(ctx.sqlWorker, loadFiles);
}

const plugin = {
    name: 'uploads',

    /** geo-query-wasm's visitor-file helpers; tests replace this method. */
    async loadFiles(ref) {
        return import(geoQueryWasmUrl(ref, 'src/files.js'));
    },

    async setup(ctx, options = {}) {
        options = options || {};
        const [{ UploadManager, POINT_CELL_COLUMNS, s3UploadStore, workerUploadStore }, { createUploadedDatasetTool, wireUploadNotices }] = await Promise.all([
            import('../../app/upload-manager.js'),
            import('../../app/upload-tools.js'),
        ]);
        let chosen = null;
        const pick = () => (chosen ??= chooseStore(ctx, options, {
            s3UploadStore, workerUploadStore, cfg: uploads.cfg,
            loadFiles: () => this.loadFiles(options.geo_query_wasm || DEFAULT_GEO_QUERY_WASM),
        }));
        const store = {
            get verb() {
                try { return pick().verb; } catch { return 'Adding'; }
            },
            // A store that cannot be chosen fails the upload with its reason.
            put: async (args) => pick().put(args),
        };
        const uploads = new UploadManager(ctx.map, options, { store });
        uploads.init();
        ctx.uploads = uploads;
        ctx.tools.registerLocal(createUploadedDatasetTool(uploads, POINT_CELL_COLUMNS));
        ctx.onReady(({ agent, ui }) => wireUploadNotices({ agent, ui }));
    },
};

export default plugin;
