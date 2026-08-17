# 第三方组件与许可证声明（THIRD-PARTY NOTICES）

本文件依据 [DEV_GUIDE.md 11.6](DEV_GUIDE.md)（许可证与合规）与 [AI_DEV_GUIDE.md 红线 15](AI_DEV_GUIDE.md) 建立。

本项目（MDNaonao for Windows）自身以 **MIT License** 发布，见 [LICENSE](LICENSE)。本项目分发的二进制中包含或链接了下列第三方组件，其版权归各自作者所有，按各自许可证条款授权。

> **维护义务**
> 1. **新增任何运行时依赖（npm 包 / crate）必须同步登记到本文件**；未登记 = 任务未完成（AI_DEV_GUIDE 第 6 节 DoD）。新增运行时依赖本身需人类批准（红线 12）。
> 2. 下表的**版本列在 M0 结束依赖冻结时回填**（精确版本写入 `package.json` / `pnpm-lock.yaml` / `Cargo.lock`，并回填 DEV_GUIDE 4.2）。
> 3. **许可证字段在 M0 出口评审前逐条以发行包内的 LICENSE 文件为准复核一次**（建议：`pnpm licenses list` + `cargo about generate` 或 `cargo-license`），标注"待核实"的条目必须在那时消除。本文件的记载不能替代对上游 LICENSE 文件的实际查验。
> 4. 借鉴参考项目代码时，在 commit message 注明来源与许可证，并在本文件"参考项目借鉴规则"一节留痕。

---

## 1. 前端运行时依赖（随安装包分发）

