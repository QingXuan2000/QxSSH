/**
 * qxssh-sdk.js —— QxSSH 应用侧统一 SDK 入口（qx 命名空间）
 * 要点：把宿主桥接、国际化、命令工具箱、代码编辑器与图表等能力汇总成 qx 对象，应用既可具名导入也可直接用 qx。
 */
import {
  getContext, onInit, getHostInfo, hostDialog, writeClipboard,
  getWorkspaceInfo, notify, listWindows, setWindowBadge, openSettings, setTitleAccent,
  setTitle, closeSelf, openApp, hostToast, setTheme, applyWallpaper, applyTaskbar,
  windowClass, windowFlash, windowControl, getWindowRect, setWindowRect,
  pickPath, listApps, notifyAppsChanged, requestAppPermission, notifyPermChanged, notifySessionRevoked,
  setGlass, applyStoredTheme, applyStoredGlass,
  provideApi, revokeApi, callAppApi, callAppApis, listAppApis, onAppApiChange, APP_API_ERR,
  publishEvent, onEvent, onWindowState, reloadApp,
  appBoot, bootApp, bootAppNoInit, onThemeChange,
  onSessionChange, onPermChange, focusWindow, openExternal, reportAppError,
} from './app-bridge.js';

import {
  setupI18n, t, tf, lang, setLang, negotiateLang, listLangs, onLangChange,
  LANGUAGES, DEFAULT_LANG,
} from './core/i18n.js';
import { setupAppI18n, i18nSelect, i18nButton, i18nMenu, withI18n } from './core/i18n-ui.js';
import { openPopper } from './core/components.js';
import {
  sh, run, runJSON, runLines, runTable, parseTable, stream, which, fetchVia, tcpConnect,
  ensureSudo, ShellError, runMany, startJob, jobHandle, followJob, jobs,
  batchExec, batchUpload, auditStats, exportAuditLogs,
  diskUsage, memoryUsage, cpuInfo, osRelease, systemUptime,
  psList, killProcess,
  listeningPorts, pingHost,
  remoteFileExists, remoteReadText, remoteWriteText, remoteReadJSON, remoteWriteJSON, remoteEnsureDir,
  serviceStatus, serviceAction,
  remoteEnv, remoteUser,
  netInterfaces, routeTable, testPort, dnsResolve,
  journalTail, dmesgTail,
  pkgDetect, pkgInstalled,
  gitStatus, gitLog,
  fileChecksum, archiveExtract, archiveCreate,
  crontabList,
} from './core/appkit.js';
import { collectMetrics, collectHostInfo } from './core/hostprobe.js';
import {
  CodeEditor, codeField, highlightCode, highlightHTML, tokenize, languages, languageForFile, isTextFile,
  registerLanguage, canonicalLanguage, TOKEN_TYPES,
} from './core/code-editor.js';
import {
  languageShader, timingShader, composeShaders, fieldShader,
  defineJsonShader, getJsonShader, listJsonShaders,
} from './core/json-shader.js';
import { VirtualList, scrollToRow } from './core/virtual-list.js';
import { LineChart, timeSeries, loadChartLib } from './core/charts.js';
import {
  auditLogs, auditNote,
} from './core/qxssh-api.js';

