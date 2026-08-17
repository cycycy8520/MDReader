# MDNaonao for Windows —— 开发指导文档

> 文档版本：v0.3（2026-08-17 修订）
> 状态：✅ 需求与方案已确认（经外部核验修订）/ ⏳ 开发未启动（整体进度 0%）
> 适用对象：本项目唯一/核心开发者、后续接手者、UI 协作方
> 本文档是"唯一事实来源"（Single Source of Truth）：需求、方案、进度以本文件为准，变更必须同步更新本文档并追加"更新日志"。
> v0.2 修订依据：2026-08-17 对 v0.1 的全量技术核验（竞品、PDF 链路、Vditor、Windows 集成、分享 API、参考链接均已联网核实，详见更新日志）。
> v0.3 修订依据：2026-08-17 对参考项目 **DeepSeek Harness 客户端**设计系统的实测提取，据此重写第 5 章视觉基线并修正 6.1/6.3/6.4/6.6 中与之冲突的交互条目。**唯一事实来源的例外**：设计 Token 的上游是 `src/styles/tokens.css`（类名映射在 `tailwind.config.js`），第 5 章是它们的人类可读镜像——改设计先改 Token 文件，再回写本章。

---

## 0. 一页纸速览

- **产品**：Windows 10/11 桌面 EXE，轻量 Markdown 查看器，注册为 .md 系列文件的打开程序（含首启"设为默认"引导）。
- **一句话定位**：打开即看、导出即用、分享即达的 Windows MD 阅读器。**小而美：V1 严格只读，把"看"这一件事做到极致，差异化全押在 Obsidian 一键入库与微信/飞书分享上。**
- **核心能力**：文件关联 + 右键菜单；左侧最近列表；可钉住大纲；文档内查找；外部修改自动刷新；Mermaid/KaTeX 查看；导出 HTML/PDF；一键导入 Obsidian；分享微信（长图）/飞书。
- **技术栈**：Tauri 2（Rust + WebView2）+ React + TypeScript + Vditor（`Vditor.preview()` 只读渲染，资源本地自托管）。
- **形态**：单实例（官方插件路由）、左栏为"最近列表"而非标签页、安装体积 ≤ 25MB、热启动 ≤ 1s、内存分级预算（见 3.2）。
- **竞品结论**（2026-08 核实）：市面无任何产品同时覆盖"轻量默认查看 + Obsidian 入库 + 微信/飞书分享"；最接近的 md-reader（Tauri 2，MIT，5-6MB）恰好缺后两项——渲染查看是红海，生态链路是空白，这就是本产品的立身之本。
- **当前进度**：0%，方案 v0.2 已定稿，待 M0 技术验证。

---

## 1. 目的与定位

### 1.1 为什么做
Windows 上缺少一个"又轻又快、开箱即用、与国内办公生态（微信/飞书/Obsidian）打通"的 MD 查看器：
- Typora 收费且缺生态链路；MarkText 刚从停更中复活（v0.20 重写仍在 RC）；VS Code 太重；网页工具无法做默认关联和右键菜单。
- 国内用户的高频动作是：看一眼 → 导出 PDF/HTML → 发给同事/微信群 → 存进 Obsidian。现有工具每个动作都要切换软件。
- 已核实：Obsidian 官方至今不支持作为 vault 外 .md 的默认打开器（官方论坛长期 feature request），本产品与 Obsidian 是互补关系。

### 1.2 产品定位
- **是**：轻量、**严格只读**的 MD 查看器。
- **不是**：编辑器（V1 完全不做编辑，V2 再评估）、知识库、同步盘、笔记管理、博客系统、插件平台。
- 对标体验：Typora 的阅读排版 + DeepSeek 客户端式的左侧列表布局 + 国产 IM 友好的分享能力。
- **小而美三原则**：功能宁缺毋滥；每个已有功能必须打磨到"顺手"；阅读体验永远优先于功能数量。

### 1.3 成功标准（做完这些就算赢）
1. 完成首启引导（设为默认）后，双击 .md → 1 秒内看到排版良好的内容。（注：Windows 10+ 的 UserChoice 机制禁止应用静默抢默认，引导用户手动确认一次是平台约束，见 2.3-2。）
2. 右键 .md → 一条命令完成"打开 / 转 HTML / 转 PDF / 导入 Obsidian / 分享"（按版本递增，见 9.1）。
3. 最近打开的文件在左侧一栏可见、可点、可过滤、可置顶。
4. 分享到微信群 = **生成长图 → 粘贴发送**两步，排版不糊；分享到公众号编辑器 = 复制富文本粘贴不塌。（微信聊天窗口不支持富文本，这是平台确定性行为，见 2.3-1。）
5. 安装包 ≤ 25MB；Win11 及绝大多数升级过的 Win10 无需装任何运行时，极少数缺失 WebView2 的设备由安装器自动联网补装（约 2MB 引导器）。

---

## 2. 范围与边界

### 2.1 范围内（In Scope）

| 编号 | 能力 | 说明 | 优先级 | 交付版本 |
|---|---|---|---|---|
| F1 | MD 渲染查看 | GFM、表格、任务列表、脚注、Mermaid、KaTeX、代码高亮、图片、frontmatter 属性卡片 | P0 | M1 |
| F2 | 文件关联 + 默认引导 | 注册 .md/.markdown/.mdown/.mkd/.mkdn 候选程序；首启引导页一键跳 `ms-settings:defaultapps` 设默认 | P0 | M1 |
| F3 | 左侧最近列表 | 时间分组、置顶、移除、打开所在目录、复制路径；过滤 v1.0 | P0 | M1 简版 / v1.0 完整 |
| F4 | 大纲 | 右侧**可钉住**面板：浮层态 / 钉住态，钉住态随滚动高亮 | P0 | M1 |
| F5 | 文档内查找 | Ctrl+F 浮条：全部命中高亮、n/m 计数、Enter/Shift+Enter 跳转 | P0 | M1 |
| F6 | 外部修改自动刷新 | notify 监听当前文件，变更后防抖重渲染并保持滚动位置 | P0 | M1 |
| F7 | 右键菜单 | .md 右键动词：M1=打开/转 HTML；v1.0 +转 PDF；v1.1 +导入 Obsidian/分享 | P0 | M1 起递增 |
| F8 | 命令行参数 | `--action open/export-html/export-pdf/... <file>` 供右键菜单无 UI 直跑 | P0 | M1 |
| F9 | 主题 | 深色/浅色/跟随系统（**首启默认跟随系统**）；字号、缩放可调 | P0 | M1 |
| F10 | 导出 HTML | 两个显式选项：单文件（全部 base64，默认）/ HTML+资源文件夹 | P0 | M1 单文件 / v1.0 完整 |
| F11 | 导出 PDF | 静默导出 A4 PDF，中文字体正确；文内目录页可选（PrintToPdf 无书签能力） | P0 | v1.0 |
| F12 | 打印 | Ctrl+P，复用 PDF 打印模板走系统打印对话框 | P1 | v1.0 |
| F13 | 滚动位置记忆 | recent.json 记录锚点，重开恢复 | P1 | v1.0 |
| F14 | 导入 Obsidian | 自动发现 Vault、选目标目录、复制文件+附件、URI 唤起定位 | P1 | v1.1 |
| F15 | 分享微信 | **长图（主路径，聊天场景）** + 富文本复制（公众号编辑器场景） | P1 | v1.1 |
| F16 | 分享飞书 | **默认：复制富文本→引导粘贴进飞书文档（零配置）**；进阶：自建应用 API 生成云文档 | P1 | v1.1 |
| F17 | 分享钉钉 | 复制富文本 / 长图 / 发送文件（钉钉无公开导入 API，见 2.3-4） | P2 | v1.1 |
| F18 | 快速切换 | Ctrl+K 最近文件模糊搜索浮层 | P2 | V2 |

### 2.2 范围外（Out of Scope，明确不做）

| 不做的事 | 原因 |
|---|---|
| **编辑（含"轻编辑"）** | V1 严格只读。编辑会引入脏状态、保存冲突（与 F6 file watch 直接冲突）、撤销栈与安全边界，成本远非"≈0"；V2 凭用户反馈再评估 |
| 多端同步 / 云存储 | 本地优先，Obsidian/网盘自行解决 |
| 完整知识库、双链图谱、标签系统 | 那是 Obsidian 的事 |
| 移动端 / macOS / Linux | 本期仅 Win10/11 x64 |
| 插件系统 | V2 再评估 |
| 多人实时协作 | 分享出去的 HTML/PDF/长图是快照 |
| 邮件、Slack、Notion 等其他分享渠道 | 预留接口，不实现 |
| 钉钉 API 导入通道 | 钉钉无公开文档导入 API（已核实，见 2.3-4），V2 视官方开放再评估 |
| 自动更新服务 | V1 提供"检查更新"入口；自动更新 V2 |
| 便携版（portable） | V1 不提供：数据目录/注册表/关联的双轨维护成本与"小而美"冲突；V2 若做则为 zip 直跑+数据写程序目录+可选注册脚本 |
| 遥测/自动上报 | V1 无任何自动遥测（合规与信任优先）；崩溃诊断走用户主动复制/打包日志，见 11.5 |
| .mdx | JSX 语法超集，按普通 MD 尽力渲染，不承诺正确性 |

### 2.3 硬性平台约束（不可绕过的现实，产品文案与验收必须与之一致）
1. **微信聊天窗口（私聊/群聊）不支持富文本**——粘贴富文本必然退化为纯文本，这是确定性行为而非风险。个人微信也没有开放 API。聊天场景唯一"排版不糊"的方案是**长图**；富文本复制只对公众号图文编辑器等富文本容器有效。
2. **Windows 10+ 的 UserChoice 机制**（带系统哈希保护）禁止应用静默把自己设为默认程序。安装器只能注册"候选程序"；用户必须在"打开方式"或"设置→默认应用"里手动选择一次。首启引导页因此是 P0 流程而非帮助链接。UserChoice 注册表键**永远不碰**（篡改会被系统重置关联）。
3. **飞书 API 需要自建应用**：个人版飞书账号（未加入任何组织）不能创建自建应用，需先免费创建一个团队（一人即可）→ 再到 open.feishu.cn 建"企业自建应用"拿 app_id/secret。引导为四步（见 8 节）。零配置的"复制富文本→粘贴进飞书文档"路径永远可用。
4. **钉钉无公开的文档导入 API**（2026-08 核实）：官方 API 列表不存在"上传 .md 生成在线文档"接口；"创建知识库文档"只能建空框架且第三方个人应用不支持。钉钉聊天粘贴富文本同样退化为纯文本。
5. **Win11 新版右键菜单**只加载实现 IExplorerCommand 且具有包身份（MSIX/稀疏包）的 COM 处理器；HKCU 注册的传统 verb 进"显示更多选项"属设计行为而非 bug。一级菜单是 V2 工作，且前置依赖代码签名证书（稀疏包必须可信签名）与自研 COM 组件（预估 1–2 周）。

---

## 3. 需求规格

### 3.1 功能需求（节选，完整验收清单见第 12 节）
- FR-01 渲染分档：≤2MB 热启动 1s 内全量渲染；2–5MB 首屏 1s、剩余后台续渲；>5MB **直接打开**+顶部提示条+分段渲染（不弹打开前确认，少一次点击）。
- FR-02 左侧栏分组：置顶 / 今天 / 昨天 / 近 7 天 / 更早；每项显示文件名、父文件夹尾段、相对时间。
- FR-03 左侧栏操作：过滤（**Ctrl+Shift+F** 聚焦，输入即过滤、命中高亮、Esc 清空）、置顶/取消、从列表移除（不删文件）、打开所在文件夹、复制文件路径。路径失效条目灰显，点击提示并可一键移除。
- FR-04 大纲两态：浮层态（默认，覆盖式、无遮罩、点击外部收起）；**钉住态**（右侧常驻 300px，阅读区自适应收窄，随滚动高亮当前章节，支持折叠、点击平滑跳转）。无标题文件隐藏大纲入口。尺寸以 5.2 为准。
- FR-05 文档内查找：Ctrl+F 唤起浮条；全部命中高亮 + 当前命中强调；显示 n/m 计数；Enter/Shift+Enter 上下跳转；Esc 关闭。分段渲染场景下触发查找即后台完成剩余渲染，期间浮条显示"正在索引…"。
- FR-06 文件监听：当前文件被外部修改 → 防抖 300ms 自动重渲染并保持滚动位置；被删除/移动 → 顶栏警示条"文件已被移动或删除"+[从列表移除]/[重新定位]。
- FR-07 导出 HTML：导出对话框两个显式选项——单文件（图片全部 base64 内联，提示体积可能较大，默认）/ HTML+资源文件夹（`xxx_files/`）；双击可离线打开、样式与预览一致、图片不丢失（按所选模式验收）。
- FR-08 导出 PDF：A4、中文字体嵌入正确、代码块不截断换行；"目录"为文内目录页（PrintToPdf 不产生 PDF 书签，如实告知用户）。
- FR-09 导入 Obsidian：读全局 obsidian.json 列出 Vault，可选子目录；同名冲突提示覆盖/改名；附件图片复制到 vault 附件目录并重写链接；完成后 `obsidian://open` 唤起定位。
- FR-10 微信分享：①长图（主路径）：CDP 全页截图生成 PNG → 写剪贴板/另存 → 用户粘贴到聊天窗口；②富文本（公众号场景）：内联样式 HTML + 纯文本双格式写剪贴板。
- FR-11 飞书分享：默认通道一键复制富文本 + 提示"粘贴到飞书文档即可保留排版"；进阶通道完成四步配置后一键生成云文档并打开链接，失败自动降级默认通道。
- FR-12 单实例：第二个 .md 经 tauri-plugin-single-instance 回调路由到主实例打开/切换，新进程即退。
- FR-13 拖拽 .md 到窗口任意位置打开；拖入过程全窗显示虚线遮罩"松开以打开文件"。
- FR-14 frontmatter（YAML）：默认折叠为文档顶部"属性"卡片（键值表），设置项"显示元数据"可切为隐藏/原文。
- FR-15 链接行为矩阵：外链单击 → 默认浏览器打开（状态栏悬停预览 URL）；指向本地 .md 的相对链接 → 本应用打开并计入最近列表；锚点链接 → 文内平滑跳转；右键任意链接 → 复制链接。
- FR-16 滚动位置记忆：重开文件恢复到上次位置（记录首个可见标题锚点+偏移）。
- FR-17 打印：Ctrl+P 调起系统打印对话框，使用与 PDF 相同的打印模板。
- FR-18 钉钉分享：复制富文本（面向钉钉文档编辑器粘贴）/ 长图 / 发送文件三条路径（聊天窗口粘贴富文本必退化为纯文本，见 2.3-4）。
- FR-19 阅读区复制：右键提供三种复制——复制（富文本+纯文本双格式）、复制为纯文本、复制为 Markdown 源；产物分别与所见排版、无格式文本、原文片段一致。

