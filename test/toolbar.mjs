import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, webkit} from 'playwright';
const server = await createServer({server:{host:'127.0.0.1',port:5204,strictPort:true}}); await server.listen();
try {
    for (const engine of process.env.BROWSER ? [process.env.BROWSER] : ['chromium','webkit']) {
        const browser=await ({chromium,webkit}[engine]).launch(engine==='chromium'?{channel:'chromium'}:{});
        try {
            const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
            const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
            await page.addInitScript(()=>{
                if(!localStorage.getItem('pencil-annotation.toolbar-pos'))localStorage.setItem('pencil-annotation.toolbar-pos',JSON.stringify({x:780,y:760}));
                if(!localStorage.getItem('pencil-annotation.toolbar-dock'))localStorage.setItem('pencil-annotation.toolbar-dock','free');
            });
            const open=async()=>{await page.goto('http://127.0.0.1:5204/test/harness.html');await page.waitForFunction(()=>window.harness?.overlay.store.loaded);await page.locator('#log').evaluate(el=>el.style.display='none');};
            const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            const measure=()=>page.evaluate(()=>{
                const p=harness.palette, r=p.toolbar.getBoundingClientRect(), c=p.toolbar.querySelector('.pa-toolbar__content'), b=p.visibleBounds();
                const buttons=[...p.toolbar.querySelectorAll('.pa-btn')];
                return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,b,
                    fits:r.left>=b.left-.5&&r.top>=b.top-.5&&r.right<=b.right+.5&&r.bottom<=b.bottom+.5,
                    innerFits:c.scrollWidth<=c.clientWidth+1,buttons:buttons.length,vertical:p.toolbar.classList.contains('pa-toolbar--vertical'),compact:p.toolbar.classList.contains('pa-toolbar--compact')};
            });
            await open();await page.evaluate(()=>harness.palette.setMode(true));
            let m=await measure();assert(m.fits&&m.innerFits,`saved hidden-position regression: ${JSON.stringify(m)}`);assert(m.height<=130&&m.compact,'phone default should be compact');
            await page.evaluate(()=>harness.palette.setLayout('vertical'));await frames();m=await measure();assert(m.vertical&&m.width<=130&&m.fits);assert(Math.abs(m.right-382)<.5&&Math.abs(m.bottom-836)<.5,'layout changes should retain nearby right/bottom anchoring');
            assert(await page.evaluate(()=>{
                const b=[...harness.palette.toolbar.querySelector('.pa-toolbar__group').querySelectorAll('button')].map(e=>e.getBoundingClientRect());
                return Math.abs(b[0].top-b[1].top)<1&&Math.abs(b[0].left-b[2].left)<1&&b[1].left>b[0].left&&b[2].top>b[0].top;
            }),'vertical mode must have two tool columns');
            await open();await page.evaluate(()=>harness.palette.setMode(true));assert.equal(await page.evaluate(()=>harness.palette.getLayout()),'vertical');assert((await measure()).fits,'persisted vertical layout must fit on first display');
            const preference=await page.evaluate(async()=>{
                const p=harness.createPlugin();await p.onload();const row=p.setting.items.find(i=>i.title==='Toolbar layout'), select=row.createActionElement();
                const before=JSON.stringify(p.data), saved=select.value;select.value='horizontal';select.dispatchEvent(new Event('change'));
                const ok=saved==='vertical'&&p.palette.getLayout()==='horizontal'&&JSON.stringify(p.data)===before&&localStorage.getItem('pencil-annotation.toolbar-layout')==='horizontal';
                await p.onunload();return ok;
            });assert(preference,'layout preference must remain local rather than writing workspace settings');

            for (const viewport of [{width:320,height:568},{width:360,height:640},{width:390,height:844},{width:568,height:260},{width:600,height:320},{width:601,height:500},{width:768,height:1024},{width:820,height:1180},{width:1024,height:600},{width:1200,height:800}]) {
                await page.setViewportSize(viewport);await frames();
                assert((await measure()).fits, 'window resize must automatically reclamp the displayed toolbar');
                for(const layout of ['auto','horizontal','vertical'])for(const tool of ['pen','highlighter','eraser','select']){
                    await page.evaluate(({layout,tool})=>{const h=harness;h.config.tool=tool;h.palette.setLayout(layout);h.palette.update({hasSelection:tool==='select',warning:tool==='select'?'A synchronization warning':''});h.palette.refresh();},{layout,tool});
                    m=await measure();assert(m.fits&&m.innerFits,`${engine} ${JSON.stringify({viewport,layout,tool,m})}`);assert(m.buttons>=11,'no global action may be omitted');
                }
            }
            assert(await page.evaluate(()=>{
                const p=harness.palette;p.deps.mobile=false;p.setLayout('auto');
                const b=p.visibleBounds();
                for(const [dock,x,y] of [['left',b.left,200],['right',b.right,200],['top',500,b.top],['bottom',500,b.bottom]]){
                    p.applyDockDrag(100,100,x,y);p.repositionForViewport();const r=p.toolbar.getBoundingClientRect();
                    if(p.dock!==dock||r.left<b.left-.5||r.right>b.right+.5||r.top<b.top-.5||r.bottom>b.bottom+.5)return false;
                    if(p.toolbar.classList.contains('pa-toolbar--vertical')!==(dock==='left'||dock==='right'))return false;
                }
                p.setLayout('horizontal');p.applyDockDrag(100,100,b.left,200);
                if(p.toolbar.classList.contains('pa-toolbar--vertical'))return false;
                p.setLayout('vertical');p.applyDockDrag(100,100,500,b.top);
                return p.toolbar.classList.contains('pa-toolbar--vertical');
            }),'docking must respect explicit layout preference and viewport bounds');
            await page.evaluate(()=>{harness.palette.deps.mobile=true;harness.palette.setLayout('auto');harness.config.tool='pen';harness.palette.update({hasSelection:false,warning:''});harness.palette.refresh();});
            m=await measure();assert(m.compact&&m.width<=380&&m.fits,'wide mobile frontend must use compact layout too');
            await page.setViewportSize({width:390,height:844});await frames();
            const visual=await page.evaluate(async()=>{
                const p=harness.palette, descriptor=Object.getOwnPropertyDescriptor(window,'visualViewport'), original=window.visualViewport;
                const fake={offsetLeft:40,offsetTop:120,width:260,height:300,scale:1.5};
                Object.defineProperty(window,'visualViewport',{configurable:true,value:fake});
                p.toolbar.style.setProperty('--pa-safe-left','12px');p.toolbar.style.setProperty('--pa-safe-right','16px');p.toolbar.style.setProperty('--pa-safe-top','18px');p.toolbar.style.setProperty('--pa-safe-bottom','20px');
                p.setLayout('vertical');original.dispatchEvent(new Event('resize'));
                await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
                const a=p.toolbar.getBoundingClientRect();let ok=a.left>=60&&a.top>=146&&a.right<=276&&a.bottom<=392;
                fake.offsetTop=250;fake.height=220;original.dispatchEvent(new Event('scroll'));
                await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
                const b=p.toolbar.getBoundingClientRect();ok&&=b.top>=276&&b.bottom<=442;
                for(const edge of ['left','right','top','bottom'])p.toolbar.style.removeProperty(`--pa-safe-${edge}`);
                Object.defineProperty(window,'visualViewport',descriptor);original.dispatchEvent(new Event('resize'));
                return ok;
            });assert(visual,'visual viewport and safe area changes must reposition the toolbar');await frames();
            if(engine==='chromium'){
                const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});
                await page.waitForFunction(()=>window.visualViewport.scale>1.5);await frames();m=await measure();assert(m.fits&&m.innerFits,'zoomed visual viewport must fit');
                await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});await frames();
            }

            await page.setViewportSize({width:390,height:260});await frames();
            await page.evaluate(()=>{harness.config.tool='pen';harness.palette.setLayout('vertical');harness.palette.refresh();harness.palette.content.scrollTop=0;});
            const rect=await page.locator('.pa-toolbar__content').boundingBox();
            const before=await page.evaluate(()=>({left:harness.palette.toolbar.style.left,top:harness.palette.toolbar.style.top,doc:harness.contentEl.scrollTop,ink:harness.strokesCount()}));
            assert(await page.evaluate(()=>harness.palette.toolbar.classList.contains('pa-toolbar--scrollable')));
            if(engine==='chromium'){
                const cdp=await context.newCDPSession(page), x=rect.x+1;
                await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:rect.y+rect.height-24}]});
                for(let y=rect.y+rect.height-44;y>rect.y+20;y-=15)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});
                await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            }else{
                // Mobile WebKit automation has no wheel/touch-drag injection.
                // Keyboard focus must still reveal the last clipped control.
                await page.locator('.pa-toolbar__content .pa-btn').last().focus();
                assert.equal(await page.locator('.pa-toolbar__content').evaluate(el=>getComputedStyle(el).touchAction),'pan-y');
            }
            await page.waitForFunction(()=>harness.palette.content.scrollTop>15);
            assert(await page.evaluate(before=>harness.palette.toolbar.style.left===before.left&&harness.palette.toolbar.style.top===before.top&&harness.contentEl.scrollTop===before.doc&&harness.strokesCount()===before.ink,before),'palette scrolling must neither drag it nor pan/draw the note');
            const moved=await page.evaluate(()=>{
                const h=harness,p=h.palette,grip=p.toolbar.querySelector('.pa-toolbar__grip'),r=grip.getBoundingClientRect(),old=p.toolbar.getBoundingClientRect();
                h.fire(grip,'pointerdown',r.left+r.width/2,r.top+r.height/2,{pointerId:950});
                h.fire(grip,'pointermove',old.left>150?100:300,90,{pointerId:950});h.fire(grip,'pointerup',old.left>150?100:300,90,{pointerId:950});
                const next=p.toolbar.getBoundingClientRect();return Math.abs(next.left-old.left)>10&&p.stopDrag===null&&h.strokesCount()===0;
            });assert(moved,'visible grip must remain draggable on a scrolling vertical palette');assert((await measure()).fits);
            await page.evaluate(()=>{const p=harness.palette;p.setLayout('horizontal');p.content.scrollTop=0;window.savedSlider=p.toolbar.querySelector('input[type="range"]');p.deps.onWidth=value=>window.receivedWidth=value;});
            await page.setViewportSize({width:820,height:600});await frames();
            assert(await page.evaluate(()=>savedSlider===harness.palette.toolbar.querySelector('input[type="range"]')),'resize/layout must not replace the active slider');
            await page.locator('.pa-width input').focus();const oldValue=Number(await page.locator('.pa-width input').inputValue());await page.keyboard.press('ArrowRight');
            assert.equal(Number(await page.locator('.pa-width input').inputValue()),oldValue+1);assert.equal(await page.evaluate(()=>window.receivedWidth),oldValue+1);
            await page.evaluate(()=>{const p=harness.palette;p.setMode(false);p.handle.style.left='9999px';p.handle.style.top='9999px';p.setMode(false);});
            const handle=await page.locator('.pa-handle').boundingBox();assert(handle.x>=0&&handle.y>=0&&handle.x+handle.width<=820&&handle.y+handle.height<=600);
            await page.setViewportSize({width:390,height:844});await frames();
            for (const layout of ['horizontal','vertical']) {
                await page.evaluate(layout=>{harness.config.tool='pen';harness.palette.setMode(true);harness.palette.setLayout(layout);harness.palette.refresh();harness.palette.deps.onWidth=value=>window.receivedWidth=value;},layout);
                const slider=page.locator('.pa-width input'), rect=await slider.boundingBox();
                const start=layout==='vertical'?{x:rect.x+rect.width/2,y:rect.y+rect.height*.2}:{x:rect.x+rect.width*.2,y:rect.y+rect.height/2};
                const end=layout==='vertical'?{x:start.x,y:rect.y+rect.height*.7}:{x:rect.x+rect.width*.7,y:start.y};
                const position=await page.locator('.pa-toolbar').boundingBox();
                await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:6});await page.mouse.up();
                assert(Number(await slider.inputValue())>5,'native range drag must change width');
                assert.equal(await page.evaluate(()=>window.receivedWidth),Number(await slider.inputValue()));
                const after=await page.locator('.pa-toolbar').boundingBox();assert.equal(after.x,position.x);assert.equal(after.y,position.y);
                assert.equal(await page.evaluate(()=>harness.strokesCount()),0,'range dragging must not draw into the note');
            }
            const deniedStorage = await page.evaluate(async()=>{
                const {Palette}=await import('/src/overlay/toolbar.ts'), get=Storage.prototype.getItem, set=Storage.prototype.setItem;
                let p;
                try {
                    Storage.prototype.getItem=()=>{throw new Error('storage denied')}; Storage.prototype.setItem=()=>{throw new Error('storage denied')};
                    p=new Palette({i18n:key=>key,config:harness.config,settings:harness.settings,onSelectTool(){},onColor(){},onWidth(){},onAction(){},onHandleActivate(){}});
                    const fallback=p.getLayout()==='auto';p.setMode(true);p.setLayout('vertical');const r=p.toolbar.getBoundingClientRect(),b=p.visibleBounds();
                    return fallback&&p.getLayout()==='vertical'&&r.right<=b.right+.5&&r.bottom<=b.bottom+.5;
                } finally {p?.destroy();Storage.prototype.getItem=get;Storage.prototype.setItem=set;}
            });assert(deniedStorage,'unavailable local storage must not prevent toolbar use');
            await page.evaluate(()=>{harness.palette.destroy();window.dispatchEvent(new Event('resize'));window.visualViewport.dispatchEvent(new Event('scroll'));});await frames();assert.equal(await page.locator('.pa-toolbar').count(),0);assert.deepEqual(errors,[]);
            console.log(`${engine}: first-show bounds, compact/vertical layouts, viewport matrix, safe areas/zoom, scroll/drag, local preference and slider identity passed`);
        }finally{await browser.close();}
    }
}finally{await server.close();}