/** 转出各模块的公共接口，应用可直接按名导入 */
export {
  getContext, onInit, getHostInfo, hostDialog, writeClipboard,
  getWorkspaceInfo, notify, listWindows, setWindowBadge, openSettings, setTitleAccent,
  setTitle, closeSelf, openApp, hostToast, setTheme, applyWallpaper, applyTaskbar,
  windowClass, windowFlash, windowControl, getWindowRect, setWindowRect,
  pickPath, listApps, notifyAppsChanged, requestAppPermission, notifyPermChanged, notifySessionRevoked,
  setGlass, applyStoredTheme, applyStoredGlass,
  provideApi, revokeApi, callAppApi, callAppApis, listAppApis, onAppApiChange, APP_API_ERR,
  publishEvent, onEvent, onWindowState, reloadApp,
  appBoot, bootApp, bootAppNoInit, onThemeChange,
  onSessionChange, onPermChange, focusWindow, openExternal, reportAppError,
  setupI18n, t, tf, lang, setLang, negotiateLang, listLangs, onLangChange,
  LANGUAGES, DEFAULT_LANG,
  setupAppI18n, i18nSelect, i18nButton, i18nMenu, withI18n, openPopper,
  sh, run, runJSON, runLines, runTable, parseTable, stream, which, fetchVia, tcpConnect,
  ensureSudo, ShellError, runMany, startJob, jobHandle, followJob, jobs, collectMetrics, collectHostInfo,
  CodeEditor, codeField, highlightCode, highlightHTML, tokenize, languages, languageForFile, isTextFile,
  registerLanguage, canonicalLanguage, TOKEN_TYPES,
  languageShader, timingShader, composeShaders, fieldShader,
  defineJsonShader, getJsonShader, listJsonShaders,
  VirtualList, scrollToRow, LineChart, timeSeries, loadChartLib,
  batchExec, batchUpload,
  auditStats, exportAuditLogs, auditLogs, auditNote,
  diskUsage, memoryUsage, cpuInfo, osRelease, systemUptime,
  psList, killProcess,
  listeningPorts, pingHost,
  remoteFileExists, remoteReadText, remoteWriteText, remoteReadJSON, remoteWriteJSON, remoteEnsureDir,
  serviceStatus, serviceAction,
  remoteEnv, remoteUser,
  netInterfaces, routeTable, testPort, dnsResolve,
  journalTail, dmesgTail,
  pkgDetect, pkgInstalled,
  gitStatus, gitLog,
  fileChecksum, archiveExtract, archiveCreate,
  crontabList,
};

