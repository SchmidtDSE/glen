/**
 * dataset-citations.js — how a dataset is cited, from its STAC record.
 *
 * Shared by the exported session report (the datasets one session used) and
 * the app's data page (every dataset the app loads), so the two cannot drift
 * apart: better metadata in the catalog improves both, with no change here.
 *
 * DOM-free: everything returns plain objects or strings.
 */

/**
 * The citation fields of one STAC collection, as a plain object the report,
 * the scripts and the data page render. The catalog's metadata is uneven —
 * some collections carry a full `sci:citation`, some only a `cite-as` DOI
 * link, some neither — so every field but the title and STAC link may be
 * missing.
 *
 * @param {object} stac - a STAC collection
 * @param {string} [fallbackUrl] - where it was fetched from, if it has no `self` link
 * @returns {{id: string, title: string, stacUrl: string|null, aboutUrl: string|null,
 *            producers: string[], license: string|null, licenseUrl: string|null,
 *            citation: string|null, doiUrl: string|null}}
 */
export function datasetCitation(stac, fallbackUrl = null) {
    const links = Array.isArray(stac?.links) ? stac.links : [];
    const link = (...rels) => links.find(l => rels.includes(l.rel) && l.href)?.href || null;
    const doi = typeof stac?.['sci:doi'] === 'string' && stac['sci:doi'].trim();
    const producers = (stac?.providers || [])
        .filter(p => p?.name && (p.roles || []).some(r => r === 'producer' || r === 'licensor'))
        .map(p => p.name);
    return {
        id: stac?.id || '',
        title: stac?.title || stac?.id || 'Untitled dataset',
        stacUrl: link('self') || fallbackUrl,
        aboutUrl: link('about'),
        producers,
        license: stac?.license || null,
        licenseUrl: link('license'),
        citation: typeof stac?.['sci:citation'] === 'string' ? stac['sci:citation'].trim() || null : null,
        doiUrl: doi ? (/^https?:\/\//.test(doi) ? doi : `https://doi.org/${doi}`) : link('cite-as'),
    };
}

/** True when the citation text already carries the DOI, so it isn't shown twice. */
function doiInCitation(d) {
    return Boolean(d.doiUrl && (d.citation || '').includes(d.doiUrl.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')));
}

/** One dataset as plain text lines, for a script comment or a notebook. */
export function datasetTextLines(d) {
    const lines = [d.title + (d.producers.length ? ` - ${d.producers.join(', ')}` : '') + '.'];
    if (d.citation) lines.push(d.citation);
    if (d.doiUrl && !doiInCitation(d)) lines.push(`Cite as: ${d.doiUrl}`);
    if (d.license) lines.push(`License: ${d.license}${d.licenseUrl ? ` (${d.licenseUrl})` : ''}`);
    if (d.stacUrl) lines.push(`STAC: ${d.stacUrl}`);
    return lines;
}

/** DOM-free HTML escape. */
export function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/** Make the DOI URLs in already-escaped citation text into links. */
function linkDois(html, attrs) {
    return html.replace(/https?:\/\/(?:dx\.)?doi\.org\/[^\s<]+?(?=[.,;)]?(?:\s|$))/g, u => `<a href="${u}"${attrs}>${u}</a>`);
}

/**
 * The inner HTML of one dataset's list item: title and producers, the
 * citation, then a line of license and record links.
 *
 * @param {ReturnType<typeof datasetCitation>} d
 * @param {object} [opts]
 * @param {string[]} [opts.meta] - extra, already-escaped entries for the meta line
 * @param {boolean} [opts.newTab] - open links in a new tab (the in-app page
 *     does; the exported report is its own document and doesn't)
 * @returns {string}
 */
export function datasetItemHtml(d, { meta = [], newTab = false } = {}) {
    const attrs = newTab ? ' target="_blank" rel="noopener noreferrer"' : '';
    const a = (href, text) => href ? `<a href="${escapeHtml(href)}"${attrs}>${text}</a>` : text;
    const title = `<strong>${escapeHtml(d.title)}</strong>`;
    const by = d.producers.length ? ` — ${escapeHtml(d.producers.join(', '))}` : '';
    const cite = d.citation
        ? `<p class="ds-citation">${linkDois(escapeHtml(d.citation), attrs)}${d.doiUrl && !doiInCitation(d) ? ` ${a(d.doiUrl, escapeHtml(d.doiUrl))}` : ''}</p>`
        : d.doiUrl ? `<p class="ds-citation">Cite as ${a(d.doiUrl, escapeHtml(d.doiUrl))}</p>`
        : `<p class="ds-citation ds-none">The catalog gives no formal citation; cite the producer.</p>`;
    const line = [
        d.license ? `License: ${a(d.licenseUrl, escapeHtml(d.license))}` : '',
        d.stacUrl ? a(d.stacUrl, 'STAC record') : '',
        d.aboutUrl ? a(d.aboutUrl, 'About') : '',
        ...meta,
    ].filter(Boolean).join(' · ');
    return `<p class="ds-title">${title}${by}</p>${cite}${line ? `<p class="ds-meta">${line}</p>` : ''}`;
}
