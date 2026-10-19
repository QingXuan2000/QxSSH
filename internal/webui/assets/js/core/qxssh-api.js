/**
 * core/qxssh-api.js —— 宿主后端接口清单
 * 要点：把各 REST/WS 端点封装成前端函数，供页面调用主机、文件、执行、应用、权限、存储等后端能力；只做请求转发，不含业务逻辑。
 */
import {
  API_BASE, errorFromResponse, sysFetch, sysGet, sysCall, sysPut, sysUrl, sysWsUrl, sysStream,
} from './sys.js';
import { notifyPermChanged } from '../app-bridge.js';
import { lang } from './i18n.js';
import { callHostHook } from './host-hooks.js';

/** 转出错误转换函数，供调用方统一处理响应错误 */
export { errorFromResponse };

/** 取宿主程序版本等基础信息 */
export function getInfo() {
  return sysGet('host/version');
}

/** 取可用语言清单 */
export function listLangs() {
  return sysGet('lang/list');
}

/** 与宿主协商界面应使用的语言 */
export function negotiateLang() {
  return sysGet('lang/negotiate');
}

/** 取本机环境信息（配置目录、路径分隔符等） */
export function localHostInfo() {
  return sysGet('local/hostinfo');
}

/** 取全部主机配置 */
export function listHosts() {
  return sysGet('hosts/list');
}

/** 新建主机 */
export function createHost(u) {
  return sysCall('hosts/create', u);
}

/** 批量导入主机 */
export function importHosts(payload) {
  return sysCall('hosts/import', payload);
}

/** 探测主机系统信息 */
export function probeHost(id) {
  return sysCall('hosts/probe', { id });
}

/** 清除已探测的主机系统信息 */
export function forgetHostOS(id) {
  return sysCall('hosts/forget-os', { id });
}

/** 更新主机配置 */
export function updateHost(id, u) {
  return sysCall('hosts/update', { ...u, id });
}

/** 删除主机 */
export function deleteHost(id) {
  return sysCall('hosts/delete', { id });
}

/** 测试主机连通性与凭据 */
export function testHost(payload) {
  return sysCall('hosts/test', payload);
}

/** 拼装终端会话的 WebSocket 地址 */
export function terminalWSUrl(hostId, cols, rows, cwd) {
  return sysWsUrl('term/session', { host: hostId, cols, rows, cwd, lang: lang() });
}

/** 列出远端目录内容 */
export function sftpList(hostId, path, elevated) {
  return sysGet('files/list', { host: hostId, path, elevated });
}

/** 新建远端目录 */
export function sftpMkdir(hostId, path, elevated) {
  return sysCall('files/mkdir', { host: hostId, path, elevated: !!elevated });
}

/** 删除远端文件或目录 */
export function sftpRemove(hostId, path, recursive = false, elevated) {
  return sysCall('files/rm', { host: hostId, path, recursive, elevated: !!elevated });
}

/** 重命名远端文件 */
export function sftpRename(hostId, from, to, elevated) {
  return sysCall('files/rename', { host: hostId, from, to, elevated: !!elevated });
}

/** 拼装远端文件下载地址 */
export function sftpDownloadUrl(hostId, path, elevated) {
  return sysUrl('files/download', { host: hostId, path, elevated });
}

/** 上传本地文件到远端目录 */
export function sftpUpload(hostId, destDir, file, elevated) {
  const fd = new FormData();
  fd.append('file', file);
  return sysFetch('POST', 'files/upload', {
    query: { host: hostId, path: destDir, elevated },
    form: fd,
  });
}

/** 复制远端文件 */
export function sftpCopy(hostId, from, to, elevated) {
  return sysCall('files/copy', { host: hostId, from, to, elevated: !!elevated });
}

/** 移动远端文件 */
export function sftpMove(hostId, from, to, elevated) {
  return sysCall('files/move', { host: hostId, from, to, elevated: !!elevated });
}

