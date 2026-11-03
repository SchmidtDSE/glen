import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { FramePlayer, formatDate } from '../app/frame-player.js';

const frames = Array.from({ length: 6 }, (_, i) => ({ datetime: `2026-01-0${i + 1}`, href: `f${i + 1}` }));

// Fake map ops: which frames are on the map, which is shown, and which have
// loaded. Frames load only when the test says so.
function makeOps() {
    const ops = {
        onMap: new Set(), shown: null, loaded: new Set(),
        ensure(f, role) { ops.onMap.add(f.datetime); if (role === 'show') ops.shown = f.datetime; },
        isLoaded(f) { return ops.loaded.has(f.datetime); },
        prune(keep) { ops.onMap = new Set([...ops.onMap].filter(d => keep.some(k => k.datetime === d))); },
        hidden: false,
        setVisible(v) { ops.hidden = !v; },
        cleared: false,
        clear() { ops.onMap.clear(); ops.cleared = true; },
    };
    return ops;
}

// A manual clock: run() fires the pending timer.
function makeClock() {
    const clock = {
        pending: null,
        setTimeout(fn, ms) { clock.pending = { fn, ms }; return 1; },
        clearTimeout() { clock.pending = null; },
        run() { const p = clock.pending; clock.pending = null; p?.fn(); return p?.ms; },
    };
    return clock;
}

const make = (config = {}, extra = {}) => {
    const ops = makeOps();
    const clock = makeClock();
    const player = new FramePlayer({ layerId: 'sst', frames, config: { preload: 2, ...config }, ops, clock, doc: null, ...extra });
    return { player, ops, clock };
};

