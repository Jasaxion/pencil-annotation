// Optional real-host integration: never opens or modifies an existing workspace.
import assert from "node:assert/strict";
import {mkdtemp, mkdir, cp, readFile, writeFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname, resolve} from "node:path";
import {spawn} from "node:child_process";
import {once} from "node:events";
import net from "node:net";
import {randomBytes} from "node:crypto";
import {chromium, webkit} from "playwright";

const kernel = process.env.SIYUAN_KERNEL;
assert(kernel, "Set SIYUAN_KERNEL to an installed SiYuan kernel executable; run npm run build first.");
const workspace = await mkdtemp(join(tmpdir(), "pencil-host-test-"));
await mkdir(join(workspace, "data/plugins/pencil-annotation"), {recursive: true});
await cp(resolve("build"), join(workspace, "data/plugins/pencil-annotation"), {recursive: true});
const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const authCode = randomBytes(24).toString('hex');
const child = spawn(kernel, ["serve", `--workspace=${workspace}`, `--port=${port}`, `--accessAuthCode=${authCode}`, "--lang=en",
    `--wd=${dirname(dirname(kernel))}`], {stdio: ["ignore", "pipe", "pipe"]});
let logs = "";
let startError;
child.on("error", error => { startError = error; });
child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
let token;
const api = async (path, data = {}) => {
    const res = await fetch(base + path, {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Token ${token}`}, body: JSON.stringify(data)});
    assert(res.ok, `${path}: HTTP ${res.status}`);
    const result = await res.json(); assert.equal(result.code, 0, `${path}: ${result.msg}`); return result.data;
};
try {
    for (let i = 0; i < 100; i++) {
        try {
            token = JSON.parse(await readFile(join(workspace, "conf/conf.json"), "utf8")).api.token;
            await api("/api/notebook/lsNotebooks"); break;
        } catch {
            if (i === 99 || startError || child.exitCode !== null) throw new Error(`Kernel did not boot: ${startError || logs}`);
            await new Promise(r => setTimeout(r, 100));
        }
    }
    const hostVersion = JSON.parse(await readFile(join(workspace, "conf/conf.json"), "utf8")).system.kernelVersion;
    const opensWelcomeEditor = /^3\.[0-7]\./.test(hostVersion);
    console.log(`Host integration version: ${hostVersion}`);
    await api("/api/system/setDownloadInstallPkg", {downloadInstallPkg: false});
    await api("/api/setting/setBazaar", {trust: true, petalDisabled: false});
    await api("/api/petal/setPetalEnabled", {packageName: "pencil-annotation", enabled: true});
    const notebook = (await api("/api/notebook/createNotebook", {name: "Pencil regression"})).notebook.id;
    const doc = await api("/api/filetree/createDocWithMd", {notebook, path: "/Pen regression", markdown:
        "- [ ] Do not toggle with pen\n\n| Column | Value |\n| --- | --- |\n| Drag with mouse | Test |\n\n" +
        Array.from({length: 30}, (_, i) => `Paragraph ${i}: native scrolling and persistent handwriting.`).join("\n\n")});
    const showMobileDocuments = async page => {
        const notebookRow = page.locator('[data-type="navigation-root"]').filter({hasText: 'Pencil regression'}).first();
        await notebookRow.waitFor({state: 'attached'});
        const visible = await notebookRow.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.left < innerWidth; });
        if (!visible) await page.locator('#toolbarFile').click();
        await page.waitForFunction(() => [...document.querySelectorAll('[data-type="navigation-root"]')].some(el => {
            const r = el.getBoundingClientRect(); return el.textContent.includes('Pencil regression') && r.width > 0 && r.left >= 0 && r.left < innerWidth;
        }));
    };
    const legacyFile = join(workspace, `data/storage/petal/pencil-annotation/${doc}.json`);
    await mkdir(join(workspace, "data/storage/petal/pencil-annotation"), {recursive: true});
    const legacyBytes = JSON.stringify({version: 1, docId: doc, updatedAt: 1, strokes: [
        {i: "legacy-seed", t: 0, c: "#334455", w: 4, o: 1, s: 0, a: 1, p: [120, 90, .5, 145, 100, .6]},
    ]});
    await writeFile(legacyFile, legacyBytes);
    for (const [name, mobile] of [["chromium", false], ["chromium", true], ["webkit", true]]) {
        const browser = await ({chromium, webkit}[name]).launch(name === "chromium" ? {channel: "chromium"} : {});
        try {
            const context = await browser.newContext({viewport: mobile ? {width: 390, height: 844} : {width: 1100, height: 800}, isMobile: mobile, hasTouch: mobile, ignoreHTTPSErrors: true});
            await context.request.post(base + "/api/system/loginAuth", {data: {authCode}});
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", error => {
                // SiYuan 3.7.2 also emits this navigation-abort rejection with all plugins disabled.
                if (name === "webkit" && error.message.endsWith("/api/storage/setLocalStorageVal due to access control checks.")) return;
                errors.push(error.message);
            });
            const open = async () => {
                await page.goto(base + (mobile ? "/stage/build/mobile/" : "/"));
                await page.waitForSelector("#loading", {state: "hidden"});
                await page.waitForSelector(".pa-handle");
                // The fresh-workspace guide opens asynchronously after plugin initialization.
                if (!mobile && opensWelcomeEditor) await page.locator(".protyle-wysiwyg:visible").first().waitFor();
                // SiYuan 3.8 moved Documents into the bottom bar; use its stable control ID.
                if (mobile) await showMobileDocuments(page);
                const note = page.locator(`[data-type="navigation-file"][data-node-id="${doc}"] .b3-list-item__text`).first();
                if (!await note.isVisible()) {
                    if (mobile) await page.getByText("Pencil regression", {exact: true}).click();
                    else await page.getByText("Pencil regression", {exact: true}).dblclick();
                }
                await note.click();
                await page.waitForFunction(id => Array.from(window.siyuan.ws.app.plugins.find(p => p.name === "pencil-annotation").overlays.values()).some(o => o.docId === id && o.store.loaded), doc);
            };
            await open();
            const count = () => page.evaluate(id => Array.from(window.siyuan.ws.app.plugins.find(p => p.name === "pencil-annotation").overlays.values()).find(o => o.docId === id).store.strokes.length, doc);
            const before = await count();
            await page.locator(".pa-handle").click();
            const task = page.locator('[data-type="NodeListItem"][data-subtype="t"]:visible').first();
            const taskBefore = await task.getAttribute("data-task");
            const target = task.locator(".protyle-action").first();
            // The 3.8 mobile sidebar slides the editor itself; wait for actionability,
            // not merely a mounted/loaded store, before measuring pen coordinates.
            await target.click({trial: true});
            const rect = await target.boundingBox();
            if (name === "chromium") {
                const cdp = await context.newCDPSession(page);
                if (!mobile) {
                    const table = page.locator('.protyle-wysiwyg:visible table').first();
                    const edge = await table.evaluate(table => {
                        const rect = table.getBoundingClientRect(), wrapper = table.parentElement.getBoundingClientRect();
                        return {x: rect.left + rect.width / 2, y: Math.max(rect.bottom, wrapper.bottom) + 1};
                    });
                    await page.mouse.move(edge.x, edge.y);
                    const addRow = page.locator('.protyle-table-control:visible [data-type="add-row"]').first();
                    await addRow.waitFor();
                    const control = await addRow.boundingBox(), rows = await table.locator('tr').count();
                    const cx = control.x + control.width / 2, cy = control.y + control.height / 2;
                    await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1, x: cx, y: cy, force: .5});
                    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, clickCount: 1, x: cx, y: cy});
                    assert.equal(await table.locator('tr').count(), rows, 'pen must not add a table row through sibling controls');
                    assert.equal(await count(), before, 'auxiliary controls are not drawing surfaces');
                    await page.mouse.move(edge.x, edge.y);
                    await addRow.click();
                    await page.waitForFunction(rows => document.querySelector('.protyle-wysiwyg table')?.rows.length === rows + 1, rows);
                    console.log('SiYuan chromium: trusted pen table-control suppression and immediate real-mouse row insertion passed');
                }
                const x = rect.x + 10, y = rect.y + 10;
                const palmScroll = await page.evaluate(id => Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id).protyle.contentElement.scrollTop, doc);
                await cdp.send("Input.dispatchMouseEvent", {type: "mousePressed", pointerType: "pen", button: "left", buttons: 1, clickCount: 1, x, y, force: .5});
                for (let i = 1; i <= 6; i++) {
                    await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", pointerType: "pen", buttons: 1, x: x + i * 5, y: y + i * 6, force: .5});
                    if (mobile && i === 2) {
                        await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: 280, y: 600}]});
                        await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: 280, y: 550}]});
                    }
                    if (mobile && i === 4) await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
                }
                await cdp.send("Input.dispatchMouseEvent", {type: "mouseReleased", pointerType: "pen", button: "left", buttons: 0, clickCount: 1, x: x + 30, y: y + 36});
                const strokeEnd = await page.evaluate(id => {
                    const o = Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id);
                    const rect = o.protyle.wysiwyg.element.getBoundingClientRect();
                    const stroke = o.store.strokes.at(-1), point = stroke.points.at(-1), offset = o.strokeOffsets()(stroke);
                    return {x: point.x + offset.dx + rect.x, y: point.y + offset.dy + rect.y, scroll: o.protyle.contentElement.scrollTop};
                }, doc);
                assert(Math.abs(strokeEnd.x - x - 30) < 1 && Math.abs(strokeEnd.y - y - 36) < 1, `full pen endpoint must survive concurrent touch: ${JSON.stringify({expected: {x: x + 30, y: y + 36}, actual: strokeEnd})}`);
                assert.equal(strokeEnd.scroll, palmScroll, "palm must not pan during pen contact");
                if (mobile) {
                    const scrollBefore = await page.evaluate(id => Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id).protyle.contentElement.scrollTop, doc);
                    await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: 280, y: 700}]});
                    for (let y = 680; y >= 350; y -= 20) {
                        await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: 280, y}]});
                        await new Promise(r => setTimeout(r, 16));
                    }
                    await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
                    const scrollAfter = await page.evaluate(id => Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id).protyle.contentElement.scrollTop, doc);
                    assert(scrollAfter > scrollBefore + 150, "real mobile editor must pan without interrupting ink");
                }
            } else {
                // WebKit automation does not expose hardware pen injection; dispatch the real handler path.
                await target.evaluate((el, rect) => {
                    for (const [type, dx, dy] of [["pointerdown", 0, 0], ["pointermove", 20, 20], ["pointerup", 30, 30]]) {
                        el.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 20, pointerType: "pen", pressure: .5,
                            button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: rect.x + 10 + dx, clientY: rect.y + 10 + dy}));
                    }
                }, rect);
            }
            assert.equal(await task.getAttribute("data-task"), taskBefore, "pen must not toggle task");
            await page.waitForFunction(id => {
                const o = Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id);
                return o.store.strokes.length > 0 && !o.store.dirty && !o.store.saving;
            }, doc);
            assert.equal(await count(), before + 1);
            const syncPath = join(workspace, `data/storage/petal/pencil-annotation/sync-v2/${doc}`);
            const snapshots = (await readdir(syncPath)).filter(name => /^w[0-9a-f]+-\d+\.json$/.test(name));
            assert(snapshots.length > 0, "versioned ink snapshots must be durable");
            const saved = await Promise.all(snapshots.map(async file => JSON.parse(await readFile(join(syncPath, file), "utf8"))));
            assert(saved.some(snapshot => snapshot.values.length > 0));
            await open();
            assert.equal(await count(), before + 1, "reload must recover all saved ink");
            await page.locator(".pa-handle").click();
            const nativeTask = page.locator('[data-type="NodeListItem"][data-subtype="t"]:visible').first();
            const oldTask = await nativeTask.getAttribute("data-task");
            await nativeTask.locator(".protyle-action").first().click();
            await page.waitForFunction(old => document.querySelector('[data-type="NodeListItem"][data-subtype="t"]')?.getAttribute("data-task") !== old, oldTask);
            assert.equal(await count(), before + 1, "native mouse task click must not draw");
            if (process.env.PENCIL_ARTIFACT_DIR) {
                await mkdir(process.env.PENCIL_ARTIFACT_DIR, {recursive: true});
                await page.screenshot({path: join(process.env.PENCIL_ARTIFACT_DIR, `${name}-${mobile ? "mobile" : "desktop"}.png`)});
            }
            assert.deepEqual(errors, []);
            console.log(`SiYuan ${name}/${mobile ? "mobile" : "desktop"}: plugin load, task isolation, kernel save and reload passed`);
        } catch (error) {
            for (const ctx of browser.contexts()) for (const page of ctx.pages()) {
                await page.screenshot({path: `/tmp/pencil-host-failure-${name}.png`});
                console.error((await page.locator("body").innerText()).slice(0,1200));
            }
            throw error;
        } finally { await browser.close(); }
    }

    const openFixture = async (page, id, title, mobile = false) => {
        await page.goto(base + (mobile ? "/stage/build/mobile/" : "/"));
        await page.waitForSelector("#loading", {state: "hidden"});
        await page.waitForSelector(".pa-handle");
        if (!mobile && opensWelcomeEditor) await page.locator(".protyle-wysiwyg:visible").first().waitFor();
        if (mobile) await showMobileDocuments(page);
        const item = page.locator(`[data-type="navigation-file"][data-node-id="${id}"] .b3-list-item__text`).first();
        if (!await item.isVisible()) {
            if (mobile) await page.getByText("Pencil regression", {exact: true}).click();
            else await page.getByText("Pencil regression", {exact: true}).dblclick();
        }
        await item.click();
        await page.waitForFunction(id => [...window.siyuan.ws.app.plugins.find(p => p.name === "pencil-annotation").overlays.values()].some(o => o.docId === id && o.store.loaded), id);
        await page.evaluate(id => {
            const plugin = window.siyuan.ws.app.plugins.find(p => p.name === "pencil-annotation");
            const overlay = [...plugin.overlays.values()].find(o => o.docId === id);
            clearInterval(plugin.syncPoll); plugin.armSave = () => {};
            window.inkFixture = {plugin, overlay};
        }, id);
    };
    const concurrentBrowser = await chromium.launch({channel: "chromium"});
    try {
        const newPage = async () => {
            const context = await concurrentBrowser.newContext({viewport: {width: 1100, height: 800}});
            await context.request.post(base + "/api/system/loginAuth", {data: {authCode}});
            const page = await context.newPage(); await openFixture(page, doc, "Pen regression"); return page;
        };
        const a = await newPage(), b = await newPage();
        // Both edits are prepared before either write starts: genuinely concurrent ancestry.
        await Promise.all([a, b].map((page, i) => page.evaluate(dx => {
            const {plugin, overlay} = window.inkFixture;
            overlay.store.moveStrokes([overlay.store.strokes.find(s => s.logicalId === "legacy-seed")], dx, 0);
            plugin.scheduleSave(overlay);
        }, i ? -20 : 20)));
        await Promise.all([a, b].map(page => page.evaluate(() => window.inkFixture.plugin.flushAll())));
        await a.context().close(); await b.context().close();
        const c = await newPage();
        assert.equal(await c.evaluate(() => window.inkFixture.overlay.store.strokes.filter(s => s.logicalId === "legacy-seed").length), 2);
        await c.evaluate(async () => {
            const {plugin, overlay} = window.inkFixture;
            const copy = overlay.store.strokes.find(s => s.logicalId === "legacy-seed");
            overlay.store.eraseWhere(s => s.revision === copy.revision); plugin.scheduleSave(overlay); await plugin.flushAll();
        });
        await c.context().close();
        const d = await newPage(), e = await newPage();
        assert.equal(await d.evaluate(() => window.inkFixture.overlay.store.strokes.filter(s => s.logicalId === "legacy-seed").length), 1);
        await d.evaluate(() => { const f = window.inkFixture; f.overlay.store.clearAll(); f.plugin.scheduleSave(f.overlay); });
        await e.evaluate(() => { const f = window.inkFixture; f.overlay.store.addStroke("pen", {color: "#123456", width: 4, opacity: 1, simulate: false}, [{x: 50, y: 50, p: .5}]); f.plugin.scheduleSave(f.overlay); });
        await Promise.all([d, e].map(page => page.evaluate(() => window.inkFixture.plugin.flushAll())));
        await d.context().close(); await e.context().close();
        const f = await newPage();
        assert.equal(await f.evaluate(() => window.inkFixture.overlay.store.strokes.length), 1, "clear must not remove an unseen concurrent addition");
        for (let i = 0; i < 4; i++) await f.evaluate(async () => {
            const x = window.inkFixture;
            x.overlay.store.addStroke("pen", {color: "#123456", width: 4, opacity: 1, simulate: false}, [{x: 70, y: 70, p: .5}]);
            x.plugin.scheduleSave(x.overlay); await x.plugin.flushAll();
        });
        const writer = await f.evaluate(() => window.inkFixture.overlay.store.writer);
        const names = await readdir(join(workspace, `data/storage/petal/pencil-annotation/sync-v2/${doc}`));
        assert.equal(names.filter(name => name.startsWith(`${writer}-`)).length, 2, "keep the latest two verified cumulative writer files");
        assert.equal(await readFile(legacyFile, "utf8"), legacyBytes, "legacy ink backup must remain untouched");
        await writeFile(legacyFile, JSON.stringify({...JSON.parse(legacyBytes), updatedAt: 999}));
        await f.evaluate(async () => { await window.inkFixture.plugin.onDataChanged("sync"); await window.inkFixture.plugin.onDataChanged("overwrite", false); });
        assert.equal(await f.evaluate(() => window.inkFixture.overlay.store.canEdit), false);
        await f.evaluate(() => window.inkFixture.plugin.reconcileLegacy(window.inkFixture.overlay));
        assert.equal(await f.evaluate(() => window.inkFixture.overlay.store.canEdit), true);
        assert.equal(await f.evaluate(() => window.inkFixture.overlay.store.strokes.length), 5, "legacy reconciliation must not resurrect retired unchanged ink");
        assert.equal(JSON.parse(await readFile(legacyFile, "utf8")).updatedAt, 999, "reconciliation must not overwrite the old file");
        console.log("SiYuan multi-browser: concurrent moves, selective conflict deletion, clear/add, restart, snapshot pruning and legacy barrier passed");
    } finally { await concurrentBrowser.close(); }

    const pdfDoc = await api("/api/filetree/createDocWithMd", {notebook, path: "/Complete PDF fixture", markdown:
        "# PDF folded heading\n\nHidden PDF child\n\nInline math $x^2$\n\n" + Array.from({length: 160}, (_, i) => `Full PDF paragraph ${i}${i === 159 ? " FINAL_PDF_SENTINEL" : ""}`).join("\n\n")});
    let heading, last;
    for (let i = 0; i < 100; i++) {
        const blocks = await api("/api/query/sql", {stmt: `select id,type,content from blocks where root_id='${pdfDoc}' and (content='PDF folded heading' or content like '%FINAL_PDF_SENTINEL%')`});
        heading = blocks.find(b => b.type === "h")?.id; last = blocks.find(b => b.type === "p")?.id;
        if (heading && last) break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert(heading && last); await api("/api/attr/setBlockAttrs", {id: heading, attrs: {fold: "1"}});
    for (const [name, mobile] of [["chromium", false], ["webkit", true]]) {
        const browser = await ({chromium, webkit}[name]).launch(name === "chromium" ? {channel: "chromium"} : {});
        try {
            const context = await browser.newContext({viewport: mobile ? {width: 390, height: 844} : {width: 1100, height: 800}, isMobile: mobile, hasTouch: mobile, acceptDownloads: true});
            await context.request.post(base + "/api/system/loginAuth", {data: {authCode}});
            const page = await context.newPage(); await openFixture(page, pdfDoc, "Complete PDF fixture", mobile);
            await page.evaluate(async last => {
                const {plugin, overlay} = window.inkFixture;
                overlay.store.addStroke("pen", {color: "#ff0000", width: 5, opacity: 1, simulate: false}, [{x: 30, y: 10, p: .7}, {x: 100, y: 12, p: .7}],
                    {blockId: last, ox: 0, oy: 0}, [30, 8000]);
                plugin.scheduleSave(overlay); await plugin.flushAll();
                window.pdfRasterStats = [];
                const original = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
                    if (type === "image/jpeg" && quality === .94) {
                        const bytes = this.getContext("2d").getImageData(0, 0, this.width, this.height).data;
                        let red = 0; for (let i = 0; i < bytes.length; i += 4) if (bytes[i] > 180 && bytes[i+1] < 90 && bytes[i+2] < 90) red++;
                        window.pdfRasterStats.push({red, width: this.width, height: this.height, tail: document.querySelector('.pa-pdf-host')?.textContent.includes('FINAL_PDF_SENTINEL')});
                    }
                    return original.call(this, type, quality);
                };
            }, last);
            await page.locator(".pa-handle").click();
            await page.getByRole("button", {name: "Export note and handwriting", exact: true}).click();
            await page.locator('[data-action="pdf"]').click();
            await page.waitForFunction(() => /failed|ready/.test(document.querySelector(".pa-export__status")?.textContent || ""), {}, {timeout: 90000});
            const status = await page.locator(".pa-export__status").innerText(); assert.match(status, /PDF ready/, status);
            const raster = await page.evaluate(() => window.pdfRasterStats);
            assert(raster.length > 1 && raster.at(-1).red > 0 && raster.every(page => page.tail), "full source and last-block ink must remain in the current-layout PDF");
            assert(!(await page.locator('.pa-export__warnings li').allTextContents()).some(text => text.includes('thumbnail copies follow')), 'ordinary folded/unloaded ink must stay on the note');
            const downloadPromise = page.waitForEvent("download"); await page.locator('[data-action="download"]').click();
            const download = await downloadPromise; const bytes = await readFile(await download.path());
            assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
            assert.equal(Number(/\/Count\s+(\d+)/.exec(bytes.toString("latin1"))[1]), raster.length);
            if (process.env.PENCIL_ARTIFACT_DIR) {
                await download.saveAs(join(process.env.PENCIL_ARTIFACT_DIR, `${name}-full-note.pdf`));
                await page.screenshot({path: join(process.env.PENCIL_ARTIFACT_DIR, `${name}-pdf-dialog.png`)});
            }
            console.log(`SiYuan ${name}: folded/unloaded full document + math + last-block ink PDF, browser download passed (${raster.length} pages)`);
        } catch (error) {
            for (const context of browser.contexts()) for (const page of context.pages()) {
                await page.screenshot({path: `/tmp/pencil-full-pdf-failure-${name}.png`});
                console.error((await page.locator("body").innerText()).slice(-1800));
                console.error('expected PDF doc', pdfDoc);
                console.error(await page.evaluate(() => [...window.siyuan.ws.app.plugins[0].overlays.values()].map(o => ({docId: o.docId, root: o.protyle.block?.rootID, optionRoot: o.protyle.options?.rootId, loaded: o.store.loaded, loading: !!o.store.loading, blocked: o.store.blocked}))));
            }
            throw error;
        } finally { await browser.close(); }
    }
    const sqlTargetDoc = await api('/api/filetree/createDocWithMd', {notebook, path: '/SQL source fixture', markdown: 'SQL_STATIC_SENTINEL'});
    let sqlTarget;
    for (let i = 0; i < 100; i++) {
        sqlTarget = (await api('/api/query/sql', {stmt: `select id from blocks where root_id='${sqlTargetDoc}' and type='p' and content='SQL_STATIC_SENTINEL'`}))[0]?.id;
        if (sqlTarget) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(sqlTarget);
    const pdfFiles = async () => (await readdir(workspace, {recursive: true})).filter(path => path.toLowerCase().endsWith('.pdf')).sort();
    for (const [name, mobile] of [['chromium', false], ['webkit', true]]) {
        const title = `Static embed ${name}`;
        const sqlDoc = await api('/api/filetree/createDocWithMd', {notebook, path: '/' + title, markdown:
            `Before embeds\n\n{{select * from blocks where id='${sqlTarget}'}}\n\nMiddle ((${sqlTarget} "Reference label"))\n\n{{select * from blocks where id='${sqlTarget}'}}\n\nAfter embeds`});
        const browser = await ({chromium, webkit}[name]).launch(name === 'chromium' ? {channel: 'chromium'} : {});
        try {
            const context = await browser.newContext({viewport: mobile ? {width: 390, height: 844} : {width: 1100, height: 800}, isMobile: mobile, hasTouch: mobile, acceptDownloads: true});
            await context.request.post(base + '/api/system/loginAuth', {data: {authCode}});
            const page = await context.newPage();
            const generate = async () => {
                await page.locator('[data-action="pdf"]').click();
                await page.waitForFunction(() => /failed|ready/.test(document.querySelector('.pa-export__status')?.textContent ?? ''), {}, {timeout: 90000});
                const status = await page.locator('.pa-export__status').innerText(); assert.match(status, /PDF ready/, status);
                const promise = page.waitForEvent('download'); await page.locator('[data-action="download"]').click();
                const download = await promise;
                assert.equal((await readFile(await download.path())).subarray(0, 4).toString(), '%PDF');
                return download;
            };
            await openFixture(page, sqlDoc, title, mobile);
            const before = await pdfFiles();
            await page.locator('.pa-handle').click();
            await page.getByRole('button', {name: 'Export note and handwriting', exact: true}).click();
            await page.locator('[data-pdf-layout]').selectOption('native');
            await page.locator('[data-best-effort]').uncheck();
            await generate();
            const strictWarnings = await page.locator('.pa-export__warnings li').allTextContents();
            assert.equal(strictWarnings.filter(text => text.startsWith('SQL embed')).length, 2, 'strict mode verifies both regenerated embed ranges');
            assert(strictWarnings.some(text => text.includes('Block references')));
            await api('/api/block/appendBlock', {parentID: sqlDoc, dataType: 'markdown', data: '{{{col\n\nSB_LEFT\n\nSB_RIGHT\n\n}}}'});
            await openFixture(page, sqlDoc, title, mobile);
            await page.waitForFunction(anchor => [...document.querySelectorAll('.protyle-wysiwyg [data-type="NodeBlockQueryEmbed"]')].filter(el => el.getBoundingClientRect().width > 0).every(el => el.querySelector(`[data-node-id="${anchor}"]`)), sqlTarget);
            await page.evaluate(async anchor => {
                const {plugin, overlay} = window.inkFixture;
                overlay.store.addStroke('pen', {color: '#ff0000', width: 5, opacity: 1, simulate: false}, [{x: 20, y: 20, p: .5}, {x: 80, y: 25, p: .6}], {blockId: anchor, ox: 0, oy: 0});
                const sb = overlay.protyle.wysiwyg.element.querySelector('[data-type="NodeSuperBlock"]');
                const column = sb?.querySelector('[data-node-id]');
                if (!column) throw new Error('Superblock fixture was not parsed');
                const sbRect = sb.getBoundingClientRect();
                window.superblockExpected = [...sb.children].filter(el => el.hasAttribute('data-node-id')).map(el => {
                    const r = el.getBoundingClientRect(); return {id: el.dataset.nodeId, x: r.left - sbRect.left, y: r.top - sbRect.top, width: r.width, height: r.height};
                });
                overlay.store.addStroke('pen', {color: '#008800', width: 5, opacity: 1, simulate: false}, [{x: 20, y: 10, p: .6}, {x: 70, y: 12, p: .6}], {blockId: column.dataset.nodeId, ox: 0, oy: 0});
                plugin.scheduleSave(overlay); await plugin.flushAll();
                window.superblockPreserved = false;
                const encode = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
                    if (type === 'image/jpeg' && quality === .94) {
                        const block = document.querySelector('.pa-pdf-host [data-type="NodeSuperBlock"]');
                        const columns = block ? [...block.children].filter(el => el.hasAttribute('data-node-id')) : [];
                        if (columns.length >= 2) {
                            const root = block.getBoundingClientRect();
                            window.superblockPreserved ||= window.superblockExpected.every(expected => {
                                const el = columns.find(el => el.dataset.nodeId === expected.id), r = el?.getBoundingClientRect();
                                return r && Math.abs(r.left - root.left - expected.x) < 2 && Math.abs(r.top - root.top - expected.y) < 2 && Math.abs(r.width - expected.width) < 2 && Math.abs(r.height - expected.height) < 2;
                            });
                        }
                    }
                    return encode.call(this, type, quality);
                };
            }, sqlTarget);
            const writes = [];
            page.on('request', request => { if (/\/api\/(file\/putFile|asset\/upload)$/.test(new URL(request.url()).pathname)) writes.push(request.url()); });
            await page.locator('.pa-handle').click();
            await page.getByRole('button', {name: 'Export note and handwriting', exact: true}).click();
            assert(await page.locator('[data-best-effort]').isChecked());
            const download = await generate();
            const warnings = await page.locator('.pa-export__warnings li').allTextContents();
            assert(warnings.some(text => text.includes('current displayed')));
            assert(!warnings.some(text => text.includes('thumbnail copies follow')), JSON.stringify(warnings));
            if (!mobile) assert(await page.evaluate(() => window.superblockExpected[1].x > window.superblockExpected[0].x + 50), 'desktop fixture must exercise side-by-side columns');
            assert(await page.evaluate(() => window.superblockPreserved), 'superblock columns must preserve the current responsive editor layout');
            assert.deepEqual(writes, [], 'PDF generation/download must not upload a result');
            assert.deepEqual(await pdfFiles(), before, 'no generated PDF may remain in the kernel workspace');
            if (process.env.PENCIL_ARTIFACT_DIR) await download.saveAs(join(process.env.PENCIL_ARTIFACT_DIR, `${name}-sql-ink.pdf`));
            console.log(`SiYuan ${name}: strict fallback and current-layout SQL/superblock ink without appendix or server-side PDF result passed`);
        } finally { await browser.close(); }
    }

    const deletionDoc = await api('/api/filetree/createDocWithMd', {notebook, path: '/Deletion lifecycle fixture', markdown: 'Disposable document for confirmed handwriting deletion.'});
    const childDoc = await api('/api/filetree/createDocWithMd', {notebook, path: '/Deletion lifecycle fixture/Child ink fixture', markdown: 'Disposable child document.'});
    const storage = join(workspace, 'data/storage/petal/pencil-annotation');
    const childLegacy = join(storage, `${childDoc}.json`);
    await writeFile(childLegacy, JSON.stringify({version: 1, docId: childDoc, updatedAt: 1, strokes: [{i: 'child-ink', t: 0, c: '#000', w: 4, o: 1, s: 0, a: 1, p: [10, 20, .5]}]}));
    const deletionBrowser = await chromium.launch({channel: 'chromium'});
    try {
        const context = await deletionBrowser.newContext({viewport: {width: 1100, height: 800}});
        await context.request.post(base + '/api/system/loginAuth', {data: {authCode}});
        const page = await context.newPage();
        const addInk = () => page.evaluate(async () => {
            const {plugin, overlay} = window.inkFixture;
            overlay.store.addStroke('pen', {color: '#123456', width: 4, opacity: 1, simulate: false}, [{x: 70, y: 70, p: .5}]);
            plugin.scheduleSave(overlay); await plugin.flushAll();
        });
        const awaitDeletion = ids => page.waitForFunction(ids => { const p = window.siyuan.ws.app.plugins.find(p => p.name === 'pencil-annotation'); return ids.every(id => !p.deletionJobs.has(id) && !p.documents.has(id)); }, ids);
        const restore = async () => {
            const versions = (await readdir(join(workspace, 'history'), {recursive: true})).filter(path => path.endsWith(`/${deletionDoc}.sy`) && path.includes('-delete/')).sort();
            assert(versions.length, 'kernel must have a real deleted document history');
            await api('/api/history/rollbackDocHistory', {historyPath: 'history/' + versions.at(-1)});
            await openFixture(page, deletionDoc, 'Deletion lifecycle fixture');
        };
        await openFixture(page, deletionDoc, 'Deletion lifecycle fixture'); await addInk();
        await api('/api/filetree/removeDoc', {notebook, path: `/${deletionDoc}.sy`});
        await awaitDeletion([deletionDoc, childDoc]);
        for (const id of [deletionDoc, childDoc]) {
            assert.deepEqual(await readdir(join(storage, `sync-v2/${id}`)), ['retired-v1.json']);
            assert.equal(JSON.parse(await readFile(join(storage, `document-lifecycle/${id}/deleted-1.json`), 'utf8')).generation, 1);
        }
        await assert.rejects(readFile(childLegacy), {code: 'ENOENT'});
        await restore();
        assert.equal(await page.evaluate(() => window.inkFixture.overlay.store.strokes.length), 0, 'history restore must not restore retired ink');
        assert.equal(await page.evaluate(() => window.inkFixture.overlay.store.generation), 1);
        await addInk();
        const restoredInk = await readdir(join(storage, `sync-v2/${deletionDoc}/g1`));
        assert(restoredInk.some(name => name.startsWith('w')));
        await api('/api/filetree/removeDoc', {notebook, path: `/${deletionDoc}.sy`});
        await page.getByText('Confirm permanent handwriting cleanup', {exact: true}).waitFor();
        await page.getByRole('button', {name: 'Cancel', exact: true}).click();
        await awaitDeletion([deletionDoc]);
        assert.deepEqual(await readdir(join(storage, `sync-v2/${deletionDoc}/g1`)), restoredInk, 'declining uncertain retirement preserves ink');
        await restore();
        assert.equal(await page.evaluate(() => window.inkFixture.overlay.store.strokes.length), 1);
        await api('/api/filetree/removeDoc', {notebook, path: `/${deletionDoc}.sy`});
        await page.getByText('Confirm permanent handwriting cleanup', {exact: true}).waitFor();
        await page.getByRole('button', {name: 'Confirm', exact: true}).click();
        await awaitDeletion([deletionDoc]);
        await assert.rejects(readdir(join(storage, `sync-v2/${deletionDoc}/g1`)), {code: 'ENOENT'});
        assert.equal(JSON.parse(await readFile(join(storage, `document-lifecycle/${deletionDoc}/deleted-2.json`), 'utf8')).generation, 2);
        console.log('SiYuan chromium: parent/child deletion cleanup, genuine history restore, fresh ink and cancel/confirm of reused-ID deletion passed');
    } finally { await deletionBrowser.close(); }
    for (const [engine, mobile] of [['chromium', false], ['webkit', true]]) {
        const title = `Manager kept note ${engine}`;
        const id = await api('/api/filetree/createDocWithMd', {notebook, path: '/' + title, markdown: 'MANAGER_BODY_MUST_STAY\n\nThis note survives deleting handwriting.'});
        const file = join(workspace, `data/${notebook}/${id}.sy`);
        const browser = await ({chromium, webkit}[engine]).launch(engine === 'chromium' ? {channel: 'chromium'} : {});
        try {
            const context = await browser.newContext({viewport: mobile ? {width:390,height:844} : {width:1100,height:800}, isMobile:mobile, hasTouch:mobile, acceptDownloads:true});
            await context.request.post(base + '/api/system/loginAuth', {data:{authCode}});
            const page = await context.newPage(); await openFixture(page, id, title, mobile);
            await page.evaluate(async () => {const {plugin,overlay}=window.inkFixture; overlay.store.addStroke('pen',{color:'#123456',width:4,opacity:1,simulate:false},[{x:70,y:70,p:.5}]);plugin.scheduleSave(overlay);await plugin.flushAll();});
            const original = JSON.parse(await readFile(file,'utf8'));
            const showList = async () => {
                await page.locator('.pa-handle').click();
                await page.getByRole('button',{name:'Drawing list',exact:true}).click();
                await page.waitForFunction(()=>document.querySelector('.pa-drawings__status')?.textContent.includes('results'));
                await page.getByPlaceholder('Search title, path or document ID').fill(title);
                assert.equal(await page.locator('.pa-drawings__row').count(),1);
                assert.equal(await page.locator('.pa-drawings').getByRole('button',{name:'Cancel',exact:true}).isVisible(),false);
                assert.equal(await page.locator('.pa-drawings').getByRole('button',{name:'Show more',exact:true}).isVisible(),false);
                assert.equal(await page.locator('.pa-toolbar').isVisible(),false);
            };
            await showList();
            if(process.env.PENCIL_ARTIFACT_DIR) await page.screenshot({path:join(process.env.PENCIL_ARTIFACT_DIR,`${engine}-drawing-list.png`)});
            await page.locator('.pa-drawings__row [data-action="export"]').click();
            await page.waitForSelector('.pa-export'); await page.waitForSelector('.pa-drawings',{state:'detached'});
            await page.locator('[data-action="pdf"]').click();
            await page.waitForFunction(()=>/ready|failed/.test(document.querySelector('.pa-export__status')?.textContent??''),{},{timeout:90000});
            assert.match(await page.locator('.pa-export__status').innerText(),/PDF ready/);
            const pendingDownload=page.waitForEvent('download');await page.locator('[data-action="download"]').click();
            assert.equal((await readFile(await (await pendingDownload).path())).subarray(0,4).toString(),'%PDF');
            await openFixture(page,id,title,mobile); await showList();
            await page.locator('.pa-drawings__row [data-action="delete"]').click();
            await page.getByText('Permanently delete handwriting',{exact:true}).waitFor();
            await page.getByRole('button',{name:'Confirm',exact:true}).click();
            await page.waitForFunction(()=>document.querySelector('.pa-drawings__status')?.textContent.startsWith('0 results'));
            assert.deepEqual(JSON.parse(await readFile(file,'utf8')),original,'manager must not modify or delete the source note');
            await openFixture(page,id,title,mobile);
            assert.equal(await page.evaluate(()=>window.inkFixture.overlay.store.strokes.length),0);
            assert.equal(await page.evaluate(()=>window.inkFixture.overlay.store.generation),1);
            await page.evaluate(async()=>{const {plugin,overlay}=window.inkFixture;overlay.store.addStroke('pen',{color:'#123456',width:4,opacity:1,simulate:false},[{x:50,y:50,p:.5}]);plugin.scheduleSave(overlay);await plugin.flushAll();});
            assert((await readdir(join(workspace,`data/storage/petal/pencil-annotation/sync-v2/${id}/g1`))).some(name=>name.startsWith('w')));
            await showList();
            assert.match(await page.locator('.pa-drawings__detail').innerText(),/1 strokes/);
            console.log(`SiYuan ${engine}: manager search/export/ink-only purge, unchanged note and fresh handwriting passed`);
        } catch(error) {
            for(const context of browser.contexts())for(const page of context.pages()){await page.screenshot({path:`/tmp/pencil-manager-failure-${engine}.png`});console.error((await page.locator('body').innerText()).slice(-1600));}
            throw error;
        } finally {await browser.close();}
    }
} finally {
    if (!startError && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited; clearTimeout(force);
    }
    await rm(workspace, {recursive: true, force: true});
}
