/**
 * core/tunnels.js —— SSH 端口转发（隧道）接口封装
 * 要点：声明 local/remote/dynamic 三种隧道类型并校验参数，统一通过宿主 sys 接口启动、查询和停止隧道。
 */
import { sysCall, sysGet } from './sys.js';
import { t, tf } from './i18n.js';

/** 隧道类型元数据：名称、说明文案键与是否需要目标地址 */
export const TUNNEL_TYPES = {
  local: {
    labelKey: 'app.core.tunnel-local',
    descKey: 'app.core.tunnel-local-hint',
    needsTarget: true,
  },
  remote: {
    labelKey: 'app.core.tunnel-remote',
    descKey: 'app.core.tunnel-remote-hint',
    needsTarget: true,
  },
  dynamic: {
    labelKey: 'app.core.tunnel-dynamic',
    descKey: 'app.core.tunnel-dynamic-hint',
    needsTarget: false,
  },
};

/** 取隧道类型的中文名称（已本地化） */
export function tunnelTypeLabel(type) {
  const def = TUNNEL_TYPES[type];
  return def ? t(def.labelKey) : type;
}

/** 取隧道类型的说明文案 */
export function tunnelTypeDesc(type) {
  const def = TUNNEL_TYPES[type];
  return def ? t(def.descKey) : '';
}

function invalid(msg) {
  const e = new Error(msg);
  e.appApiCode = 'invalid_args';
  return e;
}

function normalize({ hostId, type, bind, port, target }) {
  if (!hostId) throw invalid(t('app.core.need-host'));
  if (!Object.prototype.hasOwnProperty.call(TUNNEL_TYPES, type)) {
    throw invalid('type must be local|remote|dynamic');
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw invalid(t('app.core.bad-port'));
  const b = (bind || '127.0.0.1').trim();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(b)) {
    throw invalid(t('app.core.bad-bind'));
  }
  const opts = { hostId: String(hostId), type, bind: b, port: p, target: '' };
  if (TUNNEL_TYPES[type].needsTarget) {
    const tgt = String(target || '').trim();
    if (!tgt) throw invalid('target is required');
    const m = /^(\[[0-9a-fA-F:.]+\]|[^\s:]+):(\d{1,5})$/.exec(tgt);
    if (!m) throw invalid(t('app.core.target-shape'));
    const tp = Number(m[2]);
    if (tp < 1 || tp > 65535) throw invalid(t('app.core.target-port-range'));
    opts.target = tgt;
  }
  return opts;
}

/** 校验参数并启动一条隧道，返回隧道记录 */
export async function startTunnel(opts) {
  const r = await sysCall('tunnel/start', normalize(opts));
  if (!r || !r.id) throw new Error(t('app.core.no-entry'));
  return r;
}

/** 提前预热到主机的连接，失败时静默返回 */
export function preconnectHost(hostId) {
  const id = String(hostId || '');
  if (!id) return Promise.resolve({ ok: false });
  return sysCall('hosts/preconnect', { hostId: id }).catch(() => ({ ok: false }));
}

/** 列出当前所有活动隧道 */
export async function listTunnels() {
  const r = await sysGet('tunnel/list');
  return { tunnels: (r && Array.isArray(r.tunnels)) ? r.tunnels : [] };
}

/** 按 id 停止隧道 */
export async function stopTunnel(id) {
  const key = String(id || '');
  if (!key) throw invalid(t('app.core.missing-id'));
  return sysCall('tunnel/stop', { id: key });
}
