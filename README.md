# Pencil Annotation

Handwrite on SiYuan documents with **Apple Pencil / Android pens / drawing tablets**. Ink is stored in the workspace's private plugin directory. Browsers connected to one Docker instance share that data; separate workspaces rely on SiYuan synchronization.

> This is Jasaxion's personal-maintenance fork of [BUGdefender404/pencil-annotation](https://github.com/BUGdefender404/pencil-annotation). Install this repository's builds; marketplace updates can overwrite the customized version. Version 0.3.0 introduces a new sync store: back up the complete plugin data directory and refresh every editing browser/PWA before upgrading.

> The upstream project was inspired by [Cherise233/siyuan-document_drawing-plugins](https://github.com/Cherise233/siyuan-document_drawing-plugins). This fork builds on BUGdefender404's MIT implementation, focusing on browser input, cross-device placement, reliable synchronization and export.

## Features

- **Pressure pen** — stylus pressure via Pointer Events, including Android pens and Apple Pencil where the device/browser reports it. Mouse drawing is off by default; when enabled it uses fixed width.
- **Highlighter** — translucent, `multiply`-blended so text stays readable through the mark; overlaps between strokes deepen naturally (no dark spots inside a single stroke).
- **Eraser** — stroke-level erase while dragging, adjustable size, with a cursor ring.
- **Select** — tap a stroke to select, then drag to move, duplicate or delete it.
- **Undo / redo** — toolbar buttons (plus `Ctrl+Z` / `Ctrl+Shift+Z` on desktop), up to 100 steps.
- **Writing-first inputs** — the pen draws, fingers only pan (including horizontal tables), and the mouse edits normally unless mouse drawing is enabled. Palm contacts are rejected during ink input. Exit drawing mode before tapping tasks, resizing tables or editing by touch; normal pen/touch interaction is restored on exit. SiYuan 3.8 table/gutter editing controls also reject pen activation and pen context menus without blocking ordinary mouse use.
- **Pen-tip double-tap** — optionally tap the page twice to switch pen ↔ eraser. Off by default to avoid mistaking punctuation for a gesture; existing explicit preferences are preserved. This is not the pen's barrel gesture.
- **Floating toolbar** — draggable handle + palette with position memory. Hide the handle in settings; desktop top-bar/command entry remains available, and mobile users can restore it in plugin settings. The toolbar wraps on narrow screens.
- **Export** — full-note image-based PDF with handwriting and browser download; handwriting-only PNG save/insert; raw JSON backup including unsaved local changes.
- **English & Simplified Chinese UI**.

## Storage & multi-device sync

Version 0.3.0 keeps the existing private directory, but independent browsers no longer overwrite a single shared JSON file:

```text
{workspace}/data/storage/petal/pencil-annotation/
  {docID}.json                          # legacy source; removed after confirmed document deletion
  sync-v2/{docID}/
    base-{content-hash}.json            # deterministic migration backup
    w{writer-session}-{sequence}.json   # immutable cumulative snapshots
    retired-v1.json                    # post-deletion old-client guard, no ink
    g{generation}/...                  # fresh ink after document restoration
  document-lifecycle/{docID}/
    deleted-{generation}.json          # confirmed retirement boundary, no ink
    active-{generation}.json           # restored lifetime has been opened, no ink
```

- Anchored ink uses block-relative coordinates. Legacy points are migrated from their recorded creation origin, not guessed from the current device's layout. Unanchored ink remains document-relative.
- Add/move/delete operations affect observed value revisions. Concurrent edits remain separate selectable copies; concurrent move/delete preserves the moved copy. Unseen additions are not removed by clear-all.
- Split views share state; independent writers use unique identities. Saves are debounced by 1.2 seconds, and visible documents check for new snapshots every five seconds. Normal migrated-data polling downloads only newly named snapshots.
- Keep the newest two verified cumulative snapshots per writer. Do not expire other writers or deletion markers. Saved deletion before-images are retained: **visual deletion is not secure erasure**.
- Remote edits invalidate older undo entries affecting those logical strokes, rather than allowing undo to overwrite another device's work.

### Document deletion

- Successful kernel document-deletion notices retire the document and included descendant documents' old ink files, migration bases and snapshots, fencing late writes. **Restoring a document from history does not restore its retired ink**; new handwriting uses a new generation.
- Ordinary original-lifetime deletion is automatic. SiYuan 3.8.6 notices have no unique occurrence ID. Restored documents, closed/locked notebooks and ambiguous cases preserve data and request confirmation. Cancel keeps the unconfirmed generation. Missing documents, closed notebooks and network failures alone never authorize deletion.
- Small ID/generation-only markers prevent resurrection; **do not delete these markers manually**. While enabled, the plugin gradually re-cleans late old-generation files without removing newer restored ink.
- Offline/plugin-disabled missed notices cannot be safely reconstructed. Keep the page open after cleanup failures; reconnecting/returning retries and asks confirmation when needed. Cleanup covers current plugin storage, not SiYuan history, cloud/system backups or downloaded PDF/JSON copies.

### Upgrade and recovery

1. Back up the entire `data/storage/petal/pencil-annotation/` directory, install this 0.3.0 build, restart SiYuan and refresh all browser/PWA clients. Refresh even when the displayed version is unchanged, to replace cached scripts.
2. Do not mix editing versions. Old clients cannot read subsequent v2 changes; replacing the script with an old version is not a data rollback.
3. If an old client changes the legacy file, editing/saving pauses. After refreshing old clients, use **Merge legacy handwriting** in Export: it preserves the old file and adds new/changed values, never interprets absence as deletion, and keeps conflicts. This action cannot reimport retired data from a deleted document.
4. For capacity/integrity errors, keep the page open. Undo unsent changes or download a JSON backup from Export. That backup covers loaded state and local changes, not unobserved remote data. If initial loading fails, preserve the complete server-side directory first.

File, aggregate-document, session and retirement limits are defined in `src/engine/sync.ts` and `src/plugin/api.ts`. Reaching them pauses work instead of truncating data. Many long-lived writer sessions may require controlled maintenance; do not manually discard migration bases, latest snapshots or tombstones.

A save confirms local-kernel write/read-back, not delivery to every separate workspace. Failed writes are retained and retried a bounded number of times. Unacknowledged changes can still be lost on process kill, power failure or offline shutdown.

## Full PDF export

- Fetch the full kernel preview and source-block inventory, including folded/unloaded content, rather than a viewport screenshot. SQL embeds and references use native static export and remain subject to query/export limits. Empty responses do not prove zero query results.
- **Best-effort export defaults on.** Unsupported databases, diagrams or media use compatible text/placeholders; unverified blocks and degradations are listed in the PDF and dialog. Turn it off for strict validation, which stops on unverifiable content.
- Reliably positioned ink is composited at export-local block origins. Unverifiable ink gets a labelled thumbnail appendix without changing the note. **If the document contains SQL embeds, all old block-ID-only ink is conservatively placed in the appendix:** current results cannot establish its historical embed-instance identity. Appendix previews are bounded; preserve the note/JSON backup for full data.
- Preserve body width/typography in fixed-A4 **image PDF** pages, not searchable/selectable text. Security/access checks, source changes during preparation, final raster decode failures and page/pixel/output limits remain enforced in both modes.
- One export job at a time; cancel/close cleanup and page-sized raster surfaces. Compatibility notes follow native content and any legitimate below-document handwriting.
- The on-demand `pdf.js` module generates and downloads the PDF in the browser, **without uploading the generated PDF**. SiYuan may still prepare/cache referenced resources. The separate PNG-to-assets action intentionally uploads PNGs.
- Current isolated **SiYuan 3.8.6** Chromium/WebKit tests cover SQL/references, final-page ink and unchanged server-workspace PDF files after download. Actual Docker-container and separate-workspace cloud-sync tests were not performed.

## Install (dev build)

1. `npm install && npm run build` → output in `build/`;
2. copy everything from `build/` into `{SiYuan workspace}/data/plugins/pencil-annotation/`, or run:
   ```bash
   node scripts/copy-assets.mjs "/path/to/workspace/data/plugins"
   ```
3. restart SiYuan (or reload from Settings → Marketplace) and enable **Pencil Annotation** under downloaded plugins.

### Docker, Android tablets/phones and browser PWAs

The manifest supports the `docker` backend and both browser frontends. Install the built files in the **container's actual workspace** under `data/plugins/pencil-annotation/`; persist the workspace and ensure it is writable. Drawing runs in the browser, so the container needs neither a stylus nor Node.js at runtime.

Android tablets, pen-capable phones and PWAs use the same input path. Real pressure requires the browser to report `pointerType="pen"`. If the driver exposes a tablet only as a mouse, the browser cannot distinguish it from a real mouse: prefer the driver's pen/pressure mode (Windows Ink on Windows), or enable mouse drawing as a fallback. Include OS/browser versions, pen model and PWA status in device bug reports.

### On the iPad

Use Safari/PWA to access a SiYuan service with this fork installed. The marketplace package is the upstream version, not this personalized build; do not use it to overwrite the fork.

Native iOS workspaces are sandboxed. If using the app, use a supported plugin installation/sync method and keep every editing client on the same protocol version.

## Release process (maintainer)

1. Update versions in `plugin.json`, `package.json`, the lockfile and `CHANGELOG.md`.
2. Run typecheck, regression and host checks, then `npm run pack`.
3. Install all files from the new ZIP, including `pdf.js`, reload the plugin and refresh browser/PWA clients.
4. Commits, pushes, tags and Releases remain explicit maintainer actions; this fork does not automatically publish to the official marketplace.

## Development

```bash
npm install
npm run typecheck
npm run build       # index.js + on-demand pdf.js + static assets
npm run deploy -- "/path/to/workspace/data/plugins"  # copies an existing build
npm run harness     # browser test bench at http://localhost:5199/test/harness.html
npx playwright install chromium webkit
npm test            # both engines; BROWSER=chromium selects one
SIYUAN_KERNEL=/path/to/SiYuan-Kernel npm run test:host  # optional real-host check
npm run pack
```

`test/sync.mjs` checks migration and concurrent state. `test/deletion.mjs` covers explicit deletion, late writes, restored generations, stale confirmations and load races. `test/regression.mjs` retains input/storage checks; `test/pdf.mjs` checks page pixels, static embeds, compatibility appendices and failure cleanup. `test:host` uses a disposable workspace for real multi-browser concurrency, pen/mouse table controls, full PDF/SQL/reference export without PDF upload/server artifacts, and parent/child deletion with genuine history restore and confirmation/cancellation. Existing user notes are not opened.

Browser/mobile-viewport automation is **not physical Android/iPad or installed-PWA certification**. Hardware pressure, OS palm rejection and interruptions still need device checks; WebKit pen injection in the tests uses synthetic events.

## Known limitations (v1 roadmap)

- Coordinates use CSS pixels, not physical screen pixels. Strokes follow their anchor block's translation, not individual characters. Different desktop/tablet/phone layouts, font sizes or wrapping can misalign ink; use native text highlighting for an exact text range.
- No layers, no lasso multi-select, no pixel eraser (planned).
- Undo history is per-session and resets when the document closes (strokes themselves persist).
- Very long documents use a viewport canvas with culling; thousands of strokes may need tile caching for smoother scrolling.

## License

MIT. Block-relative coordinate and PDF ideas were adapted from upstream `a46944b`, retaining the original project's license and attribution.