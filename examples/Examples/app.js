/**
 * examples/Examples/app.js —— 示例应用主入口，装配并渲染全部演示页签
 * 要点：该示例演示 QxSSH 应用 SDK —— 从 /assets/js/app-bridge.js 取宿主桥、从 /assets/js/core/* 取基础库，
 *       用 createAppShell 组界面；此处聚合图标、组件、SDK 端点、宿主桥与平台模块各演示页并完成启动。
 */
import {
  bootApp, setTitle, hostToast, hostDialog, writeClipboard, pickPath,
  getHostInfo, getWorkspaceInfo, listWindows, listApps, notify,
  windowControl, getWindowRect, setWindowBadge, windowFlash, openApp, setTheme,
  notifyAppsChanged, openSettings, onThemeChange, reloadApp,
  applyWallpaper, setGlass, applyTaskbar, windowClass, setTitleAccent,
  closeSelf, notifyPermChanged, requestAppPermission,
  provideApi, revokeApi, callAppApi, callAppApis, listAppApis,
  publishEvent, onEvent, onWindowState,
  getContext, onInit, notifySessionRevoked, onSessionChange, onPermChange,
  focusWindow, openExternal, reportAppError, setWindowRect,
  applyStoredTheme, applyStoredGlass, APP_API_ERR, onAppApiChange,
} from '/assets/js/app-bridge.js';
import { sh, runTable, which, fetchVia } from '/assets/js/core/appkit.js';

import { h, Fragment, createView, useState } from '/assets/js/core/vdom.js';
import { signal, computed } from '/assets/js/core/signal.js';
import {
  esc, fmtSize, fmtRate, fmtTime, fmtDur, fmtCount, timeAgo, createPoller, debounce,
  modLabel,
} from '/assets/js/core/dom.js';
import { setupAppI18n, i18nSelect, i18nButton, i18nMenu } from '/assets/js/core/i18n-ui.js';
import * as I18NUI from '/assets/js/core/i18n-ui.js';
import { t, tf, lang, onLangChange } from '/assets/js/core/i18n.js';
import { icon, iconNames } from '/assets/js/icons/index.js';
import * as COMPONENTS from '/assets/js/core/components.js';
import {
  card, sectionTitle, keyValue, kvGrid, field, badge, statusDot, statusBar,
  alertBar, iconButton, inputField, selectField, textareaField, chipGroup, segmented,
  breadcrumb, searchBox, toolbar, menu, openPopper, listRow, table,
  progressBar, progressRing, statTile, codeBlock, spinner, emptyState, dialog,
  errorState, emptyAction, skeleton, copyButton, copyField, promptDialog,
  pagination, steps, timeline, kbd, segmentedBar, execResultCard, execResults,
  tipAttrs, loadingMask, sidebarSections, Tabs, MenuPanel, DialogPanel,
  FloatCard, Tree, JsonViewer, LogPanel, Collapsible, Checkbox, SwitchToggle,
  PasswordField, SliderField, StepperField, RadioGroup, TagInput, KvEditor,
  ConfirmBar, AsyncButton, DropdownButton, FileDrop, SearchSelect, sideAction,
} from '/assets/js/core/components.js';
import { toast, task, copyText, confirmAction } from '/assets/js/core/ui.js';
import { getInfo, appStoreReadJSONOr, appStoreWriteText } from '/assets/js/core/qxssh-api.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import { SysApiPage } from './sysapi-page.js';
import { COMPONENT_CLASSES, COMPONENT_CLASS, componentsIn, matchesComponent, SECTION_COMPS } from './component-classes.js';
import * as CORE_API from '/assets/js/core/qxssh-api.js';
import { SYSAPI_GROUPS, SYSAPI_ITEMS } from './sysapi-groups.js';
import { qx } from '/assets/js/qxssh-sdk.js';
import * as CODE from '/assets/js/core/code-editor.js';
import { CodeEditor, codeField } from '/assets/js/core/code-editor.js';
import * as VLIST from '/assets/js/core/virtual-list.js';
import { VirtualList, scrollToRow } from '/assets/js/core/virtual-list.js';
import * as CHARTS from '/assets/js/core/charts.js';
import { LineChart, timeSeries } from '/assets/js/core/charts.js';
import * as DATAVIEW from '/assets/js/core/data-view.js';
import { DataView, createDataView } from '/assets/js/core/data-view.js';
import * as SPLITTER from '/assets/js/core/splitter.js';
import { createSplitter } from '/assets/js/core/splitter.js';
import {
  defineJsonShader, timingShader, languageShader, composeShaders, fieldShader, listJsonShaders,
} from '/assets/js/core/json-shader.js';

const TAB_DEFS = [
  { id: 'icons', key: 'app.examples.tab-icons', icon: 'star' },
  { id: 'components', key: 'app.examples.tab-components', icon: 'layout-grid' },
  { id: 'sysapi', key: 'app.examples.tab-sysapi', icon: 'braces' },
  { id: 'sdk', key: 'app.examples.tab-sdk', icon: 'terminal' },
];

function tabsNow() {
  return TAB_DEFS.map((tab) => ({ id: tab.id, label: t(tab.key), icon: tab.icon }));
}

const OUT_IDLE_KEY = 'app.examples.click-for-result';

function outBox(initial = t(OUT_IDLE_KEY)) {
  const text = useState(initial);
  return {
    text,
    show(value) {
      text.next = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    },
  };
}

function outNode(box) {
  return h(OutPre, { text: box.text });
}

function OutPre(props) {
  return h('pre', { class: 'gal-out', text: props.text.value });
}

function btn(text, onclick, cls = 'btn btn-outline btn-sm') {
  return h('button', { class: cls, text, onClick: onclick });
}

function getCardComps(title, key) {
  if (key && SECTION_COMPS[key]) return SECTION_COMPS[key];
  for (const [k, comps] of Object.entries(SECTION_COMPS)) {
    if (t(k) === title) return comps;
  }
  return [];
}

function demoCard(title, children, opts = {}) {
  const node = card(title, [h('div', { class: 'gal-col' }, children)], opts);
  node._title = title;
  node._key = opts.key || '';
  node._comps = opts.comps || getCardComps(title, opts.key) || [];
  if (opts.isResult || title === t('app.examples.label-result')) {
    node._isResult = true;
  }
  return node;
}

function filterDemoCards(cards, props) {
  if (!props || !props.filterComps || !props.filterComps.length) return cards;
  const set = new Set(props.filterComps.map((s) => s.toLowerCase()));
  const kw = (props.kw || '').trim().toLowerCase();
  const kept = [];
  let resultCard = null;
  for (const c of cards) {
    if (!c) continue;
    if (c._isResult) {
      resultCard = c;
      continue;
    }
    const comps = c._comps || getCardComps(c._title, c._key) || [];
    const title = String(c._title || '').toLowerCase();
    const matchesComp = comps.some((comp) => set.has(comp.toLowerCase()));
    const matchesKw = kw && title.includes(kw);
    if (matchesComp || matchesKw) {
      kept.push(c);
    }
  }
  if (kept.length && resultCard) {
    kept.push(resultCard);
  }
  return kept;
}

function note(text) {
  return h('span', { class: 'gal-note', text });
}

function row(...kids) {
  return h('div', { class: 'gal-row' }, kids.filter(Boolean));
}

const FLOAT_CARD_TEXT_KEY = 'app.examples.floatcard-intro';
const CRUMB_TEXT = (label, i, total) => tf('app.examples.breadcrumb-item', { v1: label, v2: (i + 1), v3: total });
const PASS_TEXT = (v) => `passwordField: ${v ? tf('app.examples.pass-entered', { v1: v.length }) : t('app.examples.empty-parens')}`;
const DROP_TEXT = (files) =>
  `fileDrop：${files.map((f) => `${f.name}（${fmtSize(f.size)}）`).join('\n')}`;
const FIELD_TEXT_KEY = 'app.examples.field-note';
const TREE_NOTE_KEY = 'app.examples.collapsible-note';
const DEL_HINT_KEY = 'app.examples.confirmbar-hint';
const SSH_TEXT = 'ssh root@10.0.0.1 -p 22';
const HOST_DLG_DESC_KEY = 'app.examples.hostdialog-note';
const URL_TEXT = (v) => `pickPath -> ${JSON.stringify(v)}`;
function notifyArgs() {
  return { title: 'Examples', body: t('app.examples.test-notification') };
}
const NOTIFY_TEXT = (ok) => `notify -> ${ok}`;
const CLIP_TEXT = (ok) => `writeClipboard -> ${ok}`;
const PERM_TEXT = (ok) => `requestAppPermission(['hosts:read']) -> ${ok}`;
const PERM2 = ['server:read', 'logs:read'];
const PERM2_TEXT = (ok) => `requestAppPermission(['server:read','logs:read']) -> ${ok}`;
const JSON_SAMPLE = { name: 'node-01', tags: ['web', 'db'], port: 22 };
// critical-chain 形状：键里带「单元名 @激活时刻 +自身耗时」，交给 keySplit 拆成键名 + 尾段
// 时刻可能是多段（@1min 44.881s），duration 可能省略（target 类单元），两种形状都要能上色
const JSON_CHAIN_SAMPLE = {
  'graphical.target @1min 44.881s': {
    'multi-user.target @20.664s': {
      'docker.service @4.512s +588ms': true,
      'getty@tty1.service @3.120s +210ms': true,
      'systemd-journald.service @2.884s +1.402s': true,
    },
  },
};
// 日志行交给 languageShader('log')：级别、时间戳、IP、数字各自取色
const JSON_LOG_SAMPLE = {
  level: 'ERROR',
  time: '2026-10-20T12:00:00Z',
  msg: 'ssh: connect to host 10.0.0.9 port 22: Connection refused',
  retry: 3,
  fallback: 'WARN retry scheduled at 10.0.0.10',
};
// 演示自定义着色器：数值型键命中阈值时换成告警色
defineJsonShader('examples-threshold', (text, ctx) => {
  if (ctx.slot !== 'value') return null;
  const m = /^"?(\d+(?:\.\d+)?)%"?$/.exec(String(text));
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 80) return [{ text: String(text), class: 'gal-json-hot' }];
  if (n >= 50) return [{ text: String(text), class: 'gal-json-warm' }];
  return [{ text: String(text), class: 'gal-json-cool' }];
});
const JSON_UTIL_SAMPLE = { cpu: '92%', mem: '61%', disk: '38%', load: '4.10' };
// composeShaders + fieldShader 的样例：unit 字段走时刻着色器，其余字段回落到 log 语法
const JSON_EVENT_SAMPLE = {
  unit: 'docker.service @4.512s +588ms',
  peer: 'WARN containerd.service @4.101s +1.204s',
  note: 'INFO both units reached running state',
};
const EXEC_SAMPLE = { ok: true, name: 'uname -a', out: 'Linux node-01 6.1.0', dur: '0.02s' };
const WINDOW_CLASS = 'gal-demo-class';

const ICON_PAGE = 300;
const ICON_HINT_KEY = 'app.examples.icon-search-placeholder';

const REEXPORTED = new Set(['icon', 'iconNames', 'hasIcon']);

const ALL_COMPONENTS = {
  ...COMPONENTS,
  CodeEditor: CODE.CodeEditor,
  codeField: CODE.codeField,
  VirtualList: VLIST.VirtualList,
  scrollToRow: VLIST.scrollToRow,
  LineChart: CHARTS.LineChart,
  timeSeries: CHARTS.timeSeries,
  DataView: DATAVIEW.DataView,
  createDataView: DATAVIEW.createDataView,
  createSplitter: SPLITTER.createSplitter,
  i18nSelect: I18NUI.i18nSelect,
  i18nButton: I18NUI.i18nButton,
  i18nMenu: I18NUI.i18nMenu,
};

function coverageReport() {
  const exported = new Set(Object.keys(ALL_COMPONENTS));
  const missing = [];
  const unknown = [];
  for (const name of exported) {
    if (REEXPORTED.has(name)) continue;
    if (!COMPONENT_CLASS[name]) missing.push(name);
  }
  for (const [name, cls] of Object.entries(COMPONENT_CLASS)) {
    if (!exported.has(name)) unknown.push(`${name}（${cls}）`);
  }
  return { missing, unknown, total: Object.keys(COMPONENT_CLASS).length };
}

function apiCoverageReport() {
  const exported = new Set(Object.keys(CORE_API));
  const listed = new Set();
  for (const g of SYSAPI_GROUPS) for (const it of g.items) listed.add(it.fn);
  const missing = [];
  const unknown = [];
  for (const name of exported) {
    if (!listed.has(name)) missing.push(name);
  }
  for (const name of listed) {
    if (!exported.has(name)) unknown.push(name);
  }
  return { missing, unknown, total: listed.size };
}

// SDK_GROUPS 的 item.name 写法是 'qx.xxx()' / 'qx.APP_API_ERR' / 'qx.sys'，
// 这里归一化成 qx 的顶层键名（去掉 qx. 前缀与末尾括号），再与 Object.keys(qx) 对差集。
function sdkKeyOf(name) {
  return String(name || '')
    .replace(/^qx\./, '')
    .replace(/\(\s*\)$/, '')
    .trim();
}

function sdkCoverageReport() {
  const exported = Object.keys(qx || {});
  const listed = new Set();
  for (const g of SDK_GROUPS) {
    for (const it of g.items) {
      const k = sdkKeyOf(it.name);
      // 'qx.kit.sh()' 这类既细到方法名的条目归一化后带点，不参与顶层键比对
      if (k && !k.includes('.')) listed.add(k);
    }
  }
  const missing = exported.filter((k) => !listed.has(k));
  const unknown = [...listed].filter((k) => !exported.includes(k));
  return { missing, unknown, total: listed.size, exported: exported.length };
}

let iconFilter = null;

function IconsPage() {
  const all = iconNames();
  const kw = useState('');
  const page = useState(0);
  if (!iconFilter) {
    iconFilter = debounce((v) => {
      kw.next = String(v || '').trim().toLowerCase();
      page.next = 0;
    }, 250);
  }

  const list = kw.value ? all.filter((n) => n.toLowerCase().includes(kw.value)) : all;
  const pages = Math.max(1, Math.ceil(list.length / ICON_PAGE));
  const cur = Math.min(page.value, pages - 1);
  const slice = list.slice(cur * ICON_PAGE, (cur + 1) * ICON_PAGE);

  return [
    h('div', {
      class: 'gal-row gal-search-bar',
      style: { marginBottom: '0.6rem' },
      onUnmount: () => { iconFilter?.cancel(); iconFilter = null; },
    }, [
      searchBox(t(ICON_HINT_KEY), (v) => iconFilter(v), { value: kw.value }),
      h('span', {
        class: 'qx-count',
        text: kw.value ? tf('app.examples.icon-count-filtered', { v1: (list.length), v2: (all.length) }) : tf('app.examples.icon-count-all', { v1: (all.length) }),
      }),
      kw.value
        ? h('button', {
          class: 'btn btn-ghost btn-xs',
          text: t('app.examples.btn-clear-search'),
          onClick: () => {
            kw.next = '';
            page.next = 0;
          },
        })
        : null,
    ]),
    list.length === 0
      ? emptyState({
        title: t('app.examples.search-empty-title'),
        desc: t('app.examples.search-empty-desc'),
      })
      : card(t('app.examples.icon-page-desc'), [
        h('div', { class: 'qx-card-scroll' }, [
          h('div', { class: 'gal-icon-grid' }, slice.map((n) => h('button', {
            key: n,
            class: 'gal-icon-tile',
            type: 'button',
            dataset: { tip: tf('app.examples.icon-click-to-copy', { v1: n }) },
            onClick: async () => {
              const ok = await copyText(n);
              toast(ok ? tf('app.examples.icon-copied', { v1: n }) : t('app.examples.icon-copy-failed'), ok ? 'success' : 'error');
            },
          }, [
            h('span', { html: icon(n) }),
            h('span', { class: 'gal-icon-name', text: n }),
          ]))),
        ]),
        h('div', { class: 'gal-row gal-pager' }, [
          pagination(cur + 1, pages, (p) => { page.next = p - 1; }),
        ]),
      ], { fill: true, cls: 'gal-fill-card' }),
    note(t('app.examples.icon-resolution-1')
      + t('app.examples.icon-resolution-2')),
  ];
}

