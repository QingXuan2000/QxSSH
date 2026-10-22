/**
 * icons/custom.js —— 自绘图标路径表
 * 要点：存放 lucide 之外的 svg 图标内容（如终端提示符与分屏符号），由 icons/index.js 统一取出。
 */
/** 自定义图标名到 svg 内容的映射 */
export const CUSTOM_PATHS = {

  'terminal-prompt': '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',

  'split-v': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  'split-h': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
};
