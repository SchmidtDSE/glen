import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('glen core module graph', () => {
    const graph = staticGraph('core/main.js');

    it('loads glen-harness from a release tag, not the full app\'s agent or chat', () => {
        const main = readFileSync(resolve(root, 'core/main.js'), 'utf8');
        const urls = [...main.matchAll(/from '(https:\/\/cdn\.jsdelivr\.net\/gh\/SchmidtDSE\/glen-harness@([^/]+)\/[^']+)'/g)];
        expect(urls.map(m => m[1].split('@')[1].replace(/^[^/]+/, ''))).toEqual(['/src/core.js', '/ui/chat-ui.js']);
        // One tag for both, and a tag rather than a branch.
        expect(new Set(urls.map(m => m[2])).size).toBe(1);
        expect(urls[0][2]).toMatch(/^v\d+\.\d+\.\d+$/);
        for (const f of ['app/agent.js', 'app/chat-ui.js', 'app/tool-registry.js']) {
            expect(graph).not.toContain(f);
        }
    });

    it('loads no MCP, SQL, export or chart code at start', () => {
        for (const f of [
            'app/mcp-client.js', 'app/vendor/mcp-sdk.js', 'app/map-tools.js',
            'app/chart-renderer.js', 'app/export-report.js',
        ]) {
            expect(graph).not.toContain(f);
        }
    });

    it('shares the map-control tools with the full app', () => {
        expect(graph).toContain('app/map-control-tools.js');
        expect(staticGraph('app/map-tools.js')).toContain('app/map-control-tools.js');
    });
});
