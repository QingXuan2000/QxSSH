/**
 * core/store.js —— 主机与工作区全局状态容器
 * 要点：集中持有 hosts/groups/workspace；每次变更同时通过事件总线广播 store:changed 并通知订阅者。
 */
import * as api from './qxssh-api.js';
import { emit } from './bus.js';

let state = {
  hosts: [],
  groups: [],
  loaded: false,
  workspace: null,
};

const subscribers = new Set();

/** 读取当前状态快照 */
export function getState() {
  return state;
}

/** 订阅状态变化，返回取消订阅的函数 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function setState(patch) {
  state = { ...state, ...patch };
  emit('store:changed', state);
  for (const fn of subscribers) {
    try { fn(state); } catch (err) { console.error('[store] subscriber error', err); }
  }
}

/** 从后端拉取主机列表并刷新状态 */
export async function loadHosts() {
  const { hosts } = await api.listHosts();
  setState({ hosts, groups: groupsOf(hosts), loaded: true });
  return state;
}

/** 从主机列表里提取去重后的分组名 */
export function groupsOf(hosts) {
  const seen = new Set();
  const out = [];
  for (const h of hosts || []) {
    const g = (h && h.group) || 'Default';
    if (!seen.has(g)) { seen.add(g); out.push(g); }
  }
  return out;
}

/** 切换当前工作区主机并广播进入事件 */
export function setWorkspace(hostId) {
  const host = state.hosts.find((h) => h.id === hostId);
  if (!host) throw new Error(`unknown host: ${hostId}`);
  setState({ workspace: hostId });
  emit('workspace:enter', host);
  return state;
}

/** 退出工作区并广播离开事件 */
export function clearWorkspace() {
  const prev = state.workspace;
  setState({ workspace: null });
  if (prev) emit('workspace:leave', prev);
  return state;
}

/** 重新拉取主机列表 */
export function refreshHosts() {
  return loadHosts();
}
