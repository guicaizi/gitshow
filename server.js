#!/usr/bin/env node
/**
 * prize add by yanliang  20261022-start
 * Git 提交记录比对工具 —— 本地服务
 * 历史部分只调用 git 的只读命令（rev-parse / log / show / diff / status / for-each-ref）；
 * 工作区额外支持三个写操作（git add / git reset / 追加 .git/info/exclude），
 * 不执行任何 shell 字符串，全部走 execFile 参数数组。
 * prize add by yanliang for 新增 git 历史比对工具本地服务, 20261022-end
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

// prize add by yanliang for 新增 git 可执行文件探测, 20261022-start
const GIT_CANDIDATES = [
  process.env.GIT_BIN,
  'git',
  'C:\\Users\\Administrator\\Tools\\PortableGit\\cmd\\git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
].filter(Boolean);

let GIT_BIN = null;

function probeGit() {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= GIT_CANDIDATES.length) return resolve(null);
      const bin = GIT_CANDIDATES[i++];
      execFile(bin, ['--version'], { windowsHide: true }, (err, stdout) => {
        if (!err && /git version/i.test(stdout)) resolve(bin);
        else next();
      });
    };
    next();
  });
}
// prize add by yanliang for 新增 git 可执行文件探测, 20261022-end

const PORT = Number(process.env.PORT || 7391);
// prize add by yanliang for 支持部署到服务器后局域网访问（HOST=0.0.0.0）, 20261022-start
const HOST = process.env.HOST || '127.0.0.1';
// prize add by yanliang for 支持部署到服务器后局域网访问（HOST=0.0.0.0）, 20261022-end
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BUFFER = 64 * 1024 * 1024;

// prize add by yanliang for 封装 git 只读调用, 20261022-start
function git(args, cwd, extraEnv) {
  return new Promise((resolve, reject) => {
    // prize add by yanliang for 统一关闭路径转义，保证中文等非 ASCII 文件名原样输出, 20261022-start
    const fullArgs = ['-c', 'core.quotepath=false', ...args];
    // prize add by yanliang for 统一关闭路径转义，保证中文等非 ASCII 文件名原样输出, 20261022-end
    execFile(
      GIT_BIN,
      fullArgs,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          // prize add by yanliang for 支持提交时注入临时索引等环境变量, 20261022-start
          ...(extraEnv || {}),
          // prize add by yanliang for 支持提交时注入临时索引等环境变量, 20261022-end
        },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim() || 'git 执行失败'));
        else resolve(stdout);
      }
    );
  });
}
// prize add by yanliang for 封装 git 只读调用, 20261022-end

/**
 * prize add by yanliang  20261022-start
 * 解析仓库路径并校验是否为 git 仓库，返回仓库真实根目录
 */
async function resolveRepo(input) {
  if (!input || typeof input !== 'string') throw new Error('缺少仓库路径');
  const raw = input.trim().replace(/^["']|["']$/g, '');
  let target = raw;
  if (!path.isAbsolute(target)) target = path.resolve(process.cwd(), target);
  if (!fs.existsSync(target)) throw new Error(`路径不存在：${target}`);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) target = path.dirname(target);
  const top = (await git(['rev-parse', '--show-toplevel'], target)).trim();
  if (!top) throw new Error('不是 git 仓库');
  return top.replace(/\//g, path.sep);
}
// prize add by yanliang for 解析仓库路径并校验是否为 git 仓库, 20261022-end

// prize add by yanliang for 读取仓库基础信息与引用列表, 20261022-start
async function readRepoInfo(repo) {
  const [head, branchRaw, refsRaw, statusRaw] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD'], repo).catch(() => ''),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).catch(() => ''),
    git(
      ['for-each-ref', '--format=%(refname:short)%1f%(refname)', '--sort=-committerdate', 'refs/heads', 'refs/remotes', 'refs/tags'],
      repo
    ).catch(() => ''),
    git(['status', '--porcelain=v1'], repo).catch(() => ''),
  ]);

  const refs = refsRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [short, full] = line.split('\x1f');
      let kind = 'branch';
      if (full.startsWith('refs/tags/')) kind = 'tag';
      else if (full.startsWith('refs/remotes/')) kind = 'remote';
      return { name: short, kind };
    })
    .filter((r) => !r.name.endsWith('/HEAD'));

  const changed = statusRaw.split('\n').filter(Boolean).length;

  return {
    repo,
    name: path.basename(repo),
    head: head.trim(),
    branch: branchRaw.trim(),
    refs,
    dirtyCount: changed,
  };
}
// prize add by yanliang for 读取仓库基础信息与引用列表, 20261022-end

const FIELD = '\x1f';
const RECORD = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%ad', '%D', '%s'].join('%x1f') + '%x1e';

// prize add by yanliang for 读取提交列表, 20261022-start
async function readCommits(repo, ref, skip, limit) {
  const args = [
    'log',
    '--date=iso-strict',
    `--max-count=${limit}`,
  ];
  if (skip > 0) args.push(`--skip=${skip}`);
  args.push(`--pretty=format:${LOG_FORMAT}`);
  if (ref) args.push(ref);
  args.push('--');

  const out = await git(args, repo);
  const commits = out
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((chunk) => {
      const f = chunk.split(FIELD);
      return {
        hash: f[0] || '',
        short: f[1] || '',
        author: f[2] || '',
        email: f[3] || '',
        date: f[4] || '',
        refs: (f[5] || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        subject: f[6] || '',
      };
    });

  return { commits, hasMore: commits.length === limit };
}
// prize add by yanliang for 读取提交列表, 20261022-end

// prize add by yanliang for 还原 git 输出的 C 风格引号路径（porcelain 格式对含空格路径强制加引号）, 20261022-start
function unquotePath(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const nx = body[++i];
    if (nx === undefined) break;
    if (nx >= '0' && nx <= '7') {
      let oct = nx;
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i];
      bytes.push(parseInt(oct, 8));
    } else if (nx === 'n') bytes.push(10);
    else if (nx === 't') bytes.push(9);
    else if (nx === 'r') bytes.push(13);
    else bytes.push(...Buffer.from(nx, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}
// prize add by yanliang for 还原 git 输出的 C 风格引号路径（porcelain 格式对含空格路径强制加引号）, 20261022-end

// prize add by yanliang for 解析 numstat 为文件变更统计, 20261022-start
function parseNumstat(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [add, del, ...rest] = line.split('\t');
      const file = unquotePath(rest.join('\t'));
      return {
        path: file,
        additions: add === '-' ? 0 : Number(add) || 0,
        deletions: del === '-' ? 0 : Number(del) || 0,
        binary: add === '-' || del === '-',
      };
    });
}
// prize add by yanliang for 解析 numstat 为文件变更统计, 20261022-end

