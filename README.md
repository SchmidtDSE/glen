# GLEN: Map + AI Data Analyst

[![DOI](https://zenodo.org/badge/1151803996.svg)](https://doi.org/10.5281/zenodo.20673849)

A JavaScript library for interactive map applications with an LLM agent. **glen core** draws the layers of [Portolan](https://www.portolan-sdi.org/) or STAC collections on a MapLibre map, with an agent whose tools act on the map. Plugins add SQL analytics through MCP (Model Context Protocol) servers such as DuckDB, charts, drawing, GeoJSON upload and hex tile layers. The agent and chat come from [glen-harness](https://github.com/SchmidtDSE/glen-harness).

Individual apps (different datasets, URLs, branding) load glen from jsDelivr at a pinned release and provide their own configuration.

**Documentation:** <https://schmidtdse.github.io/glen/>

## Create a new app

Use [SchmidtDSE/glen-template](https://github.com/SchmidtDSE/glen-template): click "Use this template" on GitHub. You get a ready-to-deploy repo with `index.html`, `layers-input.json`, `system-prompt.md` and `k8s/` manifests. See the [quick start](https://schmidtdse.github.io/glen/guide/quickstart).

**Live demo:** <https://schmidtdse.github.io/glen-template/>

An app's `index.html` loads glen core and the shared stylesheets at one release tag:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<tag>/app/style.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<tag>/app/chat.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<tag>/app/sidebar.css">
<script type="module" src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@<tag>/core/main.js"></script>
```

Deployed apps always pin a release tag, never `@main`. Copy the full page, with its third-party libraries and their integrity hashes, from `core/index.html`.

## Repository layout

| Path | What it is |
|---|---|
| `core/` | glen core: bootstrap, Portolan catalog, map tools, prompt; `core/plugins/` holds the plugins. See [`core/README.md`](core/README.md). |
| `app/` | Shared modules glen core is built on (map, layout, layer tools, catalog code) and the stylesheets apps load. |
| `docs/` | The documentation site; `docs/design/` records settled design decisions. |
| `preview/` | The fixture for branch previews on GitHub Pages. |
| `scripts/convert-to-core.mjs` | Converts a v3 app's `layers-input.json` and `index.html` to glen core. |

## glen v3

Until v4, this repository also held the full app (`app/main.js`). v3 apps keep loading it from their pinned v3 tags, and v3 fixes go to the `release-v3.x` branch. To move an app to glen core, see [Moving a v3 app](https://schmidtdse.github.io/glen/guide/configuration#moving-a-v3-app-to-glen-core).

## Development

```bash
python -m http.server 8000      # then open http://localhost:8000/core/
corepack pnpm install
corepack pnpm test
```

`AGENTS.md` covers the architecture, testing, branch previews and the release flow.
