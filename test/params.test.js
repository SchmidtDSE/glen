import { describe, it, expect, vi } from 'vitest';
import {
    ParamBus, resolveParams, paramTokens, paramDefault, rangeValue, matchesWhen,
    expand, tokensIn, normalizeParam, controlKind, paramValueLabel,
} from '../app/params.js';

const land = {
    id: 'land', label: 'Land use', token: 'LAND',
    options: [
        { value: 'cocoa', label: 'Cocoa', tokens: { LAND_PATH: 's3://a/cocoa.parquet', LAND_COL: 'cocoa_frac' } },
        { value: 'soy', label: 'Soy', tokens: { LAND_PATH: 's3://a/soy.parquet', LAND_COL: 'soy_frac' } },
    ],
};
const years = { id: 'years', label: 'Loss years', token: 'YEAR', control: 'range', options: [2001, 2005, 2010, 2015, 2020, 2024], default: [2010, 2024] };
const unit = { id: 'unit', label: 'Unit', token: 'UNIT', options: ['hex', 'admin', 'radius'] };
const radius = { id: 'radius', label: 'Radius', token: 'K', control: 'slider', options: [1, 2, 3, 5], default: 2, when: { unit: 'radius' } };
const all = [land, years, unit, radius];

describe('param values', () => {
    it('defaults to `default`, else the first option, else a range\'s full span', () => {
        expect(paramDefault(land)).toBe('cocoa');
        expect(paramDefault(years)).toEqual([2010, 2024]);
        expect(paramDefault({ ...years, default: undefined })).toEqual([2001, 2024]);
    });

    it('holds a range to its stops, low first', () => {
        expect(rangeValue(years, [2020, 2005])).toEqual([2005, 2020]);
        expect(rangeValue(years, '2005,2020')).toEqual([2005, 2020]);
        expect(rangeValue(years, [2006, 2020])).toBeNull();
    });

    it('keeps only values that are options', () => {
        expect(resolveParams(all, { land: 'soy', unit: 'nope' })).toMatchObject({ land: 'soy', unit: 'hex' });
    });

    it('holds a drill-down at its default where its `when` does not match', () => {
        expect(resolveParams(all, { unit: 'hex', radius: 5 }).radius).toBe(2);
        expect(resolveParams(all, { unit: 'radius', radius: 5 }).radius).toBe(5);
        expect(matchesWhen({ unit: ['admin', 'radius'] }, all, { unit: 'admin' })).toBe(true);
    });
});

describe('paramTokens', () => {
    it('binds a range as _MIN and _MAX, and a chosen option\'s own tokens', () => {
        const t = paramTokens(all, resolveParams(all, { land: 'soy' }));
        expect(t).toMatchObject({ LAND: 'soy', LAND_PATH: 's3://a/soy.parquet', LAND_COL: 'soy_frac', YEAR_MIN: '2010', YEAR_MAX: '2024', UNIT: 'hex', K: '2' });
    });

    it('takes a range\'s two token names from `tokens`', () => {
        const t = paramTokens([{ ...years, tokens: ['Y0', 'Y1'] }], {});
        expect(t).toEqual({ Y0: '2010', Y1: '2024' });
    });
});

describe('templates', () => {
    it('fills tokens and leaves those in -- comments alone', () => {
        const sql = "SELECT * FROM '{{LAND_PATH}}' -- uses {{NOTHING}}\nWHERE y BETWEEN {{YEAR_MIN}} AND {{YEAR_MAX}}";
        expect(expand(sql, { LAND_PATH: 'p', YEAR_MIN: '1', YEAR_MAX: '2' }))
            .toBe("SELECT * FROM 'p' -- uses {{NOTHING}}\nWHERE y BETWEEN 1 AND 2");
        expect([...tokensIn(sql)]).toEqual(['LAND_PATH', 'YEAR_MIN', 'YEAR_MAX']);
    });

    it('does not read -- inside a string as a comment', () => {
        expect(expand("SELECT '--{{A}}'", { A: 'x' })).toBe("SELECT '--x'");
    });

    it('names the bound tokens when one is unbound', () => {
        expect(() => expand('{{B}}', { A: '1' }, 'chart c1')).toThrow(/Unbound token \{\{B\}\} in chart c1; the controls bind \{\{A\}\}/);
    });
});