### 3.2 非功能需求（NFR）

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 安装包体积 | ≤ 25MB（Vditor 资源按 8 节"Vditor 资源自托管"白名单裁剪后打入） | NSIS 产物实测 |
| 内存（空载或打开 ≤1MB 文件） | ≤ 150MB | 见口径说明 |
| 内存（打开 10MB 文件） | ≤ 250MB | 见口径说明 |
| 内存红线 | 任何场景 > 250MB 视为 bug | 见口径说明 |
| 热启动（实例已存在，双击路由） | ≤ 1s：自单实例回调收到路径至首帧渲染完成 | 高速摄像/性能日志 |
| 冷启动 | ≤ 3s：自进程创建至首帧（含 ≤300ms splash） | 基准机实测 |
| 10MB 大文件 | 不白屏、滚动均值 ≥ 50fps（分段渲染下） | 语料库压测 + DevTools 帧率 |
| 崩溃 | 内测样本（≥10 人 × 1 周）阅读场景零崩溃反馈 | 崩溃反馈通道（11.5） |
| 安全 | XSS 三层防御（Lute sanitize + DOMPurify + CSP）全部默认开启 | 恶意样本集全过 |

> **内存统计口径**：主进程 + 全部 WebView2 子进程的专用工作集（Private Working Set）之和，Process Explorer 或任务管理器"详细信息"页实测。基准机配置见 11.4。

---

## 4. 技术选型

### 4.1 总览与理由（v0.2 按"官方现成能力优先"修订）

| 层 | 选型 | 理由 | 备选/弃选 |
|---|---|---|---|
| 桌面壳 | **Tauri 2.x**（Rust + WebView2） | 轻量（壳 5-10MB）、系统集成强、前端生态全 | Wails(Go)；Electron（体积原因弃选） |
| **官方插件（能用现成绝不自研）** | **tauri-plugin-single-instance**（单实例 + 第二实例 argv/cwd 回调转发，内部即 CreateMutexW+WM_COPYDATA）；**tauri-plugin-cli**（`--action` 解析，基于 clap）；**tauri-plugin-clipboard-manager**（`write_html(html, alt_text)` 一次写入 CF_HTML+纯文本双格式，底层 arboard 自动生成 CF_HTML 头） | 三处 v0.1 拟自研项全部有官方实现，久经生产验证 | 自研 Mutex+命名管道、自建 CF_HTML 包装（v0.1 方案，废弃） |
| 文件关联 | **tauri.conf.json `bundle.fileAssociations`**（ext 数组一次关联全部扩展名） | NSIS 安装器自动注册+卸载时恢复旧值备份+SHChangeNotify 刷新，比手写 winreg 完整 | 手写 winreg 注册关联（v0.1 方案，废弃；winreg 仅保留给额外右键动词） |
| 渲染内核 | **Vditor ≥3.11.3**（MIT，2026-08 仍活跃发版）：只读用 `dist/method.min.js`（52KB）的 `Vditor.preview()`，**不加载完整编辑器** | 一个依赖覆盖 GFM/Mermaid/KaTeX/高亮/脚注/任务列表；大纲用独立的 `Vditor.outlineRender()`；中文排版友好（autoSpace） | markdown-it(21.8k★)+6-8 个插件自组（体积最省但需自研大纲/导出且插件版本自维护）；marked/remark 需另配消毒；milkdown 是编辑器框架、只读过重。体积差额仅 lute.min.js ≈3.7MB 原始（压缩后约 1MB），25MB 预算内可接受 |
| 前端框架 | React 18 + TypeScript + Zustand + Tailwind CSS + DOMPurify（XSS 第二层，见 8 节） | 官方模板成熟；Token 化主题 | Vue3；Svelte |
| 系统集成（Rust） | `winreg`（仅额外右键动词）、`notify`（文件监听）、`windows`/`webview2-com`（PrintToPdf COM 桥接，版本必须与 Tauri 内部 wry 精确对齐，用 `cargo tree` 核对）、`reqwest`（飞书 API）、`serde`、`clap`（--action 解析复用）、`thiserror`+`tracing`/`tracing-appender`（错误与日志） | 成熟 crate | — |
| PDF 生成（主） | WebView2 `ICoreWebView2_7.PrintToPdf`（隐藏窗口静默打印）。wry 0.56 仍只有弹窗 print()（wry#707 至今 open），COM 自行桥接是唯一主路线，社区无现成"PDF 生成"插件（tauri-plugin-printer 系仅做送打印机） | 渲染引擎与预览同源（同一 WebView2），唯一保证"预览=导出"；中文字体由 Chromium 打印管线自动子集化嵌入 | typst/weasyprint：渲染与预览不一致（Mermaid/打印 CSS/中文字体失真）且引入大依赖，弃选 |
| PDF 生成（兜底 A） | **headless_chrome 或 chromiumoxide 经 CDP 驱动系统 msedge.exe 调 `Page.printToPDF`** | 规避 Edge headless CLI 回归（见下） | — |
| PDF 生成（兜底 B，最后手段） | `msedge --headless --print-to-pdf`（加 `--no-pdf-header-footer`） | **已知脆弱**：Edge 141（2025-10）起存在"无报错不出文件"回归（Chromium #381548416），workaround `--headless=old` 已自 Chromium 132 移除 | — |
| 长图截图 | WebView2 自带 CDP 通道（CallDevToolsProtocolMethod）调 `Page.captureScreenshot`，**必须设 `captureBeyondViewport: true`**——默认与 CapturePreview 一样只截可视区，截不出长图；超长页面受 GPU 纹理上限（约 16384px）限制，超限强制分段截图拼接 | 与预览渲染同源，规避 html-to-image 的 foreignObject 字体丢失，少一个前端依赖 | 隐藏窗口调成内容全高后截图 / 分段拼接；html-to-image（前端备选）。**CapturePreview 仅截可视区，不用于长图** |
| 存储 | 最近列表/配置均 JSON，`%APPDATA%\MDNaonao\`；飞书密钥 DPAPI 加密 | 数据量小免数据库；V2 全文检索再上 SQLite FTS5 | SQLite |
| 打包/安装 | tauri-bundler → NSIS；`webviewInstallMode: downloadBootstrapper`（默认，体积 +0，缺 WebView2 时联网补装约 2MB）；installerHooks 清理自写注册表键 | 25MB 预算下唯一可行模式 | embedBootstrapper(+1.8MB)；offlineInstaller(+127MB，弃) |
| 飞书 SDK | 自封装 REST（reqwest）：`medias/upload_all` + `import_tasks` 两个接口而已 | 接口少，自封装比拉 SDK 轻 | oapi-sdk-rust |

> 注意：`msedge.exe` 与 WebView2 Runtime 是两个安装体（Runtime 只含 msedgewebview2.exe）。兜底路线运行时必须经注册表 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe`（及 HKCU）探测 Edge 真实路径，探测失败则隐藏兜底选项，不得硬编码 Program Files 路径，也不得以"应用能跑"推断 msedge.exe 存在。

### 4.2 版本基线
- Rust stable（edition 2021+）；Tauri 2.x；React 18+；**Vditor ≥3.11.3**（其内置 Mermaid 11.x、KaTeX）；Node 20+；pnpm。
- **M0-0 实测环境（2026-08-17 建仓时）**：rustc/cargo 1.97.1、Node 22.19.0、pnpm 11.22.0、tauri 2.11.5、wry 0.55.1 → **webview2-com 0.38.2 / windows 0.61.3**（红线 10 的锁定值，已写入 src-tauri/Cargo.toml 注释）。
- M0 结束时把全部依赖冻结为**精确版本号**写入 `rust-toolchain.toml` / `Cargo.lock` / `package.json` 并回填本节；升级需在更新日志备案。
- `webview2-com` / `windows` crate 版本跟随 Tauri 锁定（`cargo tree` 核对），否则 COM 接口类型不兼容。

---

## 5. UI / 视觉规范

> 布局参考 DeepSeek 客户端的"左栏 + 主区"结构：左侧是**最近文件列表**（相当于会话列表；**不是标签页**，点击=打开/切换该文件，无"关闭"概念），主区是阅读区。视觉关键词：**克制、聚焦阅读、现代扁平、少量高级感细节**。

> **本章基线（v0.3 起）**：以下全部色值、尺寸、字号、圆角、阴影、动效数值**不再是自拟设计**，而是 2026-08-17 对参考项目 **DeepSeek Harness 客户端**设计系统的**实测提取**结果（读其 `ui-theme` 样式源码 + 运行态取色/量距双向核对）。
> **Token 的唯一定义处是 `src/styles/tokens.css`；类名映射的唯一定义处是 `tailwind.config.js`。** 本章是这两个文件的人类可读镜像，**不是它们的上游**。
> 因此改设计的顺序永远是：**① 改 `tokens.css` → ② 回写本章 → ③ 才动组件**。反过来（先在组件里试色再补文档）一律视为违规。组件层出现裸色值/裸尺寸同样违规（红线 14）。
> 与之配套：`tailwind.config.js` 用 `theme.colors` **覆盖**（而非 extend）了 Tailwind 默认调色板——`gray-500`、`blue-600` 这类类名在本项目里**编译不出任何样式**，这是刻意的护栏。

### 5.1 总体布局（ASCII 线框）

