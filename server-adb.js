/**
* prize add by yanliang  20261029-start
* ADB 框架替换模块（配对版）。
*
* 模型：一条「配对」= 本地文件 ↔ 设备上的目标文件，比如
*   D:\alps\out\...\framework\framework.jar  →  /system/framework/framework.jar
* 配对存在 .gdv/adb-pairs.json 里，面板里可增删、可刷新校验、可只执行勾选的几条。
* 所有 adb 调用都走 execFile 参数数组，不拼 shell 字符串；只在跑服务的本机上开放。
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_TARGET = '/system/framework';
// 递归扫描（同名自动配对）时只认这些扩展名
const SCAN_EXT = new Set(['.jar', '.apk', '.odex', '.vdex', '.art', '.oat', '.apex', '.xml', '.prop', '.so', '.bin']);
const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_FILES = 400;
const MAX_LS_ENTRIES = 600;
const MAX_LINES = 2000;
const MAX_JOBS = 30;
const JOB_KEEP = 20;

function adbCandidates() {
  const list = [process.env.ADB_BIN];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    list.push(
      path.join(local, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
      'C:\\platform-tools\\adb.exe',
      'D:\\platform-tools\\adb.exe',
      'C:\\Android\\platform-tools\\adb.exe',
      'C:\\adb\\adb.exe'
    );
  }
  list.push('adb');
  return list.filter(Boolean);
}

function execAdb(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: timeout || 30000 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          out: String(stdout || ''),
          err: String(stderr || ''),
          timeout: !!(err && err.killed),
          spawnError: err && err.code === 'ENOENT' ? 'ENOENT' : '',
        });
      }
    );
  });
}

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// 设备序列号只允许常见字符，避免奇怪输入混进参数
function safeSerial(s) {
  const v = String(s || '').trim();
  if (!/^[A-Za-z0-9_.:\-]+$/.test(v)) throw new Error('设备序列号不合法');
  return v;
}

// 设备路径只做基本校验：引号/换行会破坏 shell 命令
function safeRemote(p) {
  const v = String(p || '').trim();
  if (!v.startsWith('/')) throw new Error('设备路径必须是绝对路径：' + v);
  if (/['"\n\r]/.test(v)) throw new Error('设备路径包含非法字符：' + v);
  // prize add by yanliang for 顺手把重复的 // 收成一个，免得路径被拼出 //system/..., 20261029-start
  return v.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  // prize add by yanliang for 顺手把重复的 // 收成一个，免得路径被拼出 //system/..., 20261029-end
}

function safeLocal(p) {
  const v = path.resolve(String(p || '').trim());
  if (!v || v.includes('\0')) throw new Error('本地路径不合法：' + p);
  return v;
}

function shq(p) {
  return "'" + p + "'";
}

function createAdb(opts) {
  const rootDir = opts.rootDir;
  const isLoopback = opts.isLoopback;
  const dataDir = path.join(rootDir, '.gdv');
  const backupDir = path.join(dataDir, 'adb-backup');
  const pairsFile = path.join(dataDir, 'adb-pairs.json');
  // prize add by yanliang for 组合包：把勾选的配对存成带名字的组合, 20261029-start
  const packsFile = path.join(dataDir, 'adb-packs.json');
  // prize add by yanliang for 组合包：把勾选的配对存成带名字的组合, 20261029-end
  const historyFile = path.join(dataDir, 'adb-jobs.json');

  let ADB_BIN = null;
  const jobs = new Map();
  // 顶栏每 8 秒问一次状态，设备详情要走 shell，加个短缓存免得一直占用 adb
  let statusCache = { at: 0, data: null };

  /* ---------------- adb 探测 ---------------- */

  async function ensureAdb(force) {
    if (ADB_BIN && !force) return ADB_BIN;
    for (const bin of adbCandidates()) {
      const r = await execAdb(bin, ['version'], 8000);
      if (!r.spawnError && /Android Debug Bridge/i.test(r.out)) {
        ADB_BIN = bin;
        return bin;
      }
    }
    ADB_BIN = null;
    throw new Error('没有找到 adb：请把 platform-tools 加入 PATH，或设置环境变量 ADB_BIN 指向 adb.exe');
  }

  async function run(args, timeout) {
    const bin = await ensureAdb();
    const r = await execAdb(bin, args, timeout);
    if (r.spawnError) ADB_BIN = null;
    return r;
  }

  function runOut(r) {
    return (r.out || '').trim() || (r.err || '').trim();
  }

  /* ---------------- 设备状态 ---------------- */

  function parseDevices(text) {
    const list = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^List of devices/i.test(line) || /^\*/.test(line)) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const item = { serial: parts[0], state: parts[1], model: '', product: '', transport: '' };
      for (const kv of parts.slice(2)) {
        const i = kv.indexOf(':');
        if (i < 0) continue;
        const k = kv.slice(0, i);
        const v = kv.slice(i + 1);
        if (k === 'model') item.model = v;
        else if (k === 'product') item.product = v;
        else if (k === 'transport_id') item.transport = v;
      }
      list.push(item);
    }
    return list;
  }

  async function deviceDetail(serial) {
    const cmd =
      'getprop ro.product.model; echo ---; getprop ro.build.version.release; echo ---; ' +
      'getprop ro.build.version.sdk; echo ---; getprop ro.product.cpu.abi; echo ---; ' +
      'getprop ro.build.type; echo ---; getprop ro.debuggable; echo ---; id -u';
    const r = await run(['-s', serial, 'shell', cmd], 15000);
    const seg = String(r.out || '').split(/---\r?\n?/).map((s) => s.trim());
    return {
      model: seg[0] || '',
      release: seg[1] || '',
      sdk: seg[2] || '',
      abi: seg[3] || '',
      buildType: seg[4] || '',
      debuggable: seg[5] === '1',
      uid: seg[6] || '',
      root: seg[6] === '0',
    };
  }

  async function status(fresh) {
    if (!fresh && statusCache.data && Date.now() - statusCache.at < 4000) return statusCache.data;
    const bin = await ensureAdb();
    const ver = await run(['version'], 8000);
    const versionLine = (ver.out.split(/\r?\n/).find((l) => /Android Debug Bridge version/i.test(l)) || '').trim();
    const dev = await run(['devices', '-l'], 15000);
    const devices = parseDevices(dev.out);
    for (const d of devices) {
      if (d.state !== 'device') continue;
      try {
        Object.assign(d, await deviceDetail(d.serial));
      } catch (_) {
        d.detailError = true;
      }
    }
    const data = {
      ok: true,
      adb: bin,
      version: versionLine.replace(/^Android Debug Bridge version\s*/i, ''),
      platform: process.platform,
      devices,
      online: devices.filter((d) => d.state === 'device').length,
      targetDir: DEFAULT_TARGET,
      pairs: readPairs().length,
    };
    statusCache = { at: Date.now(), data };
    return data;
  }

  /* ---------------- 本地目录 ---------------- */

  // 单层列表（选择文件用）：目录与文件都列，文件不限扩展名
  function localList(rawDir) {
    const dir = path.resolve(String(rawDir || '').trim());
    let st;
    try {
      st = fs.statSync(dir);
    } catch (_) {
      throw new Error('目录不存在：' + dir);
    }
    if (!st.isDirectory()) throw new Error('这不是目录：' + dir);

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      throw new Error('没有读取权限：' + dir);
    }

    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        dirs.push({ name: e.name, path: full });
        continue;
      }
      if (!e.isFile()) continue;
      let size = 0;
      let mtime = 0;
      try {
        const s = fs.statSync(full);
        size = s.size;
        mtime = s.mtimeMs;
      } catch (_) {}
      files.push({ name: e.name, path: full, size, sizeText: fmtSize(size), mtime });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

    const root = path.parse(dir).root;
    return {
      ok: true,
      dir,
      parent: dir === root ? null : path.dirname(dir),
      atRoot: dir === root,
      dirs,
      files,
      total: dirs.length + files.length,
    };
  }

  // 递归扫描（同名自动配对用）：只收 SCAN_EXT 里的文件
  function scanTree(rawDir) {
    const dir = path.resolve(String(rawDir || '').trim());
    let st;
    try {
      st = fs.statSync(dir);
    } catch (_) {
      throw new Error('目录不存在：' + dir);
    }
    if (!st.isDirectory()) throw new Error('这不是目录：' + dir);

    const files = [];
    let truncated = false;

    const walk = (base, rel, depth) => {
      if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SCAN_FILES) return;
      let entries;
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch (_) {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(base, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          walk(full, r, depth + 1);
          continue;
        }
        if (!e.isFile()) continue;
        if (!SCAN_EXT.has(path.extname(e.name).toLowerCase())) continue;
        if (files.length >= MAX_SCAN_FILES) {
          truncated = true;
          return;
        }
        let size = 0;
        let mtime = 0;
        try {
          const s = fs.statSync(full);
          size = s.size;
          mtime = s.mtimeMs;
        } catch (_) {}
        files.push({ rel: r, name: e.name, size, sizeText: fmtSize(size), mtime, abs: full });
      }
    };

    walk(dir, '', 0);
    return { ok: true, dir, total: files.length, truncated, files };
  }

  /* ---------------- 设备目录 ---------------- */

  function parseStatLines(text) {
    const rows = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^stat:/.test(line)) continue;
      const parts = line.split('|');
      if (parts.length < 7) continue;
      const isDir = /^directory/i.test(parts[0]);
      const size = Number(parts[4]) || 0;
      rows.push({
        path: parts.slice(6).join('|'),
        name: '',
        isDir,
        perms: parts[1],
        owner: parts[2],
        group: parts[3],
        size,
        sizeText: isDir ? '-' : fmtSize(size),
        mtime: (Number(parts[5]) || 0) * 1000,
      });
      rows[rows.length - 1].name = path.posix.basename(rows[rows.length - 1].path);
    }
    return rows;
  }

  async function remoteList(serial, rawDir) {
    const dir = safeRemote(rawDir);
    const cmd =
      "stat -c '%F|%A|%U|%G|%s|%Y|%n' " + shq(dir) + '/* ' + shq(dir) + '/.[!.]* 2>/dev/null';
    const r = await run(['-s', serial, 'shell', cmd], 30000);
    const rows = parseStatLines(r.out);
    const dirs = rows.filter((x) => x.isDir).map((x) => ({ name: x.name, path: x.path }));
    const files = rows.filter((x) => !x.isDir).slice(0, MAX_LS_ENTRIES);
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const parent = dir === '/' ? null : path.posix.dirname(dir);
    return { ok: true, dir, parent, dirs, files, total: dirs.length + files.length };
  }

  async function remoteFind(serial, rawDir) {
    const dir = safeRemote(rawDir);
    const r = await run(['-s', serial, 'shell', 'find ' + shq(dir) + ' -type f 2>/dev/null'], 60000);
    const out = [];
    for (const raw of String(r.out || '').split(/\r?\n/)) {
      const p = raw.trim();
      if (!p.startsWith('/')) continue;
      if (p.length <= dir.length) continue;
      out.push({ path: p, rel: p.slice(dir.length + 1) });
    }
    return out;
  }

  // 一次 shell 批量判断设备上这些文件在不在、多大
  async function remoteCheck(serial, remotes) {
    const map = new Map();
    if (!remotes.length) return map;
    const list = remotes.map((p) => shq(safeRemote(p))).join(' ');
    const cmd =
      'for f in ' + list + '; do if [ -e "$f" ]; then stat -c "%s|%n" "$f"; else echo "MISS|$f"; fi; done';
    const r = await run(['-s', serial, 'shell', cmd], 60000);
    for (const raw of String(r.out || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const i = line.indexOf('|');
      if (i < 0) continue;
      const head = line.slice(0, i);
      const p = line.slice(i + 1);
      if (head === 'MISS') map.set(p, { exists: false, size: 0 });
      else map.set(p, { exists: true, size: Number(head) || 0 });
    }
    return map;
  }

  /* ---------------- 配对存取 ---------------- */

  function readPairs() {
    try {
      const list = JSON.parse(fs.readFileSync(pairsFile, 'utf8'));
      if (!Array.isArray(list)) return [];
      return list
        .filter((p) => p && p.local && p.remote)
        .map((p, i) => ({
          id: String(p.id || 'p' + (i + 1)),
          local: String(p.local),
          // prize add by yanliang for 显示前把旧的 //system 归一成 /system, 20261029-start
          remote: String(p.remote).replace(/\/{2,}/g, '/'),
          // prize add by yanliang for 显示前把旧的 //system 归一成 /system, 20261029-end
          checked: p.checked !== false,
        }));
    } catch (_) {
      return [];
    }
  }

  function writePairs(list) {
    const clean = (Array.isArray(list) ? list : [])
      .filter((p) => p && p.local && p.remote)
      .map((p, i) => ({
        id: String(p.id || 'p' + Date.now().toString(36) + i),
        // 落盘前统一成绝对路径，顺手把重复分隔符吃掉
        local: path.resolve(String(p.local)),
        remote: safeRemote(p.remote),
        checked: p.checked !== false,
      }));
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(pairsFile, JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  /* ---------------- 组合包存取 ---------------- */
  // prize add by yanliang for 组合包：把勾选的配对存成带名字的组合, 20261029-start
  // 组合包存的是配对快照（local/remote），不引用配对 id，所以删掉配对也不会把包弄坏
  function readPacks() {
    try {
      const raw = JSON.parse(fs.readFileSync(packsFile, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.packs) ? raw.packs : [];
      return list
        .filter((k) => k && k.name)
        .map((k, i) => ({
          id: String(k.id || 'k' + (i + 1)),
          name: String(k.name),
          createdAt: Number(k.createdAt) || 0,
          updatedAt: Number(k.updatedAt) || Number(k.createdAt) || 0,
          pairs: (Array.isArray(k.pairs) ? k.pairs : [])
            .filter((p) => p && p.local && p.remote)
            .map((p) => ({ local: String(p.local), remote: String(p.remote) })),
        }));
    } catch (_) {
      return [];
    }
  }

  function writePacks(list) {
    const clean = (Array.isArray(list) ? list : [])
      .filter((k) => k && k.name)
      .map((k, i) => ({
        id: String(k.id || 'k' + Date.now().toString(36) + i),
        name: String(k.name).slice(0, 60),
        createdAt: Number(k.createdAt) || Date.now(),
        updatedAt: Date.now(),
        pairs: (Array.isArray(k.pairs) ? k.pairs : [])
          .filter((p) => p && p.local && p.remote)
          .map((p) => ({ local: path.resolve(String(p.local)), remote: safeRemote(p.remote) })),
      }));
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(packsFile, JSON.stringify({ packs: clean }, null, 2), 'utf8');
    return clean;
  }
  // prize add by yanliang for 组合包：把勾选的配对存成带名字的组合, 20261029-end

  // 单条配对补上两端的实时信息：本地大小 / 设备是否存在 / 设备大小
  async function enrichPairs(serial, pairs) {
    const remotes = pairs.map((p) => p.remote);
    const check = serial ? await remoteCheck(serial, remotes) : new Map();
    return pairs.map((p) => {
      const out = { ...p };
      try {
        const s = fs.statSync(p.local);
        out.localExists = s.isFile();
        out.localSize = s.size;
        out.localSizeText = fmtSize(s.size);
        out.localMtime = s.mtimeMs;
      } catch (_) {
        out.localExists = false;
        out.localSize = 0;
        out.localSizeText = '-';
      }
      const c = check.get(p.remote);
      out.remoteExists = !!(c && c.exists);
      out.remoteSize = c ? c.size : 0;
      out.remoteSizeText = c && c.exists ? fmtSize(c.size) : '-';
      out.sameSize = out.localExists && out.remoteExists && out.localSize === out.remoteSize;
      return out;
    });
  }

  /* ---------------- 任务 ---------------- */

  function log(job, text, kind) {
    job.lines.push({ t: Date.now(), text: String(text), kind: kind || 'info' });
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  }

  function stepLog(job, label, r) {
    const out = [(r.out || '').trim(), (r.err || '').trim()].filter(Boolean).join('\n');
    log(job, label + (out ? '\n' + out : '') + (r.code ? '\n（返回码 ' + r.code + '）' : ''), r.code ? 'error' : 'cmd');
  }

  function saveHistory() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const list = [...jobs.values()]
        .filter((j) => j.done)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, JOB_KEEP)
        .map((j) => ({
          id: j.id,
          startedAt: j.startedAt,
          finishedAt: j.finishedAt,
          device: j.device,
          deviceLabel: j.deviceLabel,
          backup: j.backup,
          reboot: j.reboot,
          ok: j.ok,
          results: j.results,
          error: j.error || '',
        }));
      fs.writeFileSync(historyFile, JSON.stringify(list, null, 2), 'utf8');
    } catch (_) {}
  }

  function history() {
    try {
      const list = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      return { ok: true, items: Array.isArray(list) ? list : [] };
    } catch (_) {
      return { ok: true, items: [] };
    }
  }

  async function runJob(job) {
    const serial = job.serial;
    const pairs = job.pairs;
    let failed = 0;

    try {
      log(job, '开始：' + job.deviceLabel + ' · ' + pairs.length + ' 组配对', 'head');
      const st = await run(['-s', serial, 'get-state'], 10000);
      stepLog(job, '$ adb -s ' + serial + ' get-state', st);
      if (st.code !== 0 || !/device/.test(st.out)) throw new Error('设备不在线，请检查 USB 连接与调试授权');

      log(job, '获取 root 权限…');
      const rootRes = await run(['-s', serial, 'root'], 20000);
      stepLog(job, '$ adb -s ' + serial + ' root', rootRes);
      if (/cannot run as root/i.test(rootRes.out + rootRes.err)) {
        log(job, '提示：这台机器是 user 版本，adb root 不可用；后面的 remount 大概率会失败', 'warn');
      }
      // adb root 会重启 adbd，必须等它回来再继续
      const wait = await run(['-s', serial, 'wait-for-device'], 40000);
      stepLog(job, '$ adb -s ' + serial + ' wait-for-device', wait);

      const uid = await run(['-s', serial, 'shell', 'id -u'], 10000);
      const isRoot = (uid.out || '').trim() === '0';
      log(job, isRoot ? '当前 shell 身份：root' : '当前 shell 身份：非 root（uid=' + (uid.out || '?').trim() + '）', isRoot ? 'ok' : 'warn');

      // 只有目标落在分区上时才需要 remount
      const needRemount = pairs.some((p) => /^\/(system|vendor|product|odm|system_ext|vendor_dlkm|odm_dlkm)/.test(p.remote));
      if (needRemount) {
        log(job, '重新挂载系统分区为可写…');
        const rm = await run(['-s', serial, 'remount'], 40000);
        stepLog(job, '$ adb -s ' + serial + ' remount', rm);
        if (rm.code !== 0) {
          const rm2 = await run(['-s', serial, 'shell', 'mount -o rw,remount /'], 20000);
          stepLog(job, '$ adb shell mount -o rw,remount /', rm2);
        }
        const probeDir = path.posix.dirname(pairs[0].remote);
        const probe = await run(
          ['-s', serial, 'shell', 'touch ' + shq(probeDir + '/.gdv_probe') + ' 2>&1 && echo __GdvOk || echo __GdvFail; rm -f ' + shq(probeDir + '/.gdv_probe')],
          15000
        );
        if (!/__GdvOk/.test(probe.out)) {
          log(job, '$ adb shell touch ' + probeDir + '/.gdv_probe\n' + runOut(probe), 'error');
          throw new Error('目标分区不可写：remount 失败。可以试 adb disable-verity 后重启再操作');
        }
        log(job, '分区可写 ✓', 'ok');
      }

      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        const t0 = Date.now();
        const rec = {
          local: p.local,
          remote: p.remote,
          name: path.basename(p.local),
          localSize: 0,
          ok: false,
          ms: 0,
          msg: '',
          backup: '',
        };
        job.current = p.remote;
        job.progress = { index: i + 1, total: pairs.length };
        log(job, '[' + (i + 1) + '/' + pairs.length + '] ' + rec.name + ' → ' + p.remote);

        try {
          const s = fs.statSync(p.local);
          rec.localSize = s.size;
          if (!s.isFile()) throw new Error('本地不是一个文件');

          const exist = await run(['-s', serial, 'shell', '[ -f ' + shq(p.remote) + ' ] && echo __Y || echo __N'], 10000);
          const hasOld = /__Y/.test(exist.out);
          if (!hasOld) log(job, '  设备上没有同名文件，是新增', 'warn');

          if (job.backup && hasOld) {
            const bdir = path.join(backupDir, job.id, path.posix.dirname(p.remote).replace(/^\//, '').replace(/\//g, '_'));
            fs.mkdirSync(bdir, { recursive: true });
            const bp = path.join(bdir, path.posix.basename(p.remote));
            const b = await run(['-s', serial, 'pull', p.remote, bp], 180000);
            if (b.code === 0 && fs.existsSync(bp)) {
              rec.backup = bp;
              log(job, '  已备份原文件 → ' + bp, 'ok');
            } else {
              log(job, '  备份失败，继续推送：' + runOut(b), 'warn');
            }
          }

          const push = await run(['-s', serial, 'push', p.local, p.remote], 300000);
          stepLog(job, '$ adb push ' + rec.name + ' → ' + p.remote, push);
          if (push.code !== 0) throw new Error('push 失败：' + runOut(push));

          const after = await remoteCheck(serial, [p.remote]);
          const got = after.get(p.remote);
          if (got && got.exists && got.size !== rec.localSize) {
            log(job, '  注意：设备上大小 ' + fmtSize(got.size) + ' 与本地 ' + fmtSize(rec.localSize) + ' 不一致', 'warn');
          } else if (got && got.exists) {
            log(job, '  大小校验一致：' + fmtSize(got.size), 'ok');
          }

          if (job.chmod) {
            const c = await run(['-s', serial, 'shell', 'chmod 644 ' + shq(p.remote)], 10000);
            if (c.code !== 0) log(job, '  chmod 失败：' + runOut(c), 'warn');
            else log(job, '  chmod 644 完成', 'ok');
          }

          rec.ok = true;
          rec.msg = '已替换';
        } catch (e) {
          rec.msg = e.message || String(e);
          failed++;
          log(job, '  失败：' + rec.msg, 'error');
        }
        rec.ms = Date.now() - t0;
        job.results.push(rec);
      }

      log(job, '同步文件系统…');
      const sync = await run(['-s', serial, 'shell', 'sync'], 60000);
      stepLog(job, '$ adb shell sync', sync);

      if (job.reboot) {
        log(job, '发送重启指令…');
        const rb = await run(['-s', serial, 'reboot'], 20000);
        stepLog(job, '$ adb -s ' + serial + ' reboot', rb);
        if (rb.code === 0) log(job, '设备正在重启，重启完成后新文件生效', 'ok');
      } else {
        log(job, '按设置没有自动重启：需要手动重启设备新文件才生效', 'warn');
      }

      job.ok = failed === 0;
      log(
        job,
        failed === 0 ? '全部完成：' + pairs.length + ' 组配对已替换' : '完成，但有 ' + failed + ' 组失败',
        failed === 0 ? 'head' : 'error'
      );
    } catch (e) {
      job.ok = false;
      job.error = e.message || String(e);
      log(job, '中断：' + job.error, 'error');
    } finally {
      job.done = true;
      job.finishedAt = Date.now();
      job.current = '';
      saveHistory();
    }
  }

  function startReplace(body) {
    const serial = safeSerial(body.serial);
    const raw = Array.isArray(body.pairs) ? body.pairs : [];
    if (!raw.length) throw new Error('没有勾选任何配对');

    const pairs = raw.map((p) => {
      const local = safeLocal(p.local);
      if (!fs.existsSync(local)) throw new Error('本地文件不存在：' + local);
      return { local, remote: safeRemote(p.remote) };
    });

    const job = {
      id: String(Date.now()),
      startedAt: Date.now(),
      finishedAt: 0,
      serial,
      device: serial,
      deviceLabel: String(body.deviceLabel || serial),
      backup: !!body.backup,
      chmod: body.chmod !== false,
      reboot: !!body.reboot,
      pairs,
      lines: [],
      results: [],
      done: false,
      ok: false,
      error: '',
      current: '',
      progress: { index: 0, total: pairs.length },
    };
    jobs.set(job.id, job);
    if (jobs.size > MAX_JOBS) {
      const old = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
      while (jobs.size > MAX_JOBS && old.length) jobs.delete(old.shift().id);
    }
    runJob(job);
    return { ok: true, jobId: job.id, total: pairs.length };
  }

  function jobState(id, from) {
    const job = jobs.get(String(id || ''));
    if (!job) {
      const h = history().items.find((x) => x.id === String(id));
      if (!h) throw new Error('任务不存在或服务已重启');
      return {
        ok: true,
        id: h.id,
        done: true,
        ok: h.ok,
        fromHistory: true,
        lines: [],
        next: 0,
        results: h.results || [],
        error: h.error || '',
      };
    }
    const cursor = Math.max(0, Number(from || 0));
    return {
      ok: true,
      id: job.id,
      done: job.done,
      ok: job.ok,
      error: job.error,
      current: job.current,
      progress: job.progress,
      lines: job.lines.slice(cursor),
      next: job.lines.length,
      results: job.results,
    };
  }

  /* ---------------- 路由 ---------------- */

  async function handle(action, ctx) {
    if (!isLoopback(ctx.req)) throw new Error('ADB 只能在运行服务的本机上操作');
    const q = ctx.q;
    const body = ctx.body || {};
    switch (action) {
      case 'adb-status':
        return status(q.get('fresh') === '1');

      case 'adb-pairs':
      case 'adb-pairs-refresh': {
        const pairs = readPairs();
        const serial = q.get('serial') ? safeSerial(q.get('serial')) : '';
        if (!serial) return { ok: true, pairs, items: pairs };
        // adb-pairs-refresh 顺带把两端信息带回来
        const enriched = await enrichPairs(serial, pairs);
        return { ok: true, pairs: enriched, items: enriched };
      }

      case 'adb-pairs-save': {
        const saved = writePairs(body.pairs);
        return { ok: true, pairs: saved };
      }

      // prize add by yanliang for 组合包：把勾选的配对存成带名字的组合, 20261029-start
      case 'adb-packs':
        return { ok: true, packs: readPacks() };

      case 'adb-packs-save': {
        const saved = writePacks(body.packs);
        return { ok: true, packs: saved };
      }

      // 组合包存的是快照，执行前拿这几条去核对两端还在不在
      case 'adb-check': {
        if (ctx.req.method !== 'POST') throw new Error('该接口只接受 POST');
        const list = (Array.isArray(body.pairs) ? body.pairs : [])
          .slice(0, 300)
          .map((p) => ({ local: safeLocal(p.local), remote: safeRemote(p.remote) }));
        const serial = body.serial ? safeSerial(body.serial) : '';
        return { ok: true, pairs: await enrichPairs(serial, list) };
      }
      // prize add by yanliang for 组合包：把勾选的配对存成带名字的组合, 20261029-end

      case 'adb-local-ls':
        return localList(q.get('dir'));

      case 'adb-local-tree':
        return scanTree(q.get('dir'));

      case 'adb-remote-ls':
        return remoteList(safeSerial(q.get('serial')), q.get('dir') || DEFAULT_TARGET);

      case 'adb-auto-pair': {
        const serial = safeSerial(body.serial);
        const localDir = safeLocal(body.localDir);
        const remoteDir = safeRemote(body.remoteDir || DEFAULT_TARGET);
        const tree = scanTree(localDir);
        const remoteFiles = await remoteFind(serial, remoteDir);
        const remoteByRel = new Map(remoteFiles.map((f) => [f.rel, f.path]));
        const pairs = [];
        const missing = [];
        for (const f of tree.files) {
          const hit = remoteByRel.get(f.rel);
          if (hit) pairs.push({ local: f.abs, remote: hit, name: f.rel, size: f.size, sizeText: f.sizeText });
          else missing.push(f.rel);
        }
        return {
          ok: true,
          localDir,
          remoteDir,
          pairs,
          stats: {
            localTotal: tree.files.length,
            remoteTotal: remoteFiles.length,
            matched: pairs.length,
            missingInDevice: missing.slice(0, 20),
            missingCount: missing.length,
          },
        };
      }

      case 'adb-replace':
        if (ctx.req.method !== 'POST') throw new Error('该接口只接受 POST');
        return startReplace(body);

      case 'adb-job':
        return jobState(q.get('id'), q.get('from'));

      case 'adb-history':
        return history();

      default:
        throw new Error('未知接口');
    }
  }

  return { handle, ensureAdb: () => ensureAdb(true), status };
}
// prize add by yanliang for ADB 框架替换模块（配对版）, 20261029-end

module.exports = { createAdb };
