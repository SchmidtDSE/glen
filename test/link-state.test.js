// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    parseMapView, formatMapView, parseLayerList, linkWith, updateLink, linkParams, bindMapLink, RESERVED_LINK_KEYS,
} from '../app/link-state.js';

beforeEach(() => history.replaceState(null, '', '/app/'));

describe('the map view in the link (SchmidtDSE/glen#506)', () => {
    it('reads zoom/lat/lng, with bearing and pitch when given', () => {
        expect(parseMapView('7.25/18.1/-77.3')).toEqual({ center: [-77.3, 18.1], zoom: 7.25, bearing: 0, pitch: 0 });
        expect(parseMapView('7/18/-77/30/45')).toEqual({ center: [-77, 18], zoom: 7, bearing: 30, pitch: 45 });
    });

    it('drops a missing or malformed view', () => {
        for (const v of [null, '', '7/18', '7/18/x', '7/95/0', '7/0/200', '30/0/0', '7/0/0/0/90', '1/2/3/4/5/6', '7//0']) {
            expect(parseMapView(v)).toBeNull();
        }
    });

    it('writes the view rounded to what the zoom shows, and bearing and pitch only when set', () => {
        expect(formatMapView({ center: [-77.312345678, 18.123456789], zoom: 7.256 })).toBe('7.26/18.123/-77.312');
        expect(formatMapView({ center: [-77.312345678, 18.123456789], zoom: 14 })).toBe('14/18.12346/-77.31235');
        expect(formatMapView({ center: [10.5, 20.25], zoom: 2 })).toBe('2/20.25/10.5');
        expect(formatMapView({ center: [0, 0], zoom: 5, bearing: 30 })).toBe('5/0/0/30');
        expect(formatMapView({ center: [0, 0], zoom: 5, pitch: 40 })).toBe('5/0/0/0/40');
        expect(parseMapView(formatMapView({ center: [-77.3, 18.1], zoom: 9, bearing: -20, pitch: 30 })))
            .toEqual({ center: [-77.3, 18.1], zoom: 9, bearing: -20, pitch: 30 });
    });
});

describe('the layers in the link', () => {
    it('keeps only the app\'s own layer ids', () => {
        expect(parseLayerList('a,zzz, b ,', ['a', 'b', 'c'])).toEqual(['a', 'b']);
        expect(parseLayerList('', ['a'])).toEqual([]);
        expect(parseLayerList(null, ['a'])).toBeNull();
    });
});

describe('rewriting the link', () => {
    it('sets and removes its own keys and keeps the others, the path and the hash', () => {
        expect(linkWith('https://x.org/app/?harness=h&map=1/2/3#data', { map: '7/18/-77', layers: 'a/b,c' }))
            .toBe('/app/?harness=h&map=7/18/-77&layers=a/b,c#data');
        expect(linkWith('https://x.org/app/?map=1/2/3', { map: null })).toBe('/app/');
    });

    it('encodes what could break the query', () => {
        expect(linkWith('https://x.org/', { q: 'a&b=c d' })).toBe('/?q=a%26b%3Dc+d');
    });

    it('replaces the page\'s link without adding to its history', () => {
        const before = history.length;
        updateLink({ map: '5/1/2' });
        expect(location.pathname + location.search).toBe('/app/?map=5/1/2');
        expect(history.length).toBe(before);
        expect(linkParams().get('map')).toBe('5/1/2');
    });

    it('does nothing without a window', () => {
        expect(() => updateLink({ map: '5/1/2' }, null)).not.toThrow();
        expect(linkParams(null).toString()).toBe('');
    });

    it('reserves the keys core writes', () => {
        expect([...RESERVED_LINK_KEYS]).toEqual(expect.arrayContaining(['map', 'layers', 'harness']));
    });
});

/** A MapManager with a map that reports one view and remembers its moveend handler. */
function fakeMapManager(visible) {
    const handlers = {};
    const layers = new Map(Object.entries(visible).map(([id, v]) => [id, { visible: v }]));
    const mm = {
        layers,
        map: {
            on: (ev, fn) => { handlers[ev] = fn; },
            getCenter: () => ({ lng: -77.3, lat: 18.1 }),
            getZoom: () => 9, getBearing: () => 0, getPitch: () => 0,
        },
        showLayer: vi.fn((id) => { layers.get(id).visible = true; mm.onVisibilityChange?.(id, true); }),
        hideLayer: vi.fn((id) => { layers.get(id).visible = false; mm.onVisibilityChange?.(id, false); }),
        syncCheckbox: vi.fn(),
    };
    return { mm, handlers };
}

describe('bindMapLink', () => {
    it('shows the layers the link names and hides the app\'s others', () => {
        history.replaceState(null, '', '/app/?layers=b,c,hex-1');
        const { mm } = fakeMapManager({ a: true, b: false, c: true, 'hex-1': false });
        const res = bindMapLink(mm, ['a', 'b', 'c']);
        expect(res.layers).toEqual(['b', 'c']);
        expect(mm.hideLayer).toHaveBeenCalledWith('a');
        expect(mm.showLayer).toHaveBeenCalledWith('b');
        expect(mm.showLayer).not.toHaveBeenCalledWith('c');
        expect(mm.syncCheckbox.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
        expect(mm.layers.get('hex-1').visible).toBe(false);
        expect(location.search).toBe('?layers=b,c');
    });

    it('leaves layers out of the link while they are the app\'s defaults', () => {
        const { mm } = fakeMapManager({ a: true, b: false });
        bindMapLink(mm, ['a', 'b']);
        expect(location.search).toBe('');
        mm.showLayer('b');
        expect(location.search).toBe('?layers=a,b');
        mm.hideLayer('b');
        expect(location.search).toBe('');
        mm.hideLayer('a');
        expect(location.search).toBe('?layers=');
    });

    it('removes a link\'s layers that match the defaults', () => {
        history.replaceState(null, '', '/app/?layers=a');
        const { mm } = fakeMapManager({ a: true, b: false });
        bindMapLink(mm, ['a', 'b']);
        expect(location.search).toBe('');
    });

    it('writes the view when the map stops moving', () => {
        const { mm, handlers } = fakeMapManager({ a: true });
        bindMapLink(mm, ['a']);
        handlers.moveend();
        expect(location.search).toBe('?map=9/18.1/-77.3');
    });

    it('leaves out layers that are not the app\'s, such as hex layers the agent drew', () => {
        const { mm } = fakeMapManager({ a: true, 'hex-1': false });
        bindMapLink(mm, ['a']);
        mm.showLayer('hex-1');
        expect(location.search).toBe('');
    });
});
