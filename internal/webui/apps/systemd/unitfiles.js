/**
 * unitfiles.js —— 单元文件清单（list-unit-files）与开机自启管理
 * 价值：一次性看清 enabled / disabled / static / masked / generated / indirect 全貌
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import {
  card,
  badge,
  chipGroup,
  searchBox,
  spinner,
  emptyState,
  icon,
  dialog,
  codeBlock,
  copyButton,
} from '/assets/js/core/components.js';

import * as api from './api.js';

const FILTERS = ['all', 'enabled', 'disabled', 'static', 'masked'];

/** unit-file 状态 → 徽章语义 */
function stateKind(state) {
  const s = String(state || '').toLowerCase();
  if (s.startsWith('enabled')) return 'success';
  if (s.startsWith('disabled')) return 'neutral';
  if (s.startsWith('masked')) return 'danger';
  if (s === 'static') return 'info';
  if (s === 'generated') return 'warning';
  if (s === 'indirect') return 'warning';
  return 'default';
}

function matchFilter(state, filter) {
  const s = String(state || '').toLowerCase();
  if (filter === 'all') return true;
  if (filter === 'enabled') return s.startsWith('enabled');
  if (filter === 'disabled') return s.startsWith('disabled');
  if (filter === 'static') return s === 'static' || s === 'indirect';
  if (filter === 'masked') return s.startsWith('masked');
  return true;
}

