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

    it('loads the vendored harness, not the full app\'s agent or chat', () => {
        expect(graph).toContain('app/vendor/glen-harness/src/core.js');
        expect(graph).toContain('app/vendor/glen-harness/ui/chat-ui.js');
        for (const f of ['app/agent.js', 'app/chat-ui.js', 'app/tool-registry.js']) {
            expect(graph).not.toContain(f);
        }
    });

    it('loads no MCP, SQL, export or chart code at start', () => {
        for (const f of [
            'app/mcp-client.js', 'app/vendor/mcp-sdk.js', 'app/map-tools.js',
            'app/chart-renderer.js', 'app/export-report.js',
            'app/vendor/glen-harness/ui/export-report.js',
        ]) {
            expect(graph).not.toContain(f);
        }
    });

    it('shares the map-control tools with the full app', () => {
        expect(graph).toContain('app/map-control-tools.js');
        expect(staticGraph('app/map-tools.js')).toContain('app/map-control-tools.js');
    });
});
