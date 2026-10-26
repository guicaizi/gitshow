/**
 * prize add by yanliang 20261026-start
 * 「问 AI」：把当前文件 / 选中代码的上下文拼成一段请求，复制到剪贴板，
 * 再打开 DeepSeek Harness 的 web 窗口（地址可配置），由用户粘贴发送。
 *
 * 为什么是"复制 + 跳转"而不是"点一下直接问"：
 * Harness 的 web 前端只从 URL 里读 sessionId / path / name 等参数，
 * 没有任何 prompt 预填通道；要程序化建会话 + 发消息就得逆向它的私有
 * HTTP 接口和私有会话存储，它一升级就废。所以这里只依赖它稳定存在的
 * 东西：一个带 token 的网址 + 一个能粘贴的输入框。
 */
'use strict';

(function () {
  const URL_KEY = 'gdv.aiUrl';
  // prize add by yanliang for 问 AI：没填地址时退化为「只复制不跳转」模式, 20261026-start
  const MODE_KEY = 'gdv.aiMode'; // 'url' 复制并跳转 / 'copy' 只复制，切窗口自己粘贴
  // prize add by yanliang for 问 AI：没填地址时退化为「只复制不跳转」模式, 20261026-end
  const BTN_ID = 'aiAskBtn';
  const SETUP_ID = 'aiSetup';
  const SELECT_MAX_LINES = 400; // 选中超过这么多行就截断，别把输入框撑爆
  const WHOLE_FILE_MAX_LINES = 300; // 没选中时，文件小于这么多行才附全文

  const LANG = {
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    xml: 'xml',
    bp: 'bp',
    gradle: 'groovy',
    md: 'markdown',
    json: 'json',
    js: 'javascript',
    ts: 'typescript',
    css: 'css',
    html: 'html',
    sh: 'bash',
    py: 'python',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    hpp: 'cpp',
  };

  function langOf(path) {
    const m = /\.([a-z0-9]+)$/i.exec(path || '');
    return (m && LANG[m[1].toLowerCase()]) || '';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------- 取上下文 ---------------- */

  function lineOfOffset(text, off) {
    let n = 1;
    const end = Math.min(off, text.length);
    for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }

  // 预览态：从 DOM 选区反推字符偏移，再换算成行号
  function selectionInCode(codeEl) {
    if (!codeEl) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!codeEl.contains(range.startContainer) || !codeEl.contains(range.endContainer)) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    const all = codeEl.textContent || '';
    const probe = document.createRange();
    probe.selectNodeContents(codeEl);
    probe.setEnd(range.startContainer, range.startOffset);
    const start = probe.toString().length;
    return { text, from: lineOfOffset(all, start), to: lineOfOffset(all, start + text.length), lines: lineOfOffset(all, all.length) };
  }

  // 编辑态：textarea 自带 selectionStart，直接切
  function selectionInEditor(ta) {
    if (!ta || ta.selectionStart === ta.selectionEnd) return null;
    const text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (!text.trim()) return null;
    return {
      text,
      from: lineOfOffset(ta.value, ta.selectionStart),
      to: lineOfOffset(ta.value, ta.selectionEnd),
      lines: lineOfOffset(ta.value, ta.value.length),
    };
  }

  function revLabel(editing) {
    const d = state.detail;
    if (d && d.kind === 'commit') return '提交 ' + String(d.hash || '').slice(0, 10);
    if (d && d.kind === 'compare') return '比对 ' + String(d.head || '').slice(0, 10);
    return editing ? '工作区（正在编辑，可能有未保存的改动）' : '工作区';
  }

  function currentContext() {
    const path = state.browseSel;
    if (!path) return null;
    const ta = document.getElementById('edContent');
    const editing = !!(ta && state.editing);
    const codeEl = document.querySelector('#diffPaneBody .fv-code');
    const sel = editing ? selectionInEditor(ta) : selectionInCode(codeEl);
    const whole = editing ? ta.value : codeEl ? codeEl.textContent || '' : '';
    return {
      path,
      repo: state.repo || '',
      rev: revLabel(editing),
      editing,
      sel,
      whole,
      totalLines: lineOfOffset(whole, whole.length),
      lang: langOf(path),
    };
  }

  /* ---------------- 拼 prompt ---------------- */

  function truncateLines(text, max) {
    const arr = text.split('\n');
    if (arr.length <= max) return { text, cut: 0 };
    return { text: arr.slice(0, max).join('\n'), cut: arr.length - max };
  }

  function buildPrompt(ctx) {
    const head = ['仓库：' + (ctx.repo || '（未知）'), '文件：' + ctx.path, '版本：' + ctx.rev];
    const lang = ctx.lang;

    if (ctx.sel) {
      const { text, cut } = truncateLines(ctx.sel.text, SELECT_MAX_LINES);
      return [
        '请解释下面这段代码。',
        '',
        ...head,
        `范围：第 ${ctx.sel.from}–${ctx.sel.to} 行（文件共 ${ctx.totalLines} 行）`,
        '',
        '```' + lang,
        text,
        '```',
        cut ? `\n（上面省略了选区末尾 ${cut} 行，需要的话我可以再贴）` : '',
        '',
        '请说明：',
        '1. 这段代码要解决什么问题、在整体里处于什么位置；',
        '2. 关键流程、状态变化和主要调用关系；',
        '3. 容易被误读、或者改动时容易踩坑的地方。',
        '',
        '需要看其它文件时，可以直接读上面仓库路径里的文件；读不到就告诉我，我把代码贴过来。',
      ]
        .filter((line) => line !== '')
        .join('\n');
    }

    const small = ctx.totalLines <= WHOLE_FILE_MAX_LINES;
    if (small) {
      return [
        '请解释这个文件。',
        '',
        ...head,
        `共 ${ctx.totalLines} 行。`,
        '',
        '```' + lang,
        ctx.whole,
        '```',
        '',
        '请说明：整体职责、主要方法与调用关系、关键数据结构，以及容易被误读或改动时容易踩坑的地方。',
      ].join('\n');
    }

    return [
      '请解释这个文件。',
      '',
      ...head,
      `共 ${ctx.totalLines} 行，文件较大没有贴全文。`,
      '',
      '请读上面路径里的这个文件，然后说明：整体职责、主要方法与调用关系、关键数据结构，以及容易被误读或改动时容易踩坑的地方。',
      '如果读不到，告诉我，我按需贴片段给你。',
    ].join('\n');
  }

  /* ---------------- 复制 / 打开 ---------------- */

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      /* 落到下面的老办法 */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  function openHarness(url) {
    // 固定窗口名：第二次点复用同一个标签并聚焦，而不是叠一堆窗口
    const w = window.open(url, 'gdv-dsh-ai');
    if (w) {
      try {
        w.focus();
      } catch (err) {
        /* 跨域时 focus 可能被拒，忽略 */
      }
    }
    return !!w;
  }

  /* ---------------- 复制失败的手动兜底 ---------------- */

  // 局域网 http 访问、或者浏览器禁用剪贴板时，自动复制会失败。
  // 与其让用户去代码里重新选一遍，不如把拼好的内容摆出来，全选好等他按 Ctrl+C。
  function showCopyFallback(text) {
    const old = document.getElementById('aiFallback');
    if (old) old.remove();
    const box = document.createElement('div');
    box.className = 'ai-setup ai-fallback';
    box.id = 'aiFallback';

    const title = document.createElement('div');
    title.className = 'ai-setup-title';
    title.textContent = '浏览器不让自动复制，请手动复制';

    const tip = document.createElement('p');
    tip.className = 'ai-setup-tip';
    tip.innerHTML = '内容已经全选，按 <code>Ctrl+C</code>（macOS 用 <code>Cmd+C</code>）复制，再到 AI 窗口粘贴。';

    const area = document.createElement('textarea');
    area.className = 'ai-fallback-text';
    area.readOnly = true;
    area.spellcheck = false;
    area.value = text;

    const ops = document.createElement('div');
    ops.className = 'ai-setup-ops';
    const close = document.createElement('button');
    close.className = 'btn ghost small';
    close.id = 'aiFallbackClose';
    close.textContent = '关闭';
    ops.appendChild(close);

    box.append(title, tip, area, ops);
    document.body.appendChild(box);
    area.focus();
    area.select();
  }

  function closeFallback() {
    const el = document.getElementById('aiFallback');
    if (el) el.remove();
  }

  /* ---------------- 配置面板 ---------------- */

  function closeSetup() {
    const el = document.getElementById(SETUP_ID);
    if (el) el.remove();
  }

  function openSetup(pending) {
    closeSetup();
    const btn = document.getElementById(BTN_ID);
    const box = document.createElement('div');
    box.className = 'ai-setup';
    box.id = SETUP_ID;
    box.innerHTML = `
      <div class="ai-setup-title">先填一下 Harness 地址</div>
      <input class="ai-setup-input" id="aiUrlInput" type="text" spellcheck="false"
        placeholder="http://127.0.0.1:54486/?token=..." value="${esc(localStorage.getItem(URL_KEY) || '')}" />
      <p class="ai-setup-tip">地址必须是<b>带 <code>?token=</code> 的那一整条</b>：终端跑 <code>dsh web</code> 会打印并打开它，或从已打开的 Harness 网页地址栏直接复制。只剩 <code>127.0.0.1:54486/</code> 会报 401。</p>
      <p class="ai-setup-tip">没拿到地址也行：点下面「只复制不跳转」，之后每次点击只把上下文放进剪贴板，你切到 Harness 窗口 <code>Ctrl+V</code> 发送。</p>
      <div class="ai-setup-ops">
        <button class="btn primary small" id="aiUrlSave">保存并继续</button>
        <button class="btn ghost small" id="aiUrlCopyOnly">只复制不跳转</button>
        <button class="btn ghost small" id="aiUrlClear">清除</button>
      </div>
      <p class="ai-setup-tip" style="margin:9px 0 0">想改回跳转模式：按住 <code>Shift</code> 点「问 AI」重新打开本面板。</p>`;
    document.body.appendChild(box);

    // 贴着按钮放，超出视口就收回来
    const r = btn ? btn.getBoundingClientRect() : { left: window.innerWidth / 2, top: 120, right: 0, bottom: 0 };
    const w = box.offsetWidth || 320;
    const h = box.offsetHeight || 150;
    let left = Math.min(r.right - w, window.innerWidth - w - 16);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    box.style.left = Math.max(12, left) + 'px';
    box.style.top = Math.max(12, top) + 'px';

    const input = document.getElementById('aiUrlInput');
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          saveUrl();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          closeSetup();
        }
      });
    }
    // 占位回调留给"保存后继续本次提问"
    openSetup.pending = pending || null;
  }

  async function saveUrl() {
    const input = document.getElementById('aiUrlInput');
    if (!input) return;
    const url = input.value.trim();
    // prize add by yanliang for 问 AI：地址留空即进入「只复制不跳转」模式, 20261026-start
    if (!url) {
      localStorage.setItem(MODE_KEY, 'copy');
      localStorage.removeItem(URL_KEY);
      const pend = openSetup.pending;
      closeSetup();
      toast('已切换为「只复制不跳转」：点「问 AI」后把内容粘贴到 Harness 窗口即可');
      if (pend) await runAsk(pend);
      return;
    }
    // prize add by yanliang for 问 AI：地址留空即进入「只复制不跳转」模式, 20261026-end
    if (!/^https?:\/\//i.test(url)) {
      toast('地址要以 http:// 或 https:// 开头', true);
      return;
    }
    localStorage.setItem(URL_KEY, url);
    localStorage.setItem(MODE_KEY, 'url');
    const pending = openSetup.pending;
    closeSetup();
    if (pending) await runAsk(pending);
  }

  // prize add by yanliang for 问 AI：手动选「只复制不跳转」, 20261026-start
  async function useCopyOnly() {
    localStorage.setItem(MODE_KEY, 'copy');
    localStorage.removeItem(URL_KEY);
    const pend = openSetup.pending;
    closeSetup();
    if (pend) await runAsk(pend);
  }
  // prize add by yanliang for 问 AI：手动选「只复制不跳转」, 20261026-end

  /* ---------------- 主流程 ---------------- */

  async function runAsk(ctx) {
    const url = (localStorage.getItem(URL_KEY) || '').trim();
    // prize add by yanliang for 问 AI：只复制模式 / 首次未配置 的分支, 20261026-start
    const mode = localStorage.getItem(MODE_KEY) || (url ? 'url' : '');
    if (!mode) {
      openSetup(ctx);
      return;
    }
    if (mode === 'copy' || !url) {
      const text = buildPrompt(ctx);
      const copied = await copyText(text);
      if (!copied) {
        showCopyFallback(text);
        return;
      }
      toast(
        ctx.sel
          ? `已复制第 ${ctx.sel.from}–${ctx.sel.to} 行，切到 Harness 窗口按 Ctrl+V 发送`
          : `已复制「${ctx.path.split('/').pop()}」的上下文，切到 Harness 窗口按 Ctrl+V 发送`
      );
      return;
    }
    // prize add by yanliang for 问 AI：只复制模式 / 首次未配置 的分支, 20261026-end
    const prompt = buildPrompt(ctx);
    const ok = await copyText(prompt);
    if (!ok) {
      showCopyFallback(prompt);
      return;
    }
    const opened = openHarness(url);
    if (!opened) {
      toast('内容已复制，但新窗口被拦截了；请允许弹出窗口后再点一次', true);
      return;
    }
    toast(
      ctx.sel
        ? `已复制第 ${ctx.sel.from}–${ctx.sel.to} 行（${ctx.sel.text.split('\n').length} 行），到 AI 窗口按 Ctrl+V 发送`
        : `已复制「${ctx.path.split('/').pop()}」的上下文，到 AI 窗口按 Ctrl+V 发送`
    );
  }

  async function askAi() {
    const ctx = currentContext();
    if (!ctx) {
      toast('先在左边选一个文件', true);
      return;
    }
    if (!ctx.sel && !ctx.whole.trim()) {
      toast('这个文件还没读到内容，稍等一下再点', true);
      return;
    }
    await runAsk(ctx);
  }

  /* ---------------- 按钮注入 ---------------- */

  // 只在真的显示了代码（预览或编辑）时才出现，空态 / 解释文档里不显示
  function ensureBtn() {
    const pane = document.getElementById('diffPane');
    if (!pane) return;
    const body = document.getElementById('diffPaneBody');
    const hasCode = !!(body && (body.querySelector('.fv-code') || document.getElementById('edContent')));
    const old = document.getElementById(BTN_ID);
    if (!hasCode) {
      if (old) old.remove();
      closeSetup();
      return;
    }
    if (old && old.parentNode === pane) return;
    if (old) old.remove();
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'ai-fab';
    btn.title = '把当前文件 / 选中的代码发给 AI 解释（Shift+点击可重新设置 Harness 地址）';
    btn.innerHTML = '<span class="ai-fab-mark">AI</span><span class="ai-fab-txt">问 AI</span>';
    pane.appendChild(btn);
  }

  function watchPane() {
    const pane = document.getElementById('diffPane');
    if (!pane) {
      setTimeout(watchPane, 300);
      return;
    }
    let queued = 0;
    const mo = new MutationObserver(() => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        ensureBtn();
      });
    });
    mo.observe(pane, { childList: true, subtree: true });
    ensureBtn();
  }

  /* ---------------- 事件 ---------------- */

  document.addEventListener(
    'click',
    (ev) => {
      const t = ev.target;
      if (t.closest && t.closest('#' + BTN_ID)) {
        ev.preventDefault();
        ev.stopPropagation();
        // prize add by yanliang for 问 AI：Shift+点按钮重新打开地址设置, 20261026-start
        if (ev.shiftKey) {
          openSetup(null);
          return;
        }
        // prize add by yanliang for 问 AI：Shift+点按钮重新打开地址设置, 20261026-end
        askAi();
        return;
      }
      if (t.closest && t.closest('#aiUrlCopyOnly')) {
        ev.preventDefault();
        useCopyOnly();
        return;
      }
      if (t.closest && t.closest('#aiUrlSave')) {
        ev.preventDefault();
        saveUrl();
        return;
      }
      if (t.closest && t.closest('#aiUrlClear')) {
        ev.preventDefault();
        localStorage.removeItem(URL_KEY);
        localStorage.removeItem(MODE_KEY);
        const input = document.getElementById('aiUrlInput');
        if (input) input.value = '';
        toast('已清除 Harness 地址和模式');
        return;
      }
      if (t.closest && t.closest('#aiFallbackClose')) {
        ev.preventDefault();
        closeFallback();
        return;
      }
      // 点面板外面收起设置浮层
      const box = document.getElementById(SETUP_ID);
      if (box && !box.contains(t)) closeSetup();
    },
    true
  );

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeSetup();
      closeFallback();
    }
  });

  watchPane();

  // 留个入口给自测脚本 / 以后别的模块复用
  window.gdvAi = { ask: askAi, context: currentContext, buildPrompt, ensureBtn };
})();
// prize add by yanliang 20261026-end
