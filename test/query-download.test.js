// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import * as lib from '../app/query-download.js';
import plugin, { downloadButtons, fileStem } from '../core/plugins/downloads.js';

const { rowFetcher, parseJsonRows, parseCellRows, downloadSql, toCsv, toGeoJson, buildDownload, isDownloadable, restoreSafeIntegers } = lib;

const COLUMNS = [
    { column_name: 'name', column_type: 'VARCHAR' },
    { column_name: 'h8', column_type: 'UBIGINT' },
    { column_name: 'geom', column_type: 'GEOMETRY(\'OGC:CRS84\')' },
    { column_name: 'outline', column_type: 'GEOMETRY' },
];

describe('rowFetcher', () => {
    it('asks a tool with format json for JSON, passing the call\'s endpoint but not its SQL', async () => {
        const run = vi.fn(async () => '[{"a":1}]');
        const tool = { inputSchema: { properties: { sql_query: {}, format: { enum: ['markdown', 'json'] } } } };
        const rows = await rowFetcher(tool, run, { sql_query: 'SELECT 2', s3_scope: 's3://b' })('SELECT 1');
        expect(rows).toEqual([{ a: 1 }]);
        expect(run).toHaveBeenCalledWith('SELECT 1', { s3_scope: 's3://b', format: 'json' });
    });

    it('wraps the SQL in to_json for a tool without it, as geo-query is', async () => {
        const run = vi.fn(async () => '| rows |\n|:--|\n| [{"a":"x|y"}] |');
        const rows = await rowFetcher({ inputSchema: { properties: { sql_query: {} } } }, run)('SELECT 1;  ');
        expect(rows).toEqual([{ a: 'x|y' }]);
        expect(run.mock.calls[0][0]).toBe('SELECT to_json(array_agg(__r)) AS rows FROM (\nSELECT 1\n) __r');
    });
});

describe('parsing rows', () => {
    it('reads no rows from either form', () => {
        expect(parseJsonRows('null')).toEqual([]);
        expect(parseJsonRows('[]')).toEqual([]);
        expect(parseCellRows('| rows |\n|:--|\n|  |')).toEqual([]);
        expect(parseCellRows('| rows |\n|---|\n| null |')).toEqual([]);
        expect(parseCellRows('No results found.')).toEqual([]);
    });

    it('turns an error the tool returned as text into a failure', () => {
        expect(() => parseJsonRows('SQL Error: Catalog Error: no table x')).toThrow('Catalog Error');
        expect(() => parseCellRows('SQL Error: Binder Error')).toThrow('Binder Error');
        expect(() => parseJsonRows('{"a":1}')).toThrow();
    });
});

describe('downloadSql', () => {
    it('casts 64-bit integers to text and writes geometry as GeoJSON or WKT', () => {
        expect(downloadSql('SELECT * FROM t -- note', COLUMNS, 'geojson', 10)).toBe(
            'SELECT * REPLACE (CAST("h8" AS VARCHAR) AS "h8", ST_AsGeoJSON("geom") AS "geom", ST_AsText("outline") AS "outline") '
            + 'FROM (\nSELECT * FROM t -- note\n) __d LIMIT 11');
        expect(downloadSql('SELECT 1', COLUMNS, 'csv', 10)).toContain('ST_AsText("geom") AS "geom", ST_AsText("outline")');
    });

    it('leaves a query with nothing to convert alone, and quotes odd names', () => {
        expect(downloadSql('SELECT 1 AS a', [{ column_name: 'a', column_type: 'INTEGER' }], 'csv', 5)).toBe('SELECT * FROM (\nSELECT 1 AS a\n) __d LIMIT 6');
        expect(downloadSql('q', [{ column_name: 'a"b', column_type: 'BIGINT' }], 'csv', 5)).toContain('CAST("a""b" AS VARCHAR) AS "a""b"');
    });
});

