/**
 * prize add by yanliang 20261027-start
 * 「查找引用」（谁在用它）的前端部分。
 *
 * 入口两个：代码上右键出菜单；或 Ctrl+Alt+Click 直接查。
 * 结果分两档：先显示当前模块内的命中（几秒），后台全库扫完再补一档，用 tab 切换。
 * 取词、行定位、返回栈全部复用 jump.js，所以这里只管「问」和「展示」。
 */
'use strict';

(function () {
  const PANEL_ID = 'refsPanel';
  const MENU_ID = 'refsMenu';
  const POLL_MS = 1800;
  const POLL_MAX = 120; // 全库 15 万文件约 2 分钟，留够余量

  const refsState = {
    token: 0,
    timer: 0,
    polls: 0,
    data: null,
    tab: 'local',
    path: '',
    rev: '',
    sym: '',
  };

  const KIND_LABEL = { import: 'import', 'same-package': '同包', name: '名字', comment: '注释' };

  function symbolAtPoint(x, y) {
    return window.gdvJump && window.gdvJump.symbolAtPoint ? window.gdvJump.symbolAtPoint(x, y) : '';
  }

  function revNow() {
    return typeof browseFileRev === 'function' ? browseFileRev() : '';
  }

  /* ---------------- 右键菜单 ---------------- */

  function hideMenu() {
    const el = document.getElementById(MENU_ID);
    if (el) el.remove();
  }

  function showMenu(sym, x, y) {
    hideMenu();
    const el = document.createElement('div');
    el.className = 'refs-menu';
    el.id = MENU_ID;
    el.innerHTML = `
      <div class="refs-menu-sym">${esc(sym)}</div>
      <button class="refs-menu-item" data-act="refs"><span class="refs-menu-key">Ctrl+Alt+点击</span>查找引用</button>
      <button class="refs-menu-item" data-act="def"><span class="refs-menu-key">Ctrl+点击</span>跳转到定义</button>
      <button class="refs-menu-item" data-act="copy"><span class="refs-menu-key"></span>复制符号名</button>`;
    document.body.appendChild(el);

    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 12)) + 'px';
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 12)) + 'px';

    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      ev.preventDefault();
      ev.stopPropagation();
      const act = b.dataset.act;
      hideMenu();
      if (act === 'refs') askRefs(sym);
      else if (act === 'def') askDef(sym, x, y);
      else if (act === 'copy') copySym(sym);
    });
  }

  async function copySym(sym) {
    try {
      await navigator.clipboard.writeText(sym);
      toast(`已复制 ${sym}`);
    } catch (_) {
      toast('复制失败，浏览器不允许写剪贴板', true);
    }
  }

  // 右键菜单里的「跳转到定义」直接复用 jump.js 的逻辑：用一次合成点击最省事
  function askDef(sym, x, y) {
    if (window.gdvJump && window.gdvJump.jumpTo) {
      window.gdvJump.jumpTo(sym, x, y);
      return;
    }
    const code = document.querySelector('.fv-code');
    const target = document.elementFromPoint(x, y) || code;
    if (target) {
      target.dispatchEvent(
        new MouseEvent('click', { clientX: x, clientY: y, ctrlKey: true, bubbles: true, cancelable: true })
      );
    }
  }

  /* ---------------- 面板 ---------------- */

  function closePanel() {
    clearTimeout(refsState.timer);
    refsState.timer = 0;
    const el = document.getElementById(PANEL_ID);
    if (el) el.remove();
  }

  function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.className = 'refs-panel';
    el.id = PANEL_ID;
    document.body.appendChild(el);
    el.addEventListener('click', onPanelClick);
    return el;
  }

  function headHtml(d) {
    const scopeName = d.scope || '全仓库';
    const localN = d.total || 0;
    const full = d.full || {};
    const fullTag =
      full.state === 'done'
        ? `<span class="refs-num">${full.total}</span>`
        : full.state === 'building'
          ? '<span class="refs-spin"></span>'
          : '';
    return `
      <div class="refs-head">
        <span class="refs-title"><b>${esc(d.sym)}</b><em>被引用</em></span>
        <button class="refs-x" id="refsClose" title="关闭（Esc）">×</button>
      </div>
      <div class="refs-tabs">
        <button class="refs-tab${refsState.tab === 'local' ? ' on' : ''}" data-tab="local"
          title="扫当前包目录的父级，含所有子包；大仓库通常几秒">
          本包 <span class="refs-num">${localN}</span>
        </button>
        <button class="refs-tab${refsState.tab === 'all' ? ' on' : ''}" data-tab="all" title="扫全仓库，大仓库约 1~2 分钟">
          全仓库 ${fullTag}
        </button>
        <span class="refs-scope-name" title="${esc(scopeName)}">${esc(shortScope(scopeName))}</span>
      </div>`;
  }

  // 结果里显示相对「本包范围」的短路径：ALPS 的绝对路径有 80 多个字符，
  // 全贴出来只会被 CSS 截成「…ices/core/java/...」，看不出是哪个文件
  function shortPath(p, scope) {
    if (scope && scope !== '全仓库' && p.startsWith(scope + '/')) return p.slice(scope.length + 1);
    return p;
  }

  function shortScope(s) {
    const parts = String(s || '').split('/').filter(Boolean);
    if (parts.length <= 2) return s;
    return '…/' + parts.slice(-2).join('/');
  }

  function itemHtml(it, scope) {
    const cls = it.certainty === 'low' ? ' low' : it.kind === 'import' || it.kind === 'same-package' ? ' high' : '';
    const shown = shortPath(it.path, scope);
    return `<button class="refs-item${cls}" data-path="${esc(it.path)}" data-line="${it.line}" title="${esc(
      it.path
    )}:${it.line}">
      <span class="refs-kind ${esc(it.kind)}">${esc(KIND_LABEL[it.kind] || it.kind)}</span>
      <span class="refs-loc"><span class="refs-path">${esc(shown)}</span><span class="refs-ln">:${it.line}</span></span>
      <span class="refs-code">${esc(it.text || '')}</span>
    </button>`;
  }

  function bodyHtml(d) {
    const all = refsState.tab === 'all';
    const pack = all ? d.full || {} : d;
    if (all && pack.state === 'building') {
      return `<div class="refs-empty">
        <span class="refs-spin big"></span>
        正在扫描全仓库（大仓库约 1~2 分钟），可以先看「本包」那一档
      </div>`;
    }
    if (all && (pack.state === 'lazy' || pack.state === 'idle')) {
      return `<div class="refs-empty">点上面的「全仓库」开始扫描，会扫遍所有模块，大仓库需要一两分钟</div>`;
    }
    const items = pack.items || [];
    if (!items.length) {
      return `<div class="refs-empty">${
        all ? '全仓库里没有找到引用' : '本包范围内没有找到引用，试试「全仓库」那一档'
      }</div>`;
    }
    const list = items.map((it) => itemHtml(it, d.scope)).join('');
    const shown = items.length;
    const more = pack.truncated
      ? `<div class="refs-more">${pack.files || 0} 个文件 · ${pack.occurrences || pack.total} 处引用${
          shown < (pack.total || 0) ? `，列出前 ${shown} 条` : '，每个文件最多列 2 条'
        }</div>`
      : '';
    return list + more;
  }

  function render() {
    const d = refsState.data;
    if (!d) return;
    const el = ensurePanel();
    el.innerHTML = headHtml(d) + `<div class="refs-body">${bodyHtml(d)}</div>`;
  }

  function showLoading(sym, path) {
    refsState.data = null;
    const el = ensurePanel();
    el.innerHTML = `
      <div class="refs-head">
        <span class="refs-title"><b>${esc(sym)}</b><em>被引用</em></span>
        <button class="refs-x" id="refsClose" title="关闭（Esc）">×</button>
      </div>
      <div class="refs-body"><div class="refs-empty"><span class="refs-spin big"></span>正在扫描 ${esc(
        scopeOfPath(path)
      )} …</div></div>`;
  }

  function scopeOfPath(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    if (parts.length >= 3) return parts.slice(0, 2).join('/');
    if (parts.length === 2) return parts[0];
    return '全仓库';
  }

  function onPanelClick(ev) {
    const t = ev.target;
    if (t.closest && t.closest('#refsClose')) {
      ev.preventDefault();
      closePanel();
      return;
    }
    const tab = t.closest && t.closest('[data-tab]');
    if (tab) {
      ev.preventDefault();
      const want = tab.dataset.tab;
      // 切到「全仓库」且还没扫过：先就地显示扫描中，再发一次只要全库的请求
      if (want === 'all' && refsState.data && refsState.data.full) {
        const st = refsState.data.full.state;
        if (st === 'lazy' || st === 'idle') {
          refsState.data.full = { state: 'building' };
          refsState.tab = 'all';
          render();
          startFullScan();
          return;
        }
      }
      refsState.tab = want;
      render();
      return;
    }
    const item = t.closest && t.closest('.refs-item');
    if (item) {
      ev.preventDefault();
      const p = item.dataset.path;
      const ln = Number(item.dataset.line) || 1;
      // 从结果里跳走是「顺着看」，面板得留着；把 lastPath 同步成目标，
      // 免得下面那个 setInterval 把它当成「换了文件」直接关掉
      lastPath = p;
      if (window.gdvJump) {
        window.gdvJump.history && window.gdvJump.remember && window.gdvJump.remember();
        window.gdvJump.openAt(p, ln);
      }
    }
  }

  /* ---------------- 主流程 ---------------- */

  async function askRefs(sym) {
    const path = state.browseSel;
    if (!path) {
      toast('先在左侧选一个文件', true);
      return;
    }
    if (!/\.(java|kts?)$/i.test(path)) {
      toast('查找引用目前只支持 Java / Kotlin 文件', true);
      return;
    }
    hideMenu();
    const token = ++refsState.token;
    refsState.polls = 0;
    refsState.tab = 'local';
    showLoading(sym, path);

    const rev = revNow();
    refsState.path = path;
    refsState.rev = rev;
    refsState.sym = sym;

    let data;
    try {
      data = await postApi('refs', { path, rev, sym });
    } catch (err) {
      if (token === refsState.token) closePanel();
      toast('查找引用失败：' + err.message, true);
      return;
    }
    if (token !== refsState.token) return;

    if (data.state === 'unsupported') {
      closePanel();
      toast('查找引用目前只支持 Java / Kotlin 文件', true);
      return;
    }
    refsState.data = data;
    render();

    if (data.full && data.full.state === 'building') pollFull(token);
  }

  function pollFull(token) {
    clearTimeout(refsState.timer);
    refsState.timer = setTimeout(async () => {
      if (token !== refsState.token) return;
      refsState.polls++;
      let d;
      try {
        d = await postApi('refs', {
          path: refsState.path,
          rev: refsState.rev,
          sym: refsState.sym,
          pollOnly: 1,
        });
      } catch (_) {
        // 网络抖动不算失败，继续轮；确实停了就靠 POLL_MAX 兜底
        d = null;
      }
      if (token !== refsState.token) return;
      if (d && d.full && d.full.state === 'done') {
        refsState.data.full = d.full;
        render();
        return;
      }
      if (refsState.polls >= POLL_MAX) {
        if (refsState.data) refsState.data.full = { state: 'idle' };
        render();
        return;
      }
      pollFull(token);
    }, POLL_MS);
  }

  // 「全仓库」那一档是按需启动的：onlyFull 让服务端跳过局部重扫，只推进全库任务
  async function startFullScan() {
    const token = refsState.token;
    refsState.polls = 0;
    let d;
    try {
      d = await postApi('refs', {
        path: refsState.path,
        rev: refsState.rev,
        sym: refsState.sym,
        wantFull: 1,
        onlyFull: 1,
      });
    } catch (err) {
      if (token === refsState.token) toast('启动全库扫描失败：' + err.message, true);
      return;
    }
    if (token !== refsState.token || !refsState.data) return;
    if (d.full && d.full.state === 'done') {
      refsState.data.full = d.full;
      render();
      return;
    }
    pollFull(token);
  }

  /* ---------------- 事件 ---------------- */

  document.addEventListener(
    'contextmenu',
    (ev) => {
      const code = ev.target.closest && ev.target.closest('.fv-code');
      if (!code) {
        hideMenu();
        return;
      }
      const sym = symbolAtPoint(ev.clientX, ev.clientY);
      if (!sym) return; // 空白处让浏览器出自己的菜单
      ev.preventDefault();
      ev.stopPropagation();
      showMenu(sym, ev.clientX, ev.clientY);
    },
    true
  );

  document.addEventListener(
    'click',
    (ev) => {
      if (!ev.target.closest || !ev.target.closest('#' + MENU_ID)) hideMenu();

      // Ctrl+Alt+Click：反向查引用（正向仍是 Ctrl+Click，两者不冲突）
      if (!(ev.ctrlKey && ev.altKey)) return;
      const code = ev.target.closest && ev.target.closest('.fv-code');
      if (!code) return;
      const sym = symbolAtPoint(ev.clientX, ev.clientY);
      if (!sym) return;
      ev.preventDefault();
      ev.stopPropagation();
      askRefs(sym);
    },
    true
  );

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      hideMenu();
      closePanel();
    }
  });

  // 换文件 / 换版本后旧结果没有意义，直接收掉，免得看着像当前文件的引用
  let lastPath = '';
  setInterval(() => {
    const p = state.browseSel || '';
    if (p !== lastPath) {
      lastPath = p;
      if (document.getElementById(PANEL_ID)) closePanel();
    }
  }, 400);

  window.gdvRefs = { askRefs, closePanel };
})();
// prize add by yanliang 20261027-end
