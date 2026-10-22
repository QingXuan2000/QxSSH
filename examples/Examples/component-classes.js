/**
 * examples/Examples/component-classes.js —— 组件到演示分类的映射表与元数据
 * 要点：该示例演示 QxSSH 应用 SDK 的 /assets/js/core/components.js；导出 COMPONENT_CLASS（组件名 → 分类）、
 *       COMPONENT_CLASSES（分类定义与图标）、COMPONENT_META（双语名称与搜索关键词）、
 *       SECTION_COMPS（演示卡片对应组件）、matchesComponent 搜索函数与 componentsIn。
 */
export const COMPONENT_CLASS = {
  card: 'layout',
  FloatCard: 'layout',
  sidebarSections: 'layout',

  Tabs: 'nav',
  breadcrumb: 'nav',
  menu: 'nav',
  MenuPanel: 'nav',
  openPopper: 'nav',
  steps: 'nav',
  segmented: 'nav',
  chipGroup: 'nav',
  searchBox: 'nav',
  SearchSelect: 'nav',
  toolbar: 'nav',
  pagination: 'nav',
  timeline: 'nav',
  DropdownButton: 'nav',

  field: 'form',
  inputField: 'form',
  selectField: 'form',
  textareaField: 'form',
  Checkbox: 'form',
  SwitchToggle: 'form',
  RadioGroup: 'form',
  SliderField: 'form',
  StepperField: 'form',
  TagInput: 'form',
  KvEditor: 'form',
  PasswordField: 'form',
  copyField: 'form',
  FileDrop: 'form',
  AsyncButton: 'form',

  table: 'data',
  Tree: 'data',
  listRow: 'data',
  JsonViewer: 'data',
  LogPanel: 'data',
  codeBlock: 'data',
  progressBar: 'data',
  progressRing: 'data',
  segmentedBar: 'data',
  statTile: 'data',
  spinner: 'data',
  execResultCard: 'data',
  execResults: 'data',
  Collapsible: 'data',
  loadingMask: 'data',

  sectionTitle: 'state',
  keyValue: 'state',
  kvGrid: 'state',
  badge: 'state',
  statusDot: 'state',
  statusBar: 'state',
  alertBar: 'state',
  emptyState: 'state',
  emptyAction: 'state',
  errorState: 'state',
  skeleton: 'state',
  tipAttrs: 'state',
  kbd: 'state',

  iconButton: 'action',
  copyButton: 'action',
  ConfirmBar: 'action',
  dialog: 'action',
  DialogPanel: 'action',
  promptDialog: 'action',
  sideAction: 'action',

  CodeEditor: 'advanced',
  codeField: 'advanced',
  VirtualList: 'advanced',
  scrollToRow: 'advanced',
  LineChart: 'advanced',
  timeSeries: 'advanced',
  DataView: 'advanced',
  createDataView: 'advanced',
  createSplitter: 'advanced',
  i18nSelect: 'advanced',
  i18nButton: 'advanced',
  i18nMenu: 'advanced',
};

/** 演示页使用的组件分类定义：分类 id、标题文案 key 与图标 */
export const COMPONENT_CLASSES = [
  { id: 'layout', labelKey: 'app.examples.group-layout', icon: 'layout' },
  { id: 'nav', labelKey: 'app.examples.group-nav', icon: 'navigation' },
  { id: 'form', labelKey: 'app.examples.group-form', icon: 'edit' },
  { id: 'data', labelKey: 'app.examples.group-data', icon: 'list' },
  { id: 'state', labelKey: 'app.examples.group-feedback', icon: 'info' },
  { id: 'action', labelKey: 'app.examples.group-actions', icon: 'cursor' },
  { id: 'advanced', labelKey: 'app.examples.group-advanced', icon: 'code' },
];

