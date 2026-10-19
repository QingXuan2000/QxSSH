/**
 * core/code-editor.js —— 代码高亮与代码编辑框
 * 要点：内置 sh/yaml/json/sql/nginx/js/go 等语法规则，提供分词、高亮渲染，以及带行号与自动缩进的编辑框组件。
 */
import { h, useState } from './vdom.js';
import { field } from './components.js';

/** 高亮使用的记号类型枚举，对应 qx-tok-* 样式 */
export const TOKEN_TYPES = Object.freeze([
  'comment', 'string', 'number', 'keyword', 'builtin', 'variable', 'property', 'operator',
  'punctuation', 'constant', 'tag', 'attr', 'flag', 'section', 'error', 'warning', 'info', 'muted', 'text',
]);

const SH_KEYWORDS = 'if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|return|exit|local|export|readonly|declare|set|unset|shift|source|alias|trap|break|continue';
const SH_BUILTINS = 'sudo|echo|printf|cd|pwd|ls|cat|less|tail|head|grep|egrep|awk|sed|cut|sort|uniq|wc|tr|xargs|find|test|tee|kubectl|helm|docker|podman|systemctl|journalctl|service|nginx|mysql|mysqldump|psql|redis-cli|tar|zip|unzip|gzip|curl|wget|ssh|scp|rsync|rm|cp|mv|mkdir|rmdir|touch|chmod|chown|chgrp|ln|df|du|free|top|ps|kill|pkill|apt|apt-get|yum|dnf|pacman|brew|git|make|go|node|npm|python|python3|pip|env|which|whoami|hostname|uname|date|sleep|true|false';
const SQL_KEYWORDS = 'select|from|where|and|or|not|in|is|null|as|on|join|inner|left|right|full|outer|cross|group|by|order|having|limit|offset|insert|into|values|update|set|delete|create|alter|drop|table|index|view|database|schema|if|exists|primary|key|foreign|references|unique|default|constraint|add|column|modify|change|rename|to|truncate|union|all|distinct|case|when|then|else|end|like|between|asc|desc|with|recursive|returning|explain|analyze|show|describe|use|grant|revoke|begin|commit|rollback|transaction|int|integer|bigint|smallint|tinyint|varchar|char|text|blob|datetime|timestamp|date|time|decimal|float|double|boolean|json|auto_increment|unsigned|engine|charset|collate';
const JS_KEYWORDS = 'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|get|set';
const GO_KEYWORDS = 'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var';
const GO_BUILTINS = 'bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr|any|append|cap|close|copy|delete|len|make|new|panic|print|println|recover|nil|true|false|iota';

