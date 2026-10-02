import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, webkit} from 'playwright';
const server = await createServer({server: {host: '127.0.0.1', port: 5201, strictPort: true}}); await server.listen();
try {
    for (const name of process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'webkit']) {
        const browser = await ({chromium, webkit}[name]).launch(name === 'chromium' ? {channel: 'chromium'} : {});
        try {
            const page = await browser.newPage({viewport: {width: 390, height: 844}});
            const errors = []; page.on('pageerror', e => errors.push(e.message));
            await page.goto('http://127.0.0.1:5201/test/harness.html'); await page.waitForFunction(() => window.harness?.overlay.store.loaded);
            await page.evaluate(async () => {
                const h = window.harness, api = await import('/src/plugin/api.ts'), sdk = await import('/test/siyuan.ts'), exports = await import('/src/plugin/exportDialog.ts');
                const {showTextMessage} = await import('/src/plugin/text.ts');
                showTextMessage('<img onerror="bad">', 100, 'error');
                if (sdk.messages.at(-1).includes('<img')) throw new Error('Toast errors must be escaped as text');
                h.overlay.destroy(); h.palette.toolbar.remove(); h.palette.handle.remove();
                const parent = '/data/storage/petal/pencil-annotation';
                const ids = ['aaaaaaa', 'bbbbbbb', 'ccccccc', 'ddddddd', 'eeeeeee'].map(s => `20261003120000-${s}`), [a,b,c,d,e] = ids;
                const files = new Map(), writes = [], notes = new Map(ids.map(id => [id, {body: `ORIGINAL ${id}`, title: id === a ? 'Alpha <img src=x onerror="window.injected=1">' : `Note ${id}`, available: id !== b}]));
                const legacy = (id, count) => ({version: 1, docId: id, updatedAt: 1, strokes: Array.from({length: count}, (_, i) => ({i: `stroke-${i}`, t: 0, c: '#000', w: 4, o: 1, s: 0, a: 1, p: [10,20,.5]}))});
                files.set(`${parent}/${a}.json`, legacy(a, 2)); files.set(`${parent}/${c}.json`, legacy(c, 0));
                files.set(`${parent}/${e}.json`, {version: 1, docId: e, strokes: 'invalid'}); files.set(`${parent}/settings.json`, {preserve: true});
                for (const id of [b,d]) {
                    files.set(`${parent}/document-lifecycle/${id}/deleted-1.json`, {version: 1, docId: id, kind: 'deleted', generation: 1});
                    files.set(`${parent}/sync-v2/${id}/retired-v1.json`, {version: 1, docId: id, kind: 'retired-original'});
                }
                const Store = h.overlay.store.constructor;
                const seeded = new Store(b); seeded.adoptPayload(null); seeded.generation = 1;
                const add = store => store.addStroke('pen', {color: '#000', width: 4, opacity: 1, simulate: false}, [{x: 30, y: 40, p: .5}]);
                add(seeded); const pub = seeded.serialize();
                for (const base of pub.bases) files.set(`${parent}/sync-v2/${b}/g1/base-${base.hash}.json`, base);
                files.set(`${parent}/sync-v2/${b}/g1/${pub.snapshot.writer}-${pub.snapshot.sequence}.json`, pub.snapshot);
                window.catalog = {api, sdk, exports, ids, parent, files, notes, writes, add, Store, holdSave: false, releaseSave: null, holdScan: false, scanStarted: false, scanAborted: false};
                window.fetch = async (url, options) => {
                    const state = window.catalog, endpoint = String(url), data = options.body instanceof FormData ? null : JSON.parse(options.body ?? '{}');
                    if (endpoint.endsWith('getDocInfo')) { const note = notes.get(data.id); return Response.json(note?.available ? {code: 0, data: {id: data.id, rootID: data.id, name: note.title}} : {code: -1, msg: 'block not found', data: null}); }
                    if (endpoint.endsWith('getHPathByID')) return Response.json({code: 0, data: `/Notebook/${notes.get(data.id)?.title ?? data.id}`});
                    if (endpoint.endsWith('readDir')) {
                        if (state.holdScan && data.path === parent) {
                            state.holdScan = false; state.scanStarted = true;
                            return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {state.scanAborted = true; reject(new DOMException('Aborted','AbortError'));}, {once: true}));
                        }
                        const entries = new Map(), prefix = data.path + '/';
                        for (const path of files.keys()) if (path.startsWith(prefix)) { const tail = path.slice(prefix.length), name = tail.split('/')[0]; entries.set(name, {name, isDir: tail.includes('/')}); }
                        return Response.json({code: 0, data: [...entries.values()]});
                    }
                    if (endpoint.endsWith('getFile')) {
                        if (state.holdExport && data.path === `${parent}/${a}.json`) {
                            state.holdExport = false; state.exportPending = true;
                            return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {state.exportAborted = true; reject(new DOMException('Aborted','AbortError'));}, {once:true}));
                        }
                        return files.has(data.path) ? Response.json(files.get(data.path)) : new Response('', {status: 404});
                    }
                    if (endpoint.endsWith('putFile')) {
                        const path = options.body.get('path'), value = JSON.parse(await options.body.get('file').text());
                        if (!path.startsWith(parent + '/')) throw new Error('Unexpected note write');
                        writes.push(path);
                        if (state.holdSave && /\/w[a-f0-9]+-\d+\.json$/.test(path)) return new Promise(resolve => { state.releaseSave = () => { files.set(path, value); resolve(Response.json({code: 0})); }; });
                        files.set(path, value); return Response.json({code: 0});
                    }
                    if (endpoint.endsWith('removeFile')) {
                        if (!data.path.startsWith(parent + '/')) throw new Error('Unexpected note deletion');
                        for (const path of files.keys()) if (path === data.path || path.startsWith(data.path + '/')) files.delete(path);
                        return Response.json({code: 0});
                    }
                    throw new Error(`Unexpected API: ${endpoint}`);
                };
                const p = h.createPlugin(); await p.onload(); clearInterval(p.syncPoll); p.armSave = () => {};
                const make = id => ({...h.fakeProtyle, options: {rootId: id}, block: {rootID: id}});
                sdk.navigation.onOpen = id => { const protyle = make(id); sdk.editors.splice(0, sdk.editors.length, protyle); p.attachProtyle(protyle); };
                sdk.navigation.onOpen(a);
                await p.overlays.get(h.fakeProtyle.element).store.loading;
                const store = p.overlays.get(h.fakeProtyle.element).store; add(store); p.pendingSaves.add(store);
                Object.assign(window.catalog, {p, store, originalNotes: JSON.stringify([...notes])});
                const setting = p.setting.items.find(item => item.title === 'Drawing list');
                if (!setting) throw new Error('Missing drawing-list settings entry');
                setting.createActionElement().click();
            });
            const ready = () => page.waitForFunction(() => document.querySelector('.pa-drawings__status')?.textContent.includes('results'));
            await ready();
            assert.equal(await page.getByRole('button', {name:'Cancel',exact:true}).isVisible(), false);
            assert.equal(await page.getByRole('button', {name:'Show more',exact:true}).isVisible(), false);
            assert(await page.evaluate(() => catalog.p.palette.toolbar.style.visibility === 'hidden' && catalog.p.palette.handle.style.visibility === 'hidden'));
            assert.equal(await page.locator('.pa-drawings__row').count(), 3);
            assert.equal(await page.locator('.pa-drawings img').count(), 0);
            assert.equal(await page.evaluate(() => catalog.writes.length), 0, 'listing must be read-only even for restored/inaccessible notes');
            assert.equal(await page.locator('.pa-drawings__row').first().locator('.pa-drawings__detail').innerText(), '3 strokes');
            await page.evaluate(() => {catalog.originalHost = window.siyuan; window.siyuan = {config:{readonly:true}};});
            await page.getByRole('button', {name:'Refresh',exact:true}).click(); await ready();
            assert.equal(await page.locator('.pa-drawings [data-action="delete"]:enabled').count(), 0);
            assert(await page.evaluate(async () => {try {await catalog.p.deleteDrawing({id:catalog.ids[0],generation:0,verified:true});return false;}catch{return true;}}));
            await page.evaluate(() => {window.siyuan=catalog.originalHost;});
            await page.getByRole('button', {name:'Refresh',exact:true}).click(); await ready();
            await page.getByPlaceholder('Search title, path or document ID').fill('Alpha');
            assert.equal(await page.locator('.pa-drawings__row').count(), 1);
            await page.locator('.pa-drawings__row [data-action="open"]').click();
            await page.waitForSelector('.pa-drawings', {state: 'detached'});
            assert(await page.evaluate(() => catalog.p.palette.toolbar.style.visibility !== 'hidden' && catalog.p.palette.handle.style.visibility !== 'hidden'));
            assert.equal(await page.evaluate(() => catalog.sdk.navigation.calls.at(-1).id), '20261003120000-aaaaaaa');
            await page.evaluate(() => { catalog.p.palette.setMode(true); catalog.p.palette.toolbar.querySelector('[aria-label="Drawing list"]').click(); }); await ready();
            await page.evaluate(() => {catalog.holdExport = true;});
            await page.locator('.pa-drawings__row[data-doc-id$="aaaaaaa"] [data-action="export"]').click();
            await page.waitForFunction(() => catalog.exportPending);
            await page.evaluate(() => catalog.p.drawingList.destroy());
            await page.waitForFunction(() => catalog.exportAborted);
            assert.equal(await page.locator('.pa-export').count(), 0, 'closing the manager must cancel pending export preparation');
            await page.evaluate(() => catalog.p.showDrawingList()); await ready();
            await page.locator('.pa-drawings__row[data-doc-id$="aaaaaaa"] [data-action="export"]').click();
            await page.waitForSelector('.pa-export'); await page.waitForSelector('.pa-drawings', {state: 'detached'});
            await page.evaluate(() => {catalog.exports.cancelExports(); catalog.p.showDrawingList();}); await ready();
            await page.evaluate(() => {catalog.holdSave = true; catalog.saving = catalog.p.flushAll(); catalog.sdk.confirmationControl.answer = null;});
            await page.waitForFunction(() => !!catalog.releaseSave);
            await page.locator('.pa-drawings__row[data-doc-id$="aaaaaaa"] [data-action="delete"]').click();
            assert.match(await page.evaluate(() => catalog.sdk.confirmationControl.calls.at(-1).message), /&lt;img/);
            await page.evaluate(() => catalog.sdk.confirmationControl.calls.at(-1).accept());
            await page.waitForFunction(() => catalog.store.retiredDocument);
            const confirmations = await page.evaluate(() => { catalog.p.eventBus.emit('ws-main', {cmd:'removeDoc', code:0, data:{ids:[catalog.ids[0]]}}); return catalog.sdk.confirmationControl.calls.length; });
            await page.evaluate(async () => { catalog.holdSave = false; catalog.releaseSave(); await catalog.saving; });
            await page.waitForFunction(n => catalog.sdk.confirmationControl.calls.length > n, confirmations);
            await page.evaluate(async () => { catalog.sdk.confirmationControl.calls.at(-1).cancel(); await catalog.p.deletionJobs.get(catalog.ids[0]); });
            await page.getByRole('button', {name:'Refresh', exact:true}).click(); await ready();
            assert.equal(await page.locator('.pa-drawings__row[data-doc-id$="aaaaaaa"]').count(), 0);
            assert(await page.evaluate(() => JSON.stringify([...catalog.notes]) === catalog.originalNotes && catalog.files.get(catalog.parent + '/settings.json').preserve));
            assert(await page.evaluate(() => !catalog.files.has(`${catalog.parent}/${catalog.ids[0]}.json`) && ![...catalog.files.keys()].some(path => path.startsWith(`${catalog.parent}/sync-v2/${catalog.ids[0]}/w`))));
            await page.waitForFunction(() => [...catalog.p.overlays.values()].some(o => o.docId === catalog.ids[0] && o.store.loaded && o.store.generation === 1));
            await page.evaluate(async () => { const store = [...catalog.p.overlays.values()].find(o => o.docId === catalog.ids[0]).store; catalog.add(store); catalog.p.pendingSaves.add(store); await catalog.p.flushAll(); });
            await page.getByRole('button', {name:'Refresh', exact:true}).click(); await ready();
            await page.locator('.pa-drawings__row[data-doc-id$="aaaaaaa"] [data-action="delete"]').click();
            await page.evaluate(async () => {
                const {api, ids, Store, add} = catalog, other = window.harness.createPlugin();
                await api.retireDocumentGeneration(other, ids[0], 1, true);
                const newer = new Store(ids[0]); newer.adoptPayload(await api.loadPayload(other, ids[0])); add(newer); await api.savePayload(other, newer.serialize());
                catalog.sdk.confirmationControl.calls.at(-1).accept();
            });
            await page.waitForFunction(() => document.querySelector('.pa-drawings__status')?.textContent.includes('generation changed'));
            assert(await page.evaluate(() => [...catalog.files.keys()].some(path => path.includes(`/sync-v2/${catalog.ids[0]}/g2/w`)) && !catalog.files.has(`${catalog.parent}/document-lifecycle/${catalog.ids[0]}/deleted-3.json`)));
            await page.evaluate(() => {catalog.holdScan = true;});
            await page.getByRole('button', {name:'Refresh', exact:true}).click(); await page.waitForFunction(() => catalog.scanStarted);
            await page.getByRole('button', {name:'Cancel', exact:true}).click(); await page.waitForFunction(() => catalog.scanAborted);
            assert.match(await page.locator('.pa-drawings__status').innerText(), /Scan stopped/);
            const fits = await page.locator('.pa-drawings').evaluate(el => ({width:el.clientWidth, scroll:el.scrollWidth, x:el.getBoundingClientRect().left, right:el.getBoundingClientRect().right}));
            assert(fits.x >= 0 && fits.right <= 390 && fits.scroll <= fits.width);
            await page.evaluate(async () => {catalog.p.drawingList.destroy(); await catalog.p.onunload();});
            assert.deepEqual(errors, []);
            console.log(`${name}: drawing list discovery/search/open/export, ink-only purge, slow writes, stale confirmations, readonly scan/cancel and mobile fit passed`);
        } finally { await browser.close(); }
    }
} finally { await server.close(); }
