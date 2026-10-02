import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createServer} from "vite";
import {chromium, webkit} from "playwright";
const server = await createServer({server: {host: "127.0.0.1", port: 5199, strictPort: true, allowedHosts: ["pencil.test"]}});
await server.listen();
try {
    for (const engine of process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"]) {
        const browser = await ({chromium, webkit}[engine]).launch(engine === "chromium" ? {
            channel: "chromium", args: ["--host-resolver-rules=MAP pencil.test 127.0.0.1", "--no-proxy-server"],
        } : {});
        const origin = engine === "chromium" ? "http://pencil.test:5199" : "http://127.0.0.1:5199";
        try {
            const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, acceptDownloads: true});
            const page = await context.newPage();
            await page.goto(`${origin}/test/harness.html`);
            await page.waitForFunction(() => window.harness?.overlay.store.loaded);
            if (engine === "chromium") assert.equal(await page.evaluate(() => isSecureContext), false, "exercise HTTP LAN capabilities, not localhost's secure exception");
            const result = await page.evaluate(async () => {
                const h = window.harness;
                const {buildNotePdfBlob: buildPdf} = await import("/src/plugin/exportPdf.ts");
                const buildNotePdfBlob = (input, options) => buildPdf(input, {layout: 'native', ...options});
                const docId = h.overlay.docId;
                const blocks = Array.from({length: 12}, (_, i) => `<div data-node-id="pdf-${i}" data-type="NodeParagraph" style="height:180px;position:relative;box-sizing:border-box;margin:0">Marker ${i}<div style="position:absolute;left:20px;top:120px;width:30px;height:20px;background:#0000ff"></div></div>`).join("");
                const input = {docId, source: h.wysiwygEl, strokes: [{id: "ink", tool: "pen", color: "#ff0000", width: 8, opacity: 1, simulate: false,
                    createdAt: 1, anchor: {blockId: "pdf-11", ox: 0, oy: 0}, points: [{x: 70, y: 130, p: .6}, {x: 130, y: 135, p: .7}]}]};
                const request = async (path, data) => path.endsWith("getBlockDOM")
                    ? {id: data.id, dom: blocks}
                    : {id: data.id, name: 'PDF <title> / test', type: "NodeDocument", attrs: {}, content: `<div data-node-id="${docId}" data-type="NodeHeading">PDF title</div>${blocks}`};
                const canvases = [], pixels = [];
                const nativeEncode = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
                    if (type === "image/jpeg" && quality === .94) {
                        canvases.push(this);
                        const bytes = this.getContext("2d").getImageData(0, 0, this.width, this.height).data;
                        let red = 0, blue = 0;
                        for (let i = 0; i < bytes.length; i += 4) {
                            if (bytes[i] > 180 && bytes[i+1] < 80 && bytes[i+2] < 80) red++;
                            if (bytes[i+2] > 180 && bytes[i] < 80 && bytes[i+1] < 80) blue++;
                        }
                        pixels.push({red, blue, width: this.width, height: this.height});
                    }
                    return nativeEncode.call(this, type, quality);
                };
                let pdf;
                try { pdf = await buildNotePdfBlob(input, {signal: new AbortController().signal, request}); }
                finally { HTMLCanvasElement.prototype.toDataURL = nativeEncode; }
                const rendered = {pages: pdf.pages, header: await pdf.blob.slice(0,4).text(), name: pdf.name,
                    last: pixels.at(-1), bounded: pixels.every(p => p.width <= 3800 && p.height <= 3800 && p.width*p.height <= 8010000),
                    released: canvases.every(c => c.width === 0 && c.height === 0), wrappers: document.querySelectorAll(".pa-pdf-host").length};
                const rejects = async (source, preview, extra = {}) => {
                    try {
                        await buildNotePdfBlob({...input, strokes: []}, {signal: new AbortController().signal, bestEffort: false,
                            request: async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: source}
                                : {id: data.id, name: "test", type: "NodeDocument", content: preview, attrs: {}}, ...extra});
                        return false;
                    } catch { return !document.querySelector(".pa-pdf-host"); }
                };
                const incomplete = await rejects(blocks, blocks.replace(/<div data-node-id="pdf-11"[\s\S]*$/, ""));
                const wide = '<div data-node-id="wide" data-type="NodeParagraph"><svg width="1200" height="20"><rect width="1200" height="20" fill="blue"/></svg></div>';
                const overflow = await rejects(wide, wide);
                const clipped = '<div data-node-id="clip" data-type="NodeParagraph"><div style="width:40px;overflow:clip"><div style="width:900px">Hidden content</div></div></div>';
                const clip = await rejects(clipped, clipped);
                const missingImage = '<div data-node-id="image" data-type="NodeParagraph"><img src="/missing-image-test.png"></div>';
                const brokenImage = await rejects(missingImage, missingImage);
                const chart = '<div data-node-id="chart" data-type="NodeCodeBlock"><div class="protyle-action__language">echarts</div></div>';
                let calledChart = false;
                const delayedChart = await rejects(chart, chart, {renderers: {chart: () => { calledChart = true; }}});
                const unsafe = '<div data-node-id="embed" data-type="NodeParagraph"><iframe src="https://example.invalid/"></iframe></div>';
                const rejectedEmbed = await rejects(unsafe, unsafe);
                const decode = HTMLImageElement.prototype.decode;
                let failedDecode;
                try {
                    HTMLImageElement.prototype.decode = function() {
                        if (this.src.startsWith("data:image/svg+xml")) return Promise.reject(new Error("Forced final SVG decode failure"));
                        return decode.call(this);
                    };
                    failedDecode = await rejects(blocks, blocks);
                } finally { HTMLImageElement.prototype.decode = decode; }
                const controller = new AbortController(); let cancelled = false;
                try {
                    await buildNotePdfBlob(input, {signal: controller.signal, request,
                        onProgress: (stage, done) => { if (stage === "page" && done === 1) controller.abort(); }});
                } catch (e) { cancelled = e.name === "AbortError" && !document.querySelector(".pa-pdf-host"); }
                let sourceReads = 0, changed = false;
                try {
                    await buildNotePdfBlob(input, {signal: new AbortController().signal,
                        request: async (path, data) => path.endsWith("getBlockDOM")
                            ? {id: data.id, dom: ++sourceReads === 1 ? blocks : blocks.replace("Marker 0", "Changed")}
                            : request(path, data)});
                } catch (e) { changed = e.message.includes("changed"); }
                const many = Array.from({length: 500}, (_, i) => `<div data-node-id="large-${i}" data-type="NodeParagraph" style="height:600px">Long</div>`).join("");
                const limited = await rejects(many, many);
                return {rendered, incomplete, overflow, clip, brokenImage, delayedChart: delayedChart && !calledChart,
                    rejectedEmbed, failedDecode, cancelled, changed, limited, inputUnaffected: h.overlay.store.strokes.length === 0 && h.overlay.mode};
            });
            assert.equal(result.rendered.header, "%PDF"); assert(result.rendered.pages >= 3);
            assert(result.rendered.last.red > 0 && result.rendered.last.blue > 0, JSON.stringify(result.rendered.last));
            assert(result.rendered.bounded && result.rendered.released && result.rendered.wrappers === 0);
            assert(!result.rendered.name.includes("/"));
            for (const [key, value] of Object.entries(result)) if (key !== "rendered") assert.equal(value, true, key);
            console.log(`${engine}: full PDF pages/ink pixels, bounded canvases, missing/unsafe content, decode failure and cancellation passed`);

            const compatibilityChecks = await page.evaluate(async () => {
                const h = window.harness, {buildNotePdfBlob: buildPdf} = await import("/src/plugin/exportPdf.ts");
                const buildNotePdfBlob = (input, options) => buildPdf(input, {layout: 'native', ...options});
                const docId = h.overlay.docId;
                const p = (id, text) => `<div data-node-id="${id}" data-type="NodeParagraph" class="p">${text}</div>`;
                const embed = id => `<div data-node-id="${id}" data-type="NodeBlockQueryEmbed" class="render-node" data-content="select * from blocks"></div>`;
                const source = p("before", "Before") + embed("embed-a") + p("middle", "Middle reference") + embed("embed-b") + p("after", "After");
                const preview = p("before", "Before") + p("generated-a", "STATIC_QUERY_RESULT") + p("middle", "Middle reference") + p("generated-b", "STATIC_QUERY_RESULT") + p("after", "After");
                let focused = 0;
                const request = async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: source}
                    : data.id === docId ? {id: docId, name: "SQL embeds", type: "NodeDocument", attrs: {}, content: preview}
                        : (focused++, {id: data.id, name: "SQL embeds", type: "NodeBlockQueryEmbed", attrs: {}, content: p(`focused-${focused}`, "STATIC_QUERY_RESULT")});
                const input = {docId, source: h.wysiwygEl, strokes: []};
                const live = document.createElement("div");
                live.innerHTML = ['embed-a', 'embed-b'].map(id => `<div data-node-id="${id}"><div data-node-id="current-result-b">Current result B</div></div>`).join("");
                h.wysiwygEl.append(live);
                const strict = await buildNotePdfBlob(input, {signal: new AbortController().signal, request, bestEffort: false});
                const strictMapped = focused === 2 && strict.warnings.some(w => w.includes("SQL embed"));
                const ink = {id: "embed-ink", tool: "pen", color: "#ff0000", width: 5, opacity: 1, simulate: false, createdAt: 1,
                    anchor: {blockId: "before", ox: 0, oy: 0}, points: [{x: 20, y: 20, p: .6}, {x: 80, y: 30, p: .7}]};
                let appendixAfterContent = false;
                const best = await buildNotePdfBlob({...input, strokes: [ink]}, {signal: new AbortController().signal, request,
                    onProgress: stage => { if (stage === "page") {
                        const svg = document.querySelector(".pa-pdf-compatibility svg"), end = document.querySelector('.pa-pdf-host [data-node-id="after"]');
                        appendixAfterContent = !!svg && svg.getBoundingClientRect().top > end.getBoundingClientRect().bottom;
                    }}});
                let strictInkRejected = false;
                try { await buildNotePdfBlob({...input, strokes: [ink]}, {signal: new AbortController().signal, request, bestEffort: false}); }
                catch (e) { strictInkRejected = /anchor|placement/.test(e.message); }
                const unsupportedSource = p("unsupported", '<iframe src="https://example.invalid/"></iframe><script>window.pdfInjected = true</script>');
                const unsupported = await buildNotePdfBlob(input, {signal: new AbortController().signal,
                    request: async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: unsupportedSource} : {id: docId, name: "Fallback", type: "NodeDocument", attrs: {}, content: unsupportedSource}});
                const missing = await buildNotePdfBlob(input, {signal: new AbortController().signal,
                    request: async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: p("lost", "Unavailable") + p("kept", "Retained")}
                        : {id: docId, name: "Missing", type: "NodeDocument", attrs: {}, content: p("kept", "Retained")}});
                let parentInkSeparated = false;
                const nested = child => `<div data-node-id="parent" data-type="NodeBlockquote">${child}${p("kept-child", "Retained child")}</div>`;
                await buildNotePdfBlob({...input, strokes: [{...ink, anchor: {blockId: "parent", ox: 0, oy: 0}}]}, {signal: new AbortController().signal,
                    request: async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: nested(p("lost-child", "Lost child"))} : {id: docId, name: "Nested", type: "NodeDocument", attrs: {}, content: nested("")},
                    onProgress: stage => { if (stage === "page") parentInkSeparated = !!document.querySelector(".pa-pdf-compatibility svg"); }});
                const reference = p("ref", 'Reference <span data-type="block-ref">same label</span>') + p("end", "Last paragraph");
                let reportAfterInk = false;
                await buildNotePdfBlob({...input, strokes: [{...ink, anchor: {blockId: "end", ox: 0, oy: 0}, points: [{x: 20, y: 400, p: .6}, {x: 80, y: 410, p: .7}]}]}, {
                    signal: new AbortController().signal,
                    request: async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: reference} : {id: docId, name: "Below document ink", type: "NodeDocument", attrs: {}, content: reference},
                    onProgress: stage => { if (stage === "page") {
                        const report = document.querySelector(".pa-pdf-compatibility"), end = document.querySelector('.pa-pdf-host [data-node-id="end"]');
                        reportAfterInk = !report.querySelector("svg") && report.getBoundingClientRect().top >= end.getBoundingClientRect().top + 415;
                    }}});
                const adjacentSource = p("before", "Before") + embed("embed-a") + embed("embed-b") + p("after", "After");
                const adjacentPreview = p("before", "Before") + p("generated-a", "STATIC_QUERY_RESULT") + p("generated-b", "STATIC_QUERY_RESULT") + p("after", "After");
                const adjacentRequest = async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: adjacentSource}
                    : data.id === docId ? {id: docId, name: "Adjacent embeds", type: "NodeDocument", attrs: {}, content: adjacentPreview}
                        : {id: data.id, type: "NodeBlockQueryEmbed", content: p("focused", "STATIC_QUERY_RESULT")};
                let noDuplicateInsertion = false;
                await buildNotePdfBlob(input, {signal: new AbortController().signal, request: adjacentRequest,
                    onProgress: stage => { if (stage === "page") noDuplicateInsertion = document.querySelector('.pa-pdf-host .protyle-wysiwyg').textContent.split("STATIC_QUERY_RESULT").length === 3; }});
                let ambiguousRejected = false;
                try { await buildNotePdfBlob(input, {signal: new AbortController().signal, request: adjacentRequest, bestEffort: false}); } catch { ambiguousRejected = true; }
                const empty = await buildNotePdfBlob(input, {signal: new AbortController().signal,
                    request: async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: embed("empty-embed")}
                        : {id: data.id, name: "Empty", type: data.id === docId ? "NodeDocument" : "NodeBlockQueryEmbed", content: ""}});
                const nestedQuery = child => `<div data-node-id="query-parent" data-type="NodeBlockquote">${child}</div>`;
                const nestedMapped = await buildNotePdfBlob(input, {signal: new AbortController().signal, bestEffort: false,
                    request: async (path, data) => path.endsWith("getBlockDOM") ? {id: data.id, dom: nestedQuery(embed("nested-embed"))}
                        : data.id === docId ? {id: docId, type: "NodeDocument", content: nestedQuery(p("nested-result", "NESTED_RESULT"))}
                            : {id: data.id, type: "NodeBlockQueryEmbed", content: p("focused-result", "NESTED_RESULT")}});
                live.remove();
                return {strictMapped, appendixAfterContent, strictInkRejected, parentInkSeparated, reportAfterInk, noDuplicateInsertion, ambiguousRejected,
                    emptyReported: empty.warnings.some(w => w.includes("empty")), nestedMapped: nestedMapped.warnings.some(w => w.includes("nested-embed")),
                    inkWarning: best.warnings.some(w => w.includes("strokes")),
                    unsupportedPlaceholder: unsupported.warnings.length > 0 && !window.pdfInjected,
                    missingReported: missing.warnings.some(w => w.includes("lost")), clean: !document.querySelector(".pa-pdf-host")};
            });
            Object.entries(compatibilityChecks).forEach(([key, value]) => assert(value, key));
            console.log(`${engine}: static SQL embed mapping, best-effort placeholders/report and unplaced-ink appendix passed`);

            await page.goto(`${origin}/test/harness.html`);
            await page.waitForFunction(() => window.harness?.overlay.store.loaded);
            const text = '<div data-node-id="dialog-block" data-type="NodeParagraph" style="height:100px">Download fixture</div>';
            let delay = false, missingPreview = false;
            await page.route("**/api/block/getBlockDOM", async route => {
                const data = route.request().postDataJSON();
                await route.fulfill({json: {code: 0, data: {id: data.id, dom: text}}});
            });
            await page.route("**/api/export/exportPreviewHTML", async route => {
                const data = route.request().postDataJSON();
                if (delay) await new Promise(r => setTimeout(r, 500));
                await route.fulfill({json: {code: 0, data: {id: data.id, name: "Browser download", type: "NodeDocument", content: missingPreview ? "" : text, attrs: {}}}}).catch(() => {});
            });
            const showDialog = () => page.evaluate(async () => {
                const h = window.harness, {exportStrokesDialog} = await import("/src/plugin/exportDialog.ts");
                const messages = h.createPlugin().i18n;
                const t = (key, vars = {}) => Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), messages[key] || key);
                window.pdfDialog = exportStrokesDialog(h.overlay, t);
            });
            await showDialog();
            assert.equal(await page.locator("[data-best-effort]").isChecked(), true);
            await page.locator('[data-action="pdf"]').click();
            await page.locator('[data-action="download"]').waitFor({state: "visible"});
            const [download] = await Promise.all([page.waitForEvent("download"), page.locator('[data-action="download"]').click()]);
            assert.equal(download.suggestedFilename(), "Browser download.pdf");
            await page.evaluate(() => window.harness.stroke([[100, 200], [140, 240]]));
            const [backupDownload] = await Promise.all([page.waitForEvent("download"), page.locator('[data-action="backup"]').click()]);
            const backup = JSON.parse(await readFile(await backupDownload.path(), "utf8"));
            assert.equal(backup.format, "pencil-sync-backup");
            assert(backup.payload.snapshots.some(snapshot => snapshot.values.length > 0), "backup must include unsaved ink");
            await page.evaluate(() => window.pdfDialog.destroy());
            missingPreview = true;
            await showDialog(); await page.locator('[data-pdf-layout]').selectOption('native'); await page.locator("[data-best-effort]").uncheck(); await page.locator('[data-action="pdf"]').click();
            await page.waitForFunction(() => document.querySelector(".pa-export__status")?.textContent.includes("failed"));
            assert.equal(await page.locator('[data-action="download"]').isVisible(), false);
            await page.evaluate(() => window.pdfDialog.destroy()); missingPreview = false;
            delay = true;
            await showDialog(); await page.locator('[data-action="pdf"]').click();
            await page.locator('[data-action="cancel"]').click();
            await page.waitForFunction(() => document.querySelector(".pa-export__status")?.textContent.includes("cancelled"));
            await page.waitForTimeout(650);
            assert.equal(await page.locator('[data-action="download"]').isVisible(), false);
            await page.evaluate(() => window.pdfDialog.destroy());
            await showDialog(); await page.locator('[data-action="pdf"]').click();
            await page.evaluate(() => { window.firstPdfDialog = window.pdfDialog; });
            await showDialog();
            await page.locator('[data-action="pdf"]').last().click();
            assert.match(await page.locator(".pa-export__status").last().innerText(), /Another export/);
            await page.evaluate(async () => { (await import("/src/plugin/exportDialog.ts")).cancelExports(); });
            assert.equal(await page.locator(".b3-dialog").count(), 0);
            await page.waitForTimeout(650);
            assert.equal(await page.locator(".pa-pdf-host").count(), 0);
            await page.evaluate(async () => {
                const h = window.harness, {exportStrokesDialog} = await import("/src/plugin/exportDialog.ts");
                h.overlay.store.block("integrity", "An old plugin changed the legacy ink file");
                const messages = h.createPlugin().i18n;
                const t = (key, vars = {}) => Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), messages[key] || key);
                window.importCalls = 0;
                window.pdfDialog = exportStrokesDialog(h.overlay, t, "pencil-annotation", async () => { window.importCalls++; h.overlay.store.unblock(); });
            });
            await page.locator('[data-action="reconcile"]').click();
            await page.waitForFunction(() => document.querySelector(".pa-export__status")?.textContent.includes("merged safely"));
            assert.equal(await page.evaluate(() => window.importCalls), 1);
            await page.evaluate(() => window.pdfDialog.destroy());
            console.log(`${engine}: HTTP download, raw backup, legacy import action, cancel/close cleanup and global export exclusion passed`);
        } finally { await browser.close(); }
    }
} finally { await server.close(); }