const GRAMMARS = {
  text: [],
  sh: [
    ['comment', '#.*'],
    ['string', '"(?:[^"\\\\]|\\\\[\\s\\S])*"|\'[^\']*\''],
    ['variable', '\\$\\{[^}]*\\}|\\$[\\w@#?*$!-]+'],
    ['keyword', `\\b(?:${SH_KEYWORDS})\\b`],
    ['builtin', `(?<![\\w./-])(?:${SH_BUILTINS})(?![\\w./-])`],
    ['flag', '(?<=\\s|^)--?[\\w][\\w-]*=?'],
    ['number', '\\b\\d+(?:\\.\\d+)?\\b'],
    ['operator', '\\|\\||&&|[|&;]|\\d*[<>]+&?\\d*'],
    ['punctuation', '[(){}\\[\\]]'],
  ],
  yaml: [
    ['comment', '#.*'],
    ['section', '^(?:---|\\.\\.\\.)(?=\\s|$)'],
    ['property', '^[ \\t]*(?:- +)?(?:"[^"]*"|\'[^\']*\'|[^\\s#:"\'{}\\[\\],][^#:]*?)(?=:(?:\\s|$))'],
    ['punctuation', '^[ \\t]*-(?=\\s|$)'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\''],
    ['tag', '![\\w/:.-]*'],
    ['variable', '[&*][\\w.-]+'],
    ['constant', '\\b(?:true|false|yes|no|on|off|null|True|False|Yes|No|Null|TRUE|FALSE|NULL)\\b|(?<=:\\s*)~(?=\\s|$)'],
    ['number', '(?<=[:\\s\\[,])-?\\d+(?:\\.\\d+)?(?=\\s|$|[,\\]])'],
    ['operator', '(?<=:\\s*)[|>][-+]?(?=\\s|$)'],
    ['punctuation', '[{}\\[\\],:]'],
  ],
  json: [
    ['property', '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['constant', '\\b(?:true|false|null)\\b'],
    ['number', '-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'],
    ['punctuation', '[{}\\[\\],:]'],
  ],
  nginx: [
    ['comment', '#.*'],
    ['keyword', '^[ \\t]*(?:server|http|events|location|upstream|map|if|stream|types|limit_except|split_clients|geo)(?=\\s|\\{)'],
    ['builtin', '^[ \\t]*[a-z_][\\w]*(?=\\s)'],
    ['variable', '\\$\\w+'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\''],
    ['constant', '\\b(?:on|off|always|any|all|none)\\b'],
    ['number', '\\b\\d+(?:\\.\\d+)*(?:[kKmMgG]|ms|s|m|h|d|y)?\\b'],
    ['operator', '~\\*?|=|\\^~'],
    ['punctuation', '[{};]'],
  ],
  sql: [
    ['comment', '--.*|#.*|/\\*[\\s\\S]*?\\*/'],
    ['string', '\'(?:[^\'\\\\]|\\\\.|\'\')*\'|"(?:[^"\\\\]|\\\\.)*"'],
    ['variable', '`[^`]*`|@@?\\w+'],
    ['keyword', `\\b(?:${SQL_KEYWORDS})\\b`, 'i'],
    ['builtin', '\\b[A-Za-z_]\\w*(?=\\s*\\()'],
    ['number', '\\b\\d+(?:\\.\\d+)?\\b'],
    ['operator', '<>|<=|>=|!=|[=<>+\\-*/%]'],
    ['punctuation', '[(),;.]'],
  ],
  ini: [
    ['comment', '^[ \\t]*[;#].*'],
    ['section', '^[ \\t]*\\[[^\\]\\n]*\\]'],
    ['property', '^[ \\t]*[^=\\s;#\\[][^=\\n]*?(?=\\s*=)'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\''],
    ['constant', '(?<==\\s*)(?:true|false|yes|no|on|off|null)(?=\\s*$)'],
    ['number', '(?<==\\s*)-?\\d+(?:\\.\\d+)?(?=\\s*$)'],
    ['operator', '='],
  ],
  dockerfile: [
    ['comment', '#.*'],
    ['keyword', '^[ \\t]*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\\b|\\b(?:AS|as)\\b'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\''],
    ['variable', '\\$\\{[^}]*\\}|\\$\\w+'],
    ['flag', '(?<=\\s)--[\\w-]+=?'],
    ['operator', '&&|\\|\\||[|;]|\\\\$'],
  ],
  js: [
    ['comment', '//.*|/\\*[\\s\\S]*?\\*/'],
    ['string', '`(?:[^`\\\\]|\\\\[\\s\\S])*`|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\''],
    ['keyword', `\\b(?:${JS_KEYWORDS})\\b`],
    ['constant', '\\b(?:true|false|null|undefined|NaN|Infinity)\\b'],
    ['number', '\\b0[xX][\\da-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?n?\\b'],
    ['builtin', '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()'],
    ['operator', '=>|\\.\\.\\.|[=!<>]=?=?|&&|\\|\\||\\?\\?|[+\\-*/%&|^~?:]'],
    ['punctuation', '[{}()\\[\\];,.]'],
  ],
  go: [
    ['comment', '//.*|/\\*[\\s\\S]*?\\*/'],
    ['string', '`[^`]*`|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\''],
    ['keyword', `\\b(?:${GO_KEYWORDS})\\b`],
    ['builtin', `\\b(?:${GO_BUILTINS})\\b`],
    ['number', '\\b0[xX][\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?i?\\b'],
    ['builtin', '\\b[A-Za-z_]\\w*(?=\\()'],
    ['operator', ':=|<-|\\+\\+|--|&&|\\|\\||[=!<>]=?|[+\\-*/%&|^~]'],
    ['punctuation', '[{}()\\[\\];,.]'],
  ],
  sshconfig: [
    ['comment', '#.*'],
    ['section', '^[ \\t]*(?:Host|Match)\\b[^\\n]*'],
    ['property', '^[ \\t]*[A-Za-z][A-Za-z0-9]*(?=[ \\t=])'],
    ['constant', '(?<=[ \\t=])(?:yes|no|ask|confirm|auto|always|none)(?=\\s|$)'],
    ['number', '(?<=[ \\t=])\\d+(?=\\s|$)'],
  ],
  log: [
    ['muted', '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?|\\[\\d{2}/\\w{3}/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4}\\]'],
    ['error', '\\b(?:ERROR|ERR|FATAL|CRIT(?:ICAL)?|PANIC|EMERG|ALERT)\\b'],
    ['warning', '\\b(?:WARN(?:ING)?)\\b'],
    ['info', '\\b(?:INFO|NOTICE)\\b'],
    ['muted', '\\b(?:DEBUG|TRACE|VERBOSE)\\b'],
    ['number', '\\b\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d+)?\\b'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['constant', '(?<=\\s)[1-5]\\d{2}(?=\\s)'],
  ],
};

const ALIASES = {
  bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh',
  yml: 'yaml', javascript: 'js', mjs: 'js', golang: 'go', toml: 'ini', cnf: 'ini', cfg: 'ini',
  conf: 'nginx', plain: 'text', txt: 'text', '': 'text',
};

const compiled = new Map();

function grammarOf(lang) {
  const name = canonicalLanguage(lang);
  if (compiled.has(name)) return compiled.get(name);
  const rules = (GRAMMARS[name] || []).map(([type, src, flags]) => ({ type, re: new RegExp(src, 'ym' + String(flags || '').replace(/[ym]/g, '')) }));
  compiled.set(name, rules);
  return rules;
}

/** 把语言名或别名归一化为内置语言键 */
export function canonicalLanguage(lang) {
  const l = String(lang || '').toLowerCase();
  if (GRAMMARS[l]) return l;
  if (ALIASES[l] !== undefined) return ALIASES[l];
  return 'text';
}

/** 列出支持的语言与别名 */
export function languages() {
  return [...Object.keys(GRAMMARS), ...Object.keys(ALIASES).filter(Boolean)].sort();
}

/** 注册新的语言语法，供应用扩展高亮范围 */
export function registerLanguage(name, rules, aliases = []) {
  const key = String(name || '').toLowerCase();
  if (!key) throw new Error('registerLanguage: name is required');
  GRAMMARS[key] = (rules || []).map(([type, src, flags]) => [TOKEN_TYPES.includes(type) ? type : 'text', String(src), String(flags || '')]);
  compiled.delete(key);
  for (const a of aliases) ALIASES[String(a).toLowerCase()] = key;
}

/** 按文件名或路径推断应使用的语言 */
export function languageForFile(name) {
  const full = String(name || '').replace(/\\/g, '/');
  const base = full.split('/').pop().toLowerCase();
  if (!base) return 'text';
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'ssh_config' || base === 'sshd_config' || (base === 'config' && /\/\.ssh\//.test(full))) return 'sshconfig';
  if (base === 'makefile') return 'sh';
  if (base.startsWith('.bash') || base.startsWith('.zsh') || base === '.profile') return 'sh';
  if (base === 'my.cnf' || base === '.my.cnf') return 'ini';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  if (ext === 'conf' && /nginx|sites?-(?:available|enabled)|conf\.d/.test(String(name).replace(/\\/g, '/'))) return 'nginx';
  const map = { sh: 'sh', bash: 'sh', zsh: 'sh', yaml: 'yaml', yml: 'yaml', json: 'json', sql: 'sql', ini: 'ini', toml: 'ini', cnf: 'ini', cfg: 'ini', env: 'ini', js: 'js', mjs: 'js', cjs: 'js', go: 'go', log: 'log', conf: 'nginx', nginx: 'nginx', txt: 'text', md: 'text' };
  return map[ext] || 'text';
}

const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', 'changelog', 'authors', 'contributing', 'notice',
  'hosts', 'passwd', 'group', 'fstab', 'crontab', 'motd', 'issue', 'hostname', 'resolv.conf',
  'authorized_keys', 'known_hosts', 'config', 'ssh_config', 'sshd_config', 'nginx.conf', 'my.cnf',
  '.gitignore', '.gitattributes', '.editorconfig', '.env', '.bashrc', '.zshrc', '.profile', '.vimrc',
]);
const TEXT_EXTS = new Set([
  'txt', 'md', 'log', 'conf', 'cfg', 'ini', 'cnf', 'toml', 'yaml', 'yml', 'json', 'xml', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'go', 'py', 'rb', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'sh', 'bash', 'zsh',
  'sql', 'env', 'service', 'timer', 'socket', 'list', 'repo', 'properties', 'csv', 'tsv', 'pem', 'crt', 'key',
  'pub', 'tpl', 'tmpl', 'j2', 'lock', 'sum', 'mod',
]);

/** 判断文件是否适合按文本预览 */
export function isTextFile(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!base) return false;
  if (TEXT_NAMES.has(base)) return true;
  if (languageForFile(name) !== 'text') return true;
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return TEXT_EXTS.has(ext);
}

