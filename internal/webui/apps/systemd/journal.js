/**
 * journal.js —— Systemd Journal 日志查看器 (对齐官方应用网格架构)
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import {
  card,
  searchBox,
  copyButton,
  LogPanel,
  spinner,
  emptyState,
  icon,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { downloadText } from './format.js';

export function createJournalView(deps) {
  const el = document.createElement('div');
  el.className = 'sd-fill';
  el.style.height = '100%';

  const loading = signal(false);
  const targetUnit = signal('');
  const linesCount = signal(100);
  const priority = signal('all');
  const since = signal('all');
  const boot = signal('all');
  const filterText = signal('');
  const rawLogs = signal([]);

  function unitsOf() {
    return String(targetUnit.value || '').split(/[\s,]+/).filter(Boolean);
  }

  function getFilteredLines() {
    const list = rawLogs.value;
    const q = filterText.value.toLowerCase().trim();
    if (!q) return list;
    return list.filter((l) => l.toLowerCase().includes(q));
  }

  async function fetchLogs() {
    const host = deps.host();
    if (!host) return;
    loading.next = true;
    try {
      const out = await api.fetchJournal(host, {
        units: unitsOf(),
        lines: linesCount.value,
        priority: priority.value,
        since: since.value,
        boot: boot.value === 'all' ? '' : boot.value,
      });
      const lines = out.split('\n').filter((l) => l.trim().length > 0);
      rawLogs.next = lines;
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      loading.next = false;
    }
  }

  function renderToolbar() {
    const unit = targetUnit.value;

    const unitInput = h('input', {
      type: 'text',
      class: 'input',
      style: { width: '160px', height: '28px', fontSize: '0.76rem' },
      placeholder: t('app.systemd.journal-target-system'),
      value: unit,
      onInput: (e) => { targetUnit.next = e.target.value.trim(); },
      onKeyDown: (e) => { if (e.key === 'Enter') fetchLogs(); },
    });

    const resetUnitBtn = unit ? h('button', {
      class: 'btn btn-sm btn-ghost',
      style: { height: '26px', padding: '0 6px' },
      onClick: () => { targetUnit.next = ''; fetchLogs(); },
      title: t('app.systemd.journal-target-system'),
    }, [h('span', { html: icon('close', 'qicon qicon-sm') })]) : null;

    const prioritySelect = h('select', {
      class: 'select',
      style: { width: '100px', height: '28px', fontSize: '0.76rem' },
      value: priority.value,
      onChange: (e) => { priority.next = e.target.value; fetchLogs(); },
    }, [
      h('option', { value: 'all', text: t('app.systemd.journal-priority-all') }),
      h('option', { value: 'err', text: t('app.systemd.journal-priority-err') }),
      h('option', { value: 'warning', text: t('app.systemd.journal-priority-warn') }),
      h('option', { value: 'info', text: t('app.systemd.journal-priority-info') }),
      h('option', { value: 'debug', text: t('app.systemd.journal-priority-debug') }),
    ]);

    const sinceSelect = h('select', {
      class: 'select',
      style: { width: '110px', height: '28px', fontSize: '0.76rem' },
      value: since.value,
      onChange: (e) => { since.next = e.target.value; fetchLogs(); },
    }, [
      h('option', { value: 'all', text: t('app.systemd.journal-since-all') }),
      h('option', { value: '15m', text: t('app.systemd.journal-since-15m') }),
      h('option', { value: '1h', text: t('app.systemd.journal-since-1h') }),
      h('option', { value: '24h', text: t('app.systemd.journal-since-24h') }),
      h('option', { value: '7d', text: t('app.systemd.journal-since-7d') }),
      h('option', { value: 'today', text: t('app.systemd.journal-since-today') }),
    ]);

    const bootSelect = h('select', {
      class: 'select',
      style: { width: '110px', height: '28px', fontSize: '0.76rem' },
      value: boot.value,
      onChange: (e) => { boot.next = e.target.value; fetchLogs(); },
    }, [
      h('option', { value: 'all', text: t('app.systemd.journal-boot-all') }),
      h('option', { value: 'current', text: t('app.systemd.journal-boot-current') }),
      h('option', { value: 'previous', text: t('app.systemd.journal-boot-previous') }),
    ]);

    const linesSelect = h('select', {
      class: 'select',
      style: { width: '90px', height: '28px', fontSize: '0.76rem' },
      value: String(linesCount.value),
      onChange: (e) => { linesCount.next = Number(e.target.value); fetchLogs(); },
    }, [
      h('option', { value: '50', text: tf('app.systemd.lines-option', { v1: '50' }) }),
      h('option', { value: '100', text: tf('app.systemd.lines-option', { v1: '100' }) }),
      h('option', { value: '200', text: tf('app.systemd.lines-option', { v1: '200' }) }),
      h('option', { value: '500', text: tf('app.systemd.lines-option', { v1: '500' }) }),
      h('option', { value: '1000', text: tf('app.systemd.lines-option', { v1: '1000' }) }),
    ]);

    const searchNode = searchBox(
      t('app.systemd.journal-search'),
      (val) => { filterText.next = val; },
      { value: filterText.value }
    );

    const endNodes = h('div', { class: 'sd-toolbar-actions' }, [
      h('button', {
        class: 'btn btn-sm btn-ghost',
        style: { height: '26px', padding: '0 8px' },
        onClick: () => {
          const name = `journal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.log`;
          if (!downloadText(name, rawLogs.value.join('\n'))) {
            toast(t('app.systemd.journal-download-failed'), 'danger');
          }
        },
        title: t('app.systemd.journal-download'),
      }, [
        h('span', { html: icon('download', 'qicon qicon-sm') }),
      ]),
      h('button', {
        class: 'btn btn-sm btn-ghost',
        style: { height: '26px', padding: '0 8px' },
        onClick: () => { rawLogs.next = []; },
      }, [
        h('span', { html: icon('trash-2', 'qicon qicon-sm') }),
        h('span', { text: t('app.systemd.journal-clear') }),
      ]),
      copyButton(() => rawLogs.value.join('\n')),
      h('button', {
        class: 'btn btn-sm btn-outline',
        style: { height: '26px' },
        onClick: fetchLogs,
        title: t('app.systemd.action-refresh'),
      }, [
        h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }),
      ]),
    ]);

    return h('div', { class: 'sd-toolbar' }, [
      searchNode,
      h('div', { class: 'flex items-center gap-1.5' }, [unitInput, resetUnitBtn].filter(Boolean)),
      prioritySelect,
      sinceSelect,
      bootSelect,
      linesSelect,
      endNodes,
    ]);
  }

  function renderLogBody() {
    const lines = getFilteredLines();
    if (loading.value && !lines.length) {
      return h('div', { class: 'qx-card-scroll py-12 flex justify-center' }, [spinner(t('app.systemd.loading'))]);
    }
    if (!lines.length) {
      return h('div', { class: 'qx-card-scroll py-12 flex justify-center' }, [emptyState(t('app.systemd.journal-empty'))]);
    }

    return h('div', { class: 'qx-card-scroll sd-log-scroll' }, [
      h('pre', {
        class: 'cmp-log mono',
        text: lines.join('\n'),
        ref: (node) => { if (node) node.scrollTop = node.scrollHeight; },
      }),
    ]);
  }

  const view = createView(el);
  view.update(() => {
    const list = getFilteredLines();
    const countText = tf('app.systemd.journal-count', { v1: list.length, v2: rawLogs.value.length });

    return card(t('app.systemd.tab-journal'), [
      renderToolbar(),
      renderLogBody(),
    ], {
      fill: true,
      tools: h('span', { class: 'qx-count', text: countText }),
    });
  });

  return {
    el,
    refresh: fetchLogs,
    setTargetUnit: (u) => {
      targetUnit.next = u || '';
      fetchLogs();
    },
    statusBits: () => [],
    dispose: () => {
      view.unmount();
    },
  };
}
