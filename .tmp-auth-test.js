const BASE = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(2500);
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

  // 1) 先在工具页面上调用签发接口
  await send('Page.navigate', { url: 'http://127.0.0.1:7391/' });
  await sleep(3000);
  console.log(
    '1) 页面内签发:',
    await ev(`fetch('/api/harness-auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'http://127.0.0.1:54486/'})}).then(r=>r.json()).then(j=>JSON.stringify(j))`)
  );
  console.log(
    '2) 浏览器 cookie:',
    await ev(`(async()=>{const c=await cookieStore.getAll();return JSON.stringify(c.map(x=>({name:x.name.slice(0,14)+'…',domain:x.domain,path:x.path,sameSite:x.sameSite})))})()`)
  );

  // 3) 直接访问 Harness
  await send('Page.navigate', { url: 'http://127.0.0.1:54486/' });
  await sleep(5000);
  console.log(
    '3) 打开 54486:',
    await ev(`JSON.stringify({title:document.title, bodyLen:document.body.innerText.length, head:document.body.innerText.slice(0,80).replace(/\\n/g,' '), hasApp:!!document.querySelector('#root, [data-dsh-root], .dsh-root')})`)
  );

  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
