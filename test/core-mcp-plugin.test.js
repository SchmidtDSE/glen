import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PortolanCatalog } from '../core/portolan-catalog.js';
import { createCatalogTools } from '../app/catalog-tools.js';
import { readFileSync } from 'node:fs';
import mcpPlugin, { resolveServers, workerUrl, parquetSection, HARNESS_MCP_CLIENT } from '../core/plugins/mcp.js';

describe('resolveServers', () => {
    it('reads the single-server shorthand', () => {
        expect(resolveServers({ url: 'https://a/mcp', exclude: ['browse_stac_catalog'], prompt: 'p' })).toEqual([
            { url: 'https://a/mcp', headers: {}, prompt: 'p', include: undefined, exclude: ['browse_stac_catalog'] },
        ]);
    });

    it('falls back to the config mcp_url', () => {
        expect(resolveServers({}, { mcp_url: 'https://c/mcp' })[0].url).toBe('https://c/mcp');
    });

    it('keeps a servers list in order and drops entries without a url', () => {
        const servers = resolveServers({ servers: [{ url: 'https://a/mcp' }, {}, { url: 'https://b/mcp', include: ['fit'] }] });
        expect(servers.map((s) => s.url)).toEqual(['https://a/mcp', 'https://b/mcp']);
        expect(servers[1].include).toEqual(['fit']);
    });

    it('throws without any server', () => {
        expect(() => resolveServers({})).toThrow(/required/);
    });

    it('reads a worker entry in place of a url (#457)', () => {
        const [w, h] = resolveServers({ servers: [
            { worker: 'geo-query-worker.js', worker_config: { discovery: false }, include: ['query'], headers: { A: '1' } },
            { url: 'https://a/mcp' },
        ] });
        expect(w).toEqual({ url: 'worker:geo-query-worker.js', worker: 'geo-query-worker.js', worker_config: { discovery: false },
            headers: {}, prompt: undefined, include: ['query'], exclude: undefined });
        expect(h.url).toBe('https://a/mcp');
        expect(resolveServers({ worker: 'w.js' }, { mcp_url: 'https://c/mcp' })[0].url).toBe('worker:w.js');
    });

    it('refuses an entry with both url and worker', () => {
        expect(() => resolveServers({ servers: [{ url: 'https://a/mcp', worker: 'w.js' }] })).toThrow(/not both/);
    });
});

describe('workerUrl', () => {
    it('resolves the worker file against the page and carries its config', () => {
        const url = workerUrl({ worker: 'plugins/w.js', worker_config: { discovery: false } }, 'https://app.example/demo/index.html');
        expect(url.origin + url.pathname).toBe('https://app.example/demo/plugins/w.js');
        expect(JSON.parse(url.searchParams.get('config'))).toEqual({ discovery: false });
        expect(workerUrl({ worker: 'w.js' }, 'https://app.example/').searchParams.get('config')).toBe('{}');
    });
});

