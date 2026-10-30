# AGENTS.md — homepage-cms

Instructions for AI coding agents working in this repository. Human-oriented documentation is in [README.md](README.md) (Japanese); read sections 1, 6 and 8 before changing code. The public site lives in the sibling repository `homepage` (see its AGENTS.md).

## What this is

The admin screen (CMS) of the 凌美会 art club website: a Google Apps Script web app (`AppMain.js` serves `Ui.html`, which inlines the five screen scripts `UiCore.html`, `UiMedia.html`, `UiPreview.html`, `UiEditors.html`, `UiPublish.html` in that order, and `UiStyles.html`). Server files are grouped by a name prefix, since the Apps Script editor has no folders (README section 8-1): `App…` (entry, config, shared utilities, login, error mail, Gemini client), `Content…` (content API, format, sheets, change history, proofreading, site build), `Media…` (image API, publish-time folder work, folders, storage, catalog). Functions called from the screen live in `ContentApi.js` / `MediaApi.js` (plus the feature files named in README 8-1). Helpers used by two or more groups go in `AppUtil.js`. All files share one global scope; put only declarations and constant values at the top level of a file (Apps Script loads files in no fixed order). The tests load every server `.js` (`tests/files.cjs`). It stores content in Google Sheets and images in Google Drive, and "公開する" starts a GitHub Actions build in the `homepage` repository. Users are club members, not engineers; all UI text is Japanese.

## Commands

```bash
node --test tests/*.cjs                       # unit tests (no Google access)
node tools/preview/build.cjs                  # local preview with sample data -> tools/preview/out/preview.html
npm install --prefix tools/preview            # once, for the screenshot runner
node tools/preview/shoot.cjs                  # drives every feature, saves screenshots, reports problems
```

`shoot.cjs` needs Chrome (and network for the SheetJS check). It prints: page overflow at several phone/tablet sizes, JavaScript errors, screen-script functions that never ran, and whether SheetJS loaded with SRI. It exits with code 1 when it finds a problem.

## Hard rules

- **Never** run `clasp push`, change deployments, `git commit`/`git push`, or send anything to an external service unless the maintainer explicitly asks in this conversation. Deployment is done by the maintainer (README section 4).
- **Never** read credentials or key files (service-account JSON, `.clasprc.json`, private keys, anything in a user's key folder) and never print Script Property values. If a task needs them, ask the maintainer to run that step.
- The screen scripts (`UiCore.html` … `UiPublish.html`) are inlined by HtmlService. They must not contain the literal strings `https://`, `http://`, `//` (so no `//` comments; use `/* */`), `image/*`, or an SVG `xmlns`. Build URLs with `URL_PROTOCOL + '…'` and write `'image/' + '*'`. `tests/ui-script.test.cjs` checks this.
- The content saved in `_PublishedState` and `_Drafts` is the contract between the CMS and the site build (`homepage/scripts/fetch_google_content.py`). Its shape is `CONTENT_FIELDS` in `ContentModel.js` (`formatVersion` 2, README section 8-4); change both repositories and both READMEs together. Content of another format version is refused (`requireContentFormat_`, and `read_published_content` in the site build). To change the format, raise the version and convert older versions in those two places only; remove the conversion once a publish has rewritten the stored content. The CMS and the site may be deployed in either order.
- One value, one name: do not store values that other values determine, and do not add second names for an existing value.
- Write to content sheets through `writeSheet_` (it sets the plain-text format `@` so values are not turned into formulas, dates or numbers).
- Some class names are assembled in code (e.g. `is-${placement}`, `'is-' + type`). Before removing CSS or functions as unused, search for the parts of the name and run the preview screenshots.
- Files that must not reach Apps Script (Node tools, docs, tests) go in `.claspignore`.
- Preserve each file's line endings (many files are CRLF) when editing with scripts.

## Conventions

- **Errors**: every catch site calls `showError(error, '操作名', target)` (`target` is `''`, `'auth'` or `'media'`). Classification and hints live in `ERROR_RULES`. Messages tell the member what to do next, in plain Japanese.
- **Styles**: use the tokens at the top of `UiStyles.html` (`--space-*`, `--radius-*`, `--fs-*`). Text follows the Digital Agency guideline for Japanese: 16px for body and UI, never below 14px. Touch targets are at least 44px on phones. No decorative gradients, blur or large shadows. The "サイトプレビュー" section of `UiStyles.html` mirrors the public site and is exempt.
- **Images**: render Drive images with `mediaImageHtml(file)` and call `hydrateThumbnails(container)` after inserting HTML. Images in link-shared folders (`file.public`) load straight from Drive; private ones are fetched through `getMediaThumbnails` (the browser cannot read private Drive files, the server runs as the owner). Never put a private image's Drive URL in an `<img>`.
- **Previews**: the right-hand previews are built only after the member presses 「プレビューを表示」 (`openPreview`, `ensurePreviewOpen`). Do not make tab switches or typing call the server while a preview is closed.
- **Explanations**: do not add always-visible notes. Put occasional explanations behind a `?` button (`data-help` box + `${HELP_BUTTON}` + `.help-text`).
- **Comments**: Japanese, and only for what the code cannot say (a reason, a constraint of Apps Script or Google, an agreement with the site build, a past incident). Prefer clearer names and structure over a comment. Consistency with how the rest of the code does the same thing comes first.
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
