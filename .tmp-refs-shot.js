const fs = require('fs');
const BASE = 'http://127.0.0.1:9223';
const PAGE = 'http://127.0.0.1:7391/?mode=source&repo=D%3A%5Cyanliangwork%5Cmyprogect%5Cn06liquidglass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  // 2x 缩放，截图更清晰
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(6000);
  await ev(`jumpToBrowseFile('java/com/kyant/liquidglass/GlassButton.java')`);
  await sleep(1600);

  // 右键菜单截图
  await ev(`(()=>{
    const body=document.querySelector('#diffPaneBody'), code=document.querySelector('.fv-code');
    const w=document.createTreeWalker(code,NodeFilter.SHOW_TEXT,null); let n;
    while((n=w.nextNode())){ const i=n.nodeValue.indexOf('GlassStyle'); if(i<0) continue;
      const r=document.createRange(); r.setStart(n,i+2); r.setEnd(n,i+3);
      let rc=r.getBoundingClientRect();
      if(rc.top<80||rc.top>window.innerHeight-100){ body.scrollTop+=rc.top-300; rc=r.getBoundingClientRect(); }
      const x=Math.round(rc.left+1), y=Math.round(rc.top+rc.height/2);
      (document.elementFromPoint(x,y)||code).dispatchEvent(new MouseEvent('contextmenu',{clientX:x,clientY:y,bubbles:true,cancelable:true}));
      return 1; } return 0;
  })()`);
  await sleep(400);
  const r = await ev(`(()=>{const m=document.getElementById('refsMenu');const b=m.getBoundingClientRect();return JSON.stringify({x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)})})()`);
  const box = JSON.parse(r);
  const s1 = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x - 12, y: box.y - 12, width: box.w + 24, height: box.h + 24, scale: 3 } });
  fs.writeFileSync('C:/Users/Administrator/AppData/Local/Temp/refs-menu.png', Buffer.from(s1.result.data, 'base64'));
  console.log('菜单', r);

  // 面板截图
  await ev(`document.querySelector('[data-act="refs"]').click()`);
  await sleep(2600);
  const p = await ev(`(()=>{const el=document.getElementById('refsPanel');const b=el.getBoundingClientRect();return JSON.stringify({x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)})})()`);
  const pb = JSON.parse(p);
  const s2 = await send('Page.captureScreenshot', { format: 'png', clip: { x: pb.x - 16, y: pb.y - 16, width: pb.w + 32, height: pb.h + 32, scale: 2 } });
  fs.writeFileSync('C:/Users/Administrator/AppData/Local/Temp/refs-panel.png', Buffer.from(s2.result.data, 'base64'));
  console.log('面板', p);
  ws.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
