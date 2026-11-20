/**
 * boot-progress.js — what a visitor sees while glen core starts
 * (SchmidtDSE/glen#512).
 *
 * Until the map and its layers are drawn, a full-screen overlay names the
 * step under way above a progress bar. Once the map is up it is usable, so
 * the overlay fades and a thin bar along the bottom of the page carries the
 * rest: the plugins (an SQL engine can take a few seconds) and the agent.
 * The chat input stays disabled, saying so, until the agent is ready.
 *
 * Steps are reported by core/main.js; the fractions are rough shares of a
 * typical start, not measurements.
 */

export const OVERLAY_ID = 'glen-boot';
export const BAR_ID = 'glen-boot-bar';
const STARTING = 'Starting the assistant…';

/**
 * @param {Object} [opts]
 * @param {Document} [opts.doc]
 * @returns {{
 *   step(label: string, fraction: number): void,
 *   mapReady(): void,
 *   holdInput(input?: HTMLInputElement|HTMLTextAreaElement): void,
 *   done(): void,
 *   fail(message: string): void,
 * }}
 */
export function createBootProgress({ doc = document } = {}) {
    const overlay = doc.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'glen-boot';
    const card = doc.createElement('div');
    card.className = 'glen-boot-card';
    const label = doc.createElement('p');
    label.className = 'glen-boot-label';
    label.setAttribute('role', 'status');
    label.setAttribute('aria-live', 'polite');
    label.textContent = 'Loading…';
    const track = progressTrack(doc, 'glen-boot-track', 'Loading');
    card.append(label, track.el);
    overlay.append(card);
    doc.body.append(overlay);

    let bar = null;
    let input = null;
    let inputState = null;
    let phase = 'overlay';

    const set = (text, fraction) => {
        const t = phase === 'overlay' ? track : bar;
        if (!t) return;
        if (text) (phase === 'overlay' ? label : bar.label).textContent = text;
        t.set(fraction);
    };

    const releaseInput = () => {
        if (!input || !inputState) return;
        input.disabled = inputState.disabled;
        input.placeholder = inputState.placeholder;
        input.removeAttribute('aria-busy');
        input = inputState = null;
    };

    return {
        step(text, fraction) {
            set(text, fraction);
        },

        mapReady() {
            if (phase !== 'overlay') return;
            phase = 'bar';
            overlay.classList.add('glen-boot--leaving');
            removeAfterFade(overlay);
            const t = progressTrack(doc, 'glen-boot-bar-track', STARTING);
            const text = doc.createElement('span');
            text.className = 'glen-boot-bar-label';
            text.setAttribute('role', 'status');
            text.setAttribute('aria-live', 'polite');
            text.textContent = STARTING;
            const el = doc.createElement('div');
            el.id = BAR_ID;
            el.className = 'glen-boot-bar';
            el.append(text, t.el);
            doc.body.append(el);
            bar = { ...t, el, label: text };
        },

        holdInput(el) {
            if (!el || input) return;
            input = el;
            inputState = { disabled: el.disabled, placeholder: el.placeholder };
            el.disabled = true;
            el.placeholder = STARTING;
            el.setAttribute('aria-busy', 'true');
        },

        done() {
            phase = 'done';
            releaseInput();
            overlay.remove();
            if (bar) {
                bar.set(1);
                bar.el.classList.add('glen-boot--leaving');
                removeAfterFade(bar.el);
            }
        },

        fail(message) {
            releaseInput();
            const text = `Failed to start: ${message}`;
            if (phase === 'overlay') {
                overlay.classList.add('glen-boot--failed');
                label.textContent = text;
                track.el.remove();
            } else if (bar) {
                bar.el.classList.add('glen-boot--failed');
                bar.label.textContent = text;
            }
            phase = 'failed';
        },
    };
}

/** A determinate progress bar: the element and a setter for 0..1. */
function progressTrack(doc, className, name) {
    const el = doc.createElement('div');
    el.className = className;
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-label', name);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    const fill = doc.createElement('div');
    fill.className = 'glen-boot-fill';
    el.append(fill);
    let current = 0;
    const set = (fraction) => {
        // Never backwards: a late step with a smaller share leaves the bar alone.
        const f = Math.max(current, Math.min(1, Math.max(0, Number(fraction) || 0)));
        current = f;
        const pct = Math.round(f * 100);
        fill.style.width = `${pct}%`;
        el.setAttribute('aria-valuenow', String(pct));
    };
    set(0);
    return { el, set };
}

/** Remove an element once its fade-out ends, or at once without transitions. */
function removeAfterFade(el) {
    const win = el.ownerDocument.defaultView;
    const ms = parseFloat(win?.getComputedStyle?.(el).transitionDuration || '0') * 1000;
    if (!ms) { el.remove(); return; }
    win.setTimeout(() => el.remove(), ms + 50);
}
