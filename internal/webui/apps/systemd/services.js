/**
 * services.js —— Systemd 服务管理视图 (对齐 Docker 与 Files 官方应用网格架构)
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { createSplitter } from '/assets/js/core/splitter.js';
import { toast } from '/assets/js/core/ui.js';
import {
  card,
  searchBox,
  chipGroup,
  badge,
  statusDot,
  copyButton,
  Tabs,
  kvGrid,
  JsonViewer,
  codeBlock,
  LogPanel,
  Checkbox,
  dialog,
  alertBar,
  spinner,
  emptyState,
  icon,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import {
  formatBytes,
  formatNanoCpu,
  formatUnitState,
  formatUnitFileState,
  formatStateLabel,
  formatTimestamp,
  parseDepsTree,
  downloadText,
} from './format.js';

export function createServicesView(deps) {
  const el = document.createElement('div');
  el.className = 'sd-body';

  const loading = signal(false);
  const rawUnits = signal([]);
  const systemState = signal({ state: '', isDegraded: false, isRunning: false, failedCount: 0 });

  const filterText = signal('');
  const filterType = signal('service');
  const filterState = signal('all');

  const selectedUnit = signal(null);   // 侧栏详情当前展示的单元
  const focusedUnit = signal(null);    // 列表里高亮的行，单击即改，与侧栏解耦
  const checkedUnits = signal(new Set());
  const detailTab = signal('overview');
  const detailLoading = signal(false);
  const detailProps = signal(null);
  const catContent = signal('');
  const depsContent = signal('');
  const unitLogs = signal('');

  let autoRefreshTimer = null;
  const autoRefreshRate = signal(0);

  // 列表与详情之间的可拖动分隔条 (对齐 Docker dk- 与 Files fm- 的官方实现)
  const panelRef = { current: null };
  let restoreTries = 0;
  const splitter = createSplitter({
    key: 'qx-sd-detailw',
    title: t('app.systemd.hint-resize-panel'),
    min: 320,
    pad: 340,
    getBody: () => el,
    getPanel: () => panelRef.current,
  });

  /** 详情面板挂载后恢复上次拖拽宽度；首帧布局未就绪时顺延重试 */
  function restorePanelWidth() {
    if (!panelRef.current) return;
    if (!el.clientWidth && restoreTries < 30) {
      restoreTries++;
      requestAnimationFrame(restorePanelWidth);
      return;
    }
    restoreTries = 0;
    splitter.restore();
  }

  function getStats() {
    const list = rawUnits.value;
    let active = 0;
    let inactive = 0;
    let failed = 0;
    for (const u of list) {
      if (u.active === 'active') active++;
      else if (u.active === 'inactive') inactive++;
      if (u.active === 'failed' || u.sub === 'failed') failed++;
    }
    return {
      total: list.length,
      active,
      inactive,
      failed,
    };
  }

  function getFilteredUnits() {
    const list = rawUnits.value;
    const q = filterText.value.toLowerCase().trim();
    const type = filterType.value;
    const state = filterState.value;

    return list.filter((u) => {
      if (type !== 'all' && u.unitType !== type) return false;

      if (state === 'active' && u.active !== 'active') return false;
      if (state === 'inactive' && u.active !== 'inactive') return false;
      if (state === 'failed' && u.active !== 'failed' && u.sub !== 'failed') return false;

      if (q) {
        const nameMatch = u.unit.toLowerCase().includes(q);
        const descMatch = (u.description || '').toLowerCase().includes(q);
        if (!nameMatch && !descMatch) return false;
      }
      return true;
    });
  }

  async function loadData() {
    const host = deps.host();
    if (!host) return;
    loading.next = true;
    try {
      const [uList, sysSt] = await Promise.all([
        api.listUnits(host),
        api.getSystemdState(host),
      ]);
      rawUnits.next = uList;
      systemState.next = sysSt;
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      loading.next = false;
      deps.changed?.();
    }
  }

  function handleAutoRefreshChange(sec) {
    const s = Number(sec);
    autoRefreshRate.next = s;
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (s > 0) {
      autoRefreshTimer = setInterval(() => {
        loadData();
      }, s * 1000);
    }
  }

  async function handleAction(unit, action) {
    const host = deps.host();
    if (!host) return;

    if (action === 'stop') {
      const confirmed = await deps.checkConfirm?.(
        t('app.systemd.confirm-stop-title'),
        tf('app.systemd.confirm-stop-desc', { v1: unit }),
        [],
        t('app.systemd.confirm-ok')
      );
      if (!confirmed) return;
    } else if (action === 'mask') {
      const confirmed = await deps.checkConfirm?.(
        t('app.systemd.confirm-mask-title'),
        tf('app.systemd.confirm-mask-desc', { v1: unit }),
        [],
        t('app.systemd.confirm-ok')
      );
      if (!confirmed) return;
    }

    try {
      await api.unitAction(host, unit, action);
      toast(t('app.systemd.action-success'), 'success');
      loadData();
      if (selectedUnit.value === unit) {
        openDetail(unit, detailTab.value);
      }
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function handleDaemonReload() {
    const host = deps.host();
    if (!host) return;
    try {
      await api.daemonReload(host);
      toast(t('app.systemd.action-daemon-reload-done'), 'success');
      loadData();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function handleResetAllFailed() {
    const host = deps.host();
    if (!host) return;
    try {
      await api.resetAllFailed(host);
      toast(t('app.systemd.action-reset-failed-done'), 'success');
      loadData();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  /* ---------------- 批量操作 ---------------- */

  function toggleCheck(unit, on) {
    const next = new Set(checkedUnits.value);
    if (on) next.add(unit);
    else next.delete(unit);
    checkedUnits.next = next;
  }

  function toggleCheckAll(on) {
    if (!on) {
      checkedUnits.next = new Set();
      return;
    }
    checkedUnits.next = new Set(getFilteredUnits().map((u) => u.unit));
  }

  async function handleBatch(action) {
    const host = deps.host();
    const units = Array.from(checkedUnits.value);
    if (!host || !units.length) return;

    if (action === 'stop' || action === 'disable') {
      const confirmed = await deps.checkConfirm?.(
        t('app.systemd.confirm-batch-title'),
        tf('app.systemd.confirm-batch-desc', { v1: units.length, v2: t(`app.systemd.action-${action}`) }),
        [],
        t('app.systemd.confirm-ok'),
      );
      if (!confirmed) return;
    }

    let ok = 0;
    const errs = [];
    for (const u of units) {
      try {
        await api.unitAction(host, u, action);
        ok += 1;
      } catch (e) {
        errs.push(`${u}: ${e.message || e}`);
      }
    }
    checkedUnits.next = new Set();
    await loadData();
    if (errs.length) {
      toast(tf('app.systemd.batch-done-partial', { v1: ok, v2: units.length, v3: errs[0] }), 'danger');
    } else {
      toast(tf('app.systemd.batch-done', { v1: ok }), 'success');
    }
  }

  /* ---------------- 诊断包 / 校验 ---------------- */

  function closeDialogButton(getDlg) {
    return h('button', {
      class: 'btn btn-sm btn-ghost',
      text: t('app.systemd.confirm-cancel'),
      onClick: () => getDlg().close(),
    });
  }

  async function handleDiagnose(unit) {
    const host = deps.host();
    if (!host) return;
    try {
      const text = await api.diagnoseUnit(host, unit);
      const dlg = dialog({
        title: tf('app.systemd.diagnose-title', { v1: unit }),
        width: 'lg',
        cls: 'sd-dialog-wide',
        body: [
          h('div', { class: 'flex flex-col gap-2 sd-dialog-code' }, [
            h('div', { class: 'flex justify-end gap-1.5' }, [
              copyButton(text),
              h('button', {
                class: 'btn btn-sm btn-outline',
                onClick: () => {
                  const name = `${unit.replace(/[^\w.-]+/g, '_')}-diagnose.txt`;
                  if (!downloadText(name, text)) {
                    toast(t('app.systemd.diagnose-download-failed'), 'danger');
                  }
                },
              }, [
                h('span', { html: icon('download', 'qicon qicon-sm') }),
                h('span', { text: t('app.systemd.diagnose-download') }),
              ]),
            ]),
            codeBlock(text),
          ]),
        ],
        actions: [closeDialogButton(() => dlg)],
        onClose: () => {},
      });
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function handleVerify(unit) {
    const host = deps.host();
    if (!host) return;
    try {
      const out = await api.verifyUnit(host, unit);
      const dlg = dialog({
        title: tf('app.systemd.verify-title', { v1: unit }),
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
        actions: [closeDialogButton(() => dlg)],
        onClose: () => {},
      });
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function openDetail(unit, tab = 'overview') {
    selectedUnit.next = unit;
    focusedUnit.next = unit;
    detailTab.next = tab;
    detailLoading.next = true;
    detailProps.next = null;
    catContent.next = '';
    depsContent.next = '';
    unitLogs.next = '';

    const host = deps.host();
    try {
      if (tab === 'overview' || tab === 'props') {
        const p = await api.getUnitDetail(host, unit);
        detailProps.next = p;
      } else if (tab === 'config') {
        const c = await api.getUnitCat(host, unit);
        catContent.next = c;
      } else if (tab === 'deps') {
        const d = await api.getUnitDependencies(host, unit);
        depsContent.next = d;
      } else if (tab === 'journal') {
        const l = await api.fetchJournal(host, { unit, lines: 50 });
        unitLogs.next = l;
      }
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      detailLoading.next = false;
    }
  }

  // 批量操作条：仅在勾选单元后出现，图标按钮保持单行不致换行
  function renderBatchBar() {
    const n = checkedUnits.value.size;
    if (!n) return null;
    const btn = (iconName, key, action, danger) => h('button', {
      class: `btn btn-sm ${danger ? 'btn-danger' : 'btn-outline'}`,
      title: t(key),
      onClick: () => handleBatch(action),
    }, [h('span', { html: icon(iconName, 'qicon qicon-sm') })]);

    return h('div', { class: 'sd-batch' }, [
      h('span', { class: 'sd-batch-count', text: tf('app.systemd.batch-selected', { v1: n }) }),
      btn('play', 'app.systemd.action-start', 'start', false),
      btn('rotate-cw', 'app.systemd.action-restart', 'restart', false),
      btn('square', 'app.systemd.action-stop', 'stop', true),
      btn('power', 'app.systemd.action-enable', 'enable', false),
      btn('ban', 'app.systemd.action-disable', 'disable', false),
      btn('eraser', 'app.systemd.action-reset', 'reset-failed', false),
      h('button', {
        class: 'btn btn-sm btn-ghost',
        title: t('app.systemd.batch-clear'),
        onClick: () => toggleCheckAll(false),
      }, [h('span', { html: icon('x', 'qicon qicon-sm') })]),
    ]);
  }

  // 1. 卡片工具栏 (参考 Docker dk-toolbar 单行整洁设计)
  function renderToolbar() {
    const st = getStats();
    const filterDefs = [
      { id: 'all', label: `${t('app.systemd.filter-state-all')} (${st.total})` },
      { id: 'active', label: `${t('app.systemd.filter-state-active')} (${st.active})` },
      { id: 'inactive', label: `${t('app.systemd.filter-state-inactive')} (${st.inactive})` },
      { id: 'failed', label: `${t('app.systemd.filter-state-failed')} (${st.failed})` },
    ];

    const searchNode = searchBox(
      t('app.systemd.filter-search-placeholder'),
      (val) => { filterText.next = val; },
      { value: filterText.value }
    );

    const chips = chipGroup(
      filterDefs,
      filterState.value,
      (id) => { filterState.next = id; }
    );

    const typeSelect = h('select', {
      class: 'select',
      style: { width: '130px', height: '28px', fontSize: '0.76rem' },
      value: filterType.value,
      onChange: (e) => { filterType.next = e.target.value; },
    }, [
      h('option', { value: 'service', text: t('app.systemd.filter-type-service') }),
      h('option', { value: 'all', text: t('app.systemd.filter-type-all') }),
      h('option', { value: 'socket', text: t('app.systemd.filter-type-socket') }),
      h('option', { value: 'timer', text: t('app.systemd.filter-type-timer') }),
      h('option', { value: 'target', text: t('app.systemd.filter-type-target') }),
      h('option', { value: 'mount', text: t('app.systemd.filter-type-mount') }),
      h('option', { value: 'path', text: t('app.systemd.filter-type-path') }),
    ]);

    const rateSelect = h('select', {
      class: 'select',
      style: { height: '28px', fontSize: '0.76rem' },
      value: String(autoRefreshRate.value),
      onChange: (e) => handleAutoRefreshChange(e.target.value),
    }, [
      h('option', { value: '0', text: t('app.systemd.autorefresh-off') }),
      h('option', { value: '5', text: t('app.systemd.autorefresh-5s') }),
      h('option', { value: '10', text: t('app.systemd.autorefresh-10s') }),
      h('option', { value: '30', text: t('app.systemd.autorefresh-30s') }),
    ]);

    const actions = h('div', { class: 'sd-toolbar-actions' }, [
      rateSelect,
      h('button', {
        class: 'btn btn-sm btn-outline',
        onClick: handleDaemonReload,
        title: t('app.systemd.action-daemon-reload-hint'),
      }, [
        h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }),
        h('span', { text: t('app.systemd.action-daemon-reload') }),
      ]),
      systemState.value.failedCount > 0 ? h('button', {
        class: 'btn btn-sm btn-danger',
        onClick: handleResetAllFailed,
        title: t('app.systemd.action-reset-failed-hint'),
      }, [
        h('span', { html: icon('circle-alert', 'qicon qicon-sm') }),
        h('span', { text: t('app.systemd.action-reset-failed') }),
      ]) : null,
      h('button', {
        class: 'btn btn-sm btn-outline',
        onClick: loadData,
        title: t('app.systemd.action-refresh'),
      }, [
        h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }),
      ]),
    ].filter(Boolean));

    return h('div', { class: 'sd-toolbar' }, [
      searchNode,
      chips,
      typeSelect,
      renderBatchBar(),
      actions,
    ].filter(Boolean));
  }

  // 2. 网格列表表头 (与行保持绝对一致的 Grid 轨道)
  function renderGridHead() {
    const list = getFilteredUnits();
    const allChecked = list.length > 0 && list.every((u) => checkedUnits.value.has(u.unit));
    return h('div', { class: 'sd-grid-head' }, [
      h('div', { class: 'sd-col-check' }, [
        h(Checkbox, {
          key: `all:${allChecked ? 1 : 0}`,
          checked: allChecked,
          onChange: (v) => toggleCheckAll(v),
        }),
      ]),
      h('div', { text: t('app.systemd.col-state') }),
      h('div', { text: t('app.systemd.col-unit') }),
      h('div', { text: t('app.systemd.col-enabled') }),
      h('div', { text: t('app.systemd.col-sub') }),
      h('div', { text: t('app.systemd.col-desc') }),
      h('div', { class: 'sd-col-actions', text: t('app.systemd.col-actions') }),
    ]);
  }

  // 3. 网格列表单行
  function renderGridRow(u) {
    const isSelected = focusedUnit.value === u.unit;
    const isChecked = checkedUnits.value.has(u.unit);
    const st = formatUnitState(u.active, u.sub);
    const fst = formatUnitFileState(u.unitFileState);
    const isActive = u.active === 'active';

    return h('div', {
      key: u.unit,
      class: `sd-grid-row${isSelected ? ' selected' : ''}${isChecked ? ' checked' : ''}`,
      // 与 Docker 应用一致：单击只移动行焦点，双击才唤出右侧详情栏
      onClick: () => { focusedUnit.next = u.unit; },
      onDblclick: () => openDetail(u.unit, detailTab.value || 'overview'),
    }, [
      // 勾选
      h('div', { class: 'sd-col-check', onClick: (e) => e.stopPropagation() }, [
        h(Checkbox, {
          key: `${u.unit}:${isChecked ? 1 : 0}`,
          checked: isChecked,
          onChange: (v) => toggleCheck(u.unit, v),
        }),
      ]),
      // 状态
      h('div', { class: 'sd-col-status' }, [
        statusDot(st.kind),
        badge(st.label, st.kind),
      ]),
      // 名称
      h('div', { class: 'sd-col-name', title: u.unit }, [
        h('span', { text: u.unit }),
      ]),
      // 自启
      h('div', { class: 'sd-col-enabled' }, [
        badge(fst.label, fst.kind),
      ]),
      // 子状态
      h('div', { class: 'sd-col-sub mono sd-subtext', text: formatStateLabel(u.sub) }),
      // 描述
      h('div', { class: 'sd-col-desc', title: u.description || '', text: u.description || '-' }),
      // 操作
      h('div', { class: 'sd-col-actions', onClick: (e) => e.stopPropagation() }, [
        isActive ? h('button', {
          class: 'btn btn-sm btn-outline',
          onClick: () => handleAction(u.unit, 'restart'),
          title: t('app.systemd.action-restart'),
        }, [
          h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }),
        ]) : null,
        isActive ? h('button', {
          class: 'btn btn-sm btn-danger',
          onClick: () => handleAction(u.unit, 'stop'),
          title: t('app.systemd.action-stop'),
        }, [
          h('span', { html: icon('square', 'qicon qicon-sm') }),
        ]) : h('button', {
          class: 'btn btn-sm btn-outline',
          onClick: () => handleAction(u.unit, 'start'),
          title: t('app.systemd.action-start'),
        }, [
          h('span', { html: icon('play', 'qicon qicon-sm') }),
        ]),
        h('button', {
          class: 'btn btn-sm btn-outline',
          onClick: (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const menuItems = [
              { label: t('app.systemd.action-detail'), onClick: () => openDetail(u.unit, 'overview') },
              { label: t('app.systemd.action-logs'), onClick: () => deps.openJournal?.(u.unit) },
              { label: t('app.systemd.action-cat'), onClick: () => openDetail(u.unit, 'config') },
              { label: t('app.systemd.action-props'), onClick: () => openDetail(u.unit, 'props') },
              'sep',
              { label: t('app.systemd.action-diagnose'), onClick: () => handleDiagnose(u.unit) },
              { label: t('app.systemd.action-verify'), onClick: () => handleVerify(u.unit) },
              'sep',
              { label: t('app.systemd.action-reload'), onClick: () => handleAction(u.unit, 'reload') },
              u.unitFileState.startsWith('enabled')
                ? { label: t('app.systemd.action-disable'), onClick: () => handleAction(u.unit, 'disable') }
                : { label: t('app.systemd.action-enable'), onClick: () => handleAction(u.unit, 'enable') },
              u.unitFileState.startsWith('masked')
                ? { label: t('app.systemd.action-unmask'), onClick: () => handleAction(u.unit, 'unmask') }
                : { label: t('app.systemd.action-mask'), onClick: () => handleAction(u.unit, 'mask') },
            ];
            if (u.active === 'failed' || u.sub === 'failed') {
              menuItems.push({ label: t('app.systemd.action-reset'), onClick: () => handleAction(u.unit, 'reset-failed') });
            }
            deps.menu?.(rect.left, rect.bottom + 4, menuItems);
          },
        }, [h('span', { html: icon('more-horizontal', 'qicon qicon-sm') })]),
      ].filter(Boolean)),
    ]);
  }

  // 4. 网格列表滚动区
  function renderListScroll() {
    const list = getFilteredUnits();
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

  // 5. 右侧分栏详情卡片 (与 Docker dk-detail 同风格)
  function renderDetailPane() {
    const unit = selectedUnit.value;
    if (!unit) return null;

    const curTab = detailTab.value;
    const isLoad = detailLoading.value;

    const tabItems = [
      { id: 'overview', label: t('app.systemd.detail-tab-overview') },
      { id: 'config', label: t('app.systemd.detail-tab-config') },
      { id: 'deps', label: t('app.systemd.detail-tab-deps') },
      { id: 'props', label: t('app.systemd.detail-tab-props') },
      { id: 'journal', label: t('app.systemd.detail-tab-journal') },
    ];

    return h('div', {
      class: 'sd-detail',
      ref: (node) => {
        panelRef.current = node;
        if (!node) return;
        restoreTries = 0;
        requestAnimationFrame(restorePanelWidth);
      },
    }, [
      h('div', { class: 'sd-detail-head' }, [
        h('div', { class: 'sd-detail-title-group' }, [
          h('span', { class: 'sd-detail-title mono', text: unit }),
        ]),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          onClick: () => { selectedUnit.next = null; },
        }, [h('span', { html: icon('close', 'qicon qicon-sm') })]),
      ]),
      h('div', {
        class: 'sd-detail-tabs',
        ref: (node) => {
          if (!node) return;
          const active = node.querySelector('.cmp-tab-top.active');
          if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        },
      }, [
        Tabs({
          items: tabItems,
          active: curTab,
          onChange: (nextId) => openDetail(unit, nextId),
        }),
      ]),
      h('div', { class: 'sd-detail-body' }, [
        isLoad ? h('div', { class: 'py-8 flex justify-center' }, [spinner(t('app.systemd.loading'))]) : renderDetailContent(curTab, unit),
      ]),
    ]);
  }

  function renderDetailContent(tab, unit) {
    if (tab === 'overview') {
      const p = detailProps.value;
      if (!p) return emptyState(t('app.systemd.empty-no-data'));

      // kvGrid 接收 [label, value] 元组数组，传对象会让解构抛 not iterable
      const pairs = [
        [t('app.systemd.prop-main-pid'), p.MainPID && p.MainPID !== '0' ? p.MainPID : '-'],
        [t('app.systemd.prop-memory'), formatBytes(p.MemoryCurrent)],
        [t('app.systemd.prop-cpu'), formatNanoCpu(p.CPUUsageNSec)],
        [t('app.systemd.prop-tasks'), p.TasksCurrent || '-'],
        [t('app.systemd.prop-active-time'), formatTimestamp(p.ActiveEnterTimestamp)],
        [t('app.systemd.prop-working-dir'), p.WorkingDirectory || '-'],
        [t('app.systemd.prop-exec-start'), p.ExecStart || '-'],
        [t('app.systemd.prop-fragment-path'), p.FragmentPath || '-'],
        [t('app.systemd.prop-dropin-paths'), p.DropInPaths || '-'],
        [t('app.systemd.prop-docs'), p.Documentation || '-'],
      ];

      return kvGrid(pairs, { cols: 1 });
    }

    if (tab === 'config') {
      const code = catContent.value;
      return h('div', { class: 'flex flex-col gap-2' }, [
        h('div', { class: 'flex justify-end' }, [copyButton(code)]),
        codeBlock(code || t('app.systemd.empty-no-data')),
      ]);
    }

    if (tab === 'deps') {
      const depsText = depsContent.value;
      if (!depsText.trim()) return emptyState(t('app.systemd.empty-no-data'));
      // systemctl list-dependencies 的树形文本 → 嵌套对象，交给官方 JsonViewer 渲染
      // JsonViewer 内部用 useState 存展开状态，必须以 h(组件) 挂载才有实例槽位
      return h('div', { class: 'flex flex-col gap-2' }, [
        h('div', { class: 'flex justify-end' }, [copyButton(depsText)]),
        h(JsonViewer, { value: parseDepsTree(depsText), maxDepth: 2 }),
      ]);
    }

    if (tab === 'props') {
      const p = detailProps.value;
      if (!p) return emptyState(t('app.systemd.empty-no-data'));
      return h(JsonViewer, { value: p, maxDepth: 1 });
    }

    if (tab === 'journal') {
      const logs = unitLogs.value;
      const lines = logs.split('\n').filter((l) => l.trim().length > 0);
      return h('div', { class: 'flex flex-col gap-2' }, [
        h('div', { class: 'flex items-center justify-between' }, [
          h('button', {
            class: 'btn btn-sm btn-outline',
            onClick: () => deps.openJournal?.(unit),
          }, [
            h('span', { html: icon('external-link', 'qicon qicon-sm') }),
            h('span', { text: t('app.systemd.journal-goto') }),
          ]),
          copyButton(logs),
        ]),
        LogPanel({ lines, maxHeight: '380px' }),
      ]);
    }

    return null;
  }

  const view = createView(el);
  view.update(() => {
    const filtered = getFilteredUnits();
    const countText = `${filtered.length} / ${rawUnits.value.length}`;
    const failed = systemState.value.failedCount;

    const banner = failed > 0 && filterState.value !== 'failed'
      ? h('div', {
        class: 'sd-banner',
        onClick: () => { filterState.next = 'failed'; },
      }, [
        alertBar(
          'error',
          tf('app.systemd.failed-banner', { v1: failed }),
          t('app.systemd.failed-banner-tip'),
        ),
      ])
      : null;

    const listCard = card(t('app.systemd.tab-services'), [
      banner,
      renderToolbar(),
      renderListScroll(),
    ].filter(Boolean), {
      fill: true,
      tools: h('span', { class: 'qx-count', text: countText }),
    });

    const pane = renderDetailPane();
    if (!pane) panelRef.current = null;
    splitter.setHidden(!pane);
    if (pane) splitter.el.title = t('app.systemd.hint-resize-panel');

    return [
      h('div', { class: 'sd-listcol' }, [listCard]),
      splitter.el,
      pane,
    ].filter(Boolean);
  });

  return {
    el,
    refresh: loadData,
    // 供其它视图跳转：切到服务列表并直接打开该单元详情
    setTargetUnit: (unit) => {
      const name = String(unit || '').trim();
      if (!name) return;
      filterState.next = 'all';
      filterText.next = '';
      openDetail(name, 'overview');
    },
    statusBits: () => {
      const st = systemState.value;
      const bits = [];
      if (st.state) {
        bits.push({
          text: tf('app.systemd.system-running', { v1: formatStateLabel(st.state) }),
          tip: st.isDegraded ? t('app.systemd.system-degraded') : st.state,
        });
      }
      if (st.failedCount > 0) {
        bits.push({
          text: tf('app.systemd.failed-count', { v1: st.failedCount }),
          tip: t('app.systemd.stat-failed'),
        });
      }
      return bits;
    },
    dispose: () => {
      splitter.destroy();
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      view.unmount();
    },
  };
}