// prize add by yanliang for 读取单个提交详情, 20261022-start
async function readCommitDetail(repo, hash, ignoreSpace) {
  const metaFormat = ['%H', '%h', '%P', '%an', '%ae', '%ad', '%cn', '%ce', '%cd', '%D', '%B'].join('%x1f');
  const metaRaw = await git(['show', '-s', `--date=iso-strict`, `--pretty=format:${metaFormat}`, hash], repo);
  const f = metaRaw.split(FIELD);
  const parents = (f[2] || '').split(' ').filter(Boolean);

  // prize add by yanliang for 让忽略空白开关同时作用于 patch 与 numstat，避免统计数字与显示不一致, 20261022-start
  const extra = ignoreSpace ? ['--ignore-all-space'] : [];

  const diffArgs = [
    'show',
    hash,
    '--patch',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--format=',
    '--unified=3',
    ...extra,
  ];

  // merge commit 默认不产生 diff，退化为与其第一个父提交比较
  const patchArgs =
    parents.length > 1
      ? ['diff', `${hash}^1`, hash, '--patch', '--no-color', '--no-ext-diff', '--unified=3', ...extra]
      : diffArgs;

  const [patch, numstatRaw] = await Promise.all([
    git(patchArgs, repo).catch((e) => `diff 读取失败：${e.message}`),
    git(
      (parents.length > 1
        ? ['diff', '--numstat', `${hash}^1`, hash]
        : ['show', '--numstat', '--format=', hash]
      ).concat(extra),
      repo
    ).catch(() => ''),
  ]);
  // prize add by yanliang for 让忽略空白开关同时作用于 patch 与 numstat，避免统计数字与显示不一致, 20261022-end

  return {
    kind: 'commit',
    hash: f[0] || hash,
    short: f[1] || hash.slice(0, 7),
    parents,
    author: f[3] || '',
    authorEmail: f[4] || '',
    authorDate: f[5] || '',
    committer: f[6] || '',
    committerEmail: f[7] || '',
    commitDate: f[8] || '',
    refs: (f[9] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    message: (f[10] || '').replace(/\s+$/, ''),
    files: parseNumstat(numstatRaw),
    patch,
    isMerge: parents.length > 1,
  };
}
// prize add by yanliang for 读取单个提交详情, 20261022-end

// prize add by yanliang for 读取两个提交之间的比对, 20261022-start
async function readComparison(repo, base, head, ignoreSpace) {
  const extra = ignoreSpace ? ['--ignore-all-space'] : [];
  const [patch, numstatRaw] = await Promise.all([
    git(['diff', base, head, '--patch', '--no-color', '--no-ext-diff', '--unified=3', ...extra], repo),
    // prize add by yanliang for numstat 也带上忽略空白，与 patch 统计保持一致, 20261022-start
    git(['diff', '--numstat', base, head, ...extra], repo),
    // prize add by yanliang for numstat 也带上忽略空白，与 patch 统计保持一致, 20261022-end
  ]);
  const short = (h) => h.slice(0, 7);
  return {
    kind: 'compare',
    base,
    head,
    short: `${short(base)} → ${short(head)}`,
    message: `比对 ${short(base)} 与 ${short(head)}`,
    files: parseNumstat(numstatRaw),
    patch,
  };
}
// prize add by yanliang for 读取两个提交之间的比对, 20261022-end

// prize add by yanliang for 解析 porcelain 状态，得到每个路径的暂存/工作区/未跟踪状态, 20261022-start
function parseStatusEntries(raw) {
  const map = new Map();
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let rest = line.slice(3);
    if (xy === '??') {
      const p = unquotePath(rest);
      if (p) map.set(p, { staged: false, dirty: true, untracked: true, xy });
      continue;
    }
    // 重命名形如 "R  old -> new"，取新路径（兼容路径里自带箭头的情况，取最后一处）
    const arrow = rest.lastIndexOf(' -> ');
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    const p = unquotePath(rest);
    if (!p) continue;
    map.set(p, {
      staged: xy[0] !== ' ' && xy[0] !== '?',
      dirty: xy[1] !== ' ' && xy[1] !== '?',
      untracked: false,
      xy,
    });
  }
  return map;
}
// prize add by yanliang for 解析 porcelain 状态，得到每个路径的暂存/工作区/未跟踪状态, 20261022-end

// prize add by yanliang for 为未跟踪文件合成 diff，让新文件也能按树展开内容, 20261022-start
const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024;
const UNTRACKED_MAX_LINES = 3000;
const UNTRACKED_MAX_FILES = 400;
const UNTRACKED_TOTAL_BUDGET = 8 * 1024 * 1024;

async function buildUntrackedPatch(repo, paths) {
  const parts = [];
  let budget = UNTRACKED_TOTAL_BUDGET;

  for (const rel of paths) {
    if (budget <= 0) break;

    const abs = path.resolve(repo, rel);
    let stat;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const head = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;

    // 先看体积再读，避免把超大文件整个读进内存
    if (stat.size > UNTRACKED_MAX_BYTES) {
      const part = `${head}Binary files /dev/null and b/${rel} differ\n`;
      parts.push(part);
      budget -= part.length;
      continue;
    }

    let buf;
    try {
      buf = await fs.promises.readFile(abs);
    } catch {
      continue;
    }

    if (buf.includes(0)) {
      const part = `${head}Binary files /dev/null and b/${rel} differ\n`;
      parts.push(part);
      budget -= part.length;
      continue;
    }

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // split 末尾的换行会产生一个空串，去掉它避免多算一行
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    // 统一去掉行尾 \r，避免 CRLF 文件在界面上显示成怪字符
    const shown = lines.slice(0, UNTRACKED_MAX_LINES).map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

    const part =
      `${head}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${shown.length} @@\n` +
      shown.map((l) => `+${l}`).join('\n') +
      '\n';
    parts.push(part);
    budget -= part.length;
  }

  return parts.join('');
}
// prize add by yanliang for 为未跟踪文件合成 diff，让新文件也能按树展开内容, 20261022-end

// prize add by yanliang for 读取工作区未提交改动, 20261022-start
async function readWorkingTree(repo, ignoreSpace) {
  const extra = ignoreSpace ? ['--ignore-all-space'] : [];
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], repo)
    .then(() => true)
    .catch(() => false);
  // 无提交的空仓库退化为比对待提交区
  const base = hasHead ? ['HEAD'] : ['--cached'];

  const [patch, numstatRaw, statusRaw] = await Promise.all([
    git(['diff', ...base, '--patch', '--no-color', '--no-ext-diff', '--unified=3', ...extra], repo).catch(() => ''),
    // prize add by yanliang for 工作区 numstat 同样带上忽略空白，避免统计与 patch 不一致, 20261022-start
    git(['diff', ...base, '--numstat', ...extra], repo).catch(() => ''),
    // prize add by yanliang for 工作区 numstat 同样带上忽略空白，避免统计与 patch 不一致, 20261022-end
    // -uall 让未跟踪目录展开到具体文件，否则树里只能看到一个目录名
    git(['status', '--porcelain=v1', '-uall'], repo).catch(() => ''),
  ]);

  // prize add by yanliang for 未跟踪路径同样需要还原引号, 20261022-start
  const entries = parseStatusEntries(statusRaw);
  const untracked = [...entries].filter(([, v]) => v.untracked).map(([p]) => p);
  // prize add by yanliang for 未跟踪路径同样需要还原引号, 20261022-end

  // prize add by yanliang for 未跟踪文件补进 patch，统一走树渲染, 20261022-start
  // 同一路径若已出现在 diff 里（例如 git rm --cached 后又变成未跟踪），不再重复合成
  const trackedPaths = new Set(parseNumstat(numstatRaw).map((f) => f.path));
  const pending = untracked.filter((p) => !trackedPaths.has(p));
  const untrackedPatch = await buildUntrackedPatch(repo, pending.slice(0, UNTRACKED_MAX_FILES));
  // prize add by yanliang for 未跟踪文件补进 patch，统一走树渲染, 20261022-end

  return {
    kind: 'working',
    short: 'WORKTREE',
    message: '工作区未提交的改动',
    files: parseNumstat(numstatRaw),
    untracked,
    status: Object.fromEntries(entries),
    canEdit: true,
    // prize add by yanliang for 未跟踪文件过多时告知前端已截断, 20261022-start
    untrackedTruncated: pending.length > UNTRACKED_MAX_FILES,
    // prize add by yanliang for 未跟踪文件过多时告知前端已截断, 20261022-end
    patch: patch + untrackedPatch,
  };
}
// prize add by yanliang for 读取工作区未提交改动, 20261022-end

