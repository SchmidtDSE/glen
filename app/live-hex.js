/**
 * live-hex.js — Hex layers whose SQL uses the controls' {{TOKEN}}s and is
 * rebuilt when the reader changes one (SchmidtDSE/glen#426), so the map and
 * the charts change together.
 *
 * A live hex layer is the SQL and styling of a `register_hex_tiles` +
 * `add_hex_tile_layer` pair. glen runs `register_hex_tiles` itself, at the
 * current settings, and draws the tiles; when a control the SQL uses changes,
 * it builds the tiles again and points the same layer at them, so the layer
 * keeps its id, its row in the layer panel and whether it is shown. Its colour
 * scale follows the new values.
 *
 * Changes are debounced, and a build a newer one overtook is dropped. A layer
 * the reader removed stops updating.
 */

import { tokensIn, expand } from './params.js';
import { chooseHexScale } from './hex-tools.js';

export const DEBOUNCE_MS = 800;

/** The id a live hex layer is drawn under: `hex-<id>`. */
export function liveHexId(id) {
    const s = String(id ?? '');
    return s.startsWith('hex-') ? s : `hex-${s}`;
}

/** The first JSON object in a tool's text result, or the object itself. */
export function parseToolObject(raw) {
    if (raw && typeof raw === 'object') return raw;
    const text = String(raw ?? '');
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i < 0 || j < i) return null;
    try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
}

export class LiveHexLayers {
    /**
     * @param {Object} opts
     * @param {Object} opts.map - MapManager (addHexTileLayer, updateHexTileLayer, setLayerStatus, layers)
     * @param {(sql: string, agg: string) => Promise<Object>} opts.register - runs register_hex_tiles, returns its result object
     * @param {(args: Object) => Promise<Object>} opts.resolve - resolveHexMetadata: value column, stats and bounds for a tile URL
     * @param {() => Object|null} [opts.params] - the controls' ParamBus
     * @param {number} [opts.debounceMs]
     */
    constructor({ map, register, resolve, params = null, debounceMs = DEBOUNCE_MS }) {
        this.map = map;
        this.register = register;
        this.resolve = resolve;
        this.params = params;
        this.debounceMs = debounceMs;
        this.layers = new Map();   // layer id → { spec, used, seq, timer, added }
        this._unsub = null;
    }

    /**
     * Draw a live hex layer, or redraw one with the same id from a new spec.
     * @param {Object} spec - add_hex_tile_layer's styling arguments, with `sql`,
     *   optional `agg` (register_hex_tiles' aggregation) and `layer_id`
     * @returns {Promise<Object>} add_hex_tile_layer's result, with `live` and `tokens`
     */
    async add(spec) {
        if (!spec?.sql) return { success: false, error: 'A live hex layer needs sql.' };
        if (spec.layer_id == null || !/^[A-Za-z0-9_-]+$/.test(String(spec.layer_id))) {
            return { success: false, error: 'layer_id takes letters, digits, "_" and "-".' };
        }
        const id = liveHexId(spec.layer_id);
        const used = tokensIn(spec.sql);
        const bus = used.size ? this.params?.() : null;
        if (used.size && !bus) {
            return { success: false, error: `sql uses ${[...used].map(t => `{{${t}}}`).join(', ')}, but this app has no controls to set them.` };
        }
        const prev = this.layers.get(id);
        if (prev?.timer) clearTimeout(prev.timer);
        const entry = { spec, used, seq: prev?.seq || 0, timer: null, added: !!this.map.layers?.has(id) };
        this.layers.set(id, entry);
        if (used.size) this._subscribe();
        const res = await this.build(id);
        if (!res.success && !entry.added) this.layers.delete(id);
        return { ...res, ...(used.size && res.success && { live: true, tokens: [...used] }) };
    }

    has(id) {
        return this.layers.has(liveHexId(id));
    }