```
┌─────────────────────────────────────────────────────────────────┐
│  [☰] MDNaonao  文件名.md             [查找][大纲][导出▾][分享▾][•••] │ ← 顶栏 40px（自绘，整条为拖动区）
├───────────┬─────────────────────────────────────┬───────────────┤
│ [过滤…]   │                                     │ ▸ 大纲(钉住态) │
│ 置顶      │        阅读区（内容列宽 748px 居中）  │   H1 xxx      │
│ ▸ 文件P   │   # 标题一                           │   H2 xxx ←高亮│
│ 今天      │   ……正文、表格、代码块、Mermaid……     │   H2 xxx      │
│ ▸ 文件A   │                                     │               │
│ ▸ 文件B   │                                     │ (未钉住时此栏  │
│ 昨天      │                                     │  为浮层,阅读区 │
│ ▸ 文件C   │                                     │  占满右侧)    │
├───────────┴─────────────────────────────────────┴───────────────┤
│ 12,345 字 · 234 行 · UTF-8            [100%] [Aa] [主题] │ ← 状态栏 26px
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 区域规格

| 区域 | 尺寸（实测基线） | Token / 类名 | 行为 |
|---|---|---|---|
| 顶栏 | 高 **40px**，自绘 | `--md-topbar-h` / `h-topbar` | 左：菜单折叠钮 + 文件名（修改中文件带 ● 刷新指示 200ms 闪烁）；右：查找、大纲、导出（HTML/PDF/打印）、分享（微信/飞书/钉钉）、更多（导入 Obsidian、设置、检查更新、关于）；整条空白区为窗口拖动区，双击最大化 |
| 左侧栏 | 默认 **280px**，可拖拽 **264–420px**；折叠态 **56px**（只留图标）；**窗口宽 <1024px 自动折叠** | `--md-sidebar-w/-min/-max/-collapsed` / `w-sidebar`、`w-sidebar-collapsed` | 顶部过滤框（Ctrl+Shift+F 聚焦）；置顶分组 + 时间分组列表；底部设置入口。Ctrl+B 手动折叠；自动折叠只在越过阈值的那一刻生效，之后用户手动展开不再被强制收回（本次会话内） |
| 阅读区 | 内容最大宽 **748px** 居中，**最小 640px**（窗口再窄则整体收窄不再居中留白），两侧留白自适应 | `--md-reading-w/-min` / `max-w-reading` | 垂直滚动；标题锚点供大纲跳转 |
| 大纲面板 | 默认 **300px**，可拖拽 **300–520px** | `--md-outline-w` / `w-outline` | 两态：浮层（默认收起，按钮/Ctrl+Alt+O 呼出，无遮罩，点外部收起）；钉住（📌 后常驻，阅读区收窄，滚动高亮生效）。钉住状态持久化 |
| 查找浮条 | 顶部居中浮出，宽 360px | — | Ctrl+F 呼出；输入框 + n/m 计数 + 上/下 + 关闭 |
| 状态栏 | 高 **26px** | `--md-statusbar-h` / `h-statusbar` | 左：字数/行数/编码（渲染耗时仅开发模式显示）；右：缩放（90%–150%，Ctrl+滚轮/Ctrl+=/Ctrl+-/Ctrl+0 复位）、字号、主题切换 |

**控件高度契约**（实测：参考项目的行高档位极少，只有这几档，不允许现场发明新高度）：

| 用途 | 高度 | 类名 |
|---|---|---|
| 列表行（左栏条目、大纲条目、菜单项） | 32px | `h-row` |
| 分组标题行（置顶/今天/昨天…） | 34px | `h-row-group` |
| 常规按钮 | 36px | `h-btn` |
| 紧凑按钮（顶栏图标钮、浮条内按钮） | 28px | `h-btn-sm` |
| 输入框（过滤框、查找框） | 32px | `h-input` |

> 三栏宽度全部走 CSS Grid 列宽，宽度变化时长 300ms（见 6.3）；折叠/展开与钉住切换共用同一条过渡。

### 5.3 左侧最近列表细节（产品重点）
- **数据模型**：这是"最近打开历史"，非打开中的标签集合。条目 = `{path, title, openedAt, pinned, scrollAnchor}`；标题取首个 H1，无则文件名；上限 200 条 LRU。
- **条目结构**：行高 32px，左右内边距 8px；第一行文件名 `text-ui`（14/22）单行截断，第二行 `text-ui-xs`（12/18）`text-caption` 小字"父文件夹名 · 相对时间"。
- **选中态 = hover 态**（v0.3 修正，实测结论）：**当前打开项 = 整块半透明底色 `bg-hover` + 8px 圆角（`rounded-row`），与 hover 用同一枚颜色**；鼠标移开后底色仍在，这就是"选中"的全部表达。文字不加粗、不换色，**没有左侧竖条、没有边框、没有品牌色**。
  > **为什么删掉 v0.2 的"左侧 3px 品牌色竖条"**：实测参考项目**全站零竖条**。三个硬理由：① 本项目品牌主色已改为近黑/近白（见 5.5），竖条会变成一道脏黑边或在深色下变成刺眼白条；② 半透明叠加色天然适配任何底色层级（叠在 canvas/panel/card 上都成立），竖条则要为每个主题、每个底色各调一次；③ 竖条与 8px 圆角整块高亮同时存在时，竖条会被圆角切掉两头，视觉上永远对不齐。**hover 与选中同色**不会引起歧义——鼠标只有一个，移开即消失的是 hover。
- **置顶**：置顶分组位于最上，条目悬浮 ⋮ 或右键操作。分组标题行 34px，`text-ui-xs` + `text-caption`。
- **右键菜单**：打开所在文件夹 / 复制文件路径 / 置顶(取消) / 从列表移除（不删文件）。
- **失效条目**：文件被移动/删除后整行 `opacity-40`（不换色，见 6.4）；点击提示并提供[移除]/[重新定位]。
- **空状态**：**一行 13px/20px（`text-ui-sm`）的 `text-tertiary` 文字**——"拖入 Markdown 文件，或 Ctrl+O 打开"，下方 [打开文件] + [设为默认查看器] 两个文字按钮（后者跳首启引导流程）。**不画插画、不做骨架屏、不加图标**（v0.3 修正，实测参考项目的空态一律是单行淡字，全局口径见 6.6）。

### 5.4 阅读排版（对标 Typora 阅读质量）

**字号 / 行高 / 字重**（实测值，全部已进 `tailwind.config.js` 的 `fontSize`，只准用类名）：

| 用途 | 字号/行高 | 字重 | 类名 |
|---|---|---|---|
| 正文 p | **16px / 28px** | 400 | `text-body` |
| H1 | **24px / 34px** | **700** | `text-h1` |
| H2 | **22px / 32px** | **700** | `text-h2` |
| H3 | **20px / 30px** | **700** | `text-h3` |
| H4 | 16px / 28px | 600 | `text-h4` |
| 代码块 | 13px / 22px | 400 | `text-code-block` |
| 行内代码 | 0.875em（随行 14px / 22px） | 400 | `text-code-inline` |
| UI chrome（顶栏/左栏/菜单） | 14px / 22px | 400 | `text-ui` |
| 次要 UI（空态、说明、按钮小字） | 13px / 20px | 400 | `text-ui-sm` |
| 元信息（时间、分组标题、计数） | 12px / 18px | 400 | `text-ui-xs` |

> 注意 v0.2 写的"行高 1.75 / H1 28px / H2 22px / H3 18px"是自拟值，已作废。新基线里**行高一律写死 px 不写倍数**（倍数在混排中英文时会因字体差异漂移），且 **H1–H3 全部 700 而非 600**——实测参考项目标题层级靠"字号 + 间距"拉开，字重只有 700/600/400 三档。

**Markdown 块级间距配方**（实测抄录，逐条落在渲染样式表里，不许现场估）：

| 元素 | 上间距 | 下间距 | 其他 |
|---|---|---|---|
| `p` | 16px | 16px | `overflow-wrap: anywhere` |
| `h1` / `h2` / `h3` | **32px** | **16px** | 首元素为标题时上间距归零 |
| `h4`–`h6` | 24px | 12px | — |
| `ul` / `ol` | 16px | 16px | **左 padding 18px**（非默认 40px）；嵌套层继承同值 |
| `li` | — | — | **相邻 li 间距 6px**；`li > p` 不再叠加段间距 |
| `hr` | **32px** | **32px** | 1px `border-l2`，无阴影 |
| `blockquote` | 16px | 16px | **左 2px 实线（`border-l3`）+ 左 padding 14px**；文字 `text-secondary`；**无底色**（v0.2 的"浅灰底"作废——底色会在深色主题下与 card 层撞色） |
| 行内 `code` | — | — | 字号 **0.875em**、圆角 **6px**（`rounded-chip`）、**padding 0 5px**、底色 `bg-inline-code`（纯透明度叠加），无边框 |
| `table` `th`/`td` | — | — | **padding 10px 16px**；`th` 底色 `bg-panel` + 字重 600；行分隔线 `border-l1`；**斑马纹取消**（实测参考项目只用分隔线，斑马纹在深色下太脏）；横向溢出在表格容器内滚动，不撑破页面 |
| `pre`（代码块） | 16px | 16px | 圆角 **12px**（`rounded-card`）、底色 `bg-code`、**pre 内 padding 16px**、无边框；**顶部语言条 `sticky`**（横向滚动时语言标签与复制按钮不跟着跑掉），语言名 `text-ui-xs` + `text-tertiary` |
| `img` | 16px | 16px | 圆角 6px、1px `border-l2`、最大宽 100% |

- 代码块其余规格：等宽栈见 5.6；右上角语言标签 + 复制按钮（hover 显现，`opacity` 120ms 过渡）；**屏显默认横向滚动**，设置项"代码折行"可切。
- 长内容规则：正文 `overflow-wrap: anywhere` 处理超长 URL/无空格串；嵌套列表最多视觉缩进 4 级后收敛。
- 引用块：见上表——**左 2px 中性实线 + 左 padding 14px + 次要文字色，无底色、非品牌色**（v0.2 的"3px 品牌色竖条 + 浅灰底"作废，理由同 5.3）。
- 图片：圆角 6px、细边框、点击放大（灯箱）、最大宽 100%；**外链图片默认不加载**——显示占位条 +「点击加载」，加载完成后再点进灯箱（与本地图片行为区分，安全见 10 节第 3 条）。
- frontmatter：折叠"属性"卡片（FR-14）。
- 任务列表、脚注、删除线等 GFM 全部还原 Typora 观感。
- 衬线阅读模式（思源宋体回退）为 V2 项。

### 5.5 色板（Design Tokens）

> v0.2 的自拟 GitHub 风蓝黑色板（`#0E1116` / `#4C8DF6` 那一套）**已整体作废**。以下为实测提取结果，唯一定义处 `src/styles/tokens.css`。

#### 5.5.1 两层 Token 结构（这是整套体系的骨架，不可绕过）

```
第 1 层  --md-static-*   原始色阶（neutral / dark / accent / 状态色）
                         ⤷ 明暗共用，全局只定义一次，组件永远不直接引用
第 2 层  --md-*          语义别名（bg-canvas / text-primary / border-l2 …）
                         ⤷ 组件只引用这一层；主题切换 100% 只发生在这一层
```

- **加新颜色的唯一合法路径**：先在静态层加一档色阶 → 再在浅色块与深色块里各绑一次语义名 → 最后才在 `tailwind.config.js` 暴露类名。
- 深色主题**只重绑语义层，静态色阶一个字不改**。主题落地：默认跟随系统（`prefers-color-scheme`），显式切换写 `<html data-theme="light|dark">`（显式优先级高于媒体查询）。

#### 5.5.2 背景层（浅色四层几乎全白，层次靠描边与阴影拉开）

| 语义 Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--md-bg-canvas` | `#FFFFFF` | `#151517` | 主背景 / 阅读区 |
| `--md-bg-panel` | `#F9FAFB` | `#1B1B1C` | 左侧栏、顶栏、表头（**浅色下唯一降一档的层**） |
| `--md-bg-card` | `#FFFFFF` | `#232324` | 卡片、菜单、弹窗 |
| `--md-bg-layer` | `#FFFFFF` | `#353638` | 更高浮层（浮层上的浮层、二级菜单） |
| `--md-bg-code` | `#F5F6F7` | `#232324` | 代码块底 |
| `--md-bg-inline-code` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.08)` | 行内代码底（半透明，叠在什么层都成立） |

> **深色的分层靠实色台阶** `#151517 → #1B1B1C → #232324 → #2C2C2E → #353638`（越浮起越浅，标准 elevation），**不靠阴影**。浅色反过来：四层几乎都是纯白，靠描边 + 阴影分层。这条不对称是"像不像"的关键之一。

#### 5.5.3 交互叠加色（hover 与选中共用同一枚）

| 语义 Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--md-bg-hover` | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` | **hover 与列表选中态共用**（见 5.3） |
| `--md-bg-active` | `rgba(38,49,72,.10)` | `rgba(255,255,255,.14)` | 按下 / 强调选中（如右键菜单当前项） |
| `--md-bg-hover-danger` | `rgba(236,19,19,.05)` | `rgba(242,90,90,.15)` | 危险项（删除、移除）的 hover |

> 全部是**半透明叠加**而非实色，这样同一枚颜色叠在 canvas / panel / card 上都自动成立，不必为每层各配一色。浅色的 `rgba(38,49,72,…)` 是偏冷的蓝灰而非纯黑，这点肉眼可辨。

#### 5.5.4 边框（四档纯透明度叠加，绝不用实色）

| 语义 Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--md-border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` | 最弱：**已有底色差的分界**（左栏右边界、表格行线） |
| `--md-border-l2` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` | 常规：同底色区域的分界（大纲栏左边界）、输入框静态描边、图片边 |
| `--md-border-l3` | `rgba(0,0,0,.12)` | `rgba(255,255,255,.16)` | 强调：hover 态描边、引用块竖线 |
| `--md-border-l4` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.20)` | 最强：分隔重区块 |
| `--md-border-float` | `rgba(0,0,0,0)`（全透明） | `rgba(255,255,255,.06)` | 浮层描边：**浅色纯靠阴影不描边**，深色补一道发丝高光 |

> **分隔线用极低对比度**是铁律。选档规则：**底色已经不同 → 用 l1；底色相同 → 用 l2**。所以左栏右边界是 `border-l1`（左栏本身有 panel 底色，已成分界），大纲栏左边界是 `border-l2`（大纲与阅读区同为 canvas 底色，需要更明显一档）。

#### 5.5.5 文字（四档 + 反色）

| 语义 Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--md-text-primary` | `#0F1115` | `#F9FAFB` | 正文、标题、当前项 |
| `--md-text-secondary` | `#61666B` | `#CFD3D6` | 次要文字、引用块、图标 hover 态 |
| `--md-text-tertiary` | `#81858C` | `#ADB2B8` | **图标默认色**、空状态文字、占位符 |
| `--md-text-caption` | `#ADB2B8` | `#81858C` | 时间戳、分组标题、计数（最淡一档） |
| `--md-text-disabled` | `#E1E5EE` | `#43454A` | 仅用于确实需要"看不清"的场景；**常规禁用态请用 `opacity-40`**（6.4） |
| `--md-text-inverted` | `#FFFFFF` | `#0F1115` | 主按钮上的字 |

> 主文字是 `#0F1115` 而**不是纯黑**、深色主文字是 `#F9FAFB` 而**不是纯白**——这是整套气质偏冷、不刺眼的来源。深浅两套文字色是**互为镜像**的关系（tertiary/caption 在两个主题里刚好对调），不要单独调其中一个。

#### 5.5.6 品牌色与强调色（最容易做错的一条）

| 语义 Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--md-brand` | **`#0F1115`（近黑）** | **`#F9FAFB`（近白）** | **主按钮底色**、输入框聚焦描边 |
| `--md-brand-hover` | `#43454A` | `#EBEEF2` | 主按钮 hover |
| `--md-accent` | `#4176E6` | `#679EFE` | **仅限**：链接、焦点环、进度条、选中文本高亮 |
| `--md-accent-soft` | `#E4EDFD` | `#34415B` | 强调色的浅底（查找命中高亮、提示条底） |

> **主按钮是近黑/近白（`bg-brand text-inverted`），不是蓝色。** 这是与 v0.2 差别最大的一条，也是"像 / 不像"的第一眼判据。蓝色在本系统里**不是品牌色**，它只是"可点击的链接 + 焦点提示"的功能色，出现频率极低。任何把 accent 用作按钮底色、选中底色、竖条色的写法都是错的。

