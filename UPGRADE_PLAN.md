# UPGRADE_PLAN.md —— 阅读体验升级执行文档

> 文档版本：v1.0（2026-08-18）
> 状态：批次 1 待启动
> 定位：**M1 优化阶段的执行手册**。三份文档的分工——
> [DEV_GUIDE.md](DEV_GUIDE.md) 管产品是什么（需求/边界/架构，SSOT）；
> [docs/audit-2026-08-18.md](docs/audit-2026-08-18.md) 管问题是什么（77 项审计发现，本文档的全部依据）；
> **本文档管怎么干**（任务卡/验收/进度）。条目级进度只记在这里，DEV_GUIDE 9.2 只记批次级。
> 每完成一项在本文档打勾并注日期；批次完成后同步 DEV_GUIDE 9.2 与更新日志。

---

## 0. 一页速览

- **依据**：2026-08-18 三路只读审计（MPE 标杆 / 现状盘点 / 顺手度），77 项发现：**5 blocker / 33 major / 29 minor / 10 polish**。
- **诊断**：不是零散 bug，是两类系统病——① WebView 浏览器本性未驯服（外链导航走应用、Ctrl+R 丢文档、右键浏览器菜单）；② 大面积"半接线死链路"（后端好了/状态存了/按钮画了，中间没接：缩放、滚动记忆、frontmatter、settings 字段对不上等）。
- **总排期**：四批次共约 12–16 个工作日。
- **总出口**（=「顺手」的定义，对应小而美三原则）：
  1. 任何点击/按键都不会把用户带出应用或丢失状态；
  2. 改文件、切主题、重开文件，**视线永不丢失位置**；
  3. 界面上不存在任何"点了没反应"的元素——能用的能用，没做的置灰；
  4. 同一篇文档的阅读观感与 MPE 并排对比不落下风。

---

## 1. 验收纪律（先于任务卡，约束每一批）

**开发侧自验协议**（每批结束必须全过，才允许交用户）：

| 维度 | 矩阵 |
|---|---|
| 文档 | 用户真实文档（28k 字《小怪与精英升级批》类）+ test-corpus/full-gfm.md + big-10mb.md |
| 窗口宽度 | 窄（~800px）/ 1080p / 2K 最大化 |
| 主题 | 浅色 / 深色 / 跟随系统（运行中切换系统主题） |
| 产物 | 一律 `pnpm tauri build` 的安装包（事实库 #17：cargo build 产物内嵌 devUrl，禁止用于交付） |
| 键盘 | 6.5 快捷键总表逐键 + 浏览器快捷键逐键确认已接管（清单见批次 1.2） |

**交付节奏**：批内问题自己发现自己修，不叫用户；批次完成 → 安装包 + 本批可验清单 → 用户只测一次。
**进度纪律**：勾选必须带日期；跳过或降级必须在该项下注明原因，不允许静默消失。

---

## 2. 批次 1：驯服 WebView、接通断线（3–4 天）

> 目标：5 个 blocker 清零；"点了没反应 / 点了出事故"两类问题绝迹。

### 1.1 链接点击委托 ⬜（blocker，1–2 天）
- [ ] 阅读区 click/auxclick 事件委托，接管所有 `a[href]`
- [ ] 外链 http(s)：preventDefault → tauri-plugin-opener 交系统浏览器（Rust 注册插件 + capabilities 最小权限；ipc.ts 加 `openExternal` 封装）
- [ ] 相对路径 `.md/.markdown/...`（SUPPORTED_EXTENSIONS 命中）：以 baseDir 解析绝对路径 → `fileSession.openPath`；带 `#fragment` 时渲染 settled 后跳锚点
- [ ] 文内 `#锚点`（含脚注/标题锚点/vditor-anchor）：统一走 `jumpToHeading`（平滑 250ms + 16px 留白 + 大纲高亮同步），不污染 history
- [ ] 其余协议（file:/javascript: 等）一律 deny
- [ ] Rust 侧 `on_navigation` 兜底：主窗口除自身 origin 外全部 deny（纵深防御，委托漏了也导航不走）
- 验收：点外链应用纹丝不动、系统浏览器打开；点相对 .md 在应用内打开并计入最近列表；Alt+← 无任何效果

