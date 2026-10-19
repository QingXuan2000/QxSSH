import { h } from '/assets/js/core/vdom.js';
import { fmtSize } from '/assets/js/core/dom.js';
import { batch } from '/assets/js/core/signal.js';
import { chipGroup, segmented, Tree } from '/assets/js/core/components.js';
import { openProcMenu } from './signals.js';
import { procs, list, filter, collapsed, MAX_ROWS } from './state.js';
import { tmonCard } from './shell.js';
import { t, tf } from '/assets/js/core/i18n.js';

const PRESETS = [
  { id: 'all', key: 'app.taskmon.filter-all' },
  { id: 'system', key: 'app.taskmon.filter-system' },
  { id: 'user', key: 'app.taskmon.filter-user' },
  { id: 'own', key: 'app.taskmon.filter-own' },
  { id: 'programs', key: 'app.taskmon.filter-programs' },
];

function presetItems() {
  return PRESETS.map((p) => ({ id: p.id, label: t(p.key) }));
}

const COLS = [
  { id: 'name', key: 'app.taskmon.col-name', sortable: true },
  { id: 'pid', label: 'PID', sortable: true },
  { id: 'user', key: 'app.taskmon.col-user', sortable: true },
  { id: 'cpu', label: 'CPU%', sortable: true, num: true },
  { id: 'mem', key: 'app.taskmon.apps-mem', sortable: true, num: true },
  { id: 'rss', label: 'RSS', sortable: true, num: true },
  { id: 'stat', key: 'app.taskmon.col-state', sortable: false },
  { id: 'etime', key: 'app.taskmon.col-runtime', sortable: true },
  { id: 'args', key: 'app.taskmon.col-command', sortable: false },
];

function colLabel(c) {
  return c.key ? t(c.key) : c.label;
}

function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  if (d > 0) return tf('app.taskmon.up-d-h', { v1: d, v2: hh });
  if (hh > 0) return tf('app.taskmon.up-h-m', { v1: hh, v2: mm });
  if (mm > 0) return tf('app.taskmon.up-m-s', { v1: mm, v2: ss });
  return tf('app.taskmon.up-s', { v1: ss });
}

function matchPreset(p) {
  switch (filter.preset.value) {
    case 'system': return p.kthread || p.uid < 1000;
    case 'user': return !p.kthread && p.uid >= 1000;
    case 'own': {
      const l = list.value;
      return !!l && (p.uid === l.uid || p.user === l.user);
    }
    case 'programs': return !p.kthread;
    default: return true;
  }
}

function matchQuery(p) {
  const q = filter.q.value.trim().toLowerCase();
  if (!q) return true;
  return p.name.toLowerCase().includes(q)
    || (p.args && p.args.toLowerCase().includes(q))
    || (p.user && p.user.toLowerCase().includes(q))
    || String(p.pid).includes(q);
}

function sortProcs(arr) {
  const k = filter.sort.value;
  const d = filter.dir.value;
  const out = arr.slice();
  out.sort((a, b) => {
    let va = a[k];
    let vb = b[k];
    if (k === 'name' || k === 'user' || k === 'stat' || k === 'args') {
      va = String(va || '').toLowerCase();
      vb = String(vb || '').toLowerCase();
      return va < vb ? -d : (va > vb ? d : 0);
    }
    va = Number(va) || 0;
    vb = Number(vb) || 0;
    if (va === vb) return (b.cpu || 0) - (a.cpu || 0);
    return (va - vb) * d;
  });
  return out;
}

function visibleProcs() {
  const all = procs.value;
  const match = (p) => matchPreset(p) && matchQuery(p);
  if (filter.view.value === 'flat') return sortProcs(all.filter(match));

  const keep = new Set();
  const children = new Map();
  const roots = [];
  const pidSet = new Set(all.map((p) => p.pid));
  for (const p of all) {
    const by = children.get(p.ppid);
    if (by) by.push(p);
    else children.set(p.ppid, [p]);
    if (p.ppid === 0 || p.ppid === p.pid || !pidSet.has(p.ppid)) roots.push(p);
  }
  const mark = (p) => {
    let any = match(p);
    for (const c of children.get(p.pid) || []) if (mark(c)) any = true;
    if (any) keep.add(p.pid);
    return any;
  };
  for (const r of roots) mark(r);
  for (const p of all) if (!keep.has(p.pid) && match(p)) keep.add(p.pid);
  return sortProcs(all.filter((p) => keep.has(p.pid)));
}

function sortBy(id) {
  if (filter.sort.value === id) {
    filter.dir.next = -filter.dir.value;
    return;
  }
  batch(() => {
    filter.sort.next = id;
    filter.dir.next = (id === 'name' || id === 'user') ? 1 : -1;
  });
}

