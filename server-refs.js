/**
 * prize add by yanliang 20261027-start
 * 「查找引用」（谁在用它）的服务端部分。只支持 Java / Kotlin。
 *
 * 与 server-jump.js 相反，这是**反向**查询：给定符号，找出全仓库哪些地方用它。
 * 反向必须扫文件内容，成本由「文件数量 × 单文件读盘」决定，实测网络盘上约 1300 个文件/秒：
 *   - n06liquidglass（13 个 java）        5 ms
 *   - ALPS frameworks/base（1.86 万文件） 14 s
 *   - ALPS 全库（15 万文件）              120 s
 * 所以策略是「先局部、后台补全」：
 *   1. 先只扫当前文件所在模块（路径前两段）→ 几秒内出结果
 *   2. 同时在后台扫全库，扫完缓存 10 分钟，前端轮询取回
 *
 * 准确率靠一条 grep 命令解决，不额外读文件：把「目标符号」和「目标类的 import 行」一起 grep，
 * 然后按文件分组判断可信度：
 *   - 命中 import 行          → high（确定引用了这个类）
 *   - 文件目录 = 类的包目录   → high（同包引用，Java 不用写 import）
 *   - 只有裸名字命中          → medium（可能是同名不同类）
 */
'use strict';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const SYM_RE = /^[A-Za-z_$][\w$]*$/;

function escRe(s) {
  return String(s).replace(REGEX_SPECIAL, '\\$&');
}

// POSIX ERE 不认 \b，用显式的两侧边界字符
function wordPattern(sym) {
  return `(^|[^A-Za-z0-9_$])${escRe(sym)}([^A-Za-z0-9_$]|$)`;
}

function importPattern(cls) {
  return `^[[:space:]]*import[[:space:]].*\\.${escRe(cls)}([[:space:];]|$)`;
}

// 默认扫描范围：包目录的**父级**（含所有子目录）。
//   .../java/com/android/server/policy/AppOpsPolicy.java → .../java/com/android/server  （2030 文件，约 3.6s）
//   java/com/kyant/liquidglass/GlassButton.java          → java/com/kyant              （13 文件，瞬间）
// 不用「前两段」是因为 frameworks/base 在 ALPS 上有 1.8 万文件要 25 秒；
// 也不用整包，那样会把同父包下的兄弟包漏掉（policy 的类常被同级的 am/wm 引用）。
function nearScopeOf(rel, pkgDir) {
  const parts = String(rel || '').split('/').filter(Boolean);
  parts.pop(); // 去掉文件名，只留目录
  const segs = String(pkgDir || '').split('/').filter(Boolean);
  if (segs.length >= 2) {
    const at = indexOfSegs(parts, segs);
    if (at >= 0) return parts.slice(0, at + segs.length - 1).join('/');
  }
  // 包名拿不到（符号来自依赖库、或用全限定名引用）时，退到「当前文件目录的父级」，
  // 和上面的粒度对齐；直接取前两段会在 ALPS 上放大到 frameworks/base（1.8 万文件）
  if (parts.length >= 2) return parts.slice(0, parts.length - 1).join('/');
  return parts.join('/');
}

