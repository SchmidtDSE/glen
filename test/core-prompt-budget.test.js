/**
 * The catalog section of glen core's system prompt stays small as an app's
 * catalog grows.
 *
 * Before this test, generatePrompt listed every vector layer's properties
 * (up to 30, with descriptions) and every published style, once per layer.
 * A collection whose 16 layers share their columns and styles printed them
 * 16 times: ca-30x30's prompt reached 152K characters on v4.0.5, against
 * 33K on the v3 full app. On the fixture below that code wrote about 230K
 * characters and repeated 1,800 lines; all three tests here fail on it.
 * Properties, styles and statistics are describe_layer's; columns and data
 * files are get_schema's.
 */
import { describe, it, expect } from 'vitest';
import { PortolanCatalog, firstSentence } from '../core/portolan-catalog.js';
import { describeLayer } from '../core/map-tools.js';

const ROOT = 'https://example.org/cat';
const long = (name) => `${name} of the unit, as the publisher defines it in the source geodatabase; see the README for how it was derived, its units and the edition it comes from. Values: A=first class, B=second class, C=third class.`;
const columns = Array.from({ length: 45 }, (_, i) => ({
    name: `FIELD_${i}`, type: i % 3 ? 'number' : 'string', description: long(`Field ${i}`), ...(i % 3 === 0 && { values: ['A', 'B', 'C'] }),
}));
const fields = Object.fromEntries(columns.map(c => [c.name, c.type === 'number' ? 'Number' : 'String']));
const style = (prop) => ({
    version: 8,
    sources: { data: { type: 'vector' } },
    layers: [{ id: 'f', type: 'fill', source: 'data', 'source-layer': 'data', paint: { 'fill-color': ['match', ['get', prop], 'A', '#f00', 'B', '#0f0', 'C', '#00f', '#ccc'] } }],
});
const description = 'A statewide summary of conservation value, built from species ranges and habitat models by the state wildlife agency. It is published as hexagons and as polygons. More detail follows in the README.';

/** A collection with `layers` PMTiles archives that share columns and `styles` styles. */
function collectionDoc(id, layers, styles, summary) {
    const assets = { data: { href: './data.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] } };
    for (let i = 0; i < layers; i++) {
        assets[`layer-${i}`] = { href: `./layer-${i}.pmtiles`, type: 'application/vnd.pmtiles', roles: ['visual'], title: `${id} layer ${i}` };
    }
    for (let i = 0; i < styles; i++) {
        assets[`style-${i}`] = { href: `./styles/${i}.json`, type: 'application/vnd.mapbox.style+json', roles: i ? ['style'] : ['style', 'default'] };
    }
    return {
        type: 'Collection', id, title: `Dataset ${id}`, description: summary, license: 'CC-BY-4.0',
        providers: [{ name: 'State Wildlife Agency', roles: ['producer'] }, { name: 'Lab', roles: ['host'] }],
        'table:columns': columns, links: [], assets,
    };
}

async function largeCatalog() {
    const docs = new Map();
    const specs = [];
    const add = (id, layers, styles) => {
        const url = `${ROOT}/${id}/collection.json`;
        docs.set(url, collectionDoc(id, layers, styles, `${id}: ${description}`));
        for (let i = 0; i < styles; i++) docs.set(`${ROOT}/${id}/styles/${i}.json`, style(`FIELD_${i}`));
        specs.push(url);
    };
    // One collection like ca-30x30's ACE: 16 layers sharing 45 columns and 16 styles.
    add('ace', 16, 16);
    // And 29 more collections, as ca-30x30 has.
    for (let i = 0; i < 29; i++) add(`dataset-${i}`, 1, 3);
    const c = new PortolanCatalog({
        fetchJson: async (u) => {
            if (!docs.has(u)) throw new Error(`404 ${u}`);
            return structuredClone(docs.get(u));
        },
        pmtilesMetadata: async () => ({
            vector_layers: [{ id: 'data', fields }],
            tilestats: { layers: [{ layer: 'data', geometry: 'Polygon' }] },
        }),
    });
    await c.load({ collections: specs });
    return c;
}

describe('the catalog section of the system prompt', () => {
    it('fits a 30-collection, 45-layer catalog in 10,000 characters (it takes ~6,600; the code before this test wrote ~230,000)', async () => {
        const c = await largeCatalog();
        expect(c.layers.size).toBe(45);
        const prompt = c.generatePrompt();
        expect(prompt.length).toBeLessThan(10000);
        // Every collection and layer is still named.
        for (const id of c.getIds()) expect(prompt).toContain(`### \`${id}\`: Dataset ${id}`);
        for (const id of c.layers.keys()) expect(prompt).toContain(`- \`${id}\``);
    });

    it('repeats no line, so nothing shared across a collection is printed per layer', async () => {
        const c = await largeCatalog();
        const lines = c.generatePrompt().split('\n').filter(l => l.trim());
        const repeated = lines.filter((l, i) => lines.indexOf(l) !== i);
        expect(repeated).toEqual([]);
    });

    it('leaves columns, styles, source and license to describe_layer', async () => {
        const c = await largeCatalog();
        const prompt = c.generatePrompt();
        expect(prompt).not.toContain('FIELD_0');
        expect(prompt).not.toContain('CC-BY-4.0');
        const d = describeLayer(c, c.layers.get('ace/layer-3'));
        expect(d.properties).toHaveLength(45);
        expect(d.properties[0]).toEqual({ name: 'FIELD_0', type: 'String', description: long('Field 0'), values: ['A', 'B', 'C'] });
        expect(d.properties[1]).toEqual({ name: 'FIELD_1', type: 'Number', description: long('Field 1') });
        expect(d.styles).toHaveLength(16);
        expect(d.styles[1].colours_by).toEqual({ property: 'FIELD_1', kind: 'categorical', values: ['A', 'B', 'C'] });
        expect(d).toMatchObject({ license: 'CC-BY-4.0', producers: ['State Wildlife Agency'] });
    });
});

describe('firstSentence', () => {
    it('cuts a description at its first sentence', () => {
        expect(firstSentence(description, 200)).toBe('A statewide summary of conservation value, built from species ranges and habitat models by the state wildlife agency.');
    });

    it('does not end a sentence at "et al." or "e.g."', () => {
        expect(firstSentence('Richness from Kling et al. (2018), e.g. for plants. Second.', 200)).toBe('Richness from Kling et al. (2018), e.g. for plants.');
    });

    it('drops Markdown emphasis and caps the length', () => {
        expect(firstSentence('**Bold** words', 200)).toBe('Bold words');
        expect(firstSentence('x'.repeat(300), 200)).toHaveLength(200);
    });
});
