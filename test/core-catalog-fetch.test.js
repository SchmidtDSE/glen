import { describe, it, expect } from 'vitest';
import { defaultFetchJson } from '../core/portolan-catalog.js';

/** A fetch that answers from a list, one response (or thrown error) per call. */
function scripted(answers) {
    const calls = [];
    const fetchFn = async (url) => {
        calls.push(url);
        const a = answers[Math.min(calls.length - 1, answers.length - 1)];
        if (a instanceof Error) throw a;
        return { ok: a.status < 400, status: a.status, statusText: a.statusText || '', json: async () => a.body };
    };
    return { fetchFn, calls };
}

function waits() {
    const log = [];
    return { log, wait: async (ms) => { log.push(ms); } };
}

describe('reading a catalog document (SchmidtDSE/glen#512)', () => {
    it('returns the JSON on the first try without waiting', async () => {
        const { fetchFn, calls } = scripted([{ status: 200, body: { id: 'c' } }]);
        const w = waits();
        expect(await defaultFetchJson('u', { fetchFn, wait: w.wait })).toEqual({ id: 'c' });
        expect(calls).toHaveLength(1);
        expect(w.log).toEqual([]);
    });

    it('fails at once on a 404, with no retry and no wait', async () => {
        const { fetchFn, calls } = scripted([{ status: 404, statusText: 'Not Found' }]);
        const w = waits();
        await expect(defaultFetchJson('u', { fetchFn, wait: w.wait })).rejects.toThrow('404 Not Found for u');
        expect(calls).toHaveLength(1);
        expect(w.log).toEqual([]);
    });

    it('fails at once on a 403', async () => {
        const { fetchFn, calls } = scripted([{ status: 403, statusText: 'Forbidden' }]);
        await expect(defaultFetchJson('u', { fetchFn, wait: waits().wait })).rejects.toThrow('403');
        expect(calls).toHaveLength(1);
    });

    it('fails at once on a document that is not JSON', async () => {
        const calls = [];
        const fetchFn = async () => { calls.push(1); return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }; };
        await expect(defaultFetchJson('u', { fetchFn, wait: waits().wait })).rejects.toThrow('Unexpected token');
        expect(calls).toHaveLength(1);
    });

    it('tries again after a server error, a 429 or a network error', async () => {
        for (const first of [{ status: 503 }, { status: 429 }, { status: 408 }, new TypeError('Failed to fetch')]) {
            const { fetchFn, calls } = scripted([first, { status: 200, body: { ok: 1 } }]);
            const w = waits();
            expect(await defaultFetchJson('u', { fetchFn, wait: w.wait })).toEqual({ ok: 1 });
            expect(calls).toHaveLength(2);
            expect(w.log).toEqual([500]);
        }
    });

    it('gives up after three tries, without waiting after the last', async () => {
        const { fetchFn, calls } = scripted([{ status: 502, statusText: 'Bad Gateway' }]);
        const w = waits();
        await expect(defaultFetchJson('u', { fetchFn, wait: w.wait })).rejects.toThrow('502 Bad Gateway');
        expect(calls).toHaveLength(3);
        expect(w.log).toEqual([500, 1000]);
    });

    it('rethrows the last network error', async () => {
        const { fetchFn, calls } = scripted([new TypeError('Failed to fetch')]);
        await expect(defaultFetchJson('u', { fetchFn, wait: waits().wait })).rejects.toThrow('Failed to fetch');
        expect(calls).toHaveLength(3);
    });
});
