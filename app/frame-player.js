/**
 * frame-player.js — Playback for a raster time series (#421).
 *
 * A FramePlayer steps a raster layer through its dated frames (see
 * raster-frames.js). It owns the playback state and a small panel in the map
 * overlay rail: play/pause, back and forward, a slider over the frames, the
 * date on screen, and a loading mark.
 *
 * It never touches MapLibre. MapManager passes in `ops`, which keep a few
 * frames on the map as raster layers: the one on screen, and the next ones at
 * zero opacity so their tiles load before they are needed. Playback moves on
 * only once the next frame has loaded, so a slow connection plays more slowly
 * instead of flashing blank or half-drawn frames.
 *
 * The pure playback logic runs without a DOM (`doc: null`) and with an
 * injected clock, so it is unit-tested; the panel is checked by eye.
 */

import { mountOverlay, SLOT } from './overlay-rail.js';
import { selectFrames, nearestFrameIndex } from './raster-frames.js';

const DEFAULTS = {
    step: 1,
    frame_ms: 400,
    loop: true,
    preload: 2,       // frames kept loading ahead of the one on screen
};

// While waiting for a frame's tiles, check again this often.
const WAIT_MS = 100;

export class FramePlayer {
    /**
     * @param {Object} opts
     * @param {string} opts.layerId
     * @param {string} [opts.displayName]
     * @param {import('./raster-frames.js').Frame[]} opts.frames  every frame, oldest first
     * @param {Object} [opts.config]  the layer's `control` block
     * @param {Object} opts.ops
     * @param {(frame:Object, role:'show'|'preload')=>void} opts.ops.ensure  put a frame on the map
     * @param {(frame:Object)=>boolean} opts.ops.isLoaded  whether a frame's tiles are loaded
     * @param {(keep:Object[])=>void} opts.ops.prune  remove every frame not in `keep`
     * @param {boolean} [opts.visible=true]  whether the layer is on; a hidden layer loads no frames
     * @param {Document|null} [opts.doc]
     * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.clock]
     */
    constructor(opts) {
        this.layerId = opts.layerId;
        this.displayName = opts.displayName || opts.layerId;
        this.config = { ...DEFAULTS, ...(opts.config || {}) };
        this.allFrames = opts.frames || [];
        this.ops = opts.ops;
        this.doc = opts.doc === undefined ? (typeof document !== 'undefined' ? document : null) : opts.doc;
        this.clock = opts.clock || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };

        this.range = {
            start: this.config.start || null,
            end: this.config.end || null,
            window: this.config.window || null,
            step: this.config.step,
        };
        this.frames = selectFrames(this.allFrames, this.range);
        this.index = -1;
        this.playing = false;
        this.waiting = false;
        this.visible = opts.visible !== false;
        this.timer = null;
        this.destroyed = false;

