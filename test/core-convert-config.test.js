import { describe, it, expect } from 'vitest';
import { convertConfig, convertIndexHtml, DEFAULT_MCP_URL } from '../core/convert-config.js';
import { resolveServers } from '../core/plugins/mcp.js';

const B = 'https://cdn/core/plugins';

describe('converting a v3 layers-input.json to glen core (#441)', () => {
    it('keeps collections and chrome as they are, and turns opt-in features into plugins', () => {
        const v3 = {
            catalog: 'https://x/catalog.json', titiler_url: 'https://t', view: { zoom: 3 }, theme: 'dark',
            collections: [{ collection_id: 'a', collection_url: 'https://x/a.json', group: { name: 'G', collapsed: true },
                assets: [{ id: 'p', default_style: { 'fill-color': '#f00' }, versions: [{ label: 'x', asset_id: 'p' }] }] }, 'b'],
            mcp_url: 'https://mcp/mcp', charts: { enabled: true }, draw_enabled: true, upload_enabled: { max_features: 9 },
        };
        const { config, notes } = convertConfig(v3, { pluginBase: B });
        expect(config.collections).toEqual(v3.collections);
        expect(config).toMatchObject({ catalog: v3.catalog, titiler_url: 'https://t', view: { zoom: 3 }, theme: 'dark' });
        for (const k of ['mcp_url', 'charts', 'draw_enabled', 'upload_enabled']) expect(config).not.toHaveProperty(k);
        expect(config.plugins).toEqual([
            { url: `${B}/mcp.js`, options: { url: 'https://mcp/mcp', prompt: 'geospatial-analyst' } },
            // Every v3 app had the hex tile tools.
            `${B}/hex.js`,
            `${B}/charts.js`,
            `${B}/draw.js`,
            { url: `${B}/uploads.js`, options: { max_features: 9 } },
        ]);
        expect(notes.some(n => /index\.html/.test(n))).toBe(true);
    });

    it('writes out the v3 default MCP server when an app named none, and keeps several servers in order', () => {
        const none = convertConfig({ collections: [] }, { pluginBase: B });
        expect(none.config.plugins[0].options.url).toBe(DEFAULT_MCP_URL);
        expect(none.notes.some(n => n.includes(DEFAULT_MCP_URL))).toBe(true);
        const many = convertConfig({ collections: [], mcp_servers: [{ url: 'https://a/mcp', auth_token: 't' }, { url: 'https://b/mcp', optional: true }] }, { pluginBase: B });
        expect(many.config.plugins[0].options.servers).toEqual([
            { url: 'https://a/mcp', auth_token: 't', prompt: 'geospatial-analyst' },
            { url: 'https://b/mcp', optional: true },
        ]);
    });

    it('notes what it drops, keeps plugins an app already lists, and takes upload settings from `upload`', () => {
        const { config, notes } = convertConfig({
            collections: [{ collection_id: 'c', preload: true }], catalog_index_threshold: 99, client_header_hosts: ['x'],
            plugins: ['https://p/mine.js'], upload_enabled: true, upload: { prefix: 'u' },
        }, { pluginBase: B });
        expect(config.plugins[0]).toBe('https://p/mine.js');
        expect(config.plugins.at(-1)).toEqual({ url: `${B}/uploads.js`, options: { prefix: 'u' } });
        expect(config).not.toHaveProperty('catalog_index_threshold');
        expect(notes.filter(n => /^Dropped|preload/.test(n))).toHaveLength(3);
    });

    it('the MCP plugin takes the deploy-time URL and token for the primary server, as the full app does', () => {
        const opts = convertConfig({ collections: [], mcp_servers: [{ url: 'https://a/mcp' }, { url: 'https://b/mcp', auth_token: 'b-token' }] }, { pluginBase: B }).config.plugins[0].options;
        const servers = resolveServers(opts, {}, { mcp_server_url: 'https://secret/mcp', mcp_auth_token: 's3cr3t' });
        expect(servers[0]).toMatchObject({ url: 'https://secret/mcp', headers: { Authorization: 'Bearer s3cr3t' }, prompt: 'geospatial-analyst' });
        expect(servers[1].headers).toEqual({ Authorization: 'Bearer b-token' });
        // Headers set in the entry win over auth_token.
        expect(resolveServers({ url: 'https://a/mcp', headers: { authorization: 'Basic x' }, auth_token: 't' })[0].headers).toEqual({ authorization: 'Basic x' });
    });
});

describe('converting a v3 index.html to glen core', () => {
    it('loads core/main.js and moves every glen URL to the release', () => {
        const page = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.45.1/app/style.css">
<script type="module" src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.45.1/app/main.js"></script>
<script src="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.js"></script>`;
        const { html, changed } = convertIndexHtml(page, 'v4.0.0');
        expect(changed).toBe(2);
        expect(html).toContain('glen@v4.0.0/app/style.css');
        expect(html).toContain('src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.0.0/core/main.js"');
        expect(html).toContain('maplibre-gl@5.22.0');
    });
});
