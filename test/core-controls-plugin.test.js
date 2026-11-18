// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import plugin, { controlsPrompt } from '../core/plugins/controls.js';
import chartsPlugin, { hasControlsPlugin } from '../core/plugins/charts.js';
import { ParamBus } from '../app/params.js';
import { ControlPanel } from '../app/control-panel.js';

function registry() {
    const tools = new Map();
    tools.set('create_slider', { name: 'create_slider' });
    tools.set('get_map_state', { name: 'get_map_state', description: 'Get the map state.' });
    return {
        tools,
        registerLocal: vi.fn((t) => tools.set(t.name, { ...t, source: 'local' })),
    };
}

const years = { id: 'years', label: 'Loss years', token: 'YEAR', control: 'range', options: [2001, 2010, 2020] };
const unit = { id: 'unit', label: 'Unit', token: 'UNIT', options: ['hex', 'radius'] };
const radius = { id: 'radius', label: 'Radius', token: 'K', control: 'slider', options: [1, 2, 3], when: { unit: 'radius' } };

async function setup(controls = [years, unit, radius]) {
    document.body.innerHTML = '<div id="menu"><div class="menu-header"></div></div>';
    const sections = new Map();
    const map = {
        createSlider: vi.fn(async (a) => ({ success: true, layer: a.layer_id })),
        removeSlider: vi.fn((id) => ({ success: id === 'fires' })),
        addStateSection: (name, fn) => sections.set(name, fn),
    };
    const prompts = [];
    const ctx = { tools: registry(), map, layout: { menuMountId: 'menu' }, addPrompt: (t) => t && prompts.push(t) };
    await plugin.setup(ctx, { controls });
    const call = async (name, args) => JSON.parse(await ctx.tools.tools.get(name).execute(args));
    return { ctx, map, sections, prompts, call };
}

describe('glen core controls plugin (#426)', () => {
    it('puts the configured controls on the bus and in the layer panel', async () => {
        const { ctx } = await setup();
        expect(ctx.params.tokens()).toMatchObject({ YEAR_MIN: '2001', YEAR_MAX: '2020', UNIT: 'hex', K: '1' });
        const section = document.querySelector('#menu > .param-controls');
        expect(section).not.toBeNull();
        expect(document.querySelector('#menu').firstElementChild).toBe(section);
        expect([...section.querySelectorAll('.param-control')].map(r => r.dataset.paramId)).toEqual(['years', 'unit', 'radius']);
        expect(section.querySelector('[data-param-id="radius"]').hidden).toBe(true);
    });

    it('replaces create_slider with create_control and remove_widget', async () => {
        const { ctx } = await setup();
        expect(ctx.tools.tools.has('create_slider')).toBe(false);
        expect(ctx.tools.tools.has('create_control')).toBe(true);
        expect(ctx.tools.tools.has('remove_widget')).toBe(true);
    });

    it('names the controls and their tokens in the prompt, without their values', async () => {
        const { prompts } = await setup();
        expect(prompts[0]).toContain('- Loss years (`years`): {{YEAR_MIN}}, {{YEAR_MAX}}');
        expect(prompts[0]).not.toMatch(/2020/);
        expect(controlsPrompt(new ParamBus())).toBe('');
    });

    it('lists the controls in get_map_state, and says so in its description', async () => {
        const { ctx, sections } = await setup();
        expect(sections.get('controls')()[0]).toMatchObject({ id: 'years', value: [2001, 2020], value_label: '2001 – 2020' });
        expect(ctx.tools.tools.get('get_map_state').description).toMatch(/controls/);
    });

    it('makes a filter slider from a configured filter control', async () => {
        const { map } = await setup([{ bind: 'filter', layer_id: 'fires', field: 'YEAR_', min: 1950, max: 2024 }]);
        expect(map.createSlider).toHaveBeenCalledWith(expect.objectContaining({ layer_id: 'fires', field: 'YEAR_' }));
    });

    it('skips a bad configured control and keeps the rest', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { ctx } = await setup([{ id: 'bad', options: [] }, unit]);
        expect(ctx.params.params.map(p => p.id)).toEqual(['unit']);
        warn.mockRestore();
    });
});

describe('create_control', () => {
    it('adds a param control the panel draws', async () => {
        const { ctx, call } = await setup([]);
        const res = await call('create_control', { id: 'land', label: 'Land use', options: [{ value: 'cocoa', label: 'Cocoa', tokens: { PATH: 'a' } }, { value: 'soy', label: 'Soy', tokens: { PATH: 'b' } }] });
        expect(res).toMatchObject({ success: true, created: true, control: { id: 'land', tokens: ['LAND', 'PATH'], value: 'cocoa' } });
        expect(ctx.params.tokens().PATH).toBe('a');
        const buttons = document.querySelectorAll('[data-param-id="land"] button');
        expect([...buttons].map(b => b.textContent)).toEqual(['Cocoa', 'Soy']);
        expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    });

    it('sets a value by id alone, and refuses one that is not an option', async () => {
        const { ctx, call } = await setup();
        expect(await call('create_control', { id: 'years', value: '2010,2020' })).toMatchObject({ success: true, updated: true, control: { value: [2010, 2020] } });
        expect(ctx.params.tokens().YEAR_MIN).toBe('2010');
        const bad = await call('create_control', { id: 'years', value: '2005,2020' });
        expect(bad.success).toBe(false);
        expect(bad.error).toMatch(/Options: 2001, 2010, 2020/);
    });

    it('changes a control\'s fields, keeping the rest', async () => {
        const { ctx, call } = await setup();
        await call('create_control', { id: 'unit', label: 'Unit of analysis' });
        expect(ctx.params.get('unit')).toMatchObject({ label: 'Unit of analysis', token: 'UNIT', options: ['hex', 'radius'] });
        expect(document.querySelector('[data-param-id="unit"] .param-control-label').textContent).toBe('Unit of analysis');
    });

    it('reports a bad definition', async () => {
        const { call } = await setup();
        expect(await call('create_control', { id: 'x', token: 'UNIT', options: [1] })).toMatchObject({ success: false, error: expect.stringMatching(/already binds/) });
        expect(await call('create_control', { bind: 'style' })).toMatchObject({ success: false });
    });

    it('passes a filter control to the map\'s slider', async () => {
        const { map, call } = await setup();
        await call('create_control', { bind: 'filter', layer_id: 'fires', field: 'YEAR_', min: 1, max: 2, mode: '>=' });
        expect(map.createSlider).toHaveBeenCalledWith(expect.objectContaining({ layer_id: 'fires', mode: '>=' }));
    });
});