/** 汇总全部公共能力的命名空间对象 */
export const qx = {
  getContext,
  onInit,
  getHostInfo,
  hostDialog,
  writeClipboard,
  getWorkspaceInfo,
  notify,
  listWindows,
  setWindowBadge,
  openSettings,
  setTitleAccent,
  setTitle,
  closeSelf,
  openApp,
  hostToast,
  setTheme,
  applyWallpaper,
  applyTaskbar,
  windowClass,
  windowFlash,
  windowControl,
  getWindowRect,
  setWindowRect,
  pickPath,
  requestAppPermission,
  notifyPermChanged,
  notifySessionRevoked,
  onSessionChange,
  onPermChange,
  focusWindow,
  openExternal,
  reportAppError,
  setGlass,
  applyStoredTheme,
  applyStoredGlass,
  listApps,
  notifyAppsChanged,
  provideApi,
  revokeApi,
  callAppApi,
  callAppApis,
  listAppApis,
  onAppApiChange,
  APP_API_ERR,
  publishEvent,
  onEvent,
  onWindowState,
  reloadApp,
  appBoot,
  bootApp,
  bootAppNoInit,

  setupI18n,
  t,
  tf,
  lang,
  setLang,
  negotiateLang,
  listLangs,
  onLangChange,
  LANGUAGES,
  DEFAULT_LANG,
  setupAppI18n,
  i18nSelect,
  i18nButton,
  i18nMenu,
  openPopper,
  withI18n,

  CodeEditor,
  codeField,
  highlightCode,
  highlightHTML,
  tokenize,
  languages,
  languageForFile,
  isTextFile,
  registerLanguage,
  canonicalLanguage,
  TOKEN_TYPES,

  languageShader,
  timingShader,
  composeShaders,
  fieldShader,
  defineJsonShader,
  getJsonShader,
  listJsonShaders,

  VirtualList,
  scrollToRow,
  LineChart,
  timeSeries,
  loadChartLib,

  kit: {
    sh, run, runJSON, runLines, runTable, parseTable, stream, which, fetchVia, tcpConnect,
    ensureSudo, ShellError, runMany, startJob, jobHandle, followJob, jobs, collectMetrics, collectHostInfo,
    diskUsage, memoryUsage, cpuInfo, osRelease, systemUptime,
    psList, killProcess,
    listeningPorts, pingHost,
    remoteFileExists, remoteReadText, remoteWriteText, remoteReadJSON, remoteWriteJSON, remoteEnsureDir,
    serviceStatus, serviceAction,
    remoteEnv, remoteUser,
    netInterfaces, routeTable, testPort, dnsResolve,
    journalTail, dmesgTail,
    pkgDetect, pkgInstalled,
    gitStatus, gitLog,
    fileChecksum, archiveExtract, archiveCreate,
    crontabList,
  },

  diskUsage,
  memoryUsage,
  cpuInfo,
  osRelease,
  systemUptime,
  psList,
  killProcess,
  listeningPorts,
  pingHost,
  remoteFileExists,
  remoteReadText,
  remoteWriteText,
  remoteReadJSON,
  remoteWriteJSON,
  remoteEnsureDir,
  serviceStatus,
  serviceAction,
  remoteEnv,
  remoteUser,
  netInterfaces,
  routeTable,
  testPort,
  dnsResolve,
  journalTail,
  dmesgTail,
  pkgDetect,
  pkgInstalled,
  gitStatus,
  gitLog,
  fileChecksum,
  archiveExtract,
  archiveCreate,
  crontabList,

  sys: {
    diskUsage,
    memoryUsage,
    cpuInfo,
    osRelease,
    uptime: systemUptime,
    metrics: collectMetrics,
    hostInfo: collectHostInfo,
  },

  proc: {
    list: psList,
    kill: killProcess,
  },

  net: {
    ports: listeningPorts,
    ping: pingHost,
    interfaces: netInterfaces,
    routes: routeTable,
    testPort,
    resolve: dnsResolve,
    fetchVia,
    tcpConnect,
  },

  fs: {
    exists: remoteFileExists,
    readText: remoteReadText,
    writeText: remoteWriteText,
    readJSON: remoteReadJSON,
    writeJSON: remoteWriteJSON,
    ensureDir: remoteEnsureDir,
    checksum: fileChecksum,
    extract: archiveExtract,
    compress: archiveCreate,
  },

  service: {
    status: serviceStatus,
    action: serviceAction,
    start: (h, n) => serviceAction(h, n, 'start'),
    stop: (h, n) => serviceAction(h, n, 'stop'),
    restart: (h, n) => serviceAction(h, n, 'restart'),
  },

  env: {
    get: remoteEnv,
    user: remoteUser,
  },

  journal: {
    tail: journalTail,
    dmesg: dmesgTail,
  },

  pkg: {
    detect: pkgDetect,
    installed: pkgInstalled,
  },

  git: {
    status: gitStatus,
    log: gitLog,
  },

  crontab: {
    list: crontabList,
  },

  batchExec,
  batchUpload,
  auditStats,
  exportAuditLogs,
  auditLogs,
  auditNote,

  batch: {
    exec: batchExec,
    upload: batchUpload,
  },

  audit: {
    stats: auditStats,
    export: exportAuditLogs,
    logs: auditLogs,
    note: auditNote,
  },

  async ready() {
    return new Promise((resolve) => onInit(resolve));
  },

  async context() {
    return getContext();
  },

  async host() {
    return getHostInfo();
  },

  async workspace() {
    return getWorkspaceInfo();
  },

  async alert(title, desc = '') {
    return hostDialog({ kind: 'alert', title, desc });
  },

  async confirm(title, desc = '', opts = {}) {
    const r = await hostDialog({ kind: 'confirm', title, desc, ...opts });
    return r.ok === true;
  },

  async prompt(title, desc = '', opts = {}) {
    const r = await hostDialog({ kind: 'prompt', title, desc, ...opts });
    return r.ok ? r.value : null;
  },

  async copy(text) {
    return writeClipboard(text);
  },
};

/** 默认导出 qx 命名空间 */
export default qx;
