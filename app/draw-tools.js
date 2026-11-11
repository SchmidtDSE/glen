/**
 * draw-tools.js — The polygon draw tool's agent side, shared by the full app
 * (`draw_enabled`) and glen core's draw plugin (core/plugins/draw.js).
 *
 * `MapDraw` (map-draw.js) owns the button and the polygon; this module gives
 * the agent `get_drawn_region` and tells the chat when a region is drawn or
 * cleared.
 */

/**
 * The `get_drawn_region` tool: the drawn polygon as WKT, with an H3
 * resolution to join it at.
 * @param {import('./map-draw.js').MapDraw} mapDraw
 * @returns {Object} a tool definition
 */
export function createDrawnRegionTool(mapDraw) {
    return {
        name: 'get_drawn_region',
        description:
            'Get the polygon region the user drew on the map, as WKT. ' +
            'Returns the WKT geometry and a suggested H3 resolution based on the region size. ' +
            'To use in SQL: UNNEST(h3_polygon_wkt_to_cells(wkt, resolution)) produces H3 cells ' +
            'that can be JOINed against a dataset\'s H3 index column. Use the resolution ' +
            'closest to (but not exceeding) the suggested resolution. ' +
            'Returns null if no region is drawn. Call this when the user says ' +
            '"this area", "here", "my selection", "the drawn region", or similar.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
        execute: () => {
            const wkt = mapDraw.getRegionWKT();
            if (!wkt) {
                return JSON.stringify({
                    success: false,
                    error: 'No region drawn. Ask the user to draw a polygon on the map first.',
                });
            }
            return JSON.stringify({
                success: true,
                wkt,
                suggested_h3_resolution: mapDraw.getSuggestedH3Resolution(),
                hint: 'To filter by this region, UNNEST h3_polygon_wkt_to_cells(wkt, resolution) and JOIN on the dataset H3 column. ' +
                      'Example: FROM UNNEST(h3_polygon_wkt_to_cells(\'<wkt>\', <res>)) AS t(cell) JOIN data ON data.h3_col = t.cell. ' +
                      'suggested_h3_resolution is a ceiling — pick the dataset H3 column closest to but not exceeding it.',
            });
        },
    };
}

/**
 * Tell the chat and the agent when the user draws or clears a region. The
 * agent's note is replaced, not appended, so repeated draw and clear cycles
 * do not grow its history.
 * @param {{ agent: Object, ui: Object, target?: EventTarget }} deps
 */
export function wireDrawNotices({ agent, ui, target = window }) {
    const DRAW_PREFIX = '[The user has drawn a region';
    const CLEAR_PREFIX = '[The user has cleared the drawn region';
    function replaceDrawMessage(content) {
        for (let i = agent.messages.length - 1; i >= 0; i--) {
            const c = agent.messages[i].content;
            if (agent.messages[i].role === 'user' &&
                (c.startsWith(DRAW_PREFIX) || c.startsWith(CLEAR_PREFIX))) {
                agent.messages.splice(i, 1);
            }
        }
        agent.messages.push({ role: 'user', content });
    }

    target.addEventListener('region-drawn', () => {
        ui.addMessage('system', 'Region drawn on map. Ask me anything about this area.');
        replaceDrawMessage(
            '[The user has drawn a region of interest on the map. ' +
            'Use the get_drawn_region tool to retrieve the polygon when answering spatial queries about this area.]',
        );
    });
    target.addEventListener('region-cleared', () => {
        ui.addMessage('system', 'Region cleared.');
        replaceDrawMessage(
            '[The user has cleared the drawn region from the map.]',
        );
    });
}