### 1.2 浏览器默认快捷键接管 ⬜（blocker，半天）
- [ ] Rust `with_webview` 取 `ICoreWebView2Settings3`，`AreBrowserAcceleratorKeysEnabled = false`
- [ ] 同时关 `IsZoomControlEnabled`（Ctrl+滚轮缩放整窗的根源）、`AreDefaultContextMenusEnabled = false`（浏览器右键菜单的根源，批次 3 的自绘菜单未到位前先保底屏蔽——正文选中复制走 Ctrl+C 不受影响）
- [ ] 前端按 DG 6.5 白名单重新实现需要的键：Ctrl+R 映射为"重新渲染"（与 F5 同义）
- 验收逐键清单：`Ctrl+R`（重渲染不丢文档）/ `F5`（同）/ `Ctrl+P`（无浏览器打印弹窗）/ `Ctrl+F`（无 WebView 查找条；批次 3 前无动作可接受）/ `Ctrl+U`、`F12`、`F3`、`Alt+←/→`、`Ctrl+L`（全部无效果）/ `Ctrl+C`（复制选中正常）

### 1.3 settings 前后端契约修复 ⬜（blocker，半天）
- [ ] 字段名以 Rust `settings::Settings` 为准，TS 类型与 store 逐字段对齐（当前对不上 → 保存即静默丢失，还会反向覆写）
- [ ] 加前后端序列化对拍单测（Rust 侧 serde 快照 + TS 侧类型断言），锁死契约
- 验收：改字号/主题/缩放 → 重启全部保留

### 1.4 缩放与字号真正生效 ⬜（major，1 天）
- [ ] `.md-content` 字号体系改为 `calc(var(--md-reading-font) * var(--md-zoom))`，标题行高改 em 比例字阶（settings 注入变量，即改即生效）
- [ ] Ctrl+滚轮（阅读区内，preventDefault）→ setZoom ±10；`Ctrl+=`/`Ctrl+-`/`Ctrl+0` 三键
- [ ] 状态栏 zoom% 按钮：点击弹档位菜单（90–150）
- [ ] `codeWrap` 设置接线：容器 `data-code-wrap` 属性 + 一条 CSS 切 pre-wrap
- 验收：缩放对正文生效且顶栏/状态栏不变；重启保留

### 1.5 主题链路补完 ⬜（major，小时级）
- [ ] 状态栏月亮按钮接 `setTheme`（system→light→dark 循环，图标随态）
- [ ] `theme===system` 时挂 `matchMedia('prefers-color-scheme')` change 监听：运行中系统切深浅，界面/hljs/Mermaid 全部跟随
- 验收：白天开到晚上（模拟切系统主题），全界面即时切换

### 1.6 死按钮清零 ⬜（major，小时级）
- [ ] IconButton 加 `disabled` prop（opacity-40 + cursor-default + tooltip"开发中"）
- [ ] 顶栏：查找（批次 3 点亮）/ 导出 / 分享（M2 点亮）→ disabled；"更多"若无内容先隐藏
- 验收：界面上不存在任何"看起来能点、点了没反应"的元素

### 1.7 焦点与键盘基础 ⬜（major，小时级 ×3）
- [ ] 阅读区 main `tabIndex={-1}`，打开文档后 `focus()`；点击左栏后焦点归还阅读区 → PgDn/PgUp/Space/Home/End 原生翻页生效
- [ ] Esc 语义链接线：过滤框有值→清空+失焦；否则 `closeTopLayer()`（现为死代码）
- [ ] 点击已打开的当前文件 → no-op（不重读盘不归零滚动）
- 验收：启动→打开文档→直接按 PgDn 就能翻页；Esc 按语义链逐层退

### 1.8 断线小项打包 ⬜（major/minor，合计 1 天）
- [ ] `file-removed` 前端订阅 → 顶栏 slide-down 警示条（正文保留；file-changed 恢复时自动撤条）
- [ ] 失效路径灰显：后端加批量探测命令，load()/窗口 focus 时回填 missingPaths；失效条目点击给"从列表移除"出路
- [ ] 代码块工具条 `select-none`（修"拖选正文粘出 python 复制"）
- [ ] 错误态分档：编码失败给专属文案（"暂不支持 UTF-16，请转存 UTF-8"），隐藏无意义的重试
- [ ] 拖入不支持类型：danger 遮罩 + 文案，不再静默

**批次 1 出口自验**：1.1–1.8 全勾 + 第 1 节矩阵全过 + 安装包产出。

---

## 3. 批次 2：阅读的连续性（3–4 天）

> 目标出口一句话：**改文件、切主题、重开文件，视线永不丢失位置。**

