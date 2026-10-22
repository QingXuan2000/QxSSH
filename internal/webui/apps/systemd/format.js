/**
 * format.js —— Systemd 格式化与状态映射工具库
 */

import { t } from '/assets/js/core/i18n.js';

/**
 * 把 systemd 原始状态词 (active/sub/unitFileState) 映射为当前语言的可读标记
 * 词条缺失时原样返回原始值，避免出现空标记
 * @param {string} raw
 */
export function formatStateLabel(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!name) return '-';
  const key = `app.systemd.state-${name}`;
  const label = t(key);
  return label === key ? name : label;
}

/**
 * 格式化字节大小为人类可读字符串
 * @param {number|string} bytes
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0 || n > 1e15) return '-';
  if (n === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  if (i < 0) return '0 B';
  const idx = Math.min(i, sizes.length - 1);
  return `${parseFloat((n / Math.pow(k, idx)).toFixed(idx === 0 ? 0 : 1))} ${sizes[idx]}`;
}

/**
 * 格式化 CPU 纳秒数为微秒/秒/分钟
 * @param {number|string} nanos
 */
export function formatNanoCpu(nanos) {
  const n = Number(nanos);
  if (!Number.isFinite(n) || n <= 0) return '-';
  const ms = n / 1e6;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  if (min < 60) return `${min}m ${remSec}s`;
  const hrs = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hrs}h ${remMin}m`;
}

/**
 * 根据 active 与 sub 状态返回 Qx UI Kit 适用的 badge kind 与语义描述
 * @param {string} active
 * @param {string} sub
 * @returns {{ kind: string, label: string }}
 */
export function formatUnitState(active, sub) {
  const act = String(active || '').toLowerCase();
  const s = String(sub || '').toLowerCase();

  if (act === 'failed' || s === 'failed' || s === 'auto-restart') {
    return { kind: 'danger', label: formatStateLabel('failed') };
  }
  if (act === 'active') {
    if (s === 'running') return { kind: 'success', label: formatStateLabel('running') };
    if (s === 'exited') return { kind: 'neutral', label: formatStateLabel('exited') };
    if (s === 'waiting') return { kind: 'info', label: formatStateLabel('waiting') };
    if (s === 'listening') return { kind: 'success', label: formatStateLabel('listening') };
    return { kind: 'success', label: formatStateLabel(s || 'active') };
  }
  if (act === 'activating' || act === 'reloading' || s === 'start-pre' || s === 'start') {
    return { kind: 'primary', label: formatStateLabel(act || 'activating') };
  }
  if (act === 'deactivating' || s === 'stop-sigterm' || s === 'stop') {
    return { kind: 'warning', label: formatStateLabel(act || 'stopping') };
  }
  if (act === 'inactive') {
    if (s === 'dead') return { kind: 'neutral', label: formatStateLabel('dead') };
    return { kind: 'neutral', label: formatStateLabel(s || 'inactive') };
  }
  return { kind: 'default', label: formatStateLabel(s || act || 'unknown') };
}

/**
 * 根据 unitFileState 返回自启状态的 badge kind
 * @param {string} state
 */
export function formatUnitFileState(state) {
  const st = String(state || '').toLowerCase();
  switch (st) {
    case 'enabled':
    case 'enabled-runtime':
      return { kind: 'success', label: formatStateLabel(st) };
    case 'disabled':
      return { kind: 'neutral', label: formatStateLabel('disabled') };
    case 'static':
      return { kind: 'default', label: formatStateLabel('static') };
    case 'masked':
    case 'masked-runtime':
      return { kind: 'danger', label: formatStateLabel(st) };
    case 'indirect':
    case 'generated':
    case 'transient':
      return { kind: 'info', label: formatStateLabel(st) };
    default:
      return { kind: 'default', label: formatStateLabel(st) };
  }
}

/**
 * 提取 Unit 类型的后缀与简短标签
 * @param {string} unit
 */
export function extractUnitType(unit) {
  const u = String(unit || '').trim();
  const idx = u.lastIndexOf('.');
  if (idx < 0) return 'service';
  return u.slice(idx + 1).toLowerCase();
}

/**
 * 将相对时间转换为人类友好的字符串
 * @param {string|number} timestamp
 */
export function formatTimestamp(timestamp) {
  if (!timestamp || timestamp === '0' || timestamp === 'n/a' || timestamp === '-') return '-';
  const t = typeof timestamp === 'string' ? timestamp.trim() : timestamp;
  return t;
}

/**
 * 触发浏览器下载一段文本（诊断包、日志导出）
 * iframe 沙箱内下载可能被宿主拦截，返回 false 由调用方回退到复制
 * @param {string} filename
 * @param {string} text
 * @returns {boolean}
 */
export function downloadText(filename, text) {
  try {
    const blob = new Blob([String(text == null ? '' : text)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 把带树形前缀的文本解析为嵌套对象，供 JsonViewer 渲染
 *
 * 兼容两种 systemd 输出，层级都由 ├ / └ 的字符索引决定，不依赖固定步长：
 *
 *   ① systemctl list-dependencies --all（每级 3 列，行首带 ● 状态标记）
 *     nginx.service
 *     ● ├─system.slice
 *     ● └─multi-user.target
 *     ●   └─network.target
 *
 *   ② systemd-analyze critical-chain（每级 1 个空格）
 *     multi-user.target @5.101s
 *     └─docker.service @4.512s + 588ms
 *       └─network-online.target @4.481s
 *
 * 用「索引栈」匹配父子：当前行的标记索引 <= 栈顶索引时逐层弹出，
 * 因此 3 列缩进与 1 列缩进都能正确还原。叶子节点输出 true，
 * 分支节点输出对象；重名兄弟追加 #序号 以保留全部条目。
 *
 * @param {string} text 命令输出原文
 * @returns {{root: string, total: number, tree: Record<string, any>}}
 */
export function parseTreeText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0);

  const out = { root: '', total: 0, tree: {} };
  if (!lines.length) return out;

  const cleanName = (s) => s.replace(/^[●○×*✓✗\s│]+/, '').trim();
  out.root = cleanName(lines[0]);

  const stack = [{ indent: -1, node: out.tree }];
  for (const raw of lines.slice(1)) {
    const mark = /[├└]/.exec(raw);
    const name = cleanName(mark ? raw.slice(mark.index + 2) : raw);
    if (!name) continue;

    // 无树形前缀的续行按根节点的直接子项处理
    const indent = mark ? mark.index : -1;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const key = Object.prototype.hasOwnProperty.call(parent, name)
      ? `${name}#${Object.keys(parent).length + 1}`
      : name;

    parent[key] = {};
    stack.push({ indent, node: parent[key] });
    out.total += 1;
  }

  prune(out.tree);
  return out;

  function prune(node) {
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === 'object') {
        if (Object.keys(v).length === 0) node[key] = true;
        else prune(v);
      }
    }
  }
}