function buildTreeItems(rows, limit) {
  const byPid = new Map(rows.map((p) => [p.pid, p]));
  const childrenOf = new Map();
  const roots = [];
  for (const p of rows) {
    const parent = p.ppid !== p.pid && byPid.has(p.ppid) ? p.ppid : null;
    if (parent) {
      const c = childrenOf.get(parent);
      if (c) c.push(p);
      else childrenOf.set(parent, [p]);
    } else {
      roots.push(p);
    }
  }
  const flat = [];
  const walk = (p, depth) => {
    flat.push({ p, depth });
    for (const c of childrenOf.get(p.pid) || []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  const kept = new Set(flat.slice(0, limit).map((x) => x.p.pid));
  const node = (p) => ({
    id: p.pid,
    proc: p,
    children: (childrenOf.get(p.pid) || []).filter((c) => kept.has(c.pid)).map(node),
  });
  return { roots: roots.filter((r) => kept.has(r.pid)).map(node), total: flat.length };
}

function meterCell(value) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return h('div', { class: 'tmon-c tmon-num tmon-meter-cell' }, [
    h('i', { class: 'tmon-meter', style: { width: `${pct.toFixed(1)}%` } }),
    h('span', { text: (Number(value) || 0).toFixed(1) }),
  ]);
}

function withClass(vnode, extra) {
  return h(vnode.type, {
    ...vnode.props,
    class: `${vnode.props.class || ''} ${extra}`.trim(),
  }, vnode.children);
}

function procRow(item, depth, expanded, toggle) {
  const p = item.proc;
  return h('div', {
    class: 'tmon-row',
    dataset: { pid: String(p.pid) },
    title: p.args || p.name,
    onContextmenu: (e) => { e.preventDefault(); openProcMenu(e, p); },
  }, [
    h('div', { class: 'tmon-c-name' }, [
      withClass(toggle, 'tmon-tw'),
      h('span', { class: 'tmon-pname', text: p.name }),
    ]),
    h('div', { class: 'tmon-c mono', text: String(p.pid) }),
    h('div', { class: 'tmon-c', text: p.user || '-' }),
    meterCell(p.cpu),
    h('div', { class: 'tmon-c tmon-num mono', text: p.mem.toFixed(1) }),
    h('div', { class: 'tmon-c tmon-num mono', text: fmtSize(p.rss * 1024) }),
    h('div', { class: 'tmon-c', text: p.stat || '-' }),
    h('div', { class: 'tmon-c', text: fmtDur(p.etime) }),
    h('div', { class: 'tmon-c tmon-args', text: p.args || '-' }),
  ]);
}

function headRow() {
  const sort = filter.sort.value;
  const dir = filter.dir.value;
  return h('div', { class: 'tmon-row tmon-head' }, COLS.map((c) => h('div', {
    key: c.id,
    class: `tmon-c${c.sortable ? ' is-sort' : ''}${c.num ? ' tmon-num' : ''}${c.id === 'name' ? ' tmon-c-name' : ''}`,
    onClick: c.sortable ? () => sortBy(c.id) : undefined,
    text: colLabel(c) + (sort === c.id ? (dir < 0 ? ' ↓' : ' ↑') : ''),
  })));
}

export function buildProcPage() {
  return h(ProcPage);
}

function ProcPage() {
  const rows = visibleProcs();

  const tools = h('div', { class: 'tmon-tools' }, [
    h('div', { class: 'tmon-tools-l' }, [
      h('input', {
        class: 'input tmon-search',
        type: 'search',
        placeholder: t('app.taskmon.search-placeholder'),
        onInput: (e) => { filter.q.next = e.target.value; },
      }),
      chipGroup(presetItems(), filter.preset.value, (id) => { filter.preset.next = id; }),
      segmented([
        { value: 'flat', label: t('app.taskmon.view-flat') },
        { value: 'tree', label: t('app.taskmon.view-tree') },
      ], filter.view.value, (v) => { filter.view.next = v; }),
    ]),
  ]);

  const scroll = h('div', { class: 'tmon-scroll' }, [
    h('div', { class: 'tmon-head-slot' }, [headRow()]),
    h('div', { class: 'tmon-rows' }, rowsChildren()),
  ]);

  return h('div', { class: 'tmon-content-scroll' }, tmonCard(t('app.taskmon.tab-procs'), [tools, scroll], {
    fill: true,
    tools: h('div', { class: 'qx-card-head-tools' }, [
      h('span', { class: 'qx-count', text: tf('app.taskmon.proc-summary', { v1: (rows.length), v2: (procs.value.length) }) }),
    ]),
  }));

  function rowsChildren() {
    if (!rows.length) {
      return [h('div', {
        class: 'tmon-empty',
        text: procs.value.length ? t('app.taskmon.proc-none') : t('app.taskmon.apps-loading'),
      })];
    }
    const over = h('div', {
      class: 'tmon-empty',
      text: tf('app.taskmon.proc-truncated', { v1: MAX_ROWS }),
    });
    if (filter.view.value === 'tree') {
      const { roots, total } = buildTreeItems(rows, MAX_ROWS);
      return [
        h(Tree, {
          items: roots,
          collapsed: collapsed.value,
          indent: 16,
          onToggle: (id, isExpanded) => {
            const s = new Set(collapsed.value);
            if (isExpanded) s.delete(id);
            else s.add(id);
            collapsed.next = s;
          },
          rowRender: procRow,
        }),
        total > MAX_ROWS ? over : null,
      ].filter(Boolean);
    }
    return [
      ...rows.slice(0, MAX_ROWS).map((p) => procRow(
        { proc: p }, 0, true, h('span', { class: 'tmon-tw is-empty' }),
      )),
      rows.length > MAX_ROWS ? over : null,
    ].filter(Boolean);
  }
}
