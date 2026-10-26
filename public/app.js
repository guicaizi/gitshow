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
  // prize add by yanliang for 提交列表过滤：查询词与筛出的条数, 20261027-start
  search: '',
  shownCount: 0,
  // prize add by yanliang for 提交列表过滤：查询词与筛出的条数, 20261027-end
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
  // prize add by yanliang for markdown 在线预览：是否用渲染视图代替源码 diff, 20261023-start
  mdPreview: localStorage.getItem('gdv.mdPreview') === '1',
  mdToken: 0,
  // prize add by yanliang for markdown 在线预览：是否用渲染视图代替源码 diff, 20261023-end
  // prize add by yanliang for AI 解释：索引、排队状态与右侧解释视图, 20261024-start
  explainIndex: {},
  explainPending: {},
  explainMode: false,
  explainStatus: null,
  explainDocToken: 0,
  explainPoll: null,
  // prize add by yanliang for AI 解释：索引、排队状态与右侧解释视图, 20261024-end
  // prize add by yanliang for 仓库文件树浏览：改动 / 文件 两种左栏模式, 20261023-start
  browse: localStorage.getItem('gdv.browse') === 'files' ? 'files' : 'changes',
  // prize add by yanliang for 纯源码模式 ?mode=source：只留文件树 + 代码 + 跳转, 20261026-start
  sourceMode: false,
  // prize add by yanliang for 纯源码模式 ?mode=source：只留文件树 + 代码 + 跳转, 20261026-end
  browseSel: '',
  browseToken: 0,
  treeCache: new Map(),
  treeOpen: new Set(),
  treeLoading: new Map(),
  // prize add by yanliang for 「文件」搜索：查询词、服务端命中列表与状态机, 20261026-start
  fileQuery: '',
  fileHits: null,
  fileHitTotal: 0,
  fileHitQuery: '',
  fileHitRev: '',
  fileSearchError: '',
  fileSearchBuilding: false,
  fileSearchToken: 0,
  fileSearchTimer: 0,
  // prize add by yanliang for 「文件」搜索：查询词、服务端命中列表与状态机, 20261026-end
  // prize add by yanliang for 仓库文件树浏览：改动 / 文件 两种左栏模式, 20261023-end
  // prize add by yanliang for 文件编辑器：编辑态、原内容、外部改动检测基准, 20261024-start
  editing: false,
  editPath: '',
  editBase: '',
  editDirty: false,
  editMtime: 0,
  // prize add by yanliang for 编辑定位：预览 → 编辑器的锚点, 20261024-start
  editAnchor: null,
  // prize add by yanliang for 编辑定位：预览 → 编辑器的锚点, 20261024-end
  // prize add by yanliang for 编辑定位：编辑器 → 预览的锚点（取消 / 保存后还原位置）, 20261024-start
  browseAnchor: null,
  // prize add by yanliang for 编辑定位：编辑器 → 预览的锚点（取消 / 保存后还原位置）, 20261024-end
  // prize add by yanliang for 文件编辑器：保存后工作区改动列表需要重算，切回「改动」时再刷, 20261024-start
  workingStale: false,
  // prize add by yanliang for 文件编辑器：保存后工作区改动列表需要重算，切回「改动」时再刷, 20261024-end
  // prize add by yanliang for 文件编辑器：编辑态、原内容、外部改动检测基准, 20261024-end
  filter: '',
  // prize add by yanliang for 提交面板状态：暂存区数据、勾选集合、amend 与提交说明, 20261022-start
  commitOpen: false,
  commitData: null,
  commitSel: new Set(),
  commitAmend: false,
  commitMsg: '',
  commitBusy: false,
  // prize add by yanliang for 提交面板状态：暂存区数据、勾选集合、amend 与提交说明, 20261022-end
  // prize add by yanliang for 目录选择器状态：当前目录数据与高亮项, 20261023-start
  finderOpen: false,
  finderData: null,
  finderSel: '',
  // prize add by yanliang for 目录选择器状态：当前目录数据与高亮项, 20261023-end
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

// prize add by yanliang for markdown 在线预览：轻量渲染器（零依赖，先转义再套语法）, 20261023-start
const MD_RE = /\.(md|markdown|mdx)$/i;

function isMarkdown(p) {
  return MD_RE.test(String(p || '').split('?')[0].split('#')[0]);
}

// 当前预览的文件上下文，图片等相对路径要靠它换算
let mdCtx = { file: '', rev: '' };

function mdDir(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

function mdJoin(baseDir, rel) {
  const out = [];
  for (const seg of (baseDir + rel).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

// 仓库内相对资源（图片/附件）-> /api/raw，否则浏览器按页面地址会 404
function mdAssetUrl(src) {
  const s = String(src || '').trim();
  if (!s || /^(https?:|data:|blob:|\/|#)/i.test(s)) return s;
  let decoded = s;
  try {
    decoded = decodeURI(s);
  } catch (_) {}
  const rel = mdJoin(mdDir(mdCtx.file), decoded);
  const qs = new URLSearchParams({ repo: state.repo, path: rel });
  if (mdCtx.rev) qs.set('rev', mdCtx.rev);
  return `/api/raw?${qs.toString()}`;
}

// 行内语法；入参必须是已经 esc 过的纯文本，code 内的标记用占位符保护
function mdInline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(c);
    return `\u0001${codes.length - 1}\u0001`;
  });

  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g, (_m, alt, src) => {
    return `<img src="${mdAssetUrl(src)}" alt="${alt}" loading="lazy">`;
  });
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)[^)]*\)/g, (_m, txt, href) => {
    if (href.startsWith('#')) return `<a href="${href}">${txt}</a>`;
    const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
    const url = external ? href : mdAssetUrl(href);
    return `<a href="${url}"${external || url.startsWith('/api/raw') ? ' target="_blank" rel="noopener"' : ''}>${txt}</a>`;
  });

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  return s.replace(/\u0001(\d+)\u0001/g, (_m, i) => `<code>${codes[Number(i)] || ''}</code>`);
}

function mdCells(line) {
  let s = String(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|');
}

// 列表按缩进还原嵌套，level 为缩进层级（2 空格一级）
function mdList(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    while (stack.length && stack[stack.length - 1].level > it.level) html += `</li></${stack.pop().tag}>`;
    if (!stack.length || stack[stack.length - 1].level < it.level) {
      html += `<${tag}>`;
      stack.push({ tag, level: it.level });
    } else if (stack[stack.length - 1].tag !== tag) {
      html += `</li></${stack.pop().tag}><${tag}>`;
      stack.push({ tag, level: it.level });
    } else {
      html += '</li>';
    }
    let t = esc(it.text);
    const task = t.match(/^\[([ xX])\]\s+([\s\S]*)$/);
    if (task) t = `<span class="md-task${/[xX]/.test(task[1]) ? ' on' : ''}"></span>` + task[2];
    // 这里先不闭合 li：更深的子列表要嵌在当前 li 里，闭合交给下一个 item 或收尾
    html += `<li>${mdInline(t)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

// 返回 HTML 字符串；文档里的标签一律 esc，不执行
function markdownToHtml(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const blockStart = (t) =>
    /^\s{0,3}(#{1,6}\s|```|~~~|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(t) ||
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(t);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块：内部不再解析任何语法
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/);
    if (fence) {
      const mark = fence[1];
      const lang = fence[2].trim().replace(/^\{?\.?/, '').replace(/\}?$/, '');
      const body = [];
      i++;
      const closeRe = new RegExp('^\\s{0,3}' + mark[0] + '{' + mark.length + ',}\\s*$');
      while (i < lines.length && !closeRe.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(
        `<pre class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${mdInline(esc(h[2]))}</h${lv}>`);
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 表格：本行含 | 且下一行是 --- 分隔行
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      /^\s*\|?[\s:|-]+$/.test(lines[i + 1])
    ) {
      const head = mdCells(line);
      const aligns = mdCells(lines[i + 1]).map((c) => {
        const t = c.trim();
        if (/^:-+:$/.test(t)) return 'center';
        if (/^-+:$/.test(t)) return 'right';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(mdCells(lines[i++]));
      const cell = (tag, val, k) => {
        const al = aligns[k] ? ` class="ta-${aligns[k]}"` : '';
        return `<${tag}${al}>${mdInline(esc(String(val == null ? '' : val).trim()))}</${tag}>`;
      };
      out.push(
        '<div class="md-table-wrap"><table><thead><tr>' +
          head.map((c, k) => cell('th', c, k)).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_c, k) => cell('td', r[k], k)).join('') + '</tr>').join('') +
          '</tbody></table></div>'
      );
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        items.push({
          level: Math.min(Math.floor(m[1].replace(/\t/g, '  ').length / 2), 5),
          ordered: /\d/.test(m[2]),
          text: m[3],
        });
        i++;
      }
      out.push(mdList(items));
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) para.push(lines[i++].trim());
    if (!para.length) {
      i++;
      continue;
    }
    out.push(`<p>${mdInline(esc(para.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

// 预览取哪个版本：提交详情看该提交，对比看目标版本，工作区直接读磁盘
function previewRev() {
  const d = state.detail;
  if (!d) return 'worktree';
  if (d.kind === 'commit') return d.hash || 'worktree';
  if (d.kind === 'compare') return d.head || 'worktree';
  return 'worktree';
}

async function renderMdPreview(path) {
  const body = $('#diffPaneBody');
  if (!body) return;
  const token = ++state.mdToken;
  try {
    const data = await api('file', { path, rev: previewRev() });
    if (token !== state.mdToken) return;
    if (data.binary) {
      body.innerHTML = '<div class="binary-note">这是二进制文件，没法预览</div>';
      return;
    }
    if (data.tooLarge) {
      body.innerHTML = '<div class="empty-note">文件超过 2MB，切到「源码」看改动更合适</div>';
      return;
    }
    mdCtx = { file: data.path, rev: data.rev === 'worktree' ? '' : data.rev };
    body.innerHTML = `<article class="md-view">${markdownToHtml(data.content)}</article>`;
    body.scrollTop = 0;
  } catch (err) {
    if (token !== state.mdToken) return;
    body.innerHTML = `<div class="empty-note">预览失败：${esc(err.message)}</div>`;
  }
}
// prize add by yanliang for markdown 在线预览：轻量渲染器（零依赖，先转义再套语法）, 20261023-end

// prize add by yanliang for 超大提交：整份补丁读不出来时用 numstat 的清单顶上，点文件再单读, 20261028-start
// 根提交（仓库第一次导入）动辄上万个文件、上百 MB 补丁，服务端会读爆缓冲，
// 这里只拿「路径 + 增删行数」先把左栏树撑起来，右侧选中哪个文件才去读那个文件的 diff。
function lazyFilesFromNumstat(d) {
  const root = !(d.parents || []).length;
  return (d.files || []).map((x) => ({
    oldPath: x.path,
    newPath: x.path,
    path: x.path,
    // 根提交里的文件都是新增；其它情况没有状态信息，按修改处理
    status: root ? 'A' : 'M',
    binary: !!x.binary,
    hunks: [],
    additions: x.additions,
    deletions: x.deletions,
    header: '',
    mode: langProfile(x.path),
    lazy: !x.binary,
  }));
}

async function ensureFilePatch(f) {
  const d = state.detail;
  if (!f || !f.lazy || f.patchLoading || !d || d.kind !== 'commit') return;
  f.patchLoading = true;
  try {
    const res = await api('file-diff', {
      hash: d.hash,
      path: f.path,
      ignoreSpace: state.ignoreSpace ? '1' : '0',
    });
    const one = parsePatch(res.patch || '')[0];
    if (one) {
      f.hunks = one.hunks;
      f.status = one.status || f.status;
      f.binary = one.binary;
      f.additions = one.additions;
      f.deletions = one.deletions;
    }
    f.lazy = false;
  } catch (err) {
    f.lazy = false;
    f.loadError = err.message || '读取失败';
  } finally {
    f.patchLoading = false;
    if (state.selected === f.path) renderSelectedFile();
  }
}
// prize add by yanliang for 超大提交：整份补丁读不出来时用 numstat 的清单顶上，点文件再单读, 20261028-end

function renderSelectedFile() {
  const pane = $('#diffPane');
  if (!pane) return;

  const f = (state.files || []).find((x) => x.path === state.selected);
  if (!f) {
    pane.innerHTML = '<div class="pane-empty">在左侧选择一个文件，这里显示它的改动</div>';
    return;
  }

  // prize add by yanliang for markdown 文件可切换渲染预览, 20261023-start
  const md = isMarkdown(f.path);
  const mdMode = md && state.mdPreview;
  // prize add by yanliang for 超大提交里未加载的文件先显示占位，等它的补丁回来再重绘, 20261028-start
  const pending = !!f.lazy && !f.hunks.length;
  const body = mdMode
    ? '<div class="md-loading">加载文档…</div>'
    : pending
      ? '<div class="skeleton">正在读取这个文件的改动…</div>'
      : f.loadError
        ? `<div class="skeleton">读取这个文件的改动失败：${esc(f.loadError)}</div>`
        : diffBodyHtml(f);
  if (pending) ensureFilePatch(f);
  // prize add by yanliang for 超大提交里未加载的文件先显示占位，等它的补丁回来再重绘, 20261028-end
  const mdBtn = md
    ? `<button class="btn tiny md-toggle${mdMode ? ' on' : ''}" id="mdToggle" title="${
        mdMode ? '显示这个文件的逐行改动' : '把文档渲染成排版后的样子'
      }">${mdMode ? '源码' : '预览'}</button>`
    : '';
  // prize add by yanliang for markdown 文件可切换渲染预览, 20261023-end

  const ops = f.live
    ? { stage: !!(f.untracked || f.dirty), unstage: !!f.staged, ignore: !!f.untracked }
    : null;
  const renamed = f.status === 'R' && f.oldPath && f.oldPath !== f.newPath;
  const pathHtml = renamed
    ? `<span class="old-path">${esc(f.oldPath)}</span><span class="arrow">→</span>${esc(f.path)}`
    : esc(f.path);
  // prize add by yanliang for 改动详情：还原到修改之前（HEAD 版本）, 20261024-start
  // 只对 HEAD 里存在的路径给入口：未跟踪 / 新增文件没有「修改之前」可言
  const canDiscard = !!(f.live && !f.untracked && f.status !== 'A');
  const discardBtn = canDiscard
    ? `<button class="btn tiny danger" data-discard="${esc(f.path)}" title="丢弃这个文件的全部改动，恢复成 HEAD 版本">还原</button>`
    : '';
  // prize add by yanliang for 改动详情：还原到修改之前（HEAD 版本）, 20261024-end

  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-start
  pane.classList.toggle('split-mode', state.view === 'split' && !mdMode);
  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-end
  pane.innerHTML = `
    <div class="diff-pane-head" data-file="${esc(f.path)}">
      <span class="file-status st-${f.status}">${f.status}</span>
      ${f.staged ? '<span class="staged-dot" title="已在暂存区"></span>' : ''}
      <span class="pane-file-path" title="${esc(f.path)}">${pathHtml}</span>
      ${mdBtn}
      <span class="file-stat">
        ${renderStatBars(f.additions, f.deletions)}
        <span class="stat-add">+${f.additions}</span>
        <span class="stat-del">-${f.deletions}</span>
      </span>
      ${renderRowOps(ops, 'file')}
      ${discardBtn}
    </div>
    <div class="diff-pane-body${mdMode ? ' md-body' : ''}" id="diffPaneBody">${body}</div>
    <div class="split-handle" id="splitHandle" title="拖动调整左右比例，双击复位"></div>`;

  // prize add by yanliang for markdown 文件可切换渲染预览, 20261023-start
  if (mdMode) renderMdPreview(f.path);
  // prize add by yanliang for markdown 文件可切换渲染预览, 20261023-end

  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-start
  updateSplitHandle();
  // prize add by yanliang for 并排视图左右栏比例可拖动调整, 20261023-end
  // 预览模式下工具条要收起源码相关开关
  renderToolbar();
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

