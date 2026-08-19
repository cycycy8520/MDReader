# AI_DEV_GUIDE.md —— 面向 AI 开发代理的执行手册

> 文档版本：v1.0（2026-08-17）
> 读者：负责实现本项目的 AI 编码代理（Claude Code 或同类）。人类开发者也可读，但措辞是对 AI 说的。
> 配套关系：**[DEV_GUIDE.md](DEV_GUIDE.md)（v0.2）是需求与方案的唯一事实来源（回答"做什么/为什么"）；本文档是执行手册（回答"你怎么干活"）。两者冲突时以 DEV_GUIDE.md 为准，且你必须停下来报告冲突，而不是自行取舍。**
> 本文档编号引用规则：形如"DG 8"指 DEV_GUIDE.md 第 8 节，"DG 2.3-1"指其 2.3 节第 1 条。

---

## 0. 你的角色与边界

你是本项目的实现者。人类保留以下决策与操作，你不得代替：

| 人类专属 | 说明 |
|---|---|
| 产品决策 | 加/砍功能、改优先级、偏离 DG 既定方案 |
| 账号与密钥 | 飞书应用注册、微信真机、代码签名证书 |
| 真机验证 | 粘贴到微信/公众号/飞书的实际效果、多机型测试 |
| 发布动作 | 打 tag、发 Release、上架 winget |
| 花钱 | 证书购买、任何付费服务 |

其余实现工作（写代码、写测试、建脚手架、查本地文档、跑构建）由你自主完成，不需要逐步请示。

---

## 1. 会话启动协议（每次开始工作先执行）

1. 读本文档（如果不在上下文中）。
2. 读 [DEV_GUIDE.md](DEV_GUIDE.md) 的第 0 节（速览）、9.2（进度表）。
3. 从 9.2 进度表确定当前任务：取第一个 ⬜/🔄 且无 ⛔ 前置阻塞的任务。**一次只做一个任务。**（代码仓库尚未建立时，当前任务恒为第 7 节的 M0-0。）
4. 按任务类型补读对应章节（见第 7 节任务卡的"必读"栏），不要通读全文浪费上下文。
5. 任务完成后执行第 6 节的收尾协议（更新进度表 + 提交）。
6. 用户指令与本协议冲突时，听用户的。

---

## 2. 红线清单（NEVER —— 任何理由不得违反，包括"用户似乎希望"或"这样更快"）

**安全类**
1. 永不关闭 Lute `markdown.sanitize`；永不移除 DOMPurify 后处理；永不放宽 CSP。三层防御（DG 8"XSS 三层防御"）一层都不能少。"信任此文件"开关只放开远程图片。
2. 永不写入/删除/伪造 UserChoice 注册表键（DG 2.3-2、DG 10-2）；只读检测"当前默认程序是谁"允许（首启引导需要）。设默认只能引导用户手动操作。
3. 注册表写入仅限：自家 ProgID 下的键 + 额外右键动词；每个运行时写入的键必须同步登记到 NSIS 卸载钩子清单。永不整删 `.md` 扩展名键。
4. 渲染管线中外链图片默认不发起网络请求（占位条 + 点击加载）。

**范围类**
5. 不实现任何编辑能力（V1 严格只读，DG 2.2 首行），即使 Vditor "顺带就有"、即使只是"加个保存"。
6. 不实现 DG 2.2 范围外清单中的任何项（便携版、遥测、钉钉 API 通道、自动更新等）。
7. 不承诺、不实现"自动发到微信"或任何绕过 DG 2.3 硬性平台约束的功能。

**技术类**
8. Vditor 的 `cdn` 参数必须指向本地自托管目录；产物中出现 `unpkg` 或 `jsdelivr` 字符串即构建失败（CI 有扫描，本地也要自查）。
9. 长图截图禁用 CapturePreview（只截可视区）；唯一路线是 CDP `Page.captureScreenshot` + `captureBeyondViewport: true`（DG 4.1"长图截图"行）。
10. `webview2-com` / `windows` crate 版本跟随 Tauri 内部 wry 锁定（`cargo tree` 核对后写死），永不单独升级。
11. 不自研已被官方能力覆盖的轮子：文件关联=`bundle.fileAssociations`、单实例=tauri-plugin-single-instance（**必须最先注册**）、CF_HTML=clipboard-manager `write_html`（DG 4.1）。
12. 不引入新的运行时依赖（crate / npm 包）除非：(a) DG 4.1 / DG 8 方案表已列出，或 (b) 本手册明文要求（第 5 节的 thiserror、tracing/tracing-appender、clap；红线 1 的 DOMPurify），或 (c) 人类明确批准。开发期依赖（lint/test 工具）可自主添加。
13. 新增/修改任何快捷键，必须先更新 DG 6.5 总表（它是快捷键唯一事实来源），再写代码。
14. UI 中不写裸色值，只引用 DG 5.5 的 Token；动效遵守 DG 6.1 三条军规（属性白名单 + 例外清单）。

