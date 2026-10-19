package httpapi

import "strings"

type permDef struct {
	ID       string `json:"id"`
	Group    string `json:"group"`
	Label    string `json:"label"`
	LabelKey string `json:"labelKey,omitempty"`
	Desc     string `json:"desc"`
	DescKey  string `json:"descKey,omitempty"`
	Danger   int    `json:"danger"`
	UI       bool   `json:"ui,omitempty"`
	Default  bool   `json:"default,omitempty"`
}

type permGroup struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	LabelKey string `json:"labelKey,omitempty"`
}

var permGroups = []permGroup{
	{Key: "read", Label: "只读查询", LabelKey: "core.perm.group.read"},
	{Key: "prefs", Label: "偏好设置", LabelKey: "core.perm.group.prefs"},
	{Key: "storage", Label: "应用私有存储", LabelKey: "core.perm.group.storage"},
	{Key: "secret", Label: "应用机密存储", LabelKey: "core.perm.group.secret"},
	{Key: "exec", Label: "命令执行", LabelKey: "core.perm.group.exec"},
	{Key: "job", Label: "后台作业", LabelKey: "core.perm.group.job"},
	{Key: "schedule", Label: "定时调度", LabelKey: "core.perm.group.schedule"},
	{Key: "files", Label: "远端文件", LabelKey: "core.perm.group.files"},
	{Key: "local", Label: "宿主机文件", LabelKey: "core.perm.group.local"},
	{Key: "network", Label: "网络与代理", LabelKey: "core.perm.group.network"},
	{Key: "host", Label: "主机管理", LabelKey: "core.perm.group.host"},
	{Key: "apps", Label: "应用管理", LabelKey: "core.perm.group.apps"},
	{Key: "elev", Label: "提权与权限", LabelKey: "core.perm.group.elev"},
	{Key: "logs", Label: "审计日志", LabelKey: "core.perm.group.logs"},
	{Key: "ui", Label: "界面与通知", LabelKey: "core.perm.group.ui"},
}

const (
	permLogsSensitive = "logs:readSensitive"
	permLogsArchive   = "logs:archive"
	permLogsClear     = "logs:clear"
)

