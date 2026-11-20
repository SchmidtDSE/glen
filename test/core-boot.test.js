// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { initialView, loadHighlighter, HIGHLIGHT_THEME } from '../core/boot.js';

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
