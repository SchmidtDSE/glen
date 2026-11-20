import { describe, it, expect } from 'vitest';
import { HARNESS_TAG, harnessBase, harnessUrl } from '../core/harness.js';

const RELEASE = `https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@${HARNESS_TAG}/`;
const page = (href, extra = {}) => {
    const u = new URL(href);
    return { location: { href: u.href, hostname: u.hostname, search: u.search }, ...extra };
};

describe('where glen core loads glen-harness from (SchmidtDSE/glen#511)', () => {
    it('pins one release tag', () => {
        expect(HARNESS_TAG).toMatch(/^v\d+\.\d+\.\d+$/);
    });

    it('uses the release on jsDelivr by default', () => {
        expect(harnessBase(page('https://example.org/app/'))).toBe(RELEASE);
        expect(harnessUrl('src/core.js', page('https://example.org/app/'))).toBe(`${RELEASE}src/core.js`);
        expect(harnessBase({})).toBe(RELEASE);
    });

    it('takes a base URL the page sets, adding the trailing slash', () => {
        const win = page('https://example.org/app/', { GLEN_HARNESS_URL: 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@abc1234' });
        expect(harnessUrl('ui/deps.js', win)).toBe('https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@abc1234/ui/deps.js');
    });

    it('resolves a relative base against the page', () => {
        const win = page('http://localhost:8000/core/', { GLEN_HARNESS_URL: '../../glen-harness/' });
        expect(harnessBase(win)).toBe('http://localhost:8000/glen-harness/');
    });

    it('takes ?harness= on localhost', () => {
        for (const host of ['localhost:8000', '127.0.0.1:8000']) {
            const win = page(`http://${host}/core/?harness=http://localhost:8001/`);
            expect(harnessUrl('src/core.js', win)).toBe('http://localhost:8001/src/core.js');
        }
    });

    it('ignores ?harness= on any other host, so a link cannot load other code into an app', () => {
        const win = page('https://schmidtdse.github.io/glen/preview/x/?harness=https://evil.example/');
        expect(harnessBase(win)).toBe(RELEASE);
    });

    it('prefers what the page sets over the address', () => {
        const win = page('http://localhost:8000/core/?harness=http://localhost:9/', { GLEN_HARNESS_URL: 'http://localhost:8001/' });
        expect(harnessBase(win)).toBe('http://localhost:8001/');
    });
});
