import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, webkit} from 'playwright';
const server = await createServer({server: {host: '127.0.0.1', port: 5202, strictPort: true}}); await server.listen();
try {
    for (const name of process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'webkit']) {
        const browser = await ({chromium, webkit}[name]).launch(name === 'chromium' ? {channel: 'chromium'} : {});
        try {
            const page = await browser.newPage({viewport: {width: 1100, height: 900}});
            await page.goto('http://127.0.0.1:5202/test/harness.html'); await page.waitForFunction(() => window.harness?.overlay.store.loaded);
            const result = await page.evaluate(async () => {
                const {buildNotePdfBlob} = await import('/src/plugin/exportPdf.ts');
                const h = window.harness, source = h.wysiwygEl, docId = h.overlay.docId;
                const p = (id, text, style = '') => `<div data-node-id="${id}" data-type="NodeParagraph" style="height:60px;box-sizing:border-box;${style}">${text}</div>`;
                const q = (id, children = '') => `<div data-node-id="${id}" data-type="NodeBlockQueryEmbed" data-content="select * from blocks" class="render-node">${children}</div>`;
                const columns = `<div data-node-id="super" data-type="NodeSuperBlock" data-sb-layout="col" style="display:flex;gap:12px">${p('left', 'LEFT_COLUMN', 'width:48%')}${p('right', 'RIGHT_COLUMN', 'width:48%')}</div>`;
                const raw = p('target', 'Ordinary duplicate outside the live viewport') + p('before', 'Before') + columns + q('q1') + q('q2') + q('q3') + p('tail', 'FULL_SOURCE_TAIL');
                source.innerHTML = p('before', 'Before') + columns + q('q1', p('target', 'LIVE_EMBED_ONE')) + q('q2', p('target', 'LIVE_EMBED_TWO'));
                await new Promise(resolve => requestAnimationFrame(resolve));
                const stroke = (id, anchor, color = '#ff0000') => ({id, anchor: {blockId: anchor, ox: 0, oy: 0}, color, tool: 'pen', width: 6, opacity: 1, simulate: false, createdAt: 1, points: [{x: 15, y: 20, p: .6}, {x: 70, y: 20, p: .6}]});
                const strokes = [stroke('before-ink', 'before'), stroke('left-ink', 'left'), stroke('right-ink', 'right'), stroke('embedded-ink', 'target', '#ff8800'), stroke('tail-ink', 'tail'), stroke('unloaded-ink', 'q3'), stroke('missing-ink', 'not-found')];
                const original = JSON.stringify(strokes), htmlBefore = source.innerHTML;
                const requests = [];
                let columnLayout = false, witnessedOccurrence = false, tailPresent = false, orangePixel = false, fallbackGroups = 0;
                const encode = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
                    if (type === 'image/jpeg' && quality === .94) {
                        const host = document.querySelector('.pa-pdf-host'), target = host.querySelector('#unused') || host.querySelector('[data-node-id="q1"] [data-node-id="target"]');
                        const r = target.getBoundingClientRect(), page = host.firstElementChild.getBoundingClientRect(), scale = this.width / page.width;
                        const x = Math.round((r.left - page.left + 35) * scale), y = Math.round((r.top - page.top + 20) * scale);
                        if (x >= 0 && y >= 0 && x < this.width && y < this.height) {
                            const pixel = this.getContext('2d').getImageData(x, y, 1, 1).data;
                            orangePixel ||= pixel[0] > 190 && pixel[1] > 70 && pixel[1] < 180 && pixel[2] < 90;
                        }
                    }
                    return encode.call(this, type, quality);
                };
                let pdf;
                try {
                    pdf = await buildNotePdfBlob({docId, source, strokes}, {signal: new AbortController().signal,
                        request: async (path, data) => {
                            requests.push({path,id:data.id});
                            if (path.endsWith('getBlockDOM')) return {id: docId, dom: raw};
                            if (path.endsWith('getDocInfo')) return {id: docId, rootID: docId, name: 'Current layout', ial: {}};
                            if (data.id === docId) throw new Error('Redundant full native export');
                            return {id: data.id, type: 'NodeBlockQueryEmbed', content: p('generated-result', 'UNLOADED_STATIC_RESULT').replace('data-node-id=', 'data-pa-pdf-anchor="ink-0" data-node-id=')};
                        },
                        onProgress: stage => { if (stage === 'page') {
                            const body = document.querySelector('.pa-pdf-host .protyle-wysiwyg');
                            const left = body.querySelector('[data-node-id="left"]').getBoundingClientRect(), right = body.querySelector('[data-node-id="right"]').getBoundingClientRect();
                            columnLayout = Math.abs(left.top - right.top) < 1 && right.left > left.right;
                            const target = body.querySelector('[data-node-id="target"][data-pa-pdf-anchor]');
                            witnessedOccurrence = !!target && target.closest('[data-type="NodeBlockQueryEmbed"]').dataset.nodeId === 'q1';
                            fallbackGroups = body.querySelectorAll('.pa-pdf-compatibility svg').length;
                            tailPresent = body.textContent.includes('FULL_SOURCE_TAIL') && body.textContent.includes('LIVE_EMBED_TWO') && body.textContent.includes('UNLOADED_STATIC_RESULT');
                        }} });
                } finally { HTMLCanvasElement.prototype.toDataURL = encode; }
                const immutable = original === JSON.stringify(strokes) && htmlBefore === source.innerHTML;
                const checkChanged = async (live, raw, id) => {
                    source.innerHTML = p(id, live);
                    return buildNotePdfBlob({docId, source, strokes: [stroke('changed', id)]}, {signal: new AbortController().signal,
                        request: async path => path.endsWith('getBlockDOM') ? {id: docId, dom: p(id, raw)} : {id: docId, rootID: docId, type: 'NodeDocument', name: 'Changed content', content: p(id, raw)}});
                };
                const textChanged = await checkChanged('Visible old text', 'Different saved text', 'changed-text');
                const image = color => `<img style="width:20px;height:20px" src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${color}"/></svg>`)}">`;
                const imageChanged = await checkChanged(image('red'), image('blue'), 'changed-image');
                const canvas = await checkChanged('<canvas width="20" height="20"></canvas>', '<canvas width="20" height="20"></canvas>', 'canvas');
                const address = location.href;
                const meta = await checkChanged('Saved content', '<meta http-equiv="refresh" content="0;url=/must-not-navigate">Saved content', 'meta');
                const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sprite.style.display = 'none';
                sprite.innerHTML = '<symbol id="pdf-safe-symbol"><path onclick="window.svgInjected=1" d="M0 0L20 20"/></symbol>'; document.body.append(sprite);
                const iconHTML = p('icon', '<svg width="20" height="20"><use href="#pdf-safe-symbol"></use></svg>'); source.innerHTML = iconHTML;
                let expandedSymbolSafe = false;
                try { await buildNotePdfBlob({docId, source, strokes: []}, {signal: new AbortController().signal,
                    request: async path => path.endsWith('getBlockDOM') ? {id: docId, dom: iconHTML} : {id: docId, rootID: docId, type:'NodeDocument', name:'Icon', content:iconHTML},
                    onProgress: stage => { if (stage === 'page') {const path = document.querySelector('.pa-pdf-host svg path'); expandedSymbolSafe = !!path && !path.hasAttribute('onclick');} }}); }
                finally { sprite.remove(); }
                const {captureCurrentLayout, prepareCurrentLayout} = await import('/src/plugin/pdfLayout.ts');
                const {compatibility} = await import('/src/plugin/pdfCompatibility.ts');
                const noOrdinaryLiveClone = captureCurrentLayout(source, []).live.childNodes.length === 0;
                const many = Array.from({length: 35}, (_, i) => `many-${i}`);
                source.innerHTML = many.slice(0, 34).map(id => q(id, p(`value-${id}`, 'Loaded'))).join('');
                const template = document.createElement('template'); template.innerHTML = many.map(id => q(id)).join('');
                let focusedCalls = 0;
                await prepareCurrentLayout(template.content, captureCurrentLayout(source, []), docId, async (path, data) => {focusedCalls++; return {id: data.id, type: 'NodeBlockQueryEmbed', content:p('late-result','LATE_STATIC_RESULT')};}, new AbortController().signal, compatibility(true));
                const requestBudget = focusedCalls === 1 && template.content.textContent.includes('LATE_STATIC_RESULT');
                return {columnLayout, witnessedOccurrence, tailPresent, orangePixel, expandedSymbolSafe, requestBudget, noOrdinaryLiveClone,
                    activeHtmlBlocked: location.href === address && meta.warnings.some(w => w.includes('meta')),
                    noRedundantPreview: requests.filter(r => r.path.endsWith('exportPreviewHTML') && r.id === docId).length === 0 && requests.filter(r => r.path.endsWith('getDocInfo')).length === 1 && requests.filter(r => r.path.endsWith('getBlockDOM')).length === 2,
                    changedContentSeparated: textChanged.warnings.some(w => w.startsWith('Some ink')) && imageChanged.warnings.some(w => w.startsWith('Some ink')),
                    canvasReported: canvas.warnings.some(w => w.includes('canvas')),
                    individualFallback: fallbackGroups === 2 && pdf.warnings.some(w => w.startsWith('Some ink')) && !pdf.warnings.some(w => /\d+ strokes/.test(w)),
                    immutable, valid: await pdf.blob.slice(0, 4).text() === '%PDF', clean: !document.querySelector('.pa-pdf-host')};
            });
            Object.entries(result).forEach(([key, value]) => assert(value, `${name}: ${key} ${JSON.stringify(result)}`));
            console.log(`${name}: current superblock columns, current duplicate-ID occurrence, ink pixels, complete source and individual fallback passed`);
        } finally { await browser.close(); }
    }
} finally { await server.close(); }
