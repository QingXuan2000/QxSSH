# QxSSH

> A self-hosted SSH management console: a desktop-style web UI, multi-host and jump-chain management, terminal / files / port forwarding / audit, and an installable app (plugin) ecosystem.

QxSSH is a single-binary, self-hosted web application written in Go. It turns any machine into a centralized portal for managing all your SSH servers: open it in your browser and you get an interactive "desktop" where host topology, multi-tab terminals, SFTP file transfers, port forwarding, dynamic SOCKS5 proxies, intranet web reverse proxies, scheduled cron jobs, and audit logs all run as independent apps on top of the desktop. All credentials are encrypted locally with AES-256-GCM, and every action is comprehensively audited.

- [中文文档](README.md)
- Online Documentation (Wiki): [https://github.com/QingXuan2000/QxSSH/wiki](https://github.com/QingXuan2000/QxSSH/wiki)
- License: [GNU General Public License v3.0 (GPL-3.0)](LICENSE)
- Zero external dependencies: Pure Go implementation (no CGO), native ES modules and embedded frontend assets (no Node.js build steps required). Running `go build` produces a standalone executable.

---

## Table of Contents

- [Key Features](#key-features)
- [Quick Start](#quick-start)
  - [Requirements](#requirements)
  - [Build and Run](#build-and-run)
  - [First Login](#first-login)
  - [CLI Flags and Environment Variables](#cli-flags-and-environment-variables)
- [Wiki Documentation Navigation](#wiki-documentation-navigation)
- [Security Model and Permission Architecture](#security-model-and-permission-architecture)
- [Architecture and Directory Layout](#architecture-and-directory-layout)
- [Detailed Core Features](#detailed-core-features)
  - [Hosts and Jump Chains](#hosts-and-jump-chains)
  - [Web Terminal and Command Execution](#web-terminal-and-command-execution)
  - [File Management (SFTP and Host Filesystem)](#file-management-sftp-and-host-filesystem)
  - [Port Forwarding and Intranet Web Proxy](#port-forwarding-and-intranet-web-proxy)
  - [sudo Escalation and Scheduled Jobs](#sudo-escalation-and-scheduled-jobs)
  - [Audit Logging Architecture](#audit-logging-architecture)
- [Built-in App Ecosystem](#built-in-app-ecosystem)
- [App (Plugin) Development Guide](#app-plugin-development-guide)
  - [App Package Format (.qxp)](#app-package-format-qxp)
  - [manifest.json Specification](#manifestjson-specification)
  - [Developing Apps with the SDK](#developing-apps-with-the-sdk)
  - [Local Development and Live Directory Linking](#local-development-and-live-directory-linking)
  - [Packaging and Publishing](#packaging-and-publishing)
  - [Sample App Template](#sample-app-template)
- [HTTP and WebSocket API Reference](#http-and-websocket-api-reference)
  - [API Design and Request Conventions](#api-design-and-request-conventions)
  - [Full Endpoint Listing](#full-endpoint-listing)
  - [15 Permission Groups and 88 Fine-Grained Scopes](#15-permission-groups-and-88-fine-grained-scopes)
- [Data and Configuration Directory](#data-and-configuration-directory)
- [Development and Building](#development-and-building)
- [Git Exclusions and Build Artifacts](#git-exclusions-and-build-artifacts)
- [License and Acknowledgments](#license-and-acknowledgments)
  - [Open Source License](#open-source-license)
  - [Third-Party Assets and Open-Source Components](#third-party-assets-and-open-source-components)

---

## Key Features

- **Host Management**: Full CRUD operations, host grouping, bulk import (natively parsing OpenSSH `~/.ssh/config`), connectivity testing, and in-depth operating system probing.
- **Multi-Hop Jump Chains**: Any host can designate a jump host, chained up to 5 levels deep; cyclic references are automatically detected and blocked.
- **Resilient SSH Connection Pool**: Concurrent dial deduplication, 30s keepalive heartbeats, automatic stale eviction, and cascading cleanup of downstream connections when a jump host drops.
- **Web Terminal**: Powered by WebSocket and xterm.js, offering multi-tabs, split-screen layouts, dynamic font/resize handling, disconnect auto-reconnection, and session state persistence.
- **Versatile Command Execution**: Supports one-shot execution, real-time chunked streaming, local commands on the QxSSH host, and detached background persistent jobs (start, query status, fetch output, kill, and cleanup).
- **SFTP File Management**: Remote directory browsing, file streaming upload/download, copy, move, rename, POSIX permission/owner modifications, and on-the-fly streaming zip archive downloads for directories.
- **Comprehensive Tunneling**: Local port forwarding (local), remote port forwarding (remote), and dynamic SOCKS5 proxies (dynamic).
- **Intranet Web Reverse Proxy**: Bridges remote internal HTTP/HTTPS web services to local `127.0.0.1` over SSH tunnels, transparently rewriting CORS headers, redirect URLs, and cookies without requiring browser proxy settings.
- **sudo Session Escalation**: Request administrator elevation per host; passwords reside only in memory (default 30-minute expiration) with manual instant wipe support.
- **Scheduled Jobs (Cron)**: Built-in 5-field cron engine executing automated tasks on designated remote hosts.
- **Deep Audit Logging**: Comprehensive tracking of every API call including caller app ID, target host, endpoint, duration, and status. In verbose mode, request headers and bodies are encrypted with AES-256-GCM at rest, with workspace-based log rotation, sanitized zip archiving, and retention-based pruning.
- **Micro-Kernel Plugin Ecosystem**: 11 built-in core system apps, support for installing third-party apps from `.qxp` packages, download links, or Git repositories, live dev-mode symlinking, and a strict zero-default fine-grained permission model.
- **Private Storage and Secrets**: Each app is provisioned with an isolated storage space and an AES-256-GCM encrypted secret key-value store.
- **Native Internationalization**: Full bilingual English and Simplified Chinese dictionaries with host/app separation and server-side `Accept-Language` negotiation.

---

## Quick Start

### Requirements

- **Go 1.27+**
- Pure Go implementation: no CGO, no Node.js build tools required.

### Build and Run

```bash
# 1. Build the executable binary
go build -o qxssh .

# 2. Run locally (default listen address: 127.0.0.1:8800)
./qxssh

# 3. Launch and automatically open the default web browser
./qxssh -open

# 4. Expose to external/LAN networks (authentication token is mandatory)
./qxssh -addr 0.0.0.0:8800 -auth-token "your-secure-token"
```

On Windows PowerShell, the compiled artifact is `qxssh.exe`:

```powershell
go build -o qxssh.exe .
.\qxssh.exe -open
```

### First Login

1. Navigate to `http://127.0.0.1:8800` in your browser to view the **Launcher Page** (`index.html`).
2. Click to add a new host: provide a name, address, SSH port, username, and authentication credentials (password or private key).
3. Click the host card to enter the **Desktop** (`desktop.html`), then double-click the **Terminal** app to launch an interactive shell.

### CLI Flags and Environment Variables

| CLI Flag | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `-addr` | `QXSSH_ADDR` | `127.0.0.1:8800` | HTTP service listen address |
| `-conf` | `QXSSH_CONF` | `qxssh` under user config directory | Root directory for configuration and data storage |
| `-open` | `QXSSH_OPEN` | `false` | Automatically launch the default browser on startup |
| `-log-level` | `QXSSH_LOG_LEVEL` | `info` | Logging filter level: `debug` / `info` / `warn` / `error` / `silent` |
| `-log-file` | `QXSSH_LOG_FILE` | Empty (console stdout only) | Log file path; set to `auto` to write to `<config-dir>/logs/qxssh.log` |
| `-auth-token` | `QXSSH_AUTH_TOKEN` | Empty (loopback only) | Global authentication token for remote access; mandatory for non-loopback addresses |

---

## Wiki Documentation Navigation

In addition to the self-contained references in this README, in-depth thematic guides and architectural notes are hosted on GitHub Wiki:

Online Wiki: [https://github.com/QingXuan2000/QxSSH/wiki](https://github.com/QingXuan2000/QxSSH/wiki)

| Category | Online Guides |
| --- | --- |
| **Getting Started** | [Getting Started](https://github.com/QingXuan2000/QxSSH/wiki/Getting-Started) · [Configuration](https://github.com/QingXuan2000/QxSSH/wiki/Configuration) · [Security](https://github.com/QingXuan2000/QxSSH/wiki/Security) |
| **Feature Guides** | [Hosts and Jumps](https://github.com/QingXuan2000/QxSSH/wiki/Hosts-and-Jumps) · [Terminal and Exec](https://github.com/QingXuan2000/QxSSH/wiki/Terminal-and-Exec) · [Files and SFTP](https://github.com/QingXuan2000/QxSSH/wiki/Files-and-SFTP) · [Tunnels and WebProxy](https://github.com/QingXuan2000/QxSSH/wiki/Tunnels-and-WebProxy) · [sudo and Schedules](https://github.com/QingXuan2000/QxSSH/wiki/Sudo-and-Schedules) · [Audit Log](https://github.com/QingXuan2000/QxSSH/wiki/Audit-Log) · [Permissions](https://github.com/QingXuan2000/QxSSH/wiki/Permissions) · [Built-in Apps](https://github.com/QingXuan2000/QxSSH/wiki/Built-in-Apps) |
| **App Development** | [App Development](https://github.com/QingXuan2000/QxSSH/wiki/App-Development) · [manifest.json Reference](https://github.com/QingXuan2000/QxSSH/wiki/App-Manifest) · [SDK: Host Bridge](https://github.com/QingXuan2000/QxSSH/wiki/SDK-Host-Bridge) · [SDK: Core API](https://github.com/QingXuan2000/QxSSH/wiki/SDK-Core-API) · [SDK: Toolkit](https://github.com/QingXuan2000/QxSSH/wiki/SDK-Toolkit) · [SDK: UI and I18n](https://github.com/QingXuan2000/QxSSH/wiki/SDK-UI-and-I18n) · [Packaging and Publishing](https://github.com/QingXuan2000/QxSSH/wiki/App-Packaging) |
| **System Reference** | [HTTP / WebSocket API](https://github.com/QingXuan2000/QxSSH/wiki/HTTP-API) · [Architecture](https://github.com/QingXuan2000/QxSSH/wiki/Architecture) · [Development](https://github.com/QingXuan2000/QxSSH/wiki/Development) · [Troubleshooting and FAQ](https://github.com/QingXuan2000/QxSSH/wiki/Troubleshooting-and-FAQ) |

---

## Security Model and Permission Architecture

Because QxSSH is capable of executing arbitrary commands, managing files, and operating credentials, it implements a defense-in-depth security perimeter:

1. **Loopback by Default with Hard Preflight Checks**:
   QxSSH listens strictly on loopback `127.0.0.1` by default. If the configured address binds to a non-loopback network interface (e.g. `0.0.0.0`) while `-auth-token` or `QXSSH_AUTH_TOKEN` is unset, the process **aborts startup immediately with an error**, preventing unauthenticated exposure of credentials and execution endpoints.
2. **Global Auth Token and Constant-Time Comparison**:
   When an auth token is active, every HTTP / WebSocket request must supply `Authorization: Bearer <token>`, a query parameter `?token=`, or the `qx_token` cookie. The backend compares tokens using `crypto/subtle.ConstantTimeCompare` to prevent timing attacks. Passing `?token=` upon initial login automatically issues an `HttpOnly`, `SameSite=Strict` cookie.
3. **Two-Tier Session Isolation (Host vs. App)**:
   Host pages (`index.html` and `desktop.html`) are injected with a one-time random Host Token generated via `crypto/rand` during server-side template rendering. Third-party apps run inside sandboxed `iframe`s and cannot access the host token. Apps must request a distinct Access Token minted by the host via `POST /api/v1/session/mint`, signed with specific, restricted scopes.
4. **Zero-Default Permission Principle**:
   The system defines 15 functional groups with 88 fine-grained scopes. By default, all scopes are set to `false` (no permission granted by default). Third-party apps must explicitly request permissions in `manifest.json` and obtain user consent upon installation or at runtime before accessing private storage, secrets, or system APIs. The host and built-in system apps hold full permissions.
5. **Static Credential Encryption (AES-256-GCM)**:
   All remote passwords, private keys, key passphrases, and app secrets are stored in SQLite encrypted using AES-256-GCM. The primary master key is generated via cryptographically secure randomness on the first boot and persisted into the database `meta` table.
6. **Trust On First Use (TOFU) Host Key Verification**:
   When connecting to a remote host for the first time, its public key fingerprint is stored in `<config-dir>/known_hosts` (standard OpenSSH format). Any subsequent fingerprint mismatch aborts the connection and alerts the user, mitigating Man-In-The-Middle (MITM) attacks.
7. **Constrained Egress and Path Sanitization**:
   Listeners for local port forwarding and dynamic SOCKS5 proxies are strictly restricted to loopback addresses (`127.0.0.1` / `::1`). All file paths undergo strict traversal checks (`..`) and normalization to stop symlink escape attempts.
8. **Security Headers and Same-Origin Enforcement**:
   The HTTP gateway injects security headers globally: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `Referrer-Policy: no-referrer`. WebSocket handshakes verify the Origin header against the host.

---

## Architecture and Directory Layout

### Codebase Directory Structure

```
QxSSH/
├── main.go                     # Entry point: flag parsing, preflight security checks, logging, graceful shutdown
├── internal/
│   ├── bootstrap/              # Runtime assembly: wires pool, tunnels, web proxies, HTTP gateway, and hooks
│   ├── config/                 # Storage layer: pure-Go SQLite, AES-256-GCM crypto, ssh_config parser
│   ├── sshpool/                # SSH pool: jump-chain traversal, keepalive, host key verification, OS probing
│   ├── tunnel/                 # Tunnel registry: local forwarding, remote forwarding, dynamic SOCKS5
│   ├── proxy/                  # Intranet web proxy registry: HTTP/HTTPS tunnel proxy and packet rewriting
│   ├── httpapi/                # HTTP & WebSocket API gateway: routing, permissions, audit logging, endpoints
│   ├── webui/                  # Embedded frontend: embed.FS HTML, desktop shell, SDK, styles, icons, apps
│   └── logging/                # Structured logging engine: level filtering, file rotation, redaction
├── examples/
│   └── Examples/               # Official reference app: living documentation, UI components, API coverage checks
└── wiki/                       # Standalone GitHub Wiki sources (online site: https://github.com/QingXuan2000/QxSSH/wiki)
```

### Core Component Topology

```
                  ┌────────────────────────────────────────────────────────┐
User Browser ────▶│  httpapi.Gateway (Routing / Permissions / Sessions / Audit)│
 (HTTP / WS)      └──────────┬──────────────┬──────────────┬───────────────┘
                             │              │              │
                      config.Store    sshpool.Pool   tunnel / proxy
                     (SQLite+Crypto)   (SSH Pool)    (Tunnels & Web Proxy)
```

- **`bootstrap`**: Assembles all underlying systems and registers event hooks (e.g. cascading teardown of port forwards and web proxies when a host connection drops).
- **`sshpool`**: The singular gateway for all remote SSH capabilities, managing jump chains, connection reuse, and invalidation.
- **`httpapi`**: Table-driven API gateway where each endpoint declares its HTTP verb, path, and required permission scope. All declarations are validated at startup.

---

## Detailed Core Features

### Hosts and Jump Chains

- Host parameters include name, group, address/hostname, SSH port, user, authentication type (password or private key), password text, private key content or path, passphrase, notes, and an associated jump host.
- Jump chains support up to 5 levels (`MaxJumpDepth = 5`); cyclic dependencies and excessive depth are detected and blocked on create/update.
- Deletion of any host acting as an active jump host for others is refused, displaying all dependent child hosts.
- Bulk import parses standard OpenSSH `~/.ssh/config` files, extracting `Host`, `HostName`, `User`, `Port`, `IdentityFile`, and `ProxyJump`.
- Remote OS probing inspects `/etc/os-release` and `uname` to detect distribution versions and render matching OS icons on the desktop.

### Web Terminal and Command Execution

- The terminal connects to the backend over WebSocket at `/api/v1/ws/term/session`, supporting PTY window resizing (cols and rows) and full terminal emulation.
- Command execution distinguishes between **remote host execution** (`exec:run`) and **local host execution** (`local:exec`). If the `host` parameter is left empty, the command runs locally on the machine hosting QxSSH.
- Detached Background Jobs: Jobs record their process PID, start time, and output files under `~/.qxssh/jobs/<job-id>` on the remote target host. Status and logs are queried via file protocols without maintaining a persistent connection, so jobs continue running even if the browser or network disconnects.

### File Management (SFTP and Host Filesystem)

- The SFTP subsystem provides file operations: directory listing, `stat` metadata lookup, chunked upload/download, recursive directory deletion, renaming, copying, moving, and POSIX permission/ownership updates (chmod / chown).
- Instant directory archive streaming: directories can be streamed and downloaded as zip archives generated on the fly.
- Host local filesystem operations (`localfs/*`) are gated behind high-risk permissions (`local:read`, `local:write`, `local:mkdir`, `local:rename`, `local:delete`) and tracked in audit logs.

### Port Forwarding and Intranet Web Proxy

- **Port Forwarding**:
  - Local Forwarding: Forwards traffic from a local port to a remote destination through the SSH tunnel.
  - Remote Forwarding: Listens on a remote port and redirects inbound traffic back to a local or target service.
  - Dynamic Forwarding (SOCKS5): Binds a standard SOCKS5 proxy on local loopback, routing traffic through the remote host with IPv4, IPv6, and domain name support.
- **Intranet Web Proxy**:
  - Allocates a random local loopback port, establishing an HTTP/HTTPS reverse proxy bridge over the SSH tunnel.
  - Automatically rewrites CORS headers, redirect `Location` headers, and `Set-Cookie` domains so internal web dashboards can be opened directly in your local browser without special proxy setups.

### sudo Escalation and Scheduled Jobs

- **sudo Elevation**: Calling `sudo/request` requests an elevated session for a host. Credentials reside only in process memory (default 30-minute lifespan) and can be cleared immediately via `sudo/forget`.
- **Scheduled Jobs (Cron)**: Standard 5-field cron expressions are evaluated by the backend scheduler to run commands periodically on targeted hosts, recording run times, statuses, and errors.

### Audit Logging Architecture

- Tracks vital fields: sequence ID, timestamp, app ID, workspace host, action type, target API endpoint, details, result status, and duration in milliseconds.
- Event types recorded: API calls, permission requests, grants, revocations, clears, session mints, session revocations, app notes, and system events.
- **Verbose Audit Mode**: In addition to standard metadata, records query parameters, HTTP headers, and request bodies (up to 64 KiB). Sensitive payloads are encrypted at rest with AES-256-GCM and readable only with the `logs:readSensitive` scope.
- **Log Management and Archival**: Logs are partitioned per host workspace with in-memory ring buffers and async disk queues. Files rotate at configurable size thresholds, produce sanitized zip archives, and apply retention policies based on age and count.

---

## Built-in App Ecosystem

QxSSH utilizes a modular micro-frontend architecture. All 11 built-in applications are implemented using the same public SDK and `manifest.json` specification as third-party extensions:

| App Name | App ID | Category | Description |
| --- | --- | --- | --- |
| **Terminal** | `terminal` | Tools | Interactive SSH terminal with multi-tab, split-screen, and auto-reconnect |
| **Files** | `files` | File | Remote SFTP file manager with upload, download, preview, and permissions |
| **Hosts** | `hosts` | System | Host and jump-chain management, OpenSSH config import, and probing |
| **Tunnels** | `tunnels` | Network | Local, remote, and dynamic SOCKS5 port forwarding management |
| **Browser** | `browser` | Network | Embedded browser for remote internal web consoles via web proxies |
| **Batch** | `batch` | Tools | Run shell commands in parallel across multiple hosts with aggregated output |
| **Task Monitor** | `taskmon` | System | Real-time CPU/memory load graphs, process trees, and elevated process termination |
| **Audit Log** | `logs` | System | Live audit log viewer, permission grant tracking, and archive downloads |
| **Settings** | `settings` | System | Desktop themes, Hero Patterns wallpaper textures, taskbar layout, and preferences |
| **App Manager** | `store` | System | Browse installed apps, install from Git repositories / download links / local `.qxp` packages, enable/disable, and uninstall |
| **Systemd Manager** | `systemd` | System | Inspect and control Linux services, sockets, and timers (requires a systemd host) |

Docker Manager is no longer bundled with the main binary. Official app repository:

```
https://github.com/QingXuan2000/QxSSH-AppStore.git
```

Each app in that repository lives in its own `apps/<app-id>` subdirectory; Docker Manager is at `apps/docker`. In App Manager → **Install from Git repository**, enter the repository URL above and set the subdirectory to `apps/docker` to clone and install directly. You can also use "Link directory" for development, or upload a packaged `.qxp`. The URL is always shown in the install panel with one-click copy / fill.

Git-repo installs run on the built-in pure-Go Git engine (`go-git`); **no system `git` CLI is required on the host running QxSSH**.

### Inter-App API Calls (RPC)

Built-in apps expose standardized RPC interfaces callable by other apps once authorized:

- `terminal.open`: Pass `{ hostId, path }` to open a terminal session directly into a working directory.
- `files.open`: Pass `{ hostId, path }` to launch the file manager at a specified path.
- `tunnels.create`: Open the modal dialog to create a new port forward.
- `browser.open`: Pass `{ url, title }` to open an internal web page inside the embedded browser.

---

## App (Plugin) Development Guide

Any web project can be packaged or linked as a native QxSSH desktop application by including a `manifest.json` file.

### App Package Format (.qxp)

- An app package is a standard **ZIP archive** with the file extension **`.qxp`**.
- **`manifest.json` must be located at the root of the archive** (not nested inside a subfolder).
- **Package Limits**:
  - Zip file size: $\le$ 50 MB.
  - File count: $\le$ 500 files.
  - Extracted size: $\le$ 100 MB.
  - `manifest.json` size: $\le$ 64 KB.
  - Relative paths must not begin with `/` or contain `..` directory traversal sequences.

### manifest.json Specification

```json
{
  "id": "my-app",
  "name": "My Extension App",
  "nameKey": "myApp.name",
  "description": "App description",
  "descriptionKey": "myApp.description",
  "category": "Tools",
  "icon": "terminal",
  "version": "1.0.0",
  "author": "YourName",
  "entry": "index.html",
  "permissions": [
    "hosts:read",
    "exec:run",
    "storage:read",
    "storage:write"
  ],
  "preferredSize": {
    "width": 800,
    "height": 600,
    "minWidth": 400,
    "minHeight": 300
  },
  "singleton": true,
  "apis": [
    {
      "name": "myApp.greet",
      "description": "Exposes a greeting service",
      "version": "1.0.0",
      "launch": "background",
      "perm": "apps:list"
    }
  ]
}
```

> [!WARNING]
> Third-party apps must not declare `systemApp: true` or `disableable: true`. These flags are reserved strictly for system built-in applications.

#### Theme-aware icons

`icon` accepts either a string or an object:

```json
{ "icon": "server-cog" }
{ "icon": { "light": "logo-light.svg", "dark": "logo-dark.svg" } }
```

- Each side is a built-in icon name or a relative file inside the package (`.svg` `.png` `.jpg` `.ico` `.gif` `.webp`); file values are checked for existence and extension when the package is installed.
- Supplying only `light` or only `dark` makes both themes use that value; identical values collapse into a single icon.
- Both icons are mounted at once and the root `.dark` class toggles which one is visible, so switching themes needs no re-render of the app list, desktop icons, or taskbar.

### Developing Apps with the SDK

The host provides a unified ES Module SDK accessible at `/assets/js/qxssh-sdk.js`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>My App</title>
  <link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
  <div id="app"></div>
  <script type="module">
    import { qx } from '/assets/js/qxssh-sdk.js';

    // 1. Window & Host lifecycle
    qx.bridge.ready();
    qx.bridge.notify('App ready', 'success');

    // 2. Call backend APIs (subject to permissions)
    const hosts = await qx.api.listHosts();
    console.log('Managed hosts:', hosts);

    // 3. Execute remote commands
    const result = await qx.kit.run('uname -a');
    console.log('Output:', result.stdout);

    // 4. Read/write app private storage
    await qx.api.storeWrite('config.json', JSON.stringify({ theme: 'dark' }));
  </script>
</body>
</html>
```

#### Core SDK Modules

- **`qx.bridge`** (`app-bridge.js`): Manages the `postMessage` RPC bridge between the app iframe and the desktop host (window control, native notifications, dialogs, clipboard, themes, wallpaper sync, permission prompts, and RPC `provideApi` / `callAppApi`).
- **`qx.api`** (`core/qxssh-api.js`): 92 typed async methods wrapping the backend HTTP and WebSocket API endpoints.
- **`qx.kit`** (`core/appkit.js`): High-level operational toolkit (`sh`, streaming commands `stream`, detached jobs `startJob`, HTTP proxy requests `fetchVia`, TCP socket bridging `tcpConnect`, etc.).
- **`qx.ui`** (`core/components.js`): 79 official UI components (buttons, forms, data tables, virtual lists, dialogs, code editors, charts, etc.).
- **`qx.i18n`** (`core/i18n.js`): Internationalization loader and reactive language switching.

### Local Development and Live Directory Linking

During development, you don't need to recompress `.qxp` packages repeatedly. You can **link a local source directory**:

1. Open the **App Manager** on the desktop and click **Link Local Directory**.
2. Enter the **absolute path** to your app source (e.g. `D:\Projects\my-app` or `/home/user/projects/my-app`).
3. The server writes a `.qx-source` file in `<config-dir>/apps/<app-id>/` pointing to your directory. Files will be served directly from your working tree. Press `F5` inside the app window to see changes immediately.

### Packaging and Publishing

When ready to distribute, create a `.qxp` package from the app directory (ensure `manifest.json` is at the root):

**Windows PowerShell**:
```powershell
Compress-Archive -Path * -DestinationPath ..\my-app.qxp -Force
```

**Linux / macOS**:
```bash
zip -r ../my-app.qxp . -x "*.git*"
```

Install the package via the desktop **App Manager** by clicking **Install App** and selecting the `.qxp` file. All permissions declared in `manifest.permissions` are granted upon installation.

### Sample App Template

A complete reference implementation is available in [`examples/Examples/`](examples/Examples/) (see its [README.en.md](examples/Examples/README.en.md)). It covers 100% of SDK functions and UI components, including live API coverage tests.

The official app repository is [`QxSSH-AppStore`](https://github.com/QingXuan2000/QxSSH-AppStore) (`https://github.com/QingXuan2000/QxSSH-AppStore.git`). It hosts Docker Manager and other official apps built on the same manifest / SDK spec; each app sits in its own `apps/<app-id>` subdirectory and installs straight from App Manager by entering the repository URL plus subdirectory — it is also the place to read real app code.

---

## HTTP and WebSocket API Reference

### API Design and Request Conventions

- **Prefix**: All business endpoints are served under `/api/v1/`.
- **Session Tokens**: Transmitted via the `X-Qx-Session: <token>` header or `?session=<token>` query parameter.
- **Strict Parsing**: JSON request bodies are parsed in strict mode (**unknown fields trigger errors**); body payload limit is 8 MiB.
- **Response Format**:
  - Success returns the result object or `{"ok": true}`.
  - Failure returns `{"error": "description", "code": "code"}`.
  - Missing permissions return HTTP 403:
    ```json
    {
      "error": "missing permission: exec:run",
      "code": "permission",
      "need": ["exec:run"]
    }
    ```

### Full Endpoint Listing

#### 1. Sessions and Public Metadata

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/session/mint` | Host Only | Mint an access token and refresh token for an app |
| `POST` | `/api/v1/session/refresh` | Host / App | Rotate tokens and exchange a refresh token for a new access token |
| `POST` | `/api/v1/session/revoke` | Host / App Self | Revoke an app session token (cross-app revocation requires `perm:manage`) |
| `GET` | `/.well-known/jwks.json` | Public | Retrieve IdP public signing key set (standard JWKS) |
| `GET` | `/api/v1/jwks` | Public | Retrieve IdP public signing key set (API path alias) |
| `GET` | `/api/v1/host/version` | Public | Get server version and runtime environment info |
| `GET` | `/api/v1/local/hostinfo` | `local:hostinfo` | Read host filesystem paths and platform architecture |
| `GET` | `/api/v1/lang/list` | Public | List available system languages |
| `GET` | `/api/v1/lang/negotiate` | Public | Perform language negotiation |

#### 2. Host Management and SSH Connections

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/hosts/list` | `hosts:read` | List managed host configurations |
| `POST` | `/api/v1/hosts/create` | `hosts:create` | Create a new host configuration |
| `POST` | `/api/v1/hosts/import` | `hosts:import` | Bulk import OpenSSH ssh_config files |
| `POST` | `/api/v1/hosts/update` | `hosts:update` | Update host connection parameters and credentials |
| `POST` | `/api/v1/hosts/delete` | `hosts:delete` | Delete a host (blocked if used as an active jump host) |
| `POST` | `/api/v1/hosts/test` | `hosts:test` | Test TCP network connectivity to a host |
| `POST` | `/api/v1/hosts/preconnect` | `hosts:preconnect` | Establish SSH preconnect to verify credentials and jump chain |
| `POST` | `/api/v1/hosts/probe` | `hosts:probe` | Probe remote OS release and hardware details |
| `POST` | `/api/v1/hosts/forget-os` | `hosts:forgetos` | Clear OS probe cache for a host |
| `POST` | `/api/v1/hosts/credential` | `hosts:credential` | Decrypt and retrieve plaintext credentials for a host |

#### 3. Terminal, Execution, and Background Jobs

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `GET` (WS) | `/api/v1/ws/term/session` | `term:open` | Open an interactive SSH terminal WebSocket session |
| `POST` | `/api/v1/exec/run` | `exec:run` / `local:exec` | Run a one-shot command and await completion |
| `POST` | `/api/v1/exec/stream` | `exec:stream` / `local:exec` | Stream stdout and stderr chunks in real time |
| `GET` | `/api/v1/exec/status` | `local:exec` | Query status and exit code of a local process |
| `POST` | `/api/v1/exec/kill` | `local:exec` | Terminate a local process |
| `GET` (WS) | `/api/v1/ws/exec/session` | `exec:session` / `local:exec` | Non-terminal interactive process WebSocket session |
| `POST` | `/api/v1/job/start` | `job:run` | Start a detached persistent background job on a remote host |
| `GET` | `/api/v1/job/status` | `job:status` | Check the running status of a background job |
| `GET` | `/api/v1/job/output` | `job:output` | Retrieve paginated log output of a background job |
| `POST` | `/api/v1/job/kill` | `job:kill` | Forcibly kill a background job process |
| `GET` | `/api/v1/job/list` | `job:list` | List background jobs on a remote host |
| `POST` | `/api/v1/job/remove` | `job:delete` | Delete metadata and logs for a completed job |

#### 4. Scheduled Jobs (Cron)

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/schedule/list` | `schedule:list` | List scheduled cron jobs |
| `POST` | `/api/v1/schedule/create` | `schedule:create` | Create a new scheduled job |
| `POST` | `/api/v1/schedule/update` | `schedule:update` | Update a scheduled job's cron expression or command |
| `POST` | `/api/v1/schedule/delete` | `schedule:delete` | Delete a scheduled job |
| `POST` | `/api/v1/schedule/run` | `schedule:run` | Trigger a scheduled job immediately |

#### 5. Remote File Operations (SFTP)

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/files/stat` | `server:stat` | Fetch metadata for a remote file or folder |
| `GET` | `/api/v1/files/list` | `server:read` | Browse remote directory contents |
| `GET` | `/api/v1/files/download` | `server:download` | Download a remote file or stream an archived directory |
| `POST` | `/api/v1/files/mkdir` | `server:mkdir` | Create a directory on the remote host |
| `POST` | `/api/v1/files/rm` | `server:delete` | Recursively delete files or directories |
| `POST` | `/api/v1/files/rename` | `server:rename` | Rename a remote file or directory |
| `POST` | `/api/v1/files/copy` | `server:copy` | Copy a remote file or directory |
| `POST` | `/api/v1/files/move` | `server:move` | Move a remote file or directory |
| `POST` | `/api/v1/files/upload` | `server:upload` | Stream upload a file to the remote host |
| `POST` | `/api/v1/files/attrs` | `server:attrs` | Update POSIX file permissions and ownership |

#### 6. Elevation, Tunnels, and Network Proxy

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/sudo/request` | `sudo:request` | Request an elevated in-memory sudo session |
| `POST` | `/api/v1/sudo/forget` | `sudo:forget` | Invalidate and purge cached sudo credentials |
| `POST` | `/api/v1/tunnel/start` | `tunnel:start` | Start local, remote, or dynamic SOCKS5 forwarding |
| `GET` | `/api/v1/tunnel/list` | `tunnel:list` | List active tunnels and proxies |
| `POST` | `/api/v1/tunnel/stop` | `tunnel:stop` | Terminate a port forwarding tunnel |
| `POST` | `/api/v1/webproxy/start` | `webproxy:start` | Start an intranet web reverse proxy bridge |
| `POST` | `/api/v1/webproxy/stop` | `webproxy:stop` | Stop an intranet web reverse proxy |
| `GET` (WS) | `/api/v1/ws/net/tcp` | `net:tcp` | Bridge a raw TCP stream over WebSocket |
| `POST` | `/api/v1/net/http` | `net:http` | Dispatch an outbound HTTP request from the backend |

#### 7. App Management and Permissions

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/apps/list` | `apps:list` | List all installed and linked applications |
| `POST` | `/api/v1/apps/validate` | `apps:validate` | Validate a `.qxp` package and its manifest |
| `POST` | `/api/v1/apps/install` | `apps:install` | Extract and install a `.qxp` package |
| `POST` | `/api/v1/apps/uninstall` | `apps:uninstall` | Uninstall an app and revoke its granted permissions |
| `POST` | `/api/v1/apps/link` | `apps:link` | Link a local development directory as an active app |
| `POST` | `/api/v1/apps/enabled` | `apps:toggle` | Enable or disable an installed app |
| `GET` | `/api/v1/apps/file/{id}/{path...}` | Public | Serve static assets from an installed app package |
| `GET` | `/api/v1/perm/catalog` | Public | Retrieve the catalog of all 88 permission scopes |
| `GET` | `/api/v1/perm/granted` | `perm:granted` | Check granted permissions for the calling app |
| `GET` | `/api/v1/perm/grants` | `perm:read` | Inspect permission allocations for all apps |
| `POST` | `/api/v1/perm/grant` | `perm:grant` | Grant specific scopes to an application |
| `POST` | `/api/v1/perm/revoke` | `perm:revoke` | Revoke scopes from an app (invalidates active tokens) |
| `POST` | `/api/v1/perm/clear` | `perm:clear` | Clear all scopes from an app (invalidates active tokens) |

#### 8. App Private Storage and Secrets

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/storage/list` | `storage:list` | List files in the app's private storage folder |
| `GET` | `/api/v1/storage/read` | `storage:read` | Read a file from the app's private storage |
| `POST` | `/api/v1/storage/write` | `storage:write` | Write or overwrite a private storage file |
| `POST` | `/api/v1/storage/delete` | `storage:delete` | Delete a file from private storage |
| `POST` | `/api/v1/storage/mkdir` | `storage:mkdir` | Create a subfolder in private storage |
| `POST` | `/api/v1/storage/rename` | `storage:rename` | Rename a file in private storage |
| `GET` | `/api/v1/secret/get` | `secret:read` | Retrieve an encrypted secret key-value |
| `POST` | `/api/v1/secret/set` | `secret:write` | Encrypt and store an app secret (AES-256-GCM) |
| `POST` | `/api/v1/secret/delete` | `secret:delete` | Remove a stored secret key |
| `GET` | `/api/v1/secret/list` | `secret:list` | List secret keys owned by the app |

#### 9. Host Filesystem (High Risk)

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/localfs/list` | `local:list` | Browse local directories on the QxSSH host |
| `GET` | `/api/v1/localfs/read` | `local:read` | Read and download files from the QxSSH host |
| `POST` | `/api/v1/localfs/write` | `local:write` | Write or upload files to the QxSSH host |
| `POST` | `/api/v1/localfs/mkdir` | `local:mkdir` | Create directories on the QxSSH host |
| `POST` | `/api/v1/localfs/rename` | `local:rename` | Rename files or directories on the QxSSH host |
| `POST` | `/api/v1/localfs/delete` | `local:delete` | Permanently delete files or directories on the QxSSH host |

#### 10. Preferences and Audit Logging

| Method | Endpoint | Required Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/prefs` | `prefs:read` | Retrieve global UI and system preferences |
| `PUT` | `/api/v1/prefs` | `prefs:write` | Update global UI and system preferences |
| `GET` | `/api/v1/prefs/self` | `prefs:self:read` | Read private app-specific preferences |
| `PUT` | `/api/v1/prefs/self` | `prefs:self:write` | Save private app-specific preferences |
| `GET` | `/api/v1/logs/list` | `logs:read` | Query paginated operation audit records |
| `GET` | `/api/v1/logs/settings` | `logs:settings:read` | Inspect audit settings (verbose mode & retention days) |
| `POST` | `/api/v1/logs/settings` | `logs:settings:write` | Update audit retention and verbose settings |
| `POST` | `/api/v1/logs/verbose` | `logs:verbose` | Toggle verbose audit mode |
| `POST` | `/api/v1/logs/archive` | `logs:archive` | Trigger immediate log rotation and sanitized zip archiving |
| `POST` | `/api/v1/logs/clear` | `logs:clear` | Clear audit logs for a workspace |
| `POST` | `/api/v1/audit/note` | `audit:note` | Append custom notes into the audit stream |

---

### 15 Permission Groups and 88 Fine-Grained Scopes

Permissions are partitioned into 15 categories according to the principle of least privilege, with hazard rankings (1 = low, 2 = medium, 3 = high):

1. **`read` (Read-only System)**: `local:hostinfo`, `perm:granted`
2. **`prefs` (Preferences)**: `prefs:read`, `prefs:write`, `prefs:self:read`, `prefs:self:write`
3. **`storage` (App Storage)**: `storage:list`, `storage:read`, `storage:write`, `storage:delete`, `storage:mkdir`, `storage:rename`
4. **`secret` (App Secrets)**: `secret:read`, `secret:write`, `secret:delete`, `secret:list`
5. **`exec` (Execution)**: `exec:run`, `exec:stream`, `exec:session`, `term:open`
6. **`job` (Background Jobs)**: `job:run`, `job:status`, `job:output`, `job:kill`, `job:list`, `job:delete`
7. **`schedule` (Scheduling)**: `schedule:list`, `schedule:create`, `schedule:update`, `schedule:delete`, `schedule:run`
8. **`files` (Remote SFTP)**: `server:stat`, `server:read`, `server:download`, `server:upload`, `server:mkdir`, `server:rename`, `server:copy`, `server:move`, `server:delete`, `server:attrs`
9. **`local` (Local Host Files & Exec)**: `local:list`, `local:read`, `local:write`, `local:delete`, `local:mkdir`, `local:rename`, `local:exec`
10. **`network` (Tunnels & Proxies)**: `tunnel:start`, `tunnel:list`, `tunnel:stop`, `webproxy:start`, `webproxy:stop`, `net:tcp`, `net:http`
11. **`host` (Host Topology)**: `hosts:read`, `hosts:create`, `hosts:update`, `hosts:delete`, `hosts:import`, `hosts:test`, `hosts:preconnect`, `hosts:probe`, `hosts:forgetos`, `hosts:credential`
12. **`apps` (App Management)**: `apps:list`, `apps:validate`, `apps:install`, `apps:uninstall`, `apps:link`, `apps:toggle`
13. **`elev` (Elevation & Governance)**: `sudo:request`, `sudo:forget`, `perm:read`, `perm:grant`, `perm:revoke`, `perm:clear`, `perm:manage`
14. **`logs` (Audit Logging)**: `logs:read`, `logs:readSensitive`, `logs:settings:read`, `logs:settings:write`, `logs:verbose`, `logs:archive`, `logs:clear`, `audit:note`
15. **`ui` (UI & Notifications)**: `ui:window:create`, `ui:window:control`, `ui:notification`, `ui:dialog`, `ui:clipboard:read`, `ui:clipboard:write`, `ui:theme:read`, `ui:theme:write`, `ui:wallpaper:read`, `ui:wallpaper:write`

---

## Data and Configuration Directory

Stored by default under the current user's profile configuration path (overridable via the `-conf` flag):

- **Windows**: `%AppData%\qxssh` (e.g. `C:\Users\<username>\AppData\Roaming\qxssh`)
- **macOS**: `~/Library/Application Support/qxssh`
- **Linux**: `~/.config/qxssh`

### Directory Layout

```
<config-dir>/
├── data.db             # SQLite database (hosts, permissions, preferences, cron jobs, encrypted secrets)
├── known_hosts         # TOFU host key store (OpenSSH format)
├── logs/               # Application runtime logs (generated when -log-file auto is enabled)
│   └── qxssh.log
├── apps/               # Installed third-party apps and live dev links
│   └── <app-id>/
│       ├── .qx-source  # Source path pointer for development mode links
│       └── ...         # Extracted static files for standard installations
└── appdata/            # App-isolated data stores and audit records
    ├── <app-id>/       # Private persistent storage files per app
    └── logs/           # Operation audit logs and archived zip snapshots
        ├── <host-id>.log
        └── archives/
```

---

## Development and Building

```bash
# Run static analysis
go vet ./...

# Build the project
go build ./...
```

### Development Guidelines

1. **Zero External Frontend Build Tools**:
   Do not introduce Webpack, Vite, Babel, or similar build steps. The frontend strictly uses native ES modules supported directly by modern browsers, embedded via Go's `embed.FS`.
2. **Pure-Go Database Driver**:
   Never introduce CGO dependencies. SQLite operations use `modernc.org/sqlite`, ensuring hassle-free cross-compilation across platforms.
3. **Route and Scope Consistency**:
   When registering endpoints in `internal/httpapi`, bind each route to a valid scope registered in `permissions.go`'s `permCatalog`. The server panics at boot if an unknown permission is mapped.
4. **Code Comments and Documentation**:
   Internal comments and error strings in code are written in Chinese. Documentation is maintained symmetrically in English and Chinese with consistent formatting.

---

## Git Exclusions and Build Artifacts

The repository [`.gitignore`](.gitignore) defines the following exclusion rules:

- **Compiled Binaries**: `*.exe`, `*.exe~`, `*.dll`, `*.so`, `*.dylib`, `qxssh` (binary artifacts are generated on build).
- **Test Artifacts**: `*.test`, `*.out`, `coverage.*`, `*.coverprofile`, `profile.cov`.
- **Environment and Tooling**: `go.work`, `go.work.sum`, `.env`, `.idea/`, `.vscode/`.
- **App Packages**: `*.qxp` (packaged extensions are distributable archives, not source files).
- **Agent and Temp Dirs**: `.mimosa/`, `.dsh/`.
- **Wiki Documentation Sources**: `wiki/`.
  - GitHub Project Wiki online documentation: [https://github.com/QingXuan2000/QxSSH/wiki](https://github.com/QingXuan2000/QxSSH/wiki).
  - Markdown files under `wiki/` are formatted specifically for the GitHub Wiki site; they are excluded from the main code branch to keep the repository streamlined.
  - This `README.en.md` and `README.md` provide complete, self-contained documentation, API references, and architecture guides.

---

## License and Acknowledgments

### Open Source License

QxSSH is licensed under the **[GNU General Public License v3.0 (GPL-3.0)](LICENSE)**.

You are free to run, study, modify, and distribute this software, provided that any derivative work or modification is kept open-source under the same GPL-3.0 license.

### Third-Party Assets and Open-Source Components

QxSSH integrates the following open-source projects and resources. We express our sincere gratitude to their creators and contributors:

#### UI Assets and Styling

- **Hero Patterns** (Background texture wallpapers):
  - Source: [https://heropatterns.com/](https://heropatterns.com/)
  - Author: Steve Schoger
  - License: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
  - Usage: Desktop wallpaper textures and SVG patterns
- **Lucide Icons** (Vector icon system):
  - Source: [https://lucide.dev/](https://lucide.dev/)
  - License: [ISC License](https://github.com/lucide-icons/lucide/blob/main/LICENSE)
  - Usage: Desktop and application vector icons

#### Frontend Open-Source Components

- **xterm.js** and **xterm-addon-fit** (Web terminal emulation engine):
  - Source: [https://xtermjs.org/](https://xtermjs.org/)
  - License: [MIT License](https://github.com/xtermjs/xterm.js/blob/master/LICENSE)
  - Usage: Terminal emulation and auto-fit rendering
- **uPlot** (Fast time-series charting):
  - Source: [https://github.com/leeoniya/uPlot](https://github.com/leeoniya/uPlot)
  - Author: Leon Sorokin
  - License: [MIT License](https://github.com/leeoniya/uPlot/blob/master/LICENSE)
  - Usage: System resource monitoring and task manager charts

#### Backend Core Libraries

- **modernc.org/sqlite** (Pure-Go CGO-free SQLite driver): [BSD-3-Clause](https://gitlab.com/cznic/sqlite/-/blob/master/LICENSE)
- **golang.org/x/crypto** (SSH protocol client and cryptography primitives): [BSD-3-Clause](https://go.googlesource.com/crypto/+/refs/heads/master/LICENSE)
- **github.com/pkg/sftp** (SFTP protocol client implementation): [BSD-2-Clause](https://github.com/pkg/sftp/blob/master/LICENSE)
- **github.com/gorilla/websocket** (Fast and reliable WebSocket engine): [BSD-2-Clause](https://github.com/gorilla/websocket/blob/main/LICENSE)
