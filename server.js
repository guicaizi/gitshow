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
const { execFile } = require('child_process');

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
  return { rel, rev: 'worktree', size: st.size, buf: fs.readFileSync(abs) };
}

async function readFileText(repo, rawPath, rawRev) {
  const { rel, rev, size, buf } = await readBlob(repo, rawPath, rawRev);
  const binary = buf.includes(0);
  const tooLarge = size > PREVIEW_TEXT_MAX;
  return {
    path: rel,
    rev,
    size,
    binary,
    tooLarge,
    content: binary || tooLarge ? '' : buf.toString('utf8'),
  };
}
// prize add by yanliang for 读取单个文件内容，供 markdown / 图片在线预览, 20261023-end

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
