import { detectBrowsers, launchBrowser as launch, prepare } from './browser-core.js';
import { t } from '/assets/js/core/i18n.js';

export function prepareBrowsers(info) {
  return prepare(info);
}

export function listBrowsers() {
  return detectBrowsers();
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
