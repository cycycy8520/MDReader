---
title: 极端排版压测语料（longlines）
tags: [压测, 换行, 横向滚动, 深层嵌套]
date: 2026-08-17
description: 超长 URL / 超长代码行 / 超宽表格 / 深层嵌套列表，验证布局不被撑破
---

# 极端排版压测语料

> 本文件专治"撑破布局"类缺陷。**唯一的全局验收口径：阅读区容器自身不得出现横向滚动条**——
> 允许出现横向滚动的只有代码块、表格、Mermaid 容器这三类**块级子元素**（各自独立滚动）。
> 若整个阅读区（或整个窗口）出现横向滚动条，即为缺陷。
>
> 同时验收：导出 PDF 时长内容按 A4 宽度换行且不被截断；导出长图时宽度锁定 720px 版式不被撑宽。

---

## 1. 超长 URL（无空格，不可断词）

### 1.1 裸 URL（GFM autolink）

https://example.invalid/api/v3/documents/render/preview?documentId=8f14e45fceea167a5a36dedd4bea2543&revision=20260817T093000Z&mode=readonly&theme=follow-system&sanitize=true&autoSpace=true&footnotes=true&mathEngine=katex&hljsStyle=github&outline=pinned&scrollAnchor=heading-42-offset-317&chunkStrategy=viewport-first-then-idle&chunkSize=262144&maxChunks=512&telemetry=disabled&trustRemoteImages=false&exportTarget=none&signature=b6a1f0c9d3e84725ab19cf0d5e6172839a4bcd0e1f2a3b4c5d6e7f8091a2b3c4

### 1.2 Markdown 链接语法包裹的超长 URL

