/**
 * map-control-tools.js — the agent tools that act only on the map: layers,
 * filters, sliders, styles, tooltips, legends, the camera, geocoding and the
 * projection.
 *
 * These tools read and query no data. The full app (map-tools.js) adds its
 * SQL, STAC and hex tools beside them, and glen core (core/map-tools.js) adds
 * its Portolan tools. Neither keeps a copy of these definitions.
 *
 * The descriptions are neutral about where data values come from. An app
 * whose agent has other tools passes `hints` that point at them; the full app
 * passes SQL_HINTS, which reproduce its descriptions byte for byte, so its
 * prompt prefix did not change when these tools moved here.
 */

// A paint value that is a number, or an expression (an array). `items: {}`
// keeps a constrained decoder from collapsing the array to [] (#243).
export const NUM_OR_EXPR = { type: ['number', 'array'], items: {} };

/**
 * The layer-choice rule appended to several descriptions. The live layer list
 * is in the system prompt once, not in each tool (#225).
 */
export const PICK_LAYER_NUDGE = 'Pick the layer by displayName semantic match, not by ID suffix. When several layers could plausibly match the user\'s intent (e.g. "districts" could mean congressional, state senate, or state house), choose on displayName — the ID suffix is not a reliable disambiguator.';

/** Descriptions for an agent whose only data knowledge is its system prompt. */
export const DEFAULT_HINTS = Object.freeze({
    filterValues: 'IMPORTANT: Never guess categorical values used in filters. Use values documented in your system prompt or given by the user.',
    styleValues: 'IMPORTANT: For categorical coloring (e.g., a "match" expression), never guess or assume valid values. Use values documented in your system prompt or given by the user.',
    tooltipFields: 'Property names must exactly match the feature properties in the vector tiles, as listed in your system prompt. Unknown names render nothing (no error).',
    legendIntro: `Label a layer's legend. Use after you color a layer with a \`match\` expression whose values do not explain themselves.

The legend already mirrors the map's colors automatically: a \`match\` recolor renders one swatch per category, a gradient recolor renders a colorbar. What it cannot know is what your values MEAN: a swatch shows the bare value until you name it here.

`,
    styleNotes: `After a \`match\` recolor, the legend shows one swatch per value labelled with the bare value — call set_legend with \`labels\` to name them, rather than writing the color key out in chat.

A ramp or step paints features that lack the property black. Hide them through the opacity and leave the color expression whole, so the legend can still read it: {"fill-opacity": ["case", ["==", ["typeof", ["get", "PROP"]], "number"], 0.6, 0]}.

`,
    geocode: `Resolve a free-text place reference — street address, city, landmark, or named region — to real coordinates. Use this WHENEVER the user names a place rather than giving coordinates: "show me Yosemite", "fly to Chicago".

NEVER invent, recall, or estimate coordinates from your own memory — always call this tool so the coordinate is traceable to a geocoder.

Returns up to \`limit\` ranked candidates. Each candidate has:
  - lat, lon          — pass to fly_to as center [lon, lat] (lon first!)
  - bbox [w,s,e,n]    — for framing/fit-bounds; null for precise point addresses
  - display_name      — the normalized, matched location
  - match_quality     — "high" | "medium" | "low"

How to use the result:
  - Echo the resolved \`display_name\` back to the user so they can confirm the location is the one they meant.
  - If more than one candidate is returned, or the top match_quality is "low" (e.g. "Springfield"), ASK the user which one they mean — do NOT silently pick the first.
  - Then act: fly_to the coordinate.`,
});

/**
 * The full app's descriptions, which send the agent to its SQL and STAC tools
 * for values and coordinates.
 */