#### 5.5.7 状态色与杂项

| 语义 Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--md-success` | `#22C55E` | 同 | 成功 |
| `--md-warn` | `#DD8629` | `#F59E0B` | 警告 |
| `--md-danger` | `#EC1313` | `#F25A5A` | 错误、关闭按钮 hover、删除 |
| `--md-tooltip-bg` | `#2C2C2E` | `#545557` | **两个主题的 tooltip 都是深色板** |
| `--md-mask` | `rgba(0,0,0,.24)` | `rgba(0,0,0,.50)` | 弹窗遮罩 |
| `--md-scrollbar-thumb` / `-hover` | `#E5E5E5` / `#D4D4D4` | `#3C3C3D` / `#545557` | 滚动条滑块两态 |

- 原则不变且更严：深浅共用同一套语义 Token，组件只引用 Token，**禁止裸色值**；且**禁止直接引用 `--md-static-*`**。
- 代码高亮随主题走 GitHub Light / Dark 两套（hljs 仅打包这两套主题 CSS）——高亮配色是独立体系，不纳入本 Token 表，但代码块的**容器**（底色/圆角/padding/语言条）必须走 Token。

### 5.6 字体栈

只有两条栈（v0.2 的三条已合并为两条：UI 与正文共用一条，实测参考项目并不为正文另起一栈）：

| Token | 栈 | 类名 |
|---|---|---|
| `--md-font-ui` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif` | `font-ui` |
| `--md-font-mono` | `"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"` | `font-mono` |

- Windows 上真正起作用的是 **`Segoe UI`（英数）+ `Microsoft YaHei`（中文）** 的组合，前面几个 Apple 字体是跨平台冗余，保留无害。
- **等宽栈刻意不带裸 `monospace` 尾巴**（这是本项目最容易被"顺手补全"改坏的一行）：Windows 下 `monospace` 的系统默认解析结果是 **SimSun（宋体）**，一旦回退到它，代码块里的中文会突然变成宋体、字重发虚、行高错位。因此等宽栈末尾**用 `"PingFang SC", "Microsoft YaHei"` 显式兜中文**，**故意不写 `monospace`**。任何人补上这个尾巴都算 bug。
- 衬线阅读模式（思源宋体回退）仍为 V2 项，届时另起第三条栈。

### 5.7 圆角 / 阴影 / 间距

**圆角：六档语义分档**（不再是"4/8/12 三档"，且**按用途取名而非按数值取名**，杜绝"这里该用几号圆角"的争论）：

| 类名 | 值 | 用途 |
|---|---|---|
| `rounded-chip` | 6px | 行内代码、标签/徽标、图片、小色块 |
| `rounded-row` | 8px | **列表行 hover/选中高亮块**、菜单项、图标按钮 |
| `rounded-card` | 12px | 卡片、代码块、下拉面板、tooltip |
| `rounded-btn` | 18px | **常规按钮（36px 高的胶囊形）**、输入框、chip 型控件 |
| `rounded-modal` | 24px | 弹窗、导出对话框、首启引导卡 |
| `rounded-full` | 9999px（Tailwind 默认档，未覆盖） | 头像、纯圆图标钮、进度条端点 |

> 36px 高按钮配 18px 圆角 = 正好半高胶囊，这是参考项目按钮形态的识别特征；**不要给按钮用 8px 圆角**。

**阴影：只有三档，且明暗共用同一配方**（深色靠底色台阶分层，不靠加深阴影）：

| 类名 | 配方 | 用途 |
|---|---|---|
| `shadow-lv1` | `0 2px 4px 0 rgba(0,0,0,.05)` | 贴地元素：卡片、吸顶的语言条 |
| `shadow-lv2` | `0 4px 12px 0 rgba(0,0,0,.02), 0 2px 8px 0 rgba(0,0,0,.04)` | 下拉菜单、tooltip、查找浮条 |
| `shadow-lv3` | `0 0 1px 0 rgba(0,0,0,.20), 0 0 4px 0 rgba(0,0,0,.02), 0 12px 32px 0 rgba(0,0,0,.08)` | 弹窗、大纲浮层、灯箱 |

- **深色主题不改阴影透明度**（v0.2 的"浅色主题透明度减半"作废，方向本来也反了）。深色下阴影几乎看不见是**预期行为**——那里的层次由 `bg-canvas → bg-panel → bg-card → bg-layer` 的实色台阶提供，同时用 `--md-border-float` 补一道 6% 白色发丝高光勾边。
- `shadow-lv3` 的第一层 `0 0 1px rgba(0,0,0,.2)` 是**用阴影伪造 1px 描边**（比真 border 更柔、不占布局、不参与圆角抗锯齿），末层大扩散只有 8% 不透明度——"扩散大、浓度低"是这套阴影不脏的原因，改任一参数都会立刻变廉价。
- **焦点环不是阴影档位**：用 `shadow-focus`（`0 0 0 2px var(--md-accent)`）单独实现，见 6.5。

**间距**：4px 栅格，常用 4/6/8/12/16/24；另有两个半档 `p-4.5`(18px) 与 `p-5.5`(22px)（参考设计实为 2px 粒度，这两档是列表内边距与卡片内边距的实测值，必须保留）。

### 5.8 图标与品牌
- 图标集：Lucide（MIT，线性描边）。**尺寸只允许 16 / 14 / 12 三档**（16=顶栏与列表主图标，14=行内次要图标，12=角标/箭头），**`stroke-width` 一律 1.5**，**`color` 一律 `currentColor`**（禁止给 SVG 写死颜色，否则主题切换必漏）。v0.2 的"统一 16/20px"作废——20px 在 40px 顶栏与 32px 行里都显得笨重。
- **图标永远比同行文字淡一档**：文字 `text-primary` 时图标用 `text-tertiary`，hover 才升到 `text-secondary` / `text-primary`。这条比任何单独的颜色值都更影响"精致度"，逐个组件验收（见 6.4）。
- Logo：圆角方形底 + `M↓` 符号，用 `--md-brand`（近黑/近白，深浅两版各出一份），**不再用 #4C8DF6 蓝**；应用名暂定 "MDNaonao"（中文名候选"墨读"）。
- 分享按钮用"文字+通用图标"并列（气泡/纸飞机/闪电的抽象形），**不直接使用微信/飞书/钉钉官方 Logo**，规避商标风险；发布前按 11.6 合规清单核验。

---

## 6. 交互与客户端展示效果（v0.2 新增）

> 本章回答"软件摸起来是什么手感"。总纲：**快、稳、静**——快（每次交互 ≤200ms 有反馈）、稳（无布局跳动、无闪烁）、静（阅读区零打扰，动效只出现在"外壳"上）。

### 6.1 交互四条军规
1. **阅读区滚动与刷新零动画**：滚动、翻页、file watch 重渲染不加任何动画；重渲染必须原位无闪烁（双缓冲：新内容渲染完成后一次性替换 DOM，保持滚动位置）。阅读区允许的例外仅限 6.3/6.4 明列的四类：大纲跳转平滑滚动、查找命中高亮脉冲、图片灯箱、hover 时浮现的就地控件（代码块复制按钮 / 标题锚点图标，走 `opacity` 淡入）。
2. **动效属性白名单**：只动 **`opacity`（80–150ms）/ `transform`（100–150ms）/ 布局尺寸（180–300ms）**；大纲跳转的 `scrollTop` 平滑滚动为明示例外。
   **⚠️ v0.3 核心修正：背景色（hover / 选中 / 按下）一律不加过渡，瞬时切换。** 参考项目实测如此——鼠标划过时底色**即刻**出现与消失，而浮层淡入、列宽伸缩才是慢的。"该快的极快、该慢的从容"这个反差正是精致感的来源；给 hover 加上 100ms 的颜色过渡，整个界面会立刻变得"黏、糊、廉价"。
   **禁止 width/height/top/left 等布局属性动画**。左栏折叠与大纲钉住的 grid 列宽过渡（300ms）是唯一的布局动画特批——它每帧触发阅读区重排，性能取决于文档复杂度，用 `contain`/`content-visibility` 收窄重排范围，实测掉帧则退化为无动画直切。
3. **一切可被打断**：动画过程中用户的新操作立即接管，不排队、不锁 UI。遵循系统 `prefers-reduced-motion`：开启时全部动效时长归零。
4. **交互反馈只换背景色**（v0.3 新增铁律）：**禁止** `active:scale`、`hover:-translate-y`、`hover:shadow` 抬升、`focus:ring-offset`。**全站没有任何按压位移或悬浮抬升**——按钮、列表行、图标钮被按下时只有底色从 hover 档跳到 active 档，位置纹丝不动。缺的那点"手感"由"底色瞬时响应"补足（军规 2）。

### 6.2 窗口与原生质感
- **自绘标题栏**（`decorations: false`）：与 DeepSeek 式布局统一。需自行实现：顶栏空白区拖动（`data-tauri-drag-region`，该属性不作用于子元素，按钮区自然排除）、右键顶栏弹系统菜单（GetSystemMenu + TrackPopupMenu 自研）、最小化/最大化/关闭三键 hover 态（前两键 hover 为 `bg-hover`；关闭键 hover 底色 `--md-danger`、图标转 `text-inverted`，**不用裸色值 #F85149**）。随框架/系统自动获得、只需验收无需开发：拖动区双击最大化（Tauri 内置）、Win+方向键分屏（无边框+可缩放窗口下 OS 默认支持）。
- **已知限制（如实记录）**：自绘标题栏会失去 Win11 悬停最大化按钮出现的 Snap Layouts 浮窗；V1 接受此损失（Win+Z / Win+方向键仍可用），V2 评估社区方案（如 decorum 类插件）。
- **窗口圆角**：Win11 系统自动应用，无需自绘；Win10 直角，接受差异。
- **主题跟随**：监听系统深浅主题变化实时切换（跟随系统模式下）；标题栏三键颜色随主题。
- **Mica/亚克力背景**：列为 **P2 探索项**——WebView2 透明背景与 Mica 组合存在兼容性坑，需专项验证；V1 一律实色背景（Token 色）。
- **DPI**：100%/125%/150%/200% 及多显示器混合缩放下 1px 边框不糊（用 0.5px 物理对齐技巧或 outline），splash 与主窗口尺寸按 DPI 计算。
- **窗口记忆**：位置/尺寸/最大化态/左栏宽度/大纲钉住态持久化，重启还原；异常位置（显示器拔掉）回落主屏居中。

### 6.3 动效规格表

> **总则（v0.3 实测修正，覆盖 v0.2 全表）**：
> ① **缓动全站只有一条**：`cubic-bezier(0.4, 0, 0.2, 1)`（Token `--md-ease`，类名 `ease-standard`）。不再区分 ease-out / ease-in / linear（旋转动画除外，必须 linear）。
> ② **可过渡的属性只有三类**：`opacity` **80–150ms**、`transform` **100–150ms**、布局尺寸（grid 列宽/高度）**180–300ms**。
> ③ **背景色不在可过渡属性之列——hover / 选中 / 按下的底色一律瞬时切换**（军规 2）。
> ④ 时长三档已固化为 Token：`duration-fast` 100ms / `duration-base` 200ms / `duration-slow` 300ms；表中非整档值（80/120/150/160ms）为局部特例，直接写数值即可。

| 场景 | 时长 | 缓动 | 属性 | 备注 |
|---|---|---|---|---|
| 按钮/条目 hover | **0ms（瞬时）** | — | background-color | **绝不加 transition**（军规 2）；不位移、不缩放、不改阴影 |
| 按钮/条目按下 | **0ms（瞬时）** | — | background-color（hover→active 档） | **不用 opacity .85、不用 scale**（v0.2 该行作废，与军规 4 冲突） |
| hover 时浮现的就地控件（⋮ 钮、复制钮、锚点 #） | 120ms | standard | opacity | 只淡入淡出，不位移 |
| 左栏折叠/展开 | **300ms** | standard | grid 列宽 | 掉帧则直切（军规 2） |
| 大纲浮层出/入 | 180ms / 140ms | standard | transform: translateX(12px→0) + opacity | 出慢入快 |
| 大纲钉住⇄浮层切换 | **300ms** | standard | grid 列宽 | 阅读区列宽同步过渡，与左栏用同一条曲线 |
| 弹窗/导出对话框 | 160ms | standard | scale(.96→1) + opacity | 遮罩 opacity 120ms |
| toast 出/入 | 200ms / 150ms | standard | translateY(8px→0) + opacity | 右下角，最多同屏 3 条 |
| 查找浮条出/入 | 140ms | standard | translateY(-8px→0) + opacity | — |
| 查找命中跳转 | 0ms 跳转 + 400ms 高亮脉冲 | standard | 当前命中背景 `accent-soft` 脉冲一次 | 滚动本身瞬时；这是**唯一**允许背景色带时间变化的场景（脉冲而非过渡） |
| 大纲跳转滚动 | 250ms | standard | scrollTop | 阅读区唯一允许的滚动动画 |
| 主题切换 | **0ms（直切）** | — | — | v0.2 的"150ms 全局 color/background 过渡"**作废**：全局颜色过渡会让每个元素在切换途中经过一堆中间色，反而显脏；跟随系统与手动切换**一律直切** |
| 图片灯箱 | 200ms | standard | 从原位 transform 放大至居中（FLIP） | 背景遮罩 opacity |
| 拖入文件遮罩 | 120ms | standard | opacity | 全窗虚线框 +「松开以打开」 |
| 大文件分段渲染中 | 循环 1.2s | linear | **未渲染区一行淡字的文字流光**，或行内 10px 微 spinner | **不做骨架屏**（v0.2 该行作废，见 6.6）；spinner 用 `animate-spin-micro`（10px / 1.5px 描边 / 700ms） |
| 页面级加载 spinner | 循环 800ms | linear | transform: rotate | `animate-spin-page`；仅冷启动与导出等待用 |
| 列表行入场（新条目/过滤结果） | 150ms | standard | opacity | `animate-row-in`；**只淡入不位移**，避免列表抖动 |
| splash → 主界面 | 150ms | standard | opacity 交叉淡入 | 冷启动专用，热启动无 splash |

### 6.4 微交互清单（逐条实现、逐条验收）

> **全局三条（v0.3 新增，优先级高于下面任何单条）**：
> **A. 图标永远比同行文字淡一档**——文字 `primary` 时图标 `tertiary`，hover 才升 `secondary`/`primary`；文字 `secondary` 时图标 `caption`。图标与文字同色是"业余感"最主要的来源。
> **B. 禁用态统一 `opacity-40` + `cursor-not-allowed`，不换色**——不改文字色、不改底色、不加删除线。一个 class 走天下，避免每个组件各发明一套灰。
> **C. 空状态一律是一行 13px/20px 的 `text-tertiary` 文字**——不画插画、不做骨架屏、不加大图标、不放彩色按钮。

1. **左栏条目**：hover 浮现 ⋮ 按钮（120ms opacity 淡入，不位移）；hover/选中底色瞬时切换；置顶操作后条目**直接出现在置顶分组**（`animate-row-in` 150ms 纯淡入，**不做飞行 transform**——列表重排时的飞行动画在 200 条列表里必然抖）。**没有品牌色竖条**（见 5.3）。
2. **代码块**：hover 右上角浮现语言标签+复制按钮（opacity 120ms）；点击复制 → 按钮图标就地切换为 ✓ 并保持 1.5s，无 toast（就地反馈优先于全局反馈）；语言条 `sticky`，横向滚动时不跑掉。
3. **标题锚点**：hover 标题左侧浮现 `#` 链接图标（`text-tertiary`，opacity 120ms），点击复制"文件内锚点链接"，✓ 就地反馈。
4. **图片**：hover **只换鼠标指针为 `zoom-in`，不提亮、不缩放、不加阴影**（v0.2 的 `filter: brightness(1.03)` 作废，与军规 4 同源——阅读区任何"发光式"反馈都会打断阅读）；点击 FLIP 放大进灯箱；灯箱内滚轮缩放、拖拽平移、Esc/点击背景关闭；外链图片占位条 hover 显示完整 URL。
5. **查找**：输入即时高亮（防抖 80ms）；无命中时**计数显示 0/0 且输入框描边转 `--md-danger`，不抖动**（v0.2 的"±4px 抖动"作废：位移类反馈违反军规 4）。
6. **大纲**：滚动时当前章节高亮跟随——**高亮块的出现是瞬时的**（同 5.3 的选中态），不做 translateY 滑动条；hover 条目显示完整标题 tooltip（截断时，深色板 tooltip，延迟 500ms）。
7. **file watch 刷新**：顶栏文件名旁 ● 指示点闪烁一次（200ms opacity）表示"已刷新"，不弹 toast、不打断阅读。
8. **导出/分享按钮**：点击后按钮内转 10px 微 spinner（`animate-spin-micro` 替换图标，宽度不变防跳动）；完成 → ✓ 800ms → 恢复；失败 → toast 说明 + 自动降级动作。**按钮本身不缩放、不变暗**。
9. **拖拽打开**：文件拖入窗口边界即刻全窗虚线遮罩；松开后遮罩 120ms 淡出直接接内容（**不接骨架屏**）。
10. **滚动条**：8px 半透明细窄条（`--md-scrollbar-thumb`），hover 转 `-hover` 档（瞬时换色，**不加宽**——加宽会挤动内容触发重排）；滚动停止 1s 后 opacity 淡出（阅读沉浸）。
11. **状态栏缩放**：Ctrl+滚轮时状态栏缩放数字实时变化；Ctrl+0 复位时数字**短暂转 `text-primary` 再落回 `text-secondary`**（v0.2 的 scale 1.15 弹跳作废，军规 4）。
12. **空状态/引导页**：整块 `animate-fade-in`（160ms）一次淡入，**不做 stagger、不做插画**（全局条 C）。
13. **错误警示条**（文件丢失等）：从顶栏下方 slide-down 展开（160ms，transform+opacity），非模态、不遮内容；底色 `bg-panel` + 上下 `border-l2`，图标与文字用 `--md-danger`。
14. **首启引导（设为默认）**：三步卡片式向导（欢迎 → 一键跳系统设置+动图示意 → 完成），步进切换 200ms 横向 transform；卡片 `rounded-modal`，主按钮 `bg-brand text-inverted rounded-btn h-btn`；可跳过，可从设置/空状态再次进入。
15. **输入框（过滤框/查找框）**：静态描边 `border-l2`；**聚焦时只把描边换成 `border-brand`（近黑/近白）——无外发光、无 ring、无 ring-offset、不改底色**。这是与"到处 focus 蓝光"的普通后台界面最明显的分野。
16. **按钮层级**：主按钮 `bg-brand text-inverted`（hover 转 `brand-hover`）；次按钮 `bg-transparent border-l2 text-primary`（hover 加 `bg-hover`）；文字按钮无底无边（hover 加 `bg-hover`）；危险按钮文字/图标 `text-danger`（hover 底 `bg-hover-danger`）。**四种按钮的 hover 全部只换底色，且全部瞬时。**

