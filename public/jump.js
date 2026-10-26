/**
 * prize add by yanliang 20261026-start
 * 源码跳转（Ctrl+Click 找定义）的前端部分。
 *
 * 取词不依赖高亮结构：用 caretRangeFromPoint 拿到点击处的文本节点，
 * 再向两侧扩到标识符边界，所以 highlight() 一行都不用改。
 * 行定位也不用「行高 × 行号」硬算（自动换行时会错），
 * 而是把「第 N 行的起始字符偏移」映射成 DOM Range，用真实 rect 定位与滚动。
 */
'use strict';

(function () {
  const HISTORY_MAX = 50;
  const jumpState = { token: 0, busy: false };
  const history = [];

  /* ---------------- 取词 ---------------- */

  function symbolAtPoint(x, y) {
    let node = null;
    let off = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) {
        node = p.offsetNode;
        off = p.offset;
      }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) {
        node = r.startContainer;
        off = r.startOffset;
      }
    }
    if (!node || node.nodeType !== 3) return '';
    const text = node.nodeValue || '';
    let s = off;
    let e = off;
    while (s > 0 && /[\w$]/.test(text[s - 1])) s--;
    while (e < text.length && /[\w$]/.test(text[e])) e++;
    const word = text.slice(s, e);
    return /^[A-Za-z_$][\w$]*$/.test(word) ? word : '';
  }

  /* ---------------- 行 → DOM 位置 ---------------- */

  // 第 line 行（1 起）在代码文本里的字符偏移
  function lineOffsetOf(codeEl, line) {
    const text = codeEl.textContent || '';
    let off = 0;
    for (let n = 1; n < line; n++) {
      const i = text.indexOf('\n', off);
      if (i < 0) return -1;
      off = i + 1;
    }
    return off;
  }

  // 把字符偏移映射回具体的文本节点，Range 才能用
  function pointOfOffset(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let acc = 0;
    let node = walker.nextNode();
    while (node) {
      const len = (node.nodeValue || '').length;
      if (acc + len > offset) return { node, off: offset - acc };
      acc += len;
      node = walker.nextNode();
    }
    return null;
  }

  function rangeAt(codeEl, line) {
    const off = lineOffsetOf(codeEl, line);
    if (off < 0) return null;
    const p = pointOfOffset(codeEl, off);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.node, p.off);
    r.setEnd(p.node, Math.min(p.off + 1, (p.node.nodeValue || '').length));
    return { range: r, rect: r.getBoundingClientRect() };
  }

  function codeElOf() {
    const body = document.querySelector('#diffPaneBody');
    return body ? { body, code: body.querySelector('.fv-code') } : { body: null, code: null };
  }

  function scrollToLine(line) {
    const { body, code } = codeElOf();
    if (!body || !code) return false;
    const hit = rangeAt(code, line);
    if (!hit) return false;
    const brect = body.getBoundingClientRect();
    const y = hit.rect.top - brect.top + body.scrollTop;
    body.scrollTop = Math.max(0, y - Math.min(240, body.clientHeight * 0.3));
    markLine(code, line);
    return true;
  }

  // 高亮条：绝对定位的一层，不动 pre 的结构（pre 里没法给单行加背景）
  function markLine(code, line) {
    const view = code.closest('.file-view');
    if (!view) return;
    const hit = rangeAt(code, line);
    if (!hit) return;
    const vrect = view.getBoundingClientRect();
    const lh = lineHeightOf(code);
    let bar = view.querySelector('.jump-hl');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'jump-hl';
      // 插在代码前：行号列是 sticky + z-index 1，不会被盖住
      view.insertBefore(bar, view.firstChild);
    }
    bar.style.top = Math.max(0, hit.rect.top - vrect.top) + 'px';
    bar.style.height = (hit.rect.height || lh) + 'px';
    bar.classList.remove('on');
    void bar.offsetWidth;
    bar.classList.add('on');
    clearTimeout(markLine.timer);
    markLine.timer = setTimeout(() => bar.classList.remove('on'), 1600);
  }

  /* ---------------- 打开文件 ---------------- */

  function waitFor(fn, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const v = fn();
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  async function openFile(path) {
    if (state.editing && state.editPath !== path && !confirmLeaveEdit()) return false;
    await jumpToBrowseFile(path);
    return !!(await waitFor(() => (state.browseSel === path ? codeElOf().code : null), 4000));
  }

  async function openAt(path, line) {
    // 同一个文件直接滚，免得整篇重渲染闪一下
    if (state.browseSel === path && !state.editing) {
      await new Promise((r) => requestAnimationFrame(r));
      if (scrollToLine(line)) return true;
    }
    if (!(await openFile(path))) return false;
    // 等两帧，让 pre 的排版（字体、折行）稳定后再算 rect，否则会偏
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return scrollToLine(line);
  }

  /* ---------------- 返回栈 ---------------- */

  // 记录「跳走之前」的位置：路径 + 滚动量，回去时连滚动一起还原
  function remember() {
    const path = state.browseSel;
    if (!path) return; // 还没选文件，记了也回不去
    const { body } = codeElOf();
    history.push({ path, scrollTop: body ? body.scrollTop : 0 });
    if (history.length > HISTORY_MAX) history.shift();
    syncBackBtn();
  }

  async function goBack() {
    const h = history.pop();
    if (!h || !h.path) return false;
    syncBackBtn();
    if (!(await openFile(h.path))) return false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const { body } = codeElOf();
    if (body) body.scrollTop = h.scrollTop || 0;
    return true;
  }

  /* ---------------- 返回按钮 ---------------- */

  // 按钮是详情头里渲染的，历史变了就得同步一次禁用态和提示文案
  function syncBackBtn() {
    const btn = document.getElementById('jumpBackBtn');
    if (!btn) return;
    const top = history[history.length - 1];
    btn.disabled = !top;
    btn.title = top
      ? `返回 ${top.path}${history.length > 1 ? `（还能再退 ${history.length - 1} 层）` : ''} · 快捷键 Alt+←`
      : '还没有跳转记录：在代码里 Ctrl+Click 类名或方法名';
    if (top) btn.dataset.target = top.path;
    else delete btn.dataset.target;
  }

  // 头部会被整块重建（换文件、切版本），重建后按钮回到 disabled，补一次同步
  function watchBackBtn() {
    const pane = document.getElementById('diffPane');
    if (!pane || typeof MutationObserver !== 'function') return;
    let queued = 0;
    const mo = new MutationObserver(() => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        syncBackBtn();
      });
    });
    mo.observe(pane, { childList: true, subtree: true });
  }

  /* ---------------- 候选浮层 ---------------- */

  const KIND_LABEL = { type: '类型', method: '方法', field: '字段' };

  function hideChoices() {
    const el = document.getElementById('jumpList');
    if (el) el.remove();
  }

  function showChoices(items, x, y) {
    hideChoices();
    const el = document.createElement('div');
    el.className = 'jump-list';
    el.id = 'jumpList';
    el.innerHTML = items
      .map(
        (it, i) =>
          `<button class="jump-item" data-i="${i}">
            <span class="jump-kind">${esc(KIND_LABEL[it.kind] || '定义')}</span>
            <span class="jump-path" title="${esc(it.path)}">${esc(it.path)}</span>
            <span class="jump-line">:${it.line}</span>
            <span class="jump-tag">${esc(it.label || '')}</span>
          </button>`
      )
      .join('');
    document.body.appendChild(el);

    // 贴在鼠标右下，超出视口就翻到上/左侧
    const r = el.getBoundingClientRect();
    const left = Math.min(x + 6, window.innerWidth - r.width - 12);
    const top = y + 10 + r.height > window.innerHeight ? Math.max(8, y - r.height - 10) : y + 10;
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.max(8, top) + 'px';

    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-i]');
      if (!b) return;
      ev.preventDefault();
      ev.stopPropagation();
      const it = items[Number(b.dataset.i)];
      hideChoices();
      // 从候选里点进去也要记历史，否则这条路照样回不去
      if (it) {
        remember();
        openAt(it.path, it.line);
      }
    });
  }

  /* ---------------- 发起跳转 ---------------- */

  async function jumpTo(sym, x, y) {
    const token = ++jumpState.token;
    const path = state.browseSel;
    if (!path) return;

    let data;
    try {
      data = await postApi('jump', { path, rev: browseFileRev(), sym });
    } catch (err) {
      toast('跳转失败：' + err.message, true);
      return;
    }
    if (token !== jumpState.token) return;

    if (data.state === 'unsupported') {
      toast('跳转目前只支持 Java / Kotlin 文件', true);
      return;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      toast(`没找到 ${sym} 的定义（可能来自依赖库或未跟踪的文件）`, true);
      return;
    }
    if (items.length === 1) {
      remember();
      openAt(items[0].path, items[0].line);
      return;
    }
    // 多个同名定义：让用户选，总比猜错强
    showChoices(items, x, y);
  }

  /* ---------------- 事件 ---------------- */

  function onClick(ev) {
    // 候选浮层以外的点击先收起浮层
    if (!ev.target.closest('#jumpList')) hideChoices();

    // 详情头的「返回」按钮：不用按快捷键也能退
    const backBtn = ev.target.closest && ev.target.closest('#jumpBackBtn');
    if (backBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!backBtn.disabled && history.length) goBack();
      return;
    }

    if (!(ev.ctrlKey || ev.metaKey)) return;
    // Ctrl+Alt+点击 是「查找引用」，交给 refs.js；这里必须让路，
    // 否则会同时触发正向跳转，跳到定义后面板又被当成「换了文件」关掉
    if (ev.altKey) return;
    const code = ev.target.closest && ev.target.closest('.fv-code');
    if (!code) return;
    const sym = symbolAtPoint(ev.clientX, ev.clientY);
    if (!sym) return;
    ev.preventDefault();
    ev.stopPropagation();
    jumpTo(sym, ev.clientX, ev.clientY);
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') {
      hideChoices();
      return;
    }
    // Alt+← 退回上一个位置（无论有没有历史都拦下，别让浏览器把整页后退掉）
    if (ev.altKey && ev.key === 'ArrowLeft') {
      ev.preventDefault();
      if (history.length) goBack();
      return;
    }
    // 按住 Ctrl 时把光标改成手型，提示这里可以点
    if (ev.key === 'Control' || ev.key === 'Meta') document.body.classList.add('jump-ready');
  }

  function onKeyUp(ev) {
    if (ev.key === 'Control' || ev.key === 'Meta') document.body.classList.remove('jump-ready');
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => document.body.classList.remove('jump-ready'));

  // #diffPane 可能是 app.js 后面才渲染出来的，等它出现再挂观察器
  (function initBackBtn() {
    const pane = document.getElementById('diffPane');
    if (!pane) {
      setTimeout(initBackBtn, 300);
      return;
    }
    watchBackBtn();
    syncBackBtn();
  })();

  // 给别的模块留几个入口（mode=source 的提示条、查找引用、自测脚本要用）
  window.gdvJump = { openAt, goBack, history, symbolAtPoint, syncBackBtn, remember, jumpTo };
})();
// prize add by yanliang 20261026-end
