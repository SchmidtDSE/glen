/**
 * raster-frames.js — The dated frames of a raster time series (#421).
 *
 * A raster layer with a `control` of `bind: "frame"` steps through a series of
 * COGs, one per date. This module finds those frames and picks the ones to
 * play. It has no DOM or map dependency, so all of it is unit-tested.
 *
 * Frames come from one of two places:
 *
 * - **A STAC frame-list asset** (preferred). The collection carries an
 *   `application/json` asset whose body is
 *   `{ "interval": "P1D", "frames": [{ "datetime": "2025-09-25", "href": "…tif" }, …] }`,
 *   sorted oldest first and rewritten by the publishing pipeline whenever a
 *   file is added or removed. Which data exists stays in the STAC.
 * - **A bucket listing** (`frames: "list"`), for series that have no frame-list
 *   asset yet. The directory of the layer's COG href is listed with S3
 *   ListObjectsV2, and each file's date is read from an 8-digit (YYYYMMDD) or
 *   6-digit (YYYYMM) run in its name. Files without one, such as
 *   `ssta-latest.tif`, are skipped. This assumes a path-style S3 URL
 *   (`https://host/bucket/key`) and a bucket that allows cross-origin listing.
 */

/**
 * @typedef {Object} Frame
 * @property {string} datetime  ISO date, YYYY-MM-DD
 * @property {string} href      absolute URL of the frame's COG
 */

/**
 * Parse a frame-list document.
 * @param {Object} doc
 * @returns {Frame[]} frames sorted oldest first
 */
export function parseFrameList(doc) {
    const raw = Array.isArray(doc?.frames) ? doc.frames : [];
    const frames = [];
    for (const f of raw) {
        const datetime = normalizeDate(f?.datetime);
        if (datetime && typeof f.href === 'string' && f.href) frames.push({ datetime, href: f.href });
    }
    return sortFrames(frames);
}

/**
 * Read a date from a file name: the last 8-digit run as YYYYMMDD, else the
 * last 6-digit run as YYYYMM (the first of that month).
 * @param {string} name
 * @returns {string|null} YYYY-MM-DD
 */