### 6.5 键盘快捷键总表（唯一事实来源，新增快捷键必须先登记于此）

| 快捷键 | 动作 | 版本 |
|---|---|---|
| Ctrl+O | 打开文件对话框 | M1 |
| Ctrl+F | **文档内查找**（阅读器通用语义，不可挪用） | M1 |
| Ctrl+Shift+F | 左栏过滤框聚焦 | v1.0 |
| Ctrl+B | 折叠/展开左栏 | M1 |
| Ctrl+Alt+O | 大纲呼出/收起 | M1 |
| Ctrl+滚轮 / Ctrl+= / Ctrl+- / Ctrl+0 | 缩放 / 复位 | M1 |
| F5 | 手动重新渲染 | M1 |
| Esc | 关闭最上层浮层（查找条/灯箱/大纲浮层/弹窗）；左栏过滤框聚焦时清空并失焦（FR-03，v1.0 起）；无浮层时无动作 | M1 |
| Enter / Shift+Enter | 查找下一处/上一处（查找条聚焦时） | M1 |
| Ctrl+C | 复制选中内容 | M1 |
| Ctrl+P | 打印 | v1.0 |
| Ctrl+K | 快速切换（最近文件模糊搜索） | V2 |

- **焦点管理**：所有可交互元素有可见焦点环——`shadow-focus`（`0 0 0 2px var(--md-accent)`，**用 box-shadow 而非 outline，不撑破行边界、不占布局**），**仅键盘触发时显示**（`:focus-visible`）；**不加 ring-offset**（军规 4）。焦点环是**强调蓝 accent** 的合法用途之一（另两个是链接与进度），与输入框聚焦的 `border-brand` 是两件事：鼠标点进输入框只换描边，键盘 Tab 进来才额外出蓝环。浮层打开时焦点陷阱，Esc 归还焦点到触发元素；Tab 顺序 = 视觉顺序。
- 阅读区右键菜单：复制 / 复制为纯文本 / 复制为 Markdown 源 / 全选 /（图片上）复制图片、图片另存为 /（链接上）复制链接。

### 6.6 状态反馈系统

| 状态 | 展示 |
|---|---|
| 冷启动 | ≤300ms 品牌 splash（Logo+名称，实色 `bg-canvas`）→ 150ms 交叉淡入主界面；热启动无 splash |
| 无最近文件 | **一行 13px/20px `text-tertiary` 文字**"拖入 Markdown 文件，或 Ctrl+O 打开" + [打开文件] + [设为默认查看器] 两个文字按钮。**无插画**（v0.3 修正） |
| >5MB 分段渲染 | 直接打开 + 顶部细提示条"大文件已启用分段渲染" + 未渲染区**一行 `text-tertiary` 淡字"正在渲染剩余内容…"（文字流光 1.2s 循环）或行内 10px 微 spinner**。**不做骨架屏**（v0.3 修正） |
| 文件不存在 | 顶栏下警示条 + [从列表移除] / [重新定位] |
| file watch 刷新 | 文件名旁 ● 闪烁，静默完成 |
| 导出中 | 按钮内 spinner；>2s 追加进度 toast |
| 导出完成 | toast "已导出 · 打开文件 / 打开所在文件夹"（可点击动作） |
| 分享失败 | toast 告知 + 自动执行降级路径（如"已复制富文本，请手动粘贴"） |
| 首次飞书 API 配置 | 四步向导（见 8 节），每步可测试连接，失败给具体错误码说明 |
| 更新可用 | "更多"菜单红点 + 关于页显示新版本与下载链接（不弹窗打扰） |

> **关于骨架屏（v0.3 决策，全局生效）**：**本项目不做骨架屏。** 实测参考项目虽在其 Token 层保留了骨架屏相关变量，但**全代码库零引用**——它主动放弃了这条路。理由本项目同样成立：① 骨架屏是为"结构已知、数据未达"的列表页设计的，而 Markdown 文档的结构本身就是未知的，假灰条与真内容对不上，落地瞬间会有一次明显跳变；② 骨架屏的 shimmer 是持续动画，与"阅读区零打扰"（军规 1）直接冲突；③ 一行淡字的信息量与骨架屏等价，成本却是 1/20。
> 因此全局统一：**"没有内容" → 一行 `text-tertiary` 淡字；"内容在路上" → 同一行淡字加文字流光，或行内 10px 微 spinner。** 两者都不占布局、都可随时被真实内容原位替换。

### 6.7 无障碍与可访问性（小而美的底线，不是附加项）
- 文本对比度 ≥ WCAG AA（4.5:1）；`text-secondary`（浅 `#61666B` / 深 `#CFD3D6`）与 `text-tertiary`（浅 `#81858C` / 深 `#ADB2B8`）在两主题下都要实测达标；**`text-caption` 仅用于非必读的元信息**（时间戳、计数），不承载关键信息，故允许略低于 AA。
- 全部功能键盘可达（6.5 焦点管理）。
- `prefers-reduced-motion: reduce` → 所有动效时长归零（军规 3）。
- 字号可调（正文 14–20px 档位）独立于缩放。
- 图标按钮一律带 `aria-label` 与 tooltip（延迟 500ms 显示）。

---

## 7. 架构设计

### 7.1 模块划分

