/**
 * core/json-shader.js —— JsonViewer 的键值着色器
 *
 * 要点：JsonViewer 只负责树结构与折叠，具体怎么给键名和值上色交给着色器。
 * 着色器签名统一为 (text, ctx) => Token[] | null，返回 null 或空数组即按纯文本渲染。
 *
 *   ctx = { slot: 'key' | 'value' | 'root' | 'suffix', key, depth, path }
 *
 * slot 为 'suffix' 时表示 JsonViewer 通过 keySplit 从键里拆出的尾段
 * （键名之后、值之前的那部分），着色规则与 'key' 相同。
 *
 * Token 形如 { text: '...', type: 'string' } 或 { text: '...', class: 'my-cls' }，
 * type 会展开成 qx-tok-<type>（与代码高亮共用一套色板），class 则原样落到 DOM 上。
 */
import { tokenize, canonicalLanguage } from './code-editor.js';
import { defineJsonShader } from './shader-registry.js';

export { defineJsonShader, getJsonShader, listJsonShaders } from './shader-registry.js';

// tokenize 的结果只依赖语言与原文，缓存起来避免折叠展开时重复分词
const tokCache = new Map();
const TOK_CACHE_MAX = 2000;

function cachedTokenize(text, lang) {
  const key = `${lang}\u0000${text}`;
  const hit = tokCache.get(key);
  if (hit) return hit;
  const toks = tokenize(text, lang);
  if (tokCache.size >= TOK_CACHE_MAX) tokCache.clear();
  tokCache.set(key, toks);
  return toks;
}

/** 规范化着色器返回值：只保留有文本的记号，type/class 二者必居其一 */
function normalizeTokens(toks) {
  if (!Array.isArray(toks) || !toks.length) return null;
  const out = [];
  for (const tk of toks) {
    if (!tk) continue;
    const text = tk.text == null ? '' : String(tk.text);
    if (!text) continue;
    if (tk.class) out.push({ text, class: String(tk.class) });
    else out.push({ text, type: tk.type ? String(tk.type) : 'text' });
  }
  return out.length ? out : null;
}

/**
 * 按语言语法给值上色（复用 core/code-editor.js 的语法表）
 *
 * @param {string} lang 语言名或别名，如 log / json / sh / ini
 * @param {{ keys?: boolean, values?: boolean }} [opts]
 *        keys 为真时键名也走同一套语法；values 默认为真
 * @returns {(text: string, ctx: object) => object[] | null}
 */
export function languageShader(lang, opts = {}) {
  const name = canonicalLanguage(lang);
  const colorKeys = opts.keys === true;
  const colorValues = opts.values !== false;
  return (text, ctx) => {
    const slot = ctx && ctx.slot;
    const isKey = slot === 'key' || slot === 'root';
    if (isKey ? !colorKeys : !colorValues) return null;
    return normalizeTokens(cachedTokenize(text, name));
  };
}

/**
 * 时刻标记着色器：把键名里的 @xxx 与 +xxx 分段染成两种颜色
 * 用于 systemd-analyze critical-chain 这类「单元名 @激活时刻 +自身耗时」的键
 *
 * 标记后必须紧跟数字才算命中：getty@tty1.service 这类模板实例名里的 @
 * 后面是字母，不会被误染成激活时刻
 *
 * @param {{ segments?: Array<{ test: RegExp | string, className?: string }> }} [opts]
 *        默认规则即 @ 段与 + 段；传 segments 可替换成自定义标记
 */
export function timingShader(opts = {}) {
  // systemd 的时间跨度可能是多段：@21.168s 但也会是 @1min 44.881s / @1h 2min 3.5s，
  // 所以每段是「数字开头的词」，段间允许空格，遇到 + 就停（+ 不属于 \w，天然截断）。
  const SPAN = String.raw`\d[\w.]*(?:\s+\d[\w.]*)*`;
  const rules = (opts.segments && opts.segments.length) ? opts.segments : [
    { test: new RegExp(String.raw`@\s*${SPAN}`), className: 'cmp-json-at' },
    { test: new RegExp(String.raw`\+\s*${SPAN}`), className: 'cmp-json-plus' },
  ];
  const compiled = rules.map((r) => ({
    re: r.test instanceof RegExp ? new RegExp(r.test.source, r.test.flags.replace(/[gy]/g, '') + 'g') : new RegExp(String(r.test), 'g'),
    className: r.className || 'cmp-json-accent',
  }));

  return (text, ctx) => {
    const slot = ctx && ctx.slot;
    // key / root 覆盖 critical-chain 原样的「单元名 @时刻 +耗时」整串键；
    // suffix 是 JsonViewer 用 keySplit 拆出的尾段；value 让同一套着色器也能直接
    // 用在普通字符串值上（fieldShader({ msg: timingShader() }) 这类按字段规则）
    if (slot !== 'key' && slot !== 'root' && slot !== 'suffix' && slot !== 'value') return null;
    const src = String(text);

    // 收集所有命中区间，按起点排序后顺序切片，重叠部分以前一条为准
    const hits = [];
    for (const r of compiled) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(src)) !== null) {
        if (!m[0]) { r.re.lastIndex += 1; continue; }
        hits.push({ start: m.index, end: m.index + m[0].length, className: r.className });
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.start - b.start || b.end - a.end);

    const out = [];
    let cursor = 0;
    for (const hit of hits) {
      if (hit.start < cursor) continue;
      if (hit.start > cursor) out.push({ text: src.slice(cursor, hit.start), type: 'text' });
      out.push({ text: src.slice(hit.start, hit.end), class: hit.className });
      cursor = hit.end;
    }
    if (cursor < src.length) out.push({ text: src.slice(cursor), type: 'text' });
    return normalizeTokens(out);
  };
}

/**
 * 组合多个着色器：按顺序问，第一个返回非空结果的胜出
 * 适合「先按标染时刻、剩余部分再按语言上色」这类叠加需求
 */
export function composeShaders(...fns) {
  const list = fns.filter((f) => typeof f === 'function');
  return (text, ctx) => {
    for (const f of list) {
      const toks = normalizeTokens(f(text, ctx));
      if (toks) return toks;
    }
    return null;
  };
}

/**
 * 按逐字段规则着色：rules 是「路径或键名 → 着色器」的表
 * 键支持精确键名、'*' 通配，以及以 '/' 结尾的路径前缀；
 * 命中的着色器返回空则继续试下一条，与 composeShaders 的语义一致
 *
 *   fieldShader({ ERROR: languageShader('log'), '/root/time/': timingShader() })
 */
export function fieldShader(rules) {
  const entries = Object.entries(rules || {}).filter(([, f]) => typeof f === 'function');
  return (text, ctx) => {
    const path = (ctx && ctx.path) || '';
    const key = ctx && ctx.key != null ? String(ctx.key) : '';
    for (const [pat, fn] of entries) {
      const hit = pat === '*' || pat === key || pat === path
        || (pat.endsWith('/') && path.startsWith(pat));
      if (!hit) continue;
      const toks = normalizeTokens(fn(text, ctx));
      if (toks) return toks;
    }
    return null;
  };
}

// 内置几套常用着色器，应用可直接按名引用
defineJsonShader('timing', timingShader());
defineJsonShader('log', languageShader('log'));
defineJsonShader('json', languageShader('json', { keys: true }));
defineJsonShader('sh', languageShader('sh'));
