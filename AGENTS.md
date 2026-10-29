# AGENTS.md — homepage-cms

Instructions for AI coding agents working in this repository. Human-oriented documentation is in [README.md](README.md) (Japanese); read sections 1, 6 and 8 before changing code. The public site lives in the sibling repository `homepage` (see its AGENTS.md).

## What this is

The admin screen (CMS) of the 凌美会 art club website: a Google Apps Script web app (`Code.js` serves `Ui.html`, which inlines `UiScript.html` and `UiStyles.html`). It stores content in Google Sheets and images in Google Drive, and "公開する" starts a GitHub Actions build in the `homepage` repository. Users are club members, not engineers; all UI text is Japanese.

## Commands

```bash
node --test tests/*.cjs                       # unit tests (no Google access)
node tools/preview/build.cjs                  # local preview with sample data -> tools/preview/out/preview.html
npm install --prefix tools/preview            # once, for the screenshot runner
node tools/preview/shoot.cjs                  # drives every feature, saves screenshots, reports problems
```

`shoot.cjs` needs Chrome (and network for the SheetJS check). It prints: page overflow at several phone/tablet sizes, JavaScript errors, `UiScript.html` functions that never ran, and whether SheetJS loaded with SRI. It exits with code 1 when it finds a problem.

## Hard rules

- **Never** run `clasp push`, change deployments, `git commit`/`git push`, or send anything to an external service unless the maintainer explicitly asks in this conversation. Deployment is done by the maintainer (README section 4).
- **Never** read credentials or key files (service-account JSON, `.clasprc.json`, private keys, anything in a user's key folder) and never print Script Property values. If a task needs them, ask the maintainer to run that step.
- `UiScript.html` is inlined by HtmlService. It must not contain the literal strings `https://`, `http://`, `//` (so no `//` comments; use `/* */`), `image/*`, or an SVG `xmlns`. Build URLs with `URL_PROTOCOL + '…'` and write `'image/' + '*'`. `tests/ui-script.test.cjs` checks this.
- Keep stored data backward compatible: add sheet columns at the end, keep columns that are no longer used, and make new code read old rows. The CMS and the site may be deployed in either order.
- Write to content sheets through `writeSheet_` (it sets the plain-text format `@` so values are not turned into formulas, dates or numbers).
- Files that must not reach Apps Script (Node tools, docs, tests) go in `.claspignore`.
- Preserve each file's line endings (many files are CRLF) when editing with scripts.

## Conventions

- **Errors**: every catch site calls `showError(error, '操作名', target)` (`target` is `''`, `'auth'` or `'media'`). Classification and hints live in `ERROR_RULES`. Messages tell the member what to do next, in plain Japanese.
- **Styles**: use the tokens at the top of `UiStyles.html` (`--space-*`, `--radius-*`, `--fs-*`). Text follows the Digital Agency guideline for Japanese: 16px for body and UI, never below 14px. Touch targets are at least 44px on phones. No decorative gradients, blur or large shadows. The "サイトプレビュー" section of `UiStyles.html` mirrors the public site and is exempt.
- **Explanations**: do not add always-visible notes. Put occasional explanations behind a `?` button (`data-help` box + `${HELP_BUTTON}` + `.help-text`).
- **Comments**: match the surrounding code (short Japanese comments in the GAS/UI files).
- **Preview mock**: `tools/preview/mock-backend.js` mirrors the server functions' return values and messages. When you add or change a server function the UI calls, update the mock, and add steps to `shoot.cjs` so the new UI code runs (the "never ran" list must stay empty).

## How to verify a change

1. `node --test tests/*.cjs`
2. For anything visible: `node tools/preview/build.cjs` then `node tools/preview/shoot.cjs`, and look at the relevant screenshots in `tools/preview/out/shots/` (desktop and mobile). Phone sizes are emulated as real phones (viewport meta honoured).
3. Server-side code cannot be run locally; cover it with tests in `tests/` (they load the `.js` files into a `vm` context with stubbed Google services).

## Working with the maintainer

- Report in Japanese, in plain words; spell out abbreviations. Say what you verified and what you could not verify.
- For design changes, show before/after screenshots and get agreement before finalizing.
- Ask before decisions that are the maintainer's to make (wording visible to members, removing features, anything irreversible).
- When behaviour that members see changes, update `docs/index.html` (the members' help page; its URL has been shared, so keep the path). When setup, operation or design decisions change, update `README.md`.
