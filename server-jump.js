/**
 * prize add by yanliang 20261026-start
 * 源码跳转（Ctrl+Click 找定义）的服务端部分。只支持 Java / Kotlin。
 *
 * 核心思路：**不建全局符号索引**。
 *   1. 同文件定义：正则逐行扫，读一个文件就够
 *   2. 跨文件：Java/Kotlin 的 import 是「包名 → 目录」的确定映射，
 *      用 git ls-files 按需查路径（走 git 自己的 index 文件，百万文件量级也只是百毫秒）
 *   3. Java 同包类不用写 import，单独补一次「同目录找同名文件」
 *
 * 好处是零额外内存、零索引等待，ALPS 那种 147 万文件的仓库点一下也是秒回；
 * 代价是只能跳「定义」，做不了类型精确（obj.method() 会给候选让你选），也做不了找引用。
 */
'use strict';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const SYM_RE = /^[A-Za-z_$][\w$]*$/;

function escRe(s) {
  return String(s).replace(REGEX_SPECIAL, '\\$&');
}

function langOf(rel) {
  const p = String(rel || '').toLowerCase();
  if (p.endsWith('.java')) return 'java';
  if (p.endsWith('.kt') || p.endsWith('.kts')) return 'kotlin';
  return '';
}

// 以这些词开头的行是语句而不是定义（`return foo(Sym)` 会被方法正则误判成定义）
const NOT_A_DEF = /^(?:return|new|throw|else|case|yield|assert|package|import|if|for|while|switch|catch|synchronized\s*\()\b/;

/**
 * 在一个文件的各行里找 sym 的定义。
 * 命中可能有多处（重载方法、内部类里的同名字段），由调用方决定取哪个。
 */
function findDefinitions(lines, sym, lang) {
  const s = escRe(sym);
  const kt = lang === 'kotlin';
  const reType = new RegExp(`\\b(?:class|interface|enum|record|object|@interface)\\s+${s}\\b`);
  const reKtFun = new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?${s}\\s*[(<]`);
  const reMethod = new RegExp(
    '^\\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\\s+)*' +
      `[\\w$<>\\[\\],.?\\s]{0,100}?\\b${s}\\s*\\(`
  );
  const reField = new RegExp(
    '^\\s*(?:(?:public|private|protected|static|final|transient|volatile)\\s+)*' +
      `[A-Za-z_$][\\w$.<>\\[\\],?]*\\s+${s}\\s*[;=]`
  );
  const reKtProp = new RegExp(`\\b(?:val|var)\\s+${s}\\b`);

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // 绝大多数行不含目标词，先做便宜的判断，别对每行跑四个正则
    if (!raw || raw.indexOf(sym) < 0) continue;
    const t = raw.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (!reType.test(raw) && NOT_A_DEF.test(t)) continue;

    let kind = '';
    if (reType.test(raw)) kind = 'type';
    else if (kt ? reKtFun.test(raw) : reMethod.test(raw)) kind = 'method';
    else if (kt ? reKtProp.test(raw) : reField.test(raw)) kind = 'field';
    if (kind) out.push({ line: i + 1, kind });
  }
  return out;
}

// 只扫文件头部：import 都集中在前面，没必要扫完几 MB
const IMPORT_SCAN_LINES = 800;

function parseImports(lines) {
  const out = [];
  const limit = Math.min(lines.length, IMPORT_SCAN_LINES);
  for (let i = 0; i < limit; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('import')) continue;

    // Java: import [static] a.b.C[.*];
    let m = /^import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;(?:\s*\/\/.*)?$/.exec(t);
    if (m) {
      out.push({ fqn: m[2], wildcard: !!m[3], isStatic: !!m[1], alias: '' });
      if (out.length >= 400) break;
      continue;
    }
    // Kotlin: import a.b.C[.*] [as Alias]
    m = /^import\s+([\w.]+?)(\.\*)?(?:\s+as\s+(\w+))?(?:\s*\/\/.*)?$/.exec(t);
    if (m) {
      out.push({ fqn: m[1], wildcard: !!m[2], isStatic: false, alias: m[3] || '' });
      if (out.length >= 400) break;
    }
  }
  return out;
}

// 用 -z 取，路径里带空格也不会被拆坏
function splitZ(text) {
  return String(text || '')
    .split('\0')
    .map((s) => s.replace(/\r?\n$/, ''))
    .filter(Boolean);
}

function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const key = `${it.path}\n${it.line}`;
    const prev = seen.get(key);
    // 同一位置被多规则命中时，保留分数更低的（更可信的那条）
    if (!prev || it.score < prev.score) seen.set(key, it);
  }
  return [...seen.values()].sort((a, b) => a.score - b.score || a.path.length - b.path.length);
}

function createJump(deps) {
  const { git, readFileText, safeRelPath, safeRev } = deps;

  // 工作区文件可能被删（树来自 HEAD），读不到就退回 HEAD 的版本，别让跳转直接失败
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

  async function lsPaths(repo, specs) {
    if (!specs.length) return [];
    try {
      return splitZ(await git(['ls-files', '-z', '--', ...specs], repo));
    } catch (_) {
      return [];
    }
  }

  return async function jump(repo, body) {
    const rel = safeRelPath(body.path);
    const rev = safeRev(body.rev) || 'worktree';
    const sym = String(body.sym || '').trim();

    if (!SYM_RE.test(sym)) return { state: 'bad-symbol', sym, items: [] };
    const lang = langOf(rel);
    // 只做 Java / Kotlin：别的语言没有包名到目录的确定映射，硬猜只会误导
    if (!lang) return { state: 'unsupported', sym, items: [] };

    const text = await readText(repo, rel, rev);
    if (!text) return { state: 'ok', sym, items: [], from: rel };
    const lines = text.replace(/\r\n?/g, '\n').split('\n');

    // 1) 同文件命中就直接用：IDE 也是先看当前作用域，省掉后面的跨文件查询
    const local = findDefinitions(lines, sym, lang);
    if (local.length) {
      return {
        state: 'ok',
        sym,
        from: rel,
        scope: 'local',
        items: local.slice(0, 10).map((d) => ({ path: rel, line: d.line, kind: d.kind, score: 0, label: '当前文件' })),
      };
    }

    // 2) 跨文件：把可能的目标文件路径拼成 git pathspec，一次全部查掉
    const imports = parseImports(lines);
    const specs = [];
    const plan = []; // 与 specs 一一对应的打分/来源信息
    const addSpec = (spec, tail, score, label) => {
      if (specs.length >= 40) return;
      specs.push(spec);
      plan.push({ tail, score, label });
    };

    for (const imp of imports) {
      if (imp.wildcard) {
        // import a.b.c.* → 到 a/b/c 下找同名文件
        const base = imp.fqn.replace(/\./g, '/');
        addSpec(`*${base}/${sym}.java`, `${base}/${sym}.java`, 30, `import ${imp.fqn}.*`);
        addSpec(`*${base}/${sym}.kt`, `${base}/${sym}.kt`, 30, `import ${imp.fqn}.*`);
        continue;
      }
      const parts = imp.fqn.split('.');
      const name = imp.alias || parts[parts.length - 1];
      if (name !== sym) continue;
      // import static a.b.C.member → 要跳的类是 C，不是 member
      const cls = imp.isStatic ? parts.slice(0, -1).join('.') : imp.fqn;
      const base = cls.replace(/\./g, '/');
      addSpec(`*${base}.java`, `${base}.java`, 10, `import ${imp.fqn}`);
      addSpec(`*${base}.kt`, `${base}.kt`, 10, `import ${imp.fqn}`);
    }

    // 3) Java 同包类不用 import，直接去当前目录找
    const slash = rel.lastIndexOf('/');
    const dir = slash > 0 ? rel.slice(0, slash) : '';
    if (dir) {
      addSpec(`${dir}/${sym}.java`, `${dir}/${sym}.java`, 20, '同包');
      addSpec(`${dir}/${sym}.kt`, `${dir}/${sym}.kt`, 20, '同包');
    }

    const hits = [];
    if (specs.length) {
      for (const p of await lsPaths(repo, specs)) {
        // pathspec 里 `*` 可跨目录，靠后缀反推是哪个规则命中的
        let best = null;
        for (const pl of plan) {
          if (p.endsWith('/' + pl.tail) || p === pl.tail) {
            if (!best || pl.score < best.score) best = pl;
          }
        }
        if (best) hits.push({ path: p, score: best.score, label: best.label });
      }
    }

    // 4) 给命中的文件补上行号：跳「类」要落到 class 那行，不能总是第 1 行
    const uniq = dedupe(hits.map((h) => ({ ...h, line: 1 })));
    const items = [];
    for (const h of uniq.slice(0, 8)) {
      let line = 1;
      let kind = 'type';
      const t = await readText(repo, h.path, rev);
      if (t) {
        const defs = findDefinitions(t.replace(/\r\n?/g, '\n').split('\n'), sym, langOf(h.path) || lang);
        if (defs.length) {
          line = defs[0].line;
          kind = defs[0].kind;
        }
      }
      items.push({ path: h.path, line, kind, score: h.score, label: h.label });
    }

    return { state: 'ok', sym, from: rel, scope: 'import', items };
  };
}

module.exports = { createJump, findDefinitions, parseImports, langOf };
// prize add by yanliang 20261026-end
