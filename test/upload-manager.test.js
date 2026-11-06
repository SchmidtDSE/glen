import { describe, it, expect } from 'vitest';
import {
    validateUploadGeoJSON,
    explodeMultiPoints,
    allPropertyKeys,
    pointHexSql,
    POINT_CELL_COLUMNS,
    computeBounds,
    pickTooltipFields,
    buildObjectUrl,
    contentHash,
} from '../app/upload-manager.js';

const poly = (coords, props = {}) => ({
    type: 'Feature', properties: props,
    geometry: { type: 'Polygon', coordinates: coords },
});
const SQUARE = [[[-122.3, 37.8], [-122.2, 37.8], [-122.2, 37.9], [-122.3, 37.9], [-122.3, 37.8]]];

describe('validateUploadGeoJSON', () => {
    it('accepts a FeatureCollection of polygons', () => {
        const r = validateUploadGeoJSON({ type: 'FeatureCollection', features: [poly(SQUARE)] });
        expect(r.ok).toBe(true);
        expect(r.kind).toBe('polygon');
        expect(r.geometryTypes).toEqual(['Polygon']);
        expect(r.features).toHaveLength(1);
    });

    it('accepts a bare Feature and a MultiPolygon', () => {
        expect(validateUploadGeoJSON(poly(SQUARE)).ok).toBe(true);
        const mp = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [SQUARE] } };
        const r = validateUploadGeoJSON(mp);
        expect(r.ok).toBe(true);
        expect(r.geometryTypes).toEqual(['MultiPolygon']);
    });

    it('rejects non-objects and wrong top-level types', () => {
        expect(validateUploadGeoJSON(null).ok).toBe(false);
        expect(validateUploadGeoJSON({ type: 'Point' }).ok).toBe(false);
    });

    it('rejects empty collections', () => {
        expect(validateUploadGeoJSON({ type: 'FeatureCollection', features: [] }).ok).toBe(false);
    });

    it('rejects geometry other than polygons or points, steering to data-ingest', () => {
        const line = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } };
        const r = validateUploadGeoJSON(line);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/data-ingest/i);
    });

    it('rejects a feature missing geometry', () => {
        const r = validateUploadGeoJSON({ type: 'Feature', properties: {} });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/missing geometry/i);
    });

    it('enforces the feature cap', () => {
        const many = { type: 'FeatureCollection', features: Array.from({ length: 5 }, () => poly(SQUARE)) };
        const r = validateUploadGeoJSON(many, { maxFeatures: 3 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/too many features/i);
    });
});

describe('computeBounds', () => {
    it('computes [w,s,e,n] over polygon coordinates', () => {
        expect(computeBounds(poly(SQUARE))).toEqual([-122.3, 37.8, -122.2, 37.9]);
    });

    it('spans multiple features', () => {
        const other = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
        const fc = { type: 'FeatureCollection', features: [poly(SQUARE), poly(other)] };
        expect(computeBounds(fc)).toEqual([-122.3, 0, 1, 37.9]);
    });

    it('returns null when there are no coordinates', () => {
        expect(computeBounds({ type: 'FeatureCollection', features: [] })).toBeNull();
    });
});

describe('pickTooltipFields', () => {
    it('unions property keys across features', () => {
        const feats = [poly(SQUARE, { a: 1, b: 2 }), poly(SQUARE, { b: 3, c: 4 })];
        expect(pickTooltipFields(feats)).toEqual(['a', 'b', 'c']);
    });

    it('caps the number of keys', () => {
        const feats = [poly(SQUARE, { a: 1, b: 2, c: 3, d: 4 })];
        expect(pickTooltipFields(feats, 2)).toEqual(['a', 'b']);
    });

    it('tolerates features without properties', () => {
        expect(pickTooltipFields([{ geometry: {} }])).toEqual([]);
    });
});

describe('buildObjectUrl', () => {
    it('builds a stable public URL and tolerates a trailing slash', () => {
        expect(buildObjectUrl('https://s3.example/bucket', 'uploads', 'abc123'))
            .toBe('https://s3.example/bucket/uploads/abc123/data.geojson');
        expect(buildObjectUrl('https://s3.example/bucket/', 'uploads', 'abc123'))
            .toBe('https://s3.example/bucket/uploads/abc123/data.geojson');
    });
});

