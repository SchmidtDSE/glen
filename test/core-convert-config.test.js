import { describe, it, expect } from 'vitest';
import { convertConfig, convertIndexHtml, loadsOwnLibraries, DEFAULT_MCP_URL } from '../core/convert-config.js';
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

describe('geolocation in a converted app', () => {
    it('becomes the geolocate plugin, with true as the button alone', () => {
        const find = (cfg) => cfg.plugins.find(p => typeof p === 'object' && p.url.endsWith('/geolocate.js'));
        expect(find(convertConfig({ geolocate: true }, { pluginBase: B }).config).options).toEqual({ button: true, agent_tool: false });
        expect(find(convertConfig({ geolocate: { button: true, agent_tool: true } }, { pluginBase: B }).config).options).toEqual({ button: true, agent_tool: true });
        expect(find(convertConfig({}, { pluginBase: B }).config)).toBeUndefined();
        expect(convertConfig({ geolocate: true }, { pluginBase: B }).config).not.toHaveProperty('geolocate');
    });
});

describe('the session export in a converted app', () => {
    it('stays on, as v3 had it by default, unless the app turned it off', () => {
        expect(convertConfig({ collections: [] }, { pluginBase: B }).config.export).toBe(true);
        expect(convertConfig({ export: false }, { pluginBase: B }).config.export).toBe(false);
        expect(convertConfig({ export: { default_code_language: 'r' } }, { pluginBase: B }).config.export).toEqual({ default_code_language: 'r' });
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

    const V3_PAGE = `<head>
    <!-- MapLibre GL JS -->
    <script src="https://unpkg.com/maplibre-gl@5.20.0/dist/maplibre-gl.js"
        integrity="sha384-a" crossorigin="anonymous"></script>
    <link href="https://unpkg.com/maplibre-gl@5.20.0/dist/maplibre-gl.css" rel="stylesheet"
        integrity="sha384-b" crossorigin="anonymous" />
    <script src="https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js" integrity="sha384-c" crossorigin="anonymous"></script>
    <script src="https://unpkg.com/h3-js@4.1.0/dist/h3-js.umd.js" integrity="sha384-d" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked@18.0.5/lib/marked.umd.js" integrity="sha384-e" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/dompurify@3.4.8/dist/purify.min.js" integrity="sha384-f" crossorigin="anonymous"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-agent@v3.40.0/app/style.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.45.1/app/chat.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.45.1/app/sidebar.css">
    <link rel="stylesheet" href="my-app.css">
    <link rel="icon" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.45.1/app/assets/favicon.svg">
    <script src="https://example.org/analytics.js"></script>
</head>
<body>
    <div id="map"></div>
    <script type="module" src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.45.1/app/main.js"></script>
</body>`;

    it('removes the tags glen core adds itself from v4.5.0, with their comments, and keeps the rest', () => {
        const { html, changed, removed } = convertIndexHtml(V3_PAGE, 'v4.5.0');
        expect(removed).toHaveLength(11);
        expect(html).not.toMatch(/maplibre-gl|pmtiles|h3-js|marked|dompurify|highlight\.js|style\.css|chat\.css|sidebar\.css|MapLibre GL JS/);
        expect(html).toContain('<link rel="stylesheet" href="my-app.css">');
        expect(html).toContain('https://example.org/analytics.js');
        expect(html).toContain('glen@v4.5.0/app/assets/favicon.svg');
        expect(html).toContain('src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.5.0/core/main.js"');
        expect(changed).toBe(2);
    });

    it('moves a glen core page to the release, leaving no run of blank lines', () => {
        const page = '<head>\n    <script src="https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js"></script>\n\n    <script src="https://cdn.jsdelivr.net/npm/marked@18.0.5/lib/marked.umd.js"></script>\n\n\n    <style></style>\n</head>\n<script type="module" src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.2.1/core/main.js"></script>';
        const { html, changed } = convertIndexHtml(page, 'v4.5.0');
        expect(changed).toBe(1);
        expect(html).toContain('glen@v4.5.0/core/main.js');
        expect(html).not.toMatch(/\n[ \t]*\n[ \t]*\n/);
    });

    it('reads a page that still loads boettiger-lab/geo-agent, and drops its MCP import map', () => {
        const page = `<script type="importmap">
    { "imports": { "@modelcontextprotocol/sdk/client/index.js": "https://esm.sh/@modelcontextprotocol/sdk@1.12.0/client/index" } }
    </script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.24.0/app/style.css">
    <script type="module" src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.24.0/app/main.js"></script>`;
        const { html, changed, removed } = convertIndexHtml(page, 'v4.5.0');
        expect(changed).toBe(1);
        expect(html).toContain('src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.5.0/core/main.js"');
        expect(html).not.toMatch(/importmap|style\.css/);
        expect(removed).toContain('importmap (@modelcontextprotocol/sdk)');
        const other = '<script type="importmap">{ "imports": { "lodash": "https://x/lodash.js" } }</script>';
        expect(convertIndexHtml(other, 'v4.5.0').html).toBe(other);
    });

    it('keeps every tag for an earlier release or a commit, which need them', () => {
        for (const ref of ['v4.4.0', 'v3.53.0', '4638c4adaf89d483d76563280e60894d8906f363']) {
            const { html, removed } = convertIndexHtml(V3_PAGE, ref);
            expect(removed).toEqual([]);
            expect(html).toContain('maplibre-gl@5.20.0/dist/maplibre-gl.js');
        }
        expect([loadsOwnLibraries('v4.5.0'), loadsOwnLibraries('v4.10.0'), loadsOwnLibraries('v5.0.0'), loadsOwnLibraries('v4.4.9')]).toEqual([true, true, true, false]);
    });
});
