import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatasetCatalog } from '../app/dataset-catalog.js';
import { createCatalogTools, MCP_CATALOG_TOOLS } from '../app/catalog-tools.js';
import { PortolanCatalog } from '../core/portolan-catalog.js';

const ROOT = 'https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json';
const HS = 'https://s3-west.nrp-nautilus.io/public-high-seas/stac-collection.json';
const MM = 'https://s3-west.nrp-nautilus.io/public-high-seas/megamove/stac-collection.json';
const CORR = 'https://s3-west.nrp-nautilus.io/public-high-seas/megamove/corridors/stac-collection.json';
const CPAD = 'https://s3-west.nrp-nautilus.io/public-cpad/stac-collection.json';

const coll = (id, extra = {}) => ({
    type: 'Collection', stac_version: '1.0.0', id, title: id.toUpperCase(), description: `About ${id}.`,
    license: 'CC-BY-4.0', extent: { spatial: { bbox: [[-180, -90, 180, 90]] } }, links: [], assets: {}, ...extra,
});
const parquet = (path, columns = []) => ({
    href: `https://s3-west.nrp-nautilus.io/${path}`, type: 'application/vnd.apache.parquet', 'table:columns': columns,
});

const docs = {
    [ROOT]: { type: 'Catalog', id: 'root', links: [
        { rel: 'child', id: 'high-seas', href: HS },
        { rel: 'child', id: 'cpad-2025b', href: CPAD },
    ] },
    [HS]: coll('high-seas', { links: [{ rel: 'child', href: './megamove/stac-collection.json' }] }),
    [MM]: coll('megamove', { links: [{ rel: 'child', href: './corridors/stac-collection.json' }] }),
    [CORR]: coll('megamove-corridors', { assets: { data: parquet('public-high-seas/megamove/corridors.parquet', [{ name: 'species', type: 'string', values: ['shark'] }]) } }),
    [CPAD]: coll('cpad-2025b', { assets: { data: parquet('public-cpad/cpad.parquet') } }),
};

let fetched;
beforeEach(() => {
    fetched = [];
    global.fetch = vi.fn(async (url) => {
        fetched.push(url);
        return docs[url]
            ? { ok: true, status: 200, json: async () => structuredClone(docs[url]) }
            : { ok: false, status: 404, json: async () => null };
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function tools(config = {}) {
    const catalog = new DatasetCatalog();
    await catalog.load({ catalog: ROOT, collections: ['high-seas'], ...config });
    const byName = Object.fromEntries(createCatalogTools(catalog, { s3Sources: config.s3_sources }).map(t => [t.name, t]));
    return { catalog, byName };
}

describe('local catalog tools', () => {
    it('get_schema and get_stac_details render a configured dataset from the loaded STAC', async () => {
        const { byName } = await tools();
        const before = fetched.length;
        const md = await byName.get_schema.execute({ dataset_id: 'high-seas' });
        expect(md).toContain('Collection ID: `high-seas`');
        expect(md).toContain(`collection_url: \`${HS}\``);
        expect(md).toContain("*MEGAMOVE* (`megamove`):\n  - columns: call get_stac_details('megamove')");
        expect(await byName.get_stac_details.execute({ dataset_id: 'high-seas' })).toBe(md);
        expect(fetched.length).toBe(before); // all read at boot
    });

    it('reads a sub-dataset below a configured one on demand, and keeps it', async () => {
        const { byName } = await tools();
        const md = await byName.get_stac_details.execute({ dataset_id: 'megamove-corridors' });
        expect(md).toContain("read_parquet('s3://public-high-seas/megamove/corridors.parquet')");
        expect(md).toContain("values: ['shark']");
        const n = fetched.length;
        await byName.get_stac_details.execute({ dataset_id: 'megamove-corridors' });
        expect(fetched.length).toBe(n);
    });

    it('matches an id without regard to case', async () => {
        const { byName } = await tools();
        expect(await byName.get_stac_details.execute({ dataset_id: 'MegaMove' })).toContain('Collection ID: `megamove`');
    });

    it('does not reach collections the app does not list', async () => {
        const { byName } = await tools();
        const out = JSON.parse(await byName.get_stac_details.execute({ dataset_id: 'cpad-2025b' }));
        expect(out.success).toBe(false);
        expect(out.error).toContain("This app's datasets are: high-seas.");
        expect(fetched).not.toContain(CPAD);
    });

    it('uses the app\'s own S3 sources first', async () => {
        const { byName } = await tools({ s3_sources: [{ https_prefix: 'https://s3-west.nrp-nautilus.io/public-high-seas/', s3_prefix: 's3://mirror/' }] });
        expect(await byName.get_schema.execute({ dataset_id: 'megamove-corridors' })).toContain("read_parquet('s3://mirror/megamove/corridors.parquet')");
    });

    it('lists the MCP catalog tools the app leaves out', () => {
        expect(MCP_CATALOG_TOOLS).toEqual(expect.arrayContaining(['browse_stac_catalog', 'get_stac_details', 'get_collection']));
    });
});

describe('catalog loads by id below the root (#441)', () => {
    it('the full app finds a collection two levels down and says to name its URL', async () => {
        const catalog = new DatasetCatalog();
        await catalog.load({ catalog: ROOT, collections: ['megamove'] });
        expect(catalog.getIds()).toEqual(['megamove']);
        expect(catalog.stacUrls.get('megamove')).toBe(MM);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`"collection_url": "${MM}"`));
    });

    it('resolves a child href against the collection, not the root', async () => {
        const catalog = new DatasetCatalog();
        await catalog.load({ catalog: ROOT, collections: [{ collection_id: 'megamove', collection_url: MM }] });
        expect(catalog.get('megamove').childIds).toEqual(['megamove-corridors']);
    });

    it('glen core finds a collection below a Collection', async () => {
        const c = new PortolanCatalog({
            fetchJson: async (url) => { if (!docs[url]) throw new Error('404'); return structuredClone(docs[url]); },
            pmtilesMetadata: async () => null,
        });
        await c.load({ catalog: ROOT, collections: ['megamove-corridors'] });
        expect([...c.datasets.keys()]).toEqual(['megamove-corridors']);
    });
});
