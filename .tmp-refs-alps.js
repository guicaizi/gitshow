const fs = require('fs');
const BASE = 'http://127.0.0.1:9223';
const REPO = 'Z://N06//u0.mp1.rc-aiot_alps';
const PAGE = 'http://127.0.0.1:7391/?mode=source&repo=' + encodeURIComponent(REPO);
const P = 'frameworks/base/services/core/java/com/android/server/policy/AppOpsPolicy.java';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description||'').split('\n')[0]; return r.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(9000);
  console.log('打开文件:', await ev(`(async()=>{const t=Date.now();await jumpToBrowseFile('${P}');await new Promise(r=>setTimeout(r,2500));return JSON.stringify({sel:state.browseSel.split('/').pop(),ms:Date.now()-t})})()`));

  console.log('查引用:', await ev(`(async()=>{
    const t=Date.now();
    await gdvRefs.askRefs('ActivityManager');
    for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,400)); const p=document.getElementById('refsPanel'); if(p&&p.querySelector('.refs-item')) break; }
    const p=document.getElementById('refsPanel');
    return JSON.stringify({ms:Date.now()-t, rows:p.querySelectorAll('.refs-item').length, scope:p.querySelector('.refs-scope-name').textContent});
  })()`));

  // 长路径下的省略表现
  console.log('路径宽度:', await ev(`(()=>[...document.querySelectorAll('.refs-path')].slice(0,3).map(e=>({text:e.textContent, cw:e.clientWidth, sw:e.scrollWidth, clipped:e.scrollWidth>e.clientWidth})))()`));

  const pb = JSON.parse(await ev(`(()=>{const b=document.getElementById('refsPanel').getBoundingClientRect();return JSON.stringify({x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)})})()`));
  const s2 = await send('Page.captureScreenshot', { format: 'png', clip: { x: pb.x - 16, y: pb.y - 16, width: pb.w + 32, height: pb.h + 32, scale: 2 } });
  fs.writeFileSync('C:/Users/Administrator/AppData/Local/Temp/refs-alps2.png', Buffer.from(s2.result.data, 'base64'));
  console.log('截图', JSON.stringify(pb));
  ws.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
