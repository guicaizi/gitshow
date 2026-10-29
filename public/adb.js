/**
 * prize add by yanliang 20261029-start
 * 顶栏「ADB」模块：设备检测 + 框架文件「配对替换」。
 *
 * 一条配对 = 本地文件 ↔ 设备文件（如 framework.jar → /system/framework/framework.jar）。
 * 两个视图：
 *   列表视图 —— 已配对的替换，勾选后只执行选中的几条；可刷新两端状态、看详情。
 *   添加视图 —— 左边本地目录、右边设备目录，两侧各选一个文件，预览确认后存成配对；
 *               也可以按同名文件批量自动配对。
 */
'use strict';

(function () {
  const DEFAULT_TARGET = '/system/framework';
  const POLL_MS = 700;
  const STATUS_MS = 8000;
  const LS_LOCAL_DIR = 'gdv.adbLocalDir';
  const LS_REMOTE_DIR = 'gdv.adbRemoteDir';

  const S = {
    open: false,
    view: 'list', // list | pick
    status: null,
    serial: '',
    pairs: [],
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-start
    packs: [],
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-end
    busy: false,
    jobId: '',
    cursor: 0,
    timer: 0,
    running: false,
    pick: {
      localDir: localStorage.getItem(LS_LOCAL_DIR) || '',
      remoteDir: localStorage.getItem(LS_REMOTE_DIR) || DEFAULT_TARGET,
      local: null, // {dir,parent,dirs,files}
      remote: null,
      localSel: null,
      remoteSel: null,
      localErr: '',
      remoteErr: '',
    },
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

  function fmtSize(n) {
    if (!Number.isFinite(n) || n <= 0) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtTime(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function baseName(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
  }

  function dirName(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i <= 0 ? s.slice(0, i + 1) : s.slice(0, i);
  }

  function posixJoin(dir, name) {
    if (!dir || dir === '/') return '/' + name;
    return dir.replace(/\/+$/, '') + '/' + name;
  }

  // prize add by yanliang for 预览卡里的长路径中间省略，保留开头和末尾文件名, 20261029-start
  // 路径太长时从中间省略：前段说明所在盘/工程，后段是文件名，两头都比中段有用
  function midPath(p, limit) {
    const s = String(p || '');
    const max = limit || 54;
    if (s.length <= max) return s;
    const tail = Math.min(28, Math.floor(max * 0.55));
    const head = max - tail - 1;
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }
  // prize add by yanliang for 预览卡里的长路径中间省略，保留开头和末尾文件名, 20261029-end

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
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '请求失败');
    return data;
  }

  function toast(text, isError) {
    if (typeof window.toast === 'function') window.toast(text, isError);
    else if (isError) console.error(text);
  }

  /* ---------------- 顶栏状态 ---------------- */

  function currentDevice(st) {
    const data = st || S.status;
    if (!data || !Array.isArray(data.devices)) return null;
    const online = data.devices.filter((d) => d.state === 'device');
    if (!online.length) return null;
    return online.find((d) => d.serial === S.serial) || online[0];
  }

  function paintEntry(st) {
    const btn = $('adbBtn');
    const dot = $('adbDot');
    const sub = $('adbEntrySub');
    if (!btn || !dot || !sub) return;

    const dev = currentDevice(st);
    btn.classList.toggle('on', !!dev);
    btn.classList.toggle('off', !dev);
    dot.className = 'adb-dot ' + (dev ? 'on' : 'off');

    if (!st) {
      sub.textContent = '检测中';
    } else if (dev) {
      const n = S.pairs.length;
      // 配对多了以后设备名太长会被截断，顶栏只留「N 组配对」，设备名放 title
      sub.textContent = n ? `${n} 组配对` : dev.model || dev.serial;
      btn.title = `${dev.model || dev.serial} · Android ${dev.release || '?'}\n${dev.serial}\n点击管理替换配对`;
    } else if (st.devices.some((d) => d.state === 'unauthorized')) {
      sub.textContent = '未授权';
      btn.title = '设备已插上但没授权：请在设备上点「允许 USB 调试」';
    } else if (st.devices.some((d) => d.state === 'offline')) {
      sub.textContent = '离线';
      btn.title = '设备处于 offline 状态：拔插一次 USB 或 adb kill-server 后重试';
    } else {
      sub.textContent = S.pairs.length ? `${S.pairs.length} 组配对` : '未连接';
      btn.title = '没有检测到设备，插上 USB 并打开 USB 调试后重试';
    }
  }

  async function refreshStatus(silent, fresh) {
    try {
      const st = await apiGet('adb-status', fresh ? { fresh: '1' } : null);
      const prevDev = currentDevice(null);
      S.status = st;
      const dev = currentDevice(st);
      const changed = !prevDev || !dev || prevDev.serial !== dev.serial;
      S.serial = dev ? dev.serial : '';
      paintEntry(st);
      if (S.open && S.view === 'list') {
        if (changed && !S.running) renderDeviceBar();
        else if (S.open && !S.running) renderDeviceBar();
      }
      return st;
    } catch (err) {
      S.status = null;
      paintEntry(null);
      const sub = $('adbEntrySub');
      if (sub) sub.textContent = /本机/.test(err.message) ? '仅本机' : 'adb 不可用';
      if (!silent) toast(err.message, true);
      if (S.open && S.view === 'list') renderDeviceBar(err.message);
      return null;
    }
  }

  setInterval(() => {
    if (S.running) return;
    refreshStatus(true);
  }, STATUS_MS);

  /* ---------------- 面板骨架 ---------------- */

  function shellList() {
    return `
      <div class="modal-head">
        <span class="modal-title"><span class="adb-dot" id="adbPanelDot"></span>ADB 框架替换</span>
        <span class="adb-head-hint" id="adbHeadHint"></span>
        <button class="btn small" id="adbRefresh" title="重新检测设备与 adb">重新检测</button>
        <button class="modal-close" id="adbClose" title="关闭（Esc）">&times;</button>
      </div>
      <div class="adb-body">
        <section class="adb-sec adb-sec-dev">
          <div class="adb-sec-title">① 设备连接</div>
          <div class="adb-device" id="adbDeviceBar"></div>
        </section>

        <section class="adb-sec">
          <div class="adb-pairs-head">
            <div class="adb-sec-title">② 已配对的替换<span class="adb-pairs-count" id="adbPairsCount"></span></div>
            <div class="adb-pairs-ops">
              <button class="btn small" id="adbAutoPairBtn" title="按两侧目录里的同名文件批量生成配对">同名自动配对</button>
              <button class="btn small" id="adbPairsRefresh" title="重新核对本地文件与设备文件">刷新状态</button>
              <button class="btn small primary" id="adbAddPairBtn">+ 添加配对</button>
            </div>
          </div>
          <div class="adb-pairs" id="adbPairs"></div>
          <div class="adb-pairs-foot" id="adbPairsFoot"></div>
        </section>

        <!-- prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-start -->
        <section class="adb-sec">
          <div class="adb-pairs-head">
            <div class="adb-sec-title">③ 组合包<span class="adb-pairs-count" id="adbPacksCount"></span></div>
            <span class="adb-sec-note inline">把勾选的配对存成一个包，下次一键执行</span>
          </div>
          <div class="adb-pack-save">
            <input class="adb-input" id="adbPackName" spellcheck="false" maxlength="60" placeholder="组合包名字，例如「framework 全套」" />
            <button class="btn small primary" id="adbPackSaveBtn" title="把②里勾选的配对存成组合包">存为组合包</button>
            <span class="adb-pack-save-hint" id="adbPackSaveHint"></span>
          </div>
          <div class="adb-packs" id="adbPacks"></div>
        </section>
        <!-- prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-end -->

        <section class="adb-sec">
          <div class="adb-sec-title">④ 执行选项</div>
          <div class="adb-opts">
            <label class="adb-chk"><input type="checkbox" id="adbOptBackup" checked />先备份设备原文件</label>
            <label class="adb-chk"><input type="checkbox" id="adbOptChmod" checked />push 后 chmod 644</label>
            <label class="adb-chk"><input type="checkbox" id="adbOptReboot" checked />完成后重启设备</label>
            <span class="adb-sec-note inline">自动：adb root → remount → push → 校验 → sync</span>
          </div>
        </section>

        <section class="adb-sec adb-run-sec">
          <div class="adb-run-row">
            <button class="btn primary" id="adbRunBtn">执行选中配对</button>
            <button class="btn ghost small" id="adbHistoryBtn" title="查看上一次执行的详情与日志">上次记录</button>
            <button class="btn ghost small" id="adbCopyLog" title="复制当前日志">复制日志</button>
            <span class="adb-run-hint" id="adbRunHint"></span>
          </div>
          <div class="adb-log-head"><span>执行日志</span><span id="adbLogFlag" class="adb-log-flag"></span></div>
          <pre class="adb-log" id="adbLog">等待执行…</pre>
          <div class="adb-results" id="adbResults"></div>
        </section>
      </div>`;
  }

  function shellPick() {
    return `
      <div class="modal-head">
        <span class="modal-title">添加替换配对</span>
        <span class="adb-head-hint" id="adbHeadHint">左边选本地文件，右边选设备上的目标文件</span>
        <button class="btn small" id="adbPickBack" title="返回配对列表">返回</button>
      </div>
      <div class="adb-body adb-pick-body">
        <div class="adb-pick">
          <section class="adb-pick-pane" id="adbPickLocal">
            <div class="adb-pick-title">本地文件<span class="adb-pick-tag">要替换上去的</span></div>
            <div class="adb-dir-row">
              <input id="adbLocalDir" class="adb-input" spellcheck="false" placeholder="本地目录，例如 D:\\alps\\out\\...\\system\\framework" />
              <button class="btn small" id="adbLocalUp" title="上一级">↑</button>
              <button class="btn small" id="adbLocalBrowse" title="浏览磁盘选目录">…</button>
            </div>
            <div class="adb-pick-list" id="adbLocalList"></div>
            <div class="adb-prev" id="adbLocalPrev"></div>
          </section>
          <section class="adb-pick-pane" id="adbPickRemote">
            <div class="adb-pick-title">设备文件<span class="adb-pick-tag">要被覆盖的</span></div>
            <div class="adb-dir-row">
              <input id="adbRemoteDir" class="adb-input" spellcheck="false" placeholder="/system/framework" />
              <button class="btn small" id="adbRemoteUp" title="上一级">↑</button>
              <button class="btn small" id="adbRemoteGo" title="读取该目录">读取</button>
            </div>
            <div class="adb-pick-list" id="adbRemoteList"></div>
            <div class="adb-prev" id="adbRemotePrev"></div>
          </section>
        </div>
      </div>
      <div class="adb-pick-foot">
        <span class="adb-pair-preview" id="adbPairPreview">还没有选齐两侧的文件</span>
        <button class="btn" id="adbPickCancel">取消</button>
        <button class="btn" id="adbPickAuto" title="两侧目录里同名文件全部配对">同名自动配对</button>
        <button class="btn primary" id="adbPairConfirm" disabled>确认配对</button>
      </div>`;
  }

  function openPanel() {
    S.open = true;
    S.view = 'list';
    const mask = $('adbMask');
    const modal = $('adbModal');
    if (!mask || !modal) return;
    mask.classList.remove('hidden');
    modal.innerHTML = shellList();
    bindList();
    renderDeviceBar();
    renderPairs();
    refreshStatus(true);
    loadPairs();
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-start
    loadPacks();
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-end
  }

  function closePanel() {
    S.open = false;
    stopPoll();
    const mask = $('adbMask');
    const modal = $('adbModal');
    if (mask) mask.classList.add('hidden');
    if (modal) modal.innerHTML = '';
  }

  /* ---------------- 设备区 ---------------- */

  function renderDeviceBar(errText) {
    const bar = $('adbDeviceBar');
    if (!bar) return;
    const st = S.status;
    const dot = $('adbPanelDot');
    const dev = currentDevice(st);

    if (dot) dot.className = 'adb-dot ' + (dev ? 'on' : 'off');
    const hint = $('adbHeadHint');
    if (hint) hint.textContent = st ? 'adb ' + (st.version || '') : 'adb 未就绪';

    if (errText || !st) {
      bar.innerHTML = `<div class="adb-empty bad">
        <strong>读不到 adb 状态</strong>
        <span>${esc(errText || 'adb 探测失败')}</span>
        <span class="adb-tip">把 platform-tools 加入 PATH，或设置环境变量 ADB_BIN 指向 adb.exe 后重启服务。</span>
      </div>`;
      paintRunState();
      return;
    }

    const online = st.devices.filter((d) => d.state === 'device');
    if (!online.length) {
      const pending = st.devices.filter((d) => d.state !== 'device');
      bar.innerHTML = `<div class="adb-empty">
        <strong>没有已授权的设备</strong>
        <span>adb 路径：<code>${esc(st.adb)}</code></span>
        ${
          pending.length
            ? `<span>发现 ${pending.length} 台未就绪：${pending
                .map((d) => esc(d.serial) + '（' + esc(d.state) + '）')
                .join('、')}，请在手机上确认 USB 调试授权。</span>`
            : '<span>插上 USB、打开「开发者选项 → USB 调试」，然后点右上角「重新检测」。</span>'
        }
      </div>`;
      paintRunState();
      return;
    }

    const options = online
      .map(
        (d) =>
          `<option value="${esc(d.serial)}"${d.serial === (dev && dev.serial) ? ' selected' : ''}>${esc(
            d.model || d.serial
          )} · ${esc(d.serial)}</option>`
      )
      .join('');

    bar.innerHTML = `
      <div class="adb-dev-row">
        <span class="adb-dev-state">已连接</span>
        ${
          online.length > 1
            ? `<select id="adbDeviceSel" class="adb-dev-sel">${options}</select>`
            : `<span class="adb-dev-name">${esc(dev.model || dev.serial)}</span>`
        }
        <span class="adb-chip">Android ${esc(dev.release || '?')}</span>
        <span class="adb-chip">${esc(dev.abi || '?')}</span>
        <span class="adb-chip ${dev.root ? 'good' : 'warn'}">${dev.root ? 'root 已获取' : '非 root'}</span>
        <span class="adb-dev-serial">${esc(dev.serial)}</span>
      </div>`;

    const sel = $('adbDeviceSel');
    if (sel) {
      sel.addEventListener('change', () => {
        S.serial = sel.value;
        renderDeviceBar();
        paintEntry(S.status);
        loadPairs();
      });
    }
    paintRunState();
  }

  /* ---------------- 配对列表 ---------------- */

  async function loadPairs() {
    try {
      const data = await apiGet('adb-pairs', S.serial ? { serial: S.serial } : {});
      S.pairs = data.pairs || [];
      renderPairs();
      paintEntry(S.status);
    } catch (err) {
      toast(err.message, true);
    }
  }

  function renderPairs() {
    const box = $('adbPairs');
    const count = $('adbPairsCount');
    if (!box) return;

    const checked = S.pairs.filter((p) => p.checked !== false).length;
    if (count) count.textContent = S.pairs.length ? ` ${S.pairs.length} 组 · 已选 ${checked}` : '';

    if (!S.pairs.length) {
      box.innerHTML = `<div class="adb-empty">
        <strong>还没有配对</strong>
        <span>点「+ 添加配对」左边挑本地文件、右边挑设备文件，确认后就会存下来。</span>
        <span>已经有一整套同名文件的话，用「同名自动配对」一次生成。</span>
      </div>`;
      renderPairsFoot();
      paintRunState();
      return;
    }

    const rows = S.pairs.map((p) => {
      const on = p.checked !== false;
      const status = pairStatus(p);
      return `<div class="adb-pair${on ? ' on' : ''}" data-id="${esc(p.id)}">
        <label class="adb-pair-box"><input type="checkbox" ${on ? 'checked' : ''} /></label>
        <div class="adb-pair-main">
          <div class="adb-pair-line">
            <span class="adb-pair-name" title="${esc(p.local)}">${esc(baseName(p.local))}</span>
            <span class="adb-pair-arrow">→</span>
            <span class="adb-pair-remote" title="${esc(p.remote)}">${esc(p.remote)}</span>
            <span class="adb-pair-status ${status.cls}">${esc(status.text)}</span>
            <span class="adb-pair-acts">
              <button class="adb-mini" data-act="detail" title="看两端详情">详情</button>
              <button class="adb-mini" data-act="del" title="删除这条配对">删除</button>
            </span>
          </div>
          <div class="adb-pair-detail hidden">
            <div><b>本地</b><span class="mono" title="${esc(p.local)}">${esc(p.local)}</span></div>
            <div><b>大小</b><span>${esc(p.localSizeText || '-')}${p.localExists === false ? '（文件不存在）' : ''}</span></div>
            <div><b>设备</b><span class="mono" title="${esc(p.remote)}">${esc(p.remote)}</span></div>
            <div><b>大小</b><span>${esc(p.remoteExists ? p.remoteSizeText : '设备上还没有')}</span></div>
            <div><b>修改</b><span>${esc(fmtTime(p.localMtime))}</span></div>
          </div>
        </div>
      </div>`;
    });

    box.innerHTML = `<div class="adb-pair-list">${rows.join('')}</div>`;

    box.querySelectorAll('.adb-pair').forEach((row) => {
      const id = row.dataset.id;
      const pair = S.pairs.find((p) => p.id === id);
      if (!pair) return;
      const input = row.querySelector('input');
      input.addEventListener('change', () => {
        pair.checked = input.checked;
        row.classList.toggle('on', input.checked);
        renderPairsCount();
        paintRunState();
        savePairs();
      });
      row.querySelectorAll('.adb-mini').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (btn.dataset.act === 'detail') {
            const d = row.querySelector('.adb-pair-detail');
            d.classList.toggle('hidden');
          } else if (btn.dataset.act === 'del') {
            S.pairs = S.pairs.filter((x) => x.id !== id);
            renderPairs();
            savePairs();
          }
        });
      });
      // 整行也能展开详情，省得非要点那两个小按钮
      const main = row.querySelector('.adb-pair-main');
      if (main) {
        main.addEventListener('click', (ev) => {
          if (ev.target.closest('.adb-mini')) return;
          const d = row.querySelector('.adb-pair-detail');
          if (d) d.classList.toggle('hidden');
        });
      }
    });

    renderPairsFoot();
    paintRunState();
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-start
    paintPackSaveHint();
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-end
  }

  function renderPairsCount() {
    const count = $('adbPairsCount');
    if (!count) return;
    const checked = S.pairs.filter((p) => p.checked !== false).length;
    count.textContent = S.pairs.length ? ` ${S.pairs.length} 组 · 已选 ${checked}` : '';
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-start
    paintPackSaveHint();
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-end
  }

  function pairStatus(p) {
    if (p.localExists === false) return { cls: 'bad', text: '本地文件不存在' };
    if (!S.serial) return { cls: '', text: '待校验' };
    if (p.remoteExists === false) return { cls: 'warn', text: '设备上没有' };
    if (p.sameSize) return { cls: 'muted', text: '大小一致' };
    return { cls: 'todo', text: '待替换' };
  }

  function renderPairsFoot() {
    const foot = $('adbPairsFoot');
    if (!foot) return;
    if (!S.pairs.length) {
      foot.innerHTML = '';
      return;
    }
    foot.innerHTML = `
      <span class="adb-file-count" id="adbPairsHint"></span>
      <button class="btn ghost small" id="adbSelAll">全选</button>
      <button class="btn ghost small" id="adbSelNone">全不选</button>
      <button class="btn ghost small" id="adbDelChecked">删除已选</button>`;

    const hint = $('adbPairsHint');
    const sel = S.pairs.filter((p) => p.checked !== false);
    const bytes = sel.reduce((a, p) => a + (p.localSize || 0), 0);
    if (hint) hint.textContent = `已选 ${sel.length} 组 · ${fmtSize(bytes)}`;

    $('adbSelAll').addEventListener('click', () => {
      S.pairs.forEach((p) => (p.checked = true));
      renderPairs();
      savePairs();
    });
    $('adbSelNone').addEventListener('click', () => {
      S.pairs.forEach((p) => (p.checked = false));
      renderPairs();
      savePairs();
    });
    $('adbDelChecked').addEventListener('click', () => {
      const n = S.pairs.filter((p) => p.checked !== false).length;
      if (!n) return;
      if (!confirm(`删除勾选的 ${n} 组配对？（不会动设备文件）`)) return;
      S.pairs = S.pairs.filter((p) => p.checked === false);
      renderPairs();
      savePairs();
    });
  }

  let saveTimer = 0;
  function savePairs() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = 0;
      try {
        await apiPost('adb-pairs-save', { pairs: S.pairs });
        paintEntry(S.status);
      } catch (err) {
        toast('配对保存失败：' + err.message, true);
      }
    }, 300);
  }

  async function refreshPairs() {
    if (S.busy) return;
    S.busy = true;
    const btn = $('adbPairsRefresh');
    if (btn) btn.disabled = true;
    try {
      await loadPairs();
      toast('已刷新配对状态');
    } finally {
      S.busy = false;
      if (btn) btn.disabled = false;
    }
  }

  /* ---------------- 组合包 ---------------- */
  // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-start

  async function loadPacks() {
    try {
      const data = await apiGet('adb-packs');
      S.packs = data.packs || [];
      renderPacks();
    } catch (err) {
      toast('组合包读取失败：' + err.message, true);
    }
  }

  function renderPacks() {
    const box = $('adbPacks');
    const count = $('adbPacksCount');
    if (!box) return;
    if (count) count.textContent = S.packs.length ? ` ${S.packs.length} 个` : '';
    paintPackSaveHint();

    if (!S.packs.length) {
      box.innerHTML = `<div class="adb-empty">
        <strong>还没有组合包</strong>
        <span>勾选几条配对、取个名字，点「存为组合包」就永久存下来了，之后点「执行」直接跑这一包。</span>
      </div>`;
      return;
    }

    box.innerHTML =
      '<div class="adb-pack-list">' +
      S.packs
        .map((k) => {
          const names = k.pairs.map((p) => baseName(p.local)).join(' · ');
          return `<div class="adb-pack" data-id="${esc(k.id)}">
        <div class="adb-pack-line">
          <span class="adb-pack-name" title="${esc(k.name)}">${esc(k.name)}</span>
          <span class="adb-pack-n">${k.pairs.length} 组</span>
          <span class="adb-pack-files" title="${esc(k.pairs.map((p) => p.local + ' → ' + p.remote).join('\n'))}">${esc(names)}</span>
          <span class="adb-pack-acts">
            <button class="adb-mini go" data-act="run" title="只执行这一包的配对">执行</button>
            <button class="adb-mini" data-act="load" title="把这包的配对设为已选">载入</button>
            <button class="adb-mini" data-act="del" title="删除这个组合包（不影响配对）">删除</button>
          </span>
        </div>
      </div>`;
        })
        .join('') +
      '</div>';

    box.querySelectorAll('.adb-pack').forEach((row) => {
      const id = row.dataset.id;
      row.querySelectorAll('.adb-mini').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const act = btn.dataset.act;
          if (act === 'run') runPack(id);
          else if (act === 'load') loadPack(id);
          else if (act === 'del') delPack(id);
        });
      });
    });
  }

  function paintPackSaveHint() {
    const hint = $('adbPackSaveHint');
    if (!hint) return;
    const n = S.pairs.filter((p) => p.checked !== false).length;
    hint.textContent = n ? `将打包已选 ${n} 组` : '先在上面勾选配对';
  }

  async function savePacks() {
    const out = await apiPost('adb-packs-save', { packs: S.packs });
    S.packs = out.packs || S.packs;
    renderPacks();
  }

  async function savePack() {
    const input = $('adbPackName');
    const name = input ? input.value.trim() : '';
    const sel = S.pairs.filter((p) => p.checked !== false);
    if (!name) {
      toast('先给组合包取个名字', true);
      if (input) input.focus();
      return;
    }
    if (!sel.length) return toast('先在②里勾选要打包的配对', true);

    const pairs = sel.map((p) => ({ local: p.local, remote: p.remote }));
    const exist = S.packs.find((k) => k.name === name);
    if (exist && !confirm(`已有同名组合包「${name}」，用当前勾选的 ${sel.length} 组覆盖它？`)) return;
    if (exist) {
      exist.pairs = pairs;
      exist.updatedAt = Date.now();
    } else {
      S.packs.unshift({
        id: 'k' + Date.now().toString(36),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pairs,
      });
    }
    try {
      await savePacks();
      if (input) input.value = '';
      toast(`已保存组合包「${name}」· ${pairs.length} 组`);
    } catch (err) {
      toast('组合包保存失败：' + err.message, true);
    }
  }

  // 把这包的配对设为唯一选中：找不到的（配对被删过）顺手补回列表
  function loadPack(id) {
    const pack = S.packs.find((k) => k.id === id);
    if (!pack) return;
    const hit = new Set();
    for (const p of pack.pairs) {
      const old = S.pairs.find((x) => x.remote === p.remote);
      if (old) {
        old.checked = true;
        hit.add(old.id);
      } else {
        const fresh = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), local: p.local, remote: p.remote, checked: true };
        S.pairs.unshift(fresh);
        hit.add(fresh.id);
      }
    }
    S.pairs.forEach((p) => {
      if (!hit.has(p.id)) p.checked = false;
    });
    renderPairs();
    savePairs();
    toast(`已载入「${pack.name}」· ${hit.size} 组，可以直接点「执行选中配对」`);
  }

  async function delPack(id) {
    const pack = S.packs.find((k) => k.id === id);
    if (!pack) return;
    if (!confirm(`删除组合包「${pack.name}」？（配对本身不受影响）`)) return;
    S.packs = S.packs.filter((k) => k.id !== id);
    try {
      await savePacks();
      toast('已删除组合包');
    } catch (err) {
      toast('删除失败：' + err.message, true);
    }
  }

  async function runPack(id) {
    const pack = S.packs.find((k) => k.id === id);
    if (!pack) return;
    if (S.running) return toast('正在执行，等这次跑完', true);
    if (!pack.pairs.length) return toast('这个组合包是空的', true);
    const dev = currentDevice(null);
    if (!dev) return toast('没有可用设备', true);

    // 组合包存的是快照，执行前先问服务端本地文件还在不在
    let list = pack.pairs.map((p) => ({ ...p }));
    try {
      const out = await apiPost('adb-check', { serial: dev.serial, pairs: pack.pairs });
      if (out && Array.isArray(out.pairs) && out.pairs.length) list = out.pairs;
    } catch (_) {
      /* 查不到就按原样跑，服务端会按文件报错 */
    }
    const missing = list.filter((p) => p.localExists === false);
    if (missing.length && !confirm(`组合包「${pack.name}」里有 ${missing.length} 个本地文件已不存在，跳过它们继续？`)) return;
    const runnable = list.filter((p) => p.localExists !== false);
    if (!runnable.length) return toast('这个组合包的本地文件都不在了', true);
    startReplace(runnable, pack.name);
  }
  // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-end

  /* ---------------- 添加配对（双栏选择） ---------------- */
  function openPicker() {
    S.view = 'pick';
    const modal = $('adbModal');
    if (!modal) return;
    modal.innerHTML = shellPick();
    bindPick();
    const li = $('adbLocalDir');
    if (li) li.value = S.pick.localDir;
    const ri = $('adbRemoteDir');
    if (ri) ri.value = S.pick.remoteDir;

    // 起点：上次选过的本地目录 → 已存配对的本地目录 → 仓库目录
    if (!S.pick.localDir) {
      const first = S.pairs.find((p) => p.local);
      S.pick.localDir = first ? dirName(first.local) : '';
      if (li) li.value = S.pick.localDir;
    }
    loadLocal(S.pick.localDir);
    loadRemote(S.pick.remoteDir);
  }

  function backToList() {
    S.view = 'list';
    const modal = $('adbModal');
    if (!modal) return;
    modal.innerHTML = shellList();
    bindList();
    renderDeviceBar();
    renderPairs();
    refreshStatus(true);
    loadPairs();
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-start
    loadPacks();
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-end
  }

  async function loadLocal(dir) {
    const list = $('adbLocalList');
    const prev = $('adbLocalPrev');
    if (list) list.innerHTML = '<div class="modal-loading">读取目录…</div>';
    if (prev) prev.innerHTML = '';
    S.pick.localSel = null;
    try {
      const data = await apiGet('adb-local-ls', { dir });
      S.pick.local = data;
      S.pick.localErr = '';
      S.pick.localDir = data.dir;
      localStorage.setItem(LS_LOCAL_DIR, data.dir);
      const inp = $('adbLocalDir');
      if (inp && inp.value !== data.dir) inp.value = data.dir;
      renderLocal();
    } catch (err) {
      S.pick.local = null;
      S.pick.localErr = err.message;
      renderLocal();
    }
    syncPairPreview();
  }

  function renderLocal() {
    const list = $('adbLocalList');
    if (!list) return;
    const d = S.pick.local;
    if (!d) {
      list.innerHTML = `<div class="adb-empty"><strong>读不到这个目录</strong><span>${esc(S.pick.localErr)}</span><span>填一个存在的本地目录，或点「…」浏览。</span></div>`;
      return;
    }
    const rows = [];
    if (d.parent)
      rows.push(`<div class="adb-pick-row dir" data-dir="${esc(d.parent)}"><span class="ic">↑</span><span class="nm">..</span><span class="meta">上一级</span></div>`);
    for (const dir of d.dirs)
      rows.push(`<div class="adb-pick-row dir" data-dir="${esc(dir.path)}"><span class="ic">▸</span><span class="nm">${esc(dir.name)}</span><span class="meta">目录</span></div>`);
    for (const f of d.files)
      rows.push(`<div class="adb-pick-row file" data-path="${esc(f.path)}" data-size="${f.size}" data-mtime="${f.mtime}">
        <span class="ic">·</span><span class="nm">${esc(f.name)}</span><span class="meta">${esc(f.sizeText)}</span></div>`);
    if (!rows.length) rows.push('<div class="adb-empty"><strong>空目录</strong><span>换一个目录看看。</span></div>');
    list.innerHTML = rows.join('');
    list.scrollTop = 0;

    list.querySelectorAll('.adb-pick-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.dir) {
          loadLocal(row.dataset.dir);
          return;
        }
        list.querySelectorAll('.adb-pick-row.file').forEach((r) => r.classList.remove('on'));
        row.classList.add('on');
        S.pick.localSel = {
          path: row.dataset.path,
          name: baseName(row.dataset.path),
          size: Number(row.dataset.size) || 0,
          mtime: Number(row.dataset.mtime) || 0,
        };
        renderLocalPreview();
        syncPairPreview();
      });
    });
  }

  function renderLocalPreview() {
    const box = $('adbLocalPrev');
    if (!box) return;
    const s = S.pick.localSel;
    if (!s) {
      box.innerHTML = '<span class="adb-prev-empty">选中左边任一文件后，这里显示它的信息</span>';
      return;
    }
    box.innerHTML = `<div class="adb-prev-name">${esc(s.name)}</div>
      <div class="adb-prev-row"><b>大小</b><span>${esc(fmtSize(s.size))}</span></div>
      <div class="adb-prev-row"><b>修改</b><span>${esc(fmtTime(s.mtime))}</span></div>
      <div class="adb-prev-row"><b>路径</b><span class="mono path" title="${esc(s.path)}">${esc(midPath(s.path))}</span></div>`;
  }

  async function loadRemote(dir) {
    const list = $('adbRemoteList');
    const prev = $('adbRemotePrev');
    if (list) list.innerHTML = '<div class="modal-loading">读取设备目录…</div>';
    if (prev) prev.innerHTML = '';
    S.pick.remoteSel = null;
    if (!S.serial) {
      S.pick.remote = null;
      S.pick.remoteErr = '没有已连接设备';
      renderRemote();
      syncPairPreview();
      return;
    }
    try {
      const data = await apiGet('adb-remote-ls', { serial: S.serial, dir: dir || DEFAULT_TARGET });
      S.pick.remote = data;
      S.pick.remoteErr = '';
      S.pick.remoteDir = data.dir;
      localStorage.setItem(LS_REMOTE_DIR, data.dir);
      const inp = $('adbRemoteDir');
      if (inp && inp.value !== data.dir) inp.value = data.dir;
      renderRemote();
    } catch (err) {
      S.pick.remote = null;
      S.pick.remoteErr = err.message;
      renderRemote();
    }
    syncPairPreview();
  }

  function renderRemote() {
    const list = $('adbRemoteList');
    if (!list) return;
    const d = S.pick.remote;
    if (!d) {
      list.innerHTML = `<div class="adb-empty"><strong>读不到设备目录</strong><span>${esc(S.pick.remoteErr)}</span></div>`;
      return;
    }
    const rows = [];
    if (d.parent)
      rows.push(`<div class="adb-pick-row dir" data-dir="${esc(d.parent)}"><span class="ic">↑</span><span class="nm">..</span><span class="meta">上一级</span></div>`);
    for (const dir of d.dirs)
      rows.push(`<div class="adb-pick-row dir" data-dir="${esc(dir.path)}"><span class="ic">▸</span><span class="nm">${esc(dir.name)}</span><span class="meta">目录</span></div>`);
    for (const f of d.files)
      rows.push(`<div class="adb-pick-row file" data-path="${esc(f.path)}" data-size="${f.size}">
        <span class="ic">·</span><span class="nm">${esc(f.name)}</span><span class="meta">${esc(f.sizeText)}</span></div>`);
    if (!rows.length) rows.push('<div class="adb-empty"><strong>空目录</strong><span>换一个目录看看。</span></div>');
    list.innerHTML = rows.join('');
    list.scrollTop = 0;

    list.querySelectorAll('.adb-pick-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.dir) {
          loadRemote(row.dataset.dir);
          return;
        }
        list.querySelectorAll('.adb-pick-row.file').forEach((r) => r.classList.remove('on'));
        row.classList.add('on');
        S.pick.remoteSel = {
          path: row.dataset.path,
          name: baseName(row.dataset.path),
          size: Number(row.dataset.size) || 0,
        };
        renderRemotePreview();
        syncPairPreview();
      });
    });
  }

  function renderRemotePreview() {
    const box = $('adbRemotePrev');
    if (!box) return;
    const s = S.pick.remoteSel;
    if (!s) {
      box.innerHTML = '<span class="adb-prev-empty">选中右边任一文件后，这里显示它的信息</span>';
      return;
    }
    box.innerHTML = `<div class="adb-prev-name">${esc(s.name)}</div>
      <div class="adb-prev-row"><b>大小</b><span>${esc(fmtSize(s.size))}</span></div>
      <div class="adb-prev-row"><b>路径</b><span class="mono path" title="${esc(s.path)}">${esc(midPath(s.path))}</span></div>
      <div class="adb-prev-row"><b>说明</b><span>执行时会被本地同名文件覆盖</span></div>`;
  }

  function syncPairPreview() {
    const lbl = $('adbPairPreview');
    const btn = $('adbPairConfirm');
    if (!lbl || !btn) return;
    const l = S.pick.localSel;
    const r = S.pick.remoteSel;
    if (l && r) {
      lbl.innerHTML = `<span class="mono">${esc(l.name)}</span> → <span class="mono">${esc(r.path)}</span>`;
      btn.disabled = false;
    } else {
      lbl.textContent = !l && !r ? '还没有选齐两侧的文件' : !l ? '再选左边的本地文件' : '再选右边的设备文件';
      btn.disabled = true;
    }
  }

  async function confirmPair() {
    const l = S.pick.localSel;
    const r = S.pick.remoteSel;
    if (!l || !r) return;
    const remote = r.path;
    if (S.pairs.some((p) => p.remote === remote)) {
      if (!confirm('设备上这个文件已经配对过了，要用新的本地文件替换这条配对吗？')) return;
      S.pairs = S.pairs.filter((p) => p.remote !== remote);
    }
    S.pairs.unshift({ id: 'p' + Date.now().toString(36), local: l.path, remote, checked: true });
    await apiPost('adb-pairs-save', { pairs: S.pairs });
    toast('已保存配对：' + l.name + ' → ' + remote);
    backToList();
  }

  async function autoPair() {
    if (!S.serial) return toast('没有已连接设备', true);
    const localDir = ($('adbLocalDir') ? $('adbLocalDir').value : S.pick.localDir).trim();
    const remoteDir = ($('adbRemoteDir') ? $('adbRemoteDir').value : S.pick.remoteDir).trim();
    if (!localDir) return toast('先选本地目录', true);
    const ldl = $('adbPairPreview');
    if (ldl) ldl.textContent = '正在按同名文件配对…';
    try {
      const out = await apiPost('adb-auto-pair', { serial: S.serial, localDir, remoteDir });
      if (!out.pairs.length) {
        toast('两侧没有同名文件，试试手动添加配对', true);
        return;
      }
      const exist = new Set(S.pairs.map((p) => p.remote));
      const added = out.pairs.filter((p) => !exist.has(p.remote));
      for (const p of added) {
        S.pairs.unshift({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), local: p.local, remote: p.remote, checked: true });
      }
      await apiPost('adb-pairs-save', { pairs: S.pairs });
      toast(`匹配到 ${out.stats.matched} 组，新增 ${added.length} 组`);
      if (out.stats.missingCount) console.info('设备上缺少：', out.stats.missingInDevice);
      backToList();
    } catch (err) {
      toast(err.message, true);
      syncPairPreview();
    }
  }

  /* ---------------- 执行 ---------------- */

  function paintRunState() {
    const btn = $('adbRunBtn');
    if (!btn) return;
    const dev = currentDevice(null);
    const sel = S.pairs.filter((p) => p.checked !== false);
    btn.disabled = S.running || !dev || !sel.length;
    const hint = $('adbRunHint');
    if (!hint) return;
    if (S.running) hint.textContent = '执行中…';
    else if (!dev) hint.textContent = '先连上设备';
    else if (!sel.length) hint.textContent = '先勾选要执行的配对';
    else hint.textContent = `将执行 ${sel.length} 组配对`;
  }

  function appendLog(text, kind) {
    const pre = $('adbLog');
    if (!pre) return;
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    const span = document.createElement('span');
    span.className = 'adb-line ' + (kind || 'info');
    span.textContent = text + '\n';
    pre.appendChild(span);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function clearLog(placeholder) {
    const pre = $('adbLog');
    if (!pre) return;
    pre.textContent = placeholder || '';
  }

  function stopPoll() {
    if (S.timer) clearInterval(S.timer);
    S.timer = 0;
  }

  function setRunning(on) {
    S.running = on;
    paintRunState();
    const flag = $('adbLogFlag');
    if (flag) flag.textContent = on ? '进行中…' : '';
  }

  // only：指定要执行的一组配对（组合包用）；不传就按②里勾选的那些
  async function startReplace(only, label) {
    if (S.running) return;
    const dev = currentDevice(null);
    if (!dev) return toast('没有可用设备', true);

    let runnable;
    if (Array.isArray(only) && only.length) {
      runnable = only;
    } else {
      const sel = S.pairs.filter((p) => p.checked !== false);
      if (!sel.length) return toast('先勾选要执行的配对', true);
      const missing = sel.filter((p) => p.localExists === false);
      if (missing.length) {
        if (!confirm(`${missing.length} 组配对的本地文件已不存在，跳过它们继续？`)) return;
      }
      runnable = sel.filter((p) => p.localExists !== false);
      if (!runnable.length) return toast('勾选的配对都缺本地文件', true);
    }

    const reboot = $('adbOptReboot').checked;
    const first = runnable[0];
    const who = label ? `组合包「${label}」· ` : '';
    if (
      !confirm(
        `将执行 ${who}${runnable.length} 组配对，覆盖 ${dev.model || dev.serial} 上的目标文件。\n` +
          `例如：${baseName(first.local)} → ${first.remote}\n` +
          (reboot ? '完成后自动重启设备。' : '') +
          '\n\n继续？'
      )
    )
      return;

    clearLog('');
    const res = $('adbResults');
    if (res) res.innerHTML = '';
    S.jobId = '';
    S.cursor = 0;
    setRunning(true);
    appendLog('准备执行：' + who + runnable.length + ' 组配对 → ' + (dev.model || dev.serial), 'head');

    try {
      const out = await apiPost('adb-replace', {
        serial: dev.serial,
        deviceLabel: dev.model || dev.serial,
        pairs: runnable.map((p) => ({ local: p.local, remote: p.remote })),
        backup: $('adbOptBackup').checked,
        chmod: $('adbOptChmod').checked,
        reboot,
      });
      S.jobId = out.jobId;
      S.cursor = 0;
      pollJob();
    } catch (err) {
      setRunning(false);
      appendLog('启动失败：' + err.message, 'error');
      toast(err.message, true);
    }
  }

  function pollJob() {
    stopPoll();
    S.timer = setInterval(async () => {
      try {
        const st = await apiGet('adb-job', { id: S.jobId, from: S.cursor });
        if (st.lines && st.lines.length) {
          for (const line of st.lines) appendLog(line.text, line.kind);
          S.cursor = st.next;
        }
        if (st.results && st.results.length) renderResults(st.results);
        if (st.done) {
          stopPoll();
          setRunning(false);
          const flag = $('adbLogFlag');
          if (flag) flag.textContent = st.ok ? '已完成' : '已完成（有失败）';
          renderResults(st.results || []);
          const box = $('adbResults');
          if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
          toast(st.ok ? '执行完成' + ($('adbOptReboot') && $('adbOptReboot').checked ? '，设备正在重启' : '') : '执行结束，有失败项', !st.ok);
          setTimeout(() => {
            refreshStatus(true);
            loadPairs();
          }, 3000);
        }
      } catch (err) {
        stopPoll();
        setRunning(false);
        appendLog('读取任务状态失败：' + err.message, 'error');
      }
    }, POLL_MS);
  }

  function renderResults(list) {
    const box = $('adbResults');
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = '';
      return;
    }
    const okCount = list.filter((r) => r.ok).length;
    const rows = list
      .map(
        (r) => `<tr class="${r.ok ? 'ok' : 'bad'}">
        <td class="st">${r.ok ? '✓' : '✕'}</td>
        <td class="rel" title="${esc(r.local)}">${esc(r.name || baseName(r.local))}</td>
        <td class="rel" title="${esc(r.remote)}">${esc(r.remote)}</td>
        <td class="num">${r.localSize ? fmtSize(r.localSize) : '-'}</td>
        <td class="num">${r.ms ? (r.ms / 1000).toFixed(1) + 's' : '-'}</td>
        <td class="msg" title="${esc(r.backup || '')}">${esc(r.ok ? '已替换' + (r.backup ? ' · 已备份' : '') : r.msg)}</td>
      </tr>`
      )
      .join('');
    box.innerHTML = `<div class="adb-res-head">执行详情 <span>${okCount}/${list.length} 成功</span></div>
      <table class="adb-res-table">
        <thead><tr><th></th><th>文件</th><th>设备路径</th><th class="num">大小</th><th class="num">耗时</th><th>结果</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  async function showHistory() {
    try {
      const { items } = await apiGet('adb-history');
      if (!items.length) return toast('还没有历史记录');
      const last = items[0];
      renderResults(last.results || []);
      clearLog('');
      appendLog('上次执行：' + fmtTime(last.startedAt) + ' · ' + (last.deviceLabel || last.device), 'head');
      appendLog('共 ' + (last.results || []).length + ' 组配对');
      appendLog('备份目录：.gdv/adb-backup/' + last.id);
      appendLog(last.ok ? '结果：全部成功' : '结果：有失败（详见下方详情表）', last.ok ? 'ok' : 'error');
      const flag = $('adbLogFlag');
      if (flag) flag.textContent = '历史记录';
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------------- 绑定 ---------------- */

  function bindList() {
    const close = $('adbClose');
    if (close) close.addEventListener('click', closePanel);
    const rf = $('adbRefresh');
    if (rf)
      rf.addEventListener('click', async () => {
        S.status = null;
        await refreshStatus(false, true);
        await loadPairs();
        toast('已重新检测');
      });

    const add = $('adbAddPairBtn');
    if (add) add.addEventListener('click', openPicker);
    const auto = $('adbAutoPairBtn');
    if (auto) auto.addEventListener('click', openPicker);
    const ref = $('adbPairsRefresh');
    if (ref) ref.addEventListener('click', refreshPairs);

    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-start
    const packSave = $('adbPackSaveBtn');
    if (packSave) packSave.addEventListener('click', savePack);
    const packName = $('adbPackName');
    if (packName)
      packName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') savePack();
      });
    // prize add by yanliang for 组合包：勾选的配对存成带名字的组合, 20261029-end

    const run = $('adbRunBtn');
    if (run) run.addEventListener('click', () => startReplace());
    const his = $('adbHistoryBtn');
    if (his) his.addEventListener('click', showHistory);
    const copy = $('adbCopyLog');
    if (copy)
      copy.addEventListener('click', async () => {
        const pre = $('adbLog');
        if (!pre) return;
        try {
          await navigator.clipboard.writeText(pre.textContent || '');
          toast('日志已复制');
        } catch (_) {
          toast('复制失败，请手动选中', true);
        }
      });
  }

  function bindPick() {
    const back = $('adbPickBack');
    if (back) back.addEventListener('click', backToList);
    const cancel = $('adbPickCancel');
    if (cancel) cancel.addEventListener('click', backToList);

    const li = $('adbLocalDir');
    if (li) {
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loadLocal(li.value.trim());
      });
    }
    const lup = $('adbLocalUp');
    if (lup)
      lup.addEventListener('click', () => {
        const d = S.pick.local;
        if (d && d.parent) loadLocal(d.parent);
      });
    const lb = $('adbLocalBrowse');
    if (lb)
      lb.addEventListener('click', () => {
        if (typeof window.openFinder !== 'function') return toast('目录选择器不可用', true);
        window.openFinder((picked) => {
          if (li) li.value = picked;
          loadLocal(picked);
        });
      });

    const ri = $('adbRemoteDir');
    if (ri) {
      ri.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loadRemote(ri.value.trim());
      });
    }
    const rup = $('adbRemoteUp');
    if (rup)
      rup.addEventListener('click', () => {
        const d = S.pick.remote;
        if (d && d.parent) loadRemote(d.parent);
      });
    const rgo = $('adbRemoteGo');
    if (rgo) rgo.addEventListener('click', () => loadRemote(ri ? ri.value.trim() : DEFAULT_TARGET));

    const confirmBtn = $('adbPairConfirm');
    if (confirmBtn) confirmBtn.addEventListener('click', confirmPair);
    const autoBtn = $('adbPickAuto');
    if (autoBtn) autoBtn.addEventListener('click', autoPair);
  }

  /* ---------------- 入口 ---------------- */

  function bindEntry() {
    const btn = $('adbBtn');
    if (!btn) return;
    btn.addEventListener('click', openPanel);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !S.open) return;
      if (S.view === 'pick') backToList();
      else closePanel();
    });
    const mask = $('adbMask');
    if (mask) {
      mask.addEventListener('click', (e) => {
        if (e.target === mask) closePanel();
      });
    }
    paintEntry(null);
    refreshStatus(true);
    // 顶栏也要显示配对数，先拉一次
    apiGet('adb-pairs')
      .then((d) => {
        S.pairs = d.pairs || [];
        paintEntry(S.status);
      })
      .catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEntry);
  } else {
    bindEntry();
  }

  window.gdvAdb = { open: openPanel, close: closePanel, refresh: refreshStatus };
})();
// prize add by yanliang 20261029-end