export const SQL_HINTS = Object.freeze({
    filterValues: 'IMPORTANT: Never guess categorical values used in filters. Check the dataset catalog in your system prompt for documented coded values, or call get_stac_details for full column details. Only use SELECT DISTINCT via SQL if the metadata doesn\'t cover it.',
    styleValues: 'IMPORTANT: For categorical coloring (e.g., a "match" expression), never guess or assume valid values. Check the dataset catalog in your system prompt for documented coded values, or call get_stac_details for full column details. Only fall back to SELECT DISTINCT via SQL if the metadata doesn\'t cover it.',
    tooltipFields: 'Property names must exactly match the feature properties in the vector tiles. Call get_schema first if you need to see available property names — the agent\'s catalog may list them, but get_schema returns the live set. Unknown names render nothing (no error).',
    legendIntro: `Label a layer's legend. Use after you build a map whose meaning isn't visible from the tiles — above all after styling a layer with a \`match\` expression over codes you invented in SQL.

The legend already mirrors the map's colors automatically: a \`match\` recolor renders one swatch per category, a gradient recolor renders a colorbar. What it cannot know is what your codes MEAN. If your SQL emitted \`CASE WHEN ... THEN 1\` for amphibians, the legend shows a swatch labelled "1" until you name it here.

`,
    styleNotes: `After a \`match\` recolor over codes you defined in SQL, the legend shows one swatch per code labelled with the bare number — call set_legend with \`labels\` to name them, rather than writing the color key out in chat.

For dynamic hex layers (\`hex-…\` ids from add_hex_tile_layer), \`PROP\` is the layer's value column (the \`value_column\` you passed to add_hex_tile_layer, e.g. "species_richness") — NOT "count" unless that is literally the column. If unsure, call get_map_state to read the layer's \`valueColumn\`.

`,
    flyTo: 'Animate the map to a location. Use when the user asks to navigate to, zoom in on, or center the map on a place or set of coordinates.\n\nIMPORTANT: The center parameter is [longitude, latitude] (lon first, lat second — MapLibre order).\n\nTo obtain coordinates, query the H3 parquet data using the h3 extension (pre-loaded on the MCP server). H3 cell columns are typically named h8. Example:\n  LOAD h3; SELECT h3_cell_to_lng(h8) AS lon, h3_cell_to_lat(h8) AS lat FROM read_parquet(\'s3://...\') WHERE name = \'...\' LIMIT 1',
    geocode: `Resolve a free-text place reference — street address, city, landmark, or named region — to real coordinates. Use this WHENEVER the user names a place rather than giving coordinates: "what watershed is 3109 6th Ave, LA in?", "show me Yosemite", "fly to Chicago", "which district contains downtown Fresno".

NEVER invent, recall, or estimate coordinates from your own memory — always call this tool so the coordinate is traceable to a geocoder.

Returns up to \`limit\` ranked candidates. Each candidate has:
  - lat, lon          — pass to fly_to as center [lon, lat] (lon first!), or into point-in-hex SQL lookups
  - bbox [w,s,e,n]    — for framing/fit-bounds; null for precise point addresses
  - display_name      — the normalized, matched location
  - match_quality     — "high" | "medium" | "low"

How to use the result:
  - Echo the resolved \`display_name\` back to the user so they can confirm the location is the one they meant.
  - If more than one candidate is returned, or the top match_quality is "low" (e.g. "Springfield"), ASK the user which one they mean — do NOT silently pick the first.
  - Then act: fly_to the coordinate, or use it in a containing-polygon / nearest-feature query.`,
});

const FLY_TO = 'Animate the map to a location. Use when the user asks to navigate to, zoom in on, or center the map on a place or set of coordinates.\n\nIMPORTANT: The center parameter is [longitude, latitude] (lon first, lat second — MapLibre order).\n\nFor a named place, call geocode first; never recall coordinates from memory.';

const FLY_TO_EXTENT = `Move the map. Give one of:
- layer_id: frame the whole extent of that layer's data;
- bbox: [west, south, east, north] in degrees;
- center: [longitude, latitude] (longitude first), with an optional zoom (0–22).
For a named place, call geocode first; never recall coordinates from memory.`;

/**
 * Promisified `navigator.geolocation.getCurrentPosition`. Rejects (rather than
 * hanging) when geolocation isn't available in the environment.
 * @returns {Promise<GeolocationPosition>}
 */
