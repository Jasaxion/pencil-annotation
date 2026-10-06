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
- **Drawing list** — browse handwriting archives without stroke totals, open/export them or permanently delete only their handwriting; available from settings and the toolbar.
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

1. Back up the entire `data/storage/petal/pencil-annotation/` directory, install **0.4.2**, restart SiYuan and refresh all browser/PWA clients. Existing storage/coordinates are retained; do not mix editing pages that still cache old scripts.
2. Do not mix editing versions. Old clients cannot read subsequent v2 changes; replacing the script with an old version is not a data rollback.
3. If an old client changes the legacy file, editing/saving pauses. After refreshing old clients, use **Merge legacy handwriting** in Export: it preserves the old file and adds new/changed values, never interprets absence as deletion, and keeps conflicts. This action cannot reimport retired data from a deleted document.
4. For capacity/integrity errors, keep the page open. Undo unsent changes or download a JSON backup from Export. That backup covers loaded state and local changes, not unobserved remote data. If initial loading fails, preserve the complete server-side directory first.

File, aggregate-document, session and retirement limits are defined in `src/engine/sync.ts` and `src/plugin/api.ts`. Reaching them pauses work instead of truncating data. Many long-lived writer sessions may require controlled maintenance; do not manually discard migration bases, latest snapshots or tombstones.

A save confirms local-kernel write/read-back, not delivery to every separate workspace. Failed writes are retained and retried a bounded number of times. Unacknowledged changes can still be lost on process kill, power failure or offline shutdown.

## Drawing list (lightweight archive directory)

- Open it from the **toolbar list icon**, **plugin settings → Drawing list**, or the plugin command. One compact native dialog serves desktop and mobile.
- List **current-generation archive files**, without downloading stroke points, migration bases or cumulative snapshots to count ink. Cleared/empty archives remain listed; retired generations and deletion-marker-only directories do not. Unsaved session changes are labelled separately.
- Cache the directory for 30 seconds and accessible title/path metadata for five minutes within the plugin session. Unchanged warm reopens make no requests. Local changes recheck affected archives; sync and name/notebook changes invalidate relevant caches. Refresh forces a check. These are display hints only: destructive/export actions validate current state again.
- Search title/path/ID, show more results, cancel checks and overlap at most four lightweight requests with coalesced UI updates. No persistent index or whole-note-library content scan is created. First open after restart, large directories and slow networks still take time, but listing no longer reads complete ink payloads.
- An available archive means its file exists, not that its contents are healthy; opening/exporting still reads and validates the required data.
- **Open** navigates to the note. **Export** opens the matching note and reuses the PDF/PNG/JSON dialog. Closing the manager cancels pending export preparation instead of showing a late popup.
- **Delete ink permanently retires only the selected handwriting generation, never the note body.** Confirmation is required; stale rows/approvals cannot delete a newer generation. New handwriting remains possible in the same note. Already-confirmed cleanup finishes safely even if the window closes; history/downloaded backups and necessary retirement markers remain outside physical erasure.
- Closed/locked notebooks, unavailable metadata or corrupt data are labelled, not treated as automatic deletion. Read-only access cannot delete ink. Large collections may take time to scan; discovered results remain usable and scanning is cancellable.

## Full PDF export

- **Current visual layout** is the default. The full kernel source retains superblock structure and folded/unloaded content, rather than taking a viewport screenshot. Loaded SQL embeds use their currently displayed static results; unloaded regions use bounded native previews or explicit placeholders. Embedded scripts are not executed.
- Resolve old ink against its **currently displayed block/embedded occurrence**, checking witnessed anchor dimensions, text and image references. This does not infer historical authorship. **One SQL embed no longer sends all document ink to an appendix.** Only individually missing, ambiguous or changed anchors fall back, without rewriting saved ink or the source note.
- **Best-effort export defaults on.** Unsupported databases/diagrams/media use compatible text or placeholders and visible notes. Turning it off stops on content that cannot be validated in the selected mode. Source-change, access/security, final raster decode and page/pixel/output protections remain enforced.
- The optional **SiYuan static preview** retains the previous export path. References may become footnotes and layout can change; this fallback remains more conservative about old SQL ink. Choose the default current layout to reproduce the page you presently see.
- Current body width/typography produce fixed-A4 **image PDFs**, not searchable/selectable text. Current positioning is neither historical recovery nor character-level anchoring; check complex layouts after export. Individual fallback previews are bounded; keep the note/JSON backup for full data.
- One cancellable job at a time with page-sized canvases released as work proceeds. Compatibility notes follow content and legitimate below-document handwriting.
- On-demand `pdf.js` generates and downloads the PDF in the browser, **without uploading a generated PDF**. Current-layout text/SQL exports use lightweight metadata instead of a redundant full native render. File/network images retain native resource preparation. Necessary drawing, validation and page progress remain; stroke totals are no longer reported. PNG-to-assets remains a separate explicit upload action.
- Local temporary **SiYuan 3.8.6** Chromium/WebKit tests cover responsive superblocks, duplicate SQL occurrences with ink on the note, complete long documents, the manager and unchanged note files after ink deletion. No real user notes, Docker containers or separate-workspace cloud-sync runs were used.

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

`test/performance.mjs` checks exact segment/dot hits, batched offsets, lazy offscreen outlines, unchanged pixels, deferred selection snapshots and stalled-frame fallback. `test/drawing-list.mjs` measures zero stroke-JSON reads during archive checks, zero-request warm reopen, targeted invalidation and safe cleanup. `test/current-pdf.mjs` covers current layout, pixels, safe content and omitted redundant previews. Existing sync/deletion/input/native-preview suites remain enabled. The temporary-kernel host suite validates the actual GUI, image resources, PDFs and unchanged note files after ink cleanup.

Browser/mobile-viewport automation is **not physical Android/iPad or installed-PWA certification**. Hardware pressure, OS palm rejection and interruptions still need device checks; WebKit pen injection in the tests uses synthetic events.

## Known limitations (v1 roadmap)

- Coordinates use CSS pixels, not physical screen pixels. Strokes follow their anchor block's translation, not individual characters. Different desktop/tablet/phone layouts, font sizes or wrapping can misalign ink; use native text highlighting for an exact text range.
- No layers, no lasso multi-select, no pixel eraser (planned).
- Undo history is per-session and resets when the document closes (strokes themselves persist).
- Very long documents use a viewport canvas with culling; thousands of strokes may need tile caching for smoother scrolling.

## Upstream adoption

Reviewed upstream `d590d3e` (its 0.3.0). Selectively adapted `6056a57` segment/dot hit testing, `a1ac9dc` batch-reuse ideas and `5ecf02f` stalled-frame fallback. Added lazy offscreen outlines and selection snapshots only on movement in this fork. No whole-branch merge or global smoothing, width-rendering or post-lift/retroactive snapping changes were applied. Native wheel handling and continuous pen-down recovery already work here and are not intercepted again.

## License

MIT. Block-relative coordinate and PDF ideas were adapted from upstream `a46944b`, retaining the original project's license and attribution.