const SDK_SNIPPETS = [
  {
    key: 'context',
    titleKey: 'app.examples.sdk-snippet-context',
    code: `// 查询当前应用上下文与主机信息
const ctx = await qx.context();
const host = await qx.host();
return { ctx, host };`,
  },
  {
    key: 'dialog',
    titleKey: 'app.examples.sdk-snippet-dialog',
    code: `// 弹窗交互链: confirm -> prompt -> alert
const ok = await qx.confirm('操作确认', '是否输入自定义参数？');
if (!ok) return { cancelled: true };
const val = await qx.prompt('输入参数', '请输入您的指令:', { defaultValue: 'status' });
if (val) await qx.alert('输入完成', '您输入了: ' + val);
return { val };`,
  },
  {
    key: 'sh',
    titleKey: 'app.examples.sdk-snippet-sh',
    code: `// 执行命令并分行获取输出
const host = (await qx.context())?.hostId || '';
const lines = await qx.kit.runLines(host, ['uname', '-a']);
return { lines };`,
  },
  {
    key: 'metrics',
    titleKey: 'app.examples.sdk-snippet-metrics',
    code: `// 采集主机系统指标
const host = (await qx.context())?.hostId || '';
const metrics = await qx.kit.collectMetrics(host);
return metrics;`,
  },
  {
    key: 'table',
    titleKey: 'app.examples.sdk-snippet-table',
    code: `// 结构化表格文本解析
const raw = 'NAME      STATUS    ROLES\\nnode-01   Ready     control-plane\\nnode-02   Ready     worker';
const parsed = qx.kit.parseTable(raw);
return parsed;`,
  },
  {
    key: 'sys',
    titleKey: 'app.examples.sdk-snippet-sys',
    code: `// 查询远端系统硬件、负载与磁盘/内存状态
const host = (await qx.context())?.hostId || '';
const [df, mem, cpu, os, up] = await Promise.all([
  qx.sys.diskUsage(host, '/'),
  qx.sys.memoryUsage(host),
  qx.sys.cpuInfo(host),
  qx.sys.osRelease(host),
  qx.sys.uptime(host),
]);
return { df, mem, cpu, os, up };`,
  },
  {
    key: 'proc',
    titleKey: 'app.examples.sdk-snippet-proc',
    code: `// 查询进程列表与网络监听端口
const host = (await qx.context())?.hostId || '';
const [processes, ports] = await Promise.all([
  qx.proc.list(host, { limit: 10 }),
  qx.net.ports(host),
]);
return { processes, ports };`,
  },
  {
    key: 'fs',
    titleKey: 'app.examples.sdk-snippet-fs',
    code: `// 远端文件与 JSON 读写
const host = (await qx.context())?.hostId || '';
const testPath = '/tmp/qxssh-demo-config.json';
await qx.fs.writeJSON(host, testPath, { hello: 'world', time: new Date().toISOString() });
const exists = await qx.fs.exists(host, testPath);
const readBack = await qx.fs.readJSON(host, testPath);
return { exists, readBack };`,
  },

  {
    key: 'net',
    titleKey: 'app.examples.sdk-snippet-net',
    code: `// 查询网络网卡接口、路由表与远程端口探测
const host = (await qx.context())?.hostId || '';
const [interfaces, routes, portCheck] = await Promise.all([
  qx.net.interfaces(host),
  qx.net.routes(host),
  qx.net.testPort(host, '127.0.0.1', 22, { timeoutSec: 2 }),
]);
return { interfaces, routes, portCheck };`,
  },
];

