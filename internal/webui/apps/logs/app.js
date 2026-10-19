import { bootApp, getWorkspaceInfo } from '/assets/js/app-bridge.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal, effect } from '/assets/js/core/signal.js';
import {
  esc, fmtTime, fmtSize, createPoller, isMod, modLabel, debounce,
} from '/assets/js/core/dom.js';
import { getJSONPref, setJSONPref } from '/assets/js/core/prefs.js';
import {
  spinner, emptyState, errorState, searchBox, statusBar, table, badge,
  iconButton, card, keyValue, segmented, sidebarSections,
  Collapsible, FloatCard, SwitchToggle, selectField, inputField, field, codeBlock, kvGrid,
} from '/assets/js/core/components.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import { setupI18n, t, tf } from '/assets/js/core/i18n.js';
import { highlightCode } from '/assets/js/core/code-editor.js';
import { createSplitter } from '/assets/js/core/splitter.js';
import { appIcon } from '/assets/js/icons/index.js';
import { appName as appTextName } from '/assets/js/apps/apptext.js';
import { toast, confirmAction, copyText } from '/assets/js/core/ui.js';
import { icon } from '/assets/js/icons/index.js';
import {
  auditLogs, listUserApps, auditSettings, saveAuditSettings, setAuditVerbose,
  archiveAuditLogs, clearAuditLogs,
} from '/assets/js/core/qxssh-api.js';

const TYPE_DEFS = [
  { value: 'perm_request', labelKey: 'app.logs.type-grant-request', icon: 'filter' },
  { value: 'perm_grant', labelKey: 'app.logs.type-grant', icon: 'check' },
  { value: 'perm_revoke', labelKey: 'app.logs.type-revoke', icon: 'close' },
  { value: 'perm_clear', labelKey: 'app.logs.type-grant-clear', icon: 'trash' },
  { value: 'api_call', labelKey: 'app.logs.type-api', icon: 'activity' },
  { value: 'session_mint', labelKey: 'app.logs.type-session-create', icon: 'plus' },
  { value: 'session_revoke', labelKey: 'app.logs.type-session-drop', icon: 'close' },
  { value: 'note', labelKey: 'app.logs.type-local', icon: 'edit' },
  { value: 'system', labelKey: 'app.logs.title-audit', icon: 'settings' },
];

const TYPE_KEY = new Map(TYPE_DEFS.map((d) => [d.value, d.labelKey]));
const TYPE_TONE = {
  perm_request: 'warning',
  perm_grant: 'success',
  perm_revoke: 'danger',
  perm_clear: 'danger',
};

const HOST = '\u0000host';
const auditMinMB = 0.0625;
const auditMaxMB = 64;
const LS_DETAIL = 'qx-logs-detail';
const LS_SETTING = 'qx-logs-setting';