/** 分类检索关键词表（支持中英双语检索） */
export const CATEGORY_KEYWORDS = {
  layout: '布局与骨架 布局 layout skeleton card',
  nav: '导航 nav navigation menu tab popper steps',
  form: '表单录入 表单 form input select switch check',
  data: '数据展示 数据 table data list tree log json',
  state: '状态与反馈 反馈 状态 state feedback alert badge empty',
  action: '操作件 操作 交互 action button dialog modal',
  advanced: '高级扩展与图表 高级 图表 代码 advanced chart editor',
};

/** 全量组件双语名称与检索关键词定义 */
export const COMPONENT_META = {
  card: { nameZh: '卡片容器', keywords: 'card 卡片 面板 容器 基础卡片' },
  FloatCard: { nameZh: '悬浮卡片', keywords: 'floatcard 浮动卡片 悬浮卡片 悬浮 拖拽 窗体' },
  sidebarSections: { nameZh: '侧边栏段落', keywords: 'sidebar 侧边栏 导航 分区 分组 列表' },

  Tabs: { nameZh: '顶部标签页', keywords: 'tabs 标签页 选项卡 切换 顶栏 页签' },
  breadcrumb: { nameZh: '面包屑导航', keywords: 'breadcrumb 面包屑 路径 层级' },
  menu: { nameZh: '右键菜单', keywords: 'menu 弹出菜单 上下文 右键 contextmenu' },
  MenuPanel: { nameZh: '菜单面板', keywords: 'menupanel 菜单面板 菜单列表 浮层' },
  openPopper: { nameZh: '气泡浮层', keywords: 'popper 浮层 气泡 弹出 popover 锚定' },
  steps: { nameZh: '步骤条', keywords: 'steps 步骤 流程 进度 导航' },
  segmented: { nameZh: '分段控制器', keywords: 'segmented 分段器 分段控件 切换器 单选' },
  chipGroup: { nameZh: '标签胶囊组', keywords: 'chip 胶囊 标签组 过滤片 过滤' },
  searchBox: { nameZh: '搜索框', keywords: 'searchbox 搜索框 搜索 查找 过滤 input filter' },
  SearchSelect: { nameZh: '可搜索下拉选择', keywords: 'searchselect 下拉搜索 筛选选择 搜索选择 下拉框' },
  toolbar: { nameZh: '工具栏', keywords: 'toolbar 工具条 工具栏 按钮栏 顶部栏' },
  pagination: { nameZh: '分页器', keywords: 'pagination 分页 页码 上一页 下一页 pager' },
  timeline: { nameZh: '时间线', keywords: 'timeline 时间轴 时间线 流水 历史 记录' },
  DropdownButton: { nameZh: '下拉菜单按钮', keywords: 'dropdown 下拉按钮 菜单按钮 button btn 按钮' },

  field: { nameZh: '表单字段容器', keywords: 'field 表单项 标签 提示 校验 form 表单 输入框' },
  inputField: { nameZh: '文本输入框', keywords: 'input 单行文本 输入框 编辑 text 输入' },
  selectField: { nameZh: '下拉选择框', keywords: 'select 下拉框 选择器 下拉选择 选项 option 下拉' },
  textareaField: { nameZh: '多行文本框', keywords: 'textarea 多行文本 文本域 输入 多行 输入框' },
  Checkbox: { nameZh: '复选框', keywords: 'checkbox 复选 多选 勾选 check 复选框' },
  SwitchToggle: { nameZh: '开关切换', keywords: 'switch toggle 开关 切换 启用 状态' },
  RadioGroup: { nameZh: '单选组', keywords: 'radio 单选框 单选组 互斥 单选' },
  SliderField: { nameZh: '滑块选择', keywords: 'slider 滑块 范围 拖动 数值' },
  StepperField: { nameZh: '步进增减框', keywords: 'stepper 步进器 计数器 加减 步进 数值' },
  TagInput: { nameZh: '标签输入框', keywords: 'tag 标签录入 标签输入 标签列表 taginput 输入框' },
  KvEditor: { nameZh: '键值对编辑器', keywords: 'kv kveditor 键值对 环境变量 配置' },
  PasswordField: { nameZh: '密码输入框', keywords: 'password 密码框 密码 明文 密文 eye 输入框' },
  copyField: { nameZh: '复制输入框', keywords: 'copyfield 只读文本 快捷复制 复制框 输入框' },
  FileDrop: { nameZh: '文件拖放区', keywords: 'filedrop 文件上传 文件拖放 拖拽拖放 选文件 drop' },
  AsyncButton: { nameZh: '异步操作按钮', keywords: 'asyncbutton 异步按钮 防重复 加载按钮 button btn 按钮' },

  table: { nameZh: '数据表格', keywords: 'table 表格 列表 渲染 列 数据' },
  Tree: { nameZh: '树形列表', keywords: 'tree 树形 目录 层级 折叠 树' },
  listRow: { nameZh: '列表项行', keywords: 'listrow 列表行 单行 项目 行容器' },
  JsonViewer: { nameZh: 'JSON 查看器', keywords: 'json jsonviewer 结构化 数据树 展开折叠 查看器 展开全部 expandall 着色器 shader 高亮 键值拆分 keysplit timingShader' },
  LogPanel: { nameZh: '日志面板', keywords: 'log logpanel 日志控制台 日志 输出 终端 自动滚动' },
  codeBlock: { nameZh: '代码块', keywords: 'codeblock 代码块 纯文本 等宽 pre 代码' },
  progressBar: { nameZh: '条形进度条', keywords: 'progressbar 进度条 进度 百分比 进度指示' },
  progressRing: { nameZh: '环形进度条', keywords: 'progressring 进度环 圆环 仪表 百分比 进度' },
  segmentedBar: { nameZh: '分段占比条', keywords: 'segmentedbar 占比条 容量分布 资源占用 分段' },
  statTile: { nameZh: '指标统计磁贴', keywords: 'stattile 统计数值 统计块 指标 卡片 监控 大字' },
  spinner: { nameZh: '加载指示器', keywords: 'spinner 加载中 加载指示 loading 菊花 旋转' },
  execResultCard: { nameZh: '执行结果卡片', keywords: 'execresultcard 执行结果 命令行 输出 状态' },
  execResults: { nameZh: '执行结果列表', keywords: 'execresults 批量执行 任务结果 汇聚' },
  Collapsible: { nameZh: '折叠面板', keywords: 'collapsible 折叠 手风琴 展开 伸缩 折叠面板' },
  loadingMask: { nameZh: '全屏加载遮罩', keywords: 'loadingmask 加载遮罩 蒙层 阻塞 mask 全屏遮罩' },

  sectionTitle: { nameZh: '区块小标题', keywords: 'sectiontitle 分组标题 标题 栏目 标题' },
  keyValue: { nameZh: '单条键值展示', keywords: 'keyvalue 键值 对齐 属性 信息 键值展示' },
  kvGrid: { nameZh: '键值网格布局', keywords: 'kvgrid 网格 属性表 详情 多列 键值网格' },
  badge: { nameZh: '状态徽标', keywords: 'badge 徽章 徽标 标签 状态 标记 胶囊' },
  statusDot: { nameZh: '状态圆点', keywords: 'statusdot 圆点 状态点 在线 离线 警示 状态' },
  statusBar: { nameZh: '底部状态栏', keywords: 'statusbar 状态条 状态栏 底栏 状态信息' },
  alertBar: { nameZh: '通知警告提示条', keywords: 'alertbar 警告 提示 提示条 错误 成功 横幅 alert' },
  emptyState: { nameZh: '空数据占位', keywords: 'emptystate 空状态 空态 无数据 缺省 占位 empty' },
  emptyAction: { nameZh: '带操作空状态', keywords: 'emptyaction 空态操作 引导 创建 重新加载' },
  errorState: { nameZh: '加载失败占位', keywords: 'errorstate 错误态 错态 加载失败 异常 重试' },
  skeleton: { nameZh: '骨架屏占位', keywords: 'skeleton 骨架屏 骨架 占位 占位动画' },
  tipAttrs: { nameZh: '悬浮提示属性', keywords: 'tipattrs tooltip 气泡提示 悬浮 文字提示 提示' },
  kbd: { nameZh: '键盘按键样式', keywords: 'kbd 快捷键 键盘 键位 组合键 按键' },

  iconButton: { nameZh: '纯图标按钮', keywords: 'iconbutton 图标按钮 按钮 btn button 快捷操作' },
  copyButton: { nameZh: '复制按钮', keywords: 'copybutton 复制按钮 按钮 btn button 剪贴板' },
  ConfirmBar: { nameZh: '行内二次确认条', keywords: 'confirmbar 确认条 删除确认 二次确认 内联确认 危险操作' },
  dialog: { nameZh: '模态对话框', keywords: 'dialog 对话框 弹窗 modal 确认框 提示框 窗口 本地对话框' },
  DialogPanel: { nameZh: '对话框面板', keywords: 'dialogpanel 对话框面板 模态窗口 窗体 对话框 弹窗' },
  promptDialog: { nameZh: '输入确认对话框', keywords: 'promptdialog 输入弹窗 输入对话框 prompt 提问 单行输入 对话框' },
  sideAction: { nameZh: '侧边栏操作按钮', keywords: 'sideaction 侧栏按钮 快捷键 操作项 button 按钮' },

  CodeEditor: { nameZh: '代码编辑器', keywords: 'codeeditor 编辑器 语法高亮 行号 javascript json 代码' },
  codeField: { nameZh: '代码输入字段', keywords: 'codefield 代码框 脚本输入 单行代码 代码 输入框' },
  VirtualList: { nameZh: '虚拟滚动长列表', keywords: 'virtuallist 虚拟列表 海量数据 高性能列表 滚动 虚拟长列表' },
  scrollToRow: { nameZh: '虚拟列表跳转', keywords: 'scrolltorow 定位行 滚动到 指定行 跳转' },
  LineChart: { nameZh: 'Canvas 折线图表', keywords: 'linechart 折线图 图表 趋势 监控 曲线 chart 时序' },
  timeSeries: { nameZh: '时序数据环形缓冲', keywords: 'timeseries 时序数据 数据点 采样 监控 时序' },
  DataView: { nameZh: '大数据表格视图', keywords: 'dataview 高性能表格 排序 过滤 多列 表格 数据视图' },
  createDataView: { nameZh: '创建数据视图', keywords: 'createdataview 表格初始化 挂载 实例 表格 数据视图' },
  createSplitter: { nameZh: '双栏拖拽拆分条', keywords: 'createsplitter 拖拽 分隔条 左右分栏 布局 拆分条 分栏器' },
  i18nSelect: { nameZh: '语言切换下拉框', keywords: 'i18nselect 语言切换 多语言 国际化 select 下拉' },
  i18nButton: { nameZh: '语言切换按钮', keywords: 'i18nbutton 语言按钮 多语言 切换 button 按钮' },
  i18nMenu: { nameZh: '语言切换菜单', keywords: 'i18nmenu 语言菜单 多语言 弹出菜单 menu 菜单' },
};

