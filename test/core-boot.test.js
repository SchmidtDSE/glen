// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { initialView, loadHighlighter, HIGHLIGHT_THEME, addScripts, addStylesheets, glenStylesheets, PAGE_SCRIPTS, PAGE_STYLESHEETS } from '../core/boot.js';

describe('initialView', () => {
    it('opens on the whole world without a view', () => {
        expect(initialView(undefined)).toEqual({ center: [0, 20], zoom: 2, pitch: 0, bearing: 0, globe: false });
    });
    it('opens a center with no zoom at zoom 6, as the full app did', () => {
        expect(initialView({ center: [-119.4, 36.8] })).toMatchObject({ center: [-119.4, 36.8], zoom: 6 });
    });
    it('keeps a zoom the app gives, zero included', () => {
        expect(initialView({ center: [1, 2], zoom: 0 }).zoom).toBe(0);
        expect(initialView({ zoom: 4 }).zoom).toBe(4);
        expect(initialView({ pitch: 30, bearing: 10, globe: true })).toMatchObject({ pitch: 30, bearing: 10, globe: true });
    });
});

describe('loadHighlighter', () => {
    const SCRIPTS = [
        { global: 'marked', src: 'https://cdn.example/marked.js', integrity: 'sha384-m' },
        { global: 'hljs', src: 'https://cdn.example/highlight.js/11.9.0/highlight.min.js', integrity: 'sha384-h' },
        { src: 'https://cdn.example/highlight.js/11.9.0/languages/sql.min.js', integrity: 'sha384-s' },
    ];
    let observer;
    afterEach(() => {
        observer?.disconnect();
        document.head.innerHTML = '';
        vi.restoreAllMocks();
    });

    // jsdom does not fetch scripts, so each one loads (or fails) as it is added.
    const settle = (how) => {
        observer = new MutationObserver((records) => {
            for (const r of records) for (const n of r.addedNodes) if (n.tagName === 'SCRIPT') setTimeout(() => n[how]());
        });
        observer.observe(document.head, { childList: true });
    };

    it('adds highlight.js, its SQL grammar and its theme, and leaves the other scripts alone', async () => {
        settle('onload');
        expect(await loadHighlighter(SCRIPTS, { win: {} })).toBe(true);
        const scripts = [...document.head.querySelectorAll('script')];
        expect(scripts.map(s => s.src)).toEqual([SCRIPTS[1].src, SCRIPTS[2].src]);
        expect(scripts[0].integrity).toBe('sha384-h');
        expect(scripts[0].crossOrigin).toBe('anonymous');
        expect(document.head.querySelector('link').href).toBe(HIGHLIGHT_THEME.href);
    });

    it('does nothing when the page already has hljs', async () => {
        expect(await loadHighlighter(SCRIPTS, { win: { hljs: {} } })).toBe(false);
        expect(document.head.children).toHaveLength(0);
    });

    it('goes on when a script fails to load', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        settle('onerror');
        await loadHighlighter(SCRIPTS, { win: {} });
        expect(document.head.querySelectorAll('script')).toHaveLength(2);
        expect(console.warn).toHaveBeenCalledTimes(2);
    });
});

describe('loadStylesheets: the harness chat.css in glen\'s place in the cascade (SchmidtDSE/glen#510)', () => {
    const H = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v9.9.9/ui/chat.css';
    let loadStylesheets;
    beforeAll(async () => { ({ loadStylesheets } = await import('../core/boot.js')); });
    beforeEach(() => {
        document.head.innerHTML = `
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.2.0/app/style.css">
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.2.0/app/chat.css">
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.2.0/app/sidebar.css">`;
    });
    const order = () => [...document.head.querySelectorAll('link')].map(l => l.href.split('/').slice(-2).join('/'));
    const fire = (type) => document.head.querySelectorAll(`link[href="${H}"]`).forEach(l => l.dispatchEvent(new Event(type)));

    it('goes just before glen\'s chat.css, and resolves when it loads', async () => {
        const p = loadStylesheets([H]);
        expect(order()).toEqual(['app/style.css', 'ui/chat.css', 'app/chat.css', 'app/sidebar.css']);
        fire('load');
        await expect(p).resolves.toBeUndefined();
    });

    it('resolves when a sheet fails, so the app still starts', async () => {
        const p = loadStylesheets([H]);
        fire('error');
        await expect(p).resolves.toBeUndefined();
    });

    it('goes before the first stylesheet on a page without glen\'s chat.css', async () => {
        document.head.innerHTML = '<style>.x{}</style><link rel="stylesheet" href="https://example.org/app.css">';
        const p = loadStylesheets([H]);
        expect(document.head.firstElementChild.getAttribute('href')).toBe(H);
        fire('load');
        await p;
    });

    it('leaves a sheet the page already loads alone', async () => {
        document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${H}">`);
        await loadStylesheets([H]);
        expect(document.head.querySelectorAll(`link[href="${H}"]`)).toHaveLength(1);
    });
});

