import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The preview publishes app/ as the page's own folder, so a relative import
// that leaves app/ points at nothing there and stops the app before it starts.
// glen core imports app/; app/ never imports core/.
describe('app/ module imports', () => {
    const dir = join(__dirname, '..', 'app');
    const files = readdirSync(dir).filter(f => f.endsWith('.js'));

    it.each(files)('%s imports nothing outside app/', (f) => {
        const src = readFileSync(join(dir, f), 'utf8');
        const specs = [...src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
            .map(m => m[1] || m[2]);
        expect(specs.filter(s => s.startsWith('../'))).toEqual([]);
    });
});
