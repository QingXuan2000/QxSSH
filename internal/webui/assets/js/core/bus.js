/**
 * core/bus.js —— 全局事件总线（发布/订阅）
 * 要点：为各模块提供解耦通信；emit 逐个调用订阅者并捕获异常，单个订阅者出错不影响其他订阅者。
 */
const listeners = new Map();

/** 订阅事件，返回取消订阅的函数 */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => off(event, fn);
}

/** 取消某个事件上的订阅 */
export function off(event, fn) {
  listeners.get(event)?.delete(fn);
}

/** 向某事件的所有订阅者广播数据 */
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (err) { console.error(`[bus] ${event} handler error`, err); }
  }
}
