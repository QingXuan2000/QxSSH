/**
 * sockets.js —— Systemd 套接字 (Sockets) 视图 (对齐官方应用网格架构)
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

export function createSocketsView(deps) {
  const el = document.createElement('div');
  el.className = 'sd-fill';

  const loading = signal(false);
  const rawSockets = signal([]);
  const filterText = signal('');

  function getFilteredSockets() {
    const list = rawSockets.value;
    const q = filterText.value.toLowerCase().trim();
    if (!q) return list;
    return list.filter((sItem) =>
      sItem.unit.toLowerCase().includes(q) ||
      sItem.listen.toLowerCase().includes(q) ||
      (sItem.activates || '').toLowerCase().includes(q)
    );
  }

  async function loadData() {
    const host = deps.host();
    if (!host) return;
    loading.next = true;
    try {
      const list = await api.listSockets(host);
      rawSockets.next = list;
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      loading.next = false;
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
    return h('div', { class: 'sd-socket-head' }, [
      h('div', { text: t('app.systemd.socket-col-listen') }),
      h('div', { text: t('app.systemd.socket-col-unit') }),
      h('div', { text: t('app.systemd.socket-col-activates') }),
      h('div', { class: 'sd-col-actions', text: t('app.systemd.col-actions') }),
    ]);
  }

  function renderGridRow(item) {
    return h('div', { key: item.unit, class: 'sd-socket-row' }, [
      h('div', { class: 'mono font-medium truncate', title: item.listen || '-', text: item.listen || '-' }),
      h('div', { class: 'mono sd-subtext truncate', title: item.unit, text: item.unit }),
      h('div', {
        class: 'mono text-primary cursor-pointer truncate',
        onClick: () => deps.openUnit?.(item.activates),
        title: item.activates || '-',
        text: item.activates || '-',
      }),
      h('div', { class: 'sd-col-actions' }, [
        h('button', {
          class: 'btn btn-sm btn-outline',
          onClick: async () => {
            const host = deps.host();
            if (!host) return;
            try {
              await api.unitAction(host, item.unit, 'restart');
              toast(t('app.systemd.action-success'), 'success');
              loadData();
            } catch (e) {
              toast(e.message || String(e), 'danger');
            }
          },
          title: t('app.systemd.action-restart'),
        }, [
          h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }),
        ]),
      ]),
    ]);
  }

  function renderListScroll() {
    const list = getFilteredSockets();
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
    const list = getFilteredSockets();
    const countText = `${list.length} / ${rawSockets.value.length}`;

    return card(t('app.systemd.tab-sockets'), [
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
        text: tf('app.systemd.stat-sockets', { v1: rawSockets.value.length }),
        tip: t('app.systemd.tab-sockets'),
      },
    ],
    dispose: () => {
      view.unmount();
    },
  };
}
