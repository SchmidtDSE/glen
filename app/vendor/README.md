# Vendored third-party bundles

Files here are **build artifacts, not hand-written source**. Do not edit them;
they are committed on purpose. Read this first.

## `hyparquet.js` — Parquet reader

| | |
|---|---|
| Package | `hyparquet` |
| Version | **1.32.0** (pinned exactly in `devDependencies`) |
| Built with | `esbuild` **0.28.2** (pinned exactly — see *Reproducibility*) |
| Entry point | `scripts/hyparquet-entry.js` |
| Rebuild | `pnpm run build:vendor` |
| Consumed by | `core/portolan-catalog.js` |

glen core reads a raster series' item list from the collection's
`items.parquet` mirror, which Portolan asks raster collections to publish
(#462): one request for the whole list instead of one per item. hyparquet is
pure JavaScript with no dependencies, so it bundles to about 60 kB (19 kB
gzipped). It is imported dynamically, only when a series layer loads, so it
is never in the boot module graph and an app without a series never fetches
it.

### Why it is vendored rather than loaded from a CDN

glen ships as plain ES modules served straight from jsDelivr, with no bundler
at deploy time. Loading a package through an ESM-compiling host makes that
host a runtime dependency of every app: the v3 full app loaded the MCP SDK
from `esm.sh`, and when that host was unreachable the page came up blank
(#343). A committed bundle has no third-party ESM host at runtime, and CI can
rebuild it and compare.

The MCP SDK was vendored here the same way until v4. glen core's MCP plugin
now uses glen-harness's client, which vendors its own copy.

### Reproducibility

`pnpm run build:vendor` is byte-stable for a given esbuild version, so CI can
rebuild and diff to prove the committed artifact matches the source. It is
**not** stable *across* esbuild versions. That is why `esbuild` is pinned to an
exact version rather than a caret range: a lockfile refresh that moved the
minifier would otherwise fail the CI check with no real change.

The same applies to the hyparquet version. Bumping it is a deliberate,
separate change: update `devDependencies`, run `pnpm run build:vendor`, commit
the new artifact, and update the version in this file.

### License

hyparquet is MIT and has no transitive dependencies.