describe('mcp plugin setup', () => {
    const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
    const listings = {
        'https://a/mcp': ['query', 'browse_stac_catalog', 'get_stac_details', 'get_schema', 'get_collection'],
        'https://b/mcp': ['fit_sdm', 'query'],
        'worker:w.js': ['query', 'get_schema'],
    };
    let clients;
    let warn;
    let refuse;
    let savedToken;

    class FakeClient {
        constructor(url, headers, options = {}) {
            this.url = url;
            this.headers = headers;
            this.options = options;
            clients.push(this);
        }
        async connect() {
            if (this.options.transport) {
                this.transport = this.options.transport();
                // The worker's file fails to load while the client waits.
                if (failWorkers) this.transport.port.dispatchEvent(new Event('error'));
                if (this.transport.closed) throw new Error('Connection closed');
                return;
            }
            if (refuse.has(this.url) && this.headers.Authorization !== 'Bearer good') {
                throw new Error('Error POSTing to endpoint (HTTP 401): Unauthorized');
            }
            if (!listings[this.url]) throw new Error('unreachable');
        }
        async setHeaders(h) { this.headers = h; }
        async reconnect() { this.reconnected = true; }
        getTools() { return listings[this.url].map(tool); }
        setOnReconnect(fn) { this.onReconnect = fn; }
        async getPrompt(name) { return `prompt ${name} from ${this.url}`; }
    }

    function context() {
        const prompts = [];
        const tools = {
            registerRemote: vi.fn((list, client, rewriter, { include, exclude } = {}) =>
                list.filter((t) => (!include || include.includes(t.name)) && !(exclude || []).includes(t.name)).length),
            clearRemote: vi.fn(),
            registerLocal: vi.fn(),
        };
        const ready = [];
        return { prompts, tools, ready, ctx: {
            config: {}, catalog: { getAll: () => [] }, tools,
            addPrompt: (t) => t && prompts.push(t), onReady: (fn) => ready.push(fn),
        } };
    }

    // The harness's token helpers, as in glen-harness src/mcp-token.js, for a
    // page on https://app.example.
    const PAGE = 'https://app.example';
    const tokenHelpers = {
        userTokenApplies: (s) => !!s?.url && !s.headers?.Authorization && new URL(s.url, PAGE).origin !== PAGE,
        withUserToken: (h = {}, t) => (t ? { ...h, Authorization: `Bearer ${t}` } : { ...h }),
        isMcpAuthError: (e) => /\(HTTP 40[13]\)/.test(String(e?.message || '')),
        loadMcpToken: () => savedToken,
    };
    // A Worker stand-in, and a transport that records the port it wraps.
    let workers;
    let failWorkers;
    class FakeWorker extends EventTarget {
        constructor(server) { super(); this.server = server; workers.push(this); }
        postMessage() {}
        terminate() { this.terminated = true; }
    }
    class FakeTransport {
        constructor(port) { this.port = port; }
        close() { this.closed = true; }
    }
    const plugin = {
        ...mcpPlugin,
        loadClient: async () => FakeClient,
        loadTokenHelpers: async () => tokenHelpers,
        loadTransport: async () => FakeTransport,
        startWorker: (server) => new FakeWorker(server),
    };

    beforeEach(() => {
        clients = [];
        workers = [];
        failWorkers = false;
        refuse = new Set();
        savedToken = '';
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('registers each server with its rank and filters', async () => {
        const { ctx, tools } = context();
        await plugin.setup(ctx, { servers: [
            { url: 'https://a/mcp', exclude: ['browse_stac_catalog'] },
            { url: 'https://b/mcp', include: ['fit_sdm'], headers: { Authorization: 'Bearer t' } },
        ] });
        const calls = tools.registerRemote.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0][3]).toEqual({ rank: 0, include: undefined, exclude: ['browse_stac_catalog'] });
        expect(calls[1][3]).toEqual({ rank: 1, include: ['fit_sdm'], exclude: undefined });
        expect(clients[1].headers).toEqual({ Authorization: 'Bearer t' });
    });

    it('answers the catalog tools locally and never registers a server\'s (#441)', async () => {
        const { ctx, tools } = context();
        await plugin.setup(ctx, { servers: [{ url: 'https://a/mcp' }, { url: 'https://b/mcp' }] });
        expect(tools.registerLocal.mock.calls.map(c => c[0].name)).toEqual(['get_schema', 'get_stac_details']);
        const remote = tools.registerRemote.mock.calls.map(c => c[0].map(t => t.name));
        expect(remote).toEqual([['query'], ['fit_sdm', 'query']]);
        clients[0].onReconnect(listings['https://a/mcp'].map(tool));
        expect(tools.registerRemote.mock.calls.at(-1)[0].map(t => t.name)).toEqual(['query']);
    });

    it('re-registers only the reconnecting server, with the same filters', async () => {
        const { ctx, tools } = context();
        await plugin.setup(ctx, { servers: [{ url: 'https://a/mcp', exclude: ['browse_stac_catalog'] }, { url: 'https://b/mcp' }] });
        clients[1].onReconnect([tool('fit_sdm')]);
        expect(tools.clearRemote).toHaveBeenCalledWith(clients[1]);
        expect(tools.registerRemote.mock.calls.at(-1)[1]).toBe(clients[1]);
        expect(tools.registerRemote.mock.calls.at(-1)[3]).toEqual({ rank: 1, include: undefined, exclude: undefined });
    });

    it('goes on past a server it cannot reach', async () => {
        const { ctx, tools } = context();
        await plugin.setup(ctx, { servers: [{ url: 'https://down/mcp' }, { url: 'https://b/mcp' }] });
        expect(tools.registerRemote).toHaveBeenCalledTimes(1);
        expect(tools.registerRemote.mock.calls[0][3].rank).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('https://down/mcp'), 'unreachable');
    });

    it('fails when no server can be reached, so the app logs the plugin as failed', async () => {
        const { ctx } = context();
        await expect(plugin.setup(ctx, { url: 'https://down/mcp' })).rejects.toThrow(/no MCP server/);
    });

    it('sends a saved visitor token to the first server only (glen#442)', async () => {
        savedToken = 'tok';
        const { ctx, ready } = context();
        await plugin.setup(ctx, { servers: [{ url: 'https://a/mcp' }, { url: 'https://b/mcp' }] });
        expect(clients[0].headers).toEqual({ Authorization: 'Bearer tok' });
        expect(clients[1].headers).toEqual({});
        expect(ready).toHaveLength(1);
    });

    it("offers no token field when the app sets the server's Authorization header", async () => {
        savedToken = 'tok';
        const { ctx, ready } = context();
        await plugin.setup(ctx, { url: 'https://a/mcp', headers: { Authorization: 'Bearer app' } });
        expect(clients[0].headers).toEqual({ Authorization: 'Bearer app' });
        expect(ready).toHaveLength(0);
    });

    it('opens the token field when the server refuses us at start', async () => {
        refuse.add('https://a/mcp');
        const { ctx, ready } = context();
        await expect(plugin.setup(ctx, { url: 'https://a/mcp' })).rejects.toThrow(/no MCP server/);
        const ui = { enableMcpToken: vi.fn() };
        await ready[0]({ ui });
        expect(ui.enableMcpToken).toHaveBeenCalledWith(expect.objectContaining({ authFailed: true }));
    });

    it('does not report an unreachable server as a token problem', async () => {
        const { ctx, ready } = context();
        await plugin.setup(ctx, { servers: [{ url: 'https://down/mcp' }, { url: 'https://b/mcp' }] });
        const ui = { enableMcpToken: vi.fn() };
        await ready[0]({ ui });
        expect(ui.enableMcpToken.mock.calls[0][0].authFailed).toBe(false);
    });

    it('reconnects the first server with a token saved later', async () => {
        const { ctx, ready } = context();
        await plugin.setup(ctx, { url: 'https://a/mcp', headers: { 'X-A': '1' } });
        const ui = { enableMcpToken: vi.fn() };
        await ready[0]({ ui });
        await ui.enableMcpToken.mock.calls[0][0].apply('new');
        expect(clients[0].headers).toEqual({ 'X-A': '1', Authorization: 'Bearer new' });
        expect(clients[0].reconnected).toBe(true);
    });

    it('connects to a server in a Web Worker like any other (#457)', async () => {
        savedToken = 'tok';
        const { ctx, tools, ready } = context();
        await plugin.setup(ctx, { servers: [
            { worker: 'w.js', worker_config: { discovery: false }, include: ['query'] },
            { url: 'https://b/mcp' },
        ] });
        expect(workers).toHaveLength(1);
        expect(workers[0].server.worker_config).toEqual({ discovery: false });
        expect(clients[0].transport.port).toBe(workers[0]);
        expect(clients[0].headers).toEqual({});
        expect(tools.registerLocal.mock.calls.map(c => c[0].name)).toEqual(['get_schema', 'get_stac_details']);
        expect(tools.registerRemote.mock.calls[0][0].map(t => t.name)).toEqual(['query']);
        expect(tools.registerRemote.mock.calls[0][3]).toEqual({ rank: 0, include: ['query'], exclude: undefined });
        // A worker has no origin to send a visitor's token to.
        expect(ready).toHaveLength(0);
        // A reconnect opens a new transport over the same worker, which answered.
        workers[0].dispatchEvent(new Event('message'));
        const first = clients[0].transport;
        await clients[0].connect();
        expect(clients[0].transport).not.toBe(first);
        expect(clients[0].transport.port).toBe(workers[0]);
        expect(workers).toHaveLength(1);
    });

    it('drops a worker that fails before it answers, and starts a new one on reconnect', async () => {
        failWorkers = true;
        const { ctx } = context();
        await plugin.setup(ctx, { servers: [{ worker: 'w.js' }, { url: 'https://b/mcp' }] });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('worker:w.js'), 'Connection closed');
        expect(workers[0].terminated).toBe(true);
        failWorkers = false;
        await clients[0].connect();
        expect(workers).toHaveLength(2);
        expect(clients[0].transport.port).toBe(workers[1]);
    });

    it('replaces a worker whose last connection got no answer', async () => {
        const { ctx } = context();
        await plugin.setup(ctx, { worker: 'w.js' });
        workers[0].dispatchEvent(new Event('message'));
        await clients[0].connect();          // answered before: same worker
        expect(workers).toHaveLength(1);
        await clients[0].connect();          // the last connection heard nothing
        expect(workers[0].terminated).toBe(true);
        expect(workers).toHaveLength(2);
        expect(clients[0].transport.port).toBe(workers[1]);
    });

    it('keeps a worker that has answered when it later reports an error', async () => {
        const { ctx } = context();
        await plugin.setup(ctx, { worker: 'w.js' });
        workers[0].dispatchEvent(new Event('message'));
        workers[0].dispatchEvent(new Event('error'));
        expect(workers[0].terminated).toBeUndefined();
        expect(clients[0].transport.closed).toBeUndefined();
    });

    it('adds each server\'s prompt after the data-file section', async () => {
        const { ctx, prompts } = context();
        ctx.catalog = { getAll: () => [{ id: 'roads', url: 'https://x/roads/collection.json', stac: { assets: { d: { href: 'roads.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] } } } }] };
        await plugin.setup(ctx, { servers: [{ url: 'https://a/mcp', prompt: 'analyst' }, { url: 'https://b/mcp' }] });
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain('https://x/roads/roads.parquet');
        expect(prompts[1]).toBe('prompt analyst from https://a/mcp');
    });
});

describe('parquetSection', () => {
    it('is empty without parquet data assets', () => {
        expect(parquetSection({ getAll: () => [{ id: 'a', url: 'https://x/c.json', stac: { assets: {} } }] })).toBe('');
    });
});

describe('MCP client source', () => {
    it('loads the MCP client from the same glen-harness tag as core/main.js', () => {
        const main = readFileSync(new URL('../core/main.js', import.meta.url), 'utf8');
        const tags = new Set([...main.matchAll(/glen-harness@([^/]+)\//g)].map((m) => m[1]));
        expect(tags.size).toBe(1);
        expect(HARNESS_MCP_CLIENT).toBe(`https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@${[...tags][0]}/src/mcp-client.js`);
    });
});

describe('catalog tools over Portolan collections (#441)', () => {
    const BASE = 'https://storage.example.org/cat/roads/collection.json';
    const roads = {
        type: 'Collection', id: 'road-blockages', title: 'Road blockages', description: 'Blocked roads.',
        'table:columns': [{ name: 'Damage', type: 'string', description: 'Damage class', values: ['Blocked', 'Partial'] }],
        assets: { data: { href: './data.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] } },
        links: [],
    };

    async function catalogWith(...cols) {
        const c = new PortolanCatalog({ fetchJson: async () => null, pmtilesMetadata: async () => null });
        for (const [col, url] of cols) await c.addCollection(col, url);
        return c;
    }

    beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    it('describes a listed collection with resolved paths and its column dictionary', async () => {
        const [getSchema] = createCatalogTools(await catalogWith([roads, BASE]));
        const md = await getSchema.execute({ dataset_id: 'Road-Blockages' });
        expect(md).toContain("read_parquet('s3://cat/roads/data.parquet')");
        expect(md).toContain("s3_endpoint='storage.example.org', s3_scope='s3://cat'");
        expect(md).toContain('`Damage` (string) — Damage class');
        expect(md).toContain("values: ['Blocked', 'Partial']");
    });

    it('refuses a collection the app does not list', async () => {
        const [getSchema] = createCatalogTools(await catalogWith([roads, BASE]));
        const out = JSON.parse(await getSchema.execute({ dataset_id: 'census-tract' }));
        expect(out.success).toBe(false);
        expect(out.error).toContain("This app's datasets are: road-blockages.");
    });
});

