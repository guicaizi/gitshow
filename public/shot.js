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
      S.sel = null;
      S.hover = null;
      paintShot();
      paintInfo();
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
      paintShot();
      paintInfo();
      paintTree();
      paintDetail(null);
      paintSub();
      paintPlaceholder(S.error, true);
    } finally {
      S.loading = false;
      const btn = $('shotAgain');
      if (btn) btn.disabled = false;
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

    bindSplit();
  }

  function onKey(e) {
    if (!S.open) return;
    if (e.key === 'Escape') {
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
