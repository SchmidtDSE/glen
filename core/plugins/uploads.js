/**
 * uploads.js — glen core plugin: let a visitor upload a GeoJSON of polygons
 * or points and ask about it, as the full app does with `upload_enabled`
 * (SchmidtDSE/glen#441).
 *
 * Adds the full app's upload button and map drop target (app/upload-manager.js),
 * the `get_uploaded_dataset` tool, and the chat notices (app/upload-tools.js).
 * The file goes from the browser to S3 and the agent receives only its URL,
 * which it reads with the SQL server's `query` tool, so this plugin needs an
 * SQL server from plugins/mcp.js. The plugin's options are the full app's
 * upload settings (bucket, prefix, size caps, ingest link); see
 * docs/guide/configuration.md.
 *
 *   "plugins": [{ "url": "…/core/plugins/uploads.js", "options": {} }]
 */

const plugin = {
    name: 'uploads',

    async setup(ctx, options = {}) {
        const [{ UploadManager, POINT_CELL_COLUMNS }, { createUploadedDatasetTool, wireUploadNotices }] = await Promise.all([
            import('../../app/upload-manager.js'),
            import('../../app/upload-tools.js'),
        ]);
        const uploads = new UploadManager(ctx.map, options || {});
        uploads.init();
        ctx.uploads = uploads;
        ctx.tools.registerLocal(createUploadedDatasetTool(uploads, POINT_CELL_COLUMNS));
        ctx.onReady(({ agent, ui }) => wireUploadNotices({ agent, ui }));
    },
};

export default plugin;
