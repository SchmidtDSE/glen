# Hosted app

The hosted app runs glen as a service. An author makes a map of public data with the builder, and the site serves it: there is no repository to clone and nothing to host. The builder writes an app config, a short JSON file that names the data, the look, a short prompt and which tools to turn on. The deployment supplies everything that runs code or costs money: the plugin modules, the models and their keys, the MCP server.

Private apps and private data still use [glen-template](https://github.com/SchmidtDSE/glen-template), which keeps its own server and secrets.

## Deployments

The same files serve two deployments. Each has its own `deployment.json`.

| | GitHub Pages | NRP |
|---|---|---|
| Address | `https://schmidtdse.github.io/glen/maps/` | `https://glen-maps.nrp-nautilus.io/` |
| Models | Each visitor's own OpenRouter key, saved in their browser | NRP models through the pod's `/api/llm`, with the key added by nginx |
| SQL | geo-query-wasm in a Web Worker in the browser | The shared geo-query MCP server through `/api/mcp` |
| Plugins | `mcp`, `charts`, `controls`, `draw`, `uploads`, `geolocate` | `mcp`, `hex`, `charts`, `controls`, `draw`, `geolocate` |
| Settings | `hosted/deployment.json` | `deployment.json` in `k8s/configmap.yaml` |
| Staged by | `.github/workflows/gh-pages.yml` | The initContainer in `k8s/deployment.yaml` |

Both run `scripts/stage-hosted.sh`, which lays out `core/`, `app/` and `hosted/` and writes a page at `/a/<slug>/` for each app in `hosted/apps/`.

## Addresses

The app page (`map/index.html`) finds its config in one of four places.

| Address | Config |
|---|---|
| `/a/<slug>/` | `hosted/apps/<slug>.json`, a published app |
| `hosted/map/?app=<slug>` | The same, without the page per app |
| `hosted/map/?config=<url>` | Any public JSON file that allows cross-origin reads |
| `hosted/map/?c=<encoded>` | The config itself, deflated and base64url-encoded in the link |

A deployment with `"allow_unlisted": false` serves only published apps. The builder opens any of these addresses for editing, as `hosted/?app=<slug>` and so on.

## Publishing an app

The builder's Propose on GitHub button opens GitHub's new-file form on `hosted/apps/<slug>.json` with the config filled in. Saving it opens a pull request from the author's fork, and the app is served at `/a/<slug>/` once the pull request is merged. On GitHub Pages that is the next deploy. On NRP the pod stages the registry when it starts, so it needs `kubectl -n schmidtdse rollout restart deployment/glen-maps`.

## App config

An app config takes these layers-input.json settings (see `docs/guide/configuration.md`): `catalog`, `collections`, `max_collections`, `titiler_url`, `view`, `welcome`, `default_basemap`, `custom_basemap`, `links`, `header`, `theme`, `sidebar`, `geocoder`, `s3_sources` and `auto_approve`. It adds four of its own.

- `title` is the app's name in the header, the sidebar and the browser tab.
- `system_prompt` is the app's prompt as text, at most 8000 characters. glen core puts it after its own base prompt.
- `plugins` lists names from the deployment's `plugins`, such as `["mcp", "charts"]`. An app that gives none gets the deployment's `default_plugins`.
- `data_hosts` lists other hosts the in-browser SQL may read. The hosts of the catalog and collection URLs are added without being listed.

`hosted-config.js` drops anything else, with a note in the console and in the builder. A whole layers-input.json can be uploaded: its glen plugin URLs become names and its other settings are dropped.

## Security

Every hosted app shares one origin. On GitHub Pages that origin also holds each visitor's OpenRouter key, so an app config can never name a script. Plugins are chosen by name from the deployment's list, which fixes their URLs and options; `javascript:` and similar URLs are removed wherever they appear; and glen builds the page from config strings as text, never as HTML. A published app is reviewed in its pull request. An unlisted link or config URL is not reviewed, but it can do no more than a published one.

## Files

- `index.html`, `builder.js`, `builder.css` are the builder.
- `catalog-browse.js` lists every collection under a catalog for the builder.
- `map/index.html` and `runtime.js` are the app page.
- `hosted-config.js` holds the rules: what an app may set, how it joins the deployment's settings, and how a config travels in a link. Tested in `test/hosted-config.test.js`.
- `deployment.json` holds the GitHub Pages deployment's settings.
- `geo-query-worker.js` starts geo-query-wasm from this origin, as a Worker must.
- `apps/` is the registry of published apps.
- `k8s/` is the NRP deployment.
