/**
 * style-numbers.js — Read numeric strings as numbers where a paint expression
 * needs a number (SchmidtDSE/glen#499).
 *
 * MapLibre rejects `["interpolate", ["linear"], ["get", "mw"], "0", 2, "100",
 * 9]`: the stops of `interpolate` and `step` must be literal numbers, and the
 * arguments of arithmetic operators must be numbers too. Some models send
 * these as strings, then retry the same expression. In these positions a
 * string that parses as a finite number cannot mean anything else, so it is
 * read as that number and the change is reported back to the agent.
 *
 * Field names (`["get", "2020"]`), `match` labels and `literal` values are
 * left alone, since a numeric string there can be meant as a string.
 */

const INTERPOLATE = new Set(['interpolate', 'interpolate-hcl', 'interpolate-lab']);
const ARITHMETIC = new Set([
    '+', '-', '*', '/', '%', '^', 'sqrt', 'abs', 'ln', 'log10', 'log2', 'exp',
    'min', 'max', 'round', 'floor', 'ceil', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
]);

const numeric = (v) => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));

/** Paint properties whose plain value is a number, such as `circle-radius`. */
export function isNumericPaint(prop) {
    return /-(opacity|width|radius|blur|gap-width|offset|height|base|brightness-min|brightness-max|contrast|saturation|hue-rotate|fade-duration)$/.test(prop);
}

/**
 * @param {string} prop - the paint property, e.g. `circle-radius`
 * @param {*} value - its value: a literal or an expression
 * @returns {{ value: *, converted: string[] }} the value with numeric strings
 *   read as numbers where a number is required, and the strings converted
 */
export function numericStyleValue(prop, value) {
    const converted = [];
    const num = (v) => {
        if (!numeric(v)) return v;
        converted.push(v);
        return Number(v);
    };

    const walk = (x) => {
        if (!Array.isArray(x) || typeof x[0] !== 'string') return x;
        const op = x[0];
        if (op === 'literal' || op === 'get' || op === 'has') return x;
        const out = x.map((v, i) => (i === 0 ? v : walk(v)));

        if (INTERPOLATE.has(op) && out.length >= 5) {
            // [op, ["exponential", base] | ["cubic-bezier", x1, y1, x2, y2], input, stop, output, ...]
            if (Array.isArray(out[1])) out[1] = out[1].map((v, i) => (i === 0 ? v : num(v)));
            for (let i = 3; i < out.length; i++) out[i] = num(out[i]);
        } else if (op === 'step' && out.length >= 3) {
            // [step, input, output0, stop1, output1, ...]
            for (let i = 2; i < out.length; i++) out[i] = num(out[i]);
        } else if (ARITHMETIC.has(op)) {
            for (let i = 1; i < out.length; i++) out[i] = num(out[i]);
        }
        return out;
    };

    const result = isNumericPaint(prop) && !Array.isArray(value) ? num(value) : walk(value);
    return { value: result, converted };
}

/** The note the agent reads when a value was converted. */
export function numericStyleNote(prop, converted) {
    const shown = converted.slice(0, 3).map((v) => `"${v}"`).join(', ');
    const more = converted.length > 3 ? ` and ${converted.length - 3} more` : '';
    const verb = converted.length === 1 ? 'was' : 'were';
    return `In ${prop}, ${shown}${more} ${verb} read as ${converted.length === 1 ? 'a number' : 'numbers'}. Send numbers, not strings, where an expression needs a number.`;
}