```
┌────────────────────────── Frontend (React/TS) ──────────────────────────┐
│ UI 层: 顶栏 / 左栏(最近列表) / 阅读区(Vditor.preview) / 大纲 / 查找条    │
│        / 弹窗 / toast / 首启引导                                        │
│ 状态层: Zustand stores (recentFiles, fileSession, uiState, settings)   │
│ 服务层: ipc.ts —— 统一封装 invoke() 调用，杜绝散落调用                    │
│ 渲染层: preview.ts —— Vditor.preview + outlineRender + DOMPurify 后处理 │
│         + IntersectionObserver 滚动高亮 + PRINT_READY 信号              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ tauri command (类型安全 invoke) + 官方插件
┌───────────────────────────────▼─────────────────────────────────────────┐
│ Rust 后端 (src-tauri)                                                   │
│  [官方插件] single-instance(argv 路由) / cli(--action) /                │
│             clipboard-manager(write_html/write_image)                  │
│  files.rs       文件读写、编码检测(UTF-8/BOM/GBK)、标题提取、             │
│                 recent.json 持久化、notify 文件监听                      │
│  export.rs      打印模板组装；PrintToPdf COM 桥接；CDP 兜底驱动           │
│  capture.rs     长图：CDP Page.captureScreenshot(captureBeyondViewport) │
│  share/lark.rs  token 缓存刷新、upload_all + import_tasks、降级逻辑      │
│  obsidian.rs    读全局 obsidian.json → Vault 列表 → 复制导入 → URI 唤起  │
│  shell_integ.rs 仅"额外右键动词"注册表读写（关联本身交给 bundler）        │
│  settings.rs    配置读写；飞书密钥 DPAPI 加密                            │
│  cmdline.rs     --action 分发与 clap 解析（cli 插件与单实例回调共用）     │
│  logging.rs     文件日志（轮转），--action 无 UI 模式必写                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.2 关键数据流
1. **打开文件**：双击（新进程）→ single-instance 插件检测到已有实例 → argv/cwd 经回调转发主实例 → 回调内复用 clap 解析 → 打开/切换 → 新进程退出。冷启动则正常初始化后打开。
2. **渲染管线**：读文件（UTF-8 优先，BOM 去除，失败按 GBK 解码兜底）→ 剥离 frontmatter 交属性卡片 → `Vditor.preview()`（sanitize 默认开启，本地 cdn）→ DOMPurify 后处理 → `outlineRender()` 提取标题树 → IntersectionObserver 挂滚动高亮 → 更新最近列表。
3. **file watch**：notify 事件 → 防抖 300ms → 后台重渲染到离屏容器 → 一次性替换 + 恢复滚动位置 → 顶栏 ● 闪烁。
4. **导出 PDF**：前端组装打印模板（A4、`@media print`、可选文内目录页）→ 隐藏 WebView2 窗口加载 → 等待前端 `PRINT_READY` 信号（Mermaid/字体渲染完成后 emit）→ COM `PrintToPdf` → 完成回调经 channel 桥回 async command（设超时）→ 保存；失败 → CDP 兜底 A → 均失败才提示。
5. **分享微信（长图）**：当前文档渲染态 → CDP `Page.captureScreenshot`（captureBeyondViewport:true，超限分段拼接）→ PNG → `write_image` 进剪贴板 + 可另存 → 用户粘贴。
6. **分享飞书（API 通道）**：`medias/upload_all`（parent_type=ccm_import_open，≤20MB）→ `POST import_tasks`（point.mount_key 传空=云空间根目录）→ 轮询 `GET import_tasks/:ticket` → 打开云文档链接；任一步失败 → 降级默认通道（复制富文本）。

### 7.3 存储设计
- 目录：`%APPDATA%\MDNaonao\`（`recent.json`、`settings.json`、`lark-token.json`、`logs\`）。
- `recent.json`：数组上限 200，字段 `{path, title, openedAt, pinned, scrollAnchor}`，LRU 淘汰；写入防抖 500ms。
- `settings.json`：主题、字号、缩放、导出偏好、代码折行、元数据显示、大纲钉住态、窗口几何；飞书 app_id/secret 用 Windows DPAPI 加密存储。
- `logs\`：按天分文件，保留 7 天或总量 10MB（先到为准）自动轮转。

### 7.4 单实例策略
- 直接使用 tauri-plugin-single-instance（**必须最先注册**）；第二实例的完整 argv（文件路径或 `--action …`）与 cwd 经回调到达主实例，回调内复用同一套 clap 解析逻辑。无自研 Mutex/命名管道（v0.1 方案废弃）。

---

## 8. 关键技术方案要点

| 主题 | 方案要点 |
|---|---|
| 渲染内核 | 只读渲染用 `dist/method.min.js`（52KB）的 `Vditor.preview()`，不加载完整编辑器（302KB）；大纲用 `Vditor.outlineRender()` 生成标题树；**滚动高亮官方不提供，自研**（IntersectionObserver 监听 heading）。脚注/任务列表由 Lute GFM 覆盖，无需插件 |
| Vditor 资源自托管（硬性规定） | `cdn` 参数必须指向打包进应用的本地目录（默认走 unpkg 动态加载，离线即白屏）。白名单：method.min.js + index.css + lute.min.js + mermaid.min.js + highlight.js（仅 GitHub Light/Dark 两套主题）+ KaTeX 含字体 ≈ 10.3MB 原始 / 压缩后 3-4MB。**剔除**：MathJax(1.8MB)、graphviz、echarts、markmap、abcjs、flowchart.js、plantuml。math 引擎固定 KaTeX。构建脚本校验：产物中不得出现 `unpkg` / `jsdelivr` 域名字符串 |
| PlantUML / 执行型图表 | PlantUML 的本地文件只是 encoder，**实际渲染依赖远程服务器**——离线不可用且是隐性外网请求，禁用（代码块按普通代码展示）；echarts/mindmap 等会执行文档内配置的渲染器默认关闭，仅保留 Mermaid/KaTeX/hljs |
| XSS 三层防御 | ① Lute `markdown.sanitize` 默认开启且**任何代码路径不得置 false**（Vditor/Lute 有 XSS CVE 史，最近 CVE-2026-25647）；② 渲染后 DOMPurify（约 20KB）再过滤一遍；③ Tauri 严格 CSP：script-src 仅本地、connect-src 按需白名单、img-src 默认仅本地（外链图片经"点击加载"才放行）。"信任此文件"开关只放开远程图片，不放开消毒 |
| PDF 静默导出（主） | `with_webview` 拿 ICoreWebView2 → `cast::<ICoreWebView2_7>()`（可 cast 更高版本接口）→ `ICoreWebView2Environment6::CreatePrintSettings`（A4/边距/去页眉脚）→ `PrintToPdf` → 完成回调 channel 桥回 + 超时。三个注意：crate 版本与 wry 对齐；打印前等 `PRINT_READY`；隐藏窗口生命周期管理。调试预算 3–5 天 |
| PDF 兜底 | 兜底 A：headless_chrome/chromiumoxide 经 CDP 驱动**系统 msedge.exe** 调 `Page.printToPDF`（推荐，规避 CLI 回归）；兜底 B（最后手段）：`msedge --headless --print-to-pdf --no-pdf-header-footer`，注明 Edge 141 起有"无报错不出文件"回归。msedge.exe 一律经 App Paths 注册表探测（见 4.1 注） |
| 微信分享 | 聊天场景主路径=长图：CDP `Page.captureScreenshot`（captureBeyondViewport:true）→ PNG 写剪贴板/另存（宽 720px 版式；超过 GPU 纹理上限约 16384px 时强制分页拼接）。公众号场景=富文本：doocs/md 思路渲染内联样式 HTML → `write_html(html, alt_text)`（alt_text 即纯文本回退）双格式。**不做也不承诺"直发微信"** |
| 飞书分享（双通道） | 默认通道（零配置）：复制富文本 → 提示粘贴进飞书文档（飞书文档原生支持富文本粘贴与 MD 语法，M0 实测代码块/表格保真度）。进阶通道（API）：四步引导——①个人版先免费创建团队（一人即可）→ ②open.feishu.cn 创建企业自建应用 → ③开通最小权限 `docs:document:import` + `docs:document.media:upload` 并发布版本 → ④填 app_id/secret 测试连接。文件 >20MB 提示不支持 API 导入并降级。`file_extension` 与实际后缀严格一致，否则报 1069910 |
| 钉钉分享 | 仅复制富文本（面向钉钉文档编辑器粘贴）/ 长图 / 发送文件。无公开导入 API（2.3-4） |
| Obsidian 导入 | 读 `%APPDATA%\obsidian\obsidian.json` 枚举 Vault（官方数据目录文档为准）；复制 .md + 附件到 vault（附件进 vault 附件目录并重写链接）；`obsidian://open?vault=&file=` 唤起；深定位可选 Advanced URI 插件（检测到才启用） |
| 文件关联与右键 | 关联：`bundle.fileAssociations`（ext: ["md","markdown","mdown","mkd","mkdn"]，description "Markdown 文档"），bundler 自动处理注册/卸载恢复/刷新。额外动词（转 HTML/转 PDF/导入/分享）：优先经 NSIS installerHooks 安装期写入、PREUNINSTALL 钩子删除；键仅限自家 ProgID 下，**不整删 .md 扩展名键、不碰 UserChoice**，变更后 SHChangeNotify |
| 查看态本地图片 | 以 .md 所在目录为相对路径基准；加载走 Tauri asset 协议（convertFileSrc + 动态 scope）或 Rust 读文件转 data URL——**二选一在 M0 验证定案**（这是 Tauri 做 MD 应用的头号坑）。中文/空格/UNC 路径全测 |
| 附件路径重写 | 导出单文件 HTML：相对/绝对引用 → base64 内联；导出"HTML+资源目录"：拷入 `xxx_files/` 并重写；导入 Obsidian：拷入 vault 并重写。三条路径共用同一个解析器，中文/空格路径进语料库 |
| 大文件 | >5MB 直接打开+提示条+分段渲染（首屏块优先，滚动懒渲染）；大文件下关闭实时滚动高亮，改为节流 500ms；查找触发时后台补全渲染 |
| 编码 | UTF-8 优先；BOM 去除；失败按 GBK 解码兜底（中文用户刚需）；状态栏显示实际编码 |
| 安装/卸载生命周期 | 安装：bundler 关联 + hooks 写额外动词；卸载：bundler 自动恢复关联备份 + PREUNINSTALL 删除全部自写键 + 询问是否删除 `%APPDATA%\MDNaonao\`（说明含飞书密钥与最近列表）；验收含"安装→使用→卸载→重装"循环用例 |

---

## 9. 里程碑与进度情况

### 9.1 阶段划分（单人全职口径，兼职按 1.5–2 倍折算）

| 阶段 | 内容 | 预估 | 出口标准 |
|---|---|---|---|
| **M0 技术验证** | ⓪ 建仓与脚手架（任务卡见 AI_DEV_GUIDE 第 7 节）；① PDF：PrintToPdf COM 主路线 + CDP 兜底各出一份含中文/表格/代码块/Mermaid 的 A4 PDF；② Vditor 实测包：preview 渲染 10MB 语料 + outlineRender + 本地图片加载方案定案（asset vs data URL）+ frontmatter 默认行为 + 裁剪后体积/内存实测 + CDP 全页长图截图实测（captureBeyondViewport，含超长分页）；③ 剪贴板保真实测：write_html 产物粘贴到公众号编辑器/飞书文档的样式清单核对（决定 v1.1 方案）；④ 集成冒烟：fileAssociations + single-instance 路由 + --action（半天） | **2–2.5 周** | 4 项全通过；①②任一不达标则升级为方案变更（PDF 降级系统打印对话框 / 更换渲染内核）并修订本文档 |
| **M1 批次 1：驯服 WebView、接通断线**（任务卡级执行文档见 [UPGRADE_PLAN.md](UPGRADE_PLAN.md)，条目级进度只记在那里；审计依据 docs/audit-2026-08-18.md，下同） | ① 链接点击委托：外链→系统浏览器（tauri-plugin-opener）、相对 .md→应用内打开、#锚点→统一平滑跳转，WebView 永不被导航走；② 浏览器默认快捷键接管（关 AreBrowserAcceleratorKeysEnabled + DG 6.5 白名单，Ctrl+R/P/F 不再裸奔）；③ Ctrl+滚轮从"缩放整个窗口"改为只缩正文；④ **settings 前后端字段契约修复**（当前保存即丢）+ 对拍单测；⑤ 死按钮清零：主题/缩放/字号/代码折行四个设置真正接线生效，未实现按钮一律 disabled 态；⑥ Esc 语义链、键盘翻页焦点、file-removed 警示条、失效条目灰显、点击已打开文件不重渲染 | 3–4 天 | 三个审计中 5 项 blocker 全在此批清零 |
| **M1 批次 2：阅读的连续性** | ① 外部保存刷新零白闪（离屏双缓冲，位置纹丝不动——与 MPE 差距最直观的一处）；② 滚动位置记忆接线（FR-16 后端已备）；③ 主题切换/系统深浅跟随均保持阅读位置；④ 表格宽度修复（长句单元格换行 + 嵌套表格统一滚动壳）；⑤ frontmatter 属性卡片渲染（当前数据凭空蒸发）；⑥ 本地图片 D 盘/UNC 运行时授权 + 外链图片"点击加载"修复；⑦ 窗口几何记忆 | 3–4 天 | 出口：改文件、切主题、重开文件，视线永不丢失位置 |
| **M1 批次 3：查找 + 右键菜单** | ① Ctrl+F 查找条（CSS Highlight API：全高亮/计数/Enter 循环/Esc）；② 应用内右键菜单四套（正文=MPE 结构含置灰开发中项 / 链接 / 图片 / 左栏条目），彻底替换 WebView2 浏览器菜单；③ 用其他编辑器打开源文件、在浏览器中打开；④ 左栏 hover 操作钮、键盘导航、过滤清空钮 | 4–5 天 | 用户点名项全部落位 |
| **M1 批次 4：排版补完与打磨** | ① GitHub alerts 五色告警块（> [!NOTE] 等，当下事实标准）；② details/summary、emoji、[TOC]、\ce 化学式、Mermaid 错误态；③ 代码块行号选项、嵌套引用层次、链接 hover 目标提示；④ 左栏/大纲拖宽、窄窗自适应折叠、图片灯箱、ErrorBoundary | 2–3 天 | M1 出口 = v0.9 内测包；关联装包与首启引导并入此批收尾 |
| **M2 v1.0（公开发布）** | 导出 PDF（主+兜底）、右键菜单 +转 PDF、打印、导出 HTML 资源目录模式、左栏过滤、滚动位置记忆、设置页完善、检查更新、卸载清理完善、winget 上架、签名与发布流程 | **3 周** | 12 节 v1.0 清单全过，GitHub Releases + winget 发布 |
| **M3 v1.1（生态版）** | Obsidian 导入（含附件）、微信长图+公众号富文本、飞书双通道、钉钉兜底、长图分页、右键菜单 +导入 Obsidian/分享 | **3 周** | 12 节 v1.1 清单全过；这版才是完整故事：看→存→分享 |
| **M4 V2** | Win11 一级右键（前置：签名证书+COM 组件 1–2 周）、钉钉 API（视官方开放）、衬线模式、自动更新、Ctrl+K、便携版评估、轻编辑评估、Mica 探索 | 按需 | 用户反馈驱动，不排硬期 |

### 9.2 当前进度（整体 0%）

| 模块 | 状态 | 备注 |
|---|---|---|
| 需求与方案文档 | ✅ v0.2（2026-08-17） | 即本文档，v0.1 全量核验后修订 |
| M0-0 建仓与脚手架（含 CI 骨架） | ✅ 已完成 2026-08-17 | 仓库 github.com/cycycy8520/MDReader；工具链 Rust 1.97.1 + pnpm 11.22.0；自测全绿（tsc / eslint / vite build / cargo check / clippy -D warnings / cargo test 14 passed / check-no-cdn）；`tauri build` 出 NSIS 安装包 **2.03MB**（预算 25MB）。**遗留**：正式 Logo 待品牌任务（当前为占位图标）；CI 尚未在 GitHub Actions 上实跑 |
| M0-① PDF 主路线 | ✅ 已打通（2026-08-17） | PrintToPdf COM 桥接跑通：12 页 A4（594.96×841.92pt）、993KB、耗时 2.87s、MicrosoftYaHei 等 11 个字体子集内嵌、71 个 ToUnicode CMap（可搜索复制）、解出 985 个中文字符无乱码。产物 `docs/m0/out-printtopdf.pdf` |
| M0-① 兜底 A（CDP 驱动 Edge） | ⬜ 未开始 | 本机 Edge 151 落在事实库 #3 的 CLI 回归区间，必须走 CDP `Page.printToPDF` |
| M0-② Vditor 实测包 | ⬜ 未开始 | 含本地图片方案定案 |
| M0-③ 剪贴板保真实测 | ⬜ 未开始 | 公众号编辑器 + 飞书文档 |
| M0-④ 集成冒烟 | ⬜ 未开始 | 官方插件，半天 |
| M1 主链路（打开→解码→渲染→大纲→最近列表→file watch） | ✅ 2026-08-18 打通 | 端到端日志验证；排版样式同日补齐（此前完全缺失） |
| M1-A 阅读体验完备 | 🔄 进行中 | 列宽自适应/不裁切/缩放/查找/滚动记忆；**用户已两次指出视觉问题，本阶段起执行开发侧先行视觉验收** |
| M1-B 右键菜单与打开方式 | ⬜ 排队 | MPE 结构终态 + 置灰开发中项 |
| M1-C 关联与收尾 | ⬜ 排队 | — |
| 品牌/Logo/图标 | ⬜ 未开始 | 可并行 |

> 进度更新规则：每次提交或每周更新本表；⬜ 未开始 / 🔄 进行中 / ✅ 已完成 / ⛔ 阻塞。

### 9.3 风险登记（Top 6）

| # | 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|---|
| 1 | PrintToPdf COM 桥接超预算（版本对齐/异步回调/隐藏窗口坑） | 中 | 高 | M0 第 1 天开始；兜底 A=CDP 驱动 msedge.exe；兜底 B=headless CLI（已知 Edge 141 回归，最后手段）；再不济降级系统打印对话框并移出 v1.0 关键路径 |
| 2 | Vditor preview 模式不满足查看器需求（大文件卡顿/大纲弱/图片坑） | 中 | 高 | M0-② 专项实测；备选 markdown-it 自组管线的成本预估已写入 4.1；分段渲染方案兜底 |
| 3 | 飞书自建应用流程对普通用户太复杂（含"先建团队"前置） | 高 | 中 | 双通道设计：零配置富文本粘贴永远是默认路径，API 只是进阶 |
| 4 | 未签名 EXE 被 SmartScreen/杀软拦截 | 高 | 高 | 购 OV 证书（约 $215–400/年，含硬件令牌；**不买 EV**——2024 年起 EV 已无即时声誉特权）；Azure Trusted Signing 暂仅限美加老组织、个人通道关闭，持续关注；上架 winget 缓解分发信任；发布页 SHA256 + "仍要运行"图文指引 + SmartScreen 误报申诉 |
| 5 | Lute/Vditor 出现新 XSS CVE | 低 | 高 | 订阅 GitHub Advisory；DOMPurify+CSP 两层兜底本来就在（8 节） |
| 6 | 微信/飞书粘贴保真度不及预期（公众号编辑器/飞书文档侧改版） | 中 | 中 | M0-③ 先实测再定模板；长图路径不受编辑器改版影响 |

> v0.1 的"微信富文本排版塌"已从风险表移除——它不是风险，是确定性平台约束（2.3-1），产品方案已按长图主路径重设计。

---

## 10. 注意事项（开发红线与坑）

1. **微信没有 API、聊天窗口没有富文本**：任何"自动发到微信""富文本进群聊"的文案都是假的。产品文案一律写"长图粘贴"或"复制后粘贴（公众号编辑器）"。`text/html` 只在公众号编辑器/飞书文档/Word 等富文本容器生效，聊天窗口只取 `text/plain`。
2. **UserChoice 永远不碰**：不写、不删、不猜哈希。设默认只能引导用户手动操作（2.3-2）。
3. **XSS 是头号安全问题**：三层防御（8 节）任何一层不得因"性能优化"关闭；远程图片默认不加载。
4. **编码坑**：GBK 兜底不做会被中文用户骂"乱码"。
5. **附件路径重写是导出功能最常见 bug 源**：相对/绝对/中文/空格/UNC 路径全进语料库；三条重写路径共用一个解析器，修一处即修三处。
6. **Win11 右键分层**：HKCU verb 进"显示更多选项"是设计行为，别当 bug 修；一级菜单是 V2 的 COM+签名活。
7. **卸载残留是差评重灾区**：运行时写的每一个注册表键都必须有对应的 PREUNINSTALL 删除；卸载后双击 .md 应正常回落系统推荐流程。
8. **单实例用官方插件且最先注册**，自研方案已废弃；`--action` 无 UI 调用必须写日志到 `logs\`（GUI 应用无法向控制台回写），否则右键失败无从排查。
9. **性能预算卡死**：任何单次操作 >500ms 必须有 loading 态；内存口径与分级红线见 3.2，超线即 bug。
10. **版权/商标**：Vditor(MIT)、Lucide(MIT) 保留 LICENSE；**wandao 是 AGPL-3.0——只能借鉴思路，严禁抄代码**；分享按钮不用三平台官方 Logo（5.8）；应用名避开已有商标。
11. **发布渠道**：GitHub Releases 为主 + winget；发布页写清杀软误报说明与 SHA256。
12. **依赖版本纪律**：webview2-com/windows 跟随 wry 锁定；Vditor 升级前跑一遍 XSS 样本集与渲染语料回归。
13. **视觉基线只有一个上游**（v0.3 新增）：第 5 章数值来自对参考项目的实测提取，**Token 的唯一定义处是 `src/styles/tokens.css`**。改设计的顺序永远是"先改 Token → 再回写第 5 章 → 才动组件"，禁止在组件里"先试出来再补文档"。
14. **禁止裸色值 / 裸尺寸**（v0.3 新增）：组件层只准用 `tailwind.config.js` 暴露的语义类名（`bg-canvas` / `text-secondary` / `border-l2` / `h-row` / `rounded-row` …），禁止写 `#xxxxxx`、`rgba()`、任意像素值，也**禁止直接引用 `--md-static-*`** 静态色阶。Tailwind 默认调色板已被覆盖，`gray-500` 这类类名写了也编译不出样式——出现即视为 bug。配套两条铁律见 6.1 军规 2/4：**hover/选中背景不加 transition**、**交互反馈不做位移/缩放/抬升**。