const SDK_GROUPS = [
  {
    id: 'hosts',
    permScope: 'hosts:read',
    labelKey: 'app.examples.sdk-group-hosts',
    badge: 'hosts:read',
    items: [
      { name: 'qx.host()', perm: 'hosts:read', desc: '获取当前连接的目标主机信息', descEn: 'Get current connected host info', usage: 'await qx.host()', run: () => qx.host() },
      { name: 'qx.context()', perm: 'hosts:read', desc: '获取当前应用运行上下文（appId, hostId 等）', descEn: 'Get app runtime context (appId, hostId, etc.)', usage: 'await qx.context()', run: () => qx.context() },
      { name: 'qx.kit.collectHostInfo()', perm: 'hosts:read', desc: '综合采集主机 CPU/内存/系统版本信息', descEn: 'Collect CPU, memory, and OS details', usage: 'await qx.kit.collectHostInfo(hostId)', run: (ctx) => qx.kit.collectHostInfo(ctx?.hostId || '') },
      { name: 'qx.kit.collectMetrics()', perm: 'hosts:read', desc: '实时采集主机性能指标数据', descEn: 'Collect live CPU & memory utilization metrics', usage: 'await qx.kit.collectMetrics(hostId)', run: (ctx) => qx.kit.collectMetrics(ctx?.hostId || '') },
    ],
  },
  {
    id: 'exec',
    permScope: 'exec:run / exec:stream',
    labelKey: 'app.examples.sdk-group-exec',
    badge: 'exec:run',
    items: [
      { name: 'qx.kit.sh()', perm: 'exec:run', desc: '在目标主机快速执行 Shell 命令', descEn: 'Execute shell command on target host', usage: 'await qx.kit.sh("uname -a")', run: () => qx.kit.sh('uname -a') },
      { name: 'qx.kit.runLines()', perm: 'exec:run', desc: '执行命令并将标准输出按行切分', descEn: 'Run command and split stdout into lines', usage: 'await qx.kit.runLines(hostId, ["df", "-h"])', run: (ctx) => qx.kit.runLines(ctx?.hostId || '', ['df', '-h']) },
      { name: 'qx.kit.runJSON()', perm: 'exec:run', desc: '执行命令并将输出解析为 JSON 对象', descEn: 'Run command and parse stdout as JSON', usage: 'await qx.kit.runJSON(hostId, ["cat", "/etc/os-release"])', run: (ctx) => qx.kit.runJSON(ctx?.hostId || '', ['cat', '/etc/os-release']) },
      { name: 'qx.kit.which()', perm: 'exec:run', desc: '批量探测主机是否存在指定命令', descEn: 'Check existence of binaries on host', usage: 'await qx.kit.which(hostId, ["uname", "curl"])', run: (ctx) => qx.kit.which(ctx?.hostId || '', ['uname', 'curl']) },
      { name: 'qx.kit.parseTable()', perm: 'exec:run', desc: '解析常见命令对齐纯文本为表格结构', descEn: 'Parse fixed-width table text into objects', usage: 'qx.kit.parseTable(tableText)', run: () => qx.kit.parseTable('CONTAINER_ID   IMAGE      COMMAND\n1a2b3c4d5e   nginx:1.25  "nginx -g"') },
    ],
  },
  {
    id: 'job',
    permScope: 'job:run / job:list',
    labelKey: 'app.examples.sdk-group-job',
    badge: 'job:run',
    items: [
      { name: 'qx.kit.jobs.list()', perm: 'job:list', desc: '列出目标主机上全部后台任务', descEn: 'List all background jobs on host', usage: 'await qx.kit.jobs.list(hostId)', run: (ctx) => qx.kit.jobs.list(ctx?.hostId || '') },
    ],
  },
  {
    id: 'sudo',
    permScope: 'sudo:request',
    labelKey: 'app.examples.sdk-group-sudo',
    badge: 'sudo:request',
    items: [
      { name: 'qx.kit.ensureSudo()', perm: 'sudo:request', desc: '确保在目标主机上已获得提权会话', descEn: 'Ensure sudo elevated session on target host', usage: 'await qx.kit.ensureSudo(hostId)', run: (ctx) => qx.kit.ensureSudo(ctx?.hostId || '') },
    ],
  },
  {
    id: 'network',
    permScope: 'net:tcp / net:http',
    labelKey: 'app.examples.sdk-group-net',
    badge: 'network',
    items: [
      { name: 'qx.listeningPorts()', perm: 'exec:run', desc: '查询远端主机正在监听的网络端口及所属进程', descEn: 'Query listening ports and associated processes on host', usage: 'await qx.listeningPorts(hostId)', run: (ctx) => qx.listeningPorts(ctx?.hostId || '') },
      { name: 'qx.netInterfaces()', perm: 'exec:run', desc: '查询远端网络接口列表与 IP/MAC 地址配置', descEn: 'Query network interfaces, IPs and MAC addresses', usage: 'await qx.netInterfaces(hostId)', run: (ctx) => qx.netInterfaces(ctx?.hostId || '') },
      { name: 'qx.routeTable()', perm: 'exec:run', desc: '查询远端内核路由表与默认网关', descEn: 'Query remote kernel routing table and gateways', usage: 'await qx.routeTable(hostId)', run: (ctx) => qx.routeTable(ctx?.hostId || '') },
      { name: 'qx.testPort()', perm: 'exec:run', desc: '借远端主机探测指定 IP 和端口连通性', descEn: 'Test TCP port reachability from remote host', usage: 'await qx.testPort(hostId, "127.0.0.1", 22)', run: (ctx) => qx.testPort(ctx?.hostId || '', '127.0.0.1', 22) },
      { name: 'qx.dnsResolve()', perm: 'exec:run', desc: '借远端主机执行 DNS 解析查询域名记录', descEn: 'Resolve domain name through remote DNS', usage: 'await qx.dnsResolve(hostId, "localhost")', run: (ctx) => qx.dnsResolve(ctx?.hostId || '', 'localhost') },
      { name: 'qx.pingHost()', perm: 'exec:run', desc: '借远端主机 ping 目标网络测试连通性与往返延迟', descEn: 'Ping target host/IP through remote host for latency & packet loss', usage: 'await qx.pingHost(hostId, "127.0.0.1")', run: (ctx) => qx.pingHost(ctx?.hostId || '', '127.0.0.1', { count: 2 }) },
      { name: 'qx.kit.fetchVia()', perm: 'net:http', desc: '通过指定主机代理发起 HTTP 请求', descEn: 'Send HTTP request proxied through host', usage: 'await qx.kit.fetchVia(hostId, "https://example.com")', run: (ctx) => qx.kit.fetchVia(ctx?.hostId || '', 'https://example.com') },
      { name: 'qx.kit.tcpConnect()', perm: 'net:tcp', desc: '建立远端 TCP 端口的流式桥接连接', descEn: 'Connect to remote host TCP port via bridge', usage: 'await qx.kit.tcpConnect(hostId, "127.0.0.1", 8080)', run: () => 'tcpConnect: ready for ws bridge' },
    ],
  },
  {
    id: 'apps',
    permScope: 'apps:list',
    labelKey: 'app.examples.sdk-group-apps',
    badge: 'apps:list',
    items: [
      { name: 'qx.listApps()', perm: 'apps:list', desc: '列出系统中已安装的所有应用清单', descEn: 'List all installed applications', usage: 'await qx.listApps()', run: () => qx.listApps() },
      { name: 'qx.openApp()', perm: 'apps:list', desc: '启动并打开指定应用窗口', descEn: 'Launch specified application window', usage: 'qx.openApp("settings")', run: () => { qx.openApp('settings'); return 'openApp("settings")'; } },
    ],
  },
  {
    id: 'ui',
    permScope: 'ui:settings / ui:notify',
    labelKey: 'app.examples.sdk-group-ui',
    badge: 'ui:settings',
    items: [
      { name: 'qx.openSettings()', perm: 'ui:settings', desc: '呼出系统全局设置弹窗', descEn: 'Open system global settings dialog', usage: 'qx.openSettings()', run: () => { qx.openSettings(); return 'openSettings()'; } },
      { name: 'qx.setTheme()', perm: 'ui:settings', desc: '切换系统暗色或亮色主题', descEn: 'Toggle dark / light theme', usage: 'qx.setTheme("dark")', run: () => { qx.setTheme('dark'); return 'setTheme("dark")'; } },
      { name: 'qx.applyWallpaper()', perm: 'ui:settings', desc: '切换系统桌面壁纸', descEn: 'Change desktop wallpaper', usage: 'qx.applyWallpaper(1)', run: () => { qx.applyWallpaper(1); return 'applyWallpaper(1)'; } },
      { name: 'qx.applyTaskbar()', perm: 'ui:settings', desc: '调整桌面任务栏停靠位置', descEn: 'Set taskbar position (top/bottom)', usage: 'qx.applyTaskbar("top")', run: () => { qx.applyTaskbar('top'); return 'applyTaskbar("top")'; } },
      { name: 'qx.setGlass()', perm: 'ui:settings', desc: '调整界面磨砂玻璃特效透明度', descEn: 'Adjust frosted glass blur scale', usage: 'qx.setGlass(1.2)', run: () => { qx.setGlass(1.2); return 'setGlass(1.2)'; } },
      { name: 'qx.notify()', perm: 'ui:notify', desc: '发送系统级桌面通知消息', descEn: 'Send desktop system notification', usage: 'await qx.notify({ title, body })', run: () => qx.notify(notifyArgs()) },
    ],
  },
  {
    id: 'batch',
    permScope: 'exec:run / server:upload',
    labelKey: 'app.examples.sdk-group-batch',
    badge: 'SDK 组合',
    items: [
      { name: 'qx.batch.exec()', perm: 'exec:run', desc: '在多台主机上并发执行命令并汇聚输出（高阶并发控制）', descEn: 'Concurrently execute command across multiple hosts via high-level SDK', usage: 'await qx.batch.exec({ hosts: ["h1"], cmd: "uptime" })', run: (ctx) => qx.batch.exec({ hosts: ctx?.hostId ? [ctx.hostId] : [], cmd: 'uname -a' }) },
      { name: 'qx.batch.upload()', perm: 'server:upload', desc: '批量向多台主机分发文件或内容（高阶并发控制）', descEn: 'Batch upload or distribute files across multiple hosts via high-level SDK', usage: 'await qx.batch.upload({ hosts: ["h1"], path: "/tmp/a.txt", content: "data" })', run: (ctx) => qx.batch.upload({ hosts: ctx?.hostId ? [ctx.hostId] : [], path: '/tmp/qxssh-batch-demo.txt', content: 'hello from batch.upload' }) },
    ],
  },
  {
    id: 'audit',
    permScope: 'logs:read & audit:note',
    labelKey: 'app.examples.sdk-group-audit',
    badge: 'logs:read',
    items: [
      { name: 'qx.audit.stats()', perm: 'logs:read', desc: '客户端实时聚合计算审计日志调用量、错误率与频次概览', descEn: 'Client-side real-time aggregation of audit logs and statistics', usage: 'await qx.audit.stats()', run: () => qx.audit.stats() },
      { name: 'qx.audit.export()', perm: 'logs:read', desc: '客户端格式化并导出/下载审计日志为 JSON 或 CSV', descEn: 'Client-side format and export/download audit logs to JSON or CSV', usage: 'await qx.audit.export({ format: "json" })', run: () => qx.audit.export({ format: 'json', limit: 20 }) },
      { name: 'qx.audit.logs()', perm: 'logs:read', desc: '分页查询系统审计日志记录流', descEn: 'Query paginated audit log stream', usage: 'await qx.audit.logs({ limit: 20 })', run: () => qx.audit.logs({ limit: 10 }) },
      { name: 'qx.audit.note()', perm: 'audit:note', desc: '向系统审计流追加自定义操作备注', descEn: 'Record custom note to audit log', usage: 'await qx.audit.note("action", "detail")', run: () => qx.audit.note('sdk_demo', 'triggered from sdk page') },
    ],
  },
  {
    id: 'sys',
    permScope: 'hosts:read / exec:run',
    labelKey: 'app.examples.sdk-group-sys',
    badge: 'qx.sys',
    items: [
      { name: 'qx.diskUsage()', perm: 'exec:run', desc: '查询指定挂载点或路径磁盘容量与使用率', descEn: 'Query disk usage and percentage for path/mount', usage: 'await qx.diskUsage(hostId, "/")', run: (ctx) => qx.diskUsage(ctx?.hostId || '', '/') },
      { name: 'qx.memoryUsage()', perm: 'exec:run', desc: '查询内存与交换空间用量及百分比', descEn: 'Query RAM and Swap usage and percentages', usage: 'await qx.memoryUsage(hostId)', run: (ctx) => qx.memoryUsage(ctx?.hostId || '') },
      { name: 'qx.cpuInfo()', perm: 'exec:run', desc: '查询 CPU 型号、核心数、主频与架构', descEn: 'Query CPU model, cores count, clock MHz, and architecture', usage: 'await qx.cpuInfo(hostId)', run: (ctx) => qx.cpuInfo(ctx?.hostId || '') },
      { name: 'qx.osRelease()', perm: 'exec:run', desc: '结构化解析远端 Linux 发行版版本信息', descEn: 'Parse /etc/os-release into structured object', usage: 'await qx.osRelease(hostId)', run: (ctx) => qx.osRelease(ctx?.hostId || '') },
      { name: 'qx.systemUptime()', perm: 'exec:run', desc: '查询系统正常运行时间与 1/5/15 分钟负载', descEn: 'Query system uptime and load averages', usage: 'await qx.systemUptime(hostId)', run: (ctx) => qx.systemUptime(ctx?.hostId || '') },
    ],
  },
  {
    id: 'proc',
    permScope: 'exec:run',
    labelKey: 'app.examples.sdk-group-proc',
    badge: 'qx.proc',
    items: [
      { name: 'qx.psList()', perm: 'exec:run', desc: '列出远端主机运行中的进程并支持用户/关键词过滤', descEn: 'List running processes with user/search filtering', usage: 'await qx.psList(hostId, { limit: 10 })', run: (ctx) => qx.psList(ctx?.hostId || '', { limit: 10 }) },
      { name: 'qx.killProcess()', perm: 'exec:run', desc: '终止指定 PID 或进程名的进程（支持自动提权）', descEn: 'Terminate process by PID or name with auto-elevation', usage: 'await qx.killProcess(hostId, pid, { signal: "TERM" })', run: () => ({ note: '支持按 PID 或进程名发送信号终止进程，如 qx.killProcess(hostId, 1234, { signal: "TERM" })' }) },
    ],
  },
  {
    id: 'fs',
    permScope: 'server:read / server:write',
    labelKey: 'app.examples.sdk-group-fs',
    badge: 'qx.fs',
    items: [
      { name: 'qx.remoteFileExists()', perm: 'server:read', desc: '检查远端文件或目录是否存在（安全不抛出）', descEn: 'Check if remote path exists without throwing', usage: 'await qx.remoteFileExists(hostId, "/etc/os-release")', run: (ctx) => qx.remoteFileExists(ctx?.hostId || '', '/etc/os-release') },
      { name: 'qx.remoteReadText()', perm: 'server:read', desc: '直接读取远端文本文件内容', descEn: 'Read remote text file content cleanly', usage: 'await qx.remoteReadText(hostId, "/etc/os-release")', run: (ctx) => qx.remoteReadText(ctx?.hostId || '', '/etc/os-release') },
      { name: 'qx.remoteWriteText()', perm: 'server:write', desc: '向远端路径写入文本内容（自动处理目录）', descEn: 'Write text content to remote destination path', usage: 'await qx.remoteWriteText(hostId, "/tmp/hello.txt", "content")', run: (ctx) => qx.remoteWriteText(ctx?.hostId || '', '/tmp/qx-test.txt', 'Hello QxSSH SDK') },
      { name: 'qx.remoteReadJSON()', perm: 'server:read', desc: '读取远端 JSON 配置文件并自动解析为对象', descEn: 'Read and JSON.parse remote config file', usage: 'await qx.remoteReadJSON(hostId, "/tmp/cfg.json")', run: (ctx) => qx.remoteReadJSON(ctx?.hostId || '', '/tmp/qxssh-demo-config.json') },
      { name: 'qx.remoteWriteJSON()', perm: 'server:write', desc: '序列化对象并写入远端 JSON 配置文件', descEn: 'Serialize and write object to remote JSON file', usage: 'await qx.remoteWriteJSON(hostId, "/tmp/cfg.json", data)', run: (ctx) => qx.remoteWriteJSON(ctx?.hostId || '', '/tmp/qxssh-demo-config.json', { app: 'Examples', ok: true, ts: Date.now() }) },
      { name: 'qx.remoteEnsureDir()', perm: 'server:write', desc: '递归确保远端目录存在（类似 mkdir -p）', descEn: 'Recursively ensure remote directory exists', usage: 'await qx.remoteEnsureDir(hostId, "/tmp/demo/sub")', run: (ctx) => qx.remoteEnsureDir(ctx?.hostId || '', '/tmp/qx-demo-dir') },
    ],
  },
  {
    id: 'service',
    permScope: 'exec:run',
    labelKey: 'app.examples.sdk-group-service',
    badge: 'qx.service',
    items: [
      { name: 'qx.serviceStatus()', perm: 'exec:run', desc: '查询远端 systemd 服务状态与日志输出', descEn: 'Query systemd service status and logs', usage: 'await qx.serviceStatus(hostId, "ssh")', run: (ctx) => qx.serviceStatus(ctx?.hostId || '', 'ssh') },
      { name: 'qx.serviceAction()', perm: 'exec:run', desc: '对服务执行 start/stop/restart/reload 等操作', descEn: 'Perform service action (start/stop/restart/reload) with auto-sudo', usage: 'await qx.serviceAction(hostId, "ssh", "status")', run: () => ({ note: '支持 start/stop/restart/reload/enable/disable 操作，如 qx.serviceAction(hostId, "nginx", "restart")' }) },
    ],
  },
  {
    id: 'env',
    permScope: 'exec:run',
    labelKey: 'app.examples.sdk-group-env',
    badge: 'qx.env',
    items: [
      { name: 'qx.remoteEnv()', perm: 'exec:run', desc: '查询远端环境变量键值字典', descEn: 'Query remote environment variables', usage: 'await qx.remoteEnv(hostId, ["USER", "PATH"])', run: (ctx) => qx.remoteEnv(ctx?.hostId || '', ['USER', 'HOME', 'SHELL', 'PATH']) },
      { name: 'qx.remoteUser()', perm: 'exec:run', desc: '查询远端登录用户身份（UID/GID/用户组/主目录/Shell）', descEn: 'Query remote user identity (UID/GID/groups/home/shell)', usage: 'await qx.remoteUser(hostId)', run: (ctx) => qx.remoteUser(ctx?.hostId || '') },
    ],
  },

  {
    id: 'journal',
    permScope: 'exec:run',
    labelKey: 'app.examples.sdk-group-journal',
    badge: 'qx.journal',
    items: [
      { name: 'qx.journalTail()', perm: 'exec:run', desc: '查看远端 systemd 日志（支持按服务、优先级和条数过滤）', descEn: 'Query systemd journal logs filtered by unit/priority', usage: 'await qx.journalTail(hostId, { lines: 20 })', run: (ctx) => qx.journalTail(ctx?.hostId || '', { lines: 20 }) },
      { name: 'qx.dmesgTail()', perm: 'exec:run', desc: '查看远端 Linux 内核环形缓冲区 dmesg 诊断日志', descEn: 'Tail Linux kernel ring buffer dmesg logs', usage: 'await qx.dmesgTail(hostId, { lines: 20 })', run: (ctx) => qx.dmesgTail(ctx?.hostId || '', { lines: 20 }) },
    ],
  },
  {
    id: 'pkg',
    permScope: 'exec:run',
    labelKey: 'app.examples.sdk-group-pkg',
    badge: 'qx.pkg',
    items: [
      { name: 'qx.pkgDetect()', perm: 'exec:run', desc: '自动检测远端主机包管理器类型（apt/yum/dnf/apk/pacman 等）', descEn: 'Detect host package manager type', usage: 'await qx.pkgDetect(hostId)', run: (ctx) => qx.pkgDetect(ctx?.hostId || '') },
      { name: 'qx.pkgInstalled()', perm: 'exec:run', desc: '检查指定软件包是否已在远端系统安装并返回版本', descEn: 'Check if a package is installed and get version', usage: 'await qx.pkgInstalled(hostId, "curl")', run: (ctx) => qx.pkgInstalled(ctx?.hostId || '', 'curl') },
    ],
  },
  {
    id: 'git',
    permScope: 'exec:run',
    labelKey: 'app.examples.sdk-group-git',
    badge: 'qx.git',
    items: [
      { name: 'qx.gitStatus()', perm: 'exec:run', desc: '查询远端 Git 仓库分支与工作树变动状态', descEn: 'Get git status and branch info for remote repo', usage: 'await qx.gitStatus(hostId, "/var/www/repo")', run: (ctx) => qx.gitStatus(ctx?.hostId || '', '.') },
      { name: 'qx.gitLog()', perm: 'exec:run', desc: '结构化读取远端 Git 仓库提交历史日志', descEn: 'Get structured commit history from remote git repo', usage: 'await qx.gitLog(hostId, "/var/www/repo", { limit: 5 })', run: (ctx) => qx.gitLog(ctx?.hostId || '', '.', { limit: 5 }) },
    ],
  },
  {
    id: 'archive',
    permScope: 'exec:run',
    labelKey: 'app.examples.sdk-group-archive',
    badge: 'qx.archive',
    items: [
      { name: 'qx.fileChecksum()', perm: 'exec:run', desc: '计算远端文件的散列值校验和（md5/sha1/sha256/sha512）', descEn: 'Compute remote file hash checksum', usage: 'await qx.fileChecksum(hostId, "/etc/hosts", { algorithm: "sha256" })', run: (ctx) => qx.fileChecksum(ctx?.hostId || '', '/etc/hosts', { algorithm: 'sha256' }) },
      { name: 'qx.archiveExtract()', perm: 'exec:run', desc: '解压远端 tar / tar.gz / zip / tgz 压缩归档文件', descEn: 'Extract remote archive (.tar.gz, .zip, etc.)', usage: 'await qx.archiveExtract(hostId, "/tmp/app.zip", { targetDir: "/tmp/app" })', run: () => ({ note: '支持解压 .tar.gz, .zip, .tgz 等，如 qx.archiveExtract(hostId, "/tmp/a.zip", { targetDir: "/tmp/a" })' }) },
      { name: 'qx.archiveCreate()', perm: 'exec:run', desc: '将远端指定目录或文件打包压缩为归档文件', descEn: 'Compress remote path into .tar.gz or .zip archive', usage: 'await qx.archiveCreate(hostId, "/tmp/logs", "/tmp/logs.tar.gz")', run: () => ({ note: '支持打包生成 .tar.gz, .zip 等，如 qx.archiveCreate(hostId, "/tmp/logs", "/tmp/logs.tar.gz")' }) },
    ],
  },
  {
    id: 'crontab',
    permScope: 'exec:run',
    labelKey: 'app.examples.sdk-group-crontab',
    badge: 'qx.crontab',
    items: [
      { name: 'qx.crontabList()', perm: 'exec:run', desc: '结构化读取并解析远端用户的定时任务 Crontab 规则列表', descEn: 'List and parse remote user crontab rules', usage: 'await qx.crontabList(hostId)', run: (ctx) => qx.crontabList(ctx?.hostId || '') },
    ],
  },
  {
    id: 'bridge',
    permScope: '免权限',
    labelKey: 'app.examples.sdk-group-bridge',
    badge: 'qx.getContext / qx.bootApp',
    items: [
      { name: 'qx.getContext()', perm: 'public', desc: '读取宿主当前广播的应用上下文对象', descEn: 'Read the app context object announced by host', usage: 'await qx.getContext()', run: () => qx.getContext() },
      { name: 'qx.onInit()', perm: 'public', desc: '注册初始化回调；宿主已就绪则立即执行，否则入队等待', descEn: 'Register an init callback; runs now if host is ready', usage: 'qx.onInit((ctx) => { ... })', run: () => { const off = qx.onInit(() => { }); return { registered: true, note: 'onInit 回调已注册' }; } },
      { name: 'qx.getHostInfo()', perm: 'public', desc: '获取宿主版本、平台与窗口能力信息', descEn: 'Get host version, platform and window capabilities', usage: 'await qx.getHostInfo()', run: () => qx.getHostInfo() },
      { name: 'qx.getWorkspaceInfo()', perm: 'public', desc: '获取当前工作区标识与名称', descEn: 'Get current workspace id and name', usage: 'await qx.getWorkspaceInfo()', run: () => qx.getWorkspaceInfo() },
      { name: 'qx.appBoot()', perm: 'public', desc: '等待宿主就绪并取出根元素、URL 参数与 hostId', descEn: 'Await readiness and resolve root element, params and hostId', usage: 'const boot = await qx.appBoot({ root: "#app" })', run: async () => { const b = await qx.appBoot({ root: '#app' }); return { hostId: b.hostId, params: b.params, hasRoot: !!b.root }; } },
      { name: 'qx.bootApp()', perm: 'public', desc: '等待就绪后运行应用入口，返回带 dispose 的句柄（会重启渲染，示例只展示签名）', descEn: 'Run app entry after readiness and return a dispose handle', usage: 'await qx.bootApp(({ root, ctx }) => { ... })', run: () => ({ signature: 'bootApp(boot, { root = "#app" })', note: '示例应用已在 bootApp 内运行，此处仅展示签名' }) },
      { name: 'qx.bootAppNoInit()', perm: 'public', desc: '不等待宿主就绪直接运行入口，用于独立页面', descEn: 'Run app entry without waiting for host readiness', usage: 'qx.bootAppNoInit(({ root }) => { ... })', run: () => ({ signature: 'bootAppNoInit(boot, { root = "#app" })', note: '独立页面场景使用，示例应用不重复运行' }) },
      { name: 'qx.reloadApp()', perm: 'public', desc: '请求宿主重新加载指定应用（传自身 id 会重载本窗口）', descEn: 'Ask host to reload an app by id', usage: 'qx.reloadApp("examples")', run: () => ({ signature: 'reloadApp(appId)', note: '传自身 id 会重载当前窗口，示例不触发' }) },
      { name: 'qx.closeSelf()', perm: 'public', desc: '请求宿主关闭当前应用窗口', descEn: 'Ask host to close the current window', usage: 'qx.closeSelf()', run: () => ({ signature: 'closeSelf()', note: '会关闭当前窗口，示例不触发' }) },
    ],
  },
  {
    id: 'window',
    permScope: '免权限 / 窗口控制',
    labelKey: 'app.examples.sdk-group-window',
    badge: 'qx.setTitle / qx.windowControl',
    items: [
      { name: 'qx.setTitle()', perm: 'public', desc: '设置当前窗口标题', descEn: 'Set the current window title', usage: 'qx.setTitle("QxSSH Examples")', run: () => { qx.setTitle('QxSSH Examples'); return 'setTitle -> ok'; } },
      { name: 'qx.setTitleAccent()', perm: 'public', desc: '设置标题栏强调色（CSS 颜色值）', descEn: 'Set title bar accent color', usage: 'qx.setTitleAccent("#6ea8fe")', run: () => { qx.setTitleAccent('#6ea8fe'); return 'setTitleAccent -> #6ea8fe'; } },
      { name: 'qx.setWindowBadge()', perm: 'public', desc: '在窗口标题上挂角标文本（空串清除）', descEn: 'Attach a badge text to the window title', usage: 'qx.setWindowBadge("demo")', run: () => { qx.setWindowBadge('demo'); return 'setWindowBadge -> demo'; } },
      { name: 'qx.windowClass()', perm: 'public', desc: '为窗口根节点增删 CSS 类', descEn: 'Add or remove CSS classes on the window root', usage: 'qx.windowClass(["gal-demo-class"], [])', run: () => { qx.windowClass([WINDOW_CLASS], []); return `windowClass -> ${WINDOW_CLASS}`; } },
      { name: 'qx.windowControl()', perm: 'public', desc: '控制窗口状态：minimize / maximize / restore / toggle-max / close', descEn: 'Control window state: minimize/maximize/restore/toggle-max/close', usage: 'qx.windowControl("minimize")', run: () => { qx.windowControl('restore'); return { action: 'restore', note: '可用动作：minimize / maximize / restore / toggle-max / close' }; } },
      { name: 'qx.setWindowRect()', perm: 'public', desc: '设置窗口屏幕坐标与尺寸', descEn: 'Set window screen rect (x, y, width, height)', usage: 'qx.setWindowRect({ x: 120, y: 80, width: 1120, height: 760 })', run: () => ({ signature: 'setWindowRect({ x, y, width, height })', current: undefined }) },
      { name: 'qx.focusWindow()', perm: 'public', desc: '请求宿主激活并置顶当前窗口', descEn: 'Ask host to focus and raise the current window', usage: 'qx.focusWindow()', run: () => { qx.focusWindow(); return 'focusWindow -> ok'; } },
      { name: 'qx.openExternal()', perm: 'public', desc: '用系统默认浏览器打开外部链接（不在应用 iframe 内导航）', descEn: 'Open an external URL in the system browser', usage: 'qx.openExternal("https://example.com")', run: () => ({ signature: 'openExternal(url)', note: '会拉起系统浏览器，示例不触发' }) },
      { name: 'qx.reportAppError()', perm: 'public', desc: '把应用内异常上报给宿主，进入宿主的错误面板', descEn: 'Report an app error to the host error panel', usage: 'qx.reportAppError(new Error("boom"))', run: () => { qx.reportAppError(new Error('examples: 这是一条由 reportAppError 上报的示例错误')); return 'reportAppError -> sent'; } },
      { name: 'qx.applyStoredTheme()', perm: 'public', desc: '重新应用本地持久化的主题偏好', descEn: 'Re-apply the persisted theme preference', usage: 'qx.applyStoredTheme()', run: () => { qx.applyStoredTheme(); return 'applyStoredTheme -> ok'; } },
      { name: 'qx.applyStoredGlass()', perm: 'public', desc: '重新应用本地持久化的毛玻璃参数', descEn: 'Re-apply the persisted glass blur setting', usage: 'qx.applyStoredGlass()', run: () => { qx.applyStoredGlass(); return 'applyStoredGlass -> ok'; } },
    ],
  },
  {
    id: 'appapi',
    permScope: 'apps:list / 应用间调用',
    labelKey: 'app.examples.sdk-group-appapi',
    badge: 'qx.provideApi / qx.callAppApi',
    items: [
      { name: 'qx.provideApi()', perm: 'public', desc: '对外提供本应用的 API，可带描述、版本与权限要求', descEn: 'Expose an API for other apps to call', usage: 'qx.provideApi("examples.ping", (args) => ({ ok: true, args }), { description: "ping" })', run: () => { qx.provideApi('examples.ping', (args) => ({ ok: true, echo: args }), { description: '示例 ping', version: '1.0.0' }); return { provided: 'examples.ping', hint: '现在可被其他应用 callAppApi("examples", "examples.ping", ...) 调用' }; } },
      { name: 'qx.revokeApi()', perm: 'public', desc: '撤销已提供的 API 并中止进行中的调用', descEn: 'Revoke a previously provided API', usage: 'qx.revokeApi("examples.ping")', run: () => { qx.revokeApi('examples.ping'); return 'revokeApi("examples.ping") -> ok'; } },
      { name: 'qx.callAppApi()', perm: 'apps:list', desc: '调用其他应用提供的 API，支持超时、取消与进度回调', descEn: 'Call an API provided by another app', usage: 'await qx.callAppApi("hosts", "hosts.list", {}, { timeout: 5000 })', run: async () => { try { return await qx.callAppApi('examples', 'examples.ping', { at: Date.now() }, { timeout: 3000 }); } catch (e) { return { ok: false, code: e.code, error: e.message, hint: '先点上一行 provideApi 注册，或目标应用未打开' }; } } },
      { name: 'qx.callAppApis()', perm: 'apps:list', desc: '批量调用多个应用 API，统一返回结果数组', descEn: 'Call multiple app APIs in one batch', usage: 'await qx.callAppApis([{ appId: "hosts", api: "hosts.list" }])', run: async () => { try { return await qx.callAppApis([{ appId: 'examples', api: 'examples.ping', args: { n: 1 } }], { timeout: 3000 }); } catch (e) { return { ok: false, code: e.code, error: e.message }; } } },
      { name: 'qx.listAppApis()', perm: 'apps:list', desc: '列出指定应用已提供的全部 API 及其元信息', descEn: 'List all APIs provided by an app with metadata', usage: 'await qx.listAppApis("examples")', run: () => qx.listAppApis('examples') },
      { name: 'qx.onAppApiChange()', perm: 'public', desc: '订阅应用 API 注册表变化，返回取消订阅函数', descEn: 'Subscribe to app API registry changes', usage: 'const off = qx.onAppApiChange((info) => { ... }, "examples")', run: () => { const off = qx.onAppApiChange(() => { }, 'examples'); if (typeof off === 'function') off(); return 'onAppApiChange -> subscribed & unsubscribed'; } },
      { name: 'qx.APP_API_ERR', perm: 'public', desc: '应用间调用错误码枚举：bad_args / not_open / not_provided / needs_window / target_closed / timeout / cancelled / permission / handler', descEn: 'Error code enum for app-to-app calls', usage: 'catch (e) { if (e.code === qx.APP_API_ERR.TIMEOUT) { ... } }', run: () => qx.APP_API_ERR },
      { name: 'qx.publishEvent()', perm: 'public', desc: '向宿主与其他应用广播事件，并在本应用内分发', descEn: 'Broadcast an event to host and other apps', usage: 'qx.publishEvent("examples.demo", { hello: 1 })', run: () => { qx.publishEvent('examples.demo', { hello: 1, at: Date.now() }); return 'publishEvent("examples.demo") -> ok'; } },
      { name: 'qx.onEvent()', perm: 'public', desc: '订阅事件主题（支持 * 通配），返回取消订阅函数', descEn: 'Subscribe to event topics with wildcard support', usage: 'const off = qx.onEvent("examples.*", (payload, meta) => { ... })', run: () => { const seen = []; const off = qx.onEvent('examples.*', (p) => seen.push(p)); qx.publishEvent('examples.demo2', { n: 2 }); off(); return { received: seen.length, sample: seen[0] || null }; } },
      { name: 'qx.onWindowState()', perm: 'public', desc: '订阅窗口状态变化（最小化/最大化/焦点），返回取消订阅函数', descEn: 'Subscribe to window state changes', usage: 'const off = qx.onWindowState((st) => { ... })', run: () => { let st = null; const off = qx.onWindowState((s) => { st = s; }); off(); return { current: st }; } },
    ],
  },
  {
    id: 'session',
    permScope: '免权限 / 会话与权限变更',
    labelKey: 'app.examples.sdk-group-session',
    badge: 'qx.onPermChange / qx.hostDialog',
    items: [
      { name: 'qx.hostDialog()', perm: 'public', desc: '通用宿主对话框：kind 取 alert / confirm / prompt', descEn: 'Generic host dialog: alert / confirm / prompt', usage: 'await qx.hostDialog({ kind: "alert", title: "T", desc: "D" })', run: () => qx.hostDialog({ kind: 'alert', title: 'hostDialog', desc: t('app.examples.hostdialog-note') }) },
      { name: 'qx.writeClipboard()', perm: 'public', desc: '将文本写入系统剪贴板（原生通道，非 navigator）', descEn: 'Write text to the OS clipboard through the host', usage: 'await qx.writeClipboard("text")', run: async () => ({ copied: await qx.writeClipboard('written by qx.writeClipboard()') }) },
      { name: 'qx.onSessionChange()', perm: 'public', desc: '订阅登录会话变化，返回取消订阅函数', descEn: 'Subscribe to session changes', usage: 'const off = qx.onSessionChange((s) => { ... })', run: () => { const off = qx.onSessionChange(() => { }); if (typeof off === 'function') off(); return 'onSessionChange -> subscribed'; } },
      { name: 'qx.onPermChange()', perm: 'public', desc: '订阅本应用权限集变化（提权/回收后触发）', descEn: 'Subscribe to app permission set changes', usage: 'const off = qx.onPermChange((perms) => { ... })', run: () => { const off = qx.onPermChange(() => { }); if (typeof off === 'function') off(); return 'onPermChange -> subscribed'; } },
      { name: 'qx.notifyPermChanged()', perm: 'public', desc: '通知宿主某应用的权限集已变化，触发其刷新', descEn: 'Tell host an app permission set changed', usage: 'qx.notifyPermChanged("examples")', run: () => { qx.notifyPermChanged('examples'); return 'notifyPermChanged("examples") -> ok'; } },
      { name: 'qx.notifyAppsChanged()', perm: 'public', desc: '通知宿主应用注册表已变化（安装/卸载后）', descEn: 'Tell host the app registry changed', usage: 'qx.notifyAppsChanged()', run: () => { qx.notifyAppsChanged(); return 'notifyAppsChanged() -> ok'; } },
      { name: 'qx.notifySessionRevoked()', perm: 'public', desc: '通知宿主会话已失效，触发重新登录流程', descEn: 'Tell host the session was revoked', usage: 'qx.notifySessionRevoked("examples")', run: () => ({ signature: 'notifySessionRevoked(appId)', note: '会触发宿主会话失效处理，示例不触发' }) },
    ],
  },
  {
    id: 'i18n',
    permScope: '免权限 / 国际化',
    labelKey: 'app.examples.sdk-group-i18n',
    badge: 'qx.setupAppI18n / qx.t',
    items: [
      { name: 'qx.t()', perm: 'public', desc: '按 key 取当前语言的文案，缺 key 时回落为 key 本身', descEn: 'Translate a key in current language', usage: 'qx.t("app.examples.tab-sdk")', run: () => ({ key: 'app.examples.tab-sdk', value: qx.t('app.examples.tab-sdk') }) },
      { name: 'qx.tf()', perm: 'public', desc: '带占位符的翻译：文案里写 {v1} {v2}，这里传参替换', descEn: 'Translate with {v1} placeholder interpolation', usage: 'qx.tf("app.examples.selfcheck-total", { v1: 12 })', run: () => qx.tf('app.examples.selfcheck-total', { v1: 12 }) },
      { name: 'qx.lang()', perm: 'public', desc: '读取当前语言代码', descEn: 'Read the current language code', usage: 'qx.lang()', run: () => qx.lang() },
      { name: 'qx.setLang()', perm: 'public', desc: '切换语言并持久化（examples 作用域下由 setupAppI18n 管理语言表）', descEn: 'Switch language and persist the choice', usage: 'await qx.setLang("en-US", { persist: true })', run: () => ({ signature: 'setLang(code, { persist = true })', current: qx.lang(), note: '示例应用的语言表由 setupAppI18n 加载，切换请在右上角语言菜单操作' }) },
      { name: 'qx.negotiateLang()', perm: 'public', desc: '与宿主协商最优语言（本地偏好 > 宿主设置 > navigator）', descEn: 'Negotiate the best language with host and browser', usage: 'await qx.negotiateLang()', run: () => qx.negotiateLang() },
      { name: 'qx.listLangs()', perm: 'public', desc: '列出可用语言及显示名', descEn: 'List available languages with display names', usage: 'await qx.listLangs()', run: () => qx.listLangs() },
      { name: 'qx.onLangChange()', perm: 'public', desc: '订阅语言变化，返回取消订阅函数', descEn: 'Subscribe to language changes', usage: 'const off = qx.onLangChange((code) => { ... })', run: () => { const off = qx.onLangChange(() => { }); if (typeof off === 'function') off(); return 'onLangChange -> subscribed'; } },
      { name: 'qx.LANGUAGES', perm: 'public', desc: '内置语言清单常量（宿主语言表与别名）', descEn: 'Built-in language list constant', usage: 'qx.LANGUAGES', run: () => qx.LANGUAGES },
      { name: 'qx.DEFAULT_LANG', perm: 'public', desc: '默认语言代码常量', descEn: 'Default language code constant', usage: 'qx.DEFAULT_LANG', run: () => qx.DEFAULT_LANG },
      { name: 'qx.setupI18n()', perm: 'public', desc: '底层 i18n 初始化：指定语言目录与作用域后加载语言表', descEn: 'Low-level i18n setup with base dir and scope', usage: 'await qx.setupI18n("/assets/language", { scope: "core" })', run: () => ({ signature: 'setupI18n(dir, { scope })', note: '应用一般改用 setupAppI18n，二者不叠加' }) },
      { name: 'qx.setupAppI18n()', perm: 'public', desc: '应用级 i18n 初始化：自动协商语言、按 scope 持久化、注册语言切换控件', descEn: 'App-level i18n setup with negotiation and persistence', usage: 'await qx.setupAppI18n({ base: new URL("./language", import.meta.url).href, languages: ["zh-CN", "en-US"], scope: "examples" })', run: () => ({ signature: 'setupAppI18n({ base, languages, scope })', current: qx.lang(), note: '示例应用已在启动时调用' }) },
      { name: 'qx.withI18n()', perm: 'public', desc: '包裹渲染函数，语言变化时自动重渲染', descEn: 'Wrap a render function so it rerenders on language change', usage: 'qx.withI18n(() => h("div", { text: qx.t("app.examples.tab-sdk") }))', run: () => { const wrapped = qx.withI18n(() => null); return { wrapped: typeof wrapped }; } },
      { name: 'qx.openPopper()', perm: 'public', desc: '在锚点元素旁弹出浮层（语言菜单、下拉面板的底层实现）', descEn: 'Open a popper panel anchored to an element', usage: 'qx.openPopper(anchorEl, (close) => vnode)', run: () => ({ signature: 'openPopper(anchor, render)', note: '需要真实锚点元素，示例页由 i18nMenu 内部调用' }) },
      { name: 'qx.i18nSelect()', perm: 'public', desc: '语言切换下拉框组件工厂', descEn: 'Language switcher select component', usage: 'qx.i18nSelect({ onChange })', run: () => ({ component: 'i18nSelect', returns: typeof qx.i18nSelect({}) }) },
      { name: 'qx.i18nButton()', perm: 'public', desc: '语言切换按钮组件工厂', descEn: 'Language switcher button component', usage: 'qx.i18nButton({ onChange })', run: () => ({ component: 'i18nButton', returns: typeof qx.i18nButton({}) }) },
      { name: 'qx.i18nMenu()', perm: 'public', desc: '语言切换菜单组件工厂', descEn: 'Language switcher menu component', usage: 'qx.i18nMenu({ onChange })', run: () => ({ component: 'i18nMenu', returns: typeof qx.i18nMenu({}) }) },
    ],
  },
  {
    id: 'code',
    permScope: '免权限 / 代码高亮',
    labelKey: 'app.examples.sdk-group-code',
    badge: 'qx.CodeEditor / qx.tokenize',
    items: [
      { name: 'qx.highlightCode()', perm: 'public', desc: '把源码转成带 qx-tok-* 类的 HTML 片段', descEn: 'Convert source code into highlighted HTML', usage: 'qx.highlightCode("ssh root@10.0.0.1", "sh")', run: () => ({ html: qx.highlightCode('ssh root@10.0.0.1 -p 22', 'sh') }) },
      { name: 'qx.highlightHTML()', perm: 'public', desc: '与 highlightCode 相同，但保留换行与行号友好结构', descEn: 'Highlighted HTML with line-preserving markup', usage: 'qx.highlightHTML(code, "json")', run: () => ({ html: qx.highlightHTML('{"a":1}', 'json') }) },
      { name: 'qx.tokenize()', perm: 'public', desc: '把源码切分为 { type, text } 记号列表（着色器底层依赖）', descEn: 'Split source into typed tokens', usage: 'qx.tokenize("ERROR 10.0.0.9", "log")', run: () => qx.tokenize('ERROR 10.0.0.9 refused', 'log') },
      { name: 'qx.languages()', perm: 'public', desc: '列出内置语言键与其别名', descEn: 'List built-in languages and aliases', usage: 'qx.languages()', run: () => qx.languages() },
      { name: 'qx.languageForFile()', perm: 'public', desc: '按文件名或路径推断应使用的语言键', descEn: 'Infer language from file name or path', usage: 'qx.languageForFile("nginx.conf")', run: () => ({ 'main.go': qx.languageForFile('main.go'), 'nginx.conf': qx.languageForFile('nginx.conf'), 'a.json': qx.languageForFile('a.json') }) },
      { name: 'qx.isTextFile()', perm: 'public', desc: '判断文件是否适合按文本预览', descEn: 'Check whether a file is text-previewable', usage: 'qx.isTextFile("a.log")', run: () => ({ 'a.log': qx.isTextFile('a.log'), 'a.png': qx.isTextFile('a.png') }) },
      { name: 'qx.canonicalLanguage()', perm: 'public', desc: '把语言名或别名归一化为内置语言键', descEn: 'Normalize a language name or alias', usage: 'qx.canonicalLanguage("javascript")', run: () => ({ javascript: qx.canonicalLanguage('javascript'), yml: qx.canonicalLanguage('yml') }) },
      { name: 'qx.registerLanguage()', perm: 'public', desc: '注册自定义语言语法与别名，供高亮与着色器使用', descEn: 'Register a custom language grammar and aliases', usage: 'qx.registerLanguage("mylang", [["keyword", "\\\\bfoo\\\\b"]], ["ml"])', run: () => { qx.registerLanguage('examples-demo', [['keyword', '\\bDEMO\\b']], ['exdemo']); return { registered: 'examples-demo', alias: 'exdemo', tokens: qx.tokenize('DEMO plain', 'exdemo') }; } },
      { name: 'qx.TOKEN_TYPES', perm: 'public', desc: '记号类型常量表（keyword / string / number / error / warning / info / muted / constant / text）', descEn: 'Token type constant list', usage: 'qx.TOKEN_TYPES', run: () => qx.TOKEN_TYPES },
      { name: 'qx.CodeEditor()', perm: 'public', desc: '代码编辑器组件工厂：语法高亮 + 行号 + 可编辑', descEn: 'Code editor component with highlight and gutter', usage: 'h(qx.CodeEditor, { value, lang: "sh", rows: 6 })', run: () => ({ component: 'CodeEditor', returns: typeof qx.CodeEditor }) },
      { name: 'qx.codeField()', perm: 'public', desc: '单行代码输入字段工厂（带语言高亮）', descEn: 'Single-line code input field', usage: 'qx.codeField("命令", { lang: "sh" })', run: () => ({ returns: typeof qx.codeField('命令', { lang: 'sh' }) }) },
    ],
  },
  {
    id: 'shader',
    permScope: '免权限 / JSON 着色器',
    labelKey: 'app.examples.sdk-group-shader',
    badge: 'qx.timingShader / qx.defineJsonShader',
    items: [
      { name: 'qx.timingShader()', perm: 'public', desc: '时刻着色器：把 @激活时刻 与 +耗时 分别染色，只有标记后紧跟数字才命中，getty@tty1.service 不会被误染', descEn: 'Timing shader: colour @activation and +duration segments', usage: 'h(JsonViewer, { value, keySplit: /\\s+/, shader: qx.timingShader() })', run: () => ({ tokens: qx.timingShader()('docker.service @4.512s +588ms', { slot: 'suffix', key: 'docker.service', depth: 1, path: '$root/0' }) }) },
      { name: 'qx.languageShader()', perm: 'public', desc: '按语言语法给值上色，复用 code-editor 语法表；keys:true 时键名也走同一套语法', descEn: 'Colour values with a language grammar; keys:true also colours keys', usage: "qx.languageShader('log')", run: () => ({ tokens: qx.languageShader('log')('ERROR 10.0.0.9 refused', { slot: 'value', key: 'msg', depth: 1, path: '$root/0' }) }) },
      { name: 'qx.composeShaders()', perm: 'public', desc: '组合多个着色器：按顺序问，第一个返回非空结果的胜出', descEn: 'Compose shaders; the first non-empty result wins', usage: 'qx.composeShaders(qx.fieldShader({ msg: qx.timingShader() }), qx.languageShader("log"))', run: () => ({ tokens: qx.composeShaders(qx.timingShader(), qx.languageShader('log'))('ERROR @1.2s', { slot: 'key', key: 'k', depth: 1, path: '$root/0' }) }) },
      { name: 'qx.fieldShader()', perm: 'public', desc: '按字段规则着色：键支持精确键名、* 通配、以 / 结尾的路径前缀；命中但返回空则继续下一条', descEn: 'Per-field shader rules keyed by name, * or path prefix', usage: 'qx.fieldShader({ ERROR: qx.languageShader("log"), "/root/time/": qx.timingShader() })', run: () => { const s = qx.fieldShader({ msg: qx.languageShader('log'), '*': qx.timingShader() }); return { byKey: s('ERROR refused', { slot: 'value', key: 'msg', depth: 2, path: '$root/0' }), byWildcard: s('@3.1s +20ms', { slot: 'key', key: 'x', depth: 2, path: '$root/1' }) }; } },
      { name: 'qx.defineJsonShader()', perm: 'public', desc: '注册具名着色器，之后 JsonViewer 可用字符串引用（示例页的 examples-threshold 即由此注册）', descEn: 'Register a named shader usable by string reference', usage: 'qx.defineJsonShader("myname", (text, ctx) => Token[] | null)', run: () => { qx.defineJsonShader('examples-demo', (text, ctx) => (ctx.slot === 'value' ? [{ text: String(text), class: 'gal-json-cool' }] : null)); return { registered: 'examples-demo', names: qx.listJsonShaders() }; } },
      { name: 'qx.getJsonShader()', perm: 'public', desc: '按名取回已注册的着色器函数，未注册返回 null', descEn: 'Look up a registered shader by name', usage: 'qx.getJsonShader("timing")', run: () => ({ timing: typeof qx.getJsonShader('timing'), missing: qx.getJsonShader('no-such') }) },
      { name: 'qx.listJsonShaders()', perm: 'public', desc: '列出全部已注册着色器名（内置 timing / log / json / sh）', descEn: 'List all registered shader names', usage: 'qx.listJsonShaders()', run: () => qx.listJsonShaders() },
    ],
  },
  {
    id: 'view',
    permScope: '免权限 / 大数据视图',
    labelKey: 'app.examples.sdk-group-view',
    badge: 'qx.VirtualList / qx.LineChart',
    items: [
      { name: 'qx.VirtualList()', perm: 'public', desc: '虚拟滚动长列表组件：只渲染可视区行，万级数据不卡', descEn: 'Virtual scrolling list rendering only visible rows', usage: 'h(qx.VirtualList, { items, rowHeight: 32, row: (it) => vnode })', run: () => ({ component: 'VirtualList', returns: typeof qx.VirtualList }) },
      { name: 'qx.scrollToRow()', perm: 'public', desc: '把虚拟列表滚动到指定行（支持 start / center / end 对齐）', descEn: 'Scroll a virtual list to a row index', usage: 'qx.scrollToRow(listEl, 120, 32, "center")', run: () => ({ signature: 'scrollToRow(el, index, rowHeight, align = "nearest")', note: '需要 VirtualList 的 DOM 引用，示例页 virtuallist 卡片内有按钮直接调用' }) },
      { name: 'qx.LineChart()', perm: 'public', desc: 'Canvas 折线图组件：支持多序列、时序模式与自定义配色', descEn: 'Canvas line chart with series and time mode', usage: 'h(qx.LineChart, { series: [{ name, data }], height: 160, time: true })', run: () => ({ component: 'LineChart', returns: typeof qx.LineChart }) },
      { name: 'qx.timeSeries()', perm: 'public', desc: '时序数据环形缓冲：push 采样值、按容量自动淘汰最旧点', descEn: 'Ring buffer for time-series samples', usage: 'const ts = qx.timeSeries(60); ts.push(1.2)', run: () => { const ts = qx.timeSeries(60, 2); ts.push(1.2, 3.4); return { keys: Object.keys(ts), snapshot: ts.data || ts.values || null }; } },
      { name: 'qx.loadChartLib()', perm: 'public', desc: '按需加载图表底层库（首次调用时才拉取）', descEn: 'Lazily load the chart backend library', usage: 'await qx.loadChartLib()', run: async () => { const lib = await qx.loadChartLib(); return { loaded: !!lib }; } },
    ],
  },
  {
    id: 'namespaces',
    permScope: '免权限 / 命名空间别名',
    labelKey: 'app.examples.sdk-group-namespaces',
    badge: 'qx.sys / qx.proc / qx.batchExec',
    items: [
      { name: 'qx.kit', perm: 'public', desc: '底层运维工具箱全量命名空间：sh / run / runJSON / runLines / runTable / parseTable / stream / which / fetchVia / tcpConnect / ensureSudo / runMany / startJob / jobHandle / followJob / jobs / collectMetrics / collectHostInfo 及全部系统读取方法', descEn: 'Raw ops toolbox namespace with every underlying helper', usage: 'qx.kit.diskUsage(host, "/")', run: () => ({ count: Object.keys(qx.kit).length, keys: Object.keys(qx.kit) }) },
      { name: 'qx.sys', perm: 'public', desc: '系统诊断命名空间：diskUsage / memoryUsage / cpuInfo / osRelease / uptime / metrics / hostInfo', descEn: 'System diagnostics namespace object', usage: 'qx.sys.diskUsage(host, "/")', run: () => ({ keys: Object.keys(qx.sys) }) },
      { name: 'qx.proc', perm: 'public', desc: '进程命名空间：list / kill', descEn: 'Process namespace: list / kill', usage: 'qx.proc.list(host, { limit: 10 })', run: () => ({ keys: Object.keys(qx.proc) }) },
      { name: 'qx.net', perm: 'public', desc: '网络命名空间：ports / ping / interfaces / routes / testPort / resolve / fetchVia / tcpConnect', descEn: 'Network namespace object', usage: 'qx.net.interfaces(host)', run: () => ({ keys: Object.keys(qx.net) }) },
      { name: 'qx.fs', perm: 'public', desc: '远端文件命名空间：exists / readText / writeText / readJSON / writeJSON / ensureDir / checksum / extract / compress', descEn: 'Remote file namespace object', usage: 'qx.fs.readText(host, "/etc/hosts")', run: () => ({ keys: Object.keys(qx.fs) }) },
      { name: 'qx.service', perm: 'public', desc: '服务命名空间：status / action / start / stop / restart', descEn: 'Service namespace object', usage: 'qx.service.status(host, "sshd")', run: () => ({ keys: Object.keys(qx.service) }) },
      { name: 'qx.env', perm: 'public', desc: '环境命名空间：get / user', descEn: 'Environment namespace: get / user', usage: 'qx.env.user(host)', run: () => ({ keys: Object.keys(qx.env) }) },
      { name: 'qx.journal', perm: 'public', desc: '日志命名空间：tail / dmesg', descEn: 'Journal namespace: tail / dmesg', usage: 'qx.journal.tail(host, { lines: 20 })', run: () => ({ keys: Object.keys(qx.journal) }) },
      { name: 'qx.pkg', perm: 'public', desc: '包管理命名空间：detect / installed', descEn: 'Package namespace: detect / installed', usage: 'qx.pkg.detect(host)', run: () => ({ keys: Object.keys(qx.pkg) }) },
      { name: 'qx.git', perm: 'public', desc: 'Git 命名空间：status / log', descEn: 'Git namespace: status / log', usage: 'qx.git.status(host, "/var/www/repo")', run: () => ({ keys: Object.keys(qx.git) }) },
      { name: 'qx.crontab', perm: 'public', desc: '定时任务命名空间：list', descEn: 'Crontab namespace: list', usage: 'qx.crontab.list(host)', run: () => ({ keys: Object.keys(qx.crontab) }) },
      { name: 'qx.batch', perm: 'exec:run', desc: '批量操作命名空间：exec / upload（等价的扁平别名见下）', descEn: 'Batch namespace: exec / upload', usage: 'qx.batch.exec(hostIds, "uptime")', run: () => ({ keys: Object.keys(qx.batch) }) },
      { name: 'qx.audit', perm: 'logs:read', desc: '审计命名空间：stats / export / logs / note', descEn: 'Audit namespace: stats / export / logs / note', usage: 'qx.audit.stats({ days: 7 })', run: () => ({ keys: Object.keys(qx.audit) }) },
      { name: 'qx.batchExec()', perm: 'exec:run', desc: '顶层扁平别名：多主机并发执行同一条命令', descEn: 'Flat alias: run one command across many hosts', usage: 'await qx.batchExec(hostIds, "uptime")', run: () => ({ sameAs: 'qx.batch.exec', signature: 'batchExec(hostIds, cmd, opts)' }) },
      { name: 'qx.batchUpload()', perm: 'sftp:write', desc: '顶层扁平别名：多主机并发上传同一文件', descEn: 'Flat alias: upload one file to many hosts', usage: 'await qx.batchUpload(hostIds, local, remote)', run: () => ({ sameAs: 'qx.batch.upload', signature: 'batchUpload(hostIds, localPath, remotePath, opts)' }) },
      { name: 'qx.auditStats()', perm: 'logs:read', desc: '顶层扁平别名：审计日志统计聚合', descEn: 'Flat alias: audit log statistics', usage: 'await qx.auditStats({ days: 7 })', run: () => ({ sameAs: 'qx.audit.stats', signature: 'auditStats(query)' }) },
      { name: 'qx.exportAuditLogs()', perm: 'logs:read', desc: '顶层扁平别名：导出审计日志为 CSV / JSON', descEn: 'Flat alias: export audit logs', usage: 'await qx.exportAuditLogs({ format: "csv" })', run: () => ({ sameAs: 'qx.audit.export', signature: 'exportAuditLogs(query)' }) },
      { name: 'qx.auditLogs()', perm: 'logs:read', desc: '顶层扁平别名：分页查询审计日志', descEn: 'Flat alias: page through audit logs', usage: 'await qx.auditLogs({ page: 1, size: 20 })', run: () => ({ sameAs: 'qx.audit.logs', signature: 'auditLogs(query)' }) },
      { name: 'qx.auditNote()', perm: 'logs:read', desc: '顶层扁平别名：为某条审计记录追加备注', descEn: 'Flat alias: append a note to an audit record', usage: 'await qx.auditNote(id, "note")', run: () => ({ sameAs: 'qx.audit.note', signature: 'auditNote(id, text)' }) },
    ],
  },
  {
    id: 'public',
    permScope: '免权限',
    labelKey: 'app.examples.sdk-group-public',
    badge: '免权限',
    items: [
      { name: 'qx.ready()', perm: 'public', desc: '等待宿主完成双向握手就绪', descEn: 'Wait for host bridge handshake ready', usage: 'await qx.ready()', run: () => qx.ready() },
      { name: 'qx.workspace()', perm: 'public', desc: '查询当前工作区信息及主机清单', descEn: 'Query current workspace and host inventory', usage: 'await qx.workspace()', run: () => qx.workspace() },
      { name: 'qx.alert()', perm: 'public', desc: '弹出模态系统提示对话框', descEn: 'Show modal alert dialog', usage: 'await qx.alert("Title", "Message")', run: () => qx.alert('QxSSH Alert', 'Hello from qx.alert!') },
      { name: 'qx.confirm()', perm: 'public', desc: '弹出模态确认对话框并等待选择', descEn: 'Show modal confirm dialog', usage: 'const ok = await qx.confirm("Title", "Proceed?")', run: () => qx.confirm('QxSSH Confirm', 'Proceed with action?') },
      { name: 'qx.prompt()', perm: 'public', desc: '弹出模态单行文本输入对话框', descEn: 'Show modal text prompt dialog', usage: 'const val = await qx.prompt("Title", "Input:")', run: () => qx.prompt('QxSSH Prompt', 'Input something:', { defaultValue: 'demo' }) },
      { name: 'qx.copy()', perm: 'public', desc: '将纯文本安全写入系统剪贴板', descEn: 'Write plain text to clipboard', usage: 'await qx.copy("Text")', run: async () => ({ copied: await qx.copy('Text copied via qx.copy()') }) },
      { name: 'qx.hostToast()', perm: 'public', desc: '触发宿主轻量 Toast 浮层提示', descEn: 'Show lightweight host toast notification', usage: 'qx.hostToast("Hello")', run: () => { qx.hostToast('Hello from qx.hostToast!'); return 'hostToast shown'; } },
      { name: 'qx.listWindows()', perm: 'public', desc: '查询当前打开的应用窗口列表', descEn: 'List active app windows', usage: 'await qx.listWindows()', run: () => qx.listWindows() },
      { name: 'qx.getWindowRect()', perm: 'public', desc: '获取当前窗口屏幕坐标与尺寸', descEn: 'Get current window screen rect', usage: 'await qx.getWindowRect()', run: () => qx.getWindowRect() },
      { name: 'qx.windowFlash()', perm: 'public', desc: '闪烁当前窗口以引起用户注意', descEn: 'Flash current window for attention', usage: 'qx.windowFlash()', run: () => { qx.windowFlash(); return 'windowFlash()'; } },
      { name: 'qx.pickPath()', perm: 'public', desc: '唤起原生文件或目录选取器', descEn: 'Open native file or directory picker', usage: 'await qx.pickPath({ type: "file" })', run: () => qx.pickPath() },
      { name: 'qx.requestAppPermission()', perm: 'public', desc: '动态向用户申请特定权限节点', descEn: 'Request permission nodes at runtime', usage: 'await qx.requestAppPermission(["hosts:read"])', run: () => qx.requestAppPermission(['hosts:read']) },
    ],
  },
];

