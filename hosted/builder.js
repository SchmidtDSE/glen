/**
 * builder.js — The map builder: make a hosted app's config with a form, and
 * get a link that runs it or a pull request that publishes it at /a/<slug>/.
 *
 * The form edits one object, the app config (hosted-config.js says which
 * settings it may hold). Settings the form has no control for, such as a
 * layer's styles, are kept, and can be edited in the config file box.
 */

import { sanitizeAppConfig, encodeConfig, decodeConfig, configSource, slugify, proposalUrl, SLUG } from './hosted-config.js';
import { listCollections } from './catalog-browse.js';
import { addScripts, addStylesheets, PAGE_SCRIPTS, PAGE_STYLESHEETS } from '../core/boot.js';

const DEPLOYMENT_URL = new URL('deployment.json', import.meta.url).href;
const MAP_PAGE = new URL('map/', import.meta.url).href;
const $ = (id) => document.getElementById(id);

let deployment = {};
let app = {};
let found = [];
let viewMap = null;

/* ── State ─────────────────────────────────────────────────────────────── */

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) o = (o[k] && typeof o[k] === 'object') ? o[k] : (o[k] = {});
    const last = keys.at(-1);
    if (value === '' || value == null || (Array.isArray(value) && !value.length)) delete o[last];
    else o[last] = value;
    // An emptied parent goes too, so the config holds only what was set.
    if (keys.length > 1 && !Object.keys(o).length) setPath(obj, keys.slice(0, -1).join('.'), undefined);
}

function blankApp() {
    return { title: '', catalog: deployment.catalog || '', collections: [], plugins: [...(deployment.default_plugins || [])] };
}

/** Replace the app being edited and redraw the whole form. */
function load(next, notes = []) {
    const { config, notes: more } = sanitizeAppConfig(next);
    app = config;
    app.collections ||= [];
    if (!app.plugins) app.plugins = [...(deployment.default_plugins || [])];
    showNotes([...notes, ...more]);
    renderForm();
    changed();
}

function showNotes(notes) {
    $('notes').replaceChildren(...notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
}

/* ── Form ──────────────────────────────────────────────────────────────── */

function renderForm() {
    for (const el of document.querySelectorAll('[data-bind]')) {
        const v = getPath(app, el.dataset.bind);
        if ('lines' in el.dataset) el.value = (v || []).join('\n');
        else if ('list' in el.dataset) el.value = (v || []).join(', ');
        else el.value = typeof v === 'string' ? v : '';
        // A setting the form cannot show (a theme with brand colours) is
        // edited in the config file box instead.
        el.disabled = v != null && typeof v === 'object' && !Array.isArray(v);
    }
    $('titiler').placeholder = deployment.titiler_url || '';
    renderPlugins();
    renderChosen();
    renderFound();
    $('use-view').checked = !!app.view;
    if (viewMap && app.view?.center) viewMap.jumpTo({ center: app.view.center, zoom: app.view.zoom ?? 6 });
    if (!$('slug').value && app.title) $('slug').value = slugify(app.title);
}

function bindInputs() {
    for (const el of document.querySelectorAll('[data-bind]')) {
        el.addEventListener('input', () => {
            let v = el.value;
            if ('lines' in el.dataset) v = v.split('\n').map(s => s.trim()).filter(Boolean);
            else if ('list' in el.dataset) v = v.split(',').map(s => s.trim()).filter(Boolean);
            else if (el.tagName !== 'TEXTAREA') v = v.trim();
            setPath(app, el.dataset.bind, v);
            if (el.dataset.bind === 'title' && !$('slug').dataset.touched) $('slug').value = slugify(app.title);
            changed();
        });
    }
}

function renderPlugins() {
    const box = $('plugins');
    box.replaceChildren(...Object.entries(deployment.plugins || {}).map(([name, def]) => {
        const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: app.plugins?.includes(name) });
        input.addEventListener('change', () => {
            const set = new Set(app.plugins || []);
            if (input.checked) set.add(name); else set.delete(name);
            app.plugins = Object.keys(deployment.plugins).filter(n => set.has(n));
            changed();
        });
        const label = document.createElement('label');
        label.className = 'inline';
        label.append(input, ` ${def.label || name}`);
        return label;
    }));
}

/* ── Collections ───────────────────────────────────────────────────────── */

const specUrl = (c) => (typeof c === 'string' ? c : c.url || c.collection_url || c.collection_id || c.id);

