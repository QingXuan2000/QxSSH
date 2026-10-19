# Examples — QxSSH App Development Sample

[中文](README.md) · English

---

`Examples` is a **living-documentation** app: it demonstrates the entire QxSSH app SDK — the component library, system API, host bridge and platform libraries — and **self-checks** at runtime that the listed items match the SDK's real exports.

It uses the **exact same** manifest format and SDK (`/assets/js/**`) as a third-party app, so it doubles as the best template to copy.

- **App ID**: `examples`
- **Entry**: `index.html`
- **Category**: Development
- **Not a built-in**: it must be loaded manually (below).

## Loading it

It is not under `internal/webui/apps/`, so it is not compiled into the binary. Pick one of:

**1. Dev-mode link (recommended; edit and refresh)**

In the App Manager choose "link a local directory", or call:

```js
import { linkApp } from '/assets/js/core/qxssh-api.js';
await linkApp('C:\\Users\\...\\QxSSH\\examples\\Examples'); // absolute path
```

**2. Package and install**

Package this directory's contents as a `.qxp` (zip format) with `manifest.json` at the **archive root**:

```powershell
# Run inside this directory
Compress-Archive -Path * -DestinationPath ..\examples.qxp -Force
```

Then install the `.qxp` in the App Manager.

**3. Drop it into the config dir**

Copy this directory to `<config dir>/apps/examples/` and restart QxSSH.

> After loading, an "Examples" icon appears on the desktop / start menu.

## File map

| File | Responsibility |
| --- | --- |
| `manifest.json` | Metadata (id, name, icon, category, entry) |
| `index.html` | Entry page linking stylesheets and `app.js` |
| `app.js` | Main entry: 4 pages (Icons, Components, System APIs, SDK), full-page real-time search and table-based usage |
| `app.css` | Sample-specific styles (`gal-*` classes, table and code styles) |
| `sysapi-groups.js` | System API endpoint groups mapped by permission nodes → `SYSAPI_GROUPS` / `SYSAPI_ITEMS` |
| `sysapi-page.js` | System API demo page: grouped by permission nodes with table-based display of endpoints, permissions, descriptions, usage code, call actions, and real-time search |
| `component-classes.js` | Component → category map → `COMPONENT_CLASS` / `COMPONENT_CLASSES` / `componentsIn` |
| `language/zh-CN.json` | App-provided Chinese dictionary |
| `language/en-US.json` | App-provided English dictionary |

## Tabs

| Tab | Contents |
| --- | --- |
| **Icons** | All built-in icons with real-time name search, pagination, and one-click copy |
| **Components** | Consolidated all 79 official components with global real-time component search and seamless category switcher |
| **System APIs** | All 92 `core/qxssh-api.js` endpoints grouped by permission nodes, table-based display of endpoints, permissions, descriptions, usage, and interactive calls, with real-time search |
| **SDK** | Unified SDK (`qx` namespace): grouped by permission nodes, table-based display of SDK methods and ops toolkit (`qx.kit`) usage, with real-time search, code playground, and full export self-check |

## How the self-check works

On startup and while rendering it compares each "manifest list" with the real exports; discrepancies are logged to the console:

- **Components**: compares the `component-classes.js` map against all core and advanced component exports (79/79 covered).
- **API**: compares the `sysapi-groups.js` endpoint list against `core/qxssh-api.js` exports (92/92 covered).
- **SDK**: self-checks completeness of exports on `qx` and `qx.kit` (100% covered).

This is both a demo feature and **a regression guard for SDK maintainers**: add or remove a component/endpoint without updating the sample, and the sample warns immediately.

## Using it as a template

1. Copy this directory as your new app's directory.
2. Edit `manifest.json`: change `id`, `name`, `icon`, `category`; remove unneeded fields (**do not** add `systemApp` / `disableable`).
3. Trim `index.html` / `app.css` / `app.js`, keeping the `bootApp` skeleton.
4. Keep `language/*.json` as needed and adjust the message keys.
5. Reference the call patterns here for each SDK capability.

See the app development section in [README.en.md](../../README.en.md#app-plugin-development-guide) or the online Wiki guides: [App-Development](https://github.com/QingXuan2000/QxSSH/wiki/App-Development) and [App-Manifest](https://github.com/QingXuan2000/QxSSH/wiki/App-Manifest).

## Notes

- **Some demos need a host selected first**: `exec`, `sftp`, `job`, `tunnel`, `net` etc. use the current workspace host (`ctx.hostId`); without one, related buttons prompt you.
- **Permissions**: the first restricted call triggers a consent prompt (the returned `need` lists missing permissions); you can decline and browse other tabs.
- **Dangerous actions**: host deletion, recursive file removal, etc. ask for confirmation — do not click freely in a real environment.
- **Demo only**: the sample really calls the API (including create/delete). Use it for testing, not on production hosts.