// prize add by yanliang for 仓库文件树：改动 / 文件 双模式，文件按层懒加载, 20261023-start
// 文件树看哪个版本：提交详情看该提交，比对看目标提交，工作区看 HEAD（内容仍读磁盘最新）
function browseRev() {
  const d = state.detail;
  if (!d) return 'HEAD';
  if (d.kind === 'commit') return d.hash || 'HEAD';
  if (d.kind === 'compare') return d.head || 'HEAD';
  return 'HEAD';
}

// prize add by yanliang for 文件内容按视图取版本：工作区读磁盘当前内容，提交 / 比对读对应快照, 20261024-start
// 树仍按 browseRev()（工作区看 HEAD 的文件清单），但正文必须是磁盘上的那一份，
// 否则和「编辑」里打开的、真正要改的内容对不上
function browseFileRev() {
  const d = state.detail;
  if (d && d.kind === 'commit') return d.hash || 'HEAD';
  if (d && d.kind === 'compare') return d.head || 'HEAD';
  return 'worktree';
}
// prize add by yanliang for 文件内容按视图取版本：工作区读磁盘当前内容，提交 / 比对读对应快照, 20261024-end

const REVEAL_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5"/><path d="M8 1.2v2.1M8 12.7v2.1M1.2 8h2.1M12.7 8h2.1"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>';

// 展开整条祖先链并选中目标文件；silent=true 时失败不弹提示（切换 tab 用）
async function revealInTree(path, silent) {
  const target = String(path || '');
  if (!target) return false;
  if (!state.treeCache.has('')) await loadTreeDir('', true);

  const parts = target.split('/').filter(Boolean);
  let dir = '';
  for (let i = 0; i < parts.length; i++) {
    const data = state.treeCache.get(dir);
    if (!data) return false;
    const name = parts[i];
    if (i === parts.length - 1) {
      if (!data.files.some((f) => f.name === name)) {
        if (!silent) toast('当前版本里找不到这个文件，可能已被改名或删除', true);
        return false;
      }
      break;
    }
    const child = data.dirs.find((d) => d.name === name);
    if (!child) {
      if (!silent) toast('「改动」里选中的文件不在当前版本中', true);
      return false;
    }
    state.treeOpen.add(child.path);
    if (!state.treeCache.has(child.path)) {
      await loadTreeDir(child.path, true);
      if (!state.treeCache.has(child.path)) return false;
    }
    dir = child.path;
  }
  // prize add by yanliang for 文件编辑器：定位会换掉选中文件，先确认放弃修改, 20261024-start
  if (state.browseSel !== target && !confirmLeaveEdit()) return false;
  // prize add by yanliang for 文件编辑器：定位会换掉选中文件，先确认放弃修改, 20261024-end
  state.browseSel = target;
  return true;
}

function repaintBrowseTree() {
  // prize add by yanliang for 「文件」搜索：搜索命中列表在显示时，目录树的重绘不能盖掉它, 20261026-start
  if (state.browse === 'files' && state.fileQuery.trim()) return;
  // prize add by yanliang for 「文件」搜索：搜索命中列表在显示时，目录树的重绘不能盖掉它, 20261026-end
  paintFileSidebar(false);
}

// prize add by yanliang for 文件详情定位：滚动到树里的选中项，可选居中 + 高亮, 20261026-start
function scrollToBrowseSel(center) {
  const el = document.querySelector('.bnode.file.on');
  if (!el) return;
  el.scrollIntoView({ block: center ? 'center' : 'nearest' });
  if (!center) return;
  el.classList.remove('flash');
  void el.offsetWidth; // 强制回流，动画才能重放
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1500);
}

// 详情头部的「定位」：逐层展开左栏目录并滚到当前文件。搜索命中列表会盖住目录树，先退回目录树。
async function locateInTree(path) {
  const target = String(path || '');
  if (!target || state.browse !== 'files') return false;
  if (state.fileQuery) clearFileSearch(false);
  const ok = await revealInTree(target);
  repaintBrowseTree(); // 逐层加载是静默的，失败时也要把树画出来
  if (!ok) return false;
  scrollToBrowseSel(true);
  return true;
}
// prize add by yanliang for 文件详情定位：滚动到树里的选中项，可选居中 + 高亮, 20261026-end

function browseTabsHtml() {  const n = (state.files || []).length;
  const files = state.browse === 'files';
  return `<div class="pane-tabs" id="paneTabs">
    <button class="pane-tab${files ? '' : ' on'}" data-browse="changes">改动<span class="tab-num">${n}</span></button>
    <button class="pane-tab${files ? ' on' : ''}" data-browse="files">文件</button>
  </div>`;
}

function paneHeadHtml() {
  // 文件模式下给一个「定位到改动里选中的文件」的入口
  const revealBtn =
    state.browse === 'files' && state.selected
      ? `<button class="pane-icon-btn" id="revealChange" title="定位到「改动」里选中的文件">${REVEAL_ICON}</button>`
      : '';
  return `<div class="pane-head-row">${browseTabsHtml()}${revealBtn}</div>${
    state.browse === 'files'
      ? // prize add by yanliang for 「文件」搜索：目录树上方的搜索框, 20261026-start
        `<div class="file-search-wrap${state.fileQuery ? ' has-q' : ''}">
      <input class="file-filter" id="fileSearch" spellcheck="false" autocomplete="off"
        placeholder="搜索文件路径…" value="${esc(state.fileQuery)}" />
      <button class="file-search-clear" id="fileSearchClear" title="清空搜索（Esc）">✕</button>
    </div>`
      : // prize add by yanliang for 「文件」搜索：目录树上方的搜索框, 20261026-end
        `<input class="file-filter" id="fileFilter" placeholder="筛选文件…" value="${esc(state.filter)}" />`
  }`;
}

function switchBrowse(mode) {
  if (state.browse === mode) return;
  // prize add by yanliang for 文件编辑器：离开「文件」视图会丢掉编辑，先确认, 20261024-start
  if (mode !== 'files' && state.editing) {
    if (!confirmLeaveEdit()) return;
    resetEditState();
  }
  // prize add by yanliang for 文件编辑器：离开「文件」视图会丢掉编辑，先确认, 20261024-end
  state.browse = mode;
  localStorage.setItem('gdv.browse', mode);
  // prize add by yanliang for 文件编辑器：编辑保存过文件，切回「改动」时重算一次列表, 20261024-start
  if (mode === 'changes' && state.workingStale) {
    state.workingStale = false;
    if (!state.detail || state.detail.kind === 'working') {
      // 从没加载过工作区就整份拉一次，否则只刷新已有详情
      const job = state.detail ? refreshWorking() : openWorkingTree();
      job.then(() => {
        if (state.browse === 'changes') renderBrowserPane();
      });
      renderToolbar();
      return;
    }
  }
  // prize add by yanliang for 文件编辑器：编辑保存过文件，切回「改动」时重算一次列表, 20261024-end
  renderBrowserPane();
  renderToolbar();
  // 切到文件树时，自动定位到「改动」里选中的那个文件
  if (mode === 'files' && state.selected) {
    revealInTree(state.selected, true).then((ok) => {
      if (!ok) return;
      repaintBrowseTree();
      scrollToBrowseSel();
      renderBrowseFile();
    });
  }
}

// 右栏按当前模式分发：改动视图看 diff，文件视图看内容
function renderRightPane() {
  if (state.browse === 'files') renderBrowseFile();
  else renderSelectedFile();
}

function renderBrowserPane() {
  const head = document.querySelector('.pane-head');
  const treePane = document.querySelector('.file-tree');
  if (!head || !treePane) return;

  head.innerHTML = paneHeadHtml();

  if (state.browse === 'files') {
    treePane.classList.add('browse-tree');
    // prize add by yanliang for 「文件」搜索：左栏正文统一由 fileSidebarHtml 决定（命中列表 / 目录树）, 20261026-start
    treePane.innerHTML = fileSidebarHtml();
    if (!state.fileQuery.trim() && !state.treeCache.has('')) loadTreeDir('');
    ensureSearchReady();
    // prize add by yanliang for 「文件」搜索：左栏正文统一由 fileSidebarHtml 决定（命中列表 / 目录树）, 20261026-end
  } else {
    treePane.classList.remove('browse-tree');
    treePane.innerHTML = renderTreeNode(buildFileTree(state.files || []), 0);
    applyFilter();
  }
  renderRightPane();
}

// 只请求一层：展开哪个目录才读哪个，仓库再大也只多一次 ls-tree
// 同一目录的并发请求共用一个 Promise（切 tab 时会被两处同时触发）
async function loadTreeDir(dirPath, silent) {
  const key = dirPath || '';
  let pending = state.treeLoading.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const data = await api('tree', { path: key, rev: browseRev() });
        state.treeCache.set(key, data);
      } catch (err) {
        toast(err.message, true);
        state.treeCache.set(key, { dirs: [], files: [], error: err.message });
      } finally {
        state.treeLoading.delete(key);
      }
    })();
    state.treeLoading.set(key, pending);
  }
  await pending;
  // silent 交给调用方统一重绘（定位时要连开好几层，避免每层都闪一次）
  if (!silent && state.browse === 'files') repaintBrowseTree();
}

