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
  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-start
  splitRatio: Number(localStorage.getItem('gdv.splitRatio')) || 0.5,
  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-end
  wrap: localStorage.getItem('gdv.wrap') === '1',
  ignoreSpace: localStorage.getItem('gdv.ignoreSpace') === '1',
  theme: localStorage.getItem('gdv.theme') || 'light',
  compare: [],
  // prize add by yanliang for 左树右 diff 双栏布局：记录当前选中文件与解析后的文件列表, 20261022-start
  selected: '',
  files: [],
  // prize add by yanliang for 左树右 diff 双栏布局：记录当前选中文件与解析后的文件列表, 20261022-end
  // prize add by yanliang for 记住被折叠的目录, 20261022-start
  collapsedDirs: new Set(),
  // prize add by yanliang for 记住被折叠的目录, 20261022-end
  filter: '',
  // prize add by yanliang for 提交面板状态：暂存区数据、勾选集合、amend 与提交说明, 20261022-start
  commitOpen: false,
  commitData: null,
  commitSel: new Set(),
  commitAmend: false,
  commitMsg: '',
  commitBusy: false,
  // prize add by yanliang for 提交面板状态：暂存区数据、勾选集合、amend 与提交说明, 20261022-end
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

// prize add by yanliang for 新增带 JSON 体的接口调用（工作区写操作）, 20261022-start
function postApi(action, payload) {
  return fetch(`/api/${action}?repo=${encodeURIComponent(state.repo)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '请求失败');
    return data;
  });
}
// prize add by yanliang for 新增带 JSON 体的接口调用（工作区写操作）, 20261022-end

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
    // prize add by yanliang for hunk 内按余量消费，避免正文里出现 --- / +++ 被当成文件头, 20261022-start
    const inHunk = !!(hunk && (hunk.oldRemain > 0 || hunk.newRemain > 0));
    // prize add by yanliang for hunk 内按余量消费，避免正文里出现 --- / +++ 被当成文件头, 20261022-end

    if (!inHunk && line.startsWith('diff --git ')) {
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

    // prize add by yanliang for hunk 内容按余量消费, 20261022-start
    if (inHunk) {
      if (line.startsWith('+')) {
        cur.additions++;
        hunk.lines.push(line);
        hunk.newRemain--;
      } else if (line.startsWith('-')) {
        cur.deletions++;
        hunk.lines.push(line);
        hunk.oldRemain--;
      } else if (line.startsWith('\\')) {
        hunk.lines.push(line);
      } else {
        // 上下文行正常带一个前导空格；尾部空行按空白上下文兜底
        hunk.lines.push(line === '' ? ' ' : line);
        hunk.oldRemain--;
        hunk.newRemain--;
      }
      continue;
    }
    // prize add by yanliang for hunk 内容按余量消费, 20261022-end

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
        // prize add by yanliang for 记录本 hunk 两侧剩余行数, 20261022-start
        oldRemain: 0,
        newRemain: 0,
        // prize add by yanliang for 记录本 hunk 两侧剩余行数, 20261022-end
      };
      const r = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (r) {
        hunk.oldStart = Number(r[1]);
        hunk.newStart = Number(r[3]);
        // prize add by yanliang for 记录本 hunk 两侧剩余行数, 20261022-start
        hunk.oldRemain = r[2] === undefined ? 1 : Number(r[2]);
        hunk.newRemain = r[4] === undefined ? 1 : Number(r[4]);
        // prize add by yanliang for 记录本 hunk 两侧剩余行数, 20261022-end
      }
      cur.hunks.push(hunk);
      continue;
    }
  }

  // prize add by yanliang for 同一路径只保留一个文件条目，避免目录徽标数与实际行数对不上, 20261022-start
  const uniq = [];
  const seen = new Map();
  for (const f of files) {
    const path = f.newPath || f.oldPath;
    const prev = seen.get(path);
    if (!prev) {
      seen.set(path, f);
      uniq.push(f);
      continue;
    }
    prev.hunks.push(...f.hunks);
    prev.additions += f.additions;
    prev.deletions += f.deletions;
    prev.binary = prev.binary || f.binary;
  }

  for (const f of uniq) {
    f.path = f.newPath || f.oldPath;
    f.mode = langProfile(f.path);
  }
  return uniq;
  // prize add by yanliang for 同一路径只保留一个文件条目，避免目录徽标数与实际行数对不上, 20261022-end
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

// prize add by yanliang for 文件头改为树内节点，只显示文件名并支持按层级缩进, 20261022-start
function baseName(p) {
  const s = String(p || '');
  return s.slice(s.lastIndexOf('/') + 1);
}

function renderStatBars(add, del) {
  const total = add + del;
  if (!total) return '';
  const slots = Math.min(5, Math.max(1, Math.ceil(total / 12)));
  const addSlots = Math.round((add / total) * slots);
  let bars = '';
  for (let i = 0; i < slots; i++) {
    bars += `<i style="background:${i < addSlots ? 'var(--add-text)' : 'var(--del-text)'};opacity:.7"></i>`;
  }
  return `<span class="stat-bars">${bars}</span>`;
}

// prize add by yanliang for 文件与目录行内的 git 操作按钮, 20261022-start
function renderRowOps(ops, scope) {
  if (!ops) return '';
  const btn = (op, text, title) =>
    `<button class="row-op" data-op="${op}" data-scope="${scope}" title="${esc(title)}">${text}</button>`;
  let html = '';
  if (ops.stage) html += btn('stage', '暂存', 'git add');
  if (ops.unstage) html += btn('unstage', '取消暂存', 'git reset HEAD --');
  if (ops.ignore) html += btn('ignore', '忽略', '写入 .git/info/exclude');
  return html ? `<span class="row-ops">${html}</span>` : '';
}
// prize add by yanliang for 文件与目录行内的 git 操作按钮, 20261022-end

// prize add by yanliang for 左侧文件树只列文件名，diff 改由右侧面板展示, 20261022-start
function renderFileRow(f, depth) {
  const base = baseName(f.path);
  const renamed = f.status === 'R' && f.oldPath && f.oldPath !== f.newPath;
  const nameHtml = renamed
    ? `<span class="base">${esc(baseName(f.oldPath))}</span><span class="arrow">→</span><span class="base">${esc(base)}</span>`
    : `<span class="base">${esc(base)}</span>`;

  const on = f.path === state.selected;
  return `<div class="file-block${on ? ' on' : ''}" data-file="${esc(f.path)}">
    <div class="file-head" title="${esc(f.path)}" style="padding-left:${10 + depth * 11 + 20}px">
      <span class="file-status st-${f.status}">${f.status}</span>
      ${f.staged ? '<span class="staged-dot" title="已在暂存区"></span>' : ''}
      <span class="file-name">${nameHtml}</span>
    </div>
  </div>`;
}
// prize add by yanliang for 左侧文件树只列文件名，diff 改由右侧面板展示, 20261022-end

/* ---------------- 文件目录树 ---------------- */
// prize add by yanliang for 按项目目录树组织改动文件, 20261022-start
function buildFileTree(files) {
  const root = { name: '', path: '', dirs: [], files: [] };

  for (const f of files) {
    const parts = String(f.path || '').split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let next = node.dirs.find((x) => x.name === name);
      if (!next) {
        next = { name, path: node.path ? `${node.path}/${name}` : name, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push({ name: parts[parts.length - 1], file: f });
  }

  compactDirs(root);

  const sortNode = (n) => {
    n.dirs.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => b.file.additions + b.file.deletions - (a.file.additions + a.file.deletions) || a.name.localeCompare(b.name));
    n.dirs.forEach(sortNode);
  };
  sortNode(root);

  sumTree(root);
  return root;
}

// 目录链压缩：中间层若只有一个子目录且没有文件，就合并成一行，避免深层路径把文件名挤没
function compactDirs(node) {
  for (const d of node.dirs) compactDirs(d);
  for (const d of node.dirs) {
    while (!d.files.length && d.dirs.length === 1) {
      const only = d.dirs[0];
      d.name = `${d.name}/${only.name}`;
      d.path = `${d.path}/${only.name}`;
      d.dirs = only.dirs;
      d.files = only.files;
    }
  }
}

function sumTree(node) {
  let add = 0;
  let del = 0;
  let count = 0;
  for (const d of node.dirs) {
    sumTree(d);
    add += d.stat.add;
    del += d.stat.del;
    count += d.stat.count;
  }
  for (const x of node.files) {
    add += x.file.additions || 0;
    del += x.file.deletions || 0;
    count += 1;
  }
  node.stat = { add, del, count };
}

// 取树中第一个文件（与 renderTreeNode 的渲染顺序一致），用于默认选中
function firstFileInTree(node) {
  for (const d of node.dirs) {
    const hit = firstFileInTree(d);
    if (hit) return hit;
  }
  return node.files.length ? node.files[0].file.path : '';
}

function renderTreeNode(node, depth) {
  let html = '';

  for (const d of node.dirs) {
    const collapsed = state.collapsedDirs.has(d.path);
    // prize add by yanliang for 目录行按子树聚合出批量操作按钮, 20261022-start
    const dirOps = state.opsIndex ? state.opsIndex.get(d.path) : null;
    const opsHtml = dirOps
      ? renderRowOps(
          { stage: dirOps.stage.length > 0, unstage: dirOps.unstage.length > 0, ignore: dirOps.ignore.length > 0 },
          'dir'
        )
      : '';
    // prize add by yanliang for 目录行按子树聚合出批量操作按钮, 20261022-end
    html += `<section class="tree-dir${collapsed ? ' collapsed' : ''}" data-dir="${esc(d.path)}">
      <div class="dir-head" style="padding-left:${10 + depth * 11}px" title="${esc(d.path)}">
        <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        <svg class="folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10.5v7A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>
        <span class="dir-name">${esc(d.name)}</span>
        <span class="dir-count" data-total="${d.stat.count}">${d.stat.count}</span>
        ${opsHtml}
      </div>
      <div class="dir-body"${collapsed ? ' style="display:none"' : ''}>${renderTreeNode(d, depth + 1)}</div>
    </section>`;
  }

  for (const x of node.files) html += renderFileRow(x.file, depth);
  return html;
}
// prize add by yanliang for 按项目目录树组织改动文件, 20261022-end

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

// prize add by yanliang for 右侧面板渲染选中文件的 diff, 20261022-start
// prize add by yanliang for 抽出文件正文渲染，提交面板的暂存预览也复用, 20261022-start
function diffBodyHtml(f) {
  const noContent = f.hunks.length > 0 && f.hunks.every((h) => !h.lines.length);
  if (f.binary) return '<div class="binary-note">二进制文件，不显示逐行差异</div>';
  if (!f.hunks.length) {
    return `<div class="empty-note">${f.status === 'R' ? '文件重命名，内容未变化' : '无文本差异'}</div>`;
  }
  if (noContent) return '<div class="empty-note">空文件（没有内容）</div>';
  return state.view === 'split' ? renderSplitView(f) : renderInlineView(f);
}
// prize add by yanliang for 抽出文件正文渲染，提交面板的暂存预览也复用, 20261022-end

function renderSelectedFile() {
  const pane = $('#diffPane');
  if (!pane) return;

  const f = (state.files || []).find((x) => x.path === state.selected);
  if (!f) {
    pane.innerHTML = '<div class="pane-empty">在左侧选择一个文件，这里显示它的改动</div>';
    return;
  }

  const body = diffBodyHtml(f);

  const ops = f.live
    ? { stage: !!(f.untracked || f.dirty), unstage: !!f.staged, ignore: !!f.untracked }
    : null;
  const renamed = f.status === 'R' && f.oldPath && f.oldPath !== f.newPath;
  const pathHtml = renamed
    ? `<span class="old-path">${esc(f.oldPath)}</span><span class="arrow">→</span>${esc(f.path)}`
    : esc(f.path);

  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-start
  pane.classList.toggle('split-mode', state.view === 'split');
  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-end
  pane.innerHTML = `
    <div class="diff-pane-head" data-file="${esc(f.path)}">
      <span class="file-status st-${f.status}">${f.status}</span>
      ${f.staged ? '<span class="staged-dot" title="已在暂存区"></span>' : ''}
      <span class="pane-file-path" title="${esc(f.path)}">${pathHtml}</span>
      <span class="file-stat">
        ${renderStatBars(f.additions, f.deletions)}
        <span class="stat-add">+${f.additions}</span>
        <span class="stat-del">-${f.deletions}</span>
      </span>
      ${renderRowOps(ops, 'file')}
    </div>
    <div class="diff-pane-body" id="diffPaneBody">${body}</div>
    <div class="split-handle" id="splitHandle" title="拖动调整左右比例，双击复位"></div>`;

  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-start
  updateSplitHandle();
  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-end
}

// 点击左侧文件名：切换选中项并重绘右侧
function selectFile(path) {
  if (!path || path === state.selected) return;
  state.selected = path;
  document.querySelectorAll('.file-block.on').forEach((b) => b.classList.remove('on'));
  document.querySelectorAll('.file-block').forEach((b) => {
    if (b.dataset.file === path) b.classList.add('on');
  });
  renderSelectedFile();
}

// prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-start
// 比例换算成 grid 的 fr 权重：0.5 即 1fr : 1fr
function applySplitRatio() {
  const r = Math.min(Math.max(state.splitRatio || 0.5, 0.2), 0.8);
  document.documentElement.style.setProperty('--split-l', (r / 0.5).toFixed(3) + 'fr');
  document.documentElement.style.setProperty('--split-r', ((1 - r) / 0.5).toFixed(3) + 'fr');
}

// 把中线贴到左右两栏的真实分界处；内联视图或没有可对比行时隐藏
function updateSplitHandle() {
  const pane = $('#diffPane');
  const handle = $('#splitHandle');
  const body = $('#diffPaneBody');
  if (!pane || !handle || !body) return;

  if (!pane.classList.contains('split-mode')) {
    handle.style.display = 'none';
    return;
  }

  const row = body.querySelector('.drow:not(.r-note)');
  const gutter = row && (row.querySelector('.code.wrap-gutter') || row.children[1]);
  if (!gutter) {
    handle.style.display = 'none';
    return;
  }

  const head = pane.querySelector('.diff-pane-head');
  const pr = pane.getBoundingClientRect();
  const gr = gutter.getBoundingClientRect();
  handle.style.display = 'block';
  handle.style.top = (head ? head.offsetHeight : 0) + 'px';
  handle.style.left = gr.right - pr.left + 'px';
}
// prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-end
// prize add by yanliang for 右侧面板渲染选中文件的 diff, 20261022-end

// prize add by yanliang for 汇总每个目录与整棵树的批量操作目标, 20261022-start
function buildOpsIndex(root) {
  const index = new Map();

  const walk = (node) => {
    const acc = { stage: [], unstage: [], ignore: [] };
    for (const d of node.dirs) {
      const sub = walk(d);
      acc.stage.push(...sub.stage);
      acc.unstage.push(...sub.unstage);
      acc.ignore.push(...sub.ignore);
    }
    for (const x of node.files) {
      const f = x.file;
      const stageable = !!(f.untracked || f.dirty);
      if (stageable) acc.stage.push(f.path);
      if (f.staged) acc.unstage.push(f.path);
      if (f.untracked) acc.ignore.push(f.path);
      // 文件自身也要登记，行内按钮靠它拿到操作目标
      index.set(f.path, {
        stage: stageable ? [f.path] : [],
        unstage: f.staged ? [f.path] : [],
        ignore: f.untracked ? [f.path] : [],
      });
    }
    // 目录忽略用目录本身作目标，一条 dir/ 规则就能覆盖它以后新增的文件
    const own = {
      stage: acc.stage,
      unstage: acc.unstage,
      ignore: acc.ignore.length && node.path ? [node.path] : [],
    };
    if (node.path) index.set(node.path, own);
    return acc;
  };

  index.set('__all__', walk(root));
  return index;
}
// prize add by yanliang for 汇总每个目录与整棵树的批量操作目标, 20261022-end

function renderDiff() {
  const d = state.detail;
  if (!d) return;

  const files = parsePatch(d.patch || '');
  const live = d.kind === 'working';
  const statusMap = d.status || {};

  // prize add by yanliang for 把暂存状态挂到每个文件上，工作区视图才有操作按钮, 20261022-start
  const untrackedSet = new Set(d.untracked || []);
  for (const f of files) {
    const st = statusMap[f.path] || {};
    f.live = live;
    f.staged = !!st.staged;
    f.dirty = !!st.dirty;
    f.untracked = !!st.untracked || untrackedSet.has(f.path);
  }
  // prize add by yanliang for 把暂存状态挂到每个文件上，工作区视图才有操作按钮, 20261022-end

  const sumAdd = files.reduce((s, f) => s + f.additions, 0);
  const sumDel = files.reduce((s, f) => s + f.deletions, 0);

  const scroll = $('#diffScroll');
  scroll.dataset.count = String(files.length);
  scroll.dataset.add = String(sumAdd);
  scroll.dataset.del = String(sumDel);
  state.files = files;

  if (!files.length) {
    scroll.innerHTML = `<div class="skeleton">${live ? '工作区没有未提交的改动' : '这次提交没有文件改动'}</div>`;
    state.opsIndex = null;
    state.selected = '';
    renderToolbar();
    return;
  }

  // prize add by yanliang for 左侧文件目录树 + 右侧 diff 双栏布局, 20261022-start
  const tree = buildFileTree(files);
  state.opsIndex = live ? buildOpsIndex(tree) : null;
  // 选中的文件若已不在列表里（切换提交、忽略后消失等），回落到树中第一个文件
  if (!files.some((f) => f.path === state.selected)) {
    state.selected = firstFileInTree(tree) || files[0].path;
  }

  scroll.innerHTML = `
    <aside class="file-pane" id="filePane">
      <div class="pane-head">
        <div class="pane-head-row">
          <span class="pane-title">改动文件</span>
          <span class="pane-count" id="filePaneCount">${files.length}</span>
        </div>
        <input class="file-filter" id="fileFilter" placeholder="筛选文件…" value="${esc(state.filter)}" />
      </div>
      <div class="file-tree">${renderTreeNode(tree, 0)}</div>
    </aside>
    <div class="pane-resizer" id="paneResizer" title="拖动调整文件栏宽度，双击复位"></div>
    <section class="diff-pane" id="diffPane"></section>`;

  renderSelectedFile();
  applyFilter();
  // prize add by yanliang for 左侧文件目录树 + 右侧 diff 双栏布局, 20261022-end

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
    <div class="toolbar-spacer"></div>
    ${
      // prize add by yanliang for 工作区视图提供整棵树的一键暂存/取消暂存, 20261022-start
      state.detail && state.detail.kind === 'working'
        ? `<div class="bulk-ops">
            <button class="btn small primary" data-open-commit title="查看暂存区并提交">提交…</button>
            <button class="btn small" data-op="stage" data-scope="all" title="git add -A">全部暂存</button>
            <button class="btn small" data-op="unstage" data-scope="all" title="git reset HEAD --">全部取消暂存</button>
          </div>`
        : ''
      // prize add by yanliang for 工作区视图提供整棵树的一键暂存/取消暂存, 20261022-end
    }
    <span class="fact">${count} 个文件 <span class="stat-add">+${add}</span> <span class="stat-del">-${del}</span></span>
  `;
}

function applyFilter() {
  const q = state.filter.trim().toLowerCase();
  // prize add by yanliang for 筛选时目录级联隐藏/自动展开, 20261022-start
  const hitDirs = new Set();
  // prize add by yanliang for 筛选时目录徽标跟随命中数，避免徽标数与实际可见行数对不上, 20261022-start
  const hits = new Map();
  let visibleFiles = 0;
  // prize add by yanliang for 筛选时目录徽标跟随命中数，避免徽标数与实际可见行数对不上, 20261022-end

  for (const block of document.querySelectorAll('.file-block')) {
    const path = block.dataset.file || '';
    const show = !q || path.toLowerCase().includes(q);
    block.style.display = show ? '' : 'none';
    if (!show) continue;
    visibleFiles++;
    // 有命中的文件，把它所有祖先目录标记为可见（closest 含自身，必须从 parentElement 往上找）
    let p = block.closest('.tree-dir');
    while (p) {
      if (hitDirs.has(p)) {
        // prize add by yanliang for 祖先链可能已被上层提前标记，命中数仍需逐个累加, 20261022-start
        hits.set(p, (hits.get(p) || 0) + 1);
        break;
      }
      hitDirs.add(p);
      hits.set(p, (hits.get(p) || 0) + 1);
      p = p.parentElement ? p.parentElement.closest('.tree-dir') : null;
    }
  }

  for (const dir of document.querySelectorAll('.tree-dir')) {
    const visible = hitDirs.has(dir);
    dir.style.display = visible ? '' : 'none';

    // prize add by yanliang for 筛选时徽标显示命中数，清空筛选后恢复总数, 20261022-start
    const badge = dir.querySelector(':scope > .dir-head .dir-count');
    if (badge) {
      const total = badge.dataset.total || badge.textContent;
      badge.textContent = q ? String(hits.get(dir) || 0) : total;
      badge.title = q ? `命中 ${hits.get(dir) || 0} / 共 ${total} 个文件` : '';
    }
    // prize add by yanliang for 筛选时徽标显示命中数，清空筛选后恢复总数, 20261022-end

    const body = dir.querySelector(':scope > .dir-body');
    if (!body) continue;
    if (q && visible) {
      // 命中项所在目录强制展开，否则用户看不到搜索结果
      body.style.display = '';
      dir.classList.remove('collapsed');
    } else {
      const collapsed = state.collapsedDirs.has(dir.dataset.dir || '');
      body.style.display = collapsed ? 'none' : '';
      dir.classList.toggle('collapsed', collapsed);
    }
  }
  // prize add by yanliang for 筛选时目录级联隐藏/自动展开, 20261022-end

  // prize add by yanliang for 左栏文件计数跟随筛选结果, 20261022-start
  const paneCount = $('#filePaneCount');
  if (paneCount) {
    const total = document.querySelectorAll('.file-block').length;
    paneCount.textContent = q ? `${visibleFiles}/${total}` : String(total);
  }
  // prize add by yanliang for 左栏文件计数跟随筛选结果, 20261022-end
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
    // prize add by yanliang for 工作区头部显示已暂存/未暂存/未跟踪数量, 20261022-start
    const entries = Object.values(d.status || {});
    const stagedN = entries.filter((x) => x.staged).length;
    const plainN = entries.filter((x) => !x.staged).length;
    const untrackedN = entries.filter((x) => x.untracked).length;
    head.innerHTML = `
      <h1 class="commit-title">工作区未提交的改动</h1>
      <div class="commit-facts">
        <span class="fact">已暂存 ${stagedN}</span>
        <span class="fact">未暂存 ${Math.max(0, plainN - untrackedN)}</span>
        ${untrackedN ? `<span class="fact" style="color:var(--text-3)">未跟踪 ${untrackedN}</span>` : ''}
        ${
          d.untrackedTruncated
            ? '<span class="fact" style="color:var(--del-text)">未跟踪文件过多，仅渲染前 400 个</span>'
            : ''
        }
      </div>`;
    // prize add by yanliang for 工作区头部显示已暂存/未暂存/未跟踪数量, 20261022-end
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
      <p>填入本地仓库路径后打开<br /><span>历史只读；工作区可暂存 / 忽略 / 提交</span></p>
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
    </div>
    ${
      // prize add by yanliang for 仓库卡片上常驻一个提交入口, 20261022-start
      `<div class="repo-actions">
        <button class="btn small" data-open-commit title="查看暂存区并提交">提交…</button>
      </div>`
      // prize add by yanliang for 仓库卡片上常驻一个提交入口, 20261022-end
    }`;
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
    state.selected = '';
    // prize add by yanliang for 换仓库时重置目录折叠状态, 20261022-start
    state.collapsedDirs.clear();
    // prize add by yanliang for 换仓库时重置目录折叠状态, 20261022-end
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
    state.selected = '';
    // prize add by yanliang for 切换提交时重置目录折叠状态, 20261022-start
    state.collapsedDirs.clear();
    // prize add by yanliang for 切换提交时重置目录折叠状态, 20261022-end
    state.filter = '';

    renderCommitList();
    renderCommitHead();
    renderDiff();
    // prize add by yanliang for 切换详情后重置右侧 diff 滚动位置, 20261022-start
    const paneBody = $('#diffPaneBody');
    if (paneBody) paneBody.scrollTop = 0;
    // prize add by yanliang for 切换详情后重置右侧 diff 滚动位置, 20261022-end
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
    state.selected = '';
    // prize add by yanliang for 切换提交时重置目录折叠状态, 20261022-start
    state.collapsedDirs.clear();
    // prize add by yanliang for 切换提交时重置目录折叠状态, 20261022-end
    state.filter = '';

    renderCommitList();
    renderCommitHead();
    renderDiff();
    // prize add by yanliang for 切换详情后重置右侧 diff 滚动位置, 20261022-start
    const paneBody = $('#diffPaneBody');
    if (paneBody) paneBody.scrollTop = 0;
    // prize add by yanliang for 切换详情后重置右侧 diff 滚动位置, 20261022-end
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
    state.selected = '';
    // prize add by yanliang for 切换提交时重置目录折叠状态, 20261022-start
    state.collapsedDirs.clear();
    // prize add by yanliang for 切换提交时重置目录折叠状态, 20261022-end
    state.filter = '';

    renderCommitList();
    renderCommitHead();
    renderDiff();
    // prize add by yanliang for 切换详情后重置右侧 diff 滚动位置, 20261022-start
    const paneBody = $('#diffPaneBody');
    if (paneBody) paneBody.scrollTop = 0;
    // prize add by yanliang for 切换详情后重置右侧 diff 滚动位置, 20261022-end
  } catch (err) {
    toast(err.message, true);
  }
}

// prize add by yanliang for 执行工作区 git 操作并原地刷新, 20261022-start
async function runGitOp(op, paths) {
  if (!paths || !paths.length) return;
  const label = { stage: '暂存', unstage: '取消暂存', ignore: '忽略' }[op] || op;
  try {
    const res = await postApi('git-op', { op, paths });
    toast(res.message || `${label}完成`);
    await refreshWorking();
  } catch (err) {
    toast(`${label}失败：${err.message}`, true);
  }
}

// 只刷新工作区详情与仓库状态，保留折叠、筛选和滚动位置
async function refreshWorking() {
  if (!state.detail || state.detail.kind !== 'working') return;
  // prize add by yanliang for 刷新后保留左右两栏各自的滚动位置, 20261022-start
  const treePane = document.querySelector('.file-tree');
  const treeTop = treePane ? treePane.scrollTop : 0;
  const diffBody = $('#diffPaneBody');
  const diffTop = diffBody ? diffBody.scrollTop : 0;
  // prize add by yanliang for 刷新后保留左右两栏各自的滚动位置, 20261022-end
  const [detail, info] = await Promise.all([
    api('working', { ignoreSpace: state.ignoreSpace ? '1' : '0' }),
    fetch(`/api/repo?repo=${encodeURIComponent(state.repo)}`)
      .then((r) => r.json())
      .catch(() => null),
  ]);
  state.detail = detail;
  if (info && !info.error) state.info = info;
  renderRepoCard();
  renderCommitList();
  renderCommitHead();
  renderDiff();
  // prize add by yanliang for 还原左右两栏滚动位置, 20261022-start
  const treePane2 = document.querySelector('.file-tree');
  if (treePane2) treePane2.scrollTop = treeTop;
  const diffBody2 = $('#diffPaneBody');
  if (diffBody2) diffBody2.scrollTop = diffTop;
  // prize add by yanliang for 还原左右两栏滚动位置, 20261022-end
}
// prize add by yanliang for 执行工作区 git 操作并原地刷新, 20261022-end

/* ---------------- 提交面板 ---------------- */
// prize add by yanliang for 提交面板：勾选暂存文件、填写说明、支持 amend, 20261022-start
async function openCommitPanel() {
  if (!state.repo) {
    toast('先打开一个仓库', true);
    return;
  }
  if (state.commitOpen) return;

  state.commitOpen = true;
  state.commitData = null;
  state.commitSel = new Set();
  state.commitAmend = false;
  state.commitMsg = '';
  state.commitBusy = false;

  $('#commitMask').classList.remove('hidden');
  $('#commitModal').innerHTML = '<div class="modal-loading">读取暂存区…</div>';

  try {
    const data = await api('staged', {});
    // 面板可能已被 Esc 关掉，不再回填
    if (!state.commitOpen) return;

    state.commitData = data;
    state.commitSel = new Set((data.files || []).map((f) => f.path));

    renderCommitPanel();
    const msg = $('#commitMsg');
    if (msg) msg.focus();
  } catch (err) {
    toast(`读取暂存区失败：${err.message}`, true);
    closeCommitPanel();
  }
}

function closeCommitPanel() {
  state.commitOpen = false;
  state.commitBusy = false;
  const mask = $('#commitMask');
  if (mask) mask.classList.add('hidden');
  const modal = $('#commitModal');
  if (modal) modal.innerHTML = '';
}

function commitSelStats() {
  const files = (state.commitData && state.commitData.files) || [];
  let add = 0;
  let del = 0;
  let n = 0;
  for (const f of files) {
    if (!state.commitSel.has(f.path)) continue;
    add += f.additions || 0;
    del += f.deletions || 0;
    n++;
  }
  return { add, del, n, total: files.length };
}

function syncCommitSubmit() {
  const btn = $('#commitSubmit');
  if (!btn) return;
  const hasMsg = !!state.commitMsg.trim();
  const ok = hasMsg && (state.commitAmend || state.commitSel.size > 0);
  btn.disabled = state.commitBusy || !ok;
  btn.textContent = state.commitBusy ? '提交中…' : state.commitAmend ? '修改提交' : '提交';
  btn.title = state.commitAmend ? 'git commit --amend' : 'git commit';
}

function syncCommitSelUI() {
  const s = commitSelStats();
  document.querySelectorAll('#commitModal .stg-row').forEach((row) => {
    const on = state.commitSel.has(row.dataset.path);
    row.classList.toggle('on', on);
    // prize add by yanliang for 全选/反选时同步回每个勾选框的显示状态, 20261022-start
    const box = row.querySelector('.stg-check');
    if (box) box.checked = on;
    // prize add by yanliang for 全选/反选时同步回每个勾选框的显示状态, 20261022-end
  });

  const all = $('#commitAll');
  if (all) {
    all.checked = s.total > 0 && s.n === s.total;
    all.indeterminate = s.n > 0 && s.n < s.total;
  }

  const count = $('#stgSelCount');
  if (count) count.textContent = `${s.n}/${s.total}`;

  const hint = $('#commitHint');
  if (hint) {
    hint.innerHTML = s.n
      ? `将提交 ${s.n} 个文件 <span class="stat-add">+${s.add}</span> <span class="stat-del">-${s.del}</span>`
      : state.commitAmend
        ? '未选择文件，只修改提交说明'
        : '未选择任何文件';
  }

  syncCommitSubmit();
}

// prize add by yanliang for 提交面板改成单栏文件清单（去掉右侧改动预览）, 20261022-start
function renderCommitPanel() {
  const modal = $('#commitModal');
  const d = state.commitData;
  if (!modal) return;
  if (!d) {
    modal.innerHTML = '<div class="modal-loading">读取暂存区…</div>';
    return;
  }

  const files = d.files || [];
  const s = commitSelStats();

  const rows = files.length
    ? files
        .map((f) => {
          const on = state.commitSel.has(f.path);
          return `<div class="stg-row${on ? ' on' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}">
            <input type="checkbox" class="stg-check" data-path="${esc(f.path)}"${on ? ' checked' : ''} />
            <span class="file-status st-${esc(f.status)}">${esc(f.status)}</span>
            <span class="stg-path"><span class="stg-dir">${esc(
              f.path.slice(0, f.path.lastIndexOf('/') + 1)
            )}</span><span class="stg-base">${esc(baseName(f.path))}</span></span>
            <span class="stg-stat"><span class="stat-add">+${f.additions}</span><span class="stat-del">-${
              f.deletions
            }</span></span>
          </div>`;
        })
        .join('')
    : '<div class="stg-empty">暂存区是空的<br />先在左侧「工作区改动」里点暂存，再回来提交</div>';

  const amendTip = !d.hasHead
    ? '<span class="amend-tip">还没有提交，无法 amend</span>'
    : d.headPushed
      ? `<span class="amend-tip warn">改写 ${esc(d.short)}，该提交已在远端，amend 后需要强制推送</span>`
      : `<span class="amend-tip">改写上一次提交 ${esc(d.short)}</span>`;

  modal.innerHTML = `
    <div class="modal-head">
      <div class="modal-title">提交暂存区的改动 <span class="modal-sub">${esc(d.branch)}</span></div>
      <button class="modal-close" id="commitClose" title="关闭（Esc）">×</button>
    </div>
    <div class="modal-body">
      <div class="stg-list-pane">
        <div class="stg-list-head">
          <label class="stg-all"><input type="checkbox" id="commitAll"${
            files.length && s.n === files.length ? ' checked' : ''
          } />全选</label>
          <span class="stg-count" id="stgSelCount">${s.n}/${files.length}</span>
        </div>
        <div class="stg-list">${rows}</div>
      </div>
    </div>
    <div class="modal-foot">
      <label class="stg-amend${d.hasHead ? '' : ' disabled'}">
        <input type="checkbox" id="commitAmend"${state.commitAmend ? ' checked' : ''}${d.hasHead ? '' : ' disabled'} />
        amend 上一次提交
        <span id="commitAmendTip">${amendTip}</span>
      </label>
      <textarea id="commitMsg" spellcheck="false" placeholder="提交说明：第一行写标题，空一行再写详细说明（Ctrl+Enter 提交）">${esc(
        state.commitMsg
      )}</textarea>
      <div class="modal-actions">
        <span class="modal-hint" id="commitHint"></span>
        <button class="btn" id="commitCancel">取消</button>
        <button class="btn primary" id="commitSubmit">提交</button>
      </div>
    </div>`;

  syncCommitSelUI();
}

// 打开 amend 时带出上一次提交说明，关掉时把它清回去
function toggleAmend(on) {
  const d = state.commitData || {};
  state.commitAmend = !!on && !!d.hasHead;
  const box = $('#commitMsg');
  const last = (d.lastMessage || '').trim();

  if (state.commitAmend && !state.commitMsg.trim() && last) {
    state.commitMsg = d.lastMessage || '';
    if (box) box.value = state.commitMsg;
  } else if (!state.commitAmend && last && state.commitMsg.trim() === last) {
    state.commitMsg = '';
    if (box) box.value = '';
  }

  const tip = $('#commitAmendTip');
  if (tip) tip.style.opacity = state.commitAmend ? '1' : '.6';
  syncCommitSelUI();
}

function onCommitModalChange(e) {
  const t = e.target;

  if (t.id === 'commitAll') {
    const all = (state.commitData && state.commitData.files) || [];
    state.commitSel = t.checked ? new Set(all.map((f) => f.path)) : new Set();
    syncCommitSelUI();
    return;
  }

  if (t.classList && t.classList.contains('stg-check')) {
    const p = t.dataset.path || '';
    if (t.checked) state.commitSel.add(p);
    else state.commitSel.delete(p);
    syncCommitSelUI();
    return;
  }

  if (t.id === 'commitAmend') toggleAmend(t.checked);
}

function onCommitModalClick(e) {
  const t = e.target;

  if (t.closest('#commitClose') || t.closest('#commitCancel')) {
    closeCommitPanel();
    return;
  }
  if (t.closest('#commitSubmit')) {
    submitCommit();
    return;
  }
  // 勾选框交给 change 处理；点行其他地方直接切换该文件的提交勾选
  if (t.closest('.stg-check') || t.closest('#commitAll') || t.closest('#commitAmend')) return;

  const row = t.closest('.stg-row');
  if (row) {
    const p = row.dataset.path || '';
    const on = !state.commitSel.has(p);
    if (on) state.commitSel.add(p);
    else state.commitSel.delete(p);
    const box = row.querySelector('.stg-check');
    if (box) box.checked = on;
    syncCommitSelUI();
  }
}

async function submitCommit() {
  if (state.commitBusy || !state.commitData) return;

  const msg = String(state.commitMsg || '').trim();
  if (!msg) {
    toast('提交说明不能为空', true);
    const box = $('#commitMsg');
    if (box) box.focus();
    return;
  }

  const paths = [...state.commitSel];
  if (!state.commitAmend && !paths.length) {
    toast('至少选择一个要提交的文件', true);
    return;
  }

  state.commitBusy = true;
  syncCommitSubmit();

  try {
    const res = await postApi('commit', { message: msg, amend: state.commitAmend, paths });
    toast(res.amend ? `已修改提交 ${res.short}` : `已提交 ${res.short}`);
    closeCommitPanel();
    await afterCommit();
  } catch (err) {
    state.commitBusy = false;
    syncCommitSubmit();
    toast(`提交失败：${err.message}`, true);
  }
}

async function afterCommit() {
  const info = await fetch(`/api/repo?repo=${encodeURIComponent(state.repo)}`)
    .then((r) => r.json())
    .catch(() => null);
  if (info && !info.error) {
    state.info = info;
    renderRepoCard();
  }
  await loadCommits(true);
  if (state.active && state.active.kind === 'working') await refreshWorking();
}
// prize add by yanliang for 提交面板：勾选暂存文件、填写说明、支持 amend, 20261022-end

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
    // prize add by yanliang for 切换视图模式时只重绘右侧面板并保留滚动位置, 20261022-start
    const prev = $('#diffPaneBody');
    const top = prev ? prev.scrollTop : 0;
    const left = prev ? prev.scrollLeft : 0;
    renderDiff();
    const now = $('#diffPaneBody');
    if (now) {
      now.scrollTop = top;
      now.scrollLeft = left;
    }
    // prize add by yanliang for 切换视图模式时只重绘右侧面板并保留滚动位置, 20261022-end
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
    // prize add by yanliang for 工具条上的全部暂存/全部取消暂存, 20261022-start
    const bulk = e.target.closest('[data-op]');
    if (bulk) {
      const entry = state.opsIndex && state.opsIndex.get('__all__');
      const targets = entry ? entry[bulk.dataset.op] : null;
      if (targets && targets.length) runGitOp(bulk.dataset.op, targets);
      else toast('没有可操作的路径');
      return;
    }
    // prize add by yanliang for 工具条上的全部暂存/全部取消暂存, 20261022-end

    const btn = e.target.closest('#viewSeg button');
    if (btn) {
      setView(btn.dataset.view);
      return;
    }
    if (e.target.closest('#wrapToggle')) {
      state.wrap = !state.wrap;
      localStorage.setItem('gdv.wrap', state.wrap ? '1' : '0');
      if (state.detail) {
        // prize add by yanliang for 换行开关只重绘右侧面板，保留其滚动位置, 20261022-start
        const prev = $('#diffPaneBody');
        const top = prev ? prev.scrollTop : 0;
        const left = prev ? prev.scrollLeft : 0;
        renderSelectedFile();
        const now = $('#diffPaneBody');
        if (now) {
          now.scrollTop = top;
          now.scrollLeft = left;
        }
        // prize add by yanliang for 换行开关只重绘右侧面板，保留其滚动位置, 20261022-end
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

  // prize add by yanliang for 筛选框移到左侧文件栏后，改由 #diffScroll 事件委托, 20261022-start
  $('#diffScroll').addEventListener('input', (e) => {
    if (e.target.id === 'fileFilter') {
      state.filter = e.target.value;
      applyFilter();
    }
  });
  // prize add by yanliang for 筛选框移到左侧文件栏后，改由 #diffScroll 事件委托, 20261022-end

  $('#diffScroll').addEventListener('click', (e) => {
    // prize add by yanliang for 文件/目录行内的暂存、取消暂存、忽略按钮, 20261022-start
    const opBtn = e.target.closest('[data-op]');
    if (opBtn) {
      e.stopPropagation();
      const scope = opBtn.dataset.scope;
      const holder =
        scope === 'dir' ? opBtn.closest('.tree-dir') : scope === 'file' ? opBtn.closest('[data-file]') : null;
      const key =
        scope === 'all' ? '__all__' : holder ? (scope === 'dir' ? holder.dataset.dir : holder.dataset.file) : '';
      const entry = state.opsIndex && key ? state.opsIndex.get(key) : null;
      const targets = entry ? entry[opBtn.dataset.op] : null;
      if (targets && targets.length) runGitOp(opBtn.dataset.op, targets);
      else toast('没有可操作的路径');
      return;
    }
    // prize add by yanliang for 文件/目录行内的暂存、取消暂存、忽略按钮, 20261022-end

    // prize add by yanliang for 点击目录头折叠或展开整棵子树, 20261022-start
    const dirHead = e.target.closest('.dir-head');
    if (dirHead) {
      const dir = dirHead.closest('.tree-dir');
      if (dir) {
        const body = dir.querySelector(':scope > .dir-body');
        const collapsed = dir.classList.toggle('collapsed');
        if (body) body.style.display = collapsed ? 'none' : '';
        const key = dir.dataset.dir || '';
        if (collapsed) state.collapsedDirs.add(key);
        else state.collapsedDirs.delete(key);
      }
      return;
    }
    // prize add by yanliang for 点击目录头折叠或展开整棵子树, 20261022-end

    // prize add by yanliang for 点击左侧文件名，右侧显示对应 diff, 20261022-start
    const head = e.target.closest('.file-head');
    if (head) {
      const block = head.closest('.file-block');
      if (block) selectFile(block.dataset.file || '');
      return;
    }
    // prize add by yanliang for 点击左侧文件名，右侧显示对应 diff, 20261022-end
    const code = e.target.closest('[data-copy]');
    if (code) copyText(code.dataset.copy);
  });

  $('#diffScroll').addEventListener('copy', (e) => {
    const sel = window.getSelection().toString();
    if (!sel) return;
    // 去掉行号，只保留代码正文
    e.clipboardData.setData('text/plain', sel);
  });

  // prize add by yanliang for 左侧文件栏宽度可拖拽调整, 20261022-start
  const view = $('#diffScroll');
  let paneDrag = false;
  view.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('#paneResizer');
    if (!handle) return;
    paneDrag = true;
    handle.classList.add('dragging');
    // prize add by yanliang for 拖动时统一光标并禁止选中文字, 20261023-start
    document.body.classList.add('col-resizing');
    // prize add by yanliang for 拖动时统一光标并禁止选中文字, 20261023-end
    e.preventDefault();
  });
  // prize add by yanliang for 双击分隔线恢复默认宽度, 20261023-start
  view.addEventListener('dblclick', (e) => {
    if (!e.target.closest('#paneResizer')) return;
    document.documentElement.style.removeProperty('--filepane-w');
    localStorage.removeItem('gdv.filepane');
  });
  // prize add by yanliang for 双击分隔线恢复默认宽度, 20261023-end
  document.addEventListener('mousemove', (e) => {
    if (!paneDrag) return;
    const rect = view.getBoundingClientRect();
    const max = Math.max(200, rect.width - 320);
    const w = Math.min(Math.max(e.clientX - rect.left, 180), Math.min(460, max));
    document.documentElement.style.setProperty('--filepane-w', w + 'px');
    localStorage.setItem('gdv.filepane', String(Math.round(w)));
    // prize add by yanliang for 文件栏宽度变化后同步 diff 中线位置, 20261023-start
    updateSplitHandle();
    // prize add by yanliang for 文件栏宽度变化后同步 diff 中线位置, 20261023-end
  });
  document.addEventListener('mouseup', () => {
    if (!paneDrag) return;
    paneDrag = false;
    document.querySelectorAll('.pane-resizer.dragging').forEach((el) => el.classList.remove('dragging'));
    document.body.classList.remove('col-resizing');
  });
  // prize add by yanliang for 左侧文件栏宽度可拖拽调整, 20261022-end

  // prize add by yanliang for 拖动 diff 中线自由调整左右栏比例, 20261023-start
  let splitDrag = false;
  let splitStartX = 0;
  let splitStartRatio = 0.5;
  let splitAvailW = 1;

  view.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('#splitHandle');
    if (!handle) return;
    const body = $('#diffPaneBody');
    const row = body && body.querySelector('.drow:not(.r-note)');
    if (!row) return;
    // 两栏合计可用宽度（减去左右两个行号列）
    splitAvailW = row.getBoundingClientRect().width - 92;
    if (splitAvailW < 120) return;
    splitDrag = true;
    splitStartX = e.clientX;
    splitStartRatio = Math.min(Math.max(state.splitRatio || 0.5, 0.2), 0.8);
    handle.classList.add('dragging');
    document.body.classList.add('col-resizing');
    e.preventDefault();
  });

  view.addEventListener('dblclick', (e) => {
    if (!e.target.closest('#splitHandle')) return;
    state.splitRatio = 0.5;
    applySplitRatio();
    updateSplitHandle();
    localStorage.removeItem('gdv.splitRatio');
  });

  document.addEventListener('mousemove', (e) => {
    if (!splitDrag) return;
    const r = splitStartRatio + (e.clientX - splitStartX) / splitAvailW;
    state.splitRatio = Math.min(Math.max(r, 0.2), 0.8);
    applySplitRatio();
    updateSplitHandle();
  });

  document.addEventListener('mouseup', () => {
    if (!splitDrag) return;
    splitDrag = false;
    document.querySelectorAll('#splitHandle.dragging').forEach((el) => el.classList.remove('dragging'));
    document.body.classList.remove('col-resizing');
    localStorage.setItem('gdv.splitRatio', String(Number((state.splitRatio || 0.5).toFixed(3))));
  });

  // 窗口尺寸变化后中线需要重新贴合分界处
  window.addEventListener('resize', () => updateSplitHandle());
  applySplitRatio();
  // prize add by yanliang for 拖动 diff 中线自由调整左右栏比例, 20261023-end

  // prize add by yanliang for 提交面板事件：遮罩关闭、勾选、amend、Ctrl+Enter 提交, 20261022-start
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-commit]')) {
      e.preventDefault();
      openCommitPanel();
      return;
    }
    if (e.target.id === 'commitMask') closeCommitPanel();
  });

  $('#commitModal').addEventListener('click', onCommitModalClick);
  $('#commitModal').addEventListener('change', onCommitModalChange);
  $('#commitModal').addEventListener('input', (e) => {
    if (e.target.id === 'commitMsg') {
      state.commitMsg = e.target.value;
      syncCommitSubmit();
    }
  });
  $('#commitModal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitCommit();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!state.commitOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommitPanel();
    }
  });
  // prize add by yanliang for 提交面板事件：遮罩关闭、勾选、amend、Ctrl+Enter 提交, 20261022-end

  // 键盘导航
  document.addEventListener('keydown', (e) => {
    // prize add by yanliang for 提交面板打开时禁用 j/k 切换提交, 20261022-start
    if (state.commitOpen) return;
    // prize add by yanliang for 提交面板打开时禁用 j/k 切换提交, 20261022-end
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
    // prize add by yanliang for 拖动时统一光标并禁止选中文字, 20261023-start
    document.body.classList.add('col-resizing');
    // prize add by yanliang for 拖动时统一光标并禁止选中文字, 20261023-end
    e.preventDefault();
  });
  // prize add by yanliang for 双击分隔线恢复默认宽度, 20261023-start
  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--sidebar-w');
    localStorage.removeItem('gdv.sidebar');
  });
  // prize add by yanliang for 双击分隔线恢复默认宽度, 20261023-end
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(Math.max(e.clientX, 240), 620);
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    localStorage.setItem('gdv.sidebar', String(w));
    // prize add by yanliang for 侧栏宽度变化后同步 diff 中线位置, 20261023-start
    updateSplitHandle();
    // prize add by yanliang for 侧栏宽度变化后同步 diff 中线位置, 20261023-end
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
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
  // prize add by yanliang for 恢复左侧文件栏宽度, 20261022-start
  const savedPane = localStorage.getItem('gdv.filepane');
  if (savedPane) document.documentElement.style.setProperty('--filepane-w', Number(savedPane) + 'px');
  // prize add by yanliang for 恢复左侧文件栏宽度, 20261022-end

  bindEvents();
  state.filter = '';
  renderCompareBar();

  // prize add by yanliang for 部署在 Linux 服务器时把路径提示换成服务器路径样式, 20261022-start
  try {
    const ping = await api('ping', {});
    const box = $('#repoPath');
    if (box && ping && ping.platform && ping.platform !== 'win32') {
      box.placeholder = `仓库路径，例如 ${ping.home || '/home/me'}/share/my-project`;
    }
  } catch (e) {}
  // prize add by yanliang for 部署在 Linux 服务器时把路径提示换成服务器路径样式, 20261022-end

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
