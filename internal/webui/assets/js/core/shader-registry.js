/**
 * core/shader-registry.js —— 着色器注册表
 *
 * 要点：只放一个 Map 和三存取函数，不 import 任何模块。
 * 这样 components.js（JsonViewer）与 json-shader.js（具体着色器实现）都能引用它，
 * 而不会形成 components → json-shader → code-editor → components 的循环依赖。
 */

/** 着色器名 → 函数 */
const registry = new Map();

/**
 * 注册具名着色器
 * @param {string} name 名称，配置里用字符串引用
 * @param {(text: string, ctx: object) => object[] | null} fn
 * @returns {string} 归一化后的名称
 */
export function defineJsonShader(name, fn) {
  const key = String(name || '').trim();
  if (!key) throw new Error('defineJsonShader: name is required');
  if (typeof fn !== 'function') throw new Error('defineJsonShader: shader must be a function');
  registry.set(key, fn);
  return key;
}

/**
 * 按名取着色器
 * @param {string} name
 * @returns {Function | null} 未注册返回 null
 */
export function getJsonShader(name) {
  return registry.get(String(name || '').trim()) || null;
}

/** 列出现已注册的着色器名 */
export function listJsonShaders() {
  return [...registry.keys()].sort();
}
