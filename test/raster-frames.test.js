import { describe, it, expect, vi } from 'vitest';
import {
    parseFrameList, dateFromFilename, listingFor, parseListing, loadFrames,
    parseDuration, subtractDuration, selectFrames, nearestFrameIndex, normalizeDate,
} from '../app/raster-frames.js';

const days = (from, n) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    return { datetime: d, href: `https://h/b/ssta-${d.replace(/-/g, '')}.tif` };
});

describe('frame-list asset', () => {
    it('parses, sorts and drops bad entries', () => {
        const frames = parseFrameList({ interval: 'P1D', frames: [
            { datetime: '2025-09-27', href: 'c' },
            { datetime: '2025-09-25T00:00:00Z', href: 'a' },
            { datetime: 'not a date', href: 'x' },
            { datetime: '2025-09-26' },
        ] });
        expect(frames).toEqual([{ datetime: '2025-09-25', href: 'a' }, { datetime: '2025-09-27', href: 'c' }]);
    });

    it('returns nothing for a document without frames', () => {
        expect(parseFrameList({})).toEqual([]);
        expect(parseFrameList(null)).toEqual([]);
    });
});

describe('dates from file names', () => {
    it('reads YYYYMMDD and YYYYMM', () => {
        expect(dateFromFilename('crw-5km-daily/ssta/cog/ssta-20250925.tif')).toBe('2025-09-25');
        expect(dateFromFilename('crw-5km-monthly/ssta-mean/cog/ssta-mean-198501.tif')).toBe('1985-01-01');
    });

    it('skips names without a date and impossible dates', () => {
        expect(dateFromFilename('ssta-latest.tif')).toBe(null);
        expect(dateFromFilename('ssta-20251399.tif')).toBe(null);
    });

    it('reads only the file name, not digits in the directory', () => {
        expect(dateFromFilename('crw-5km/2024/x/ssta-latest.tif')).toBe(null);
    });
});

describe('bucket listing', () => {
    it('lists the directory of a path-style COG href', () => {
        expect(listingFor('https://s3.example/public-crw/crw-5km-daily/ssta/cog/ssta-latest.tif'))
            .toEqual({ base: 'https://s3.example/public-crw', prefix: 'crw-5km-daily/ssta/cog/' });
    });

    it('parses keys and the continuation token', () => {
        const xml = `<ListBucketResult><IsTruncated>true</IsTruncated>
            <Contents><Key>d/ssta-20250926.tif</Key></Contents>
            <Contents><Key>d/ssta-latest.tif</Key></Contents>
            <Contents><Key>d/frames.json</Key></Contents>
            <Contents><Key>d/ssta-20250925.tif</Key></Contents>
            <NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`;
        const { frames, next } = parseListing(xml, 'https://s3/b');
        expect(frames.map(f => f.datetime)).toEqual(['2025-09-26', '2025-09-25']);
        expect(frames[0].href).toBe('https://s3/b/d/ssta-20250926.tif');
        expect(next).toBe('tok&1');
    });

    it('loadFrames follows continuation pages and sorts', async () => {
        const pages = [
            '<IsTruncated>true</IsTruncated><Key>d/x-20250927.tif</Key><NextContinuationToken>p2</NextContinuationToken>',
            '<IsTruncated>false</IsTruncated><Key>d/x-20250925.tif</Key>',
        ];
        const fetchFn = vi.fn(async () => ({ ok: true, text: async () => pages.shift() }));
        const frames = await loadFrames({ listFrom: 'https://s3/b/d/x-latest.tif' }, fetchFn);
        expect(frames.map(f => f.datetime)).toEqual(['2025-09-25', '2025-09-27']);
        expect(fetchFn.mock.calls[0][0]).toBe('https://s3/b?list-type=2&prefix=d%2F');
        expect(fetchFn.mock.calls[1][0]).toContain('&continuation-token=p2');
    });

    it('loadFrames reads a frame-list asset', async () => {
        const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ frames: [{ datetime: '2025-09-25', href: 'a' }] }) }));
        expect(await loadFrames({ indexUrl: 'https://s3/b/frames.json' }, fetchFn)).toEqual([{ datetime: '2025-09-25', href: 'a' }]);
    });

    it('loadFrames reports a failed request and a missing source', async () => {
        await expect(loadFrames({ indexUrl: 'u' }, async () => ({ ok: false, status: 404 }))).rejects.toThrow(/404/);
        await expect(loadFrames({})).rejects.toThrow(/frame-list asset/);
    });
});

describe('durations', () => {
    it('parses days, weeks, months and years', () => {
        expect(parseDuration('P90D')).toEqual({ years: 0, months: 0, days: 90 });
        expect(parseDuration('P2W')).toEqual({ years: 0, months: 0, days: 14 });
        expect(parseDuration('p1y6m')).toEqual({ years: 1, months: 6, days: 0 });
        expect(parseDuration('P')).toBe(null);
        expect(parseDuration('90 days')).toBe(null);
    });

    it('subtracts across month and year ends', () => {
        expect(subtractDuration('2026-03-01', { years: 0, months: 0, days: 1 })).toBe('2026-02-28');
        expect(subtractDuration('2026-11-01', { years: 0, months: 13, days: 0 })).toBe('2025-10-01');
    });
});

describe('selectFrames', () => {
    const frames = days('2026-01-01', 10);   // 1 … 10 January

    it('keeps everything by default', () => {
        expect(selectFrames(frames)).toHaveLength(10);
    });

    it('steps back from the latest frame so it is always kept', () => {
        expect(selectFrames(frames, { step: 4 }).map(f => f.datetime.slice(8))).toEqual(['02', '06', '10']);
    });

    it('keeps a recent window measured from the last frame', () => {
        expect(selectFrames(frames, { window: 'P3D' }).map(f => f.datetime.slice(8))).toEqual(['07', '08', '09', '10']);
    });

    it('applies start and end before the window and step', () => {
        const out = selectFrames(frames, { start: '2026-01-03', end: '2026-01-08', step: 2 });
        expect(out.map(f => f.datetime.slice(8))).toEqual(['04', '06', '08']);
    });
});

describe('nearestFrameIndex and normalizeDate', () => {
    const frames = [{ datetime: '2026-01-01' }, { datetime: '2026-01-05' }, { datetime: '2026-01-09' }];

    it('finds the nearest frame, earlier on a tie', () => {
        expect(nearestFrameIndex(frames, '2026-01-06')).toBe(1);
        expect(nearestFrameIndex(frames, '2026-01-07')).toBe(1);
        expect(nearestFrameIndex(frames, '2030-01-01')).toBe(2);
        expect(nearestFrameIndex(frames, 'soon')).toBe(-1);
        expect(nearestFrameIndex([], '2026-01-01')).toBe(-1);
    });

    it('normalizes month and datetime strings', () => {
        expect(normalizeDate('1998-02')).toBe('1998-02-01');
        expect(normalizeDate('2026-01-05T12:00:00Z')).toBe('2026-01-05');
        expect(normalizeDate('2026-02-30')).toBe(null);
        expect(normalizeDate(20260105)).toBe(null);
    });
});
