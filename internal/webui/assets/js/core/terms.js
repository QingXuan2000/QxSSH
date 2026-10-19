/**
 * core/terms.js —— 术语取词工具
 * 要点：在词表中查 key，未命中时回退到调用方给出的兜底文案。
 */
import { t } from './i18n.js';

/** 从词表取术语：命中则返回译文，否则返回 fallback */
export function pickTerm(key, fallback) {
  const k = String(key || '');
  if (!k) return fallback;
  const v = t(k);
  return v === k ? fallback : v;
}
