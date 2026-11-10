import { describe, it, expect } from 'vitest';
import {
    rewriteHref, routeHint, parquetPath, isQueryableAsset, formatColumns,
    formatParquetAssets, formatCollection, pyRepr, pyStr,
} from '../app/stac-details.js';

describe('S3 paths', () => {
    it('rewrites the built-in sources and leaves other hosts alone', () => {
        expect(rewriteHref('https://s3-west.nrp-nautilus.io/public-cpad/cpad.parquet')).toBe('s3://public-cpad/cpad.parquet');
        expect(rewriteHref('https://data.source.coop/cboettig/x.parquet')).toBe('s3://us-west-2.opendata.source.coop/cboettig/x.parquet');
        expect(rewriteHref('https://minio.example.org/b/x.parquet')).toBe('https://minio.example.org/b/x.parquet');
    });

    it('takes an app\'s own sources', () => {
        const sources = [{ https_prefix: 'https://minio.example.org/', s3_prefix: 's3://' }];
        expect(parquetPath('https://minio.example.org/b/hex/', sources)).toEqual({ path: 's3://b/hex/**', hint: null });
    });

    it('derives a routing hint for an unknown host, as the server does', () => {
        expect(routeHint('https://minio.example.org/b/k/x.parquet')).toEqual({ path: 's3://b/k/x.parquet', endpoint: 'minio.example.org', scope: 's3://b' });
        expect(routeHint('https://bkt.s3.us-west-2.amazonaws.com/k.parquet')).toEqual({ path: 's3://bkt/k.parquet', endpoint: 's3.us-west-2.amazonaws.com', scope: 's3://bkt' });
        expect(routeHint('https://host/onlybucket')).toBeNull();
        expect(parquetPath('https://minio.example.org/b/x.parquet').hint.endpoint).toBe('minio.example.org');
    });

    it('treats parquet files and hex directories as queryable, not tiles or rasters', () => {
        expect(isQueryableAsset({ href: 'https://x/a.parquet' })).toBe(true);
        expect(isQueryableAsset({ href: 'https://x/hex/' })).toBe(true);
        expect(isQueryableAsset({ href: 'https://x/a.pmtiles' })).toBe(false);
        expect(isQueryableAsset({ href: 'https://x/a.tif', type: 'image/tiff' })).toBe(false);
    });
});

describe('Python-style values', () => {
    it('prints values as the server did', () => {
        expect(pyRepr([1, 'a', true, null, { k: 'v' }])).toBe("[1, 'a', True, None, {'k': 'v'}]");
        expect(pyStr('mixed (per-row)')).toBe('mixed (per-row)');
        expect(pyStr([8, 6])).toBe('[8, 6]');
    });
});

describe('formatCollection', () => {
    const col = {
        id: 'cpad', title: 'CPAD', description: 'Protected areas.',
        assets: {
            parquet: {
                href: 'https://s3-west.nrp-nautilus.io/public-cpad/cpad.parquet', type: 'application/vnd.apache.parquet',
                title: 'Holdings', 'file:size': 2 * 1024 ** 3,
                'table:columns': [{ name: 'ACCESS_TYP', type: 'string', description: 'Access', values: ['Open', 'No'] }, { name: 'geometry', type: 'binary' }],
            },
            hex: {
                href: 'https://s3-west.nrp-nautilus.io/public-cpad/hex/', type: 'application/vnd.apache.parquet',
                'h3:native_resolution': 10,
                'table:columns': [{ name: 'ACCESS_TYP' }, { name: 'h10', type: 'string' }],
            },
            tiles: { href: 'https://s3-west.nrp-nautilus.io/public-cpad/cpad.pmtiles' },
        },
    };

    it('lists each table once with its columns, and every description once', () => {
        const md = formatCollection(col, { url: 'https://s3-west.nrp-nautilus.io/public-cpad/stac-collection.json' });
        expect(md).toContain('collection_url: `https://s3-west.nrp-nautilus.io/public-cpad/stac-collection.json`');
        expect(md).toContain("  - Holdings (2.00 GiB): `read_parquet('s3://public-cpad/cpad.parquet')`");
        expect(md).toContain("  - hex: `read_parquet('s3://public-cpad/hex/**')`");
        expect(md).toContain('    - h3:native_resolution: 10');
        expect(md).toContain('    - columns: `ACCESS_TYP` (string), `geometry` (binary)');
        expect(md.match(/`ACCESS_TYP` \(string\) — Access/g)).toHaveLength(1);
        expect(md).toContain("      values: ['Open', 'No']");
        expect(md).not.toContain('pmtiles');
        expect(md).not.toContain('Key columns');
    });

    it('falls back to collection-level columns when no table describes its own', () => {
        const md = formatCollection({
            id: 'c', assets: { p: { href: 'https://s3-west.nrp-nautilus.io/b/x.parquet' } },
            'table:columns': [{ name: 'GEOID', type: 'string' }],
        });
        expect(md).toContain('\nKey columns:\n    - `GEOID` (string)');
    });

    it('lists sub-datasets compactly, including those with no tables', () => {
        const md = formatCollection({ id: 'parent', title: 'Parent', assets: {} }, {
            children: [
                { id: 'a', title: 'A', assets: { p: { href: 'https://s3-west.nrp-nautilus.io/b/a.parquet', 'table:columns': [{ name: 'x' }] } } },
                { id: 'rasters', title: 'Rasters', assets: {} },
            ],
        });
        expect(md).toContain('**Sub-datasets (2):**');
        expect(md).toContain("*A* (`a`):\n  - p: `read_parquet('s3://b/a.parquet')`\n  - columns: call get_stac_details('a')");
        expect(md).toContain("*Rasters* (`rasters`):\n  - columns: call get_stac_details('rasters')");
        expect(md).not.toContain('`x`');
    });

    it('takes descriptions from the collection when the assets list only names and types (#441)', () => {
        const md = formatCollection({
            id: 'fee', 'table:columns': [{ name: 'GAP_Sts', type: 'string', description: 'GAP status', values: ['1', '2'] }],
            assets: {
                parquet: { href: 'https://s3-west.nrp-nautilus.io/b/fee.parquet', 'table:columns': [{ name: 'GAP_Sts', type: 'string' }] },
                hex: { href: 'https://s3-west.nrp-nautilus.io/b/hex/', 'table:columns': [{ name: 'GAP_Sts', type: 'string' }, { name: 'h8', type: 'string' }] },
            },
        });
        expect(md).toContain('    - `GAP_Sts` (string) — GAP status');
        expect(md).toContain("      values: ['1', '2']");
        expect(md).not.toContain('Key columns');
    });

    it('formatColumns hides geometry columns', () => {
        expect(formatColumns([{ name: 'geom' }, { name: 'BBOX' }, { name: 'n', type: 'int' }])).toEqual(['    - `n` (int)']);
    });

    it('notes the endpoint for a table on an unknown host', () => {
        const lines = formatParquetAssets({ assets: { p: { href: 'https://minio.example.org/b/x.parquet' } } });
        expect(lines[0]).toBe("  - p: `read_parquet('s3://b/x.parquet')`");
        expect(lines[1]).toContain("s3_endpoint='minio.example.org', s3_scope='s3://b'");
    });
});
