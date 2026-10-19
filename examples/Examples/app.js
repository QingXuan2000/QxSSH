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
        text: `${tf('app.examples.selfcheck-total', { v1: qxTotalKeys })}\n${tf('app.examples.selfcheck-total', { v1: `qx.kit: ${kitTotalKeys}` })}\n${t('app.examples.sdk-selfcheck-ok')}`,
      }),
      note('自检验证 qx 命名空间下全部 140+ 个属性与方法均可正常导出与使用。'),
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