function renderChosen() {
    const list = $('chosen');
    const cols = app.collections || [];
    $('chosen-empty').hidden = cols.length > 0;
    list.replaceChildren(...cols.map((c, i) => {
        if (typeof c === 'string') cols[i] = c = { url: c };
        const li = document.createElement('li');
        const name = Object.assign(document.createElement('input'), { type: 'text', value: c.display_name || '', placeholder: 'Name in the layer list' });
        name.addEventListener('input', () => { setPath(c, 'display_name', name.value.trim()); changed(); });
        const group = Object.assign(document.createElement('input'), { type: 'text', value: c.group || '', placeholder: 'Group' });
        group.addEventListener('input', () => { setPath(c, 'group', group.value.trim()); changed(); });
        const vis = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!c.visible });
        vis.addEventListener('change', () => { setPath(c, 'visible', vis.checked || undefined); changed(); });
        const visLabel = document.createElement('label');
        visLabel.className = 'inline';
        visLabel.append(vis, ' On at start');
        const move = (d) => () => {
            const j = i + d;
            if (j < 0 || j >= cols.length) return;
            [cols[i], cols[j]] = [cols[j], cols[i]];
            renderChosen();
            changed();
        };
        const btn = (text, title, fn) => {
            const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, title });
            b.addEventListener('click', fn);
            return b;
        };
        const src = Object.assign(document.createElement('div'), { className: 'muted small', textContent: specUrl(c) });
        const fields = document.createElement('div');
        fields.className = 'row wrap';
        fields.append(name, group, visLabel,
            btn('↑', 'Earlier in the list', move(-1)),
            btn('↓', 'Later in the list', move(1)),
            btn('Remove', 'Remove this layer', () => { cols.splice(i, 1); renderChosen(); renderFound(); changed(); }));
        li.append(fields, src);
        return li;
    }));
}

function isChosen(url) {
    return (app.collections || []).some(c => specUrl(c) === url);
}

function addCollection(url, title) {
    if (!url || isChosen(url)) return;
    app.collections.push({ url, ...(title ? { display_name: title } : {}) });
    renderChosen();
    renderFound();
    changed();
}

async function browse() {
    const url = $('catalog').value.trim();
    if (!url) return;
    $('browser').hidden = false;
    $('browse-status').textContent = 'Reading the catalog…';
    found = [];
    renderFound();
    try {
        found = await listCollections(url, {
            fetchJson: async (u) => {
                const r = await fetch(u);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            },
            onProgress: (n) => { $('browse-status').textContent = `Reading the catalog… ${n} documents`; },
        });
        const drawable = found.filter(c => c.kinds.length).length;
        $('browse-status').textContent = `${found.length} collections, ${drawable} with map layers.`;
    } catch (err) {
        $('browse-status').textContent = `The catalog could not be read: ${err.message}. It must be public JSON that allows cross-origin reads (CORS).`;
    }
    renderFound();
}

function renderFound() {
    const q = $('filter').value.trim().toLowerCase();
    const drawableOnly = $('drawable-only').checked;
    const shown = found.filter(c => (!drawableOnly || c.kinds.length)
        && (!q || `${c.title} ${c.id} ${c.parent || ''} ${c.description}`.toLowerCase().includes(q)));
    $('found').replaceChildren(...shown.slice(0, 200).map((c) => {
        const li = document.createElement('li');
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: isChosen(c.url) });
        box.addEventListener('change', () => {
            if (box.checked) addCollection(c.url, c.title);
            else {
                app.collections = app.collections.filter(x => specUrl(x) !== c.url);
                renderChosen();
                changed();
            }
        });
        const label = document.createElement('label');
        label.className = 'inline';
        const title = Object.assign(document.createElement('strong'), { textContent: c.title });
        const meta = Object.assign(document.createElement('span'), {
            className: 'muted small',
            textContent: ` ${c.id}${c.parent ? ` · in ${c.parent}` : ''}${c.kinds.length ? ` · ${c.kinds.join(' and ')}` : ' · no map layer'}`,
        });
        label.append(box, ' ', title, meta);
        li.append(label);
        return li;
    }));
    if (shown.length > 200) $('found').append(Object.assign(document.createElement('li'), { className: 'muted', textContent: `${shown.length - 200} more; filter to find them.` }));
}

/* ── View ──────────────────────────────────────────────────────────────── */

async function mountViewMap() {
    await Promise.all([addStylesheets(PAGE_STYLESHEETS), addScripts(PAGE_SCRIPTS)]);
    const esri = (name) => `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${name}/MapServer/tile/{z}/{y}/{x}`;
    viewMap = new maplibregl.Map({
        container: 'view-map',
        style: {
            version: 8,
            sources: {
                base: { type: 'raster', tiles: [esri('World_Light_Gray_Base')], tileSize: 256, maxzoom: 16, attribution: 'Tiles &copy; Esri' },
                labels: { type: 'raster', tiles: [esri('World_Light_Gray_Reference')], tileSize: 256, maxzoom: 16 },
            },
            layers: [{ id: 'base', type: 'raster', source: 'base' }, { id: 'labels', type: 'raster', source: 'labels' }],
        },
        center: app.view?.center || [-98, 39],
        zoom: app.view?.zoom ?? 3,
        attributionControl: { compact: true },
    });
    viewMap.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    viewMap.on('moveend', () => { if ($('use-view').checked) takeView(); });
}

function takeView() {
    if (!viewMap) return;
    const c = viewMap.getCenter();
    app.view = { center: [+c.lng.toFixed(4), +c.lat.toFixed(4)], zoom: +viewMap.getZoom().toFixed(2) };
    changed();
}

/* ── Output ────────────────────────────────────────────────────────────── */

let encoding = 0;