describe('normalizeParam', () => {
    it('rejects what would be unsafe or unusable', () => {
        expect(() => normalizeParam({ id: 'a b', options: [1] })).toThrow(/id/);
        expect(() => normalizeParam({ id: 'a', options: [] })).toThrow(/options/);
        expect(() => normalizeParam({ id: 'a', options: [{ value: {} }] })).toThrow(/string or number/);
        expect(() => normalizeParam({ id: 'a', token: 'A}}', options: [1] })).toThrow(/token/);
        expect(() => normalizeParam({ id: 'a', control: 'dial', options: [1] })).toThrow(/unknown control/);
        expect(() => normalizeParam({ id: 'a', control: 'range', options: [1] })).toThrow(/two options/);
        expect(() => normalizeParam({ id: '__proto__', options: [1] })).toThrow(/id/);
    });

    it('refuses a token another control binds', () => {
        expect(() => normalizeParam({ id: 'b', token: 'LAND_PATH', options: [1] }, [land])).toThrow(/already binds/);
    });

    it('draws five options or fewer as buttons and more as a menu', () => {
        expect(controlKind(unit)).toBe('segmented');
        expect(controlKind({ options: [1, 2, 3, 4, 5, 6] })).toBe('select');
        expect(controlKind(years)).toBe('range');
    });

    it('labels a range and the full span', () => {
        expect(paramValueLabel(years, [2010, 2024])).toBe('2010 – 2024');
        expect(paramValueLabel({ ...years, all_label: 'All years' }, [2001, 2024])).toBe('All years');
        expect(paramValueLabel(land, 'soy')).toBe('Soy');
    });
});

describe('ParamBus', () => {
    it('tells subscribers which tokens a change touched', () => {
        const bus = new ParamBus(all);
        const seen = vi.fn();
        bus.subscribe(seen);
        expect(bus.set('land', 'soy')).toEqual({ success: true, value: 'soy' });
        expect([...seen.mock.calls[0][0]].sort()).toEqual(['LAND', 'LAND_COL', 'LAND_PATH']);
        bus.set('years', [2001, 2005]);
        expect([...seen.mock.calls[1][0]].sort()).toEqual(['YEAR_MAX', 'YEAR_MIN']);
    });

    it('does not notify when nothing changed', () => {
        const bus = new ParamBus(all);
        const seen = vi.fn();
        bus.subscribe(seen);
        bus.set('land', 'cocoa');
        expect(seen).not.toHaveBeenCalled();
    });

    it('refuses a value that is not an option, and a drill-down that does not apply', () => {
        const bus = new ParamBus(all);
        expect(bus.set('land', 'rice')).toMatchObject({ success: false, error: expect.stringMatching(/Options: cocoa, soy/) });
        expect(bus.set('radius', 3)).toMatchObject({ success: false, error: expect.stringMatching(/does not apply/) });
        bus.set('unit', 'radius');
        expect(bus.set('radius', 3).success).toBe(true);
        expect(bus.set('nope', 1).success).toBe(false);
    });

    it('resets a drill-down when its parent moves away', () => {
        const bus = new ParamBus(all);
        bus.set('unit', 'radius');
        bus.set('radius', 5);
        bus.set('unit', 'hex');
        expect(bus.values.radius).toBe(2);
    });

    it('replaces a control with the same id, keeping a value its options still hold', () => {
        const bus = new ParamBus([unit]);
        bus.set('unit', 'admin');
        bus.define({ ...unit, label: 'Unit of analysis' });
        expect(bus.values.unit).toBe('admin');
        expect(bus.get('unit').label).toBe('Unit of analysis');
        bus.define({ id: 'unit', token: 'UNIT', options: ['hex'] });
        expect(bus.values.unit).toBe('hex');
    });

    it('takes a starting value on define', () => {
        const bus = new ParamBus();
        bus.define({ ...unit, value: 'admin' });
        expect(bus.values.unit).toBe('admin');
    });

    it('removes a control and its tokens', () => {
        const bus = new ParamBus(all);
        const seen = vi.fn();
        bus.subscribe(seen);
        expect(bus.remove('land')).toBe(true);
        expect(bus.tokens().LAND_PATH).toBeUndefined();
        expect(seen.mock.calls[0][0].has('LAND_PATH')).toBe(true);
        expect(bus.remove('land')).toBe(false);
    });

    it('describes the controls for get_map_state', () => {
        const bus = new ParamBus(all);
        const d = bus.describe();
        expect(d[0]).toMatchObject({ id: 'land', control: 'segmented', tokens: ['LAND', 'LAND_PATH', 'LAND_COL'], value: 'cocoa', value_label: 'Cocoa' });
        expect(d[3]).toMatchObject({ id: 'radius', control: 'slider', when: { unit: 'radius' }, applies: false });
    });
});
