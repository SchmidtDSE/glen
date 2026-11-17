// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isNumericPaint, numericStyleValue } from '../app/style-numbers.js';
import { MapManager } from '../app/map-manager.js';

describe('numeric strings in paint expressions (SchmidtDSE/glen#499)', () => {
    it('reads interpolate stops and outputs as numbers (datacenters circle size)', () => {
        const sent = ['interpolate', ['linear'], ['get', 'current_power_mw'],
            '0', '2', '10', '3.6', '50', '5.5', '1037', '18.1'];
        const { value, converted } = numericStyleValue('circle-radius', sent);
        expect(value).toEqual(['interpolate', ['linear'], ['get', 'current_power_mw'],
            0, 2, 10, 3.6, 50, 5.5, 1037, 18.1]);
        expect(converted).toHaveLength(8);
    });

    it('keeps colour outputs and reads the stops of a colour ramp', () => {
        const { value } = numericStyleValue('fill-color',
            ['interpolate', ['exponential', '1.5'], ['get', 'acres'], '0', '#eee', '1000', '#333']);
        expect(value).toEqual(['interpolate', ['exponential', 1.5], ['get', 'acres'], 0, '#eee', 1000, '#333']);
    });

    it('reads step stops and arithmetic arguments at any depth', () => {
        expect(numericStyleValue('circle-radius', ['step', ['get', 'n'], '2', '10', '4']).value)
            .toEqual(['step', ['get', 'n'], 2, 10, 4]);
        expect(numericStyleValue('circle-radius', ['+', '2', ['*', 0.5, ['sqrt', ['get', 'mw']]]]).value)
            .toEqual(['+', 2, ['*', 0.5, ['sqrt', ['get', 'mw']]]]);
    });

    it('leaves field names, match labels, literals and non-numeric strings alone', () => {
        const value = ['interpolate', ['linear'], ['get', '2020'], 0, 1, 10, 5];
        expect(numericStyleValue('circle-radius', value)).toEqual({ value, converted: [] });
        const match = ['match', ['get', 'GAP_Sts'], '1', '#26633A', '2', '#3E9C47', '#888888'];
        expect(numericStyleValue('fill-color', match).value).toEqual(match);
        expect(numericStyleValue('fill-color', ['literal', ['1', '2']]).value).toEqual(['literal', ['1', '2']]);
        expect(numericStyleValue('fill-color', '#ff0000').value).toBe('#ff0000');
        expect(numericStyleValue('circle-radius', ['+', '', 'x']).value).toEqual(['+', '', 'x']);
    });

    it('reads a plain numeric string only for a numeric property', () => {
        expect(numericStyleValue('fill-opacity', '0.8').value).toBe(0.8);
        expect(numericStyleValue('line-width', '2').value).toBe(2);
        expect(isNumericPaint('circle-stroke-width')).toBe(true);
        expect(isNumericPaint('fill-color')).toBe(false);
        expect(numericStyleValue('fill-pattern', '1').value).toBe('1');
    });

    it('setStyle applies the numbers and tells the agent what it changed', () => {
        const painted = {};
        const mm = Object.create(MapManager.prototype);
        mm.layers = new Map([['dc', { layerId: 'dc', mapLayerId: 'layer-dc', displayName: 'Data centers', type: 'vector' }]]);
        mm.map = {
            setPaintProperty: (id, prop, v) => { painted[prop] = v; },
            getLayer: () => ({ type: 'circle' }),
        };
        mm._mapErrorsDuring = (fn) => { fn(); return []; };
        mm._effectivePaint = () => ({});
        mm._promoteLegendType = () => {};
        mm._refreshLegend = () => {};

        const result = mm.setStyle('dc', {
            'circle-radius': ['interpolate', ['linear'], ['get', 'mw'], '0', '2', '100', '9'],
            'circle-color': '#e45',
        });
        expect(result.success).toBe(true);
        expect(painted['circle-radius']).toEqual(['interpolate', ['linear'], ['get', 'mw'], 0, 2, 100, 9]);
        expect(painted['circle-color']).toBe('#e45');
        expect(result.adjusted).toHaveLength(1);
        expect(result.adjusted[0]).toMatch(/In circle-radius, "0", "2", "100" and 1 more were read as numbers/);
    });
});
