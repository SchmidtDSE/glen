#!/usr/bin/env node
/**
 * Convert a v3 app's layers-input.json to glen core's (SchmidtDSE/glen#441).
 *
 *   node scripts/convert-to-core.mjs layers-input.json --ref v4.5.0 > layers-input.core.json
 *   node scripts/convert-to-core.mjs index.html --ref v4.5.0 > index.core.html
 *
 * `--ref` is the glen release the app will pin; the plugin URLs, and an
 * index.html's glen URLs, point at it. What changed is printed to stderr.
 */
import { readFileSync } from 'node:fs';
import { convertConfig, convertIndexHtml, loadsOwnLibraries } from '../core/convert-config.js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--ref');
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : null;
if (!file || !ref) {
    console.error('usage: node scripts/convert-to-core.mjs <layers-input.json> --ref <glen tag>');
    process.exit(2);
}
if (/\.html?$/i.test(file)) {
    const { html, changed, removed } = convertIndexHtml(readFileSync(file, 'utf8'), ref);
    process.stdout.write(html);
    console.error(`note: ${changed} glen URL(s) now load glen core at ${ref}.`);
    for (const url of removed) console.error(`note: removed ${url}; glen core loads its own.`);
    if (removed.length) console.error('note: to pin another version of a library, list its tag again with its integrity hash; glen core leaves it alone.');
    if (!removed.length && !loadsOwnLibraries(ref)) console.error(`note: kept the page's library tags; glen adds them itself from v4.5.0.`);
    if (!changed) console.error('note: no glen app URL found; is this a glen app\'s index.html?');
    process.exit(0);
}
const { config, notes } = convertConfig(JSON.parse(readFileSync(file, 'utf8')), {
    pluginBase: `https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@${ref}/core/plugins`,
});
process.stdout.write(JSON.stringify(config, null, 2) + '\n');
for (const n of notes) console.error(`note: ${n}`);
