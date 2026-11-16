import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// glen core's catalog: the catalog tools read whatever it loaded (#441).
const portolan = () => new PortolanCatalog({
    fetchJson: async (url) => {
        const res = await global.fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
    },
    pmtilesMetadata: async () => null,
});

async function tools(config = {}) {
    const catalog = portolan();
    await catalog.load({ catalog: ROOT, collections: ['megamove-corridors'], ...config });
    const byName = Object.fromEntries(createCatalogTools(catalog, { s3Sources: config.s3_sources }).map(t => [t.name, t]));
    return { catalog, byName };
}

describe('local catalog tools', () => {
    it('get_schema and get_stac_details render a configured dataset from the loaded STAC', async () => {
        const { byName } = await tools();
        const before = fetched.length;
        const md = await byName.get_schema.execute({ dataset_id: 'megamove-corridors' });
        expect(md).toContain('Collection ID: `megamove-corridors`');
        expect(md).toContain(`collection_url: \`${CORR}\``);
        expect(md).toContain("read_parquet('s3://public-high-seas/megamove/corridors.parquet')");
        expect(md).toContain("values: ['shark']");
        expect(await byName.get_stac_details.execute({ dataset_id: 'megamove-corridors' })).toBe(md);
        expect(fetched.length).toBe(before); // all read at boot
    });

    it('matches an id without regard to case', async () => {
        const { byName } = await tools();
        expect(await byName.get_stac_details.execute({ dataset_id: 'MegaMove-Corridors' })).toContain('Collection ID: `megamove-corridors`');
    });

    it('does not reach collections the app does not list', async () => {
        const { byName } = await tools();
        const before = fetched.length; // the boot walk may pass CPAD on the way down
        const out = JSON.parse(await byName.get_stac_details.execute({ dataset_id: 'cpad-2025b' }));
        expect(out.success).toBe(false);
        expect(out.error).toContain("This app's datasets are: megamove-corridors.");
        expect(fetched.length).toBe(before);
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
    it('glen core finds a collection below a Collection', async () => {
        const c = new PortolanCatalog({
            fetchJson: async (url) => { if (!docs[url]) throw new Error('404'); return structuredClone(docs[url]); },
            pmtilesMetadata: async () => null,
        });
        await c.load({ catalog: ROOT, collections: ['megamove-corridors'] });
        expect([...c.datasets.keys()]).toEqual(['megamove-corridors']);
    });
});

describe('a collection with items (#462)', () => {
    const URL = 'https://h/cat/heat/collection.json';
    const doc = { id: 'heat', links: [{ rel: 'item', href: './a/a.json' }], assets: {} };
    const catalog = { resolveStac: async () => ({ doc, url: URL, children: [] }), getIds: () => ['heat'] };

    it('reads the first item once and lists its assets', async () => {
        const fetchJson = vi.fn(async () => ({ id: 'a', assets: { data: { href: './a.tif', type: 'image/tiff; application=geotiff' } } }));
        const [schema, details] = createCatalogTools(catalog, { fetchJson });
        expect(await schema.execute({ dataset_id: 'heat' })).toContain('  - `data`: COG');
        await details.execute({ dataset_id: 'heat' });
        expect(fetchJson).toHaveBeenCalledTimes(1);
        expect(fetchJson).toHaveBeenCalledWith('https://h/cat/heat/a/a.json');
    });

    it('still answers when the item cannot be read', async () => {
        const [schema] = createCatalogTools(catalog, { fetchJson: async () => { throw new Error('404'); } });
        const text = await schema.execute({ dataset_id: 'heat' });
        expect(text).toContain('**Items (1)**');
        expect(text).not.toContain("First item's assets");
    });
});
