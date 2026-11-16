# Shared modules

The ES modules glen core (`core/`) is built on: the map, the layout and chrome, the map tools and the tools behind the plugins, and the catalog code. Apps load the stylesheets here (`style.css`, `chat.css`, `sidebar.css`) from jsDelivr at the same tag as `core/main.js`; the modules themselves are imported by glen core.

**Do not deploy this directory.** It has no page of its own since v4. Use [glen-template](https://github.com/SchmidtDSE/glen-template) to make an app, and run glen core locally from the repository root at `/core/`.

`AGENTS.md` lists the modules. `app/` never imports from `core/`, and every module here must be reached from glen core or a plugin; tests check both.