/** 查询远端路径的详细信息 */
export function sftpStat(hostId, path, elevated) {
  return sysCall('files/stat', { host: hostId, path, elevated: !!elevated });
}

/** 修改远端路径的权限、属主等属性 */
export function sftpSetAttrs(payload) {
  return sysCall('files/attrs', payload);
}

/** 提交 sudo 密码（submit 为 false 时仅探测是否需要密码） */
export function sftpSudoAuth(hostId, password = '', submit = false) {
  return sysCall('sudo/request', { host: hostId, password, submit });
}

/** 清除已缓存的 sudo 凭据，可作用于全部主机 */
export function sftpSudoForget(hostId, { all = false } = {}) {
  const query = all || !hostId ? { all: '1' } : { host: hostId };
  return sysFetch('POST', 'sudo/forget', { query });
}

/** 拼装远端文件的内联预览地址 */
export function sftpPreviewUrl(hostId, path, elevated) {
  return sysUrl('files/download', { host: hostId, path, inline: '1', elevated });
}

/** 启动到目标地址的 Web 代理 */
export function startWebProxy(hostId, target, tls = false) {
  return sysCall('webproxy/start', { hostId, target, tls });
}

/** 停止 Web 代理 */
export function stopWebProxy(id) {
  return sysCall('webproxy/stop', { id });
}

/** 拼装 TCP 转发通道的 WebSocket 地址 */
export function tcpBridgeWSUrl(hostId, addr, port) {
  return sysWsUrl('net/tcp', dquery(hostId, { addr, port }));
}

/** 通过指定主机发起 HTTP 请求 */
export function netHttpRequest(payload) {
  return sysCall('net/http', payload);
}

/** 在主机上执行命令并等待结果 */
export function execRun(payload) {
  return sysCall('exec/run', payload);
}

/** 取主机凭据（密码、密钥等） */
export function hostCredential(hostId, kind) {
  return sysCall('hosts/credential', { id: hostId, kind });
}

/** 在主机上流式执行命令 */
export function execStream(payload, streamOpts = {}) {
  return sysStream('exec/stream', { body: payload, ...streamOpts });
}

/** 查询执行任务状态 */
export function execStatus(id) {
  return sysGet('exec/status', { id });
}

/** 终止执行任务 */
export function execKill(id) {
  return sysCall('exec/kill', { id });
}

/** 拼装交互式命令会话的 WebSocket 地址 */
export function execWSUrl({ host = '', argv, cols, rows, cwd, elevated } = {}) {
  return sysWsUrl('exec/session', dquery(host, {
    argv: JSON.stringify(argv || []), cols, rows, cwd, elevated: elevated ? 1 : '',
    lang: host ? lang() : '',
  }));
}

function dquery(host, extra = {}) {
  const q = { host: host || '' };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null || v === '') continue;
    q[k] = v === true ? '1' : v;
  }
  return q;
}

/** 取已安装的用户应用列表 */
export function listUserApps() {
  return sysGet('apps/list').then((j) => (Array.isArray(j.apps) ? j.apps : []));
}

/** 校验应用包，返回校验结果 */
export function validateApp(pkg) {
  return appPkgRequest('apps/validate', pkg);
}

/** 安装应用包 */
export function installApp(pkg) {
  return appPkgRequest('apps/install', pkg);
}

/** 以目录链接方式加载正在开发的应用 */
export function linkApp(dir) {
  return sysCall('apps/link', { dir });
}

/** 卸载用户应用 */
export function uninstallApp(id) {
  return sysCall('apps/uninstall', { id });
}

/** 启用或停用用户应用 */
export function setAppEnabled(id, enabled) {
  return sysCall('apps/enabled', { id, enabled });
}

