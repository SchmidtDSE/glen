import { describe, it, expect } from 'vitest';
import {
    rewriteHref, routeHint, parquetPath, isQueryableAsset, formatColumns,
    formatParquetAssets, formatCollection, formatItems, pyRepr, pyStr,
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

    it('describes a table without its own columns by the collection\'s, once (#441)', () => {
        const md = formatCollection({
            id: 'c', assets: { p: { href: 'https://s3-west.nrp-nautilus.io/b/x.parquet' } },
            'table:columns': [{ name: 'GEOID', type: 'string', description: 'Census GEOID' }],
        });
        expect(md).toContain("  - p: `read_parquet('s3://b/x.parquet')`\n    - columns: `GEOID` (string)");
        expect(md.match(/Census GEOID/g)).toHaveLength(1);
        expect(md).not.toContain('Key columns');
    });

    it('lists the collection\'s columns as Key columns when it has no tables', () => {
        const md = formatCollection({
            id: 'c', assets: { cog: { href: 'https://s3-west.nrp-nautilus.io/b/x.tif', type: 'image/tiff' } },
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

    it('describes an asset without its own list by the collection\'s (#441)', () => {
        const md = formatCollection({
            id: 'wcb', 'table:columns': [{ name: 'ProjectID', type: 'string', description: 'WCB project id' }, { name: 'Acres', type: 'double', description: 'Project acres' }],
            assets: {
                parquet: { href: 'https://s3-west.nrp-nautilus.io/b/wcb.parquet', type: 'application/vnd.apache.parquet' },
                hex: { href: 'https://s3-west.nrp-nautilus.io/b/hex/', 'table:columns': [{ name: 'ProjectID', type: 'string' }, { name: 'h8', type: 'string' }] },
            },
        });
        expect(md).toContain("  - parquet: `read_parquet('s3://b/wcb.parquet')`\n    - columns: `ProjectID` (string), `Acres` (double)");
        expect(md).toContain('    - `Acres` (double) — Project acres');
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

describe('STAC items (#462)', () => {
    const URL = 'https://h/cat/heat/collection.json';
    const col = {
        id: 'heat', title: 'Heat',
        extent: { temporal: { interval: [['2025-06-15T00:00:00Z', '2025-08-31T23:59:59Z']] } },
        links: [{ rel: 'item', href: './a/a.json' }, { rel: 'item', href: './b/b.json' }, { rel: 'root', href: '../catalog.json' }],
        assets: { mirror: { href: './items.parquet', type: 'application/vnd.apache.parquet', roles: ['collection-mirror'], title: 'STAC items as GeoParquet' } },
    };
    const item = {
        id: 'a',
        assets: {
            data: { href: './a.tif', type: 'image/tiff; application=geotiff', bands: [{ name: 'tmax_c', unit: 'Cel' }, {}] },
            table: { href: './a.parquet', type: 'application/vnd.apache.parquet' },
        },
    };

    it('says how many items, their extent, the first item\'s assets, and where the full list is', () => {
        expect(formatItems(col, item, { sampleUrl: 'https://s3-west.nrp-nautilus.io/b/heat/a/a.json' })).toEqual([
            '\n**Items (2)**, 2025-06-15 to 2025-08-31.',
            "First item's assets (`a`):",
            '  - `data`: COG, 2 bands: `tmax_c` (Cel), `band 2`',
            "  - `table`: GeoParquet, this item's: `read_parquet('s3://b/heat/a/a.parquet')`",
            "The item list, with every item's dates and asset hrefs, is the items GeoParquet above.",
        ]);
    });

    it('prints only the count without a sample item or extent, and nothing without items', () => {
        expect(formatItems({ links: col.links }, null)).toEqual(['\n**Items (2)**.']);
        expect(formatItems({ links: [] }, item)).toEqual([]);
    });

    it('closes the collection text, after its SQL data', () => {
        const text = formatCollection(col, { url: URL, sampleItem: { doc: item, url: 'https://h/cat/heat/a/a.json' } });
        expect(text.indexOf('SQL data')).toBeLessThan(text.indexOf('**Items (2)**'));
        expect(formatCollection({ id: 'x', links: [] }, {})).not.toContain('Items');
    });
});
