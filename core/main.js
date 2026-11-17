/**
 * glen core — a map, a Portolan catalog, and an agent that drives the map.
 *
 *   config → Portolan catalog + map → map tools → plugins → agent → chat
 *
 * The core assumes no MCP server, SQL engine or tile server of its own. The
 * agent's tools act on the page (show, hide, filter, style, legend, fly to).
 * Everything else glen does (DuckDB over MCP, hex layers, charts, drawing,
 * uploads, session export) is meant to arrive as a plugin.
 *
 * A downstream app serves index.html, layers-input.json and (optionally) a
 * config.json, and loads this module from the CDN:
 *
 *   <script type="module" src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<ref>/core/main.js"></script>
 *
 * Plugins are ES modules listed in layers-input.json:
 *
 *   "plugins": ["https://…/my-plugin.js", { "url": "https://…/other.js", "options": { … } }]
 *
 * and export a default object `{ name, setup(ctx, options) }`. See
 * core/README.md for the context a plugin receives.
 */

import { MapManager } from '../app/map-manager.js';
import { buildLayout, sidebarHooks } from '../app/layout-manager.js';
import { createGeocoder } from '../app/geocoder.js';
import { mountDataPage } from '../app/data-page.js';
import { mountH3GridToggle } from '../app/h3-grid.js';
// glen-harness, loaded from jsDelivr at a release tag, as apps load glen
// itself. Its ./core entry is the agent loop and tool registry without the MCP
// client. Both URLs name the same tag; bump them together.
import {
    Agent, ToolRegistry, applyProxyModelList, buildUserModels, loadUserSettings,
} from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.5.0/src/core.js';
import { ChatUI } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.5.0/ui/chat-ui.js';
import { PortolanCatalog, exportCatalogView } from './portolan-catalog.js';
import { createCoreMapTools } from './map-tools.js';
import { loadPrompts } from './prompt.js';
import { ensurePanelActions } from '../app/panel-actions.js';

/**
 * The harness's chat, with Export in the panel's action row beside Globe and
 * Upload, where v3 had it. The harness alone puts a bare icon in the chat
 * footer, which people did not find. Without a layer panel (floating layout)
 * it falls back to the footer.
 */
class GlenChatUI extends ChatUI {
    exportRow() {
        const controls = document.getElementById('layer-controls-container');
        return controls ? ensurePanelActions(controls) : null;
    }
}

/** The ref this module was loaded at (a tag or SHA on jsDelivr), or 'dev'. */
export const CORE_VERSION = import.meta.url.match(/glen@([^/]+)/)?.[1] || 'dev';

/**
 * Start a glen core app.
 * @param {Object} [options]
 * @param {Array<Object>} [options.plugins] - plugin objects, in addition to
 *   the module URLs named in the config's `plugins`
 * @returns {Promise<Object>} the plugin context, for scripts and tests
 */