const ALL_SDK_ITEMS = SDK_GROUPS.flatMap((g) => g.items);

function matchesSdk(it, kw, group) {
  if (!kw) return true;
  if (it.name.toLowerCase().includes(kw)) return true;
  if (it.perm && it.perm.toLowerCase().includes(kw)) return true;
  if (it.desc && it.desc.toLowerCase().includes(kw)) return true;
  if (it.descEn && it.descEn.toLowerCase().includes(kw)) return true;
  if (it.usage && it.usage.toLowerCase().includes(kw)) return true;
  if (group) {
    if (group.id && group.id.toLowerCase().includes(kw)) return true;
    if (group.permScope && group.permScope.toLowerCase().includes(kw)) return true;
    if (group.labelKey && t(group.labelKey).toLowerCase().includes(kw)) return true;
    if (group.badge && group.badge.toLowerCase().includes(kw)) return true;
  }
  return false;
}

function SdkPage(props) {
  const out = outBox();
  const ctx = props.ctx;
  const snippetIdx = useState(0);
  const codeVal = useState(SDK_SNIPPETS[0].code);
  const running = useState(false);
  const filterKw = useState('');

  const kw = filterKw.value;
  const filteredGroups = SDK_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => matchesSdk(it, kw, g)),
  })).filter((g) => g.items.length > 0);

  const totalMatched = filteredGroups.reduce((acc, g) => acc + g.items.length, 0);

  async function runCode() {
    running.next = true;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction('qx', codeVal.value);
      const res = await fn(qx);
      out.show(res !== undefined ? res : '(Finished with no return value)');
    } catch (err) {
      out.show({ error: err.message, stack: err.stack });
    } finally {
      running.next = false;
    }
  }

  function pickSnippet(idx) {
    snippetIdx.next = idx;
    codeVal.next = SDK_SNIPPETS[idx].code;
  }

  const qxTotalKeys = Object.keys(qx).length;
  const kitTotalKeys = Object.keys(qx.kit || {}).length;

  function itemDesc(it) {
    const l = typeof lang === 'function' ? lang() : '';
    if (l && l.startsWith('en') && it.descEn) return it.descEn;
    return it.desc || it.name;
  }

  const sdkColumns = [
    {
      key: 'name',
      label: t('app.examples.col-sdk-method'),
      width: '180px',
      render: (it) => h('code', { class: 'gal-api-name' }, it.name),
    },
    {
      key: 'perm',
      label: t('app.examples.col-perm'),
      width: '120px',
      render: (it) => badge(it.perm, it.perm === 'public' || it.perm === '免权限' ? 'default' : 'info'),
    },
    {
      key: 'desc',
      label: t('app.examples.col-desc'),
      render: (it) => h('span', { class: 'gal-table-desc', text: itemDesc(it) }),
    },
    {
      key: 'usage',
      label: t('app.examples.col-usage'),
      render: (it) => h('code', { class: 'gal-table-code', text: it.usage }),
    },
    {
      key: 'action',
      label: t('app.examples.col-action'),
      width: '90px',
      cls: 'qx-actions-col',
      render: (it) => h('button', {
        class: 'btn btn-outline btn-xs',
        text: t('app.examples.btn-run'),
        onClick: async () => {
          try {
            out.show(await it.run(ctx));
          } catch (e) {
            out.show({ error: e.message });
          }
        },
      }),
    },
  ];

  const searchBar = h('div', { class: 'gal-row gal-search-bar', style: { marginBottom: '0.6rem' } }, [
    searchBox(t('app.examples.sdk-search-placeholder'), (v) => {
      filterKw.next = String(v || '').trim().toLowerCase();
    }, { value: kw }),
    h('span', { class: 'qx-count' }, [
      kw
        ? tf('app.examples.search-count-matched', { v1: totalMatched, v2: ALL_SDK_ITEMS.length })
        : tf('app.examples.sdk-count-all', { v1: ALL_SDK_ITEMS.length }),
    ]),
    kw
      ? h('button', {
        class: 'btn btn-ghost btn-xs',
        text: t('app.examples.btn-clear-search'),
        onClick: () => { filterKw.next = ''; },
      })
      : null,
  ]);

  return [
    searchBar,
    card(t('app.examples.tab-sdk'), [
      note(t('app.examples.sdk-intro')),
      h('pre', {
        class: 'gal-out',
        text: `// 统一引入方式：\nimport { qx } from '/assets/js/qxssh-sdk.js';\n// 或按需解构：\nimport { sh, which, CodeEditor, VirtualList, LineChart } from '/assets/js/qxssh-sdk.js';`,
      }),
    ]),

    kw && totalMatched === 0
      ? emptyState({
        title: t('app.examples.search-empty-title'),
        desc: t('app.examples.search-empty-desc'),
      })
      : filteredGroups.map((g) => card(t(g.labelKey), [
        h('div', { class: 'gal-row', style: { marginBottom: '6px' } }, [
          badge(g.badge || g.permScope, 'info'),
        ]),
        h('div', { class: 'gal-table-box' }, [
          table(sdkColumns, g.items, { rowKey: (it) => it.name }),
        ]),
      ])),

    card(t('app.examples.section-sdk-playground'), [
      note(t('app.examples.sdk-playground-desc')),
      h('div', { class: 'gal-code-toolbar' }, [
        selectField(
          t('app.examples.sdk-select-snippet'),
          SDK_SNIPPETS.map((sn, idx) => ({ value: String(idx), label: t(sn.titleKey) })),
          String(snippetIdx.value),
          (v) => pickSnippet(Number(v)),
          { cls: 'gal-code-select gal-snippet-select' },
        ),
        btn(
          running.value ? t('app.examples.sdk-running') : t('app.examples.sdk-run-code'),
          runCode,
          'btn btn-primary btn-sm gal-code-run-btn',
        ),
      ]),
      h(CodeEditor, {
        value: codeVal.value,
        lang: 'javascript',
        lineNumbers: true,
        rows: 8,
        onChange: (v) => { codeVal.next = v; },
      }),
    ]),

    card(t('app.examples.sdk-selfcheck'), [
      h('pre', {
        class: 'gal-out',
        text: [
          tf('app.examples.selfcheck-total', { v1: qxTotalKeys }),
          tf('app.examples.selfcheck-total', { v1: `qx.kit: ${kitTotalKeys}` }),
          tf('app.examples.selfcheck-total', { v1: `${SDK_GROUPS.length} groups / ${ALL_SDK_ITEMS.length} items` }),
          t('app.examples.sdk-selfcheck-ok'),
        ].join('\n'),
      }),
      note(tf('app.examples.sdk-selfcheck-note', { v1: qxTotalKeys, v2: ALL_SDK_ITEMS.length })),
    ]),

    card(t('app.examples.label-result'), [outNode(out)]),
  ];
}