/**
 * 把 `systemctl list-dependencies --all` 的树形文本解析为嵌套对象
 * 解析逻辑复用 parseTreeText，返回结构沿用 unit / total / tree 三字段
 *
 * @param {string} text systemctl 输出原文
 * @returns {{unit: string, total: number, tree: Record<string, any>}}
 */
export function parseDepsTree(text) {
  const { root, total, tree } = parseTreeText(text);
  return { unit: root, total, tree };
}

/** critical-chain 末尾两行固定说明，分别解释 @ 与 + 的含义，不属于树结构 */
const CHAIN_LEGEND_AT = /printed after the "@" character/i;
const CHAIN_LEGEND_PLUS = /printed after the "\+" character/i;

/**
 * 解析 `systemd-analyze critical-chain` 输出
 *
 * 除了树形正文，该命令末尾还会打印两行说明：
 *   The time when unit became active or started is printed after the "@" character.
 *   The time the unit took to start is printed after the "+" character.
 * 这两行没有 ├ / └ 前缀，直接交给 parseTreeText 会变成根节点下的垃圾条目，
 * 因此在这里摘出来单独返回，由视图层翻译成中文放到树外面展示。
 *
 * @param {string} text systemd-analyze critical-chain 输出原文
 * @returns {{root: string, total: number, tree: Record<string, any>,
 *            legend: { at: boolean, plus: boolean }}}
 */
export function parseCriticalChain(text) {
  const treeLines = [];
  const legend = { at: false, plus: false };

  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) continue;
    if (CHAIN_LEGEND_PLUS.test(raw)) { legend.plus = true; continue; }
    if (CHAIN_LEGEND_AT.test(raw)) { legend.at = true; continue; }
    treeLines.push(raw);
  }

  const { root, total, tree } = parseTreeText(treeLines.join('\n'));
  return { root, total, tree, legend };
}
