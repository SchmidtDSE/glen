import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import mcpPlugin, { resolveServers, parquetSection, HARNESS_MCP_CLIENT } from '../core/plugins/mcp.js';

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
});

describe('mcp plugin setup', () => {
    const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
    const listings = {
        'https://a/mcp': ['query', 'browse_stac_catalog'],
        'https://b/mcp': ['fit_sdm', 'query'],
    };
    let clients;
    let warn;
    let refuse;
    let savedToken;

    class FakeClient {
        constructor(url, headers) {
            this.url = url;
            this.headers = headers;
            clients.push(this);
        }
        async connect() {
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
    const plugin = { ...mcpPlugin, loadClient: async () => FakeClient, loadTokenHelpers: async () => tokenHelpers };

    beforeEach(() => {
        clients = [];
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