// prize add by yanliang for 工作区写操作：暂存 / 取消暂存 / 写入 .git/info/exclude 忽略, 20261022-start
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 只接受仓库内的相对路径，挡住绝对路径与 ../ 越界，也避免 git 参数注入
function safeRelPath(raw) {
  const p = String(raw == null ? '' : raw).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!p) throw new Error('缺少文件路径');
  if (p.includes('\0')) throw new Error('路径含非法字符');
  if (p.split('/').includes('..')) throw new Error(`路径越界：${p}`);
  return p.replace(/\/+$/, '');
}

// prize add by yanliang for 读取单个文件内容，供 markdown / 图片在线预览, 20261023-start
const PREVIEW_TEXT_MAX = 2 * 1024 * 1024;
const PREVIEW_RAW_MAX = 12 * 1024 * 1024;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

function mimeOf(rel) {
  return MIME_BY_EXT[path.extname(rel).toLowerCase()] || 'application/octet-stream';
}

// 版本号白名单：避免 -x 之类被 git 当成选项
function safeRev(raw) {
  const r = String(raw == null ? '' : raw).trim();
  if (!r || r === 'worktree') return '';
  if (!/^[0-9A-Za-z][0-9A-Za-z._/^~-]*$/.test(r)) throw new Error('非法的版本号：' + r);
  return r;
}

// 工作区文件绝对路径，必须落在仓库目录内
function worktreeFile(repo, rel) {
  const root = path.resolve(repo);
  const abs = path.resolve(root, rel);
  const lowerAbs = abs.toLowerCase();
  const lowerRoot = root.toLowerCase();
  if (lowerAbs !== lowerRoot && !lowerAbs.startsWith(lowerRoot + path.sep)) {
    throw new Error('路径越界：' + rel);
  }
  return abs;
}

// 和 git() 一样，但保留二进制（图片预览要用）
function gitBuf(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      GIT_BIN,
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'buffer',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || err.message);
          return reject(new Error(msg.trim() || 'git 执行失败'));
        }
        resolve(stdout);
      }
    );
  });
}

// 取文件二进制：rev 为空读工作区，否则读该提交里的版本
async function readBlob(repo, rawPath, rawRev) {
  const rel = safeRelPath(rawPath);
  if (rel.split('/')[0] === '.git') throw new Error('不预览 .git 目录里的文件');
  const rev = safeRev(rawRev);

  if (rev) {
    let size = 0;
    try {
      size = Number(String(await git(['cat-file', '-s', `${rev}:${rel}`], repo)).trim() || 0);
    } catch (_) {
      throw new Error(`这个版本里没有该文件：${rel}`);
    }
    if (size > PREVIEW_RAW_MAX) throw new Error(`文件太大，不预览（${(size / 1024 / 1024).toFixed(1)}MB）`);
    return { rel, rev, size, buf: await gitBuf(['show', `${rev}:${rel}`], repo) };
  }

  const abs = worktreeFile(repo, rel);
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    throw new Error(`文件不存在（可能已被删除）：${rel}`);
  }
  if (!st.isFile()) throw new Error(`这不是普通文件：${rel}`);
  if (st.size > PREVIEW_RAW_MAX) throw new Error(`文件太大，不预览（${(st.size / 1024 / 1024).toFixed(1)}MB）`);
  // prize add by yanliang for 文件编辑：把 mtime 一并返回，保存时用来发现外部改动, 20261024-start
  return { rel, rev: 'worktree', size: st.size, mtimeMs: st.mtimeMs, buf: fs.readFileSync(abs) };
  // prize add by yanliang for 文件编辑：把 mtime 一并返回，保存时用来发现外部改动, 20261024-end
}

async function readFileText(repo, rawPath, rawRev) {
  const { rel, rev, size, mtimeMs, buf } = await readBlob(repo, rawPath, rawRev);
  const binary = buf.includes(0);
  const tooLarge = size > PREVIEW_TEXT_MAX;
  return {
    path: rel,
    rev,
    size,
    // prize add by yanliang for 文件编辑：工作区文件带上 mtimeMs，历史版本没有, 20261024-start
    mtimeMs: mtimeMs || 0,
    // prize add by yanliang for 文件编辑：工作区文件带上 mtimeMs，历史版本没有, 20261024-end
    binary,
    tooLarge,
    content: binary || tooLarge ? '' : buf.toString('utf8'),
  };
}
// prize add by yanliang for 读取单个文件内容，供 markdown / 图片在线预览, 20261023-end

// prize add by yanliang for 文件编辑器：把工作区文本文件写回磁盘, 20261024-start
// 定位是「就地改一个已有文件」，不负责新建 / 删除 / 改权限，越界的事一概不做。
const SAVE_TEXT_MAX = 2 * 1024 * 1024;

async function saveWorktreeFile(repo, rawPath, rawContent, baseMtimeMs) {
  const rel = safeRelPath(rawPath);
  if (rel.split('/')[0] === '.git') throw new Error('不能编辑 .git 目录里的文件');
  const abs = worktreeFile(repo, rel);

  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st) throw new Error(`文件不存在（可能已被删除）：${rel}`);
  if (!st.isFile()) throw new Error(`这不是普通文件：${rel}`);
  if (st.size > SAVE_TEXT_MAX) {
    throw new Error(`文件超过 2MB，不支持在线编辑（${(st.size / 1024 / 1024).toFixed(1)}MB）`);
  }

  const oldBuf = await fs.promises.readFile(abs);
  if (oldBuf.includes(0)) throw new Error('二进制文件不支持在线编辑');

  const content = String(rawContent == null ? '' : rawContent);
  if (content.includes('\0')) throw new Error('内容含非法字符');
  if (Buffer.byteLength(content, 'utf8') > SAVE_TEXT_MAX) throw new Error('内容超过 2MB，未保存');

  // 编辑期间文件被别人改过（本机其它编辑器、git checkout、构建脚本）就别覆盖了，
  // 前端重新读一次再保存即可；留 1ms 容差，避免文件系统 mtime 精度差异误判
  if (baseMtimeMs && Math.abs(Number(baseMtimeMs) - st.mtimeMs) > 1) {
    throw new Error('文件已被其他程序修改，请重新打开再编辑');
  }

  // 换行风格跟随原文件：Windows 项目里把 CRLF 写成 LF 会让整个文件在 diff 里全变红
  const oldText = oldBuf.toString('utf8');
  const crlf = oldText.includes('\r\n');
  const normalized = content.replace(/\r\n?/g, '\n');
  const out = crlf ? normalized.replace(/\n/g, '\r\n') : normalized;

  if (out === oldText) {
    return { ok: true, path: rel, size: st.size, mtimeMs: st.mtimeMs, eol: crlf ? 'crlf' : 'lf', unchanged: true };
  }

  // 直接写而不是「临时文件 + rename」：rename 会换 inode，外部编辑器的文件监听会当成删除+新建
  await fs.promises.writeFile(abs, out, 'utf8');
  const st2 = await fs.promises.stat(abs);
  return { ok: true, path: rel, size: st2.size, mtimeMs: st2.mtimeMs, eol: crlf ? 'crlf' : 'lf', unchanged: false };
}
// prize add by yanliang for 文件编辑器：把工作区文本文件写回磁盘, 20261024-end

