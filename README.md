# MDNaonao for Windows

> 打开即看、导出即用、分享即达的 Windows Markdown 阅读器。

Windows 10/11 桌面应用，注册为 `.md` 系列文件的默认打开程序。**严格只读**——完全不做编辑，把「看」这一件事做到极致；差异化押在 **Obsidian 一键入库** 与 **微信长图 / 飞书分享** 上。

技术栈：Tauri 2（Rust + WebView2）+ React 18 + TypeScript + Vditor（`Vditor.preview()` 只读渲染，资源本地自托管、零 CDN）。安装包 **≈5.4MB**。

---

## 下载安装

交付物在 [`release/`](release/) 目录（由 `pnpm package` 产出，附 SHA256 校验和）：

| 文件 | 说明 |
|---|---|
| `MDNaonao_x.y.z_x64_setup.exe` | **安装包**（NSIS）。双击安装，自动注册 `.md/.markdown/.mdown/.mkd/.mkdn` 关联 |
| `MDNaonao_x.y.z_x64_portable.zip` | **便携版**（与安装版同一份 exe）。解压即用，数据写在解压目录 `data\` 下，不碰注册表与 %APPDATA% |
| `SHA256SUMS.txt` | 校验和（`certutil -hashfile <文件> SHA256` 比对） |

系统要求：Windows 10/11 x64；WebView2 Runtime（Win11 自带，Win10 缺失时安装器自动补装）。

---

## 功能（当前版本 0.1.0 实际具备）

**渲染**
GFM 全家桶（表格格内换行不截断、任务列表、脚注）、Mermaid、KaTeX（含 `\ce` 化学式）、代码高亮（可选行号 / 折行）、GitHub 五色告警块（`> [!NOTE]` 等）、frontmatter 属性卡片、emoji 短代码、`[TOC]`。UTF-8 / GBK 编码自动识别，>5MB 大文件分段渲染，>50MB 拒开有明确提示。

**阅读体验**
深 / 浅 / 跟随系统主题；字号、缩放、正文列宽三档；可钉住的大纲（滚动高亮）；文档内查找（Ctrl+F）；**专注阅读**（F11，隐去全部外壳只留正文）；外部修改自动刷新且不跳位置；滚动位置记忆（重开恢复）；本地图片直显、外链图片默认不发请求（点击加载）。

**文件组织**
左栏「最近文件 ⇄ 文件夹树」一键互切：**打开文件夹为项目**（顶栏按钮 / 左栏右键 / 正文右键 / Ctrl+Shift+O / 拖入文件夹五个入口），树只显 Markdown、按层懒加载、单击即开、当前文件自动定位，目录变化自动刷新；最近文件夹（用过即记，上限 12）；最近列表分组 / 置顶 / 过滤。

**导出与分享**
导出 HTML（单文件 base64 内联 / 带资源目录两种模式）、导出 PDF（A4、中文字体正确、可选文内目录页）、打印（Ctrl+P）、微信长图 PNG（超长自动分段）、公众号富文本、飞书（零配置富文本粘贴 / 自建应用 API 双通道）、**Obsidian 一键入库**（自动发现 Vault、连同引用图片一起拷贝、URI 直达定位）。

**系统集成**
「用其他编辑器打开源文件 ▸」子菜单与资源管理器「打开方式」同数据源——**检测到什么列什么**（含各应用真实图标），用「其他程序…」选过一次的编辑器自动出现；`.md` 文件专属图标与应用图标分离；右键菜单 Win11 级手感（悬停展开、斜滑不断、贴合重叠）。

> **明确不做**（完整清单见 DEV_GUIDE 2.2）：编辑（含「轻编辑」）、云同步、双链知识库、插件系统、macOS/Linux、任何遥测。

### 常用快捷键

| 键 | 动作 | 键 | 动作 |
|---|---|---|---|
| Ctrl+O | 打开文件 | Ctrl+F | 文档内查找 |
| Ctrl+Shift+O | 打开文件夹 | Ctrl+Shift+F | 左栏过滤 |
| F11 | 专注阅读 | Ctrl+P | 打印 |
| Ctrl+B | 收展左栏 | Ctrl+滚轮 / Ctrl+=/-/0 | 缩放 |

完整总表见 DEV_GUIDE 6.5（唯一事实来源）。

---

## 项目状态

| 里程碑 | 状态 |
|---|---|
| M1 阅读体验（批次 1–5：WebView 驯服 / 阅读连续性 / 查找与右键 / 排版 / 文件夹模式） | ✅ 自验通过，待用户整体验收（4.4 文件关联装包实测除外） |
| M2 导出发布（HTML / PDF / 打印 / 长图） | ✅ 提前完成自验 |
| M3 生态（Obsidian 入库 / 微信 / 飞书分享） | ✅ 主链路已通 |
| v1.0 公开发布收尾（winget 上架、签名、检查更新） | ⬜ 计划中 |
| V2（Win11 一级右键、Ctrl+K 快速切换、衬线模式、自动更新等） | 评估池 |

条目级进度唯一记录处：[UPGRADE_PLAN.md](UPGRADE_PLAN.md) 第 6 节进度总表。

---

## 从源码构建

依赖：Node 20+、pnpm 9+（`corepack enable pnpm`）、Rust stable（MSVC target）、VS 2022 Build Tools（C++ 桌面开发）。

```powershell
pnpm install
node scripts/fetch-vditor.mjs    # 按白名单裁剪 vendor/vditor/ 自托管渲染资源（不入库）
pnpm gen:corpus                  # 生成 10MB 压测语料（可选）
pnpm tauri dev                   # 开发窗口
pnpm package                     # 一条命令产出 release/ 三件套（安装包+便携版+校验和）
```

| 校验命令 | 作用 |
|---|---|
| `pnpm lint && pnpm test` | ESLint + Vitest |
| `cargo test && cargo clippy -- -D warnings`（src-tauri/ 下） | Rust 测试 + 零告警门 |
| `pnpm check:no-cdn` | 产物出现 `unpkg`/`jsdelivr` 即失败（红线 8） |

注意事项：换应用/文件图标后必须 `cargo clean -p mdnaonao --release` 再打包（图标由 build 脚本嵌入 exe，cargo 不追踪 icons 目录）；交付物一律出自 `pnpm tauri build` / `pnpm package`（`cargo build --release` 的 exe 内嵌 devUrl，脱离开发服务器即白屏）。

---

## 仓库结构

```
├── DEV_GUIDE.md              # 需求与方案（唯一事实来源）
├── AI_DEV_GUIDE.md           # AI 执行手册（红线 / 事实库 / DoD）
├── UPGRADE_PLAN.md           # 当前阶段任务卡与条目级进度
├── CLAUDE.md                 # AI 会话自动加载的薄入口
├── THIRD-PARTY-NOTICES.md    # 依赖许可证登记与借鉴规则
├── release/                  # 交付物：安装包 + 便携版 + 校验和（pnpm package 产出）
├── src/                      # 前端：components / stores / services / render / styles / i18n
├── src-tauri/                # Rust：files / dirtree / export / capture / share / obsidian / shell_integ …
├── vendor/vditor/            # 自托管渲染资源（不入库，脚本拉取）
├── test-corpus/              # 标准测试语料（渲染回归 + 压测 + XSS 套件）
├── docs/                     # 审计与验证报告
└── scripts/                  # package / fetch-vditor / gen-corpus / check-no-cdn …
```

## 文档导航

| 文档 | 作用 |
|---|---|
| [DEV_GUIDE.md](DEV_GUIDE.md) | **唯一事实来源**：定位、范围（2.1/2.2）、需求规格、选型、UI 规范（5/6 章）、架构、里程碑、验收清单。冲突时以它为准 |
| [UPGRADE_PLAN.md](UPGRADE_PLAN.md) | 任务卡、验收纪律、进度总表、右键菜单规格（附录 A） |
| [AI_DEV_GUIDE.md](AI_DEV_GUIDE.md) | 会话启动协议、15 条红线、已核验事实库、编码规范、完成定义 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三方许可证 + 参考项目借鉴规则（AGPL 只看思路禁止抄码） |

**新人/新 AI 上手顺序**：本 README → CLAUDE.md → AI_DEV_GUIDE 第 1/2 节 → DEV_GUIDE 第 0 节 → UPGRADE_PLAN 进度总表。

---

## 许可证

[MIT License](LICENSE)。第三方依赖与参考项目的合规要求见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。分享功能不使用微信/飞书/钉钉官方 Logo（商标规避，DEV_GUIDE 11.6）。
