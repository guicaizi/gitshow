#!/usr/bin/env node
/**
 * prize add by yanliang  20261022-start
 * Git 提交记录比对工具 —— 本地只读服务
 * 只调用 git 的只读命令（rev-parse / log / show / diff / status / for-each-ref），
 * 不执行任何写操作，也不接收任意 shell 字符串，全部走 execFile 参数数组。
 * prize add by yanliang for 新增 git 历史比对工具本地服务, 20261022-end
 */
'use strict';

const http = require('http');
const fs = require('fs');
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
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BUFFER = 64 * 1024 * 1024;

// prize add by yanliang for 封装 git 只读调用, 20261022-start
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      GIT_BIN,
      args,
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

// prize add by yanliang for 解析 numstat 为文件变更统计, 20261022-start
function parseNumstat(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [add, del, ...rest] = line.split('\t');
      const file = rest.join('\t');
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

  const diffArgs = [
    'show',
    hash,
    '--patch',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--format=',
    '--unified=3',
  ];
  if (ignoreSpace) diffArgs.push('--ignore-all-space');

  // merge commit 默认不产生 diff，退化为与其第一个父提交比较
  const patchArgs =
    parents.length > 1
      ? ['diff', `${hash}^1`, hash, '--patch', '--no-color', '--no-ext-diff', '--unified=3'].concat(
          ignoreSpace ? ['--ignore-all-space'] : []
        )
      : diffArgs;

  const [patch, numstatRaw] = await Promise.all([
    git(patchArgs, repo).catch((e) => `diff 读取失败：${e.message}`),
    git(
      parents.length > 1
        ? ['diff', '--numstat', `${hash}^1`, hash]
        : ['show', '--numstat', '--format=', hash],
      repo
    ).catch(() => ''),
  ]);

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
    git(['diff', '--numstat', base, head], repo),
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
    git(['diff', ...base, '--numstat'], repo).catch(() => ''),
    git(['status', '--porcelain=v1'], repo).catch(() => ''),
  ]);

  const untracked = statusRaw
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim());

  return {
    kind: 'working',
    short: 'WORKTREE',
    message: '工作区未提交的改动',
    files: parseNumstat(numstatRaw),
    untracked,
    patch,
  };
}
// prize add by yanliang for 读取工作区未提交改动, 20261022-end

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
      return sendJson(res, 200, { ok: true, git: GIT_BIN });
    }

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
      return sendJson(res, 200, await readCommitDetail(repo, q.get('hash'), ignoreSpace));
    }
    if (action === 'compare') {
      return sendJson(res, 200, await readComparison(repo, q.get('base'), q.get('head'), ignoreSpace));
    }
    if (action === 'working') {
      return sendJson(res, 200, await readWorkingTree(repo, ignoreSpace));
    }
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
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Git 提交比对工具已启动：http://127.0.0.1:${PORT}`);
    console.log(`使用 git：${GIT_BIN}`);
  });
});
// prize add by yanliang for 启动服务, 20261022-end
