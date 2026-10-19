import { lang, onLangChange, setupI18n, t, tf } from '/assets/js/core/i18n.js';
import { h, Fragment } from '/assets/js/core/vdom.js';
import { bootApp } from '/assets/js/app-bridge.js';

import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import { requestSudoElevation } from '/assets/js/core/sys.js';
import { getState } from '/assets/js/core/store.js';
import { getPref, setPref, delPref } from '/assets/js/core/prefs.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import { dialog, menu, sidebarSections, statusBar, sideAction } from '/assets/js/core/components.js';
import * as api from './api.js';
import { createContainersView } from './containers.js';
import { createImagesView, createVolumesView, createNetworksView } from './resources.js';
import { createComposeView } from './compose.js';

const NOTIFY_KEY = 'qx-docker-notify';
const NOTIFY_KEY_LEGACY = 'qx-notify';

const TAB_DEFS = [
  { id: 'containers', key: 'app.docker.tab-containers', icon: 'grid' },
  { id: 'images', key: 'app.docker.tab-images', icon: 'image' },
  { id: 'volumes', key: 'app.docker.tab-volumes', icon: 'disk' },
  { id: 'networks', key: 'app.docker.tab-networks', icon: 'network' },
  { id: 'compose', label: 'Compose', icon: 'list' },
];

function tabsNow() {
  return TAB_DEFS.map((d) => ({ id: d.id, icon: d.icon, label: d.key ? t(d.key) : d.label }));
}

