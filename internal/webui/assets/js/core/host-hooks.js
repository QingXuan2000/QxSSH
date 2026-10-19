/**
 * core/host-hooks.js —— 桌面宿主能力登记表
 * 要点：桌面壳把窗口管理、打开应用等能力登记在此，应用页通过 callHostHook 调用；未登记时安全降级到 fallback。
 */
/** 允许登记的宿主钩子名单 */
export const HOST_HOOKS = Object.freeze([
  'wm',
  'openApp',
  'openAppById',
  'openApiWindow',
  'openSettingsTab',
  'workspaceHostId',
  'reloadUserApps',
]);

const hooks = Object.create(null);

/** 批量登记宿主钩子，名单外的名字直接报错 */
export function setHostHooks(partial) {
  for (const [name, fn] of Object.entries(partial || {})) {
    if (!HOST_HOOKS.includes(name)) throw new Error(`host-hooks: unknown hook "${name}"`);
    hooks[name] = fn;
  }
}

/** 取某个钩子函数，未登记时告警并返回 undefined */
export function hostHook(name) {
  const fn = hooks[name];
  if (fn === undefined) console.warn(`[host-hooks] "${name}" 未登记`);
  return fn;
}

/** 调用宿主钩子，未登记或不可调用时返回 fallback */
export function callHostHook(name, args = [], fallback = undefined) {
  const fn = hooks[name];
  if (typeof fn !== 'function') return fallback;
  return fn(...args);
}
