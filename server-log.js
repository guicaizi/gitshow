/**
 * prize add by yanliang 20261102-start
 * 实时日志（logcat）会话管理：只在本机（loopback）可用。
 *
 * 模型：同一时间只允许一个采集会话。启动时先捞一小段历史（可关），
 * 再用 -T <最后一行的设备时间> 续上，避免把整块 buffer 重复灌一遍。
 * 行存在内存环形缓冲里，前端按 seq 增量拉取，断开重连不丢内容。
 */
'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_LINES = 40000; // 服务端保留的最大行数，超过从头部丢
const MAX_POLL = 3000; // 单次 poll 最多返回的行数
const MAX_SEED = 3000;
const ALLOWED_BUFFERS = new Set(['main', 'system', 'crash', 'events', 'kernel', 'radio']);
const TS_RE = /^\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d\d\d/;

function execAdb(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeout || 20000 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          out: String(stdout || ''),
          err: String(stderr || ''),
          timeout: !!(err && err.killed),
        });
      }
    );
  });
}

function safeSerial(s) {
  const v = String(s || '').trim();
  if (!/^[A-Za-z0-9_.:\-]+$/.test(v)) throw new Error('设备序列号不合法');
  return v;
}

function createLog(deps) {
  const isLoopback = (deps && deps.isLoopback) || (() => true);
  const ensureAdb = (deps && deps.ensureAdb) || (async () => 'adb');
  // 收藏的过滤条件落盘在这里，和 adb 配对一样放 .gdv
  const dataDir = path.join((deps && deps.rootDir) || __dirname, '.gdv');
  const favFile = path.join(dataDir, 'log-favs.json');
  const FAV_GROUP = '未分类';
  const MAX_FAVS = 200;

  let cur = null; // 当前会话
  let killing = false;

  /* ---------------- 过滤条件收藏 ---------------- */

  function favLevels(v) {
    const list = (Array.isArray(v) ? v : []).map((x) => String(x).toUpperCase()).filter((x) => /^[VDIWEF]$/.test(x));
    return list.length ? list : ['D', 'I', 'W', 'E', 'F'];
  }

  function favBuffers(v) {
    const list = (Array.isArray(v) ? v : []).map((x) => String(x).toLowerCase()).filter((b) => ALLOWED_BUFFERS.has(b));
    return list.length ? list : ['main', 'system', 'crash'];
  }

  function normFilter(f) {
    const o = f && typeof f === 'object' ? f : {};
    return {
      levels: favLevels(o.levels),
      tag: String(o.tag || '').slice(0, 120),
      kw: String(o.kw || '').slice(0, 120),
      errOnly: !!o.errOnly,
      buffers: favBuffers(o.buffers),
      seed: Math.max(0, Math.min(Number(o.seed) || 0, MAX_SEED)),
    };
  }

  function readFavs() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(favFile, 'utf8'));
    } catch (_) {
      raw = null;
    }
    const groups = [];
    const seen = new Set();
    const gsrc = raw && Array.isArray(raw.groups) ? raw.groups : [];
    gsrc.forEach((g, i) => {
      if (!g || !g.name) return;
      const id = String(g.id || 'g' + (i + 1));
      if (seen.has(id)) return;
      seen.add(id);
      groups.push({ id, name: String(g.name).slice(0, 24) });
    });
    if (!groups.length) groups.push({ id: 'g0', name: FAV_GROUP });
    const firstGid = groups[0].id;

    const items = [];
    const isrc = raw && Array.isArray(raw.items) ? raw.items : [];
    isrc.forEach((it, i) => {
      if (!it || !it.name || !it.filter) return;
      items.push({
        id: String(it.id || 'f' + (i + 1)),
        name: String(it.name).slice(0, 40),
        group: seen.has(String(it.group)) ? String(it.group) : firstGid,
        filter: normFilter(it.filter),
        at: Number(it.at) || 0,
      });
    });
    return { groups, items: items.slice(0, MAX_FAVS) };
  }

  function writeFavs(data) {
    const clean = {
      groups: (data.groups || []).map((g) => ({ id: String(g.id), name: String(g.name).slice(0, 24) })),
      items: (data.items || []).slice(0, MAX_FAVS).map((it) => ({
        id: String(it.id),
        name: String(it.name).slice(0, 40),
        group: String(it.group),
        filter: normFilter(it.filter),
        at: Number(it.at) || Date.now(),
      })),
    };
    fs.mkdirSync(dataDir, { recursive: true });
    // 先写临时文件再改名，避免写一半被读到半截 JSON
    const tmp = favFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(tmp, favFile);
    return clean;
  }

  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function favSave(body) {
    const data = readFavs();
    const filter = normFilter(body.filter);
    let groupId = String(body.group || '').trim();
    const groupName = String(body.groupName || '').trim().slice(0, 24);

    if (groupName) {
      const hit = data.groups.find((g) => g.name === groupName);
      if (hit) groupId = hit.id;
      else {
        const g = { id: newId('g'), name: groupName };
        data.groups.push(g);
        groupId = g.id;
      }
    }
    if (!data.groups.some((g) => g.id === groupId)) groupId = data.groups[0].id;

    const name = String(body.name || '').trim().slice(0, 40) || fallbackName(filter);
    const id = String(body.id || '').trim();
    const exist = id ? data.items.find((it) => it.id === id) : null;
    let item;
    if (exist) {
      exist.name = name;
      exist.group = groupId;
      exist.filter = filter;
      exist.at = Date.now();
      item = exist;
    } else {
      item = { id: newId('f'), name, group: groupId, filter, at: Date.now() };
      data.items.unshift(item);
    }
    const saved = writeFavs(data);
    return { ok: true, item, groups: saved.groups, items: saved.items };
  }

  function fallbackName(f) {
    const bits = [];
    if (f.tag) bits.push(f.tag);
    if (f.kw) bits.push(f.kw.split(/\s+/).slice(0, 2).join(' '));
    if (f.errOnly) bits.push('异常');
    const lv = f.levels.join('');
    if (lv !== 'DIWEF') bits.push('≥' + lv[0]);
    return (bits.join(' · ') || '全部日志').slice(0, 40);
  }

  function favDel(id) {
    const data = readFavs();
    data.items = data.items.filter((it) => it.id !== String(id));
    return Object.assign({ ok: true }, stripAt(writeFavs(data)));
  }

  function groupAdd(name) {
    const nm = String(name || '').trim().slice(0, 24);
    if (!nm) throw new Error('分类名不能为空');
    const data = readFavs();
    const hit = data.groups.find((g) => g.name === nm);
    if (hit) return Object.assign({ ok: true, group: hit }, stripAt(data));
    const g = { id: newId('g'), name: nm };
    data.groups.push(g);
    return Object.assign({ ok: true, group: g }, stripAt(writeFavs(data)));
  }

  function groupRename(id, name) {
    const nm = String(name || '').trim().slice(0, 24);
    if (!nm) throw new Error('分类名不能为空');
    const data = readFavs();
    const g = data.groups.find((x) => x.id === String(id));
    if (!g) throw new Error('分类不存在');
    g.name = nm;
    return Object.assign({ ok: true }, stripAt(writeFavs(data)));
  }

  function groupDel(id) {
    const data = readFavs();
    const gid = String(id);
    if (!data.groups.some((g) => g.id === gid)) return Object.assign({ ok: true }, stripAt(data));
    if (data.groups.length <= 1) throw new Error('至少要留一个分类');
    const keep = data.groups.find((g) => g.id !== gid);
    data.groups = data.groups.filter((g) => g.id !== gid);
    // 分类删了，里面的收藏不跟着删，挪到第一个分类
    data.items.forEach((it) => {
      if (it.group === gid) it.group = keep.id;
    });
    return Object.assign({ ok: true }, stripAt(writeFavs(data)));
  }

  function stripAt(d) {
    return { groups: d.groups, items: d.items };
  }

  function favHandle(action, body) {
    switch (action) {
      case 'log-fav-list': {
        const d = readFavs();
        return Object.assign({ ok: true }, stripAt(d));
      }
      case 'log-fav-save':
        return favSave(body);
      case 'log-fav-del':
        return favDel(body.id);
      case 'log-group-add':
        return groupAdd(body.name);
      case 'log-group-rename':
        return groupRename(body.id, body.name);
      case 'log-group-del':
        return groupDel(body.id);
      default:
        throw new Error('未知接口');
    }
  }

  function newSession(serial, buffers, pkg, pid) {
    return {
      serial,
      buffers,
      pkg: pkg || '',
      pid: pid || 0,
      lines: [],
      firstSeq: 1,
      nextSeq: 1,
      dropped: 0,
      seeded: 0,
      startedAt: Date.now(),
      endedAt: 0,
      running: false,
      error: '',
      proc: null,
      cmd: '',
    };
  }

  function push(s, text) {
    const arr = s.lines;
    arr.push(text);
    s.nextSeq += 1;
    if (arr.length > MAX_LINES) {
      const drop = arr.length - MAX_LINES;
      arr.splice(0, drop);
      s.firstSeq += drop;
      s.dropped += drop;
    }
  }

  // 逐行切：adb 在 Windows 上吐 \r\n，跨 chunk 的半行要留到下一次
  function lineReader(onLine) {
    let buf = '';
    return (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buf = buf.slice(i + 1);
        onLine(line);
      }
      if (buf.length > 256 * 1024) {
        // 单行超过 256KB 基本是异常数据，直接切出去免得内存涨
        onLine(buf);
        buf = '';
      }
    };
  }

  function stopProc(s) {
    const p = s && s.proc;
    if (!p || !p.pid) return;
    try {
      if (process.platform === 'win32') {
        // adb 在 Windows 上是 adb.exe，/T 连子进程一起收
        spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
      } else {
        p.kill('SIGKILL');
      }
    } catch (_) {}
  }

  async function deviceNow(bin, serial) {
    const r = await execAdb(bin, ['-s', serial, 'shell', "date '+%m-%d %H:%M:%S'"], 8000);
    const m = /(\d\d-\d\d)\s+(\d\d:\d\d:\d\d)/.exec(r.out);
    return m ? `${m[1]} ${m[2]}.000` : '';
  }

  async function resolvePid(bin, serial, pkg) {
    const r = await execAdb(bin, ['-s', serial, 'shell', 'pidof', pkg], 8000);
    const m = /(\d+)/.exec(r.out);
    return m ? Number(m[1]) : 0;
  }

  async function start(opts) {
    const serial = safeSerial(opts.serial);
    const buffers = (Array.isArray(opts.buffers) ? opts.buffers : ['main', 'system', 'crash'])
      .map((b) => String(b).toLowerCase().trim())
      .filter((b) => ALLOWED_BUFFERS.has(b));
    const bufList = buffers.length ? buffers : ['main', 'system', 'crash'];
    const seed = Math.max(0, Math.min(Number(opts.seed) || 0, MAX_SEED));
    const pkg = String(opts.pkg || '').trim();
    if (pkg && !/^[A-Za-z0-9_.]+$/.test(pkg)) throw new Error('包名不合法：' + pkg);

    if (cur && cur.running) stop();

    const bin = await ensureAdb();
    let pid = 0;
    let warning = '';
    if (pkg) {
      pid = await resolvePid(bin, serial, pkg);
      if (!pid) warning = `没找到进程 ${pkg} 的 pid，本次不按进程过滤（应用没启动或包名写错）`;
    }

    const s = newSession(serial, bufList, pkg, pid);

    // 1) 先捞一小段历史，既能给上下文，也拿到用来续接的时间点
    let from = '';
    if (seed > 0) {
      const r = await execAdb(
        bin,
        ['-s', serial, 'logcat', '-v', 'threadtime', '-b', bufList.join(','), '-d', '-t', String(seed)],
        20000
      );
      if (r.out) {
        r.out.split(/\r?\n/).forEach((line) => {
          if (!line || /^-+ beginning of/.test(line)) return;
          push(s, line);
          s.seeded += 1;
        });
      }
      const seedLines = r.out.split(/\r?\n/).filter(Boolean);
      for (let i = seedLines.length - 1; i >= 0; i--) {
        const head = seedLines[i].slice(0, 18);
        if (TS_RE.test(head)) {
          from = head;
          break;
        }
      }
    }
    if (!from) from = await deviceNow(bin, serial);

    // 2) 从那个时间点开始追，避免整块 buffer 重放
    const args = ['-s', serial, 'logcat', '-v', 'threadtime', '-b', bufList.join(',')];
    if (from) args.push('-T', from);
    if (pid) args.push('--pid', String(pid));

    const proc = spawn(bin, args, { windowsHide: true });
    s.proc = proc;
    s.running = true;
    s.cmd = `adb ${args.join(' ')}`;
    cur = s;

    // 续接点附近的重复行：用最近若干行的原文做一次去重
    const tail = new Map();
    s.lines.slice(-60).forEach((l) => tail.set(l, (tail.get(l) || 0) + 1));
    const read = lineReader((line) => {
      if (killing) return;
      if (!line) return;
      if (/^-+ beginning of/.test(line)) return;
      const hit = tail.get(line);
      if (hit) {
        // 只吃掉种子那一份，后面对内容相同的真实日志不再误删
        if (hit <= 1) tail.delete(line);
        else tail.set(line, hit - 1);
        return;
      }
      push(s, line);
    });
    proc.stdout.on('data', read);
    let errBuf = '';
    proc.stderr.on('data', (c) => {
      errBuf = (errBuf + c.toString('utf8')).slice(-2000);
    });
    proc.on('error', (err) => {
      s.running = false;
      s.endedAt = Date.now();
      s.error = err && err.message ? err.message : '启动 logcat 失败';
    });
    proc.on('exit', (code) => {
      s.running = false;
      s.endedAt = Date.now();
      if (!killing) {
        const clean = errBuf.trim().split(/\r?\n/).filter(Boolean).slice(-4).join('\n');
        if (clean) s.error = clean;
        else if (code) s.error = `logcat 退出，code=${code}`;
      }
      killing = false;
    });

    return {
      ok: true,
      warning,
      session: summary(s),
      from,
    };
  }

  function summary(s) {
    return {
      running: !!(s && s.running),
      serial: s ? s.serial : '',
      seq: s ? s.nextSeq - 1 : 0,
      firstSeq: s ? s.firstSeq : 0,
      count: s ? s.lines.length : 0,
      dropped: s ? s.dropped : 0,
      seeded: s ? s.seeded : 0,
      pid: s ? s.pid : 0,
      pkg: s ? s.pkg : '',
      buffers: s ? s.buffers : [],
      startedAt: s ? s.startedAt : 0,
      endedAt: s ? s.endedAt : 0,
      error: s ? s.error : '',
      cmd: s ? s.cmd : '',
    };
  }

  function stop() {
    const s = cur;
    if (!s) return { ok: true, stopped: false };
    killing = true;
    stopProc(s);
    s.running = false;
    s.endedAt = Date.now();
    s.proc = null;
    return { ok: true, stopped: true, session: summary(s) };
  }

  function poll(cursor, limit) {
    const s = cur;
    if (!s) return { ok: true, running: false, seq: 0, lines: [], count: 0 };
    const n = Math.max(1, Math.min(Number(limit) || MAX_POLL, MAX_POLL));
    let cur0 = Number(cursor) || 0;
    let truncated = false;
    if (cur0 < s.firstSeq - 1) {
      // 客户端落后太多（服务端已经丢过头部），从现存最早的一行重来
      cur0 = s.firstSeq - 1;
      truncated = true;
    }
    const startIdx = Math.max(0, cur0 - s.firstSeq + 1);
    const slice = s.lines.slice(startIdx, startIdx + n);
    const lastSeq = slice.length ? s.firstSeq + startIdx + slice.length - 1 : cur0;
    return {
      ok: true,
      running: s.running,
      serial: s.serial,
      seq: s.nextSeq - 1,
      cursor: lastSeq,
      firstSeq: s.firstSeq,
      count: s.lines.length,
      dropped: s.dropped,
      more: startIdx + slice.length < s.lines.length,
      truncated,
      lines: slice,
      error: s.error,
    };
  }

  function clear() {
    if (!cur) return { ok: true };
    cur.lines = [];
    cur.firstSeq = cur.nextSeq;
    return { ok: true, session: summary(cur) };
  }

  async function handle(action, ctx) {
    if (!isLoopback(ctx.req)) throw new Error('实时日志只能在本机上操作');
    const body = ctx.body || {};
    const q = ctx.q;
    switch (action) {
      case 'log-start':
        return start(body);
      case 'log-stop':
        return stop();
      case 'log-clear':
        return clear();
      case 'log-status':
        return { ok: true, session: summary(cur) };
      case 'log-poll':
        return poll(q.get('cursor'), q.get('limit'));
      case 'log-fav-list':
      case 'log-fav-save':
      case 'log-fav-del':
      case 'log-group-add':
      case 'log-group-rename':
      case 'log-group-del':
        return favHandle(action, body);
      default:
        throw new Error('未知接口');
    }
  }

  return { handle, summary: () => summary(cur), stop };
}

module.exports = { createLog };
// prize add by yanliang 20261102-end