function LayoutPage(props = {}) {
  const out = outBox();
  const flatPick = useState('x');
  const groupPick = useState('a');

  return filterDemoCards([
    demoCard(t('app.examples.section-card'), [
      h('div', { class: 'gal-grid2' }, [
        card(t('app.examples.card-plain'), [h('span', { text: t('app.examples.card-plain-desc') })]),
        card(t('app.examples.card-fill'), [h('span', { text: t('app.examples.card-fill-desc') })], { fill: true }),
      ]),
      note(t('app.examples.card-opts')),
    ]),
    demoCard(t('app.examples.section-floatcard'), [
      h('div', { class: 'gal-grid2' }, [
        h(FloatCard, {
          title: t('app.examples.floatcard-kind'),
          actions: [btn(t('app.examples.action-close'), () => out.show(t('app.examples.clicked-close')))],
          body: [h('span', { text: t(FLOAT_CARD_TEXT_KEY) })],
        }),
        h(FloatCard, { title: t('app.examples.floatcard-no-actions'), body: [h('span', { text: t('app.examples.floatcard-actions-optional') })] }),
        h(FloatCard, {
          title: t('app.examples.floatcard-hidden'),
          body: [h('span', { text: t('app.examples.floatcard-hidden-note') })],
          hidden: true,
        }),
      ]),
      note(t('app.examples.floatcard-note')),
    ]),
    demoCard(t('app.examples.section-sidebar-flat'), [
      note(t('app.examples.sidebar-flat-desc')),
      h('div', { class: 'gal-sidebar-box' }, [
        sidebarSections([{ items: [
          { id: 'x', label: t('app.examples.item-first'), icon: 'folder' },
          { id: 'y', label: t('app.examples.item-second'), icon: 'file' },
          { id: 'z', label: t('app.examples.item-third'), icon: 'star' },
        ] }], flatPick.value, (id) => {
          flatPick.next = id;
          out.show(tf('app.examples.sidebar-flat-selected', { v1: id }));
        }),
      ]),
    ]),
    demoCard(t('app.examples.section-sidebar-grouped'), [
      note(t('app.examples.sidebar-grouped-desc')),
      h('div', { class: 'gal-sidebar-box' }, [
        sidebarSections([
          { title: t('app.examples.group-one'), items: [{ id: 'a', label: t('app.examples.item-jia') }, { id: 'b', label: t('app.examples.item-yi') }] },
          {
            title: t('app.examples.group-two'),
            items: [{ id: 'c', label: t('app.examples.item-bing'), tip: t('app.examples.item-with-hint') }],
            note: t('app.examples.sidebar-group-note'),
          },
        ], groupPick.value, (id) => {
          groupPick.next = id;
          out.show(tf('app.examples.sidebar-grouped-selected', { v1: id }));
        }),
      ]),
    ]),
    demoCard(t('app.examples.label-result'), [outNode(out)]),
  ], props);
}

