import { h } from '/assets/js/core/vdom.js';
import { fmtSize } from '/assets/js/core/dom.js';
import { icon } from '/assets/js/icons/index.js';
import { openGroupMenu, openProcMenu } from './signals.js';
import { procs, expanded, toggleGroup } from './state.js';
import { tmonCard } from './shell.js';
import { t, tf } from '/assets/js/core/i18n.js';

function aggregate() {
  const map = new Map();
  for (const p of procs.value) {
    if (p.kthread) continue;
    let g = map.get(p.name);
    if (!g) {
      g = { name: p.name, count: 0, cpu: 0, mem: 0, rss: 0, ioR: 0, ioW: 0, hasIO: false, procs: [] };
      map.set(p.name, g);
    }
    g.count++;
    g.cpu += p.cpu;
    g.mem += p.mem;
    g.rss += p.rss;
    if (p.hasIO) {
      g.ioR += p.ioR;
      g.ioW += p.ioW;
      g.hasIO = true;
    }
    g.procs.push(p);
  }
  for (const g of map.values()) g.procs.sort((a, b) => b.cpu - a.cpu);
  return [...map.values()].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
}

const NOTE_KEY = 'app.taskmon.apps-metric-note';
const NOTE_FULL_KEYS = ['app.taskmon.apps-net-note', 'app.taskmon.apps-disk-note'];

function subRow(p) {
  return h('div', {
    class: 'tmon-row tmon-app-sub',
    title: p.args || p.name,
    onContextmenu: (e) => { e.preventDefault(); openProcMenu(e, p); },
  }, [
    h('span', { class: 'tmon-sub-line' }, [
      h('span', { class: 'tmon-sub-pid mono', text: String(p.pid) }),
      h('span', { class: 'tmon-sub-user', text: p.user || '-' }),
      h('span', { class: 'tmon-sub-args', text: p.args || p.name }),
    ]),
  ]);
}

function groupRow(g) {
  const open = expanded.value.has(g.name);
  return h('div', {
    class: 'tmon-row tmon-app-row',
    title: g.name,
    onClick: () => toggleGroup(g.name),
    onContextmenu: (e) => { e.preventDefault(); openGroupMenu(e, g); },
  }, [
    h('div', { class: 'tmon-c-name' }, [
      h('span', { class: 'tmon-tw', html: icon(open ? 'chevron-down' : 'chevron-right', 'qicon-sm') }),
      h('span', { class: 'tmon-pname', text: g.name }),
    ]),
    h('div', { class: 'tmon-c tmon-num mono', text: String(g.count) }),
    h('div', { class: 'tmon-c tmon-num mono', text: g.cpu.toFixed(1) }),
    h('div', { class: 'tmon-c tmon-num mono', text: g.mem.toFixed(1) }),
    h('div', { class: 'tmon-c tmon-num mono', text: g.hasIO ? fmtSize(g.ioR) : '-' }),
    h('div', { class: 'tmon-c tmon-num mono', text: g.hasIO ? fmtSize(g.ioW) : '-' }),
  ]);
}

export function buildAppsPage() {
  return h(AppsPage);
}

function AppsPage() {
  const groups = aggregate();

  const tools = h('div', { class: 'tmon-tools' }, [
    h('div', { class: 'tmon-tools-l' }, [
      h('span', {
        class: 'tmon-hint',
        text: t(NOTE_KEY),
        title: NOTE_FULL_KEYS.map((k) => t(k)).join(''),
      }),
    ]),
  ]);

  const rows = h('div', { class: 'tmon-rows' }, groups.length
    ? groups.flatMap((g) => [
      groupRow(g),
      ...(expanded.value.has(g.name) ? g.procs.map(subRow) : []),
    ])
    : [h('div', {
      class: 'tmon-empty',
      text: procs.value.length ? t('app.taskmon.apps-none') : t('app.taskmon.apps-loading'),
    })]);

  const scroll = h('div', { class: 'tmon-scroll' }, [
    h('div', { class: 'tmon-head-slot' }, [
      h('div', { class: 'tmon-row tmon-head tmon-app-row' }, [
        h('div', { class: 'tmon-c-name', text: t('app.taskmon.tab-apps') }),
        h('div', { class: 'tmon-c tmon-num', text: t('app.taskmon.apps-count') }),
        h('div', { class: 'tmon-c tmon-num', text: 'CPU%' }),
        h('div', { class: 'tmon-c tmon-num', text: t('app.taskmon.apps-mem') }),
        h('div', { class: 'tmon-c tmon-num', text: t('app.taskmon.apps-disk-read') }),
        h('div', { class: 'tmon-c tmon-num', text: t('app.taskmon.apps-disk-write') }),
      ]),
    ]),
    rows,
  ]);

  return h('div', { class: 'tmon-content-scroll' }, tmonCard(t('app.taskmon.tab-apps'), [tools, scroll], {
    fill: true,
    tools: h('div', { class: 'qx-card-head-tools' }, [
      h('span', {
        class: 'qx-count',
        text: tf('app.taskmon.apps-summary', { v1: (groups.length), v2: (procs.value.length) }),
      }),
    ]),
  }));
}