---

## 11. 开发规范

### 11.1 仓库与流程
- monorepo 单包（`src/` 前端 + `src-tauri/` Rust），M0 建立。
- Conventional Commits；`main`（可发布）+ `feat/*`；PR 自审清单：更新本文档进度表 / 不破坏既有验收项 / 附验证截图。

### 11.2 测试策略
- Rust 单测：额外动词注册表键生成/删除、obsidian.json 解析、编码检测、frontmatter 剥离、路径重写解析器。
- 前端 vitest：stores、剪贴板 HTML 模板转义、大纲树构建、查找高亮。
- 核心场景按 12 节验收清单 + 语料库手工回归（GUI 自动化 V1 不引入）。

### 11.3 CI
- GitHub Actions：`cargo test` + `pnpm lint/test` + `tauri build` 产 NSIS 产物 + 产物内禁用域名字符串扫描（unpkg/jsdelivr）；tag 触发发版。

### 11.4 测试环境矩阵（每个里程碑至少覆盖打 ★ 组合）
- 操作系统：Win10 22H2 ★ / Win11 23H2 ★ / Win11 24H2 ★ / Win10 21H2（尽力）
- WebView2：Evergreen 最新 ★ / 落后 2 个大版本
- DPI：100% ★ / 150% ★ / 200%，多显示器混合缩放 ★
- 系统主题：深 ★ / 浅 ★；区域设置：中文(GBK 场景) ★ / 英文
- 防护：SmartScreen 开启 ★ + 至少一款主流杀软
- 基准测试机（NFR 数字以此为准）：4C8T / 16GB / SATA 或以上 SSD（型号 M0 时定死并回填）

