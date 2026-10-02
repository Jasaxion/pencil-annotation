# Changelog

## 0.3.0 (2026-10-02)

- Adopt block-relative anchored ink with deterministic legacy migration, preserved zero origins/fallback placement, export-local projections, and atomic reanchor/undo geometry.
- Add independent immutable writer snapshots under `sync-v2/`; moves and deletes retire observed value revisions instead of overwriting another browser's JSON. Concurrent edits remain separate selectable copies.
- Preserve old files, verify writes/read-back, keep two covered cumulative snapshots per writer, release caches for closed clean documents, and pause on integrity/capacity errors. Add raw JSON backup and explicit additive legacy reconciliation.
- Add full-note browser PDF export, adapted from upstream `a46944b`: full-source coverage checks, folded/unloaded content, title/math/ink, fixed A4 image pages, bounded strict SVG decoding, cancellation and download links.
- Support SiYuan 3.8.6 static SQL embeds and references despite regenerated export IDs. Best-effort export defaults on, with compatible text/placeholders and in-PDF warnings; strict mode remains available. Unverifiable ink (including provenance-free ink in SQL documents) goes into a labelled appendix instead of being misplaced. Missing-child degradation reaches ancestor anchors; reports stay below legitimate below-document ink.
- Load PDF dependencies only on demand from a separate `pdf.js` browser module; retain lightweight handwriting startup and the existing PNG flow.
- Redesign the export dialog for desktop/mobile, including progress, cancellation, download, backup and sync-recovery actions.
- Fix mobile editor reuse retaining a stale `options.rootId`; use the loaded block's canonical root ID so switching documents cannot attach the previous document's ink.
- Isolate pen down and pen context menus on the owning editor's 3.8 table/gutter auxiliary controls, preserving normal mouse input, toolbar behavior and continuous strokes.
- Permanently retire document handwriting on verified successful deletion, including notified child documents. Use immutable lifecycle markers and fresh restored-document namespaces, fence/settle old writes, invalidate retired stores and clean late old-generation files. Ambiguous/reused-ID notifications require confirmation; missing/closed/locked documents alone never authorize erasure. Existing history/cloud/downloaded backups are outside this cleanup.
- Ignore obsolete initial-load errors after a newer load recovers; scope export cancellation to the deleted document.
- Expand state, browser and real-host tests for concurrent writers/restarts, selective conflicts, old-client barriers/import, budgets, PDF pixels/downloads, static embeds, deletion races and genuine history restore/confirmation. On isolated SiYuan 3.8.6, both browser engines verified no generated PDF upload or new workspace PDF file. Actual Docker-container/cloud-sync runs were not performed.

## 0.2.4 (2026-10-01)

- Declare the Docker backend to fix the compatibility false negative.
- Add floating-button visibility and independent mouse drawing (off by default).
- Use writing-first input routing: native mouse editing remains available; fingers pan without activating document controls. Intercept Pointer, Touch and compatibility Mouse events before SiYuan's touch-to-mouse bridge.
- Apply the gesture policy before contact, pace finger panning to animation frames, bound inertia, and arbitrate palm rejection across split views and the palette.
- Continue sampling after capture loss until contact ends; retain coalesced/up endpoints and release pressure, including down/up-only short strokes. Paint completed strokes with the final renderer path.
- Snapshot each stroke's tool/color, and make toolbar drag/cancel/disposal pointer-owned so foreign contacts cannot toggle drawing mode.
- Preserve sampled ink and completed dots on interruption/navigation; reset canvas clipping between paints and refresh input policy after editor replacement.
- Block drawing until a successful initial read, reject failed/malformed reads, share split-view stores, serialize saves and retain failed detached writes for retry.
- Default pen-tip double-tap to off (preserve existing preferences), avoiding accidental eraser switches while writing punctuation.
- Wrap the toolbar on narrow phones and keep controls within the viewport after rotation.
- Add Chromium/WebKit regression checks and optional isolated SiYuan-host integration tests. Physical-device/PWA verification is separate from browser emulation.
- Fix the packaging script on macOS/Linux and fail explicitly when the archiver fails instead of reporting a nonexistent ZIP.

## 0.2.3 (2026-10-01)

- 新增：图形识别（GoodNotes 风格）——钢笔/荧光笔画完停顿约半秒，自动变规则图形：
  直线（水平/竖直自动对齐）、矩形、三角形、椭圆；停顿后再移动笔立即恢复手绘，提交的就是规整后的笔迹
- 设置新增「画完停顿自动变规则图形」开关（默认开启）

## 0.2.2 (2026-10-01)

iPad 端体验修复（对齐 GoodNotes 交互：笔写字、手翻页）：

- 手指翻页：手写模式下手指重新可以滚动/翻页（带惯性），仅触控笔落笔；手掌握着写字不会误触发翻页
- Apple Pencil 双击切换钢笔/橡皮：修复双击间隔落在 300–420ms 之间时永远无法切换的死区，双击后不再残留点迹
- 手写球支持用 Apple Pencil 点击进入手写模式：落笔微抖不再被误判为拖动（8px 拖拽阈值）

## 0.2.1 (2026-10-01)

- 修复：钢笔笔迹不跟随文字块重排
  - 钢笔快速点按的点（双击检测的延迟提交路径）此前丢失块锚点，现在正常记录
  - 旧版本绘制的无锚点笔迹在加载时自动回填锚点（对最近文字块），之后随块移动并持久化
- 修复：文档内容变化（插入/删除段落、重渲染）后笔迹不重绘的问题；窗口最小化/遮挡期间也能正常重绘

## 0.2.0 (2026-10-01)

- 粗细改为滑杆连续调节：钢笔 1–20（步进 1，上限可在设置中调大）、荧光笔 10–60、橡皮擦 10–50（步进 5）
- 修复：思源全局样式把工具栏/工具球/顶栏的描边图标填充成实心团，所有图标恢复清晰线条
- 工具栏支持拖到屏幕四边吸附停靠，左右两侧自动竖排（滑杆沿边竖向滑动）
- 设置新增「钢笔滑杆上限」

## 0.1.0 (2026-09-30)

首个开发版。

- 压感钢笔（Apple Pencil 真实压感；鼠标/触摸自动模拟）
- 荧光笔（multiply 混合，文字透过可见）
- 橡皮擦（整笔擦除，光标圈，三档大小）
- 选择：点选笔迹后拖动 / 复制 / 删除
- 撤销 / 重做（100 步）
- 手掌防误触（手指滚动，仅触控笔落笔，可关闭）
- Apple Pencil 双击切换钢笔/橡皮（可关闭）
- 可拖动浮动工具栏 + 桌面端顶栏入口
- 笔迹按文档存于插件私有数据目录，随思源云同步，多设备按笔迹 ID 增量合并
- 导出 PNG（白底/透明底）到 assets，可一键插入文档
- 中英双语
