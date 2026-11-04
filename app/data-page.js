/**
 * data-page.js — the app's data sources page (#433).
 *
 * Lists every dataset the app loads, with the citation its STAC record gives,
 * built by the same code the exported report uses for the datasets one
 * session touched (`dataset-citations.js`). Apps used to keep such a list by
 * hand on an About page, where it drifted from the catalog the app actually
 * loads; this one cannot drift, and better catalog metadata improves it with
 * no change to the app.
 *
 * Downstream apps are a single static HTML file loading this library from a
 * CDN, so the page is a dialog inside the app rather than a separate file,
 * addressed by the `#data` fragment. That makes it linkable from anywhere —
 * a custom About page links to `https://<app>/#data` — and the header nav and
 * chat footer link to it by default. `links.data: false` removes the links;
 * `links.data: { label }` renames them. The page itself still opens on
 * `#data` either way, so an About page's link keeps working.
 */

import { datasetCitation, datasetItemHtml, escapeHtml } from './dataset-citations.js';

/** The fragment that opens the page. */
export const DATA_PAGE_HASH = '#data';

const DEFAULT_LABEL = 'Data';

/**
 * The default link to the page, from the `links` config block, or null when
 * the app has turned it off with `links.data: false`.
 *
 * @param {object} [links] - the app's `links` block
 * @returns {{label: string, href: string}|null}
 */
export function resolveDataLink(links) {
    const cfg = links?.data;
    if (cfg === false) return null;
    const label = typeof cfg?.label === 'string' && cfg.label.trim() ? cfg.label.trim() : DEFAULT_LABEL;
    return { label, href: DATA_PAGE_HASH };
}

/**
 * Citation records for every dataset the catalog loaded, in catalog order.
 * A collection that groups sub-collections lists them under it, each with its
 * own citation, since a query reads (and a citation is owed to) the child.
 *
 * @param {{_rawStac?: object, _rawChildren?: object[]|null}[]} entries - DatasetCatalog#getAll
 * @returns {(ReturnType<typeof datasetCitation> & {children: ReturnType<typeof datasetCitation>[]})[]}
 */
export function catalogDatasets(entries = []) {
    return entries
        .filter(e => e?._rawStac)
        .map(e => ({
            ...datasetCitation(e._rawStac),
            children: (e._rawChildren || []).filter(Boolean).map(c => datasetCitation(c)),
        }));
}

/**
 * The page body: an introduction and the list.
 *
 * @param {ReturnType<typeof catalogDatasets>} datasets
 * @param {object} [opts]
 * @param {string|null} [opts.catalogUrl] - the STAC catalog the app reads
 * @param {boolean} [opts.degraded] - the catalog could not be reached at boot
 * @returns {string}
 */
export function dataPageHtml(datasets, { catalogUrl = null, degraded = false } = {}) {
    const link = (href, text) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    const from = catalogUrl ? ` Each entry comes from its record in the ${link(catalogUrl, 'STAC catalog')}.` : '';
    const intro = `<p class="data-page-intro">The datasets this app loads, with the citation each one's catalog record gives. Please cite the ones your work uses.${from}</p>`;

    if (!datasets.length) {
        const why = degraded
            ? 'The data catalog could not be reached when the app loaded, so no datasets are listed. Reload the page to try again.'
            : 'This app loads no datasets from a catalog.';
        return `${intro}<p class="data-page-empty">${why}</p>`;
    }

    const items = datasets.map(d => {
        let sub = '';
        if (d.children.length) {
            const n = d.children.length;
            const kids = d.children.map(c => `<li>${datasetItemHtml(c, { newTab: true })}</li>`).join('');
            sub = `<details class="ds-children"><summary>${n} sub-collection${n === 1 ? '' : 's'}</summary><ol class="ds-list">${kids}</ol></details>`;
        }
        return `<li>${datasetItemHtml(d, { newTab: true })}${sub}</li>`;
    }).join('\n');
    return `${intro}<ol class="ds-list">\n${items}\n</ol>`;
}

/**
 * Build the page as a dialog and open it whenever the URL fragment is
 * `#data`, including on load. Closing it clears the fragment, so the link can
 * be followed again; the browser's back button closes it too.
 *
 * Call once the catalog has loaded. A click on a link before then only sets
 * the fragment, which this picks up when it mounts.
 *
 * @param {{getAll: Function, catalogUrl?: string, degraded?: boolean}} catalog
 * @param {object} [opts]
 * @param {Document} [opts.doc]
 * @param {Window} [opts.win]
 * @returns {{element: HTMLDialogElement, open: Function, close: Function}}
 */
export function mountDataPage(catalog, { doc = document, win = window } = {}) {
    const dialog = doc.createElement('dialog');
    dialog.id = 'data-page';
    dialog.setAttribute('aria-labelledby', 'data-page-title');

    const head = doc.createElement('div');
    head.className = 'data-page-head';
    const title = doc.createElement('h2');
    title.id = 'data-page-title';
    title.textContent = 'Data sources';
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'data-page-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    head.append(title, closeBtn);

    const body = doc.createElement('div');
    body.className = 'data-page-body';
    dialog.append(head, body);
    doc.body.appendChild(dialog);

    // Rendered on each open rather than once: cheap, and it keeps the page
    // honest if the catalog is ever reloaded.
    const render = () => {
        body.innerHTML = dataPageHtml(catalogDatasets(catalog?.getAll?.() || []), {
            catalogUrl: catalog?.catalogUrl || null,
            degraded: Boolean(catalog?.degraded),
        });
    };

    const isOpen = () => dialog.open;
    const open = () => {
        if (isOpen()) return;
        render();
        // jsdom and very old browsers lack showModal; the attribute still shows it.
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        body.scrollTop = 0;
    };
    const close = () => {
        if (!isOpen()) return;
        if (typeof dialog.close === 'function') dialog.close();
        else { dialog.removeAttribute('open'); dialog.dispatchEvent(new win.Event('close')); }
    };

    closeBtn.addEventListener('click', close);
    // A click on the backdrop lands on the dialog element itself.
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
    dialog.addEventListener('close', () => {
        if (win.location.hash === DATA_PAGE_HASH) {
            win.history.replaceState(null, '', win.location.pathname + win.location.search);
        }
    });

    const sync = () => (win.location.hash === DATA_PAGE_HASH ? open() : close());
    win.addEventListener('hashchange', sync);
    sync();

    return { element: dialog, open, close };
}
