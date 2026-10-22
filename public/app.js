/* prize add by yanliang  20261022-start
   Git 提交比对工具 —— 前端逻辑
   职责：拉取提交列表 / 解析 unified diff / 渲染并排与内联视图 / 提交间比对 */
'use strict';

/* ---------------- 基础工具 ---------------- */
const $ = (sel) => document.querySelector(sel);

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 0) return '刚刚';
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  if (d < 365 * 86400e3) return Math.floor(d / (30 * 86400e3)) + ' 个月前';
  return Math.floor(d / (365 * 86400e3)) + ' 年前';
}

function fullTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function authorColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 58% 45%)`;
}

function initial(name) {
  const s = String(name || '?').trim();
  return /^[a-zA-Z]/.test(s) ? s.slice(0, 1).toUpperCase() : s.slice(0, 1);
}

let toastTimer = null;
function toast(msg, isError) {
  let box = $('.toast');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.classList.toggle('error', !!isError);
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 1900);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败', true);
  }
}

/* ---------------- 状态 ---------------- */
const state = {
  repo: '',
  info: null,
  ref: 'HEAD',
  commits: [],
  skip: 0,
  hasMore: false,
  loadingCommits: false,
  active: null,        // 当前打开的条目
  detail: null,
  view: localStorage.getItem('gdv.view') || 'split',
  wrap: localStorage.getItem('gdv.wrap') === '1',
  ignoreSpace: localStorage.getItem('gdv.ignoreSpace') === '1',
  theme: localStorage.getItem('gdv.theme') || 'light',
  compare: [],
  collapsed: new Set(),
  filter: '',
};

const MAX_COMPARE = 2;

/* ---------------- 接口 ---------------- */
function api(action, params) {
  const qs = new URLSearchParams({ repo: state.repo, ...params });
  return fetch(`/api/${action}?${qs}`).then(async (res) => {
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '请求失败');
    return data;
  });
}

/* ---------------- 主题 ---------------- */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('#themeToggle').innerHTML =
    state.theme === 'light'
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>';
}

/* ---------------- 语法着色 ---------------- */
// prize add by yanliang for 新增轻量语法着色, 20261022-start
const KEYWORDS = new Set(
  ('const let var function return if else for while do switch case break continue class extends new this super ' +
    'import export from default try catch finally throw async await typeof instanceof in of delete void yield ' +
    'static get set public private protected interface type enum implements package namespace struct fn impl mut ' +
    'pub use mod match where loop trait def elif lambda pass raise with as assert global del print echo then fi ' +
    'done esac select update insert into values where table create index join left right inner outer on group by ' +
    'order having limit and or not is null undefined true false None True False nil echo fi')
    .split(/\s+/)
    .filter(Boolean)
);

function langProfile(file) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  const slash = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'go', 'rs', 'swift', 'scala', 'dart', 'php', 'proto', 'groovy', 'm', 'mm']);
  const hash = new Set(['py', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'rb', 'pl', 'r', 'ps1', 'conf', 'ini', 'dockerfile']);
  const none = new Set(['json', 'css', 'scss', 'less', 'lock', 'log', 'txt', 'md', 'markdown', 'csv', 'tsv']);
  if (slash.has(ext)) return 'slash';
  if (hash.has(ext)) return 'hash';
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'vue' || ext === 'svg') return 'html';
  if (none.has(ext)) return ext === 'css' || ext === 'scss' || ext === 'less' ? 'css' : 'none';
  return 'slash';
}

const RE_SLASH = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;
const RE_HASH = /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
const RE_CSS = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d[\d_]*(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b)|(#[0-9a-fA-F]{3,8}\b)|([A-Za-z_-][\w-]*)/g;

function highlight(text, mode) {
  if (!text) return '';
  const re = mode === 'hash' ? RE_HASH : mode === 'css' ? RE_CSS : mode === 'none' ? null : RE_SLASH;
  if (!re) return esc(text);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out += esc(text.slice(last, m.index));
    const tok = m[0];
    let cls = '';
    if (m[1] || (mode === 'css' && m[4])) cls = 'tk-com';
    else if (m[2]) cls = 'tk-str';
    else if (mode === 'css' && m[4]) cls = 'tk-com';
    else if (m[3]) cls = 'tk-num';
    else if (m[5] && KEYWORDS.has(tok)) cls = 'tk-key';
    out += cls ? `<span class="${cls}">${esc(tok)}</span>` : esc(tok);
    last = m.index + tok.length;
    if (tok.length === 0) re.lastIndex++;
  }
  if (last < text.length) out += esc(text.slice(last));
  return out;
}
// prize add by yanliang for 新增轻量语法着色, 20261022-end

/* ---------------- 词级行内差异 ---------------- */
// prize add by yanliang for 新增行内词级差异计算, 20261022-start
function tokenizeLine(s) {
  return s.match(/[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g) || [];
}

function mergeSegs(arr) {
  const out = [];
  for (const seg of arr) {
    const prev = out[out.length - 1];
    if (prev && prev.c === seg.c) prev.t += seg.t;
    else out.push({ t: seg.t, c: seg.c });
  }
  return out;
}

function wordDiff(aText, bText) {
  const A = tokenizeLine(aText);
  const B = tokenizeLine(bText);
  if (!A.length || !B.length) return null;
  if (A.length > 700 || B.length > 700 || A.length * B.length > 180000) return null;

  const n = A.length;
  const m = B.length;
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] =
        A[i] === B[j]
          ? dp[(i + 1) * W + j + 1] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }

  const left = [];
  const right = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      left.push({ t: A[i], c: false });
      right.push({ t: B[j], c: false });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      left.push({ t: A[i++], c: true });
    } else {
      right.push({ t: B[j++], c: true });
    }
  }
  while (i < n) left.push({ t: A[i++], c: true });
  while (j < m) right.push({ t: B[j++], c: true });

  return { left: mergeSegs(left), right: mergeSegs(right) };
}

function renderSegs(segs, mode) {
  return segs
    .map((s) => {
      const inner = highlight(s.t, mode);
      return s.c ? `<span class="wd">${inner}</span>` : inner;
    })
    .join('');
}
// prize add by yanliang for 新增行内词级差异计算, 20261022-end

/* ---------------- patch 解析 ---------------- */
// prize add by yanliang for 新增 unified diff 解析, 20261022-start
function parsePatch(patch) {
  const files = [];
  if (!patch) return files;

  const lines = patch.split('\n');
  let cur = null;
  let hunk = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = {
        oldPath: m ? m[1] : '',
        newPath: m ? m[2] : '',
        status: 'M',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
        header: line,
      };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') cur.oldPath = p.replace(/^a\//, '');
      else cur.status = 'A';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') cur.newPath = p.replace(/^b\//, '');
      else cur.status = 'D';
      continue;
    }
    if (line.startsWith('new file mode')) { cur.status = 'A'; continue; }
    if (line.startsWith('deleted file mode')) { cur.status = 'D'; continue; }
    if (line.startsWith('rename from')) { cur.status = 'R'; continue; }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(.*)$/.exec(line);
      hunk = {
        head: m ? m[1] : line,
        oldStart: 1,
        newStart: 1,
        section: m ? (m[2] || '').trim() : '',
        lines: [],
      };
      const r = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (r) {
        hunk.oldStart = Number(r[1]);
        hunk.newStart = Number(r[3]);
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (line.startsWith('+')) {
        cur.additions++;
        hunk.lines.push(line);
      } else if (line.startsWith('-')) {
        cur.deletions++;
        hunk.lines.push(line);
      } else if (line.startsWith(' ') || line === '' || line.startsWith('\\')) {
        hunk.lines.push(line);
      }
    }
  }

  for (const f of files) {
    f.path = f.newPath || f.oldPath;
    f.mode = langProfile(f.path);
  }
  return files;
}
// prize add by yanliang for 新增 unified diff 解析, 20261022-end

// prize add by yanliang for 新增并排视图行组装, 20261022-start
function toSplitRows(hunk) {
  const rows = [];
  const src = hunk.lines;
  let i = 0;
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;

  while (i < src.length) {
    const line = src[i];

    if (line.startsWith('-')) {
      const dels = [];
      while (i < src.length && src[i].startsWith('-')) dels.push(src[i++]);
      const adds = [];
      while (i < src.length && src[i].startsWith('+')) adds.push(src[i++]);
      const total = Math.max(dels.length, adds.length);
      for (let k = 0; k < total; k++) {
        const dl = k < dels.length ? { no: oldNo++, text: dels[k].slice(1), type: 'del' } : null;
        const ad = k < adds.length ? { no: newNo++, text: adds[k].slice(1), type: 'add' } : null;
        rows.push({ left: dl, right: ad, pair: !!(dl && ad) });
      }
      continue;
    }

    if (line.startsWith('+')) {
      const adds = [];
      while (i < src.length && src[i].startsWith('+')) adds.push(src[i++]);
      for (const a of adds) {
        rows.push({ left: null, right: { no: newNo++, text: a.slice(1), type: 'add' }, pair: false });
      }
      continue;
    }

    if (line.startsWith('\\')) {
      rows.push({ note: '文件末尾没有换行符' });
      i++;
      continue;
    }

    if (line.startsWith(' ') || line === '') {
      const text = line.slice(1);
      rows.push({
        left: { no: oldNo++, text, type: 'ctx' },
        right: { no: newNo++, text, type: 'ctx' },
        pair: true,
        context: true,
      });
      i++;
      continue;
    }

    i++;
  }
  return rows;
}
// prize add by yanliang for 新增并排视图行组装, 20261022-end

/* ---------------- diff 渲染 ---------------- */
const MAX_LINES_PER_FILE = 2600;

function renderFileHead(f, collapsed) {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
  const base = f.path.slice(dir.length);
  const bars = [];
  const total = f.additions + f.deletions;
  const slots = Math.min(5, Math.max(1, Math.ceil(total / 12)));
  const addSlots = total ? Math.round((f.additions / total) * slots) : 0;
  if (total) {
    for (let i = 0; i < slots; i++) {
      bars.push(`<i style="background:${i < addSlots ? 'var(--add-text)' : 'var(--del-text)'};opacity:.7"></i>`);
    }
  }

  const renamed = f.status === 'R' && f.oldPath && f.oldPath !== f.newPath;
  const nameHtml = renamed
    ? `<span class="dir">${esc(f.oldPath)}</span><span class="arrow">→</span><span class="base">${esc(f.newPath)}</span>`
    : `${dir ? `<span class="dir">${esc(dir)}</span>` : ''}<span class="base">${esc(base)}</span>`;

  return `<div class="file-head" data-file="${esc(f.path)}">
    <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    <span class="file-status st-${f.status}">${f.status}</span>
    <span class="file-name">${nameHtml}</span>
    <span class="file-stat">
      <span class="stat-bars">${bars.join('')}</span>
      <span class="stat-add">+${f.additions}</span>
      <span class="stat-del">-${f.deletions}</span>
    </span>
  </div>`;
}

function hunkHead(hunk) {
  return `<div class="hunk-head"><span class="hunk-range">${esc(hunk.head.trim())}</span>${
    hunk.section ? ` <span class="hunk-fn">${esc(hunk.section)}</span>` : ''
  }</div>`;
}

function renderSplitView(f) {
  let html = '';
  let budget = MAX_LINES_PER_FILE;

  for (const hunk of f.hunks) {
    if (budget <= 0) break;
    const rows = toSplitRows(hunk);
    const shown = rows.slice(0, budget);
    budget -= shown.length;

    html += hunkHead(hunk);
    html += `<div class="drows${state.wrap ? ' wrap' : ''}">`;

    for (const r of shown) {
      if (r.note) {
        html += `<div class="drow r-note"><div class="note">\\ ${esc(r.note)}</div></div>`;
        continue;
      }

      const L = r.left;
      const R = r.right;
      let lCode = '';
      let rCode = '';

      if (r.pair && !r.context && L && R && L.text !== R.text) {
        const d = wordDiff(L.text, R.text);
        if (d) {
          lCode = renderSegs(d.left, f.mode);
          rCode = renderSegs(d.right, f.mode);
        }
      }
      if (!lCode && L) lCode = highlight(L.text, f.mode);
      if (!rCode && R) rCode = highlight(R.text, f.mode);

      const lCls = L ? (L.type === 'add' ? 'r-add' : L.type === 'del' ? 'r-del' : '') : 'r-empty';
      const rCls = R ? (R.type === 'add' ? 'r-add' : R.type === 'del' ? 'r-del' : '') : 'r-empty';

      html += `<div class="drow">
        <div class="ln ${lCls}">${L ? L.no : ''}</div>
        <div class="code ${lCls} wrap-gutter">${lCode}</div>
        <div class="ln ${rCls}">${R ? R.no : ''}</div>
        <div class="code ${rCls}">${rCode}</div>
      </div>`;
    }

    html += '</div>';
  }

  if (budget <= 0) {
    html += `<div class="empty-note">该文件差异过大，仅显示前 ${MAX_LINES_PER_FILE} 行（可用命令 git show 查看完整内容）</div>`;
  }
  return html;
}

function renderInlineView(f) {
  let html = '';
  let budget = MAX_LINES_PER_FILE;
  let oldNo = 0;
  let newNo = 0;

  for (const hunk of f.hunks) {
    if (budget <= 0) break;
    oldNo = hunk.oldStart;
    newNo = hunk.newStart;

    html += hunkHead(hunk);
    html += `<div class="drows inline${state.wrap ? ' wrap' : ''}">`;

    let used = 0;
    for (const line of hunk.lines) {
      if (used >= budget) break;
      used++;

      let cls = '';
      let no = '';
      let text = line;

      if (line.startsWith('+')) {
        cls = 'r-add';
        no = newNo++;
        text = line.slice(1);
      } else if (line.startsWith('-')) {
        cls = 'r-del';
        no = oldNo++;
        text = line.slice(1);
      } else if (line.startsWith('\\')) {
        html += `<div class="drow r-note"><div class="note">\\ 文件末尾没有换行符</div></div>`;
        continue;
      } else {
        no = newNo++;
        oldNo++;
        text = line.slice(1);
      }

      html += `<div class="drow"><div class="ln ${cls}">${no}</div><div class="code ${cls}">${highlight(
        text,
        f.mode
      )}</div></div>`;
    }

    budget -= used;
    html += '</div>';
  }

  if (budget <= 0) {
    html += `<div class="empty-note">该文件差异过大，仅显示前 ${MAX_LINES_PER_FILE} 行</div>`;
  }
  return html;
}

function renderFileBlock(f) {
  const collapsed = state.collapsed.has(f.path);
  let body = '';
  if (f.binary) {
    body = '<div class="binary-note">二进制文件，不显示逐行差异</div>';
  } else if (!f.hunks.length) {
    body = `<div class="empty-note">${f.status === 'R' ? '文件重命名，内容未变化' : '无文本差异'}</div>`;
  } else {
    body = state.view === 'split' ? renderSplitView(f) : renderInlineView(f);
  }

  return `<section class="file-block${collapsed ? ' collapsed' : ''}" data-file="${esc(f.path)}">
    ${renderFileHead(f, collapsed)}
    <div class="file-body"${collapsed ? ' style="display:none"' : ''}>${body}</div>
  </section>`;
}

function renderDiff() {
  const d = state.detail;
  if (!d) return;

  const files = parsePatch(d.patch || '');
  if (d.untracked && d.untracked.length) {
    files.push({
      path: '__untracked__',
      status: 'A',
      hunks: [],
      additions: 0,
      deletions: 0,
      binary: false,
      untrackedOnly: true,
      mode: 'none',
    });
  }

  const sumAdd = files.reduce((s, f) => s + (f.untrackedOnly ? 0 : f.additions), 0);
  const sumDel = files.reduce((s, f) => s + (f.untrackedOnly ? 0 : f.deletions), 0);

  if (!files.length) {
    $('#diffScroll').innerHTML = '<div class="skeleton">这次提交没有文件改动</div>';
    return;
  }

  let html = files
    .map((f) => {
      if (f.untrackedOnly) {
        return `<section class="file-block" data-file="__untracked__">
          <div class="file-head">
            <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            <span class="file-status st-A">A</span>
            <span class="file-name"><span class="base">未跟踪的新文件</span></span>
            <span class="file-stat">${d.untracked.length} 个</span>
          </div>
          <div class="file-body"><div class="empty-note">${d.untracked.map(esc).join('<br>')}</div></div>
        </section>`;
      }
      return renderFileBlock(f);
    })
    .join('');

  $('#diffScroll').innerHTML = html;
  applyFilter();

  const scroll = $('#diffScroll');
  scroll.dataset.count = files.filter((f) => !f.untrackedOnly).length;
  scroll.dataset.add = sumAdd;
  scroll.dataset.del = sumDel;
  renderToolbar();
}

/* ---------------- 工具条 ---------------- */
function renderToolbar() {
  const scroll = $('#diffScroll');
  const count = scroll.dataset.count || '0';
  const add = scroll.dataset.add || '0';
  const del = scroll.dataset.del || '0';

  $('#diffToolbar').innerHTML = `
    <div class="seg" id="viewSeg">
      <button data-view="split" class="${state.view === 'split' ? 'on' : ''}">并排</button>
      <button data-view="inline" class="${state.view === 'inline' ? 'on' : ''}">内联</button>
    </div>
    <button class="btn small ${state.ignoreSpace ? 'active' : ''}" id="ignoreSpace" title="忽略空格与缩进变化">忽略空白</button>
    <button class="btn small ${state.wrap ? 'active' : ''}" id="wrapToggle" title="超长代码行自动折行">自动换行</button>
    <input class="file-filter" id="fileFilter" placeholder="筛选文件…" value="${esc(state.filter)}" />
    <div class="toolbar-spacer"></div>
    <span class="fact">${count} 个文件 <span class="stat-add">+${add}</span> <span class="stat-del">-${del}</span></span>
  `;
}

function applyFilter() {
  const q = state.filter.trim().toLowerCase();
  document.querySelectorAll('.file-block').forEach((block) => {
    const path = block.dataset.file || '';
    block.style.display = !q || path.toLowerCase().includes(q) ? '' : 'none';
  });
}

/* ---------------- 提交头部 ---------------- */
function renderCommitHead() {
  const d = state.detail;
  const head = $('#commitHead');
  if (!d) {
    head.innerHTML = '';
    return;
  }

  if (d.kind === 'working') {
    head.innerHTML = `
      <h1 class="commit-title">工作区未提交的改动</h1>
      <div class="commit-facts">
        <span class="fact">包含已暂存与未暂存的修改</span>
        ${
          d.untracked && d.untracked.length
            ? `<span class="fact" style="color:var(--text-3)">另有 ${d.untracked.length} 个未跟踪文件</span>`
            : ''
        }
      </div>`;
    return;
  }

  if (d.kind === 'compare') {
    head.innerHTML = `
      <h1 class="commit-title">跨提交比对</h1>
      <div class="commit-facts">
        <span class="fact">起点 <code data-copy="${esc(d.base)}">${esc(d.base.slice(0, 10))}</code></span>
        <span class="fact">终点 <code data-copy="${esc(d.head)}">${esc(d.head.slice(0, 10))}</code></span>
      </div>`;
    return;
  }

  const lines = (d.message || '').split('\n');
  const title = lines[0] || '(无提交说明)';
  const body = lines.slice(1).join('\n').trim();
  const refs = (d.refs || [])
    .map((r) => `<span class="ref-badge">${esc(r)}</span>`)
    .join('');

  head.innerHTML = `
    <h1 class="commit-title">${esc(title)} ${refs}</h1>
    ${body ? `<pre class="commit-desc">${esc(body)}</pre>` : ''}
    <div class="commit-facts">
      <span class="fact">
        <span class="avatar" style="background:${authorColor(d.author)}">${esc(initial(d.author))}</span>
        ${esc(d.author)}
      </span>
      <span class="fact">${esc(fullTime(d.authorDate || d.commitDate))}</span>
      <span class="fact"><code data-copy="${esc(d.hash)}" title="点击复制完整 hash">${esc(d.short)}</code></span>
      ${d.parents && d.parents.length ? `<span class="fact" style="color:var(--text-3)">父提交 ${esc(d.parents.map((p) => p.slice(0, 7)).join(', '))}</span>` : ''}
      ${d.isMerge ? '<span class="fact" style="color:var(--text-3)">合并提交，按与第一个父提交的差异显示</span>' : ''}
    </div>`;
}

/* ---------------- 提交列表 ---------------- */
function commitItemHtml(c, idx) {
  const checked = state.compare.includes(c.hash);
  const active = state.active && state.active.hash === c.hash;
  const refHtml = (c.refs || []).slice(0, 2).map((r) => `<span class="ref-badge">${esc(r)}</span>`).join('');

  return `<li class="commit-item${active ? ' active' : ''}${checked ? ' checked' : ''}" data-idx="${idx}">
    <div class="commit-subject">${esc(c.subject || '(无说明)')}</div>
    <div class="commit-meta">
      <span class="avatar" style="background:${authorColor(c.author)}">${esc(initial(c.author))}</span>
      <span class="commit-author">${esc(c.author)}</span>
      <span class="dot">·</span>
      <span class="commit-hash">${esc(c.short)}</span>
      ${refHtml}
      <span class="commit-time" title="${esc(fullTime(c.date))}">${esc(relTime(c.date))}</span>
    </div>
    <span class="commit-check" data-check="${idx}" title="加入比对"></span>
  </li>`;
}

function renderCommitList() {
  const list = $('#commitList');
  const worktreeItem = `<li class="commit-item worktree${
    state.active && state.active.kind === 'working' ? ' active' : ''
  }" data-worktree="1">
    <div class="commit-subject">工作区改动（未提交）</div>
    <div class="commit-meta"><span class="commit-hash">WORKTREE</span></div>
  </li>`;

  const hasWorktree = state.info && state.info.dirtyCount > 0;
  list.innerHTML = (hasWorktree ? worktreeItem : '') + state.commits.map((c, i) => commitItemHtml(c, i)).join('');
  $('#listFoot').textContent = state.loadingCommits
    ? '加载中…'
    : state.commits.length
      ? state.hasMore
        ? '滚动加载更多'
        : `共 ${state.commits.length} 个提交`
      : '';
}

/* ---------------- 仓库信息 ---------------- */
function renderRepoCard() {
  const info = state.info;
  const card = $('#repoCard');
  if (!info) {
    card.innerHTML = `<div class="repo-empty">
      <div class="repo-empty-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>
      <p>填入本地仓库路径后打开<br /><span>只读访问，不会修改任何文件</span></p>
    </div>`;
    return;
  }

  card.innerHTML = `
    <div class="repo-title"><strong>${esc(info.name)}</strong></div>
    <div class="repo-path">${esc(info.repo)}</div>
    <div class="repo-chips">
      <span class="chip">${esc(info.branch || 'detached')}</span>
      <span class="chip">HEAD ${esc(info.head || '—')}</span>
      ${info.dirtyCount ? `<span class="chip warn" id="dirtyChip">${info.dirtyCount} 处未提交改动</span>` : ''}
    </div>`;
}

/* ---------------- 数据加载 ---------------- */
async function loadCommits(reset) {
  if (state.loadingCommits || !state.repo) return;
  state.loadingCommits = true;
  if (reset) {
    state.commits = [];
    state.skip = 0;
    renderCommitList();
  } else {
    $('#listFoot').textContent = '加载中…';
  }

  try {
    const data = await api('commits', {
      ref: state.ref,
      skip: state.skip,
      limit: 60,
    });
    state.commits = state.commits.concat(data.commits);
    state.skip = state.commits.length;
    state.hasMore = data.hasMore;
    renderCommitList();
  } catch (err) {
    toast(err.message, true);
    $('#listFoot').textContent = '加载失败';
  } finally {
    state.loadingCommits = false;
    $('#listFoot').textContent = state.hasMore ? '滚动加载更多' : `共 ${state.commits.length} 个提交`;
  }
}

async function openRepo(path) {
  if (!path.trim()) {
    toast('请先填写仓库路径', true);
    return;
  }
  try {
    state.repo = path.trim();
    const info = await fetch(`/api/repo?repo=${encodeURIComponent(state.repo)}`).then(async (r) => {
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || '打开失败');
      return d;
    });

    state.repo = info.repo;
    state.info = info;
    localStorage.setItem('gdv.repo', state.repo);
    $('#repoPath').value = state.repo;

    const refSelect = $('#refSelect');
    const branches = info.refs.filter((r) => r.kind !== 'remote' || /^origin\//.test(r.name));
    refSelect.innerHTML =
      `<option value="HEAD">HEAD（当前）</option>` +
      branches.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
    refSelect.value = 'HEAD';
    state.ref = 'HEAD';

    state.active = null;
    state.detail = null;
    state.compare = [];
    state.collapsed.clear();
    renderRepoCard();
    renderCompareBar();
    showEmpty('选择一个提交', '查看它改动了哪些文件、每一行的增删，也可以勾选两个提交做跨版本比对。');

    await loadCommits(true);
  } catch (err) {
    state.info = null;
    renderRepoCard();
    toast(err.message, true);
  }
}

async function openCommit(hash) {
  try {
    $('#detailEmpty').classList.add('hidden');
    $('#detailBody').classList.remove('hidden');
    $('#commitHead').innerHTML = '<div class="skeleton">读取提交详情…</div>';
    $('#diffScroll').innerHTML = '';

    const detail = await api('commit', { hash, ignoreSpace: state.ignoreSpace ? '1' : '0' });
    state.detail = detail;
    state.active = { hash: detail.hash, kind: 'commit' };
    state.collapsed.clear();
    state.filter = '';

    renderCommitList();
    renderCommitHead();
    renderDiff();
    $('#diffScroll').scrollTop = 0;
  } catch (err) {
    toast(err.message, true);
  }
}

async function openWorkingTree() {
  try {
    $('#detailEmpty').classList.add('hidden');
    $('#detailBody').classList.remove('hidden');
    $('#commitHead').innerHTML = '<div class="skeleton">读取工作区改动…</div>';
    $('#diffScroll').innerHTML = '';

    const detail = await api('working', { ignoreSpace: state.ignoreSpace ? '1' : '0' });
    state.detail = detail;
    state.active = { kind: 'working' };
    state.collapsed.clear();
    state.filter = '';

    renderCommitList();
    renderCommitHead();
    renderDiff();
    $('#diffScroll').scrollTop = 0;
  } catch (err) {
    toast(err.message, true);
  }
}

async function openComparison(base, head) {
  try {
    $('#detailEmpty').classList.add('hidden');
    $('#detailBody').classList.remove('hidden');
    $('#commitHead').innerHTML = '<div class="skeleton">比对两个提交…</div>';
    $('#diffScroll').innerHTML = '';

    const detail = await api('compare', { base, head, ignoreSpace: state.ignoreSpace ? '1' : '0' });
    state.detail = detail;
    state.active = { kind: 'compare' };
    state.collapsed.clear();
    state.filter = '';

    renderCommitList();
    renderCommitHead();
    renderDiff();
    $('#diffScroll').scrollTop = 0;
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 比对选择 ---------------- */
function renderCompareBar() {
  const bar = $('#compareBar');
  if (!state.compare.length) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const names = state.compare.map((h) => h.slice(0, 7));
  $('#compareText').textContent =
    state.compare.length === 2
      ? `${names[0]} → ${names[1]}`
      : `已选 ${names[0]}，再选一个提交作为终点`;
  $('#runCompare').disabled = state.compare.length !== 2;
  $('#runCompare').style.opacity = state.compare.length === 2 ? '1' : '.5';
}

function toggleCompare(hash) {
  const i = state.compare.indexOf(hash);
  if (i >= 0) {
    state.compare.splice(i, 1);
  } else {
    if (state.compare.length >= MAX_COMPARE) {
      toast('最多选择两个提交比对');
      return;
    }
    state.compare.push(hash);
  }
  renderCompareBar();
  renderCommitList();
}

/* ---------------- 视图切换 ---------------- */
function setView(view) {
  if (state.view === view) return;
  state.view = view;
  localStorage.setItem('gdv.view', view);
  if (state.detail) {
    const top = $('#diffScroll').scrollTop;
    renderDiff();
    $('#diffScroll').scrollTop = top;
  }
}

function showEmpty(title, desc) {
  $('#detailBody').classList.add('hidden');
  const empty = $('#detailEmpty');
  empty.classList.remove('hidden');
  empty.innerHTML = `<h2>${esc(title)}</h2><p>${esc(desc)}</p>`;
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $('#openRepo').addEventListener('click', () => openRepo($('#repoPath').value));
  $('#repoPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openRepo($('#repoPath').value);
  });

  $('#refSelect').addEventListener('change', (e) => {
    state.ref = e.target.value;
    loadCommits(true);
  });

  $('#search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.commit-item').forEach((item) => {
      const text = item.textContent.toLowerCase();
      item.style.display = !q || text.includes(q) ? '' : 'none';
    });
  });

  $('#themeToggle').addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('gdv.theme', state.theme);
    applyTheme();
  });

  $('#commitList').addEventListener('click', (e) => {
    const item = e.target.closest('.commit-item');
    if (!item) return;

    if (e.target.closest('.commit-check')) {
      e.stopPropagation();
      const idx = Number(item.dataset.check);
      const commit = state.commits[idx];
      if (commit) toggleCompare(commit.hash);
      return;
    }

    if (item.dataset.worktree) {
      openWorkingTree();
      return;
    }
    const idx = Number(item.dataset.idx);
    const commit = state.commits[idx];
    if (commit) openCommit(commit.hash);
  });

  $('#commitList').addEventListener('scroll', () => {
    const el = $('#commitList');
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 120 && state.hasMore && !state.loadingCommits) {
      loadCommits(false);
    }
  });

  $('#runCompare').addEventListener('click', () => {
    if (state.compare.length === 2) openComparison(state.compare[0], state.compare[1]);
  });

  $('#clearCompare').addEventListener('click', () => {
    state.compare = [];
    renderCompareBar();
    renderCommitList();
  });

  // 工具条（事件委托，因为工具条会重渲染）
  $('#diffToolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('#viewSeg button');
    if (btn) {
      setView(btn.dataset.view);
      return;
    }
    if (e.target.closest('#wrapToggle')) {
      state.wrap = !state.wrap;
      localStorage.setItem('gdv.wrap', state.wrap ? '1' : '0');
      if (state.detail) {
        const top = $('#diffScroll').scrollTop;
        renderDiff();
        $('#diffScroll').scrollTop = top;
      }
      return;
    }
    if (e.target.closest('#ignoreSpace')) {
      state.ignoreSpace = !state.ignoreSpace;
      localStorage.setItem('gdv.ignoreSpace', state.ignoreSpace ? '1' : '0');
      if (state.detail) {
        if (state.detail.kind === 'commit') openCommit(state.detail.hash);
        else if (state.detail.kind === 'working') openWorkingTree();
        else if (state.detail.kind === 'compare') openComparison(state.detail.base, state.detail.head);
      }
    }
  });

  $('#diffToolbar').addEventListener('input', (e) => {
    if (e.target.id === 'fileFilter') {
      state.filter = e.target.value;
      applyFilter();
    }
  });

  $('#diffScroll').addEventListener('click', (e) => {
    const head = e.target.closest('.file-head');
    if (head) {
      const block = head.closest('.file-block');
      const path = block.dataset.file;
      const body = block.querySelector('.file-body');
      const collapsed = block.classList.toggle('collapsed');
      if (body) body.style.display = collapsed ? 'none' : '';
      if (collapsed) state.collapsed.add(path);
      else state.collapsed.delete(path);
      return;
    }
    const code = e.target.closest('[data-copy]');
    if (code) copyText(code.dataset.copy);
  });

  $('#diffScroll').addEventListener('copy', (e) => {
    const sel = window.getSelection().toString();
    if (!sel) return;
    // 去掉行号，只保留代码正文
    e.clipboardData.setData('text/plain', sel);
  });

  // 键盘导航
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
    if (!state.commits.length) return;

    const cur = state.active && state.active.hash ? state.commits.findIndex((c) => c.hash === state.active.hash) : -1;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = state.commits[Math.min(cur + 1, state.commits.length - 1)];
      if (next && next.hash !== (state.active && state.active.hash)) openCommit(next.hash);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = state.commits[Math.max(cur - 1, 0)];
      if (prev && prev.hash !== (state.active && state.active.hash)) openCommit(prev.hash);
    }
  });

  // 侧栏拖拽
  const resizer = $('#resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(Math.max(e.clientX, 240), 620);
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    localStorage.setItem('gdv.sidebar', String(w));
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
  });
}

// prize add by yanliang for 初始化页面, 20261022-start
async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'inline' || params.get('view') === 'split') {
    state.view = params.get('view');
  }
  if (params.get('theme') === 'dark' || params.get('theme') === 'light') {
    state.theme = params.get('theme');
  }
  if (params.get('wrap') === '1') state.wrap = true;

  applyTheme();
  const savedWidth = localStorage.getItem('gdv.sidebar');
  if (savedWidth) document.documentElement.style.setProperty('--sidebar-w', savedWidth + 'px');

  bindEvents();
  state.filter = '';
  renderCompareBar();

  // 支持 http://127.0.0.1:7391/?repo=D:\code\xxx&commit=abc1234 直接定位
  const paramRepo = params.get('repo');
  const lastRepo = paramRepo || localStorage.getItem('gdv.repo');
  if (lastRepo) {
    $('#repoPath').value = lastRepo;
    await openRepo(lastRepo);

    const commit = params.get('commit');
    const cmp = params.get('cmp');
    if (cmp && cmp.includes('..')) {
      const [base, head] = cmp.split('..');
      openComparison(base, head);
    } else if (params.get('working') === '1') {
      openWorkingTree();
    } else if (commit) {
      openCommit(commit);
    }
  } else {
    renderRepoCard();
    $('#repoPath').focus();
  }
}

document.addEventListener('DOMContentLoaded', init);
// prize add by yanliang for 初始化页面, 20261022-end
/* prize add by yanliang for 新增前端逻辑, 20261022-end */