function renderBrowseNodes(dirPath, depth) {
  const data = state.treeCache.get(dirPath);
  if (!data) return '';
  const pad = 8 + depth * 13;
  let html = '';
  for (const d of data.dirs) {
    const open = state.treeOpen.has(d.path);
    html += `<div class="bnode dir${open ? ' open' : ''}" data-bdir="${esc(d.path)}" style="padding-left:${pad}px">
      <span class="bcaret">${open ? '▾' : '▸'}</span><span class="bname">${esc(d.name)}</span></div>`;
    if (open) {
      html += state.treeCache.has(d.path)
        ? renderBrowseNodes(d.path, depth + 1)
        : `<div class="bnode-load" style="padding-left:${pad + 13}px">读取中…</div>`;
    }
  }
  for (const f of data.files) {
    // prize add by yanliang for 文件树上标出哪些文件已有解释文档, 20261024-start
    const ex = state.explainIndex[f.path] ? '<i class="bex-dot" title="已有解释文档"></i>' : '';
    // prize add by yanliang for 文件树上标出哪些文件已有解释文档, 20261024-end
    html += `<div class="bnode file${f.path === state.browseSel ? ' on' : ''}" data-bfile="${esc(
      f.path
    )}" style="padding-left:${pad}px" title="${esc(f.path)}">
      <span class="bcaret"></span><span class="bname">${esc(f.name)}</span>${ex}</div>`;
  }
  return html;
}

// prize add by yanliang for 「文件」搜索：全量路径 + 本地过滤 + 命中列表, 20261026-start
// 目录树是按层懒加载的，没展开的目录不在缓存里，所以搜索不走 treeCache，另拉一份全量路径
const FILE_SEARCH_MAX = 200;
const FILE_SEARCH_DEBOUNCE = 220;

// 左栏正文：改动模式是目录树，文件模式是「搜索命中列表」或目录树
function fileSidebarHtml() {
  if (state.browse !== 'files') return renderTreeNode(buildFileTree(state.files || []), 0);
  if (!state.fileQuery.trim()) {
    return state.treeCache.has('')
      ? renderBrowseNodes('', 0)
      : '<div class="bnode-load">读取目录…</div>';
  }
  return fileSearchHtml();
}

function paintFileSidebar(resetScroll) {
  const treePane = document.querySelector('.file-tree');
  if (!treePane) return;
  const top = treePane.scrollTop;
  treePane.innerHTML = fileSidebarHtml();
  treePane.scrollTop = resetScroll ? 0 : top;
}

// 搜索交给服务端：大仓库（ALPS 全量树 147 万文件）没法把路径清单整包塞进浏览器，
// 命中项只回前 FILE_SEARCH_MAX 条，排序也在服务端做。
function scheduleFileSearch(delay) {
  clearTimeout(state.fileSearchTimer);
  state.fileSearchTimer = setTimeout(fetchFileSearch, delay);
}

async function fetchFileSearch() {
  const raw = state.fileQuery.trim();
  if (!raw) return;
  const rev = browseRev();
  const token = ++state.fileSearchToken;
  try {
    const data = await api('tree-search', { rev, q: raw, limit: FILE_SEARCH_MAX });
    if (token !== state.fileSearchToken) return;
    // 首次搜索时服务端要先把这个版本的文件清单流式读一遍，没好就过一会再问
    if (data.state === 'building') {
      state.fileSearchBuilding = true;
      state.fileHits = null;
      paintFileSidebar(true);
      scheduleFileSearch(800);
      return;
    }
    state.fileSearchBuilding = false;
    state.fileSearchError = '';
    state.fileHits = Array.isArray(data.items) ? data.items : [];
    state.fileHitTotal = Number(data.total) || state.fileHits.length;
    state.fileHitQuery = raw;
    state.fileHitRev = rev;
    paintFileSidebar(true);
  } catch (err) {
    if (token !== state.fileSearchToken) return;
    state.fileSearchBuilding = false;
    state.fileHits = null;
    state.fileSearchError = `读取文件列表失败：${err.message}`;
    paintFileSidebar(true);
  }
}

function stopFileSearch() {
  clearTimeout(state.fileSearchTimer);
  state.fileSearchTimer = 0;
  state.fileSearchToken += 1; // 作废在途请求
}

// 先转义再拼高亮，避免文件名里的 < > 被当成标签
function hlMatch(text, at, len) {
  if (at < 0 || !len) return esc(text);
  return `${esc(text.slice(0, at))}<mark class="fhit">${esc(text.slice(at, at + len))}</mark>${esc(text.slice(at + len))}`;
}

function fileSearchHtml() {
  const raw = state.fileQuery.trim();
  if (state.fileSearchError) return `<div class="bnode-load">${esc(state.fileSearchError)}</div>`;
  if (state.fileSearchBuilding) {
    return '<div class="bnode-load">正在建立文件索引…<br>文件多的仓库首次搜索需要十几秒</div>';
  }
  if (!state.fileHits) return '<div class="bnode-load">读取文件列表…</div>';
  if (!state.fileHits.length) return `<div class="bnode-load">没有匹配「${esc(raw)}」的文件</div>`;

  const q = raw.toLowerCase();
  const total = state.fileHitTotal || state.fileHits.length;
  const more = total > state.fileHits.length ? ` · 仅显示前 ${state.fileHits.length} 个` : '';
  let html = `<div class="sfile-tip">${total} 个匹配${more}</div>`;
  for (const path of state.fileHits) {
    const slash = path.lastIndexOf('/');
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
    const nameAt = name.toLowerCase().indexOf(q);
    // 查询词跨了目录分隔符时名字里找不到，就到目录里找位置
    const dirAt = nameAt < 0 ? dir.toLowerCase().indexOf(q) : -1;
    const ex = state.explainIndex[path] ? '<i class="bex-dot" title="已有解释文档"></i>' : '';
    html += `<div class="bnode file sfile${path === state.browseSel ? ' on' : ''}" data-sfile="${esc(
      path
    )}" title="${esc(path)}"><span class="sfile-dir">${
      dir ? hlMatch(dir, dirAt, q.length) : ''
    }</span><span class="sfile-name">${hlMatch(name, nameAt, q.length)}</span>${ex}</div>`;
  }
  return html;
}

function onFileSearchInput(value) {
  state.fileQuery = value;
  const wrap = document.querySelector('.file-search-wrap');
  if (wrap) wrap.classList.toggle('has-q', !!value);
  state.fileSearchError = '';
  if (!value.trim()) {
    stopFileSearch();
    state.fileHits = null;
    state.fileHitTotal = 0;
    state.fileSearchBuilding = false;
    paintFileSidebar(true);
    return;
  }
  paintFileSidebar(true); // 先用上一轮命中顶着，防抖后再发请求
  scheduleFileSearch(FILE_SEARCH_DEBOUNCE);
}

// 有查询但还没拿到命中时补一次；重绘左栏、换版本后也调它
function ensureSearchReady() {
  const raw = state.fileQuery.trim();
  if (!raw || state.fileSearchBuilding) return;
  if (state.fileHits && state.fileHitQuery === raw && state.fileHitRev === browseRev()) return;
  scheduleFileSearch(0);
}

function clearFileSearch(focus) {
  if (!state.fileQuery) return false;
  state.fileQuery = '';
  const wrap = document.querySelector('.file-search-wrap');
  if (wrap) wrap.classList.remove('has-q');
  const input = $('#fileSearch');
  if (input) {
    input.value = '';
    if (focus) input.focus();
  }
  stopFileSearch();
  state.fileHits = null;
  state.fileHitTotal = 0;
  state.fileSearchBuilding = false;
  state.fileSearchError = '';
  paintFileSidebar(true);
  return true;
}
// prize add by yanliang for 「文件」搜索：服务端建索引 + 服务端过滤 + 命中列表, 20261026-end

function treeClickNode(el) {
  const dir = el.closest('[data-bdir]');
  if (dir) {
    const path = dir.dataset.bdir;
    if (state.treeOpen.has(path)) state.treeOpen.delete(path);
    else {
      state.treeOpen.add(path);
      if (!state.treeCache.has(path)) loadTreeDir(path);
    }
    const treePane = document.querySelector('.file-tree');
    if (treePane) treePane.innerHTML = renderBrowseNodes('', 0);
    return true;
  }
  // prize add by yanliang for 「文件」搜索：命中列表的行与目录树的行走同一条打开逻辑, 20261026-start
  const file = el.closest('[data-bfile]') || el.closest('[data-sfile]');
  if (file) {
    // prize add by yanliang for 文件编辑器：切文件前确认放弃未保存的修改, 20261024-start
    if (!confirmLeaveEdit()) return true;
    // prize add by yanliang for 文件编辑器：切文件前确认放弃未保存的修改, 20261024-end
    state.browseSel = file.dataset.bfile || file.dataset.sfile;
    // prize add by yanliang for 切文件时清掉上一个文件的解释状态, 20261024-start
    state.explainMode = false;
    state.explainStatus = null;
    // prize add by yanliang for 切文件时清掉上一个文件的解释状态, 20261024-end
    document.querySelectorAll('.bnode.file.on').forEach((n) => n.classList.remove('on'));
    file.classList.add('on');
    renderBrowseFile();
    return true;
  }
  return false;
}

// prize add by yanliang for 代码语法高亮（零依赖，逐行状态机，支持跨行注释/字符串）, 20261023-start
const HL_LANG = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts',
  java: 'java', kt: 'java', kts: 'java', gradle: 'java',
  go: 'go',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c',
  py: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', bat: 'sh', cmd: 'sh',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'css', less: 'css',
  json: 'json',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
};

const HL_KW = {
  js:
    'const let var function return if else for while do break continue class extends new this super import export from default async await try catch finally throw typeof instanceof in of delete void yield switch case static get set null true false undefined NaN',
  ts:
    'const let var function return if else for while do break continue class extends new this super import export from default async await try catch finally throw typeof instanceof in of delete void yield switch case static get set null true false undefined interface type enum implements public private protected readonly declare namespace abstract as satisfies keyof infer never unknown any',
  java:
    'public private protected static final abstract class interface enum extends implements new return if else for while do switch case break continue try catch finally throw throws import package this super void int long double float boolean char byte short null true false instanceof synchronized volatile transient native default record var final',
  go:
    'package import func var const type struct interface map chan go defer return if else for range switch case break continue fallthrough select default nil true false string int int64 int32 float64 float32 bool byte rune error make new len cap append panic recover',
  c:
    'int char float double void long short unsigned signed struct union enum typedef static const extern return if else for while do switch case break continue goto sizeof volatile register inline NULL nullptr class namespace using template typename public private protected virtual override new delete this true false auto constexpr include define ifndef endif pragma',
  py:
    'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False async await self print len range str int float dict list set tuple',
  sh:
    'if then else elif fi for while do done case esac function return export local readonly source echo cd exit set unset shift eval exec trap alias printf read test',
  sql:
    'select from where insert into values update set delete create table drop alter add index join left right inner outer on group by order having limit offset as and or not null distinct count sum avg min max case when then end',
  json: 'true false null',
  yaml: 'true false null yes no on off',
};

// 简体规则表：行注释前缀 / 块注释 / 字符串引号 / 关键字集合
const HL_SYN = {
  js: { line: '//', block: ['/*', '*/'], quotes: '"\'`', kw: 'js', ml: '`' },
  ts: { line: '//', block: ['/*', '*/'], quotes: '"\'`', kw: 'ts', ml: '`' },
  java: { line: '//', block: ['/*', '*/'], quotes: '"\'', kw: 'java' },
  go: { line: '//', block: ['/*', '*/'], quotes: '"`', kw: 'go', ml: '`' },
  c: { line: '//', block: ['/*', '*/'], quotes: '"\'', kw: 'c' },
  py: { line: '#', block: null, quotes: '"\'', kw: 'py' },
  sh: { line: '#', block: null, quotes: '"\'', kw: 'sh' },
  sql: { line: '--', block: ['/*', '*/'], quotes: "'\"", kw: 'sql' },
  xml: { line: null, block: ['<!--', '-->'], quotes: '"\'', kw: null },
  css: { line: null, block: ['/*', '*/'], quotes: '"\'', kw: null },
  json: { line: null, block: null, quotes: '"', kw: 'json' },
  yaml: { line: '#', block: null, quotes: '"\'', kw: 'yaml' },
};

const HL_MAX_LINES = 4000;
const HL_KW_SETS = new Map();
function hlKwSet(name) {
  if (!name) return null;
  if (!HL_KW_SETS.has(name)) {
    HL_KW_SETS.set(name, new Set(String(HL_KW[name] || '').split(/\s+/).filter(Boolean)));
  }
  return HL_KW_SETS.get(name);
}