export function getCurrentPositionAsync(options = { enableHighAccuracy: true, timeout: 10000 }) {
    return new Promise((resolve, reject) => {
        const geo = typeof navigator !== 'undefined' && navigator.geolocation;
        if (!geo) {
            reject(new Error('Geolocation is not available in this browser.'));
            return;
        }
        geo.getCurrentPosition(resolve, reject, options);
    });
}

/**
 * The map-control tools, in the order the full app has always listed them.
 *
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {Object} [options]
 * @param {{ forwardGeocode: Function }|null} [options.geocoder] - adds `geocode`
 * @param {boolean} [options.geolocateTool] - adds `get_user_location` (privacy opt-in)
 * @param {Object} [options.hints] - description text; see DEFAULT_HINTS and SQL_HINTS
 * @param {(layerId: string) => number[]|null} [options.layerExtent] - lets fly_to frame
 *   a layer or a bbox; returns [w, s, e, n] or null
 * @param {boolean} [options.reportView] - get_map_state also reports the camera
 * @param {(layerId: string) => Object|undefined} [options.resetStyle] - handles
 *   reset_style for layers MapManager cannot reset itself; return undefined to defer
 * @returns {Array<Object>} tool definitions for ToolRegistry.registerLocal
 */
export function createMapControlTools(mapManager, {
    geocoder = null,
    geolocateTool = false,
    hints = {},
    layerExtent = null,
    reportView = false,
    resetStyle = null,
} = {}) {
    const h = { ...DEFAULT_HINTS, ...hints };
    const pickLayerNudge = PICK_LAYER_NUDGE;

    return [
        {
            name: 'show_layer',
            description: `Show/display a layer on the map. Use when the user asks to "show", "display", or "visualize" a layer.

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to show' }
                },
                required: ['layer_id']
            },
            execute: (args) => {
                const result = mapManager.showLayer(args.layer_id);
                if (result.success) mapManager.syncCheckbox(args.layer_id);
                return JSON.stringify(result);
            },
        },

        {
            name: 'hide_layer',
            description: `Hide/remove a layer from the map. Use when the user asks to "hide", "remove", or "turn off" a layer.`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to hide' }
                },
                required: ['layer_id']
            },
            execute: (args) => {
                const result = mapManager.hideLayer(args.layer_id);
                if (result.success) mapManager.syncCheckbox(args.layer_id);
                return JSON.stringify(result);
            },
        },

        {
            name: 'set_filter',
            description: `Apply a MapLibre filter expression to a vector layer. Use when the user asks to filter features by property values.

${h.filterValues}

Filter syntax (use MapLibre expressions — NOT legacy filter arrays):
- Equality: ["==", ["get", "property"], "value"]
- Inequality: ["!=", ["get", "property"], "value"]
- Comparison: [">", ["get", "property"], 100]
- In list: ["match", ["get", "property"], ["val1", "val2", "val3"], true, false]
- AND: ["all", ["==", ["get", "p1"], "v1"], [">", ["get", "p2"], 100]]
- OR: ["any", ["==", ["get", "p"], "v1"], ["==", ["get", "p"], "v2"]]

IMPORTANT: Do NOT use the legacy ["in", "property", val1, val2] form — it is silently ignored in current MapLibre. Always use ["match", ["get", "property"], [...values], true, false] for list membership.

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID to filter' },
                    filter: {
                        type: 'array',
                        // `items: {}` (any JSON value, including nested arrays) is
                        // REQUIRED: under grammar-constrained tool decoding, an array
                        // schema with no `items` compiles to a grammar that can only
                        // emit `[]`, silently collapsing every filter to empty (#243).
                        items: {},
                        description: 'MapLibre filter expression array'
                    }
                },
                required: ['layer_id', 'filter']
            },
            execute: (args) => JSON.stringify(mapManager.setFilter(args.layer_id, args.filter)),
        },

        {
            name: 'clear_filter',
            description: `Remove ALL filters from a layer, showing every feature regardless of properties. Use when the user wants to see everything (e.g. "show all GAP codes", "remove filter", "show everything").

Note: some layers have a config default filter applied at startup. This tool removes that too. Use reset_filter instead if you want to restore the default.`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to clear filters from' }
                },
                required: ['layer_id']
            },
            execute: (args) => JSON.stringify(mapManager.clearFilter(args.layer_id)),
        },

        {
            name: 'reset_filter',
            description: `Reset a layer's filter to its config default (the filter it had when the app loaded). If the layer had no default filter, this clears all filters. Use when the user asks to "reset to default", "restore original view", or "go back to how it was".`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to reset filter on' }
                },
                required: ['layer_id']
            },
            execute: (args) => JSON.stringify(mapManager.resetFilter(args.layer_id)),
        },

        {
            name: 'create_slider',
            description: `Create an interactive slider that filters a vector layer by a numeric or temporal field — entirely client-side, with no round-trip per step. Use when the user wants to scrub, step, or animate through values of one field (e.g. "let me step through fire years", "add a year slider", "play the burn history over time").

The slider binds as a MapLibre filter on \`field\`:
- mode "cumulative" (default): shows every feature with field <= the slider value (e.g. fires accumulate as the year advances).
- mode "step": shows only features whose field == the slider value (one year at a time).

Set animate: true to add a play/pause button that sweeps min→max automatically. Only one slider can be attached to a layer at a time (creating a new one replaces it). The slider panel is shown while the layer is visible — call show_layer first if it isn't already on.

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID to attach the slider to' },
                    field: { type: 'string', description: 'Feature property to filter on (e.g. "YEAR_"). Must be numeric or a value that compares numerically.' },
                    min: { type: 'number', description: 'Slider minimum (low end of the field range)' },
                    max: { type: 'number', description: 'Slider maximum (high end of the field range)' },
                    step: { type: 'number', description: 'Slider step size (default 1)' },
                    mode: { type: 'string', enum: ['cumulative', 'step'], description: 'cumulative (<=) or step (==). Default cumulative.' },
                    label: { type: 'string', description: 'Label shown on the slider panel (defaults to the field name)' },
                    animate: { type: 'boolean', description: 'Add a play button that sweeps the range (default false)' },
                },
                required: ['layer_id', 'field', 'min', 'max'],
            },
            execute: async (args) => JSON.stringify(await mapManager.createSlider(args)),
        },

        {
            name: 'set_tooltip',
            description: `Set which feature properties appear in the hover tooltip for a vector layer. Pass an array of property names; the tooltip displays them in order. Pass an empty array to disable the tooltip for that layer.

Use when the user asks to "show X on hover", "include Y in the tooltip", or "stop showing the tooltip".

${h.tooltipFields}

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID' },
                    fields: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Property names to display, in order. Pass [] to disable the tooltip.'
                    },
                },
                required: ['layer_id', 'fields'],
            },
            execute: (args) => JSON.stringify(mapManager.setTooltip(args.layer_id, args.fields)),
        },

        {
            name: 'reset_tooltip',
            description: `Reset a layer's tooltip fields to its config default (the fields it had when the app loaded). If the layer had no default tooltip, this disables the tooltip. Use when the user asks to "reset the tooltip", "restore the default hover", or "go back to how it was".`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID' },
                },
                required: ['layer_id'],
            },
            execute: (args) => JSON.stringify(mapManager.resetTooltip(args.layer_id)),
        },

        {
            name: 'set_legend',
            description: `${h.legendIntro}So: whenever you post a color key in chat, call this instead — that key belongs on the map.

  set_legend { "layer_id": "hex-1a66…",
               "labels": { "1": "Amphibians", "2": "Reptiles", "3": "Birds", "4": "Mammals", "5": "Plants" } }

Fields (all optional except layer_id):
  labels    class value → name, for a categorical/swatch legend. Keys are the values in
            your \`match\` expression, as strings. Merged with labels already set.
  title     heading for the layer, in both the legend and the layer panel.
  units     unit shown after a colorbar's end values (e.g. "observations", "kg/ha").
  visible   false hides this layer's legend section; true brings it back.

Colors and value ranges are NOT settable — they are read from the layer's paint, so the legend can never disagree with the map. To change the colors, call set_style; the legend follows.

Call get_map_state to see what a legend currently says (its \`legend.type\`, and \`legend.classes\` with the label each class shows now). Use reset_legend to return to the app's own labels.`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID whose legend to label' },
                    labels: {
                        type: 'object',
                        description: 'Class value → display name, e.g. {"1": "Amphibians", "2": "Reptiles"}. Keys are the values from the layer\'s `match` expression, as strings.',
                        additionalProperties: { type: 'string' },
                    },
                    title: { type: 'string', description: 'Heading for this layer in the legend and layer panel' },
                    units: { type: 'string', description: 'Unit suffix for a colorbar\'s end values, e.g. "species"' },
                    visible: { type: 'boolean', description: 'false hides this layer\'s legend section' },
                },
                required: ['layer_id'],
            },
            execute: (args) => JSON.stringify(mapManager.setLegend(args.layer_id, {
                labels: args.labels,
                title: args.title,
                units: args.units,
                visible: args.visible,
            })),
        },

        {
            name: 'reset_legend',
            description: `Discard legend labels, title, units, and hiding you set with set_legend, returning the layer to the app's own legend. Does not change the map's colors — a legend derived from a restyle stays derived. Use when the user asks to "reset the legend" or "put the labels back".`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID whose legend to reset' },
                },
                required: ['layer_id'],
            },
            execute: (args) => JSON.stringify(mapManager.resetLegend(args.layer_id)),
        },

        {
            name: 'set_style',
            description: `Update a layer's paint/style properties. Provide MapLibre paint properties — every property name carries a layer-type prefix (\`fill-\`, \`line-\`, \`circle-\`, \`raster-\`).

${h.styleValues}

Supported paint properties by MapLibre layer type:
  fill (polygons):   fill-color, fill-opacity, fill-outline-color, fill-pattern
  line (lines, polygon outlines): line-color, line-width, line-opacity, line-blur, line-dasharray
  circle (points):   circle-color, circle-radius, circle-opacity, circle-stroke-color, circle-stroke-width
  raster:            raster-opacity, raster-brightness-min, raster-brightness-max, raster-contrast, raster-saturation, raster-hue-rotate

Examples:
  Simple: { "fill-color": "red", "fill-opacity": 0.5 }
  Data-driven categorical: { "fill-color": ["match", ["get", "PROP"], "val1", "#c1", "val2", "#c2", "#default"] }
  Data-driven gradient: { "fill-color": ["interpolate", ["linear"], ["get", "PROP"], 0, "#low", 100, "#high"] }
  Stepped: { "fill-color": ["step", ["get", "PROP"], "#c1", 10, "#c2", 50, "#c3"] }

${h.styleNotes}${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to style' },
                    style: {
                        type: 'object',
                        description: 'MapLibre paint properties object, e.g. {"fill-color": "#ff0000", "fill-opacity": 0.8}. Never a string.',
                        // Named properties give constrained decoders something to
                        // generate; a property-less object schema collapsed to "" (#409).
                        // Number-valued ones are typed, or models send "0.8" as a string,
                        // which MapLibre rejects.
                        properties: {
                            'fill-color': { description: 'Fill color, or an expression' },
                            'fill-opacity': { ...NUM_OR_EXPR, description: 'Fill opacity 0–1, or an expression' },
                            'fill-outline-color': { description: 'Fill outline color' },
                            'line-color': { description: 'Line color, or an expression' },
                            'line-width': { ...NUM_OR_EXPR, description: 'Line width in pixels, or an expression' },
                            'line-opacity': { ...NUM_OR_EXPR, description: 'Line opacity 0–1' },
                            'circle-color': { description: 'Circle color, or an expression' },
                            'circle-radius': { ...NUM_OR_EXPR, description: 'Circle radius in pixels, or an expression' },
                            'circle-opacity': { ...NUM_OR_EXPR, description: 'Circle opacity 0–1' },
                            'fill-extrusion-color': { description: 'Extrusion color, or an expression' },
                            'fill-extrusion-opacity': { ...NUM_OR_EXPR, description: 'Extrusion opacity 0–1' },
                            'raster-opacity': { ...NUM_OR_EXPR, description: 'Raster opacity 0–1' },
                        },
                        additionalProperties: true,
                    }
                },
                required: ['layer_id', 'style']
            },
            execute: (args) => JSON.stringify(mapManager.setStyle(args.layer_id, args.style)),
        },

        {
            name: 'reset_style',
            description: `Reset a layer's style to its default appearance.`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to reset' }
                },
                required: ['layer_id']
            },
            execute: (args) => JSON.stringify(resetStyle?.(args.layer_id) ?? mapManager.resetStyle(args.layer_id)),
        },

        {
            name: 'get_map_state',
            description: 'Get the current state of all map layers: which are visible, which have filters applied, etc. Use only when the user asks about current map state.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: () => JSON.stringify(reportView ? withView(mapManager) : mapManager.getMapState()),
        },

        {
            name: 'fly_to',
            description: h.flyTo ?? (layerExtent ? FLY_TO_EXTENT : FLY_TO),
            inputSchema: layerExtent ? {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Frame this layer\'s extent' },
                    bbox: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north]' },
                    center: { type: 'array', items: { type: 'number' }, description: '[longitude, latitude]' },
                    zoom: { type: 'number', description: 'Zoom level 0–22' },
                },
            } : {
                type: 'object',
                properties: {
                    center: {
                        type: 'array',
                        items: { type: 'number' },
                        description: 'Target [longitude, latitude]'
                    },
                    zoom: {
                        type: 'number',
                        description: 'Target zoom level (0–22). Optional — omit to keep current zoom.'
                    }
                },
                required: ['center']
            },
            execute: (args) => JSON.stringify(layerExtent ? flyTo(mapManager, layerExtent, args) : mapManager.flyTo(args)),
        },

        // ---- Geocoding ----
        ...(geocoder ? [{
            name: 'geocode',
            description: h.geocode,
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Free-text place reference: address, city, landmark, or region name.' },
                    limit: { type: 'number', description: 'Max candidates to return (1–10, default 5). Use a small limit unless disambiguating.' },
                },
                required: ['query'],
            },
            execute: async (args) => {
                try {
                    const results = await geocoder.forwardGeocode(args.query, { limit: args.limit ?? 5 });
                    if (!results.length) {
                        return JSON.stringify({
                            success: true,
                            count: 0,
                            results: [],
                            message: `No location found for "${args.query}". Ask the user to add detail (city, state, or a more specific address).`,
                        });
                    }
                    return JSON.stringify({ success: true, count: results.length, source: results[0].source, results });
                } catch (err) {
                    return JSON.stringify({ success: false, error: `Geocoding failed: ${err.message}` });
                }
            },
        }] : []),

        // ---- Geolocation (device location; opt-in) ----
        ...(geolocateTool ? [{
            name: 'get_user_location',
            description: `Get the user's CURRENT PHYSICAL location from their device (GPS/network), returning { latitude, longitude, accuracy_m }. Use this when the relevant place is *where the user is* — "near me", "my area", "what county/district am I in", "carbon here". For a place the user NAMES (a city, address, landmark), use \`geocode\` instead.

The browser asks the user for permission. If they deny it (success:false), tell them you couldn't access their location and offer to let them name a place instead (\`geocode\`).

Returns a single point. This tool does NOT move the map — call \`fly_to\` yourself if you want to recenter. To answer "what's here", feed the coordinate into a containing-polygon / point-in-hex query.`,
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const pos = await getCurrentPositionAsync();
                    return JSON.stringify({
                        success: true,
                        latitude: pos.coords.latitude,
                        longitude: pos.coords.longitude,
                        accuracy_m: pos.coords.accuracy,
                    });
                } catch (err) {
                    const reason = err?.code === 1 ? 'The user denied location permission.'
                        : err?.code === 2 ? 'The location is currently unavailable.'
                        : err?.code === 3 ? 'The location request timed out.'
                        : (err?.message || 'Unknown error.');
                    return JSON.stringify({ success: false, error: `Could not get the user's location: ${reason}` });
                }
            },
        }] : []),
    ];
}