describe('the page\'s libraries and stylesheets (SchmidtDSE/glen#511)', () => {
    const fresh = (head = '') => {
        const doc = document.implementation.createHTMLDocument('t');
        doc.head.innerHTML = head;
        return doc;
    };
    // jsdom does not fetch; fire each added tag's load event by hand.
    const settle = (doc) => doc.querySelectorAll('script, link').forEach((el) => el.onload?.());

    it('pins each library with a version and an integrity hash', () => {
        for (const s of [...PAGE_SCRIPTS, ...PAGE_STYLESHEETS]) {
            expect(s.src || s.href).toMatch(/@\d+\.\d+\.\d+\//);
            expect(s.integrity).toMatch(/^sha384-/);
        }
        expect(PAGE_SCRIPTS.map((s) => s.global)).toEqual(['maplibregl', 'pmtiles']);
    });

    it('adds a script per missing library, with its hash, and skips what the page has', async () => {
        const doc = fresh('<script src="https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js"></script>');
        const done = addScripts([...PAGE_SCRIPTS, { global: 'marked', src: 'https://x/marked.js', integrity: 'sha384-m' }], { doc, win: { marked: {} } });
        const added = [...doc.querySelectorAll('script')].slice(1);
        expect(added.map((s) => s.src)).toEqual([PAGE_SCRIPTS[0].src]);
        expect(added[0].integrity).toBe(PAGE_SCRIPTS[0].integrity);
        expect(added[0].crossOrigin).toBe('anonymous');
        settle(doc);
        await done;
    });

    it('loads a script with no global after the one before it', async () => {
        const doc = fresh();
        const done = addScripts([
            { global: 'hljs', src: 'https://x/hl.js', integrity: 'sha384-a' },
            { src: 'https://x/sql.js', integrity: 'sha384-b' },
        ], { doc, win: {} });
        expect(doc.querySelectorAll('script')).toHaveLength(1);
        doc.querySelector('script').onload();
        await new Promise((r) => setTimeout(r, 0));
        expect([...doc.querySelectorAll('script')].map((s) => s.src)).toEqual(['https://x/hl.js', 'https://x/sql.js']);
        settle(doc);
        await done;
    });

    it('resolves when a script fails, with a warning', async () => {
        const doc = fresh();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const done = addScripts([PAGE_SCRIPTS[0]], { doc, win: {} });
        doc.querySelector('script').onerror();
        await done;
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('maplibre-gl'));
        warn.mockRestore();
    });

    it('puts glen\'s stylesheets before the page\'s own, and skips one the page links by a relative path', async () => {
        const base = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.5.0/core/boot.js';
        const sheets = [...PAGE_STYLESHEETS, ...glenStylesheets(base)];
        expect(sheets.map((s) => s.href).slice(1)).toEqual(['style.css', 'chat.css', 'sidebar.css']
            .map((f) => `https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.5.0/app/${f}`));
        const doc = fresh('<base href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.5.0/core/"><link rel="stylesheet" href="../app/chat.css"><link rel="stylesheet" href="https://example.org/mine.css">');
        const done = addStylesheets(sheets, { doc });
        const hrefs = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
        expect(hrefs).toEqual([
            PAGE_STYLESHEETS[0].href,
            'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.5.0/app/style.css',
            'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v4.5.0/app/sidebar.css',
            '../app/chat.css',
            'https://example.org/mine.css',
        ]);
        expect(doc.querySelector('link').integrity).toBe(PAGE_STYLESHEETS[0].integrity);
        settle(doc);
        await done;
    });
});