// prize add by yanliang for 仓库文件树：按层懒加载，一次只读一层目录, 20261023-start
async function readTree(repo, rawRev, rawPath) {
  const rev = safeRev(rawRev) || 'HEAD';
  let dir = String(rawPath == null ? '' : rawPath).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (dir.includes('\0')) throw new Error('路径含非法字符');
  if (dir.split('/').includes('..')) throw new Error('路径越界：' + dir);
  if (dir && !dir.endsWith('/')) dir += '/';

  const args = ['ls-tree', '-l', rev];
  if (dir) args.push('--', dir);

  let out = '';
  try {
    out = await git(args, repo);
  } catch (err) {
    throw new Error(`读取目录失败：${String(err.message || '').trim() || rev}`);
  }

  const dirs = [];
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    const full = line.slice(tab + 1);
    const name = full.slice(full.lastIndexOf('/') + 1);
    if (!name) continue;
    const type = meta[1];
    const mode = meta[0];
    if (type === 'tree') dirs.push({ name, path: full });
    else files.push({ name, path: full, size: Number(meta[3]) || 0, mode, type: type || 'blob' });
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  dirs.sort(byName);
  files.sort(byName);

  return { rev, path: dir, dirs, files };
}
// prize add by yanliang for 仓库文件树：按层懒加载，一次只读一层目录, 20261023-end

// prize add by yanliang for 「文件」搜索：服务端流式建索引 + 服务端过滤, 20261026-start
// 目录树是按层懒加载的，靠已加载的缓存搜不到没展开的目录，所以搜索要单独拿一份全量路径。
// 但不能整包给前端：ALPS 级仓库 147 万文件，ls-tree -z 输出 126MB，既撑爆 execFile 的
// maxBuffer（报 stdout maxBuffer length exceeded），也不可能在浏览器里存下。
// 做法：spawn 流式拼成一个大字符串建索引（缓存起来），搜索在服务端做，只回命中项。
const FILE_SEARCH_MAX = 200;
const PATH_INDEX_TTL = 5 * 60 * 1000;
const PATH_INDEX_MAX_ENTRIES = 2; // 一份索引可达上百 MB，只留最近两个版本
const PATH_INDEX_MAX_CHARS = 300 * 1024 * 1024; // 再加一道总量闸，别让两份大索引同时挂着
const pathIndex = new Map(); // key -> { text, total, at, promise, error }

function pathIndexKey(repo, rev) {
  return `${repo}\n${rev}`;
}

function pathIndexChars() {
  let n = 0;
  for (const e of pathIndex.values()) n += e.text ? e.text.length : 0;
  return n;
}

function evictPathIndex() {
  // 条数和总字符数双重上限：先建的最先淘汰，正在建的那条永远最新，不会被删
  while (pathIndex.size > 1 && (pathIndex.size > PATH_INDEX_MAX_ENTRIES || pathIndexChars() > PATH_INDEX_MAX_CHARS)) {
    pathIndex.delete(pathIndex.keys().next().value);
  }
}

// 流式读 ls-tree：setEncoding('utf8') 走 StringDecoder，跨块的多字节字符（中文路径）不会裂
function buildPathIndex(repo, rev, entry) {
  entry.promise = new Promise((resolve, reject) => {
    const child = spawn(GIT_BIN, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', '-z', rev], {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    let text = '';
    let total = 0;
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      // \0 是 git 的路径分隔符（路径里不可能出现），数它比 split 整串省一次大数组
      total += chunk.split('\0').length - 1;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        entry.text = text;
        entry.total = total;
        entry.at = Date.now();
        entry.promise = null;
        resolve(entry);
      } else {
        entry.error = (stderr || `git ls-tree 退出码 ${code}`).trim();
        entry.promise = null;
        reject(new Error(entry.error));
      }
    });
  });
  return entry.promise;
}

// 取索引：已建好且没过期直接用；正在建就把 pending 的 entry 还回去，让调用方轮询
function ensurePathIndex(repo, rev) {
  const key = pathIndexKey(repo, rev);
  const cached = pathIndex.get(key);
  if (cached && cached.promise) return cached;
  if (cached && !cached.error && Date.now() - cached.at < PATH_INDEX_TTL) return cached;

  const entry = { text: '', total: 0, at: 0, promise: null, error: null };
  pathIndex.delete(key);
  pathIndex.set(key, entry);
  evictPathIndex();
  buildPathIndex(repo, rev, entry).catch(() => {
    /* 失败原因挂在 entry.error 上，由调用方决定怎么报 */
  });
  return entry;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function countSlashes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 47) n += 1;
  return n;
}

// 在 '\0' 分隔的大字符串里找命中：大小写不敏感用正则 i 标记，避免再造一份小写副本
// 排序和前端一致：文件名前缀命中 > 文件名包含 > 只命中目录名，同档按目录更浅、路径更短
function searchPathText(text, rawQuery, limit) {
  const q = rawQuery.toLowerCase();
  const re = new RegExp(rawQuery.replace(REGEX_SPECIAL, '\\$&'), 'gi');
  const cands = [];
  let total = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const at = m.index;
    const start = at === 0 ? 0 : text.lastIndexOf('\0', at - 1) + 1;
    let end = text.indexOf('\0', at);
    if (end < 0) end = text.length;
    const p = text.slice(start, end);
    total += 1;
    if (cands.length < 4000) {
      const slash = p.lastIndexOf('/');
      const name = slash >= 0 ? p.slice(slash + 1) : p;
      const nameAt = name.toLowerCase().indexOf(q);
      const rank = nameAt === 0 ? 0 : nameAt >= 0 ? 1 : 2;
      cands.push({ path: p, score: rank * 1e12 + countSlashes(p) * 1e6 + Math.min(p.length, 999999) });
      // 命中太多时（比如只打一个字母）分批收口，别让候选数组涨到上百万条
      if (cands.length === 4000) {
        cands.sort((a, b) => a.score - b.score);
        cands.length = 1000;
      }
    }
    re.lastIndex = end + 1; // 一个路径只算一次，顺带跳过路径内的其它命中点
  }
  cands.sort((a, b) => a.score - b.score);
  const items = cands.slice(0, limit).map((c) => c.path);
  return { total, items, truncated: total > items.length };
}

