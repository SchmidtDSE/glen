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
// glen-harness, loaded from jsDelivr at a release tag, as apps load glen
// itself. Its ./core entry is the agent loop and tool registry without the MCP
// client. Both URLs name the same tag; bump them together.
import { Agent, ToolRegistry } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.2.0/src/core.js';
import { ChatUI } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.2.0/ui/chat-ui.js';
import { PortolanCatalog } from './portolan-catalog.js';
import { createCoreMapTools } from './map-tools.js';

/** The ref this module was loaded at (a tag or SHA on jsDelivr), or 'dev'. */
export const CORE_VERSION = import.meta.url.match(/glen@([^/]+)/)?.[1] || 'dev';

const STORAGE_KEY_API = 'geo-agent-api-key';
const STORAGE_KEY_ENDPOINT = 'geo-agent-endpoint';

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
    if (!appConfig.llm_models && appConfig.llm?.user_provided) {
        const saved = loadUserLLMConfig(appConfig.llm);
        if (saved) {
            appConfig.llm_models = saved.llm_models;
            appConfig.llm_model = saved.llm_models[0]?.value;
        }
        appConfig._userProvidedMode = true;
    }

    /* ── 2. Chrome, catalog and map (catalog and map load in parallel) ── */
    const layoutRefs = buildLayout(appConfig);
    const promptP = loadSystemPrompt(appConfig);
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
    // With no view configured, open on the data.
    if (!appConfig.view) fitToCatalog(mapManager, catalog);

    /* ── 3. Map tools ──────────────────────────────────────────────────── */
    const tools = new ToolRegistry();
    const geoCfg = appConfig.geocoder || {};
    let geocoder = null;
    if (geoCfg.enabled !== false) {
        try {
            geocoder = createGeocoder({ ...geoCfg, maptiler_key: geoCfg.maptiler_key || runtimeConfig?.maptiler_key });
        } catch (err) {
            console.warn('[core] Geocoder off:', err.message);
        }
    }
    for (const t of createCoreMapTools(mapManager, catalog, { geocoder })) tools.registerLocal(t);

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
    const agent = new Agent(appConfig, tools, { clientName: `glen-core/${CORE_VERSION}` });
    agent.setSystemPrompt(systemPrompt);
    // The session export documents SQL sessions; a map-only app leaves it off
    // unless its config turns it on, and then the harness loads it on first use.
    appConfig.export ??= false;
    const ui = new ChatUI(agent, appConfig, layoutRefs.chatMount, mapManager);
    ui.catalog = catalog;
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
    for (const k of ['llm_models', 'llm_model', 'transcription_model', 'max_tool_calls', 'max_tool_calls_manual']) {
        if (runtimeConfig[k] != null) appConfig[k] = runtimeConfig[k];
    }
    return appConfig;
}

/**
 * Build llm_models from a key the user saved in this browser (the
 * user-provided key mode, e.g. an OpenRouter key). Shares geo-agent's
 * localStorage names, so a key saved in one GLEN app works in the others on
 * the same site.
 */
export function loadUserLLMConfig(llmConfig, storage = globalThis.localStorage) {
    const apiKey = storage?.getItem(STORAGE_KEY_API);
    if (!apiKey) return null;
    const endpoint = storage.getItem(STORAGE_KEY_ENDPOINT) || llmConfig.default_endpoint || 'https://openrouter.ai/api/v1';
    const models = (llmConfig.models || []).map(m => ({ ...m, endpoint, api_key: apiKey }));
    if (!models.length) models.push({ value: 'auto', label: 'Auto', endpoint, api_key: apiKey });
    return { llm_models: models };
}

/** The base prompt: the app's own file if it names one, else the core's. */
async function loadSystemPrompt(appConfig) {
    const url = appConfig.system_prompt_url || new URL('./system-prompt.md', import.meta.url).href;
    try {
        return await fetchText(url);
    } catch (err) {
        console.warn(`[core] System prompt ${url} unreadable; using a minimal one:`, err.message);
        return 'You control an interactive map. Use the tools to show, hide, filter and style its layers.';
    }
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

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.text();
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
