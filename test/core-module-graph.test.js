import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module reachable from `entry` through static relative imports. */
function staticGraph(entry) {
    const seen = new Set();
    const visit = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        const src = readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) {
            visit(resolve(dirname(file), m[1]));
        }
        for (const m of src.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) {
            visit(resolve(dirname(file), m[1]));
        }
    };
    visit(resolve(root, entry));
    return [...seen].map(f => relative(root, f)).sort();
}

/** Every module reachable from `entries`, through static imports and import() alike. */
function fullGraph(entries) {
    const seen = new Set();
    const visit = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        const src = readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|^\s*import\s+)['"](\.[^'"]+)['"]/gm)) {
            visit(resolve(dirname(file), m[1]));
        }
    };
    for (const e of entries) visit(resolve(root, e));
    return [...seen].map(f => relative(root, f));
}

describe('glen core module graph', () => {
    const graph = staticGraph('core/main.js');

    it('loads glen-harness from a release tag, not the full app\'s agent or chat', () => {
        const main = readFileSync(resolve(root, 'core/main.js'), 'utf8');
        const urls = [...main.matchAll(/from '(https:\/\/cdn\.jsdelivr\.net\/gh\/SchmidtDSE\/glen-harness@([^/]+)\/[^']+)'/g)];
        expect(urls.map(m => m[1].split('@')[1].replace(/^[^/]+/, ''))).toEqual(['/src/core.js', '/ui/chat-ui.js']);
        // One tag for both, and a tag rather than a branch.
        expect(new Set(urls.map(m => m[2])).size).toBe(1);
        expect(urls[0][2]).toMatch(/^v\d+\.\d+\.\d+$/);
    });

    it('loads no SQL or chart code at start', () => {
        for (const f of ['app/query-filter-tool.js', 'app/hex-tools.js', 'app/chart-renderer.js', 'app/chart-tool.js']) {
            expect(graph).not.toContain(f);
        }
    });

    it('uses the shared map-control tools and catalog walk', () => {
        expect(graph).toContain('app/map-control-tools.js');
        expect(graph).toContain('app/catalog-tree.js');
    });

    // Since v4, app/ is glen core's shared library: a module that neither
    // core nor a plugin reaches is dead code (SchmidtDSE/glen#441).
    it('reaches every app/ module from core or a plugin', () => {
        const plugins = readdirSync(resolve(root, 'core/plugins')).filter(f => f.endsWith('.js')).map(f => `core/plugins/${f}`);
        const reached = new Set(fullGraph(['core/main.js', ...plugins]));
        const app = readdirSync(resolve(root, 'app')).filter(f => f.endsWith('.js')).map(f => `app/${f}`);
        expect(app.filter(f => !reached.has(f))).toEqual([]);
    });
});
