# Who loads glen's third-party scripts

**Status: proposal, for SchmidtDSE/glen#511 (deployer papercut).** If it is accepted, it amends the decision recorded in SchmidtDSE/glen#344, and this note becomes the record.

## The problem

A deployer building an app copies about fifteen lines from glen-template's `index.html` without knowing which of them are needed or why:

- maplibre-gl, as a script and a stylesheet;
- pmtiles;
- h3-js;
- marked and DOMPurify;
- highlight.js, its SQL grammar and its theme;
- glen's three stylesheets (`style.css`, `chat.css`, `sidebar.css`);
- glen's `core/main.js`.

Each third-party line carries a version and an SRI hash. The block is copied into every app, so each copy drifts on its own (SchmidtDSE/glen#344 lists the drift).

## What #344 decided, and why

SchmidtDSE/glen#344 kept these libraries as page `<script>` tags with SRI hashes, and did not vendor them into glen. It gave four reasons:

1. **SRI.** The chat renders model output that attacker-controlled data can steer. DOMPurify sanitizes that output, and an SRI hash guarantees the DOMPurify that ran is the real one.
2. **A shared cache.** Apps that load the same maplibre URL share one browser cache entry.
3. **Repository weight.** maplibre alone is about 800 kB, which would be committed again at every bump.
4. **Version control for apps.** An app author can pin another maplibre version.

None of these reasons needs the tags to be written in the app's page. Each needs only that the tags exist, with their hashes, at the CDN URLs.

## Proposal

glen core adds the tags itself. One list in glen holds the URL, SRI hash and page global of each library. `core/main.js` adds a `<script>` or `<link>` tag for each one the page does not already have, with its `integrity` and `crossorigin` set, and waits for those it needs before using them. An app's page then needs only `core/main.js` and the app's own stylesheet.

This keeps all four reasons for #344:

1. **SRI is unchanged.** The browser checks the same hashes on the same files. They are written once in glen instead of once per app.
2. **The cache is unchanged.** The URLs are the same, so apps still share cache entries.
3. **Nothing is vendored.**
4. **Apps keep control of versions.** A library already on the page is left alone, so an app that lists its own maplibre tag keeps its version. Every existing app keeps working unchanged, since it already lists all of them.

glen already does this in three places, so the proposal extends a pattern rather than starting one:

- `app/h3-grid.js` loads h3-js with SRI the first time the hex grid is turned on, unless the page already has it. **The template's h3-js tag is already unneeded.**
- `core/boot.js` `loadHighlighter` adds highlight.js, its SQL grammar and its theme from the harness's list (`CHAT_SCRIPTS` in glen-harness `ui/deps.js`), with its hashes. **The template's highlight.js tags are already unneeded.**
- glen-harness `loadChatDeps` adds marked and DOMPurify the same way. glen core does not call it yet.

Only maplibre (script and CSS), pmtiles, and glen's own three stylesheets have no loader today.

## Costs

- **Start-up time.** A script tag in the page starts downloading when the HTML is parsed, alongside `main.js`. A tag added by `main.js` starts only after glen's module graph has loaded, which costs one round trip before maplibre arrives. maplibre is the largest file, so this needs measuring on the preview against today's page before deciding.
  - If the cost matters, the template can keep one optional `<link rel="preload">` for maplibre. That line is an optimisation, not a requirement, and skipping it only costs time.
  - Alternatively, `main.js` can start these loads at the top of its first module, before its CDN imports resolve.
- **Stylesheet order.** glen's sheets must come before the app's own, so the app's rules still win ties. `loadStylesheets` in `core/boot.js` already places harness sheets this way (SchmidtDSE/glen#510). glen's three sheets would follow the same rule, inserted before the page's first stylesheet.
- **A page without JavaScript modules** shows nothing either way, so nothing changes there.
- **One list to keep current.** The marked, DOMPurify and highlight.js entries come from the harness (`CHAT_SCRIPTS`), so glen lists only maplibre and pmtiles. A test checks that each entry has a hash and a pinned version.

## What would change

- **`core/main.js` and `core/boot.js`:**
  - Add maplibre (script and CSS) and pmtiles from a list, before the map is made.
  - Call the harness's `loadChatDeps` scripts for marked and DOMPurify.
  - Add glen's three stylesheets.
- **glen-template, `docs/guide/quickstart.md` and the converter's output:** the page shrinks to a `<link>` for the app's own stylesheet and the `main.js` script tag. This is a separate PR in glen-template after a glen release.
- **SchmidtDSE/glen#344** gets a comment pointing to this note, as the decision it amends.

## Not proposed

- **Vendoring any of these libraries into glen**, for the reasons in #344.
- **Bundling glen into one file.** That is SchmidtDSE/glen#526 (npm), a separate question.