describe('remove_widget', () => {
    it('removes a control, a chart, or a layer\'s filter slider', async () => {
        const { ctx, call } = await setup();
        ctx.charts = { has: (id) => id === 'c1', remove: vi.fn(), describe: () => [{ chart_id: 'c1' }] };
        expect(await call('remove_widget', { id: 'unit' })).toMatchObject({ success: true, removed: 'control' });
        expect(document.querySelector('[data-param-id="unit"]')).toBeNull();
        expect(await call('remove_widget', { id: 'c1' })).toMatchObject({ success: true, removed: 'chart' });
        expect(ctx.charts.remove).toHaveBeenCalledWith('c1');
        expect(await call('remove_widget', { id: 'fires' })).toMatchObject({ success: true, removed: 'filter slider' });
        const miss = await call('remove_widget', { id: 'nope' });
        expect(miss.error).toMatch(/Controls and charts: years, radius, c1/);
    });
});

describe('ControlPanel', () => {
    let bus, mount;
    beforeEach(() => {
        document.body.innerHTML = '<div id="m"></div>';
        mount = document.getElementById('m');
        bus = new ParamBus([years, unit, radius, { id: 'many', token: 'MANY', options: [1, 2, 3, 4, 5, 6], format: '{} km' }]);
        new ControlPanel(bus, { mount });
    });

    it('sets the bus from buttons, menus, sliders and ranges', () => {
        document.querySelectorAll('[data-param-id="unit"] button')[1].click();
        expect(bus.values.unit).toBe('radius');
        expect(document.querySelector('[data-param-id="radius"]').hidden).toBe(false);

        const sel = document.querySelector('[data-param-id="many"] select');
        expect(sel.options[2].textContent).toBe('3 km');
        sel.value = '2';
        sel.dispatchEvent(new Event('change'));
        expect(bus.values.many).toBe(3);

        const k = document.querySelector('[data-param-id="radius"] input');
        k.value = '2';
        k.dispatchEvent(new Event('input'));
        expect(bus.values.radius).toBe(3);

        const [lo, hi] = document.querySelectorAll('[data-param-id="years"] input');
        hi.value = '1';
        hi.dispatchEvent(new Event('input'));
        expect(bus.values.years).toEqual([2001, 2010]);
        expect(document.querySelector('[data-param-id="years"] .param-control-value').textContent).toBe('2001 – 2010');
        lo.value = '2';                                   // past the high handle: held to it
        lo.dispatchEvent(new Event('input'));
        expect(bus.values.years).toEqual([2010, 2010]);
    });

    it('shows a value the agent set', () => {
        bus.set('years', [2010, 2020]);
        const [lo, hi] = document.querySelectorAll('[data-param-id="years"] input');
        expect([lo.value, hi.value]).toEqual(['1', '2']);
    });
});

describe('charts plugin with controls', () => {
    it('knows when the app loads the controls plugin', () => {
        expect(hasControlsPlugin({ plugins: ['core/plugins/controls.js', 'core/plugins/charts.js'] })).toBe(true);
        expect(hasControlsPlugin({ plugins: [{ url: 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.1.0/core/plugins/controls.js' }] })).toBe(true);
        expect(hasControlsPlugin({ plugins: ['core/plugins/charts.js'] })).toBe(false);
    });

    it('draws the configured charts once the app is ready, with their tokens filled', async () => {
        document.body.innerHTML = '<div id="menu"></div>';
        const ready = [];
        const tools = new Map();
        const run = vi.fn(async () => 'rows\n[{"y":2001,"v":1}]');
        tools.set('query', { inputSchema: { properties: { sql_query: {} } } });
        const ctx = {
            config: { plugins: ['core/plugins/controls.js', 'core/plugins/charts.js'] },
            tools: { tools, registerLocal: (t) => tools.set(t.name, t), execute: async (n, a) => ({ success: true, result: await run(a) }) },
            layout: { menuMountId: 'menu' },
            onReady: (fn) => ready.push(fn),
        };
        await chartsPlugin.setup(ctx, { charts: [{ chart_id: 'loss', chart_type: 'line', x: 'y', y: 'v', sql: 'SELECT y, v FROM t WHERE y >= {{YEAR_MIN}}', when: { unit: 'hex' } }] });
        await plugin.setup(ctx, { controls: [years, unit] });
        ctx.charts.render = vi.fn(async (spec, rows, o) => ({ id: o.id }));
        ctx.charts.setHidden = vi.fn();
        await ready[0]();
        expect(run.mock.calls[0][0].sql_query).toContain('WHERE y >= 2001');
        expect(ctx.tools.tools.get('render_chart').live.has('loss')).toBe(true);
        expect(ctx.tools.tools.get('render_chart').description).toMatch(/TOKEN/);
    });
});
