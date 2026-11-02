/**
 * prize add by yanliang 20261102-start
 * scrcpy 投屏窗口的启停：只在本机（loopback）可用。
 *
 * 画面是 scrcpy 自己开的原生窗口（SDL），浏览器里嵌不进去；
 * 网页只负责“开 / 关 / 看状态”，真正的画面在旁边那个窗口里。
 */
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function createScrcpy(deps) {
  const isLoopback = (deps && deps.isLoopback) || (() => true);
  const running = new Map(); // serial -> { pid, at, proc }
  let binCache = '';
  let verCache = '';

  // 允许用 SCRCPY_BIN 指定，其次找常见的解压位置
  const CANDIDATES = [
    process.env.SCRCPY_BIN || '',
    'D:\\install\\scrcpy-win64-v5.0.1\\scrcpy-win64-v5.0.1\\scrcpy.exe',
    'D:\\install\\scrcpy-win64-v5.0.1\\scrcpy.exe',
    'C:\\scrcpy\\scrcpy.exe',
  ];

  function bin() {
    if (binCache && fs.existsSync(binCache)) return binCache;
    for (const c of CANDIDATES) {
      if (c && fs.existsSync(c)) {
        binCache = c;
        return c;
      }
    }
    // 最后看 PATH
    try {
      const p = execFileSyncWhere('scrcpy.exe');
      if (p) {
        binCache = p;
        return p;
      }
    } catch (_) {}
    binCache = '';
    return '';
  }

  function execFileSyncWhere(name) {
    // 同步找 PATH 里的 exe，只在首次解析路径时跑一次
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync(IS_WIN ? 'where' : 'which', [name], { windowsHide: true, timeout: 5000 });
      const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      return first && fs.existsSync(first) ? first : '';
    } catch (_) {
      return '';
    }
  }

  function readVersion(b) {
    if (verCache || !b) return Promise.resolve(verCache);
    return new Promise((resolve) => {
      execFile(b, ['--version'], { windowsHide: true, timeout: 8000 }, (err, out) => {
        if (!err && out) {
          const m = /scrcpy\s+([\d.]+)/i.exec(String(out));
          verCache = m ? m[1] : String(out).trim().split(/\r?\n/)[0].slice(0, 40);
        }
        resolve(verCache);
      });
    });
  }

  // 系统里所有 scrcpy.exe 的 pid（含用户自己手动起的）
  function listProcs() {
    return new Promise((resolve) => {
      if (!IS_WIN) return resolve([]);
      execFile(
        'tasklist',
        ['/FI', 'IMAGENAME eq scrcpy.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 8000 },
        (err, out) => {
          if (err || !out) return resolve([]);
          const pids = String(out)
            .split(/\r?\n/)
            .map((l) => /^"scrcpy\.exe","(\d+)"/i.exec(l.trim()))
            .filter(Boolean)
            .map((m) => Number(m[1]));
          resolve(pids);
        }
      );
    });
  }

  async function status() {
    const procs = await listProcs();
    const ours = [];
    for (const [serial, v] of [...running.entries()]) {
      if (procs.includes(v.pid)) ours.push({ serial, pid: v.pid, at: v.at });
      else running.delete(serial);
    }
    const known = new Set(ours.map((o) => o.pid));
    const external = procs.filter((p) => !known.has(p));
    const b = bin();
    return {
      ok: true,
      exists: !!b,
      bin: b,
      version: await readVersion(b),
      isWin: IS_WIN,
      ours,
      external,
    };
  }

  function start(serial, opts) {
    const b = bin();
    if (!b) throw new Error('没找到 scrcpy.exe：解压到 D:\\install\\scrcpy-win64-v5.0.1，或设置环境变量 SCRCPY_BIN');
    if (!serial) throw new Error('没有选中的设备');
    const cur = running.get(serial);
    if (cur) return { ok: true, already: true, pid: cur.pid, serial };

    const args = ['-s', serial];
    const o = opts || {};
    if (o.noAudio) args.push('--no-audio');
    if (o.maxSize && Number(o.maxSize) >= 240) args.push('--max-size=' + Math.round(Number(o.maxSize)));
    if (o.stayAwake) args.push('--stay-awake');
    if (o.title) args.push('--window-title=' + String(o.title).slice(0, 60));

    // detached + CREATE_NO_WINDOW：不弹黑框控制台，但 SDL 的投屏窗口照常显示
    const proc = spawn(b, args, {
      cwd: path.dirname(b),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    proc.on('error', () => running.delete(serial));
    proc.on('exit', () => running.delete(serial));
    if (proc.pid) running.set(serial, { pid: proc.pid, at: Date.now(), proc });
    proc.unref();
    return { ok: true, pid: proc.pid || 0, serial, cmd: `${path.basename(b)} ${args.join(' ')}` };
  }

  function stopOne(pid) {
    if (!IS_WIN) {
      try {
        process.kill(pid);
      } catch (_) {}
      return;
    }
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  }

  function stop(serial) {
    const v = running.get(serial);
    if (!v) return { ok: true, stopped: false };
    stopOne(v.pid);
    running.delete(serial);
    return { ok: true, stopped: true, pid: v.pid, serial };
  }

  async function handle(action, ctx) {
    if (!isLoopback(ctx.req)) throw new Error('scrcpy 只能在本机上操作');
    const body = ctx.body || {};
    const serial = String(body.serial || ctx.q.get('serial') || '').trim();
    switch (action) {
      case 'scrcpy-status':
        return status();
      case 'scrcpy-start':
        return start(serial, body);
      case 'scrcpy-stop':
        return stop(serial);
      default:
        throw new Error('未知接口');
    }
  }

  return { handle, status };
}

module.exports = { createScrcpy };
// prize add by yanliang 20261102-end
