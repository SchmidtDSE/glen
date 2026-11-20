// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { mountSetting, refreshSettings, settingsList, SETTING } from '../app/settings-section.js';
import { ReactiveControl } from '../app/reactive-control.js';
import { ControlPanel } from '../app/control-panel.js';
import { ParamBus } from '../app/params.js';

const section = () => document.querySelector('.param-controls');

describe('the Settings section (#426)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="sidebar-layers-pane"><div id="layer-controls-container"></div></div>';
    });

    it('goes first in the layer panel, and hides when nothing in it shows', () => {
        const el = document.createElement('div');
        mountSetting(el, SETTING.FILTER);
        const pane = document.getElementById('sidebar-layers-pane');
        expect(pane.firstElementChild).toBe(section());
        expect(section().hidden).toBe(false);
        el.style.display = 'none';
        refreshSettings();
        expect(section().hidden).toBe(true);
        el.remove();
        refreshSettings();
        expect(section().hidden).toBe(true);
    });

    it('falls back to the overlay rail on a page with no layer panel', () => {
        document.body.replaceChildren();
        const el = document.createElement('div');
        mountSetting(el, SETTING.FILTER, { railSlot: 20 });
        expect(el.parentElement.id).toBe('map-overlay-rail');
        expect(settingsList()).toBe(null);
    });

    it('puts a layer filter slider beside the params, after them', () => {
        const pane = document.getElementById('sidebar-layers-pane');
        const bus = new ParamBus([{ id: 'unit', token: 'UNIT', options: ['a', 'b'] }]);
        const panel = new ControlPanel(bus, { mount: pane });
        const ctrl = new ReactiveControl({ layerId: 'fire', displayName: 'Fire year', config: { field: 'YEAR', min: 2000, max: 2020 } });
        const list = section().querySelector('.param-controls-list');
        expect(list.querySelectorAll('.param-rows, .reactive-controls')).toHaveLength(2);
        expect(Number(list.querySelector('.reactive-controls').style.order)).toBeGreaterThan(Number(list.querySelector('.param-rows').style.order));
        expect(list.querySelector('.reactive-controls .rc-label').textContent).toBe('Fire year');
        expect(document.querySelectorAll('.param-controls')).toHaveLength(1);
        // hiding the layer hides its slider; the params keep the section open
        ctrl.setVisible(false);
        expect(section().hidden).toBe(false);
        panel.destroy();
        expect(section().hidden).toBe(true);
        ctrl.setVisible(true);
        expect(section().hidden).toBe(false);
        ctrl.destroy();
        expect(section().hidden).toBe(true);
    });
});
