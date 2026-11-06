# Vendored glen-harness

An unmodified copy of modules from [glen-harness](https://github.com/SchmidtDSE/glen-harness), at the ref in `REF`. glen core (`core/main.js`) imports the agent loop, the tool registry and the chat from here. The full app still has its own copies in `app/`; moving it onto this copy is #422.

Do not edit these files. Change glen-harness, tag a release, and re-vendor:

```bash
scripts/vendor-harness.sh v0.2.0
```

CI re-runs `scripts/vendor-harness.sh` against `REF` and fails if the result differs from what is committed.

| File | Loaded |
|---|---|
| `src/core.js`, `src/agent.js`, `src/tool-registry.js` | At start: the agent loop and tool registry, without the MCP client |
| `ui/chat-ui.js`, `ui/markdown.js`, `ui/export-config.js`, `ui/icons.js` | At start: the chat |
| `ui/export-report.js` | On the first session export; glen core turns the export off by default |
| `ui/voice-input.js`, `ui/transcriber.js` | Only when the config names a `transcription_model` |

The MCP client is not vendored here. glen core's MCP plugin uses `app/mcp-client.js` and the bundled SDK in `app/vendor/mcp-sdk.js`.