export function createUnitFilesView(deps) {
  const el = document.createElement('div');
  el.className = 'sd-fill';

  const loading = signal(false);
  const rawFiles = signal([]);
  const filterText = signal('');
  const filterState = signal('all');

  function filtered() {
    const q = filterText.value.toLowerCase().trim();
    return rawFiles.value.filter((f) => {
      if (!matchFilter(f.state, filterState.value)) return false;
      if (!q) return true;
      return f.unit.toLowerCase().includes(q);
    });
  }

  function counts() {
    const list = rawFiles.value;
    const out = { all: list.length, enabled: 0, disabled: 0, static: 0, masked: 0 };
    for (const f of list) {
      for (const key of FILTERS) {
        if (key !== 'all' && matchFilter(f.state, key)) out[key]++;
      }
    }
    return out;
  }

  async function loadData() {
    const host = deps.host();
    if (!host) return;
    loading.next = true;
    try {
      rawFiles.next = await api.listUnitFiles(host);
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      loading.next = false;
    }
  }

  async function runAction(unit, action) {
    const host = deps.host();
    if (!host) return;
    try {
      await api.unitAction(host, unit, action);
      toast(t('app.systemd.action-success'), 'success');
      loadData();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function showVerify(unit) {
    const host = deps.host();
    if (!host) return;
    let out;
    try {
      out = await api.verifyUnit(host, unit);
    } catch (e) {
      toast(e.message || String(e), 'danger');
      return;
    }
    const dlg = dialog({
      title: tf('app.systemd.unitfiles-verify-title', { v1: unit }),
      width: 'lg',
      cls: 'sd-dialog-wide',
      body: [
        h('div', { class: 'flex flex-col gap-2 sd-dialog-code' }, [
          h('div', { class: 'flex items-center justify-between' }, [
            badge(
              out.ok ? t('app.systemd.unitfiles-verify-ok') : t('app.systemd.unitfiles-verify-bad'),
              out.ok ? 'success' : 'danger',
            ),
            copyButton(out.output),
          ]),
          codeBlock(out.output),
        ]),
      ],
      actions: [
        h('button', {
          class: 'btn btn-sm btn-ghost',
          text: t('app.systemd.confirm-cancel'),
          onClick: () => dlg.close(),
        }),
      ],
      onClose: () => {},
    });
  }

  function renderToolbar() {
    const c = counts();
    const chips = chipGroup(
      FILTERS.map((id) => ({
        id,
        label: id === 'all'
          ? `${t('app.systemd.unitfiles-filter-all')} (${c.all})`
          : `${t(`app.systemd.unitfiles-filter-${id}`)} (${c[id]})`,
      })),
      filterState.value,
      (id) => { filterState.next = id; },
    );

    return h('div', { class: 'sd-toolbar' }, [
      searchBox(
        t('app.systemd.filter-search-placeholder'),
        (val) => { filterText.next = val; },
        { value: filterText.value },
      ),
      chips,
      h('div', { class: 'sd-toolbar-actions' }, [
        h('button', {
          class: 'btn btn-sm btn-outline',
          onClick: loadData,
          title: t('app.systemd.action-refresh'),
        }, [
          h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }),
        ]),
      ]),
    ]);
  }

  function renderHead() {
    return h('div', { class: 'uf-grid-head' }, [
      h('div', { text: t('app.systemd.col-unit') }),
      h('div', { text: t('app.systemd.col-enabled') }),
      h('div', { text: t('app.systemd.unitfiles-col-preset') }),
      h('div', { text: t('app.systemd.unitfiles-col-type') }),
      h('div', { class: 'sd-col-actions', text: t('app.systemd.col-actions') }),
    ]);
  }

  function renderRow(f) {
    const isEnabled = f.state.startsWith('enabled');
    const isMasked = f.state.startsWith('masked');

    return h('div', { key: f.unit, class: 'uf-grid-row' }, [
      h('div', { class: 'mono truncate', title: f.unit, text: f.unit }),
      h('div', null, [badge(f.state, stateKind(f.state))]),
      h('div', { class: 'mono sd-subtext', text: f.preset || '-' }),
      h('div', { class: 'sd-subtext', text: f.unitType }),
      h('div', { class: 'sd-col-actions' }, [
        h('button', {
          class: `btn btn-sm ${isEnabled ? 'btn-outline' : 'btn-primary'}`,
          title: isEnabled ? t('app.systemd.action-disable') : t('app.systemd.action-enable'),
          onClick: () => runAction(f.unit, isEnabled ? 'disable' : 'enable'),
        }, [
          h('span', { html: icon('power', 'qicon qicon-sm') }),
        ]),
        h('button', {
          class: `btn btn-sm ${isMasked ? 'btn-outline' : 'btn-ghost'}`,
          title: isMasked ? t('app.systemd.action-unmask') : t('app.systemd.action-mask'),
          onClick: () => runAction(f.unit, isMasked ? 'unmask' : 'mask'),
        }, [
          h('span', { html: icon('ban', 'qicon qicon-sm') }),
        ]),
        h('button', {
          class: 'btn btn-sm btn-ghost',
          title: t('app.systemd.unitfiles-action-verify'),
          onClick: () => showVerify(f.unit),
        }, [
          h('span', { html: icon('shield-check', 'qicon qicon-sm') }),
        ]),
        h('button', {
          class: 'btn btn-sm btn-ghost',
          title: t('app.systemd.action-detail'),
          onClick: () => deps.openUnit?.(f.unit),
        }, [
          h('span', { html: icon('more-horizontal', 'qicon qicon-sm') }),
        ]),
      ]),
    ]);
  }

  function renderList() {
    const list = filtered();
    if (loading.value && !list.length) {
      return h('div', { class: 'qx-card-scroll py-12 flex justify-center' }, [spinner(t('app.systemd.loading'))]);
    }
    if (!list.length) {
      return h('div', { class: 'qx-card-scroll py-12 flex justify-center' }, [emptyState(t('app.systemd.empty-no-data'))]);
    }
    return h('div', { class: 'qx-card-scroll' }, [
      renderHead(),
      ...list.map(renderRow),
    ]);
  }

  const view = createView(el);
  view.update(() => {
    const list = filtered();
    return card(t('app.systemd.tab-unitfiles'), [
      renderToolbar(),
      renderList(),
    ], {
      fill: true,
      tools: h('span', { class: 'qx-count', text: `${list.length} / ${rawFiles.value.length}` }),
    });
  });

  return {
    el,
    refresh: loadData,
    statusBits: () => [{
      text: tf('app.systemd.stat-unitfiles', { v1: rawFiles.value.length }),
      tip: t('app.systemd.tab-unitfiles'),
    }],
    dispose: () => {
      view.unmount();
    },
  };
}
