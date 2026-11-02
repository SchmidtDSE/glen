import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildControlAction, ReactiveControl } from '../app/reactive-control.js';

describe('buildControlAction', () => {
    it('cumulative filter binds field <= value', () => {
        const action = buildControlAction({ bind: 'filter', mode: 'cumulative', field: 'YEAR_' }, 1990);
        expect(action).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
    });

    it('step filter binds field == value', () => {
        const action = buildControlAction({ bind: 'filter', mode: 'step', field: 'YEAR_' }, 1990);
        expect(action).toEqual({ kind: 'filter', expr: ['==', ['get', 'YEAR_'], 1990] });
    });

    it('defaults to cumulative when mode is omitted', () => {
        const action = buildControlAction({ bind: 'filter', field: 'depth' }, 50);
        expect(action).toEqual({ kind: 'filter', expr: ['<=', ['get', 'depth'], 50] });
    });

    it('returns null when the filter bind has no field', () => {
        expect(buildControlAction({ bind: 'filter' }, 5)).toBeNull();
    });

    it('returns null for unimplemented bind kinds (style/query reserved)', () => {
        expect(buildControlAction({ bind: 'style', field: 'x' }, 5)).toBeNull();
        expect(buildControlAction({ bind: 'query', field: 'x' }, 5)).toBeNull();
    });
});

describe('ReactiveControl (no-DOM core)', () => {
    // doc:null skips panel construction so the value→action pipeline can be
    // tested without faking the DOM. The browser-bound _build / autoplay paths
    // are verified manually in a deployed app (per the module-coverage policy).
    const makeControl = (config) => {
        const actions = [];
        const ctrl = new ReactiveControl({
            layerId: 'fires',
            displayName: 'Fires',
            config,
            apply: (a) => actions.push(a),
            doc: null,
        });
        return { ctrl, actions };
    };

    it('applies an initial action on construction at the default value', () => {
        const { actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024, mode: 'cumulative' });
        // cumulative default = max → reveals everything up front
        expect(actions).toEqual([{ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 2024] }]);
    });

    it('step mode defaults the initial value to min', () => {
        const { actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024, mode: 'step' });
        expect(actions[0]).toEqual({ kind: 'filter', expr: ['==', ['get', 'YEAR_'], 1835] });
    });

    it('honours an explicit default value', () => {
        const { actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024, default: 1990 });
        expect(actions[0]).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
    });

    it('setValue recomputes and re-applies the action', () => {
        const { ctrl, actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024 });
        ctrl.setValue(2000);
        expect(actions.at(-1)).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 2000] });
    });

    it('setValue clamps to [min, max]', () => {
        const { ctrl, actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024 });
        ctrl.setValue(5000);
        expect(actions.at(-1)).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 2024] });
        ctrl.setValue(0);
        expect(actions.at(-1)).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1835] });
    });

    it('throws when min/max are missing', () => {
        expect(() => makeControl({ field: 'YEAR_' })).toThrow(/min and max/);
    });

    it('destroy is safe with no DOM panel', () => {
        const { ctrl } = makeControl({ field: 'YEAR_', min: 1835, max: 2024 });
        expect(() => ctrl.destroy()).not.toThrow();
        expect(ctrl.destroyed).toBe(true);
    });
});

describe('step-slider autoplay stays on the step grid (#360)', () => {
    let raf;
    beforeEach(() => {
        raf = [];
        globalThis.requestAnimationFrame = (cb) => { raf.push(cb); return raf.length; };
        globalThis.cancelAnimationFrame = () => {};
    });
    afterEach(() => {
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;
    });

    const make = (config) => {
        const actions = [];
        const ctrl = new ReactiveControl({ layerId: 'h', config: { animate: true, ...config }, apply: (a) => actions.push(a), doc: null });
        return { ctrl, actions };
    };
    // Run frames `ms` apart and return every value the binding received.
    const run = (ctrl, actions, frames, ms) => {
        const from = actions.length;
        ctrl.play();
        for (let i = 0, t = 0; i < frames && raf.length; i++, t += ms) raf.shift()(t);
        return actions.slice(from).map(a => a.expr[2]);
    };

    it('setValue snaps a step slider to the nearest step', () => {
        const { ctrl, actions } = make({ field: 'SEASON', min: 1851, max: 2026, step: 1, mode: 'step' });
        ctrl.setValue(2024.37);
        expect(actions.at(-1).expr).toEqual(['==', ['get', 'SEASON'], 2024]);
    });

    it('autoplay binds only whole steps and advances through them', () => {
        const { ctrl, actions } = make({ field: 'SEASON', min: 1851, max: 2026, step: 1, mode: 'step', duration_seconds: 1 });
        // 1 s over a 175-year range, frames 1 ms apart: ~0.175 years per frame.
        const values = run(ctrl, actions, 60, 1);
        expect(values.length).toBeGreaterThan(3);
        expect(values.every(Number.isInteger)).toBe(true);
        expect(Math.max(...values)).toBeGreaterThan(1851);
        // Each value is bound once, not re-applied every frame.
        expect(new Set(values).size).toBe(values.length);
    });

    it('fractional steps snap cleanly', () => {
        const { ctrl, actions } = make({ field: 'x', min: 0, max: 1, step: 0.1, mode: 'step' });
        ctrl.setValue(0.3000001);
        expect(actions.at(-1).expr[2]).toBe(0.3);
    });

    it('cumulative autoplay still advances smoothly', () => {
        const { ctrl, actions } = make({ field: 'SEASON', min: 1851, max: 2026, mode: 'cumulative', default: 1851, duration_seconds: 1 });
        const values = run(ctrl, actions, 20, 1);
        expect(values.some(v => !Number.isInteger(v))).toBe(true);
    });
});
