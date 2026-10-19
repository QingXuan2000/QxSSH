/**
 * core/wallpapers.js —— 壁纸与纹理资源清单
 * 要点：合并内置资源与用户目录中的图片，负责文件名清洗、重名处理以及用户壁纸的上传与删除。
 */
import { localHostInfo, localFsList, localFsMkdir, localFsWrite, localFsDelete, localFsReadUrl } from './qxssh-api.js';
import { t, tf } from './i18n.js';

const INDEX_URL = '/assets/images/background/index.json';
const BUILTIN_BASE = '/assets/images/background';
const TEXTURE_BASE = '/assets/images/background/texture';
const USER_DIR = 'wallpapers';

const EXTS = new Set(['.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif', '.bmp']);
const MAX_BYTES = 25 << 20;
const MAX_NAME_BYTES = 80;

let builtinP = null;
let hostP = null;

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i >= 0 ? String(name).slice(i).toLowerCase() : '';
}

function suggestTheme(name) {
  const low = String(name).toLowerCase();
  if (low.includes('dark')) return 'dark';
  if (low.includes('light')) return 'light';
  return 'any';
}

function hostFacts() {
  if (!hostP) {
    hostP = localHostInfo().then((f) => ({
      configDir: String((f && f.configDir) || '').replace(/[/\\]+$/, ''),
      sep: (f && f.pathSep) || ((f && f.goos) === 'windows' ? '\\' : '/'),
    })).catch((e) => { hostP = null; throw e; });
  }
  return hostP;
}

/** 取用户壁纸目录的绝对路径 */
export async function wallpaperUserDir() {
  const { configDir, sep } = await hostFacts();
  return `${configDir}${sep}${USER_DIR}`;
}

async function builtinIndex() {
  if (!builtinP) {
    builtinP = fetch(INDEX_URL, { cache: 'no-cache' }).then(async (res) => {
      if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
      const d = await res.json();
      return { wallpapers: Array.isArray(d.wallpapers) ? d.wallpapers : [], textures: Array.isArray(d.textures) ? d.textures : [] };
    }).catch((e) => { builtinP = null; throw e; });
  }
  return builtinP;
}

/** 汇总内置壁纸、用户壁纸与纹理清单 */
export async function fetchWallpapers() {
  const idx = await builtinIndex();
  const items = idx.wallpapers.map((w) => ({
    url: `${BUILTIN_BASE}/${w.theme}/${encodeURIComponent(w.name)}`,
    name: w.name,
    theme: w.theme,
    builtin: true,
  }));
  let dir = '';
  try {
    dir = await wallpaperUserDir();
    const r = await localFsList(dir);
    for (const e of (r && r.entries) || []) {
      if (!e || e.isDir || !EXTS.has(extOf(e.name))) continue;
      const { sep } = await hostFacts();
      items.push({ url: localFsReadUrl(`${dir}${sep}${e.name}`), name: e.name, theme: suggestTheme(e.name), builtin: false });
    }
  } catch { }
  items.sort((a, b) => (a.theme !== b.theme ? (a.theme < b.theme ? -1 : 1) : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const textures = idx.textures
    .filter((t) => t && t.file && t.w > 0 && t.h > 0)
    .map((t) => ({ name: t.name, url: `${TEXTURE_BASE}/${encodeURIComponent(t.file)}`, w: t.w, h: t.h }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { wallpapers: items, textures, dir };
}

/** 把上传文件名清洗为安全且长度受限的文件名 */
export function safeWallpaperName(raw) {
  const base = String(raw || '').replace(/\\/g, '/').split('/').pop() || '';
  let out = '';
  for (const ch of base) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) continue;
    out += '<>:"/\\|?*'.includes(ch) ? '_' : ch;
  }
  out = out.trim();
  if (out === '.' || out === '..') return '';
  const ext = extOf(base);
  const enc = new TextEncoder();
  const limit = Math.max(1, MAX_NAME_BYTES - enc.encode(ext).length);
  if (enc.encode(out).length > limit) {
    let stem = out;
    while (stem && enc.encode(stem).length > limit) stem = stem.slice(0, -1);
    out = stem.trim() + ext;
  }
  return out;
}

async function uniqueName(dir, base) {
  let taken = new Set();
  try {
    const r = await localFsList(dir);
    taken = new Set(((r && r.entries) || []).map((e) => e.name));
  } catch { }
  if (!taken.has(base)) return base;
  const ext = extOf(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; ; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!taken.has(cand)) return cand;
  }
}

/** 校验并保存用户壁纸到用户目录，返回新的壁纸条目 */
export async function uploadWallpaper(file) {
  if (!file) throw new Error(t('core.wallpaper.no-file'));
  const name = safeWallpaperName(file.name);
  if (!name) throw new Error(t('core.wallpaper.bad-name'));
  if (!EXTS.has(extOf(name))) throw new Error(t('core.wallpaper.bad-ext'));
  if (file.size > MAX_BYTES) throw new Error(tf('core.wallpaper.too-large', { v1: MAX_BYTES >> 20 }));
  const dir = await wallpaperUserDir();
  const { sep } = await hostFacts();
  try { await localFsMkdir(dir); } catch { }
  const final = await uniqueName(dir, name);
  const path = `${dir}${sep}${final}`;
  await localFsWrite(path, file);
  return { wallpaper: { url: localFsReadUrl(path), name: final, theme: suggestTheme(final), builtin: false } };
}

/** 删除用户目录中的壁纸文件 */
export async function deleteWallpaper(name) {
  const n = String(name || '');
  if (!n || n === '.' || n === '..' || /[/\\]/.test(n) || !EXTS.has(extOf(n))) throw new Error(t('core.wallpaper.bad-name'));
  const dir = await wallpaperUserDir();
  const { sep } = await hostFacts();
  await localFsDelete(`${dir}${sep}${n}`);
  return { ok: true };
}