### 2.1 外部保存刷新零白闪 ⬜（major，1–2 天）
- [ ] 静默刷新改离屏容器渲染：settled 后一次性 `replaceChildren` + 同帧恢复 scrollTop（当前是先清空 DOM、跳顶、最长 8s 后才弹回）
- [ ] silent 刷新不显示 LoadingLine；● 指示点闪烁保留
- 验收：VS Code 里连续保存 5 次，阅读区无白闪、位置纹丝不动（与 MPE 并排对比）

### 2.2 滚动位置记忆接线（FR-16）⬜（major，1 天）
- [ ] scroll 节流 500ms 写"视口首个标题 id + 像素偏移"→ `updateScrollAnchor`（后端命令已备）
- [ ] openPath 渲染 settled 后恢复（id 优先、失效退偏移；主动新开的文档无锚点则顶部）
- 验收：重开 big-10mb.md 回到上次位置 ±1 屏

### 2.3 主题切换 / F5 保位 ⬜（major，小时级）
- [ ] keepTop 条件改为"path 未变即保留"——只有主动换文档才归顶
- 验收：文中部切主题/按 F5，位置不动

### 2.4 表格宽度修复 ⬜（major，半天）
- [ ] 长句单元格恢复换行（width:max-content 策略修正 + 单元格宽度约束生效），只有真超宽表才滚动
- [ ] 所有 table（含嵌套在列表/引用内的）统一 `.md-table-wrap` 包裹，删 `> table` 特判
- 验收：用户真实文档的"进表的东西"那张表正常换行；嵌套宽表只在壳内滚动，阅读区无横向滚动条

### 2.5 frontmatter 属性卡片 ⬜（major，半天）
- [ ] 按 `frontmatterDisplay` 渲染 dl 卡片（样式现成）；raw 模式退化为代码块；hidden 隐藏
- 验收：含 YAML 头的文档不再"信息蒸发"

### 2.6 图片链路补完 ⬜（major，小时级 ×2）
- [ ] `read_markdown` 成功后运行时授权文档所在目录（`allow_asset_dir`）——D 盘/UNC 的配图不再裂
- [ ] CSP `img-src` 追加 https:/http:（仅图片，脚本不动）——外链图"点击加载"真的能加载；占位块补失败态
- [ ] 占位区补"本篇全部加载"入口
- 验收：D 盘文档配图正常；外链图点击可载、失败有文案

### 2.7 窗口几何记忆 ⬜（major，半天）
- [ ] CloseRequested 时存 size/position/maximized；setup 恢复 + 屏幕边界校验（显示器拔掉回落主屏居中）
- 验收：调窗→关→开，原样还原

### 2.8 及时回填与降级反馈 ⬜（minor，半天）
- [ ] 大纲/字数在 DOM 落地后立即回填，不再被 Mermaid settle 绑架（超时文档大纲 8s 才出现 → 即时）
- [ ] isLarge 文档顶部细提示条（规格 DG 6.6 现成）；loading 期旧文 `opacity-40 + pointer-events-none`
- [ ] >50MB 拒开并给明确文案

---

## 4. 批次 3：查找 + 右键菜单（4–5 天）

### 3.1 文档内查找 ⬜（blocker，3 天）
- [ ] FindBar 组件：Ctrl+F 唤起聚焦、输入防抖 80ms 即时高亮、n/m 计数、Enter/Shift+Enter（含 F3/Shift+F3）循环跳转、Esc 关闭归还焦点
- [ ] 命中标记用 **CSS Custom Highlight API**（WebView2 支持；不改 DOM，对 KaTeX/Mermaid 子树免疫）
- [ ] 大文件分段渲染场景：触发查找即后台补全渲染，浮条显示"正在索引…"
- [ ] 顶栏查找按钮点亮
- 验收：big-10mb.md 中查中文词，计数正确、跳转高亮脉冲、无卡顿

### 3.2 应用内右键菜单四套 ⬜（blocker 级体验债，2 天）
- [ ] ContextMenu 组件（此前代理已产出框架：边界翻转/键盘导航/焦点陷阱，复用）
- [ ] **正文菜单 = 用户确认的 MPE 结构**：复制/复制为纯文本/复制全文 Markdown 源 ┃ 导出▸(置灰)/分享▸(置灰)/导入 Obsidian(置灰) ┃ 在浏览器中打开(置灰，依赖 M2 导出)/用其他编辑器打开/在资源管理器中显示/打印(置灰) ┃ 禅模式/缩放▸/主题▸ ┃ 关于
- [ ] 链接上：在浏览器打开 / 在本应用打开（按 href 类型二选一）+ 复制链接地址
- [ ] 图片上：复制图片地址 / 在资源管理器中显示（本地图）
- [ ] 左栏条目：打开 / 打开所在文件夹 / 复制文件路径 ┃ 置顶/取消 ┃ 从列表移除（危险项样式）
- [ ] 输入框保留系统菜单（粘贴/输入法）
- 验收：全应用右键无一处浏览器菜单；置灰项 hover 有"开发中"说明