// permCatalog 定义系统全量细粒度 scope 目录。
// 遵循零默认权限原则：每个 API 端点均绑定独立权限节点，无任何默认放行项（Default 项全为 false），
// 应用访问自身私有存储、私有机密与偏好设置亦必须获得用户显式授权。
var permCatalog = []permDef{
	// 1. 只读查询与系统
	{ID: "local:hostinfo", Group: "read", Label: "读取宿主机信息", LabelKey: "core.perm.local.hostinfo", Desc: "读取运行 QxSSH 这台机器的家目录、临时目录、配置目录、平台与架构，以及安装根等环境变量", DescKey: "core.perm.local.hostinfo.desc", Danger: 2},
	{ID: "perm:granted", Group: "read", Label: "查看自身授权", LabelKey: "core.perm.perm.granted", Desc: "查询当前应用自身已获得的权限列表", DescKey: "core.perm.perm.granted.desc", Danger: 1},

	// 2. 偏好设置
	{ID: "prefs:read", Group: "prefs", Label: "读取全局偏好", LabelKey: "core.perm.prefs.read", Desc: "读取系统全局偏好设置及界面配置", DescKey: "core.perm.prefs.read.desc", Danger: 1},
	{ID: "prefs:write", Group: "prefs", Label: "修改全局偏好", LabelKey: "core.perm.prefs.write", Desc: "修改系统全局外观、主题与行为偏好设置", DescKey: "core.perm.prefs.write.desc", Danger: 2},
	{ID: "prefs:self:read", Group: "prefs", Label: "读取应用私有偏好", LabelKey: "core.perm.prefs.self.read", Desc: "读取当前应用保存在服务端的专属私有偏好设置", DescKey: "core.perm.prefs.self.read.desc", Danger: 1},
	{ID: "prefs:self:write", Group: "prefs", Label: "保存应用私有偏好", LabelKey: "core.perm.prefs.self.write", Desc: "保存或修改当前应用专属的私有偏好配置数据", DescKey: "core.perm.prefs.self.write.desc", Danger: 1},

	// 3. 应用私有存储（非默认，需用户显式授权）
	{ID: "storage:list", Group: "storage", Label: "浏览私有存储目录", LabelKey: "core.perm.storage.list", Desc: "浏览应用在服务端专属数据目录（appdata/<id>/）的文件列表", DescKey: "core.perm.storage.list.desc", Danger: 1},
	{ID: "storage:read", Group: "storage", Label: "读取私有存储文件", LabelKey: "core.perm.storage.read", Desc: "读取应用专属数据目录下的文件内容", DescKey: "core.perm.storage.read.desc", Danger: 1},
	{ID: "storage:write", Group: "storage", Label: "写入私有存储文件", LabelKey: "core.perm.storage.write", Desc: "在应用专属数据目录下创建、写入或追加文件内容", DescKey: "core.perm.storage.write.desc", Danger: 2},
	{ID: "storage:mkdir", Group: "storage", Label: "创建私有存储目录", LabelKey: "core.perm.storage.mkdir", Desc: "在应用专属数据目录下创建新子目录", DescKey: "core.perm.storage.mkdir.desc", Danger: 1},
	{ID: "storage:rename", Group: "storage", Label: "重命名私有存储文件", LabelKey: "core.perm.storage.rename", Desc: "重命名或移动应用专属数据目录下的文件或子目录", DescKey: "core.perm.storage.rename.desc", Danger: 2},
	{ID: "storage:delete", Group: "storage", Label: "删除私有存储文件", LabelKey: "core.perm.storage.delete", Desc: "永久删除应用专属数据目录下的文件或目录", DescKey: "core.perm.storage.delete.desc", Danger: 2},

	// 4. 应用机密存储（非默认，需用户显式授权）
	{ID: "secret:list", Group: "secret", Label: "列出私有机密键", LabelKey: "core.perm.secret.list", Desc: "列出应用保存在服务端的加密机密键名列表", DescKey: "core.perm.secret.list.desc", Danger: 1},
	{ID: "secret:read", Group: "secret", Label: "读取私有机密", LabelKey: "core.perm.secret.read", Desc: "解密并读取应用私有机密的明文内容", DescKey: "core.perm.secret.read.desc", Danger: 2},
	{ID: "secret:write", Group: "secret", Label: "设置私有机密", LabelKey: "core.perm.secret.write", Desc: "加密保存或更新应用私有机密键值对", DescKey: "core.perm.secret.write.desc", Danger: 2},
	{ID: "secret:delete", Group: "secret", Label: "删除私有机密", LabelKey: "core.perm.secret.delete", Desc: "从加密存储库中永久删除指定的私有机密", DescKey: "core.perm.secret.delete.desc", Danger: 2},

	// 5. 命令执行与终端
	{ID: "term:open", Group: "exec", Label: "打开终端会话", LabelKey: "core.perm.term.open", Desc: "在受管远端主机上打开交互式 SSH 终端会话", DescKey: "core.perm.term.open.desc", Danger: 3},
	{ID: "exec:run", Group: "exec", Label: "远端命令执行", LabelKey: "core.perm.exec.run", Desc: "在受管远端主机上执行单次命令并获取完整执行结果", DescKey: "core.perm.exec.run.desc", Danger: 3},
	{ID: "exec:stream", Group: "exec", Label: "流式命令执行", LabelKey: "core.perm.exec.stream", Desc: "在受管远端主机上执行命令并实时流式接收标准输出与标准错误", DescKey: "core.perm.exec.stream.desc", Danger: 3},
	{ID: "exec:session", Group: "exec", Label: "命令执行通道", LabelKey: "core.perm.exec.session", Desc: "通过 WebSocket 会话双向流式收发命令输入与执行输出", DescKey: "core.perm.exec.session.desc", Danger: 3},
	{ID: "local:exec", Group: "exec", Label: "宿主机命令执行", LabelKey: "core.perm.local.exec", Desc: "在运行 QxSSH 的宿主机上执行任意命令、读取其输出并启动/停止后台进程", DescKey: "core.perm.local.exec.desc", Danger: 3},

	// 6. 后台作业
	{ID: "job:list", Group: "job", Label: "查看后台作业列表", LabelKey: "core.perm.job.list", Desc: "读取受管主机上保存的后台持久化作业清单", DescKey: "core.perm.job.list.desc", Danger: 1},
	{ID: "job:status", Group: "job", Label: "查看后台作业状态", LabelKey: "core.perm.job.status", Desc: "获取受管主机上指定后台作业的运行状态与退出码", DescKey: "core.perm.job.status.desc", Danger: 1},
	{ID: "job:output", Group: "job", Label: "查看后台作业输出", LabelKey: "core.perm.job.output", Desc: "读取受管主机上后台作业产生的标准输出日志内容", DescKey: "core.perm.job.output.desc", Danger: 1},
	{ID: "job:run", Group: "job", Label: "启动后台作业", LabelKey: "core.perm.job.run", Desc: "在受管主机上启动脱离终端生命周期的后台持久化长作业", DescKey: "core.perm.job.run.desc", Danger: 3},
	{ID: "job:kill", Group: "job", Label: "终止后台作业", LabelKey: "core.perm.job.kill", Desc: "终止受管主机上正在运行的后台作业进程", DescKey: "core.perm.job.kill.desc", Danger: 2},
	{ID: "job:delete", Group: "job", Label: "删除后台作业", LabelKey: "core.perm.job.delete", Desc: "删除受管主机上记录的后台作业元数据与执行历史记录", DescKey: "core.perm.job.delete.desc", Danger: 2},

	// 7. 定时调度
	{ID: "schedule:list", Group: "schedule", Label: "查看定时作业列表", LabelKey: "core.perm.schedule.list", Desc: "读取受管远端主机上配置的定时作业调度计划、执行历史与状态", DescKey: "core.perm.schedule.list.desc", Danger: 1},
	{ID: "schedule:create", Group: "schedule", Label: "创建定时作业", LabelKey: "core.perm.schedule.create", Desc: "在受管主机上新建定时作业调度计划", DescKey: "core.perm.schedule.create.desc", Danger: 3},
	{ID: "schedule:update", Group: "schedule", Label: "修改定时作业", LabelKey: "core.perm.schedule.update", Desc: "更新已有定时作业的执行指令、cron 表达式与启用状态", DescKey: "core.perm.schedule.update.desc", Danger: 3},
	{ID: "schedule:delete", Group: "schedule", Label: "删除定时作业", LabelKey: "core.perm.schedule.delete", Desc: "从配置数据库中删除指定的定时作业调度计划", DescKey: "core.perm.schedule.delete.desc", Danger: 2},
	{ID: "schedule:run", Group: "schedule", Label: "手动触发定时作业", LabelKey: "core.perm.schedule.run", Desc: "手动立即触发指定定时作业执行一次", DescKey: "core.perm.schedule.run.desc", Danger: 3},

	// 8. 远端文件 SFTP
	{ID: "server:stat", Group: "files", Label: "查询远端文件元数据", LabelKey: "core.perm.server.stat", Desc: "查询受管主机上文件或目录的大小、修改时间、模式与 POSIX 权限等属性", DescKey: "core.perm.server.stat.desc", Danger: 1},
	{ID: "server:read", Group: "files", Label: "浏览远端目录", LabelKey: "core.perm.server.read", Desc: "浏览受管远端主机目录下的文件与子目录列表", DescKey: "core.perm.server.read.desc", Danger: 1},
	{ID: "server:download", Group: "files", Label: "下载远端文件", LabelKey: "core.perm.server.download", Desc: "读取并下载远端主机上的文件内容或目录归档打包文件", DescKey: "core.perm.server.download.desc", Danger: 2},
	{ID: "server:upload", Group: "files", Label: "上传远端文件", LabelKey: "core.perm.server.upload", Desc: "向受管远端主机上传写入新文件或覆盖已有文件内容", DescKey: "core.perm.server.upload.desc", Danger: 2},
	{ID: "server:mkdir", Group: "files", Label: "远端创建目录", LabelKey: "core.perm.server.mkdir", Desc: "在受管远端主机上创建新目录", DescKey: "core.perm.server.mkdir.desc", Danger: 2},
	{ID: "server:rename", Group: "files", Label: "重命名远端文件", LabelKey: "core.perm.server.rename", Desc: "在受管远端主机上重命名文件或目录", DescKey: "core.perm.server.rename.desc", Danger: 2},
	{ID: "server:copy", Group: "files", Label: "复制远端文件", LabelKey: "core.perm.server.copy", Desc: "在受管远端主机上复制文件或目录", DescKey: "core.perm.server.copy.desc", Danger: 2},
	{ID: "server:move", Group: "files", Label: "移动远端文件", LabelKey: "core.perm.server.move", Desc: "在受管远端主机上跨目录移动文件或目录", DescKey: "core.perm.server.move.desc", Danger: 2},
	{ID: "server:attrs", Group: "files", Label: "修改远端文件属性", LabelKey: "core.perm.server.attrs", Desc: "修改受管远端主机上文件的 POSIX 权限位（chmod）与属主属组（chown）", DescKey: "core.perm.server.attrs.desc", Danger: 2},
	{ID: "server:delete", Group: "files", Label: "删除远端文件与目录", LabelKey: "core.perm.server.delete", Desc: "永久删除受管远端主机上的文件与目录（不可逆的破坏性操作）", DescKey: "core.perm.server.delete.desc", Danger: 3},

	// 9. 宿主机文件
	{ID: "local:list", Group: "local", Label: "浏览宿主机目录", LabelKey: "core.perm.local.list", Desc: "浏览运行 QxSSH 的宿主机本地目录与文件清单", DescKey: "core.perm.local.list.desc", Danger: 2},
	{ID: "local:read", Group: "local", Label: "读取宿主机文件", LabelKey: "core.perm.local.read", Desc: "读取与下载宿主机上任意路径的文件内容", DescKey: "core.perm.local.read.desc", Danger: 3},
	{ID: "local:write", Group: "local", Label: "写入宿主机文件", LabelKey: "core.perm.local.write", Desc: "在宿主机任意路径下上传与写入文件内容", DescKey: "core.perm.local.write.desc", Danger: 3},
	{ID: "local:mkdir", Group: "local", Label: "宿主机创建目录", LabelKey: "core.perm.local.mkdir", Desc: "在宿主机文件系统上创建新目录", DescKey: "core.perm.local.mkdir.desc", Danger: 3},
	{ID: "local:rename", Group: "local", Label: "重命名宿主机文件", LabelKey: "core.perm.local.rename", Desc: "重命名或移动宿主机上的文件与目录", DescKey: "core.perm.local.rename.desc", Danger: 3},
	{ID: "local:delete", Group: "local", Label: "删除宿主机文件与目录", LabelKey: "core.perm.local.delete", Desc: "永久删除 QxSSH 运行所在宿主机上的文件与目录（不可逆的破坏性操作）", DescKey: "core.perm.local.delete.desc", Danger: 3},

	// 10. 网络与代理
	{ID: "tunnel:list", Group: "network", Label: "查看端口转发列表", LabelKey: "core.perm.tunnel.list", Desc: "读取当前运行中的 SSH 端口转发通道与内网 Web 代理服务列表及状态", DescKey: "core.perm.tunnel.list.desc", Danger: 1},
	{ID: "tunnel:start", Group: "network", Label: "启动SSH端口转发", LabelKey: "core.perm.tunnel.start", Desc: "启动远端 SSH 端口转发通道", DescKey: "core.perm.tunnel.start.desc", Danger: 3},
	{ID: "tunnel:stop", Group: "network", Label: "停止SSH端口转发", LabelKey: "core.perm.tunnel.stop", Desc: "停止正在运行的远端 SSH 端口转发通道", DescKey: "core.perm.tunnel.stop.desc", Danger: 2},
	{ID: "tunnel:local", Group: "network", Label: "本机建立端口转发", LabelKey: "core.perm.tunnel.local", Desc: "在本机监听端口，把流量经 SSH 转发到目标主机（或 SOCKS5 代理）", DescKey: "core.perm.tunnel.local.desc", Danger: 3},
	{ID: "webproxy:start", Group: "network", Label: "启动内网Web代理", LabelKey: "core.perm.webproxy.start", Desc: "启动内网 HTTP/Web 代理服务与端口映射", DescKey: "core.perm.webproxy.start.desc", Danger: 2},
	{ID: "webproxy:stop", Group: "network", Label: "停止内网Web代理", LabelKey: "core.perm.webproxy.stop", Desc: "停止正在运行的内网 HTTP/Web 代理服务", DescKey: "core.perm.webproxy.stop.desc", Danger: 2},
	{ID: "net:tcp", Group: "network", Label: "发起服务端TCP桥接", LabelKey: "core.perm.net.tcp", Desc: "通过服务端发起原生 TCP 桥接通道", DescKey: "core.perm.net.tcp.desc", Danger: 3},
	{ID: "net:http", Group: "network", Label: "服务端发起HTTP请求", LabelKey: "core.perm.net.http", Desc: "通过服务端反向代理或跨域发起 HTTP 请求", DescKey: "core.perm.net.http.desc", Danger: 3},

	// 11. 主机管理
	{ID: "hosts:read", Group: "host", Label: "读取主机列表", LabelKey: "core.perm.hosts.read", Desc: "读取受管远端主机的网络地址、端口、用户、标签与分组", DescKey: "core.perm.hosts.read.desc", Danger: 1},
	{ID: "hosts:test", Group: "host", Label: "测试主机连通性", LabelKey: "core.perm.hosts.test", Desc: "向受管主机发起 SSH 网络连通性测试", DescKey: "core.perm.hosts.test.desc", Danger: 1},
	{ID: "hosts:preconnect", Group: "host", Label: "预连接主机", LabelKey: "core.perm.hosts.preconnect", Desc: "提前建立受管主机 SSH 连接池连接", DescKey: "core.perm.hosts.preconnect.desc", Danger: 1},
	{ID: "hosts:probe", Group: "host", Label: "探测主机硬件与系统", LabelKey: "core.perm.hosts.probe", Desc: "深入探测受管主机的操作系统发行版、内核版本及系统信息", DescKey: "core.perm.hosts.probe.desc", Danger: 1},
	{ID: "hosts:forgetos", Group: "host", Label: "清除系统探测缓存", LabelKey: "core.perm.hosts.forgetos", Desc: "清除受管主机的操作系统发行版探测结果与图标记忆", DescKey: "core.perm.hosts.forgetos.desc", Danger: 1},
	{ID: "hosts:create", Group: "host", Label: "新增主机配置", LabelKey: "core.perm.hosts.create", Desc: "添加新主机配置到配置数据库", DescKey: "core.perm.hosts.create.desc", Danger: 2},
	{ID: "hosts:import", Group: "host", Label: "批量导入主机", LabelKey: "core.perm.hosts.import", Desc: "从 OpenSSH 配置文件批量导入主机配置", DescKey: "core.perm.hosts.import.desc", Danger: 2},
	{ID: "hosts:update", Group: "host", Label: "修改主机配置", LabelKey: "core.perm.hosts.update", Desc: "更新已保存的主机网络地址、端口、用户或跳板机配置", DescKey: "core.perm.hosts.update.desc", Danger: 2},
	{ID: "hosts:delete", Group: "host", Label: "删除主机配置", LabelKey: "core.perm.hosts.delete", Desc: "从配置数据库中永久删除指定主机", DescKey: "core.perm.hosts.delete.desc", Danger: 3},
	{ID: "hosts:credential", Group: "host", Label: "读取主机凭据", LabelKey: "core.perm.hosts.credential", Desc: "读取主机已保存的登录密码与私钥口令明文", DescKey: "core.perm.hosts.credential.desc", Danger: 3},

	// 12. 应用管理
	{ID: "apps:list", Group: "apps", Label: "获取应用列表", LabelKey: "core.perm.apps.list", Desc: "读取内置与已安装应用的清单、版本、来源与授权状态", DescKey: "core.perm.apps.list.desc", Danger: 1},
	{ID: "apps:validate", Group: "apps", Label: "校验应用安装包", LabelKey: "core.perm.apps.validate", Desc: "校验第三方应用安装包的文件格式与清单元数据", DescKey: "core.perm.apps.validate.desc", Danger: 1},
	{ID: "apps:install", Group: "apps", Label: "安装应用", LabelKey: "core.perm.apps.install", Desc: "安装应用包（应用代码将以当前权限运行）", DescKey: "core.perm.apps.install.desc", Danger: 3},
	{ID: "apps:link", Group: "apps", Label: "链接开发应用", LabelKey: "core.perm.apps.link", Desc: "软链接本地目录作为开发应用", DescKey: "core.perm.apps.link.desc", Danger: 3},
	{ID: "apps:uninstall", Group: "apps", Label: "卸载应用", LabelKey: "core.perm.apps.uninstall", Desc: "删除已安装应用及其权限授权", DescKey: "core.perm.apps.uninstall.desc", Danger: 2},
	{ID: "apps:toggle", Group: "apps", Label: "启停应用", LabelKey: "core.perm.apps.toggle", Desc: "更改应用的启用或禁用状态", DescKey: "core.perm.apps.toggle.desc", Danger: 2},

	// 13. 提权与权限
	{ID: "sudo:request", Group: "elev", Label: "sudo 提权", LabelKey: "core.perm.sudo.request", Desc: "申请被控机管理员（sudo）会话并在内存中暂存凭据", DescKey: "core.perm.sudo.request.desc", Danger: 3},
	{ID: "sudo:forget", Group: "elev", Label: "清除 sudo 缓存", LabelKey: "core.perm.sudo.forget", Desc: "主动清除受管主机暂存在内存中的管理员提权凭据", DescKey: "core.perm.sudo.forget.desc", Danger: 1},
	{ID: "perm:read", Group: "elev", Label: "查看应用授权", LabelKey: "core.perm.perm.read", Desc: "查看所有第三方应用的权限授予状态与历史记录", DescKey: "core.perm.perm.read.desc", Danger: 1},
	{ID: "perm:grant", Group: "elev", Label: "授予应用权限", LabelKey: "core.perm.perm.grant", Desc: "为第三方应用显式授予指定权限", DescKey: "core.perm.perm.grant.desc", Danger: 3},
	{ID: "perm:revoke", Group: "elev", Label: "撤销应用权限", LabelKey: "core.perm.perm.revoke", Desc: "撤销第三方应用已获得的指定权限并吊销其历史令牌", DescKey: "core.perm.perm.revoke.desc", Danger: 3},
	{ID: "perm:clear", Group: "elev", Label: "清空应用权限", LabelKey: "core.perm.perm.clear", Desc: "清空第三方应用的全部已授权权限并吊销其会话", DescKey: "core.perm.perm.clear.desc", Danger: 3},

	// 14. 审计日志
	{ID: "logs:read", Group: "logs", Label: "查看审计日志", LabelKey: "core.perm.logs.read", Desc: "查看各应用的操作调用记录与权限历史", DescKey: "core.perm.logs.read.desc", Danger: 1},
	{ID: "audit:note", Group: "logs", Label: "添加审计备注", LabelKey: "core.perm.audit.note", Desc: "在当前操作审计日志中记录自定义调用备注", DescKey: "core.perm.audit.note.desc", Danger: 1},
	{ID: "logs:settings:read", Group: "logs", Label: "查看审计配置", LabelKey: "core.perm.logs.settings.read", Desc: "查看审计日志详细模式与保留归档策略", DescKey: "core.perm.logs.settings.read.desc", Danger: 1},
	{ID: "logs:settings:write", Group: "logs", Label: "修改审计配置", LabelKey: "core.perm.logs.settings.write", Desc: "修改审计日志保留策略与详细记录选项", DescKey: "core.perm.logs.settings.write.desc", Danger: 3},
	{ID: "logs:verbose", Group: "logs", Label: "开关详细审计", LabelKey: "core.perm.logs.verbose", Desc: "开关敏感请求头与请求体的详细加密记录模式", DescKey: "core.perm.logs.verbose.desc", Danger: 3},
	{ID: "logs:archive", Group: "logs", Label: "立即归档审计", LabelKey: "core.perm.logs.archive", Desc: "手动立即打包归档当前工作区的审计日志文件", DescKey: "core.perm.logs.archive.desc", Danger: 3},
	{ID: "logs:clear", Group: "logs", Label: "清空审计日志", LabelKey: "core.perm.logs.clear", Desc: "永久删除指定工作区的全部审计日志与归档文件", DescKey: "core.perm.logs.clear.desc", Danger: 3},
	{ID: "logs:readSensitive", Group: "logs", Label: "查看审计明细", LabelKey: "core.perm.logs.readSensitive", Desc: "查看调用的原始请求体与全部请求头（含凭据明文）", DescKey: "core.perm.logs.readSensitive.desc", Danger: 3},

	// 15. 界面与通知
	{ID: "ui:notify", Group: "ui", Label: "发送系统通知", LabelKey: "core.perm.ui.notify", Desc: "通过系统通知中心弹出桌面通知", DescKey: "core.perm.ui.notify.desc", Danger: 1, UI: true},
	{ID: "ui:settings", Group: "ui", Label: "更改系统全局设置", LabelKey: "core.perm.ui.settings", Desc: "修改主题、壁纸、任务栏位置、桌面图标布局等全局界面设置", DescKey: "core.perm.ui.settings.desc", Danger: 2, UI: true},
}