**法务类**
15. AGPL 项目（wandao、MarkFlowy、Inkdown、mdSilo）的代码一行都不能复制，只能看思路。MIT 项目可借鉴但保留声明（登记进 THIRD-PARTY-NOTICES）。

---

## 3. 已核验事实库（截至 2026-08-17，均经联网核实——不要重新调研，不要"好心纠正"）

以下结论是 v0.2 定稿时的核验结果。你在实现中若发现与之矛盾的现象（如 API 行为变了、库升级了），**不要静默改方案**：停下，报告证据，等人类确认后同步更新 DEV_GUIDE.md 和本节。

| # | 已核验事实 | 对你的指令 |
|---|---|---|
| 1 | wry（0.56.x）只有弹窗 `print()`，无静默 PDF；wry#707 仍 open；无现成 PDF 生成插件 | 直接写 COM 桥接，不要去找插件 |
| 2 | PrintToPdf 路线：`with_webview` → `cast::<ICoreWebView2_7>()`（可 cast 更高版本）→ `ICoreWebView2Environment6::CreatePrintSettings` → `PrintToPdf`；范例=SO 问题 78327694 的被采纳答案（answer 78330108，Tauri 1.x + webview2-com 0.19） | 照此模式实现，注意 Tauri 2 的版本对齐（红线 10） |
| 3 | `msedge --headless --print-to-pdf` 在 Edge 141+ 有"无报错不出文件"回归；`--headless=old` 已从 Chromium 132 移除 | 兜底走 CDP（headless_chrome/chromiumoxide 驱动 msedge.exe），CLI 只作最后手段 |
| 4 | WebView2 Runtime 不含 msedge.exe；Edge 路径经 App Paths 注册表探测 | 不要硬编码 Edge 路径，不要用 Runtime 存在推断 Edge 存在 |
| 5 | CapturePreview 仅截可视区（微软官方确认，设计行为） | 见红线 9 |
| 6 | 微信聊天窗口粘贴富文本必退化为纯文本（平台确定性行为）；个人微信无 API | 聊天分享只做长图/文件；富文本只面向公众号编辑器 |
| 7 | 飞书：接口为复数 `import_tasks`；链路=`medias/upload_all`(parent_type=ccm_import_open) → `POST import_tasks` → 轮询 `GET import_tasks/:ticket`；MD 上限 20MB；`file_extension` 与后缀严格一致否则报 1069910；最小权限 `docs:document:import` + `docs:document.media:upload`；个人版账号须先建免费团队才能建自建应用 | 按此实现 lark.rs，权限只申请最小集 |
| 8 | 钉钉无公开文档导入 API | 只做富文本/长图/文件三兜底，不要去找 API |
| 9 | Vditor ≥3.11.3：只读用 `method.min.js`(52KB) 的 `Vditor.preview()`；大纲是独立的 `Vditor.outlineRender()`；滚动高亮官方没有（自研 IntersectionObserver）；默认 cdn 指向 unpkg；`markdown.sanitize` 默认 true；PlantUML 依赖远程服务器 | 按 DG 8 的白名单裁剪自托管；PlantUML 禁用 |
| 10 | Vditor/Lute 有 XSS CVE 史（最近 CVE-2026-25647，Lute ≤1.7.6 href 注入） | 三层防御不可省（红线 1）；升级 Vditor 前跑 xss-suite 回归 |
| 11 | Windows 10+ UserChoice 带哈希保护，应用不可写 | 见红线 2 |
| 12 | `bundle.fileAssociations` 的 NSIS 产物含安装注册+卸载恢复备份+SHChangeNotify；ext 支持数组 | 关联相关不写一行 winreg 代码 |
| 13 | tauri-plugin-single-instance 内部即 CreateMutexW+WM_COPYDATA，回调给出第二实例 argv/cwd | 直接用，回调内复用 clap 解析 |
| 14 | clipboard-manager `write_html(html, alt_text)` 自动生成 CF_HTML 头并同时写纯文本 | 不手工拼 CF_HTML 头 |
| 15 | 2024 年起 EV 证书无 SmartScreen 即时声誉；Azure Trusted Signing 个人通道关闭（仅美加 3 年以上组织） | 签名方案不要自行"优化"，按 DG 9.3 风险 #4 |
| 16 | Tauri 拖动区（data-tauri-drag-region）自带双击最大化；无边框+可缩放窗口下 Win+方向键分屏 OS 默认支持；右键标题栏系统菜单需自研 | 按 DG 6.2 分清"要做的"和"白送的" |
| 17 | `cargo build --release` 产出的 exe 内嵌 devUrl（localhost:1420），离开开发服务器即白屏/报错（2026-08-18 实际故障）；只有 `pnpm tauri build` 走生产路径真正内嵌前端 | **交付用户验证的产物一律 `pnpm tauri build`**；另注意仅改前端时 Rust 不重编，dist 不会重新内嵌 |
| 18 | 编译通过 + 日志正确 ≠ UI 正确：列宽写死、内容裁切、浏览器右键菜单等问题只有视觉检查能发现（用户已两次代替开发承担测试） | UI 改动交付前必须视觉自验：真实文档 × 窄/1080p/2K 三档窗口 × 深浅主题 |
| 19 | **Windows PowerShell 5.1 默认 DPI-UNAWARE**。它调 `CopyFromScreen` 截一个 per-monitor-aware 窗口时，只会拿到左上角 `1/scale` 的区域，**不报错、图像上也看不出缺了东西**；`GetWindowRect` 同样返回虚拟化后的尺寸（2026-08-18 实测：真实 1822×1213 的窗口被报成 1215×809）。据此看图会"发现"根本不存在的缺陷——本项目曾因此误判「正文右侧被裁、状态栏消失」并改了两处 CSS | 截图/量窗口**一律走 `scripts/shot.ps1`**（它先调 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`）。看到"内容被裁"先验截图工具，再怀疑产品 |
| 19b | **语料里的图片资源不入库，必须先 `pnpm gen:corpus-assets` 生成**（`test-corpus/README.md` 第 4 节列了五张）。不生成的话 `full-gfm.md` 第 10 节四个用例全是破图 —— 而 10.2「中文 + 空格路径」是 DG 点名的头号坑，缺图时那条路径**从来没有被真实验证过**，只是看起来测过了（2026-08-18 由用户发现） | 任何涉及图片/导出/长图的验收，先跑这条命令。看到破图先确认图在不在，再怀疑渲染 |
| 20 | PDF 文本校验有两个坑：① 直接在 PDF 字节里搜字符串**永远搜不到**（子集化字体编码），那种检查恒返回"干净"，是最坏的假阳性；② 提取出的表格单元格文本**带换行**，整串匹配会把内容完好误判成整列被裁 | 用 `pdfminer` 真正提取文本，且比对前先 `re.sub(r"\s+","",text)`；必须先跑一组"正文里确实存在的词"作对照，对照不全中就说明提取失效、后面的结论一律不作数 |

---

## 4. 仓库结构（首个编码任务 = 按此建仓）

```
mdnaonao/
├── CLAUDE.md                  # AI 会话自动加载的薄入口（见根目录模板）
├── DEV_GUIDE.md               # 唯一事实来源（从 E:\MDyuedu\ 移入仓库）
├── AI_DEV_GUIDE.md            # 本文档
├── THIRD-PARTY-NOTICES        # 依赖许可证登记（红线 15）
├── package.json / pnpm-lock.yaml
├── src/                       # 前端 (React + TS + Zustand + Tailwind)
│   ├── components/            # 顶栏/左栏/阅读区/大纲/查找条/弹窗/toast/引导
│   ├── stores/                # recentFiles / fileSession / uiState / settings
│   ├── services/ipc.ts        # 唯一 invoke 封装入口（禁止组件直接 invoke）
│   ├── render/preview.ts      # Vditor.preview + outlineRender + DOMPurify + 滚动高亮 + PRINT_READY
│   └── styles/tokens.css      # DG 5.5 Token 的唯一定义处
├── src-tauri/
│   ├── tauri.conf.json        # fileAssociations / webviewInstallMode / CSP / 插件注册
│   ├── Cargo.toml             # 版本锁定（红线 10、12）
│   └── src/                   # 模块对应 DG 7.1：files / export / capture / share/lark
│                              #   / obsidian / shell_integ / settings / logging / cmdline
├── vendor/vditor/             # 自托管渲染资源（DG 8 白名单，构建脚本校验来源）
├── test-corpus/               # DG 12.0 六件套语料（建仓时一并生成）
├── docs/m0/                   # M0 各任务卡验证报告（第 7 节，出口评审依据）
├── scripts/                   # 构建校验（禁用域名扫描）、语料生成
└── .github/workflows/ci.yml   # DG 11.3
```

- **仓库已建立**（2026-08-17）：位置就是 `E:\MDyuedu` 本身（不是子目录），远程 `origin` = https://github.com/cycycy8520/MDReader ，默认分支 `main`。三份文档即位于仓库根，无需搬动，也不存在副本分裂问题。
- 推送凭据经 Windows 凭据管理器已可用，`git push` 直接可用；`gh` CLI 未登录，需要 issue/PR 操作时由人类先 `gh auth login`。
- `tauri.conf.json` 首版三要素：`bundle.fileAssociations`（五个扩展名，DG 8）、`webviewInstallMode: downloadBootstrapper`、严格 CSP（首版策略串：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data:; connect-src 'self'`，后续放行必须先改这里并在 DG 留痕）。single-instance 的"最先注册"落实在 `main.rs` 的 Builder 链，不是 conf 配置项。