async function treeSearch(repo, rawRev, rawQuery, rawLimit) {
  const rev = safeRev(rawRev) || 'HEAD';
  const query = String(rawQuery || '').trim();
  const limit = Math.min(Math.max(Number(rawLimit) || FILE_SEARCH_MAX, 1), FILE_SEARCH_MAX);
  if (!query) return { state: 'ready', rev, total: 0, items: [], truncated: false };

  const entry = ensurePathIndex(repo, rev);
  if (entry.promise) return { state: 'building', rev, total: entry.total, items: [], truncated: false };
  if (entry.error) throw new Error(entry.error);

  const hit = searchPathText(entry.text, query, limit);
  return { state: 'ready', rev, total: hit.total, items: hit.items, truncated: hit.truncated };
}
// prize add by yanliang for 「文件」搜索：服务端流式建索引 + 服务端过滤, 20261026-end


function escapeIgnorePattern(p) {
  return p
    .replace(/[\\*?[\]]/g, (m) => `\\${m}`)
    .replace(/^([#!])/, '\\$1');
}

async function opStage(repo, paths) {
  // -A 让删除的文件也能一并暂存
  await git(['add', '-A', '--', ...paths], repo);
  return `已暂存 ${paths.length} 个路径`;
}

async function opUnstage(repo, paths) {
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], repo)
    .then(() => true)
    .catch(() => false);
  if (hasHead) await git(['reset', '-q', 'HEAD', '--', ...paths], repo);
  else await git(['rm', '--cached', '-r', '-q', '--', ...paths], repo);
  return `已从暂存区移除 ${paths.length} 个路径`;
}

async function opIgnore(repo, paths) {
  const rel = (await git(['rev-parse', '--git-path', 'info/exclude'], repo)).trim();
  const file = path.isAbsolute(rel) ? rel : path.resolve(repo, rel);

  let content = '';
  try {
    content = await fs.promises.readFile(file, 'utf8');
  } catch {
    content = '';
  }

  const existing = new Set(content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  const added = [];
  const skipped = [];

  // 已跟踪的文件不受 exclude 影响，先识别出来，别让用户白写一行
  const trackedRaw = await git(['ls-files', '--', ...paths], repo).catch(() => '');
  const trackedSet = new Set(trackedRaw.split('\n').map((s) => s.trim()).filter(Boolean));

  for (const p of paths) {
    let isDir = false;
    try {
      isDir = (await fs.promises.stat(path.resolve(repo, p))).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir && trackedSet.has(p)) {
      skipped.push(p);
      continue;
    }
    const pattern = escapeIgnorePattern(isDir ? `${p}/` : p);
    if (existing.has(pattern)) continue;
    existing.add(pattern);
    added.push(pattern);
  }

  if (!added.length) {
    if (skipped.length) return `已在版本控制中，忽略不生效：${skipped.join(', ')}`;
    return '这些路径已经在 .git/info/exclude 里了';
  }

  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const marker = '# 由 git-diff-viewer 添加';
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  const header = content.includes(marker) ? '' : `${marker}\n`;
  await fs.promises.appendFile(file, `${prefix}${header}${added.join('\n')}\n`, 'utf8');

  const tip = skipped.length ? `（已在版本控制中，未写入：${skipped.join(', ')}）` : '';
  return `已写入 .git/info/exclude：${added.join(', ')}${tip}`;
}

// prize add by yanliang for 还原：把路径恢复成 HEAD 版本（暂存区与工作区一起回退）, 20261024-start
// 语义就是「回到修改之前」：一条 checkout 同时重置 index 和 worktree，
// 所以已暂存、未暂存、已删除的改动都会被抹掉。新增文件在 HEAD 里不存在，不在还原范围。
async function opDiscard(repo, paths) {
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], repo)
    .then(() => true)
    .catch(() => false);
  if (!hasHead) throw new Error('仓库还没有任何提交，没有可还原的版本');

  // -z 避免中文 / 空格路径被 quotepath 转义后再拆错
  const listed = await git(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths], repo).catch(() => '');
  const inHead = new Set(
    String(listed || '')
      .split('\0')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const revert = paths.filter((p) => inHead.has(p));
  const skipped = paths.filter((p) => !inHead.has(p));

  if (!revert.length) {
    throw new Error(`HEAD 里没有这些路径，无法还原：${skipped.join(', ')}（新增文件请手动删除）`);
  }

  await git(['checkout', 'HEAD', '--', ...revert], repo);

  if (skipped.length) {
    return `已还原 ${revert.length} 个路径到 HEAD；新增文件不在还原范围：${skipped.join(', ')}`;
  }
  return `已还原 ${revert.length} 个路径到 HEAD`;
}
// prize add by yanliang for 还原：把路径恢复成 HEAD 版本（暂存区与工作区一起回退）, 20261024-end

async function runGitOp(repo, op, rawPaths) {
  const list = (Array.isArray(rawPaths) ? rawPaths : [rawPaths])
    .filter((p) => p != null && String(p).trim() !== '')
    .map(safeRelPath);
  const paths = [...new Set(list)];
  if (!paths.length) throw new Error('缺少文件路径');

  let message;
  if (op === 'stage') message = await opStage(repo, paths);
  else if (op === 'unstage') message = await opUnstage(repo, paths);
  else if (op === 'ignore') message = await opIgnore(repo, paths);
  // prize add by yanliang for 工作区改动详情支持还原到 HEAD 版本, 20261024-start
  else if (op === 'discard') message = await opDiscard(repo, paths);
  // prize add by yanliang for 工作区改动详情支持还原到 HEAD 版本, 20261024-end
  else throw new Error(`不支持的操作：${op}`);

  return { ok: true, op, paths, message };
}
// prize add by yanliang for 工作区写操作：暂存 / 取消暂存 / 写入 .git/info/exclude 忽略, 20261022-end

// prize add by yanliang for 提交面板：读取暂存区改动与上次提交说明, 20261022-start
function parseNameStatus(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const st = line.slice(0, tab).trim()[0] || 'M';
    const parts = line.slice(tab + 1).split('\t');
    // 重命名/复制形如 R100\told\tnew，取最后一列新路径
    const p = unquotePath(parts[parts.length - 1]);
    if (!p) continue;
    out.push({ path: p, status: st === 'R' || st === 'C' ? 'R' : st });
  }
  return out;
}

