/**
 * prompt.js — The opening of glen core's system prompt: core's own base
 * prompt, then the app's.
 *
 * An app's prompt is the file `system_prompt_url` names, or else a
 * `system-prompt.md` beside the page, as v3 apps served it. It adds to core's
 * prompt rather than replacing it. An app without one is fine, so a missing
 * default file is not an error. The layers and the plugins' sections follow
 * these in main.js.
 */

const FALLBACK_BASE = 'You help people explore geospatial data on an interactive map.';

/**
 * Where the app's prompt is, or null when it would be core's own file (the
 * page at /core/ sits beside core/system-prompt.md).
 * @param {Object} config - the app config
 * @param {string} baseUrl - absolute URL of core's system-prompt.md
 * @param {string} pageUrl - the page's URL (document.baseURI)
 */
export function appPromptUrl(config, baseUrl, pageUrl) {
    const url = new URL(config?.system_prompt_url || 'system-prompt.md', pageUrl).href;
    return url === new URL(baseUrl, pageUrl).href ? null : url;
}

/**
 * Text of a prompt file, or '' when there is none. A server that answers a
 * missing file with the app's index page (an SPA fallback) gives HTML, which
 * is not a prompt.
 */
async function readPrompt(url, fetchFn) {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (/html/i.test(res.headers?.get?.('content-type') || '') || /^\s*<(!doctype|html)/i.test(text)) throw new Error('got an HTML page');
    return text.trim();
}

/**
 * Core's base prompt and the app's, joined.
 * @param {Object} config
 * @param {Object} opts
 * @param {string} opts.baseUrl - absolute URL of core's system-prompt.md
 * @param {string} opts.pageUrl - the page's URL
 * @param {Function} [opts.fetchFn]
 */
export async function loadPrompts(config, { baseUrl, pageUrl, fetchFn = fetch }) {
    const appUrl = appPromptUrl(config, baseUrl, pageUrl);
    const [base, app] = await Promise.all([
        readPrompt(baseUrl, fetchFn).catch((err) => {
            console.warn(`[core] Base prompt ${baseUrl} unreadable (${err.message}); using a minimal one.`);
            return FALLBACK_BASE;
        }),
        appUrl ? readPrompt(appUrl, fetchFn).catch((err) => {
            // Only a file the app named is worth a warning.
            if (config?.system_prompt_url) console.warn(`[core] App prompt ${appUrl} unreadable (${err.message}).`);
            return '';
        }) : '',
    ]);
    return [base, app].filter(Boolean).join('\n\n');
}
