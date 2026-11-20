// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { barSpecFromChart, renderBarChart, niceTicks } from '../app/svg-bar-chart.js';

describe('barSpecFromChart', () => {
    it('keeps one series as it is', () => {
        const rows = [{ c: 'a', v: 1 }];
        expect(barSpecFromChart({ x: 'c', y: 'v', y_label: 'Loss' }, rows)).toEqual({
            spec: { category: 'c', stacked: false, format: 'num', label_lines: 2, title: '', series: [{ field: 'v', label: 'Loss' }] },
            rows,
        });
    });

    it('turns long rows with a series column into one row per category, in first-seen order', () => {
        const rows = [
            { year: 2020, land: 'cocoa', ha: 5 }, { year: 2020, land: 'soy', ha: 2 },
            { year: 2019, land: 'soy', ha: 1 },
        ];
        const { spec, rows: out } = barSpecFromChart({ x: 'year', y: 'ha', series: 'land', stacked: true }, rows);
        expect(spec.series).toEqual([{ field: '__s0', label: 'cocoa' }, { field: '__s1', label: 'soy' }]);
        expect(spec.stacked).toBe(true);
        expect(out).toEqual([{ year: 2020, __s0: 5, __s1: 2 }, { year: 2019, __s1: 1 }]);
    });
});

describe('renderBarChart', () => {
    it('draws one row per category with its value, and a legend for several series', () => {
        const box = document.createElement('div');
        renderBarChart(box, { category: 'c', series: [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }], format: 'int' },
            [{ c: 'x', a: 1200, b: null }], { width: 400 });
        expect(box.querySelector('.legend-row').textContent).toBe('AB');
        expect([...box.querySelectorAll('text.val')].map(t => t.textContent)).toEqual(['1,200']);
        expect(box.querySelector('text.nodata').textContent).toBe('—');
    });

    it('says so when there are no rows', () => {
        const box = document.createElement('div');
        renderBarChart(box, { category: 'c', series: [{ field: 'v' }] }, []);
        expect(box.textContent).toBe('No rows to chart.');
    });

    it('rounds the axis to nice ticks', () => {
        expect(niceTicks(9, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
    });
});