export async function start({ plugins: extraPlugins = [] } = {}) {
    /* ── 1. Config ─────────────────────────────────────────────────────── */
    const [appConfig, runtimeConfig] = await Promise.all([
        fetchJson('layers-input.json'),
        fetchJson('config.json').catch(() => null),
    ]);
    mergeRuntimeConfig(appConfig, runtimeConfig);
    // A user-provided key builds the model list from what this browser saved
    // (glen#443). Otherwise, behind open-llm-proxy, the picker shows the
    // models the app's key may use (glen#444); this runs beside the catalog
    // and map, and the agent waits for it.
    let modelListP = null;
    if (!appConfig.llm_models && appConfig.llm?.user_provided) {
        const saved = buildUserModels(appConfig.llm, loadUserSettings());
        if (saved) Object.assign(appConfig, saved);
        appConfig._userProvidedMode = true;
    } else {
        modelListP = applyProxyModelList(appConfig).catch((err) => {
            console.warn('[core] Model list unavailable; using llm_models:', err.message);
            return null;
        });
    }

    /* ── 2. Chrome, catalog and map (catalog and map load in parallel) ── */
    const layoutRefs = buildLayout(appConfig);
    // Core's base prompt, then the app's own (system_prompt_url, or a
    // system-prompt.md beside the page).
    const promptP = loadPrompts(appConfig, { baseUrl: new URL('./system-prompt.md', import.meta.url).href, pageUrl: document.baseURI });
    const catalog = new PortolanCatalog();
    const mapManager = new MapManager('map', {
        center: appConfig.view?.center || [0, 20],
        zoom: appConfig.view?.zoom ?? 2,
        pitch: appConfig.view?.pitch ?? 0,
        bearing: appConfig.view?.bearing ?? 0,
        globe: appConfig.view?.globe ?? false,
        titilerUrl: appConfig.titiler_url || 'https://titiler.nrp-nautilus.io',
        maptilerKey: runtimeConfig?.maptiler_key || '',
        defaultBasemap: appConfig.default_basemap || 'natgeo',
        customBasemap: appConfig.custom_basemap || null,
    });
    await Promise.all([catalog.load(appConfig), mapManager.ready]);

    // The data sources page (#data): every collection with its citation and license.
    try { mountDataPage(catalog); } catch (err) { console.error('[core] Data page failed to mount:', err); }
    sidebarHooks.onResizeTick = () => mapManager.map.resize();
    sidebarHooks.onResizeEnd = () => mapManager.map.resize();
    mapManager.generateMenu(layoutRefs.menuMountId);
    mapManager.addLayersFromCatalog(catalog.getMapLayerConfigs());
    mapManager.generateControls('layer-controls-container');
    // The H3 grid, a reference for what size of cell a pixel or feature is.
    try { mountH3GridToggle(mapManager.map); } catch (err) { console.error('[core] Hex grid button failed:', err); }
    // With no view configured, open on the data.
    if (!appConfig.view) fitToCatalog(mapManager, catalog);

    /* ── 3. Map tools ──────────────────────────────────────────────────── */
    const tools = new ToolRegistry();
    // One geocoder serves the `geocode` tool (on unless `enabled: false`) and
    // the search box (off unless `search_box: true`).
    const geoCfg = appConfig.geocoder || {};
    const geocodeTool = geoCfg.enabled !== false;
    let geocoder = null;
    if (geocodeTool || geoCfg.search_box) {
        try {
            geocoder = createGeocoder({ ...geoCfg, maptiler_key: geoCfg.maptiler_key || runtimeConfig?.maptiler_key });
        } catch (err) {
            console.warn('[core] Geocoder off:', err.message);
        }
    }
    if (geocoder && geoCfg.search_box) {
        // The library loads only for apps that show the box.
        import('../app/map-geocoder.js')
            .then(({ addSearchBox }) => addSearchBox(mapManager.map, geocoder, {
                position: geoCfg.search_box_position,
                placeholder: geoCfg.search_box_placeholder,
            }))
            .catch(err => console.warn('[core] Search box failed:', err.message));
    }
    for (const t of createCoreMapTools(mapManager, catalog, { geocoder: geocodeTool ? geocoder : null })) tools.registerLocal(t);

    /* ── 4. Plugins ────────────────────────────────────────────────────── */
    const promptParts = [];
    const readyHooks = [];
    const ctx = {
        version: CORE_VERSION,
        config: appConfig,
        runtimeConfig,
        map: mapManager,
        catalog,
        tools,
        layout: layoutRefs,
        /** Add a section to the system prompt (keep it static per deployment). */
        addPrompt: (text) => { if (text) promptParts.push(String(text)); },
        /** Run once the agent and chat exist: fn({ agent, ui }). */
        onReady: (fn) => readyHooks.push(fn),
        agent: null,
        ui: null,
    };
    const plugins = [...await loadPluginModules(appConfig.plugins || []), ...extraPlugins.map(p => ({ plugin: p, options: {} }))];
    for (const { plugin, options } of plugins) {
        try {
            await plugin.setup?.(ctx, options || {});
            console.log(`[core] Plugin ready: ${plugin.name || '(unnamed)'}`);
        } catch (err) {
            console.error(`[core] Plugin ${plugin.name || '(unnamed)'} failed; continuing without it:`, err);
        }
    }

    /* ── 5. Agent and chat ─────────────────────────────────────────────── */
    const systemPrompt = [await promptP, catalog.generatePrompt(), ...promptParts].join('\n\n');
    const tier = await modelListP;
    if (tier) console.log(`[core] Models from the proxy (${tier} tier): ${appConfig.llm_models.length}`);
    const agent = new Agent(appConfig, tools, { clientName: `glen-core/${CORE_VERSION}` });
    agent.setSystemPrompt(systemPrompt);
    // The session export documents SQL sessions; a map-only app leaves it off
    // unless its config turns it on, and then the harness loads it on first use.
    // It redraws the session's charts with the charts plugin's renderer.
    appConfig.export ??= false;
    const ui = new GlenChatUI(agent, appConfig, layoutRefs.chatMount, mapManager, ctx.charts || null);
    ui.catalog = exportCatalogView(catalog);
    ctx.agent = agent;
    ctx.ui = ui;
    for (const fn of readyHooks) {
        try { await fn({ agent, ui }); } catch (err) { console.error('[core] onReady hook failed:', err); }
    }
    console.log(`[core] Ready: ${catalog.layers.size} layers, ${tools.getNames().length} tools`);
    return ctx;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */


/** Copy the deploy-time settings (models, keys) over the static config. */
export function mergeRuntimeConfig(appConfig, runtimeConfig) {
    if (!runtimeConfig) return appConfig;
    // As in the full app. The MCP server's URL and token reach plugins/mcp.js
    // through ctx.runtimeConfig instead.
    for (const k of ['llm_models', 'llm_model', 'transcription_model', 'max_tool_calls', 'max_tool_calls_manual', 'geolocate', 'export']) {
        if (runtimeConfig[k] != null) appConfig[k] = runtimeConfig[k];
    }
    return appConfig;
}

async function loadPluginModules(specs) {
    const out = [];
    for (const spec of specs) {
        const url = typeof spec === 'string' ? spec : spec?.url;
        if (!url) continue;
        try {
            const mod = await import(new URL(url, document.baseURI).href);
            const plugin = mod.default || mod.plugin;
            if (!plugin) throw new Error('module has no default export');
            out.push({ plugin, options: (typeof spec === 'object' && spec.options) || {} });
        } catch (err) {
            console.error(`[core] Plugin ${url} failed to load; continuing without it:`, err);
        }
    }
    return out;
}

/** Frame every collection's extent when the config sets no view. */
function fitToCatalog(mapManager, catalog) {
    const boxes = catalog.getAll().map(d => d.bbox).filter(b => Array.isArray(b) && b.length >= 4)
        .map(b => (b.length === 6 ? [b[0], b[1], b[3], b[4]] : b));
    if (!boxes.length) return;
    const w = Math.min(...boxes.map(b => b[0])), s = Math.min(...boxes.map(b => b[1]));
    const e = Math.max(...boxes.map(b => b[2])), n = Math.max(...boxes.map(b => b[3]));
    mapManager.map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0, maxZoom: 14 });
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.json();
}

/* ── Boot ─────────────────────────────────────────────────────────────── */

// Start on load unless the page asks to call start() itself (for plugins
// passed as objects, or tests).
if (typeof window !== 'undefined' && !window.GLEN_CORE_MANUAL_START) {
    start().catch(err => {
        console.error('[core] Fatal boot error:', err);
        const msg = document.getElementById('chat-messages');
        if (msg) {
            const div = document.createElement('div');
            div.className = 'chat-message error';
            div.textContent = `Failed to start: ${err.message}`;
            msg.replaceChildren(div);
        }
    });
}
