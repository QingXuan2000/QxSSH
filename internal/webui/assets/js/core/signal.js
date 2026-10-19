/**
 * core/signal.js —— 细粒度响应式原语
 * 要点：为 vdom 及界面状态提供读写自动收集依赖的信号、副作用与派生值，并支持批量提交以减少重跑。
 */
let activeEffect = null;

const running = new Set();

class Effect {
  constructor(fn) {
    this.fn = fn;
    this.deps = new Set();
    this.active = true;
  }

  run() {
    if (!this.active) return undefined;
    if (running.has(this)) {
      console.warn('[signal] effect 在运行中写到了它依赖的 signal，已跳过本轮重跑（会自激）');
      return undefined;
    }
    cleanup(this);
    const prev = activeEffect;
    activeEffect = this;
    running.add(this);
    try {
      return this.fn();
    } finally {
      activeEffect = prev;
      running.delete(this);
    }
  }

  stop() {
    cleanup(this);
    this.active = false;
  }
}

function cleanup(e) {
  for (const dep of e.deps) dep.delete(e);
  e.deps.clear();
}

/** 创建响应式值：读取时收集依赖，写入 .next 时通知订阅者 */
export function signal(initial) {
  let value = initial;
  const subs = new Set();
  const sig = {
    get value() {
      if (activeEffect) {
        subs.add(activeEffect);
        activeEffect.deps.add(subs);
      }
      return value;
    },
    set next(v) {
      if (Object.is(v, value)) return;
      value = v;
      for (const s of [...subs]) {
        try {
          if (typeof s === 'function') s(value);
          else if (batchQueue) batchQueue.add(s);
          else s.run();
        } catch (err) {
          console.error('[signal] subscriber error', err);
        }
      }
    },
    peek() { return value; },
    subscribe(fn) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
  };
  return sig;
}

/** 创建副作用：立即执行一次，依赖变化后自动重跑 */
export function effect(fn) {
  const e = new Effect(fn);
  e.run();
  return { run: () => e.run(), stop: () => e.stop() };
}

/** 在不收集依赖的前提下执行函数 */
export function untrack(fn) {
  const prev = activeEffect;
  activeEffect = null;
  try {
    return fn();
  } finally {
    activeEffect = prev;
  }
}

/** 由若干信号派生出新信号，源信号变化时自动重算 */
export function computed(fn, deps) {
  const out = signal(fn());
  for (const dep of deps) dep.subscribe(() => { out.next = untrack(fn); });
  return out;
}

/** 批量修改多个信号，结束后统一触发一次副作用 */
export function batch(fn) {
  const queued = new Set();
  const prev = batchQueue;
  batchQueue = queued;
  try {
    fn();
  } finally {
    batchQueue = prev;
  }
  for (const e of queued) e.run();
}

let batchQueue = null;
