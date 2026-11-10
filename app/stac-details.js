/**
 * stac-details.js — Render a STAC collection for the agent, in the browser.
 *
 * The app answers `get_stac_details` and `get_schema` itself, from the STAC it
 * loaded at boot (#441, Phase B). Until v3.44 those calls went to the MCP
 * server, which rendered the same markdown from the same JSON; this is a port
 * of that renderer (geo-query `stac.py`: `_format_collection`,
 * `_extract_parquet_assets`, `_format_columns`) so the model sees the text it
 * is used to. Moving it here means the app reads only the collections its
 * `layers-input.json` names, whatever the catalog around them looks like, and
 * the MCP server's catalog tools can be retired.
 *
 * Pure functions on STAC JSON; no fetching.
 */

/**
 * HTTPS prefixes that DuckDB should read as s3:// paths. These match the MCP
 * server's built-in sources (geo-query `s3config.py`); an app adds its own
 * with `s3_sources` in layers-input.json, in the same shape:
 * `[{ "https_prefix": "https://host/", "s3_prefix": "s3://" }]`.
 */
export const DEFAULT_S3_SOURCES = [
    // NRP Ceph: the server's default S3 secret reads these paths.
    { https_prefix: 'https://s3-west.nrp-nautilus.io/', s3_prefix: 's3://' },
    // The source.coop gateway cannot list or glob; the bucket form can.
    { https_prefix: 'https://data.source.coop/', s3_prefix: 's3://us-west-2.opendata.source.coop/' },
];

const HIDDEN_COLUMNS = new Set(['geometry', 'geom', 'bbox']);
const EXTENSION_FIELDS = ['h3:native_resolution', 'h3:parent_resolutions', 'raster:bands', 'vector:layers'];

/** Rewrite an HTTPS href to the s3:// path DuckDB reads, or return it unchanged. */
export function rewriteHref(href, sources = DEFAULT_S3_SOURCES) {
    for (const s of sources || []) {
        if (s?.https_prefix && s?.s3_prefix && href.startsWith(s.https_prefix)) {
            return s.s3_prefix + href.slice(s.https_prefix.length);
        }
    }
    return href;
}

/**
 * For an HTTPS href on a host no source covers: the s3:// path and the
 * endpoint and scope the `query` tool needs to read it, assuming path-style
 * S3. Mirrors geo-query `s3config.route_hint`.
 * @returns {{path: string, endpoint: string, scope: string}|null}
 */
export function routeHint(href) {
    const m = /^https:\/\/([^/]+)\/(.+)$/.exec(href);
    if (!m) return null;
    const [, host, rest] = m;
    const vhost = /^([^/]+?)\.(s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com)$/.exec(host);
    let bucket, key, endpoint;
    if (vhost) {
        [, bucket, endpoint] = vhost;
        key = rest;
    } else {
        const i = rest.indexOf('/');
        bucket = i < 0 ? rest : rest.slice(0, i);
        key = i < 0 ? '' : rest.slice(i + 1);
        endpoint = host;
    }
    if (!bucket || !key) return null;
    return { path: `s3://${bucket}/${key}`, endpoint, scope: `s3://${bucket}` };
}

/** True for an asset the `query` tool reads with read_parquet(). */
export function isQueryableAsset(asset) {
    const href = asset?.href || '';
    const type = asset?.type || '';
    if (type.includes('pmtiles') || href.endsWith('.pmtiles')) return false;
    if (type.includes('tif') || href.endsWith('.tif') || href.endsWith('.tiff')) return false;
    return type.includes('parquet') || href.endsWith('.parquet') || href.endsWith('/') || href.includes('/hex/');
}

/**
 * The read_parquet() path for a queryable asset, and the routing note when
 * its host is unknown.
 * @returns {{path: string, hint: Object|null}}
 */
export function parquetPath(href, sources = DEFAULT_S3_SOURCES) {
    let path = rewriteHref(href, sources);
    const hint = path.startsWith('http') ? routeHint(path) : null;
    if (hint) path = hint.path;
    if (path.endsWith('/')) path = `${path.replace(/\/+$/, '')}/**`;
    return { path, hint };
}

/** Markdown lines for table:columns, without geometry columns. */
export function formatColumns(cols) {
    const lines = [];
    for (const c of cols || []) {
        if (!c?.name || HIDDEN_COLUMNS.has(c.name.toLowerCase())) continue;
        const desc = c.description ? ` — ${c.description}` : '';
        lines.push(`    - \`${c.name}\` (${c.type || '?'})${desc}`);
        if (Array.isArray(c.values) && c.values.length) lines.push(`      values: ${pyList(c.values)}`);
    }
    return lines;
}

function assetColumnSummary(cols) {
    return (cols || []).filter(c => c?.name).map(c => (c.type ? `\`${c.name}\` (${c.type})` : `\`${c.name}\``)).join(', ');
}

/**
 * Lines for a collection's queryable assets. Each asset lists its own column
 * names and types; every column's description and values appear once, in a
 * shared block after the assets. `compact` leaves the columns out, for the
 * list of sub-datasets.
 */
