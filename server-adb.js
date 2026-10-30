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

  // prize add by yanliang for 手动提权：adb root + adb remount 后再给状态, 20261030-start
  /**
   * 面板上点「提权」走这里：adb root → 等 adbd 回来 → adb remount → 写探针验证 → 报状态
   * 一律不抛异常，每步的原始输出都塞进 steps 给前端展示，失败也让人看得见原因
   */
  async function elevate(serialRaw) {
    const serial = serialRaw ? safeSerial(serialRaw) : await firstOnlineSerial();
    const steps = [];
    const add = (cmd, r, kind) => {
      steps.push({
        cmd,
        code: r && typeof r.code === 'number' ? r.code : -1,
        out: r ? runOut(r) : '',
        kind: kind || (r && r.code === 0 ? 'ok' : 'error'),
      });
    };
    const st = await run(['-s', serial, 'get-state'], 10000);
    if (st.code !== 0 || !/device/.test(st.out || '')) {
      add('adb -s ' + serial + ' get-state', st, 'error');
      return { ok: false, root: false, remounted: false, error: '设备不在线，请检查 USB 连接与调试授权', steps };
    }

    // 已经是 root 就别再重启一次 adbd：adb root 会让设备短暂 offline
    const uid0 = await run(['-s', serial, 'shell', 'id -u'], 10000);
    let isRoot = (uid0.out || '').trim() === '0';
    if (isRoot) add('adb shell id -u', uid0, 'ok');

    if (!isRoot) {
      const r = await run(['-s', serial, 'root'], 25000);
      add('adb -s ' + serial + ' root', r, r.code === 0 ? 'ok' : 'error');
      const text = (r.out || '') + (r.err || '');
      if (/cannot run as root/i.test(text)) {
        return {
          ok: false,
          root: false,
          remounted: false,
          production: true,
          error: '这台设备是 user 版本，adb root 被系统禁掉了。framework 替换需要 userdebug / eng 版本，或已 root 的 boot。',
          steps,
        };
      }
      // adb root 会重启 adbd，必须等它回来再探身份
      const w = await run(['-s', serial, 'wait-for-device'], 45000);
      add('adb -s ' + serial + ' wait-for-device', w, w.code === 0 ? 'ok' : 'error');
      const uid1 = await run(['-s', serial, 'shell', 'id -u'], 10000);
      isRoot = (uid1.out || '').trim() === '0';
      add('adb shell id -u', uid1, isRoot ? 'ok' : 'error');
    }

    let remounted = false;
    let remountText = '';
    if (isRoot) {
      const rm = await run(['-s', serial, 'remount'], 45000);
      add('adb -s ' + serial + ' remount', rm, rm.code === 0 ? 'ok' : 'warn');
      remountText = (rm.out || '') + (rm.err || '');
      if (rm.code !== 0 || /failed|not permitted|read-only/i.test(remountText)) {
        // 老机型 / 部分 MTK 平台 remount 子命令不认，退回 mount 重挂
        const rm2 = await run(['-s', serial, 'shell', 'mount -o rw,remount /'], 25000);
        add('adb shell mount -o rw,remount /', rm2, rm2.code === 0 ? 'ok' : 'warn');
        remountText += (rm2.out || '') + (rm2.err || '');
      }
      // remount 在 Android 10+ 上可能重启 adbd（overlayfs），再来一次等待
      await run(['-s', serial, 'wait-for-device'], 40000);

      // 写探针比看 remount 输出可靠：能真的创建文件才算可写
      const probe = await run(
        ['-s', serial, 'shell', 'touch /system/.gdv_probe 2>&1 && echo __GdvOk; rm -f /system/.gdv_probe'],
        15000
      );
      remounted = /__GdvOk/.test(probe.out || '');
      add('adb shell touch /system/.gdv_probe', probe, remounted ? 'ok' : 'warn');
    }

    // 状态缓存作废，前端刷新时拿到的是提权后的真实身份
    statusCache = { at: 0, data: null };

    let error = '';
    if (!isRoot) error = 'adb root 没有生效（uid 仍不是 0），这台设备可能只允许 shell 身份。';
    else if (!remounted) {
      error = /disable-verity|verity/i.test(remountText)
        ? 'remount 失败：需要先 adb disable-verity，然后 adb reboot，开机后再次提权。'
        : 'root 已获取，但 /system 仍不可写（remount 未成功），替换前需要先解决分区可写。';
    }

    return {
      ok: isRoot && remounted,
      root: isRoot,
      remounted,
      production: false,
      error,
      steps,
    };
  }
  // prize add by yanliang for 手动提权：adb root + adb remount 后再给状态, 20261030-end

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

  // prize add by yanliang for 设备截图页：screencap 抓屏 + uiautomator 布局树, 20261029-start
  const shotsDir = path.join(dataDir, 'adb-shots');
  const SHOT_KEEP = 24;
  const MAX_UI_NODES = 4000;
  const MAX_UI_DEPTH = 40;

  // 只读 PNG 头拿真实像素尺寸，比信 wm size 靠谱（可能是 override 尺寸）
  function pngSize(buf) {
    if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  async function firstOnlineSerial() {
    const dev = await run(['devices'], 12000);
    const list = parseDevices(dev.out).filter((d) => d.state === 'device');
    if (!list.length) throw new Error('没有已连接的设备');
    return list[0].serial;
  }

  async function screenInfo(serial) {
    const r = await run(['-s', serial, 'shell', 'wm size; wm density'], 12000);
    const size = /Override size:\s*(\d+)x(\d+)/.exec(r.out) || /Physical size:\s*(\d+)x(\d+)/.exec(r.out);
    const dens = /Override density:\s*(\d+)/.exec(r.out) || /Physical density:\s*(\d+)/.exec(r.out);
    return {
      width: size ? Number(size[1]) : 0,
      height: size ? Number(size[2]) : 0,
      density: dens ? Number(dens[1]) : 0,
    };
  }

  function pruneShots() {
    try {
      const files = fs
        .readdirSync(shotsDir)
        .filter((n) => /^shot-\d+\.png$/.test(n))
        .map((n) => ({ n, t: fs.statSync(path.join(shotsDir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      files.slice(SHOT_KEEP).forEach((f) => {
        try {
          fs.unlinkSync(path.join(shotsDir, f.n));
        } catch (_) {}
      });
    } catch (_) {}
  }

  // screencap 走 exec-out 会被当字符串解坏，统一「设备落文件 → adb pull」
  async function captureShot(serialRaw) {
    const serial = serialRaw ? safeSerial(serialRaw) : await firstOnlineSerial();
    const remote = '/data/local/tmp/.gdv-screen.png';
    const cap = await run(['-s', serial, 'shell', 'screencap -p ' + remote], 40000);
    if (cap.code !== 0) throw new Error('截图失败：' + runOut(cap));
    fs.mkdirSync(shotsDir, { recursive: true });
    const id = 'shot-' + Date.now() + '.png';
    const abs = path.join(shotsDir, id);
    const pull = await run(['-s', serial, 'pull', remote, abs], 90000);
    run(['-s', serial, 'shell', 'rm -f ' + remote], 8000).catch(() => {});
    if (pull.code !== 0 || !fs.existsSync(abs)) throw new Error('拉取截图失败：' + runOut(pull));
    const buf = fs.readFileSync(abs);
    if (!buf.length) throw new Error('截图文件是空的');
    const px = pngSize(buf) || { width: 0, height: 0 };
    pruneShots();
    const info = await screenInfo(serial).catch(() => ({ width: 0, height: 0, density: 0 }));
    return {
      ok: true,
      id,
      url: '/api/adb-shot-file?id=' + encodeURIComponent(id),
      serial,
      width: px.width,
      height: px.height,
      size: buf.length,
      sizeText: fmtSize(buf.length),
      screen: info,
      at: Date.now(),
    };
  }

  function decodeXml(s) {
    return String(s || '')
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function parseBounds(v) {
    const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(v || '');
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  }

  /**
   * uiautomator dump 的 XML 结构很规整（<hierarchy><node .../>...</hierarchy>），
   * 为了不引依赖就手写一个极简解析：只认开始 / 自闭合 / 结束三种标签。
   */
  function parseUiXml(xml) {
    const root = { depth: 0, cls: '', kids: [] };
    const stack = [root];
    let seq = 1;
    let total = 0;
    let truncated = false;
    let rotation = 0;
    const tagRe = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;
    let m;
    while ((m = tagRe.exec(xml))) {
      const closing = m[1] === '/';
      const tag = m[2];
      const attrs = m[3] || '';
      const selfClose = m[4] === '/';
      if (closing) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (tag === 'hierarchy') {
        const rot = /\brotation="(\d+)"/.exec(attrs);
        if (rot) rotation = Number(rot[1]);
        if (!selfClose) stack.push(root);
        continue;
      }
      if (tag !== 'node') {
        if (!selfClose) stack.push(stack[stack.length - 1]);
        continue;
      }
      const parent = stack[stack.length - 1];
      if (total >= MAX_UI_NODES || parent.depth >= MAX_UI_DEPTH) {
        truncated = true;
        if (!selfClose) stack.push(parent);
        continue;
      }
      const a = {};
      const ar = /([\w:-]+)="([^"]*)"/g;
      let am;
      while ((am = ar.exec(attrs))) a[am[1]] = am[2];
      const node = {
        id: seq++,
        depth: parent.depth + 1,
        idx: Number(a.index || 0),
        cls: decodeXml(a['class'] || ''),
        txt: decodeXml(a.text || ''),
        rid: decodeXml(a['resource-id'] || ''),
        desc: decodeXml(a['content-desc'] || ''),
        pkg: a.package || '',
        b: parseBounds(a.bounds) || [0, 0, 0, 0],
        click: a.clickable === 'true',
        longClick: a['long-clickable'] === 'true',
        scroll: a.scrollable === 'true',
        checkable: a.checkable === 'true',
        checked: a.checked === 'true',
        enabled: a.enabled !== 'false',
        selected: a.selected === 'true',
        focusable: a.focusable === 'true',
        focused: a.focused === 'true',
        password: a.password === 'true',
        kids: [],
      };
      parent.kids.push(node);
      total++;
      if (!selfClose) stack.push(node);
    }
    let clickable = 0;
    let texts = 0;
    const walk = (n) => {
      if (n.click) clickable++;
      if (n.txt) texts++;
      n.kids.forEach(walk);
    };
    root.kids.forEach(walk);
    return {
      tree: root.kids,
      stats: { total, clickable, texts, truncated, rotation },
    };
  }

  async function focusedWindow(serial) {
    // dumpsys window 里 mCurrentFocus 会出现多次（先 null 后真值），取最后一条能解析的
    const r = await run(['-s', serial, 'shell', 'dumpsys window | grep mCurrentFocus'], 15000);
    const lines = (r.out || '').split(/\r?\n/).filter((l) => l.includes('mCurrentFocus'));
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(lines[i]);
      if (m) return m[1] + '/' + m[2];
    }
    const r2 = await run(['-s', serial, 'shell', 'dumpsys activity activities | grep -m1 mResumedActivity'], 15000);
    const m2 = /([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(r2.out || '');
    return m2 ? m2[1] + '/' + m2[2] : '';
  }

  async function dumpLayout(serialRaw) {
    const serial = serialRaw ? safeSerial(serialRaw) : await firstOnlineSerial();
    let remote = '/data/local/tmp/.gdv-ui.xml';
    let r = await run(['-s', serial, 'shell', 'uiautomator dump ' + remote], 45000);
    if (r.code !== 0 || /ERROR|could not|No such file/i.test(r.out + r.err)) {
      // 个别机型不允许写 /data/local/tmp，退回默认路径
      const r2 = await run(['-s', serial, 'shell', 'uiautomator dump'], 45000);
      if (r2.code !== 0) throw new Error('读取布局失败：' + (runOut(r2) || runOut(r)));
      r = r2;
      remote = '/sdcard/window_dump.xml';
    }
    const stamp = Date.now();
    const local = path.join(os.tmpdir(), 'gdv-ui-' + stamp + '.xml');
    const pull = await run(['-s', serial, 'pull', remote, local], 60000);
    if (pull.code !== 0 || !fs.existsSync(local)) throw new Error('拉取布局文件失败：' + runOut(pull));
    const xml = fs.readFileSync(local, 'utf8');
    try {
      fs.unlinkSync(local);
    } catch (_) {}
    if (!/<hierarchy/i.test(xml)) throw new Error('布局文件内容异常（不是 uiautomator 的 XML）');
    const parsed = parseUiXml(xml);
    const focus = await focusedWindow(serial).catch(() => '');
    const screen = await screenInfo(serial).catch(() => ({ width: 0, height: 0, density: 0 }));
    return {
      ok: true,
      serial,
      tree: parsed.tree,
      stats: parsed.stats,
      focus,
      screen,
      xmlSize: Buffer.byteLength(xml, 'utf8'),
      at: stamp,
    };
  }

  // 截图文件由浏览器直接 <img> 拉，走原始二进制而不是 JSON
  function sendShot(req, res, id) {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ADB 只能在运行服务的本机上访问');
    }
    const name = String(id || '');
    if (!/^shot-\d+\.png$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('截图 id 不合法');
    }
    const abs = path.join(shotsDir, name);
    if (!fs.existsSync(abs)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('截图不存在（可能已被清理）');
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Length': fs.statSync(abs).size,
    });
    fs.createReadStream(abs).pipe(res);
  }
  // prize add by yanliang for 设备截图页：screencap 抓屏 + uiautomator 布局树, 20261029-end

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

      // prize add by yanliang for 手动提权：adb root + adb remount 后再给状态, 20261030-start
      case 'adb-root':
        if (ctx.req.method !== 'POST') throw new Error('该接口只接受 POST');
        return elevate((body.serial || q.get('serial') || '').trim());
      // prize add by yanliang for 手动提权：adb root + adb remount 后再给状态, 20261030-end

      // prize add by yanliang for 设备截图页：抓屏 + 布局树, 20261029-start
      case 'adb-shot':
        return captureShot((body.serial || q.get('serial') || '').trim());

      case 'adb-layout':
        return dumpLayout((body.serial || q.get('serial') || '').trim());
      // prize add by yanliang for 设备截图页：抓屏 + 布局树, 20261029-end

      default:
        throw new Error('未知接口');
    }
  }

  return { handle, ensureAdb: () => ensureAdb(true), status, sendShot };
}
// prize add by yanliang for ADB 框架替换模块（配对版）, 20261029-end

module.exports = { createAdb };
