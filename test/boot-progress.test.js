// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createBootProgress, OVERLAY_ID, BAR_ID } from '../app/boot-progress.js';

const overlay = () => document.getElementById(OVERLAY_ID);
const bar = () => document.getElementById(BAR_ID);
const valueOf = (el) => Number(el.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'));

function chatInput() {
    const input = document.createElement('textarea');
    input.placeholder = 'Ask about the data…';
    document.body.append(input);
    return input;
}

beforeEach(() => {
    document.body.replaceChildren();
});

describe('start-up progress (SchmidtDSE/glen#512)', () => {
    it('covers the page with an overlay from the start, naming the step', () => {
        const p = createBootProgress();
        expect(overlay()).not.toBeNull();
        p.step('Loading settings…', 0.1);
        expect(overlay().querySelector('[role="status"]').textContent).toBe('Loading settings…');
        expect(valueOf(overlay())).toBe(10);
        expect(bar()).toBeNull();
    });

    it('keeps the label when a step gives only a fraction, and never moves backwards', () => {
        const p = createBootProgress();
        p.step('Loading the map and data…', 0.5);
        p.step(null, 0.3);
        expect(overlay().querySelector('[role="status"]').textContent).toBe('Loading the map and data…');
        expect(valueOf(overlay())).toBe(50);
        p.step(null, 7);
        expect(valueOf(overlay())).toBe(100);
    });

    it('swaps the overlay for a bar along the bottom once the map is up', () => {
        const p = createBootProgress();
        p.mapReady();
        expect(overlay()).toBeNull();
        expect(bar()).not.toBeNull();
        expect(bar().querySelector('[role="status"]').textContent).toBe('Starting the assistant…');
        p.step(null, 0.6);
        expect(valueOf(bar())).toBe(60);
        p.mapReady();
        expect(document.querySelectorAll(`#${BAR_ID}`)).toHaveLength(1);
    });

    it('holds the chat input until the agent is ready, then gives it back as it was', () => {
        const input = chatInput();
        const p = createBootProgress();
        p.holdInput(input);
        expect(input.disabled).toBe(true);
        expect(input.placeholder).toBe('Starting the assistant…');
        expect(input.getAttribute('aria-busy')).toBe('true');
        p.mapReady();
        p.done();
        expect(input.disabled).toBe(false);
        expect(input.placeholder).toBe('Ask about the data…');
        expect(input.hasAttribute('aria-busy')).toBe(false);
        expect(bar()).toBeNull();
        expect(overlay()).toBeNull();
    });

    it('ignores a missing input', () => {
        const p = createBootProgress();
        expect(() => p.holdInput(undefined)).not.toThrow();
        expect(() => p.done()).not.toThrow();
    });

    it('shows a failure on the overlay when the map never came up', () => {
        const input = chatInput();
        const p = createBootProgress();
        p.holdInput(input);
        p.fail('layers-input.json: 404');
        expect(overlay().classList.contains('glen-boot--failed')).toBe(true);
        expect(overlay().textContent).toBe('Failed to start: layers-input.json: 404');
        expect(overlay().querySelector('[role="progressbar"]')).toBeNull();
        expect(input.disabled).toBe(false);
    });

    it('shows a failure on the bar when it comes after the map', () => {
        const p = createBootProgress();
        p.mapReady();
        p.fail('boom');
        expect(bar().classList.contains('glen-boot--failed')).toBe(true);
        expect(bar().querySelector('[role="status"]').textContent).toBe('Failed to start: boom');
    });
});
