/**
 * filter-types.js — Make a filter's literal values match the field types in
 * the tiles.
 *
 * MapLibre compares values strictly by type: `[">=", ["get", "Asthma_Pctl"],
 * "90"]` matches nothing when Asthma_Pctl is a number, and `[">=", ["get",
 * "YEAR_"], 2000]` matches nothing when YEAR_ is a string. Models write both,
 * and the map just goes empty. Each change is reported back, so the agent
 * learns the field's type.
 */

const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ORDER = new Set(['<', '<=', '>', '>=']);

/** 'number', 'string' or null, from a PMTiles or table:columns type name. */
export function fieldKind(type) {
    const t = String(type || '').toLowerCase();
    if (/^(number|int|uint|float|double|decimal|real|bigint|smallint|tinyint|long|short)/.test(t)) return 'number';
    if (/^(string|utf8|large_string|text|varchar|char)/.test(t)) return 'string';
    return null;
}

const isGet = (x) => Array.isArray(x) && x[0] === 'get' && typeof x[1] === 'string' && x.length === 2;
const numeric = (v) => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));

/**
 * @param {*} filter - a MapLibre filter expression
 * @param {(field: string) => ('number'|'string'|null)} kindOf
 * @returns {{ filter: *, notes: string[] }}
 */
export function coerceFilter(filter, kindOf) {
    const notes = [];
    const note = (s) => { if (!notes.includes(s)) notes.push(s); };

    // A literal compared with a field of a known kind, as that kind.
    const asKind = (v, kind, field) => {
        if (kind === 'number' && numeric(v)) {
            note(`${field} is a number in the tiles, so "${v}" was compared as ${Number(v)}.`);
            return Number(v);
        }
        if (kind === 'string' && typeof v === 'number') {
            note(`${field} is a string in the tiles, so ${v} was compared as "${v}".`);
            return String(v);
        }
        return v;
    };

    const walk = (x) => {
        if (!Array.isArray(x) || typeof x[0] !== 'string') return x;
        const op = x[0];
        if (op === 'literal') return x;

        if (COMPARE.has(op) && x.length >= 3) {
            const [a, b] = [x[1], x[2]];
            const getSide = isGet(a) ? 1 : isGet(b) ? 2 : 0;
            const other = getSide === 1 ? b : a;
            if (getSide && !Array.isArray(other)) {
                const field = x[getSide][1];
                const kind = kindOf(field);
                const out = [...x];
                if (kind === 'string' && typeof other === 'number' && ORDER.has(op)) {
                    // An ordering on text compares as numbers, so read the field as one.
                    note(`${field} is a string in the tiles, so it was read with to-number for "${op}".`);
                    out[getSide] = ['to-number', x[getSide]];
                } else {
                    out[getSide === 1 ? 2 : 1] = asKind(other, kind, field);
                }
                return out;
            }
        }

        if (op === 'match' && isGet(x[1]) && x.length >= 4) {
            const field = x[1][1];
            const kind = kindOf(field);
            const out = [...x];
            // Labels sit at 2, 4, …; the last element is the fallback.
            for (let i = 2; i < x.length - 1; i += 2) {
                out[i] = Array.isArray(x[i]) ? x[i].map(v => asKind(v, kind, field)) : asKind(x[i], kind, field);
                out[i + 1] = walk(x[i + 1]);
            }
            out[x.length - 1] = walk(x[x.length - 1]);
            return out;
        }

        if (op === 'in' && x.length === 3 && isGet(x[1]) && Array.isArray(x[2]) && x[2][0] === 'literal' && Array.isArray(x[2][1])) {
            const field = x[1][1];
            const kind = kindOf(field);
            return ['in', x[1], ['literal', x[2][1].map(v => asKind(v, kind, field))]];
        }

        return x.map((y, i) => (i === 0 ? y : walk(y)));
    };

    return { filter: walk(filter), notes };
}