/** The globe / mercator switch, listed last by the full app. */
export function createProjectionTool(mapManager) {
    return {
        name: 'set_projection',
        description: 'Switch the map between globe (spherical 3D) and mercator (flat 2D) projection. Use when the user asks to "show a globe", "switch to globe view", "go back to flat map", etc.',
        inputSchema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['globe', 'mercator'],
                    description: 'Projection type: "globe" for spherical Earth, "mercator" for flat map'
                }
            },
            required: ['type']
        },
        execute: (args) => {
            mapManager.setProjection(args.type);
            return JSON.stringify({ success: true, projection: args.type });
        },
    };
}

/**
 * fly_to with a layer's extent, a bbox, or a centre and zoom.
 * @param {(layerId: string) => number[]|null} layerExtent
 */
export function flyTo(mapManager, layerExtent, { layer_id, bbox, center, zoom } = {}) {
    if (layer_id) {
        bbox = layerExtent(layer_id);
        if (!bbox) return { success: false, error: `${layer_id} is not a layer with a known extent.` };
    }
    if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)) {
        const [w, s, e, n] = bbox;
        if (s > n || Math.abs(s) > 90 || Math.abs(n) > 90) return { success: false, error: 'bbox must be [west, south, east, north] in degrees.' };
        mapManager.map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 16 });
        return { success: true, bbox: [w, s, e, n] };
    }
    if (Array.isArray(center) && center.length === 2) {
        if (Math.abs(center[1]) > 90) return { success: false, error: 'center is [longitude, latitude]; the latitude is out of range.' };
        return mapManager.flyTo({ center, zoom });
    }
    return { success: false, error: 'Give layer_id, bbox, or center.' };
}

