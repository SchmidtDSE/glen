/**
 * control-panel.js — The panel that draws an app's params as controls
 * (SchmidtDSE/glen#426): buttons, a menu, a slider over ordered options, or a
 * two-handle range. It sits at the top of the layer panel, in the floating
 * and the sidebar layouts alike.
 *
 * The panel only shows and sets values; the ParamBus (params.js) holds them.
 * A control the agent sets, or a drill-down whose `when` stops matching,
 * redraws here from the bus.
 */

import { optionValue, optionLabel, controlKind, paramValueLabel, rangeValue } from './params.js';

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
        const row = d.createElement('div');
        row.className = 'param-control';
        row.dataset.paramId = p.id;
        const head = d.createElement('div');
        head.className = 'param-control-head';
        const label = d.createElement('span');
        label.className = 'param-control-label';
        label.textContent = p.label || p.id;
        const readout = d.createElement('span');
        readout.className = 'param-control-value';
        head.append(label, readout);
        row.appendChild(head);
        const set = (v) => this.bus.set(p.id, v);
        const values = p.options.map(optionValue);
        const indexOf = (v) => values.findIndex(x => String(x) === String(v));
        const kind = controlKind(p);
        let sync;

        if (kind === 'segmented') {
            const group = d.createElement('div');
            group.className = 'param-segmented';
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', p.label || p.id);
            const buttons = p.options.map((o) => {
                const b = d.createElement('button');
                b.type = 'button';
                b.className = 'basemap-btn';
                b.textContent = optionLabel(p, o);
                b.addEventListener('click', () => set(optionValue(o)));
                group.appendChild(b);
                return b;
            });
            row.appendChild(group);
            readout.hidden = true;
            sync = (v) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(String(values[i]) === String(v))));
        } else if (kind === 'select') {
            const sel = d.createElement('select');
            sel.className = 'param-select';
            sel.setAttribute('aria-label', p.label || p.id);
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
            const input = slider(d, values.length, p.label || p.id);
            input.addEventListener('input', () => {
                readout.textContent = paramValueLabel(p, values[Number(input.value)]);
                set(values[Number(input.value)]);
            });
            row.appendChild(input);
            sync = (v) => { input.value = String(indexOf(v)); readout.textContent = paramValueLabel(p, v); };
        } else {
            // range: two handles over the same stops, low never past high
            const wrap = d.createElement('div');
            wrap.className = 'param-range';
            const lo = slider(d, values.length, `${p.label || p.id}, from`);
            const hi = slider(d, values.length, `${p.label || p.id}, to`);
            wrap.append(lo, hi);
            const onInput = (moved) => {
                let i = Number(lo.value), j = Number(hi.value);
                if (i > j) { if (moved === lo) i = j; else j = i; lo.value = String(i); hi.value = String(j); }
                readout.textContent = paramValueLabel(p, [values[i], values[j]]);
                set([values[i], values[j]]);
            };
            lo.addEventListener('input', () => onInput(lo));
            hi.addEventListener('input', () => onInput(hi));
            row.appendChild(wrap);
            sync = (v) => {
                const r = rangeValue(p, v) || [values[0], values[values.length - 1]];
                lo.value = String(indexOf(r[0]));
                hi.value = String(indexOf(r[1]));
                readout.textContent = paramValueLabel(p, r);
            };
        }
        return { row, sync };
    }
}

function slider(d, n, label) {
    const input = d.createElement('input');
    input.type = 'range';
    input.className = 'param-slider';
    input.min = '0';
    input.max = String(n - 1);
    input.step = '1';
    input.setAttribute('aria-label', label);
    return input;
}