describe('files', () => {
    it('writes CSV in column order, quoting where needed and nested values as JSON', () => {
        const csv = toCsv([
            { b: 'plain', a: 1 },
            { a: null, b: 'has, comma "and" quotes' },
            { a: 3, b: [1, 2] },
            { a: 4, b: 'line\nbreak' },
        ], ['a', 'b']);
        expect(csv).toBe('a,b\r\n1,plain\r\n,"has, comma ""and"" quotes"\r\n3,"[1,2]"\r\n4,"line\nbreak"\r\n');
    });

    it('writes a FeatureCollection with the other columns as properties', () => {
        const fc = JSON.parse(toGeoJson([
            { name: 'a', geom: { type: 'Point', coordinates: [1, 2] } },
            { name: 'b', geom: '{"type":"Point","coordinates":[3,4]}' },
            { name: 'c', geom: null },
        ], 'geom'));
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features.map(f => f.geometry?.coordinates ?? null)).toEqual([[1, 2], [3, 4], null]);
        expect(fc.features[0].properties).toEqual({ name: 'a' });
    });
});

describe('buildDownload', () => {
    const fetcher = (rows) => vi.fn(async (sql) => (sql.startsWith('DESCRIBE') ? COLUMNS : rows));

    it('describes the query, then fetches its rows with the columns converted', async () => {
        const fetchRows = fetcher([{ name: 'x', h8: '617700169958293503', geom: { type: 'Point', coordinates: [0, 0] }, outline: 'POINT (0 0)' }]);
        const res = await buildDownload(fetchRows, 'SELECT * FROM t', 'geojson');
        expect(fetchRows.mock.calls[0][0]).toBe('DESCRIBE SELECT * FROM (\nSELECT * FROM t\n) __d');
        expect(res).toMatchObject({ ok: true, rows: 1, truncated: false, ext: 'geojson', mime: 'application/geo+json' });
        expect(JSON.parse(res.text).features[0].properties).toEqual({ name: 'x', h8: '617700169958293503', outline: 'POINT (0 0)' });
    });

    it('keeps 64-bit integers that a number cannot hold as text, and the rest as numbers', async () => {
        const columns = [{ column_name: 'n', column_type: 'BIGINT' }, { column_name: 'h8', column_type: 'UBIGINT' }, { column_name: 's', column_type: 'VARCHAR' }];
        const fetchRows = vi.fn(async (sql) => (sql.startsWith('DESCRIBE') ? columns
            : [{ n: '42', h8: '617700169958293503', s: '7' }, { n: '-9007199254740993', h8: null, s: 'x' }]));
        const res = await buildDownload(fetchRows, 'SELECT 1', 'csv');
        expect(res.text).toBe('n,h8,s\r\n42,617700169958293503,7\r\n-9007199254740993,,x\r\n');
        expect(restoreSafeIntegers([{ n: '42', s: '7' }], ['n'])).toEqual([{ n: 42, s: '7' }]);
    });

    it('keeps the first rows of a larger result and says so', async () => {
        const res = await buildDownload(fetcher([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), 'SELECT 1', 'csv', { limit: 2 });
        expect(res).toMatchObject({ ok: true, rows: 2, truncated: true, ext: 'csv' });
        expect(res.text.split('\r\n')[2]).toBe('b,,,');
    });

    it('refuses GeoJSON without a geometry column, and reports a failed query', async () => {
        const noGeom = vi.fn(async () => [{ column_name: 'a', column_type: 'INTEGER' }]);
        expect(await buildDownload(noGeom, 'SELECT 1', 'geojson')).toMatchObject({ ok: false, error: expect.stringMatching(/no geometry column/) });
        expect(noGeom).toHaveBeenCalledTimes(1);
        const failing = async () => { throw new Error('HTTP 500'); };
        expect(await buildDownload(failing, 'SELECT 1', 'csv')).toEqual({ ok: false, error: 'HTTP 500' });
    });
});

describe('isDownloadable', () => {
    it('takes a query result with rows and nothing else', () => {
        const ok = { name: 'query', success: true, sqlQuery: 'SELECT 1', result: '| a |\n|--|\n| 1 |' };
        expect(isDownloadable(ok)).toBe(true);
        expect(isDownloadable({ ...ok, name: 'get_schema' })).toBe(false);
        expect(isDownloadable({ ...ok, success: false })).toBe(false);
        expect(isDownloadable({ ...ok, sqlQuery: null })).toBe(false);
        expect(isDownloadable({ ...ok, result: 'No results found.' })).toBe(false);
        expect(isDownloadable({ ...ok, result: 'SQL Error: Parser Error' })).toBe(false);
    });
});

describe('downloads plugin', () => {
    const queryTool = { inputSchema: { properties: { sql_query: {}, s3_endpoint: {}, format: { enum: ['markdown', 'json'] } } } };
    const toolsWith = (execute) => ({ tools: new Map([['query', queryTool]]), execute });
    const result = { name: 'query', success: true, sqlQuery: 'SELECT * FROM t', result: '| a |', args: { sql_query: 'SELECT * FROM t', s3_endpoint: 'minio.example' } };

    it('adds CSV and GeoJSON buttons that re-run the query and save the file', async () => {
        const execute = vi.fn(async (name, args) => ({
            success: true,
            result: args.sql_query.startsWith('DESCRIBE') ? '[{"column_name":"a","column_type":"INTEGER"}]' : '[{"a":1},{"a":2}]',
        }));
        const save = vi.fn();
        const els = downloadButtons(result, { tools: toolsWith(execute), lib, doc: document, save, now: () => new Date(2026, 10, 24, 9, 5) });
        expect(els.map(e => e.textContent)).toEqual(['CSV', 'GeoJSON', '']);
        els[0].click();
        await vi.waitFor(() => expect(save).toHaveBeenCalled());
        expect(save).toHaveBeenCalledWith('a\r\n1\r\n2\r\n', 'query-2026-11-24-0905.csv', 'text/csv');
        expect(execute.mock.calls[1][1]).toMatchObject({ format: 'json', s3_endpoint: 'minio.example' });
        expect(els[2].textContent).toBe('2 rows.');
        expect(els[0].disabled).toBe(false);
    });

    it('shows why a download failed', async () => {
        const execute = vi.fn(async () => ({ success: true, result: '[{"column_name":"a","column_type":"INTEGER"}]' }));
        const save = vi.fn();
        const els = downloadButtons(result, { tools: toolsWith(execute), lib, doc: document, save });
        els[1].click();
        await vi.waitFor(() => expect(els[2].textContent).toMatch(/no geometry column/));
        expect(save).not.toHaveBeenCalled();
    });

    it('adds nothing to other results, or with no query tool', () => {
        const deps = { tools: toolsWith(vi.fn()), lib, doc: document, save: vi.fn() };
        expect(downloadButtons({ ...result, name: 'fly_to' }, deps)).toBeNull();
        expect(downloadButtons(result, { ...deps, tools: { tools: new Map(), execute: vi.fn() } })).toBeNull();
    });

    it('registers a result action once the chat exists, and warns on an older harness', async () => {
        let ready;
        const ctx = { tools: toolsWith(vi.fn()), onReady: (fn) => { ready = fn; } };
        await plugin.setup(ctx, { max_rows: 10 });
        const addResultAction = vi.fn();
        ready({ ui: { addResultAction } });
        expect(addResultAction).toHaveBeenCalledTimes(1);
        expect(addResultAction.mock.calls[0][0]({ name: 'fly_to' })).toBeNull();

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        ready({ ui: {} });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/v0\.6\.0/));
        warn.mockRestore();
    });

    it('names the file by the time of the download', () => {
        expect(fileStem(new Date(2026, 0, 2, 3, 4))).toBe('query-2026-01-02-0304');
    });
});