/** 拼装应用内静态文件的访问地址 */
export function appFileUrl(id, path) {
  const entry = String(path || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
  const tail = entry.split('/').map(encodeURIComponent).join('/');
  return `${API_BASE}/apps/file/${encodeURIComponent(id)}/${tail}`;
}

/** 取可申请的权限目录 */
export function permCatalog() {
  return sysGet('perm/catalog');
}

/** 取某应用已授予的权限 */
export function permGrants(appId) {
  return sysGet('perm/grants', appId ? { app: appId } : {});
}

function permWrite(target, body) {
  return sysCall(target, body).then((d) => {
    notifyPermChanged(body.app);
    return d;
  });
}

function auditHost() {
  const id = callHostHook('workspaceHostId', [], null);
  return typeof id === 'string' && id ? { host: id } : {};
}

/** 授予应用权限，并通知宿主刷新 */
export function permGrant(appId, perms, expiresAt = 0) {
  const payload = { app: appId, perms, ...auditHost() };
  if (expiresAt > 0) payload.expiresAt = expiresAt;
  return permWrite('perm/grant', payload);
}

/** 撤销应用权限 */
export function permRevoke(appId, perms) {
  return permWrite('perm/revoke', { app: appId, perms, ...auditHost() });
}

/** 清空某应用的全部权限 */
export function permClear(appId) {
  return permWrite('perm/clear', { app: appId, ...auditHost() });
}

/** 取当前应用已获授权的权限 */
export function permGranted() {
  return sysGet('perm/granted');
}

/** 取全部偏好设置 */
export function prefsAll() {
  return sysGet('prefs');
}

/** 批量写入偏好设置 */
export function prefsSet(prefs) {
  return sysPut('prefs', { prefs });
}

/** 记录一条审计备注，失败时静默忽略 */
export function auditNote(action, detail = '') {
  return sysCall('audit/note', { action, detail }).catch(() => null);
}

/** 分页查询审计日志 */
export function auditLogs(opts = {}) {
  const q = new URLSearchParams();
  q.set('host', String(opts.host || '_'));
  if (opts.app) q.set('app', opts.app);
  if (opts.page) q.set('page', '1');
  if (opts.type) q.set('type', opts.type);
  if (opts.limit) q.set('limit', String(opts.limit));
  return sysGet('logs/list?' + q.toString());
}

/** 取审计日志设置 */
export function auditSettings(host) {
  return sysGet('logs/settings?host=' + encodeURIComponent(host || '_'));
}

/** 保存审计日志设置 */
export function saveAuditSettings(patch, host) {
  return sysCall('logs/settings', { ...patch, host: host || '_' });
}

/** 开关审计详细模式 */
export function setAuditVerbose(on, host) {
  return sysCall('logs/verbose', { verbose: !!on, host: host || '_' });
}

/** 归档审计日志 */
export function archiveAuditLogs(host) {
  return sysCall('logs/archive', { host: host || '_' });
}

/** 清空审计日志 */
export function clearAuditLogs(host) {
  return sysCall('logs/clear', { host: host || '_' });
}

/** 列出应用存储目录内容 */
export function appStoreList(path = '') {
  return sysGet('storage/list', path ? { path } : {});
}

/** 读取应用存储文件，返回原始响应供自行消费 */
export function appStoreReadRaw(path) {
  return sysFetch('GET', 'storage/read', { query: { path }, raw: true });
}

/** 读取应用存储中的文本文件 */
export async function appStoreReadText(path) {
  const res = await appStoreReadRaw(path);
  return res.text();
}

/** 读取并解析应用存储中的 JSON 文件 */
export async function appStoreReadJSON(path) {
  return JSON.parse(await appStoreReadText(path));
}

/** 读取 JSON 文件，失败或不存在时返回默认值 */
export async function appStoreReadJSONOr(path, def = null) {
  try {
    const res = await sysFetch('GET', 'storage/read', { query: { path, optional: '1' }, raw: true });
    if (!res || res.status === 204 || res.status === 404) return def;
    const text = await res.text();
    if (!text) return def;
    return JSON.parse(text);
  } catch {
    return def;
  }
}

/** 拼装应用存储文件的访问地址 */
export function appStoreReadUrl(path) {
  return sysUrl('storage/read', { path });
}

/** 写入文本文件（可追加） */
export function appStoreWriteText(path, content, { append = false } = {}) {
  return sysCall('storage/write', { path, content: String(content == null ? '' : content), append });
}

/** 写入二进制数据 */
export function appStoreWriteBlob(path, blob) {
  return sysFetch('POST', 'storage/write', { query: { path }, blob });
}

/** 新建应用存储目录 */
export function appStoreMkdir(path) {
  return sysCall('storage/mkdir', { path });
}

/** 重命名应用存储中的文件或目录 */
export function appStoreRename(from, to) {
  return sysCall('storage/rename', { from, to });
}

/** 删除应用存储中的文件或目录 */
export function appStoreDelete(path) {
  return sysCall('storage/delete', { path });
}

/** 启动后台任务 */
export function jobStart(payload) {
  return sysCall('job/start', payload);
}

/** 查询后台任务状态 */
export function jobStatus(hostId, id) {
  return sysGet('job/status', { host: hostId, id });
}

/** 按偏移量增量读取任务输出 */
export function jobOutput(hostId, id, offset = 0, limit) {
  return sysGet('job/output', { host: hostId, id, offset, limit });
}

/** 结束后台任务，可指定信号 */
export function jobKill(hostId, id, signal = 'TERM') {
  return sysCall('job/kill', { host: hostId, id, signal });
}

/** 列出主机上的后台任务 */
export function jobList(hostId) {
  return sysGet('job/list', { host: hostId });
}

/** 移除任务记录 */
export function jobRemove(hostId, id) {
  return sysCall('job/remove', { host: hostId, id });
}

/** 列出定时任务 */
export function scheduleList() {
  return sysGet('schedule/list');
}

/** 新建定时任务 */
export function scheduleCreate(payload) {
  return sysCall('schedule/create', payload);
}

/** 更新定时任务 */
export function scheduleUpdate(payload) {
  return sysCall('schedule/update', payload);
}

/** 删除定时任务 */
export function scheduleDelete(id) {
  return sysCall('schedule/delete', { id });
}

/** 立即执行一次定时任务 */
export function scheduleRun(id) {
  return sysCall('schedule/run', { id });
}

/** 读取密钥 */
export function secretGet(key) {
  return sysGet('secret/get', { key });
}

/** 写入密钥 */
export function secretSet(key, value) {
  return sysCall('secret/set', { key, value });
}

/** 删除密钥 */
export function secretDelete(key) {
  return sysCall('secret/delete', { key });
}

/** 列出已保存的密钥名 */
export function secretList() {
  return sysGet('secret/list');
}

/** 列出本机目录内容 */
export function localFsList(path) {
  return sysGet('localfs/list', { path });
}

/** 读取本机文件，返回原始响应 */
export function localFsReadRaw(path) {
  return sysFetch('GET', 'localfs/read', { query: { path }, raw: true });
}

/** 拼装本机文件的访问地址 */
export function localFsReadUrl(path) {
  return sysUrl('localfs/read', { path });
}

/** 写入本机文件 */
export function localFsWrite(path, body) {
  return sysFetch('POST', 'localfs/write', { query: { path }, blob: body });
}

/** 新建本机目录 */
export function localFsMkdir(path) {
  return sysCall('localfs/mkdir', { path });
}

/** 重命名本机文件 */
export function localFsRename(from, to) {
  return sysCall('localfs/rename', { path: from, to });
}

/** 删除本机文件 */
export function localFsDelete(path) {
  return sysCall('localfs/delete', { path });
}

function appPkgRequest(target, pkg) {
  if (pkg instanceof File || pkg instanceof Blob) {
    const fd = new FormData();
    fd.append('file', pkg, pkg.name || 'app.qxp');
    return sysFetch('POST', target, { form: fd });
  }
  return sysCall(target, { url: String((pkg && pkg.url) || pkg || '') });
}