describe('FramePlayer', () => {
    it('starts on the latest frame and preloads the next two', () => {
        const { player, ops } = make();
        expect(player.current.datetime).toBe('2026-01-06');
        expect(ops.shown).toBe('2026-01-06');
        // Looping: the frames after the last are the first two.
        expect([...ops.onMap].sort()).toEqual(['2026-01-01', '2026-01-02', '2026-01-06']);
    });

    it('starts on a configured default date', () => {
        const { player } = make({ default: '2026-01-03' });
        expect(player.current.datetime).toBe('2026-01-03');
    });

    it('plays from the start, waiting for each frame to load', () => {
        const { player, ops, clock } = make({ frame_ms: 300 });
        player.play();
        expect(player.current.datetime).toBe('2026-01-01');   // restarted from the last frame
        // Frame 2 has not loaded: the player holds frame 1 and checks again soon.
        expect(clock.run()).toBe(300);
        expect(player.current.datetime).toBe('2026-01-01');
        expect(player.waiting).toBe(true);
        expect(clock.pending.ms).toBe(100);
        ops.loaded.add('2026-01-02');
        clock.run();
        expect(player.current.datetime).toBe('2026-01-02');
        expect(player.waiting).toBe(false);
        expect(clock.pending.ms).toBe(300);
    });

    it('keeps only the frame on screen and those ahead on the map', () => {
        const { player, ops, clock } = make();
        frames.forEach(f => ops.loaded.add(f.datetime));
        player.play();
        clock.run(); clock.run();
        expect(player.current.datetime).toBe('2026-01-03');
        expect([...ops.onMap].sort()).toEqual(['2026-01-03', '2026-01-04', '2026-01-05']);
    });

    it('loops, or stops at the end when loop is off', () => {
        const looping = make();
        frames.forEach(f => looping.ops.loaded.add(f.datetime));
        looping.player.show(4);
        looping.player.playing = true;
        looping.clock.setTimeout(() => looping.player._tick(), 0);
        looping.clock.run(); looping.clock.run();
        expect(looping.player.current.datetime).toBe('2026-01-01');

        const once = make({ loop: false });
        frames.forEach(f => once.ops.loaded.add(f.datetime));
        once.player.play();
        for (let i = 0; i < 10; i++) once.clock.run();
        expect(once.player.current.datetime).toBe('2026-01-06');
        expect(once.player.playing).toBe(false);
    });

    it('setRange applies step and window and keeps the date when it can', () => {
        const { player } = make();
        player.setDate('2026-01-04');
        player.setRange({ step: 2 });
        expect(player.frames.map(f => f.datetime.slice(8))).toEqual(['02', '04', '06']);
        expect(player.current.datetime).toBe('2026-01-04');
        player.setRange({ step: 1, window: 'P1D' });
        expect(player.frames.map(f => f.datetime.slice(8))).toEqual(['05', '06']);
        expect(player.current.datetime).toBe('2026-01-06');
    });

    it('stepBy pauses and moves within bounds', () => {
        const { player } = make();
        player.play();
        player.stepBy(-1);
        expect(player.playing).toBe(false);
        expect(player.current.datetime).toBe('2026-01-01');   // play restarted at 01; -1 clamps
        player.stepBy(2);
        expect(player.current.datetime).toBe('2026-01-03');
    });

    it('hiding pauses and hides the frames without removing them', () => {
        const { player, ops } = make();
        player.play();
        const before = new Set(ops.onMap);
        player.setVisible(false);
        expect(player.playing).toBe(false);
        expect(ops.hidden).toBe(true);
        expect(ops.onMap).toEqual(before);
        player.setVisible(true);
        expect(ops.hidden).toBe(false);
        expect(ops.shown).toBe(player.current.datetime);
    });

    it('a hidden player does not touch the map when its date changes', () => {
        const { player, ops } = make({}, { visible: false });
        player.setDate('2026-01-02');
        expect(ops.onMap.size).toBe(0);
        expect(player.current.datetime).toBe('2026-01-02');
    });

    it('preload sets how many frames load ahead', () => {
        const { ops } = make({ preload: 4, loop: false, default: '2026-01-01' });
        expect([...ops.onMap].sort()).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
    });

    it('preloads three frames by default', () => {
        const ops = makeOps();
        new FramePlayer({ layerId: 'sst', frames, config: { loop: false, default: '2026-01-01' }, ops, clock: makeClock(), doc: null });
        expect(ops.onMap.size).toBe(4);
    });

    it('stops waiting for a frame after max_wait_ms and moves on', () => {
        const { player, clock } = make({ max_wait_ms: 1000 });
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(0);
        player.play();
        clock.run();                       // frame 2 not loaded: wait
        expect(player.waiting).toBe(true);
        now.mockReturnValue(500);
        clock.run();
        expect(player.current.datetime).toBe('2026-01-01');
        now.mockReturnValue(1200);
        clock.run();                       // waited too long: move on
        expect(player.current.datetime).toBe('2026-01-02');
        expect(player.waiting).toBe(false);
        now.mockRestore();
    });

    it('starts with nothing on the map when created hidden', () => {
        const { ops } = make({}, { visible: false });
        expect(ops.onMap.size).toBe(0);
    });

    it('describe reports the date, range and availability', () => {
        const { player } = make({ step: 2, window: 'P4D' });
        expect(player.describe()).toMatchObject({
            date: '2026-01-06', first: '2026-01-02', last: '2026-01-06', frames: 3,
            available: { first: '2026-01-01', last: '2026-01-06', frames: 6 },
            step: 2, window: 'P4D', playing: false,
        });
    });

    it('destroy removes every frame', () => {
        const { player, ops } = make();
        player.destroy();
        expect(ops.onMap.size).toBe(0);
        expect(ops.cleared).toBe(true);
    });
});

describe('formatDate', () => {
    it('shows monthly series as YYYY-MM', () => {
        const monthly = [{ datetime: '1985-01-01' }, { datetime: '1985-02-01' }];
        expect(formatDate('1985-02-01', monthly)).toBe('1985-02');
        expect(formatDate('2026-01-03', frames)).toBe('2026-01-03');
    });
});

describe('FramePlayer panel', () => {
    it('moving the slider shows the frame it was moved to', () => {
        const dom = new JSDOM('<!doctype html><body></body>');
        const doc = dom.window.document;
        const ops = makeOps();
        const player = new FramePlayer({ layerId: 'sst', frames, config: {}, ops, clock: makeClock(), doc });
        const slider = doc.querySelector('.frame-player .rc-slider');
        expect(slider.value).toBe('5');
        slider.value = '2';
        slider.dispatchEvent(new dom.window.Event('input'));
        expect(player.current.datetime).toBe('2026-01-03');
        expect(slider.value).toBe('2');
        expect(doc.querySelector('.frame-player .rc-value').textContent).toBe('2026-01-03');
    });

    it('back and forward buttons step one frame', () => {
        const dom = new JSDOM('<!doctype html><body></body>');
        const doc = dom.window.document;
        const player = new FramePlayer({ layerId: 'sst', frames, config: {}, ops: makeOps(), clock: makeClock(), doc });
        doc.querySelector('.fp-prev').click();
        expect(player.current.datetime).toBe('2026-01-05');
        doc.querySelector('.fp-next').click();
        expect(player.current.datetime).toBe('2026-01-06');
    });
});
