import { detectBrowsers, launchBrowser as launch, prepare, resetBrowsers } from './browser-core.js';
import { t } from '/assets/js/core/i18n.js';

export function prepareBrowsers(info) {
  return prepare(info);
}

export function listBrowsers() {
  return detectBrowsers();
}

/** 丢掉检测缓存，下一次 listBrowsers 会重新扫一遍本机浏览器 */
export function resetBrowserCache() {
  resetBrowsers();
}

export function launchBrowser(url, browser, proxy) {
  return launch({ url, path: browser, proxy });
}

export function browserErrorText(code, raw) {
  if (code === 'no-browser') return t('app.browser.no-browser-found');
  if (code === 'not-in-list') return t('app.browser.not-in-list');
  if (code === 'proxy-required') return t('app.browser.proxy-required');
  return raw || '';
}
