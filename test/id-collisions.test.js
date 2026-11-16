// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PortolanCatalog, uniqueDatasetId } from '../core/portolan-catalog.js';
import { MapManager } from '../app/map-manager.js';

/**
 * SchmidtDSE/glen#492: ids built from different collections could collide,
 * silently, so the order of layers-input.json decided what a layer drew.
 */

const pm = (href) => ({ href, type: 'application/vnd.pmtiles', roles: ['visual'], 'pmtiles:layers': ['l'] });
const coll = (id, assets) => ({ type: 'Collection', id, title: id, assets, links: [] });

function catalogOf(docs, delays = {}) {
    return new PortolanCatalog({
        fetchJson: async (u) => {
            if (delays[u]) await new Promise(r => setTimeout(r, delays[u]));
            return structuredClone(docs[u]);
        },
        pmtilesMetadata: async () => null,
    });
}

afterEach(() => vi.restoreAllMocks());

describe('collections that share an id (#492)', () => {
    const docs = {
        'https://a.org/roads/collection.json': coll('roads', { tiles: pm('https://a.org/roads.pmtiles') }),
        'https://b.org/roads/collection.json': coll('roads', { tiles: pm('https://b.org/roads.pmtiles') }),
    };

    it('keeps both, numbering the later one in config order, with a warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The first collection answers last; config order still decides.
        const c = catalogOf(docs, { 'https://a.org/roads/collection.json': 20 });
        await c.load({ collections: Object.keys(docs) });
        expect([...c.datasets.keys()]).toEqual(['roads', 'roads-2']);
        const urls = Object.fromEntries(c.getMapLayerConfigs().map(l => [l.layerId, l.source.url]));
        expect(urls).toEqual({ roads: 'pmtiles://https://a.org/roads.pmtiles', 'roads-2': 'pmtiles://https://b.org/roads.pmtiles' });
        expect(warn.mock.calls.flat().join(' ')).toMatch(/both "roads".*"roads-2".*"id"/);
    });

    it('keeps one id for the same collection listed twice, with both entries\' layers', async () => {
        const url = 'https://a.org/roads/collection.json';
        const c = catalogOf({ [url]: coll('roads', { main: pm('https://a.org/m.pmtiles'), side: pm('https://a.org/s.pmtiles') }) });
        await c.load({ collections: [{ url, assets: ['main'] }, { url, assets: ['side'], display_name: 'Side' }] });
        expect([...c.datasets.keys()]).toEqual(['roads']);
        expect(c.datasets.get('roads').layerIds).toEqual(['roads/main', 'roads/side']);
    });

    it('numbers past ids already taken', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const taken = new Map([['x', 'u1'], ['x-2', 'u2']]);
        expect(uniqueDatasetId('x', 'u1', taken)).toBe('x');
        expect(uniqueDatasetId('x', 'u3', taken)).toBe('x-3');
    });
});

describe('source ids (#492)', () => {
    it('gives different files different sources, whatever their ids flatten to', async () => {
        const c = catalogOf({
            'https://c.org/x/collection.json': coll('land-use', { a: pm('https://c.org/1.pmtiles'), b: pm('https://c.org/x.pmtiles') }),
            'https://c.org/y/collection.json': coll('land', { 'use-a': pm('https://c.org/2.pmtiles'), b: pm('https://c.org/y.pmtiles') }),
        });
        await c.load({ collections: ['https://c.org/x/collection.json', 'https://c.org/y/collection.json'] });
        const byLayer = Object.fromEntries(c.getMapLayerConfigs().map(l => [l.layerId, l.sourceId]));
        expect(byLayer['land-use/a']).not.toBe(byLayer['land/use-a']);
        expect(new Set(Object.values(byLayer)).size).toBe(4);
    });
});

function managerWithMap() {
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map();
    const sources = new Map();
    const layers = new Map();
    mm.map = {
        getSource: (id) => sources.get(id) || null,
        addSource: (id, s) => { if (sources.has(id)) throw new Error(`duplicate source ${id}`); sources.set(id, s); },
        getLayer: (id) => layers.get(id) || null,
        addLayer: (def) => { if (layers.has(def.id)) throw new Error(`duplicate layer ${def.id}`); layers.set(def.id, def); },
        setLayoutProperty: () => {}, setFilter: () => {},
    };
    for (const k of ['_wireTooltip', '_showLegendIfVisible', '_refreshLegend', '_promoteLegendType', '_refreshCycleBtnState']) mm[k] = () => {};
    mm._hasLegend = () => false;
    return { mm, sources, layers };
}

const vector = (layerId, url, extra = {}) => ({
    layerId, datasetId: layerId.split('/')[0], displayName: layerId, type: 'vector',
    source: { type: 'vector', url: `pmtiles://${url}` }, sourceLayer: 'l', paint: {}, ...extra,
});

describe('MapManager with colliding ids (#492)', () => {
    it('draws each layer from its own data, and shares a source only for the same data', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { mm, sources } = managerWithMap();
        mm.registerLayer(vector('one', 'https://x/1.pmtiles', { sourceId: 'src-shared' }));
        mm.registerLayer(vector('two', 'https://x/1.pmtiles', { sourceId: 'src-shared' }));
        mm.registerLayer(vector('three', 'https://x/2.pmtiles', { sourceId: 'src-shared' }));
        expect(mm.layers.get('two').sourceId).toBe('src-shared');
        expect(mm.layers.get('three').sourceId).not.toBe('src-shared');
        expect(sources.get(mm.layers.get('three').sourceId).url).toBe('pmtiles://https://x/2.pmtiles');
        expect(warn.mock.calls.flat().join(' ')).toMatch(/"src-shared" is already used for other data; layer "three"/);
    });

    it('keeps layers apart whose ids differ only in "-" and "/"', () => {
        const { mm, layers } = managerWithMap();
        mm.registerLayer(vector('land-use/a', 'https://x/1.pmtiles'));
        mm.registerLayer(vector('land/use-a', 'https://x/2.pmtiles'));
        expect([...layers.keys()]).toEqual(expect.arrayContaining(['layer-land-use/a', 'layer-land/use-a']));
        const container = document.createElement('div');
        mm.generateControls(container);
        const rows = [...container.querySelectorAll('.layer-item')].map(r => r.dataset.layerId);
        expect(rows).toEqual(['land-use/a', 'land/use-a']);
    });
});
