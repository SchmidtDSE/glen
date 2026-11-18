/**
 * control-panel.js — The Settings section of the side panel, which draws an
 * app's params as controls (SchmidtDSE/glen#426). The markup and its styles
 * are glen-charts' settings controls: pill buttons, a slider over clickable
 * stops, a two-handle range over the same stops, and a menu for long lists.
 * It goes first in the layer panel, in the floating and sidebar layouts alike.
 *
 * The panel only shows and sets values; the ParamBus (params.js) holds them.
 * A slider or range sets its value when the handle is released, not while it
 * is dragged, so a drag costs one query. A control the agent sets, or a
 * drill-down whose `when` stops matching, redraws here from the bus.
 */

import { optionValue, optionLabel, controlKind, paramValueLabel, rangeValue } from './params.js';

/** Past this many stops, label only every few, so the labels do not collide. */
const MAX_STOP_LABELS = 7;

export class ControlPanel {
    /**
     * @param {import('./params.js').ParamBus} bus
     * @param {Object} opts
     * @param {Element} opts.mount - the layer panel; the section goes first in it
     * @param {Document} [opts.doc]
     */
    constructor(bus, { mount, doc } = {}) {
        this.bus = bus;
        this.doc = doc || mount?.ownerDocument || (typeof document !== 'undefined' ? document : null);
        this.rows = new Map();   // param id → { row, sync }
        this.section = null;
        if (!this.doc || !mount) return;
        this.section = this.doc.createElement('section');
        this.section.className = 'param-controls menu-section';
        this.section.setAttribute('aria-label', 'Settings');
        const title = this.doc.createElement('div');
        title.className = 'section-title';
        title.textContent = 'Settings';
        this.list = this.doc.createElement('div');
        this.list.className = 'param-controls-list';
        this.section.append(title, this.list);
        mount.prepend(this.section);
        this._unsub = bus.subscribe(() => this.sync());
        this.render();
    }

    /** Rebuild every control, after one is added, changed or removed. */
    render() {
        if (!this.section) return;
        this.list.replaceChildren();
        this.rows.clear();
        for (const p of this.bus.params) {
            const built = this._build(p);
            this.list.appendChild(built.row);
            this.rows.set(p.id, built);
        }
        this.sync();
    }

    /** Show each control's value, and hide drill-downs that do not apply. */
    sync() {
        if (!this.section) return;
        for (const p of this.bus.params) {
            const r = this.rows.get(p.id);
            if (!r) continue;
            r.row.hidden = !this.bus.active(p);
            r.sync(this.bus.values[p.id]);
        }
        this.section.hidden = this.bus.params.length === 0;
    }

    destroy() {
        this._unsub?.();
        this.section?.remove();
    }