---

## 5. 编码规范（写代码前读一遍，评审按此执行）

**TypeScript**
- `strict: true`；禁 `any`（确需逃逸用 `unknown` + 收窄）。
- 组件不直接 `invoke`：一律经 `services/ipc.ts`，每个 command 一个类型化函数。
- 状态只放 Zustand store；组件本地 UI 态（如 hover）除外。
- 样式只用 Tailwind + Token（红线 14）；新 Token 必须先进 DG 5.5。
- 文案集中 `i18n/zh-CN.ts`，代码中禁止内联中文字符串（className 等技术值除外）。

**Rust**
- 每个 tauri command 返回 `Result<T, AppError>`（thiserror 定义，错误信息面向日志而非用户；用户文案由前端 i18n 决定）。
- 日志用 `tracing` + 文件输出（DG 7.3 轮转规则）；`--action` 无 UI 路径的每一步必须留日志（DG 10-8）。
- 单元测试与被测代码同文件 `#[cfg(test)]`；DG 11.2 列出的必测项不可跳过。
- `cargo clippy -- -D warnings` 必须零告警。

**通用**
- Conventional Commits；一个任务一个分支（`feat/m0-1-pdf-poc` 式命名）。
- 注释只写代码表达不了的约束（如"此处顺序不能变：single-instance 必须先于 cli 注册"），不写"下一行做了什么"。
- 借鉴参考项目代码时在 commit message 注明来源与许可证（红线 15）。

