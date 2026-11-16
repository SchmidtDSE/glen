import { describe, it, expect, vi } from 'vitest';
import plugin, { geolocateSettings } from '../core/plugins/geolocate.js';

function ctxWith(config = {}) {
    const controls = [];
    const tools = [];
    return {
        ctx: { config, map: { map: { addControl: (c, pos) => controls.push([c, pos]) } }, tools: { registerLocal: (t) => tools.push(t.name) } },
        controls, tools,
    };
}
class GeolocateControl { constructor(opts) { this.opts = opts; } }
const maplibregl = { GeolocateControl };

describe('geolocate plugin', () => {
    it('reads true as the locate button alone, as v3 did', () => {
        expect(geolocateSettings(true)).toEqual({ button: true, agent_tool: false });
        expect(geolocateSettings({ button: true, agent_tool: true })).toEqual({ button: true, agent_tool: true });
        expect(geolocateSettings({ agent_tool: true })).toEqual({ button: false, agent_tool: true });
        expect(geolocateSettings(undefined)).toEqual({ button: false, agent_tool: false });
    });

    it('adds the button, and the location tool only when asked', () => {
        const a = ctxWith();
        plugin.setup(a.ctx, { button: true, maplibregl });
        expect(a.controls).toHaveLength(1);
        expect(a.controls[0][0]).toBeInstanceOf(GeolocateControl);
        expect(a.controls[0][1]).toBe('top-left');
        expect(a.tools).toEqual([]);

        const b = ctxWith();
        plugin.setup(b.ctx, { button: false, agent_tool: true, maplibregl });
        expect(b.controls).toHaveLength(0);
        expect(b.tools).toEqual(['get_user_location']);
    });

    it('takes the app\'s geolocate setting when given no options, so config.json can still set it', () => {
        const a = ctxWith({ geolocate: { agent_tool: true } });
        plugin.setup(a.ctx, { maplibregl });
        expect(a.controls).toHaveLength(0);
        expect(a.tools).toEqual(['get_user_location']);
        // Listed with nothing else: the button.
        const b = ctxWith();
        plugin.setup(b.ctx, { maplibregl });
        expect(b.controls).toHaveLength(1);
    });
});