[点击这里查看一条被链接文本包裹的超长 URL](https://example.invalid/very/deeply/nested/path/segment-one/segment-two/segment-three/segment-four/segment-five/segment-six/segment-seven/segment-eight/segment-nine/segment-ten/resource.html?utf8=%E2%9C%93&query=%E4%B8%AD%E6%96%87%E6%9F%A5%E8%AF%A2%E5%8F%82%E6%95%B0&page=1&pageSize=100&sortBy=lastModifiedDescending&filter=extension%3Amd%2Cmarkdown%2Cmdown%2Cmkd%2Cmkdn&token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik1EIFZpZXdlciIsImlhdCI6MTUxNjIzOTAyMn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c)

### 1.3 链接文本本身就是超长 URL（最难换行的形态）

[https://example.invalid/this/is/an/extremely/long/link/text/that/is/itself/a/url/and/therefore/contains/no/whitespace/at/all/which/makes/it/the/hardest/case/for/word-wrapping/engines/because/there/is/literally/nowhere/to/break/unless/the/renderer/applies/overflow-wrap-anywhere/or/word-break-break-all/to/the/anchor/element/index.html](https://example.invalid/)

### 1.4 超长文件路径（Windows 与 UNC 形态）

行内代码形态：`C:\Users\某个很长的中文用户名\Documents\项目资料\2026 年度\Markdown 文档归档\第三季度\技术方案\MDNaonao\开发指南与验收清单\附件\这是一个非常非常长的文件名用于验证行内代码块在窄容器下的换行策略是否正确.md`

UNC 形态（仅手工回归覆盖，不入库）：`\\file-server-01.corp.example.invalid\shared-documents$\部门共享\研发中心\前端组\Markdown 归档\2026\08\17\会议纪要-关于渲染管线分段策略的讨论记录-最终版-v3-确认稿.md`

### 1.5 超长单词（英文，无连字符）

Supercalifragilisticexpialidociouspneumonoultramicroscopicsilicovolcanoconiosisantidisestablishmentarianismfloccinaucinihilipilificationhippopotomonstrosesquippedaliophobiapseudopseudohypoparathyroidism

### 1.6 超长中文无标点串

渲染引擎在处理没有任何标点符号也没有任何空格的超长中文字符串时必须按字符边界断行否则容器会被撑破进而在阅读区产生横向滚动条这一串文本故意写得非常长并且刻意避免使用任何标点符号包括逗号句号顿号分号冒号问号感叹号引号括号书名号省略号破折号连接号间隔号以及任何形式的空白字符用来把断行策略逼到极限并同时验证导出为便携文档格式时的换行表现是否与预览一致

---

## 2. 超长代码行

### 2.1 JavaScript：单行约 1200 字符

```js
const EXPORT_PIPELINE_CONFIGURATION_MATRIX = { singleFileHtml: { inlineImagesAsBase64: true, inlineStylesheets: true, inlineFonts: false, stripScripts: true, rewriteRelativeAssetPaths: true, maxInlineImageBytes: 5 * 1024 * 1024, warnWhenOutputExceedsBytes: 20 * 1024 * 1024, fallbackWhenImageMissing: 'placeholder-box-with-original-path' }, htmlWithAssetsFolder: { assetsFolderSuffix: '_files', copyImages: true, copyFonts: true, rewriteRelativeAssetPaths: true, preserveOriginalFileNames: true, deduplicateByContentHash: true, conflictStrategy: 'append-numeric-suffix' }, portableDocumentFormat: { paperSize: 'A4', marginsMillimetres: { top: 18, right: 15, bottom: 18, left: 15 }, headerEnabled: false, footerEnabled: false, printBackground: true, waitForReadySignalMilliseconds: 30000, fallbackRoute: 'chrome-devtools-protocol-via-system-edge', embedChineseFontSubset: true }, longImageCapture: { widthPixels: 720, captureBeyondViewport: true, maximumSingleImageHeightPixels: 16384, paginateWhenExceedingMaximumHeight: true, outputFormat: 'png', clipboardWriteEnabled: true } };
```

### 2.2 Rust：单行约 900 字符

```rust
pub const REGISTRY_KEYS_WRITTEN_AT_INSTALL_TIME: &[&str] = &["HKEY_CURRENT_USER\\Software\\Classes\\MDNaonao.Document\\shell\\open\\command", "HKEY_CURRENT_USER\\Software\\Classes\\MDNaonao.Document\\shell\\ExportHtml\\command", "HKEY_CURRENT_USER\\Software\\Classes\\MDNaonao.Document\\shell\\ExportPdf\\command", "HKEY_CURRENT_USER\\Software\\Classes\\MDNaonao.Document\\shell\\ImportToObsidian\\command", "HKEY_CURRENT_USER\\Software\\Classes\\MDNaonao.Document\\shell\\ShareAsLongImage\\command", "HKEY_CURRENT_USER\\Software\\Classes\\MDNaonao.Document\\DefaultIcon", "HKEY_CURRENT_USER\\Software\\Classes\\Applications\\mdnaonao.exe\\SupportedTypes"];
```

### 2.3 Bash：单行约 1000 字符

```bash
pnpm exec node ./scripts/gen-corpus.mjs --source ./test-corpus/full-gfm.md --target ./test-corpus/big-10mb.md --target-bytes 10485760 --tolerance 0.05 --min-headings 500 --min-code-blocks 100 --min-tables 50 --rewrite-heading-anchors --renumber-sections --strip-frontmatter-after-first-copy --shuffle-block-order false --verify-after-write --report ./logs/gen-corpus-report.json && pnpm exec node ./scripts/check-no-cdn.mjs --dist ./dist --dist ./src-tauri/target/release --pattern 'unpkg' --pattern 'jsdelivr' --fail-on-match --report ./logs/no-cdn-report.json && echo "语料生成与禁用域名扫描全部通过，可以进入渲染回归阶段"
```

### 2.4 单行 JSON（无换行，约 700 字符）

```json
{"schemaVersion":1,"recentFiles":[{"path":"E:\\MDyuedu\\test-corpus\\full-gfm.md","displayName":"full-gfm.md","parentFolderTail":"test-corpus","lastOpenedAt":"2026-08-17T09:30:00+08:00","pinned":true,"scrollAnchor":{"headingId":"code-blocks","offsetPixels":317},"encoding":"UTF-8","sizeBytes":18432,"missing":false},{"path":"E:\\MDyuedu\\test-corpus\\longlines.md","displayName":"longlines.md","parentFolderTail":"test-corpus","lastOpenedAt":"2026-08-17T09:31:12+08:00","pinned":false,"scrollAnchor":{"headingId":"deep-nesting","offsetPixels":0},"encoding":"UTF-8","sizeBytes":9216,"missing":false}],"windowState":{"x":120,"y":80,"width":1280,"height":860,"maximized":false,"sidebarWidth":260,"outlinePinned":true}}
```

### 2.5 缩进型代码块（四空格）内的长行

    这是四空格缩进的代码块，下面一行同样很长：非常长的一行内容用于验证缩进型代码块与围栏型代码块在横向滚动行为上是否一致 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

---

## 3. 超宽表格

### 3.1 22 列（列头短、数据密）

| # | 模块 | 文件 | 语言 | 行数 | 覆盖率 | 圈复杂度 | 依赖数 | 被依赖数 | 单测 | 集成测 | 语料回归 | 性能敏感 | 安全敏感 | 平台相关 | 里程碑 | 优先级 | 状态 | 负责人 | 最近改动 | 备注 | 关联 FR |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | :---: | :---: | :---: | :---: | :---: | :---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | render | preview.ts | TypeScript | 412 | 78% | 14 | 6 | 9 | ✅ | ✅ | ✅ | 是 | 是 | 否 | M1 | P0 | 进行中 | 待定 | 2026-08-17 | 三层防御第二层落点 | FR-01 |
| 2 | render | outline.ts | TypeScript | 236 | 71% | 9 | 3 | 4 | ✅ | ⬜ | ✅ | 是 | 否 | 否 | M1 | P0 | 未开始 | 待定 | 2026-08-17 | 滚动高亮自研 | FR-04 |
| 3 | files | reader.rs | Rust | 318 | 84% | 11 | 5 | 7 | ✅ | ✅ | ✅ | 是 | 否 | 是 | M1 | P0 | 未开始 | 待定 | 2026-08-17 | UTF-8 优先 GBK 兜底 | FR-01 |
| 4 | export | pdf.rs | Rust | 527 | 62% | 22 | 8 | 2 | ✅ | ⬜ | ⬜ | 是 | 否 | 是 | v1.0 | P0 | 未开始 | 待定 | 2026-08-17 | COM 调用链最高风险 | FR-08 |
| 5 | export | html.rs | Rust | 389 | 75% | 16 | 6 | 3 | ✅ | ✅ | ✅ | 否 | 是 | 否 | M1 | P0 | 未开始 | 待定 | 2026-08-17 | 路径重写解析器共用 | FR-07 |
| 6 | capture | long_image.rs | Rust | 274 | 58% | 13 | 4 | 1 | ✅ | ⬜ | ⬜ | 是 | 否 | 是 | v1.1 | P1 | 未开始 | 待定 | 2026-08-17 | 16384px 分页拼接 | FR-10 |
| 7 | share | lark.rs | Rust | 441 | 69% | 19 | 7 | 1 | ✅ | ⬜ | ⬜ | 否 | 是 | 否 | v1.1 | P1 | 未开始 | 待定 | 2026-08-17 | 20MB 上限与降级 | FR-11 |
| 8 | obsidian | vault.rs | Rust | 205 | 81% | 8 | 3 | 2 | ✅ | ⬜ | ⬜ | 否 | 否 | 是 | v1.1 | P1 | 未开始 | 待定 | 2026-08-17 | obsidian.json 解析 | FR-09 |

### 3.2 8 列但单元格内容极长（另一种撑破方式）

| 场景编号 | 场景描述 | 前置条件 | 操作步骤 | 预期结果 | 实际结果 | 判定 | 备注 |
| --- | --- | --- | --- | --- | --- | :---: | --- |
| TC-001 | 在已存在主实例的前提下双击第二个 Markdown 文件，验证单实例路由链路端到端的正确性与耗时是否满足热启动一秒以内的硬性指标要求 | 应用已启动并处于最小化状态，最近列表中已有至少三条记录，且待打开文件位于中文加空格路径下 | 第一步在资源管理器中定位到测试文件；第二步双击该文件；第三步立即开始计时直到阅读区首帧渲染完成；第四步在性能日志中读取单实例回调时间戳与首帧时间戳并求差 | 新进程立即退出，主实例窗口从最小化状态恢复并置顶，阅读区渲染出目标文件内容，最近列表新增一条记录并置于今天分组首位，日志中记录的耗时不超过一千毫秒 | 待回填 | 待定 | 基准机口径见 DG 11.4，测量方法以性能日志为准而非人工秒表 |
| TC-002 | 在超过五兆字节的大文档上触发文档内查找，验证分段渲染场景下查找会先后台补全渲染再给出命中计数，且期间浮条显示正在索引的提示文案 | 已打开 big-10mb.md，页面仅渲染了首屏分块，其余分块尚未渲染 | 第一步按下组合键唤起查找浮条；第二步输入一个在文档尾部才出现的关键词；第三步观察浮条状态文案与计数变化；第四步按回车逐个跳转到命中项 | 浮条立即显示正在索引的提示，后台补全全部分块渲染后计数稳定为正确的总命中数，逐个跳转时目标命中背景出现一次四百毫秒的高亮脉冲，滚动本身为瞬时不带动画 | 待回填 | 待定 | 与 FR-05 的验收项逐字对应，计数正确性以脚本统计结果为准 |

---

<a id="deep-nesting"></a>

## 4. 深层嵌套列表

### 4.1 无序列表：10 级

- 第 1 级：MDNaonao
  - 第 2 级：前端 src/
    - 第 3 级：components/
      - 第 4 级：阅读区
        - 第 5 级：代码块组件
          - 第 6 级：复制按钮
            - 第 7 级：就地反馈状态机
              - 第 8 级：图标切换为对勾
                - 第 9 级：保持 1.5 秒
                  - 第 10 级：恢复原图标（此级仍应有正确缩进与项目符号）

### 4.2 有序列表：8 级

1. 第 1 级：M0 阶段
   1. 第 2 级：建仓与脚手架
      1. 第 3 级：接入官方插件
         1. 第 4 级：single-instance
            1. 第 5 级：必须最先注册
               1. 第 6 级：回调内复用 clap 解析
                  1. 第 7 级：解析失败时的兜底
                     1. 第 8 级：记日志并按普通打开处理

### 4.3 混合嵌套 + 任务列表 + 引用 + 代码（7 级）

- 第 1 级：验收清单
  1. 第 2 级：M1 出口
     - [ ] 第 3 级：双击到首帧 ≤1000ms
       - 第 4 级：测量口径
         1. 第 5 级：自单实例回调计时
            - 第 6 级：数据来源
              > 第 7 级：引用块出现在第 7 级缩进下，左边框与缩进都不应错位。
              >
              > ```bash
              > # 第 7 级缩进下的代码块
              > pnpm test -- --reporter=verbose
              > ```
     - [x] 第 3 级：xss-suite 全部样本通过

### 4.4 深层嵌套下的超长内容（缩进 + 不可断词双重压力）

- 第 1 级
  - 第 2 级
    - 第 3 级
      - 第 4 级
        - 第 5 级
          - 第 6 级：https://example.invalid/deeply/indented/list/item/containing/an/extremely/long/url/that/cannot/be/broken/at/any/whitespace/because/there/is/none/whatsoever/in/this/entire/string/segment/final.html
          - 第 6 级：`E:\MDyuedu\test-corpus\assets-cn path\一个非常长的中文文件名用来验证深层缩进下行内代码的换行行为是否正确.png`

---

## 5. 其他撑破布局的形态

### 5.1 超宽 Mermaid 图（横向节点链）

```mermaid
flowchart LR
    S1[读取文件字节] --> S2[去除 BOM] --> S3[检测编码] --> S4[GBK 兜底解码] --> S5[剥离 frontmatter] --> S6[构建属性卡片] --> S7[按标题分块] --> S8[渲染首屏分块] --> S9[DOMPurify 过滤] --> S10[空闲渲染剩余分块] --> S11[提取标题树] --> S12[挂滚动高亮] --> S13[恢复滚动锚点] --> S14[更新最近列表] --> S15[上报首帧指标]
```

### 5.2 超长行内公式

$$
L_{\text{total}} = \alpha_1 x_1 + \alpha_2 x_2 + \alpha_3 x_3 + \alpha_4 x_4 + \alpha_5 x_5 + \alpha_6 x_6 + \alpha_7 x_7 + \alpha_8 x_8 + \alpha_9 x_9 + \alpha_{10} x_{10} + \alpha_{11} x_{11} + \alpha_{12} x_{12} + \alpha_{13} x_{13} + \alpha_{14} x_{14} + \alpha_{15} x_{15} + \alpha_{16} x_{16} + \alpha_{17} x_{17} + \alpha_{18} x_{18} + \alpha_{19} x_{19} + \alpha_{20} x_{20}
$$

### 5.3 超长标题（影响大纲截断与 tooltip）

#### 这是一个非常长的四级标题用于验证大纲面板在标题超出列宽时是否正确截断并在悬停时以 tooltip 展示完整标题同时验证锚点跳转在长标题上依然精准

### 5.4 单行超多行内代码

`a1` `a2` `a3` `a4` `a5` `a6` `a7` `a8` `a9` `a10` `a11` `a12` `a13` `a14` `a15` `a16` `a17` `a18` `a19` `a20` `a21` `a22` `a23` `a24` `a25` `a26` `a27` `a28` `a29` `a30` `a31` `a32` `a33` `a34` `a35` `a36` `a37` `a38` `a39` `a40`

### 5.5 超长表格单行（单列，内容不换行）

| 唯一列 |
| --- |
| `ThisIsASingleUnbreakableTokenInsideATableCellThatIsDeliberatelyMadeExtremelyLongSoThatTheTableMustEitherScrollHorizontallyOrBreakTheLayoutAndWeExpectTheFormerNotTheLatterEndOfToken` |
