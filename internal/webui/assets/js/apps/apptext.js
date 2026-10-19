/**
 * apps/apptext.js —— 应用元信息的本地化取值
 * 要点：按应用自身语言或系统语言，优先取宿主词表、回退应用自带文案，产出显示名、描述与分类。
 */
import {
  t, lang, DEFAULT_LANG, savedLang, hostTerms, prefetchHostLang,
} from '../core/i18n.js';
import { pickTerm } from '../core/terms.js';

function normalizeTag(tag) {
  return String(tag || '').trim().replace(/_/g, '-').toLowerCase();
}

function primaryTag(tag) {
  const i = tag.indexOf('-');
  return i < 0 ? tag : tag.slice(0, i);
}

function scriptTag(tag) {
  const p = tag.split('-');
  return p.length >= 2 && p[1].length === 4 ? p[1] : '';
}

function pickLocalized(byLang, want) {
  const keys = Object.keys(byLang).sort();
  const hit = (n) => byLang[keys[n]];
  const text = (k) => (byLang[k] == null ? '' : String(byLang[k]));
  const tiers = [
    () => keys.findIndex((k) => normalizeTag(k) === want),
    () => keys.findIndex((k) => primaryTag(normalizeTag(k)) === primaryTag(want)
      && scriptTag(normalizeTag(k)) === scriptTag(want)),
    () => keys.findIndex((k) => primaryTag(normalizeTag(k)) === primaryTag(want)),
    () => keys.findIndex((k) => normalizeTag(k) === normalizeTag(DEFAULT_LANG)),
  ];
  for (const tier of tiers) {
    const i = tier();
    if (i >= 0 && text(keys[i]) !== '') return text(keys[i]);
  }
  return keys.map(text).find((s) => s !== '') || '';
}

function ownText(raw, langCode) {
  if (raw == null) return '';
  if (typeof raw !== 'object') return String(raw);
  return pickLocalized(raw, normalizeTag(langCode));
}

/** 判定该应用应使用的语言代码（应用内设定优先，其次系统语言） */
export function appLangCode(app) {
  const own = savedLang(app && app.id);
  if (own) return own;
  const sys = lang();
  const list = app && Array.isArray(app.languages) ? app.languages : null;
  if (list && list.length && !list.includes(sys)) return list[0];
  return sys;
}

function hostTerm(key, code) {
  if (!key) return undefined;
  if (code === lang()) return t(key);
  prefetchHostLang(code);
  const table = hostTerms(code);
  return table ? table[key] : undefined;
}

/** 取应用显示名（宿主词表优先，回退应用自带名称） */
export function appName(app) {
  if (!app) return '';
  const code = appLangCode(app);
  const own = ownText(app.name, code) || app.id || '';
  const v = hostTerm(app.nameKey, code);
  return typeof v === 'string' && v && v !== app.nameKey ? v : own;
}

/** 取应用描述文案 */
export function appDesc(app) {
  if (!app) return '';
  const code = appLangCode(app);
  const own = ownText(app.description, code);
  const v = hostTerm(app.descriptionKey, code);
  return typeof v === 'string' && v && v !== app.descriptionKey ? v : own;
}

/** 取应用的分类键 */
export function appCategoryKey(app) {
  if (!app) return '';
  return app.categoryKey || ownText(app.category, DEFAULT_LANG);
}

/** 取应用分类的本地化名称 */
export function appCategory(app) {
  return categoryName(appCategoryKey(app));
}

/** 把分类键翻译为显示名，未命中时原样返回 */
export function categoryName(key) {
  const k = String(key || '');
  if (!k) return t('core.category-other');
  return pickTerm(k, k);
}
