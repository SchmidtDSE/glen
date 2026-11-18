/**
 * controls.js — glen core plugin: controls whose values enter SQL as
 * {{TOKEN}}s (SchmidtDSE/glen#426), with the tools the agent uses to make and
 * change them.
 *
 * A control is a param (app/params.js), the same object glen-charts takes in
 * its `params`: an id, a label, a token, its options and how it is drawn.
 * Charts whose `sql` uses a token re-run when the reader changes it (with the
 * charts plugin). The app's config lists the controls it starts with; the
 * agent adds, changes and removes them with `create_control` and
 * `remove_widget`, which take the same objects, and sees them, with what the
 * reader chose, in `get_map_state`.
 *
 *   { "url": "…/core/plugins/controls.js", "options": { "controls": [
 *       { "id": "years", "label": "Loss years", "token": "YEAR", "control": "range",
 *         "options": [2001, 2005, 2010, 2015, 2020, 2024] },
 *       { "id": "land", "label": "Land use", "token": "LAND", "options": [
 *           { "value": "cocoa", "label": "Cocoa", "tokens": { "LAND_PATH": "s3://…/cocoa.parquet" } },
 *           { "value": "soy", "label": "Soy", "tokens": { "LAND_PATH": "s3://…/soy.parquet" } } ] },
 *       { "bind": "filter", "layer_id": "fires/perimeters", "field": "YEAR_", "min": 1950, "max": 2024 }
 *   ] } }
 *
 * A control with `"bind": "filter"` is the layer slider of create_slider: it
 * filters one vector layer by a feature property, with no query. With this
 * plugin, `create_control` takes over from `create_slider`.
 */

const CONTROL_FIELDS = ['id', 'label', 'token', 'tokens', 'options', 'control', 'default', 'when', 'format', 'all_label'];

/** The prompt section naming the configured controls and their tokens (static per deployment). */
export function controlsPrompt(bus) {
    if (!bus.params.length) return '';
    const lines = bus.describe().map(c => `- ${c.label} (\`${c.id}\`): ${c.tokens.map(t => `{{${t}}}`).join(', ')}`);
    return `## Controls\n\nThe reader's settings, which chart SQL can use as tokens:\n${lines.join('\n')}`;
}

