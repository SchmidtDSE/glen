/**
 * draw.js — glen core plugin: draw a polygon on the map and let the agent
 * use it, as the full app does with `draw_enabled` (SchmidtDSE/glen#441).
 *
 * Adds the full app's draw button (app/map-draw.js), the `get_drawn_region`
 * tool, and the chat notices when a region is drawn or cleared
 * (app/draw-tools.js). The region comes back as WKT with an H3 resolution, so
 * it is most useful with an SQL server from plugins/mcp.js.
 *
 *   "plugins": ["…/core/plugins/draw.js"]
 */

const plugin = {
    name: 'draw',

    async setup(ctx) {
        const [{ MapDraw }, { createDrawnRegionTool, wireDrawNotices }] = await Promise.all([
            import('../../app/map-draw.js'),
            import('../../app/draw-tools.js'),
        ]);
        const mapDraw = new MapDraw(ctx.map.map);
        await mapDraw.init();
        ctx.draw = mapDraw;
        ctx.tools.registerLocal(createDrawnRegionTool(mapDraw));
        ctx.onReady(({ agent, ui }) => wireDrawNotices({ agent, ui }));
    },
};

export default plugin;
