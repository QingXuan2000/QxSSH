/**
 * app.js —— Systemd 管理器主入口 (基于官方组件规范)
 */
import { lang, onLangChange, setupI18n, t, tf } from '/assets/js/core/i18n.js';
import { h } from '/assets/js/core/vdom.js';
import { bootApp } from '/assets/js/app-bridge.js';
import { signal } from '/assets/js/core/signal.js';
import { getState } from '/assets/js/core/store.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import {
  alertBar,
  dialog,
  menu,
  sidebarSections,
  statusBar,
  sideAction,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { createServicesView } from './services.js';
import { createJournalView } from './journal.js';
import { createTimersView } from './timers.js';
import { createSocketsView } from './sockets.js';
import { createAnalyzeView } from './analyze.js';
import { createUnitFilesView } from './unitfiles.js';

const TAB_DEFS = [
  { id: 'services', key: 'app.systemd.tab-services', icon: 'layers' },
  { id: 'journal', key: 'app.systemd.tab-journal', icon: 'file-text' },
  { id: 'timers', key: 'app.systemd.tab-timers', icon: 'clock' },
  { id: 'sockets', key: 'app.systemd.tab-sockets', icon: 'cable' },
  { id: 'unitfiles', key: 'app.systemd.tab-unitfiles', icon: 'file-cog' },
  { id: 'analyze', key: 'app.systemd.tab-analyze', icon: 'activity' },
];

function tabsNow() {
  return TAB_DEFS.map((d) => ({
    id: d.id,
    icon: d.icon,
    label: d.key ? t(d.key) : d.id,
  }));
}

function boot(el, ctx) {
  const hostId = (ctx && ctx.hostId) || '';

  const systemdState = signal('');
  const systemdErr = signal('');
  const statusBits = signal([]);

  const deps = {
    host: () => hostId,
    menu: showMenu,
    checkConfirm,
    openJournal: (unit) => {
      shell.setActive('journal');
      show('journal');
      const v = getView('journal');
      v.setTargetUnit?.(unit);
    },
    openUnit: (unit) => {
      shell.setActive('services');
      show('services');
      getView('services').setTargetUnit?.(unit);
    },
    changed: refreshStatus,
  };

  const FACTORIES = {
    services: createServicesView,
    journal: createJournalView,
    timers: createTimersView,
    sockets: createSocketsView,
    unitfiles: createUnitFilesView,
    analyze: createAnalyzeView,
  };
  const viewCache = {};
  let cur = null;

  function SystemdNote() {
    lang();
    const st = systemdState.value;
    const err = systemdErr.value;
    return h('span', {
      class: 'qx-side-note',
      text: err ? '' : (st ? tf('app.systemd.system-running', { v1: st }) : t('app.systemd.system-detecting')),
    });
  }

  function RefreshAction() {
    lang();
    return sideAction({
      icon: 'rotate-cw',
      label: t('app.systemd.action-refresh'),
      tip: t('app.systemd.action-refresh-hint'),
      onClick: () => cur?.refresh?.(),
    });
  }

  async function fetchInfo() {
    if (!hostId) {
      systemdErr.next = 'No host connected';
      refreshStatus();
      return;
    }
    try {
      const chk = await api.checkSystemd(hostId);
      if (!chk.isSystemd) {
        systemdErr.next = chk.error || t('app.systemd.not-systemd');
        systemdState.next = '';
      } else {
        systemdState.next = chk.state;
        systemdErr.next = '';
      }
    } catch (e) {
      systemdState.next = '';
      systemdErr.next = e.message || String(e);
    }
    refreshStatus();
  }

  function checkConfirm(title, desc, checks = [], okText = t('app.systemd.confirm-ok')) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        dlg.close();
        resolve(v);
      };
      const dlg = dialog({
        width: 'sm',
        body: [
          h('div', { class: 'confirm-body' }, [
            h('div', { class: 'confirm-content' }, [
              h('div', { class: 'confirm-title font-semibold mb-2', text: title }),
              h('div', { class: 'confirm-desc text-muted text-sm', text: desc }),
            ]),
          ]),
        ],
        actions: [
          h('button', {
            class: 'btn btn-ghost btn-sm',
            text: t('app.systemd.confirm-cancel'),
            onClick: () => finish(false),
          }),
          h('button', {
            class: 'btn btn-danger btn-sm',
            text: okText,
            onClick: () => finish(true),
          }),
        ],
        onClose: () => finish(false),
      });
    });
  }

  function showMenu(x, y, items) {
    menu(items.map((it) => (it === 'sep' ? { sep: true } : it)), { x, y });
  }

  const contentHost = document.createElement('div');
  contentHost.className = 'qx-main';

  const shell = createAppShell(el, {
    tabs: tabsNow,
    active: 'services',
    onChange: show,
    sideTop: [sidebarSections([{ node: h(SystemdNote, {}) }])],
    actions: [h(RefreshAction, {})],
  });

  function mainTree() {
    const err = systemdErr.value;
    return h('div', { class: 'app-root' }, [
      err ? h('div', { style: { padding: '12px 18px 0 18px' } }, [
        alertBar('error', t('app.systemd.not-systemd'), t('app.systemd.not-systemd-tip')),
      ]) : null,
      contentHost,
      statusBar(statusBits.value),
    ]);
  }

  shell.setMain(mainTree);

  const offLang = onLangChange(() => refreshStatus());

  function getView(id) {
    if (!viewCache[id]) viewCache[id] = FACTORIES[id](deps);
    return viewCache[id];
  }

  function show(id) {
    const v = getView(id);
    if (cur === v) return;
    cur = v;
    contentHost.replaceChildren(v.el);
    if (!v._loaded) {
      v._loaded = true;
      v.refresh?.();
    }
    refreshStatus();
  }

  function refreshStatus() {
    const bits = [{
      text: hostId ? labelOfHost(hostId) : t('app.systemd.target-host'),
      tip: t('app.systemd.target-host'),
    }];
    const st = systemdState.value;
    if (st) {
      bits.push({ text: `Systemd: ${st}`, tip: 'Systemd Init Status' });
    }
    if (cur && cur.statusBits) {
      bits.push(...cur.statusBits());
    }
    bits.push(h('span', { key: 'grow', class: 'sd-status-grow' }));
    statusBits.next = bits;
  }

  function labelOfHost(id) {
    const st = getState() || {};
    const hh = (st.hosts || []).find((x) => x.id === id);
    return hh ? hh.name : id;
  }

  show('services');
  fetchInfo();

  return () => {
    offLang();
    for (const id of Object.keys(viewCache)) {
      viewCache[id].dispose?.();
    }
    shell.destroy();
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'],
  scope: 'systemd',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId }) => boot(root, { hostId }));
});
