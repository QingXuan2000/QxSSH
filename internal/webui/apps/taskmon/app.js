import { bootApp, setTitle } from '/assets/js/app-bridge.js';
import { hostId, layout, loadLayout, startPolling } from './state.js';
import { createShell } from './shell.js';
import { buildWorksheet } from './worksheet.js';
import { buildProcPage } from './procview.js';
import { buildAppsPage } from './appsview.js';
import { t, tf, setupI18n } from '/assets/js/core/i18n.js';

function boot(el, ctx) {
  hostId.next = ctx.hostId;
  layout.next = loadLayout();

  const shell = createShell(el, {
    initial: ctx.page,
    builders: {
      overview: () => buildWorksheet('overview'),
      processes: () => buildProcPage(),
      apps: () => buildAppsPage(),
    },
  });
  const stopPolling = startPolling();

  return () => {
    stopPolling();
    shell.destroy();
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'taskmon',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId, params }) => {
    setTitle(t('app.taskmon.title'));
    return boot(root, { hostId, page: params.page || undefined });
  });
});
