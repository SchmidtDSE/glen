/**
 * runtime.js — Start a hosted app: find its config, keep what an app may set,
 * join it with this deployment's settings, and start glen core with it.
 *
 * The page is hosted/map/index.html, also served as /a/<slug>/ for each app
 * in the registry. See hosted/README.md.
 */

import { configSource, decodeConfig, sanitizeAppConfig, buildCoreConfig } from './hosted-config.js';

// Before core loads, so it waits for start() and the config given here.
window.GLEN_CORE_MANUAL_START = true;

const DEPLOYMENT_URL = new URL('deployment.json', import.meta.url).href;
const BUILDER_URL = new URL('./', import.meta.url).href;

/** Say why the app cannot start, on the page where the map would be. */
function fail(message) {
    const status = document.getElementById('boot-status');
    if (!status) return;
    const p = document.createElement('p');
    p.textContent = message;
    const a = document.createElement('a');
    a.href = BUILDER_URL;
    a.textContent = 'Build an app';
    status.replaceChildren(p, a);
}

async function getJson(url, what) {
    let res;
    try {
        res = await fetch(url, { cache: 'no-cache' });
    } catch (err) {
        throw new Error(`${what} could not be read (${err.message}). A config on another site must allow cross-origin reads (CORS).`);
    }
    if (!res.ok) throw new Error(`${what} could not be read (HTTP ${res.status}).`);
    try { return await res.json(); } catch { throw new Error(`${what} is not JSON.`); }
}

async function appConfigFrom(source, deployment) {
    const unlisted = () => {
        if (!deployment.allow_unlisted) throw new Error('This deployment serves only the apps published on it.');
    };
    switch (source.kind) {
        case 'slug':
            return getJson(new URL(`${deployment.registry || 'apps/'}${source.value}.json`, DEPLOYMENT_URL), `The app "${source.value}"`);
        case 'url':
            unlisted();
            return getJson(new URL(source.value, location.href).href, `The config at ${source.value}`);
        case 'inline':
            unlisted();
            return decodeConfig(source.value);
        case 'bad':
            throw new Error(`"${source.value}" is not an app name.`);
        default:
            return null;
    }
}

async function run() {
    const deployment = await getJson(DEPLOYMENT_URL, 'This deployment\'s settings');
    const raw = await appConfigFrom(configSource(location), deployment);
    if (!raw) {
        location.replace(BUILDER_URL);
        return;
    }
    const { config: app, notes } = sanitizeAppConfig(raw);
    for (const n of notes) console.warn('[hosted]', n);
    const { config, skipped } = buildCoreConfig(app, deployment, { base: DEPLOYMENT_URL });
    if (skipped.length) console.warn(`[hosted] This deployment has no ${skipped.join(', ')} plugin; the app runs without it.`);
    if (app.title) document.title = app.title;
    const runtimeConfig = deployment.runtime_config
        ? await getJson(new URL(deployment.runtime_config, DEPLOYMENT_URL).href, 'The model settings').catch((err) => {
            console.warn('[hosted]', err.message);
            return null;
        })
        : null;
    const { start } = await import('../core/main.js');
    await start({ config, runtimeConfig });
}

run().catch((err) => {
    console.error('[hosted]', err);
    fail(err.message);
});