const TAB_ITEM_DEFS = [
  { id: 'a', key: 'app.examples.tab-overview', icon: 'info' },
  { id: 'b', key: 'app.examples.tab-details', icon: 'list' },
  { id: 'c', key: 'app.examples.tab-settings', icon: 'settings' },
];
const CRUMB_KEYS = ['app.examples.label-hosts', 'app.examples.field-group', 'node-01'];
const FILTER_DEFS = [
  { id: 'all', key: 'app.examples.filter-all' },
  { id: 'run', key: 'app.examples.status-running' },
  { id: 'stop', key: 'app.examples.status-stopped' },
];
const VIEW_DEFS = [
  { value: 'list', key: 'app.examples.view-list' },
  { value: 'grid', key: 'app.examples.view-grid' },
];
const CITY_DEFS = [
  { key: 'app.examples.city-beijing', value: 'a' },
  { key: 'app.examples.city-shanghai', value: 'b' },
  { key: 'app.examples.city-guangzhou', value: 'c' },
];
const NAV_PAGES = 5;
const POPPER_DEFS = [
  { value: 'bottom', key: 'app.examples.popper-bottom' },
  { value: 'top', key: 'app.examples.popper-top' },
  { value: 'right', key: 'app.examples.popper-right' },
];

function crumbLabel(key) {
  return key.startsWith('app.examples.') ? t(key) : key;
}

function PopperPanel({ items, value, cls = '', onClose = null, onPick = null }) {
  return h('div', { class: `cmp-pop-menu ${cls}`.trim() }, items.map((it) => h('button', {
    key: it.value,
    class: `cmp-pop-item${value === it.value ? ' active' : ''}`,
    type: 'button',
    onClick: () => { onClose?.(); onPick?.(it.value); },
  }, [
    h('span', { class: 'cmp-pop-item-name', text: t(it.key) }),
    value === it.value
      ? h('span', { class: 'cmp-pop-item-tick', html: icon('check', 'qicon qicon-sm') })
      : null,
  ].filter(Boolean))));
}

function NavPage(props = {}) {
  const out = outBox();
  const topTab = useState('a');
  const filter = useState('all');
  const view = useState('list');
  const picked = useState('b');
  const page = useState(1);

  const menuItems = [
    { label: t('app.examples.action-copy'), icon: 'copy', onClick: () => out.show(t('app.examples.menu-copy')) },
    { label: t('app.examples.action-rename'), icon: 'edit', onClick: () => out.show(t('app.examples.menu-rename')) },
    { sep: true },
    { label: t('app.examples.action-delete'), icon: 'trash', danger: true, onClick: () => out.show(t('app.examples.menu-delete')) },
  ];
  const menuBtn = h('button', {
    class: 'btn btn-outline btn-sm',
    text: t('app.examples.menu-open'),
    onClick: (e) => menu(menuItems, { x: e.clientX, y: e.clientY }),
  });

  const popperPlace = useState('bottom');
  const popperAnchor = { current: null };
  const popperOpen = { current: null };
  const popperBtn = h('button', {
    class: 'btn btn-outline btn-sm',
    text: t('app.examples.popper-open'),
    ref: (el) => { popperAnchor.current = el; },
    onClick: (e) => {
      e.stopPropagation();
      if (popperOpen.current && !popperOpen.current.closed) {
        popperOpen.current.close();
        return;
      }
      popperOpen.current = openPopper(PopperPanel, {
        anchor: popperAnchor.current,
        placement: popperPlace.value,
        props: {
          items: POPPER_DEFS,
          value: popperPlace.value,
          onPick: (v) => { popperPlace.next = v; },
        },
      });
    },
  });

  return filterDemoCards([
    demoCard(t('app.examples.section-tabs'), [
      h(Tabs, {
        items: TAB_ITEM_DEFS.map((it) => ({ id: it.id, label: t(it.key), icon: it.icon })),
        active: topTab.value,
        onChange: (id) => { topTab.next = id; },
      }),
      h('pre', { class: 'gal-out', text: tf('app.examples.tabs-index', { v1: (topTab.value) }) }),
      note(t('app.examples.tabs-note')),
    ]),
    demoCard(t('app.examples.section-breadcrumb'), [
      h('div', { class: 'gal-row' }, [
        breadcrumb(CRUMB_KEYS.map((key) => ({ label: crumbLabel(key) })), (item, i) => {
          out.show(CRUMB_TEXT(item.label, i, CRUMB_KEYS.length));
        }),
      ]),
      note(t('app.examples.breadcrumb-note')),
    ]),
    demoCard(t('app.examples.section-filter'), [
      chipGroup(FILTER_DEFS.map((f) => ({ id: f.id, label: t(f.key) })), filter.value, (id) => { filter.next = id; }),
      note(tf('app.examples.filter-current', { v1: (filter.value) })),
      segmented(VIEW_DEFS.map((v) => ({ value: v.value, label: t(v.key) })), view.value, (v) => { view.next = v; }),
      note(tf('app.examples.view-current', { v1: (view.value) })),
      note(t('app.examples.chipgroup-note')),
    ]),
    demoCard(t('app.examples.section-menu'), [
      row(menuBtn, h(DropdownButton, {
        label: t('app.examples.menu-more'),
        items: [
          { label: t('app.examples.menu-export'), onClick: () => out.show(t('app.examples.dropdown-export')) },
          { label: t('app.examples.menu-import'), onClick: () => out.show(t('app.examples.dropdown-import')) },
        ],
      })),
      h('div', { class: 'gal-stage gal-stage-menu' }, [h(MenuPanel, { items: menuItems })]),
      note(t('app.examples.menu-note-1')
        + t('app.examples.menu-note-2')),
    ]),
    demoCard(t('app.examples.section-popper'), [
      row(popperBtn),
      note(t('app.examples.popper-note-1')
        + t('app.examples.popper-note-2')),
    ]),
    demoCard(t('app.examples.section-steps'), [
      steps([
        { label: t('app.examples.step-pick-host') },
        { label: t('app.examples.step-configure') },
        { label: t('app.examples.step-confirm') },
      ], 1),
      note(t('app.examples.steps-note')),
    ]),
    demoCard(t('app.examples.section-search'), [
      row(
        searchBox(t('app.examples.search-hosts'), (v) => out.show(tf('app.examples.searchbox-value', { v1: (v || t('app.examples.empty-parens')) }))),
        h(SearchSelect, {
          items: CITY_DEFS.map((c) => ({ label: t(c.key), value: c.value })),
          value: picked.value,
          onChange: (v) => { picked.next = v; out.show(tf('app.examples.searchselect-value', { v1: v })); },
          placeholder: t('app.examples.search-or-pick'),
        }),
      ),
      note(t('app.examples.searchbox-note-1')
        + t('app.examples.searchbox-note-2')),
    ]),
    demoCard(t('app.examples.section-toolbar'), [
      toolbar([
        iconButton('refresh', { tip: t('app.examples.action-refresh'), onClick: () => out.show(t('app.examples.clicked-refresh')) }),
        h('span', { class: 'gal-note', text: t('app.examples.toolbar-label') }),
      ], { end: [btn(t('app.examples.toolbar-actions'), () => out.show(t('app.examples.toolbar-actions-tip')))] }),
      h('div', { class: 'gal-col' }, [note(t('app.examples.toolbar-body'))]),
    ]),
    demoCard(t('app.examples.section-pagination'), [
      h('div', { class: 'gal-row gal-pager' }, [
        pagination(page.value, NAV_PAGES, (p) => {
          page.next = p;
          out.show(tf('app.examples.page-n', { v1: p }));
        }),
      ]),
      note(t('app.examples.pagination-note')),
    ]),
    demoCard(t('app.examples.section-timeline'), [
      timeline([
        { title: t('app.examples.status-connected'), desc: fmtTime(Date.now() - 3600e3), kind: 'success' },
        { title: t('app.examples.timeline-retry'), desc: fmtTime(Date.now() - 1800e3), kind: 'warning' },
        { title: t('app.examples.timeline-session-end'), desc: fmtTime(Date.now()), kind: '' },
      ]),
    ]),
    demoCard(t('app.examples.label-result'), [outNode(out)]),
  ], props);
}

