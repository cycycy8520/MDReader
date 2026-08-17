# MD Viewer for Windows

> 打开即看、导出即用、分享即达的 Windows Markdown 阅读器。

Windows 10/11 桌面应用，注册为 `.md` 系列文件的打开程序。**严格只读**——V1 完全不做编辑，把"看"这一件事做到极致；差异化押在 **Obsidian 一键入库** 与 **微信长图 / 飞书分享** 上。

技术栈：Tauri 2（Rust + WebView2）+ React 18 + TypeScript + Vditor（`Vditor.preview()` 只读渲染，资源本地自托管）。

---

## 当前状态：M0 技术验证，**应用还跑不起来**

| 项目 | 情况 |
|---|---|
| 整体进度 | **0%**（详见 [DEV_GUIDE.md 9.2](DEV_GUIDE.md) 进度表，那里是唯一事实源） |
| 需求与方案 | ✅ 已定稿（DEV_GUIDE.md v0.2，2026-08-17） |
| 代码 | 🔄 M0-0 建仓与脚手架进行中；M0-①～④ 未开始 |
| 能否运行 | ❌ **不能**。当前仓库只是脚手架骨架 |

**为什么现在跑不起来（如实说明）：**

1. **本机缺 Rust 工具链与 pnpm**，`pnpm tauri dev` / `pnpm tauri build` 无法执行（安装方式见下节）。
2. **缺应用图标**：`src-tauri/icons/` 尚未产出（DEV_GUIDE 9.2"品牌/Logo/图标"仍为⬜），Tauri 打包会因缺图标失败。
3. **缺自托管渲染资源**：`vendor/vditor/` 不入库（见 `.gitignore`），需先跑 `node scripts/fetch-vditor.mjs` 按 DEV_GUIDE 8 节白名单裁剪出自托管资源。
4. 依赖尚未安装（`node_modules/` 不存在），也未做过任何构建验证。

**下一步该做什么**：按 [AI_DEV_GUIDE.md 第 7 节](AI_DEV_GUIDE.md) 的任务卡串行推进 —— **M0-0 → M0-① → M0-② → M0-③ → M0-④**，每张卡在 `docs/m0/` 产出一份验证报告。M0 出口标准见 DEV_GUIDE 9.1。

---

## 功能规划

按 [DEV_GUIDE.md 2.1](DEV_GUIDE.md) 精简。✅ = 该版本交付，➕ = 在前一版本基础上增强。

| 编号 | 能力 | M1（v0.9 内测） | v1.0（公开发布） | v1.1（生态版） |
|---|---|---|---|---|
| F1 | MD 渲染查看（GFM / Mermaid / KaTeX / 脚注 / 代码高亮 / frontmatter） | ✅ | | |
| F2 | 文件关联 + 首启"设为默认"引导 | ✅ | | |
| F3 | 左侧最近列表（分组 / 置顶 / 移除 / 打开目录 / 复制路径） | ✅ 简版 | ➕ 过滤 | |
| F4 | 大纲（浮层态 / 钉住态 + 滚动高亮） | ✅ | | |
| F5 | 文档内查找（Ctrl+F 浮条、命中计数） | ✅ | | |
| F6 | 外部修改自动刷新（保持滚动位置） | ✅ | | |
| F7 | 资源管理器右键菜单 | ✅ 打开 / 转 HTML | ➕ 转 PDF | ➕ 导入 Obsidian / 分享 |
| F8 | 命令行参数 `--action <verb> <file>` | ✅ | | |
| F9 | 主题（深 / 浅 / 跟随系统，首启默认跟随） | ✅ | | |
| F10 | 导出 HTML | ✅ 单文件（base64 内联） | ➕ HTML + 资源文件夹 | |
| F11 | 导出 PDF（A4、中文字体正确、静默导出） | | ✅ | |
| F12 | 打印（Ctrl+P，复用 PDF 模板） | | ✅ | |
| F13 | 滚动位置记忆 | | ✅ | |
| F14 | 导入 Obsidian（发现 Vault、复制附件、URI 定位） | | | ✅ |
| F15 | 分享微信（长图主路径 + 公众号富文本） | | | ✅ |
| F16 | 分享飞书（复制富文本默认通道 + API 进阶通道） | | | ✅ |
| F17 | 分享钉钉（富文本 / 长图 / 发送文件） | | | ✅ |

