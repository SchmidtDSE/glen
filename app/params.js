/**
 * params.js — Params: settings a reader chooses that enter SQL as {{TOKEN}}s
 * (SchmidtDSE/glen#426). The rules for a param's value, its tokens and `when`
 * are ported from glen-charts' core/engine.js, so a param written for one
 * library works in the other.
 *
 *   { "id": "years", "label": "Loss years", "token": "YEAR", "control": "range",
 *     "options": [2001, 2005, 2010, 2015, 2020, 2024], "default": [2010, 2024] }
 *
 * - A param's value is always one of its options, so it is safe in SQL.
 * - `control` is how the panel draws it: "segmented" (buttons), "select" (a
 *   menu), "slider" (a slider over the options, for ordered settings) or
 *   "range" (two handles over ordered stops, bound as {{TOKEN_MIN}} and
 *   {{TOKEN_MAX}}, or the two names in "tokens"). Without `control`, five
 *   options or fewer are buttons and more are a menu.
 * - An option is a bare value or { value, label, tokens }. An option's own
 *   `tokens` are bound while it is chosen, so one choice can set a dataset's
 *   path, its column and its unit together.
 * - `when` ({ "<param id>": value or [values] }) makes a param a drill-down: it
 *   applies only at those settings of the params before it, and elsewhere is
 *   held at its default and hidden. A chart may carry `when` too.
 *
 * ParamBus holds the current values and tells subscribers which tokens a
 * change touched, so a chart re-runs only when its SQL uses one of them.
 */

/** An option is a bare value or { value, label, tokens }. */
export const optionValue = o => (o && typeof o === 'object' ? o.value : o);

/** An option's label, with the param's `format` ("{} km") applied to a bare value. */
export function optionLabel(p, o) {
    if (o && typeof o === 'object' && o.label) return String(o.label);
    const text = String(optionValue(o));
    return p.format ? p.format.replace('{}', text) : text;
}

const sameValue = (a, b) => String(a) === String(b);

/**
 * A range param's value from [low, high] or "low,high": two of its options,
 * low first, or null when either is not an option.
 */
export function rangeValue(p, want) {
    if (want === undefined || want === null) return null;
    const parts = Array.isArray(want) ? want : String(want).split(',');
    if (parts.length !== 2) return null;
    const vals = p.options.map(optionValue);
    let [i, j] = parts.map(x => vals.findIndex(v => sameValue(v, String(x).trim())));
    if (i < 0 || j < 0) return null;
    if (i > j) [i, j] = [j, i];
    return [vals[i], vals[j]];
}

/** A param's default: `default`, else its first option (a range's full span). */
export function paramDefault(p) {
    if (p.control === 'range') {
        const vals = p.options.map(optionValue);
        return rangeValue(p, p.default) || [vals[0], vals[vals.length - 1]];
    }
    const hit = p.default !== undefined && p.options.find(o => sameValue(optionValue(o), p.default));
    return hit !== undefined && hit !== false ? optionValue(hit) : optionValue(p.options[0]);
}

/** The token names a param binds: its token, or a range param's two. */
export function paramTokenNames(p) {
    const t = p.token || String(p.id).toUpperCase();
    return p.control === 'range' ? (p.tokens || [`${t}_MIN`, `${t}_MAX`]) : [t];
}

/**
 * Whether an item applies at the current settings. `when` maps a param id to
 * a value or a list of values; every param named must match. An item without
 * `when` always applies.
 */
export function matchesWhen(when, params, values = {}) {
    if (!when) return true;
    return Object.entries(when).every(([id, want]) => {
        const p = params.find(x => x.id === id);
        const v = values[id] ?? (p ? paramDefault(p) : undefined);
        if (v === undefined) return false;
        return (Array.isArray(want) ? want : [want]).some(w => sameValue(w, v));
    });
}

/**
 * Every param's value, from the values given where they are valid and apply
 * (`when`), else the default. Params are read in order, so a drill-down's
 * `when` sees the values before it.
 */
export function resolveParams(params, given = {}) {
    const out = {};
    for (const p of params) {
        const want = given[p.id];
        const applies = matchesWhen(p.when, params, out);
        if (p.control === 'range') {
            out[p.id] = (want !== undefined && applies && rangeValue(p, want)) || paramDefault(p);
            continue;
        }
        const hit = want !== undefined && applies && p.options.find(o => sameValue(optionValue(o), want));
        out[p.id] = hit !== undefined && hit !== false ? optionValue(hit) : paramDefault(p);
    }
    return out;
}