function FormPage(props = {}) {
  const out = outBox();

  return filterDemoCards([
    demoCard(t('app.examples.section-input'), [
      inputField(t('app.examples.field-single-label'), 'node-01', (v) => out.show(`inputField：${v}`), {
        placeholder: t('app.examples.field-optional'), mono: true,
      }),
      textareaField(t('app.examples.field-multi-label'), 'uptime\ndf -h',
        (v) => out.show(tf('app.examples.textarea-value', { v1: (v.length) })), { rows: 3, mono: true }),
      field(t('app.examples.field-with-note'), h('span', { class: 'gal-note', text: t(FIELD_TEXT_KEY) })),
      note(t('app.examples.inputfield-note')),
    ]),
    demoCard(t('app.examples.section-select'), [
      selectField(t('app.examples.select-label'), [
        { value: 'ssh', label: 'SSH' },
        { value: 'sftp', label: 'SFTP' },
      ], 'ssh', (v) => out.show(`selectField：${v}`)),
      h(RadioGroup, {
        items: [
          { value: 'a', label: t('app.examples.option-a') },
          { value: 'b', label: t('app.examples.option-b') },
        ],
        value: 'a',
        onChange: (v) => out.show(`radioGroup：${v}`),
      }),
      note(t('app.examples.radiogroup-note')),
    ]),
    demoCard(t('app.examples.section-toggle'), [
      h(Checkbox, {
        label: t('app.examples.checkbox-label'),
        checked: true,
        onChange: (v) => out.show(`Checkbox：${v}`),
      }),
      h(SwitchToggle, {
        label: t('app.examples.switch-label'),
        checked: true,
        onChange: (v) => out.show(`SwitchToggle：${v}`),
      }),
      h(PasswordField, {
        label: t('app.examples.password-label'),
        value: '',
        onInput: (v) => out.show(PASS_TEXT(v)),
      }),
      note(t('app.examples.switchtoggle-note')),
    ]),
    demoCard(t('app.examples.section-number'), [
      h(SliderField, {
        label: t('app.examples.slider-label'),
        value: 40,
        onChange: (v) => out.show(`SliderField：${v}`),
        min: 0, max: 100, unit: '%',
      }),
      h(StepperField, {
        label: t('app.examples.field-port'),
        value: 22,
        onChange: (v) => out.show(`StepperField：${v}`),
        min: 1, max: 65535,
      }),
    ]),
    demoCard(t('app.examples.section-composite'), [
      h(TagInput, {
        tags: ['web', 'db'],
        onChange: (v) => out.show(`TagInput：${JSON.stringify(v)}`),
      }),
      h(KvEditor, {
        pairs: [
          ['PATH', '/usr/local/bin:/usr/bin'],
          ['LANG', 'zh_CN.UTF-8'],
        ],
        onChange: (pairs) => out.show(`KvEditor：${JSON.stringify(pairs)}`),
      }),
      copyField('ssh node-01 -p 22', { mono: true }),
    ]),
    demoCard(t('app.examples.section-file-async'), [
      h(FileDrop, {
        multiple: true,
        onFiles: (files) => out.show(DROP_TEXT(files)),
        text: t('app.examples.filedrop-hint'),
      }),
      h(AsyncButton, {
        label: t('app.examples.asyncbtn-label'),
        fn: async () => {
          await new Promise((r) => setTimeout(r, 600));
          return 'done';
        },
        okToast: t('app.examples.asyncbtn-done'),
      }),
      note(t('app.examples.asyncbtn-note')),
    ]),
    demoCard(t('app.examples.label-result'), [outNode(out)]),
  ], props);
}

const TABLE_COLS = [
  { key: 'name', labelKey: 'app.examples.label-hosts' },
  { key: 'addr', labelKey: 'app.examples.col-address' },
  { key: 'st', labelKey: 'app.examples.col-status', render: (r) => badge(r.st, r.ok ? 'success' : 'error') },
];
const TABLE_ROW_DEFS = [
  { name: 'node-01', addr: '10.0.0.1:22', stKey: 'app.examples.status-online', ok: true },
  { name: 'node-02', addr: '10.0.0.2:22', stKey: 'app.examples.status-offline', ok: false },
];
const TREE_ITEM_DEFS = [
  { id: 'g1', key: 'app.examples.env-prod', children: [
    { id: 'h1', label: 'node-01' },
    { id: 'h2', label: 'node-02' },
  ] },
  { id: 'g2', key: 'app.examples.env-test', children: [
    { id: 'h3', label: 'test-01' },
  ] },
];
const LOG_LINES = [
  `${fmtTime(Date.now() - 120e3)}  [info]   连接已建立`,
  `${fmtTime(Date.now() - 60e3)}  [warn]   延迟偏高：320ms`,
  `${fmtTime(Date.now())}  [error]  一次认证失败`,
];

function DataPage(props = {}) {
  const out = outBox();
  const collapsed = useState(new Set(['g2']));

  function toggleNode(id, expanded) {
    const s = new Set(collapsed.value);
    if (expanded) s.delete(id);
    else s.add(id);
    collapsed.next = s;
  }

  return filterDemoCards([
    demoCard(t('app.examples.section-table'), [
      table(
        TABLE_COLS.map((c) => ({ ...c, label: t(c.labelKey) })),
        TABLE_ROW_DEFS.map((r) => ({ ...r, st: t(r.stKey) })),
        {
          rowKey: (r) => r.name,
          onRowClick: (r) => out.show(tf('app.examples.table-row-clicked', { v1: (r.name) })),
        },
      ),
      note(t('app.examples.table-note')),
    ]),
    demoCard(t('app.examples.section-tree'), [
      h('div', { class: 'gal-sidebar-box' }, [
        h(Tree, {
          items: TREE_ITEM_DEFS.map((n) => ({ ...n, label: t(n.key) })),
          collapsed: collapsed.value,
          onToggle: toggleNode,
          onSelect: (n) => out.show(tf('app.examples.tree-selected', { v1: (n.label) })),
        }),
      ]),
      note(t(TREE_NOTE_KEY)),
    ]),
    demoCard(t('app.examples.section-listrow'), [
      h('div', { class: 'gal-col' }, [
        listRow([h('span', { text: t('app.examples.listrow-clickable') })], { onClick: () => out.show(t('app.examples.listrow-clicked')) }),
        listRow([
          h('span', { text: t('app.examples.listrow-trailing') }),
          h('span', { class: 'gal-note', text: 'trail' }),
        ], { active: true }),
      ]),
      note(t('app.examples.listrow-note')),
    ]),
    demoCard(t('app.examples.section-json'), [
      h(JsonViewer, { value: JSON_SAMPLE, maxDepth: 3, cls: 'gal-json-box' }),
      note(t('app.examples.jsonviewer-note')),
    ]),
    demoCard(t('app.examples.section-json-expand'), [
      h('div', { class: 'gal-grid2' }, [
        h(JsonViewer, {
          value: JSON_CHAIN_SAMPLE,
          expandAll: true,
          rootLabel: 'expandAll: true',
          cls: 'gal-json-box',
        }),
        h(JsonViewer, {
          value: JSON_CHAIN_SAMPLE,
          maxDepth: 1,
          expandAll: false,
          rootLabel: 'maxDepth: 1',
          cls: 'gal-json-box',
        }),
      ]),
      note(t('app.examples.jsonviewer-expand-note')),
    ]),
    demoCard(t('app.examples.section-json-keysplit'), [
      h(JsonViewer, {
        value: JSON_CHAIN_SAMPLE,
        expandAll: true,
        keySplit: /\s+/,
        shader: timingShader(),
        rootLabel: t('app.examples.json-keysplit-root'),
        cls: 'gal-json-box',
      }),
      note(t('app.examples.jsonviewer-keysplit-note')),
    ]),
    demoCard(t('app.examples.section-json-shader'), [
      h('div', { class: 'gal-grid2' }, [
        h(JsonViewer, {
          value: JSON_LOG_SAMPLE,
          expandAll: true,
          shader: languageShader('log'),
          rootLabel: "languageShader('log')",
          cls: 'gal-json-box',
        }),
        h(JsonViewer, {
          value: JSON_UTIL_SAMPLE,
          expandAll: true,
          shader: 'examples-threshold',
          rootLabel: "shader: 'examples-threshold'",
          cls: 'gal-json-box',
        }),
      ]),
      h(JsonViewer, {
        value: JSON_EVENT_SAMPLE,
        expandAll: true,
        shader: composeShaders(
          fieldShader({ unit: timingShader() }),
          languageShader('log'),
        ),
        rootLabel: 'composeShaders(fieldShader({ unit: timingShader() }), languageShader("log"))',
        cls: 'gal-json-box',
      }),
      note(`${t('app.examples.jsonviewer-shader-note')} ${t('app.examples.jsonviewer-shader-registered')}${listJsonShaders().join(', ')}`),
    ]),
    demoCard(t('app.examples.section-log'), [
      h(LogPanel, { title: t('app.examples.log-title'), lines: LOG_LINES, maxHeight: '9rem' }),
      note(t('app.examples.logpanel-note')),
    ]),
    demoCard(t('app.examples.section-code'), [
      codeBlock('ssh -J jump@10.0.0.1 root@10.0.0.9 -p 22'),
    ]),
    demoCard(t('app.examples.section-progress'), [
      h('div', { class: 'gal-grid2' }, [
        progressBar(72),
        progressRing(72, { label: '72%' }),
        segmentedBar(45, { kind: 'success' }),
      ]),
    ]),
    demoCard(t('app.examples.section-stattile'), [
      h('div', { class: 'gal-grid2' }, [
        statTile('CPU', '18', { unit: '%' }),
        statTile(t('app.examples.stat-mem'), '3.2', { unit: 'GB' }),
        statTile(t('app.examples.stat-hosts-online'), '4', { kind: 'success' }),
      ]),
    ]),
    demoCard(t('app.examples.section-exec'), [
      execResultCard(EXEC_SAMPLE),
      note(t('app.examples.execresult-note')),
      execResults([
        { ok: true, name: 'uptime', out: ' 14:32:01 up 12 days', dur: '0.03s' },
        { ok: false, name: 'df -h', err: 'command not found: df', dur: '0.01s' },
      ], { sum: t('app.examples.exec-summary') }),
    ]),
    demoCard(t('app.examples.section-spinner'), [
      spinner(t('app.examples.loading')),
      h(Collapsible, {
        title: t('app.examples.collapsible-label'),
        body: [h('span', { text: t('app.examples.collapsible-content') })],
      }),
    ]),
    demoCard(t('app.examples.section-loadingmask'), [
      row(btn(t('app.examples.loadingmask-label'), () => {
        const m = loadingMask(t('app.examples.loading'));
        setTimeout(() => m.close(), 1800);
      })),
      note(t('app.examples.loadingmask-note')),
    ]),
    demoCard(t('app.examples.label-result'), [outNode(out)]),
  ], props);
}

function StatePage(props = {}) {
  const out = outBox();

  return filterDemoCards([
    demoCard(t('app.examples.section-kv'), [
      sectionTitle(t('app.examples.kv-section-title')),
      keyValue(t('app.examples.kv-single'), t('app.examples.kv-single-note')),
      kvGrid([
        [t('app.examples.kv-proto'), 'SSH'],
        [t('app.examples.field-port'), '22'],
        [t('app.examples.kv-auth'), 'publickey'],
        [t('app.examples.kv-keepalive'), '30s'],
      ], { cols: 2 }),
      note(t('app.examples.kv-note')),
    ]),
    demoCard(t('app.examples.section-badge'), [
      row(
        badge(t('app.examples.kind-default')), badge(t('app.examples.sev-success'), 'success'), badge(t('app.examples.sev-warning'), 'warning'),
        badge(t('app.examples.sev-error'), 'error'), badge(t('app.examples.sev-info'), 'info'),
      ),
      row(
        statusDot('success', t('app.examples.dot-normal')), statusDot('warning', t('app.examples.dot-caution')),
        statusDot('error', t('app.examples.dot-abnormal')), statusDot('', t('app.examples.dot-unknown')),
      ),
      note(t('app.examples.badge-note')),
    ]),
    demoCard(t('app.examples.section-statusbar'), [
      statusBar([
        badge(t('app.examples.status-connected'), 'success'),
        t('app.examples.statusbar-latency'),
        badge(t('app.examples.statusbar-warnings'), 'warning'),
      ]),
      note(t('app.examples.statusbar-note')),
    ]),
    demoCard(t('app.examples.section-alertbar'), [
      alertBar('info', t('app.examples.sev-info'), t('app.examples.alertbar-info')),
      alertBar('success', t('app.examples.sev-success'), t('app.examples.alertbar-success')),
      alertBar('warning', t('app.examples.sev-warning'), t('app.examples.alertbar-warning')),
      alertBar('error', t('app.examples.sev-error'), t('app.examples.alertbar-error')),
    ]),
    demoCard(t('app.examples.section-empty'), [
      h('div', { class: 'gal-grid2' }, [
        emptyState(t('app.examples.empty-no-data')),
        emptyAction(t('app.examples.empty-no-hosts'), t('app.examples.empty-add-host'), () => out.show(t('app.examples.empty-clicked-add'))),
        errorState(t('app.examples.load-failed')),
        h('div', { class: 'gal-col' }, [skeleton(), skeleton('skeleton-line'),
          skeleton('skeleton-avatar')]),
      ]),
      note(t('app.examples.skeleton-note')),
    ]),
    demoCard(t('app.examples.section-tip'), [
      row(
        h('button', {
          class: 'btn btn-outline btn-sm',
          text: t('app.examples.tip-hover-me'),
          onClick: () => out.show(t('app.examples.tip-clicked')),
          ...tipAttrs(t('app.examples.tip-content')),
        }),
        kbd(modLabel()), kbd('Shift'), kbd('Alt'),
      ),
      note(t('app.examples.tipattrs-note')
        + t('app.examples.tipattrs-note-2')
        + t('app.examples.tipattrs-note-3')),
    ]),
    demoCard(t('app.examples.label-result'), [outNode(out)]),
  ], props);
}

