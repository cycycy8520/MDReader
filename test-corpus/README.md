# test-corpus —— 标准测试语料库

> 对应 **DEV_GUIDE.md 12.0（标准测试语料库六件套）**，供 12 节全部验收项与日常回归共用。
> 语料是**验收契约的一部分**：改语料等于改验收口径，请连同 DG 12 一起评审。

---

## 0. 三条使用纪律

1. **语料不许被"修好"**。这些文件里的超长行、畸形 HTML、恶意 payload 都是故意的。
   请把 `test-corpus/` 排除在 Prettier / ESLint / markdownlint / EditorConfig 的自动格式化范围之外——
   一次"保存时自动格式化"就能把超长 URL 折行、把 payload 的引号规范化，语料随即失效。
2. **改动语料必须说明理由**。新增元素可以，删减元素不行：`big-10mb.md` 的元素密度直接取决于 `full-gfm.md`，
   删掉一个表格就会让历次压测数据失去可比性（DG 12.0 对 big-10mb 有 ≥500 标题 / ≥100 代码块 / ≥50 表格的下限要求）。
3. **XSS 样本只在本应用里打开**。不要用系统浏览器直接打开 `xss-suite/*.md` 的渲染产物，
   也不要把它们粘贴进任何在线 Markdown 预览服务。

---

## 1. 文件清单与验收映射

| 语料 | 是否入库 | 主要验证的验收项（DG 12） | 一句话用途 |
| --- | :---: | --- | --- |
| `full-gfm.md` | ✅ | M1：双击到首帧 ≤1000ms；大纲两态与滚动高亮；Mermaid 渲染；frontmatter 属性卡片；三种复制（FR-19）<br>v1.0：导出 A4 PDF；导出 HTML 两种模式；打印版式<br>v1.1：公众号 / 飞书 8 项样式清单；长图版式 | 核心基准文档，同时是 PDF / 长图 / 富文本的**视觉基准** |
| `longlines.md` | ✅ | M1：`big-10mb.md` 之外的布局压测；导出 PDF 不截断；长图宽度锁定 | 超长 URL / 超长代码行 / 超宽表格 / 深层嵌套列表 |
| `gbk-source.md` → `gbk.md` | 源文件入库，`gbk.md` 需本地生成 | M1：`gbk.md` 无乱码；状态栏编码显示；导出后中文正确 | GBK 兜底解码验收（见第 3 节） |
| `assets-cn path/图 片.md` | ✅（图片不入库） | M1：本地图片加载（中文/空格路径）<br>v1.0：导出单文件 base64 内联 / 资源目录模式<br>v1.1：Obsidian 导入附件复制与链接重写 | 路径重写解析器的**共用回归用例**（三条导出路径共用一个解析器） |
| `xss-suite/`（15 个样本） | ✅ | M1：全部样本脚本不执行、无外网请求（DevTools Network 为证）；DG 3.2 "外网请求数 = 0" | XSS 三层防御的固定回归集；**升级 Vditor / Lute 前必跑** |
| `big-10mb.md` | ❌（生成物） | M1：不白屏、滚动均值 ≥50fps、内存 ≤250MB、Ctrl+F 命中计数正确<br>v1.0：滚动位置记忆 ±1 屏内 | 10MB 压测文档（见第 2 节） |

> 六件套与 DG 12.0 的对应关系：`full-gfm.md` / `gbk.md` / `big-10mb.md` / `xss-suite/` / `assets-cn path/图 片.md` / `longlines.md`。
> 本目录额外提供 `gbk-source.md`（`gbk.md` 的 UTF-8 源）与本 README，不计入六件套。

---

## 2. `big-10mb.md`：生成物，不入库

`.gitignore` 中已列 `test-corpus/big-10mb.md`。原因：10MB 二进制级体积进版本库会污染 clone 与 diff，
而它完全可由 `full-gfm.md` 确定性地再生。

生成命令（仓库根目录执行）：

```powershell
pnpm gen:corpus
```