function langOf(p) {
  const ext = String(p || '').split('.').pop().toLowerCase();
  return HL_LANG[ext] || '';
}

// 逐行扫描；st 在行间传递，保证跨行的 /* */ 与模板字符串也能正确着色
function hlLine(line, syn, kw, st) {
  let out = '';
  let i = 0;
  const n = line.length;
  const span = (cls, text) => (cls ? `<span class="tk tk-${cls}">${esc(text)}</span>` : esc(text));

  while (i < n) {
    if (st.blockEnd) {
      const end = line.indexOf(st.blockEnd, i);
      if (end < 0) {
        out += span(st.blockCls, line.slice(i));
        return out;
      }
      out += span(st.blockCls, line.slice(i, end + st.blockEnd.length));
      i = end + st.blockEnd.length;
      st.blockEnd = '';
      st.blockCls = '';
      continue;
    }

    if (syn.line && line.startsWith(syn.line, i)) {
      out += span('c', line.slice(i));
      return out;
    }

    if (syn.block && line.startsWith(syn.block[0], i)) {
      const startAt = i + syn.block[0].length;
      const end = line.indexOf(syn.block[1], startAt);
      if (end < 0) {
        out += span('c', line.slice(i));
        st.blockEnd = syn.block[1];
        st.blockCls = 'c';
        return out;
      }
      out += span('c', line.slice(i, end + syn.block[1].length));
      i = end + syn.block[1].length;
      continue;
    }

    const ch = line[i];
    if (syn.quotes.includes(ch)) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (j > n) j = n;
      out += span('s', line.slice(i, j));
      if (!closed && syn.ml === ch) {
        st.blockEnd = ch;
        st.blockCls = 's';
      }
      i = j;
      continue;
    }

    // 数字（含 0x、小数、指数、常见后缀）
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._]/.test(line[j])) j++;
      if (j < n && /[eE]/.test(line[j]) && /[0-9+-]/.test(line[j + 1] || '')) {
        j += 2;
        while (j < n && /[0-9]/.test(line[j])) j++;
      }
      while (j < n && /[a-zA-Z]{1,2}$/.test(line.slice(i, j)) && /[flFLuUL]/.test(line[j])) j++;
      out += span('n', line.slice(i, j));
      i = j;
      continue;
    }

    if (/[A-Za-z_$@]/.test(ch)) {
      // 从 i+1 起扫，@ 这类前缀字符本身也算 token，否则 i 不前进会死循环
      let j = i + 1;
      while (j < n && /[\w$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      i = j;
      const bare = word.replace(/^@/, '');
      const after = line[i];
      if (kw && kw.has(bare)) out += span('k', word);
      else if (word.startsWith('@')) out += span('a', word);
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(bare)) out += span('t', word);
      else if (after === '(') out += span('f', word);
      else out += esc(word);
      continue;
    }

    out += esc(ch);
    i++;
  }
  return out;
}

function hlLines(lines, lang) {
  const syn = HL_SYN[lang];
  if (!syn) return null;
  const kw = hlKwSet(syn.kw);
  const st = { blockEnd: '', blockCls: '' };
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) out[i] = hlLine(lines[i], syn, kw, st);
  return out;
}
// prize add by yanliang for 代码语法高亮（零依赖，逐行状态机，支持跨行注释/字符串）, 20261023-end

function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function renderCodeView(text, filePath) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const MAX = 6000;
  const cut = lines.length > MAX;
  const show = cut ? lines.slice(0, MAX) : lines;
  const lang = langOf(filePath);
  // 大文件不上色：span 太多会把排版拖慢
  const hl = lang && show.length <= HL_MAX_LINES ? hlLines(show, lang) : null;
  const w = String(show.length).length;
  // 两个 pre：一个放行号、一个放代码。比「每行一个 div」的节点数少一个量级
  const gutter = show.map((_l, i) => i + 1).join('\n');
  const code = hl ? hl.join('\n') : esc(show.join('\n'));
  const tips = [];
  if (cut) tips.push(`文件较大，只显示前 ${MAX} 行（共 ${lines.length} 行）`);
  else if (lang && !hl) tips.push(`超过 ${HL_MAX_LINES} 行，已关闭语法高亮`);
  const tip = tips.length ? `<div class="fv-cut">${tips.join('　')}</div>` : '';
  return `<div class="file-view${state.wrap ? ' wrap' : ''}" style="--fv-w:${w}"><pre class="fv-gutter">${gutter}</pre><pre class="fv-code">${code}</pre></div>${tip}`;
}

// prize add by yanliang for AI 解释：按钮状态、发起请求、文档渲染与轮询, 20261024-start
const EXPLAIN_TTL_MS = 5 * 60 * 1000;

// 状态优先级：精确状态（已查过）> 排队 > 索引里有文档 > 没有
function explainKindOf(rel) {
  const st = state.explainStatus;
  if (st && st.path === rel && st.state && st.state !== 'none') return st.state;
  const pend = state.explainPending[rel];
  if (pend && !pend.failed) return 'pending';
  if (pend && pend.failed) return 'failed';
  if (state.explainIndex[rel]) return 'ready';
  return 'none';
}

function explainBtnHtml(rel, kind, showing) {
  if (kind === 'pending') {
    const since = (state.explainPending[rel] || {}).requestedAt;
    const wait = since ? relTime(since) : '';
    const tooLong = !!since && Date.now() - new Date(since).getTime() > EXPLAIN_TTL_MS;
    return `<button class="btn tiny explain-btn pending" id="explainBtn" disabled title="${
      tooLong
        ? '排队超过 5 分钟还没处理：切到 WorkBuddy 说一句「处理待办」'
        : '已排队，切到 WorkBuddy 说一句「处理待办」即可生成'
    }">解释中…${wait ? ` ${wait}` : ''}</button>`;
  }
  if (kind === 'failed') {
    return '<button class="btn tiny explain-btn failed" id="explainBtn" title="上次生成失败，重新发起一次">重试解释</button>';
  }
  if (kind === 'ready' || kind === 'stale') {
    const dot = kind === 'stale' ? '<i class="ex-dot" title="代码已变更，这份解释可能过期"></i>' : '';
    const title = showing
      ? '回到源码'
      : kind === 'stale'
        ? '代码已变更，建议对照阅读或重新生成'
        : '查看已生成的解释文档';
    return `<button class="btn tiny explain-btn ready" id="explainBtn" title="${title}">${
      showing ? '看源码' : '看解释'
    }${dot}</button>`;
  }
  return '<button class="btn tiny explain-btn" id="explainBtn" title="由 WorkBuddy 读取这个文件并生成对照解释文档">去解释</button>';
}

async function loadExplainIndex(silent) {
  if (!state.repo) return;
  try {
    const data = await api('explain-index');
    state.explainIndex = data.entries || {};
    state.explainPending = data.pending || {};
  } catch (err) {
    if (!silent) toast('解释索引读取失败：' + err.message, true);
    return;
  }
  if (Object.keys(state.explainPending).length) startExplainPoll();
}

// 单个文件的精确状态：只有这里才知道 blob 有没有变（全树逐个算哈希太贵）
async function refreshExplainStatus(rel) {
  if (!state.repo || !rel) return;
  try {
    const st = await api('explain-status', { path: rel });
    if (state.browseSel !== rel) return;
    state.explainStatus = st;
  } catch {
    state.explainStatus = null;
  }
  patchExplainBtn();
}

// 只换掉按钮本身，避免整块重绘把滚动位置和选中态一起冲掉
function patchExplainBtn() {
  const old = $('#explainBtn');
  const rel = state.browseSel;
  if (!old || !rel) return;
  const holder = document.createElement('span');
  holder.innerHTML = explainBtnHtml(rel, explainKindOf(rel), state.explainMode);
  const next = holder.firstElementChild;
  if (next) old.replaceWith(next);
}

async function requestExplain(rel) {
  const btn = $('#explainBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '提交中…';
  }
  try {
    const data = await postApi('explain-request', { path: rel });
    state.explainStatus = null;
    if (data.state === 'ready') {
      await loadExplainIndex(true);
      toast('这个文件已有解释，直接看就行');
      patchExplainBtn();
      return;
    }
    const req = data.request || {};
    state.explainPending[rel] = { id: req.id, requestedAt: req.requestedAt, blob: req.blob };
    toast('已排队：切到 WorkBuddy 说一句「处理待办」');
    patchExplainBtn();
    startExplainPoll();
  } catch (err) {
    toast('发起失败：' + err.message, true);
    patchExplainBtn();
  }
}

// 生成完成后按钮要自动从「解释中」变成「看解释」，轮询只做这一件事
function startExplainPoll() {
  if (state.explainPoll) return;
  state.explainPoll = setInterval(async () => {
    const before = Object.keys(state.explainPending).length;
    await loadExplainIndex(true);
    const after = Object.keys(state.explainPending).length;
    // 有请求落地了，树上补上解释标记
    if (after < before && state.browse === 'files') repaintBrowseTree();
    const rel = state.browseSel;
    if (rel) {
      // 排队清空后才去问精确状态，否则会把按钮闪回「去解释」
      if (state.explainPending[rel]) patchExplainBtn();
      else await refreshExplainStatus(rel);
    }
    if (!Object.keys(state.explainPending).length) {
      clearInterval(state.explainPoll);
      state.explainPoll = null;
    }
  }, 2500);
}

// prize add by yanliang for 解释文档顶部显示绝对路径，并可一键在文件夹中定位, 20261024-start
// 仓库路径由服务端返回，已是绝对路径；这里只做拼接和斜杠归一，不碰磁盘
function absOf(rel) {
  const repo = String(state.repo || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const clean = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!repo || !clean) return '';
  return `${repo}/${clean}`;
}

function explainPathRow(label, rel) {
  const abs = absOf(rel);
  if (!abs) return '';
  return `<div class="ex-path-row">
      <span class="ex-path-k">${esc(label)}</span>
      <code class="ex-path" data-reveal="${esc(rel)}" title="点击在文件夹中显示">${esc(abs)}</code>
      <button class="ex-reveal" data-reveal="${esc(rel)}" title="在文件夹中显示">↗</button>
    </div>`;
}

async function revealPath(rel) {
  if (!rel) return;
  try {
    const data = await postApi('reveal', { path: rel });
    toast('已定位到：' + data.dir);
  } catch (err) {
    // 服务端进程还没重启时，旧代码里没有这个路由，返回的就是「未知接口」
    const msg = /未知接口/.test(err.message) ? '服务需要重启一次（新版接口还没加载）' : err.message;
    toast('打开位置失败：' + msg, true);
  }
}
// prize add by yanliang for 解释文档顶部显示绝对路径，并可一键在文件夹中定位, 20261024-end

async function renderExplainDoc(rel, entry) {
  const body = $('#diffPaneBody');
  if (!body) return;
  const token = ++state.explainDocToken;
  const docPath = entry.doc || `.gdv/explain/${rel}.md`;
  try {
    const data = await api('file', { path: docPath, rev: 'worktree' });
    if (token !== state.explainDocToken) return;
    if (data.binary || data.tooLarge) {
      body.innerHTML = '<div class="empty-note">解释文档读不出来（二进制或超过 2MB）</div>';
      return;
    }
    const meta = [
      entry.blob ? `blob ${String(entry.blob).slice(0, 7)}` : '',
      entry.commit ? `commit ${String(entry.commit).slice(0, 7)}` : '',
      entry.generatedAt ? fullTime(entry.generatedAt) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const related = (entry.related || []).length
      ? `<span class="ex-related">关联：${entry.related
          .map((p) => `<a href="#" data-explain-file="${esc(p)}">${esc(p)}</a>`)
          .join('、')}</span>`
      : '';
    // prize add by yanliang for 解释文档顶部显示绝对路径，并可一键在文件夹中定位, 20261024-start
    const paths = [explainPathRow('源文件', rel), explainPathRow('解释文档', docPath)]
      .filter(Boolean)
      .join('');
    // prize add by yanliang for 解释文档顶部显示绝对路径，并可一键在文件夹中定位, 20261024-end
    const stale = explainKindOf(rel) === 'stale';
    body.innerHTML = `
      ${paths ? `<div class="explain-paths">${paths}</div>` : ''}
      ${
        stale
          ? '<div class="explain-banner">代码已变更，这份解释可能已经过期，建议先看「去解释」重新生成。</div>'
          : ''
      }
      ${meta || related ? `<div class="explain-meta"><span>${esc(meta)}</span>${related}</div>` : ''}
      <article class="md-view explain-view">${markdownToHtml(data.content)}</article>`;
    body.scrollTop = 0;
  } catch (err) {
    if (token !== state.explainDocToken) return;
    body.innerHTML = `<div class="empty-note">解释文档读取失败：${esc(
      err.message
    )}<br />它应该在 <code>.gdv/explain/</code> 下，可能被删掉了，可以重新发起解释。</div>`;
  }
}

// 解释文档里点关联文件：逐层展开目录并选中
async function jumpToBrowseFile(rel) {
  if (!rel) return;
  if (state.browse !== 'files') {
    state.browse = 'files';
    localStorage.setItem('gdv.browse', 'files');
    renderBrowserPane();
  }
  state.explainMode = false;
  state.explainStatus = null;
  state.browseSel = rel;
  const parts = rel.split('/');
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i];
    state.treeOpen.add(cur);
    if (!state.treeCache.has(cur)) await loadTreeDir(cur, true);
  }
  repaintBrowseTree();
  scrollToBrowseSel();
  renderBrowseFile();
}
// prize add by yanliang for AI 解释：按钮状态、发起请求、文档渲染与轮询, 20261024-end

