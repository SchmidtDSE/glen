/**
 * settings-section.js — The Settings section at the top of the layer panel,
 * where every control that changes what the map or a chart shows goes
 * (SchmidtDSE/glen#426): an app's params, layer filter sliders, the raster
 * time-series player and the trajectory playback controls. Only the legend
 * and the map's own buttons stay on the map.
 *
 * The section is made on first use, first in the layer panel
 * (`#sidebar-layers-pane` in the sidebar layout, `#menu` in the floating
 * one), and hides itself when nothing in it is showing. A page with no layer
 * panel (a test, an embed) falls back to the map's overlay rail.
 */

import { mountOverlay } from './overlay-rail.js';

const PANE_IDS = ['sidebar-layers-pane', 'menu'];

/** Order within the section: params first, then the map's own controls. */
export const SETTING = {
    PARAMS: 0,
    FILTER: 20,
    PLAYER: 25,
    ANIMATION: 30,
};

/** The layer panel the section goes in, or null when the page has none. */
export function settingsPane(doc = globalThis.document) {
    if (!doc?.getElementById) return null;
    for (const id of PANE_IDS) {
        const el = doc.getElementById(id);
        if (el) return el;
    }
    return null;
}

/**
 * The Settings section's list, made on first use.
 * @param {Document} [doc]
 * @param {Element} [pane] - defaults to the layer panel
 * @returns {Element|null} the list, or null without a layer panel
 */
export function settingsList(doc = globalThis.document, pane = settingsPane(doc)) {
    if (!pane) return null;
    let section = pane.querySelector(':scope > .param-controls');
    if (!section) {
        section = doc.createElement('section');
        section.className = 'param-controls menu-section';
        section.setAttribute('aria-label', 'Settings');
        section.hidden = true;
        const title = doc.createElement('div');
        title.className = 'section-title';
        title.textContent = 'Settings';
        const list = doc.createElement('div');
        list.className = 'param-controls-list';
        section.append(title, list);
    }
    placeFirst(pane, section);
    return section.querySelector('.param-controls-list');
}

/**
 * Put a section first in the layer panel's content: after the panel's header
 * row (its title and fold button) when it has one, else at the top. Settings
 * comes first and the charts follow it. Called again on each use, since the
 * header can be added after the section.
 * @param {Element} pane
 * @param {Element} el - `.param-controls` or `.chart-cards`
 */
export function placeFirst(pane, el) {
    const header = pane.querySelector(':scope > .menu-header');
    const settings = pane.querySelector(':scope > .param-controls');
    const anchor = el === settings ? header : (settings || header);
    if (anchor) {
        if (anchor.nextElementSibling !== el) anchor.after(el);
    } else if (pane.firstElementChild !== el) {
        pane.prepend(el);
    }
    // the charts follow the settings wherever the settings moved to
    const charts = pane.querySelector(':scope > .chart-cards');
    if (el === settings && charts && settings.nextElementSibling !== charts) settings.after(charts);
}

/**
 * Put a control in the Settings section at `order`, or in the overlay rail
 * when the page has no layer panel.
 * @param {HTMLElement} el
 * @param {number} order - a SETTING value
 * @param {Object} [opts]
 * @param {Document} [opts.doc]
 * @param {number} [opts.railSlot] - the overlay-rail slot for the fallback
 */
export function mountSetting(el, order, { doc = el.ownerDocument || globalThis.document, railSlot = order } = {}) {
    const list = settingsList(doc);
    if (!list) return mountOverlay(el, railSlot, doc);
    el.style.order = String(order);
    el.classList.add('setting');
    list.appendChild(el);
    refreshSettings(doc);
    return list;
}

/** Hide the section when nothing in it is showing; call after a control is shown, hidden or removed. */
export function refreshSettings(doc = globalThis.document, section = settingsPane(doc)?.querySelector(':scope > .param-controls')) {
    if (!section) return;
    const list = section.querySelector('.param-controls-list');
    section.hidden = ![...list.children].some(showing);
}

function showing(el) {
    if (el.hidden || el.style.display === 'none') return false;
    // a group (the params' rows) shows when any row in it does
    if (el.classList.contains('param-rows')) return [...el.children].some(showing);
    return true;
}
