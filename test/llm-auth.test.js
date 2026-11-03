import { describe, it, expect, vi, afterEach } from 'vitest';
import { bearerHeader } from '../app/llm-auth.js';
import { Agent } from '../app/agent.js';
import { Transcriber } from '../app/transcriber.js';

describe('bearerHeader (#420)', () => {
    it('sends the key as a bearer token', () => {
        expect(bearerHeader('k')).toEqual({ Authorization: 'Bearer k' });
    });

    it('sends no header when the key is absent or blank', () => {
        expect(bearerHeader(undefined)).toEqual({});
        expect(bearerHeader(null)).toEqual({});
        expect(bearerHeader('')).toEqual({});
        expect(bearerHeader('   ')).toEqual({});
    });
});

describe('LLM requests without api_key leave basic-auth credentials alone (#420)', () => {
    let originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    const ok = { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };

    it('Agent.callLLM omits Authorization when the model has no api_key', async () => {
        let headers;
        global.fetch = vi.fn(async (_url, opts) => { headers = opts.headers; return ok; });
        const agent = new Agent(
            { llm_models: [{ value: 'm', endpoint: '/api/llm/v1' }] },
            { getToolsForLLM: () => [], isLocal: () => true, execute: async () => ({ result: '' }) },
        );
        await agent.callLLM('/api/llm/v1/chat/completions', { value: 'm' }, [{ role: 'user', content: 'hi' }], []);
        expect(headers).not.toHaveProperty('Authorization');
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('Transcriber omits Authorization when the model has no api_key', async () => {
        global.fetch = vi.fn(async () => ok);
        await new Transcriber({ value: 'm', endpoint: '/api/llm/v1' }).transcribe({ data: 'b', format: 'wav' });
        expect(global.fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });
});