等价于 `node ./scripts/gen-corpus.mjs`。脚本以 `full-gfm.md` 内容循环拼接至 **10MB ± 5%**，
并保证 DG 12.0 的元素下限：**≥500 个各级标题、≥100 个代码块、≥50 张表格**。

使用要点：

- 每次拉取代码后、跑性能回归前先执行一次 `pnpm gen:corpus`；**没有它就没有性能数据**。
- 性能数据必须标注基准机（DG 11.4）与生成时间；换机器测出的数字不可跨机比较。
- 若修改过 `full-gfm.md`，必须重新生成，并在性能报告中注明"语料已更新"，否则新旧数据不可比。
- 生成后建议核对一次元素密度（脚本自带校验；`full-gfm.md` 第 6.3 节的 Python 片段是同一套统计口径）。

---

## 3. GBK 语料的生成与注意事项

### 3.1 为什么入库的是 `gbk-source.md` 而不是 `gbk.md`

- `gbk-source.md` 是 **UTF-8** 编码的源文件，可读、可 diff、可评审。
- `gbk.md` 是**非 UTF-8 字节流**，多数编辑器与代码托管平台会把它显示成乱码，直接编辑极易损坏。
- 因此约定：**源文件入库，`gbk.md` 由命令生成**。

### 3.2 生成命令（Windows PowerShell）

在仓库根目录执行。GB18030 是 GBK 的超集，Windows 代码页为 936：

```powershell
# PowerShell 7+ 必须先注册代码页编码提供程序才能拿到 936；
# Windows PowerShell 5.1 内置 936、且没有 CodePagesEncodingProvider 这个类型，
# 因此用 try/catch 包住——两个版本都能直接跑这一段。
try { [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance) } catch { }

$src = 'E:\MDyuedu\test-corpus\gbk-source.md'
$dst = 'E:\MDyuedu\test-corpus\gbk.md'
$text = [System.IO.File]::ReadAllText($src, [System.Text.Encoding]::UTF8)
$gbk  = [System.Text.Encoding]::GetEncoding(936)          # 936 = GBK / GB18030
[System.IO.File]::WriteAllText($dst, $text, $gbk)         # WriteAllText 对 936 不写 BOM
```

### 3.3 生成后必须验证（三项）

```powershell
try { [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance) } catch { }
$bytes  = [System.IO.File]::ReadAllBytes('E:\MDyuedu\test-corpus\gbk.md')
$origin = [System.IO.File]::ReadAllText('E:\MDyuedu\test-corpus\gbk-source.md', [System.Text.Encoding]::UTF8)

# ① 首字节不得是 BOM（EF BB BF 或 FF FE 都算失败；本语料首字节应为 2D 2D 2D，即 frontmatter 的 ---）
Format-Hex -Path 'E:\MDyuedu\test-corpus\gbk.md' -Count 16

# ② 按 UTF-8 解码应出现替换字符（U+FFFD），证明它确实不是 UTF-8
$asUtf8 = [System.Text.Encoding]::UTF8.GetString($bytes)
if ($asUtf8.Contains([char]0xFFFD)) { '② 通过：按 UTF-8 解码失败，确为非 UTF-8 编码' } else { '② 失败：文件仍是 UTF-8' }

# ③ 按 936 解码应与源文件逐字相同
$asGbk = [System.Text.Encoding]::GetEncoding(936).GetString($bytes)
if ($asGbk -eq $origin) { '③ 通过：GBK 解码结果与源文件一致' } else { '③ 失败：存在丢字或转码错误' }
```

> `gbk-source.md` 的 GBK 往返一致性已在入库前用上述 ③ 的方法校验通过（全文可无损转为代码页 936）。
> 新增内容后请重跑一次，防止误引入 GBK 无法表示的字符。

### 3.4 编码注意事项（踩过的坑）

- **不要用 `Set-Content -Encoding` 转码**。PowerShell 5.1 与 7 的默认编码行为不一致，
  `-Encoding Default` / `Oem` 依赖系统区域设置，在非中文系统上会转成别的代码页。一律用上面的 .NET 写法。