/**
 * Build the `set_time` tool for raster time series (#421). Registered only
 * when the app has a layer with a frame control, so other apps' prompts carry
 * no extra schema.
 *
 * @param {import('./map-manager.js').MapManager} mapManager
 * @returns {Object} a tool definition
 */
export function createSetTimeTool(mapManager) {
    return {
        name: 'set_time',
        description: `Set the date shown by a time-series raster layer, choose which dates it plays, and start or stop playback. Time-series layers report a \`timeSeries\` block in get_map_state, with the date on screen and the first and last dates available.

Use it when the user asks for a date ("show SST anomaly on 1 March"), a period ("animate the last three months", "play 2015 to 2016"), a speed, or to stop the animation.

- date: jump to the frame nearest this date (YYYY-MM-DD, or YYYY-MM for monthly series).
- start / end: the first and last dates to play. Giving either replaces the layer's configured window.
- step: play every Nth frame (e.g. 4 for every fourth day). The most recent frame is always kept.
- frame_ms: how long each frame is shown, in milliseconds.
- play: true to start playback, false to stop.

The layer is shown if it is hidden. The result gives the date on screen and the range now playing; report those rather than the dates you asked for, since a date snaps to the nearest available frame.`,
        inputSchema: {
            type: 'object',
            properties: {
                layer_id: { type: 'string', description: 'Time-series raster layer ID' },
                date: { type: 'string', description: 'Date to show, YYYY-MM-DD or YYYY-MM' },
                start: { type: 'string', description: 'First date to play' },
                end: { type: 'string', description: 'Last date to play' },
                step: { type: 'integer', description: 'Play every Nth frame' },
                frame_ms: { type: 'integer', description: 'Milliseconds each frame is shown' },
                play: { type: 'boolean', description: 'true to start playback, false to stop' },
            },
            required: ['layer_id'],
        },
        execute: async (args) => JSON.stringify(await mapManager.setTime(args)),
    };
}

/** getMapState plus the camera position. */
function withView(mapManager) {
    const state = mapManager.getMapState();
    const m = mapManager.map;
    const c = m.getCenter();
    return { ...state, view: { center: [round(c.lng, 4), round(c.lat, 4)], zoom: round(m.getZoom(), 2) } };
}

function round(v, d) {
    const f = 10 ** d;
    return Math.round(v * f) / f;
}