    _build(p) {
        const d = this.doc;
        const name = p.label || p.id;
        const row = d.createElement('div');
        row.className = 'param';
        row.dataset.paramId = p.id;
        const head = d.createElement('div');
        head.className = 'param-head';
        const label = d.createElement('span');
        label.className = 'step-label';
        label.textContent = name;
        const readout = d.createElement('span');
        readout.className = 'param-value';
        head.append(label, readout);
        row.appendChild(head);
        const set = (v) => this.bus.set(p.id, v);
        const values = p.options.map(optionValue);
        const indexOf = (v) => values.findIndex(x => String(x) === String(v));
        const kind = controlKind(p);
        let sync;

        if (kind === 'segmented') {
            const group = d.createElement('div');
            group.className = 'seg';
            group.setAttribute('role', 'radiogroup');
            group.setAttribute('aria-label', name);
            const buttons = p.options.map((o) => {
                const b = d.createElement('button');
                b.type = 'button';
                b.setAttribute('role', 'radio');
                b.textContent = optionLabel(p, o);
                b.addEventListener('click', () => set(optionValue(o)));
                group.appendChild(b);
                return b;
            });
            row.appendChild(group);
            readout.hidden = true;
            sync = (v) => buttons.forEach((b, i) => b.setAttribute('aria-checked', String(String(values[i]) === String(v))));
        } else if (kind === 'select') {
            const sel = d.createElement('select');
            sel.className = 'param-select';
            sel.setAttribute('aria-label', name);
            p.options.forEach((o, i) => {
                const opt = d.createElement('option');
                opt.value = String(i);
                opt.textContent = optionLabel(p, o);
                sel.appendChild(opt);
            });
            sel.addEventListener('change', () => set(values[Number(sel.value)]));
            row.appendChild(sel);
            readout.hidden = true;
            sync = (v) => { sel.value = String(indexOf(v)); };
        } else if (kind === 'slider') {
            const wrap = d.createElement('div');
            wrap.className = 'param-slider';
            wrap.style.setProperty('--n', String(values.length));
            const input = rangeInput(d, values.length, name);
            const stops = stopButtons(d, p);
            wrap.append(input, stops.el);
            // the readout follows the handle; the value is set on release
            input.addEventListener('input', () => { readout.textContent = paramValueLabel(p, values[Number(input.value)]); });
            input.addEventListener('change', () => set(values[Number(input.value)]));
            stops.buttons.forEach((b, i) => b.addEventListener('click', () => set(values[i])));
            row.appendChild(wrap);
            sync = (v) => {
                const i = indexOf(v);
                input.value = String(i);
                readout.textContent = paramValueLabel(p, v);
                stops.buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
            };
        } else {
            // range: two handles on one track over the stops, low never past high
            const n = values.length;
            const wrap = d.createElement('div');
            wrap.className = 'param-span';
            wrap.style.setProperty('--n', String(n));
            wrap.style.setProperty('--last', String(Math.max(1, n - 1)));
            const track = d.createElement('div');
            track.className = 'pr-track';
            const fill = d.createElement('div');
            fill.className = 'pr-fill';
            const lo = rangeInput(d, n, `${name}: from`);
            const hi = rangeInput(d, n, `${name}: to`);
            track.append(fill, lo, hi);
            const stops = stopButtons(d, p);
            wrap.append(track, stops.el);
            row.appendChild(wrap);
            const mark = (a, z) => {
                wrap.style.setProperty('--lo', String(a));
                wrap.style.setProperty('--hi', String(z));
                // both handles at the last stop: the "from" handle on top, so it can move left
                wrap.classList.toggle('lo-top', a === z && z === n - 1);
                stops.buttons.forEach((b, i) => {
                    b.setAttribute('aria-pressed', String(i === a || i === z));
                    b.classList.toggle('in-range', i > a && i < z);
                });
                readout.textContent = paramValueLabel(p, [values[a], values[z]]);
            };
            const value = () => [values[Number(lo.value)], values[Number(hi.value)]];
            lo.addEventListener('input', () => { if (+lo.value > +hi.value) lo.value = hi.value; mark(+lo.value, +hi.value); });
            hi.addEventListener('input', () => { if (+hi.value < +lo.value) hi.value = lo.value; mark(+lo.value, +hi.value); });
            lo.addEventListener('change', () => set(value()));
            hi.addEventListener('change', () => set(value()));
            // clicking a stop moves the nearer handle
            stops.buttons.forEach((b, i) => b.addEventListener('click', () => {
                const a = +lo.value, z = +hi.value;
                if (i < a || (i <= z && i - a <= z - i && i !== z)) lo.value = String(i); else hi.value = String(i);
                set(value());
            }));
            sync = (v) => {
                const r = rangeValue(p, v) || [values[0], values[n - 1]];
                const a = indexOf(r[0]), z = indexOf(r[1]);
                lo.value = String(a);
                hi.value = String(z);
                mark(a, z);
            };
        }
        return { row, sync };
    }
}

function rangeInput(d, n, label) {
    const input = d.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(n - 1);
    input.step = '1';
    input.setAttribute('aria-label', label);
    return input;
}

/** The clickable stops under a slider; past a few, only every few carry a label. */
function stopButtons(d, p) {
    const el = d.createElement('div');
    el.className = 'param-stops';
    const n = p.options.length;
    const every = n > MAX_STOP_LABELS ? Math.ceil((n - 1) / (MAX_STOP_LABELS - 1)) : 1;
    const buttons = p.options.map((o, i) => {
        const b = d.createElement('button');
        b.type = 'button';
        const text = optionLabel(p, o);
        b.setAttribute('aria-label', text);
        b.textContent = i % every === 0 || i === n - 1 ? text : '';
        if (!b.textContent) b.classList.add('param-stop-tick');
        el.appendChild(b);
        return b;
    });
    return { el, buttons };
}
