/**
 * Bundle entry point for the vendored Parquet reader (app/vendor/hyparquet.js).
 *
 * glen core reads a raster series' item list from the collection's
 * `items.parquet` mirror, which Portolan asks raster collections to publish
 * (#462): one request instead of one per item. hyparquet is pure JavaScript
 * with no dependencies; it is bundled for the same reason as the MCP SDK, so
 * no third-party ESM host is involved at runtime. It is imported only when a
 * series layer loads, never at boot.
 *
 * Re-export only what core/portolan-catalog.js uses.
 *
 * Rebuild with `pnpm run build:vendor`. See app/vendor/README.md.
 */
export { parquetReadObjects, parquetMetadataAsync, asyncBufferFromUrl } from 'hyparquet';