---

## 6. 任务执行协议与完成定义（DoD）

每个任务按此流程，缺一步不算完成：

1. **对齐**：从 DG 找到该任务对应的 FR 编号与验收项，在任务开始时列出（这是你的验收契约）。
2. **实现**：遵守第 2/5 节。
3. **自测**：`pnpm lint && pnpm test`、`cargo test && cargo clippy -- -D warnings`；日常任务 dev 冒烟即可，完整 `pnpm tauri build` 仅在 M0-0（验证打包链路）、触碰打包配置的任务、各里程碑出口时必跑。涉及渲染的改动跑 test-corpus 相关语料（自 M0-② 渲染管线存在起适用）。
4. **验收自查**：逐条核对第 1 步列出的验收项，能自动验证的给出证据（命令输出/截图），需真机的标注"待人类验证"。
5. **文档同步**：更新 DG 9.2 进度表状态；若改动影响 DG 记载的行为/方案，同步修改对应节并在 DG 14 追加更新日志行。**代码与文档不同步 = 任务未完成。**
6. **提交**：Conventional Commit；PR 描述引用 FR 编号与验收证据。

**报告纪律**：测试失败就说失败并贴输出；跳过的步骤明说跳过；不确定的标注不确定。禁止"应该没问题"式收尾。

---

