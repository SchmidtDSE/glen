/**
 * catalog-tools.js — The agent's catalog tools, answered in the browser.
 *
 * `get_schema` and `get_stac_details` used to be MCP calls; the app forwarded
 * its cached STAC inline and the server rendered it (#192, #354). They are now
 * answered here, from the STAC the app loaded, with the same text (#441,
 * Phase B). That keeps every catalog question inside the collections the
 * app's layers-input.json lists, and leaves the MCP server only the compute
 * tools (`query` and the hex tools).
 *
 * The two tools return the same document. Both names stay because the system
 * prompt, the tool hints and the models' habits use both: `get_schema` before
 * a first query, `get_stac_details` for sub-datasets and to recover a path.
 */

import { formatCollection, DEFAULT_S3_SOURCES } from './stac-details.js';

/**
 * The MCP tools these replace. The app does not register them from any
 * server: they could read collections the app does not list.
 */
export const MCP_CATALOG_TOOLS = ['browse_stac_catalog', 'get_stac_details', 'get_collection', 'get_schema'];

/**
 * @param {Object} catalog - a DatasetCatalog, or anything with
 *   `resolveStac(id)` and `getIds()`
 * @param {Object} [options]
 * @param {Array<Object>} [options.s3Sources] - extra https → s3 prefixes,
 *   tried before the defaults (layers-input.json `s3_sources`)
 * @returns {Array<Object>} tool definitions for ToolRegistry.registerLocal
 */
export function createCatalogTools(catalog, { s3Sources = [] } = {}) {
    const sources = [...(Array.isArray(s3Sources) ? s3Sources : []), ...DEFAULT_S3_SOURCES];

    const describe = async (id) => {
        let hit = null;
        try {
            hit = await catalog.resolveStac(id);
        } catch (err) {
            return JSON.stringify({ success: false, error: `Could not read the metadata for ${id}: ${err.message || err}` });
        }
        if (!hit) {
            return JSON.stringify({
                success: false,
                error: `Dataset not found: ${id}. This app's datasets are: ${catalog.getIds().join(', ')}. `
                    + 'Sub-datasets are listed by get_stac_details on their parent.',
            });
        }
        return formatCollection(hit.doc, { url: hit.url, children: hit.children, sources });
    };

    return [
        {
            name: 'get_schema',
            description: 'Get column names, types, descriptions and coded value lists for a dataset, with its read_parquet() paths. **Call this before your first SQL query against a dataset.**',
            inputSchema: {
                type: 'object',
                properties: {
                    dataset_id: { type: 'string', description: 'Collection ID of the dataset' },
                },
                required: ['dataset_id'],
            },
            execute: (args) => describe(args?.dataset_id),
        },
        {
            name: 'get_stac_details',
            description: 'Get the full metadata for one of this app\'s datasets or sub-datasets: description, read_parquet() paths, column schemas and the list of sub-datasets. Use it to find a sub-dataset\'s path, or the right path after a query fails to find its files.',
            inputSchema: {
                type: 'object',
                properties: {
                    dataset_id: { type: 'string', description: 'Collection ID of a dataset or sub-dataset' },
                },
                required: ['dataset_id'],
            },
            execute: (args) => describe(args?.dataset_id),
        },
    ];
}