### 3.3 打开方式 ⬜（major，半天）
- [ ] "用其他编辑器打开源文件"：opener 交系统"打开方式"（用户点名项）
- [ ] 任务栏/Alt-Tab 标题带当前文件名（`setTitle`，补 allow-set-title 权限）
- [ ] 禅模式 F11（隐左栏/大纲/顶栏细化为悬浮窗控），快捷键先登记 DG 6.5

### 3.4 左栏顺手化 ⬜（major/minor，1 天）
- [ ] 条目 hover 右侧浮现 pin 与 ⋯（16px，仅变色不铺底）；操作后 `scrollIntoView({block:"nearest"})` 防跳
- [ ] 键盘导航：容器 roving tabindex，↑↓/Home/End/Enter；过滤框 ↓ 直落第一行
- [ ] 过滤框清空钮 + Ctrl+Shift+F 聚焦；分组折叠态提升到 uiState 不再丢
- [ ] 同文件不同大小写/分隔符去重（前后端同一归一化规则）

---

## 5. 批次 4：排版补完与打磨（2–3 天）

### 4.1 GitHub alerts ⬜（major，1 天）
- [ ] 渲染后处理识别 `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` → 五色 `.md-alert` 块（图标 + 语义边线，深浅 Token；IMPORTANT 紫并入 accent 已在样式桥备注）
- 验收：GitHub 流行 README 样张渲染正确，无裸露标记

### 4.2 排版长尾 ⬜（minor，1 天）
- [ ] details/summary 折叠块：透传 fixture 验证 + 样式（手型/三角/缩进）
- [ ] emoji 短代码 fixture 验证，未启用则显式开
- [ ] `[TOC]`：决策执行——渲染为文内目录（点击走 jumpToHeading）或至少静默移除裸文本
- [ ] `\ce{}` 化学式：决策——打包 mhchem（+few KB）或文档声明不支持
- [ ] Mermaid 语法错误态样式化（错误信息 + 原文代码块回退）
- [ ] 嵌套引用层次区分、链接 hover 状态栏显示目标 URL
- [ ] 代码块行号（设置项，默认关）

### 4.3 布局打磨 ⬜（minor，1 天）
- [ ] 左栏拖宽 264–420 / 大纲拖宽 300–520（先统一三处矛盾常量）+ 持久化
- [ ] 窄窗（<1024）自动折叠左栏（记住手动意图）
- [ ] 图片灯箱（FLIP 放大/滚轮缩放/Esc 关）
- [ ] React ErrorBoundary（错误摘要 + 重新加载 + 日志目录指引）

### 4.4 M1 收尾 ⬜（原 M1-C 并入）
- [ ] 文件关联装包实测（五扩展名、卸载回落）——虚拟机或用户确认的测试机
- [ ] 首启引导页（设为默认三步向导）
- [ ] `--action` 分发（open 已通，headless 动作 M2）
- 验收：M1 全批完成 = **v0.9 内测包**，走 DEV_GUIDE 12 节 M1 出口清单

---

## 6. 进度总表（唯一条目级进度记录处）

| 批次 | 状态 | 开始 | 自验通过 | 用户验收 |
|---|---|---|---|---|
| 批次 1 驯服 WebView、接通断线 | ⬜ 待启动 | — | — | — |
| 批次 2 阅读的连续性 | ⬜ | — | — | — |
| 批次 3 查找 + 右键菜单 | ⬜ | — | — | — |
| 批次 4 排版补完与打磨 | ⬜ | — | — | — |

**已完成的前置项**（2026-08-18，随审计同日落地，视觉自验并入批次 1 出口）：
- [x] github-markdown-css 基底 + Token 变量桥（MPE 同源观感）
- [x] 列宽三态、默认自适应窗口（fluid）
- [x] 表格 .md-table-wrap 滚动壳（顶层；嵌套场景在 2.4）
- [x] 最近列表会话内排序冻结（修"鼠标下重排"）

---

## 7. 更新日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-08-18 | 依据 77 项审计建立执行文档：四批次任务卡、验收纪律、进度表 |