## 7. M0 任务卡（当前阶段，最细粒度）

> M0 目标与出口标准见 DG 9.1。**单人串行顺序：M0-0 → ① → ② → ③ → ④**；③ 交人类真机验证的等待期可穿插 ④ 与报告整理。工期加总 8–12 个工作日（DG 9.1 预估 2–2.5 周），触顶仍未完成按第 9 节上报。每张卡产出一份 `docs/m0/` 下的验证报告（结论 + 数据 + 截图 + "是否达标"判定），这是 M0 出口评审的依据。

### 任务卡 M0-0：建仓与脚手架（前置，约半天–1 天）
- **必读**：本文档第 4/5 节；DG 4.1/4.2。
- **步骤**：Tauri 2 + React + TS 模板初始化 → 按第 4 节调整结构 → 接入三个官方插件：tauri-plugin-single-instance（main.rs 最先注册）、tauri-plugin-cli、tauri-plugin-clipboard-manager → tauri.conf.json 首版三要素（第 4 节）→ CI 骨架 = DG 11.3 的子集：cargo test/clippy + pnpm lint/test + 禁用域名扫描（tauri build 任务可 allow-failure，tag 发版流程 M2 再加）→ 生成 test-corpus 六件套（DG 12.0，其中 xss-suite 至少 10 个样本：script 标签/事件属性/javascript: href/svg onload/data: URI 等）。
- **远程仓库**：由人类创建并提供地址，或明确授权你用 gh 建私有仓库；远程未就绪前 CI 项以本地脚本等效执行，DoD 记为"待远程补验"。
- **DoD**：`pnpm tauri dev` 起得来空窗口；完整 `pnpm tauri build` 出包成功（打包链路验证，仅此卡必跑）；CI 绿（或本地等效 + 待补验标注）；语料入库。

### 任务卡 M0-①：PDF 静默导出 PoC（最高风险，预算 3–5 天；前置：M0-0）
- **必读**：DG 4.1（PDF 三行 + 表下注）、DG 8"PDF 静默导出/兜底"、事实库 #1–4。
- **步骤**：
  1. `cargo tree` 确认 wry 依赖的 webview2-com/windows 版本，写死进 Cargo.toml。
  2. 打印内容不依赖渲染管线（那是 M0-② 的事）：手写静态测试页 `docs/m0/print-poc.html`，内嵌中文段落、宽表格、长代码块、一个 Mermaid 图（本地 mermaid.min.js 手动初始化）。
  3. 主路线：隐藏窗口加载 print-poc.html → 页面渲染完成（含 Mermaid）后 emit `PRINT_READY` → Rust 侧 COM 调用链（事实库 #2）→ 完成回调经 channel 桥回 async command，超时 30s。
  4. 兜底 A：headless_chrome 驱动 App Paths 探测到的 msedge.exe，CDP `Page.printToPDF`。
- **DoD / 报告**：两条路线各对 print-poc.html 出一份 A4 PDF，中文不乱码、表格完整、代码块不截断、Mermaid 清晰；记录耗时与失败模式（`full-gfm.md` 全量渲染版 PDF 在 M0-② 完成后补验一次）。**主路线卡点上报口径**：自 9.2 将本卡置 🔄 起计 3 个工作日、仅计主路线投入（兜底 A 不计入），到期未通即按第 9 节格式上报，由人类决定（继续 / 降级系统打印对话框方案并修订 DG）。

### 任务卡 M0-②：Vditor 实测包（预算 3–4 天）
- **必读**：DG 4.1"渲染内核"行、DG 8 前四行、事实库 #9–10。
- **步骤**：
  1. 按白名单搭 `vendor/vditor/`，`cdn` 指本地；构建脚本加禁用域名扫描。
  2. `Vditor.preview()` 渲染 test-corpus 全部语料；`outlineRender` 提取标题树；IntersectionObserver 滚动高亮原型。
  3. 本地图片二选一定案：asset 协议（convertFileSrc + 动态 scope）vs Rust 读文件转 data URL——各做最小实现，按"任意目录的 .md + 中文/空格路径图片 + UNC 路径（\\server\share\...）"实测，选定后写入报告与 DG 8。
  4. frontmatter 默认行为实测（Vditor 会不会当正文渲染）→ 决定剥离层实现位置。
  5. CDP 全页长图截图实测（captureBeyondViewport:true，含 >16384px 分页场景）。
  6. 实测数据：裁剪后安装包体积、10MB 语料渲染耗时/内存/滚动帧率、xss-suite 全过（DevTools Network 证明零外网请求）。
