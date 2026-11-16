# Quick Start

## Two repos, one workflow

| Repo | What it is | Who it's for |
|---|---|---|
| [`glen`](https://github.com/SchmidtDSE/glen) | glen core and its plugins: map, map tools, MCP, charts. Loaded from CDN. | Library contributors; this docs site. |
| [`glen-template`](https://github.com/SchmidtDSE/glen-template) | Starter template. Three files to edit, then deploy. | App builders — **start here**. |

**To build a new map app:** use the template. You never touch the library repo.

## Start from the template

Go to [SchmidtDSE/glen-template](https://github.com/SchmidtDSE/glen-template) and click **Use this template → Create a new repository**. You get a ready-to-deploy repo with the three files you need. Edit them for your dataset and deploy.

**Live demo:** <https://schmidtdse.github.io/glen-template/>

## Your app is just three files

```
index.html          ← HTML shell — loads glen core JS/CSS from CDN
layers-input.json   ← which datasets to show, which plugins, how to connect to the LLM
system-prompt.md    ← what the data is and who the app is for
```

No JavaScript to write. glen core (the map and its tools) and its plugins load from jsDelivr, and the agent and chat come from [glen-harness](https://github.com/SchmidtDSE/glen-harness), which glen core loads itself.

## index.html

The HTML shell loads two kinds of code: a set of **pinned third-party libraries** (MapLibre, PMTiles, marked, DOMPurify) as page-global `<script>` tags, and **glen core** (JS + CSS) from the CDN. There is no import map. glen-harness loads highlight.js itself when the chat first shows code, and the MCP plugin loads a pre-bundled MCP SDK, so the only hosts your page contacts are the CDNs. The `<body>` only needs two placeholder `<div>`s — the layout manager builds the rest (chat panel, controls, etc.) dynamically.

::: warning Copy this file from the template — don't hand-author it
The canonical `index.html` is `core/index.html` in this repository, as glen-template uses it. **Copy it verbatim** rather than retyping the script tags below. In particular, never hand-edit the `integrity="sha384-…"` hashes — see [Subresource Integrity](#about-the-integrity-hashes) for why. The block below is reproduced for reference and matches the template at the pinned release.
:::

```html
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Map App</title>

    <!-- MapLibre GL JS -->
    <script src="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.js"
        integrity="sha384-U054LTKiMIJKEecR8PKFiUZdvkGWHjfPBnen5hSmR9TwfOfgZmKbskC8Rs9dCm/1"
        crossorigin="anonymous"></script>
    <link href="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.css" rel="stylesheet"
        integrity="sha384-MGCxhspF/+ufueUgol3FDkiAYQbpSNRhBT0VWHJt64U8qIy9qlnXWx8LAbj6niPH"
        crossorigin="anonymous" />

    <!-- PMTiles protocol -->
    <script src="https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js"
        integrity="sha384-MjejsnWXHmuz93aE35YWLh5AbS/6ceRB3Vb+ukOwqFzJRTpQ8vvbkLbNV7I0QK4f"
        crossorigin="anonymous"></script>

    <!-- Markdown rendering (lib/marked.umd.js is the package-shipped artifact;
         marked.min.js is a CDN-generated file and unsafe to hash) -->
    <script src="https://cdn.jsdelivr.net/npm/marked@18.0.5/lib/marked.umd.js"
        integrity="sha384-ZD0fTOwPMHi7zM6WTVIWJR21I07lq0ccnqz3J6WMvQKG9thh4y7TA1QE6PJu0Af8"
        crossorigin="anonymous"></script>

    <!-- HTML sanitizer — chat-ui.js refuses to render markdown without it -->
    <script src="https://cdn.jsdelivr.net/npm/dompurify@3.4.8/dist/purify.min.js"
        integrity="sha384-jrsBdrv4eDpEYIq32u13DPbvB6tRmqIDnA6UlgFBoexpetaiWi7g/VbfMEL1WVen"
        crossorigin="anonymous"></script>

    <!-- GLEN styles (pinned, at the same ref as core/main.js) -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.53.0/app/style.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.53.0/app/chat.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.53.0/app/sidebar.css">
    <style>
        /* Boot placeholder — see #boot-status in the body. */
        #boot-status {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font: 14px/1.4 system-ui, sans-serif;
            color: #666;
            text-align: center;
        }
        #map.maplibregl-map #boot-status { display: none; }
    </style>
</head>

<body>
    <!-- Map -->
    <!-- #boot-status makes a failed module load read as "stuck loading" rather
         than an unexplained blank page. MapLibre puts .maplibregl-map on this
         container once the map exists, which hides it again — no JS needed (#343). -->
    <div id="map">
        <div id="boot-status">Loading map modules…</div>
    </div>

    <!-- Layer controls — generated by MapManager.generateMenu() -->
    <div id="menu"></div>

    <!-- GLEN bootstrap (pinned) -->
    <script type="module" src="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.53.0/core/main.js"></script>
</body>

</html>
```

::: tip Sidebar CSS is safe to always include
`sidebar.css` is scoped to `body.sidebar-mode` and sidebar-only IDs, so it has zero effect on floating-mode apps. Include it unconditionally to keep all apps on the same scaffold.
:::

### About the `integrity` hashes

Each third-party `<script>`/`<link>` carries an `integrity="sha384-…"` attribute — that's [Subresource Integrity (SRI)](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity). The browser downloads the file, hashes it, and **refuses to run it unless the hash matches**. If a CDN were ever compromised and served a tampered library, the mismatch blocks the swapped-in code instead of executing it. This matters here specifically because the agent renders model output (which can be steered by attacker-controllable data) into the page — DOMPurify sanitizes it, and SRI guarantees the *real* DOMPurify is the thing that loaded. `crossorigin="anonymous"` is required for SRI to work on cross-origin files.

**You normally never touch these values.** They're maintained in this repo's `core/index.html` and the template, kept in lockstep with the release the app pins. Copy them; don't retype them.

A hash needs updating in exactly one situation: **you bump a pinned library to a new version** (e.g. `marked@18.0.5` → a later release). A new version is different bytes, so the old hash will no longer match and the browser will block the file — chat text then renders as escaped plain markdown (a deliberate fail-closed, with a console warning), which is your signal that a hash and its URL have drifted apart. Recompute with:

```bash
curl -sL "<the pinned URL>" | openssl dgst -sha384 -binary | openssl base64 -A
# prefix the result with "sha384-"
```

Update the URL and its `integrity` value together in the same commit. Because every URL pins an *exact* version (never a floating range like `@18` or bare `marked`), the served bytes are immutable and the hash is stable indefinitely — so this is rare and only done by maintainers bumping a dependency.

| CDN reference | When to use |
|---|---|
| `@vX.Y.Z` (e.g. `@v3.53.0`) | Every deployed app — pinned, immutable |
| `@<40-char-commit-sha>` | Short-lived demo of an in-flight feature branch |

`@main` is **not** used by deployed apps: a merge to `main` can change behavior under a running page, and tooling/MCP contracts evolve between releases. Bump the pin deliberately, never implicitly.

## layers-input.json

Minimal example:

```json
{
  "catalog": "https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json",
  "collections": ["cpad-2025b"],
  "plugins": [
    { "url": "https://cdn.jsdelivr.net/gh/SchmidtDSE/glen@v3.53.0/core/plugins/mcp.js",
      "options": { "url": "https://duckdb-mcp.nrp-nautilus.io/mcp", "prompt": "geospatial-analyst" } }
  ],
  "llm": {
    "user_provided": true,
    "default_endpoint": "https://openrouter.ai/api/v1",
    "models": [
      { "value": "anthropic/claude-sonnet-4", "label": "Claude Sonnet" },
      { "value": "google/gemini-2.5-flash", "label": "Gemini Flash" }
    ]
  }
}
```

Without `plugins`, the agent works the map alone: it shows, filters and styles layers from the catalog's metadata. The MCP plugin adds SQL queries over the data behind each layer. See [Configuration Reference](./configuration) for all fields and the other plugins.

## system-prompt.md

Plain Markdown, added after glen core's short base prompt. Tell the assistant what data it's looking at and who the app is for. Keep it short: the tools describe themselves. See [System prompt](./configuration#system-prompt).

```markdown
This app is for exploring California's protected lands: who owns
and manages them, and how well they are protected for biodiversity.
```

## Local development

```bash
# From your app folder (index.html + layers-input.json + system-prompt.md)
python -m http.server 8000
# Open http://localhost:8000
# Enter your API key in the ⚙ settings panel
```

## Next steps

- [Configuration Reference](./configuration) — all `layers-input.json` fields and plugins
- [Moving a v3 app](./configuration#moving-a-v3-app-to-glen-core) — converting an app that loads `app/main.js`
- [Deployment](./deployment) — GitHub Pages, Hugging Face Spaces, Kubernetes
- [Agent Loop](./agent-loop) — how the LLM tool-use loop works internally