/** 演示卡片 translation key 到所演示组件列表的映射表 */
export const SECTION_COMPS = {
  'app.examples.section-card': ['card'],
  'app.examples.section-floatcard': ['FloatCard'],
  'app.examples.section-sidebar-flat': ['sidebarSections'],
  'app.examples.section-sidebar-grouped': ['sidebarSections'],
  'app.examples.section-tabs': ['Tabs'],
  'app.examples.section-breadcrumb': ['breadcrumb'],
  'app.examples.section-filter': ['chipGroup', 'segmented'],
  'app.examples.section-menu': ['menu', 'MenuPanel', 'DropdownButton'],
  'app.examples.section-popper': ['openPopper'],
  'app.examples.section-steps': ['steps'],
  'app.examples.section-search': ['searchBox', 'SearchSelect'],
  'app.examples.section-toolbar': ['toolbar'],
  'app.examples.section-pagination': ['pagination'],
  'app.examples.section-timeline': ['timeline'],
  'app.examples.section-input': ['field', 'inputField', 'textareaField'],
  'app.examples.section-select': ['selectField', 'RadioGroup'],
  'app.examples.section-toggle': ['Checkbox', 'SwitchToggle', 'PasswordField'],
  'app.examples.section-number': ['SliderField', 'StepperField'],
  'app.examples.section-composite': ['TagInput', 'KvEditor', 'copyField'],
  'app.examples.section-file-async': ['FileDrop', 'AsyncButton'],
  'app.examples.section-table': ['table'],
  'app.examples.section-tree': ['Tree'],
  'app.examples.section-listrow': ['listRow'],
  'app.examples.section-json': ['JsonViewer'],
  'app.examples.section-json-expand': ['JsonViewer'],
  'app.examples.section-json-keysplit': ['JsonViewer'],
  'app.examples.section-json-shader': ['JsonViewer'],
  'app.examples.section-log': ['LogPanel'],
  'app.examples.section-code': ['codeBlock'],
  'app.examples.section-progress': ['progressBar', 'progressRing', 'segmentedBar'],
  'app.examples.section-stattile': ['statTile'],
  'app.examples.section-exec': ['execResultCard', 'execResults'],
  'app.examples.section-spinner': ['spinner', 'Collapsible'],
  'app.examples.section-loadingmask': ['loadingMask'],
  'app.examples.section-kv': ['sectionTitle', 'keyValue', 'kvGrid'],
  'app.examples.section-badge': ['badge', 'statusDot'],
  'app.examples.section-statusbar': ['statusBar'],
  'app.examples.section-alertbar': ['alertBar'],
  'app.examples.section-empty': ['emptyState', 'emptyAction', 'errorState', 'skeleton'],
  'app.examples.section-tip': ['tipAttrs', 'kbd'],
  'app.examples.section-iconbutton': ['iconButton'],
  'app.examples.section-copybutton': ['copyButton'],
  'app.examples.section-confirmbar': ['ConfirmBar'],
  'app.examples.section-dialogpanel': ['DialogPanel'],
  'app.examples.section-dialog': ['dialog'],
  'app.examples.section-promptdialog': ['promptDialog'],
  'app.examples.section-confirmaction': ['dialog'],
  'app.examples.section-sideaction': ['sideAction'],
  'app.examples.section-codeeditor': ['CodeEditor', 'codeField'],
  'app.examples.section-virtuallist': ['VirtualList', 'scrollToRow'],
  'app.examples.section-linechart': ['LineChart', 'timeSeries'],
  'app.examples.section-dataview': ['DataView', 'createDataView', 'createSplitter'],
  'app.examples.section-i18n-ui': ['i18nSelect', 'i18nButton', 'i18nMenu'],
};

/** 匹配组件名或其关键词是否命中了用户检索词 */
export function matchesComponent(name, query) {
  if (!query) return true;
  const kw = String(query).trim().toLowerCase();
  if (!kw) return true;
  const cls = COMPONENT_CLASS[name] || '';
  if (name.toLowerCase().includes(kw)) return true;
  if (cls.toLowerCase().includes(kw)) return true;
  const meta = COMPONENT_META[name];
  if (meta) {
    if (meta.nameZh && meta.nameZh.toLowerCase().includes(kw)) return true;
    if (meta.keywords && meta.keywords.toLowerCase().includes(kw)) return true;
  }
  const cat = CATEGORY_KEYWORDS[cls];
  if (cat && cat.toLowerCase().includes(kw)) return true;
  return false;
}

/** 返回归属于指定分类的全部组件名 */
export function componentsIn(cls) {
  return Object.keys(COMPONENT_CLASS).filter((k) => COMPONENT_CLASS[k] === cls);
}
