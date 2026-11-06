# Vendored glen-harness

A trimmed copy of [glen-harness](https://github.com/SchmidtDSE/glen-harness) at `v0.1.0` (commit `8827366`), the agent harness extracted from this repository. glen core uses it in place of the full app's `app/agent.js`, `app/tool-registry.js` and `app/chat-ui.js`.

| File | Upstream | Changes |
|---|---|---|
| `agent.js` | `src/agent.js` | Sends no `Authorization` header when a model has no `api_key` (glen#420, which postdates v0.1.0) |
| `tool-registry.js` | `src/tool-registry.js` | None |
| `ui/chat-ui.js` | `ui/chat-ui.js` | The session export is removed, so `export-report.js` and its DuckDB code are not loaded. Markdown rendering is imported from `ui/markdown.js`, and `tool-registry.js` from the directory above |
| `ui/markdown.js` | `ui/export-report.js` | Only `renderMarkdown`, `scrubCredentials` and `REDACTED_KEYS` |
| `ui/icons.js` | `ui/icons.js` | None |

The MCP client is not vendored here. A plugin that needs one, such as `core/plugins/mcp.js`, loads `app/mcp-client.js` when it runs.

The changes to `agent.js` and `chat-ui.js` belong upstream: the header fix as is, and the export as an optional module that the chat imports only when it is enabled. Once glen-harness has them, this directory can be replaced by an unmodified copy of a tagged release, checked in CI the way `app/vendor/mcp-sdk.js` is.