async function readStaged(repo) {
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], repo)
    .then(() => true)
    .catch(() => false);

  const [numstatRaw, nameStatusRaw, patch, branchRaw, remoteRaw, lastRaw] = await Promise.all([
    // prize add by yanliang for 暂存区统一关闭重命名识别，列表里的路径与 patch 才能一一对应, 20261022-start
    git(['diff', '--cached', '--no-renames', '--numstat'], repo).catch(() => ''),
    git(['diff', '--cached', '--no-renames', '--name-status'], repo).catch(() => ''),
    git(['diff', '--cached', '--no-renames', '--patch', '--no-color', '--no-ext-diff', '--unified=3'], repo).catch(
      () => ''
    ),
    // prize add by yanliang for 暂存区统一关闭重命名识别，列表里的路径与 patch 才能一一对应, 20261022-end
    // prize add by yanliang for 空仓库也能显示分支名, 20261022-start
    hasHead
      ? git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).catch(() => '')
      : git(['symbolic-ref', '--short', '-q', 'HEAD'], repo).catch(() => ''),
    // prize add by yanliang for 空仓库也能显示分支名, 20261022-end
    // HEAD 已存在于远端时，amend 会改写已推送的历史，前端需要提示
    hasHead ? git(['branch', '-r', '--contains', 'HEAD'], repo).catch(() => '') : Promise.resolve(''),
    hasHead ? git(['log', '-1', '--pretty=format:%h%x1f%B'], repo).catch(() => '') : Promise.resolve(''),
  ]);

  const stats = new Map(parseNumstat(numstatRaw).map((f) => [f.path, f]));
  const files = parseNameStatus(nameStatusRaw).map((entry) => {
    const s = stats.get(entry.path) || {};
    return {
      path: entry.path,
      status: entry.status,
      additions: s.additions || 0,
      deletions: s.deletions || 0,
      binary: !!s.binary,
    };
  });

  const [short, ...msgLines] = lastRaw.split('\x1f');
  return {
    kind: 'staged',
    files,
    patch,
    hasHead,
    branch: branchRaw.trim() || 'HEAD',
    short: (short || '').trim(),
    lastMessage: msgLines.join('\x1f').replace(/\s+$/, ''),
    headPushed: !!remoteRaw.trim(),
  };
}
// prize add by yanliang for 提交面板：读取暂存区改动与上次提交说明, 20261022-end

// prize add by yanliang for 执行 commit / amend，支持只提交选中的已暂存文件, 20261022-start
async function opCommit(repo, message, amend, rawPaths) {
  const msg = String(message == null ? '' : message).replace(/\r\n/g, '\n').trim();
  if (!msg) throw new Error('提交说明不能为空');

  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], repo)
    .then(() => true)
    .catch(() => false);
  if (amend && !hasHead) throw new Error('还没有任何提交，无法 amend');

  const staged = parseNameStatus(
    await git(['diff', '--cached', '--no-renames', '--name-status'], repo).catch(() => '')
  ).map((x) => x.path);

  const all = new Set(staged);
  const picked = (Array.isArray(rawPaths) ? rawPaths : [])
    .map((p) => String(p == null ? '' : p).trim())
    .filter(Boolean)
    .map(safeRelPath);

  // 只允许提交真实存在暂存记录的路径，避免前端传错把工作区内容混进来
  const selected = (picked.length ? [...new Set(picked)] : staged.slice()).filter((p) => all.has(p));

  if (!amend && !staged.length) throw new Error('暂存区是空的，先把要提交的改动暂存起来');
  if (!amend && !selected.length) throw new Error('至少选择一个要提交的文件');

  // 未选中的已暂存路径在临时索引里回退到 HEAD，因此不会被这次提交带走
  const skipped = staged.filter((p) => !selected.includes(p));

  const gitDir = (await git(['rev-parse', '--absolute-git-dir'], repo)).trim();
  const realIndex = path.join(gitDir, 'index');
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpIndex = path.join(os.tmpdir(), `gdv-index-${stamp}`);
  const msgFile = path.join(os.tmpdir(), `gdv-msg-${stamp}.txt`);

  try {
    await fs.promises.copyFile(realIndex, tmpIndex).catch(() => {});
    const env = { GIT_INDEX_FILE: tmpIndex };

    if (skipped.length) {
      if (hasHead) await git(['reset', '-q', 'HEAD', '--', ...skipped], repo, env);
      else await git(['rm', '--cached', '-r', '-q', '--', ...skipped], repo, env);
    }

    await fs.promises.writeFile(msgFile, `${msg}\n`, 'utf8');
    const args = ['commit', '-F', msgFile];
    if (amend) args.push('--amend');
    const out = await git(args, repo, env);

    // 提交完成后把真实暂存区里已提交的路径对齐到新 HEAD，未选中的暂存内容原样保留
    if (selected.length) await git(['reset', '-q', 'HEAD', '--', ...selected], repo).catch(() => {});

    const short = (await git(['rev-parse', '--short', 'HEAD'], repo).catch(() => '')).trim();
    return {
      ok: true,
      short,
      amend: !!amend,
      files: selected.length,
      detail: String(out || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .join('，'),
    };
  } finally {
    // 临时索引与说明文件不留在磁盘上
    fs.promises.unlink(tmpIndex).catch(() => {});
    fs.promises.unlink(msgFile).catch(() => {});
  }
}
// prize add by yanliang for 执行 commit / amend，支持只提交选中的已暂存文件, 20261022-end

// prize add by yanliang for 读取单个文件的历史提交, 20261022-start
async function readFileHistory(repo, file, limit) {
  const out = await git(
    ['log', '--date=iso-strict', `--max-count=${limit}`, `--pretty=format:${LOG_FORMAT}`, '--follow', '--', file],
    repo
  ).catch(() => '');
  return out
    .split(RECORD)
    .map((c) => c.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((chunk) => {
      const f = chunk.split(FIELD);
      return {
        hash: f[0] || '',
        short: f[1] || '',
        author: f[2] || '',
        date: f[4] || '',
        subject: f[6] || '',
      };
    });
}
// prize add by yanliang for 读取单个文件的历史提交, 20261022-end

// prize add by yanliang for AI 解释：本地旁路存储（.gdv），与 diff 主链路完全隔离, 20261024-start
// 约定：解释由外部（WorkBuddy）生成，服务端只负责「排队 / 存放 / 展示」，自身不发任何网络请求
const GDV_INDEX_FILE = '.gdv/explain/index.json';
const GDV_REQ_DIR = '.gdv/requests';
// prize add by yanliang for 解释文档改为 v3「源码分段+中文讲解」形态, 20261024-start
const GDV_TEMPLATE = 'v3';
// prize add by yanliang for 解释文档改为 v3「源码分段+中文讲解」形态, 20261024-end
const GDV_RELATED_LIMIT = 3;

function gdvAbs(repo, rel) {
  return path.resolve(repo, rel);
}

async function readJsonQuiet(file, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 先写临时文件再 rename：前端随时可能在读，不能让它拿到半截 JSON
async function writeJsonAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, file);
}

async function readExplainIndex(repo) {
  const raw = await readJsonQuiet(gdvAbs(repo, GDV_INDEX_FILE), null);
  const entries =
    raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  return { version: 1, entries };
}

// 用工作区内容算 blob 哈希：与 git rev-parse HEAD:path 同值，未改动的文件天然对得上
async function blobOf(repo, rel) {
  const out = await git(['hash-object', '--', rel], repo);
  return String(out || '').trim();
}

// .gdv 只留在本地，写进 .git/info/exclude，别让它污染「工作区改动」
async function ensureGdvExcluded(repo) {
  const relExclude = (await git(['rev-parse', '--git-path', 'info/exclude'], repo)).trim();
  const file = path.isAbsolute(relExclude) ? relExclude : path.resolve(repo, relExclude);
  let content = '';
  try {
    content = await fs.promises.readFile(file, 'utf8');
  } catch {
    content = '';
  }
  const lines = content.split(/\r?\n/).map((s) => s.trim());
  if (lines.includes('.gdv/')) return false;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  const header = content.includes('# 由 git-diff-viewer 添加') ? '' : '# 由 git-diff-viewer 添加\n';
  await fs.promises.appendFile(file, `${prefix}${header}.gdv/\n`, 'utf8');
  return true;
}

