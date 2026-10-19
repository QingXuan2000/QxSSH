/**
 * desktop/iconlayout.js —— 桌面图标网格布局
 * 要点：按主机持久化图标所在行列，负责为新增图标寻找空位、清理失效图标以及按网格重排。
 */
import { getPref, setJSONPref } from '../core/prefs.js';

/** 按主机拼装布局配置的偏好键名 */
export function layoutKey(hostId) {
  return `qx-desktop-layout-${hostId}`;
}

/** 读取布局，丢弃行列非法的记录 */
export function load(key) {
  try {
    const raw = getPref(key, '');
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    for (const [id, v] of Object.entries(obj)) {
      if (v && Number.isFinite(v.col) && Number.isFinite(v.row)) out[id] = { col: v.col, row: v.row };
    }
    return out;
  } catch (err) {
    console.warn('[desktop] 布局读取失败', err);
    return {};
  }
}

/** 保存布局 */
export function save(key, layout) {
  try {
    setJSONPref(key, layout);
    return true;
  } catch (err) {
    console.warn('[desktop] 布局保存失败', err);
    return false;
  }
}

function gridSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 1;
}

/** 在网格中寻找第一个空闲格子 */
export function firstFreeCell(layout, baseCols = 4, rowsPerCol = Infinity, placeRows = null) {
  const cols = gridSize(baseCols);
  const values = Object.values(layout);
  const count = values.length;
  const maxUsedRow = values.reduce((m, c) => Math.max(m, (c?.row || 0) + 1), 0);
  const limit = [placeRows, rowsPerCol].find((v) => Number.isFinite(v) && v > 0) ?? null;
  const scanRows = Math.max(1, limit ?? maxUsedRow + 1);
  const taken = new Set(values.map((c) => `${c.col},${c.row}`));
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < scanRows; r++) {
      if (!taken.has(`${c},${r}`)) return { col: c, row: r };
    }
  }
  const maxCol = values.reduce((m, c) => Math.max(m, c?.col || 0), -1);
  const endCol = Math.max(cols, Math.min(maxCol + 1, cols + count + 1));
  const endRow = Math.max(maxUsedRow, scanRows + count);
  for (let c = 0; c <= endCol; c++) {
    for (let r = 0; r <= endRow; r++) {
      if (!taken.has(`${c},${r}`)) return { col: c, row: r };
    }
  }
  return { col: endCol, row: 0 };
}

/** 用当前图标集合校准布局：保留合法位置，其余补空位，必要时落盘 */
export function reconcile(key, ids, baseCols = 4, rowsPerCol = Infinity, { preserveUnknown = false, placeRows = null, persist = true } = {}) {
  const saved = load(key);
  const savedIds = Object.keys(saved);
  const currentIds = new Set(ids);
  const cols = gridSize(baseCols);
  const rows = Number.isFinite(rowsPerCol) && rowsPerCol > 0 ? Math.floor(rowsPerCol) : Infinity;
  const maxLogicalCols = cols + Math.max(ids.length, savedIds.length);
  const layout = {};
  const taken = new Set();
  const pending = [];
  for (const id of ids) {
    const cell = saved[id];
    const valid = cell
      && Number.isInteger(cell.col)
      && Number.isInteger(cell.row)
      && cell.col >= 0
      && cell.col < maxLogicalCols
      && cell.row >= 0
      && (rows === Infinity || cell.row < rows);
    if (valid && !taken.has(`${cell.col},${cell.row}`)) {
      layout[id] = { col: cell.col, row: cell.row };
      taken.add(`${cell.col},${cell.row}`);
    } else {
      pending.push(id);
    }
  }
  if (preserveUnknown) {
    for (const [id, cell] of Object.entries(saved)) {
      if (currentIds.has(id)) continue;
      const valid = cell
        && Number.isInteger(cell.col)
        && Number.isInteger(cell.row)
        && cell.col >= 0
        && cell.col < maxLogicalCols
        && cell.row >= 0;
      if (valid && !taken.has(`${cell.col},${cell.row}`)) {
        layout[id] = { col: cell.col, row: cell.row };
        taken.add(`${cell.col},${cell.row}`);
      }
    }
  }
  for (const id of pending) {
    const next = firstFreeCell(layout, cols, rows, placeRows);
    layout[id] = next;
    taken.add(`${next.col},${next.row}`);
  }
  let changed = Object.keys(layout).length !== savedIds.length;
  for (const [id, after] of Object.entries(layout)) {
    const before = saved[id];
    if (!before || before.col !== after.col || before.row !== after.row) changed = true;
  }
  if (changed && persist) save(key, layout);
  return layout;
}

/** 为新图标分配位置，已存在则沿用原位置 */
export function addApp(key, id, baseCols = 4, rowsPerCol = Infinity, placeRows = null) {
  const layout = load(key);
  if (layout[id]) return layout[id];
  const cell = firstFreeCell(layout, baseCols, rowsPerCol, placeRows);
  layout[id] = cell;
  save(key, layout);
  return cell;
}

/** 移除某个图标的布局记录 */
export function removeApp(key, id) {
  const layout = load(key);
  if (!(id in layout)) return;
  delete layout[id];
  save(key, layout);
}

/** 清理已不在有效集合中的图标布局 */
export function prune(key, validIds) {
  const layout = load(key);
  const valid = new Set(validIds);
  let changed = false;
  for (const id of Object.keys(layout)) {
    if (!valid.has(id)) {
      delete layout[id];
      changed = true;
    }
  }
  if (changed) save(key, layout);
}

/** 按给定顺序重排图标位置，并保留其余图标的位置 */
export function arrange(key, orderedIds, cols, rowsPerCol = Infinity, { preserveOthers = true } = {}) {
  const saved = load(key);
  const width = gridSize(cols);
  const rows = Number.isFinite(rowsPerCol) && rowsPerCol > 0
    ? Math.floor(rowsPerCol)
    : Math.max(1, Math.ceil(orderedIds.length / width));
  const layout = {};
  const taken = new Set();
  orderedIds.forEach((id, i) => {
    const cell = { col: Math.floor(i / rows), row: i % rows };
    layout[id] = cell;
    taken.add(`${cell.col},${cell.row}`);
  });
  if (preserveOthers) {
    const activeIds = new Set(orderedIds);
    for (const [id, cell] of Object.entries(saved)) {
      if (activeIds.has(id)) continue;
      if (!taken.has(`${cell.col},${cell.row}`)) {
        layout[id] = { col: cell.col, row: cell.row };
        taken.add(`${cell.col},${cell.row}`);
      } else {
        const next = firstFreeCell(layout, width, rows, rowsPerCol);
        layout[id] = next;
        taken.add(`${next.col},${next.row}`);
      }
    }
  }
  if (!save(key, layout)) return null;
  return layout;
}

