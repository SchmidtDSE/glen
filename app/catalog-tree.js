/**
 * catalog-tree.js — Find STAC collections by id under a catalog root.
 *
 * Our catalog is changing shape (#441, data-workflows#762). Today the root
 * links to bucket-level Collections, some with Collections below them; after
 * the change the root links to Catalogs (`catalog.json`) with Collections
 * (`collection.json`) inside, Portolan style. Apps name collections by id, so
 * the lookup walks both: through Catalogs and Collections alike, to any depth,
 * resolving each href against the document it came from.
 *
 * The walk reads only what it needs. At each level it reads first the links
 * whose `id` is one it is looking for, then links without an id, and only
 * then the rest, and it stops as soon as every id is found. A config whose
 * collections all sit directly under the root reads nothing else.
 */

/** Resolve an href against the URL of the document that holds it. */
export function resolveHref(href, base) {
    try { return new URL(href, base).href; } catch { return href; }
}

/** A document's child links, with absolute hrefs. */
export function childLinks(doc, url) {
    return (doc?.links || [])
        .filter(l => l.rel === 'child' && l.href)
        .map(l => ({ href: resolveHref(l.href, url), id: l.id ?? null, title: l.title ?? null }));
}

/**
 * Find collections by id under a root catalog or collection.
 *
 * @param {string} rootUrl
 * @param {Iterable<string>} ids - the collection ids wanted
 * @param {Object} options
 * @param {(url: string) => Promise<Object>} options.fetchJson
 * @param {number} [options.maxDepth=6] - levels below the root to search
 * @param {number} [options.concurrency=16] - reads in flight at once
 * @param {(url: string, err: Error) => void} [options.onError] - a node below
 *   the root could not be read; the walk carries on without it
 * @returns {Promise<Map<string, {url: string, doc: Object, depth: number}>>}
 *   id → where it was found, and how many levels below the root. Ids not found are absent. Rejects only if the root cannot be read.
 */
export async function findCollections(rootUrl, ids, { fetchJson, maxDepth = 6, concurrency = 16, onError = () => {} }) {
    const missing = new Set(ids);
    const found = new Map();
    const seen = new Set([rootUrl]);

    const root = await fetchJson(rootUrl);
    const visit = (url, doc, depth) => {
        if (doc?.type !== 'Catalog' && doc?.id && missing.has(doc.id)) {
            found.set(doc.id, { url, doc, depth });
            missing.delete(doc.id);
        }
    };
    visit(rootUrl, root, 0);
    let docs = [[rootUrl, root]];

    for (let depth = 0; depth < maxDepth && missing.size && docs.length; depth++) {
        const links = [];
        for (const [url, doc] of docs) {
            for (const l of childLinks(doc, url)) {
                if (seen.has(l.href)) continue;
                seen.add(l.href);
                links.push(l);
            }
        }
        // Named matches first, then unnamed links (which might be anything),
        // then the rest, which can only hold what we want further down.
        const groups = [
            links.filter(l => l.id && missing.has(l.id)),
            links.filter(l => !l.id),
            links.filter(l => l.id && !missing.has(l.id)),
        ];
        const next = [];
        for (const group of groups) {
            if (!missing.size) break;
            const read = await mapLimit(group, concurrency, async (l) => {
                try { return [l.href, await fetchJson(l.href)]; } catch (err) {
                    onError(l.href, err);
                    return null;
                }
            });
            for (const r of read) {
                if (!r) continue;
                visit(r[0], r[1], depth + 1);
                next.push(r);
            }
        }
        docs = next;
    }
    return found;
}

/** Map over items with at most `limit` promises in flight; keeps order. */
export async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => {
        while (i < items.length) {
            const k = i++;
            out[k] = await fn(items[k], k);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}
