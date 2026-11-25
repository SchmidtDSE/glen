import { describe, it, expect, vi } from 'vitest';
import { appPromptUrl, loadPrompts } from '../core/prompt.js';

const BASE = 'https://cdn/glen@v4/core/system-prompt.md';
const PAGE = 'https://app.example.org/';

/** A fetch over a fixed set of files; anything else is a 404. */
function files(map) {
    return vi.fn(async (url) => {
        const f = map[url];
        if (f === undefined) return { ok: false, status: 404, headers: new Map(), text: async () => 'Not found' };
        const [text, type = 'text/markdown'] = Array.isArray(f) ? f : [f];
        return { ok: true, status: 200, headers: new Map([['content-type', type]]), text: async () => text };
    });
}

describe('the app prompt beside core\'s', () => {
    it('reads system-prompt.md beside the page, after core\'s base prompt', async () => {
        const fetchFn = files({ [BASE]: '# Base', [`${PAGE}system-prompt.md`]: 'You help with protected lands.\n' });
        expect(await loadPrompts({}, { baseUrl: BASE, pageUrl: PAGE, fetchFn })).toBe('# Base\n\nYou help with protected lands.');
    });

    it('reads the file system_prompt_url names, relative to the page', async () => {
        const fetchFn = files({ [BASE]: '# Base', [`${PAGE}prompts/p.md`]: 'App' });
        expect(await loadPrompts({ system_prompt_url: 'prompts/p.md' }, { baseUrl: BASE, pageUrl: PAGE, fetchFn })).toBe('# Base\n\nApp');
    });

    it('takes the app prompt as text from system_prompt, and reads no file for it', async () => {
        const fetchFn = files({ [BASE]: '# Base', [`${PAGE}system-prompt.md`]: 'Not this one' });
        expect(await loadPrompts({ system_prompt: ' Coral reefs of Belize.\n' }, { baseUrl: BASE, pageUrl: PAGE, fetchFn })).toBe('# Base\n\nCoral reefs of Belize.');
        expect(await loadPrompts({ system_prompt: '' }, { baseUrl: BASE, pageUrl: PAGE, fetchFn })).toBe('# Base');
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(appPromptUrl({ system_prompt: '' }, BASE, PAGE)).toBeNull();
    });

    it('is fine without an app prompt, and takes no index page for one', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await loadPrompts({}, { baseUrl: BASE, pageUrl: PAGE, fetchFn: files({ [BASE]: '# Base' }) })).toBe('# Base');
        const spa = files({ [BASE]: '# Base', [`${PAGE}system-prompt.md`]: ['<!doctype html><html></html>', 'text/html'] });
        expect(await loadPrompts({}, { baseUrl: BASE, pageUrl: PAGE, fetchFn: spa })).toBe('# Base');
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('does not read core\'s own prompt twice on the page beside it', () => {
        expect(appPromptUrl({}, 'https://h/glen/core/system-prompt.md', 'https://h/glen/core/')).toBeNull();
        expect(appPromptUrl({}, BASE, PAGE)).toBe(`${PAGE}system-prompt.md`);
    });

    it('falls back to a short base prompt when core\'s cannot be read', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = await loadPrompts({}, { baseUrl: BASE, pageUrl: PAGE, fetchFn: files({ [`${PAGE}system-prompt.md`]: 'App' }) });
        expect(out).toMatch(/interactive map\.\n\nApp$/);
        warn.mockRestore();
    });
});
