const BASE = 'http://127.0.0.1:9223';
const PAGE = 'http://127.0.0.1:7391/?mode=source&repo=D%3A%5Cyanliangwork%5Cmyprogect%5Cn06liquidglass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') console.log('!! 页面异常:', (d.params.exceptionDetails?.exception?.description || '').split('\n')[0]); };
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0];
    return r.result?.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(6000);

  await ev(`jumpToBrowseFile('java/com/kyant/liquidglass/GlassButton.java')`);
  await sleep(1600);

  // 1) 右键菜单
  console.log('1) 右键 GlassStyle:', await ev(`(()=>{
    const body=document.querySelector('#diffPaneBody'), code=document.querySelector('.fv-code');
    const w=document.createTreeWalker(code,NodeFilter.SHOW_TEXT,null); let n;
    while((n=w.nextNode())){
      const i=n.nodeValue.indexOf('GlassStyle'); if(i<0) continue;
      const r=document.createRange(); r.setStart(n,i+2); r.setEnd(n,i+3);
      let rc=r.getBoundingClientRect();
      if(rc.top<80||rc.top>window.innerHeight-100){ body.scrollTop+=rc.top-300; rc=r.getBoundingClientRect(); }
      const x=Math.round(rc.left+1), y=Math.round(rc.top+rc.height/2);
      (document.elementFromPoint(x,y)||code).dispatchEvent(new MouseEvent('contextmenu',{clientX:x,clientY:y,bubbles:true,cancelable:true}));
      const menu=document.getElementById('refsMenu');
      return JSON.stringify({menu:!!menu, sym:menu&&menu.querySelector('.refs-menu-sym').textContent, items:menu?[...menu.querySelectorAll('.refs-menu-item')].map(b=>b.textContent.trim()):[]});
    }
    return 'not found';
  })()`));

  // 2) 点「查找引用」
  console.log('2) 点击查找引用:', await ev(`(async()=>{
    document.querySelector('[data-act="refs"]').click();
    await new Promise(r=>setTimeout(r,2500));
    const p=document.getElementById('refsPanel');
    if(!p) return 'no panel';
    return JSON.stringify({
      head:p.querySelector('.refs-title').textContent.trim(),
      tabs:[...p.querySelectorAll('.refs-tab')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()),
      scope:p.querySelector('.refs-scope-name').textContent,
      rows:p.querySelectorAll('.refs-item').length,
      kinds:[...new Set([...p.querySelectorAll('.refs-kind')].map(e=>e.textContent))],
      first:[...p.querySelectorAll('.refs-item')].slice(0,2).map(b=>({loc:b.querySelector('.refs-path').textContent+':'+b.querySelector('.refs-ln').textContent, code:b.querySelector('.refs-code').textContent.slice(0,50)}))
    });
  })()`));

  // 3) 点条目跳转，面板应保留
  console.log('3) 点第 2 条:', await ev(`(async()=>{
    const items=[...document.querySelectorAll('.refs-item')];
    const target=items.find(b=>!b.dataset.path.endsWith('GlassButton.java'));
    const before=state.browseSel;
    target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,2500));
    return JSON.stringify({from:before.split('/').pop(), to:state.browseSel.split('/').pop(), panelAlive:!!document.getElementById('refsPanel'), hist:gdvJump.history.length});
  })()`));

  // 4) Ctrl+Alt+Click 反向查
  console.log('4) Ctrl+Alt+Click:', await ev(`(async()=>{
    await jumpToBrowseFile('java/com/kyant/liquidglass/GlassButton.java');
    await new Promise(r=>setTimeout(r,1600));
    const body=document.querySelector('#diffPaneBody'), code=document.querySelector('.fv-code');
    const w=document.createTreeWalker(code,NodeFilter.SHOW_TEXT,null); let n;
    while((n=w.nextNode())){
      const i=n.nodeValue.indexOf('GlassStyle'); if(i<0) continue;
      const r=document.createRange(); r.setStart(n,i+2); r.setEnd(n,i+3);
      let rc=r.getBoundingClientRect();
      if(rc.top<80||rc.top>window.innerHeight-100){ body.scrollTop+=rc.top-300; rc=r.getBoundingClientRect(); }
      const x=Math.round(rc.left+1), y=Math.round(rc.top+rc.height/2);
      (document.elementFromPoint(x,y)||code).dispatchEvent(new MouseEvent('click',{clientX:x,clientY:y,ctrlKey:true,altKey:true,bubbles:true,cancelable:true}));
      return 'dispatched';
    }
    return 'not found';
  })()`));
  await sleep(2500);
  console.log('   结果:', await ev(`(()=>{const p=document.getElementById('refsPanel');return JSON.stringify({sym:p&&p.querySelector('.refs-title b').textContent, rows:p&&p.querySelectorAll('.refs-item').length})})()`));

  // 5) 切「全仓库」tab
  console.log('5) 切全仓库:', await ev(`(async()=>{
    document.querySelector('[data-tab="all"]').click();
    await new Promise(r=>setTimeout(r,700));
    const p=document.getElementById('refsPanel');
    const st1={body:p.querySelector('.refs-body').textContent.replace(/\\s+/g,' ').trim().slice(0,60), spin:!!p.querySelector('.refs-spin')};
    await new Promise(r=>setTimeout(r,6000));
    const p2=document.getElementById('refsPanel');
    return JSON.stringify({duringBuilding:st1, after: p2.querySelector('.refs-body').textContent.replace(/\\s+/g,' ').trim().slice(0,50), rows:p2.querySelectorAll('.refs-item').length, tab:p2.querySelector('[data-tab="all"]').textContent.replace(/\\s+/g,' ').trim()});
  })()`));

  ws.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