function ActionPage(props = {}) {
  const out = outBox();
  const step = useState('idle');

  return filterDemoCards([
    demoCard(t('app.examples.section-iconbutton'), [
      row(
        iconButton('plus', { tip: t('app.examples.action-new'), onClick: () => out.show(t('app.examples.action-new')) }),
        iconButton('copy', { tip: t('app.examples.action-copy'), onClick: () => out.show(t('app.examples.action-copy')) }),
        iconButton('trash', { tip: t('app.examples.action-delete'), onClick: () => out.show(t('app.examples.action-delete')) }),
        iconButton('settings', { tip: t('app.examples.tab-settings'), active: true, onClick: () => out.show(t('app.examples.tab-settings')) }),
        iconButton('save', {
          tip: t('app.examples.iconbutton-disabled'), disabled: true, onClick: () => out.show(t('app.examples.iconbutton-disabled-note')),
        }),
      ),
      note(t('app.examples.iconbutton-opts')),
    ]),
    demoCard(t('app.examples.section-copybutton'), [
      row(copyButton('ssh root@10.0.0.1 -p 22', {
        onDone: (ok) => toast(ok ? t('app.examples.copied') : t('app.examples.icon-copy-failed'), ok ? 'success' : 'error'),
      }), h('span', { class: 'gal-note mono', text: SSH_TEXT })),
    ]),
    demoCard(t('app.examples.section-confirmbar'), [
      btn(t('app.examples.action-delete'), () => { step.next = step.value === 'ask' ? 'idle' : 'ask'; }),
      step.value === 'ask'
        ? h(ConfirmBar, {
          message: t('app.examples.confirmbar-title'),
          onConfirm: () => { step.next = 'done'; },
        })
        : note(step.value === 'done' ? t('app.examples.confirmbar-done') : t(DEL_HINT_KEY)),
      note(t('app.examples.confirmbar-note')),
    ]),
    demoCard(t('app.examples.section-dialogpanel'), [
      h('div', { class: 'gal-stage' }, [
        h(DialogPanel, {
          title: t('app.examples.dialogpanel-label'),
          body: [h('span', { text: t('app.examples.dialogpanel-note-1')
            + t('app.examples.dialogpanel-note-2') })],
          actions: [
            h('button', { class: 'btn btn-ghost btn-sm', text: t('app.examples.action-cancel') }),
            h('button', { class: 'btn btn-primary btn-sm', text: t('app.examples.action-ok') }),
          ],
          width: 'sm',
        }),
      ]),
      note(t('app.examples.dialogpanel-note-3')),
    ]),
    demoCard(t('app.examples.section-dialog'), [
      btn(t('app.examples.dialog-open'), () => {
        const dlg = dialog({
          title: t('app.examples.dialog-label'),
          body: [h('span', { text: t('app.examples.dialog-note') })],
          actions: [
            h('button', {
              class: 'btn btn-ghost btn-sm', text: t('app.examples.action-cancel'), onClick: () => dlg.close(),
            }),
            h('button', {
              class: 'btn btn-primary btn-sm',
              text: t('app.examples.action-ok'),
              onClick: () => { out.show(t('app.examples.confirmed')); dlg.close('ok'); },
            }),
          ],
        });
      }),
      note(t('app.examples.dialog-note-2')
        + t('app.examples.dialog-note-3')),
    ]),
    demoCard(t('app.examples.section-promptdialog'), [
      btn(t('app.examples.promptdialog-open'), async () => {
        const v = await promptDialog({ title: t('app.examples.promptdialog-label'), placeholder: t('app.examples.promptdialog-placeholder') });
        out.show(tf('app.examples.promptdialog-got', { v1: (JSON.stringify(v)) }));
      }),
      note(t('app.examples.promptdialog-note')),
    ]),
    demoCard(t('app.examples.section-confirmaction'), [
      row(btn(t('app.examples.confirmaction-label'), async () => {
        const ok = await confirmAction(t('app.examples.confirmaction-title'), { danger: true });
        out.show(`confirmAction -> ${ok}`);
      })),
      note(t('app.examples.confirmaction-note-1')
        + t('app.examples.confirmaction-note-2')),
    ]),
    demoCard(t('app.examples.section-sideaction'), [
      row(
        sideAction({ icon: 'terminal', label: t('app.examples.sideaction-demo'), onClick: () => out.show('sideAction: clicked!'), on: true }),
        sideAction({ icon: 'folder', label: t('app.examples.sideaction-disabled'), disabled: true }),
      ),
      note(t('app.examples.sideaction-note')),
    ]),
    demoCard(t('app.examples.label-result'), [outNode(out)]),
  ], props);
}

const CODE_SAMPLES = {
  javascript: `// QxSSH CodeEditor demo\nasync function main() {\n  const info = await qx.host();\n  console.log("Connected to", info.hostname);\n}`,
  json: `{\n  "service": "qxssh",\n  "port": 8800,\n  "enabled": true,\n  "tags": ["ssh", "webui"]\n}`,
  sh: `#!/bin/bash\necho "Checking system status..."\nuname -a\ndf -h\nfree -m`,
  sql: `SELECT id, hostname, ip, status\nFROM hosts\nWHERE status = 'online'\nORDER BY id ASC;`,
};

function AdvancedPage(props = {}) {
  const out = outBox();

  // CodeEditor state
  const codeLang = useState('javascript');
  const codeReadOnly = useState(false);
  const codeVal = useState(CODE_SAMPLES.javascript);

  function onLangSelect(lang) {
    codeLang.next = lang;
    if (CODE_SAMPLES[lang]) {
      codeVal.next = CODE_SAMPLES[lang];
    }
  }

  // VirtualList state
  const vlistItems = useState(() => Array.from({ length: 10000 }, (_, i) => ({
    id: i + 1,
    name: `Server-Node-${String(i + 1).padStart(5, '0')}`,
    ip: `192.168.${Math.floor(i / 254)}.${(i % 254) + 1}`,
    status: i % 3 === 0 ? 'online' : (i % 3 === 1 ? 'idle' : 'busy'),
  })));
  const vlistRef = { current: null };

  // LineChart state
  const ts = useState(() => {
    const tbuf = timeSeries(30, 2);
    const now = Date.now();
    for (let i = 29; i >= 0; i--) {
      tbuf.push([20 + Math.sin(i / 3) * 15 + Math.random() * 5, 45 + Math.cos(i / 2) * 10 + Math.random() * 5], now - i * 1000);
    }
    return tbuf;
  }).value;
  const chartData = useState(() => ts.data());

  function pushChartPoint() {
    ts.push([
      Math.max(5, Math.min(95, 30 + Math.random() * 40)),
      Math.max(10, Math.min(95, 50 + Math.random() * 30)),
    ]);
    chartData.next = ts.data();
    out.show({ pushed: true, length: ts.length, peaks: ts.peaks() });
  }

  // DataView & Splitter
  const dvRef = useState(null);
  const splitRef = useState(null);

  return filterDemoCards([
    demoCard(t('app.examples.section-codeeditor'), [
      h('div', { class: 'gal-code-toolbar' }, [
        selectField(
          t('app.examples.codeeditor-lang'),
          [
            { value: 'javascript', label: 'JavaScript' },
            { value: 'json', label: 'JSON' },
            { value: 'sh', label: 'Shell' },
            { value: 'sql', label: 'SQL' },
          ],
          codeLang.value,
          onLangSelect,
          { cls: 'gal-code-select' },
        ),
        h(Checkbox, {
          label: t('app.examples.codeeditor-readonly'),
          checked: codeReadOnly.value,
          onChange: (v) => { codeReadOnly.next = v; },
        }),
      ]),
      h(CodeEditor, {
        value: codeVal.value,
        lang: codeLang.value,
        readOnly: codeReadOnly.value,
        lineNumbers: true,
        rows: 6,
        onChange: (v) => { codeVal.next = v; },
      }),
      codeField(t('app.examples.codefield-label'), {
        multiline: false,
        lang: 'json',
        value: '{"port": 8800, "ssl": false, "active": true}',
        onChange: (v) => out.show(`codeField: ${v}`),
      }),
      note(t('app.examples.codeeditor-note')),
    ]),
    demoCard(t('app.examples.section-virtuallist'), [
      row(
        btn(t('app.examples.virtuallist-scroll-top'), () => scrollToRow(vlistRef.current, 0, 32, 'start')),
        btn(t('app.examples.virtuallist-scroll-mid'), () => scrollToRow(vlistRef.current, 4999, 32, 'center')),
        btn(t('app.examples.virtuallist-scroll-bottom'), () => scrollToRow(vlistRef.current, 9999, 32, 'end')),
      ),
      h('div', { style: { height: '200px', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' } }, [
        h(VirtualList, {
          items: vlistItems.value,
          rowHeight: 32,
          listRef: vlistRef,
          onRowClick: (item) => out.show(item),
          render: (item) => h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', width: '100%' },
          }, [
            h('span', { style: { fontFamily: 'monospace' }, text: `#${item.id} ${item.name}` }),
            h('span', { class: 'gal-note', text: item.ip }),
            badge(item.status, { tone: item.status === 'online' ? 'success' : (item.status === 'busy' ? 'warning' : 'neutral') }),
          ]),
        }),
      ]),
      note(t('app.examples.virtuallist-note')),
    ]),
    demoCard(t('app.examples.section-linechart'), [
      row(
        btn(t('app.examples.linechart-add-point'), pushChartPoint),
      ),
      h(LineChart, {
        height: 160,
        time: true,
        data: chartData.value,
        series: [
          { label: 'CPU %', color: '#3b82f6', fill: true },
          { label: 'Mem %', color: '#10b981', fill: true },
        ],
      }),
      note(t('app.examples.linechart-note')),
    ]),
    demoCard(t('app.examples.section-dataview'), [
      row(
        btn(t('app.examples.dataview-reload'), () => dvRef.value?.reload()),
      ),
      h('div', {
        style: {
          display: 'flex',
          height: '140px',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          overflow: 'hidden',
          position: 'relative',
        },
        onMount: (container) => {
          const leftPane = document.createElement('div');
          leftPane.style.cssText = 'flex: 1 1 0; min-width: 150px; padding: 10px; overflow: auto; background: var(--card-bg, rgba(255,255,255,0.03));';

          const dv = createDataView({
            load: async () => {
              await new Promise((r) => setTimeout(r, 300));
              return [
                { id: 'web-1', role: 'Nginx Gateway', status: 'active' },
                { id: 'api-1', role: 'Go Backend API', status: 'active' },
                { id: 'db-1', role: 'PostgreSQL Primary', status: 'standby' },
              ];
            },
            render: (rows) => h('div', { class: 'gal-col', style: { gap: '4px' } }, rows.map((r) => h('div', {
              style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' },
            }, [
              h('span', { text: r.id }),
              h('span', { class: 'gal-note', text: r.role }),
            ]))),
          });
          dvRef.next = dv;
          leftPane.appendChild(dv.element);

          const rightPane = document.createElement('div');
          rightPane.style.cssText = 'flex: 0 0 240px; padding: 12px; font-size: 12px; overflow: auto; border-left: 1px solid var(--hairline); color: var(--muted-foreground);';
          rightPane.textContent = t('app.examples.dataview-note');

          const splitter = createSplitter({
            key: 'qx-examples-splitter',
            min: 120,
            pad: 100,
            getBody: () => container,
            getPanel: () => rightPane,
          });
          splitRef.next = splitter;

          container.appendChild(leftPane);
          container.appendChild(splitter.el);
          container.appendChild(rightPane);
        },
        onUnmount: () => {
          dvRef.value?.dispose();
          splitRef.value?.destroy();
        },
      }),
      note(t('app.examples.dataview-note')),
    ]),
    demoCard(t('app.examples.section-i18n-ui'), [
      row(
        note('i18nSelect:'),
        i18nSelect(),
        note('i18nButton:'),
        i18nButton({ cls: 'btn btn-outline btn-sm' }),
        note('i18nMenu:'),
        i18nMenu({ cls: 'btn btn-outline btn-sm' }),
      ),
      note(t('app.examples.i18n-ui-note')),
    ]),
    demoCard(t('app.examples.label-result'), [outNode(out)]),
  ], props);
}

function ComponentsPage() {
  const activeClass = useState('layout');
  const kwState = useState('');
  const clsId = activeClass.value;
  const kw = kwState.value;

  const allCompNames = Object.keys(ALL_COMPONENTS).filter((n) => !REEXPORTED.has(n));
  const matchedCompNames = kw
    ? allCompNames.filter((n) => matchesComponent(n, kw))
    : allCompNames;

  const searchBar = h('div', { class: 'gal-row gal-search-bar', style: { marginBottom: '0.6rem' } }, [
    searchBox(t('app.examples.component-search-placeholder'), (v) => {
      kwState.next = String(v || '').trim().toLowerCase();
    }, { value: kw }),
    h('span', { class: 'qx-count' }, [
      kw
        ? tf('app.examples.components-count-filtered', { v1: matchedCompNames.length, v2: allCompNames.length })
        : tf('app.examples.components-count-all', { v1: allCompNames.length }),
    ]),
    kw
      ? h('button', {
        class: 'btn btn-ghost btn-xs',
        text: t('app.examples.btn-clear-search'),
        onClick: () => { kwState.next = ''; },
      })
      : null,
  ]);

  if (kw) {
    if (matchedCompNames.length === 0) {
      return [
        searchBar,
        emptyState({
          title: t('app.examples.search-empty-title'),
          desc: t('app.examples.search-empty-desc'),
        }),
      ];
    }

    const matchedClassIds = new Set(matchedCompNames.map((n) => COMPONENT_CLASS[n]).filter(Boolean));
    const activeClasses = COMPONENT_CLASSES.filter((c) => matchedClassIds.has(c.id));

    return [
      searchBar,
      h('div', { class: 'gal-row', style: { marginBottom: '0.8rem', flexWrap: 'wrap', gap: '6px' } },
        matchedCompNames.map((n) => h('button', {
          key: n,
          type: 'button',
          class: 'cmp-badge cmp-badge-info',
          style: { cursor: 'pointer', border: 'none' },
          dataset: { tip: `点击仅查看 ${n}` },
          onClick: () => { kwState.next = n; },
        }, n))
      ),
      ...activeClasses.map((c) => {
        const SubPage = CLASS_PAGE[c.id];
        const names = componentsIn(c.id).filter((n) => matchedCompNames.includes(n));
        return card(`${t(c.labelKey)}（${names.length}）`, [
          h('div', { class: 'gal-note', style: { marginBottom: '0.5rem' } }, [
            tf('app.examples.class-components', { v1: names.length, v2: names.join('、') }),
          ]),
          h(SubPage, { filterComps: matchedCompNames, kw }),
        ]);
      }),
    ];
  }

  const Page = CLASS_PAGE[clsId] || CLASS_PAGE.layout;
  const names = componentsIn(clsId);

  return [
    searchBar,
    h('div', { class: 'gal-comp-header' }, [
      segmented(
        COMPONENT_CLASSES.map((c) => ({ value: c.id, label: t(c.labelKey) })),
        clsId,
        (id) => { activeClass.next = id; },
        { cls: 'gal-comp-segmented' },
      ),
    ]),
    h('div', { class: 'gal-note', style: { margin: '4px 0 10px 0' } }, [
      tf('app.examples.class-components', { v1: names.length, v2: names.join('、') }),
    ]),
    h(Page, NO_PROPS),
  ];
}



const CLASS_PAGE = {
  layout: LayoutPage,
  nav: NavPage,
  form: FormPage,
  data: DataPage,
  state: StatePage,
  action: ActionPage,
  advanced: AdvancedPage,
};

COMPONENT_CLASSES.forEach((c) => {
  if (typeof CLASS_PAGE[c.id] !== 'function') {
    console.warn(`[examples] 分类「${c.label}」没有对应的页面组件`);
  }
});

const COVERAGE = coverageReport();
if (COVERAGE.missing.length || COVERAGE.unknown.length) {
  console.warn('[examples] 组件分类表与 components.js 不一致', COVERAGE);
}
const API_COVERAGE = apiCoverageReport();
if (API_COVERAGE.missing.length || API_COVERAGE.unknown.length) {
  console.warn('[examples] 端点清单与 core/qxssh-api.js 不一致', API_COVERAGE);
}
const SDK_COVERAGE = sdkCoverageReport();
if (SDK_COVERAGE.missing.length || SDK_COVERAGE.unknown.length) {
  console.warn('[examples] SDK 演示清单与 qxssh-sdk.js 的 qx 命名空间不一致', SDK_COVERAGE);
}

const NO_PROPS = {};

setupAppI18n({
  base: new URL('./language', import.meta.url).href,
  languages: ['zh-CN', 'en-US'],
  scope: 'examples',
}).catch(() => { }).then(() => {
  bootApp(({ root, ctx }) => {
    setTitle('Examples');

    const PAGES = {
      icons: IconsPage,
      components: ComponentsPage,
      sysapi: SysApiPage,
      sdk: SdkPage,
    };

    const shell = createAppShell(root, {
      tabs: tabsNow(),
      active: TAB_DEFS[0].id,
      onChange: (id) => show(id),
    });

    const offLang = onLangChange(() => shell.setTabs(tabsNow()));

    const active = signal('');
    const pages = new Map();

    function show(id) {
      if (!PAGES[id]) return;
      pageSlot(id);
      active.next = id;
    }

    function pageSlot(id) {
      if (pages.has(id)) return;
      const box = document.createElement('div');
      box.className = 'qx-scroll';
      const view = createView(box);
      const props = { ctx };
      view.update(() => h(PAGES[id], props));
      pages.set(id, view);
    }

    function mainTree() {
      const cur = active.value;
      return h('div', { class: 'gal-main' }, [...pages].map(([id, view]) => h('div', {
        key: id,
        style: { display: id === cur ? 'contents' : 'none' },
      }, [view.el])));
    }

    shell.setMain(mainTree);

    show(TAB_DEFS[0].id);

    return () => {
      offLang();
      for (const view of pages.values()) view.unmount();
      shell.destroy();
    };
  });
});