export function formatParquetAssets(col, { compact = false, sources = DEFAULT_S3_SOURCES } = {}) {
    const lines = [];
    const shared = new Map();
    for (const [assetId, asset] of Object.entries(col?.assets || {})) {
        if (!isQueryableAsset(asset)) continue;
        const { path, hint } = parquetPath(asset.href || '', sources);
        const size = asset['file:size'];
        const sizeNote = size && size > 1024 ** 2 ? ` (${(size / 1024 ** 3).toFixed(2)} GiB)` : '';
        lines.push(`  - ${asset.title || assetId}${sizeNote}: \`read_parquet('${path}')\``);
        if (hint) {
            lines.push(`    - ⚠️ non-default endpoint (derived from \`${asset.href}\` assuming path-style S3): `
                + `call \`query\` with s3_endpoint='${hint.endpoint}', s3_scope='${hint.scope}' `
                + '(anonymous; add s3_key/s3_secret if private)');
        }
        if (asset.description) lines.push(`    - ${asset.description}`);
        for (const k of EXTENSION_FIELDS) {
            if (asset[k] != null) lines.push(`    - ${k}: ${pyStr(asset[k])}`);
        }
        if (compact) continue;
        // An asset without its own list is described by the collection's
        // (Portolan: per-asset lists only where a schema differs, #441).
        const cols = Array.isArray(asset['table:columns']) ? asset['table:columns']
            : Array.isArray(col?.['table:columns']) ? col['table:columns'] : [];
        const summary = assetColumnSummary(cols);
        if (summary) lines.push(`    - columns: ${summary}`);
        for (const c of cols) {
            if (!c?.name) continue;
            const held = shared.get(c.name);
            if (!held) { shared.set(c.name, { ...c }); continue; }
            for (const k of ['description', 'values', 'type']) {
                if (!held[k] && c[k]) held[k] = c[k];
            }
        }
    }
    if (!compact) {
        // A Portolan collection describes its columns once, on the collection
        // (PORTO-FMT-046); an asset may then list only names and types. Fill
        // what the assets leave out from the collection's dictionary (#441).
        fillFromDictionary(shared, col?.['table:columns']);
        const block = formatColumns([...shared.values()]);
        if (block.length) lines.push('\nColumn descriptions (shared across the assets above):', ...block);
    }
    return lines;
}

/**
 * Fill each column's missing description, values and type from a
 * `table:columns` list, matching by name.
 * @param {Map<string, Object>} byName - column name → column, filled in place
 * @param {Array<Object>} dictionary
 */
export function fillFromDictionary(byName, dictionary) {
    if (!Array.isArray(dictionary)) return byName;
    for (const d of dictionary) {
        const held = d?.name && byName.get(d.name);
        if (!held) continue;
        for (const k of ['description', 'values', 'type']) {
            if (!held[k] && d[k]) held[k] = d[k];
        }
    }
    return byName;
}

/**
 * True if the collection has a queryable asset. Such an asset is described by
 * its own `table:columns` or, lacking one, by the collection's, so the shared
 * block already carries the collection's dictionary and a separate
 * `Key columns` trailer would print it twice (#441).
 */
function hasQueryableAsset(col) {
    return Object.values(col?.assets || {}).some(a => isQueryableAsset(a));
}

/**
 * The markdown `get_stac_details` returns for one collection.
 *
 * @param {Object} col - STAC collection (or catalog) JSON
 * @param {Object} [options]
 * @param {string} [options.url] - where it was read from
 * @param {Array<Object>} [options.children] - its sub-collections, already read
 * @param {Array<Object>} [options.sources] - https → s3 prefixes
 * @returns {string}
 */
export function formatCollection(col, { url = null, children = [], sources = DEFAULT_S3_SOURCES } = {}) {
    const lines = [`**${col.title || col.id}**`, `Collection ID: \`${col.id}\``];
    const self = url || (col.links || []).find(l => l.rel === 'self')?.href;
    if (self) lines.push(`collection_url: \`${self}\``);
    if (col.description) lines.push(col.description);

    const parquet = formatParquetAssets(col, { sources });
    const keyColumns = !hasQueryableAsset(col) && Array.isArray(col['table:columns']) && col['table:columns'].length
        ? ['\nKey columns:', ...formatColumns(col['table:columns'])]
        : [];

    if (children.length) {
        lines.push(`\n**Sub-datasets (${children.length}):**\n`);
        for (const sc of children) {
            lines.push(`*${sc.title || sc.id}* (\`${sc.id}\`):`);
            lines.push(...formatParquetAssets(sc, { compact: true, sources }));
            lines.push(`  - columns: call get_stac_details('${sc.id}')`);
        }
        lines.push(`\nCall get_stac_details with a sub-dataset ID (e.g. \`${children[0].id}\`) for column schemas and details.`);
        // A collection with its own tables as well as sub-datasets keeps them.
        if (parquet.length) lines.push('\nSQL data in this collection itself (use with `query` tool):', ...parquet, ...keyColumns);
    } else if (parquet.length) {
        lines.push('\nSQL data (use with `query` tool):', ...parquet, ...keyColumns);
    } else if (keyColumns.length) {
        lines.push(...keyColumns);
    }
    return lines.join('\n');
}

/** A JSON value as Python's str() prints it, as the server did. */
export function pyStr(v) {
    return typeof v === 'string' ? v : pyRepr(v);
}

/** A JSON value as Python's repr() prints it. */
export function pyRepr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (Array.isArray(v)) return pyList(v);
    return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
}

function pyList(arr) {
    return `[${arr.map(pyRepr).join(', ')}]`;
}
