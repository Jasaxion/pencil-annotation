import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, webkit} from 'playwright';
const server = await createServer({server: {host:'127.0.0.1',port:5203,strictPort:true}}); await server.listen();
try {
    for (const name of process.env.BROWSER ? [process.env.BROWSER] : ['chromium','webkit']) {
        const browser = await ({chromium,webkit}[name]).launch(name==='chromium'?{channel:'chromium'}:{});
        try {
            const page = await browser.newPage({viewport:{width:1100,height:800}});
            await page.goto('http://127.0.0.1:5203/test/harness.html'); await page.waitForFunction(()=>window.harness?.overlay.store.loaded);
            const result = await page.evaluate(async()=>{
                const h=window.harness, {segmentHitsStroke,pointHitsStroke,translateStroke}=await import('/src/engine/geometry.ts');
                const {StrokeRenderer,paintStrokes}=await import('/src/engine/renderer.ts');
                const stroke=(id,pts)=>({id,tool:'pen',color:'#000',width:4,opacity:1,simulate:false,createdAt:1,points:pts.map(([x,y])=>({x,y,p:.5}))});
                const sparse=stroke('sparse',[[0,0],[1000,0]]), dot=stroke('dot',[[4,6]]);
                const long=stroke('long',Array.from({length:601},(_,i)=>[i,i===2?0:100]));
                const geometry = segmentHitsStroke(sparse,500,-50,500,50,1) && pointHitsStroke(sparse,500,0,1) &&
                    segmentHitsStroke(dot,0,6,10,6,1) && pointHitsStroke(dot,4,6,0) && !pointHitsStroke(dot,40,60,1) &&
                    pointHitsStroke(long,2,0,.1) && !pointHitsStroke(stroke('u',[[0,0],[0,100],[100,100],[100,0]]),50,50,1) &&
                    segmentHitsStroke(stroke('line',[[0,0],[10,0]]),5,0,20,0,0) && !segmentHitsStroke(stroke('line',[[0,0],[10,0]]),20,0,30,0,1);
                const renderer=new StrokeRenderer(), visible=stroke('visible',[[10,10],[40,40]]);
                const hidden=Array.from({length:100},(_,i)=>stroke(`off-${i}`,[[10,10000+i*200],[50,10020+i*200]]));
                const canvas=document.createElement('canvas'); canvas.width=canvas.height=100; const ctx=canvas.getContext('2d');
                let pathCalls=0; const getPath=renderer.getPath.bind(renderer); renderer.getPath=(...args)=>{pathCalls++;return getPath(...args)};
                paintStrokes(ctx,[visible,...hidden],renderer,{originX:0,originY:0,width:100,height:100});
                const lazy=pathCalls===1 && hidden.every(s=>!renderer.cache.get(s.id).path);
                const reference=document.createElement('canvas');reference.width=reference.height=100;const referenceCtx=reference.getContext('2d');
                const outline=StrokeRenderer.outline(visible,false), path=new Path2D(); path.moveTo(...outline[0]);for(let i=1;i<outline.length;i++)path.lineTo(...outline[i]);path.closePath();referenceCtx.fill(path);
                const expected=referenceCtx.getImageData(0,0,100,100).data, actual=ctx.getImageData(0,0,100,100).data;
                const samePixels=actual.every((v,i)=>v===expected[i]);
                paintStrokes(ctx,[visible,...hidden],renderer,{originX:0,originY:10000,width:100,height:100});
                const lazyPan=pathCalls===2;
                const bounds=renderer.getBounds(visible);const stableBounds=bounds===renderer.getBounds(visible);
                translateStroke(visible,10,0);const moved=renderer.getBounds(visible);visible.width=10;const widened=renderer.getBounds(visible);
                const invalidation=moved!==bounds && moved.minX===bounds.minX+10 && widened!==moved && widened.minX<moved.minX;

                h.settings.shapeSnap=false;h.settings.doubleTapToggle=false;h.config.tool='pen';
                const still=h.toClient(80,120);h.fire(h.captureEl(),'pointerdown',still.x,still.y,{pointerId:899});
                let liveRequests=0;const requestLive=h.overlay.scheduleLive.bind(h.overlay);h.overlay.scheduleLive=()=>{liveRequests++;requestLive()};
                h.fire(h.captureEl(),'pointermove',still.x,still.y,{pointerId:899});
                const duplicatePenSkipped=liveRequests===0;
                h.overlay.scheduleLive=requestLive;h.fire(h.captureEl(),'pointerup',still.x,still.y,{pointerId:899,pressure:0});
                h.overlay.store.clearAll();h.overlay.refreshFromStore();h.config.tool='eraser';
                h.overlay.store.addStroke('pen',{color:'#000',width:4,opacity:1,simulate:false},[{x:0,y:200,p:.5},{x:300,y:200,p:.5}]);
                const start=h.toClient(100,150); h.fire(h.captureEl(),'pointerdown',start.x,start.y,{pointerId:900});
                let offsets=0;const buildOffsets=h.overlay.buildOffsets.bind(h.overlay);h.overlay.buildOffsets=()=>{offsets++;return buildOffsets()};
                const samples=[180,200,200,230].map(y=>{const p=h.toClient(100,y);return new PointerEvent('pointermove',{pointerId:900,pointerType:'pen',buttons:1,pressure:.5,clientX:p.x,clientY:p.y})});
                const p=h.toClient(100,230), event=new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:900,pointerType:'pen',buttons:1,pressure:.5,clientX:p.x,clientY:p.y});
                Object.defineProperty(event,'getCoalescedEvents',{value:()=>samples});h.captureEl().dispatchEvent(event);
                const batch=offsets===1 && h.overlay.curPoints.length===1 && h.overlay.store.strokes.length===0;
                h.overlay.buildOffsets=buildOffsets;h.fire(h.captureEl(),'pointerup',p.x,p.y,{pointerId:900,pressure:0});h.overlay.undo();
                const undo=h.overlay.store.strokes.length===1;
                h.config.tool='select';let copies=0,moves=0;
                const snapshot=h.overlay.store.snapshotStrokes.bind(h.overlay.store),move=h.overlay.store.moveStrokesTransient.bind(h.overlay.store);
                h.overlay.store.snapshotStrokes=(...args)=>{copies++;return snapshot(...args)};
                h.overlay.store.moveStrokesTransient=(...args)=>{moves++;return move(...args)};
                const select=h.toClient(150,200);
                h.fire(h.captureEl(),'pointerdown',select.x,select.y,{pointerId:901});
                h.fire(h.captureEl(),'pointermove',select.x,select.y,{pointerId:901});h.fire(h.captureEl(),'pointerup',select.x,select.y,{pointerId:901,pressure:0});
                const lazySelection=h.overlay.selected.length===1 && copies===0 && moves===0;
                h.fire(h.captureEl(),'pointerdown',select.x,select.y,{pointerId:902});h.fire(h.captureEl(),'pointermove',select.x+30,select.y+5,{pointerId:902});h.fire(h.captureEl(),'pointerup',select.x+30,select.y+5,{pointerId:902,pressure:0});
                const snapshotOnce=copies===1 && moves===1;
                h.overlay.undo();h.overlay.deselect();h.overlay.store.snapshotStrokes=snapshot;h.overlay.store.moveStrokesTransient=move;
                await h.sleep(200);
                const raf=window.requestAnimationFrame,caf=window.cancelAnimationFrame,frames=new Map();let next=1,paints=0;
                window.requestAnimationFrame=fn=>{const id=next++;frames.set(id,fn);return id};window.cancelAnimationFrame=id=>frames.delete(id);
                const redraw=h.overlay.redrawLive.bind(h.overlay);h.overlay.redrawLive=()=>{paints++;redraw()};
                let fallback=false, noLatePaint=false;
                try {
                    h.overlay.scheduleLive();h.overlay.scheduleLive();const old=[...frames.values()][0];
                    await h.sleep(180);fallback=paints===1 && frames.size===0;
                    h.overlay.scheduleLive();old();const fresh=[...frames.values()][0];fresh();await h.sleep(180);
                    fallback&&=paints===2 && frames.size===0;
                    h.overlay.scheduleLive();const abandoned=[...frames.values()][0];h.overlay.finalizeInput();const finished=paints;abandoned();await h.sleep(180);
                    noLatePaint=paints===finished && frames.size===0 && h.overlay.liveTimer===null;
                } finally {window.requestAnimationFrame=raf;window.cancelAnimationFrame=caf;h.overlay.redrawLive=redraw;}
                return {geometry,lazy,lazyPan,samePixels,stableBounds,invalidation,batch,undo,duplicatePenSkipped,lazySelection,snapshotOnce,fallback,noLatePaint};
            });
            Object.entries(result).forEach(([key,value])=>assert(value,`${name}: ${key} ${JSON.stringify(result)}`));
            const before=await page.evaluate(()=>harness.contentEl.scrollTop);await page.mouse.move(200,500);await page.mouse.wheel(0,150);
            await page.waitForFunction(before=>harness.contentEl.scrollTop>before,before);
            console.log(`${name}: exact sparse/dot erasure, one offset batch, lazy offscreen paths, unchanged ink pixels, rAF fallback and native wheel passed`);
        } finally {await browser.close();}
    }
} finally {await server.close();}