function boot(el, ctx) {

  const appFilter = signal('');
  const typeFilter = signal('');
  const query = signal('');
  const sortKey = signal('time:-1');
  const logs = signal([]);
  const apps = signal(new Map());
  const hostId = signal((ctx && ctx.hostId) || '');
  const appListError = signal('');
  const loading = signal(false);
  const loadError = signal('');
  const selKey = signal('');
  const verbose = signal(false);
  const settings = signal({
    verbose: false, maxBytes: 8 << 20, archives: 1, rotateMode: 'archive', retentionDays: 0,
  });
  const groups = signal([]);
  const dataPath = signal('');
  const archivePath = signal('');
  const settingOn = signal(getJSONPref(LS_SETTING, true) !== false);
  const busy = signal('');
  const setErr = signal('');
  const detailOn = signal(getJSONPref(LS_DETAIL, true) !== false);

  let sensitive = true;

  const verboseRev = signal(0);

  function typeLabel(v) {
    const key = TYPE_KEY.get(v);
    return (key && t(key)) || v || t('app.logs.unknown');
  }

  function appLabel(id) {
    if (!id) return t('app.logs.filter-host');
    const m = apps.value.get(id);
    return appTextName(m) || id;
  }

  function appIconNode(iconName, id) {
    return h('span', { class: 'qicon-sm', html: appIcon(iconName, 'qicon qicon-sm', id) });
  }

  function isStatus(v) {
    return /^[1-5]\d\d$/.test(String(v || ''));
  }

  function resultTone(e) {
    if (isStatus(e.result)) {
      const n = Number(e.result);
      return n === 401 || n === 403 ? 'danger' : n >= 400 ? 'warning' : 'success';
    }
    return e.result === 'ok' || e.result === 'system' ? 'success' : 'default';
  }

  function durText(ms) {
    if (ms == null) return '—';
    const n = Number(ms);
    if (!Number.isFinite(n)) return '—';
    if (n < 1000) return `${Math.round(n)}ms`;
    const s = n / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s - m * 60)}s`;
  }

  function curGroup() {
    return hostId.value || '_';
  }

  function rowKey(e) {
    if (e && e.seq != null) return String(e.seq);
    return `${e.time || ''}|${e.appId || ''}|${e.type}|${e.target || ''}|${e.detail || ''}`;
  }

  function matches(e, q) {
    const app = appFilter.value;
    if (app === HOST) {
      if (e.appId) return false;
    } else if (app && e.appId !== app) {
      return false;
    }
    if (typeFilter.value && e.type !== typeFilter.value) return false;
    if (!q) return true;
    return [
      e.appId, appLabel(e.appId), e.type, typeLabel(e.type),
      e.target, e.detail, e.result,
    ].filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  function sortRows(list) {
    const [key, dirRaw] = sortKey.value.split(':');
    const dir = Number(dirRaw);
    return list.slice().sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (x === y) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x > y ? 1 : -1) * dir;
    });
  }

  function shownRows() {
    return sortRows(logs.value.filter((e) => matches(e, query.value)));
  }

  function appFilterLabel() {
    const a = appFilter.value;
    if (a === '') return t('app.logs.filter-all-apps');
    if (a === HOST) return t('app.logs.filter-host');
    return appLabel(a);
  }

  function sideTree() {
    const fixed = [
      { id: '', label: t('app.logs.filter-all-apps'), icon: 'grid' },
      { id: HOST, label: t('app.logs.filter-host'), icon: 'monitor' },
    ];
    const installed = [...apps.value.entries()].map(([id, m]) => ({
      id,
      label: appTextName(m) || id,
      icon: appIconNode((m && m.icon) || id, id),
    }));
    const types = [{ id: '', label: t('app.logs.filter-all-types'), icon: 'list' }]
      .concat(TYPE_DEFS.map((d) => ({ id: d.value, label: t(d.labelKey), icon: d.icon })));
    return sidebarSections([
      { title: t('app.logs.filter-by-app'), group: 'app', items: fixed },
      { node: h('hr', { class: 'qx-side-sep' }) },
      {
        title: t('app.logs.installed-apps'),
        group: 'app',
        items: installed,
        empty: appListError.value
          ? t('app.logs.apps-load-failed') + appListError.value
          : t('app.logs.no-installed-apps'),
      },
      { title: t('app.logs.filter-by-type'), group: 'type', items: types },
    ], { app: appFilter.value, type: typeFilter.value }, (id, group) => {
      if (group === 'app') appFilter.next = id;
      else typeFilter.next = id;
      load();
    });
  }

  function tableTree() {
    const rows = shownRows();
    if (!rows.length) {
      const q = query.value;
      if (loading.value && !logs.value.length) return spinner(t('app.logs.list-loading'));
      return emptyState(q ? t('app.logs.empty-no-match-pre') + q + t('app.logs.empty-no-match-post') : t('app.logs.empty-none'));
    }
    return table([
      { label: t('app.logs.col-time'), key: 'time', cls: 'mono lg-c-time', render: (r) => esc(fmtTime(r.time)) },
      { label: t('app.logs.col-app'), key: 'appId', render: (r) => esc(appLabel(r.appId)) },
      { label: t('app.logs.col-type'), key: 'type', render: (r) => badge(typeLabel(r.type), TYPE_TONE[r.type] || 'default') },
      {
        label: t('app.logs.col-target'), key: 'target', cls: 'mono lg-c-target',
        render: (r) => esc(r.target || '—'),
      },
      { label: t('app.logs.col-result'), key: 'result', cls: 'lg-c-result', render: (r) => badge(r.result || '—', resultTone(r)) },
      { label: t('app.logs.col-duration'), key: 'durationMs', cls: 'mono lg-c-dur', render: (r) => esc(durText(r.durationMs)) },
    ], rows, {
      rowKey: (r) => rowKey(r),
      onRowClick: (r) => {
        selKey.next = rowKey(r);
        if (!detailOn.value) detailOn.next = true;
      },
    });
  }

  function detailTree() {
    const key = selKey.value;
    const e = key ? logs.value.find((r) => rowKey(r) === key) : null;
    return h(FloatCard, {
      key: e ? `row-${key}` : 'row-none',
      title: t('app.logs.detail-title'),
      actions: iconButton('close', { tip: t('app.logs.detail-close'), onClick: () => setDetail(false) }),
      body: e ? detailBody(e) : emptyState(t('app.logs.detail-empty')),
    });
  }

  function detailBody(e) {
    return [
      keyValue(t('app.logs.col-time'), fmtTime(e.time)),
      keyValue(t('app.logs.col-app'), e.appId ? `${appLabel(e.appId)}（${e.appId}）` : t('app.logs.filter-host')),
      keyValue(t('app.logs.col-type'), typeLabel(e.type)),
      keyValue(t('app.logs.col-target'), e.target || '—'),
      keyValue(t('app.logs.col-result'), e.result || '—'),
      keyValue(t('app.logs.col-duration'), durText(e.durationMs)),
      e.detail ? keyValue(
        e.type === 'perm_request' ? t('app.logs.detail-perms') : t('app.logs.detail-label'),
        e.detail,
        { mono: true },
      ) : null,
      e.verbose ? verboseBlock(e.verbose) : null,
    ].filter(Boolean);
  }

  function verboseBlock(v) {
    const heads = Object.keys(v.headers || {});
    const parts = [
      h('div', {
        class: 'lg-secret-note',
        text: t('app.logs.sensitive-note'),
      }),
    ];
    if (v.query) {
      parts.push(h(Collapsible, {
        key: 'query', title: t('app.logs.detail-query'), body: codeBlock(v.query), open: true,
      }));
    }
    parts.push(h(Collapsible, {
      key: 'origin',
      title: t('app.logs.detail-source'),
      body: kvGrid([
        [t('app.logs.detail-source-addr'), v.remote || '—'],
        ['User-Agent', v.agent || '—'],
        ['Referer', v.referer || '—'],
        ['Origin', v.origin || '—'],
        ['Sec-Fetch', [v.fetchMode, v.fetchDest].filter(Boolean).join(' / ') || '—'],
      ]),
      open: true,
    }));
    if (heads.length) {
      const sorted = heads.sort();
      parts.push(h(Collapsible, {
        key: 'headers',
        title: tf('app.logs.detail-headers-count', { v1: (sorted.length) }),
        body: table([
          { label: t('app.logs.col-header'), key: 'name', cls: 'mono', render: (r) => esc(r.name) },
          { label: t('app.logs.col-value'), key: 'value', cls: 'mono', render: (r) => esc(r.value) },
        ], sorted.map((k) => ({ name: k, value: v.headers[k] })), {
          rowKey: (r) => r.name,
          empty: t('app.logs.none'),
        }),
      }));
    }
    if (v.body || v.bodyNote) {
      parts.push(h(Collapsible, {
        key: 'body',
        title: v.bodyBytes ? tf('app.logs.detail-body-sized', { v1: (fmtSize(v.bodyBytes)) }) : t('app.logs.detail-body'),
        body: h('div', { class: 'lg-vbody' }, [
          v.body ? highlightCode(prettifyMaybeJSON(v.body), /^\s*[{[]/.test(v.body) ? 'json' : 'text', { wrap: true }) : null,
          v.bodyNote ? h('p', { class: 'lg-vnote', text: v.bodyNote }) : null,
        ].filter(Boolean)),
        open: !!v.body,
      }));
    }
    const resp = kvGrid([
      ['Content-Type', v.respType || '—'],
      [t('app.logs.detail-response-bytes'), v.respBytes ? fmtSize(v.respBytes) : '0'],
    ]);
    if (v.respError) resp.push([t('app.logs.detail-failed-response'), v.respError]);
    parts.push(h(Collapsible, { key: 'resp', title: t('app.logs.detail-response'), body: resp, open: true }));
    return h('div', { class: 'lg-verbose' }, parts);
  }

  function prettifyMaybeJSON(body) {
    const t = String(body || '').trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return body;
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return body;
    }
  }

  function settingCard() {
    const s = settings.value;
    const busyNow = busy.value;
    const g = groups.value[0] || null;
    const curBytes = g ? (Number(g.bytes) || 0) : 0;
    const arcBytes = g ? (Number(g.archiveBytes) || 0) : 0;
    const totalBytes = curBytes + arcBytes;

    const save = async (patch, okMsg) => {
      if (busy.value) return;
      busy.next = 'settings';
      setErr.next = '';
      try {
        const d = await saveAuditSettings(patch, curGroup());
        applySettingsPayload(d);
        if (okMsg) toast(okMsg, 'success');
      } catch (e) {
        setErr.next = (e && e.message) || String(e);
        toast(t('app.logs.save-failed') + setErr.value, 'error');
      } finally {
        busy.next = '';
      }
    };

    const occupancy = g
      ? kvGrid([
        [t('app.logs.group-workspace'), g.name ? `${g.name}（${g.group}）` : (g.hostId ? tf('app.logs.group-deleted-host', { v1: (g.group) }) : t('app.logs.group-host-page'))],
        [t('app.logs.group-records'), tf('app.logs.group-rows', { v1: (Number(g.rows) || 0) })],
        [t('app.logs.archive-label'), tf('app.logs.group-archives', { v1: (Number(g.archives) || 0), v2: (fmtSize(arcBytes)) })],
        [t('app.logs.recent-records'), g.modified ? fmtTime(g.modified) : '—'],
      ], { cols: 2 })
      : emptyState(t('app.logs.workspace-empty'));

    return card(t('app.logs.archive-title'), [
      setErr.value ? h('p', { class: 'lg-seterr', text: setErr.value }) : null,
      ...pathRows(),
      h('div', { class: 'lg-setgrid' }, [
        field(t('app.logs.field-rotate-threshold'), inputField('', String(Math.round(s.maxBytes / 1024 / 1024)), (v) => {
          const mb = Math.max(auditMinMB, Math.min(auditMaxMB, Number(v) || 8));
          save({ maxBytes: Math.round(mb * 1024 * 1024) });
        }, { type: 'number', tip: t('app.logs.rotate-threshold-hint') })),
        field(t('app.logs.field-keep-generations'), inputField('', String(s.archives), (v) => {
          save({ archives: Math.max(1, Math.min(10, Math.round(Number(v) || 1))) });
        }, { type: 'number', tip: t('app.logs.keep-generations-hint') })),
        field(t('app.logs.field-rotate-mode'), selectField('', [
          { value: 'archive', label: t('app.logs.rotate-archive') },
          { value: 'delete', label: t('app.logs.rotate-drop') },
        ], s.rotateMode, (v) => save({ rotateMode: v }), {
          tip: t('app.logs.rotate-archive-warning'),
        })),
        field(t('app.logs.field-keep-days'), inputField('', String(s.retentionDays), (v) => {
          save({ retentionDays: Math.max(0, Math.min(3650, Math.round(Number(v) || 0))) });
        }, { type: 'number', tip: t('app.logs.keep-days-hint') })),
      ]),
      h('div', { class: 'lg-setfoot' }, [
        h('span', { class: 'lg-settotal', text: tf('app.logs.workspace-usage', { v1: (fmtSize(totalBytes)) }) }),
        h('span', { class: 'lg-sethint', text: busyNow ? t('app.logs.status-saving') : t('app.logs.autosave-note') }),
      ]),
      occupancy,
    ].filter(Boolean), { cls: 'lg-setting-card' });
  }

  function pathRows() {
    if (!dataPath.value) {
      return [h('div', { class: 'lg-setpath' }, [
        h('span', { class: 'lg-setpath-l', text: t('app.logs.data-location') }),
        h('code', { class: 'lg-setpath-v mono', text: t('app.logs.dir-unavailable') }),
      ])];
    }
    const row = (label, path) => h('div', { class: 'lg-setpath' }, [
      h('span', { class: 'lg-setpath-l', text: label }),
      h('code', { class: 'lg-setpath-v mono', text: path, title: path }),
      h('button', {
        class: 'qx-ibtn qx-ibtn-sm', type: 'button', 'aria-label': tf('app.logs.copy-item', { v1: label }),
        html: icon('copy', 'qicon-sm'),
        onClick: async () => {
          const ok = await copyText(path);
          toast(ok ? tf('app.logs.copied-item', { v1: label }) : t('app.logs.copy-failed'), ok ? 'success' : 'error');
        },
      }),
    ]);
    const out = [row(t('app.logs.generation-current'), dataPath.value)];
    if (archivePath.value) out.push(row(t('app.logs.archive-label'), archivePath.value));
    return out;
  }

  const onSearch = debounce((v) => {
    query.next = String(v || '').trim().toLowerCase();
  }, 250);

  function toolsCard() {
    return card('', [
      h('div', { class: 'lg-tools' }, [
        searchBox(t('app.logs.search-placeholder'), (v) => onSearch(v)),
        segmented([
          { value: 'time:-1', label: t('app.logs.sort-newest') },
          { value: 'time:1', label: t('app.logs.sort-oldest') },
          { value: 'appId:1', label: t('app.logs.sort-by-app') },
          { value: 'durationMs:-1', label: t('app.logs.sort-by-duration') },
        ], sortKey.value, (v) => { sortKey.next = v; }),
        iconButton('info', {
          tip: tf('app.logs.detail-hint', { v1: (modLabel()) }),
          active: detailOn.value,
          onClick: () => setDetail(!detailOn.value),
        }),
        h(SwitchToggle, {
          key: `${verbose.value ? 1 : 0}-${verboseRev.value}`,
          label: t('app.logs.verbose-label'),
          checked: verbose.value,
          onChange: (on) => applyVerbose(on),
          tip: t('app.logs.verbose-hint'),
        }),
        iconButton('archive', { tip: t('app.logs.action-archive-now'), onClick: doArchive }),
        iconButton('settings', {
          tip: t('app.logs.archive-title'),
          active: settingOn.value,
          onClick: () => setSetting(!settingOn.value),
        }),
        iconButton('trash', { tip: t('app.logs.action-clear-logs'), cls: 'lg-danger', onClick: doClear }),
        iconButton('reload', { tip: t('app.logs.action-refresh-now'), onClick: () => load() }),
      ]),
      settingOn.value ? settingCard() : null,
    ].filter(Boolean), { cls: 'lg-tools-card' });
  }

  function mainTree() {
    const body = loadError.value
      ? errorState(t('app.logs.read-failed') + loadError.value)
      : h('div', { class: 'qx-card-scroll' }, [tableTree()]);
    return [
      h('div', { class: 'lg-split', ref: splitRef }, [
        h('div', { class: 'lg-left' }, [toolsCard(), card('', [body], { fill: true })]),
        splitter.el,
        detailPane,
      ]),
      statusBar([
        tf('app.logs.count-shown', { v1: (shownRows().length), v2: (logs.value.length) }),
        appFilterLabel(),
        typeFilter.value ? typeLabel(typeFilter.value) : t('app.logs.filter-all-types'),
        loading.value ? t('app.logs.status-refreshing') : '',
      ]),
    ];
  }

  function setDetail(on) {
    detailOn.next = on === true;
    setJSONPref(LS_DETAIL, detailOn.value);
  }

  function setSetting(on) {
    settingOn.next = on === true;
    setJSONPref(LS_SETTING, settingOn.value);
    if (settingOn.value) loadSettings();
  }

  async function applyVerbose(on) {
    if (busy.value) return;
    if (on) {
      const ok = await confirmAction(
        t('app.logs.confirm-verbose-title'),
        t('app.logs.confirm-verbose-1')
        + t('app.logs.confirm-verbose-2')
        + t('app.logs.confirm-verbose-3'),
        { okText: t('app.logs.action-enable'), danger: true },
      );
      if (!ok) {
        verboseRev.next++;
        return;
      }
    }
    busy.next = 'verbose';
    try {
      const d = await setAuditVerbose(on, curGroup());
      applySettingsPayload(d);
      toast(on ? t('app.logs.verbose-on') : t('app.logs.verbose-off'), 'success');
    } catch (e) {
      toast(t('app.logs.toggle-failed') + ((e && e.message) || e), 'error');
    } finally {
      busy.next = '';
      verboseRev.next++;
    }
  }

  async function doArchive() {
    if (busy.value) return;
    busy.next = 'archive';
    try {
      const d = await archiveAuditLogs(curGroup());
      applySettingsPayload(d);
      const n = ((d && d.result && d.result.groups) || []).length;
      const rows = (d && d.result && d.result.rows) || 0;
      const arc = (d && d.result && d.result.archivedBytes) || 0;
      toast(n ? tf('app.logs.archived', { v1: rows, v2: (fmtSize(arc)) }) : t('app.logs.archive-none'), 'success');
    } catch (e) {
      toast(t('app.logs.archive-failed') + ((e && e.message) || e), 'error');
    } finally {
      busy.next = '';
    }
  }

  async function doClear() {
    if (busy.value) return;
    const g = groups.value[0] || null;
    const totalBytes = g ? (Number(g.bytes) || 0) : 0;
    const who = g && g.name ? g.name : t('app.logs.current-workspace');
    const ok = await confirmAction(
      t('app.logs.confirm-clear-title'),
      tf('app.logs.confirm-clear-1', { v1: who, v2: (fmtSize(totalBytes)) })
      + t('app.logs.confirm-clear-2'),
      { okText: t('app.logs.type-grant-clear'), danger: true },
    );
    if (!ok) return;
    busy.next = 'clear';
    try {
      const d = await clearAuditLogs(curGroup());
      applySettingsPayload(d);
      logs.next = [];
      selKey.next = '';
      toast(tf('app.logs.cleared', { v1: (fmtSize((d && d.result && d.result.freedBytes) || 0)) }), 'success');
    } catch (e) {
      toast(t('app.logs.clear-failed') + ((e && e.message) || e), 'error');
    } finally {
      busy.next = '';
    }
  }

  function applySettingsPayload(d) {
    if (!d) return;
    if (d.settings) settings.next = d.settings;
    if ('group' in d) groups.next = d.group ? [d.group] : [];
    if (typeof d.verbose === 'boolean') verbose.next = d.verbose;
    if (typeof d.path === 'string') dataPath.next = d.path;
    if (typeof d.archivePath === 'string') archivePath.next = d.archivePath;
  }

  async function loadSettings() {
    try {
      applySettingsPayload(await auditSettings(curGroup()));
    } catch {
    }
  }

  async function load() {
    if (loading.value) return;
    loading.next = true;
    try {
      const onlyHost = appFilter.value === HOST;
      const d = await auditLogs({
        app: onlyHost ? '' : appFilter.value,
        host: curGroup(),
        page: onlyHost ? 1 : '',
        type: typeFilter.value,
        limit: 500,
      });
      logs.next = (d && Array.isArray(d.logs)) ? d.logs : [];
      if (d && typeof d.verbose === 'boolean') verbose.next = d.verbose;
      if (d && typeof d.sensitive === 'boolean') sensitive = d.sensitive;
      loadError.next = '';
    } catch (err) {
      loadError.next = (err && err.message) || String(err);
    } finally {
      loading.next = false;
    }
  }

  async function syncWorkspace() {
    let info = null;
    try {
      info = await getWorkspaceInfo();
    } catch {
      return false;
    }
    if (!info) return false;
    const id = info.hostId || '';
    if (id === hostId.value) return false;
    hostId.next = id;
    selKey.next = '';
    groups.next = [];
    if (settingOn.value) await loadSettings();
    return true;
  }

  const detailPane = document.createElement('div');
  detailPane.className = 'lg-detail';
  const detailView = createView(detailPane);
  detailView.update(detailTree);

  const splitRef = { current: null };
  const splitter = createSplitter({
    key: 'qx-logs-detailw',
    title: t('app.logs.detail-resize-hint'),
    min: 240,
    pad: 340,
    getBody: () => splitRef.current,
    getPanel: () => detailPane,
  });

  const sideBox = document.createElement('div');
  sideBox.className = 'lg-side-box';
  const sideView = createView(sideBox);
  sideView.update(sideTree);

  const shell = createAppShell(el, { tabs: [], sideTop: [sideBox] });
  shell.setMain(mainTree);

  effect(() => {
    const on = detailOn.value;
    detailPane.classList.toggle('hidden', !on);
    splitter.setHidden(!on);
    if (on) splitter.restore();
  });

  const onKey = (e) => {
    if (!isMod(e) || String(e.key).toLowerCase() !== 'd') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    setDetail(!detailOn.value);
  };
  document.addEventListener('keydown', onKey);

  const poller = createPoller(async () => {
    await syncWorkspace();
    await load();
  }, 5000, { immediate: false, hiddenPause: true });

  async function start() {
    if (settingOn.value) await loadSettings();
    try {
      const list = await listUserApps();
      const m = new Map();
      for (const a of (Array.isArray(list) ? list : [])) {
        if (a && a.id) m.set(a.id, a);
      }
      apps.next = m;
    } catch (err) {
      appListError.next = (err && err.message) || String(err);
    }
    await syncWorkspace();
    await load();
  }
  start();

  return () => {
    onSearch.cancel();
    document.removeEventListener('keydown', onKey);
    poller.dispose();
    splitter.destroy();
    detailView.unmount();
    sideView.unmount();
    shell.destroy();
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'logs',
}).catch(() => { }).then(() => {
  bootApp(({ root, ctx }) => boot(root, ctx));
});
