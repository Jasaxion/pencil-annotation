import assert from "node:assert/strict";
import {createServer} from "vite";
import {chromium, webkit} from "playwright";
const server = await createServer({server: {host: "127.0.0.1", port: 5200, strictPort: true}});
await server.listen();
try {
    for (const engine of process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"]) {
        const browser = await ({chromium, webkit}[engine]).launch(engine === "chromium" ? {channel: "chromium"} : {});
        try {
            const page = await browser.newPage();
            const errors = []; page.on("pageerror", error => errors.push(error.message));
            await page.goto("http://127.0.0.1:5200/test/harness.html");
            await page.waitForFunction(() => window.harness?.overlay.store.loaded);
            const result = await page.evaluate(async () => {
                const h = window.harness, api = await import("/src/plugin/api.ts"), {confirmationControl} = await import("/test/siyuan.ts");
                h.overlay.destroy(); h.palette.toolbar.remove(); h.palette.handle.remove();
                const id = "20261002120000-abcdefg", otherId = "20261002120001-abcdefg";
                const root = `/data/storage/petal/pencil-annotation/sync-v2/${id}`, parent = "/data/storage/petal/pencil-annotation";
                const files = new Map(), oldFetch = window.fetch;
                let exists = true, closed = false, offline = false, held = false, finishWrite, symlink = false, holdInfoFor = null, releaseInfo;
                window.fetch = async (url, options) => {
                    const endpoint = String(url), data = options.body instanceof FormData ? null : JSON.parse(options.body ?? "{}");
                    if (endpoint.endsWith("getDocInfo")) {
                        if (offline) throw new TypeError("offline");
                        if (data.id === holdInfoFor) {
                            holdInfoFor = null;
                            const response = exists ? {code: 0, data: {id: data.id, rootID: data.id}} : {code: -1, msg: 'block not found', data: null};
                            return new Promise(resolve => { releaseInfo = () => resolve(Response.json(response)); });
                        }
                        return Response.json(exists ? {code: 0, data: {id: data.id, rootID: data.id}} : {code: -1, msg: "block not found", data: null});
                    }
                    if (endpoint.endsWith("lsNotebooks")) return Response.json({code: 0, data: {notebooks: [{closed, encrypted: false}]}});
                    if (endpoint.endsWith("readDir")) {
                        const entries = new Map(), prefix = data.path + "/";
                        for (const path of files.keys()) if (path.startsWith(prefix)) {
                            const tail = path.slice(prefix.length), name = tail.split("/")[0];
                            entries.set(name, {name, isDir: tail.includes("/"), isSymlink: symlink && name === id && data.path.endsWith("/sync-v2")});
                        }
                        return Response.json({code: 0, data: [...entries.values()]});
                    }
                    if (endpoint.endsWith("getFile")) return files.has(data.path) ? Response.json(files.get(data.path)) : new Response("", {status: 404});
                    if (endpoint.endsWith("putFile")) {
                        const path = options.body.get("path"), value = JSON.parse(await options.body.get("file").text());
                        if (held && /\/w[a-f0-9]+-\d+\.json$/.test(path)) return new Promise(resolve => { finishWrite = () => { files.set(path, value); resolve(Response.json({code: 0})); }; });
                        files.set(path, value); return Response.json({code: 0});
                    }
                    if (endpoint.endsWith("removeFile")) {
                        for (const path of files.keys()) if (path === data.path || path.startsWith(data.path + "/")) files.delete(path);
                        return Response.json({code: 0});
                    }
                    throw new Error(`Unexpected API ${endpoint}`);
                };
                const until = async predicate => { for (let n = 0; n < 300; n++) { if (predicate()) return; await h.sleep(5); } throw new Error("deletion check timed out"); };
                const protyle = {...h.fakeProtyle, options: {rootId: id}, block: {rootID: id}};
                const p = h.createPlugin(), peer = h.createPlugin(), observer = h.createPlugin();
                for (const plugin of [p, peer, observer]) { await plugin.onload(); clearInterval(plugin.syncPoll); plugin.armSave = () => {}; }
                const legacy = {version: 1, docId: id, updatedAt: 1, strokes: [{i: "legacy", t: 0, c: "#000", w: 3, o: 1, s: 0, a: 1, p: [10, 20, .5]}]};
                files.set(`${parent}/${id}.json`, legacy);
                p.attachProtyle(protyle);
                const old = p.overlays.get(protyle.element).store;
                await until(() => old.loaded);
                const add = store => store.addStroke("pen", {color: "#000", width: 4, opacity: 1, simulate: false}, [{x: 30, y: 40, p: .5}]);
                add(old); p.pendingSaves.add(old); await p.flushAll();
                const baseline = old.strokes.length === 2 && !old.dirty;
                const clone = protyle.element.cloneNode(true); clone.querySelectorAll(".pa-overlay").forEach(el => el.remove()); document.body.append(clone);
                const observerProtyle = {...protyle, element: clone, contentElement: clone.querySelector(".protyle-content"), wysiwyg: {element: clone.querySelector(".protyle-wysiwyg")}};
                observer.attachProtyle(observerProtyle);
                const observedOld = observer.overlays.get(clone).store; await until(() => observedOld.loaded);
                add(old); p.pendingSaves.add(old); held = true;
                const publication = old.serialize(), oldPayload = old.backup().payload, saving = p.flushAll();
                await until(() => finishWrite);
                exists = false;
                const notice = {cmd: "removeDoc", code: 0, data: {ids: [id, id]}};
                p.eventBus.emit("ws-main", notice); peer.eventBus.emit("ws-main", notice);
                await until(() => old.retiredDocument);
                held = false; finishWrite();
                await Promise.all([saving, p.deletionJobs.get(id), peer.deletionJobs.get(id)]);
                const markerCount = () => [...files.keys()].filter(path => path.includes(`document-lifecycle/${id}/deleted-`)).length;
                const erased = !files.has(`${parent}/${id}.json`) && ![...files.keys()].some(path => path.startsWith(root + "/") && path !== root + "/retired-v1.json");
                old.adoptPayload(oldPayload); old.mergeRemote(oldPayload); old.unblock(); old.acknowledge(999);
                let mutationRejected = false; old.beginInput(); try { add(old); } catch { mutationRejected = true; }
                let staleWriteRejected = false; try { await api.savePayload(p, publication); } catch { staleWriteRejected = true; }
                const deadStore = !old.canEdit && old.strokes.length === 0 && !old.dirty && mutationRejected && staleWriteRejected;
                p.eventBus.emit("ws-main", notice); await p.deletionJobs.get(id);
                const duplicateSafe = markerCount() === 1 && confirmationControl.calls.length === 0;
                await observer.onDataChanged("sync");
                const absentRetirement = observedOld.retiredDocument && observedOld.strokes.length === 0 && !observer.documents.has(id);
                exists = true;
                const staleObserver = new old.constructor(id); staleObserver.adoptPayload(oldPayload);
                observer.documents.set(id, staleObserver); observer.attachProtyle(observerProtyle);
                await observer.onDataChanged("sync");
                await until(() => observer.overlays.get(clone)?.store.loaded);
                const restoredRetirement = staleObserver.retiredDocument && staleObserver.strokes.length === 0 && observer.overlays.get(clone).store.generation === 1 && observer.overlays.get(clone).store.strokes.length === 0;
                p.attachProtyle(protyle);
                const fresh = p.overlays.get(protyle.element).store;
                await until(() => fresh.loaded);
                const freshGeneration = fresh.generation === 1 && fresh.strokes.length === 0;
                add(fresh); p.pendingSaves.add(fresh); await p.flushAll();
                const freshPaths = [...files.keys()].filter(path => path.startsWith(root + "/g1/"));
                await observer.onDataChanged("sync");
                const metadataClient = h.createPlugin(), deletedPath = `${parent}/document-lifecycle/${id}/deleted-1.json`, activePath = `${parent}/document-lifecycle/${id}/active-1.json`;
                const deletedRecord = files.get(deletedPath), activeRecord = files.get(activePath);
                files.delete(deletedPath);
                let activeBeforeDeleteBlocked = false, missingProofRemembered = false;
                try { await api.loadPayload(metadataClient, id); } catch (error) { activeBeforeDeleteBlocked = error.name === 'SyncTransientError'; }
                files.delete(activePath);
                try { await api.loadPayload(metadataClient, id); } catch (error) { missingProofRemembered = error.name === 'SyncTransientError'; }
                files.set(deletedPath, deletedRecord); files.set(activePath, activeRecord);
                const temporary = [];
                for (let i = 0; i < 2100; i++) {
                    const other = `20260101000000-${String(i).padStart(7, '0')}`, path = `${parent}/document-lifecycle/${other}/deleted-1.json`;
                    temporary.push(path); files.set(path, {version: 1, docId: other, kind: 'deleted', generation: 1});
                }
                const registryBudget = (await api.retiredDocumentIds(metadataClient)).length >= 2100;
                temporary.forEach(path => files.delete(path));
                files.delete(`${parent}/document-lifecycle/${id}/active-1.json`); // partial marker synchronization must not classify existing g1 data as unborn
                confirmationControl.answer = false;
                p.eventBus.emit("ws-main", notice); await p.deletionJobs.get(id);
                const delayedNoticeSafe = markerCount() === 1 && freshPaths.every(path => files.has(path)) && confirmationControl.calls.length === 1;
                await until(() => fresh.canEdit);
                exists = false; p.eventBus.emit("ws-main", notice); await p.deletionJobs.get(id);
                const declined = markerCount() === 1 && freshPaths.every(path => files.has(path));
                await observer.onDataChanged("sync");
                const sameGenerationUnavailable = !observer.overlays.get(clone).store.retiredDocument && observer.overlays.get(clone).store.strokes.length === 1;
                confirmationControl.answer = true; p.eventBus.emit("ws-main", notice); await p.deletionJobs.get(id);
                const repeatedDelete = markerCount() === 2 && freshPaths.every(path => !files.has(path));
                exists = true;
                const current = new fresh.constructor(id); current.adoptPayload(await api.loadPayload(p, id)); add(current);
                await api.savePayload(p, current.serialize());
                const newestPaths = [...files.keys()].filter(path => path.startsWith(root + "/g2/"));
                files.set(`${parent}/${id}.json`, legacy);
                const latePath = `${root}/${publication.snapshot.writer}-${publication.snapshot.sequence}.json`;
                files.set(latePath, publication.snapshot);
                symlink = true; let symlinkRefused = false;
                try { await api.cleanupRetiredDocument(p, id); } catch { symlinkRefused = files.has(latePath); }
                symlink = false; await api.cleanupRetiredDocument(p, id);
                const selectiveCleanup = !files.has(latePath) && !files.has(`${parent}/${id}.json`) && newestPaths.length > 0 && newestPaths.every(path => files.has(path));
                let legacyBlocked = false; try { await api.reconcileLegacy(p, id); } catch { legacyBlocked = true; }
                files.set(`${parent}/${otherId}.json`, {...legacy, docId: otherId});
                files.set(`${parent}/settings.json`, {keep: true});
                exists = false; closed = true; confirmationControl.answer = false;
                const otherNotice = {cmd: "removeDoc", code: 0, data: {ids: [otherId]}};
                p.eventBus.emit("ws-main", {cmd: "closenotebook", code: 0, data: {ids: [otherId]}});
                p.eventBus.emit("ws-main", {...otherNotice, code: -1});
                p.eventBus.emit("ws-main", {cmd: "removeDoc", code: 0, data: {ids: ["settings", "../bad"]}});
                await p.onDataChanged("overwrite");
                const noAbsenceDeletion = files.has(`${parent}/${otherId}.json`) && files.has(`${parent}/settings.json`);
                p.eventBus.emit("ws-main", otherNotice); await p.deletionJobs.get(otherId);
                const closedSafe = files.has(`${parent}/${otherId}.json`) && ![...files.keys()].some(path => path.includes(`document-lifecycle/${otherId}/deleted-`));
                closed = false; offline = true; p.eventBus.emit("ws-main", otherNotice); await p.deletionJobs.get(otherId);
                const failedSafe = files.has(`${parent}/${otherId}.json`) && p.failedDeletions.has(otherId);
                offline = false; p.onOnline(); await p.deletionJobs.get(otherId);
                const retryConfirmed = files.has(`${parent}/${otherId}.json`) && !p.failedDeletions.has(otherId);
                const loadingId = "20261002120002-abcdefg", loadingRoot = `${parent}/sync-v2/${loadingId}`;
                for (const kind of ["deleted", "active"]) files.set(`${parent}/document-lifecycle/${loadingId}/${kind}-1.json`, {version: 1, docId: loadingId, generation: 1, kind});
                exists = false; holdInfoFor = loadingId; releaseInfo = null;
                const loadingProtyle = {...protyle, options: {rootId: loadingId}, block: {rootID: loadingId}};
                p.attachProtyle(loadingProtyle); const loadingStore = p.overlays.get(protyle.element).store;
                await until(() => releaseInfo);
                exists = true; // restored before the old absent-document response is delivered
                const initialLoad = loadingStore.loading;
                const loadingNotice = {cmd: "removeDoc", code: 0, data: {ids: [loadingId]}};
                p.eventBus.emit("ws-main", loadingNotice); await p.deletionJobs.get(loadingId);
                await until(() => loadingStore.loaded && loadingStore.canEdit);
                releaseInfo(); await initialLoad.catch(() => {});
                const declinedLoadingResumes = loadingStore.generation === 1 && loadingStore.canEdit;
                add(loadingStore); p.pendingSaves.add(loadingStore); await p.flushAll();
                confirmationControl.answer = null;
                const promptsBefore = confirmationControl.calls.length;
                p.eventBus.emit("ws-main", loadingNotice);
                await until(() => confirmationControl.calls.length > promptsBefore);
                const staleApproval = confirmationControl.calls.at(-1);
                await api.retireDocumentGeneration(peer, loadingId, 1, true);
                const newer = new old.constructor(loadingId); newer.adoptPayload(await api.loadPayload(peer, loadingId)); add(newer);
                await api.savePayload(peer, newer.serialize());
                const newerPaths = [...files.keys()].filter(path => path.startsWith(loadingRoot + "/g2/"));
                staleApproval.accept(); await p.deletionJobs.get(loadingId);
                const staleConfirmationSafe = newerPaths.length > 0 && newerPaths.every(path => files.has(path)) && !files.has(`${parent}/document-lifecycle/${loadingId}/deleted-3.json`);
                await p.onunload(); await peer.onunload(); await observer.onunload(); window.fetch = oldFetch;
                return {baseline, erased, deadStore, duplicateSafe, activeBeforeDeleteBlocked, missingProofRemembered, registryBudget, absentRetirement, restoredRetirement, sameGenerationUnavailable, freshGeneration, delayedNoticeSafe, declined, repeatedDelete, selectiveCleanup, symlinkRefused, legacyBlocked, noAbsenceDeletion, closedSafe, failedSafe, retryConfirmed, declinedLoadingResumes, staleConfirmationSafe};
            });
            Object.entries(result).forEach(([key, value]) => assert(value, key));
            assert.deepEqual(errors, []);
            console.log(`${engine}: confirmed document deletion, in-flight writes, duplicate notices, restored generations, conservative confirmation and targeted cleanup passed`);
        } finally { await browser.close(); }
    }
} finally { await server.close(); }
