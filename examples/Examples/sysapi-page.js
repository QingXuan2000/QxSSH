/**
 * examples/Examples/sysapi-page.js —— 系统 API 按权限节点分组演示页
 * 要点：展示 /assets/js/core/qxssh-api.js 全量 92 个系统端点，按后端权限节点规范分组；
 *       以表格形式清晰展示端点、权限节点、功能说明、代码用法与操作调用，配备
 *       全局实时搜索功能，支持目标主机选择、参数组装、危险确认与调用结果展示。
 */
import * as api from '/assets/js/core/qxssh-api.js';
import { h, useState } from '/assets/js/core/vdom.js';
import {
  card, alertBar, badge, Checkbox, JsonViewer, table, searchBox, emptyState,
} from '/assets/js/core/components.js';
import { SYSAPI_GROUPS, SYSAPI_ITEMS } from './sysapi-groups.js';
import { t, tf, lang } from '/assets/js/core/i18n.js';

function describe(v) {
  if (v == null) return 'null';
  if (typeof v === 'string') return v;
  if (v instanceof Error) {
    return `${v.message}${v.need ? `\n\n缺少权限节点：${v.need.join(', ')}` : ''}`;
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function isStructured(v) {
  return v !== null && typeof v === 'object' && !(v instanceof Error);
}

function row(...kids) {
  return h('div', { class: 'gal-row' }, kids.filter(Boolean));
}

function note(text) {
  return h('span', { class: 'gal-note', text });
}

const TMP_NAME = 'qxssh-examples-demo.txt';
const LOCAL_DIR_KEY = 'gal-local-dir';
const LOCAL_DIR_HINT_KEY = 'app.examples.local-dir-placeholder';
const DEMO_TEXT = 'hello from examples gallery';
const confirmText = (text) => tf('app.examples.danger-confirm', { v1: text });
const URL_HINT_KEY = 'app.examples.url-note';

function groupLabel(g) {
  return g.labelKey ? t(g.labelKey) : (g.label || g.id);
}

function groupNote(g) {
  return g.noteKey ? t(g.noteKey) : (g.note || '');
}

function itemDesc(it) {
  if (it.descKey) return t(it.descKey);
  const l = typeof lang === 'function' ? lang() : '';
  if (l && l.startsWith('en') && it.descEn) return it.descEn;
  return it.desc || it.fn;
}

function matchesSysApi(it, kw, group) {
  if (!kw) return true;
  if (it.fn.toLowerCase().includes(kw)) return true;
  if (it.perm && it.perm.toLowerCase().includes(kw)) return true;
  if (it.desc && it.desc.toLowerCase().includes(kw)) return true;
  if (it.descEn && it.descEn.toLowerCase().includes(kw)) return true;
  if (it.usage && it.usage.toLowerCase().includes(kw)) return true;
  if (group) {
    if (group.id && group.id.toLowerCase().includes(kw)) return true;
    if (group.permScope && group.permScope.toLowerCase().includes(kw)) return true;
    const gl = groupLabel(group);
    if (gl && gl.toLowerCase().includes(kw)) return true;
    const gn = groupNote(group);
    if (gn && gn.toLowerCase().includes(kw)) return true;
  }
  return false;
}

function DEMO_ERROR_RESPONSE() {
  return new Response(JSON.stringify({
    error: 'demo: permission denied',
    code: 'permission',
    need: ['hosts:read'],
  }), { status: 403, headers: { 'content-type': 'application/json' } });
}

function buildArgs(fn, host) {
  const h0 = host || '';
  switch (fn) {
    case 'testHost': case 'probeHost':
    case 'forgetHostOS': case 'deleteHost':
      return [h0];
    case 'sftpList': case 'sftpStat': return [h0, '/tmp'];
    case 'sftpMkdir': return [h0, '/tmp/qxssh-demo-dir'];
    case 'sftpRename': case 'sftpMove': return [h0, '/tmp/qxssh-demo-a', '/tmp/qxssh-demo-b'];
    case 'sftpCopy': return [h0, '/tmp/qxssh-demo-a', '/tmp/qxssh-demo-copy'];
    case 'sftpRemove': return [h0, '/tmp/qxssh-demo-not-exist'];
    case 'sftpUpload': return [h0, '/tmp/qxssh-demo-upload.txt', new Blob([DEMO_TEXT])];
    case 'sftpSetAttrs': return [h0, '/tmp', {}];
    case 'sftpDownloadUrl': case 'sftpPreviewUrl': return [h0, '/tmp'];
    case 'sftpSudoAuth': return [h0, ''];
    case 'sftpSudoForget': return [h0];
    case 'execRun': return [{ host: h0, argv: ['uname', '-a'] }];
    case 'execStream': return [{ host: h0, argv: ['uname', '-a'] }];
    case 'execStatus': case 'execKill': return [''];
    case 'jobStart': return [{ host: h0, argv: ['sh', '-c', 'for i in 1 2 3; do echo tick $i; sleep 1; done'], name: 'examples demo' }];
    case 'jobStatus': case 'jobOutput': case 'jobKill': case 'jobRemove': return [h0, 'j-0000000000000000'];
    case 'jobList': return [h0];
    case 'scheduleCreate': return [{ host: h0, argv: ['uptime'], cron: '*/5 * * * *', name: 'examples demo', enabled: false }];
    case 'scheduleUpdate': return [{ id: 's-000000000000', enabled: false }];
    case 'scheduleRun': case 'scheduleDelete': return ['s-000000000000'];
    case 'scheduleList': case 'secretList': return [];
    case 'secretSet': return ['examples/demo', `demo-${Date.now()}`];
    case 'secretGet': case 'secretDelete': return ['examples/demo'];
    case 'execWSUrl': return [{ host: h0, argv: ['bash', '-l'], cols: 80, rows: 24 }];
    case 'terminalWSUrl': return [h0, 80, 24, ''];
    case 'netHttpRequest': return [{ url: 'https://example.com', method: 'GET' }];
    case 'startWebProxy': return [h0, 'http://127.0.0.1:8080'];
    case 'stopWebProxy': return [''];
    case 'tcpBridgeWSUrl': return [h0, '127.0.0.1', 8080];
    case 'createHost': case 'updateHost': return [{ name: 'demo', address: '127.0.0.1' }];
    case 'hostCredential': return [h0, 'password'];
    case 'installApp': case 'validateApp': return [null];
    case 'uninstallApp': case 'setAppEnabled': return ['no-such-app-id'];
    case 'appFileUrl': return ['no-such-app-id', 'index.html'];
    case 'permGrant': case 'permRevoke': return ['no-such-app-id', ['hosts:read']];
    case 'permClear': return ['no-such-app-id'];
    case 'saveAuditSettings': return [{}];
    case 'setAuditVerbose': return [false];
    case 'archiveAuditLogs': case 'clearAuditLogs': return [undefined];
    case 'auditNote': return ['examples', t('app.examples.probe-title')];
    case 'prefsSet': return [{ 'qx-examples-demo': 'hello' }];
    case 'errorFromResponse': return [DEMO_ERROR_RESPONSE()];
    case 'appStoreList': case 'prefsAll': case 'listUserApps': case 'listLangs': return [];
    case 'negotiateLang': return [['zh-CN', 'en-US']];
    case 'appStoreReadRaw': case 'appStoreReadUrl': case 'appStoreReadText': case 'appStoreReadJSON': return ['demo.txt'];
    case 'appStoreReadJSONOr': return ['demo.json', { ok: true, note: 'default fallback' }];
    case 'appStoreWriteText': return ['demo.txt', tf('app.examples.probe-written-at', { v1: (new Date().toLocaleString()) })];
    case 'appStoreWriteBlob': return ['demo.bin', new Blob(['bin'])];
    case 'appStoreMkdir': return ['out'];
    case 'appStoreRename': return ['demo.txt', 'out/renamed.txt'];
    case 'appStoreDelete': return ['out'];
    case 'localFsList': case 'localFsReadRaw': case 'localFsReadUrl':
      return [localFsBase()];
    case 'localFsWrite': return [tmpPath(), t('app.examples.file-demo')];
    case 'localFsMkdir': return [localFsBase()];
    case 'localFsRename': return [tmpPath(), `${tmpPath()}.bak`];
    case 'localFsDelete': return [`${tmpPath()}.bak`];
    case 'auditStats': return [{ host: h0 || undefined, limit: 100 }];
    case 'exportAuditLogs': return [{ host: h0 || undefined, format: 'json', limit: 100 }];
    case 'generateKey': return [{ name: 'examples-key', type: 'ed25519', comment: 'examples@qxssh' }];
    case 'listKeys': return [];
    case 'importKey': return [{ name: 'imported-demo', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n...' }];
    case 'deleteKey': return ['key_demo_0000'];
    case 'deployKey': return [{ host: h0, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePublicKeyForDeploymentOnly examples@qxssh' }];
    case 'batchExec': return [{ hosts: h0 ? [h0] : [], cmd: 'uptime', timeout: 15 }];
    case 'batchUpload': return [{ hosts: h0 ? [h0] : [], path: '/tmp/qxssh-batch-demo.txt', content: 'batch test content' }];
    default: return [];
  }
}

function localFsBase() {
  return lsGet(LOCAL_DIR_KEY) || '';
}

function tmpPath() {
  return `${localFsBase()}/${TMP_NAME}`;
}

function lsGet(k) {
  try {
    return window.localStorage.getItem(k) || '';
  } catch {
    return '';
  }
}

function lsSet(k, v) {
  try {
    window.localStorage.setItem(k, v);
  } catch {
  }
}

/** 系统 API 演示页：按权限节点分组展示全部端点，配备表格与实时搜索功能 */
export function SysApiPage() {
  const hosts = useState(null);
  const hostId = useState('');
  const result = useState(null);
  const opened = useState(new Set());
  const filterKw = useState('');

  function show(v) {
    result.next = { value: v, structured: isStructured(v) };
  }

  async function loadHosts() {
    try {
      const d = await api.listHosts();
      const hs = Array.isArray(d) ? d : (d && d.hosts) || [];
      hosts.next = { list: hs, err: '' };
    } catch (e) {
      hosts.next = { list: [], err: e.message };
    }
  }

  const hostView = hosts.value;
  const hostList = hostView ? hostView.list : [];
  const res = result.value;
  const kw = filterKw.value;

  const filteredGroups = SYSAPI_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => matchesSysApi(it, kw, g)),
  })).filter((g) => g.items.length > 0);

  const totalMatched = filteredGroups.reduce((acc, g) => acc + g.items.length, 0);

  const searchBar = h('div', { class: 'gal-row gal-search-bar', style: { marginBottom: '0.6rem' } }, [
    searchBox(t('app.examples.api-search-placeholder'), (v) => {
      filterKw.next = String(v || '').trim().toLowerCase();
    }, { value: kw }),
    h('span', { class: 'qx-count' }, [
      kw
        ? tf('app.examples.search-count-matched', { v1: totalMatched, v2: SYSAPI_ITEMS.length })
        : tf('app.examples.endpoint-count', { v1: SYSAPI_ITEMS.length }),
    ]),
    kw
      ? h('button', {
        class: 'btn btn-ghost btn-xs',
        text: t('app.examples.btn-clear-search'),
        onClick: () => { filterKw.next = ''; },
      })
      : null,
  ]);

  const hostBar = h('div', {
    class: 'gal-row',
    onMount: loadHosts,
  }, [
    note(t('app.examples.target-host')),
    h('select', {
      class: 'input',
      onChange: (e) => { hostId.next = e.target.value; },
    }, (hostList.length || (hostView && hostView.err)
      ? [{ value: '', text: hostList.length ? t('app.examples.host-none') : t('app.examples.host-none-available') }]
      : [{ value: '', text: t('app.examples.host-loading') }]
    ).concat(hostList.map((x) => ({ value: x.id, label: `${x.name}（${x.address}）` })))
      .map((o) => h('option', { key: o.value || '-', value: o.value, text: o.label }))),
    h('span', {
      class: 'gal-note',
      text: hostView
        ? (hostView.err ? tf('app.examples.host-read-failed', { v1: (hostView.err) }) : tf('app.examples.host-count', { v1: (hostList.length) }))
        : t('app.examples.host-loading'),
    }),
  ]);

  const localDirInput = h('input', {
    class: 'input',
    placeholder: t(LOCAL_DIR_HINT_KEY),
    value: localFsBase(),
    onChange: (e) => lsSet(LOCAL_DIR_KEY, e.target.value),
  });

  function itemAction(it) {
    const fn = api[it.fn];
    if (typeof fn !== 'function') {
      return h('span', { class: 'gal-note', text: tf('app.examples.stale-export', { v1: it.fn }) });
    }
    const disabled = !!it.host && !hostId.value;
    const tipText = [
      `[${it.perm}]`,
      it.host && !hostId.value ? t('app.examples.need-host') : '',
    ].filter(Boolean).join('\n');

    if (it.url) {
      return h('button', {
        class: 'btn btn-outline btn-xs',
        text: t('app.examples.btn-get-url'),
        disabled,
        dataset: tipText ? { tip: tipText } : {},
        onClick: () => {
          try {
            const u = fn(...buildArgs(it.fn, hostId.value));
            show({ url: u, 说明: t(URL_HINT_KEY) });
          } catch (e) {
            show(e);
          }
        },
      });
    }

    return h('button', {
      class: it.danger ? 'btn btn-danger btn-xs' : 'btn btn-outline btn-xs',
      text: it.danger ? t('app.examples.btn-run-danger') : t('app.examples.btn-run'),
      disabled,
      dataset: tipText ? { tip: tipText } : {},
      onClick: async () => {
        if (it.danger && !window.confirm(confirmText(it.fn))) return;
        try {
          show(await fn(...buildArgs(it.fn, hostId.value)));
        } catch (e) {
          show(e);
        }
      },
    });
  }

  const columns = [
    {
      key: 'fn',
      label: t('app.examples.col-endpoint'),
      width: '170px',
      render: (it) => h('code', { class: 'gal-api-name' }, `${it.fn}()`),
    },
    {
      key: 'perm',
      label: t('app.examples.col-perm'),
      width: '130px',
      render: (it) => badge(it.perm, it.perm === 'public' ? 'default' : (it.danger ? 'danger' : 'info')),
    },
    {
      key: 'desc',
      label: t('app.examples.col-desc'),
      render: (it) => h('span', { class: 'gal-table-desc', text: itemDesc(it) }),
    },
    {
      key: 'usage',
      label: t('app.examples.col-usage'),
      render: (it) => h('code', { class: 'gal-table-code', text: it.usage || `${it.fn}()` }),
    },
    {
      key: 'action',
      label: t('app.examples.col-action'),
      width: '90px',
      cls: 'qx-actions-col',
      render: (it) => itemAction(it),
    },
  ];

  function groupCard(g) {
    const hidden = g.items.filter((it) => it.hidden);
    const shown = opened.value.has(g.id);
    const items = g.items.filter((it) => !it.hidden || shown || kw);
    const cardTitle = `${groupLabel(g)}（${g.items.length}）`;

    return card(cardTitle, [
      h('div', { class: 'gal-row', style: { marginBottom: '6px' } }, [
        badge(g.badge || g.permScope, 'info'),
        g.items.some((it) => it.host) ? note(t('app.examples.group-needs-host')) : null,
      ].filter(Boolean)),
      h('div', { class: 'gal-table-box' }, [
        table(columns, items, { rowKey: (it) => it.fn }),
      ]),
      hidden.length && !kw
        ? h('div', { class: 'gal-row', style: { marginTop: '6px' } }, [
          h(Checkbox, {
            label: tf('app.examples.show-hidden-risky', { v1: (hidden.length) }),
            checked: shown,
            onChange: (on) => {
              const s = new Set(opened.value);
              if (on) s.add(g.id);
              else s.delete(g.id);
              opened.next = s;
            },
          }),
        ])
        : null,
      note(groupNote(g)),
    ]);
  }

  return [
    searchBar,
    card(t('app.examples.notes'), [
      alertBar(
        'info',
        tf('app.examples.notes-summary', { v1: (SYSAPI_ITEMS.length), v2: (SYSAPI_GROUPS.length) }),
        t('app.examples.notes-source')
        + t('app.examples.notes-verify'),
      ),
      alertBar(
        'warn',
        t('app.examples.notes-default-args'),
        t('app.examples.notes-buildargs')
        + t('app.examples.notes-danger'),
      ),
      hostBar,
      row(note(t('app.examples.local-file-dir')), localDirInput),
    ]),

    kw && totalMatched === 0
      ? emptyState({
        title: t('app.examples.search-empty-title'),
        desc: t('app.examples.search-empty-desc'),
      })
      : filteredGroups.map(groupCard),

    card(t('app.examples.result'), [
      h('div', { class: 'gal-row' }, [badge(tf('app.examples.endpoint-count', { v1: (SYSAPI_ITEMS.length) }), 'default')]),
      h('pre', {
        class: 'gal-out',
        hidden: !!(res && res.structured),
        text: res && res.structured ? '' : describe(res ? res.value : null),
      }),
      h('div', { class: 'gal-json-box', hidden: !(res && res.structured) }, [
        h(JsonViewer, { value: res && res.structured ? res.value : {}, maxDepth: 2 }),
      ]),
    ]),
  ];
}
