import { describe, it, expect, beforeEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Bare MapManager mock exposing only the surface setFilter touches:
 * a single registered vector layer and a map that records setFilter calls.
 */
function createManager(featuresInView = 3, layer = {}) {
    const setFilterCalls = [];
    const sourceQueries = [];
    const map = {
        setFilter: (id, f) => setFilterCalls.push({ id, f }),
        // What was drawn before the filter: setFilter must not report it (#527).
        queryRenderedFeatures: () => Array.from({ length: 99 }, () => ({})),
        querySourceFeatures: (id, opts) => {
            sourceQueries.push({ id, opts });
            return Array.from({ length: featuresInView }, () => ({}));
        },
    };
    const mm = Object.create(MapManager.prototype);
    mm.map = map;
    mm.layers = new Map([
        ['vec', { type: 'vector', mapLayerId: 'layer-vec', sourceId: 'src-vec', sourceLayer: 'plots', displayName: 'Vec', ...layer }],
    ]);
    mm._sourceQueries = sourceQueries;
    mm._setFilterCalls = setFilterCalls;
    return mm;
}

describe('MapManager.setFilter empty-filter guard (#243)', () => {
    let mm;
    beforeEach(() => { mm = createManager(); });

    it('rejects an empty array [] with an error instead of silent success', () => {
        const r = mm.setFilter('vec', []);
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/empty/i);
        // The no-op filter never reaches the map (would otherwise clear it silently).
        expect(mm._setFilterCalls.length).toBe(0);
    });

    it('applies a valid (non-empty) filter expression', () => {
        const expr = ['==', ['get', 'NO_TAKE'], 'All'];
        const r = mm.setFilter('vec', expr);
        expect(r.success).toBe(true);
        expect(r.filter).toEqual(expr);
        expect(r.featuresInView).toBe(3);
        expect(mm._setFilterCalls[0].f).toEqual(expr);
    });

    it('still allows null to clear — clearFilter passes null, not [] (the guard must not block it)', () => {
        const r = mm.setFilter('vec', null);
        expect(r.success).toBe(true);
        expect(mm._setFilterCalls[0].f).toBe(null);
    });
});

describe('MapManager._applyControlAction (reactive slider, #147)', () => {
    const setup = (extra = {}) => {
        const setFilterCalls = [];
        const queryCalls = { n: 0 };
        const mm = Object.create(MapManager.prototype);
        mm.map = {
            setFilter: (id, f) => setFilterCalls.push({ id, f }),
            queryRenderedFeatures: () => { queryCalls.n++; return []; },
        };
        mm.layers = new Map([
            ['vec', { type: 'vector', mapLayerId: 'layer-vec', outlineLayerId: 'layer-vec-outline', displayName: 'Vec', ...extra }],
        ]);
        mm._setFilterCalls = setFilterCalls;
        mm._queryCalls = queryCalls;
        return mm;
    };

    it('applies the slider expression to the layer and its outline', () => {
        const mm = setup();
        mm._applyControlAction('vec', { kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
        expect(mm._setFilterCalls).toEqual([
            { id: 'layer-vec', f: ['<=', ['get', 'YEAR_'], 1990] },
            { id: 'layer-vec-outline', f: ['<=', ['get', 'YEAR_'], 1990] },
        ]);
    });

    it('does NOT call queryRenderedFeatures (cheap per-frame path, unlike setFilter)', () => {
        const mm = setup();
        mm._applyControlAction('vec', { kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
        expect(mm._queryCalls.n).toBe(0);
    });

    it('composes the slider predicate with the layer base filter so a defaultFilter survives', () => {
        const base = ['==', ['get', 'severity'], 'high'];
        const mm = setup({ controlBaseFilter: base });
        mm._applyControlAction('vec', { kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
        expect(mm._setFilterCalls[0].f).toEqual(['all', base, ['<=', ['get', 'YEAR_'], 1990]]);
    });

    it('ignores non-filter actions and unknown layers', () => {
        const mm = setup();
        mm._applyControlAction('vec', { kind: 'style', paint: {} });
        mm._applyControlAction('missing', { kind: 'filter', expr: ['<=', ['get', 'x'], 1] });
        expect(mm._setFilterCalls.length).toBe(0);
    });
});

describe('MapManager.setFilter 0-features-in-view', () => {
    it('reports plain success with no failure signal when 0 features are in the viewport', () => {
        // queryRenderedFeatures is viewport-scoped: a valid filter whose matches are
        // off-screen returns 0 here. The result must NOT flag that as a problem — a
        // warning here was being relayed to users as "filter matched nothing / is
        // wrong". featuresInView is plain data; 0 just means none in the current view.
        const mm = createManager(0);
        const expr = ['==', ['get', 'admin_agency'], 'NPS'];
        const r = mm.setFilter('vec', expr);

        expect(r.success).toBe(true);
        expect(r.featuresInView).toBe(0);
        // No warning / error / "no match" failure signal — the filter applied fine.
        expect(r.warning).toBeUndefined();
        expect(r.error).toBeUndefined();
    });
});

describe('MapManager.setFilter against the fields in the tiles (SchmidtDSE/glen#527)', () => {
    const columns = [
        { name: 'plot.anon.id', type: 'String' },
        { name: 'area.gps', type: 'Number' },
        { name: 'region', type: 'String' },
    ];

    it('refuses a field the tiles do not carry and leaves the layer unchanged', () => {
        const mm = createManager(3, { columns, columnsFromTiles: true });
        const r = mm.setFilter('vec', ['in', ['get', '_cng_fid'], ['literal', [1, 2]]]);
        expect(r.success).toBe(false);
        expect(r.error).toContain('"_cng_fid"');
        expect(r.error).toContain('plot.anon.id, area.gps, region');
        expect(mm._setFilterCalls).toEqual([]);
    });

    it('applies a filter on fields the tiles carry', () => {
        const mm = createManager(2, { columns, columnsFromTiles: true });
        const expr = ['all', ['in', ['get', 'plot.anon.id'], ['literal', ['P02536', 'P05223']]], ['==', ['get', 'region'], 'Ashanti']];
        const r = mm.setFilter('vec', expr);
        expect(r.success).toBe(true);
        expect(mm._setFilterCalls[0].f).toEqual(expr);
    });

    it('does not check fields that came from the STAC record rather than the tiles', () => {
        const mm = createManager(0, { columns, columnsFromTiles: false });
        const r = mm.setFilter('vec', ['==', ['get', 'other'], 1]);
        expect(r.success).toBe(true);
    });

    it('counts the features in the loaded tiles that pass the new filter, not those drawn before it', () => {
        const mm = createManager(2, { columns, columnsFromTiles: true });
        const expr = ['==', ['get', 'region'], 'Ashanti'];
        const r = mm.setFilter('vec', expr);
        expect(r.featuresInView).toBe(2);
        expect(mm._sourceQueries).toEqual([{ id: 'src-vec', opts: { sourceLayer: 'plots', filter: expr } }]);
    });

    it('counts a feature split across tiles once when it has an id', () => {
        const mm = createManager(0);
        mm.map.querySourceFeatures = () => [{ id: 7 }, { id: 7 }, { id: 8 }, {}];
        expect(mm.setFilter('vec', ['has', 'x']).featuresInView).toBe(3);
    });

    it('leaves featuresInView out when the source cannot be read', () => {
        const mm = createManager(0, { sourceId: null });
        const r = mm.setFilter('vec', ['has', 'x']);
        expect(r.success).toBe(true);
        expect(r.featuresInView).toBeUndefined();
    });
});
