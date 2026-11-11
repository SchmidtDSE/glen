import { describe, it, expect, vi } from 'vitest';
import plugin, { runQuery } from '../core/plugins/charts.js';

function registry(queryTool = null) {
    const tools = new Map();
    if (queryTool) tools.set('query', queryTool);
    return {
        tools,
        registerLocal: vi.fn((t) => tools.set(t.name, { ...t, source: 'local' })),
        execute: vi.fn(async (name, args) => {
            const t = tools.get(name);
            if (!t) return { success: false, result: `Unknown tool: ${name}` };
            return { success: true, result: await t.run(args) };
        }),
    };
}

describe('glen core charts plugin (#441)', () => {
    it('registers render_chart and exposes the renderer', async () => {
        const ctx = { tools: registry() };
        await plugin.setup(ctx, {});
        expect(ctx.tools.registerLocal).toHaveBeenCalledTimes(1);
        expect(ctx.tools.tools.get('render_chart').name).toBe('render_chart');
        expect(typeof ctx.charts.render).toBe('function');
    });

    it('runs chart SQL through the registered query tool, naming its SQL argument', async () => {
        const run = vi.fn(async () => '[{"rows": [{"c":"a","v":1}]}]');
        const geoQuery = registry({ inputSchema: { properties: { sql_query: {}, s3_endpoint: {} } }, run });
        await runQuery(geoQuery, 'SELECT 1');
        expect(geoQuery.execute).toHaveBeenCalledWith('query', { sql_query: 'SELECT 1' });
        const other = registry({ inputSchema: { properties: { sql: {} } }, run });
        await runQuery(other, 'SELECT 2');
        expect(other.execute).toHaveBeenCalledWith('query', { sql: 'SELECT 2' });
    });

    it('draws from SQL end to end, and says what is missing without a query tool', async () => {
        const run = vi.fn(async () => 'rows\n[{"c":"a","v":1},{"c":"b","v":2}]');
        const ctx = { tools: registry({ inputSchema: { properties: { sql_query: {}, s3_endpoint: {} } }, run }) };
        await plugin.setup(ctx, {});
        ctx.charts.render = vi.fn(async () => ({ id: 'chart-1' }));
        const tool = ctx.tools.tools.get('render_chart');
        const ok = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'c', y: 'v', sql: 'SELECT c, v FROM t' }));
        expect(ok).toMatchObject({ success: true, points: 2 });
        expect(run.mock.calls[0][0].sql_query).toContain('FROM (SELECT c, v FROM t) _chart_rows');

        // Data on another host: the endpoint get_schema gave goes to query.
        await tool.execute({ chart_type: 'bar', x: 'c', y: 'v', sql: 'SELECT 1', s3_endpoint: 'storage.googleapis.com', s3_scope: 's3://b' });
        expect(run.mock.calls[1][0]).toMatchObject({ s3_endpoint: 'storage.googleapis.com' });
        expect(run.mock.calls[1][0].s3_scope).toBeUndefined(); // this query tool's schema lacks it
        expect(tool.inputSchema.properties).toHaveProperty('s3_endpoint');

        const bare = { tools: registry() };
        await plugin.setup(bare, {});
        const missing = JSON.parse(await bare.tools.tools.get('render_chart').execute({ chart_type: 'bar', x: 'c', y: 'v', sql: 'SELECT 1' }));
        expect(missing.success).toBe(false);
        expect(missing.error).toMatch(/no query tool/);
    });
});