/** { YEAR_MIN: '2010', LAND: 'cocoa', LAND_PATH: 's3://…' } for template expansion. */
export function paramTokens(params, values = {}) {
    const out = {};
    for (const p of params) {
        const v = values[p.id] ?? paramDefault(p);
        if (p.control === 'range') {
            const r = rangeValue(p, v) || paramDefault(p);
            const [lo, hi] = paramTokenNames(p);
            out[lo] = String(r[0]);
            out[hi] = String(r[1]);
            continue;
        }
        out[paramTokenNames(p)[0]] = String(v);
        // an option's own tokens are bound while it is chosen
        const chosen = p.options.find(o => o && typeof o === 'object' && sameValue(optionValue(o), v));
        if (chosen?.tokens) for (const [k, t] of Object.entries(chosen.tokens)) out[k] = String(t);
    }
    return out;
}

/** The label of a param's value: its option's label, or "low – high" for a range. */
export function paramValueLabel(p, value) {
    const label = v => {
        const o = p.options.find(x => sameValue(optionValue(x), v));
        return o === undefined ? String(v) : optionLabel(p, o);
    };
    if (p.control === 'range') {
        const r = rangeValue(p, value);
        if (!r) return String(value);
        const vals = p.options.map(optionValue);
        if (p.all_label && sameValue(r[0], vals[0]) && sameValue(r[1], vals[vals.length - 1])) return p.all_label;
        return sameValue(r[0], r[1]) ? label(r[0]) : `${label(r[0])} – ${label(r[1])}`;
    }
    return label(value);
}

/** The control a param is drawn as. */
export function controlKind(p) {
    if (['segmented', 'select', 'slider', 'range'].includes(p.control)) return p.control;
    return p.options.length <= 5 ? 'segmented' : 'select';
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z_]\w{0,63}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check a param definition and return it with its fields normalised, or throw
 * with a message the agent can act on.
 */
export function normalizeParam(spec, others = []) {
    if (!spec || typeof spec !== 'object') throw new Error('A control must be an object.');
    const p = { ...spec };
    if (!ID_RE.test(String(p.id ?? '')) || RESERVED.has(p.id)) throw new Error('A control needs an id of letters, digits, "_" or "-".');
    if (!Array.isArray(p.options) || p.options.length === 0) throw new Error(`Control "${p.id}" needs a non-empty options list.`);
    for (const o of p.options) {
        const v = optionValue(o);
        if (!['string', 'number'].includes(typeof v) || v === '') throw new Error(`Control "${p.id}" has an option whose value is not a string or number.`);
        if (o && typeof o === 'object' && o.tokens) {
            for (const [k, t] of Object.entries(o.tokens)) {
                if (!TOKEN_RE.test(k)) throw new Error(`Control "${p.id}" has an option token named "${k}"; use letters, digits and "_".`);
                if (!['string', 'number'].includes(typeof t)) throw new Error(`Control "${p.id}" option token ${k} must be text or a number.`);
            }
        }
    }
    if (p.control != null && !['segmented', 'select', 'slider', 'range'].includes(p.control)) {
        throw new Error(`Control "${p.id}" has an unknown control "${p.control}"; use segmented, select, slider or range.`);
    }
    if (p.control === 'range' && p.options.length < 2) throw new Error(`Range control "${p.id}" needs at least two options.`);
    if (p.token != null && !TOKEN_RE.test(p.token)) throw new Error(`Control "${p.id}" has a token "${p.token}"; use letters, digits and "_".`);
    if (p.tokens != null && (!Array.isArray(p.tokens) || p.tokens.length !== 2 || !p.tokens.every(t => TOKEN_RE.test(t)))) {
        throw new Error(`Range control "${p.id}" takes "tokens" as two names, low then high.`);
    }
    if (p.when != null && (typeof p.when !== 'object' || Array.isArray(p.when))) throw new Error(`Control "${p.id}" has a "when" that is not an object.`);
    const mine = new Set([...paramTokenNames(p), ...optionTokenNames(p)]);
    for (const q of others) {
        if (q.id === p.id) continue;
        const clash = [...paramTokenNames(q), ...optionTokenNames(q)].find(t => mine.has(t));
        if (clash) throw new Error(`Control "${p.id}" binds {{${clash}}}, which control "${q.id}" already binds.`);
    }
    return p;
}

function optionTokenNames(p) {
    const names = new Set();
    for (const o of p.options || []) if (o && typeof o === 'object' && o.tokens) Object.keys(o.tokens).forEach(k => names.add(k));
    return [...names];
}

/* ── Templates ────────────────────────────────────────────────────────── */

/** Index of a `--` comment outside a quoted string, or -1. */
function commentStart(line) {
    let q = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === q) q = null; continue; }
        if (ch === "'" || ch === '"') q = ch;
        else if (ch === '-' && line[i + 1] === '-') return i;
    }
    return -1;
}

const TOKEN_IN_TEXT = /\{\{(\w+)\}\}/g;