// prize add by yanliang for 文件编辑器：工作区文件就地编辑与保存, 20261024-start
// 只在「文件」视图 + 工作区版本开放：提交详情里看到的是历史内容，改了会误导
function isWorktreeView() {
  return !state.detail || state.detail.kind === 'working';
}

function canEditFile(path) {
  return state.browse === 'files' && !!path && isWorktreeView();
}

function lineNumbersOf(n) {
  let out = '';
  for (let i = 1; i <= n; i++) out += i === n ? String(i) : i + '\n';
  return out;
}

// 编辑态的状态条：只改文字和 class，不重排 DOM，敲键时不会闪
function setEditState() {
  const ta = $('#edContent');
  const st = $('#edState');
  if (!ta) return;
  state.editDirty = ta.value !== state.editBase;
  if (st) {
    st.textContent = state.editDirty ? '● 未保存' : '编辑中';
    st.classList.toggle('dirty', state.editDirty);
  }
}

// 行号列与 textarea 各自滚动，靠 scrollTop 对齐；行数变了才重建行号文本
function syncEditorGutter() {
  const ta = $('#edContent');
  const g = $('#edGutter');
  if (!ta || !g) return;
  const lines = ta.value.split('\n').length;
  if (Number(g.dataset.lines) !== lines) {
    g.dataset.lines = String(lines);
    g.textContent = lineNumbersOf(lines);
  }
  g.scrollTop = ta.scrollTop;
}

// prize add by yanliang for 编辑定位：预览 ↔ 编辑器双向带位置, 20261024-start
// 两边都用「行号 + 行内偏移」表示位置，滚到半行也能还原。
// textarea 有 padding-top，换算时要减掉，否则会整体偏一行高。

const ANCHOR_LINE_HEIGHT = 19;

function lineHeightOf(el) {
  const lh = parseFloat(getComputedStyle(el).lineHeight || '0') || 0;
  return lh > 0 ? lh : ANCHOR_LINE_HEIGHT;
}

function anchorFrom(scroller, lineHeight, padTop, totalLines) {
  const rel = Math.max(0, (scroller.scrollTop || 0) - padTop);
  const line = Math.min(totalLines, Math.max(1, Math.floor(rel / lineHeight) + 1));
  return { line, offset: rel - (line - 1) * lineHeight };
}

function scrollTopOf(anchor, lineHeight, padTop) {
  return Math.max(0, padTop + (anchor.line - 1) * lineHeight + (anchor.offset || 0));
}

function paddingTopOf(el) {
  return parseFloat(getComputedStyle(el).paddingTop || '0') || 0;
}

// 预览 → 编辑器：源码视图滚到哪一行，编辑器就开到哪一行
function captureBrowseAnchor() {
  const body = $('#diffPaneBody');
  if (!body) return null;
  const gutter = body.querySelector('.fv-gutter');
  if (!gutter) return null; // markdown 预览没有行号柱，排版正文和源码行号对不上
  const lineCount = gutter.textContent ? gutter.textContent.split('\n').length : 0;
  if (!lineCount) return null;

  // 自动换行时行号柱不折行、代码在折行，两者高度不再一一对应，只能按比例粗定位
  if (state.wrap) {
    const max = body.scrollHeight - body.clientHeight;
    return { ratio: max > 0 ? body.scrollTop / max : 0, line: 0 };
  }
  return anchorFrom(body, lineHeightOf(gutter), 0, lineCount);
}

function applyEditorAnchor(ta) {
  const anchor = state.editAnchor;
  state.editAnchor = null;
  if (!ta) return;
  if (!anchor) {
    ta.setSelectionRange(0, 0);
    return;
  }
  if (!anchor.line) {
    ta.setSelectionRange(0, 0);
    ta.focus({ preventScroll: true });
    ta.scrollTop = anchor.ratio * Math.max(0, ta.scrollHeight - ta.clientHeight);
    return;
  }
  const lines = ta.value.split('\n');
  let pos = 0;
  for (let i = 0; i < anchor.line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  ta.setSelectionRange(pos, pos);
  // preventScroll：否则 focus 会先把光标滚进来，再被下面的 scrollTop 覆盖一次，视觉上会闪
  ta.focus({ preventScroll: true });
  ta.scrollTop = scrollTopOf(anchor, lineHeightOf(ta), paddingTopOf(ta));
}

// 编辑器 → 预览：取消 / 保存后回到同一行
function captureEditorAnchor() {
  const ta = $('#edContent');
  if (!ta) return null;
  const total = ta.value ? ta.value.split('\n').length : 1;
  return anchorFrom(ta, lineHeightOf(ta), paddingTopOf(ta), total);
}

function applyBrowseAnchor() {
  const anchor = state.browseAnchor;
  state.browseAnchor = null;
  if (!anchor) return;
  const body = $('#diffPaneBody');
  if (!body) return;
  const gutter = body.querySelector('.fv-gutter');
  if (!gutter) return; // markdown 预览下没有行号柱，放弃精确对位
  body.scrollTop = scrollTopOf(anchor, lineHeightOf(gutter), 0);
}
// prize add by yanliang for 编辑定位：预览 ↔ 编辑器双向带位置, 20261024-end

async function enterEdit(path) {
  try {
    // prize add by yanliang for 编辑定位：进编辑器前先记住预览滚到哪一行, 20261024-start
    // 必须在 await 之前抓：await 之后右栏可能已被别的渲染覆盖
    const anchor = captureBrowseAnchor();
    // prize add by yanliang for 编辑定位：进编辑器前先记住预览滚到哪一行, 20261024-end
    // 不带 rev：永远读工作区磁盘内容，这才是保存时要覆盖的东西
    const data = await api('file', { path });
    if (data.binary) return toast('二进制文件不能编辑', true);
    if (data.tooLarge) return toast('文件超过 2MB，不支持在线编辑', true);
    state.editing = true;
    state.editPath = data.path || path;
    state.editBase = String(data.content || '').replace(/\r\n?/g, '\n');
    state.editMtime = Number(data.mtimeMs) || 0;
    state.editDirty = false;
    // prize add by yanliang for 编辑定位：把预览位置交给编辑器, 20261024-start
    state.editAnchor = anchor;
    // prize add by yanliang for 编辑定位：把预览位置交给编辑器, 20261024-end
    renderBrowseFile();
    toast('编辑中 · Ctrl+S 保存 · Esc 取消');
  } catch (err) {
    toast('打开编辑器失败：' + err.message, true);
  }
}

function resetEditState() {
  state.editing = false;
  state.editPath = '';
  state.editBase = '';
  state.editDirty = false;
  state.editMtime = 0;
  // prize add by yanliang for 编辑定位：锚点只在一次「预览 → 编辑」之间有效, 20261024-start
  state.editAnchor = null;
  // prize add by yanliang for 编辑定位：锚点只在一次「预览 → 编辑」之间有效, 20261024-end
}

function exitEdit() {
  if (state.editDirty && !confirm('有未保存的修改，确定放弃？')) return false;
  // prize add by yanliang for 编辑定位：回预览前记住编辑器停在哪一行, 20261024-start
  state.browseAnchor = captureEditorAnchor();
  // prize add by yanliang for 编辑定位：回预览前记住编辑器停在哪一行, 20261024-end
  resetEditState();
  renderBrowseFile();
  return true;
}

async function saveEdit() {
  const ta = $('#edContent');
  if (!ta || !state.editPath) return;
  const btn = $('#edSave');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中…';
  }
  try {
    const data = await postApi('save-file', {
      path: state.editPath,
      content: ta.value,
      baseMtimeMs: state.editMtime,
    });
    // prize add by yanliang for 编辑定位：保存后回预览要停在同一行, 20261024-start
    state.browseAnchor = captureEditorAnchor();
    // prize add by yanliang for 编辑定位：保存后回预览要停在同一行, 20261024-end
    resetEditState();
    toast(data.unchanged ? '内容没有变化' : '已保存');
    // prize add by yanliang for 文件编辑器：保存后立刻刷新仓库卡片与工作区改动数据, 20261024-start
    await refreshAfterSave();
    // prize add by yanliang for 文件编辑器：保存后立刻刷新仓库卡片与工作区改动数据, 20261024-end
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '保存';
    }
    toast('保存失败：' + err.message, true);
  }
}

// prize add by yanliang for 文件编辑器：保存后的刷新收口（卡片 / 改动列表 / 当前视图）, 20261024-start
// 工作区数据（左栏「改动」徽标、改动列表、提交列表里的条数）都来自 state.detail，
// 所以保存后必须重拉一次，否则界面会停在「没有改动」的旧状态。
async function refreshAfterSave() {
  try {
    const info = await fetch(`/api/repo?repo=${encodeURIComponent(state.repo)}`).then((r) => r.json());
    if (info && !info.error) {
      state.info = info;
      renderRepoCard();
    }
  } catch (_) {
    /* 卡片刷新失败不影响已保存的结果 */
  }

  if (state.detail && state.detail.kind === 'working') {
    // 刚编辑过的文件在「改动」里选中，切过去就能直接看到自己刚才的修改
    if (state.browseSel) state.selected = state.browseSel;
    // refreshWorking 内部按当前 browse 模式重绘右栏，文件视图不会被切走
    await refreshWorking();
  } else {
    // 还没加载过工作区改动：只重绘当前文件，切到「改动」时再补拉（见 switchBrowse）
    state.workingStale = true;
    renderBrowseFile();
  }
}
// prize add by yanliang for 文件编辑器：保存后的刷新收口（卡片 / 改动列表 / 当前视图）, 20261024-end

// 切文件前的守卫：有改动就先问一句，避免点一下树就把稿子丢了
function confirmLeaveEdit() {
  if (!state.editing || !state.editDirty) return true;
  return confirm('有未保存的修改，确定放弃？');
}

// 右侧面板要被别的视图（提交详情 / 比对 / 工作区 diff）接管前调用
function leaveEditorFor() {
  if (!state.editing) return true;
  if (!confirmLeaveEdit()) return false;
  resetEditState();
  return true;
}

function textBytes(s) {
  try {
    return new TextEncoder().encode(s).length;
  } catch (_) {
    return s.length;
  }
}

function onEditorKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    exitEdit();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveEdit();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start === end) {
      ta.setRangeText('    ', start, end, 'end');
    } else {
      // 多行选中时整体右移一个缩进，而不是把整块替换成一个 Tab
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const block = ta.value.slice(lineStart, end);
      ta.setRangeText(block.replace(/(^|\n)(?=.)/g, '$1    '), lineStart, end, 'select');
    }
    setEditState();
    syncEditorGutter();
  }
}

function renderEditorPane(pane, path) {
  const lineCount = state.editBase ? state.editBase.split('\n').length : 1;
  pane.classList.remove('split-mode');
  pane.innerHTML = `
    <div class="diff-pane-head" data-file="${esc(path)}">
      <span class="pane-file-path" title="${esc(absOf(path) || path)}">${esc(path)}</span>
      <span class="ed-state${state.editDirty ? ' dirty' : ''}" id="edState">${
        state.editDirty ? '● 未保存' : '编辑中'
      }</span>
      <button class="btn tiny primary" id="edSave" title="保存到工作区（Ctrl+S）">保存</button>
      <button class="btn tiny" id="edCancel" title="放弃修改（Esc）">取消</button>
      <span class="file-stat" id="fvStat"><span class="fv-meta">${fmtSize(
        textBytes(state.editBase)
      )} · ${lineCount} 行</span></span>
    </div>
    <div class="diff-pane-body ed-body" id="diffPaneBody">
      <div class="ed-wrap">
        <pre class="ed-gutter" id="edGutter" data-lines="0"></pre>
        <textarea class="ed-area" id="edContent" spellcheck="false" autocomplete="off"
          autocapitalize="off" autocorrect="off" wrap="off"></textarea>
      </div>
    </div>`;

  const ta = $('#edContent');
  ta.value = state.editBase;
  ta.addEventListener('input', () => {
    setEditState();
    syncEditorGutter();
  });
  ta.addEventListener('scroll', syncEditorGutter);
  ta.addEventListener('keydown', onEditorKeydown);
  syncEditorGutter();
  // prize add by yanliang for 编辑定位：从预览位置接管光标与滚动, 20261024-start
  applyEditorAnchor(ta);
  syncEditorGutter();
  // prize add by yanliang for 编辑定位：从预览位置接管光标与滚动, 20261024-end
  renderToolbar();
}
// prize add by yanliang for 文件编辑器：工作区文件就地编辑与保存, 20261024-end

