/**
 * Small pieces of glen core's start-up (core/main.js), kept here so tests can
 * reach them: main.js imports glen-harness from the CDN, which tests cannot.
 */

/**
 * The map's opening camera from the app's `view`. A view with a center but
 * no zoom opens at zoom 6, as in the full app; with neither, the whole world.
 * @param {Object} [view]
 */
export function initialView(view) {
    return {
        center: view?.center || [0, 20],
        zoom: view?.zoom ?? (view?.center ? 6 : 2),
        pitch: view?.pitch ?? 0,
        bearing: view?.bearing ?? 0,
        globe: view?.globe ?? false,
    };
}

/** The highlight.js theme the full app used, at the same version as the harness's highlight.js. */
export const HIGHLIGHT_THEME = {
    href: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
    integrity: 'sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH',
};

/**
 * Load highlight.js and its SQL grammar, so the chat colours the SQL in tool
 * calls, unless the page already has it. The scripts come from the harness's
 * own list (CHAT_SCRIPTS in glen-harness ui/deps.js), with its versions and
 * integrity hashes; the page's marked and DOMPurify are left alone. A script
 * that fails to load is logged and skipped, since the chat works without it.
 *
 * @param {Array<{src: string, integrity: string, global?: string}>} scripts
 * @param {Object} [opts]
 * @param {Document} [opts.doc]
 * @param {Object} [opts.win] - where the `hljs` global lives
 * @returns {Promise<boolean>} whether anything was loaded
 */
export async function loadHighlighter(scripts, { doc = document, win = globalThis } = {}) {
    if (win.hljs) return false;
    if (!doc.querySelector(`link[href="${HIGHLIGHT_THEME.href}"]`)) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = HIGHLIGHT_THEME.href;
        link.integrity = HIGHLIGHT_THEME.integrity;
        link.crossOrigin = 'anonymous';
        doc.head.appendChild(link);
    }
    for (const s of scripts.filter((x) => x.src.includes('/highlight.js/'))) {
        if (doc.querySelector(`script[src="${s.src}"]`)) continue;
        // The SQL grammar registers itself with hljs, so the scripts load in order.
        await new Promise((resolve) => {
            const el = doc.createElement('script');
            el.src = s.src;
            el.integrity = s.integrity;
            el.crossOrigin = 'anonymous';
            el.onload = resolve;
            el.onerror = () => { console.warn(`[core] Could not load ${s.src}`); resolve(); };
            doc.head.appendChild(el);
        });
    }
    return true;
}
