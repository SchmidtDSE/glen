# Where glen core's code lives at v4

At v4 the full app becomes glen core plus plugins (SchmidtDSE/glen#441). Glen core already loads 32 of the 46 modules in `app/`, plus `app/`'s stylesheets, favicon and vendored bundles. The other 14 are the full app's alone, and v4 replaces every one: glen-harness replaces `agent.js`, `chat-ui.js`, `tool-registry.js`, `llm-auth.js`, `llm-models.js`, `transcriber.js`, `voice-input.js` and `export-report.js`; core's Portolan catalog, map tools and MCP plugin replace `dataset-catalog.js`, `map-tools.js` and `mcp-servers.js`; and core has its own `main.js`, geocoder control and H3 helpers in place of `main.js`, `map-geocoder.js` and `h3geo.js`.

So the shared modules stay where they are. At the v4 switch, those 14 modules, `app/main.js` and `app/index.html` are deleted, and `app/` is then glen core's shared library. Moving the shared modules into `core/` was considered and rejected: it would change the stylesheet paths in every downstream `index.html` and in the converter's output, restructure the branch previews again, and gain nothing until v4. v3 apps are pinned to tags, so they keep loading `app/` from their own release.

Until v4, `app/` never imports from `core/` (`test/app-imports.test.js`); `core/` imports `app/`.
