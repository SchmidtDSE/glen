// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChartRenderer } from '../app/chart-renderer.js';
import { createRenderChartTool } from '../app/chart-tool.js';
import { ParamBus } from '../app/params.js';

const fakePlot = {
    barY: () => ({}), lineY: () => ({}), dot: () => ({}), rectY: () => ({}), binX: () => ({}), ruleY: () => ({}),
    plot: (o) => { const el = document.createElement('figure'); el.dataset.rows = String(o.marks?.length ?? 0); return el; },
};

const years = { id: 'years', label: 'Years', token: 'YEAR', control: 'range', options: [2001, 2010, 2020] };
const land = { id: 'land', token: 'LAND', options: [{ value: 'cocoa', tokens: { PATH: 'a.parquet' } }, { value: 'soy', tokens: { PATH: 'b.parquet' } }] };
const unit = { id: 'unit', token: 'UNIT', options: ['hex', 'admin'] };

/** A query function answering with rows, recording the SQL it ran. */
function fakeQuery(rows = [{ y: 2001, v: 1 }, { y: 2010, v: 2 }]) {
    const fn = vi.fn(async () => `rows\n${JSON.stringify(rows)}`);
    return fn;
}

const ranSql = (q, i) => q.mock.calls[i][0].match(/FROM \((.*)\n\) _chart_rows/s)[1];

describe('ChartRenderer in place (#426)', () => {
    beforeEach(() => { globalThis.Plot = fakePlot; document.body.replaceChildren(); });
    afterEach(() => { delete globalThis.Plot; });

    it('redraws the chart with the same id instead of opening another', async () => {
        const r = new ChartRenderer();
        await r.render({ chart_type: 'bar', x: 'a', y: 'b', title: 'One' }, [{ a: 1, b: 2 }], { id: 'c1' });
        await r.render({ chart_type: 'bar', x: 'a', y: 'b', title: 'Two' }, [{ a: 1, b: 3 }], { id: 'c1' });
        expect(document.querySelectorAll('.chart-card')).toHaveLength(1);
        expect(document.querySelector('.chart-card-title').textContent).toBe('Two');
        expect(r.describe()).toEqual([{ chart_id: 'c1', title: 'Two', chart_type: 'bar', rows: 1 }]);
        const { id } = await r.render({ chart_type: 'bar', x: 'a', y: 'b' }, [{ a: 1, b: 3 }]);
        expect(id).not.toBe('c1');
    });

    it('puts the Charts section after Settings in the side panel, newest first', async () => {
        document.body.innerHTML = '<div id="menu"><section class="param-controls"></section><div class="layers"></div></div>';
        const r = new ChartRenderer({ mount: document.getElementById('menu') });
        await r.render({ chart_type: 'bar', x: 'a', y: 'b', title: 'One' }, [{ a: 'x', b: 2 }], { id: 'c1' });
        await r.render({ chart_type: 'bar', x: 'a', y: 'b', title: 'Two' }, [{ a: 'x', b: 2 }], { id: 'c2' });
        const kids = [...document.getElementById('menu').children].map(e => e.className);
        expect(kids).toEqual(['param-controls', 'chart-cards menu-section', 'layers']);
        expect([...document.querySelectorAll('.chart-card-title')].map(t => t.textContent)).toEqual(['Two', 'One']);
        r.remove('c1');
        r.remove('c2');
        expect(document.querySelector('.chart-cards').hidden).toBe(true);
    });

    it('draws bars as SVG rows in row order, without Plot, and exports them', async () => {
        delete globalThis.Plot;
        const r = new ChartRenderer();
        const rows = [{ c: 'Zebra', v: 1 }, { c: 'Apple', v: 3 }];
        await r.render({ chart_type: 'bar', x: 'c', y: 'v', y_label: 'Count' }, rows, { id: 'b' });
        const labels = [...document.querySelectorAll('.chart-card-body svg text[text-anchor="end"]')].map(t => t.textContent);
        expect(labels).toEqual(['Zebra', 'Apple']);
        expect(document.querySelector('.chart-card .sub').textContent).toBe('Count');
        expect(r.exportFigure('b')).toMatch(/^<svg[^>]*width="780"/);
    });

    it('shows loading and error states, and hides a panel', async () => {
        const r = new ChartRenderer();
        await r.render({ chart_type: 'bar', x: 'a', y: 'b' }, [{ a: 1, b: 2 }], { id: 'c1' });
        const panel = document.querySelector('.chart-card');
        r.setStatus('c1', { loading: true });
        expect(panel.classList.contains('chart-card--loading')).toBe(true);
        expect(panel.getAttribute('aria-busy')).toBe('true');
        r.setStatus('c1', { error: 'boom' });
        expect(panel.classList.contains('chart-card--loading')).toBe(false);
        expect(panel.querySelector('.chart-card-status').textContent).toBe('boom');
        r.setHidden('c1', true);
        expect(panel.hidden).toBe(true);
        expect(r.describe()[0].hidden).toBe(true);
    });

    it('tells listeners when a panel closes', async () => {
        const r = new ChartRenderer();
        const seen = vi.fn();
        r.onRemove(seen);
        await r.render({ chart_type: 'bar', x: 'a', y: 'b' }, [{ a: 1, b: 2 }], { id: 'c1' });
        document.querySelector('.chart-card-close').click();
        expect(seen).toHaveBeenCalledWith('c1');
        expect(r.has('c1')).toBe(false);
    });

    it('folds a card to its title and opens it again', async () => {
        const r = new ChartRenderer();
        await r.render({ chart_type: 'bar', x: 'a', y: 'b' }, [{ a: 1, b: 2 }], { id: 'c1' });
        const card = document.querySelector('.chart-card');
        const fold = card.querySelector('.chart-card-fold');
        fold.click();
        expect(card.classList.contains('chart-card--folded')).toBe(true);
        expect(fold.getAttribute('aria-expanded')).toBe('false');
        fold.click();
        expect(card.classList.contains('chart-card--folded')).toBe(false);
        expect(r.has('c1')).toBe(true);
    });

    it('gives a card no remove button when asked, so a configured chart cannot be lost', async () => {
        const r = new ChartRenderer();
        await r.render({ chart_type: 'bar', x: 'a', y: 'b' }, [{ a: 1, b: 2 }], { id: 'c1', removable: false });
        expect(document.querySelector('.chart-card-close')).toBe(null);
        expect(document.querySelector('.chart-card-fold')).not.toBe(null);
    });
});

