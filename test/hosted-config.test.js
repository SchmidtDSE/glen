import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    sanitizeAppConfig, buildCoreConfig, encodeConfig, decodeConfig, configSource,
    dataOrigins, pluginName, slugify, proposalUrl, SLUG, MAX_PROMPT,
} from '../hosted/hosted-config.js';
import { listCollections } from '../hosted/catalog-browse.js';

const BASE = 'https://glen.example.org/hosted/deployment.json';
const pages = JSON.parse(readFileSync(new URL('../hosted/deployment.json', import.meta.url), 'utf8'));

describe('what a hosted app may set', () => {
    it('keeps the data and look, and leaves models, keys and plugin scripts to the deployment', () => {
        const { config, notes } = sanitizeAppConfig({
            title: 'Reefs',
            catalog: 'https://data.source.coop/x/catalog.json',
            llm: { user_provided: false, models: [] },
            llm_models: [{ value: 'x', api_key: 'sk-stolen' }],
            plugins: ['charts', 'https://evil.example/steal.js', { url: 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.3.0/core/plugins/mcp.js', options: { url: 'https://evil.example/mcp' } }],
        });
        expect(config).toEqual({ title: 'Reefs', catalog: 'https://data.source.coop/x/catalog.json', plugins: ['charts', 'mcp'] });
        expect(notes.join(' ')).toMatch(/"llm" is set by the deployment/);
        expect(notes.join(' ')).toMatch(/steal\.js.*not one of glen's/);
        expect(notes.join(' ')).toMatch(/"mcp" takes the deployment's options/);
    });

    it('reads a whole v4 layers-input.json, turning its plugin URLs into names', () => {
        const tpl = { collections: [{ url: 'https://h/c.json' }], plugins: ['https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.3.0/core/plugins/hex.js', 'core/plugins/charts.js'] };
        expect(sanitizeAppConfig(tpl).config.plugins).toEqual(['hex', 'charts']);
        expect(pluginName('draw')).toBe('draw');
        expect(pluginName('https://example.org/my-plugin.js')).toBeNull();
    });

    it('drops script URLs wherever they are', () => {
        const { config, notes } = sanitizeAppConfig({
            links: { docs: 'javascript:alert(1)', github: 'https://github.com/x/y' },
            header: { nav: [{ label: 'x', href: ' JavaScript:void(0)' }] },
        });
        expect(config.links).toEqual({ github: 'https://github.com/x/y' });
        expect(config.header.nav[0].href).toBeUndefined();
        expect(notes.filter(n => /script URL/.test(n))).toHaveLength(2);
    });

    it('caps the prompt and keeps only host names as data hosts', () => {
        const { config } = sanitizeAppConfig({ system_prompt: 'x'.repeat(MAX_PROMPT + 5), data_hosts: ['storage.googleapis.com', 'https://bad/', 'Example.org:9000'] });
        expect(config.system_prompt).toHaveLength(MAX_PROMPT);
        expect(config.data_hosts).toEqual(['storage.googleapis.com', 'example.org:9000']);
    });

    it('refuses what is not an object', () => {
        expect(() => sanitizeAppConfig([])).toThrow(/JSON object/);
        expect(() => sanitizeAppConfig(null)).toThrow(/JSON object/);
    });
});

describe('the config glen core starts with', () => {
    it('puts the app over the deployment defaults, and only the deployment sets the models', () => {
        const app = sanitizeAppConfig({ title: 'Reefs', default_basemap: 'satellite', sidebar: { chat_title: 'Ask' }, plugins: ['charts', 'hex'] }).config;
        const { config, skipped } = buildCoreConfig(app, pages, { base: BASE });
        expect(config.sidebar).toEqual({ enabled: true, chat_title: 'Ask', title: 'Reefs' });
        expect(config.default_basemap).toBe('satellite');
        expect(config.llm).toEqual(pages.llm);
        expect(config.titiler_url).toBe(pages.titiler_url);
        expect(config.system_prompt).toBe('');
        expect(config.plugins).toEqual([{ url: 'https://glen.example.org/core/plugins/charts.js', options: {} }]);
        expect(skipped).toEqual(['hex']);
        expect(config.title).toBeUndefined();
    });

    it('turns on the deployment\'s default plugins when the app names none', () => {
        const { config } = buildCoreConfig({}, pages, { base: BASE });
        expect(config.plugins.map(p => p.url.split('/').pop())).toEqual(pages.default_plugins.map(n => `${n}.js`));
    });

    it('serves the SQL worker from the deployment, allowed to read the app\'s data hosts', () => {
        const app = { catalog: 'https://storage.googleapis.com/carto/cat.json', collections: [{ url: 'https://data.source.coop/a/c.json' }, 'some-id'], data_hosts: ['minio.example.org'], plugins: ['mcp'] };
        const { config } = buildCoreConfig(app, pages, { base: BASE });
        const server = config.plugins[0].options.servers[0];
        expect(server.worker).toBe('https://glen.example.org/hosted/geo-query-worker.js');
        expect(server.worker_config.allowedDirectories).toEqual(expect.arrayContaining(['s3://', 'https://storage.googleapis.com/', 'https://minio.example.org/']));
        expect(server.worker_config.allowedDirectories.filter(d => d === 'https://data.source.coop/')).toHaveLength(1);
        expect(server.worker_config.allowedEndpoints).toContain('minio.example.org');
        // The deployment's own definition is left as it was.
        expect(pages.plugins.mcp.options.servers[0].worker).toBe('geo-query-worker.js');
    });

    it('drops llm from the config when the deployment gives models in config.json', () => {
        const { config } = buildCoreConfig({}, { ...pages, llm: undefined, defaults: { llm: { user_provided: true } } }, { base: BASE });
        expect(config.llm).toBeUndefined();
    });

    it('finds the origins of the app\'s data', () => {
        expect(dataOrigins({ catalog: 'http://insecure/x.json', collections: ['an-id', { collection_url: 'https://a.org/b/c.json' }] })).toEqual(['https://a.org/']);
    });
});

describe('links', () => {
    it('carry the config, deflated, and come back the same', async () => {
        const app = { title: 'Jamaica', collections: Array.from({ length: 20 }, (_, i) => ({ url: `https://storage.googleapis.com/carto-open-catalogs/x/${i}/collection.json`, display_name: `Layer ${i}` })) };
        const c = await encodeConfig(app);
        expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(c.length).toBeLessThan(JSON.stringify(app).length / 3);
        expect(await decodeConfig(c)).toEqual(app);
        await expect(decodeConfig(c.slice(0, 20))).rejects.toThrow(/cut short or damaged/);
    });

    it('name the app by path, registry name, config URL or inline config', () => {
        expect(configSource({ pathname: '/glen/maps/a/st-louis/' })).toEqual({ kind: 'slug', value: 'st-louis' });
        expect(configSource({ pathname: '/a/st-louis/index.html', search: '?map=1,2,3' })).toEqual({ kind: 'slug', value: 'st-louis' });
        expect(configSource({ pathname: '/hosted/map/', search: '?app=jamaica' })).toEqual({ kind: 'slug', value: 'jamaica' });
        expect(configSource({ pathname: '/hosted/map/', search: '?config=https://x.org/a.json' })).toEqual({ kind: 'url', value: 'https://x.org/a.json' });
        expect(configSource({ pathname: '/hosted/map/', search: '?c=abc&map=1' })).toEqual({ kind: 'inline', value: 'abc' });
        expect(configSource({ pathname: '/hosted/map/', search: '?app=../../secrets' })).toEqual({ kind: 'bad', value: '../../secrets' });
        expect(configSource({ pathname: '/hosted/map/' })).toEqual({ kind: 'none' });
    });
});

describe('publishing', () => {
    it('makes a slug from a title', () => {
        expect(slugify('St. Louis open data')).toBe('st-louis-open-data');
        expect(slugify('Évora — Café maps!')).toBe('evora-cafe-maps');
        expect(SLUG.test(slugify('x'.repeat(100)))).toBe(true);
        expect(SLUG.test('-bad')).toBe(false);
    });

    it('opens GitHub\'s new-file form on the registry with the config filled in', () => {
        const url = new URL(proposalUrl('SchmidtDSE/glen', 'hosted/apps/', 'reefs', { title: 'Reefs' }));
        expect(url.origin + url.pathname).toBe('https://github.com/SchmidtDSE/glen/new/main/hosted/apps');
        expect(url.searchParams.get('filename')).toBe('reefs.json');
        expect(JSON.parse(url.searchParams.get('value'))).toEqual({ title: 'Reefs' });
    });
});

describe('browsing a catalog', () => {
    const docs = {
        'https://h/catalog.json': { type: 'Catalog', id: 'root', links: [{ rel: 'child', href: 'a/collection.json' }, { rel: 'child', href: 'bucket/collection.json' }, { rel: 'child', href: 'gone.json' }] },
        'https://h/a/collection.json': { type: 'Collection', id: 'a', title: 'Parcels', links: [{ rel: 'pmtiles', href: 'a.pmtiles' }] },
        'https://h/bucket/collection.json': { type: 'Collection', id: 'bucket', links: [{ rel: 'child', href: 'cog/collection.json' }, { rel: 'child', href: '../a/collection.json' }] },
        'https://h/bucket/cog/collection.json': { type: 'Collection', id: 'cog', title: 'Population', assets: { data: { href: 'pop.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } } },
    };
    const fetchJson = async (u) => { if (!docs[u]) throw new Error('404'); return docs[u]; };

    it('lists collections at any depth, through collections, with what each draws', async () => {
        const list = await listCollections('https://h/catalog.json', { fetchJson });
        expect(list.map(c => [c.id, c.kinds, c.parent])).toEqual([
            ['a', ['vector'], 'root'],
            ['bucket', [], 'root'],
            ['cog', ['raster'], 'bucket'],
        ]);
    });

    it('stops at the document limit, and fails only when the root cannot be read', async () => {
        expect(await listCollections('https://h/catalog.json', { fetchJson, maxDocs: 2 })).toHaveLength(1);
        await expect(listCollections('https://h/nope.json', { fetchJson })).rejects.toThrow('404');
    });
});
