import { describe, it, expect } from 'vitest';
import { coerceFilter, fieldKind, filterFields } from '../app/filter-types.js';
import { MapManager } from '../app/map-manager.js';

const kinds = { Asthma_Pctl: 'number', YEAR_: 'string', COUNTY: 'string', GAP: 'number' };
const kindOf = (f) => kinds[f] || null;

describe('matching filter literals to the tile types', () => {
    it('reads the type names PMTiles and table:columns use', () => {
        expect(fieldKind('Number')).toBe('number');
        expect(fieldKind('int64')).toBe('number');
        expect(fieldKind('double')).toBe('number');
        expect(fieldKind('String')).toBe('string');
        expect(fieldKind('utf8')).toBe('string');
        expect(fieldKind('Boolean')).toBeNull();
        expect(fieldKind(undefined)).toBeNull();
    });

    it('compares a numeric field with a number, not a numeric string (calenviroscreen)', () => {
        const { filter, notes } = coerceFilter(['>=', ['get', 'Asthma_Pctl'], '90'], kindOf);
        expect(filter).toEqual(['>=', ['get', 'Asthma_Pctl'], 90]);
        expect(notes[0]).toMatch(/Asthma_Pctl is a number/);
        // Either side.
        expect(coerceFilter(['<', '90', ['get', 'Asthma_Pctl']], kindOf).filter).toEqual(['<', 90, ['get', 'Asthma_Pctl']]);
    });

    it('orders a string field numerically, and matches it as a string (ca-ccca5 fire years)', () => {
        const { filter, notes } = coerceFilter(['all', ['>=', ['get', 'YEAR_'], 2000], ['==', ['get', 'COUNTY'], 6]], kindOf);
        expect(filter).toEqual(['all', ['>=', ['to-number', ['get', 'YEAR_']], 2000], ['==', ['get', 'COUNTY'], '6']]);
        expect(notes).toHaveLength(2);
    });

    it('matches match labels and in-lists to the field type', () => {
        expect(coerceFilter(['match', ['get', 'GAP'], ['1', '2'], true, false], kindOf).filter)
            .toEqual(['match', ['get', 'GAP'], [1, 2], true, false]);
        expect(coerceFilter(['match', ['get', 'YEAR_'], 2020, true, 2021, true, false], kindOf).filter)
            .toEqual(['match', ['get', 'YEAR_'], '2020', true, '2021', true, false]);
        expect(coerceFilter(['in', ['get', 'GAP'], ['literal', ['1', '2']]], kindOf).filter)
            .toEqual(['in', ['get', 'GAP'], ['literal', [1, 2]]]);
    });

    it('leaves filters alone that already match, or whose fields it does not know', () => {
        for (const f of [
            ['>=', ['get', 'Asthma_Pctl'], 90],
            ['==', ['get', 'COUNTY'], 'Alameda'],
            ['>=', ['get', 'unknown'], '90'],
            ['>=', ['to-number', ['get', 'YEAR_']], 2000],
            ['==', ['get', 'Asthma_Pctl'], 'n/a'],
        ]) {
            const r = coerceFilter(f, kindOf);
            expect(r.filter).toEqual(f);
            expect(r.notes).toEqual([]);
        }
    });
});

describe('set_filter with the tile types', () => {
    it('applies the matched filter and tells the agent what it changed', () => {
        const calls = [];
        const mm = Object.create(MapManager.prototype);
        mm.map = { setFilter: (id, f) => calls.push(f), queryRenderedFeatures: () => [{}] };
        mm.layers = new Map([['tracts', { type: 'vector', mapLayerId: 'layer-tracts', displayName: 'Tracts', columns: [{ name: 'Asthma_Pctl', type: 'Number' }] }]]);
        mm._mapErrorsDuring = (fn) => { fn(); return []; };
        const r = mm.setFilter('tracts', ['>=', ['get', 'Asthma_Pctl'], '90']);
        expect(calls[0]).toEqual(['>=', ['get', 'Asthma_Pctl'], 90]);
        expect(r.filter).toEqual(['>=', ['get', 'Asthma_Pctl'], 90]);
        expect(r.adjusted[0]).toMatch(/number/);
        // Nothing to change, nothing reported.
        expect(mm.setFilter('tracts', ['>=', ['get', 'Asthma_Pctl'], 90])).not.toHaveProperty('adjusted');
    });
});

describe('filterFields', () => {
    it('lists each property a filter reads, once, skipping literals', () => {
        expect(filterFields(['all',
            ['in', ['get', 'a'], ['literal', [['get', 'not-a-read']]]],
            ['==', ['get', 'b'], 1],
            ['>', ['to-number', ['get', 'a']], 2],
        ])).toEqual(['a', 'b']);
        expect(filterFields(null)).toEqual([]);
    });
});