describe('render_chart with controls (#426)', () => {
    let bus, renderer, query, tool;
    beforeEach(() => {
        vi.useFakeTimers();
        globalThis.Plot = fakePlot;
        document.body.replaceChildren();
        bus = new ParamBus([years, land, unit]);
        renderer = new ChartRenderer();
        query = fakeQuery();
        tool = createRenderChartTool(renderer, query, { params: () => bus, debounceMs: 50 });
    });
    afterEach(() => { vi.useRealTimers(); delete globalThis.Plot; });

    const sql = "SELECT y, v FROM '{{PATH}}' WHERE y BETWEEN {{YEAR_MIN}} AND {{YEAR_MAX}}";

    it('fills the tokens and reports the chart as live', async () => {
        const res = JSON.parse(await tool.execute({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' }));
        expect(res).toMatchObject({ success: true, chart_id: 'loss', live: true, tokens: ['PATH', 'YEAR_MIN', 'YEAR_MAX'] });
        expect(ranSql(query, 0)).toBe("SELECT y, v FROM 'a.parquet' WHERE y BETWEEN 2001 AND 2020");
    });

    it('re-runs once the controls settle, in the same panel', async () => {
        await tool.execute({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' });
        bus.set('years', [2001, 2010]);
        bus.set('land', 'soy');
        expect(document.querySelector('.chart-card').classList.contains('chart-card--loading')).toBe(true);
        await vi.advanceTimersByTimeAsync(60);
        expect(query).toHaveBeenCalledTimes(2);
        expect(ranSql(query, 1)).toBe("SELECT y, v FROM 'b.parquet' WHERE y BETWEEN 2001 AND 2010");
        expect(document.querySelectorAll('.chart-card')).toHaveLength(1);
        expect(document.querySelector('.chart-card').classList.contains('chart-card--loading')).toBe(false);
    });

    it('does not re-run for a control its SQL does not use', async () => {
        await tool.execute({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' });
        bus.set('unit', 'admin');
        await vi.advanceTimersByTimeAsync(60);
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('drops a run that a newer one overtook', async () => {
        let release;
        await tool.execute({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' });
        query.mockImplementationOnce(() => new Promise((res) => { release = () => res('[{"y":1,"v":99}]'); }));
        bus.set('land', 'soy');
        await vi.advanceTimersByTimeAsync(60);           // slow run starts
        bus.set('land', 'cocoa');
        await vi.advanceTimersByTimeAsync(60);           // newer run finishes
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(renderer._charts.get('loss').rows).toEqual([{ y: 2001, v: 1 }, { y: 2010, v: 2 }]);
    });

    it('shows a failed re-run on the panel and keeps the chart', async () => {
        await tool.execute({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' });
        query.mockRejectedValueOnce(new Error('timeout'));
        bus.set('land', 'soy');
        await vi.advanceTimersByTimeAsync(60);
        expect(document.querySelector('.chart-card-status').textContent).toMatch(/timeout/);
        expect(renderer.has('loss')).toBe(true);
    });

    it('stops re-running a chart the reader closed', async () => {
        await tool.execute({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' });
        renderer.remove('loss');
        bus.set('land', 'soy');
        await vi.advanceTimersByTimeAsync(60);
        expect(query).toHaveBeenCalledTimes(1);
        expect(tool.live.has('loss')).toBe(false);
    });

    it('stops re-running a chart redrawn without tokens', async () => {
        await tool.execute({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' });
        const res = JSON.parse(await tool.execute({ chart_type: 'line', x: 'y', y: 'v', sql: 'SELECT 1 AS y, 2 AS v', chart_id: 'loss' }));
        expect(res.live).toBeUndefined();
        expect(tool.live.has('loss')).toBe(false);
    });

    it('names the bound tokens for an unbound one', async () => {
        const res = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'y', y: 'v', sql: 'SELECT {{NOPE}}' }));
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/Unbound token \{\{NOPE\}\}.*\{\{YEAR_MIN\}\}/);
    });

    it('hides a chart whose `when` does not match, and re-runs it when shown', async () => {
        await tool.draw({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' }, { when: { unit: 'hex' } });
        bus.set('unit', 'admin');
        expect(document.querySelector('.chart-card').hidden).toBe(true);
        bus.set('land', 'soy');                          // changes while hidden: no run yet
        await vi.advanceTimersByTimeAsync(60);
        expect(query).toHaveBeenCalledTimes(1);
        bus.set('unit', 'hex');
        await vi.advanceTimersByTimeAsync(60);
        expect(document.querySelector('.chart-card').hidden).toBe(false);
        expect(query).toHaveBeenCalledTimes(2);
    });

    it('opens a configured chart whose query failed, and tries again when a control changes', async () => {
        query.mockRejectedValueOnce(new Error('HTTP 401'));
        const res = await tool.drawConfigured({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' });
        expect(res.success).toBe(false);
        expect(renderer.has('loss')).toBe(true);
        expect(document.querySelector('.chart-card-close')).toBe(null);
        expect(document.querySelector('.chart-card-status').textContent).toMatch(/401/);
        bus.set('land', 'soy');
        await vi.advanceTimersByTimeAsync(60);
        expect(renderer._charts.get('loss').rows).toHaveLength(2);
        expect(document.querySelector('.chart-card-status').textContent).toBe('');
    });

    it('does not run a configured chart its `when` hides until it is shown', async () => {
        const res = await tool.drawConfigured({ chart_type: 'line', x: 'y', y: 'v', sql, chart_id: 'loss' }, { when: { unit: 'admin' } });
        expect(res).toMatchObject({ success: true, deferred: true });
        expect(query).not.toHaveBeenCalled();
        expect(document.querySelector('.chart-card').hidden).toBe(true);
        bus.set('unit', 'admin');
        await vi.advanceTimersByTimeAsync(60);
        expect(query).toHaveBeenCalledTimes(1);
        expect(renderer._charts.get('loss').rows).toHaveLength(2);
    });

    it('refuses a bad chart_id', async () => {
        const res = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'a', y: 'b', data: [{ a: 1, b: 2 }], chart_id: 'a b' }));
        expect(res.success).toBe(false);
    });
});

describe('render_chart without controls', () => {
    it('says the tokens have nothing to set them, and does not mention controls', async () => {
        const tool = createRenderChartTool(new ChartRenderer({ doc: null }), fakeQuery());
        const res = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'y', y: 'v', sql: 'SELECT {{A}}' }));
        expect(res.error).toMatch(/no controls/);
        expect(tool.description).not.toMatch(/TOKEN/);
    });
});

describe('labels with tokens', () => {
    it('fills a label from the controls and redraws it when they change', async () => {
        vi.useFakeTimers();
        globalThis.Plot = fakePlot;
        document.body.replaceChildren();
        const bus = new ParamBus([{ id: 'unit', token: 'U', options: [{ value: 'km2', tokens: { UNIT_LABEL: 'km²' } }, { value: 'ha', tokens: { UNIT_LABEL: 'ha' } }] }]);
        const renderer = new ChartRenderer();
        const query = fakeQuery();
        const tool = createRenderChartTool(renderer, query, { params: () => bus, debounceMs: 10 });
        const res = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'y', y: 'v', data: [{ y: 1, v: 2 }], title: 'Loss ({{UNIT_LABEL}}) {{OTHER}}', chart_id: 'c' }));
        expect(res.live).toBe(true);
        expect(document.querySelector('.chart-card-title').textContent).toBe('Loss (km²) {{OTHER}}');
        bus.set('unit', 'ha');
        await vi.advanceTimersByTimeAsync(20);
        expect(document.querySelector('.chart-card-title').textContent).toBe('Loss (ha) {{OTHER}}');
        expect(query).not.toHaveBeenCalled();
        vi.useRealTimers();
        delete globalThis.Plot;
    });
});

describe('the configured charts (#508)', () => {
    beforeEach(() => { globalThis.Plot = fakePlot; document.body.replaceChildren(); });
    afterEach(() => { delete globalThis.Plot; });

    it('opens every card in config order, and a stuck query holds up no other chart', async () => {
        const bus = new ParamBus([{ id: 'module', token: 'MODULE', options: ['loss', 'attribution'] }]);
        const renderer = new ChartRenderer();
        const query = vi.fn((sql) => (sql.includes("'stuck'") ? new Promise(() => {}) : Promise.resolve('rows\n[{"y":1,"v":2}]')));
        const tool = createRenderChartTool(renderer, query, { params: () => bus, debounceMs: 10 });
        const chart = (id, s, when) => ({ chart_id: id, chart_type: 'bar', x: 'y', y: 'v', sql: s, when });
        const done = tool.drawConfiguredAll([
            chart('first', "SELECT 'stuck' AS y, 1 AS v", { module: 'loss' }),
            chart('second', 'SELECT 1 AS y, 2 AS v;\n', { module: 'loss' }),
            chart('third', "SELECT '{{MODULE}}' AS y, 3 AS v", { module: 'attribution' }),
        ]);
        await vi.waitFor(() => expect(renderer._charts.get('second')?.rows).toHaveLength(1));
        const ids = [...document.querySelectorAll('.chart-card')].map(c => c.dataset.chartId);
        expect(ids).toEqual(['first', 'second', 'third']);
        expect(document.querySelector('[data-chart-id="first"]').classList.contains('chart-card--loading')).toBe(true);
        expect(document.querySelector('[data-chart-id="third"]').hidden).toBe(true);
        // the trailing `;` is gone before the query is wrapped
        expect(query.mock.calls.map(c => c[0]).find(q => q.includes('2 AS v'))).toMatch(/2 AS v\n\) _chart_rows$/);
        expect(done).toBeInstanceOf(Promise);
    });
});

describe('redrawing a configured chart by id (#508)', () => {
    beforeEach(() => { globalThis.Plot = fakePlot; document.body.replaceChildren(); });
    afterEach(() => { delete globalThis.Plot; });

    it('keeps its `when`, so it stays hidden where the config hides it', async () => {
        const bus = new ParamBus([{ id: 'module', token: 'MODULE', options: ['loss', 'attribution'] }]);
        const renderer = new ChartRenderer();
        const tool = createRenderChartTool(renderer, fakeQuery([{ y: 1, v: 2 }]), { params: () => bus, debounceMs: 10 });
        const args = { chart_id: 'loss', chart_type: 'bar', x: 'y', y: 'v', sql: 'SELECT 1 AS y, 2 AS v' };
        await tool.drawConfigured(args, { when: { module: 'loss' } });
        bus.set('module', 'attribution');
        const card = () => document.querySelector('[data-chart-id="loss"]');
        expect(card().hidden).toBe(true);
        const res = JSON.parse(await tool.execute({ ...args, title: 'Again' }));
        expect(res).toMatchObject({ success: true, hidden: true });
        expect(card().hidden).toBe(true);
        bus.set('module', 'loss');
        expect(card().hidden).toBe(false);
    });
});

describe('a chart hidden while its re-run waits (#508)', () => {
    beforeEach(() => { vi.useFakeTimers(); globalThis.Plot = fakePlot; document.body.replaceChildren(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.Plot; });

    it('sends no query, and runs when it is shown again', async () => {
        const bus = new ParamBus([{ id: 'module', token: 'MODULE', options: ['loss', 'attribution'] }, { id: 'area', token: 'AREA', options: ['a', 'b'] }]);
        const renderer = new ChartRenderer();
        const query = fakeQuery([{ y: 1, v: 2 }]);
        const tool = createRenderChartTool(renderer, query, { params: () => bus, debounceMs: 50 });
        await tool.drawConfigured({ chart_id: 'loss', chart_type: 'bar', x: 'y', y: 'v', sql: "SELECT '{{AREA}}' AS y, 2 AS v" }, { when: { module: 'loss' } });
        expect(query).toHaveBeenCalledTimes(1);
        bus.set('area', 'b');
        await vi.advanceTimersByTimeAsync(20);
        bus.set('module', 'attribution');
        await vi.advanceTimersByTimeAsync(200);
        expect(query).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-chart-id="loss"]').classList.contains('chart-card--loading')).toBe(false);
        bus.set('module', 'loss');
        await vi.advanceTimersByTimeAsync(200);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[1][0]).toContain("'b' AS y");
    });
});

describe('a configured chart whose query is still running (#508)', () => {
    beforeEach(() => { globalThis.Plot = fakePlot; document.body.replaceChildren(); });
    afterEach(() => { delete globalThis.Plot; });

    it('hides when its `when` stops holding, and draws its rows when the query returns', async () => {
        const bus = new ParamBus([{ id: 'module', token: 'MODULE', options: ['loss', 'impacts'] }]);
        const renderer = new ChartRenderer();
        let finish;
        const query = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
        const tool = createRenderChartTool(renderer, query, { params: () => bus, debounceMs: 10 });
        const done = tool.drawConfigured({ chart_id: 'ranked', chart_type: 'bar', x: 'y', y: 'v', sql: 'SELECT 1 AS y, 2 AS v' }, { when: { module: 'loss' } });
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
        const card = () => document.querySelector('[data-chart-id="ranked"]');
        expect(card().hidden).toBe(false);
        bus.set('module', 'impacts');
        expect(card().hidden).toBe(true);
        finish(`rows\n${JSON.stringify([{ y: 1, v: 2 }])}`);
        const res = await done;
        expect(res).toMatchObject({ success: true, chart_id: 'ranked' });
        expect(card().hidden).toBe(true);
        expect(card().getAttribute('aria-busy')).toBe('false');
        bus.set('module', 'loss');
        expect(card().hidden).toBe(false);
        expect(query).toHaveBeenCalledTimes(1);
    });
});