| 组件 | 用途 | 许可证 | 版本 | 备注 |
|---|---|---|---|---|
| [Vditor](https://github.com/Vanessa219/vditor) | 渲染内核：`Vditor.preview()` / `Vditor.outlineRender()` | MIT | ≥ 3.11.3（待冻结） | 仅使用 `dist/method.min.js` 及白名单资源，**本地自托管**（DEV_GUIDE 8），`cdn` 参数禁止指向 unpkg/jsdelivr（红线 8） |
| Lute（Vditor 内置 Markdown 引擎，`lute.min.js`） | Markdown 解析 + `markdown.sanitize` 消毒 | **待核实**（以上游 [88250/lute](https://github.com/88250/lute) 仓库 LICENSE 为准，随 vditor dist 一并分发） | 跟随 Vditor | 裁剪 `vendor/vditor/` 时（M0-②）逐文件核实并回填本行 |
| Mermaid | 图表渲染（Vditor 内置调用） | MIT | Vditor 内置 11.x | 随 Vditor 白名单资源分发 |
| KaTeX | 数学公式渲染（Vditor 内置调用） | MIT | Vditor 内置 | 随 Vditor 白名单资源分发；含 KaTeX 字体文件 |
| highlight.js | 代码高亮（Vditor 内置调用） | **待核实**（上游为 BSD-3-Clause） | Vditor 内置 | 同上 |
| [DOMPurify](https://github.com/cure53/DOMPurify) | XSS 三层防御第二层（红线 1） | **(MPL-2.0 OR Apache-2.0) 双许可** | 待冻结 | 双许可，二选一遵守；MPL-2.0 为文件级 copyleft，本项目仅作依赖引用、不修改其源码，因此无源码开放义务 |
| [React](https://github.com/facebook/react) / react-dom | UI 框架 | MIT | 18.x（待冻结） | |
| [Zustand](https://github.com/pmndrs/zustand) | 状态管理 | MIT | 待冻结 | |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | 样式（仅 Token 化使用，红线 14） | MIT | 待冻结 | 产物为生成的 CSS |
| [Lucide](https://github.com/lucide-icons/lucide) | 图标集（16/20px 线性图标） | MIT（DEV_GUIDE 11.6 记载）— **发布前复核**：上游发行包曾以 ISC 分发，以实际 LICENSE 文件为准 | 待冻结 | 必须保留版权声明（DEV_GUIDE 10-10） |

## 2. Rust / Tauri 侧运行时依赖（随可执行文件分发）

| Crate | 用途 | 许可证 | 备注 |
|---|---|---|---|
| `tauri` / `tauri-build` / `tauri-runtime` | 桌面壳 | Apache-2.0 OR MIT | |
| `tauri-plugin-single-instance` | 单实例 + 第二实例 argv/cwd 回调（**必须最先注册**） | Apache-2.0 OR MIT | |
| `tauri-plugin-cli` | `--action` 命令行解析 | Apache-2.0 OR MIT | |
| `tauri-plugin-clipboard-manager` | `write_html()` 写 CF_HTML + 纯文本双格式 | Apache-2.0 OR MIT | 内部使用 `arboard`（MIT OR Apache-2.0） |
| `wry` / `tao` | WebView2 绑定与窗口层（经 Tauri 传递依赖） | Apache-2.0 OR MIT | |
| `windows` / `windows-sys` | Win32 / COM 绑定 | MIT OR Apache-2.0 | 版本**跟随 Tauri 内部 wry 锁定**，永不单独升级（红线 10） |
| `webview2-com` | `ICoreWebView2_7::PrintToPdf` COM 桥接 | MIT（待核实） | 同上，版本跟随 wry |
| `winreg` | 仅用于额外右键动词的注册表键（**永不触碰 UserChoice**，红线 2/3） | MIT | |
| `notify` | 文件监听（外部修改自动刷新） | CC0-1.0 OR Artistic-2.0（待核实，随版本可能不同） | |
| `reqwest` | 飞书 REST 调用 | MIT OR Apache-2.0 | |
| `serde` / `serde_json` | 序列化（recent.json / settings.json） | MIT OR Apache-2.0 | |
| `clap` | 命令行参数解析（与 cli 插件复用） | MIT OR Apache-2.0 | |
| `thiserror` | `AppError` 定义 | MIT OR Apache-2.0 | |
| `tracing` / `tracing-subscriber` / `tracing-appender` | 日志与轮转 | MIT | |
| `headless_chrome` 或 `chromiumoxide`（PDF 兜底 A，M0-① 后定案） | CDP 驱动系统 `msedge.exe` 出 PDF | headless_chrome: MIT / chromiumoxide: MIT OR Apache-2.0（待核实） | 只保留最终选定的一个 |

## 3. 构建期与分发相关

| 组件 | 用途 | 许可证 | 备注 |
|---|---|---|---|
| Vite / TypeScript / ESLint / Vitest / tauri-cli | 开发与构建工具链 | 各自 MIT 或 Apache-2.0（TypeScript 为 Apache-2.0） | 不随产物分发，登记备查 |
| NSIS（经 tauri-bundler 使用） | Windows 安装器 | zlib/libpng 类许可（待核实） | 安装器 stub 随安装包分发，发布前核实声明义务 |
| Microsoft Edge WebView2 Runtime | 运行时宿主 | 微软专有（Microsoft Software License Terms） | **不随本项目分发**；`webviewInstallMode: downloadBootstrapper` 由微软官方 bootstrapper 联网安装 |

---

## 4. 参考项目借鉴规则（红线 15，DEV_GUIDE 11.6 / 13.1）

### 4.1 AGPL-3.0 项目：**仅可借鉴思路，一行代码都不能复制**

| 项目 | 许可证 | 允许 | 禁止 |
|---|---|---|---|
| [tllovesxs/wandao](https://github.com/tllovesxs/wandao) | AGPL-3.0 | 阅读其各平台导入导出**思路**，据此独立实现 | 复制/改写其源码片段、结构性照搬其模块实现、复制其资源文件 |
| MarkFlowy | AGPL-3.0 | 同上 | 同上 |
| Inkdown | AGPL-3.0 | 同上 | 同上 |
| mdSilo | AGPL-3.0 | 同上 | 同上 |

**理由**：AGPL-3.0 具有强 copyleft 与网络分发条款，一旦复制其代码，本项目（MIT）将被迫整体改为 AGPL-3.0，与 DEV_GUIDE 11.6 的许可证决策直接冲突。

**执行口径**：从 AGPL 项目学到的东西只能以"读完关掉、用自己的话在 PR/commit 里描述做法、再自行实现"的方式落地；**不得**在编辑器里并排复制粘贴，**不得**让 AI 代理"参照该文件改写"。若某处实现与其高度相似且无法解释来源，视为违规，必须重写。

### 4.2 MIT / Apache-2.0 项目：可借鉴，但必须保留声明

| 项目 | 许可证 | 借鉴点 |
|---|---|---|
| [Neilooo/md-reader](https://github.com/Neilooo/md-reader) | MIT | Tauri 2 查看器的文件关联与导出实现（最接近的先例） |
| [Vanessa219/vditor](https://github.com/Vanessa219/vditor) | MIT | 渲染内核用法（同时是运行时依赖，见第 1 节） |
| [doocs/md](https://github.com/doocs/md) | 见其仓库 LICENSE（引用前核实） | 公众号内联样式模板与剪贴板方案 |
| [marktext/marktext](https://github.com/marktext/marktext) | MIT | 桌面 MD 应用架构、导出交互 |
| [obsidianmd/obsidian-importer](https://github.com/obsidianmd/obsidian-importer) | MIT | 导入逻辑参考 |
| [Vinzent03/obsidian-advanced-uri](https://github.com/Vinzent03/obsidian-advanced-uri) | MIT | Obsidian 深定位 URI |
| [gkuegler/obsidian-launcher](https://github.com/gkuegler/obsidian-launcher) | 见其仓库 LICENSE（已停更，引用前核实） | `obsidian.json` 读取示例；以 Obsidian 官方数据目录文档为准 |
| [scottli139/vividmark](https://github.com/scottli139/vividmark) | 见其仓库 LICENSE（早期项目，代码自行甄别） | Tauri 2 的 HTML/PDF 导出先例 |

**借鉴 MIT/Apache 代码时的三步义务**：
1. 在 commit message 中注明来源仓库、文件与许可证（AI_DEV_GUIDE 第 5 节"通用"）。
2. 在被借鉴的源文件顶部保留原始版权声明与许可证指引注释。
3. 在本文件第 4.2 表补一行"实际复制了什么"（不只是"参考"），列出目标文件路径。

> 目前尚无实际代码复制记录。发生第一次复制时在此追加清单表。

### 4.3 商标与品牌资源

- 分享功能**不直接使用微信 / 飞书 / 钉钉的官方 Logo**，采用"文字 + 通用抽象图标（气泡 / 纸飞机 / 闪电）"并列的规避方案（DEV_GUIDE 5.8）。
- 发布前按各平台品牌规范逐条核验（DEV_GUIDE 11.6）。
- 应用名 "MDNaonao"（中文名候选"墨读"）发布前需做商标冲突检索（DEV_GUIDE 10-10）。

---

## 5. 待办

- [ ] M0 依赖冻结后回填全部版本号（第 1、2 节）
- [ ] 消除全部"待核实"标记（以发行包内 LICENSE 文件为准）
- [ ] 裁剪 `vendor/vditor/` 时确认 lute / mermaid / KaTeX / highlight.js 各自的 LICENSE 是否已随资源保留
- [ ] 发布前核验 NSIS 与三平台品牌合规声明义务