async function listExplainRequests(repo) {
  const dir = gdvAbs(repo, GDV_REQ_DIR);
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const data = await readJsonQuiet(path.join(dir, name), null);
    if (data && data.id && data.path) out.push(data);
  }
  out.sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')));
  return out;
}

// 单个文件的精确状态：有文档→比对 blob 判过期；无文档→看有没有排队/失败
async function explainStatusOf(repo, rel) {
  const blob = await blobOf(repo, rel);
  const entry = (await readExplainIndex(repo)).entries[rel] || null;
  const mine = (await listExplainRequests(repo)).filter((r) => r.path === rel);
  const live = mine.filter((r) => r.status === 'pending' || r.status === 'working').pop() || null;
  const failed = mine.filter((r) => r.status === 'failed').pop() || null;

  let state = 'none';
  if (entry) state = entry.blob === blob ? 'ready' : 'stale';
  else if (live) state = 'pending';
  else if (failed) state = 'failed';

  return { path: rel, blob, state, entry, request: live || failed, regenerating: !!live && !!entry };
}

async function createExplainRequest(repo, rawPath) {
  const rel = safeRelPath(rawPath);
  if (rel.split('/')[0] === '.git') throw new Error('不解释 .git 目录里的文件');
  const abs = worktreeFile(repo, rel);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`文件不存在或不是普通文件：${rel}`);

  const blob = await blobOf(repo, rel);
  const entry = (await readExplainIndex(repo)).entries[rel] || null;
  const requests = await listExplainRequests(repo);
  const live = requests
    .filter((r) => r.path === rel && (r.status === 'pending' || r.status === 'working'))
    .pop();

  // 同一份内容已经解释过、或已经在排队，直接复用，不重复排队
  if (entry && entry.blob === blob && !live) {
    return { reused: true, state: 'ready', path: rel, blob, entry };
  }
  if (live) return { reused: true, state: 'pending', path: rel, blob, request: live };

  await ensureGdvExcluded(repo);

  const now = new Date().toISOString();
  const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const commit = (await git(['rev-parse', 'HEAD'], repo).catch(() => '')).trim();

  const request = {
    id,
    status: 'pending',
    path: rel,
    blob,
    commit: commit ? commit.slice(0, 12) : '',
    docTarget: `.gdv/explain/${rel}.md`,
    template: GDV_TEMPLATE,
    relatedLimit: GDV_RELATED_LIMIT,
    related: [],
    requestedAt: now,
    claimedAt: null,
    finishedAt: null,
    error: null,
  };
  await writeJsonAtomic(gdvAbs(repo, `${GDV_REQ_DIR}/${id}.json`), request);
  return { reused: false, state: 'pending', path: rel, blob, request };
}
// prize add by yanliang for AI 解释：本地旁路存储（.gdv），与 diff 主链路完全隔离, 20261024-end

// prize add by yanliang for 在系统文件管理器里定位文件，供解释文档顶部的「打开位置」使用, 20261024-start
// 只在本机回环地址上开放：服务一旦 HOST=0.0.0.0 暴露到局域网，
// 陌生请求就不该在宿主机的桌面上弹窗
function isLoopbackRequest(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function revealInFileManager(repo, rawPath) {
  const rel = safeRelPath(rawPath);
  const abs = worktreeFile(repo, rel);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) throw new Error(`路径不存在：${rel}`);

  const target = abs;
  const dir = stat.isDirectory() ? target : path.dirname(target);

  return new Promise((resolve, reject) => {
    let cmd;
    let args;
    if (process.platform === 'win32') {
      // /select 必须和目标路径拼成同一个参数：空格由 execFile 负责加引号，
      // 文件名里允许出现 & 之类的字符，所以不能走 exec 拼命令行
      cmd = 'explorer.exe';
      args = [`/select,${target}`];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = ['-R', target];
    } else {
      cmd = 'xdg-open';
      args = [dir];
    }
    execFile(cmd, args, (err) => {
      // explorer.exe 即使成功也常返回非 0，只有「命令根本起不来」才算失败
      if (err && err.code === 'ENOENT') {
        return reject(new Error(`系统里没有可用的文件管理器命令：${cmd}`));
      }
      resolve({ ok: true, path: target, dir });
    });
  });
}
// prize add by yanliang for 在系统文件管理器里定位文件，供解释文档顶部的「打开位置」使用, 20261024-end

// prize add by yanliang for HTTP 路由与静态资源托管, 20261022-start
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// prize add by yanliang for 目录浏览：供前端在弹出的选择器里挑仓库路径, 20261023-start
const MAX_DIRS = 500;

function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function listWindowsDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const p = String.fromCharCode(c) + ':\\';
    try {
      if (fs.existsSync(p)) out.push(p);
    } catch (_) {}
  }
  return out;
}