async function renderBrowseFile() {
  const pane = $('#diffPane');
  if (!pane) return;
  const path = state.browseSel;
  if (!path) {
    pane.innerHTML = '<div class="pane-empty">在左侧「文件」里选一个文件，这里显示它的内容</div>';
    renderToolbar();
    return;
  }

  // prize add by yanliang for 文件编辑器：编辑态整块换成编辑视图, 20261024-start
  if (state.editing) {
    if (state.editPath === path) return renderEditorPane(pane, path);
    // 选中文件被别的入口换掉了（URL / 关联跳转）：不再追问，直接退出编辑避免状态错位
    resetEditState();
  }
  // prize add by yanliang for 文件编辑器：编辑态整块换成编辑视图, 20261024-end

  // prize add by yanliang for AI 解释：头部按钮 + 解释文档视图, 20261024-start
  const kind = explainKindOf(path);
  const entry =
    (state.explainStatus && state.explainStatus.path === path ? state.explainStatus.entry : null) ||
    state.explainIndex[path] ||
    null;
  const showDoc = state.explainMode && !!entry && (kind === 'ready' || kind === 'stale');
  // prize add by yanliang for AI 解释：头部按钮 + 解释文档视图, 20261024-end

  const md = isMarkdown(path);
  const mdMode = md && state.mdPreview;
  const editable = canEditFile(path) && !showDoc;
  pane.classList.remove('split-mode');
  pane.innerHTML = `
    <div class="diff-pane-head" data-file="${esc(path)}">
      <button class="btn tiny back-btn" id="jumpBackBtn" disabled title="回到上一个跳转位置（Alt+←）">← 返回</button>
      <span class="pane-file-path" title="${esc(absOf(path) || path)}">${esc(path)}</span>
      <button class="btn tiny locate-btn" id="locateBtn" title="在左侧文件树中展开并定位到这个文件">${REVEAL_ICON}<span>定位</span></button>
      <button class="btn tiny icon-only" id="locateDiskBtn" title="在系统文件管理器中显示这个文件">↗</button>
      ${editable ? '<button class="btn tiny edit-btn" id="editBtn" title="就地编辑这个文件并保存到工作区">编辑</button>' : ''}
      ${explainBtnHtml(path, kind, showDoc)}
      ${
        md && !showDoc
          ? `<button class="btn tiny md-toggle${mdMode ? ' on' : ''}" id="mdToggle" title="${
              mdMode ? '显示源码' : '渲染成排版后的文档'
            }">${mdMode ? '源码' : '预览'}</button>`
          : ''
      }
      <span class="file-stat" id="fvStat"></span>
    </div>
    <div class="diff-pane-body${showDoc ? ' md-body' : ''}" id="diffPaneBody">${
      showDoc ? '<div class="md-loading">读取解释…</div>' : '<div class="md-loading">读取文件…</div>'
    }</div>
    <div class="split-handle" id="splitHandle" style="display:none"></div>`;

  // prize add by yanliang for AI 解释：解释视图只渲染文档，不再读源码, 20261024-start
  if (showDoc) {
    await renderExplainDoc(path, entry);
    renderToolbar();
    refreshExplainStatus(path);
    return;
  }
  refreshExplainStatus(path);
  // prize add by yanliang for AI 解释：解释视图只渲染文档，不再读源码, 20261024-end

  const token = ++state.browseToken;
  try {
    const data = await api('file', { path, rev: browseFileRev() });
    if (token !== state.browseToken) return;
    const stat = $('#fvStat');
    const body = $('#diffPaneBody');
    if (!body) return;
    if (data.binary) {
      if (stat) stat.textContent = fmtSize(data.size);
      // prize add by yanliang for 文件编辑器：二进制文件不提供编辑入口, 20261024-start
      const eb = $('#editBtn');
      if (eb) eb.remove();
      // prize add by yanliang for 文件编辑器：二进制文件不提供编辑入口, 20261024-end
      body.innerHTML = '<div class="binary-note">二进制文件，不显示内容</div>';
      renderToolbar();
      return;
    }
    // prize add by yanliang for 文件编辑器：超过 2MB 的文件同样不给编辑入口（服务端也会拒绝）, 20261024-start
    if (data.tooLarge) {
      const eb = $('#editBtn');
      if (eb) eb.remove();
    }
    // prize add by yanliang for 文件编辑器：超过 2MB 的文件同样不给编辑入口（服务端也会拒绝）, 20261024-end
    const lineCount = data.content ? data.content.split('\n').length : 0;
    if (stat) {
      stat.innerHTML = `<span class="fv-meta">${fmtSize(data.size)} · ${lineCount} 行</span>`;
    }
    if (mdMode) {
      mdCtx = { file: data.path, rev: data.rev === 'worktree' ? '' : data.rev };
      body.innerHTML = `<article class="md-view">${markdownToHtml(data.content)}</article>`;
    } else {
      body.innerHTML = renderCodeView(data.content, data.path);
    }
    // prize add by yanliang for 编辑定位：从编辑器回来时还原到原来那一行, 20261024-start
    applyBrowseAnchor();
    // prize add by yanliang for 编辑定位：从编辑器回来时还原到原来那一行, 20261024-end
  } catch (err) {
    if (token !== state.browseToken) return;
    const body = $('#diffPaneBody');
    // prize add by yanliang for 工作区读取失败时说明「文件已不在磁盘上」, 20261024-start
    const hint =
      browseFileRev() === 'worktree'
        ? '<br />「文件」里显示的是磁盘上的当前内容。这个文件在工作区可能已被删除，可以到「改动」里还原。'
        : '';
    if (body) body.innerHTML = `<div class="empty-note">读取失败：${esc(err.message)}${hint}</div>`;
    // prize add by yanliang for 工作区读取失败时说明「文件已不在磁盘上」, 20261024-end
  }
  renderToolbar();
}

// 切提交 / 刷新工作区时，文件树缓存与展开状态都作废
function resetTreeState() {
  state.treeCache.clear();
  state.treeOpen.clear();
  state.treeLoading.clear();  state.browseToken++;
  // prize add by yanliang for 「文件」搜索：换版本后服务端命中作废（查询词保留）, 20261026-start
  stopFileSearch();
  state.fileHits = null;
  state.fileHitTotal = 0;
  state.fileHitQuery = '';
  state.fileHitRev = '';
  state.fileSearchError = '';
  state.fileSearchBuilding = false;
  // prize add by yanliang for 「文件」搜索：换版本后服务端命中作废（查询词保留）, 20261026-end
}
// prize add by yanliang for 仓库文件树：改动 / 文件 双模式，文件按层懒加载, 20261023-end

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

  // prize add by yanliang for 换了版本才清文件树缓存，同一版本内刷新保持展开状态, 20261023-start
  const treeRev = browseRev();
  if (state.treeRev !== treeRev) {
    resetTreeState();
    state.treeRev = treeRev;
  }
  // prize add by yanliang for 换了版本才清文件树缓存，同一版本内刷新保持展开状态, 20261023-end

  // prize add by yanliang for 超大补丁失败时改用 numstat 清单，避免误报「没有文件改动」, 20261028-start
  const files = d.patchError ? lazyFilesFromNumstat(d) : parsePatch(d.patch || '');
  // prize add by yanliang for 超大补丁失败时改用 numstat 清单，避免误报「没有文件改动」, 20261028-end
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

  if (!files.length && state.browse !== 'files') {
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
  // prize add by yanliang for 改动列表为空时不再访问 files[0]（文件视图下会走到这一行）, 20261024-start
  if (!files.some((f) => f.path === state.selected)) {
    state.selected = firstFileInTree(tree) || (files.length ? files[0].path : '');
  }
  // prize add by yanliang for 改动列表为空时不再访问 files[0]（文件视图下会走到这一行）, 20261024-end

  scroll.innerHTML = `
    <aside class="file-pane" id="filePane">
      <div class="pane-head">${paneHeadHtml()}</div>
      <div class="file-tree${state.browse === 'files' ? ' browse-tree' : ''}">${fileSidebarHtml()}</div>
    </aside>
    <div class="pane-resizer" id="paneResizer" title="拖动调整文件栏宽度，双击复位"></div>
    <section class="diff-pane" id="diffPane"></section>`;

  // prize add by yanliang for 左栏「改动 / 文件」两种模式, 20261023-start
  if (state.browse === 'files') {
    if (!state.fileQuery.trim() && !state.treeCache.has('')) loadTreeDir('');
    ensureSearchReady();
    renderBrowseFile();
  } else {
    renderSelectedFile();
    applyFilter();
  }
  // prize add by yanliang for 左栏「改动 / 文件」两种模式, 20261023-end
  // prize add by yanliang for 左侧文件目录树 + 右侧 diff 双栏布局, 20261022-end

  renderToolbar();
}

/* ---------------- 工具条 ---------------- */
function renderToolbar() {
  const scroll = $('#diffScroll');
  const count = scroll.dataset.count || '0';
  const add = scroll.dataset.add || '0';
  const del = scroll.dataset.del || '0';

  // prize add by yanliang for 预览模式下收起源码视图相关开关, 20261023-start
  const fileMode = state.browse === 'files';
  const mdMode = state.mdPreview && isMarkdown(fileMode ? state.browseSel : state.selected);
  const wrapBtn = `<button class="btn small ${state.wrap ? 'active' : ''}" id="wrapToggle" title="超长代码行自动折行">自动换行</button>`;
  const sourceOps = state.editing
    ? '<span class="md-hint">编辑中 · Ctrl+S 保存 · Esc 取消</span>'
    : mdMode
      ? '<span class="md-hint">Markdown 预览</span>'
      : fileMode
        ? `<span class="md-hint">${isWorktreeView() ? '仓库文件' : '仓库文件（只读）'}</span>${wrapBtn}`
        : `<div class="seg" id="viewSeg">
      <button data-view="split" class="${state.view === 'split' ? 'on' : ''}">并排</button>
      <button data-view="inline" class="${state.view === 'inline' ? 'on' : ''}">内联</button>
    </div>
    <button class="btn small ${state.ignoreSpace ? 'active' : ''}" id="ignoreSpace" title="忽略空格与缩进变化">忽略空白</button>
    ${wrapBtn}`;
  // prize add by yanliang for 预览模式下收起源码视图相关开关, 20261023-end

  $('#diffToolbar').innerHTML = `
    ${sourceOps}
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
    ${state.detail && state.detail.patchError ? `<span class="fact tag-warn" title="整份补丁超过服务端读取上限，点开文件才会读取它的改动">补丁过大 · 按文件加载</span>` : ''}
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

// prize add by yanliang for 提交列表过滤：查询词记在 state 里，每次重绘后自动重新生效, 20261027-start
// 原来只对整个 .commit-item 改 display，列表一重绘（点提交、勾比对、滚动加载）就丢了过滤，
// 现在把查询词存进 state.search，重绘完立刻按它重新筛一遍。
function commitMatchText(c) {
  if (!c) return '';
  return [c.subject, c.author, c.email, c.short, c.hash, (c.refs || []).join(' ')]
    .join(' ')
    .toLowerCase();
}

function applyCommitFilter() {
  const q = (state.search || '').toLowerCase();
  let shown = 0;
  document.querySelectorAll('#commitList .commit-item').forEach((item) => {
    let ok;
    if (!q) ok = true;
    // 工作区改动没有作者，过滤时先收起来，免得混在某个作者的结果里
    else if (item.dataset.worktree) ok = false;
    else ok = commitMatchText(state.commits[Number(item.dataset.idx)]).includes(q);
    item.style.display = ok ? '' : 'none';
    if (ok) shown += 1;
  });
  state.shownCount = shown;
  return shown;
}