/** 把源码切分为带类型的记号列表 */
export function tokenize(code, lang) {
  const src = String(code ?? '');
  const rules = grammarOf(lang);
  const out = [];
  let pos = 0;
  let plain = '';
  const flush = () => { if (plain) { out.push({ type: 'text', text: plain }); plain = ''; } };
  while (pos < src.length) {
    let hit = null;
    for (const r of rules) {
      r.re.lastIndex = pos;
      const m = r.re.exec(src);
      if (m && m.index === pos && m[0].length > 0) { hit = { type: r.type, text: m[0] }; break; }
    }
    if (hit) {
      flush();
      out.push(hit);
      pos += hit.text.length;
    } else {
      plain += src[pos];
      pos++;
    }
  }
  flush();
  return out;
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把源码渲染成高亮 HTML */
export function highlightHTML(code, lang) {
  return tokenize(code, lang).map((tk) => (tk.type === 'text'
    ? escapeHTML(tk.text)
    : `<span class="qx-tok-${tk.type}">${escapeHTML(tk.text)}</span>`)).join('');
}

/** 生成高亮代码块视图，可选行号与自动换行 */
export function highlightCode(code, lang, { cls = '', lineNumbers = false, wrap = false } = {}) {
  const text = String(code ?? '');
  const html = highlightHTML(text, lang);
  if (!lineNumbers) {
    return h('pre', { class: cx('cmp-code qx-hl', wrap && 'qx-hl-wrap', cls), html });
  }
  const n = text.split('\n').length;
  return h('div', { class: cx('qx-code qx-code-static', cls) }, [
    h('div', { class: 'qx-code-gutter', 'aria-hidden': 'true' }, Array.from({ length: n }, (_, i) => h('span', { text: String(i + 1) }))),
    h('pre', { class: cx('qx-code-hl qx-code-hl-static', wrap && 'qx-hl-wrap'), html }),
  ]);
}

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

const DEFAULT_ROWS = 8;
const DEFAULT_MAX_ROWS = 30;

function replaceSelection(ta, text, selectStart, selectEnd) {
  let viaCommand = false;
  try {
    ta.focus();
    viaCommand = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  } catch { viaCommand = false; }
  if (!viaCommand) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  if (selectStart != null) ta.setSelectionRange(selectStart, selectEnd == null ? selectStart : selectEnd);
  return viaCommand;
}

/** 代码编辑框组件：高亮层叠加文本域，支持缩进、提交与只读 */
export function CodeEditor(props) {
  const {
    value = '', lang = 'text', onChange, onSubmit, single = false, readOnly = false,
    lineNumbers = true, rows = DEFAULT_ROWS, maxRows = DEFAULT_MAX_ROWS, tabSize = 2,
    placeholder = '', cls = '', onBlur, onFocus,
  } = props;
  const slot = useState(() => ({
    text: String(value ?? ''), last: String(value ?? ''), ta: null, pre: null, gutter: null,
  })).value;
  const rev = useState(0);
  void rev.value;
  if (slot.last !== String(value ?? '')) {
    slot.last = String(value ?? '');
    slot.text = slot.last;
  }
  const refs = slot;
  const cur = slot.text;
  const lineCount = single ? 1 : cur.split('\n').length;
  const visibleRows = single ? 1 : Math.max(rows, maxRows > 0 ? Math.min(lineCount, maxRows) : lineCount);

  const update = () => {
    const ta = refs.ta;
    if (!ta) return;
    if (ta.value !== slot.text) {
      slot.text = ta.value;
      rev.next = rev.value + 1;
      if (onChange) onChange(ta.value);
    }
  };
  const syncScroll = () => {
    const { ta, pre, gutter } = refs;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    if (gutter) gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
  };
  const indentUnit = ' '.repeat(Math.max(1, tabSize | 0));

  const onKeydown = (e) => {
    const ta = e.currentTarget;
    if (readOnly) return;
    if (e.key === 'Enter' && (single || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (onSubmit) onSubmit(ta.value);
      return;
    }
    if (single) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      const v = ta.value;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const multi = v.slice(s, en).includes('\n');
      if (!multi && !e.shiftKey) {
        if (!replaceSelection(ta, indentUnit)) update();
        return;
      }
      const lineEnd = v.indexOf('\n', en - (en > s && v[en - 1] === '\n' ? 1 : 0));
      const blockEnd = lineEnd < 0 ? v.length : lineEnd;
      const block = v.slice(lineStart, blockEnd);
      const lines = block.split('\n');
      const next = lines.map((l) => (e.shiftKey ? l.replace(new RegExp(`^(?: {1,${indentUnit.length}}|\\t)`), '') : (l.length ? indentUnit + l : l))).join('\n');
      ta.setSelectionRange(lineStart, blockEnd);
      if (!replaceSelection(ta, next, lineStart, lineStart + next.length)) update();
      else ta.setSelectionRange(lineStart, lineStart + next.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const s = ta.selectionStart;
      const v = ta.value;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(lineStart, s);
      const indent = (/^[ \t]*/.exec(line) || [''])[0];
      const extra = /[{[(:]\s*$/.test(line) ? indentUnit : '';
      if (!replaceSelection(ta, `\n${indent}${extra}`)) update();
    }
  };

  const html = highlightHTML(single ? cur : `${cur}\n`, lang);
  const gutter = !single && lineNumbers
    ? h('div', { class: 'qx-code-gutter-clip', 'aria-hidden': 'true' }, [
      h('div', { class: 'qx-code-gutter', ref: (el) => { refs.gutter = el; } },
        Array.from({ length: lineCount }, (_, i) => h('span', { text: String(i + 1) }))),
    ])
    : null;
  return h('div', {
    class: cx('qx-code', single && 'qx-code-single', readOnly && 'qx-code-readonly', cls),
    style: { '--qx-code-tab': String(tabSize) },
  }, [
    gutter,
    h('div', { class: 'qx-code-scroll' }, [
      h('pre', { class: 'qx-code-hl', 'aria-hidden': 'true', html, ref: (el) => { refs.pre = el; } }),
      h('textarea', {
        class: 'qx-code-input',
        value: cur,
        rows: String(visibleRows),
        spellcheck: 'false',
        autocapitalize: 'off',
        autocomplete: 'off',
        wrap: 'off',
        placeholder,
        readonly: readOnly ? true : null,
        'aria-label': props['aria-label'] || null,
        ref: (el) => { refs.ta = el; if (props.inputRef) props.inputRef.current = el; },
        onInput: update,
        onScroll: syncScroll,
        onKeydown,
        onBlur: onBlur || null,
        onFocus: onFocus || null,
      }),
    ]),
  ]);
}

/** 带标签的代码输入字段（multiline 为 true 时多行） */
export function codeField(label, opts = {}) {
  const { multiline = false, ...rest } = opts;
  return field(label, h(CodeEditor, { ...rest, single: !multiline }));
}
