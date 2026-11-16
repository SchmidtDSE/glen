/**
 * geolocate.js — glen core plugin: the device's location.
 *
 *   "plugins": [{ "url": "…/core/plugins/geolocate.js", "options": { "button": true, "agent_tool": false } }]
 *
 * `button` adds MapLibre's locate-me button. `agent_tool` registers
 * `get_user_location`, which reads the device's location, so it is a separate
 * opt-in. With no options the plugin reads the app's `geolocate` setting, so a
 * deploy-time config.json can still set it, as in v3; `true` there means the
 * button alone.
 */
import { createUserLocationTool } from '../../app/map-control-tools.js';

/** A `geolocate` value: `true` is the button alone; the tool is never implied. */
export function geolocateSettings(value) {
    if (value === true) return { button: true, agent_tool: false };
    const o = value && typeof value === 'object' ? value : {};
    return { button: !!o.button, agent_tool: !!o.agent_tool };
}

export default {
    name: 'geolocate',
    setup(ctx, options = {}) {
        const given = 'button' in options || 'agent_tool' in options;
        const { button, agent_tool } = geolocateSettings(given ? options : (ctx.config?.geolocate ?? { button: true }));
        if (agent_tool) ctx.tools.registerLocal(createUserLocationTool());
        // The button ships with MapLibre, so there is nothing to load.
        if (button) {
            const maplibre = options.maplibregl || globalThis.maplibregl;
            ctx.map.map.addControl(new maplibre.GeolocateControl({
                positionOptions: { enableHighAccuracy: true },
                trackUserLocation: true,
                showUserLocation: true,
            }), 'top-left');
        }
    },
};