- **DoD / 报告**：各项数据 vs DG 3.2 指标的达标判定；图片方案定案理由；不达标项的降级建议。

### 任务卡 M0-③：剪贴板保真实测（预算 1–2 天，含人类环节）
- **必读**：DG 8"微信分享/飞书分享"行、事实库 #6–7、#14。
- **步骤**：`write_html` 写入 doocs/md 风格内联样式模板 → 生成 DG 12 的"8 项样式清单"测试文档 → **交人类真机粘贴**到公众号编辑器与飞书文档 → 按清单逐项记录塌/不塌。
- **DoD / 报告**：8 项清单核对表 ×2 目标；结论直接决定 v1.1 模板打磨方向；飞书保真度若达标，记录"API 通道可进一步后置"的建议。

### 任务卡 M0-④：集成冒烟（半天；前置：M0-0）
- **必读**：DG 4.1 官方插件行、事实库 #12–13。
- **步骤**：fileAssociations 装包实测（五扩展名、卸载后关联回落）——**在虚拟机或人类确认的测试机上执行**（会真实改动 .md 关联，开发机上只做 dev 冒烟）→ 双击第二个文件路由回调 → `--action open <file>` 直跑 + 日志落盘。
- **DoD**：三条链路各一条通过记录；发现的坑记入报告。

### M0 期间需要人类提供的事项（提前打招呼，别阻塞了才说）
- GitHub 远程仓库（M0-0：人类创建，或授权用 gh 建私有仓）。
- 装包实测环境：虚拟机或指定测试机（M0-④）。
- 真机微信/公众号编辑器/飞书账号（M0-③）。
- 飞书自建应用（**可延后到 M3**，M0 不需要）。
- 基准测试机确认（DG 11.4，实测数据在哪台机跑就以哪台为准并回填）。

---

## 8. M1 及以后（粗粒度索引，进入该阶段时再细化成任务卡）

进入 M1 时，你的第一个任务是：按 DG 9.1 M1 行 + DG 12 M1 验收清单，把 M1 拆成 8–12 张本节格式的任务卡追加到本文档（人类确认后开工）。M2/M3 同理。拆卡规则：每卡 ≤3 天、有明确 FR 映射、有可自动验证的 DoD。

---

## 9. 何时问人类（判断准则）

**直接做，不要问**：实现细节选择（数据结构、内部 API 形状）、测试补充、重构不改行为、文档错别字修正、本手册任务卡内明确写了的一切。

**必须停下来问**（给出选项与你的推荐，等答复）：
- 需要偏离 DG 既定方案（含"我发现更好的做法"——先报告，别先改）。
- 需要新增运行时依赖（红线 12）。
- 事实库条目与现实冲突（第 3 节开头的流程）。
- 验收指标不达标且无降级预案。
- 任何 UI 视觉产出首次成形时（截图给人类过目一次再批量铺开）。
- M0-① 超 3 天未通（任务卡内已写）。

**阻塞报告格式**：卡在哪（一句话）→ 已尝试什么（列表）→ 证据（输出/截图）→ 可选项 A/B/C + 你的推荐。

---

## 10. 文档维护义务

- 本文档的任务卡状态不重复维护——进度只记在 DG 9.2（单一事实源）。
- 每完成一个里程碑，回顾本文档：过时的任务卡归档删除，新阶段任务卡补入，"已核验事实库"若有更新逐条注明日期。
- 修改本文档也要在 DG 14 更新日志留痕（"AI_DEV_GUIDE 更新至 vX.X"一行即可）。

---

## 更新日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-08-17 | 初版：基于 DEV_GUIDE.md v0.2 建立执行手册——角色边界、启动协议、15 条红线、16 条已核验事实库、仓库结构、编码规范、DoD、M0 五张任务卡、问询准则 |
