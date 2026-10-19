import { bootAppNoInit } from '/assets/js/app-bridge.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import {
  card, toolbar, searchBox, statusBar, sidebarSections, sideAction, dialog,
} from '/assets/js/core/components.js';
import { icon } from '/assets/js/icons/index.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import { deleteHost, testHost, importHosts } from '/assets/js/core/qxssh-api.js';
import { getState, refreshHosts, subscribe } from '/assets/js/core/store.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import { openHostForm } from '/assets/js/pages/host-form.js';
import { setupI18n, t, tf } from '/assets/js/core/i18n.js';
import { CodeEditor } from '/assets/js/core/code-editor.js';

function authLabel(type) {
  return type === 'key' ? t('app.hosts.auth.key') : t('app.hosts.auth.password');
}

const mount = document.getElementById('app');

const query = signal('');
const group = signal('');
const listErr = signal('');
const testing = signal(new Set());
const removing = signal(new Set());

const tick = signal(0);

function hostsOf() {
  return getState().hosts || [];
}

function filteredHosts() {
  const q = query.value.trim().toLowerCase();
  const g = group.value;
  return hostsOf().filter((x) => {
    if (g && (x.group || '') !== g) return false;
    if (!q) return true;
    return `${x.name} ${x.address} ${x.user} ${x.group || ''}`.toLowerCase().includes(q);
  });
}

function sortedGroups() {
  return (getState().groups || []).slice().sort((a, b) => a.localeCompare(b, 'zh'));
}

const sideBox = document.createElement('div');
sideBox.className = 'ah-side';
const sideView = createView(sideBox);
sideView.update(() => {
  void tick.value;
  const groups = sortedGroups();
  return sidebarSections([
    { title: t('app.hosts.sidebar.filterTitle'), group: 'g', items: [{ id: '', label: t('app.hosts.sidebar.allHosts'), icon: 'server' }] },
    {
      title: t('app.hosts.sidebar.groupTitle'),
      group: 'g',
      items: groups.map((g) => ({ id: g, label: g, icon: 'tag' })),
      empty: t('app.hosts.sidebar.noGroups'),
    },
  ], group.value, (id) => { group.next = id; });
});

async function doRefresh() {
  listErr.next = '';
  try {
    await refreshHosts();
  } catch (e) {
    listErr.next = (e && e.message) || String(e);
  }
}

function openAdd() {
  openHostForm({
    groups: getState().groups || [],
    onSaved: () => { doRefresh(); },
  });
}

function openEdit(host) {
  openHostForm({
    host,
    groups: getState().groups || [],
    onSaved: () => { doRefresh(); },
  });
}

async function doDelete(host) {
  const ok = await confirmAction(
    tf('app.hosts.delete.confirm', { name: host.name }),
    t('app.hosts.delete.detail'),
    { okText: t('app.hosts.delete.ok'), danger: true }
  );
  if (!ok) return;
  removing.next = new Set(removing.value).add(host.id);
  try {
    await deleteHost(host.id);
    toast(t('app.hosts.delete.done'), 'success');
    await doRefresh();
  } catch (e) {
    toast(tf('app.hosts.delete.failed', { err: e.message }), 'error');
  } finally {
    const s = new Set(removing.value);
    s.delete(host.id);
    removing.next = s;
  }
}

async function doTest(host) {
  testing.next = new Set(testing.value).add(host.id);
  try {
    const r = await testHost({ id: host.id });
    if (r.ok) toast(tf('app.hosts.test.ok', { name: host.name, ms: r.latencyMs }), 'success');
    else toast(tf('app.hosts.test.ko', { name: host.name, err: r.error || t('app.hosts.test.unknown') }), 'error');
  } catch (e) {
    toast(tf('app.hosts.test.err', { name: host.name, err: e.message }), 'error');
  } finally {
    const s = new Set(testing.value);
    s.delete(host.id);
    testing.next = s;
  }
}

function emptyText() {
  if (!hostsOf().length) return t('app.hosts.empty.first');
  if (group.value || query.value.trim()) return t('app.hosts.empty.filtered');
  return t('app.hosts.empty.none');
}

function rowAction({ iconName, tip, cls = '', busy = false, onClick }) {
  return h('button', {
    class: `btn btn-ghost btn-sm ${cls}`.trim(),
    dataset: { tip },
    disabled: busy,
    html: busy ? '' : icon(iconName),
    onClick: busy ? undefined : onClick,
  });
}

function tableTree() {
  const busyIds = testing.value;
  const goneIds = removing.value;
  return h('table', { class: 'qx-table' }, [
    h('thead', {}, [
      h('tr', {}, [
        h('th', { text: t('app.hosts.column.name') }),
        h('th', { text: t('app.hosts.column.group') }),
        h('th', { text: t('app.hosts.column.address') }),
        h('th', { text: t('app.hosts.column.user') }),
        h('th', { text: t('app.hosts.column.auth') }),
        h('th', { class: 'qx-actions-col', text: t('app.hosts.column.actions') }),
      ]),
    ]),
    h('tbody', {}, filteredHosts().map((host) => h('tr', { key: host.id }, [
      h('td', {}, [
        h('div', { class: 'ah-cell-name', text: host.name }),
        host.jumpHostId
          ? h('div', { class: 'ah-cell-note ah-jump', text: tf('app.hosts.jumpVia', { name: host.jumpHostName || host.jumpHostId }) })
          : null,
        host.note ? h('div', { class: 'ah-cell-note', text: host.note }) : null,
      ].filter(Boolean)),
      h('td', {}, [
        host.group
          ? h('span', { class: 'ah-pill', text: host.group })
          : h('span', { class: 'ah-muted', text: '-' }),
      ]),
      h('td', { class: 'mono' }, `${host.address}:${host.port}`),
      h('td', { class: 'mono' }, host.user),
      h('td', {}, authLabel(host.authType)),
      h('td', { class: 'qx-actions-col' }, [
        rowAction({
          iconName: 'check-square', tip: t('app.hosts.tip.test'),
          busy: busyIds.has(host.id), onClick: () => doTest(host),
        }),
        rowAction({ iconName: 'edit', tip: t('app.hosts.tip.edit'), onClick: () => openEdit(host) }),
        rowAction({
          iconName: 'trash', tip: t('app.hosts.tip.delete'), cls: 'btn-text-danger',
          busy: goneIds.has(host.id), onClick: () => doDelete(host),
        }),
      ]),
    ]))),
  ]);
}