/** create_control and remove_widget, over a ParamBus, its panel, the map and the charts. */
export function createControlTools({ bus, panel, map, charts }) {
    const createControl = {
        name: 'create_control',
        description: `Add a control to the settings panel, change one, or set its value.

bind "param" (default): a setting whose value enters SQL as a {{TOKEN}}. A chart drawn with render_chart whose sql uses the token re-runs whenever the reader changes the control. Give id, label, token and options; an option is a value or {"value", "label", "tokens"}, and an option's "tokens" are bound while it is chosen, so one choice can set a dataset path and its column together. control "range" takes ordered options and binds {{TOKEN_MIN}} and {{TOKEN_MAX}}; "slider" picks one of ordered options; "segmented" and "select" pick one. "when": {"<control id>": value} shows a control only at that setting of another.

bind "filter": a slider that filters one vector layer by a numeric feature property, with no query. Give layer_id, field, min and max; mode "<=" (default), ">=" or "==".

Call again with the same id to change a control: fields you pass replace the old ones, and "value" alone sets what it shows. get_map_state lists the controls and their values.`,
        inputSchema: {
            type: 'object',
            properties: {
                bind: { type: 'string', enum: ['param', 'filter'], description: 'param (default): a {{TOKEN}} for SQL. filter: a slider that filters a vector layer.' },
                id: { type: 'string', description: 'param: the control\'s id (letters, digits, "_" and "-")' },
                label: { type: 'string', description: 'Label shown on the control' },
                token: { type: 'string', description: 'param: the token name, used as {{TOKEN}} in SQL. Defaults to the id in capitals.' },
                options: { type: 'array', items: {}, description: 'param: the choices, as values or {"value", "label", "tokens"} objects. A value is always one of these, so it is safe in SQL.' },
                control: { type: 'string', enum: ['segmented', 'select', 'slider', 'range'], description: 'param: how it is drawn. Default: buttons for up to five options, else a menu.' },
                default: { type: 'string', description: 'param: the starting value; for a range, two options as "low,high"' },
                value: { type: 'string', description: 'param: set the control to this value; for a range, two options as "low,high"' },
                when: { type: 'object', description: 'param: show this control only when other controls have these values, e.g. {"unit": "radius"}' },
                format: { type: 'string', description: 'param: label for a bare option value, with {} for the value, e.g. "{} km"' },
                layer_id: { type: 'string', description: 'filter: the vector layer to filter' },
                field: { type: 'string', description: 'filter: the numeric feature property' },
                min: { type: 'number', description: 'filter: slider minimum' },
                max: { type: 'number', description: 'filter: slider maximum' },
                step: { type: 'number', description: 'filter: slider step (default 1)' },
                mode: { type: 'string', enum: ['<=', '>=', '=='], description: 'filter: how the field compares with the slider value. Default <=.' },
                animate: { type: 'boolean', description: 'filter: add a play button that sweeps the range' },
            },
            required: [],
        },
        execute: async (args = {}) => JSON.stringify(await applyControl(args)),
    };

    async function applyControl(args) {
        if (args.bind === 'filter') {
            if (!map?.createSlider) return { success: false, error: 'This app has no map to filter.' };
            return map.createSlider(args);
        }
        if (args.bind && args.bind !== 'param') return { success: false, error: `Unknown bind "${args.bind}"; use param or filter.` };
        const prev = args.id != null ? bus.get(String(args.id)) : null;
        const fields = Object.fromEntries(CONTROL_FIELDS.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
        try {
            if (prev && Object.keys(fields).length === 1 && args.value !== undefined) {
                const res = bus.set(prev.id, args.value);
                if (!res.success) return res;
            } else {
                bus.define({ ...(prev || {}), ...fields, ...(args.value !== undefined && { value: args.value }) });
                panel?.render();
                if (args.value !== undefined && String(bus.values[args.id]) !== String(args.value)) {
                    const res = bus.set(String(args.id), args.value);
                    if (!res.success) return res;
                }
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
        const control = bus.describe().find(c => c.id === String(args.id));
        return { success: true, ...(prev ? { updated: true } : { created: true }), control };
    }

    const removeWidget = {
        name: 'remove_widget',
        description: 'Remove a control from the settings panel (by its id), a chart (by its chart_id), or a layer\'s filter slider (by its layer_id). Charts that used a removed control\'s tokens stop updating.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'A control id, a chart_id, or the layer_id of a layer with a filter slider' },
            },
            required: ['id'],
        },
        execute: (args = {}) => {
            const id = String(args.id ?? '');
            if (bus.get(id)) {
                bus.remove(id);
                panel?.render();
                return JSON.stringify({ success: true, removed: 'control', id });
            }
            if (charts?.()?.has?.(id)) {
                charts().remove(id);
                return JSON.stringify({ success: true, removed: 'chart', id });
            }
            if (map?.removeSlider && map.removeSlider(id).success) {
                return JSON.stringify({ success: true, removed: 'filter slider', id });
            }
            const known = [...bus.params.map(p => p.id), ...(charts?.()?.describe?.() || []).map(c => c.chart_id)];
            return JSON.stringify({ success: false, error: `Nothing called "${id}". ${known.length ? `Controls and charts: ${known.join(', ')}.` : 'There are no controls or charts.'}` });
        },
    };

    return [createControl, removeWidget];
}

const plugin = {
    name: 'controls',

    async setup(ctx, options = {}) {
        const [{ ParamBus }, { ControlPanel }] = await Promise.all([
            import('../../app/params.js'),
            import('../../app/control-panel.js'),
        ]);
        const bus = new ParamBus();
        const filters = [];
        for (const spec of Array.isArray(options.controls) ? options.controls : []) {
            if (spec?.bind === 'filter') { filters.push(spec); continue; }
            try {
                const { bind, ...p } = spec || {};
                bus.define(p, { silent: true });
            } catch (err) {
                console.warn('[controls] Control skipped:', err.message);
            }
        }
        // Read by the charts plugin when a chart is drawn.
        ctx.params = bus;

        const doc = typeof document !== 'undefined' ? document : null;
        const mount = doc && ctx.layout?.menuMountId ? doc.getElementById(ctx.layout.menuMountId) : null;
        const panel = mount ? new ControlPanel(bus, { mount, doc }) : null;
        ctx.controls = panel;

        for (const spec of filters) {
            const res = await ctx.map?.createSlider?.(spec);
            if (res && !res.success) console.warn('[controls] Filter slider skipped:', res.error);
        }

        // create_control takes over from create_slider.
        ctx.tools.tools?.delete?.('create_slider');
        for (const t of createControlTools({ bus, panel, map: ctx.map, charts: () => ctx.charts || null })) ctx.tools.registerLocal(t);

        ctx.map?.addStateSection?.('controls', () => (bus.params.length ? bus.describe() : null));
        const state = ctx.tools.tools?.get?.('get_map_state');
        if (state) state.description += ' It also lists the settings panel\'s controls, with their tokens and the values the reader chose.';
        ctx.addPrompt?.(controlsPrompt(bus));
    },
};

export default plugin;