// 只列子目录（不列文件），顺带标记哪些是 git 仓库；隐藏目录不下发，避免 .git 之类干扰
function listDir(rawPath) {
  const home = os.homedir();
  let target = String(rawPath || '').trim();
  // Windows 上单写 C: 会被 path.resolve 当成“该盘当前目录”，补上分隔符才是盘根
  if (/^[a-zA-Z]:$/.test(target)) target += path.sep;
  if (!target) target = home;
  if (target.includes('\0')) throw new Error('路径不合法');

  const abs = path.resolve(target);
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    throw new Error('路径不存在：' + abs);
  }
  if (!st.isDirectory()) throw new Error('这不是目录：' + abs);

  let entries = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (_) {
    throw new Error('没有读取权限：' + abs);
  }

  const dirs = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(abs, e.name);
    let dir = e.isDirectory();
    if (!dir && e.isSymbolicLink()) dir = isDirSync(full);
    if (!dir) continue;
    dirs.push({ name: e.name, path: full, isRepo: isDirSync(path.join(full, '.git')) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

  const root = path.parse(abs).root;
  const atRoot = abs === root;

  return {
    path: abs,
    parent: atRoot ? null : path.dirname(abs),
    home,
    root,
    atRoot,
    drives: process.platform === 'win32' && atRoot ? listWindowsDrives() : null,
    isRepo: isDirSync(path.join(abs, '.git')),
    total: dirs.length,
    truncated: dirs.length > MAX_DIRS,
    dirs: dirs.slice(0, MAX_DIRS),
  };
}
// prize add by yanliang for 目录浏览：供前端在弹出的选择器里挑仓库路径, 20261023-end

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

async function handleApi(req, res, urlObj) {
  const q = urlObj.searchParams;
  const action = urlObj.pathname.replace('/api/', '');
  const ignoreSpace = q.get('ignoreSpace') === '1';

  try {
    if (action === 'ping') {
      // prize add by yanliang for 返回平台信息，前端据此调整路径输入提示, 20261022-start
      return sendJson(res, 200, { ok: true, git: GIT_BIN, platform: process.platform, home: os.homedir() });
      // prize add by yanliang for 返回平台信息，前端据此调整路径输入提示, 20261022-end
    }

    // prize add by yanliang for 目录浏览接口，供前端选仓库路径, 20261023-start
    // 放在 resolveRepo 之前：它不针对某个仓库，只列磁盘目录
    if (action === 'ls') {
      return sendJson(res, 200, listDir(q.get('path')));
    }
    // prize add by yanliang for 目录浏览接口，供前端选仓库路径, 20261023-end

    const repo = await resolveRepo(q.get('repo'));

    if (action === 'repo') {
      return sendJson(res, 200, await readRepoInfo(repo));
    }
    if (action === 'commits') {
      const ref = q.get('ref') || 'HEAD';
      const skip = Number(q.get('skip') || 0);
      const limit = Math.min(Number(q.get('limit') || 60), 300);
      return sendJson(res, 200, await readCommits(repo, ref, skip, limit));
    }
    if (action === 'commit') {
      // prize add by yanliang for 同一个 /api/commit 按方法区分：POST 提交，GET 读详情, 20261022-start
      if (req.method === 'POST') {
        const body = await readJsonBody(req, 8 * 1024 * 1024);
        return sendJson(res, 200, await opCommit(repo, body.message, !!body.amend, body.paths));
      }
      // prize add by yanliang for 同一个 /api/commit 按方法区分：POST 提交，GET 读详情, 20261022-end
      return sendJson(res, 200, await readCommitDetail(repo, q.get('hash'), ignoreSpace));
    }
    // prize add by yanliang for 提交面板读取暂存区, 20261022-start
    if (action === 'staged') {
      return sendJson(res, 200, await readStaged(repo));
    }
    // prize add by yanliang for 提交面板读取暂存区, 20261022-end
    if (action === 'compare') {
      return sendJson(res, 200, await readComparison(repo, q.get('base'), q.get('head'), ignoreSpace));
    }
    if (action === 'working') {
      return sendJson(res, 200, await readWorkingTree(repo, ignoreSpace));
    }
    // prize add by yanliang for 单文件内容接口：markdown 预览与图片资源, 20261023-start
    if (action === 'tree') {
      return sendJson(res, 200, await readTree(repo, q.get('rev'), q.get('path')));
    }
    // prize add by yanliang for 「文件」搜索：全量路径列表, 20261026-start
    if (action === 'tree-search') {
      return sendJson(res, 200, await treeSearch(repo, q.get('rev'), q.get('q'), q.get('limit')));
    }
    // prize add by yanliang for 「文件」搜索：全量路径列表, 20261026-end
    if (action === 'file') {
      return sendJson(res, 200, await readFileText(repo, q.get('path'), q.get('rev')));
    }
    if (action === 'raw') {
      const { rel, buf } = await readBlob(repo, q.get('path'), q.get('rev'));
      res.writeHead(200, {
        'Content-Type': mimeOf(rel),
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }
    // prize add by yanliang for 单文件内容接口：markdown 预览与图片资源, 20261023-end
    // prize add by yanliang for 工作区写操作接口（POST，路径在 JSON 体内）, 20261022-start
    if (action === 'git-op') {
      if (req.method !== 'POST') throw new Error('该接口只接受 POST');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await runGitOp(repo, String(body.op || ''), body.paths));
    }
    // prize add by yanliang for 工作区写操作接口（POST，路径在 JSON 体内）, 20261022-end
    if (action === 'file-history') {
      const limit = Math.min(Number(q.get('limit') || 30), 100);
      return sendJson(res, 200, { commits: await readFileHistory(repo, q.get('file'), limit) });
    }

    // prize add by yanliang for 文件编辑器：保存工作区文件（POST，路径在 JSON 体内）, 20261024-start
    if (action === 'save-file') {
      if (req.method !== 'POST') throw new Error('该接口只接受 POST');
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      return sendJson(
        res,
        200,
        await saveWorktreeFile(repo, String(body.path || ''), body.content, body.baseMtimeMs)
      );
    }
    // prize add by yanliang for 文件编辑器：保存工作区文件（POST，路径在 JSON 体内）, 20261024-end

    // prize add by yanliang for AI 解释三个接口：状态 / 全量索引 / 发起解释, 20261024-start
    // 解释文档本身走已有的 /api/file 读取（.gdv 不在 .git 下，readBlob 放行），不另开接口
    if (action === 'explain-status') {
      return sendJson(res, 200, await explainStatusOf(repo, safeRelPath(q.get('path'))));
    }
    if (action === 'explain-index') {
      const index = await readExplainIndex(repo);
      const pending = {};
      // 按 requestedAt 升序下发，同一文件后发起的覆盖先前的，前端只关心最新一条
      for (const r of await listExplainRequests(repo)) {
        if (r.status === 'pending' || r.status === 'working') {
          pending[r.path] = { id: r.id, requestedAt: r.requestedAt, blob: r.blob };
        } else if (r.status === 'failed') {
          pending[r.path] = { id: r.id, requestedAt: r.requestedAt, blob: r.blob, failed: true };
        }
      }
      return sendJson(res, 200, { entries: index.entries, pending });
    }
    if (action === 'explain-request') {
      if (req.method !== 'POST') throw new Error('该接口只接受 POST');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await createExplainRequest(repo, String(body.path || '')));
    }
    // prize add by yanliang for AI 解释三个接口：状态 / 全量索引 / 发起解释, 20261024-end

    // prize add by yanliang for 在文件夹中显示当前文件（解释文档顶部的绝对路径点击）, 20261024-start
    if (action === 'reveal') {
      if (req.method !== 'POST') throw new Error('该接口只接受 POST');
      if (!isLoopbackRequest(req)) throw new Error('只有在运行服务的本机上才能打开文件位置');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await revealInFileManager(repo, String(body.path || '')));
    }
    // prize add by yanliang for 在文件夹中显示当前文件（解释文档顶部的绝对路径点击）, 20261024-end

    return sendJson(res, 404, { error: '未知接口' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || String(err) });
  }
}
// prize add by yanliang for HTTP 路由与静态资源托管, 20261022-end

// prize add by yanliang for 启动服务, 20261022-start
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (urlObj.pathname.startsWith('/api/')) {
    handleApi(req, res, urlObj);
  } else {
    serveStatic(res, decodeURIComponent(urlObj.pathname));
  }
});

probeGit().then((bin) => {
  if (!bin) {
    console.error('未找到 git，请把 git 加入 PATH 或设置环境变量 GIT_BIN');
    process.exit(1);
  }
  GIT_BIN = bin;
  server.listen(PORT, HOST, () => {
    console.log(`Git 提交比对工具已启动：http://127.0.0.1:${PORT}`);
    // prize add by yanliang for 监听 0.0.0.0 时打印局域网可访问地址, 20261022-start
    if (HOST === '0.0.0.0' || HOST === '::') {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const n of nets[name] || []) {
          if (n.family === 'IPv4' && !n.internal) console.log(`局域网访问：http://${n.address}:${PORT}`);
        }
      }
    }
    // prize add by yanliang for 监听 0.0.0.0 时打印局域网可访问地址, 20261022-end
    console.log(`使用 git：${GIT_BIN}`);
  });
});
// prize add by yanliang for 启动服务, 20261022-end