- **不要在 `gbk-source.md` 中使用 GBK 无法表示的字符**：Emoji、生僻汉字、日文假名、韩文、
  以及 `✅ ⬜ →` 这类符号中的一部分。转码时它们会变成 `?`，语料即失真。
  源文件顶部已写明此约束，新增内容前请先读一遍。
- **行尾问题不必担心**：GBK 的尾字节范围不含 `0x0D`/`0x0A`，Git 的行尾归一化不会破坏 GBK 文本。
  但若仍想彻底避免任何自动处理，可请仓库负责人在 `.gitattributes` 中加一行
  `test-corpus/gbk.md binary`（本文件作者不拥有 `.gitattributes`，此项仅为建议）。
- **`gbk.md` 是否入库由仓库负责人决定**：入库则需保证上述 `.gitattributes` 或至少不被编辑器改写；
  不入库则每台机器执行一次 3.2 的命令即可（本 README 按"每台机器本地生成"编写）。

---

## 4. 图片资源（二进制，不入库）

语料中引用的图片一律**不提交到仓库**（避免二进制膨胀）。需要验收图片相关项时，按下表自行放置任意 PNG 即可
（内容不限，建议用带明显可辨识图案的图，便于在 PDF / 长图中确认是否丢失）。

| 需要放置的文件 | 被谁引用 |
| --- | --- |
| `test-corpus/assets/architecture.png` | `full-gfm.md` 10.1 / 10.4，`xss-suite/*` 的对照组 |
| `test-corpus/assets-cn path/示 例图.png` | `assets-cn path/图 片.md` 1.1 / 1.2 / 1.3 / 4 / 5，`full-gfm.md` 10.2 |
| `test-corpus/assets-cn path/架构图.png` | `assets-cn path/图 片.md` 1.4 |
| `test-corpus/assets-cn path/plain-ascii.png` | `assets-cn path/图 片.md` 1.5（纯 ASCII 对照组） |
| `test-corpus/assets-cn path/子 目录/深层 图片.png` | `assets-cn path/图 片.md` 第 2 节 |

快速生成占位图（把任意一张 PNG 复制成上述五个文件名）：

```powershell
$root = 'E:\MDyuedu\test-corpus'
New-Item -ItemType Directory -Force "$root\assets" | Out-Null
New-Item -ItemType Directory -Force "$root\assets-cn path\子 目录" | Out-Null
$sample = 'C:\Windows\Web\Screen\img100.jpg'   # 换成任意一张本机 PNG
Copy-Item $sample "$root\assets\architecture.png"
Copy-Item $sample "$root\assets-cn path\示 例图.png"
Copy-Item $sample "$root\assets-cn path\架构图.png"
Copy-Item $sample "$root\assets-cn path\plain-ascii.png"
Copy-Item $sample "$root\assets-cn path\子 目录\深层 图片.png"
```

> **未放置图片时语料依然有用**：此时它是"图片缺失占位"的回归用例——
> 应显示占位框与原始路径，而不是空白、报错弹窗或布局塌陷。
> `full-gfm.md` 10.5 专门保留了一条**永远不存在**的图片引用，即使放好上表图片也仍会缺失，属预期。

---

## 5. `xss-suite/` 使用说明

15 个样本，每个文件名即攻击手法，文件内含 payload、预期结论、验证方法与对照组。