### 11.5 日志、诊断与遥测决策
- **V1 无任何自动遥测**。崩溃/异常时弹窗引导用户一键"复制诊断信息"或打包 `logs\`，附 GitHub Issue 模板链接。
- 日志分级（error/warn/info，settings 可调 debug）；轮转策略见 7.3。
- NFR"崩溃"指标的验证口径：内测样本量 + 反馈通道（3.2）。

### 11.6 许可证与合规
- 本项目许可证：**MIT**（开源；若后续商业化再评估双许可）。
- 建立 `THIRD-PARTY-NOTICES`：Vditor(MIT)/Lucide(MIT)/DOMPurify((MPL-2.0 OR Apache-2.0) 双许可)/各 crate。
- 参考项目代码借鉴规则：MIT/Apache 可借鉴（保留声明）；**AGPL（wandao、MarkFlowy、Inkdown、mdSilo）仅借鉴思路**。
- 三平台品牌资源：发布前逐条核验各自品牌规范，UI 采用 5.8 的规避方案。

### 11.7 i18n
- V1 仅简体中文；文案集中 i18n 文件，预留英文位。

---

## 12. 验收标准（发布门槛，逐条打勾）

### 12.0 标准测试语料库（入库 `test-corpus/`，验收与回归共用）
- `full-gfm.md`：全 GFM 元素 + Mermaid + KaTeX + 脚注 + 任务列表 + frontmatter
- `gbk.md`：GBK 编码中文文档
- `big-10mb.md`：10MB 压测文档（由 `scripts/gen-corpus` 以 full-gfm.md 内容循环拼接至 10MB±5%，含 ≥500 个各级标题、≥100 个代码块、≥50 张表格，保证指标可比）
- `xss-suite/`：恶意样本集（script/事件属性/href 注入/svg 等）
- `assets-cn path/图 片.md`：中文+空格路径的本地附件文档（UNC 路径场景 `\\server\share` 以手工回归覆盖，不入库）
- `longlines.md`：超长 URL/超宽表格/深嵌套列表

### M1（v0.9 内测）出口
- [ ] 完成首启引导后，双击 .md/.markdown（.mdown/.mkd/.mkdn 各抽测一次）→ 本应用打开，`full-gfm.md` 双击到首帧 ≤1000ms（基准机热启动）
- [ ] 右键 .md：打开 / 转 HTML（单文件）产物正确：离线双击可开，中文/表格/代码块/本地图片逐项与预览一致
- [ ] `--action export-html <file>` 无 UI 直跑成功，`logs\` 留有对应日志
- [ ] 对 `full-gfm.md` 选区执行三种复制（富文本/纯文本/Markdown 源），产物逐一核对（FR-19）
- [ ] 左栏：分组正确、置顶/移除/打开所在文件夹/复制路径可用、点击切换、失效条目灰显可清理
- [ ] 大纲：浮层/钉住两态、点击跳转、钉住态滚动高亮正确；Mermaid 正常渲染；frontmatter 显示为属性卡片
- [ ] Ctrl+F 查找：`big-10mb.md` 中命中计数正确、跳转高亮脉冲、Esc 关闭归还焦点
- [ ] 外部编辑器修改文件 → 1s 内自动刷新且滚动位置不跳
- [ ] 深/浅/跟随系统三态正确，首启=跟随系统，重启后设置保留
- [ ] `xss-suite/` 全部样本：脚本不执行、无外网请求（DevTools Network 为证）
- [ ] `gbk.md` 无乱码；`big-10mb.md` 不白屏、滚动均值 ≥50fps
- [ ] 6.5 表中版本列=M1 的快捷键逐条可用；`prefers-reduced-motion` 下动效归零
- [ ] 内存：空载 ≤150MB；`big-10mb.md` ≤250MB（11.4 基准机、3.2 口径）

### v1.0 出口（在 M1 基础上追加）
- [ ] 导出 PDF（含右键"转 PDF"入口直达）：`full-gfm.md` → A4 PDF，中文字体正确、代码块不截断、Mermaid 为清晰位图/矢量；主路线失败时兜底 A 自动接管且产物同样达标
- [ ] 打印对话框正常调起且版式与 PDF 一致
- [ ] 导出 HTML 两种模式各自验收（单文件离线可开；资源目录模式整目录拷贝后可开）
- [ ] 滚动位置记忆：重开 `big-10mb.md` 回到上次位置 ±1 屏内
- [ ] 左栏过滤：Ctrl+Shift+F 聚焦、输入即过滤、命中高亮、Esc 清空（FR-03 逐项）
- [ ] 安装→使用→卸载→重装循环：卸载后无孤儿右键项、关联正确回落、重装全功能正常
- [ ] 安装包 ≤25MB；产物无 unpkg/jsdelivr 字符串；缺 WebView2 的干净虚拟机上安装器自动补装后可用
- [ ] 检查更新入口可用

### v1.1 出口（生态版）
- [ ] 微信：长图清晰（720px 版式、文字可读、代码块完整）两步可发；公众号编辑器粘贴 8 项样式清单（标题/加粗/列表/引用/代码块/表格/图片占位/链接）逐项不塌
- [ ] 飞书默认通道：富文本粘贴进飞书文档，同 8 项清单核对；进阶通道：四步引导完成后一键生成云文档并打开，失败自动降级且有明确提示；>20MB 文档明确提示不支持 API 导入并自动降级复制富文本
- [ ] Obsidian：Vault 列表正确、子目录可选、附件复制且链接重写、同名冲突提示、导入后唤起定位成功；右键菜单"导入 Obsidian / 分享"入口直达可用
- [ ] 钉钉：富文本复制（钉钉文档粘贴核对）/ 长图 / 文件三条路径可用

---

## 13. 附录

### 13.1 参考开源项目（v0.2 已逐一联网核验存在性与活跃度）

| 项目 | 借鉴点 | 状态注记（2026-08） |
|---|---|---|
| [Neilooo/md-reader](https://github.com/Neilooo/md-reader) | **最接近本产品的先例**：Tauri 2 查看器，5-6MB，关联/导出/大纲/最近文件已实现——重点研读其文件关联与导出实现；本产品差异化在 Obsidian+分享 | MIT，活跃但年轻（50 commits） |
| [Vanessa219/vditor](https://github.com/Vanessa219/vditor) | 渲染内核（preview/outlineRender/Mermaid/KaTeX） | MIT，11.2k★，v3.11.3（2026-08）活跃 |
| [doocs/md](https://github.com/doocs/md) | 公众号内联样式模板与剪贴板方案（仅公众号编辑器场景） | 13.2k★，活跃 |
| [marktext/marktext](https://github.com/marktext/marktext) | 桌面 MD 应用架构、导出交互 | MIT，60.2k★；曾长期停更，2025 起恢复维护 |
| [obsidianmd/obsidian-importer](https://github.com/obsidianmd/obsidian-importer) | 导入逻辑参考（官方项目） | MIT，1.6k★，活跃 |
| [Vinzent03/obsidian-advanced-uri](https://github.com/Vinzent03/obsidian-advanced-uri) | 深定位 URI（基础唤起用官方 obsidian://open 即可） | MIT，1.2k★，活跃 |
| [tllovesxs/wandao](https://github.com/tllovesxs/wandao) | 各平台导入导出思路 | **AGPL-3.0：仅借鉴思路，禁止抄代码**；829★，活跃 |
| [gkuegler/obsidian-launcher](https://github.com/gkuegler/obsidian-launcher) | obsidian.json 读取示例 | 0★，2023 起停更；以官方数据目录文档为准，此仓库仅作代码示例 |
| [ternag/markdown-viewer](https://github.com/ternag/markdown-viewer) | Tauri MD 查看器可行性佐证 | 0★ 个人实验项目，作者自述非生产可用 |
| [scottli139/vividmark](https://github.com/scottli139/vividmark) | Tauri 2 + HTML/PDF 导出先例 | 3★ 早期项目（自称 100% AI 构建），代码自行甄别 |
| [tauri-apps/awesome-tauri](https://github.com/tauri-apps/awesome-tauri) | 官方生态目录，选型/先例检索入口 | 官方维护 |

### 13.2 关键文档链接（含最后核验日期 2026-08-17）
- Tauri 2 文件关联：https://v2.tauri.app/reference/config/（FileAssociation）；Windows 安装器与 webviewInstallMode/installerHooks：https://v2.tauri.app/distribute/windows-installer/
- Tauri 官方插件：single-instance https://v2.tauri.app/plugin/single-instance/ ；cli https://v2.tauri.app/plugin/cli/ ；clipboard-manager https://v2.tauri.app/reference/javascript/clipboard-manager/
- WebView2 打印：ICoreWebView2_7.PrintToPdf https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_7 ；官方 how-to/print；wry#707（至今 open）；SO 问题 78327694（其被采纳答案 answer 78330108：Tauri 1.x + webview2-com 0.19 模式，Tauri 2 需对齐版本）
- WebView2 分发（Win10 少数设备缺失的官方说明）：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
- CDP 兜底：headless_chrome https://crates.io/crates/headless_chrome ；chromiumoxide https://crates.io/crates/chromiumoxide
- 文件监听：notify https://crates.io/crates/notify
- 飞书导入：使用指南（upload_all/import_tasks/权限/20MB/后缀严格一致）https://open.feishu.cn/document/server-docs/docs/drive-v1/import_task/import-user-guide ；创建导入任务 https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/import_task/create
- Obsidian 数据目录：https://obsidian.md/help/data-storage（当前规范地址）
- Win11 右键与 IExplorerCommand：https://learn.microsoft.com/en-us/answers/questions/832880/adding-an-item-to-windows-11-context-menu ；操作性补充 https://www.cnblogs.com/laurencee/p/22463491
- SmartScreen 声誉机制：https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation

### 13.3 术语表

| 术语 | 含义 |
|---|---|
| ProgID | 注册表中文件类型到应用的映射标识 |
| UserChoice | Win10+ 用户默认程序选择键，带系统哈希保护，应用不可写 |
| CF_HTML | Windows 剪贴板 HTML 格式，粘贴富文本靠它（写入由 clipboard-manager 插件自动包装） |
| PrintToPdf | WebView2 静默打印接口（ICoreWebView2_7） |
| CDP | Chrome DevTools Protocol：长图经 WebView2 自带 CDP 通道（CallDevToolsProtocolMethod）调用；PDF 兜底 A 经外部库驱动 msedge.exe |
| import_tasks | 飞书"导入文件生成云文档"的异步任务 API（注意复数） |
| DPAPI | Windows 数据保护接口，本地加密飞书密钥用 |
| sanitize | HTML 消毒，防 XSS（Lute 内置，默认开启） |
| FLIP | First-Last-Invert-Play，灯箱放大动画技术 |
| Snap Layouts | Win11 悬停最大化按钮出现的分屏布局浮窗（自绘标题栏会失去，见 6.2） |

---

## 14. 更新日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.3 | 2026-08-17 | **视觉基线换血：第 5 章由"自拟设计"改为"对参考项目 DeepSeek Harness 客户端的实测提取"**，并同步修正第 6 章冲突条目。① 5 章开篇确立新的事实链：Token 唯一定义处 = `src/styles/tokens.css`，类名映射 = `tailwind.config.js`（已覆盖 Tailwind 默认色板，`gray-500` 类名不再存在），本章是其镜像而非上游；② **5.5 色板整体作废重写**——改为两层 Token 结构（`--md-static-*` 原始色阶 + `--md-*` 语义别名，主题切换只重绑语义层），浅色画布/卡片纯白 `#FFFFFF`、侧栏 `#F9FAFB`，深色实色台阶 `#151517→#1B1B1C→#232324→#2C2C2E→#353638`，边框四档纯透明度叠加（l1 .04/.06、l2 .10/.12、l3 .12/.16、l4 .16/.20），文字四档 `#0F1115/#61666B/#81858C/#ADB2B8` 与深色镜像，**品牌主色改为近黑/近白 `#0F1115`/`#F9FAFB`（主按钮用），强调蓝 `#4176E6`/`#679EFE` 降级为仅链接/焦点环/进度**，hover 与选中共用 `rgba(38,49,72,.06)`/`rgba(255,255,255,.08)`；③ **5.3 删除"当前项左侧 3px 品牌色竖条"**——实测参考项目全站零竖条，选中态 = hover 同色半透明底 + 8px 圆角整块高亮（附三条理由）；④ 5.2 尺寸校正：左栏 260→**280**（264–420，折叠 56，窗口 <1024px 自动折叠）、大纲 240→**300**（300–520）、阅读列宽 760→**748**（最小 640）、顶栏 44→**40**，并新增控件高度契约（行 32 / 分组 34 / 按钮 36 / 小钮 28 / 输入 32）；⑤ 5.4 排版校正：正文 16/28、H1 **24/34/700**、H2 **22/32/700**、H3 **20/30/700**、H4 16/28/600，新增 Markdown 块级间距配方表（p/h/ul/li/hr/blockquote/行内 code/表格/代码块/img 逐项），引用块改中性 2px 线无底色，表格取消斑马纹；⑥ 5.6 字体栈合并为两条，并硬性规定**等宽栈不带裸 `monospace` 尾巴**（否则 Windows 中文掉 SimSun）；⑦ 5.7 圆角改语义六档 6/8/12/18/24/999（按用途取名），阴影改三档实测配方且**明暗共用**（深色靠底色台阶分层，不靠阴影）；⑧ 5.8 图标改 **16/14/12 三档 + stroke 1.5 + currentColor**，确立"图标永远比同行文字淡一档"；⑨ **6.1 增第 4 条军规"交互反馈只换背景色"**（禁 scale/位移/抬升/ring-offset）；⑩ **6.3 动效表核心修正：hover/选中/按下的背景色一律瞬时无过渡**，可过渡属性收敛为 opacity 80–150ms / transform 100–150ms / 布局尺寸 180–300ms，缓动统一 `cubic-bezier(0.4,0,0.2,1)`，三栏列宽 300ms，"主题切换 150ms 全局过渡"改直切，"按下 opacity .85"作废；⑪ 6.4 删除与铁律冲突的条目（图片 hover 提亮、查找框抖动、缩放数字弹跳、置顶飞行动画），补入全局三条（图标淡一档 / 禁用态 `opacity-40` / 空态纯文字）与输入框聚焦规格（**只换 `border-brand`，无发光无 ring**）、按钮四层级；⑫ **全局取消骨架屏**（参考项目 Token 有定义但零引用），空态与加载态统一为一行 13/20 `text-tertiary` 淡字 + 文字流光或 10px 微 spinner，6.6 与 3.1 FR-04（大纲 240→300）同步；⑬ 第 10 章补红线 13/14（视觉基线唯一上游、禁止裸色值/裸尺寸），与 `tokens.css` / `tailwind.config.js` 的代码注释交叉引用对齐；⑭ 文档头补 v0.3 修订依据，并注明"唯一事实来源"对设计 Token 的例外（上游是 tokens.css，第 5 章是其镜像） |
| v0.5 | 2026-08-18 | 全盘体验审计落地：三个只读审计代理产出 77 项发现（5 blocker / 30+ major，全文见 docs/audit-2026-08-18.md），M1 据此重排为批次 1–4（驯服 WebView→阅读连续性→查找与右键菜单→排版补完），取代 v0.4 的 A/B/C 划分；同日完成：github-markdown-css 基底接入（MPE 同源观感 + Token 变量桥）、列宽三态默认自适应、最近列表会话内排序冻结（修"鼠标下重排"） |
| v0.4 | 2026-08-18 | M1 按用户反馈重排为 A（阅读体验完备）/B（右键菜单与打开方式）/C（关联收尾）三段，阅读体验优先于一切新功能；5.2 阅读列宽由固定 748px 改为「默认自适应 + 设置三档」；新增两条工程纪律：① 交付用户的产物必须由 `pnpm tauri build` 产出（`cargo build --release` 会内嵌 devUrl 指向开发服务器，已实际造成一次故障）；② UI 改动必须先过开发侧视觉验收（真实文档 × 三档窗口宽度 × 深浅主题）才可交用户 |
| v0.2.2 | 2026-08-17 | M0-0 建仓：仓库落在 E:\MDyuedu 本身（非子目录）并推送至 github.com/cycycy8520/MDReader；9.2 进度表 M0-0 转 🔄；AI_DEV_GUIDE 第 4 节同步实际仓库位置与凭据现状 |
| v0.2.1 | 2026-08-17 | 配套建立 AI 执行手册（AI_DEV_GUIDE.md v1.0）与 CLAUDE.md，并据其双向校验回改本文档：13.2 SO 引用注明问题/答案双编号；9.2 增补 M0-0 建仓行（并入原"代码仓库与 CI"行）、M0 预估改 2–2.5 周；7.1 补 cmdline.rs；4.1 补 clap/thiserror/tracing 与 DOMPurify；12.0 补 big-10mb 生成规则与 UNC 覆盖口径；8 节 write_html 参数命名统一 |
| v0.2 | 2026-08-17 | 全量核验修订：① 修正三处事实错误——微信聊天不支持富文本（成功标准 4 改长图主路径）、UserChoice 禁止静默设默认（新增首启引导 P0）、钉钉无公开导入 API；② 废弃三处自研轮子，改用 bundle.fileAssociations / tauri-plugin-single-instance / clipboard-manager write_html；③ PDF 兜底从 Edge headless CLI 升级为 CDP 驱动（Edge 141 回归）；④ Vditor 方案细化：method.min.js+本地 cdn 硬规定、资源白名单、outlineRender+自研滚动高亮、禁 PlantUML、XSS 三层防御（CVE-2026-25647）；⑤ 飞书改双通道（零配置富文本默认、API 进阶四步引导、最小权限集）；⑥ 补齐查看器本职：文档内查找（Ctrl+F 归还）、file watch、滚动记忆、多扩展名、本地图片加载（进 M0）、frontmatter、打印、链接矩阵、卸载生命周期；⑦ 统一概念模型：左栏=最近列表（删除"标签页"）、大纲可钉住、内存分级口径、渲染分档；⑧ 里程碑重切：M0 两周、M1 四周 v0.9 内测先行、v1.0/v1.1 分层发布；⑨ 砍掉轻编辑（V1 严格只读）；⑩ 新增第 6 章"交互与客户端展示效果"（军规/窗口质感/动效规格/微交互清单/快捷键总表/状态反馈/无障碍）；⑪ 附录逐条核验并加注（wandao AGPL 警示、md-reader 新增）；⑫ 新增测试矩阵、遥测决策、许可证合规、语料库与量化验收；⑬ 定稿前三方自校验修正：长图方案统一为 CDP captureBeyondViewport（CapturePreview 仅可视区，不可用于长图）、自绘标题栏补偿清单纠偏（双击最大化/Win+方向键为现成能力）、动效军规例外清单化、F/FR/里程碑/验收四方对齐（含 Ctrl+Shift+F 归位 v1.0、新增 FR-18/19 与对应验收项） |
| v0.1 | 2026-08（初稿，具体日期未记录） | 建立文档：目的、边界、选型、UI 规范、架构、进度、风险、验收 |
