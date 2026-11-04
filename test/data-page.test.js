// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    DATA_PAGE_HASH, resolveDataLink, catalogDatasets, dataPageHtml, mountDataPage,
} from '../app/data-page.js';
import { datasetCitation, datasetItemHtml, datasetTextLines } from '../app/dataset-citations.js';

const cited = {
    id: 'mobi', title: 'Map of Biodiversity Importance',
    license: 'CC-BY-4.0',
    'sci:citation': 'Hamilton et al. 2022. https://doi.org/10.1002/eap.2534.',
    'sci:doi': '10.1002/eap.2534',
    providers: [{ name: 'NatureServe', roles: ['producer'] }],
    links: [
        { rel: 'self', href: 'https://stac.example/mobi/collection.json' },
        { rel: 'license', href: 'https://creativecommons.org/licenses/by/4.0/' },
    ],
};
const bare = { id: 'bare', title: 'Bare <dataset>', links: [] };
const child = (id) => ({ id, title: `Child ${id}`, links: [{ rel: 'cite-as', href: `https://doi.org/10.1/${id}` }] });

describe('resolveDataLink', () => {
    it('is on by default, with or without a links block', () => {
        expect(resolveDataLink(undefined)).toEqual({ label: 'Data', href: DATA_PAGE_HASH });
        expect(resolveDataLink({ docs: 'https://d.example' })).toEqual({ label: 'Data', href: '#data' });
    });
    it('is off with links.data: false', () => {
        expect(resolveDataLink({ data: false })).toBeNull();
    });
    it('takes a label, and ignores a blank one', () => {
        expect(resolveDataLink({ data: { label: ' Data sources ' } }).label).toBe('Data sources');
        expect(resolveDataLink({ data: { label: '  ' } }).label).toBe('Data');
        expect(resolveDataLink({ data: true }).label).toBe('Data');
    });
});

describe('catalogDatasets', () => {
    it('cites every catalog entry, in order, with its sub-collections', () => {
        const ds = catalogDatasets([
            { id: 'mobi', _rawStac: cited, _rawChildren: null },
            { id: 'parent', _rawStac: bare, _rawChildren: [child('a'), child('b')] },
            { id: 'nostac' },
        ]);
        expect(ds.map(d => d.id)).toEqual(['mobi', 'bare']);
        expect(ds[0].children).toEqual([]);
        expect(ds[1].children.map(c => c.doiUrl)).toEqual(['https://doi.org/10.1/a', 'https://doi.org/10.1/b']);
    });
    it('copes with no entries', () => {
        expect(catalogDatasets()).toEqual([]);
    });
});

describe('dataPageHtml', () => {
    it('lists the datasets with their citations and links, opening in a new tab', () => {
        const html = dataPageHtml(catalogDatasets([{ _rawStac: cited }]), { catalogUrl: 'https://stac.example/catalog.json' });
        expect(html).toContain('<strong>Map of Biodiversity Importance</strong> — NatureServe');
        expect(html).toContain('Hamilton et al. 2022.');
        // The DOI inside the citation is linked, and not repeated after it.
        expect(html.match(/doi\.org\/10\.1002\/eap\.2534/g)).toHaveLength(2); // href + text, once
        expect(html).toContain('href="https://stac.example/catalog.json"');
        expect(html).not.toMatch(/<a href="[^"]*">/); // every link carries target
    });
    it('escapes catalog text', () => {
        const html = dataPageHtml(catalogDatasets([{ _rawStac: bare }]));
        expect(html).toContain('Bare &lt;dataset&gt;');
        expect(html).toContain('The catalog gives no formal citation');
    });
    it('folds sub-collections into a disclosure', () => {
        const html = dataPageHtml(catalogDatasets([{ _rawStac: bare, _rawChildren: [child('a')] }]));
        expect(html).toContain('<summary>1 sub-collection</summary>');
        expect(html).toContain('Child a');
    });
    it('says why the list is empty', () => {
        expect(dataPageHtml([], { degraded: true })).toContain('could not be reached');
        expect(dataPageHtml([])).toContain('loads no datasets');
    });
});

describe('dataset-citations', () => {
    it('leaves the report markup as it was: no target, usage in the meta line', () => {
        const d = datasetCitation(cited);
        const html = datasetItemHtml(d, { meta: ['queried in this session'] });
        expect(html).not.toContain('target=');
        expect(html).toMatch(/<p class="ds-meta">License: .* · queried in this session<\/p>$/);
    });
    it('gives plain text lines for scripts', () => {
        expect(datasetTextLines(datasetCitation(bare))).toEqual(['Bare <dataset>.']);
    });
});

describe('mountDataPage', () => {
    const catalog = {
        getAll: () => [{ _rawStac: cited }],
        catalogUrl: 'https://stac.example/catalog.json',
        degraded: false,
    };
    let page;

    beforeEach(() => {
        document.body.innerHTML = '';
        history.replaceState(null, '', '/app/');
    });
    afterEach(() => page?.close());

    it('stays closed without the fragment', () => {
        page = mountDataPage(catalog);
        expect(page.element.open).toBe(false);
        expect(document.getElementById('data-page')).toBe(page.element);
    });

    it('opens on load when the URL already has #data', () => {
        history.replaceState(null, '', '/app/#data');
        page = mountDataPage(catalog);
        expect(page.element.open).toBe(true);
        expect(page.element.textContent).toContain('Map of Biodiversity Importance');
    });

    it('opens on hashchange and closes when the fragment goes', () => {
        page = mountDataPage(catalog);
        location.hash = '#data';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        expect(page.element.open).toBe(true);
        location.hash = '';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        expect(page.element.open).toBe(false);
    });

    it('clears the fragment on close, so the link works again', () => {
        history.replaceState(null, '', '/app/?x=1#data');
        page = mountDataPage(catalog);
        page.element.querySelector('.data-page-close').click();
        expect(page.element.open).toBe(false);
        expect(location.hash).toBe('');
        expect(location.pathname + location.search).toBe('/app/?x=1');
    });

    it('closes on a backdrop click but not a click inside', () => {
        history.replaceState(null, '', '/app/#data');
        page = mountDataPage(catalog);
        page.element.querySelector('.data-page-body').click();
        expect(page.element.open).toBe(true);
        page.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(page.element.open).toBe(false);
    });

    it('is labelled by its heading', () => {
        page = mountDataPage(catalog);
        const id = page.element.getAttribute('aria-labelledby');
        expect(document.getElementById(id).textContent).toBe('Data sources');
    });
});
