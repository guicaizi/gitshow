/**
 * prize add by yanliang 20261029-start
 * 设备截图页：adb 抓当前界面 + uiautomator 布局树。
 *
 * 左边是截图（可缩放、可点选），右边是布局树与属性。
 * 树里点一个节点 → 图上框出来；图上点一下 → 选中该坐标最深的那个节点。
 */
'use strict';

(function () {
  const S = {
    open: false,
    serial: '',
    devices: [],
    shot: null,
    layout: null,
    tree: [],
    stats: null,
    sel: null,
    hover: null,
    collapsed: new Set(),
    include: null,
    filter: '',
    clickOnly: false,
    loading: false,
    error: '',
    zoom: 'fit', // fit | free
    scale: 1,
    tab: 'overview', // 分析表格当前页签
    folded: false,
    flat: null, // 扁平化后的节点数组，表格共用
    boxes: false,
    stageW: 0,
    stageH: 0,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  function shortCls(cls) {
    const s = String(cls || '');
    if (!s) return '(无类名)';
    const i = s.lastIndexOf('.');
    return i < 0 ? s : s.slice(i + 1);
  }

  function shortId(rid) {
    const s = String(rid || '');
    if (!s) return '';
    return s.replace(/^[A-Za-z0-9_.]+:id\//, '@id/');
  }

  function fmtTime(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async function apiGet(action, params) {
    const qs = new URLSearchParams(params || {});
    const res = await fetch(`/api/${action}?${qs}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '请求失败');
    return data;
  }

  async function apiPost(action, payload) {
    const res = await fetch(`/api/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '请求失败');
    return data;
  }

  /* ---------------- 页面骨架 ---------------- */

  function shell() {
    return `
      <header class="shot-bar">
        <button class="btn icon shot-back" id="shotBack" title="返回提交列表">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 5l-7 7 7 7"></path>
          </svg>
        </button>
        <div class="shot-brand">设备截图<span class="shot-sub" id="shotSub">读取中…</span></div>
        <select id="shotDev" class="shot-dev hidden" title="选择设备"></select>
        <div class="shot-bar-acts">
          <button class="btn small" id="shotCast" title="用 scrcpy 打开投屏窗口（原生窗口，画面不嵌在网页里）">投屏</button>
          <button class="btn small" id="shotAgain" title="重新抓取截图与布局">重新抓取</button>
          <button class="btn small" id="shotSave" title="把这张截图存到本地">保存图片</button>
          <button class="btn small ghost" id="shotClose" title="关闭（Esc）">关闭</button>
        </div>
      </header>
      <div class="shot-body">
        <section class="shot-left">
          <div class="shot-toolbar">
            <button class="btn small" id="shotFit" title="整屏适应窗口">适应</button>
            <button class="btn small" id="shotOne" title="原始像素 1:1">1:1</button>
            <button class="btn small" id="shotZoomOut" title="缩小">−</button>
            <span class="shot-zoom" id="shotZoom">100%</span>
            <button class="btn small" id="shotZoomIn" title="放大">+</button>
            <label class="adb-chk" title="把布局树里所有可点击区域框出来"><input type="checkbox" id="shotBoxes" />标出可点区域</label>
            <span class="shot-hint" id="shotHint"></span>
          </div>
          <div class="shot-stage" id="shotStage">
            <div class="shot-canvas" id="shotCanvas">
              <img id="shotImg" alt="设备截图" draggable="false" />
              <div class="shot-overlay" id="shotOverlay"></div>
            </div>
            <div class="shot-placeholder" id="shotPlaceholder">正在抓取设备界面…</div>
          </div>
        </section>
        <div class="shot-split" id="shotSplit" title="拖动调整左右宽度"></div>
        <aside class="shot-right">
          <div class="shot-info" id="shotInfo"></div>
          <div class="shot-tables">
            <div class="shot-tabs" id="shotTabs">
              <button class="shot-tab on" data-tab="overview">概览</button>
              <button class="shot-tab" data-tab="cls">类名分布</button>
              <button class="shot-tab" data-tab="click">可点清单</button>
              <button class="shot-tab" data-tab="issue">问题诊断</button>
              <button class="shot-tab" data-tab="cmd">命令速查</button>
              <button class="shot-tab-mini" id="shotTableFold" title="收起或展开表格">收起</button>
            </div>
            <div class="shot-table-wrap" id="shotTables"></div>
          </div>
          <div class="shot-find">
            <input id="shotFilter" class="adb-input" spellcheck="false" placeholder="过滤 text / id / class，回车跳第一条" />
            <label class="adb-chk"><input type="checkbox" id="shotClickOnly" />只看可点</label>
          </div>
          <div class="shot-tree" id="shotTree"></div>
          <div class="shot-detail" id="shotDetail"></div>
        </aside>
      </div>`;
  }

  function openPage() {
    const page = $('shotPage');
    if (!page) return;
    S.open = true;
    page.innerHTML = shell();
    page.classList.remove('hidden');
    document.body.classList.add('shot-open');
    bindAll();
    capture('first');
  }

  function closePage() {
    if (!S.open) return;
    S.open = false;
    const page = $('shotPage');
    if (page) {
      page.classList.add('hidden');
      page.innerHTML = '';
    }
    document.body.classList.remove('shot-open');
    S.shot = null;
    S.layout = null;
    S.tree = [];
    S.sel = null;
    S.hover = null;
    S.flat = null;
    S.tab = 'overview';
    S.folded = false;
    S.collapsed = new Set();
    S.include = null;
    S.error = '';
  }

  /* ---------------- 抓取 ---------------- */

  async function loadDevices() {
    try {
      const st = await apiGet('adb-status');
      S.devices = (st.devices || []).filter((d) => d.state === 'device');
      const sel = $('shotDev');
      if (!S.devices.length) {
        S.serial = '';
        if (sel) sel.classList.add('hidden');
        return;
      }
      if (!S.devices.some((d) => d.serial === S.serial)) S.serial = S.devices[0].serial;
      if (sel) {
        if (S.devices.length > 1) {
          sel.classList.remove('hidden');
          sel.innerHTML = S.devices
            .map(
              (d) =>
                `<option value="${esc(d.serial)}"${d.serial === S.serial ? ' selected' : ''}>${esc(
                  d.model || d.serial
                )}</option>`
            )
            .join('');
        } else {
          sel.classList.add('hidden');
        }
      }
    } catch (_) {
      S.devices = [];
      S.serial = '';
    }
  }

  function paintPlaceholder(text, isError) {
    const ph = $('shotPlaceholder');
    if (!ph) return;
    if (!text) {
      ph.classList.add('hidden');
      ph.classList.remove('shot-bad');
      return;
    }
    ph.textContent = text;
    ph.classList.toggle('shot-bad', !!isError);
    ph.classList.remove('hidden');
  }

  function paintSub() {
    const sub = $('shotSub');
    if (!sub) return;
    const dev = S.devices.find((d) => d.serial === S.serial);
    if (S.error) {
      sub.textContent = '抓取失败';
      return;
    }
    if (!dev && !S.serial) {
      sub.textContent = '没有已连接的设备';
      return;
    }
    const name = (dev && (dev.model || dev.serial)) || S.serial;
    const res = S.shot && S.shot.width ? ` · ${S.shot.width}×${S.shot.height}` : '';
    sub.textContent = name + res;
  }

  async function capture(mode) {
    if (S.loading) return;
    S.loading = true;
    S.error = '';
    if (mode === 'first') paintPlaceholder('正在抓取设备界面…');
    const again = $('shotAgain');
    if (again) again.disabled = true;
    try {
      await loadDevices();
      if (!S.serial) throw new Error('没有已连接的设备：先用 USB 连上并允许调试');
      // 截图与布局并行，设备端各写各的临时文件，互不影响
      const [shot, layout] = await Promise.all([
        apiPost('adb-shot', { serial: S.serial }),
        apiPost('adb-layout', { serial: S.serial }).catch((err) => ({ error: err.message })),
      ]);
      S.shot = shot;
      if (layout && layout.error) {
        S.layout = null;
        S.tree = [];
        S.stats = null;
        S.rightError = layout.error;
      } else {
        S.layout = layout;
        S.tree = layout.tree || [];
        S.stats = layout.stats;
        S.rightError = '';
        S.collapsed = new Set();
        autoCollapse(S.tree);
        buildInclude();
      }
      S.flat = null;
      S.sel = null;
      S.hover = null;
      paintShot();
      paintInfo();
      paintTables();
      paintTree();
      paintDetail(null);
      paintSub();
      paintPlaceholder('');
      if (S.zoom === 'fit') applyFit();
    } catch (err) {
      S.error = err.message || String(err);
      S.shot = null;
      S.tree = [];
      S.stats = null;
      S.flat = null;
      paintShot();
      paintInfo();
      paintTables();
      paintTree();
      paintDetail(null);
      paintSub();
      paintPlaceholder(S.error, true);
    } finally {
      S.loading = false;
      const btn = $('shotAgain');
      if (btn) btn.disabled = false;
      paintCast();
    }
  }

  // 默认只展开前 3 层：层级太深的树一打开就是几千行
  function autoCollapse(list) {
    const walk = (n) => {
      if (n.kids.length && n.depth >= 3) S.collapsed.add(n.id);
      n.kids.forEach(walk);
    };
    list.forEach(walk);
  }

  /* ---------------- 截图区 ---------------- */

  function paintShot() {
    const img = $('shotImg');
    const canvas = $('shotCanvas');
    if (!img || !canvas) return;
    if (!S.shot) {
      canvas.classList.add('hidden');
      img.removeAttribute('src');
      return;
    }
    canvas.classList.remove('hidden');
    if (img.getAttribute('src') !== S.shot.url) img.src = S.shot.url;
    img.onload = () => {
      applyScale();
      paintOverlay();
    };
    const hint = $('shotHint');
    if (hint) hint.textContent = `${S.shot.sizeText} · ${fmtTime(S.shot.at)}`;
  }

  function applyFit() {
    const stage = $('shotStage');
    if (!stage || !S.shot) return;
    const pad = 24;
    const w = stage.clientWidth - pad;
    const h = stage.clientHeight - pad;
    if (w <= 0 || h <= 0) return;
    const s = Math.min(w / S.shot.width, h / S.shot.height);
    S.scale = Math.max(0.05, Math.min(s, 1));
    S.zoom = 'fit';
    applyScale();
  }

  function applyScale() {
    const img = $('shotImg');
    const canvas = $('shotCanvas');
    if (!img || !canvas || !S.shot) return;
    const w = Math.max(1, Math.round(S.shot.width * S.scale));
    const h = Math.max(1, Math.round(S.shot.height * S.scale));
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const z = $('shotZoom');
    if (z) z.textContent = Math.round(S.scale * 100) + '%';
    paintOverlay();
  }

  // 设备像素 → 截图像素的比例（多数设备 1:1，override 分辨率时可能不等）
  function pxRatio() {
    const sw = S.shot && S.shot.screen && S.shot.screen.width;
    if (!sw || !S.shot.width) return 1;
    return S.shot.width / sw;
  }

  function boxRect(b) {
    const k = pxRatio() * S.scale;
    return {
      left: Math.round(b[0] * k),
      top: Math.round(b[1] * k),
      width: Math.max(1, Math.round((b[2] - b[0]) * k)),
      height: Math.max(1, Math.round((b[3] - b[1]) * k)),
    };
  }

  function paintOverlay() {
    const ov = $('shotOverlay');
    if (!ov) return;
    ov.innerHTML = '';
    if (!S.shot) return;
    if (S.boxes) {
      const walk = (n) => {
        if (n.click && n.b[2] > n.b[0] && n.b[3] > n.b[1]) {
          const r = boxRect(n.b);
          const d = document.createElement('div');
          d.className = 'shot-box all';
          d.style.left = r.left + 'px';
          d.style.top = r.top + 'px';
          d.style.width = r.width + 'px';
          d.style.height = r.height + 'px';
          ov.appendChild(d);
        }
        n.kids.forEach(walk);
      };
      S.tree.forEach(walk);
    }
    if (S.sel && S.sel.b) {
      const r = boxRect(S.sel.b);
      const d = document.createElement('div');
      d.className = 'shot-box sel';
      d.style.left = r.left + 'px';
      d.style.top = r.top + 'px';
      d.style.width = r.width + 'px';
      d.style.height = r.height + 'px';
      ov.appendChild(d);
    }
    if (S.hover && S.hover.b && (!S.sel || S.sel.id !== S.hover.id)) {
      const r = boxRect(S.hover.b);
      const d = document.createElement('div');
      d.className = 'shot-box hover';
      d.style.left = r.left + 'px';
      d.style.top = r.top + 'px';
      d.style.width = r.width + 'px';
      d.style.height = r.height + 'px';
      ov.appendChild(d);
    }
  }

  // 树里选中的节点如果在图上滚出视野了，把截图滚到它中间
  function ensureBoxVisible(n) {
    if (!n || !n.b) return;
    const stage = $('shotStage');
    const img = $('shotImg');
    if (!stage || !img || !S.shot) return;
    const r = boxRect(n.b);
    const ir = img.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const left = ir.left - sr.left + stage.scrollLeft;
    const top = ir.top - sr.top + stage.scrollTop;
    const pad = 24;
    if (r.width <= stage.clientWidth - pad * 2 && (left + r.width > stage.scrollLeft + stage.clientWidth - pad || left < stage.scrollLeft + pad)) {
      stage.scrollLeft = Math.max(0, left + r.width / 2 - stage.clientWidth / 2);
    }
    if (r.height <= stage.clientHeight - pad * 2 && (top + r.height > stage.scrollTop + stage.clientHeight - pad || top < stage.scrollTop + pad)) {
      stage.scrollTop = Math.max(0, top + r.height / 2 - stage.clientHeight / 2);
    }
  }

  /* ---------------- 信息区 ---------------- */

  function paintInfo() {
    const box = $('shotInfo');
    if (!box) return;
    if (S.error) {
      box.innerHTML = `<div class="shot-info-err">${esc(S.error)}</div>`;
      return;
    }
    const sh = S.shot;
    if (!sh) {
      box.innerHTML = '<div class="shot-info-empty">还没有截图</div>';
      return;
    }
    const dev = S.devices.find((d) => d.serial === S.serial) || {};
    const st = S.stats || {};
    const focus = (S.layout && S.layout.focus) || '';
    const rows = [
      ['设备', `${dev.model || sh.serial}${dev.release ? ' · Android ' + dev.release : ''}`],
      ['分辨率', `${sh.width}×${sh.height}${sh.screen && sh.screen.density ? ' · ' + sh.screen.density + 'dpi' : ''}`],
      ['界面', focus || '（未取到当前 Activity）'],
      ['节点', S.layout ? `${st.total || 0} 个 · 可点 ${st.clickable || 0} · 有文字 ${st.texts || 0}` : '（布局读取失败）'],
    ];
    box.innerHTML =
      `<div class="shot-info-grid">` +
      rows
        .map(
          ([k, v]) =>
            `<div class="shot-info-k">${esc(k)}</div><div class="shot-info-v" title="${esc(v)}">${esc(v)}</div>`
        )
        .join('') +
      `</div>` +
      (st.truncated ? '<div class="shot-info-warn">节点太多，只保留了前 4000 个</div>' : '');
  }

  /* ---------------- 分析数据表 ---------------- */

  // 分类速查：把窗口排查常用的 adb 命令按「焦点 / 合成 / 界面 / 显示 / 取证」归好类
  // k 有值 = 设备端可执行（走 adb-probe 白名单），无值 = 只能复制到终端自己跑
  const CMDS = [
    { g: '焦点', k: 'focus', cmd: 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"', use: '当前焦点窗口，判断焦点被谁抢走' },
    { g: '焦点', k: 'windows', cmd: 'dumpsys window windows', use: '所有窗口的 frame、可见性、flag' },
    { g: '焦点', k: 'displays', cmd: 'dumpsys window displays', use: 'Display 尺寸、密度、旋转、cutout' },
    { g: '焦点', k: 'policy', cmd: 'dumpsys window policy', use: 'keyguard 状态、是否禁止截屏录屏' },
    { g: '焦点', k: 'animator', cmd: 'dumpsys window animator', use: '窗口动画是否卡住（没上屏时先看这里）' },
    { g: '合成', k: 'sf-list', cmd: 'dumpsys SurfaceFlinger --list', use: '所有 Layer 名单，确认目标 Layer 在不在' },
    { g: '合成', k: 'sf', cmd: 'dumpsys SurfaceFlinger', use: '每个 Layer 的 z-order、crop、buffer 状态' },
    { g: '合成', k: '', cmd: 'dumpsys SurfaceFlinger --latency <layer>', use: '帧时间戳，查掉帧和卡顿（要带 Layer 名）' },
    { g: '界面', k: 'activities', cmd: 'dumpsys activity activities', use: 'Task 栈、topResumedActivity' },
    { g: '界面', k: 'top', cmd: 'dumpsys activity top', use: '顶层 Activity 的 View 层级' },
    { g: '显示', k: 'display', cmd: 'wm size; wm density', use: '物理与覆盖的分辨率、密度' },
    { g: '显示', k: 'rotation', cmd: 'settings get system user_rotation', use: '强制旋转角度' },
    { g: '取证', k: '', cmd: 'screencap -p /sdcard/s.png', use: 'SF 合成路径截图，和 App 内部截图对比' },
    { g: '取证', k: '', cmd: 'screenrecord --bugreport /sdcard/a.mp4', use: '录屏加帧时间，复现偶发问题' },
    { g: '取证', k: '', cmd: 'logcat -s WindowManager SurfaceFlinger BufferQueue', use: '窗口创建销毁与 buffer 生命周期' },
    { g: '本页', k: '', cmd: 'uiautomator dump /sdcard/ui.xml', use: '本页布局树来源，可点区域和文字都从这来' },
  ];

  function density() {
    return (S.shot && S.shot.screen && S.shot.screen.density) || 0;
  }

  function px2dp(px) {
    const d = density();
    return d ? Math.round((px * 160) / d) : Math.round(px);
  }

  function screenSize() {
    const sc = (S.shot && S.shot.screen) || {};
    return {
      w: sc.width || (S.shot && S.shot.width) || 0,
      h: sc.height || (S.shot && S.shot.height) || 0,
    };
  }

  function nodeW(n) {
    return Math.max(0, n.b[2] - n.b[0]);
  }

  function nodeH(n) {
    return Math.max(0, n.b[3] - n.b[1]);
  }

  function pct(a, b) {
    return !b ? '0%' : Math.round((a / b) * 100) + '%';
  }

  function td(v, cls) {
    const s = String(v == null ? '' : v);
    return `<td${cls ? ` class="${cls}"` : ''} title="${esc(s)}">${esc(s)}</td>`;
  }

  function tdRaw(html, cls) {
    return `<td${cls ? ` class="${cls}"` : ''}>${html}</td>`;
  }

  function tr(cells, attrs) {
    return `<tr${attrs || ''}>${cells.join('')}</tr>`;
  }

  function tblHtml(head, body, note) {
    return (
      `<table class="shot-tbl"><thead><tr>` +
      head.map((h) => `<th>${esc(h)}</th>`).join('') +
      `</tr></thead><tbody>${body}</tbody></table>` +
      (note ? `<div class="shot-tbl-note">${esc(note)}</div>` : '')
    );
  }

  function flatTree() {
    const out = [];
    const walk = (n) => {
      out.push(n);
      n.kids.forEach(walk);
    };
    S.tree.forEach(walk);
    return out;
  }

  function classDist(flat) {
    const m = new Map();
    flat.forEach((n) => {
      const k = shortCls(n.cls);
      const it = m.get(k) || { cls: k, num: 0, click: 0 };
      it.num++;
      if (n.click) it.click++;
      m.set(k, it);
    });
    return [...m.values()].sort((a, b) => b.num - a.num);
  }

  // 可点区域覆盖率：网格采样命中比例，比面积并集好算且够用
  function clickCoverage(flat) {
    const sz = screenSize();
    const nodes = flat.filter((n) => n.click && nodeW(n) > 0 && nodeH(n) > 0);
    if (!sz.w || !sz.h || !nodes.length) return null;
    const N = 48;
    let hit = 0;
    let tot = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = ((i + 0.5) * sz.w) / N;
        const y = ((j + 0.5) * sz.h) / N;
        tot++;
        if (nodes.some((n) => x >= n.b[0] && x <= n.b[2] && y >= n.b[1] && y <= n.b[3])) hit++;
      }
    }
    return hit / tot;
  }

  function overlapNodes(flat) {
    const list = flat.filter((n) => n.click && nodeW(n) > 0 && nodeH(n) > 0).slice(0, 300);
    const hit = new Set();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const w = Math.min(a.b[2], b.b[2]) - Math.max(a.b[0], b.b[0]);
        const h = Math.min(a.b[3], b.b[3]) - Math.max(a.b[1], b.b[1]);
        if (w <= 0 || h <= 0) continue;
        const small = Math.min(nodeW(a) * nodeH(a), nodeW(b) * nodeH(b));
        if (small > 0 && (w * h) / small > 0.6) {
          hit.add(a);
          hit.add(b);
        }
      }
    }
    return [...hit];
  }

  function dupNodes(flat) {
    const m = new Map();
    flat.forEach((n) => {
      if (!n.txt) return;
      m.set(n.txt, (m.get(n.txt) || 0) + 1);
    });
    return flat.filter((n) => n.txt && m.get(n.txt) >= 3);
  }

  function issueList(flat) {
    const sz = screenSize();
    const d = density();
    const minPx = d ? Math.round((48 * d) / 160) : 0;
    const out = [];
    const add = (name, level, note, list) => {
      if (list && list.length) out.push({ name, level, note, list });
    };
    add('可点区域过小', 'warn', minPx ? `短边小于 ${minPx}px（48dp），手指容易点不中` : '短边小于 48dp', flat.filter((n) => n.click && n.enabled && (nodeW(n) < minPx || nodeH(n) < minPx)));
    add('可点但尺寸为 0', 'bad', 'clickable 却宽或高为 0，点了没反应', flat.filter((n) => n.click && (nodeW(n) <= 0 || nodeH(n) <= 0)));
    add('超出屏幕', 'bad', 'bounds 落在屏幕外，可能被裁掉或点击坐标失效', sz.w ? flat.filter((n) => n.b[0] < 0 || n.b[1] < 0 || n.b[2] > sz.w || n.b[3] > sz.h) : []);
    add('可点但无文字', 'info', '没有 text 也没有 content-desc，看图或自动化都认不出', flat.filter((n) => n.click && !n.txt && !n.desc));
    add('有文字但不可点', 'info', '文字只是展示，点了不响应属正常，确认不是 bug 即可', flat.filter((n) => n.txt && !n.click));
    add('可点区域互相重叠', 'warn', '两个可点区域重叠超过 60%，点击可能被上层吃掉', overlapNodes(flat));
    add('密码类输入框', 'info', 'password=true，无障碍节点里的文字是掩码', flat.filter((n) => n.password));
    add('文字重复出现', 'info', '同一段文字出现 3 次以上，留意列表项或重复控件', dupNodes(flat));
    return out;
  }

  function tabOverview(flat) {
    const sz = screenSize();
    const d = density();
    const cx = flat.filter((n) => n.click);
    const tx = flat.filter((n) => n.txt);
    const maxDepth = flat.reduce((m, n) => Math.max(m, n.depth), 0);
    const cov = clickCoverage(flat);
    const iss = issueList(flat);
    const bad = iss.filter((i) => i.level === 'bad').reduce((s, i) => s + i.list.length, 0);
    const warn = iss.filter((i) => i.level === 'warn').reduce((s, i) => s + i.list.length, 0);
    const rows = [
      ['节点总数', String(flat.length), 'uiautomator dump 解析出的全部节点'],
      ['可点节点', `${cx.length} · ${pct(cx.length, flat.length)}`, 'clickable=true，真正能点到的控件'],
      ['有文字节点', `${tx.length} · ${pct(tx.length, flat.length)}`, 'text 非空，卡片和列表项一般是这类'],
      ['最大层级', `${maxDepth} 层`, '层级越深说明布局嵌套越多'],
      ['可点面积覆盖', cov == null ? '-' : Math.round(cov * 100) + '%', '屏幕被可点区域覆盖的比例，太低说明大片区域点不动'],
      ['屏幕 / 密度', `${sz.w}×${sz.h}${d ? ' · ' + d + 'dpi' : ''}`, d ? `1dp ≈ ${(d / 160).toFixed(2)}px` : '取不到密度，dp 换算省略'],
      ['48dp 阈值', d ? `${Math.round((48 * d) / 160)}px` : '-', '短边小于它的可点区域按「过小」算'],
      ['异常命中', `严重 ${bad} · 需注意 ${warn}`, '展开「问题诊断」看命中的具体节点'],
    ];
    return tblHtml(
      ['指标', '值', '说明'],
      rows.map((r) => tr([td(r[0]), td(r[1]), td(r[2], 'muted')])).join('')
    );
  }

  function tabCls(flat) {
    const dist = classDist(flat).slice(0, 20);
    if (!dist.length) return '<div class="shot-tbl-empty">没有节点</div>';
    const max = dist[0].num || 1;
    const rows = dist
      .map((x) => {
        const w = Math.max(3, Math.round((x.num / max) * 100));
        return tr([
          td(x.cls),
          td(String(x.num)),
          td(String(x.click)),
          tdRaw(`<span class="shot-mbar"><i style="width:${w}%"></i></span> ${pct(x.num, flat.length)}`),
        ]);
      })
      .join('');
    return tblHtml(['类名', '节点数', '可点', '占比'], rows, '按节点数排序，只列前 20 类');
  }

  function tabClick(flat) {
    const d = density();
    const minPx = d ? Math.round((48 * d) / 160) : 48;
    const list = flat.filter((n) => n.click).slice(0, 400);
    if (!list.length) return '<div class="shot-tbl-empty">这一屏没有可点节点</div>';
    const rows = list
      .map((n) => {
        const small = nodeW(n) < minPx || nodeH(n) < minPx;
        return tr(
          [
            td(shortCls(n.cls)),
            td(n.txt || shortId(n.rid) || n.desc || '—'),
            td(`${px2dp(nodeW(n))}×${px2dp(nodeH(n))}`),
            td(`${n.b[0]},${n.b[1]}`),
            td(small ? '过小' : '正常', small ? 'bad' : 'good'),
          ],
          ` class="jump" data-id="${n.id}"`
        );
      })
      .join('');
    return tblHtml(['类名', '文字 / id', '尺寸 dp', '左上', '判定'], rows, '点一行跳到树上选中该节点');
  }

  function tabIssue(flat) {
    const iss = issueList(flat);
    if (!iss.length) return '<div class="shot-tbl-empty">没命中规则，这一屏结构看起来正常</div>';
    const lv = (k) => (k === 'bad' ? '严重' : k === 'warn' ? '注意' : '提示');
    const lvCls = (k) => (k === 'bad' ? 'bad' : k === 'warn' ? 'warn' : 'muted');
    const rows = iss
      .map((it) =>
        tr(
          [td(it.name), td(String(it.list.length)), td(lv(it.level), lvCls(it.level)), td(it.note)],
          ` class="jump" data-id="${it.list[0].id}"`
        )
      )
      .join('');
    return tblHtml(['规则', '命中', '级别', '判断依据'], rows, '点一行跳到第一个命中的节点');
  }

  function tabCmd() {
    const rows = CMDS.map((c) => {
      const run = !!c.k;
      return tr(
        [td(c.g), td(c.cmd), td(c.use, 'muted'), td(run ? '运行分析' : '复制', run ? 'run' : 'muted')],
        ` class="jump" data-key="${esc(c.k || '')}" data-cmd="${esc(c.cmd)}"`
      );
    }).join('');
    return tblHtml(
      ['分类', '命令', '用来判断什么', '操作'],
      rows,
      '点一行：能在设备上跑的会直接执行并把结果解析成卡片和表格；带 <layer> 的只能复制到终端跑'
    );
  }

  /* ---------------- 命令结果分析 ---------------- */

  const PROBE_TITLE = {
    focus: '当前焦点窗口',
    windows: '窗口列表',
    displays: 'Display 信息',
    policy: '窗口策略与锁屏',
    animator: '窗口动画',
    'sf-list': 'Layer 名单',
    sf: '图层合成状态',
    activities: 'Activity 栈',
    top: '顶层 Activity',
    display: '分辨率与密度',
    rotation: '旋转设置',
  };

  function lastLine(out, kw) {
    const ls = out.split(/\r?\n/).filter((l) => l.includes(kw));
    return ls.length ? ls[ls.length - 1].trim() : '';
  }

  function kvOf(out, key) {
    const m = new RegExp(key + '=([^\\s,}]+)').exec(out);
    return m ? m[1] : '';
  }

  function yesNo(v) {
    if (v === 'true') return '是';
    if (v === 'false') return '否';
    return v || '-';
  }

  function pFocus(out) {
    const line = lastLine(out, 'mCurrentFocus');
    const app = lastLine(out, 'mFocusedApp');
    const w = /Window\{[0-9a-fA-F]+ u(\d+) ([^}]+)\}/.exec(line);
    const name = w ? w[2].trim() : '';
    const empty = !name || name === 'null';
    const pack = empty ? '' : name.split('/')[0];
    const act = name.includes('/') ? name.split('/')[1] : '';    const blocks = [
      {
        type: 'cards',
        items: [
          ['焦点窗口', empty ? '（没有窗口拿到焦点）' : name, empty ? 'bad' : 'good'],
          ['包名', pack || '-'],
          ['界面', act ? act.split('.').pop() : '-'],
          ['窗口用户', w ? 'u' + w[1] : '-'],
          ['判定', empty ? '焦点为空：可能在转场、被锁屏盖住或 AMS 卡住' : '点击会落到这个窗口', empty ? 'warn' : ''],
        ],
      },
    ];
    if (app) blocks.push({ type: 'note', text: 'mFocusedApp：' + app.replace(/^mFocusedApp=/, '') });
    return blocks;
  }

  function pWindows(out) {
    const wins = [];
    let cur = null;
    out.split(/\r?\n/).forEach((l) => {
      const h = /^\s*Window #(\d+) Window\{[0-9a-fA-F]+ u(\d+) ([^}]+)\}/.exec(l);
      if (h) {
        cur = { idx: h[1], name: h[3].trim(), vis: '', surf: '', ty: '', frame: '' };
        wins.push(cur);
        return;
      }
      if (!cur) return;
      if (!cur.vis) {
        const m = /isVisible=(\w+)/.exec(l);
        if (m) cur.vis = m[1];
      }
      if (!cur.surf) {
        const m = /mHasSurface=(\w+)/.exec(l);
        if (m) cur.surf = m[1];
      }
      if (!cur.ty) {
        const m = /ty=([A-Z_]+)/.exec(l);
        if (m) cur.ty = m[1];
      }
      if (!cur.frame) {
        const m = /(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(l);
        if (m) cur.frame = `${Number(m[3]) - Number(m[1])}×${Number(m[4]) - Number(m[2])} @ ${m[1]},${m[2]}`;
      }
    });
    if (!wins.length) return [];
    const vis = wins.filter((w) => w.vis === 'true').length;
    const surf = wins.filter((w) => w.surf === 'true').length;
    const noSurf = wins.filter((w) => w.surf === 'false').length;
    const rows = wins
      .slice(0, 120)
      .map((w) =>
        tr([
          td(w.idx),
          td(w.name),
          td(w.ty || '-'),
          td(yesNo(w.vis), w.vis === 'true' ? 'good' : 'muted'),
          td(yesNo(w.surf), w.surf === 'false' ? 'bad' : ''),
          td(w.frame || '-'),
        ])
      )
      .join('');
    return [
      {
        type: 'cards',
        items: [
          ['窗口总数', String(wins.length)],
          ['可见', String(vis), 'good'],
          ['有 surface', String(surf)],
          ['没 surface', String(noSurf), noSurf ? 'bad' : ''],
        ],
      },
      {
        type: 'table',
        title: '窗口明细',
        head: ['#', '窗口', '类型', '可见', 'Surface', '尺寸'],
        rows,
        note: wins.length > 120 ? '只列前 120 个窗口' : '可见=是 且有 surface 的窗口才是真在屏幕上',
      },
    ];
  }

  function pDisplays(out) {
    const cur = /cur=(\d+)x(\d+)/.exec(out);
    const app = /app=(\d+)x(\d+)/.exec(out);
    const init = /init=(\d+)x(\d+)/.exec(out);
    const densRaw = /density (\d+)/i.exec(out) || /(\d+)\s*dpi/i.exec(out);
    let dens = densRaw && Number(densRaw[1]) >= 10 ? densRaw[1] : '';
    // 副屏的 dumpsys 密度经常是 1dpi，退回本页从 wm density 读到的值
    if (!dens && density()) dens = String(density());
    const id = /mDisplayId=(-?\d+)/.exec(out);
    const rot = /mRotation=(ROTATION_\d+)/.exec(out) || /rotation[ =](\d)/i.exec(out);
    const hz = /([\d.]+)\s*hz/i.exec(out);
    const cut = /cutout\s*=\s*([^\n]{0,50})/i.exec(out);
    const items = [
      ['Display', id ? '#' + id[1] : '-'],
      ['cur', cur ? cur[1] + '×' + cur[2] : '-'],
      ['app', app ? app[1] + '×' + app[2] : '-'],
      ['init', init ? init[1] + '×' + init[2] : '-'],
      ['密度', dens ? dens + 'dpi' : '-'],
      ['旋转', rot ? rot[1] : '-'],
    ];
    if (hz) items.push(['刷新率', hz[1] + 'Hz']);
    if (cut) items.push(['cutout', cut[1].trim()]);
    return [
      { type: 'cards', items },
      { type: 'note', text: 'cur 是当前逻辑分辨率，app 是 App 可用区域；两者不一致通常是被系统栏或 cutout 让了位' },
    ];
  }

  function pPolicy(out) {
    const keys = [
      ['mKeyguardShowing', '锁屏显示'],
      ['mKeyguardOccluded', '锁屏被遮挡'],
      ['mScreenOnFully', '屏幕点亮完成'],
      ['mAwake', '已唤醒'],
      ['interactiveState', '交互状态'],
      ['mForceShowSystemBars', '强制显示系统栏'],
      ['mKeyguardDrawComplete', '锁屏绘制完成'],
    ];
    const items = [];
    const seen = new Set();
    keys.forEach(([k, name]) => {
      const v = kvOf(out, k);
      if (!v || seen.has(k)) return;
      seen.add(k);
      const warn = v === 'true' && (k === 'mKeyguardShowing' || k === 'mKeyguardOccluded' || k === 'mForceShowSystemBars');
      items.push([name, yesNo(v), warn ? 'warn' : '']);
    });
    // 不同 ROM 的 policy 字段差别很大，缺字段时退回按关键字捞几行
    if (items.length < 3) {
      out.split(/\r?\n/).forEach((l) => {
        if (items.length >= 8) return;
        if (!/keyguard|awake|screenon|interactive|secure/i.test(l)) return;
        const m = /^\s*([A-Za-z_][\w.]*)\s*=\s*(.+)$/.exec(l);
        if (!m || seen.has(m[1]) || m[2].length > 40) return;
        seen.add(m[1]);
        items.push([m[1], m[2].trim(), /true/i.test(m[2]) && /keyguard|secure/i.test(m[1]) ? 'warn' : '']);
      });
    }
    const blocks = items.length ? [{ type: 'cards', items }] : [];
    if (/FLAG_SECURE|secure/i.test(out)) blocks.push({ type: 'note', text: '输出里有 secure 相关字样，再配合「窗口列表」看具体窗口的 flag' });
    return blocks;
  }

  function fmtAgo(ms) {
    if (ms == null) return '-';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒前';
    return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分前';
  }

  function pAnimator(out) {
    const wins = [];
    const perDisp = new Map();
    let disp = '';
    out.split(/\r?\n/).forEach((l) => {
      const dh = /^\s*Display\{#(\d+)/.exec(l);
      if (dh) {
        disp = '#' + dh[1];
        if (!perDisp.has(disp)) perDisp.set(disp, 0);
        return;
      }
      const m = /Window #(\d+): WindowStateAnimator\{[0-9a-f]+ (.+?)\}/.exec(l);
      if (!m) return;
      const d = disp || '?';
      perDisp.set(d, (perDisp.get(d) || 0) + 1);
      wins.push({ disp: d, idx: m[1], name: m[2] });
    });
    if (!wins.length) {
      const items = [];
      const re = /^\s{0,6}(m[A-Za-z]\w*)[=:]\s*(.{1,46})$/gm;
      let m;
      while ((m = re.exec(out)) && items.length < 10) items.push([m[1], m[2].trim()]);
      return items.length ? [{ type: 'cards', items }] : [];
    }
    // 最后一行 mCurrentTime 后面括号里是「距上次动画推进多久」，静态界面会很大
    const tm = /mCurrentTime=(\d+)(?:\s*\((\d+) ms ago\))?/.exec(out);
    const ago = tm && tm[2] ? Number(tm[2]) : null;
    const rows = wins
      .slice(0, 80)
      .map((w) => tr([td(w.disp), td(w.idx), td(w.name)]))
      .join('');
    return [
      {
        type: 'cards',
        items: [
          ['持有动画器的窗口', String(wins.length)],
          ['Display 分布', [...perDisp.entries()].map(([k, v]) => k + ':' + v).join(' ')],
          ['上次动画', fmtAgo(ago), ago != null && ago > 10000 ? 'warn' : ''],
        ],
      },
      { type: 'table', title: '按 Display 列出的窗口', head: ['Display', '#', '窗口'], rows },
      {
        type: 'note',
        text:
          '「持有动画器的窗口」是登记了 WindowStateAnimator 的窗口数，不等于正在播动画；判断动画有没有在跑看「上次动画」，几十秒以上没更新说明界面早已静止，此时若用户还在等转场，就是动画卡住了',
      },
    ];
  }

  function layerKind(n) {
    const s = n.toLowerCase();
    if (s.startsWith('statusbar')) return '状态栏';
    if (s.startsWith('navigationbar')) return '导航栏';
    if (s.includes('wallpaper')) return '壁纸';
    if (s.startsWith('splash screen')) return '启动图';
    if (s.startsWith('background for') || s.startsWith('dim layer')) return '背景/遮罩';
    if (/^\w+(:\w+)*:\d+:\d+#\d+$/.test(n)) return '系统装置';
    if (n.includes('/')) return '应用窗口';
    if (n.includes('#')) return '系统组件';
    return '其它';
  }

  function pSfList(out) {
    const names = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return [];
    const kinds = new Map();
    names.forEach((n) => {
      const k = layerKind(n);
      kinds.set(k, (kinds.get(k) || 0) + 1);
    });
    const items = [['Layer 总数', String(names.length)]];
    kinds.forEach((v, k) => items.push([k, String(v)]));
    const rows = names.slice(0, 200).map((n) => tr([td(n), td(layerKind(n))])).join('');
    return [
      { type: 'cards', items },
      {
        type: 'table',
        title: 'Layer 名单',
        head: ['名称', '分类'],
        rows,
        note: names.length > 200 ? '只列前 200 个' : '截图缺内容时，先在这确认目标 Layer 到底有没有被创建',
      },
    ];
  }

  function pSf(out) {
    const layers = [];
    out.split(/^\+ Layer /m).slice(1).forEach((p) => {
      // 真机格式：+ Layer (WindowedMagnification:0:31#4) uid=1000
      const head = /^\(([^)]+)\)/.exec(p);
      if (!head) return;
      const z = /z=\s*(-?\d+)/.exec(p);
      const size = /size=\(\s*(\d+),\s*(\d+)\)/.exec(p);
      const buf = /activeBuffer=\[\s*(\d+)x\s*(\d+)/.exec(p);
      const w = size ? size[1] : buf ? buf[1] : '';
      const h = size ? size[2] : buf ? buf[2] : '';
      layers.push({ name: head[1], z: z ? Number(z[1]) : 0, size: w ? `${w}×${h}` : '-' });
    });
    if (!layers.length) return [];
    layers.sort((a, b) => a.z - b.z);
    const zs = layers.map((l) => l.z).filter((z) => z > -100000 && z < 100000);
    const rows = layers
      .slice(0, 150)
      .map((l) => tr([td(Math.abs(l.z) > 100000 ? '相对' : String(l.z)), td(l.name), td(l.size)]))
      .join('');
    return [
      {
        type: 'cards',
        items: [
          ['Layer 数', String(layers.length)],
          ['z 范围', zs.length ? `${zs[0]} → ${zs[zs.length - 1]}` : '-'],
          ['相对层级', String(layers.length - zs.length), layers.length - zs.length ? 'warn' : ''],
        ],
      },
      { type: 'table', title: '按 z-order 排序', head: ['z', 'Layer', 'size'], rows, note: 'z 越大越靠上；「相对」表示 zOrderRelativeOf 挂靠别的 Layer' },
    ];
  }

  function pActivities(out) {
    const top = /topResumedActivity=ActivityRecord\{[^}]*? u(\d+) (\S+) t(\d+)/.exec(out);
    const lines = out.split(/\r?\n/);
    const tasks = lines.filter((l) => /^\s*\* Task\{/.test(l));
    const recs = lines.filter((l) => /^\s*\* ActivityRecord\{/.test(l));
    const visTasks = tasks.filter((l) => /visible=true/.test(l)).length;
    const items = [
      ['顶层 Activity', top ? top[2] : '-', top ? 'good' : 'bad'],
      ['所属 Task', top ? '#' + top[3] : '-'],
      ['Task 总数', String(tasks.length)],
      ['可见 Task', String(visTasks)],
      ['Activity 记录', String(recs.length)],
    ];
    const rows = recs
      .slice(0, 60)
      .map((l) => {
        const m = /u(\d+) (\S+) t(\d+)/.exec(l);
        const st = /state=(\w+)/.exec(l);
        return tr([td(m ? m[3] : '-'), td(m ? m[2] : l.trim().slice(0, 56)), td(st ? st[1] : '-')]);
      })
      .join('');
    const blocks = [{ type: 'cards', items }];
    if (rows) blocks.push({ type: 'table', title: 'Activity 记录', head: ['Task', 'Activity', 'state'], rows });
    return blocks;
  }

  function pTop(out) {
    const acts = [];
    out.split(/\r?\n/).forEach((l) => {
      const m = /^\s*ACTIVITY (\S+) (\S+) pid=/.exec(l);
      if (m) acts.push(m[1] + '/' + m[2]);
    });
    const views = [];
    const lines = out.split(/\r?\n/);
    const vi = lines.findIndex((l) => /View Hierarchy:/.test(l));
    if (vi >= 0) {
      const baseIndent = (/^(\s*)/.exec(lines[vi + 1] || '')).length;
      for (let i = vi + 1; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) continue;
        const ind = /^(\s*)/.exec(l)[1].length;
        if (ind < baseIndent) break;
        if (/[\w.$]+\{/.test(l)) views.push(l);
      }
    }
    // dumpsys activity top 第一条不一定是最上面的界面，有焦点信息时以焦点为准
    const focus = (S.layout && S.layout.focus) || '';
    return [
      {
        type: 'cards',
        items: [
          ['当前界面', focus || acts[0] || '-', focus || acts[0] ? 'good' : 'bad'],
          ['本次 dump 的 Activity', String(acts.length)],
          ['View 节点行', String(views.length)],
          ['根 View', views.length ? /([\w.$]+)\{/.exec(views[0])[1].split('.').pop() : '-'],
        ],
      },
      { type: 'note', text: 'View 节点行越多说明嵌套越深；要看具体控件还是用左侧布局树更快' },
    ];
  }

  function pDisplay(out) {
    const phys = /Physical size:\s*(\d+)x(\d+)/.exec(out);
    const over = /Override size:\s*(\d+)x(\d+)/.exec(out);
    const pd = /Physical density:\s*(\d+)/.exec(out);
    const od = /Override density:\s*(\d+)/.exec(out);
    const base = over || phys;
    const w = base ? Number(base[1]) : 0;
    const h = base ? Number(base[2]) : 0;
    const d = od ? Number(od[1]) : pd ? Number(pd[1]) : 0;
    return [
      {
        type: 'cards',
        items: [
          ['物理分辨率', phys ? `${phys[1]}×${phys[2]}` : '-'],
          ['覆盖分辨率', over ? `${over[1]}×${over[2]}` : '（无）', over ? 'warn' : 'muted'],
          ['物理密度', pd ? pd[1] + 'dpi' : '-'],
          ['覆盖密度', od ? od[1] + 'dpi' : '（无）', od ? 'warn' : 'muted'],
          ['屏幕 dp', w && d ? `${Math.round((w * 160) / d)}×${Math.round((h * 160) / d)}` : '-'],
        ],
      },
      { type: 'note', text: '出现 Override 说明分辨率或密度被改过，截图尺寸和布局 bounds 可能对不上，本页换算按 override 值走' },
    ];
  }

  function pRotation(out) {
    const lines = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const setting = /^\d$/.test(lines[0] || '') ? lines[0] : '';
    const deg = { 0: '0°', 1: '90°', 2: '180°', 3: '270°' }[setting] || '-';
    const rot = /(ROTATION_\d+|rotation[ =]\d)/i.exec(out);
    return [
      {
        type: 'cards',
        items: [
          ['user_rotation', setting ? `${setting}（${deg}）` : '（未设置）'],
          ['当前 rotation', rot ? rot[1] : '-'],
          ['说明', 'user_rotation 是强制值，自动旋转开着时不一定等于实际旋转'],
        ],
      },
    ];
  }

  function analyzeProbe(key, out) {
    const map = {
      focus: pFocus,
      windows: pWindows,
      displays: pDisplays,
      policy: pPolicy,
      animator: pAnimator,
      'sf-list': pSfList,
      sf: pSf,
      activities: pActivities,
      top: pTop,
      display: pDisplay,
      rotation: pRotation,
    };
    const fn = map[key];
    let blocks = [];
    try {
      blocks = (fn && fn(out)) || [];
    } catch (_) {
      blocks = [];
    }
    if (!blocks.length) blocks.push({ type: 'note', text: '这台设备的输出格式没解析出结构化字段，直接看下面的原始输出' });
    blocks.push({ type: 'raw', text: out });
    return blocks;
  }

  function blockHtml(b) {
    if (b.type === 'cards') {
      return (
        `<div class="shot-cards">` +
        b.items
          .map(
            (it) =>
              `<div class="shot-card${it[2] ? ' ' + it[2] : ''}"><div class="shot-card-k">${esc(
                it[0]
              )}</div><div class="shot-card-v" title="${esc(it[1])}">${esc(it[1])}</div></div>`
          )
          .join('') +
        `</div>`
      );
    }
    if (b.type === 'table') {
      return (
        `<div class="shot-probe-sec"><div class="shot-probe-sec-title">${esc(b.title || '')}</div>` +
        tblHtml(b.head, b.rows, b.note) +
        `</div>`
      );
    }
    if (b.type === 'note') return `<div class="shot-probe-note">${esc(b.text)}</div>`;
    if (b.type === 'raw') {
      const lines = b.text.split(/\r?\n/).length;
      return `<details class="shot-probe-raw"><summary>原始输出 · ${lines} 行</summary><pre>${esc(b.text)}</pre></details>`;
    }
    return '';
  }

  function probeShell(item) {
    return `<div class="shot-probe-mask" id="shotProbeMask">
      <div class="shot-probe">
        <div class="shot-probe-head">
          <span class="shot-probe-tag">${esc(item.g)}</span>
          <span class="shot-probe-name" id="shotProbeName">${esc(PROBE_TITLE[item.k] || item.cmd)}</span>
          <span class="shot-probe-cmd" id="shotProbeCmd">${esc(item.cmd)}</span>
          <span class="shot-probe-meta" id="shotProbeMeta"></span>
          <button class="btn small" id="shotProbeAgain">重跑</button>
          <button class="btn small ghost" id="shotProbeClose">关闭</button>
        </div>
        <div class="shot-probe-body" id="shotProbeBody"></div>
      </div>
    </div>`;
  }

  function openProbe(item) {
    if (!S.serial) {
      if (typeof window.toast === 'function') window.toast('先连一台设备', true);
      return;
    }
    const host = $('shotPage');
    if (!host) return;
    let mask = $('shotProbeMask');
    if (!mask) {
      host.insertAdjacentHTML('beforeend', probeShell(item));
      mask = $('shotProbeMask');
      const close = $('shotProbeClose');
      if (close) close.addEventListener('click', () => mask.remove());
      mask.addEventListener('click', (e) => {
        if (e.target === mask) mask.remove();
      });
    } else {
      const tag = mask.querySelector('.shot-probe-tag');
      const nm = $('shotProbeName');
      const cm = $('shotProbeCmd');
      if (tag) tag.textContent = item.g;
      if (nm) nm.textContent = PROBE_TITLE[item.k] || item.cmd;
      if (cm) cm.textContent = item.cmd;
    }
    const again = $('shotProbeAgain');
    if (again) again.onclick = () => runProbe(item);
    runProbe(item);
  }

  async function runProbe(item) {
    const body = $('shotProbeBody');
    const meta = $('shotProbeMeta');
    const again = $('shotProbeAgain');
    if (!body) return;
    body.innerHTML = '<div class="shot-probe-loading">正在设备上执行命令…</div>';
    if (meta) meta.textContent = '';
    if (again) again.disabled = true;
    try {
      const r = await apiPost('adb-probe', { serial: S.serial, key: item.k });
      if (meta) meta.textContent = `${r.ms}ms · ${fmtTime(r.at)} · ${r.serial}${r.truncated ? ' · 已截断' : ''}`;
      if (!r.ok && !(r.out || '').trim()) throw new Error(r.err || '命令执行失败');
      body.innerHTML = analyzeProbe(item.k, r.out || '').map(blockHtml).join('');
    } catch (err) {
      body.innerHTML = `<div class="shot-probe-err">${esc(err.message || String(err))}</div>`;
    } finally {
      if (again) again.disabled = false;
    }
  }

  function paintTables() {
    const box = $('shotTables');
    if (!box) return;
    box.classList.toggle('hidden', S.folded);
    if (S.folded) return;
    if (!S.tree.length) {
      box.innerHTML = '<div class="shot-tbl-empty">没有布局数据，表格要等布局抓取成功后才能算</div>';
      return;
    }
    if (!S.flat) S.flat = flatTree();
    const flat = S.flat;
    if (S.tab === 'cls') box.innerHTML = tabCls(flat);
    else if (S.tab === 'click') box.innerHTML = tabClick(flat);
    else if (S.tab === 'issue') box.innerHTML = tabIssue(flat);
    else if (S.tab === 'cmd') box.innerHTML = tabCmd();
    else box.innerHTML = tabOverview(flat);
  }

  /* ---------------- 布局树 ---------------- */

  function matchNode(n) {
    if (S.clickOnly && !n.click) return false;
    const f = (S.filter || '').trim().toLowerCase();
    if (!f) return true;
    return (
      (n.txt && n.txt.toLowerCase().includes(f)) ||
      (n.rid && n.rid.toLowerCase().includes(f)) ||
      (n.cls && n.cls.toLowerCase().includes(f)) ||
      (n.desc && n.desc.toLowerCase().includes(f))
    );
  }

  function buildInclude() {
    S.include = null;
    if (!S.filter.trim() && !S.clickOnly) return;
    const set = new Set();
    const walk = (n, stack) => {
      const st = stack.concat([n]);
      if (matchNode(n)) st.forEach((x) => set.add(x.id));
      n.kids.forEach((k) => walk(k, st));
    };
    S.tree.forEach((n) => walk(n, []));
    S.include = set;
  }

  function visibleRows() {
    const out = [];
    const walk = (n) => {
      if (S.include && !S.include.has(n.id)) return;
      out.push(n);
      if (!S.include && S.collapsed.has(n.id)) return;
      n.kids.forEach(walk);
    };
    S.tree.forEach(walk);
    return out;
  }

  function rowHtml(n) {
    const hasKids = n.kids.length > 0;
    const open = !S.collapsed.has(n.id);
    const caret = hasKids ? (open ? '▾' : '▸') : '·';
    const flags = [
      n.click ? '<span class="shot-flag click">可点</span>' : '',
      n.scroll ? '<span class="shot-flag">可滚</span>' : '',
      n.checkable ? `<span class="shot-flag">${n.checked ? '已选' : '可勾'}</span>` : '',
      n.enabled ? '' : '<span class="shot-flag off">禁用</span>',
    ].join('');
    const text = n.txt ? `<span class="shot-txt">${esc(n.txt)}</span>` : '';
    const rid = n.rid ? `<span class="shot-rid">${esc(shortId(n.rid))}</span>` : '';
    const desc = n.desc && !n.txt ? `<span class="shot-desc">${esc(n.desc)}</span>` : '';
    return (
      `<div class="shot-row${S.sel && S.sel.id === n.id ? ' on' : ''}" data-id="${n.id}" data-depth="${n.depth}" style="padding-left:${6 + (n.depth - 1) * 12}px">` +
      `<span class="shot-caret${hasKids ? '' : ' leaf'}">${caret}</span>` +
      `<span class="shot-cls">${esc(shortCls(n.cls))}</span>` +
      text +
      rid +
      desc +
      flags +
      `</div>`
    );
  }

  function paintTree() {
    const box = $('shotTree');
    if (!box) return;
    if (S.rightError) {
      box.innerHTML = `<div class="shot-tree-empty">布局读取失败：${esc(S.rightError)}</div>`;
      return;
    }
    if (!S.tree.length) {
      box.innerHTML = '<div class="shot-tree-empty">没有布局节点</div>';
      return;
    }
    const rows = visibleRows();
    if (!rows.length) {
      box.innerHTML = '<div class="shot-tree-empty">没有匹配的节点</div>';
      return;
    }
    box.innerHTML = rows.map(rowHtml).join('');
  }

  function findNode(id, list) {
    const arr = list || S.tree;
    for (const n of arr) {
      if (n.id === id) return n;
      const hit = n.kids.length ? findNode(id, n.kids) : null;
      if (hit) return hit;
    }
    return null;
  }

  function expandAncestors(id) {
    const path = [];
    const walk = (n, stack) => {
      if (n.id === id) {
        path.push(...stack);
        return true;
      }
      for (const k of n.kids) if (walk(k, stack.concat([n]))) return true;
      return false;
    };
    for (const n of S.tree) if (walk(n, [])) break;
    path.forEach((p) => S.collapsed.delete(p.id));
  }

  function selectNode(n, opts) {
    S.sel = n || null;
    const box = $('shotTree');
    if (box) {
      box.querySelectorAll('.shot-row.on').forEach((el) => el.classList.remove('on'));
      if (n) {
        const el = box.querySelector(`.shot-row[data-id="${n.id}"]`);
        if (el) {
          el.classList.add('on');
          if (opts && opts.scroll) el.scrollIntoView({ block: 'center' });
        }
      }
    }
    paintOverlay();
    paintDetail(n);
    if (n && opts && opts.reveal) ensureBoxVisible(n);
  }

  function paintDetail(n) {
    const box = $('shotDetail');
    if (!box) return;
    if (!n) {
      box.innerHTML = '<div class="shot-detail-empty">在树上或截图上点一个节点，这里显示它的全部属性</div>';
      return;
    }
    const b = n.b || [0, 0, 0, 0];
    const rows = [
      ['class', n.cls || '-'],
      ['text', n.txt || '-'],
      ['id', n.rid || '-'],
      ['desc', n.desc || '-'],
      ['package', n.pkg || '-'],
      ['bounds', `[${b[0]},${b[1]}][${b[2]},${b[3]}]`],
      ['size', `${Math.max(0, b[2] - b[0])} × ${Math.max(0, b[3] - b[1])}`],
      [
        '状态',
        [
          n.enabled ? 'enabled' : 'disabled',
          n.click ? 'clickable' : '',
          n.longClick ? 'long-clickable' : '',
          n.scroll ? 'scrollable' : '',
          n.checkable ? (n.checked ? 'checked' : 'checkable') : '',
          n.selected ? 'selected' : '',
          n.focused ? 'focused' : '',
          n.password ? 'password' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ],
    ];
    box.innerHTML =
      `<div class="shot-detail-head"><span class="shot-detail-title">${esc(shortCls(n.cls))}</span>` +
      `<span class="shot-detail-depth">第 ${n.depth} 层 · #${n.idx}</span>` +
      `<button class="adb-mini" id="shotCopyBounds" title="复制 bounds">复制 bounds</button>` +
      `<button class="adb-mini" id="shotCopyNode" title="复制这个节点的关键属性">复制节点</button></div>` +
      `<div class="shot-detail-grid">` +
      rows
        .map(
          ([k, v]) =>
            `<div class="shot-detail-k">${esc(k)}</div><div class="shot-detail-v mono" title="${esc(v)}">${esc(v)}</div>`
        )
        .join('') +
      `</div>`;
    const cb = $('shotCopyBounds');
    if (cb)
      cb.addEventListener('click', () => {
        copyText(`[${b[0]},${b[1]}][${b[2]},${b[3]}]`, 'bounds 已复制');
      });
    const cn = $('shotCopyNode');
    if (cn)
      cn.addEventListener('click', () => {
        const s =
          `<${shortCls(n.cls)}` +
          (n.rid ? ` id="${shortId(n.rid)}"` : '') +
          (n.txt ? ` text="${n.txt}"` : '') +
          ` bounds="${b[0]},${b[1]},${b[2]},${b[3]}">`;
        copyText(s, '节点已复制');
      });
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      if (typeof window.toast === 'function') window.toast(okMsg);
    } catch (_) {
      if (typeof window.toast === 'function') window.toast('复制失败，请手动选中', true);
    }
  }

  /* ---------------- scrcpy 投屏 ---------------- */

  function toast(msg, bad) {
    if (typeof window.toast === 'function') window.toast(msg, bad);
  }

  async function paintCast() {
    const btn = $('shotCast');
    if (!btn) return;
    try {
      const st = await apiGet('scrcpy-status', {});
      const mine = (st.ours || []).find((o) => o.serial === S.serial);
      btn.textContent = mine ? '关投屏' : '投屏';
      btn.classList.toggle('primary', !!mine);
      btn.disabled = !st.exists;
      btn.title = st.exists
        ? `scrcpy ${st.version || ''}${st.external && st.external.length ? ' · 另有 ' + st.external.length + ' 个手动开的窗口' : ''} · 点${mine ? '关闭' : '打开'}投屏窗口`
        : '没找到 scrcpy.exe：解压到 D:\\install\\scrcpy-win64-v5.0.1，或设置环境变量 SCRCPY_BIN';
    } catch (_) {}
  }

  async function toggleCast() {
    if (!S.serial) return toast('先连一台设备', true);
    const btn = $('shotCast');
    if (btn) btn.disabled = true;
    try {
      const st = await apiGet('scrcpy-status', {});
      if (!st.exists) return toast('没找到 scrcpy.exe，检查 D:\\install 路径', true);
      const mine = (st.ours || []).find((o) => o.serial === S.serial);
      if (mine) {
        await apiPost('scrcpy-stop', { serial: S.serial });
        toast('投屏窗口已关闭');
      } else {
        await apiPost('scrcpy-start', { serial: S.serial, noAudio: true, title: 'scrcpy · ' + S.serial });
        toast('投屏窗口已拉起（在浏览器外面）');
      }
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      if (btn) btn.disabled = false;
      paintCast();
    }
  }

  /* ---------------- 交互 ---------------- */

  function hitTest(clientX, clientY) {
    if (!S.tree.length || !S.shot) return null;
    const img = $('shotImg');
    const r = img.getBoundingClientRect();
    const k = pxRatio();
    const x = (clientX - r.left) / (S.scale * k || 1);
    const y = (clientY - r.top) / (S.scale * k || 1);
    let best = null;
    const walk = (n) => {
      const b = n.b;
      if (b && b[2] > b[0] && b[3] > b[1] && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) {
        if (!best || n.depth >= best.depth) best = n;
      }
      n.kids.forEach(walk);
    };
    S.tree.forEach(walk);
    return best;
  }

  function bindAll() {
    const back = $('shotBack');
    if (back) back.addEventListener('click', closePage);
    const close = $('shotClose');
    if (close) close.addEventListener('click', closePage);
    const again = $('shotAgain');
    if (again) again.addEventListener('click', () => capture('again'));
    const cast = $('shotCast');
    if (cast) cast.addEventListener('click', toggleCast);

    const save = $('shotSave');
    if (save)
      save.addEventListener('click', () => {
        if (!S.shot) return;
        const a = document.createElement('a');
        a.href = S.shot.url;
        a.download = `shot-${S.shot.serial || 'device'}-${S.shot.width}x${S.shot.height}-${S.shot.id.replace(
          /^shot-|\.png$/g,
          ''
        )}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });

    const dev = $('shotDev');
    if (dev)
      dev.addEventListener('change', () => {
        S.serial = dev.value;
        capture('again');
      });

    const fit = $('shotFit');
    if (fit)
      fit.addEventListener('click', () => {
        applyFit();
        applyScale();
      });
    const one = $('shotOne');
    if (one)
      one.addEventListener('click', () => {
        S.zoom = 'free';
        S.scale = 1;
        applyScale();
      });
    const zin = $('shotZoomIn');
    if (zin)
      zin.addEventListener('click', () => {
        S.zoom = 'free';
        S.scale = Math.min(4, S.scale * 1.25);
        applyScale();
      });
    const zout = $('shotZoomOut');
    if (zout)
      zout.addEventListener('click', () => {
        S.zoom = 'free';
        S.scale = Math.max(0.08, S.scale / 1.25);
        applyScale();
      });

    const boxes = $('shotBoxes');
    if (boxes)
      boxes.addEventListener('change', () => {
        S.boxes = boxes.checked;
        paintOverlay();
      });

    const stage = $('shotStage');
    if (stage) {
      stage.addEventListener('click', (e) => {
        if (!S.tree.length) return;
        if (e.target.closest('.shot-overlay')) return;
        const hit = hitTest(e.clientX, e.clientY);
        if (!hit) return selectNode(null);
        expandAncestors(hit.id);
        paintTree();
        selectNode(hit, { scroll: true });
      });
      stage.addEventListener(
        'wheel',
        (e) => {
          if (!S.shot) return;
          if (!e.ctrlKey) return; // Ctrl+滚轮才缩放，普通滚轮留给滚动
          e.preventDefault();
          S.zoom = 'free';
          S.scale = Math.max(0.08, Math.min(4, S.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
          applyScale();
        },
        { passive: false }
      );
    }

    const tree = $('shotTree');
    if (tree) {
      tree.addEventListener('click', (e) => {
        const row = e.target.closest('.shot-row');
        if (!row) return;
        const id = Number(row.dataset.id);
        const node = findNode(id);
        if (!node) return;
        if (e.target.closest('.shot-caret') && node.kids.length) {
          if (S.collapsed.has(id)) S.collapsed.delete(id);
          else S.collapsed.add(id);
          paintTree();
          return;
        }
        selectNode(node, { reveal: true });
      });
      tree.addEventListener('mouseover', (e) => {
        const row = e.target.closest('.shot-row');
        if (!row) return;
        const node = findNode(Number(row.dataset.id));
        if (!node || (S.hover && S.hover.id === node.id)) return;
        S.hover = node;
        paintOverlay();
      });
      tree.addEventListener('mouseleave', () => {
        if (!S.hover) return;
        S.hover = null;
        paintOverlay();
      });
    }

    const filter = $('shotFilter');
    if (filter) {
      filter.addEventListener('input', () => {
        S.filter = filter.value;
        buildInclude();
        paintTree();
      });
      filter.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const first = $('shotTree').querySelector('.shot-row');
        if (first) {
          const node = findNode(Number(first.dataset.id));
          if (node) selectNode(node, { scroll: true });
        }
      });
    }
    const clickOnly = $('shotClickOnly');
    if (clickOnly)
      clickOnly.addEventListener('change', () => {
        S.clickOnly = clickOnly.checked;
        buildInclude();
        paintTree();
      });

    const tabs = $('shotTabs');
    if (tabs)
      tabs.addEventListener('click', (e) => {
        const t = e.target.closest('.shot-tab');
        if (!t) return;
        S.tab = t.dataset.tab;
        tabs.querySelectorAll('.shot-tab').forEach((el) => el.classList.toggle('on', el === t));
        paintTables();
      });

    const fold = $('shotTableFold');
    if (fold)
      fold.addEventListener('click', () => {
        S.folded = !S.folded;
        fold.textContent = S.folded ? '展开' : '收起';
        paintTables();
      });

    const tables = $('shotTables');
    if (tables)
      tables.addEventListener('click', (e) => {
        const row = e.target.closest('tr.jump');
        if (!row) return;
        if (row.dataset.cmd) {
          const key = row.dataset.key || '';
          if (key) {
            const item = CMDS.find((c) => c.k === key);
            if (item) {
              openProbe(item);
              return;
            }
          }
          copyText(row.dataset.cmd, '命令已复制');
          return;
        }
        const node = findNode(Number(row.dataset.id));
        if (!node) return;
        expandAncestors(node.id);
        paintTree();
        selectNode(node, { scroll: true, reveal: true });
      });

    bindSplit();
  }

  function onKey(e) {
    if (!S.open) return;
    if (e.key === 'Escape') {
      const mask = $('shotProbeMask');
      if (mask) {
        mask.remove();
        return;
      }
      const page = $('shotPage');
      if (page && page.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
        document.activeElement.blur();
        return;
      }
      closePage();
    }
  }

  function bindSplit() {
    const split = $('shotSplit');
    const left = document.querySelector('.shot-left');
    const body = document.querySelector('.shot-body');
    if (!split || !left || !body) return;
    let dragging = false;
    split.addEventListener('pointerdown', (e) => {
      dragging = true;
      split.setPointerCapture(e.pointerId);
      document.body.classList.add('shot-col-resize');
    });
    split.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = body.getBoundingClientRect();
      const w = Math.max(320, Math.min(e.clientX - r.left, r.width - 320));
      left.style.flex = `0 0 ${w}px`;
      applyFit();
    });
    const stop = () => {
      dragging = false;
      document.body.classList.remove('shot-col-resize');
      if (S.zoom === 'fit') applyFit();
    };
    split.addEventListener('pointerup', stop);
    split.addEventListener('pointercancel', stop);
  }

  window.addEventListener('resize', () => {
    if (S.open && S.zoom === 'fit') applyFit();
  });

  /* ---------------- 入口 ---------------- */

  function init() {
    const btn = $('shotBtn');
    if (!btn) return;
    btn.addEventListener('click', openPage);
    // 只绑一次：页面每次打开都重绑会在关闭时叠一堆监听
    document.addEventListener('keydown', onKey);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.gdvShot = { open: openPage, close: closePage };
})();
// prize add by yanliang 20261029-end