// permAliases 提供旧版别名向新规范的透明映射，保证向后兼容。
var permAliases = map[string]string{
	"perm:sudo":       "sudo:request",
	"perm:manage":     "perm:grant",
	"job:read":        "job:list",
	"schedule:read":   "schedule:list",
	"tunnel:read":     "tunnel:list",
	"sys:read":        "prefs:read",
	"hosts:forget-os": "hosts:forgetos",
	"storage:use":     "storage:write",
	"secrets:use":     "secret:write",
	"secret:get":      "secret:read",
	"secret:set":      "secret:write",
	"localfs:read":    "local:read",
	"localfs:list":    "local:list",
	"localfs:write":   "local:write",
	"localfs:mkdir":   "local:mkdir",
	"localfs:rename":  "local:rename",
	"localfs:delete":  "local:delete",
}

// PermNormalize 把权限键归一化为目录中的规范权限 ID；未知键原样返回。
func PermNormalize(id string) string {
	id = strings.TrimSpace(id)
	if g, ok := permAliases[id]; ok {
		return g
	}
	return id
}

var permByID = func() map[string]permDef {
	m := make(map[string]permDef, len(permCatalog))
	for _, p := range permCatalog {
		m[p.ID] = p
	}
	return m
}()

func permKnown(id string) bool {
	id = strings.TrimSpace(id)
	_, ok := permByID[id]
	return ok
}

func permIDs() []string {
	out := make([]string, 0, len(permCatalog))
	for _, p := range permCatalog {
		out = append(out, p.ID)
	}
	return out
}

func permIsDefault(id string) bool {
	p, ok := permByID[PermNormalize(id)]
	return ok && p.Default
}

func permDefaultIDs() []string {
	out := make([]string, 0, len(permCatalog))
	for _, p := range permCatalog {
		if p.Default {
			out = append(out, p.ID)
		}
	}
	return out
}