export function dateFromFilename(name) {
    const base = String(name).split('/').pop();
    const d8 = base.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g);
    if (d8) {
        const s = d8[d8.length - 1];
        return validDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
    }
    const d6 = base.match(/(?<!\d)(\d{4})(\d{2})(?!\d)/g);
    if (d6) {
        const s = d6[d6.length - 1];
        return validDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-01`);
    }
    return null;
}

/**
 * The ListObjectsV2 request for the directory holding a COG.
 * @param {string} cogHref  e.g. https://host/bucket/a/b/ssta-latest.tif
 * @returns {{ base: string, prefix: string }}
 */
export function listingFor(cogHref) {
    const u = new URL(cogHref);
    const parts = u.pathname.replace(/^\//, '').split('/');
    const bucket = parts.shift();
    parts.pop();   // the file itself
    const prefix = parts.length ? `${parts.join('/')}/` : '';
    return { base: `${u.origin}/${bucket}`, prefix };
}

/**
 * Parse one ListObjectsV2 XML page into frames and the continuation token.
 * @param {string} xml
 * @param {string} base  `https://host/bucket`
 * @returns {{ frames: Frame[], next: string|null }}
 */
export function parseListing(xml, base) {
    const frames = [];
    for (const m of String(xml).matchAll(/<Key>([^<]+)<\/Key>/g)) {
        const key = decodeXml(m[1]);
        if (!/\.tiff?$/i.test(key)) continue;
        const datetime = dateFromFilename(key);
        if (datetime) frames.push({ datetime, href: `${base}/${key}` });
    }
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    const token = String(xml).match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    return { frames, next: truncated && token ? decodeXml(token[1]) : null };
}

/**
 * Load a series' frames.
 * @param {{ indexUrl?: string, listFrom?: string, frames?: Frame[] }} source
 *   `indexUrl`: the frame-list asset's href. `listFrom`: a COG href whose
 *   directory is listed. `frames`: a list already read, such as glen core's
 *   frames from a collection's items (#462).
 * @param {Function} [fetchFn=fetch]
 * @returns {Promise<Frame[]>}
 */
export async function loadFrames(source, fetchFn = globalThis.fetch) {
    if (Array.isArray(source?.frames)) return parseFrameList({ frames: source.frames });
    if (source?.indexUrl) {
        const res = await fetchFn(source.indexUrl);
        if (!res.ok) throw new Error(`Frame list ${source.indexUrl} returned ${res.status}`);
        return parseFrameList(await res.json());
    }
    if (source?.listFrom) {
        const { base, prefix } = listingFor(source.listFrom);
        const frames = [];
        let token = null;
        for (let page = 0; page < 50; page++) {
            let url = `${base}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
            if (token) url += `&continuation-token=${encodeURIComponent(token)}`;
            const res = await fetchFn(url);
            if (!res.ok) throw new Error(`Listing ${base}/${prefix} returned ${res.status}`);
            const { frames: got, next } = parseListing(await res.text(), base);
            frames.push(...got);
            if (!next) break;
            token = next;
        }
        return sortFrames(frames);
    }
    throw new Error('A time series needs a frame-list asset, frames: "list", or a list of frames.');
}

/**
 * Parse an ISO-8601 duration of days, weeks, months or years (P90D, P2W,
 * P13M, P10Y, P1Y6M).
 * @param {string} s
 * @returns {{ years: number, months: number, days: number }|null}
 */
export function parseDuration(s) {
    const m = String(s ?? '').trim().toUpperCase().match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/);
    if (!m || m.slice(1).every(x => x == null)) return null;
    const [, y, mo, w, d] = m.map(x => Number(x || 0));
    return { years: y, months: mo, days: d + 7 * w };
}

/**
 * Subtract a duration from an ISO date.
 * @param {string} date  YYYY-MM-DD
 * @param {{ years: number, months: number, days: number }} dur
 * @returns {string} YYYY-MM-DD
 */
export function subtractDuration(date, dur) {
    const [y, m, d] = date.split('-').map(Number);
    const t = new Date(Date.UTC(y - dur.years, m - 1 - dur.months, d - dur.days));
    return t.toISOString().slice(0, 10);
}

/**
 * Pick the frames to play.
 *
 * `start`/`end` bound the range by date. `window` (a duration such as "P90D")
 * keeps only the most recent part of it, measured back from its last frame.
 * `step` keeps every Nth frame, counted back from the last, so the most recent
 * frame is always included.
 *
 * @param {Frame[]} frames  sorted oldest first
 * @param {{ start?: string, end?: string, window?: string, step?: number }} [opts]
 * @returns {Frame[]}
 */
export function selectFrames(frames, opts = {}) {
    let out = frames;
    const start = normalizeDate(opts.start);
    const end = normalizeDate(opts.end);
    if (start) out = out.filter(f => f.datetime >= start);
    if (end) out = out.filter(f => f.datetime <= end);
    const dur = parseDuration(opts.window);
    if (dur && out.length) {
        const from = subtractDuration(out[out.length - 1].datetime, dur);
        out = out.filter(f => f.datetime >= from);
    }
    const step = Math.max(1, Math.floor(Number(opts.step) || 1));
    if (step > 1) {
        const last = out.length - 1;
        out = out.filter((_, i) => (last - i) % step === 0);
    }
    return out;
}

/**
 * Index of the frame nearest a date; ties go to the earlier frame.
 * @param {Frame[]} frames
 * @param {string} date
 * @returns {number} -1 when there are no frames or the date is invalid
 */
export function nearestFrameIndex(frames, date) {
    const target = normalizeDate(date);
    if (!frames.length || !target) return -1;
    const t = Date.parse(target);
    let best = 0;
    let bestGap = Infinity;
    frames.forEach((f, i) => {
        const gap = Math.abs(Date.parse(f.datetime) - t);
        if (gap < bestGap) { best = i; bestGap = gap; }
    });
    return best;
}

/**
 * Accept YYYY-MM-DD, YYYY-MM, or a full ISO datetime; return YYYY-MM-DD.
 * @param {string} s
 * @returns {string|null}
 */
export function normalizeDate(s) {
    if (typeof s !== 'string') return null;
    const m = s.trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!m) return null;
    return validDate(`${m[1]}-${m[2]}-${m[3] || '01'}`);
}

function validDate(iso) {
    const t = Date.parse(`${iso}T00:00:00Z`);
    return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? null : iso;
}

function sortFrames(frames) {
    const byDate = new Map();
    for (const f of frames) byDate.set(f.datetime, f);   // one frame per date
    return [...byDate.values()].sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
}

function decodeXml(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
