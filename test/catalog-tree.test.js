import { describe, it, expect, vi } from 'vitest';
import { findCollections, childLinks, resolveHref, mapLimit } from '../app/catalog-tree.js';

const R = 'https://s3.example.org/public-data/stac/catalog.json';

/** A fetchJson over a dict of URL → document, counting reads. */
function store(docs) {
    const fetchJson = vi.fn(async (url) => {
        if (!docs[url]) throw new Error(`404 ${url}`);
        return structuredClone(docs[url]);
    });
    return fetchJson;
}

// Today's layout: the root links bucket-level Collections, with Collections
// below them, and some below those.
const today = {
    [R]: { type: 'Catalog', id: 'root', links: [
        { rel: 'child', id: 'cpad', href: 'https://s3.example.org/public-cpad/stac-collection.json' },
        { rel: 'child', id: 'high-seas', href: 'https://s3.example.org/public-high-seas/stac-collection.json' },
        { rel: 'child', href: 'https://s3.example.org/public-hawaii/stac-collection.json' },
    ] },
    'https://s3.example.org/public-cpad/stac-collection.json': { type: 'Collection', id: 'cpad', links: [] },
    'https://s3.example.org/public-high-seas/stac-collection.json': { type: 'Collection', id: 'high-seas', links: [
        { rel: 'child', href: './megamove/stac-collection.json' },
    ] },
    'https://s3.example.org/public-high-seas/megamove/stac-collection.json': { type: 'Collection', id: 'megamove', links: [
        { rel: 'child', href: 'corridors/stac-collection.json' },
    ] },
    'https://s3.example.org/public-high-seas/megamove/corridors/stac-collection.json': { type: 'Collection', id: 'megamove-corridors', links: [] },
    'https://s3.example.org/public-hawaii/stac-collection.json': { type: 'Collection', id: 'hawaii', links: [] },
};

// The Portolan layout after data-workflows#762: Catalogs hold Collections.
const portolan = {
    [R]: { type: 'Catalog', id: 'root', links: [
        { rel: 'child', href: '../../public-census/catalog.json' },
        { rel: 'child', href: '../../public-cpad/catalog.json' },
    ] },
    'https://s3.example.org/public-census/catalog.json': { type: 'Catalog', id: 'public-census', links: [
        { rel: 'child', href: './tract/collection.json' },
    ] },
    'https://s3.example.org/public-census/tract/collection.json': { type: 'Collection', id: 'census-tract', links: [] },
    'https://s3.example.org/public-cpad/catalog.json': { type: 'Catalog', id: 'cpad', links: [
        { rel: 'child', href: './cpad/collection.json' },
    ] },
    'https://s3.example.org/public-cpad/cpad/collection.json': { type: 'Collection', id: 'cpad', links: [] },
};

describe('resolveHref and childLinks', () => {
    it('resolves hrefs against the document that holds them', () => {
        expect(resolveHref('./a/collection.json', 'https://x.org/b/catalog.json')).toBe('https://x.org/b/a/collection.json');
        expect(childLinks({ links: [{ rel: 'child', href: '../c.json', id: 'c' }, { rel: 'item', href: 'i.json' }] }, 'https://x.org/b/d.json'))
            .toEqual([{ href: 'https://x.org/c.json', id: 'c', title: null }]);
    });
});

describe('findCollections', () => {
    it('reads only the named link when the root names the id', async () => {
        const fetchJson = store(today);
        const found = await findCollections(R, ['cpad'], { fetchJson });
        expect(found.get('cpad').url).toBe('https://s3.example.org/public-cpad/stac-collection.json');
        expect(found.get('cpad').depth).toBe(1);
        expect(fetchJson).toHaveBeenCalledTimes(2);
    });

    it('finds collections below bucket-level Collections, at any depth', async () => {
        const found = await findCollections(R, ['megamove', 'megamove-corridors'], { fetchJson: store(today) });
        expect(found.get('megamove').depth).toBe(2);
        expect(found.get('megamove-corridors')).toMatchObject({
            url: 'https://s3.example.org/public-high-seas/megamove/corridors/stac-collection.json',
            depth: 3,
        });
    });

    it('finds collections inside Catalogs (the Portolan layout)', async () => {
        const found = await findCollections(R, ['census-tract', 'cpad'], { fetchJson: store(portolan) });
        expect(found.get('census-tract').url).toBe('https://s3.example.org/public-census/tract/collection.json');
        // A Catalog that shares a collection's id is not the collection.
        expect(found.get('cpad').url).toBe('https://s3.example.org/public-cpad/cpad/collection.json');
    });

    it('leaves out ids it cannot find, and stops at maxDepth', async () => {
        const found = await findCollections(R, ['megamove-corridors', 'nowhere'], { fetchJson: store(today), maxDepth: 2 });
        expect(found.size).toBe(0);
    });

    it('skips a node it cannot read and reports it', async () => {
        const docs = { ...today };
        delete docs['https://s3.example.org/public-hawaii/stac-collection.json'];
        const onError = vi.fn();
        const found = await findCollections(R, ['megamove'], { fetchJson: store(docs), onError });
        expect(found.has('megamove')).toBe(true);
        expect(onError).toHaveBeenCalledWith('https://s3.example.org/public-hawaii/stac-collection.json', expect.any(Error));
    });

    it('rejects when the root cannot be read', async () => {
        await expect(findCollections(R, ['cpad'], { fetchJson: store({}) })).rejects.toThrow(/404/);
    });

    it('reads a node once even when two links lead to it', async () => {
        const docs = structuredClone(today);
        docs['https://s3.example.org/public-cpad/stac-collection.json'].links = [
            { rel: 'child', href: '../public-high-seas/megamove/stac-collection.json' },
        ];
        const fetchJson = store(docs);
        await findCollections(R, ['megamove-corridors'], { fetchJson });
        const urls = fetchJson.mock.calls.map(c => c[0]);
        expect(urls.length).toBe(new Set(urls).size);
    });
});

describe('mapLimit', () => {
    it('keeps order and never runs more than the limit at once', async () => {
        let running = 0, peak = 0;
        const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
            running++; peak = Math.max(peak, running);
            await new Promise(r => setTimeout(r, 1));
            running--;
            return x * 10;
        });
        expect(out).toEqual([10, 20, 30, 40, 50]);
        expect(peak).toBe(2);
    });
});
