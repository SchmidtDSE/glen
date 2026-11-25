/**
 * catalog-browse.js — Every collection under a STAC or Portolan catalog, for
 * the builder's list to choose from.
 *
 * The walk goes through Catalogs and Collections alike, as glen core's does
 * (app/catalog-tree.js), so it finds collections in our bucket-level layout
 * and in Portolan's. A collection is marked with what glen core would draw
 * from it.
 */

import { childLinks, mapLimit } from '../app/catalog-tree.js';
import { findVectorSources, findRasterAssets } from '../core/portolan.js';

/** What a collection draws: 'vector', 'raster', both, or neither. */
export function drawableKinds(doc, url) {
    const kinds = [];
    try { if (findVectorSources(doc, url).length) kinds.push('vector'); } catch { /* none */ }
    try { if (findRasterAssets(doc, url).length) kinds.push('raster'); } catch { /* none */ }
    return kinds;
}

/**
 * @param {string} rootUrl
 * @param {Object} opts
 * @param {(url: string) => Promise<Object>} opts.fetchJson
 * @param {number} [opts.maxDocs=600] - most documents to read
 * @param {number} [opts.maxDepth=6]
 * @param {(n: number) => void} [opts.onProgress] - documents read so far
 * @returns {Promise<Array<{id, title, description, url, kinds, parent}>>}
 *   collections in the order found; rejects only if the root cannot be read
 */
export async function listCollections(rootUrl, { fetchJson, maxDocs = 600, maxDepth = 6, onProgress = () => {} }) {
    const root = await fetchJson(rootUrl);
    const out = [];
    const seen = new Set([rootUrl]);
    let read = 1;
    const visit = (url, doc, parent) => {
        if (doc?.type === 'Collection') {
            out.push({
                id: doc.id,
                title: doc.title || doc.id,
                description: doc.description || '',
                url,
                kinds: drawableKinds(doc, url),
                parent,
            });
        }
    };
    visit(rootUrl, root, null);
    let level = [[rootUrl, root]];
    for (let depth = 0; depth < maxDepth && level.length && read < maxDocs; depth++) {
        const links = [];
        for (const [url, doc] of level) {
            for (const l of childLinks(doc, url)) {
                if (seen.has(l.href)) continue;
                seen.add(l.href);
                links.push({ ...l, parent: doc.title || doc.id || null });
            }
        }
        const batch = links.slice(0, Math.max(0, maxDocs - read));
        const docs = await mapLimit(batch, 16, async (l) => {
            try { return [l.href, await fetchJson(l.href), l.parent]; } catch { return null; } finally { onProgress(++read); }
        });
        level = [];
        for (const d of docs) {
            if (!d) continue;
            visit(d[0], d[1], d[2]);
            level.push([d[0], d[1]]);
        }
    }
    return out;
}
