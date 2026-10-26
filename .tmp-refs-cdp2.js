const BASE = 'http://127.0.0.1:9223';
const PAGE = 'http://127.0.0.1:7391/?mode=source&repo=D%3A%5Cyanliangwork%5Cmyprogect%5Cn06liquidglass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLICK = (word, mods) => `(()=>{
  const body=document.querySelector('#diffPaneBody'), code=document.querySelector('.fv-code');
  if(!code) return 'no code';
  const w=document.createTreeWalker(code,NodeFilter.SHOW_TEXT,null); let n;
  while((n=w.nextNode())){
    const i=n.nodeValue.indexOf('${word}'); if(i<0) continue;
    const r=document.createRange(); r.setStart(n,i+2); r.setEnd(n,i+3);
    let rc=r.getBoundingClientRect();
    if(rc.top<80||rc.top>window.innerHeight-100){ body.scrollTop+=rc.top-300; rc=r.getBoundingClientRect(); }
    const x=Math.round(rc.left+1), y=Math.round(rc.top+rc.height/2);
    (document.elementFromPoint(x,y)||code).dispatchEvent(new MouseEvent('click',{clientX:x,clientY:y,${mods},bubbles:true,cancelable:true}));
    return 'ok';
  }
  return 'not found';
})()`;
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(6000);
  await ev(`jumpToBrowseFile('java/com/kyant/liquidglass/GlassButton.java')`);
  await sleep(1600);

  // A) Ctrl+Alt+Click 直接查引用（不应触发跳转）
  console.log('A) Ctrl+Alt+Click GlassStyle:', await ev(CLICK('GlassStyle', 'ctrlKey:true,altKey:true')));
  await sleep(2600);
  console.log('   →', await ev(`(()=>{const p=document.getElementById('refsPanel');return JSON.stringify({panel:!!p,sym:p&&p.querySelector('.refs-title b').textContent,rows:p&&p.querySelectorAll('.refs-item').length,stillOn:state.browseSel.split('/').pop(),hist:gdvJump.history.length})})()`));

  // B) 普通 Ctrl+Click 仍然跳定义（不冲突）
  console.log('B) Ctrl+Click 跳定义:', await ev(`(async()=>{gdvRefs.closePanel();await new Promise(r=>setTimeout(r,300));${CLICK('GlassStyle', 'ctrlKey:true')};await new Promise(r=>setTimeout(r,2200));return JSON.stringify({to:state.browseSel.split('/').pop(),panel:!!document.getElementById('refsPanel')})})()`));

  // C) 切全仓库
  await ev(`jumpToBrowseFile('java/com/kyant/liquidglass/GlassButton.java')`);
  await sleep(1400);
  await ev(CLICK('GlassStyle', 'ctrlKey:true,altKey:true'));
  await sleep(2600);
  console.log('C) 切全仓库:', await ev(`(async()=>{
    document.querySelector('[data-tab="all"]').click();
    await new Promise(r=>setTimeout(r,600));
    const p=document.getElementById('refsPanel');
    const during={txt:p.querySelector('.refs-body').textContent.replace(/\\s+/g,' ').trim().slice(0,50), spin:!!p.querySelector('.refs-spin')};
    await new Promise(r=>setTimeout(r,7000));
    const p2=document.getElementById('refsPanel');
    return JSON.stringify({during, afterRows:p2.querySelectorAll('.refs-item').length, afterTxt:p2.querySelector('.refs-body').textContent.replace(/\\s+/g,' ').trim().slice(0,40), tab:p2.querySelector('[data-tab="all"]').textContent.replace(/\\s+/g,' ').trim()});
  })()`));

  // D) Esc 关闭
  console.log('D) Esc 关闭:', await ev(`(async()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(r=>setTimeout(r,300));return JSON.stringify({panel:!!document.getElementById('refsPanel')})})()`));

  ws.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