| 文件 | 攻击手法 |
| --- | --- |
| `01-script-tag.md` | `<script>` 标签直接注入（含大小写、嵌套破坏、外部脚本、module） |
| `02-img-onerror.md` | `<img onerror>` 事件（含 beacon 外带、Markdown 图片语法逃逸） |
| `03-svg-onload.md` | SVG `onload` / 内嵌 script / SMIL `onbegin` / `foreignObject` |
| `04-javascript-href.md` | HTML 链接的 `javascript:` 协议（大小写、空白、实体、百分号编码混淆） |
| `05-data-uri-script.md` | `data:` URI 携带脚本（链接 / iframe / object / embed / script src） |
| `06-iframe-inject.md` | iframe 注入（`srcdoc`、隐藏 iframe、点击劫持、顶层导航） |
| `07-event-attr-onmouseover.md` | 事件属性注入（含 `ontoggle`/`autofocus onfocus`/CSS 动画等**免交互**触发） |
| `08-style-css-inject.md` | `<style>`/`<link>`/内联 style：远程资源、`expression()`、全屏钓鱼遮罩、Token 劫持、CSS 数据外带 |
| `09-meta-refresh.md` | `<meta http-equiv=refresh>` 自动跳转、CSP 覆盖尝试、`file://` 跳转 |
| `10-object-embed.md` | `<object>`/`<embed>`/`<applet>`/媒体元素等插件与容器通道 |
| `11-base-tag-hijack.md` | `<base>` 劫持全文相对路径（**定向打击本应用的路径重写解析器**） |
| `12-form-inject.md` | 表单注入与钓鱼（伪造飞书密钥表单、`formaction`、孤立控件、自动提交） |
| `13-md-link-javascript.md` | **纯 Markdown 语法**内藏 `javascript:`（内联/引用式/自动链接/图片/脚注/表格） |
| `14-html-entity-bypass.md` | HTML 实体与多重编码绕过（含"过度解码"反向探针） |
| `15-remote-resource-beacon.md` | 外链资源静默请求（追踪像素、preload/prefetch、字体、CSS、媒体） |

### 5.1 统一验收流程

1. 依次用本应用打开 15 个文件（`--action open` 与双击两条路径各抽测一次）。
2. **每个文件都要做交互**：悬停 / 点击 / 右键 / 滚动一遍所有 payload——
   `04`、`07`、`12`、`13` 的相当一部分 payload 需要用户交互才触发，只"打开看一眼"验不出来。
3. 全程开着 DevTools 的 **Console** 与 **Network** 两个面板：
   - Console 不得出现任何 `XSS-NN-X` 字样的输出，不得弹出任何 `alert`；
   - Network 面板中指向 `xss-beacon.example.invalid` 的请求数必须为 **0**（这是 DG 3.2「外网请求数 = 0」的取数依据）。
4. 逐个检查 **对照组**：几乎每个样本末尾都有一段良性内容（正常链接、正常图片、Mermaid 图、HTML 实体等）。
   对照组失效说明**消毒过严**，同样是缺陷——安全与可用要一起验，不能只看"没炸"。
5. 应用主窗口的 `location.href` 全程不得改变；不得有任何页面导航发生。

> 所有 payload 统一使用 `example.invalid` 域名（RFC 2606 保留域，**永远不可解析**），
> 因此即使意外发出请求也不会真的联通外部主机；但 Network 面板仍会记录该请求，判定依据是**请求是否发出**，不是是否成功。

### 5.2 什么时候必须重跑

- 升级 **Vditor / Lute** 之前与之后各跑一遍（DG 关键结论第 12 条；Lute 有 href 注入 CVE 史）。
- 升级 **DOMPurify** 之后。
- 修改 **CSP 策略**、消毒配置、或渲染管线任何一环之后。
- 每个里程碑出口评审时全量跑一遍。

---

## 6. 快速开始

```powershell
# 1) 生成 10MB 压测语料（必需，否则没有性能数据）
pnpm gen:corpus

# 2) 生成 GBK 语料（完整命令见第 3.2 节，含 PowerShell 7 的编码提供程序注册）
#    ReadAllText(gbk-source.md, UTF8) -> WriteAllText(gbk.md, GetEncoding(936))

# 3) 放置图片占位（见第 4 节）

# 4) 依次打开验收
#    full-gfm.md → longlines.md → gbk.md → assets-cn path\图 片.md → big-10mb.md → xss-suite\*.md
```

验收记录写入 `docs/m0/` 下对应的验证报告（M0 各任务卡的出口评审依据）。
