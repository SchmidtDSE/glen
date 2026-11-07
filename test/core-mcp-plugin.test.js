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

    class FakeClient {
        constructor(url, headers) {
            this.url = url;
            this.headers = headers;
            clients.push(this);
        }
        async connect() {
            if (!listings[this.url]) throw new Error('unreachable');
        }
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
        return { prompts, tools, ctx: { config: {}, catalog: { getAll: () => [] }, tools, addPrompt: (t) => t && prompts.push(t) } };
    }

    const plugin = { ...mcpPlugin, loadClient: async () => FakeClient };

    beforeEach(() => {
        clients = [];
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