function updateListFoot() {
  const foot = $('#listFoot');
  if (!foot) return;
  if (state.loadingCommits) {
    foot.textContent = '加载中…';
    return;
  }
  if (state.search) {
    // 过滤状态下说清「筛出几条 / 一共加载了几条」，剩下的还可以点或滚着继续加载
    const more = state.hasMore ? ' · 点这里或在列表里滚动继续加载' : '';
    foot.textContent = `匹配 ${state.shownCount || 0} / 已加载 ${state.commits.length}${more}`;
    foot.classList.toggle('can-more', !!state.hasMore);
    return;
  }
  foot.classList.remove('can-more');
  foot.textContent = state.hasMore
    ? '滚动加载更多'
    : state.commits.length
      ? `共 ${state.commits.length} 个提交`
      : '';
}
// prize add by yanliang for 提交列表过滤：查询词记在 state 里，每次重绘后自动重新生效, 20261027-end

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
  // prize add by yanliang for 提交列表过滤：重绘后立刻恢复过滤, 20261027-start
  applyCommitFilter();
  updateListFoot();
  // prize add by yanliang for 提交列表过滤：重绘后立刻恢复过滤, 20261027-end
}

/* ---------------- 仓库信息 ---------------- */
// prize add by yanliang for 标题跟着项目名走：顶栏品牌 + 浏览器标签页都换掉, 20261027-start
// 多开几个标签页时全是「Git 提交比对」分不清，现在打开仓库后显示仓库名，没打开就退回原名。
function syncTitle() {
  const name = state.info && state.info.name ? state.info.name : '';
  const brand = $('#brandName');
  if (brand) {
    brand.textContent = name || 'Git 提交比对';
    // 名字长的时候靠 CSS 省略号截断，完整名字放到 title 里
    brand.title = name ? `${name}\n${state.info.repo}` : 'Git 提交比对';
  }
  if (state.sourceMode) document.title = name ? `${name} · 源码浏览` : '源码浏览';
  else document.title = name ? `${name} · Git 提交比对` : 'Git 提交比对';
}
// prize add by yanliang for 标题跟着项目名走：顶栏品牌 + 浏览器标签页都换掉, 20261027-end

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
    // prize add by yanliang for 加载结束后底部提示按过滤状态重算, 20261027-start
    updateListFoot();
    // prize add by yanliang for 加载结束后底部提示按过滤状态重算, 20261027-end
  }
}

// prize add by yanliang for 过滤词也写进地址栏，刷新 / 换分支后还能保持同一个作者, 20261027-start
function syncSearchUrl(q) {
  try {
    const url = new URL(location.href);
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    const search = url.searchParams.toString().replace(/%2F/g, '/');
    history.replaceState(null, '', url.pathname + (search ? '?' + search : '') + url.hash);
  } catch (e) {}
}
// prize add by yanliang for 过滤词也写进地址栏，刷新 / 换分支后还能保持同一个作者, 20261027-end

// prize add by yanliang for 换仓库后同步地址栏，避免刷新时 URL 参数把刚选的仓库覆盖回去, 20261023-start
function syncRepoUrl(repo) {
  try {
    const url = new URL(location.href);
    if (repo) url.searchParams.set('repo', repo);
    else url.searchParams.delete('repo');
    // 换了仓库，之前那个仓库的定位参数（提交 / 对比 / 工作区）已经没有意义
    ['commit', 'cmp', 'working'].forEach((k) => url.searchParams.delete(k));
    // 默认会把路径里的 / 编码成 %2F，这里还原成可读形式
    const search = url.searchParams.toString().replace(/%2F/g, '/');
    history.replaceState(null, '', url.pathname + (search ? '?' + search : '') + url.hash);
  } catch (e) {}
}
// prize add by yanliang for 换仓库后同步地址栏，避免刷新时 URL 参数把刚选的仓库覆盖回去, 20261023-end

async function openRepo(path, opts) {
  if (!path.trim()) {
    toast('请先填写仓库路径', true);
    return false;
  }
  const syncUrl = !opts || opts.syncUrl !== false;
  // 打开失败时要把 state.repo 还原，否则后续请求会打到不存在的仓库
  const prevRepo = state.repo;
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
    // prize add by yanliang for 打开仓库后顶栏标题与标签页换成项目名, 20261027-start
    syncTitle();
    // prize add by yanliang for 打开仓库后顶栏标题与标签页换成项目名, 20261027-end
    // prize add by yanliang for 地址栏跟着选中的仓库走，刷新后不会再回到旧仓库, 20261023-start
    if (syncUrl) syncRepoUrl(state.repo);
    // prize add by yanliang for 地址栏跟着选中的仓库走，刷新后不会再回到旧仓库, 20261023-end
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
    // prize add by yanliang for 换仓库时重置解释索引并重新拉取, 20261024-start
    state.explainIndex = {};
    state.explainPending = {};
    state.explainMode = false;
    state.explainStatus = null;
    loadExplainIndex(true).then(() => {
      if (state.browse === 'files') repaintBrowseTree();
    });
    // prize add by yanliang for 换仓库时重置解释索引并重新拉取, 20261024-end
    // prize add by yanliang for 换仓库时重置目录折叠状态, 20261022-start
    state.collapsedDirs.clear();
    // prize add by yanliang for 换仓库时重置目录折叠状态, 20261022-end
    renderRepoCard();
    renderCompareBar();
    showEmpty('选择一个提交', '查看它改动了哪些文件、每一行的增删，也可以勾选两个提交做跨版本比对。');

    await loadCommits(true);
    // prize add by yanliang for 纯源码模式：打开仓库后直接进工作区文件视图, 20261026-start
    if (state.sourceMode) {
      state.browse = 'files';
      await openWorkingTree();
    }
    // prize add by yanliang for 纯源码模式：打开仓库后直接进工作区文件视图, 20261026-end
    return true;
  } catch (err) {
    state.repo = prevRepo;
    // 之前已经打开过仓库时保留原视图，只提示错误；首次打开失败则回空态
    if (!state.info) renderRepoCard();
    // prize add by yanliang for 打开失败时标题退回上一个仓库（或默认名）, 20261027-start
    syncTitle();
    // prize add by yanliang for 打开失败时标题退回上一个仓库（或默认名）, 20261027-end
    toast(err.message, true);
    return false;
  }
}

// prize add by yanliang for 目录选择器：从磁盘挑一个仓库并记住, 20261023-start
const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"></path></svg>';
const REPO_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"></circle><circle cx="6" cy="18" r="2.4"></circle><circle cx="18" cy="12" r="2.4"></circle><path d="M6 8.4v7.2M8.4 6h4.1a3 3 0 0 1 3 3v.9M8.4 18h4.1a3 3 0 0 0 3-3v-.9"></path></svg>';

function finderShell() {
  return `
    <div class="modal-head">
      <span class="modal-title">选择仓库目录</span>
      <button class="modal-close" data-finder-close title="关闭">&times;</button>
    </div>
    <div class="finder-nav">
      <button class="btn small" id="finderUp" title="上一级目录">上一级</button>
      <button class="btn small" id="finderHome" title="回到用户主目录">主目录</button>
      <input class="finder-path" id="finderPath" spellcheck="false" placeholder="直接输入路径后回车" />
    </div>
    <div class="finder-list" id="finderList"></div>
    <div class="finder-foot">
      <span class="finder-hint" id="finderHint"></span>
      <button class="btn" data-finder-close>取消</button>
      <button class="btn" id="finderPick">选择此目录</button>
    </div>`;
}

function openFinder() {
  state.finderOpen = true;
  state.finderSel = '';
  state.finderData = null;
  $('#finderMask').classList.remove('hidden');
  $('#finderModal').innerHTML = finderShell();
  // 起点优先级：上次浏览的位置 → 当前仓库 → 输入框里手写的路径
  const start =
    localStorage.getItem('gdv.browseDir') ||
    state.repo ||
    ($('#repoPath') ? $('#repoPath').value.trim() : '');
  finderGo(start);
}

function closeFinder() {
  if (!state.finderOpen) return;
  state.finderOpen = false;
  state.finderSel = '';
  state.finderData = null;
  $('#finderMask').classList.add('hidden');
  $('#finderModal').innerHTML = '';
}

async function finderGo(target, isRetry) {
  if (!state.finderOpen) return;
  const list = $('#finderList');
  if (list) list.innerHTML = '<div class="modal-loading">读取目录…</div>';
  try {
    const data = await api('ls', { path: target || '' });
    if (!state.finderOpen) return;
    state.finderData = data;
    state.finderSel = '';
    localStorage.setItem('gdv.browseDir', data.path);
    renderFinder();
  } catch (err) {
    if (!state.finderOpen) return;
    // 记录的上次目录可能已被删除或移动，首次打开时静默退回主目录，别让用户卡在空面板
    if (!isRetry && !state.finderData) return finderGo('', true);
    toast(err.message, true);
    if (list) list.innerHTML = `<div class="finder-empty">${esc(err.message)}</div>`;
  }
}

function renderFinder() {
  const d = state.finderData;
  if (!d) return;

  const pathInput = $('#finderPath');
  if (pathInput && pathInput.value !== d.path) pathInput.value = d.path;

  const up = $('#finderUp');
  if (up) up.disabled = !d.parent;

  const rows = [];
  // Windows 盘根：先给一排盘符，方便换盘
  if (d.drives && d.drives.length) {
    for (const drv of d.drives) {
      rows.push(`<div class="finder-row" data-dir="${esc(drv)}" title="${esc(drv)}">
        <span class="ic">${FOLDER_ICON}</span><span class="finder-name">${esc(drv)}</span>
        <span class="finder-badge">磁盘</span>
      </div>`);
    }
  }
  for (const dir of d.dirs) {
    rows.push(`<div class="finder-row${
      state.finderSel === dir.path ? ' on' : ''
    }" data-dir="${esc(dir.path)}" title="${esc(dir.path)}">
      <span class="ic${dir.isRepo ? ' repo' : ''}">${dir.isRepo ? REPO_ICON : FOLDER_ICON}</span>
      <span class="finder-name">${esc(dir.name)}</span>
      ${dir.isRepo ? '<span class="finder-badge">git</span>' : ''}
    </div>`);
  }

  if (!rows.length) {
    rows.push('<div class="finder-empty">这个目录下没有子目录<br />可以直接点右下角「选择此目录」</div>');
  } else if (d.truncated) {
    rows.push(
      `<div class="finder-empty">目录太多，只显示前 ${d.dirs.length} 个（共 ${d.total} 个）<br />可在上面直接输入完整路径</div>`
    );
  }

  $('#finderList').innerHTML = rows.join('');
  $('#finderList').scrollTop = 0;
  syncFinderFoot();
}

function syncFinderFoot() {
  const d = state.finderData;
  if (!d) return;
  const picked = state.finderSel || d.path;
  const isRepo = state.finderSel
    ? !!(d.dirs.find((x) => x.path === state.finderSel) || {}).isRepo
    : d.isRepo;

  const hint = $('#finderHint');
  if (hint) {
    hint.textContent = (state.finderSel ? '已选：' : '当前：') + picked;
    hint.title = picked;
  }
  const btn = $('#finderPick');
  if (btn) {
    btn.textContent = isRepo ? '打开这个仓库' : '选择此目录';
    btn.classList.toggle('primary', isRepo);
  }
}

async function finderConfirm() {
  const d = state.finderData;
  const target = state.finderSel || (d && d.path);
  if (!target) return;
  closeFinder();
  $('#repoPath').value = target;
  // openRepo 成功后会把路径记进 gdv.repo，刷新时自动打开，这就是“默认”
  await openRepo(target);
}
// prize add by yanliang for 目录选择器：从磁盘挑一个仓库并记住, 20261023-end

