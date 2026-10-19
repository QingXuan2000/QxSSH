# QxSSH

> 自托管的 SSH 管理控制台：桌面式 Web UI、多主机与跳板链、终端 / 文件 / 端口转发 / 审计，以及可安装的应用（插件）体系。

QxSSH 是一个用 Go 编写的单二进制自托管 Web 应用。它把一台机器变成你集中管理所有 SSH 主机的门户：浏览器打开就是一个交互式“桌面”，主机管理、多标签终端、SFTP 文件传输、端口转发、SOCKS5 动态代理、内网 Web 代理、定时任务、操作审计都以独立应用（App）的形式运行在这套桌面之上。所有凭据在本地以 AES-256-GCM 加密存储，所有操作全程留痕审计。

- [English Documentation](README.en.md)
- 在线文档（Wiki）：[https://github.com/QingXuan2000/QxSSH/wiki](https://github.com/QingXuan2000/QxSSH/wiki)
- 开源许可证：[GNU General Public License v3.0 (GPL-3.0)](LICENSE)
- 无外部依赖：纯 Go 开发（无需 CGO），前端原生 ES Module 与静态资源全量内嵌（无需 Node.js 构建工具），`go build` 即可产出单二进制可执行文件。

---

## 目录

- [特性亮点](#特性亮点)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [构建与运行](#构建与运行)
  - [首次登录](#首次登录)
  - [命令行参数与环境变量](#命令行参数与环境变量)
- [Wiki 深入文档导航](#wiki-深入文档导航)
- [安全模型与权限机制](#安全模型与权限机制)
- [架构与目录结构](#架构与目录结构)
- [核心功能详解](#核心功能详解)
  - [主机与跳板机链](#主机与跳板机链)
  - [Web 终端与命令执行](#web-终端与命令执行)
  - [文件管理（SFTP 与宿主机）](#文件管理sftp-与宿主机)
  - [端口转发与内网 Web 代理](#端口转发与内网-web-代理)
  - [sudo 提权与定时任务](#sudo-提权与定时任务)
  - [审计日志体系](#审计日志体系)
- [内置应用体系](#内置应用体系)
- [应用（插件）开发指南](#应用插件开发指南)
  - [应用包格式（.qxp）](#应用包格式qxp)
  - [manifest.json 配置规范](#manifestjson-配置规范)
  - [使用 SDK 开发应用](#使用-sdk-开发应用)
  - [本地开发与调试链接](#本地开发与调试链接)
  - [打包与发布](#打包与发布)
  - [示例应用模板](#示例应用模板)
- [HTTP 与 WebSocket API 参考](#http-与-websocket-api-参考)
  - [API 设计与调用约定](#api-设计与调用约定)
  - [全量端点清单](#全量端点清单)
  - [15 大权限分组与 88 项细粒度 Scope](#15-大权限分组与-88-项细粒度-scope)
- [数据与配置目录](#数据与配置目录)
- [开发与构建](#开发与构建)
- [Git 忽略与构建产物说明](#git-忽略与构建产物说明)
- [许可证与致谢](#许可证与致谢)
  - [开源许可证](#开源许可证)
  - [第三方资产与开源组件致谢](#第三方资产与开源组件致谢)

---

## 特性亮点

- **主机管理**：支持增删改查、主机分组、批量导入（原生解析 OpenSSH `~/.ssh/config` 配置）、网络连通性测试与操作系统深度探测。
- **多级跳板链（Jump Host）**：每台主机均可自由指定跳板机，最高支持 5 级嵌套；内核自动检测并阻断循环依赖。
- **高可用 SSH 连接池**：并发拨号自动去重、30 秒 keepalive 心跳保活、断线自动淘汰，跳板机失效时级联清理依赖该跳板的所有下游连接。
- **Web 终端**：基于 WebSocket 与 xterm.js，支持多标签页、窗口分屏、字体自适应、会话断线重连与终端状态保持。
- **全方位命令执行**：支持远端一次性执行、流式输出、宿主机本地命令执行，以及无需长连接保持的脱机后台长作业（启动、状态查询、输出拉取、终止与清理）。
- **SFTP 文件管理**：远程目录浏览、文件上传 / 下载、复制、移动、重命名、权限属主修改，以及目录即时打包归档下载。
- **网络隧道体系**：支持本地端口转发（local）、远程端口转发（remote）与动态 SOCKS5 代理（dynamic）。
- **内嵌 Web 代理**：通过 SSH 隧道将远端内网 Web 页面反向代理至本地 `127.0.0.1`，自动改写跨域响应头、重定向 URL 与 Cookie，无需配置浏览器代理即可直连内网面板。
- **sudo 会话提权**：按主机申请管理员权限，密码仅在内存中缓存（默认 30 分钟），支持主动遗忘清空。
- **定时任务引擎**：内置 cron 表达式调度器，支持在指定主机上定期执行自动化命令。
- **深度审计留痕**：详细记录每一次 API 调用的发起应用、目标主机、接口方法、耗时与结果；详细模式下请求头与请求体采用 AES-256-GCM 加密落盘，支持按工作区轮转、脱敏归档打包与保留期淘汰。
- **微内核插件生态**：内置 11 款核心系统应用，支持通过 `.qxp` 格式安装第三方应用，支持本地开发目录软链接；应用具备细粒度权限控制与零默认放行原则。
- **应用私有存储与机密**：每个应用享有独立的磁盘存储空间与经 AES-256-GCM 加密保护的私有机密键值库。
- **原生多语言国际化**：内置中 / 英文完整词表，宿主与应用各自分离，服务端支持基于 `Accept-Language` 的智能协商。

---

## 快速开始

### 环境要求

- **Go 1.27+**
- 纯 Go 实现，无 CGO 依赖，无 Node.js 构建步骤。

### 构建与运行

```bash
# 1. 编译可执行文件
go build -o qxssh .

# 2. 本地运行（默认监听 127.0.0.1:8800）
./qxssh

# 3. 启动后自动调用系统默认浏览器打开控制台
./qxssh -open

# 4. 对外网 / 局域网暴露服务（必须配置鉴权令牌）
./qxssh -addr 0.0.0.0:8800 -auth-token "your-secure-token"
```

在 Windows PowerShell 下编译产物为 `qxssh.exe`：

```powershell
go build -o qxssh.exe .
.\qxssh.exe -open
```

### 首次登录

1. 使用浏览器访问 `http://127.0.0.1:8800`，首先进入**启动器页**（`index.html`）。
2. 点击添加主机，输入主机名称、连接地址、SSH 端口、登录用户名，选择密码或私钥认证方式。
3. 点击主机卡片进入**桌面**（`desktop.html`），双击「终端」应用即可开启 SSH 命令行会话。

### 命令行参数与环境变量

| 命令行参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `-addr` | `QXSSH_ADDR` | `127.0.0.1:8800` | HTTP 服务监听地址 |
| `-conf` | `QXSSH_CONF` | 用户配置目录下的 `qxssh` | 数据与配置存储根目录 |
| `-open` | `QXSSH_OPEN` | `false` | 启动完成后自动使用默认浏览器打开控制台 |
| `-log-level` | `QXSSH_LOG_LEVEL` | `info` | 日志过滤级别：`debug` / `info` / `warn` / `error` / `silent` |
| `-log-file` | `QXSSH_LOG_FILE` | 留空（仅输出到控制台） | 日志输出路径；设为 `auto` 则写入 `<配置目录>/logs/qxssh.log` |
| `-auth-token` | `QXSSH_AUTH_TOKEN` | 留空（仅允许回环地址） | 外部访问全局鉴权令牌；非回环监听时为强制必填项 |

---

## Wiki 深入文档导航

除本自包含文档外，全套深入专题与架构演进说明已发布至 GitHub Wiki：

在线主页：[https://github.com/QingXuan2000/QxSSH/wiki](https://github.com/QingXuan2000/QxSSH/wiki)

| 专题分类 | 在线 Wiki 页面 |
| --- | --- |
| **开始使用** | [快速开始](https://github.com/QingXuan2000/QxSSH/wiki/Getting-Started) · [配置与命令行](https://github.com/QingXuan2000/QxSSH/wiki/Configuration) · [安全模型](https://github.com/QingXuan2000/QxSSH/wiki/Security) |
| **功能指南** | [主机与跳板](https://github.com/QingXuan2000/QxSSH/wiki/Hosts-and-Jumps) · [终端与执行](https://github.com/QingXuan2000/QxSSH/wiki/Terminal-and-Exec) · [文件与 SFTP](https://github.com/QingXuan2000/QxSSH/wiki/Files-and-SFTP) · [转发与代理](https://github.com/QingXuan2000/QxSSH/wiki/Tunnels-and-WebProxy) · [sudo 与定时任务](https://github.com/QingXuan2000/QxSSH/wiki/Sudo-and-Schedules) · [审计日志](https://github.com/QingXuan2000/QxSSH/wiki/Audit-Log) · [权限系统](https://github.com/QingXuan2000/QxSSH/wiki/Permissions) · [内置应用](https://github.com/QingXuan2000/QxSSH/wiki/Built-in-Apps) |
| **应用开发** | [应用开发总览](https://github.com/QingXuan2000/QxSSH/wiki/App-Development) · [manifest.json 参考](https://github.com/QingXuan2000/QxSSH/wiki/App-Manifest) · [SDK：宿主桥](https://github.com/QingXuan2000/QxSSH/wiki/SDK-Host-Bridge) · [SDK：系统 API](https://github.com/QingXuan2000/QxSSH/wiki/SDK-Core-API) · [SDK：执行与网络工具](https://github.com/QingXuan2000/QxSSH/wiki/SDK-Toolkit) · [SDK：组件库与国际化](https://github.com/QingXuan2000/QxSSH/wiki/SDK-UI-and-I18n) · [打包与发布](https://github.com/QingXuan2000/QxSSH/wiki/App-Packaging) |
| **参考维护** | [HTTP / WebSocket API](https://github.com/QingXuan2000/QxSSH/wiki/HTTP-API) · [架构与代码结构](https://github.com/QingXuan2000/QxSSH/wiki/Architecture) · [参与开发](https://github.com/QingXuan2000/QxSSH/wiki/Development) · [排错与 FAQ](https://github.com/QingXuan2000/QxSSH/wiki/Troubleshooting-and-FAQ) |

---

## 安全模型与权限机制

QxSSH 具备执行任意系统命令、管理远程文件与操作敏感凭据的强大能力，因此内置了严密纵深的安全防护边界：

1. **默认回环保护与非回环硬校验**：
   默认严格监听回环地址 `127.0.0.1`。若监听地址包含外网或局域网网卡（例如 `0.0.0.0`），而未设置 `-auth-token` 或 `QXSSH_AUTH_TOKEN`，程序会在启动预检阶段**直接拒绝运行并输出告警**，彻底杜绝凭据与命令执行接口在公网裸奔。
2. **全局访问令牌与常量时间比较**：
   启用鉴权令牌后，所有外部 HTTP / WebSocket 请求必须携带 `Authorization: Bearer <token>`、URL 参数 `?token=` 或 `qx_token` Cookie。服务端使用 `crypto/subtle.ConstantTimeCompare` 进行防时序攻击比较；使用 `?token=` 初次登录成功后，会自动写入 `HttpOnly`、`SameSite=Strict` 的安全 Cookie。
3. **宿主与应用双层会话隔离**：
   宿主界面（`index.html` 与 `desktop.html`）在服务端渲染时通过 `crypto/rand` 随机生成并注入一次性宿主令牌（Host Token）。第三方应用运行于 `iframe` 沙箱中，无法接触宿主令牌；应用必须由宿主通过 `POST /api/v1/session/mint` 端点为其铸造独立的会话访问令牌（Access Token），该令牌绑定应用身份并签名受限 Scope。
4. **零默认权限原则（Zero Default Permissions）**：
   系统定义了 15 个分组共 88 项细粒度权限（Scope）。所有权限项默认均为 `false`（无放行权限）。第三方应用访问私有存储、读写机密或调用任何系统 API，都必须在 `manifest.json` 中明确声明，并在安装或运行时获得用户显式授权。宿主与内置系统应用拥有全量权限。
5. **凭据静态加密（AES-256-GCM）**：
   所有远程主机密码、私钥内容、私钥密码短语以及应用私有机密，在 SQLite 数据库中均通过 AES-256-GCM 算法加密存储。主密钥在首次运行时由加密安全随机数生成并存入数据库 `meta` 表中。
6. **首次信任主机公钥校验（TOFU 机制）**：
   首次连接某远程主机时，系统会自动记录其主机公钥指纹至 `<配置目录>/known_hosts` 文件中（标准 OpenSSH 格式）。若后续连接发现远端公钥指纹变动，连接将被强制中断并向用户告警，有效抵御中间人攻击（MITM）。
7. **出向网络与路径收敛**：
   本地端口转发与动态 SOCKS5 代理的监听端口强制限定于本机回环地址（`127.0.0.1` / `::1`）；所有本地与远程文件操作均执行严格的路径穿越（`..`）校验与规范化处理，阻断符号链接逃逸。
8. **安全响应头与同源校验**：
   服务端全局默认注入 `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: no-referrer`；WebSocket 建立连接时严格核对 Origin 同源标头。

---

## 架构与目录结构

### 源码目录结构

```
QxSSH/
├── main.go                     # 主程序入口：命令行解析、安全预检、日志装配与优雅退出
├── internal/
│   ├── bootstrap/              # 依赖装配：拼装连接池、端口转发、Web 代理、HTTP 网关及级联钩子
│   ├── config/                 # 数据存储层：纯 Go SQLite 操作、AES-256-GCM 加解密、OpenSSH 配置解析
│   ├── sshpool/                # SSH 连接池：跳板链穿透、Keepalive 保活、主机密钥校验、操作系统探测
│   ├── tunnel/                 # 端口转发注册表：本地转发、远程转发与 SOCKS5 动态代理
│   ├── proxy/                  # 内网 Web 代理注册表：HTTP/HTTPS 隧道反代与报文重写
│   ├── httpapi/                # HTTP 与 WebSocket API 网关：路由分派、权限判定、审计记录与各业务端点
│   ├── webui/                  # 前端静态资产：embed.FS 内嵌 HTML、桌面框架、SDK、样式、图标与内置应用
│   └── logging/                # 结构化日志引擎：分级过滤、日志轮转与数据脱敏
├── examples/
│   └── Examples/               # 官方全量 SDK 示例应用（活文档、组件库与端点覆盖自检）
└── wiki/                       # GitHub Wiki 独立源文件（在线站点：https://github.com/QingXuan2000/QxSSH/wiki）
```

### 核心组件拓扑

```
               ┌────────────────────────────────────────────────────────┐
用户浏览器 ────▶│  httpapi.Gateway（路由分派 / 权限校验 / 会话控制 / 审计日志）   │
(HTTP / WS)    └──────────┬──────────────┬──────────────┬───────────────┘
                          │              │              │
                   config.Store    sshpool.Pool   tunnel / proxy
                   (SQLite+加密)   (SSH 连接池)   (端口转发与 Web 反代)
```

- **`bootstrap`**：统一组装各底层子系统，注册连接池失效时级联关闭对应端口转发和 Web 代理的事件监听。
- **`sshpool`**：所有远程 SSH 能力的唯一出口，统一管理多级跳板链拨号、连接复用与失效淘汰。
- **`httpapi`**：采用表驱动的网关架构，每个端点均静态声明请求谓词、路径与所需权限，服务启动时强制校验权限有效性。

---

## 核心功能详解

### 主机与跳板机链

- 主机参数包含名称、分组、IP / 域名、SSH 端口、用户名、认证类型（密码 / 私钥）、密码文本、私钥文件路径或私钥文本内容、私钥密码短语、备注说明与关联跳板机。
- 跳板机链最高支持 5 级（`MaxJumpDepth = 5`）；创建或更新主机配置时，系统会深度遍历并阻断循环引用与超深跳板。
- 若某台主机正被其它主机作为跳板使用，系统会直接拒绝删除操作，并清晰提示依赖该跳板的所有下游主机清单。
- 支持批量导入 OpenSSH 风格的 `~/.ssh/config` 配置，智能提取 `Host`、`HostName`、`User`、`Port`、`IdentityFile` 及 `ProxyJump` 字段。
- 支持针对远程主机执行操作系统深度探测（解析 `/etc/os-release` 与 `uname`），自动在界面上匹配并渲染 Linux 发行版或 Windows 图标。

### Web 终端与命令执行

- 终端通过 `/api/v1/ws/term/session` WebSocket 端点与后端进行双向全双工桥接，支持 PTY 窗口尺寸（cols / rows）动态伸缩通知。
- 命令执行严格区分**远端主机执行**（`exec:run`）与**宿主机本地执行**（`local:exec`）。若请求中 `host` 字段留空，则明确认定为在运行 QxSSH 程序的宿主机本地执行。
- 创新性实现脱机后台持久化作业（Background Jobs）：后台任务将进程 PID、启动时间与输出重定向文件存储在目标远端主机的 `~/.qxssh/jobs/<job-id>` 目录下，通过轻量级文件交互拉取状态与日志，即使关闭浏览器或断开 SSH 连接，后台任务依然稳定运行。

### 文件管理（SFTP 与宿主机）

- SFTP 模块提供高可靠的文件操作集：目录列表遍历、`stat` 元数据查询、文件流式上传与断点续传、文件下载、目录递归删除、文件重命名、复制、移动与权限属主（chmod / chown）修改。
- 支持远程文件夹一键打包流式下载（后端即时生成 Zip 归档流并回传）。
- 宿主机本地文件系统提供独立的 `localfs/*` 接口，受到 `local:read`、`local:write`、`local:mkdir`、`local:rename`、`local:delete` 等高危权限的单独控制与审计记录。

### 端口转发与内网 Web 代理

- **端口转发**：
  - 本地转发（Local）：将本地指定端口流量通过 SSH 隧道转发至远端目标地址。
  - 远程转发（Remote）：在远端主机上监听端口并将流量导回本地或指定目标。
  - 动态转发（Dynamic SOCKS5）：在本地回环地址启动标准 SOCKS5 代理服务，流量通过远端主机出网，支持 IPv4、IPv6 与域名寻址。
- **内网 Web 代理（Web Reverse Proxy）**：
  - 自动在本地回环地址分配随机端口，通过 SSH 隧道与远端内网 HTTP / HTTPS 服务建立反向代理桥。
  - 智能改写 HTTP 报文中的跨域头、重定向 Location 以及 Set-Cookie 域，使用户在本地浏览器即可无缝访问远端受保护内网中的各类 Web 控制台。

### sudo 提权与定时任务

- **sudo 提权会话**：通过 `sudo/request` 申请主机级别的提权会话，密码凭据仅存储于进程内存缓存中，默认有效周期为 30 分钟。超时自动销毁，支持随时调用 `sudo/forget` 立即释放。
- **定时任务**：支持配置标准 5 字段 cron 调度表达式，由服务端调度器统一管理，定时在目标主机上执行预设命令，并记录最近执行耗时、状态与错误输出。

### 审计日志体系

- 审计核心记录全量关键字段：自增序号、操作时间戳、调用应用 ID、工作区目标主机、操作类型、目标 API 标识、明细描述、执行结果与消耗毫秒数。
- 记录的操作类型包括：API 调用、权限申请、权限授予、权限撤销、权限清空、会话铸造、会话吊销、应用备注与底层系统事件。
- **详细审计模式（Verbose）**：除常规元数据外，支持抓取请求 Query 参数、HTTP 请求头与请求体（上限 64 KiB），敏感信息落盘时全程经 AES-256-GCM 加密，仅拥有 `logs:readSensitive` 权限的角色方可解密查看。
- **存储与归档策略**：审计日志基于主机工作区隔离，采用内存环形缓冲区与异步持久化队列写入磁盘；支持根据文件尺寸自动切分轮转、打包生成脱敏 Zip 归档包，并支持按保存份数与天数自动清理历史数据。

---

## 内置应用体系

QxSSH 桌面采用模块化微前端架构，系统自带的 11 款内置应用均采用与第三方应用完全一致的 SDK 接口与 `manifest.json` 规范开发，具备高度一致的交互体验：

| 应用名称 | 应用 ID | 分类 | 功能描述 |
| --- | --- | --- | --- |
| **终端** | `terminal` | 工具 | SSH 交互式终端：多标签页管理、分屏会话、断线自动重连 |
| **文件管理** | `files` | 文件 | 远程 SFTP 文件管理器：文件流式上传下载、文本预览与权限修改 |
| **主机管理** | `hosts` | 系统 | SSH 主机与跳板机拓扑管理、OpenSSH 配置导入、连通性探测 |
| **端口转发** | `tunnels` | 网络 | 本地转发、远程转发与 SOCKS5 动态代理通道启停监控 |
| **内置浏览器** | `browser` | 网络 | 访问远端内网 Web 页面与管理后台，配合内网反代使用 |
| **Docker 管理** | `docker` | 系统 | 容器状态监控、镜像拉取、卷与网络查看、Compose 堆栈启停 |
| **批量执行** | `batch` | 工具 | 跨多台主机并发分发执行 shell 命令并聚合统计结果 |
| **任务管理器** | `taskmon` | 系统 | 实时监控远端 CPU / 内存负载、查看进程树并支持提权结束进程 |
| **审计日志** | `logs` | 系统 | 实时检索操作日志、查看权限授权变更与日志归档下载 |
| **系统设置** | `settings` | 系统 | 个性化桌面主题、Hero Patterns 纹理壁纸、任务栏样式与偏好设置 |
| **应用管理器** | `store` | 系统 | 浏览已安装应用、上传安装 `.qxp` 插件、启用 / 禁用与卸载管理 |

### 应用间 API 互调（RPC）

内置应用对外声明并暴露了标准化服务接口，第三方应用在获得授权后可直接调用：

- `terminal.open`：传入 `{ hostId, path }` 打开指定主机的终端窗口并进入指定目录。
- `files.open`：传入 `{ hostId, path }` 打开指定目录的文件管理器。
- `tunnels.create`：快捷拉起端口转发创建窗口。
- `browser.open`：传入 `{ url, title }` 在内置浏览器中打开目标 Web 界面。

---

## 应用（插件）开发指南

在 QxSSH 中，任何 Web 应用只需附带一份 `manifest.json` 即可打包或链接为桌面原生应用。

### 应用包格式（.qxp）

- 应用包是一个标准的 **ZIP 归档文件**，文件后缀名必须为 **`.qxp`**。
- **必须保证 `manifest.json` 位于压缩包的最顶层根目录**（解压时不应额外嵌套父级文件夹）。
- **打包限制**：
  - ZIP 压缩包体积不超过 50 MB。
  - 包内文件总数不超过 500 个。
  - 解压后展开总容量不超过 100 MB。
  - `manifest.json` 文件体积不超过 64 KB。
  - 相对路径严禁以 `/` 开头或包含 `..` 上级目录跳转。

### manifest.json 配置规范

```json
{
  "id": "my-app",
  "name": "我的扩展应用",
  "nameKey": "myApp.name",
  "description": "应用功能简述",
  "descriptionKey": "myApp.description",
  "category": "工具",
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
      "description": "对外提供问候服务",
      "version": "1.0.0",
      "launch": "background",
      "perm": "apps:list"
    }
  ]
}
```

> [!WARNING]
> 第三方应用禁止在 `manifest.json` 中配置 `systemApp: true` 或 `disableable: true`，这两个属性仅供系统底层内置应用使用。

### 使用 SDK 开发应用

宿主在运行时对外暴露了统一的 ES Module SDK，位于 `/assets/js/qxssh-sdk.js`：

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

    // 1. 窗口与宿主交互
    qx.bridge.ready();
    qx.bridge.notify('应用已就绪', 'success');

    // 2. 调用后端系统 API（受权限控制）
    const hosts = await qx.api.listHosts();
    console.log('受管主机:', hosts);

    // 3. 执行远端命令
    const result = await qx.kit.run('uname -a');
    console.log('命令输出:', result.stdout);

    // 4. 读写应用私有存储
    await qx.api.storeWrite('config.json', JSON.stringify({ theme: 'dark' }));
  </script>
</body>
</html>
```

#### SDK 核心模块拆解

- **`qx.bridge`**（`app-bridge.js`）：提供应用与外层桌面宿主之间的 `postMessage` RPC 桥接通道，覆盖窗口尺寸 / 标题变更、系统原生通知、模态弹窗、剪贴板交互、主题壁纸跟随、权限动态申请，以及跨应用 RPC 注册与调用（`provideApi` / `callAppApi`）。
- **`qx.api`**（`core/qxssh-api.js`）：包含对后端 HTTP / WebSocket API 的 92 个强类型异步调用封装，涵盖主机、终端、SFTP、转发、作业、密钥、存储等。
- **`qx.kit`**（`core/appkit.js`）：面向日常运维与交互的高阶工具包（如便捷运行 `sh`、流式监听 `stream`、脱机作业 `startJob`、代发网络请求 `fetchVia`、建立 TCP 隧道 `tcpConnect` 等）。
- **`qx.ui`**（`core/components.js`）：内置 79 款开箱即用的原生 UI 组件（包含按钮、表单、数据表格、虚拟滚动列表、模态窗、代码编辑器、图表等）。
- **`qx.i18n`**（`core/i18n.js`）：负责应用多语言国际化文案加载与响应式切换。

### 本地开发与调试链接

在开发第三方应用时，无需反复压缩打包。可通过开发模式直接**软链接本地源码目录**：

1. 打开桌面「应用管理器」→ 点击「链接本地目录」。
2. 输入本地源码所在的**绝对路径**（例如 `D:\Projects\my-app` 或 `/home/user/projects/my-app`）。
3. 服务端将在 `<配置目录>/apps/<app-id>/` 下创建一个 `.qx-source` 索引文件，应用的所有静态文件都将直接从该本地源码路径实时读取。代码修改后在应用窗口内按 `F5` 刷新即可即时生效。

### 打包与发布

完成开发后，在应用根目录下（确保 `manifest.json` 在当前目录）生成 `.qxp` 安装包：

**Windows PowerShell**：
```powershell
Compress-Archive -Path * -DestinationPath ..\my-app.qxp -Force
```

**Linux / macOS**：
```bash
zip -r ../my-app.qxp . -x "*.git*"
```

在桌面打开「应用管理器」点击「安装应用」，选择打包好的 `.qxp` 文件即可完成安装。安装时 `manifest.json` 中声明的权限将随安装操作一并获得用户授权。

### 示例应用模板

项目中提供了完整的官方参考实现：[`examples/Examples/`](examples/Examples/)（详见其 [README.md](examples/Examples/README.md)）。该示例应用覆盖了 100% 的 SDK 模块与 UI 组件，并包含自检机制，是开发第三方应用的理想模板。

---

## HTTP 与 WebSocket API 参考

### API 设计与调用约定

- **接口前缀**：所有业务 API 统一挂载于 `/api/v1/` 命名空间下。
- **鉴权传输**：会话令牌通过 HTTP 请求头 `X-Qx-Session: <token>` 或 Query 参数 `?session=<token>` 传递。
- **请求体验证**：请求体使用严格 JSON 模式反序列化，**若包含未定义字段将直接报错**，单次请求体上限为 8 MiB。
- **统一响应规范**：
  - 成功时返回具体业务对象或 `{"ok": true}`。
  - 失败时返回 `{"error": "错误描述", "code": "错误码"}`。
  - 权限不足时统一返回 HTTP 403，结构为：
    ```json
    {
      "error": "应用缺少权限：exec:run",
      "code": "permission",
      "need": ["exec:run"]
    }
    ```

### 全量端点清单

#### 1. 会话控制与公开元信息

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `POST` | `/api/v1/session/mint` | 宿主专有 | 为指定应用铸造会话访问令牌与刷新令牌 |
| `POST` | `/api/v1/session/refresh` | 宿主 / 应用 | 使用刷新令牌轮换并换发新的访问令牌 |
| `POST` | `/api/v1/session/revoke` | 宿主 / 应用自身 | 撤销应用会话令牌（跨应用撤销需 `perm:manage`） |
| `GET` | `/.well-known/jwks.json` | 公开 | 获取 IdP 签名公钥集（标准 JWKS 格式） |
| `GET` | `/api/v1/jwks` | 公开 | 获取 IdP 签名公钥集（API 别名路径） |
| `GET` | `/api/v1/host/version` | 公开 | 读取服务端版本号与运行环境信息 |
| `GET` | `/api/v1/local/hostinfo` | `local:hostinfo` | 读取 QxSSH 宿主机路径与系统架构信息 |
| `GET` | `/api/v1/lang/list` | 公开 | 查询系统支持的可用语言清单 |
| `GET` | `/api/v1/lang/negotiate` | 公开 | 执行国际化语言偏好智能协商 |

#### 2. 主机管理与 SSH 连接

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/hosts/list` | `hosts:read` | 查询受管主机配置列表 |
| `POST` | `/api/v1/hosts/create` | `hosts:create` | 创建新的远程主机记录 |
| `POST` | `/api/v1/hosts/import` | `hosts:import` | 批量导入 OpenSSH 风格的 ssh_config 配置 |
| `POST` | `/api/v1/hosts/update` | `hosts:update` | 更新指定主机的连接配置与凭据 |
| `POST` | `/api/v1/hosts/delete` | `hosts:delete` | 删除主机（若被其它主机作为跳板使用则阻断） |
| `POST` | `/api/v1/hosts/test` | `hosts:test` | 测试网络端口连通性 |
| `POST` | `/api/v1/hosts/preconnect` | `hosts:preconnect` | 建立 SSH 预连接以检测鉴权与跳板链 |
| `POST` | `/api/v1/hosts/probe` | `hosts:probe` | 深度探测目标主机的操作系统版本与环境信息 |
| `POST` | `/api/v1/hosts/forget-os` | `hosts:forgetos` | 清除该主机的操作系统探测缓存 |
| `POST` | `/api/v1/hosts/credential` | `hosts:credential` | 解密读取远程主机明文凭据 |

#### 3. 终端、命令与后台作业

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `GET` (WS) | `/api/v1/ws/term/session` | `term:open` | 建立交互式 SSH 终端 WebSocket 双向通道 |
| `POST` | `/api/v1/exec/run` | `exec:run` / `local:exec` | 一次性执行命令并等待输出结果 |
| `POST` | `/api/v1/exec/stream` | `exec:stream` / `local:exec` | 以分块流的形式实时获取命令标准输出与错误 |
| `GET` | `/api/v1/exec/status` | `local:exec` | 查询宿主机本地后台进程状态与退出码 |
| `POST` | `/api/v1/exec/kill` | `local:exec` | 终止宿主机本地后台进程 |
| `GET` (WS) | `/api/v1/ws/exec/session` | `exec:session` / `local:exec` | 建立非终端形式的交互式子进程 WebSocket 会话 |
| `POST` | `/api/v1/job/start` | `job:run` | 在远端启动脱机后台持久长作业 |
| `GET` | `/api/v1/job/status` | `job:status` | 查询指定脱机后台作业的运行状态 |
| `GET` | `/api/v1/job/output` | `job:output` | 分页拉取脱机后台作业的运行日志输出 |
| `POST` | `/api/v1/job/kill` | `job:kill` | 强行终止远端脱机后台作业 |
| `GET` | `/api/v1/job/list` | `job:list` | 获取目标主机上的脱机后台作业列表 |
| `POST` | `/api/v1/job/remove` | `job:delete` | 删除已结束后台作业的元数据与日志记录 |

#### 4. 定时调度（Cron）

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/schedule/list` | `schedule:list` | 查询已配置的定时任务列表 |
| `POST` | `/api/v1/schedule/create` | `schedule:create` | 新增定时调度任务 |
| `POST` | `/api/v1/schedule/update` | `schedule:update` | 更新定时任务的 cron 表达式或命令 |
| `POST` | `/api/v1/schedule/delete` | `schedule:delete` | 删除指定定时任务 |
| `POST` | `/api/v1/schedule/run` | `schedule:run` | 手动立即触发定时任务运行一次 |

#### 5. 远程文件管理（SFTP）

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `POST` | `/api/v1/files/stat` | `server:stat` | 查询远端文件或目录的元数据信息 |
| `GET` | `/api/v1/files/list` | `server:read` | 浏览远程目录并列出文件项 |
| `GET` | `/api/v1/files/download` | `server:download` | 下载远端文件或流式打包下载目录归档 |
| `POST` | `/api/v1/files/mkdir` | `server:mkdir` | 在远端主机创建新目录 |
| `POST` | `/api/v1/files/rm` | `server:delete` | 递归删除远端文件或目录 |
| `POST` | `/api/v1/files/rename` | `server:rename` | 重命名远端文件或目录 |
| `POST` | `/api/v1/files/copy` | `server:copy` | 在远端主机上复制文件或目录 |
| `POST` | `/api/v1/files/move` | `server:move` | 在远端主机上移动文件或目录 |
| `POST` | `/api/v1/files/upload` | `server:upload` | 向远端主机流式上传文件 |
| `POST` | `/api/v1/files/attrs` | `server:attrs` | 修改远端文件的 POSIX 权限位与属主 |

#### 6. 提权、网络隧道与代理

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `POST` | `/api/v1/sudo/request` | `sudo:request` | 申请目标主机的内存 Sudo 提权会话 |
| `POST` | `/api/v1/sudo/forget` | `sudo:forget` | 立即清除内存中的 Sudo 凭据缓存 |
| `POST` | `/api/v1/tunnel/start` | `tunnel:start` | 启动本地转发、远程转发或 SOCKS5 代理通道 |
| `GET` | `/api/v1/tunnel/list` | `tunnel:list` | 查询当前运行中的所有隧道与代理状态 |
| `POST` | `/api/v1/tunnel/stop` | `tunnel:stop` | 停止指定的端口转发通道 |
| `POST` | `/api/v1/webproxy/start` | `webproxy:start` | 启动通往远端内网 Web 服务的反向代理 |
| `POST` | `/api/v1/webproxy/stop` | `webproxy:stop` | 停止指定的内网 Web 反向代理 |
| `GET` (WS) | `/api/v1/ws/net/tcp` | `net:tcp` | 通过 WebSocket 建立原生 TCP 流量桥接隧道 |
| `POST` | `/api/v1/net/http` | `net:http` | 由服务端代发外部 HTTP/HTTPS 出向网络请求 |

#### 7. 应用管理与权限授权

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/apps/list` | `apps:list` | 获取系统已安装及链接的全部应用清单 |
| `POST` | `/api/v1/apps/validate` | `apps:validate` | 校验 `.qxp` 安装包的完整性与 manifest 规范 |
| `POST` | `/api/v1/apps/install` | `apps:install` | 解包安装第三方 `.qxp` 应用并授予声明权限 |
| `POST` | `/api/v1/apps/uninstall` | `apps:uninstall` | 卸载目标应用并级联清空其所有已获授权 |
| `POST` | `/api/v1/apps/link` | `apps:link` | 软链接本地开发目录为实时应用 |
| `POST` | `/api/v1/apps/enabled` | `apps:toggle` | 切换指定应用的启用 / 禁用状态 |
| `GET` | `/api/v1/apps/file/{id}/{path...}` | 公开 | 获取已安装应用包内的静态资产文件（如图标） |
| `GET` | `/api/v1/perm/catalog` | 公开 | 获取系统全量 88 项细粒度权限规范目录 |
| `GET` | `/api/v1/perm/granted` | `perm:granted` | 查询当前应用自身已获得的权限列表 |
| `GET` | `/api/v1/perm/grants` | `perm:read` | 查询所有已注册应用的权限分配详情 |
| `POST` | `/api/v1/perm/grant` | `perm:grant` | 批量向指定应用授予权限节点 |
| `POST` | `/api/v1/perm/revoke` | `perm:revoke` | 批量撤销指定应用的权限节点（旧令牌立即失效） |
| `POST` | `/api/v1/perm/clear` | `perm:clear` | 清空指定应用的全部已获权限（令牌立即失效） |

#### 8. 应用私有存储与机密

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/storage/list` | `storage:list` | 遍历当前应用私有存储目录中的文件 |
| `GET` | `/api/v1/storage/read` | `storage:read` | 读取当前应用私有目录中的指定文件 |
| `POST` | `/api/v1/storage/write` | `storage:write` | 写入或覆盖当前应用私有目录中的文件 |
| `POST` | `/api/v1/storage/delete` | `storage:delete` | 删除当前应用私有目录中的文件 |
| `POST` | `/api/v1/storage/mkdir` | `storage:mkdir` | 在应用私有目录中创建子文件夹 |
| `POST` | `/api/v1/storage/rename` | `storage:rename` | 重命名应用私有目录中的文件 |
| `GET` | `/api/v1/secret/get` | `secret:read` | 读取当前应用的加密私有机密键值 |
| `POST` | `/api/v1/secret/set` | `secret:write` | 以 AES-256-GCM 加密存储应用专属机密项 |
| `POST` | `/api/v1/secret/delete` | `secret:delete` | 删除当前应用的专属机密项 |
| `GET` | `/api/v1/secret/list` | `secret:list` | 列出当前应用拥有的所有机密键名列表 |

#### 9. 宿主机文件系统（高危操作）

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/localfs/list` | `local:list` | 浏览运行 QxSSH 的宿主机本地目录 |
| `GET` | `/api/v1/localfs/read` | `local:read` | 读取并下载宿主机本地文件 |
| `POST` | `/api/v1/localfs/write` | `local:write` | 写入或上传文件至宿主机本地磁盘 |
| `POST` | `/api/v1/localfs/mkdir` | `local:mkdir` | 在宿主机本地创建新文件夹 |
| `POST` | `/api/v1/localfs/rename` | `local:rename` | 重命名宿主机本地文件或目录 |
| `POST` | `/api/v1/localfs/delete` | `local:delete` | 彻底删除宿主机本地文件或目录 |

#### 10. 偏好设置与审计日志

| 请求方法 | 接口端点 | 所需权限 | 功能说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/prefs` | `prefs:read` | 读取系统全局外观与行为偏好 |
| `PUT` | `/api/v1/prefs` | `prefs:write` | 更新系统全局外观与行为偏好 |
| `GET` | `/api/v1/prefs/self` | `prefs:self:read` | 读取当前应用在服务端的专属偏好配置 |
| `PUT` | `/api/v1/prefs/self` | `prefs:self:write` | 保存当前应用在服务端的专属偏好配置 |
| `GET` | `/api/v1/logs/list` | `logs:read` | 分页条件检索操作审计日志明细 |
| `GET` | `/api/v1/logs/settings` | `logs:settings:read` | 读取审计系统设置（详细模式与保留天数） |
| `POST` | `/api/v1/logs/settings` | `logs:settings:write` | 调整审计设置（修改详细审计与保留期） |
| `POST` | `/api/v1/logs/verbose` | `logs:verbose` | 快速切换详细审计日志记录模式 |
| `POST` | `/api/v1/logs/archive` | `logs:archive` | 立即触发工作区审计日志打包与脱敏归档 |
| `POST` | `/api/v1/logs/clear` | `logs:clear` | 清空指定工作区审计日志 |
| `POST` | `/api/v1/audit/note` | `audit:note` | 向审计日志流中追加应用自定义备注记录 |

---

### 15 大权限分组与 88 项细粒度 Scope

系统权限体系按照最小权限原则划分为 15 个功能分组，每个权限节点（Scope）具备独立的危险级别定义（1-低危、2-中危、3-高危）：

1. **`read`（只读查询）**：`local:hostinfo`、`perm:granted`
2. **`prefs`（偏好设置）**：`prefs:read`、`prefs:write`、`prefs:self:read`、`prefs:self:write`
3. **`storage`（应用私有存储）**：`storage:list`、`storage:read`、`storage:write`、`storage:delete`、`storage:mkdir`、`storage:rename`
4. **`secret`（应用机密存储）**：`secret:read`、`secret:write`、`secret:delete`、`secret:list`
5. **`exec`（命令执行）**：`exec:run`、`exec:stream`、`exec:session`、`term:open`
6. **`job`（后台长作业）**：`job:run`、`job:status`、`job:output`、`job:kill`、`job:list`、`job:delete`
7. **`schedule`（定时调度）**：`schedule:list`、`schedule:create`、`schedule:update`、`schedule:delete`、`schedule:run`
8. **`files`（远端 SFTP 文件）**：`server:stat`、`server:read`、`server:download`、`server:upload`、`server:mkdir`、`server:rename`、`server:copy`、`server:move`、`server:delete`、`server:attrs`
9. **`local`（宿主机本地文件与进程）**：`local:list`、`local:read`、`local:write`、`local:delete`、`local:mkdir`、`local:rename`、`local:exec`
10. **`network`（网络隧道与代理）**：`tunnel:start`、`tunnel:list`、`tunnel:stop`、`webproxy:start`、`webproxy:stop`、`net:tcp`、`net:http`
11. **`host`（主机与凭据管理）**：`hosts:read`、`hosts:create`、`hosts:update`、`hosts:delete`、`hosts:import`、`hosts:test`、`hosts:preconnect`、`hosts:probe`、`hosts:forgetos`、`hosts:credential`
12. **`apps`（应用插件管理）**：`apps:list`、`apps:validate`、`apps:install`、`apps:uninstall`、`apps:link`、`apps:toggle`
13. **`elev`（提权与授权治理）**：`sudo:request`、`sudo:forget`、`perm:read`、`perm:grant`、`perm:revoke`、`perm:clear`、`perm:manage`
14. **`logs`（审计日志）**：`logs:read`、`logs:readSensitive`、`logs:settings:read`、`logs:settings:write`、`logs:verbose`、`logs:archive`、`logs:clear`、`audit:note`
15. **`ui`（界面与桌面交互）**：`ui:window:create`、`ui:window:control`、`ui:notification`、`ui:dialog`、`ui:clipboard:read`、`ui:clipboard:write`、`ui:theme:read`、`ui:theme:write`、`ui:wallpaper:read`、`ui:wallpaper:write`

---

## 数据与配置目录

默认存储于当前系统用户的配置目录下（可用 `-conf` 命令行参数覆盖）：

- **Windows**：`%AppData%\qxssh`（例如 `C:\Users\<用户名>\AppData\Roaming\qxssh`）
- **macOS**：`~/Library/Application Support/qxssh`
- **Linux**：`~/.config/qxssh`

### 目录树结构

```
<配置目录>/
├── data.db             # SQLite 数据库（存储主机记录、权限分配、偏好设置、定时任务、加密凭据等）
├── known_hosts         # TOFU 主机公钥记录文件（标准 OpenSSH 格式）
├── logs/               # 系统运行日志（使用 -log-file auto 时生成）
│   └── qxssh.log
├── apps/               # 已安装的第三方应用及开发模式软链接文件
│   └── <app-id>/
│       ├── .qx-source  # （若为开发链接）记录本地源码绝对路径
│       └── ...         # （若为正式安装）解包后的应用完整静态文件
└── appdata/            # 各应用私有持久化数据存储与操作审计日志
    ├── <app-id>/       # 单个应用的私有存储文件（受 storage:* 权限保护）
    └── logs/           # 操作审计日志与轮转归档的 zip 文件
        ├── <host-id>.log
        └── archives/
```

---

## 开发与构建

```bash
# 静态语法分析与代码检查
go vet ./...

# 编译项目
go build ./...
```

### 开发与编码约定

1. **零外部构建工具**：
   前端严禁引入 Webpack、Vite、Babel 等编译构建工具，全部采用浏览器原生支持的 ES Module，由 Go 标准库 `embed.FS` 直接打包内嵌。
2. **纯 Go 数据库驱动**：
   严禁使用 CGO；数据库必须使用纯 Go 实现的 `modernc.org/sqlite` 驱动，确保跨平台交叉编译时零依赖。
3. **接口权限一致性检查**：
   在 `internal/httpapi` 中新增任何系统 API 时，必须在 `api.go` 中明确绑定规范权限；若绑定的权限键未预先在 `permissions.go` 的 `permCatalog` 中登记，服务端在启动时将直接 panic，杜绝未定义权限的接口上线。
4. **统一中英文空格与注释规范**：
   服务端错误信息与代码注释统一采用中文；文档中严格遵循中英文之间有空格的排版规则。

---

## Git 忽略与构建产物说明

在项目根目录的 [`.gitignore`](.gitignore) 中，配置了以下规范的忽略规则：

- **二进制可执行文件**：`*.exe`、`*.exe~`、`*.dll`、`*.so`、`*.dylib`、`qxssh`（编译产物不计入代码仓库）。
- **测试与覆盖率产物**：`*.test`、`*.out`、`coverage.*`、`*.coverprofile`、`profile.cov`。
- **本地环境与工作区配置**：`go.work`、`go.work.sum`、`.env`、`.idea/`、`.vscode/`。
- **应用打包文件**：`*.qxp`（应用插件归档属于分发包，不计入代码仓库）。
- **代理与临时目录**：`.mimosa/`、`.dsh/`。
- **Wiki 文档源文件**：`wiki/`。
  - GitHub 项目 Wiki 在线文档站点：[https://github.com/QingXuan2000/QxSSH/wiki](https://github.com/QingXuan2000/QxSSH/wiki)。
  - `wiki/` 目录中的 Markdown 文件专为 GitHub Wiki 站点设计，代码仓库主分支将其排除以保持代码库精简。
  - 本 `README.md` 与 `README.en.md` 包含全量完整、自包含的技术架构、API 接口与二次开发指南。

---

## 许可证与致谢

### 开源许可证

QxSSH 遵循 **[GNU General Public License v3.0 (GPL-3.0)](LICENSE)** 协议开源。

您可以自由地运行、研读、修改与分发本软件，但在修改或派生软件时必须保持源代码开源并继承 GPL-3.0 许可证。

### 第三方资产与开源组件致谢

QxSSH 的用户界面与底层运行时整合了以下优秀的开源项目与素材，在此向原作者与开源社区致以由衷感谢：

#### 界面资产与样式

- **Hero Patterns**（系统背景纹理壁纸）：
  - 来源：[https://heropatterns.com/](https://heropatterns.com/)
  - 作者：Steve Schoger
  - 许可证：[Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
  - 用途：系统桌面纹理背景与壁纸 SVG 素材
- **Lucide Icons**（系统矢量图标库）：
  - 来源：[https://lucide.dev/](https://lucide.dev/)
  - 许可证：[ISC License](https://github.com/lucide-icons/lucide/blob/main/LICENSE)
  - 用途：桌面与应用内置矢量图标系统

#### 前端开源组件

- **xterm.js** 与 **xterm-addon-fit**（Web 终端模拟渲染引擎）：
  - 来源：[https://xtermjs.org/](https://xtermjs.org/)
  - 许可证：[MIT License](https://github.com/xtermjs/xterm.js/blob/master/LICENSE)
  - 用途：Web 终端模拟与自适应渲染引擎
- **uPlot**（超高性能时序监控图表）：
  - 来源：[https://github.com/leeoniya/uPlot](https://github.com/leeoniya/uPlot)
  - 作者：Leon Sorokin
  - 许可证：[MIT License](https://github.com/leeoniya/uPlot/blob/master/LICENSE)
  - 用途：任务管理器与系统资源时序监控图表

#### 后端核心开源库

- **modernc.org/sqlite**（纯 Go 无 CGO 的 SQLite 驱动）：[BSD-3-Clause](https://gitlab.com/cznic/sqlite/-/blob/master/LICENSE)
- **golang.org/x/crypto**（SSH 客户端协议栈与现代密码学实现）：[BSD-3-Clause](https://go.googlesource.com/crypto/+/refs/heads/master/LICENSE)
- **github.com/pkg/sftp**（SFTP 客户端子协议实现）：[BSD-2-Clause](https://github.com/pkg/sftp/blob/master/LICENSE)
- **github.com/gorilla/websocket**（高效稳定的 WebSocket 协议引擎）：[BSD-2-Clause](https://github.com/gorilla/websocket/blob/main/LICENSE)
