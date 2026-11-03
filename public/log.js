/**
 * prize add by yanliang 20261102-start
 * 顶栏「实时日志」：把设备 logcat 拉进网页看，带级别 / tag / 关键字筛选、
 * 异常自动标红捕获，可把当前（筛选后的）日志存成 .log 文件。
 *
 * 数据流：server-log.js 里跑一个 adb logcat 进程 → 内存环形缓冲 → 前端按 seq 增量拉。
 * 关掉面板只停"看"，采集要不要继续由按钮决定；重新打开会接着上次的会话。
 */
'use strict';

(function () {
  const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
  const LEVEL_NAME = { V: 'Verbose', D: 'Debug', I: 'Info', W: 'Warn', E: 'Error', F: 'Fatal' };
  const CAP = 2000; // DOM 里最多保留的行数，再多就从头部删
  const MAX_ENTRIES = 60000; // 前端内存里最多留的条目
  const POLL_MS = 600;

  // 异常识别：等级本身就够（E/F），再加常见的崩溃 / ANR / 堆栈特征
  const ERR_RE = new RegExp(
    [
      'FATAL EXCEPTION',
      'ANR in ',
      'tombstone',
      'SIGSEGV',
      'SIGABRT',
      'native crash',
      'has died',
      'Force finishing',
      'DeadSystemException',
      'Caused by:',
      '\\b(?:[A-Za-z_$][\\w$]*\\.)+[A-Za-z_$][\\w$]*(?:Exception|Error)\\b',
      '\\bat [a-z][\\w$]*(?:\\.[\\w$]+)+\\(.*\\.(?:java|kt):\\d+\\)',
    ].join('|')
  );

  const S = {
    open: false,
    serial: '',
    devices: [],
    running: false,
    starting: false,
    cursor: 0,
    seq: 0,
    entries: [],
    lineCount: 0,
    errCount: 0,
    dropped: 0,
    renderedCount: 0,
    needFull: true,
    timer: 0,
    polling: false,
    follow: true,
    pause: false,
    pkg: '',
    seed: 200,
    buffers: { main: true, system: true, crash: true, events: false },
    levels: { V: false, D: true, I: true, W: true, E: true, F: true },
    tag: '',
    kw: '',
    errOnly: false,
    status: '',
    sessionStart: 0,
    err: '',
    // 收藏的过滤条件：groups 是分类，items 是具体条目
    fav: { groups: [], items: [], open: false, group: '', draft: '', loading: false, edited: false, rename: '' },
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

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function fmtClock(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function stampName() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function toast(msg, bad) {
    if (typeof window.toast === 'function') window.toast(msg, bad);
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
    const lvBtns = LEVELS.map(
      (l) =>
        `<button class="lg-lv lv-${l.toLowerCase()}${S.levels[l] ? ' on' : ''}" data-lv="${l}" title="${LEVEL_NAME[l]}">${l}</button>`
    ).join('');
    return `
      <div class="log-head">
        <span class="log-title"><span class="log-dot" id="logDot"></span>实时日志<em class="log-cmd" id="logCmd"></em></span>
        <select id="logDev" class="log-dev" title="选择设备"></select>
        <input id="logPkg" class="log-in log-pkg" spellcheck="false" placeholder="包名（可选，只看该进程）" value="${esc(S.pkg)}" />
        <select id="logSeed" class="log-dev" title="启动时带上多少历史日志">
          <option value="0">不带历史</option>
          <option value="200" selected>最近 200 行</option>
          <option value="1000">最近 1000 行</option>
          <option value="3000">最近 3000 行</option>
        </select>
        <button class="btn small primary" id="logRun">开始</button>
        <button class="btn small" id="logClear" title="清空当前缓冲区（设备上的日志不受影响）">清空</button>
        <button class="btn small" id="logCast" title="用 scrcpy 打开投屏窗口（原生窗口，画面不嵌在网页里）">投屏</button>
        <button class="modal-close" id="logClose" title="关闭（Esc）">&times;</button>
      </div>
      <div class="log-bar">
        <span class="log-lbl">缓冲</span>
        <label class="adb-chk"><input type="checkbox" id="logBufMain" checked />main</label>
        <label class="adb-chk"><input type="checkbox" id="logBufSys" checked />system</label>
        <label class="adb-chk"><input type="checkbox" id="logBufCrash" checked />crash</label>
        <label class="adb-chk" title="events 缓冲区：系统事件流（am_/wm_/power_ 等结构化事件），量很大，默认不开"><input type="checkbox" id="logBufEvt" />event</label>
        <span class="log-sep"></span>
        <span class="log-lbl">级别</span>
        <div class="log-lvs" id="logLvs">${lvBtns}</div>
        <input id="logTag" class="log-in log-tag" spellcheck="false" placeholder="tag（| =或）"
          title="子串匹配，不区分大小写。竖线表示或：WindowManager|InputDispatcher" />
        <input id="logKw" class="log-in log-kw" spellcheck="false" placeholder="关键字（空格=且，| =或，/…/ =正则）"
          title="空格表示且、竖线表示或、/…/ 包裹按正则（不区分大小写）。例：/err\\d|fail/ 表示正则；/timeout|anr/ focus 表示正则命中且含 focus。正则写错会按普通子串处理" />
        <label class="adb-chk log-errchk" title="只看 E/F 级别和崩溃堆栈"><input type="checkbox" id="logErrOnly" />只看异常</label>
        <div class="log-favwrap">
          <button class="btn small log-favbtn" id="logFavBtn" title="收藏当前过滤条件 / 打开收藏夹">☆ 收藏</button>
          <div class="log-fav-pop hidden" id="logFavPop"></div>
        </div>
      </div>
      <div class="log-body" id="logBody"></div>
      <div class="log-foot">
        <span class="log-stat" id="logStat">未开始</span>
        <label class="adb-chk"><input type="checkbox" id="logFollow" checked />自动滚动</label>
        <label class="adb-chk" title="暂停：仍然采集，只是不往屏幕上刷"><input type="checkbox" id="logPause" />暂停显示</label>
        <span class="log-foot-hint" id="logHint">点一行展开完整消息与堆栈</span>
        <button class="btn small" id="logSave" title="按当前筛选条件保存">保存</button>
        <button class="btn small" id="logSaveAll" title="保存缓冲区里的全部日志">保存全部</button>
      </div>`;
  }

  function openPanel() {
    const mask = $('logMask');
    const modal = $('logModal');
    if (!mask || !modal) return;
    S.open = true;
    mask.classList.remove('hidden');
    modal.innerHTML = shell();
    bind();
    paintFavBtn();
    loadFavs();
    loadDevices().then(async () => {
      paintCast();
      if (S.running) {
        // 上次会话还在跑：直接续上看
        try {
          const st = await apiGet('log-status');
          paintCmd((st.session && st.session.cmd) || '');
          S.sessionStart = (st.session && st.session.startedAt) || 0;
        } catch (_) {}
        paintRun(true);
        S.cursor = 0;
        S.entries = [];
        S.renderedCount = 0;
        S.needFull = true;
        statText('正在接回上次的采集会话…');
        poll();
      } else {
        start();
      }
    });
  }

  function closePanel() {
    S.open = false;
    S.fav.open = false;
    clearTimeout(S.timer);
    S.timer = 0;
    const mask = $('logMask');
    const modal = $('logModal');
    if (mask) mask.classList.add('hidden');
    if (modal) modal.innerHTML = '';
  }

  /* ---------------- 设备 ---------------- */

  async function loadDevices() {
    const sel = $('logDev');
    if (!sel) return;
    try {
      const st = await apiGet('adb-status');
      S.devices = (st.devices || []).filter((d) => d.state === 'device');
      if (!S.devices.length) {
        sel.innerHTML = '<option value="">没有连接的设备</option>';
        sel.disabled = true;
        return;
      }
      sel.disabled = false;
      if (!S.devices.some((d) => d.serial === S.serial)) S.serial = S.devices[0].serial;
      sel.innerHTML = S.devices
        .map(
          (d) =>
            `<option value="${esc(d.serial)}"${d.serial === S.serial ? ' selected' : ''}>${esc(
              (d.model ? d.model + ' · ' : '') + d.serial
            )}</option>`
        )
        .join('');
    } catch (err) {
      sel.innerHTML = `<option value="">adb 不可用</option>`;
      sel.disabled = true;
      statText('adb 不可用：' + err.message, true);
    }
  }

  /* ---------------- 采集 ---------------- */

  function buffers() {
    const list = [];
    if (S.buffers.main) list.push('main');
    if (S.buffers.system) list.push('system');
    if (S.buffers.crash) list.push('crash');
    if (S.buffers.events) list.push('events');
    return list.length ? list : ['main', 'system', 'crash'];
  }

  async function start() {
    if (S.starting) return;
    const sel = $('logDev');
    const serial = (sel && sel.value) || S.serial;
    if (!serial) {
      statText('没有可用的设备，先插上 USB 并打开 USB 调试', true);
      return;
    }
    S.serial = serial;
    S.pkg = (($('logPkg') || {}).value || '').trim();
    S.starting = true;
    const btn = $('logRun');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '启动中…';
    }
    try {
      const r = await apiPost('log-start', { serial, buffers: buffers(), seed: S.seed, pkg: S.pkg });
      S.entries = [];
      S.lineCount = 0;
      S.errCount = 0;
      S.dropped = 0;
      S.cursor = 0;
      S.renderedCount = 0;
      S.needFull = true;
      S.sessionStart = (r.session && r.session.startedAt) || Date.now();
      S.err = '';
      paintCmd((r.session && r.session.cmd) || '');
      const body = $('logBody');
      if (body) body.innerHTML = '';
      paintRun(true);
      if (r.warning) toast(r.warning, true);
      statText('采集中…');
      poll();
    } catch (err) {
      S.running = false;
      paintRun(false);
      statText('启动失败：' + err.message, true);
      toast(err.message, true);
    } finally {
      S.starting = false;
      const b = $('logRun');
      if (b) {
        b.disabled = false;
      }
    }
  }

  async function stop() {
    clearTimeout(S.timer);
    S.timer = 0;
    try {
      await apiPost('log-stop', {});
    } catch (_) {}
    paintRun(false);
    statText('已停止采集');
  }

  /* ---------------- scrcpy 投屏（与设备截图页同一套接口） ---------------- */

  async function paintCast() {
    const btn = $('logCast');
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
    const btn = $('logCast');
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

  async function poll() {
    if (!S.open || S.polling) return;
    S.polling = true;
    try {
      // 一次没追平就继续拉，最多 20 轮，避免单帧卡太久
      for (let i = 0; i < 20; i++) {
        const r = await apiGet('log-poll', { cursor: S.cursor, limit: 3000 });
        if (!S.open) return;
        if (r.truncated) {
          S.entries = [];
          S.lineCount = 0;
          S.errCount = 0;
          S.renderedCount = 0;
          S.needFull = true;
        }
        if (r.lines && r.lines.length) {
          ingest(r.lines);
          S.cursor = r.cursor;
        } else if (typeof r.cursor === 'number') {
          S.cursor = r.cursor;
        }
        S.seq = r.seq || S.seq;
        S.dropped = r.dropped || 0;
        if (r.error && r.error !== S.err) {
          S.err = r.error;
          statText('采集中断：' + r.error, true);
        }
        if (r.running !== S.running) paintRun(!!r.running);
        if (!r.more) break;
      }
      if (!S.pause) {
        if (S.needFull) fullRender();
        else appendRender();
      } else {
        paintStats();
      }
    } catch (err) {
      statText('拉取失败：' + err.message, true);
    } finally {
      S.polling = false;
    }
    if (S.open && S.running) {
      clearTimeout(S.timer);
      S.timer = setTimeout(poll, POLL_MS);
    }
  }

  /* ---------------- 解析 ---------------- */

  function parseLine(raw) {
    // 10-30 17:13:54.172   858   858 I BufferQueueDebug: onDestructor()
    const m = /^(\d\d-\d\d)\s+(\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([\s\S]*)$/.exec(raw);
    if (!m) return { cont: true, raw };
    const rest = m[6];
    const ci = rest.indexOf(': ');
    const tag = ci > 0 ? rest.slice(0, ci).trim() : '';
    const msg = ci > 0 ? rest.slice(ci + 2) : rest;
    const e = {
      raw,
      time: m[2],
      pid: m[3],
      tid: m[4],
      lv: m[5] === 'A' ? 'F' : m[5],
      tag,
      msg,
      extra: [],
      err: false,
    };
    e.err = e.lv === 'E' || e.lv === 'F' || ERR_RE.test(msg);
    return e;
  }

  function ingest(lines) {
    for (const raw of lines) {
      if (!raw) continue;
      S.lineCount += 1;
      const e = parseLine(raw);
      const last = S.entries.length ? S.entries[S.entries.length - 1] : null;
      if (e.cont) {
        if (last) {
          if (last.extra.length < 200) {
            last.extra.push(raw);
            if (!last.err && last.extra.length === 1 && ERR_RE.test(raw)) {
              last.err = true;
              S.errCount += 1;
            }
          }
        } else {
          // 第一行就对不上格式（多行消息的续行等），单独占一行灰色显示
          const fake = { raw, time: '', pid: '', tid: '', lv: '', tag: '', msg: raw, extra: [], err: false };
          S.entries.push(fake);
        }
        continue;
      }
      S.entries.push(e);
      if (e.err) S.errCount += 1;
    }
    if (S.entries.length > MAX_ENTRIES) {
      const drop = S.entries.length - MAX_ENTRIES;
      S.entries.splice(0, drop);
      S.renderedCount = 0;
      S.needFull = true;
    }
  }

  /* ---------------- 筛选 ---------------- */

  // 简易布尔：空格=且，竖线=或，/…/ 包裹的词按正则（不区分大小写）。
  // `a|b c` 读作 (a 或 b) 且 c；`/err|fail/ pid` 读作匹配正则 err|fail 且含 pid。
  // 词都是子串匹配，不用转义；正则写错时回退成普通子串，不至于整屏过滤失效。
  const reCache = new Map();
  function reOf(body) {
    let re = reCache.get(body);
    if (re === undefined) {
      try {
        re = new RegExp(body, 'i');
      } catch (_) {
        re = false;
      }
      reCache.set(body, re);
      if (reCache.size > 200) reCache.clear();
    }
    return re;
  }

  function tokenHit(tok, hay) {
    if (tok.length > 2 && tok.charCodeAt(0) === 47 && tok.charCodeAt(tok.length - 1) === 47) {
      const re = reOf(tok.slice(1, -1));
      if (re) return re.test(hay);
    }
    return hay.indexOf(tok) >= 0;
  }

  function matchExpr(hay, expr) {
    const groups = String(expr || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    for (const g of groups) {
      // 整体就是 /…/：竖线属于正则本身，不能再按或拆
      if (g.length > 2 && g.charCodeAt(0) === 47 && g.charCodeAt(g.length - 1) === 47) {
        if (!tokenHit(g, hay)) return false;
        continue;
      }
      const alts = g.split('|').filter(Boolean);
      if (!alts.length) continue;
      let hit = false;
      for (const a of alts) {
        if (tokenHit(a, hay)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
    return true;
  }

  function match(e) {
    if (S.errOnly && !e.err) return false;
    if (e.lv && !S.levels[e.lv]) return false;
    if (S.tag && !matchExpr(e.tag.toLowerCase(), S.tag)) return false;
    if (S.kw) {
      const hay = (e.tag + ' ' + e.msg + ' ' + e.extra.join('\n')).toLowerCase();
      if (!matchExpr(hay, S.kw)) return false;
    }
    return true;
  }

  function applyFilter() {
    S.needFull = true;
    S.renderedCount = 0;
    if (!S.pause) fullRender();
    else paintStats();
    // 收藏夹开着时，标题跟着当前过滤条件走（用户自己改过就不动）
    if (S.fav.open && !S.fav.edited) {
      const inp = $('logFavName');
      if (inp) inp.value = autoFavName();
    }
  }

  /* ---------------- 过滤条件收藏 ---------------- */

  function curFilter() {
    return {
      levels: LEVELS.filter((l) => S.levels[l]),
      tag: S.tag,
      kw: S.kw,
      errOnly: S.errOnly,
      buffers: buffers(),
      seed: S.seed,
    };
  }

  function favDesc(f) {
    const bits = [];
    const lv = (f.levels || []).join('');
    if (lv && lv !== 'DIWEF') bits.push('级别 ' + lv);
    if (f.tag) bits.push('tag ' + f.tag);
    if (f.kw) bits.push('“' + f.kw + '”');
    if (f.errOnly) bits.push('只看异常');
    const bf = (f.buffers || []).join('+');
    if (bf && bf !== 'main+system+crash') bits.push(bf);
    return bits.join(' · ') || '全部日志';
  }

  function autoFavName() {
    const f = curFilter();
    // S.tag/S.kw 为了匹配都转成了小写，取名用输入框里的原文
    const tagIn = $('logTag');
    const kwIn = $('logKw');
    const tag = (tagIn ? tagIn.value : f.tag).trim();
    const kw = (kwIn ? kwIn.value : f.kw).trim();
    const bits = [];
    if (tag) bits.push(tag);
    if (kw) bits.push(kw.split(/\s+/).slice(0, 2).join(' '));
    if (f.errOnly) bits.push('异常');
    if (f.levels.join('') !== 'DIWEF' && f.levels.length) bits.push('≥' + f.levels[0]);
    return (bits.join(' · ') || '全部日志').slice(0, 40);
  }

  async function loadFavs() {
    try {
      const r = await apiGet('log-fav-list');
      S.fav.groups = r.groups || [];
      S.fav.items = r.items || [];
    } catch (_) {}
    paintFavBtn();
    if (S.fav.open) renderFav();
  }

  function paintFavBtn() {
    const btn = $('logFavBtn');
    if (!btn) return;
    const n = S.fav.items.length;
    btn.textContent = (n ? '★ 收藏 ' + n : '☆ 收藏');
    btn.title = n ? `已收藏 ${n} 组过滤条件，点击打开收藏夹` : '把当前过滤条件收藏起来';
  }

  function renderFav() {
    const pop = $('logFavPop');
    if (!pop) return;
    const groups = S.fav.groups;
    const items = S.fav.items;
    const gid = groups.some((g) => g.id === S.fav.group) ? S.fav.group : (groups[0] && groups[0].id) || '';

    const opts =
      groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('') +
      '<option value="__new">＋ 新建分类…</option>';

    let list;
    if (S.fav.loading) list = '<div class="log-fav-empty">读取收藏中…</div>';
    else if (!groups.length) list = '<div class="log-fav-empty">还没有分类</div>';
    else
      list = groups
        .map((g) => {
          const own = items.filter((it) => it.group === g.id);
          const rows = own
            .map(
              (it) =>
                `<div class="log-fav-item" data-id="${esc(it.id)}" title="点击套用这组过滤条件">` +
                `<span class="log-fav-iname">${esc(it.name)}</span>` +
                `<span class="log-fav-idesc">${esc(favDesc(it.filter))}</span>` +
                `<button class="log-fav-del" data-del="${esc(it.id)}" title="删除这条收藏">×</button>` +
                `</div>`
            )
            .join('');
          const renaming = S.fav.rename === g.id;
          const head = renaming
            ? `<div class="log-fav-ghead">` +
              `<input id="logFavRename" class="log-in log-fav-rename" value="${esc(g.name)}" />` +
              `<button class="btn small primary" id="logFavRenameOk">确定</button>` +
              `<button class="btn small ghost" id="logFavRenameCancel">取消</button>` +
              `</div>`
            : `<div class="log-fav-ghead">` +
              `<span class="log-fav-gname">${esc(g.name)}</span>` +
              `<span class="log-fav-gcount">${own.length}</span>` +
              `<span class="log-fav-gacts">` +
              `<button class="log-fav-gtool" data-gren="${esc(g.id)}" title="给这个分类改名">改名</button>` +
              (groups.length > 1
                ? `<button class="log-fav-gtool log-fav-gdel" data-gdel="${esc(g.id)}" title="删除分类（里面的收藏会移到第一个分类）">删除</button>`
                : '') +
              `</span>` +
              `</div>`;
          return (
            `<div class="log-fav-group">` +
            head +
            (rows || '<div class="log-fav-empty">这个分类还没有收藏</div>') +
            `</div>`
          );
        })
        .join('');

    pop.innerHTML =
      `<div class="log-fav-hint">把当前「级别 / tag / 关键字 / 只看异常 / 缓冲范围」存成一条，下次点一下就能套回来。</div>` +
      `<div class="log-fav-form">` +
      `<input id="logFavName" class="log-in log-fav-namein" placeholder="收藏名称" value="${esc(S.fav.draft || autoFavName())}" />` +
      `<select id="logFavGroup" class="log-dev log-fav-gsel">${opts}</select>` +
      `<button class="btn small primary" id="logFavSave">保存</button>` +
      `</div>` +
      `<div class="log-fav-newgrp hidden" id="logFavNewGrp">` +
      `<input id="logFavNewName" class="log-in" placeholder="新分类名称，回车确认" />` +
      `<button class="btn small" id="logFavNewOk">添加</button>` +
      `</div>` +
      `<div class="log-fav-list">${list}</div>`;

    const sel = $('logFavGroup');
    if (sel) sel.value = gid;
    bindFavForm();
  }

  function bindFavForm() {
    const save = $('logFavSave');
    if (save) save.addEventListener('click', saveFav);
    const nameIn = $('logFavName');
    if (nameIn) {
      nameIn.addEventListener('input', () => {
        S.fav.draft = nameIn.value;
        S.fav.edited = true;
      });
      nameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveFav();
      });
    }
    const sel = $('logFavGroup');
    if (sel)
      sel.addEventListener('change', () => {
        const isNew = sel.value === '__new';
        const box = $('logFavNewGrp');
        if (box) box.classList.toggle('hidden', !isNew);
        if (isNew) {
          const inp = $('logFavNewName');
          if (inp) inp.focus();
        }
      });
    const renameIn = $('logFavRename');
    if (renameIn) {
      const commit = () => renameGroup(S.fav.rename, renameIn.value);
      renameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          S.fav.rename = '';
          renderFav();
        }
      });
      const rok = $('logFavRenameOk');
      if (rok) rok.addEventListener('click', commit);
      const rcancel = $('logFavRenameCancel');
      if (rcancel)
        rcancel.addEventListener('click', () => {
          S.fav.rename = '';
          renderFav();
        });
    }
    const ok = $('logFavNewOk');
    if (ok) ok.addEventListener('click', addGroup);
    const newName = $('logFavNewName');
    if (newName)
      newName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addGroup();
      });
  }

  async function saveFav() {
    const nameIn = $('logFavName');
    const sel = $('logFavGroup');
    const payload = { name: (nameIn && nameIn.value.trim()) || '', filter: curFilter() };
    const v = sel ? sel.value : '';
    if (v === '__new') {
      const nm = (($('logFavNewName') || {}).value || '').trim();
      if (!nm) {
        toast('先给新分类起个名字', true);
        return;
      }
      payload.groupName = nm;
    } else {
      payload.group = v;
    }
    try {
      const r = await apiPost('log-fav-save', payload);
      S.fav.groups = r.groups || S.fav.groups;
      S.fav.items = r.items || S.fav.items;
      S.fav.draft = '';
      S.fav.edited = false;
      S.fav.group = (r.item && r.item.group) || v;
      paintFavBtn();
      renderFav();
      toast('已收藏「' + ((r.item && r.item.name) || '过滤条件') + '」');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function delFav(id) {
    try {
      const r = await apiPost('log-fav-del', { id });
      S.fav.groups = r.groups || S.fav.groups;
      S.fav.items = r.items || S.fav.items;
      paintFavBtn();
      renderFav();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function addGroup() {
    const inp = $('logFavNewName');
    const nm = ((inp && inp.value) || '').trim();
    if (!nm) {
      toast('分类名不能为空', true);
      return;
    }
    try {
      const r = await apiPost('log-group-add', { name: nm });
      S.fav.groups = r.groups || S.fav.groups;
      S.fav.items = r.items || S.fav.items;
      S.fav.group = (r.group && r.group.id) || S.fav.group;
      renderFav();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function delGroup(id) {
    try {
      const r = await apiPost('log-group-del', { id });
      S.fav.groups = r.groups || S.fav.groups;
      S.fav.items = r.items || S.fav.items;
      paintFavBtn();
      renderFav();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function renameGroup(id, name) {
    const nm = String(name || '').trim();
    if (!nm) {
      toast('分类名不能为空', true);
      return;
    }
    try {
      const r = await apiPost('log-group-rename', { id, name: nm });
      S.fav.groups = r.groups || S.fav.groups;
      S.fav.items = r.items || S.fav.items;
      S.fav.rename = '';
      renderFav();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function applyFav(id) {
    const it = S.fav.items.find((x) => x.id === id);
    if (!it) return;
    const f = it.filter || {};
    LEVELS.forEach((l) => {
      S.levels[l] = (f.levels || []).indexOf(l) >= 0;
    });
    const chips = document.querySelectorAll('#logLvs .lg-lv');
    Array.prototype.forEach.call(chips, (b) => b.classList.toggle('on', !!S.levels[b.dataset.lv]));

    S.tag = f.tag || '';
    S.kw = f.kw || '';
    S.errOnly = !!f.errOnly;
    const tagIn = $('logTag');
    if (tagIn) tagIn.value = S.tag;
    const kwIn = $('logKw');
    if (kwIn) kwIn.value = S.kw;
    const errIn = $('logErrOnly');
    if (errIn) errIn.checked = S.errOnly;

    // 缓冲范围 / 历史行数是启动参数：先同步到界面，采集中的话提示下次生效
    const bufs = f.buffers || [];
    S.buffers = {
      main: bufs.indexOf('main') >= 0,
      system: bufs.indexOf('system') >= 0,
      crash: bufs.indexOf('crash') >= 0,
      events: bufs.indexOf('events') >= 0,
    };
    const bm = $('logBufMain');
    if (bm) bm.checked = S.buffers.main;
    const bs = $('logBufSys');
    if (bs) bs.checked = S.buffers.system;
    const bc = $('logBufCrash');
    if (bc) bc.checked = S.buffers.crash;
    const be = $('logBufEvt');
    if (be) be.checked = S.buffers.events;
    if (f.seed != null) {
      S.seed = Number(f.seed) || 0;
      const sd = $('logSeed');
      if (sd) sd.value = String(S.seed);
    }

    applyFilter();
    closeFav();
    toast('已套用「' + it.name + '」' + (S.running ? '；缓冲范围下次开始采集才生效' : ''));
  }

  function openFav() {
    const pop = $('logFavPop');
    if (!pop) return;
    S.fav.open = true;
    S.fav.draft = '';
    S.fav.edited = false;
    S.fav.rename = '';
    S.fav.loading = true;
    pop.classList.remove('hidden');
    renderFav();
    loadFavs().then(() => {
      S.fav.loading = false;
      if (S.fav.open) renderFav();
    });
  }

  function closeFav() {
    S.fav.open = false;
    const pop = $('logFavPop');
    if (pop) pop.classList.add('hidden');
  }

  function toggleFav() {
    if (S.fav.open) closeFav();
    else openFav();
  }

  /* ---------------- 渲染 ---------------- */

  function rowHtml(e) {
    const cls = ['lg-item'];
    if (e.lv) cls.push('lv-' + e.lv.toLowerCase());
    if (e.err) cls.push('is-err');
    if (e.extra.length) cls.push('has-x');
    const lv = e.lv || '';
    return (
      `<div class="${cls.join(' ')}">` +
      `<div class="lg-row">` +
      `<span class="lg-t">${esc(e.time)}</span>` +
      `<span class="lg-p">${esc(e.pid)}</span>` +
      `<span class="lg-l">${lv}</span>` +
      `<span class="lg-g" title="${esc(e.tag)}">${esc(e.tag)}</span>` +
      `<span class="lg-m">${esc(e.msg)}</span>` +
      (e.extra.length ? `<span class="lg-x">+${e.extra.length}</span>` : '') +
      `</div>` +
      (e.extra.length
        ? `<pre class="lg-xbody">${esc(e.extra.slice(0, 60).join('\n'))}${
            e.extra.length > 60 ? '\n…（还有 ' + (e.extra.length - 60) + ' 行）' : ''
          }</pre>`
        : '') +
      `</div>`
    );
  }

  function fullRender() {
    const body = $('logBody');
    if (!body) return;
    const out = [];
    let n = 0;
    for (let i = S.entries.length - 1; i >= 0 && n < CAP; i--) {
      const e = S.entries[i];
      if (!match(e)) continue;
      out.push(rowHtml(e));
      n++;
    }
    body.innerHTML = out.length
      ? out.reverse().join('')
      : S.entries.length
        ? `<div class="log-empty">当前筛选条件下没有匹配的日志（缓冲区共 ${S.lineCount} 行）</div>`
        : '';
    S.renderedCount = S.entries.length;
    S.needFull = false;
    if (S.follow) scrollBottom();
    paintStats();
  }

  function appendRender() {
    const body = $('logBody');
    if (!body) return;
    const out = [];
    for (let i = S.renderedCount; i < S.entries.length; i++) {
      const e = S.entries[i];
      if (match(e)) out.push(rowHtml(e));
    }
    S.renderedCount = S.entries.length;
    if (out.length) {
      const empty = body.querySelector('.log-empty');
      if (empty) empty.remove();
      body.insertAdjacentHTML('beforeend', out.join(''));
      while (body.children.length > CAP) body.removeChild(body.firstElementChild);
      if (S.follow) scrollBottom();
    }
    paintStats();
  }

  function scrollBottom() {
    const body = $('logBody');
    if (body) body.scrollTop = body.scrollHeight;
  }

  function visibleCount() {
    const body = $('logBody');
    if (!body) return 0;
    return body.querySelectorAll('.lg-item').length;
  }

  function paintStats() {
    const shown = visibleCount();
    const bits = [`共 ${S.lineCount} 行`];
    bits.push(`显示 ${shown}${shown >= CAP ? '+' : ''}`);
    bits.push(`异常 ${S.errCount}`);
    if (S.dropped) bits.push(`服务端已丢弃 ${S.dropped}`);
    bits.push(S.running ? '采集中' : '未采集');
    const el = $('logStat');
    if (el) {
      el.textContent = bits.join(' · ');
      el.classList.toggle('bad', !!S.err);
      el.title = S.err || '';
    }
  }

  function statText(text, bad) {
    const el = $('logStat');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
  }

  function paintRun(running) {
    S.running = !!running;
    const btn = $('logRun');
    const dot = $('logDot');
    if (btn) {
      btn.textContent = S.running ? '停止' : '开始';
      btn.classList.toggle('primary', !S.running);
      btn.disabled = false;
    }
    if (dot) dot.className = 'log-dot ' + (S.running ? 'on' : 'off');
    // 设备 / 缓冲范围 / 历史行数都是启动参数，改了会重启采集，所以不锁；只有包名要输完整，锁住
    const pkg = $('logPkg');
    if (pkg) pkg.disabled = S.running;
  }

  // 启动参数（缓冲范围、历史行数、设备）改了就重启采集，别让勾选看起来没反应。
  // 连点三个复选框会连开三个进程，这里 350ms 合并一次。
  let restartTimer = 0;
  function restartSoon() {
    if (!S.running || S.starting) return;
    clearTimeout(restartTimer);
    statText('参数已改，正在按新参数重启采集…');
    restartTimer = setTimeout(() => {
      if (!S.running || S.starting) return;
      stop().then(() => start());
    }, 350);
  }

  function paintCmd(cmd) {
    const el = $('logCmd');
    if (el) el.textContent = cmd ? '  ' + cmd.replace(/^adb\s+/, '') : '';
    if (el) el.title = cmd || '';
  }

  /* ---------------- 保存 ---------------- */

  function buildText(onlyFiltered) {
    const list = onlyFiltered ? S.entries.filter(match) : S.entries;
    const lines = [`# gitshow 实时日志导出`];
    lines.push(`# 设备   : ${S.serial || '-'}`);
    lines.push(`# 采集   : ${fmtClock(S.sessionStart)} 起${S.running ? '（导出时仍在采集）' : ''}`);
    lines.push(`# 导出   : ${fmtClock(Date.now())}`);
    const filters = [];
    const lvOn = LEVELS.filter((l) => S.levels[l]).join('');
    filters.push('级别 ' + (lvOn ? lvOn : '全部未选'));
    if (S.tag) filters.push('tag~' + S.tag);
    if (S.kw) filters.push('关键字~' + S.kw);
    if (S.errOnly) filters.push('只看异常');
    lines.push(`# 筛选   : ${onlyFiltered ? filters.join(' , ') : '不过滤（全部）'}`);
    lines.push(`# 行数   : ${list.reduce((n, e) => n + 1 + e.extra.length, 0)}（缓冲区共 ${S.lineCount} 行，异常 ${S.errCount}）`);
    lines.push('# ' + '-'.repeat(60));
    list.forEach((e) => {
      if (e.raw) lines.push(e.raw);
      if (e.extra.length) lines.push(e.extra.join('\n'));
    });
    return lines.join('\n');
  }

  function download(name, text) {
    const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function save(onlyFiltered) {
    const list = onlyFiltered ? S.entries.filter(match) : S.entries;
    if (!list.length) {
      toast('没有可保存的日志', true);
      return;
    }
    const name = `logcat_${(S.serial || 'device').replace(/[^\w.-]/g, '_')}_${stampName()}.log`;
    download(name, buildText(onlyFiltered));
    toast(`已保存 ${name}`);
  }

  /* ---------------- 交互 ---------------- */

  function bind() {
    const close = $('logClose');
    if (close) close.addEventListener('click', closePanel);
    const run = $('logRun');
    if (run) run.addEventListener('click', () => (S.running ? stop() : start()));
    const clr = $('logClear');
    if (clr)
      clr.addEventListener('click', async () => {
        try {
          await apiPost('log-clear', {});
        } catch (_) {}
        S.entries = [];
        S.lineCount = 0;
        S.errCount = 0;
        S.renderedCount = 0;
        S.needFull = true;
        const body = $('logBody');
        if (body) body.innerHTML = '';
        paintStats();
      });

    const castBtn = $('logCast');
    if (castBtn) castBtn.addEventListener('click', toggleCast);

    const sel = $('logDev');
    if (sel)
      sel.addEventListener('change', () => {
        S.serial = sel.value;
        paintCast();
        if (S.running) {
          stop().then(() => start());
        }
      });

    const pkg = $('logPkg');
    if (pkg) pkg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !S.running) start();
    });

    const seed = $('logSeed');
    if (seed)
      seed.addEventListener('change', () => {
        S.seed = Number(seed.value) || 0;
        restartSoon();
      });

    const BUF_IDS = [
      ['Main', 'main'],
      ['Sys', 'system'],
      ['Crash', 'crash'],
      ['Evt', 'events'],
    ];
    BUF_IDS.forEach(([id, key]) => {
      const el = $('logBuf' + id);
      if (el)
        el.addEventListener('change', () => {
          S.buffers[key] = el.checked;
          // 一个都不勾时服务端会兜底成全勾，界面和实际就不一致了，这里直接拦住
          if (!S.buffers.main && !S.buffers.system && !S.buffers.crash && !S.buffers.events) {
            S.buffers[key] = true;
            el.checked = true;
            toast('至少保留一个缓冲区', true);
            return;
          }
          restartSoon();
        });
    });

    const lvs = $('logLvs');
    if (lvs)
      lvs.addEventListener('click', (e) => {
        const b = e.target.closest('.lg-lv');
        if (!b) return;
        const l = b.dataset.lv;
        S.levels[l] = !S.levels[l];
        b.classList.toggle('on', S.levels[l]);
        applyFilter();
      });

    let t = 0;
    const tag = $('logTag');
    if (tag)
      tag.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          S.tag = tag.value.trim().toLowerCase();
          applyFilter();
        }, 200);
      });
    const kw = $('logKw');
    if (kw)
      kw.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          S.kw = kw.value.trim().toLowerCase();
          applyFilter();
        }, 200);
      });

    const errOnly = $('logErrOnly');
    if (errOnly)
      errOnly.addEventListener('change', () => {
        S.errOnly = errOnly.checked;
        applyFilter();
      });

    const follow = $('logFollow');
    if (follow)
      follow.addEventListener('change', () => {
        S.follow = follow.checked;
        if (S.follow) scrollBottom();
      });

    const pause = $('logPause');
    if (pause)
      pause.addEventListener('change', () => {
        S.pause = pause.checked;
        if (!S.pause) {
          S.needFull = true;
          fullRender();
        }
      });

    const saveBtn = $('logSave');
    if (saveBtn) saveBtn.addEventListener('click', () => save(true));
    const saveAll = $('logSaveAll');
    if (saveAll) saveAll.addEventListener('click', () => save(false));

    // 收藏：按钮开关 + 面板内条目用事件委托（内容会整体重绘，不能逐条绑）
    const favBtn = $('logFavBtn');
    if (favBtn) favBtn.addEventListener('click', toggleFav);
    const favPop = $('logFavPop');
    if (favPop)
      favPop.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) {
          e.stopPropagation();
          delFav(del.dataset.del);
          return;
        }
        const gren = e.target.closest('[data-gren]');
        if (gren) {
          e.stopPropagation();
          S.fav.rename = gren.dataset.gren;
          renderFav();
          const inp = $('logFavRename');
          if (inp) {
            inp.focus();
            inp.select();
          }
          return;
        }
        const gdel = e.target.closest('[data-gdel]');
        if (gdel) {
          e.stopPropagation();
          delGroup(gdel.dataset.gdel);
          return;
        }
        const item = e.target.closest('.log-fav-item');
        if (item) applyFav(item.dataset.id);
      });
    const body = $('logBody');
    if (body) {
      body.addEventListener('click', (e) => {
        const row = e.target.closest('.lg-row');
        if (!row) return;
        row.parentElement.classList.toggle('open');
      });
      body.addEventListener('scroll', () => {
        const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        const cb = $('logFollow');
        if (nearBottom && !S.follow) {
          S.follow = true;
          if (cb) cb.checked = true;
        } else if (!nearBottom && S.follow) {
          S.follow = false;
          if (cb) cb.checked = false;
        }
      });
    }

    paintRun(S.running);
    paintStats();
  }

  /* ---------------- 入口 ---------------- */

  function bindEntry() {
    const btn = $('logBtn');
    if (btn) btn.addEventListener('click', openPanel);
    // 点空白处收起收藏夹（只绑一次，别放在每次开面板的 bind 里）
    document.addEventListener('click', (e) => {
      if (!S.open || !S.fav.open) return;
      if (e.target.closest('.log-favwrap')) return;
      closeFav();
    });
    const mask = $('logMask');
    if (mask)
      mask.addEventListener('click', (e) => {
        if (e.target === mask) closePanel();
      });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !S.open) return;
      // 收藏夹开着先收它，再按一次才关面板
      if (S.fav.open) {
        closeFav();
        return;
      }
      closePanel();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindEntry);
  else bindEntry();

  // 暴露给控制台/自动化检查用：open() 打开面板，text(true) 取「按当前筛选」的导出文本
  window.gshowLog = { open: openPanel, close: closePanel, text: (filtered) => buildText(!!filtered) };
})();
// prize add by yanliang 20261102-end
