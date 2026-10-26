const BASE = 'http://127.0.0.1:9223';
const PAGE =
  'http://127.0.0.1:7391/?mode=source&repo=D%3A%5Cyanliangwork%5Cmyprogect%5Cn06liquidglass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pend = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) {
      pend.get(d.id)(d);
      pend.delete(d.id);
    }
  };
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0];
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (e) {}
  try {
    await send('Browser.grantPermissions', {
      origin: 'http://127.0.0.1:7391',
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch (e) {}
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(6500);
  await ev(`localStorage.removeItem('gdv.aiUrl');localStorage.removeItem('gdv.aiMode')`);
  await ev(`jumpToBrowseFile('java/com/kyant/liquidglass/GlassButton.java')`);
  await sleep(1600);

  console.log(
    '1) 面板占位符:',
    await ev(`(async()=>{document.getElementById('aiAskBtn').click();await new Promise(r=>setTimeout(r,400));return JSON.stringify({ph:document.getElementById('aiUrlInput').placeholder, tips:document.querySelectorAll('.ai-setup-tip').length})})()`)
  );

  console.log(
    '2) 填裸地址保存:',
    await ev(`(async()=>{
      window.__opened=[]; window.open=(u,n)=>{window.__opened.push(u);return {focus(){}}};
      document.getElementById('aiUrlInput').value='http://127.0.0.1:54486/';
      document.getElementById('aiUrlSave').click();
      await new Promise(r=>setTimeout(r,1200));
      let clip=''; try{clip=await navigator.clipboard.readText()}catch(e){clip='ERR'}
      return JSON.stringify({mode:localStorage.getItem('gdv.aiMode'), url:localStorage.getItem('gdv.aiUrl'), opened:window.__opened, clipLen:clip.length, toast:(document.querySelector('.toast')||{}).textContent});
    })()`)
  );

  // 3) 再点一次，确认会带着 cookie 打开
  console.log(
    '3) 再次点击:',
    await ev(`(async()=>{
      window.__opened=[]; document.getElementById('aiAskBtn').click();
      await new Promise(r=>setTimeout(r,900));
      return JSON.stringify({opened:window.__opened, toast:(document.querySelector('.toast')||{}).textContent});
    })()`)
  );

  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