describe('contentHash', () => {
    it('is deterministic, 16 hex chars, and content-addressed', async () => {
        const a = await contentHash('{"hello":"world"}');
        const b = await contentHash('{"hello":"world"}');
        const c = await contentHash('{"hello":"there"}');
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toMatch(/^[0-9a-f]{16}$/);
    });
});

const pt = (lon, lat, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const fc = (features) => ({ type: 'FeatureCollection', features });

describe('point uploads (#435)', () => {
    it('accepts points, with their own larger cap', () => {
        const many = fc(Array.from({ length: 2000 }, (_, i) => pt(-122 + i * 1e-4, 37)));
        const r = validateUploadGeoJSON(many);
        expect(r.ok).toBe(true);
        expect(r.kind).toBe('point');
        expect(r.features).toHaveLength(2000);
        expect(validateUploadGeoJSON(many, { maxPointFeatures: 1999 }).error).toMatch(/too many points/i);
    });

    it('splits MultiPoints into Points that keep their properties, and caps the split count', () => {
        const mp = { type: 'Feature', properties: { sp: 'x' }, geometry: { type: 'MultiPoint', coordinates: [[-122, 37], [-121, 38]] } };
        const r = validateUploadGeoJSON(fc([mp, pt(-120, 36)]));
        expect(r.ok).toBe(true);
        expect(r.geometryTypes).toEqual(['MultiPoint', 'Point']);
        expect(r.features.map(f => f.geometry.type)).toEqual(['Point', 'Point', 'Point']);
        expect(r.features[1]).toMatchObject({ properties: { sp: 'x' }, geometry: { coordinates: [-121, 38] } });
        expect(validateUploadGeoJSON(fc([mp]), { maxPointFeatures: 1 }).ok).toBe(false);
    });

    it('rejects a mix of points and polygons', () => {
        const r = validateUploadGeoJSON(fc([pt(0, 0), poly(SQUARE)]));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/separate files/);
    });

    it('rejects missing, projected or swapped coordinates', () => {
        expect(validateUploadGeoJSON(pt(NaN, 0)).error).toMatch(/no valid coordinates/);
        expect(validateUploadGeoJSON(fc([{ type: 'Feature', geometry: { type: 'Point' } }])).ok).toBe(false);
        expect(validateUploadGeoJSON(pt(37.8, -122.3)).error).toMatch(/swapped or projected/);
        expect(validateUploadGeoJSON(pt(500000, 4200000)).ok).toBe(false);
        expect(validateUploadGeoJSON(fc([{ type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [] } }])).error)
            .toMatch(/no points/);
    });

    it('leaves Points alone when splitting', () => {
        const p = pt(1, 2);
        expect(explodeMultiPoints([p])[0]).toBe(p);
    });

    it('collects every property key, uncapped', () => {
        const fs = Array.from({ length: 12 }, (_, i) => pt(0, 0, { [`k${i}`]: i }));
        expect(allPropertyKeys([...fs, pt(0, 0), { type: 'Feature' }])).toHaveLength(12);
    });

    it('computes cells the cng-datasets way: h10 from the point, every parent from h10', () => {
        expect(POINT_CELL_COLUMNS).toEqual(['h10', 'h9', 'h8', 'h7', 'h6', 'h5', 'h4', 'h3', 'h2', 'h1', 'h0']);
        const sql = pointHexSql('https://b.example/uploads/abc/data.geojson', ['species']);
        expect(sql).toContain("ST_Read('https://b.example/uploads/abc/data.geojson')");
        expect(sql).toContain('h3_latlng_to_cell(ST_Y(geom), ST_X(geom), 10) AS h10');
        for (let r = 9; r >= 0; r--) expect(sql).toContain(`h3_cell_to_parent(h10, ${r}) AS h${r}`);
        // Parents never come from the coordinate (data-workflows #697).
        expect(sql.match(/h3_latlng_to_cell/g)).toHaveLength(1);
        expect(sql).not.toContain('EXCLUDE');
    });

    it('drops a property that clashes with a cell column, and quotes the URL', () => {
        const sql = pointHexSql("https://b.example/it's.geojson", ['h8', 'name', 'h0']);
        expect(sql).toContain('SELECT * EXCLUDE ("h8", "h0"), h3_latlng_to_cell');
        expect(sql).toContain("ST_Read('https://b.example/it''s.geojson')");
    });
});
