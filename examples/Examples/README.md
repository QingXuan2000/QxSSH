# Examples — QxSSH 应用开发示例

[English](README.en.md) · 中文

---

`Examples` 是一个**活文档**应用：它把 QxSSH 应用 SDK 的组件库、系统 API、宿主桥与平台基础库全部演示一遍，并在运行时**自检**清单是否与 SDK 导出一致。

它使用与第三方应用**完全相同的** manifest 格式与 SDK（`/assets/js/**`），所以既是演示，也是最好抄的模板。

- **应用 ID**：`examples`
- **入口**：`index.html`
- **分类**：开发
- **不是内置应用**：需要手动加载（见下）。

## 加载它

它不在 `internal/webui/apps/` 里，因此不会被编译进二进制，需要三选一：

**1. 开发模式链接（推荐，改完刷新即可）**

在「应用管理器」里选择“链接本地目录”，或调用：

```js
import { linkApp } from '/assets/js/core/qxssh-api.js';
await linkApp('C:\\Users\\...\\QxSSH\\examples\\Examples'); // 绝对路径
```

**2. 打包安装**

把本目录内容打包为 `.qxp`（zip 格式），`manifest.json` 必须在压缩包**根目录**：

```powershell
# 在本目录内执行
Compress-Archive -Path * -DestinationPath ..\examples.qxp -Force
```

然后在「应用管理器」里安装该 `.qxp`。

**3. 直接放进配置目录**

把本目录复制到 `<配置目录>/apps/examples/`，重启 QxSSH。

> 加载后，桌面 / 开始菜单会出现「Examples」图标。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 应用元数据（id、名称、图标、分类、entry） |
| `index.html` | 入口页，引入样式表与 `app.js` |
| `app.js` | 主入口：图标库、组件库、系统 API、SDK 示例四大页面，全页面实时搜索与表格用法演示 |
| `app.css` | 示例专有样式（`gal-*` 类，表格与代码块样式） |
| `sysapi-groups.js` | 系统 API 端点按权限节点分组清单 → `SYSAPI_GROUPS` / `SYSAPI_ITEMS` |
| `sysapi-page.js` | 系统 API 演示页：按权限节点分组表格化展示端点、权限、说明、用法与调用，支持实时搜索 |
| `component-classes.js` | 组件 → 分类映射 → `COMPONENT_CLASS` / `COMPONENT_CLASSES` / `componentsIn` |
| `language/zh-CN.json` | 应用自带中文词表 |
| `language/en-US.json` | 应用自带英文词表 |

## 页签一览

| 页签 | 内容 |
| --- | --- |
| **图标库** | 内置全量图标，支持实时名称搜索、分页与点击一键复制图标名 |
| **组件库** | 聚合全量 79 个官方组件，支持全局组件名实时搜索过滤与分类无缝切换演示 |
| **系统 API** | `core/qxssh-api.js` 全部 92 个系统 API 端点，按权限节点分组，表格化展示端点、权限、说明、用法与调用，支持实时搜索 |
| **SDK** | 统一 SDK（`qx` 命名空间）：按权限节点表格化展示各 SDK 方法与运维工具箱（`qx.kit`）用法，支持实时搜索、代码演练场与全量自检 |

## 自检机制

启动及渲染时会核对“清单”与“真实导出”是否一致，不一致就在 Console 警告：

- **组件自检**：比对 `component-classes.js` 的分类表与所有核心及高级组件的实际导出（79/79 全部覆盖）。
- **API 自检**：比对 `sysapi-groups.js` 的端点清单与 `core/qxssh-api.js` 的实际导出（92/92 全部覆盖）。
- **SDK 自检**：自检验证 `qx` 命名空间与 `qx.kit` 的全部导出完备性（100% 覆盖）。

这既是示例的特性，也是**给 SDK 维护者的回归保障**：新增或删除一个组件 / 端点而忘了更新示例，示例会立刻提示。

## 把它当模板用

1. 复制本目录为你的新应用目录。
2. 改 `manifest.json`：换 `id`、`name`、`icon`、`category`，删掉不需要的字段（**不要**加 `systemApp` / `disableable`）。
3. 精简 `index.html` / `app.css` / `app.js`，保留 `bootApp` 启动骨架。
4. 按需要保留 `language/*.json` 词表并调整文案键。
5. 参考本目录里对每个 SDK 能力的调用写法。

最小骨架与字段说明见主文档 [README.md](../../README.md#应用插件开发指南) 或在线 Wiki 专题：[App-Development](https://github.com/QingXuan2000/QxSSH/wiki/App-Development) 与 [App-Manifest](https://github.com/QingXuan2000/QxSSH/wiki/App-Manifest)。

## 注意事项

- **部分演示需要先选主机**：`exec`、`sftp`、`job`、`tunnel`、`net` 等会用到当前工作区主机（`ctx.hostId`）；未选主机时相关按钮会提示。
- **权限**：首次调用受限端点会触发授权申请（返回的 `need` 会列出缺少的权限），可拒绝后再看其它页签。
- **危险操作**：删除主机、递归删除文件等按钮会二次确认，请勿在真实环境随意点。
- **仅用于演示**：示例会真的调用 API（包括创建/删除），请只用它测试，不要在生产主机上乱试。