> F18（Ctrl+K 快速切换）属 V2，不在上表三个版本内。
> **明确不做**（DEV_GUIDE 2.2）：编辑（含"轻编辑"）、云同步、双链知识库、插件系统、macOS/Linux、遥测、便携版、自动更新。
> **平台硬约束**（DEV_GUIDE 2.3，产品文案必须与之一致）：微信聊天窗口不支持富文本（聊天场景只能发长图）；Windows 10+ 的 UserChoice 禁止应用静默抢默认（只能引导用户手动设一次）；钉钉无公开文档导入 API。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Tauri 2.x（Rust + WebView2），NSIS 安装器，`webviewInstallMode: downloadBootstrapper` |
| 官方插件 | tauri-plugin-single-instance（**main.rs 最先注册**）、tauri-plugin-cli、tauri-plugin-clipboard-manager |
| 渲染内核 | Vditor ≥ 3.11.3 的 `dist/method.min.js`（`Vditor.preview()` + `Vditor.outlineRender()`），**资源本地自托管，禁止 CDN** |
| 前端 | React 18 + TypeScript（`strict`，禁 `any`）+ Zustand + Tailwind CSS + DOMPurify |
| Rust 侧 | winreg / notify / windows + webview2-com（PrintToPdf COM 桥接）/ reqwest / serde / clap / thiserror / tracing |
| 存储 | JSON 于 `%APPDATA%\MDViewer\`；飞书密钥经 DPAPI 加密 |
| 安全 | XSS 三层防御：Lute `markdown.sanitize` + DOMPurify + 严格 CSP（一层都不能少） |

版本基线：Rust stable（edition 2021+）、Node 20+、pnpm。M0 结束时把全部依赖冻结为精确版本号并回填 DEV_GUIDE 4.2。

---

## 开发环境准备

### 必备

| 组件 | 要求 | 本机当前 | 安装方式 |
|---|---|---|---|
| Node.js | **20 +** | ✅ v22.19.0 | https://nodejs.org 或 `winget install OpenJS.NodeJS.LTS` |
| pnpm | **9 +**（随 Node 的 corepack 启用，见 `package.json` 的 `engines`） | ❌ **未安装**（corepack 0.34.0 已在） | `corepack enable pnpm`（如提示权限不足，用管理员 PowerShell） |
| Rust | **stable** 工具链（含 cargo、MSVC target） | ❌ **未安装** | `winget install Rustlang.Rustup`，或从 https://rustup.rs 下载 `rustup-init.exe`；装完执行 `rustup default stable` |
| MSVC 生成工具 | Visual Studio 2022 Build Tools +「使用 C++ 的桌面开发」工作负载 | 未核实 | `winget install Microsoft.VisualStudio.2022.BuildTools`（Tauri 在 Windows 上链接必需） |
| WebView2 Runtime | Evergreen | Win11 系统自带 | Win10 少数设备缺失时从 https://developer.microsoft.com/microsoft-edge/webview2/ 安装；正式安装包会用 bootstrapper 自动补装 |

> 注意：`msedge.exe` 与 WebView2 Runtime 是两个安装体，Runtime 不含 `msedge.exe`。PDF 兜底路线依赖 Edge 时必须经注册表 `App Paths\msedge.exe` 探测真实路径，**不得硬编码**。

### 首次拉起（工具链齐备后）

```powershell
corepack enable pnpm             # 一次性启用 pnpm
pnpm install                     # 安装前端依赖
node scripts/fetch-vditor.mjs    # 按白名单裁剪出 vendor/vditor/ 自托管资源
pnpm gen:corpus                  # 生成 test-corpus/big-10mb.md（10MB 压测语料）
pnpm tauri dev                   # 起开发窗口（需要 Rust 工具链 + 应用图标就位）
```

---

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | Vite 前端开发服务器（不带 Tauri 外壳） |
| `pnpm build` | 前端类型检查 + 产物构建 |
| `pnpm preview` | 本地预览前端构建产物 |
| `pnpm lint` | ESLint 检查 |
| `pnpm test` | Vitest 前端单元测试 |
| `pnpm tauri dev` / `pnpm tauri build` | Tauri 开发窗口 / 打 NSIS 安装包 |
| `pnpm check:no-cdn` | 扫描产物中是否出现 `unpkg` / `jsdelivr` 字符串（**出现即失败**，红线 8） |
| `pnpm gen:corpus` | 生成 `test-corpus/big-10mb.md` 压测语料 |

Rust 侧（在 `src-tauri/` 目录下执行）：

```powershell
cargo test
cargo clippy -- -D warnings     # 必须零告警
cargo tree                      # 核对 webview2-com / windows 与 wry 的版本对齐
```

提交前自测口径见 AI_DEV_GUIDE 第 6 节 DoD：`pnpm lint && pnpm test` + `cargo test && cargo clippy -- -D warnings`；完整 `pnpm tauri build` 仅在 M0-0、触碰打包配置的任务、各里程碑出口时必跑。

---

## 仓库结构

```
E:\MDyuedu\
├── CLAUDE.md                 # AI 会话自动加载的薄入口
├── DEV_GUIDE.md              # 需求与方案（唯一事实来源）
├── AI_DEV_GUIDE.md           # AI 执行手册（红线 / 任务卡 / DoD）
├── THIRD-PARTY-NOTICES.md    # 依赖许可证登记与借鉴规则
├── src/                      # 前端：components / stores / services / render / styles
├── src-tauri/                # Rust：tauri.conf.json / Cargo.toml / src
├── vendor/vditor/            # 自托管渲染资源（不入库，由脚本拉取）
├── test-corpus/              # 标准测试语料（DEV_GUIDE 12.0 六件套）
├── docs/m0/                  # M0 各任务卡验证报告（出口评审依据）
├── scripts/                  # check-no-cdn.mjs / gen-corpus.mjs / fetch-vditor.mjs
└── .github/                  # CI、PR 模板、Issue 模板
```

---

## 文档导航

| 文档 | 作用 | 什么时候读 |
|---|---|---|
| [DEV_GUIDE.md](DEV_GUIDE.md) | **需求与方案的唯一事实来源**：定位、范围、需求规格（FR 编号）、技术选型、UI/交互规范、架构、里程碑与进度表（9.2）、验收清单（12）。与其他文档冲突时以它为准 | 做任何功能前，按章节定点查阅；进度只在它的 9.2 维护 |
| [AI_DEV_GUIDE.md](AI_DEV_GUIDE.md) | **执行手册**：AI/开发者的会话启动协议、15 条红线、已核验事实库、仓库结构、编码规范、完成定义（DoD）、M0 任务卡 | 每次开工先读第 1 节；写代码前读第 2/5 节 |
| [CLAUDE.md](CLAUDE.md) | AI 会话自动加载的薄入口，只做指路和红线速览 | 无需手动读，工具会自动加载 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三方依赖许可证登记 + 参考项目借鉴规则（AGPL 项目禁止抄代码） | 新增依赖、借鉴参考项目代码时 |
| [docs/m0/README.md](docs/m0/README.md) | M0 验证报告的模板与出口评审判定标准 | 做 M0 任务卡、写验证报告时 |

**新人/新 AI 五分钟上手顺序**：本 README → CLAUDE.md → AI_DEV_GUIDE.md 第 1/2 节 → DEV_GUIDE.md 第 0 节与 9.2 → 认领 9.2 中第一个 ⬜/🔄 且无阻塞的任务。

---

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖与参考项目的许可证与合规要求见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

图标集 Lucide（MIT）需保留声明；分享功能**不使用微信/飞书/钉钉官方 Logo**，以规避商标风险（DEV_GUIDE 5.8 / 11.6）。
