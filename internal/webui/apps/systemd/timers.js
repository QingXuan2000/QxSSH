/**
 * timers.js —— Systemd 定时任务 (Timers) 视图 (对齐官方应用网格架构)
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import {
  card,
  searchBox,
  spinner,
  emptyState,
  icon,
} from '/assets/js/core/components.js';

import * as api from './api.js';

export function createTimersView(deps) {
  const el = document.createElement('div');
  el.className = 'sd-fill';

  const loading = signal(false);
  const rawTimers = signal([]);
  const filterText = signal('');

  function getFilteredTimers() {
    const list = rawTimers.value;
    const q = filterText.value.toLowerCase().trim();
    if (!q) return list;
    return list.filter((tItem) =>
      tItem.unit.toLowerCase().includes(q) ||
      (tItem.activates || '').toLowerCase().includes(q) ||
      (tItem.next || '').toLowerCase().includes(q)
    );
  }

  async function loadData() {
    const host = deps.host();
    if (!host) return;
    loading.next = true;
    try {
      const list = await api.listTimers(host);
      rawTimers.next = list;
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      loading.next = false;
    }
  }

  async function triggerTimer(timer) {
    const host = deps.host();
    if (!host) return;
    try {
      const target = timer.activates || timer.unit;
      await api.unitAction(host, target, 'start');
      toast(t('app.systemd.timer-action-trigger-done'), 'success');
      loadData();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  function renderToolbar() {
    const searchNode = searchBox(
      t('app.systemd.filter-search-placeholder'),
      (val) => { filterText.next = val; },
      { value: filterText.value }
    );

    const endNodes = h('div', { class: 'sd-toolbar-actions' }, [
      h('button', {
        class: 'btn btn-sm btn-outline',
        onClick: loadData,
        title: t('app.systemd.action-refresh'),
      }, [
        h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }),
      ]),
    ]);

    return h('div', { class: 'sd-toolbar' }, [
      searchNode,
      endNodes,
    ]);
  }

  function renderGridHead() {
    return h('div', { class: 'sd-timer-head' }, [
      h('div', { text: t('app.systemd.timer-col-unit') }),
      h('div', { text: t('app.systemd.timer-col-activates') }),
      h('div', { text: t('app.systemd.timer-col-next') }),
      h('div', { text: t('app.systemd.timer-col-left') }),
      h('div', { class: 'sd-col-actions', text: t('app.systemd.col-actions') }),
    ]);
  }

  function renderGridRow(item) {
    return h('div', {
      key: item.unit,
      class: 'sd-timer-row',
      title: item.raw || '',
    }, [
      h('div', { class: 'mono font-medium truncate', title: item.unit, text: item.unit }),
      h('div', {
        class: 'mono text-primary cursor-pointer truncate',
        onClick: () => deps.openUnit?.(item.activates),
        title: item.activates || '-',
        text: item.activates || '-',
      }),
      h('div', { class: 'mono text-xs truncate', title: item.next || '-', text: item.next || '-' }),
      h('div', { class: 'mono sd-subtext truncate', title: item.last || '-', text: item.left || '-' }),
      h('div', { class: 'sd-col-actions' }, [
        h('button', {
          class: 'btn btn-sm btn-outline',
          onClick: () => triggerTimer(item),
          title: t('app.systemd.timer-action-trigger'),
        }, [
          h('span', { html: icon('play', 'qicon qicon-sm') }),
          h('span', { text: t('app.systemd.timer-action-trigger') }),
        ]),
      ]),
    ]);
  }

  function renderListScroll() {
    const list = getFilteredTimers();
    if (loading.value && !list.length) {
      return h('div', { class: 'qx-card-scroll py-12 flex justify-center' }, [spinner(t('app.systemd.loading'))]);
    }
    if (!list.length) {
      return h('div', { class: 'qx-card-scroll py-12 flex justify-center' }, [emptyState(t('app.systemd.empty-no-data'))]);
    }

    return h('div', { class: 'qx-card-scroll' }, [
      renderGridHead(),
      ...list.map(renderGridRow),
    ]);
  }

  const view = createView(el);
  view.update(() => {
    const list = getFilteredTimers();
    const countText = `${list.length} / ${rawTimers.value.length}`;

    return card(t('app.systemd.tab-timers'), [
      renderToolbar(),
      renderListScroll(),
    ], {
      fill: true,
      tools: h('span', { class: 'qx-count', text: countText }),
    });
  });

  return {
    el,
    refresh: loadData,
    statusBits: () => [
      {
        text: tf('app.systemd.stat-timers', { v1: rawTimers.value.length }),
        tip: t('app.systemd.tab-timers'),
      },
    ],
    dispose: () => {
      view.unmount();
    },
  };
}