/** The token names a template uses, outside `--` comments. */
export function tokensIn(template) {
    const out = new Set();
    for (const line of String(template ?? '').split('\n')) {
        const c = commentStart(line);
        const code = c < 0 ? line : line.slice(0, c);
        for (const m of code.matchAll(TOKEN_IN_TEXT)) out.add(m[1]);
    }
    return out;
}

/**
 * Fill {{TOKEN}}s in a SQL template. Tokens inside `--` comments are left as
 * written. An unbound token throws, naming the tokens that are bound.
 */
export function expand(template, tokens, where = '') {
    return String(template).split('\n').map(line => {
        const c = commentStart(line);
        const code = c < 0 ? line : line.slice(0, c);
        const filled = code.replace(TOKEN_IN_TEXT, (m, k) => {
            if (!Object.prototype.hasOwnProperty.call(tokens, k)) {
                const bound = Object.keys(tokens);
                throw new Error(`Unbound token ${m}${where ? ` in ${where}` : ''}; ${bound.length ? `the controls bind ${bound.map(b => `{{${b}}}`).join(', ')}` : 'no control binds a token'}.`);
            }
            return tokens[k];
        });
        return c < 0 ? filled : filled + line.slice(c);
    }).join('\n');
}

/**
 * Fill the tokens that are bound in display text, such as a chart's title or
 * axis label ("Loss ({{UNIT_LABEL}})"), and leave any others as written.
 */
export function fillText(text, tokens) {
    if (typeof text !== 'string') return text;
    return text.replace(TOKEN_IN_TEXT, (m, k) => (Object.prototype.hasOwnProperty.call(tokens, k) ? tokens[k] : m));
}

/* ── The bus ──────────────────────────────────────────────────────────── */

export class ParamBus {
    constructor(params = []) {
        this.params = [];
        this.values = {};
        this._listeners = new Set();
        for (const p of params) this.define(p, { silent: true });
    }

    /** The current tokens. */
    tokens() {
        return paramTokens(this.params, this.values);
    }

    get(id) {
        return this.params.find(p => p.id === id) || null;
    }

    /** Whether a param applies at the current settings. */
    active(p) {
        return matchesWhen(p.when, this.params, this.values);
    }

    /**
     * Add a param, or replace the one with its id (keeping its value when the
     * new options still hold it). Throws on a bad definition.
     */
    define(spec, { silent = false } = {}) {
        const p = normalizeParam(spec, this.params);
        const i = this.params.findIndex(x => x.id === p.id);
        const before = this.tokens();
        if (i >= 0) this.params[i] = p; else this.params.push(p);
        const given = { ...this.values };
        if (spec.value !== undefined) given[p.id] = spec.value;
        this.values = resolveParams(this.params, given);
        if (!silent) this._emit(before);
        return p;
    }

    remove(id) {
        const i = this.params.findIndex(x => x.id === id);
        if (i < 0) return false;
        const before = this.tokens();
        this.params.splice(i, 1);
        const { [id]: _, ...rest } = this.values;
        this.values = resolveParams(this.params, rest);
        this._emit(before);
        return true;
    }

    /**
     * Set a param's value. Returns { success, value } or { success: false,
     * error } when the value is not one of its options or the param does not
     * apply at the current settings.
     */
    set(id, value) {
        const p = this.get(id);
        if (!p) return { success: false, error: `No control "${id}".` };
        if (!this.active(p)) return { success: false, error: `Control "${id}" does not apply at the current settings (its "when").` };
        const ok = p.control === 'range' ? rangeValue(p, value) : p.options.some(o => sameValue(optionValue(o), value));
        if (!ok) {
            const opts = p.options.map(optionValue).join(', ');
            return { success: false, error: `${JSON.stringify(value)} is not an option of "${id}"${p.control === 'range' ? ' (give two of its options, low and high)' : ''}. Options: ${opts}.` };
        }
        const before = this.tokens();
        this.values = resolveParams(this.params, { ...this.values, [id]: value });
        this._emit(before);
        return { success: true, value: this.values[id] };
    }

    /** subscribe(fn) → unsubscribe; fn(changedTokenNames: Set) after each change. */
    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /** The controls as get_map_state lists them. */
    describe() {
        return this.params.map(p => ({
            id: p.id,
            label: p.label || p.id,
            control: controlKind(p),
            tokens: [...paramTokenNames(p), ...optionTokenNames(p)],
            value: this.values[p.id],
            value_label: paramValueLabel(p, this.values[p.id]),
            options: p.options.map(optionValue),
            ...(p.when && { when: p.when, applies: this.active(p) }),
        }));
    }

    _emit(before) {
        const after = this.tokens();
        const changed = new Set();
        for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (before[k] !== after[k]) changed.add(k);
        }
        if (!changed.size) return;
        for (const fn of [...this._listeners]) {
            try { fn(changed); } catch (err) { console.error('[params] listener failed:', err); }
        }
    }
}
