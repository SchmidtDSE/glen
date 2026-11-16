# Layout preview fixture

`layers-input.json` here is a **test fixture, not a demo**. The map, layout and
chrome modules are browser-bound, and the coverage table in `AGENTS.md` says
to verify them visually, with no harness yet. This is that harness: the Pages
workflow publishes each `preview/*` branch with this config, so a change to
browser-bound UI can be looked at in a real browser before it merges.

The fixture is glen core's config, with plugins named relative to the branch
root (`core/plugins/…`); the workflow adjusts the paths for variants.

## Publishing a preview

> The operational runbook — mirror-push pattern, verification, variants,
> gotchas — is the **`deploy-preview`** skill in `.claude/skills/`. This file
> covers what the fixture *is*; that one covers how to ship it.


Deploys are restricted to branches matching `preview/*` (a deployment-branch
policy on the `github-pages` environment). Push the branch you want to look at
under that prefix, then dispatch the workflow on it:

```bash
git push -u origin HEAD:preview/<name>
gh workflow run gh-pages.yml --ref main
```

Dispatch on `main`, not on the preview branch: `workflow_dispatch` runs the
workflow file from the ref it is dispatched on, so dispatching on a branch
uses that branch's copy, which goes stale whenever the workflow changes. The
build stages every `preview/*` ref regardless of what triggered it.

It lands at `https://schmidtdse.github.io/glen/preview/<name>/`, and the
docs site keeps its usual URLs, because previews are staged into the built docs
tree rather than replacing it. `/preview/` lists whatever is published.

**Every `preview/*` branch is rebuilt on each deploy**, whichever ref triggered
it. Pages has a single deployment slot, so staging only the triggering branch
meant one preview silently took every other offline and a push to `main` took
them all; rebuilding the set keeps them additive. A preview lives until its
branch is deleted.

Nothing is pinned and no downstream app is involved — a preview serves that
branch's `core/` and `app/` directly, via relative imports, so pushing more
commits and re-dispatching is the whole iteration loop.

**Which app the root shows depends on the branch.** A branch with
`app/index.html` (v3) shows the fixture in the v3 full app. A branch without one
(v4, SchmidtDSE/glen#441) shows it in glen core: the root page is
`core/index.html` loading `core/main.js` and `app/`'s stylesheets from beside
it, as a downstream app loads them from jsDelivr, with this fixture as its
`layers-input.json`. The variants below follow the root. `/core/` and the
core variants are the same in both.

## Logos in the fixture

All three header slots are filled with real marks, so spacing and truncation
can be judged as a deployed app would show them:

- **GLEN** and **DSE** come from `app/assets/` as library defaults, needing no
  configuration. The GLEN one is a placeholder until a real mark exists.
- **BOSL** (`bosl-logo.svg`, vendored from <https://bosl.ucsb.edu/>) fills the
  partner slot, standing for a sister organisation. It is a self-contained
  badge with its own dark background, so it needs no light/dark variant.

## Editing the fixture

`layers-input.json` here is a **fixed point of `json.dumps(..., indent=2)`**
plus a trailing newline: format it and you get the same bytes back. So a
programmatic edit produces a diff of only what changed.

Round-tripping a file through a formatter it does not already match reformats
it wholesale. One session turned a six-line addition into a 577-line diff that
way. Nothing catches it — the tests still pass, and the churn only shows up in
review, where it buries the actual change.

**The settings are per file.** Check before editing, rather than assuming:

```python
raw = open(path).read()
raw == json.dumps(json.load(open(path)), indent=N) + nl   # find the N and nl that hold
```

| File | Fixed point of |
|---|---|
| `preview/layers-input.json` | `indent=2`, trailing newline |
| `preview/variants/*.json` | `indent=2`, trailing newline |
| `core/layers-input.json` | **none**: hand-formatted, with short arrays on one line |

`core/layers-input.json` is the one to be careful with: any `json.dumps`
round trip rewrites much of it, so edit it by hand.

## Variants

`preview/variants/<name>.json` is a **shallow patch** over the base fixture,
published alongside it at `/preview/<branch>/<name>/`. One branch can therefore show
several configurations at once — a light and a dark theme, say — without
duplicating the whole fixture, which would then drift out of sync.

```json
// preview/variants/light.json
{ "theme": "light" }
```

`brand.json` is the same fixture under an invented house palette, to show that
a downstream app can recolour from config alone. It is a made-up colour scheme,
not anyone's real branding.

`rasters-from-catalog.json` draws two rasters with no styling in their config,
so they start from the catalog's published renders (#440): vessel density as
one layer with two versions, each with its own range, and NLCD 2024 in its
land-cover classes.

Top-level keys in the patch replace those in the base; there is no deep merge,
so patch whole blocks rather than individual nested fields.

## What the fixture covers

Sixteen real collections across twelve groups. The count is deliberate: a
three-layer panel does not show whether the layout survives a realistic list,
so the fixture is sized to crowd it. Between them they cover:

| Layer | Exercises |
|---|---|
| PAD-US fee (vector, visible) | categorical vector legend, tooltips |
| NLCD, RAP cover (raster COG) | categorical raster legend, colormaps |
| Irrecoverable carbon, MOBI richness, GHS population (raster COG) | continuous colorbar legends |
| Federal trails (vector) | `layer_type: line` |
| SVI, flood hazard, wetlands (vector) | further categorical legends |
| USGS fire perimeters (vector, visible) | reactive `control` slider, animated |
| PAD-US easement, critical habitat, watersheds, ecoregions, IPLC lands | group nesting and list density |

Plus `sidebar.enabled`, charts, geocoder, draw, upload, geolocate and the
footer links. The fire slider and a visible legend are deliberately on at once
— that pairing is the collision from
[#359](https://github.com/SchmidtDSE/glen/issues/359).

No `config.json` is deployed, so no LLM is configured and the chat will not
answer. That is intentional: previews carry no secrets, and the point is the
visual layout.

## Keeping it working

The collection IDs, URLs and asset IDs are copied from a live catalog, so this
file can rot if those move. If a preview comes up with missing layers, check
`preview/layers-input.json` against the catalog before assuming the branch
broke something.

## Core variants

`preview/core-variants/<name>.json` is a shallow patch over glen core's own
config, `core/layers-input.json`, published at `/preview/<branch>/core-<name>/`.
`era5.json` draws the ERA5-Land daily heat collection from the Portolan
registry (#462): Tmax and the Tmax anomaly (band 3) as time series over all 78
items, read from the collection's `items.parquet`, and two single days as item
layers.
`panel.json` shows the v3 full app's layer panel settings in glen core, written as
apps already write them (SchmidtDSE/glen#441): a versioned layer, a toggle group
over two rasters, a collapsed group, and a layer with `"sidebar": false`.
`template.json` is glen-template's layer config (the `template-today` variant)
in glen core, changed only by renaming `collection_id` and `collection_url` to
`id` and `url`, to compare the two apps side by side (SchmidtDSE/glen#441).