        this._panel = null;
        if (this.doc) this._build();
        if (this._panel && !this.visible) this._panel.style.display = 'none';
        const first = this.config.default ? nearestFrameIndex(this.frames, this.config.default) : this.frames.length - 1;
        this.show(first);
    }

    /** The frame on screen. */
    get current() {
        return this.frames[this.index] || null;
    }

    /**
     * Show a frame by index and start loading the ones after it.
     * @param {number} i
     */
    show(i) {
        if (this.destroyed || !this.frames.length) return;
        this.index = Math.max(0, Math.min(this.frames.length - 1, i));
        const keep = [this.current, ...this._ahead()];
        if (this.visible) {
            this.ops.ensure(this.current, 'show');
            for (const f of keep.slice(1)) this.ops.ensure(f, 'preload');
        }
        this.ops.prune(this.visible ? keep : []);
        this._render();
    }

    /** Jump to the frame nearest a date. Returns the date shown, or null. */
    setDate(date) {
        const i = nearestFrameIndex(this.frames, date);
        if (i < 0) return null;
        this.show(i);
        return this.current.datetime;
    }

    /**
     * Change which frames play: a date range, a recent window and a step.
     * Keeps the date on screen when it is still in range, else shows the last frame.
     * @param {{ start?: string|null, end?: string|null, window?: string|null, step?: number }} range
     */
    setRange(range) {
        const date = this.current?.datetime;
        this.range = { ...this.range, ...range };
        this.frames = selectFrames(this.allFrames, this.range);
        const i = date ? this.frames.findIndex(f => f.datetime === date) : -1;
        this.show(i >= 0 ? i : this.frames.length - 1);
    }

    /** Replace the frame list (a refreshed listing), keeping the date on screen. */
    setFrames(frames) {
        this.allFrames = frames || [];
        this.setRange({});
    }

    setFrameMs(ms) {
        const n = Number(ms);
        if (n > 0) this.config.frame_ms = n;
    }

    play() {
        if (this.destroyed || this.frames.length < 2) return;
        // From the last frame, start again at the first.
        if (this.index >= this.frames.length - 1) this.show(0);
        this.playing = true;
        this._render();
        this._schedule(this.config.frame_ms);
    }

    pause() {
        this.playing = false;
        this.waiting = false;
        if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
        this._render();
    }

    /** Step one frame; stops playback. */
    stepBy(n) {
        this.pause();
        this.show(this.index + n);
    }

    _ahead() {
        const out = [];
        const n = this.frames.length;
        for (let k = 1; k <= this.config.preload && k < n; k++) {
            let j = this.index + k;
            if (j >= n) {
                if (!this.config.loop) break;
                j -= n;
            }
            out.push(this.frames[j]);
        }
        return out;
    }

    _schedule(ms) {
        if (this.timer) this.clock.clearTimeout(this.timer);
        this.timer = this.clock.setTimeout(() => this._tick(), ms);
    }

    _tick() {
        this.timer = null;
        if (!this.playing || this.destroyed) return;
        let next = this.index + 1;
        if (next >= this.frames.length) {
            if (!this.config.loop) { this.pause(); return; }
            next = 0;
        }
        const frame = this.frames[next];
        if (!this.ops.isLoaded(frame)) {
            // Hold the current frame until the next one has its tiles.
            this.ops.ensure(frame, 'preload');
            if (!this.waiting) { this.waiting = true; this._render(); }
            this._schedule(WAIT_MS);
            return;
        }
        this.waiting = false;
        this.show(next);
        this._schedule(this.config.frame_ms);
    }

    // ---- Lifecycle ----

    setVisible(visible) {
        this.visible = visible;
        if (this._panel) this._panel.style.display = visible ? '' : 'none';
        if (!visible) this.pause();
        this.show(this.index);
    }

    destroy() {
        this.pause();
        this.destroyed = true;
        this.ops.prune([]);
        if (this._panel) this._panel.remove();
    }

    /** What the agent sees in get_map_state. */
    describe() {
        return {
            date: this.current?.datetime || null,
            first: this.frames[0]?.datetime || null,
            last: this.frames[this.frames.length - 1]?.datetime || null,
            frames: this.frames.length,
            available: {
                first: this.allFrames[0]?.datetime || null,
                last: this.allFrames[this.allFrames.length - 1]?.datetime || null,
                frames: this.allFrames.length,
            },
            step: this.range.step,
            ...(this.range.window && { window: this.range.window }),
            frame_ms: this.config.frame_ms,
            playing: this.playing,
        };
    }

    // ---- Panel ----

    _build() {
        const panel = this.doc.createElement('div');
        panel.className = 'reactive-controls frame-player';
        panel.dataset.layerId = this.layerId;
        const label = this.config.label || this.displayName;
        panel.innerHTML = `
            <span class="rc-label" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
            <button type="button" class="rc-play fp-prev" aria-label="Previous frame">‹</button>
            <button type="button" class="rc-play fp-toggle" aria-label="Play">▶</button>
            <button type="button" class="rc-play fp-next" aria-label="Next frame">›</button>
            <input class="rc-slider" type="range" min="0" max="0" step="1" value="0" aria-label="${escapeAttr(label)} date" />
            <span class="rc-value" aria-live="polite"></span>
        `;
        mountOverlay(panel, SLOT.REACTIVE, this.doc);
        this._panel = panel;
        this._slider = panel.querySelector('.rc-slider');
        this._value = panel.querySelector('.rc-value');
        this._toggle = panel.querySelector('.fp-toggle');

        this._slider.addEventListener('input', () => {
            this.pause();
            this.show(Number(this._slider.value));
        });
        this._toggle.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
        panel.querySelector('.fp-prev').addEventListener('click', () => this.stepBy(-1));
        panel.querySelector('.fp-next').addEventListener('click', () => this.stepBy(1));
    }

    _render() {
        if (!this._panel) return;
        this._slider.max = String(Math.max(0, this.frames.length - 1));
        this._slider.value = String(Math.max(0, this.index));
        this._value.textContent = this.current ? formatDate(this.current.datetime, this.allFrames) : 'No frames';
        this._toggle.textContent = this.playing ? '❚❚' : '▶';
        this._toggle.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
        this._panel.classList.toggle('loading', this.waiting);
    }
}

/**
 * Show a monthly series as YYYY-MM and anything finer as YYYY-MM-DD.
 * @param {string} date
 * @param {Object[]} frames
 */
export function formatDate(date, frames) {
    const monthly = frames.length > 1 && frames.every(f => f.datetime.endsWith('-01'));
    return monthly ? date.slice(0, 7) : date;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
}
