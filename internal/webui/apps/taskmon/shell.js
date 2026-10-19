import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { card, sidebarSections, statusBar, sideAction } from '/assets/js/core/components.js';
import { fmtUptime } from './widgets.js';
import {
  elevated, errMetrics, errProcs, list, sys, lastTick, uptimeSec, toggleAdmin, refresh,
} from './state.js';
import { t, tf } from '/assets/js/core/i18n.js';

export const PAGES = [
  { id: 'overview', key: 'app.taskmon.tab-overview', icon: 'grid' },
  { id: 'apps', key: 'app.taskmon.tab-apps', icon: 'server' },
  { id: 'processes', key: 'app.taskmon.tab-procs', icon: 'list' },
];

function pageItems() {
  return PAGES.map((p) => ({ id: p.id, icon: p.icon, label: t(p.key) }));
}

export function tmonCard(title, body, { tools = null, fill = false, cls = '' } = {}) {
  return card(title, body, {
    tools,
    cls: `${fill ? 'tmon-fill' : ''}${cls ? ' ' + cls : ''}`.trim(),
  });
}

export function createShell(el, { builders, initial = 'overview' }) {
  const page = signal(PAGES.some((p) => p.id === initial) ? initial : 'overview');
  const make = (id) => (builders[id] ? builders[id]() : h('div', { class: 'tmon-content-scroll' }));

  function admBtn() {
    const on = elevated.value;
    return sideAction({
      icon: 'shield',
      label: on ? t('app.taskmon.mode-admin') : t('app.taskmon.mode-normal'),
      tip: on
        ? t('app.taskmon.mode-admin-hint')
        : t('app.taskmon.mode-normal-hint'),
      on,
      onClick: () => toggleAdmin(),
    });
  }

  function refreshBtn() {
    return sideAction({
      icon: 'reload',
      label: t('app.taskmon.action-refresh'),
      tip: t('app.taskmon.action-refresh-now'),
      onClick: () => refresh(),
    });
  }

  function sideTree() {
    return h('aside', { class: 'cmp-sidebar' }, [
      sidebarSections([{ items: pageItems() }], page.value, (id) => { page.next = id; }),
      h('div', { class: 'qx-side-spacer' }),
      admBtn(),
      refreshBtn(),
    ]);
  }

  function statusBits() {
    const num = (v, digits = 1) => (Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : '-');
    const bits = [];
    const l = list.value;
    if (l) {
      bits.push(tf('app.taskmon.stat-load', { v1: (num(l.load1, 2)), v2: (num(l.load5, 2)), v3: (num(l.load15, 2)) }));
      bits.push(tf('app.taskmon.stat-procs', { v1: (l.count) }));
      if (l.user) bits.push(tf('app.taskmon.stat-user', { v1: (l.user) }));
    }
    const s = sys.value;
    if (s) {
      bits.push(`CPU ${num(s.cpuPct)}%`);
      bits.push(tf('app.taskmon.stat-memory', { v1: (num(s.memUsed)), v2: (num(s.memTotal)) }));
      const up = uptimeSec();
      if (up != null) bits.push(tf('app.taskmon.stat-uptime', { v1: (fmtUptime(up)) }));
    }
    if (lastTick.value) {
      const at = new Date(lastTick.value).toLocaleTimeString('zh-CN', { hour12: false });
      bits.push(tf('app.taskmon.stat-updated', { v1: at }));
    }
    if (elevated.value) bits.push(t('app.taskmon.badge-elevated'));
    return bits;
  }

  function mainTree() {
    const err = errMetrics.value || errProcs.value;
    return h('div', { class: 'app-taskmon' }, [
      sideTree(),
      h('div', { class: 'tmon-content' }, [
        h('div', { class: `qx-err${err ? '' : ' hidden'}`, text: err, title: err }),
        make(page.value),
        statusBar(statusBits()),
      ]),
    ]);
  }

  const view = createView(el);
  view.update(mainTree);

  return {
    setPage(id) { page.next = id; },
    destroy() { view.unmount(); },
  };
}