/** The app changed: redraw the config box, the link and the publish form. */
async function changed() {
    const json = JSON.stringify(app, null, 2);
    if (document.activeElement !== $('json')) $('json').value = json;
    const mine = ++encoding;
    const c = await encodeConfig(app);
    if (mine !== encoding) return;
    const link = `${MAP_PAGE}?c=${c}`;
    $('open-app').href = link;
    $('open-app').dataset.link = link;
    $('link-note').textContent = link.length > 6000
        ? `The link is ${link.length} characters, too long for some servers and chat apps. Publish the app at a path, or host the config file and open it with ?config=<its URL>.`
        : 'The link carries the whole config, so it works without publishing anything.';
    renderPublish();
}

function renderPublish() {
    const slug = $('slug').value.trim();
    const ok = SLUG.test(slug);
    const appUrl = new URL(`../a/${slug}/`, new URL('./', import.meta.url)).href;
    $('path-preview').textContent = ok ? appUrl : 'Lowercase letters, digits and hyphens.';
    const propose = $('propose');
    if (ok && deployment.repo) {
        propose.href = proposalUrl(deployment.repo, deployment.registry_path || 'hosted/apps', slug, app);
        propose.removeAttribute('aria-disabled');
    } else {
        propose.removeAttribute('href');
        propose.setAttribute('aria-disabled', 'true');
    }
}

function download() {
    const blob = new Blob([`${JSON.stringify(app, null, 4)}\n`], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${$('slug').value.trim() || 'app'}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ── Starting points ───────────────────────────────────────────────────── */

async function fetchApp(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

/** Open an app link (…/a/<slug>/, ?app=, ?config= or ?c=) or a config URL. */
async function openLink(text) {
    let url;
    try { url = new URL(text, location.href); } catch { throw new Error('That is not a link.'); }
    const src = configSource(url);
    if (src.kind === 'inline') return decodeConfig(src.value);
    if (src.kind === 'slug') return fetchApp(new URL(`${deployment.registry || 'apps/'}${src.value}.json`, DEPLOYMENT_URL));
    if (src.kind === 'url') return fetchApp(new URL(src.value, location.href));
    return fetchApp(url);
}

function bindStarts() {
    const starts = $('starts');
    for (const ex of deployment.examples || []) {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: ex.title || ex.slug });
        b.addEventListener('click', async () => {
            try {
                load(await fetchApp(new URL(`${deployment.registry || 'apps/'}${ex.slug}.json`, DEPLOYMENT_URL)));
                $('slug').value = '';
                renderPublish();
            } catch (err) { showNotes([`Could not load ${ex.slug}: ${err.message}`]); }
        });
        starts.append(b);
    }
    starts.querySelector('[data-start=blank]').addEventListener('click', () => { $('slug').value = ''; load(blankApp()); });
    $('upload').addEventListener('change', async () => {
        const file = $('upload').files[0];
        if (!file) return;
        try { load(JSON.parse(await file.text()), [`Read ${file.name}.`]); } catch (err) { showNotes([`${file.name} is not a config: ${err.message}`]); }
        $('upload').value = '';
    });
    $('open-link-go').addEventListener('click', async () => {
        try { load(await openLink($('open-link').value.trim())); } catch (err) { showNotes([`Could not open it: ${err.message}`]); }
    });
}

/* ── Start ─────────────────────────────────────────────────────────────── */

async function init() {
    deployment = await (await fetch(DEPLOYMENT_URL, { cache: 'no-cache' })).json();
    $('deployment-about').textContent = deployment.about || '';
    bindStarts();
    bindInputs();
    $('browse').addEventListener('click', browse);
    $('filter').addEventListener('input', renderFound);
    $('drawable-only').addEventListener('change', renderFound);
    $('add-url-go').addEventListener('click', () => { addCollection($('add-url').value.trim()); $('add-url').value = ''; });
    $('use-view').addEventListener('change', () => {
        if ($('use-view').checked) takeView();
        else { delete app.view; changed(); }
    });
    $('slug').addEventListener('input', () => { $('slug').dataset.touched = '1'; renderPublish(); });
    $('copy-link').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText($('open-app').dataset.link);
            $('copy-link').textContent = 'Copied';
        } catch { prompt('Copy this link', $('open-app').dataset.link); }
        setTimeout(() => { $('copy-link').textContent = 'Copy link'; }, 1500);
    });
    $('download').addEventListener('click', download);
    $('json-apply').addEventListener('click', () => {
        try {
            load(JSON.parse($('json').value));
            $('json-status').textContent = 'Applied.';
        } catch (err) { $('json-status').textContent = `Not valid JSON: ${err.message}`; }
    });

    // The builder opens on the app its link names (?c=, ?config=, ?app=), or a new one.
    const src = configSource(location);
    let start = blankApp();
    if (src.kind !== 'none') {
        try { start = await openLink(location.href); } catch (err) { showNotes([`Could not open the app in the link: ${err.message}`]); }
    }
    load(start);
    mountViewMap().catch(err => console.warn('[builder] map:', err.message));
}

init().catch((err) => showNotes([`The builder could not start: ${err.message}`]));
