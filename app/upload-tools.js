/**
 * upload-tools.js — The GeoJSON upload's agent side, shared by the full app
 * (`upload_enabled`) and glen core's uploads plugin (core/plugins/uploads.js).
 *
 * `UploadManager` (upload-manager.js) owns the button and the files; this
 * module gives the agent `get_uploaded_dataset`, which returns only the
 * files' URLs so the geometry never enters the model's context
 * (geo-agent#325, points #435), and tells the chat when a file arrives.
 */

/**
 * The `get_uploaded_dataset` tool.
 * @param {import('./upload-manager.js').UploadManager} uploadManager
 * @param {string[]} POINT_CELL_COLUMNS - the H3 columns a point upload's SQL source adds
 * @returns {Object} a tool definition
 */
export function createUploadedDatasetTool(uploadManager, POINT_CELL_COLUMNS) {
    return {
        name: 'get_uploaded_dataset',
        description:
            'Get the files the user uploaded to the map: polygon boundaries, or points such as their own ' +
            'occurrence records. Returns public GeoJSON URL(s); the agent does NOT receive the geometry. ' +
            'Read a boundary server-side in the query tool with ST_Read(url) and use it as an area-of-interest mask. ' +
            'A point upload comes with a ready `sql_source` that adds H3 cell columns h10…h0 (UBIGINT, like the ' +
            'catalog\'s hex columns), so the points join to any H3-indexed dataset on a shared column such as h10. ' +
            'Call this when the user refers to "the uploaded file", "my boundary", "my points", "my observations", ' +
            '"the shape I added", "this area", or asks a question about uploaded data. Returns success:false if nothing is uploaded.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => {
            const uploads = uploadManager.getUploads();
            if (!uploads.length) {
                return JSON.stringify({ success: false, error: 'No uploaded dataset. Ask the user to upload a GeoJSON of polygons or points first.' });
            }
            const hints = [];
            if (uploads.some(u => u.kind !== 'point')) {
                hints.push(
                    "Boundaries: read server-side, never inline the geometry. For an H3-indexed dataset, convert the " +
                    "boundary once to cells and JOIN, also on h0, which catalog hex data is partitioned by: " +
                    "WITH aoi AS (SELECT ST_AsText(ST_Union_Agg(geom)) AS wkt FROM ST_Read('<url>')), " +
                    "cells AS (SELECT UNNEST(h3_polygon_wkt_to_cells(aoi.wkt, <res>)) AS cell FROM aoi) " +
                    "SELECT d.* FROM cells JOIN data d ON d.h<res> = cells.cell AND d.h0 = h3_cell_to_parent(cells.cell, 0). " +
                    "Pick <res> to keep cell counts reasonable (coarser for large areas). " +
                    "Use this hex join, not an exact geometry test, whenever the dataset has H3 columns: it is much faster. " +
                    "Only for a dataset without H3 columns, mask with geometry: " +
                    "WITH aoi AS (SELECT ST_Union_Agg(geom) AS g FROM ST_Read('<url>')) " +
                    "SELECT ... FROM data, aoi WHERE ST_Within(data.geom, aoi.g).",
                );
            }
            if (uploads.some(u => u.kind === 'point')) {
                hints.push(
                    "Points: use the dataset's sql_source exactly as given, as a table in FROM or a CTE; " +
                    "do not recompute the cells yourself. " +
                    "WITH pts AS (SELECT * FROM <sql_source>) SELECT ... FROM pts JOIN data d ON d.h10 = pts.h10 AND d.h0 = pts.h0. " +
                    "Join on the finest resolution both sides have (h10 for catalog hex data at resolution 10), and always on h0 too, " +
                    "which catalog hex data is partitioned by, so only the partitions the points fall in are read. " +
                    "A coarser join overcounts: a point matches if anything in its larger cell does. " +
                    "Use this hex join, not an exact geometry test (ST_Within against a polygon file): at h10 it gives the same answer " +
                    "in a fraction of the time. " +
                    "To map counts, aggregate by a cell column, e.g. SELECT h8, count(*) AS n FROM <sql_source> GROUP BY h8.",
                );
            }
            return JSON.stringify({
                success: true,
                datasets: uploads.map(u => ({
                    url: u.url,
                    display_name: u.displayName,
                    kind: u.kind || 'polygon',
                    geometry_type: u.geometryType,
                    feature_count: u.featureCount,
                    property_keys: u.propertyKeys,
                    ...(u.sqlSource ? { sql_source: u.sqlSource, cell_columns: POINT_CELL_COLUMNS } : {}),
                })),
                hint: hints.join(' '),
            });
        },
    };
}

/**
 * Tell the chat and the agent when a file is uploaded, or fails to upload.
 * @param {{ agent: Object, ui: Object, target?: EventTarget }} deps
 */
export function wireUploadNotices({ agent, ui, target = window }) {
    target.addEventListener('geojson-uploaded', (e) => {
        const name = e.detail?.displayName || 'the file';
        const points = e.detail?.kind === 'point';
        ui.addMessage('system', points
            ? `Uploaded "${name}" (${e.detail.featureCount} points) to the map. Ask me anything about these points.`
            : `Uploaded "${name}" to the map. Ask me anything about this area.`);
        agent.messages.push({
            role: 'user',
            content: points
                ? '[The user has uploaded a set of points to the map. Use the get_uploaded_dataset tool to get its ' +
                  'SQL source, with H3 cell columns, when answering questions about these points.]'
                : '[The user has uploaded a polygon boundary to the map. ' +
                  'Use the get_uploaded_dataset tool to retrieve its URL when answering spatial queries about this area.]',
        });
    });
    target.addEventListener('geojson-upload-error', (e) => {
        ui.addMessage('system', `Upload failed: ${e.detail?.message || 'unknown error'}`);
    });
}