    untrack(id) {
        const e = this.layers.get(liveHexId(id));
        if (e?.timer) clearTimeout(e.timer);
        this.layers.delete(liveHexId(id));
    }

    /** The live layers, for get_map_state. */
    describe() {
        return [...this.layers].map(([id, e]) => ({ layer_id: id, tokens: [...e.used] }));
    }

    _subscribe() {
        const bus = this.params?.();
        if (this._unsub || !bus) return;
        this._unsub = bus.subscribe((changed) => {
            for (const [id, e] of this.layers) {
                if ([...e.used].some(t => changed.has(t))) this._schedule(id);
            }
        });
    }

    _schedule(id) {
        const e = this.layers.get(id);
        if (!e) return;
        // the reader removed it: stop updating
        if (e.added && !this.map.layers?.has(id)) { this.untrack(id); return; }
        if (e.timer) clearTimeout(e.timer);
        this.map.setLayerStatus?.(id, { busy: true });
        e.timer = setTimeout(() => { e.timer = null; this.build(id); }, this.debounceMs);
    }

    /** Build the layer's tiles at the current settings and draw them. */
    async build(id) {
        const e = this.layers.get(id);
        if (!e) return { success: false, error: `No live hex layer ${id}.` };
        const seq = ++e.seq;
        const stale = () => this.layers.get(id) !== e || e.seq !== seq;
        const fail = (error) => {
            if (!stale()) this.map.setLayerStatus?.(id, { error });
            return { success: false, error };
        };
        if (e.added) this.map.setLayerStatus?.(id, { busy: true });
        const { spec } = e;
        let sql;
        try {
            sql = e.used.size ? expand(spec.sql, this.params?.()?.tokens() || {}, 'sql') : spec.sql;
        } catch (err) {
            return fail(err.message);
        }
        let reg;
        try {
            reg = await this.register(sql, spec.agg || 'COUNT');
        } catch (err) {
            return fail(`register_hex_tiles failed: ${err.message}`);
        }
        if (stale()) return { success: true, superseded: true };
        if (!reg || reg.status === 'failed' || reg.error) return fail(`register_hex_tiles failed: ${reg?.error || 'no result'}`);
        const tileUrl = reg.tile_url_template || reg.tile_url;
        if (!tileUrl) return fail('register_hex_tiles returned no tile URL.');
        const meta = await this.resolve({
            tile_url: tileUrl,
            value_column: spec.value_column,
            ...(reg.value_stats && spec.value_column && reg.value_stats[spec.value_column] && { value_stats: reg.value_stats[spec.value_column] }),
            ...(Array.isArray(reg.bounds) && { bounds: reg.bounds }),
        });
        if (stale()) return { success: true, superseded: true };
        if (meta.error) return fail(meta.error);
        let res;
        if (e.added && this.map.layers?.has(id)) {
            res = this.map.updateHexTileLayer(id, { tileUrl, valueColumn: meta.valueColumn, valueStats: meta.valueStats, scale: chooseHexScale(spec.scale, meta.valueStats) });
        } else if (e.added) {
            // removed by the reader while it was being built
            this.untrack(id);
            return { success: false, error: `Hex layer ${id} was removed.` };
        } else {
            res = this.map.addHexTileLayer({
                layerId: id,
                tileUrl,
                valueColumn: meta.valueColumn,
                valueStats: meta.valueStats,
                bounds: meta.bounds,
                layerName: meta.layerName,
                palette: spec.palette || 'viridis',
                opacity: spec.opacity ?? 0.7,
                displayName: spec.display_name || `Hex: ${meta.valueColumn}`,
                fitBounds: spec.fit_bounds !== false,
                extrude: spec.extrude === true,
                extrudeMaxHeight: spec.extrude_max_height,
                scale: chooseHexScale(spec.scale, meta.valueStats),
            });
            if (res?.success) e.added = true;
        }
        if (!res?.success) return fail(res?.error || 'Could not draw the hex layer.');
        this.map.setLayerStatus?.(id, {});
        return res;
    }
}