function listTree() {
  const hosts = filteredHosts();
  const err = listErr.value;
  return h('div', { class: 'qx-card-scroll' }, [
    err && hosts.length
      ? h('div', { class: 'ah-err' }, [
        h('span', { text: tf('app.hosts.refresh.failed', { err }) }),
        h('button', { class: 'btn btn-ghost btn-sm', text: t('app.hosts.retry'), onClick: () => doRefresh() }),
      ])
      : null,
    hosts.length
      ? tableTree()
      : h('div', { class: 'qx-card-empty', text: err ? tf('app.hosts.load.failed', { err }) : emptyText() }),
  ].filter(Boolean));
}

function mainTree() {
  void tick.value;
  const hosts = filteredHosts();
  const total = sortedGroups().length;
  return h('div', { class: 'app-root' }, [
    h('div', { class: 'qx-scroll' }, [
      card(t('app.hosts.card.title'), [
        toolbar([searchBox(t('app.hosts.search.placeholder'), (v) => { query.next = v; })]),
        listTree(),
      ], { fill: true, tools: h('span', { class: 'qx-count', text: tf('app.hosts.count.of', { shown: hosts.length, total: hostsOf().length }) }) }),
    ]),
    statusBar([
      tf('app.hosts.status.total', { n: hostsOf().length }),
      group.value ? tf('app.hosts.status.group', { name: group.value }) : tf('app.hosts.status.allGroups', { n: total }),
      query.value.trim() ? tf('app.hosts.status.filtered', { q: query.value.trim() }) : null,
      listErr.value ? t('app.hosts.status.readError') : null,
    ]),
  ]);
}

function doExport() {
  const list = hostsOf().map((h) => {
    const copy = { ...h };
    delete copy.id;
    return copy;
  });
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'qxssh-hosts.json';
  a.click();
  URL.revokeObjectURL(url);
}

function openImportDialog() {
  const textRef = { current: null };
  const submit = async () => {
    const val = (textRef.current?.value || '').trim();
    if (!val) return;
    try {
      let payload;
      if (val.startsWith('[') || val.startsWith('{')) {
        const parsed = JSON.parse(val);
        payload = { format: 'json', hosts: Array.isArray(parsed) ? parsed : [parsed] };
      } else {
        payload = { format: 'ssh_config', content: val };
      }
      const res = await importHosts(payload);
      if (res && res.ok) {
        toast(tf('app.hosts.import.success', { v1: res.imported || 0 }), 'success');
        dlg.close();
        await doRefresh();
      } else {
        toast(tf('app.hosts.import.failed', { v1: (res && res.error) || '' }), 'error');
      }
    } catch (e) {
      toast(tf('app.hosts.import.failed', { v1: e.message || String(e) }), 'error');
    }
  };

  const dlg = dialog({
    title: t('app.hosts.import.title'),
    body: [
      h('div', { class: 'field' }, [
        h('label', { class: 'label', text: t('app.hosts.import.hint') }),
        h(CodeEditor, {
          inputRef: textRef,
          lang: 'sshconfig',
          rows: 10,
          maxRows: 24,
          cls: 'hosts-import-code',
          placeholder: 'Host my-server\n  HostName 1.2.3.4\n  User root\n  Port 22',
        }),
      ]),
    ],
    actions: [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.hosts.action.cancel'), onClick: () => dlg.close() }),
      h('button', { class: 'btn btn-primary btn-sm', text: t('app.hosts.action.confirm'), onClick: submit }),
    ],
  });
}

function boot() {
  const shell = createAppShell(mount, {
    tabs: [],
    sideTop: [sideBox],
    actions: [
      () => sideAction({ icon: 'plus', label: t('app.hosts.action.add'), onClick: openAdd }),
      () => sideAction({ icon: 'upload', label: t('app.hosts.action.import'), onClick: openImportDialog }),
      () => sideAction({ icon: 'download', label: t('app.hosts.action.export'), onClick: doExport }),
      () => sideAction({ icon: 'reload', label: t('app.hosts.action.refresh'), onClick: () => doRefresh() }),
    ],
  });
  shell.setMain(mainTree);
  return () => {
    sideView.unmount();
    shell.destroy();
  };
}

const unsubscribe = subscribe(() => { tick.next = tick.value + 1; });

const ready = setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'hosts',
}).catch(() => { });
ready.then(() => {
  bootAppNoInit(() => {
    const dispose = boot();
    return () => {
      unsubscribe();
      dispose?.();
    };
  });
  return doRefresh();
}).catch(() => { });