async function openCommit(hash) {
  // prize add by yanliang for 文件编辑器：右侧面板要被换掉前先确认放弃修改, 20261024-start
  if (!leaveEditorFor()) return;
  // prize add by yanliang for 文件编辑器：右侧面板要被换掉前先确认放弃修改, 20261024-end
  try {
    $('#detailEmpty').classList.add('hidden');
    $('#detailBody').classList.remove('hidden');
    $('#commitHead').innerHTML = '<div class="skeleton">读取提交详情…</div>';
    $('#diffScroll').innerHTML = '';

    const detail = await api('commit', { hash, ignoreSpace: state.ignoreSpace ? '1' : '0' });
    state.detail = detail;
    // prize add by yanliang for 补丁过大时明确说一句，免得以为提交是空的, 20261028-start
    if (detail.patchError === 'too-large') {
      toast('这次提交的补丁太大，改成按文件加载：点开文件才读取它的改动');
    } else if (detail.patchError) {
      toast('整份补丁读取失败，改成按文件加载', true);
    }
    // prize add by yanliang for 补丁过大时明确说一句，免得以为提交是空的, 20261028-end
    state.active = { hash: detail.hash, kind: 'commit' };
    state.selected = '';
    // prize add by yanliang for 切换提交时重置目录折叠状态, 20261022-start
    state.collapsedDirs.clear();
    // prize add by yanliang for 切换提交时重置目录折叠状态, 20261022-end
    state.filter = '';
    // prize add by yanliang for 「文件」搜索：换版本时收起搜索，避免结果与当前版本对不上, 20261026-start
    state.fileQuery = '';
    // prize add by yanliang for 「文件」搜索：换版本时收起搜索，避免结果与当前版本对不上, 20261026-end

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
  // prize add by yanliang for 文件编辑器：右侧面板要被换掉前先确认放弃修改, 20261024-start
  if (!leaveEditorFor()) return;
  // prize add by yanliang for 文件编辑器：右侧面板要被换掉前先确认放弃修改, 20261024-end
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
    // prize add by yanliang for 「文件」搜索：换版本时收起搜索，避免结果与当前版本对不上, 20261026-start
    state.fileQuery = '';
    // prize add by yanliang for 「文件」搜索：换版本时收起搜索，避免结果与当前版本对不上, 20261026-end

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
  // prize add by yanliang for 文件编辑器：右侧面板要被换掉前先确认放弃修改, 20261024-start
  if (!leaveEditorFor()) return;
  // prize add by yanliang for 文件编辑器：右侧面板要被换掉前先确认放弃修改, 20261024-end
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
    // prize add by yanliang for 「文件」搜索：换版本时收起搜索，避免结果与当前版本对不上, 20261026-start
    state.fileQuery = '';
    // prize add by yanliang for 「文件」搜索：换版本时收起搜索，避免结果与当前版本对不上, 20261026-end

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
  const label = { stage: '暂存', unstage: '取消暂存', ignore: '忽略', discard: '还原' }[op] || op;
  try {
    const res = await postApi('git-op', { op, paths });
    toast(res.message || `${label}完成`);
    await refreshWorking();
  } catch (err) {
    toast(`${label}失败：${err.message}`, true);
  }
}

// prize add by yanliang for 改动详情：还原到修改之前（HEAD 版本）, 20261024-start
// 是不可撤销操作，先问一句，并把「已暂存和未暂存都会丢」说清楚
async function discardFile(rel) {
  if (!rel) return;
  const ok = confirm(
    `还原「${rel}」到修改之前？\n\n已暂存和未暂存的改动都会被丢弃，恢复成 HEAD 版本，此操作不可撤销。`
  );
  if (!ok) return;
  await runGitOp('discard', [rel]);
}
// prize add by yanliang for 改动详情：还原到修改之前（HEAD 版本）, 20261024-end

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
    // prize add by yanliang for 过滤词存进 state，列表重绘后不再被清空, 20261027-start
    state.search = e.target.value.trim().toLowerCase();
    applyCommitFilter();
    updateListFoot();
    syncSearchUrl(state.search);
    // prize add by yanliang for 过滤词存进 state，列表重绘后不再被清空, 20261027-end
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

  // prize add by yanliang for 过滤后可能一条都不剩、列表滚不动，底部那行也能点着继续加载, 20261027-start
  $('#listFoot').addEventListener('click', () => {
    if (state.hasMore && !state.loadingCommits) loadCommits(false);
  });
  // prize add by yanliang for 过滤后可能一条都不剩、列表滚不动，底部那行也能点着继续加载, 20261027-end

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
        // 文件浏览模式下重绘的是文件内容，diff 模式下重绘 diff
        renderRightPane();
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
    // prize add by yanliang for 「文件」搜索：输入即过滤, 20261026-start
    if (e.target.id === 'fileSearch') onFileSearchInput(e.target.value);
    // prize add by yanliang for 「文件」搜索：输入即过滤, 20261026-end
  });
  // prize add by yanliang for 筛选框移到左侧文件栏后，改由 #diffScroll 事件委托, 20261022-end

  // prize add by yanliang for 「文件」搜索：Esc 清空、Enter 打开第一条命中, 20261026-start
  $('#diffScroll').addEventListener('keydown', (e) => {
    if (e.target.id !== 'fileSearch') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      clearFileSearch(true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = document.querySelector('.file-tree .sfile');
      if (first) treeClickNode(first);
    }
  });
  // prize add by yanliang for 「文件」搜索：Esc 清空、Enter 打开第一条命中, 20261026-end

  $('#diffScroll').addEventListener('click', (e) => {
    // prize add by yanliang for 左栏「改动 / 文件」切换与文件树点击, 20261023-start
    const tab = e.target.closest('#paneTabs [data-browse]');
    if (tab) {
      switchBrowse(tab.dataset.browse);
      return;
    }
    // prize add by yanliang for 「文件」搜索：清空按钮 + 定位改动前先退出搜索, 20261026-start
    if (e.target.closest('#fileSearchClear')) {
      clearFileSearch(true);
      return;
    }
    // prize add by yanliang for 「文件」搜索：清空按钮 + 定位改动前先退出搜索, 20261026-end
    if (e.target.closest('#revealChange')) {
      // prize add by yanliang for 「文件」搜索：命中列表会挡住目录树，定位前先退出搜索, 20261026-start
      clearFileSearch(false);
      // prize add by yanliang for 「文件」搜索：命中列表会挡住目录树，定位前先退出搜索, 20261026-end
      revealInTree(state.selected).then((ok) => {
        if (!ok) return;
        repaintBrowseTree();
        scrollToBrowseSel();
        renderBrowseFile();
      });
      return;
    }
    if (treeClickNode(e.target)) return;
    // prize add by yanliang for 左栏「改动 / 文件」切换与文件树点击, 20261023-end
    // prize add by yanliang for 改动详情：还原到修改之前（HEAD 版本）, 20261024-start
    const discardBtn = e.target.closest('[data-discard]');
    if (discardBtn) {
      e.preventDefault();
      e.stopPropagation();
      discardFile(discardBtn.dataset.discard);
      return;
    }
    // prize add by yanliang for 改动详情：还原到修改之前（HEAD 版本）, 20261024-end
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
    // prize add by yanliang for 文件详情定位：点一次展开左栏目录并滚到该文件, 20261026-start
    if (e.target.closest('#locateBtn')) {
      e.preventDefault();
      locateInTree(state.browseSel);
      return;
    }
    // 同一文件在系统文件夹里显示（只有运行服务的本机能用，局域网访问会提示）
    if (e.target.closest('#locateDiskBtn')) {
      e.preventDefault();
      revealPath(state.browseSel);
      return;
    }
    // prize add by yanliang for 文件详情定位：点一次展开左栏目录并滚到该文件, 20261026-end
    // prize add by yanliang for 文件编辑器：编辑 / 保存 / 取消, 20261024-start
    if (e.target.closest('#editBtn')) {
      e.preventDefault();
      const rel = state.browseSel;
      if (rel) enterEdit(rel);
      return;
    }
    if (e.target.closest('#edSave')) {
      e.preventDefault();
      saveEdit();
      return;
    }
    if (e.target.closest('#edCancel')) {
      e.preventDefault();
      exitEdit();
      return;
    }
    // prize add by yanliang for 文件编辑器：编辑 / 保存 / 取消, 20261024-end
    // prize add by yanliang for markdown 预览/源码切换（记住偏好）, 20261023-start
    if (e.target.closest('#mdToggle')) {
      state.mdPreview = !state.mdPreview;
      localStorage.setItem('gdv.mdPreview', state.mdPreview ? '1' : '0');
      renderRightPane();
      return;
    }
    // prize add by yanliang for markdown 预览/源码切换（记住偏好）, 20261023-end
    // prize add by yanliang for AI 解释：看解释 / 去解释 / 关联文件跳转, 20261024-start
    if (e.target.closest('#explainBtn')) {
      e.preventDefault();
      const rel = state.browseSel;
      if (!rel) return;
      const kind = explainKindOf(rel);
      if (kind === 'ready' || kind === 'stale') {
        state.explainMode = !state.explainMode;
        renderBrowseFile();
      } else if (kind !== 'pending') {
        requestExplain(rel);
      }
      return;
    }
    if (e.target.closest('[data-explain-file]')) {
      e.preventDefault();
      jumpToBrowseFile(e.target.closest('[data-explain-file]').dataset.explainFile);
      return;
    }
    // prize add by yanliang for 解释文档顶部显示绝对路径，并可一键在文件夹中定位, 20261024-start
    if (e.target.closest('[data-reveal]')) {
      e.preventDefault();
      revealPath(e.target.closest('[data-reveal]').dataset.reveal);
      return;
    }
    // prize add by yanliang for 解释文档顶部显示绝对路径，并可一键在文件夹中定位, 20261024-end
    // prize add by yanliang for AI 解释：看解释 / 去解释 / 关联文件跳转, 20261024-end
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

  // prize add by yanliang for 目录选择器事件：进入目录、选中、确认、关闭, 20261023-start
  $('#repoPick').addEventListener('click', openFinder);

  $('#finderMask').addEventListener('click', (e) => {
    if (e.target.id === 'finderMask') return closeFinder();
    if (e.target.closest('[data-finder-close]')) return closeFinder();
    const d = state.finderData;
    if (e.target.closest('#finderUp')) {
      if (d && d.parent) finderGo(d.parent);
      return;
    }
    if (e.target.closest('#finderHome')) {
      if (d) finderGo(d.home);
      return;
    }
    if (e.target.closest('#finderPick')) {
      finderConfirm();
      return;
    }
    const row = e.target.closest('.finder-row');
    if (row) {
      state.finderSel = row.dataset.dir || '';
      document.querySelectorAll('#finderList .finder-row').forEach((r) => r.classList.toggle('on', r === row));
      syncFinderFoot();
    }
  });

  // 双击进入子目录（单击只选中，避免选子目录时被弹进去）
  $('#finderMask').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.finder-row');
    if (!row) return;
    finderGo(row.dataset.dir || '');
  });

  $('#finderMask').addEventListener('keydown', (e) => {
    if (e.target.id !== 'finderPath') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finderGo(e.target.value.trim());
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!state.finderOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFinder();
    }
  });
  // prize add by yanliang for 目录选择器事件：进入目录、选中、确认、关闭, 20261023-end

  // 键盘导航
  document.addEventListener('keydown', (e) => {
    // prize add by yanliang for 提交面板打开时禁用 j/k 切换提交, 20261022-start
    if (state.commitOpen) return;
    // prize add by yanliang for 提交面板打开时禁用 j/k 切换提交, 20261022-end
    // prize add by yanliang for 目录选择器打开时同样不要响应快捷键, 20261023-start
    if (state.finderOpen) return;
    // prize add by yanliang for 目录选择器打开时同样不要响应快捷键, 20261023-end
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

  // prize add by yanliang for 纯源码模式：?mode=source 只保留文件树 + 代码 + 跳转, 20261026-start
  if (params.get('mode') === 'source') {
    state.sourceMode = true;
    // 直接盖掉 localStorage 里的选择：这个模式下「改动」一概不显示
    state.browse = 'files';
    document.body.classList.add('mode-source');
    // prize add by yanliang for 源码模式的标题也走统一入口，打开仓库后会带上项目名, 20261027-start
    syncTitle();
    // prize add by yanliang for 源码模式的标题也走统一入口，打开仓库后会带上项目名, 20261027-end
  }
  // prize add by yanliang for 纯源码模式：?mode=source 只保留文件树 + 代码 + 跳转, 20261026-end

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

  // prize add by yanliang for 地址栏带 q 时回填到搜索框，刷新后保持同一个作者, 20261027-start
  const initQ = params.get('q');
  if (initQ) {
    state.search = initQ.trim().toLowerCase();
    $('#search').value = initQ;
  }
  // prize add by yanliang for 地址栏带 q 时回填到搜索框，刷新后保持同一个作者, 20261027-end

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
    // prize add by yanliang for URL 带仓库时不动地址栏，避免抹掉 commit/cmp 定位参数, 20261023-start
    let ok = await openRepo(lastRepo, { syncUrl: !paramRepo });
    // 链接里的仓库已经不存在（比如被删了 / 换机器了）：回退到上次真正打开过的仓库，并修正地址栏
    if (!ok && paramRepo) {
      const fallback = localStorage.getItem('gdv.repo');
      if (fallback && fallback !== paramRepo) {
        $('#repoPath').value = fallback;
        ok = await openRepo(fallback, { syncUrl: true });
        if (ok) return;
      }
    }
    if (!ok) return;
    // prize add by yanliang for URL 带仓库时不动地址栏，避免抹掉 commit/cmp 定位参数, 20261023-end

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