function boot(el, ctx) {
  const hostId = (ctx && ctx.hostId) || '';

  const dockerClient = signal('');
  const dockerErr = signal('');
  const notifyOn = signal(false);
  const statusBits = signal([]);

  const deps = {
    host: () => hostId,

    requestPerm: async () => {
      if (!hostId) return false;
      const r = await requestSudoElevation(hostId, {
        title: t('app.docker.docker-needs-root'),
        reason: t('app.docker.docker-root-hint'),
      });
      return !!(r && r.ok);
    },
    auth: async (fn) => {
      try {
        return await fn();
      } catch (e) {
        if (e.status === 403 && e.code !== 'permission') {
          const ok = await deps.requestPerm();
          if (ok) return await fn();
        }
        throw e;
      }
    },
    menu: showMenu,
    checkConfirm,
    notify: (title, body) => {
      if (!deps.notifyEnabled()) return;
      try { new Notification(title, { body }); } catch (_) { }
    },
    notifyEnabled: () => notifyPrefOn()
      && typeof Notification !== 'undefined' && Notification.permission === 'granted',
    changed: refreshStatus,
  };

  const FACTORIES = {
    containers: createContainersView,
    images: createImagesView,
    volumes: createVolumesView,
    networks: createNetworksView,
    compose: createComposeView,
  };
  const viewCache = {};
  let cur = null;

  function DockerNote() {
    lang();
    const client = dockerClient.value;
    const err = dockerErr.value;
    return h('span', {
      class: 'qx-side-note',
      text: err ? '' : (client ? `Docker ${client}` : t('app.docker.docker-detecting')),
    });
  }

  function BellAction() {
    lang();
    const on = notifyOn.value;
    return sideAction({
      icon: 'bell',
      label: on ? t('app.docker.notif-on') : t('app.docker.notif-off'),
      tip: on ? t('app.docker.notif-disable-hint') : t('app.docker.notif-enable-hint'),
      on,
      onClick: toggleNotify,
    });
  }

  function RefreshAction() {
    lang();
    return sideAction({
      icon: 'reload',
      label: t('app.docker.action-refresh'),
      tip: t('app.docker.action-refresh-hint'),
      onClick: () => cur?.refresh?.(),
    });
  }

  async function fetchInfo() {
    try {
      const d = await api.dockerInfo(hostId);
      dockerClient.next = (d.client || '').replace(/^Docker version\s+/, '').split(',')[0];
      dockerErr.next = '';
    } catch (e) {
      dockerClient.next = '';
      dockerErr.next = e.message || String(e);
    }
    refreshStatus();
  }

  async function toggleNotify() {
    if (typeof Notification === 'undefined') {
      toast(t('app.docker.notif-unsupported'), 'warning');
      return;
    }

    if (deps.notifyEnabled()) {
      setNotifyPref(false);
      toast(t('app.docker.notif-disabled'));
      notifyOn.next = false;
      refreshStatus();
      return;
    }
    if (Notification.permission === 'denied') {
      toast(t('app.docker.notif-denied'), 'warning');
      return;
    }
    if (Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') {
        toast(t('app.docker.notif-not-granted'), 'warning');
        notifyOn.next = deps.notifyEnabled();
        refreshStatus();
        return;
      }
    }
    setNotifyPref(true);
    toast(t('app.docker.notif-enabled'));
    notifyOn.next = true;
    refreshStatus();
  }

  function notifyPrefOn() {
    const v = getPref(NOTIFY_KEY, null);
    if (v === null) {
      const old = getPref(NOTIFY_KEY_LEGACY, 'on');
      setPref(NOTIFY_KEY, old);
      delPref(NOTIFY_KEY_LEGACY);
      return old !== 'off';
    }
    return v !== 'off';
  }

  function setNotifyPref(on) {
    setPref(NOTIFY_KEY, on ? 'on' : 'off');
  }

  function checkConfirm(title, desc, checks = [], okText = t('app.docker.action-ok')) {
    return new Promise((resolve) => {
      const boxes = checks.map((c) => ({ key: c.key, label: c.label, ref: { current: null } }));
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
              h('div', { class: 'confirm-title', text: title }),
              h('div', { class: 'confirm-desc', text: desc }),
              boxes.length
                ? h('div', { style: { marginTop: '10px', display: 'grid', gap: '7px' } },
                  boxes.map((b) => h('label', {
                    class: 'dk-host',
                    style: { cursor: 'pointer', gap: '7px' },
                  }, [
                    h('input', { type: 'checkbox', class: 'dk-check', ref: b.ref }),
                    h('span', { text: b.label }),
                  ])))
                : null,
            ].filter(Boolean)),
          ]),
        ],
        actions: [
          h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-cancel'), onClick: () => finish(null) }),
          h('button', {
            class: 'btn btn-danger btn-sm',
            text: okText,
            onClick: () => {
              const out = {};
              for (const b of boxes) out[b.key] = !!(b.ref.current && b.ref.current.checked);
              finish(out);
            },
          }),
        ],
        onClose: () => finish(null),
      });
    });
  }

  function showMenu(x, y, items) {
    menu(items.map((it) => (it === 'sep' ? { sep: true } : it)), { x, y });
  }

  const contentHost = document.createElement('div');
  contentHost.className = 'qx-scroll';

  const shell = createAppShell(el, {
    tabs: tabsNow,
    active: 'containers',
    onChange: show,
    sideTop: [sidebarSections([{ node: h(DockerNote, {}) }])],
    actions: [h(RefreshAction, {}), h(BellAction, {})],
  });

  function mainTree() {
  const err = dockerErr.value;
  return h('div', { class: 'app-root' }, [
    h('div', {
      class: `qx-err${err ? '' : ' hidden'}`,
      title: err || '',
      text: err ? tf('app.docker.docker-unavailable', { v1: err }) : '',
    }),
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
    const bits = [{ text: hostId ? labelOfHost(hostId) : t('app.docker.target-local'), tip: t('app.docker.target-host') }];
    const client = dockerClient.value;
    if (client) bits.push({ text: `Docker ${client}`, tip: t('app.docker.client-version') });
    if (cur) bits.push(...cur.statusBits());
    bits.push(h('span', { key: 'grow', class: 'dk-status-grow' }));
    bits.push(deps.notifyEnabled()
      ? { text: t('app.docker.notif-on-label'), tip: t('app.docker.notif-on-detail') }
      : { text: t('app.docker.notif-off-label'), tip: t('app.docker.notif-off-detail') });
    statusBits.next = bits;
  }

  function labelOfHost(id) {
    const st = getState() || {};
    const hh = (st.hosts || []).find((x) => x.id === id);
    return hh ? hh.name : id;
  }

  notifyOn.next = deps.notifyEnabled();
  show('containers');
  fetchInfo();

  return () => {
    offLang();
    for (const id of Object.keys(viewCache)) viewCache[id].dispose?.();
    shell.destroy();
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'docker',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId }) => boot(root, { hostId }));
});