function indexOfSegs(parts, segs) {
  for (let i = 0; i + segs.length <= parts.length; i++) {
    let ok = true;
    for (let j = 0; j < segs.length; j++) {
      if (parts[i + j] !== segs[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function specsOf(scope) {
  return scope ? [`${scope}/*.java`, `${scope}/*.kt`] : ['*.java', '*.kt'];
}

function baseName(rel) {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  const name = i >= 0 ? s.slice(i + 1) : s;
  return name.replace(/\.(java|kts?)$/i, '');
}

function packageOf(text) {
  const m = /^[ \t]*package[ \t]+([\w.]+)/m.exec(String(text || ''));
  return m ? m[1] : '';
}

// 注释里的提及不算「调用」，单列一档，别让它淹没真实引用
function isComment(text) {
  const t = String(text || '').trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function isImportLine(text) {
  return /^[ \t]*import[ \t]/.test(String(text || ''));
}

const MAX_TEXT = 200;
// 同一个文件最多留几条。热门类（ActivityManager 这类）能命中 350 个文件、
// 1500 多处，全列出来没法看；每个文件留最实在的 2 条，扫文件列表就够了。
const PER_FILE = 2;

function createRefs(deps) {
  const { git, readFileText, safeRelPath, safeRev } = deps;

  const FULL_TTL = 10 * 60 * 1000;
  const FULL_MAX = 3;
  const FULL_LIMIT = 4000; // 全库结果最多留这么多条，防爆内存
  const LOCAL_LIMIT = 1500;
  const SHOW_LIMIT = 300; // 一次最多发这么多给前端

  const fullCache = new Map(); // key → { at, data }
  const running = new Map(); // key → Promise，同一个符号只扫一次

  async function readText(repo, rel, rev) {
    try {
      const d = await readFileText(repo, rel, rev);
      return d.binary ? '' : d.content || '';
    } catch (_) {
      if (!rev) return '';
      try {
        const d = await readFileText(repo, rel, 'HEAD');
        return d.binary ? '' : d.content || '';
      } catch (_) {
        return '';
      }
    }
  }

  function grep(repo, sym, cls, specs) {
    const args = ['grep', '-n', '-I', '--no-color', '-E', '-e', wordPattern(sym)];
    // 类名和符号不同时（查方法/字段），再把「谁 import 了这个类」一并抓回来，用于降噪
    if (cls && cls !== sym) args.push('-e', importPattern(cls));
    args.push('--', ...specs);
    return git(args, repo).catch(() => '');
  }

  /**
   * 把 grep 的原始输出变成分类好的条目。
   * 一趟 grep 同时拿到「名字命中」和「import 命中」，按文件聚合后判断可信度，
   * 这样不需要为了看 import 再逐个读文件（那会把耗时翻倍）。
   */
  function classify(raw, ctx) {
    const { defPath, cls, pkgDir, sym } = ctx;
    const byFile = new Map();

    for (const line of String(raw || '').split('\n')) {
      if (!line) continue;
      const m = /^(.+?):(\d+):([\s\S]*)$/.exec(line);
      if (!m) continue;
      const p = m[1];
      const ln = Number(m[2]);
      const text = m[3];
      let f = byFile.get(p);
      if (!f) {
        f = { path: p, hasImport: false, hits: [] };
        byFile.set(p, f);
      }
      const isImport = /^[ \t]*import[ \t]/.test(text) && cls && new RegExp('\\.' + escRe(cls) + '([\\s;]|$)').test(text);
      if (isImport) f.hasImport = true;
      f.hits.push({ line: ln, text: text.trim().slice(0, MAX_TEXT) });
    }

    const items = [];
    let occurrences = 0;
    let truncatedFiles = false;
    for (const f of byFile.values()) {
      // 同包判断不能用全等：路径前面还挂着 java/ 这类源根，只能比后缀
      const d = dirOf(f.path);
      const samePackage = !!pkgDir && (d === pkgDir || d.endsWith('/' + pkgDir));
      const certainty = f.hasImport || samePackage ? 'high' : 'medium';
      const kind = f.hasImport ? 'import' : samePackage ? 'same-package' : 'name';

      // 定义行要排掉（用已知行号，别用正则猜；猜会误杀 `= DEFAULT_DEPTH;` 这种真的引用）
      const live = f.hits.filter(
        (h) => !(f.path === defPath && ctx.defLines && ctx.defLines.has(h.line))
      );
      occurrences += live.length;
      if (!live.length) continue;

      // import 行只是「这个文件引用了它」，真正干活的在后面的使用行。
      // 有使用行就优先给使用行，否则才退回 import 行。
      const real = live.filter((h) => !isImportLine(h.text) && !isComment(h.text));
      const chosen = (real.length ? real : live).slice(0, PER_FILE);
      if (live.length > chosen.length) truncatedFiles = true;

      for (const h of chosen) {
        // 种类按「这一行」判，不按文件判：文件有 import 但我们展示的是使用行时，
        // 标成 import 会让人以为它只是导入了没用
        const lineKind = isImportLine(h.text) ? 'import' : isComment(h.text) ? 'comment' : samePackage ? 'same-package' : 'name';
        items.push({
          path: f.path,
          line: h.line,
          text: h.text,
          kind: lineKind,
          certainty: isComment(h.text) ? 'low' : certainty,
        });
        if (items.length >= ctx.limit) break;
      }
      if (items.length >= ctx.limit) break;
    }

    // 可信度优先，其次种类，最后按路径聚在一起（同一个文件的多条要相邻，
    // 否则扫列表时会出现 am/X.java → SystemConfig.java → am/X.java 的跳跃感）
    const rankC = { high: 0, medium: 1, low: 2 };
    const rank = { 'same-package': 0, import: 1, name: 2, comment: 3 };
    items.sort(
      (a, b) =>
        rankC[a.certainty] - rankC[b.certainty] ||
        rank[a.kind] - rank[b.kind] ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.line - b.line
    );
    return { items, occurrences, truncatedFiles };
  }

  function dirOf(p) {
    const i = String(p || '').lastIndexOf('/');
    return i > 0 ? p.slice(0, i) : '';
  }

  function summarize(items) {
    const n = (k) => items.filter((it) => it.kind === k).length;
    return {
      total: items.length,
      files: new Set(items.map((it) => it.path)).size,
      import: n('import'),
      samePackage: n('same-package'),
      nameOnly: n('name'),
      comment: n('comment'),
    };
  }

  // pack = classify() 的结果（items / occurrences / truncatedFiles）
  function slice(pack) {
    const items = pack.items;
    const sum = summarize(items);
    return {
      items: items.slice(0, SHOW_LIMIT),
      total: items.length,
      files: sum.files,
      // 原始命中行数（同一文件可能有多处），用来告诉用户「文件 N 个、引用 M 处」
      occurrences: pack.occurrences,
      truncated: items.length > SHOW_LIMIT || !!pack.truncatedFiles,
      summary: sum,
    };
  }

  function fullKey(repo, rev, sym) {
    return `${repo}\n${rev}\n${sym}`;
  }

  function evictFull() {
    while (fullCache.size > FULL_MAX) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of fullCache) {
        if (v.at < oldest) {
          oldest = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey == null) break;
      fullCache.delete(oldestKey);
    }
  }

  /**
   * 后台扫全库。真正耗时的那一步，绝不阻塞首次响应。
   * 同一个符号只允许一个扫描在跑（并发扫大仓库会把磁盘 IO 打满）。
   */
  function startFull(repo, rev, sym, ctx) {
    const key = fullKey(repo, rev, sym);
    if (running.has(key)) return;
    const p = (async () => {
      const raw = await grep(repo, sym, ctx.cls, specsOf(''));
      const pack = classify(raw, { ...ctx, limit: FULL_LIMIT });
      fullCache.set(key, { at: Date.now(), data: slice(pack) });
      evictFull();
    })().catch(() => {
      // 扫失败也写一条空结果，避免前端无限轮询
      fullCache.set(key, { at: Date.now(), data: slice({ items: [], occurrences: 0 }) });
    });
    running.set(key, p);
    p.finally(() => running.delete(key));
  }

  return async function refs(repo, body) {
    const rel = safeRelPath(body.path);
    const rev = safeRev(body.rev) || 'worktree';
    const sym = String(body.sym || '').trim();

    if (!SYM_RE.test(sym)) return { state: 'bad-symbol', sym, items: [] };

    // 轮询只查缓存，不重跑局部 grep：大仓库一次局部扫描要十几秒，不能每秒重复一次
    if (body.pollOnly) {
      const key = fullKey(repo, rev, sym);
      const hit = fullCache.get(key);
      if (hit && Date.now() - hit.at < FULL_TTL) {
        return { state: 'ok', sym, pollOnly: true, full: { state: 'done', ...hit.data } };
      }
      return { state: 'ok', sym, pollOnly: true, full: { state: running.has(key) ? 'building' : 'idle' } };
    }

    if (!/\.(java|kts?)$/i.test(rel)) return { state: 'unsupported', sym, items: [] };

    // 定义位置：决定「哪个类的成员」和「包目录」，import 过滤全靠它
    let defPath = '';
    let defLine = 0;
    let pkg = '';
    const defLines = new Set();
    try {
      const j = await deps.jumpTo(repo, { path: rel, rev, sym });
      const items = j.items || [];
      const first = items[0];
      if (first) {
        defPath = first.path;
        defLine = first.line || 1;
        // 重载方法在这个文件里可能有多处定义，全部按「定义」排掉
        for (const it of items) if (it.path === defPath) defLines.add(it.line);
      }
    } catch (_) {
      /* 跳转失败不影响找引用，只是过滤能力弱一点 */
    }
    // 找不到定义（符号来自依赖库）时，只能假设这个符号本身就是类名，
    // 这样 import 过滤仍能生效（查 Bitmap 时能认出 import android.graphics.Bitmap）
    const cls = defPath ? baseName(defPath) : sym;
    if (defPath) pkg = packageOf(await readText(repo, defPath, rev));
    const pkgDir = pkg ? pkg.replace(/\./g, '/') : '';

    // 范围要围绕「定义所在位置」算，不是「你正在看的文件」：
    // 在 AppOpsPolicy 里查 ActivityManager，兄弟包应该在 frameworks/base/core/java/android 下找
    const scopeBase = defPath || rel;
    const scope = nearScopeOf(scopeBase, pkgDir);
    const ctx = { defPath, cls, pkgDir, sym, defLines };

    // 1) 局部（包目录父级）：几秒内出结果。onlyFull 表示用户只切了 tab，别重复扫一遍
    let local = null;
    if (!body.onlyFull) {
      const rawLocal = await grep(repo, sym, cls, specsOf(scope));
      local = slice(classify(rawLocal, { ...ctx, limit: LOCAL_LIMIT }));
    }

    // 2) 全库：**按需启动**。默认只给缓存，用户点「全仓库」那一档才真去扫，
    //    避免每次查引用都白跑一趟 2 分钟的全库扫描，跟后面的查询抢磁盘 IO
    const key = fullKey(repo, rev, sym);
    const cached = fullCache.get(key);
    const fresh = cached && Date.now() - cached.at < FULL_TTL;
    let full;
    if (!scope) {
      // 范围已经退化到仓库根，局部就是全库
      full = { state: 'done', ...(local || (cached && cached.data) || slice({ items: [], occurrences: 0 })) };
    } else if (fresh) {
      full = { state: 'done', ...cached.data };
    } else if (body.wantFull || body.onlyFull) {
      startFull(repo, rev, sym, ctx);
      full = { state: 'building' };
    } else {
      full = { state: 'lazy' };
    }

    const base = local || { items: [], total: 0, files: 0, truncated: false, summary: summarize([]) };
    return {
      state: 'ok',
      sym,
      from: rel,
      scope: scope || '全仓库',
      defPath,
      defLine,
      cls,
      pkg,
      ...base,
      full,
    };
  };
}

module.exports = { createRefs, nearScopeOf, wordPattern, importPattern };
// prize add by yanliang 20261027-end
