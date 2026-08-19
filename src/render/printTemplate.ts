/**
 * 打印模板 —— M2「导出 PDF / 打印」的前端半（DG 7.2-4 数据流的第一步）。
 *
 * 【它解决的问题】
 * M0-① 的 PrintToPdf 主路线打印的是**主窗口**，于是左栏、顶栏、状态栏会一起被印进 PDF。
 * 本模块产出一份「只有正文、没有界面外壳」的独立打印文档：
 *
 *   Rust（export.rs）建隐藏打印窗口，用 initialization_script 注入 [`PRINT_JOB_GLOBAL`]
 *     → 前端入口（main.tsx）读到任务就**不挂载 React 应用**，改调 [`renderPrintPage`]
 *     → 读原文 → 复用渲染管线渲染 → 组装完整 HTML 文档 → 装载进当前 document
 *     → 就绪后打 [`PRINT_READY_ATTR`] 标志并 emit PRINT_READY
 *     → Rust 收到信号，执行 PrintToPdf / ShowPrintUI。
 *
 * 【为什么正文必须走 preview.ts 的 renderMarkdown】
 * 「预览 = 导出」是 PDF 主路线的立身之本（DG 4.1 选型理由）。自己再写一条渲染路径
 * 意味着 Mermaid / KaTeX / 告警块 / 代码高亮 / 图片改写各有两份实现，
 * 任何一处漂移用户都会看到「屏幕上好好的，导出来变样了」。所以这里只做三件事：
 * 造一个 A4 正文宽度的离屏容器 → 交给 renderMarkdown 渲染 → 取走它的 innerHTML。
 *
 * 【为什么打印一律浅色，不跟随应用主题】
 * 1. 省墨：深色主题打印出来是整页实底黑，激光打印机一页顶十页的碳粉，喷墨更糟；
 * 2. 专业：PDF 是要发给同事 / 存档的产物，白底黑字是文档的通用形态，深色底会被当成截图；
 * 3. 可读：多数打印机的浅色文字压在深底上会糊成一团（碳粉扩散），对比度反而更差。
 * 因此 [`PRINT_THEME`] 恒为 "light"，生成的文档在 <html> 上写死 data-theme="light"，
 * 与用户当前主题无关——这是刻意的产品决策，不是漏接线。
 *
 * 【为什么 CSS 要内联而不是留 <link>】
 * 打印窗口是隐藏窗口，PrintToPdf 在页面「看起来就绪」的那一刻就会开印。
 * 外链样式表的加载是异步的，一旦晚于 PRINT_READY，印出来就是一份没有样式的裸 HTML。
 * 全部内联成 <style> 之后，文档装载完成即样式完成，不存在这个竞态；
 * 同时这份文档字符串本身也是自洽的（离线、可另存、可复用给 FR-07 导出 HTML）。
 */

import { t } from "../i18n/zh-CN";
import {
  emitHeadlessExportDone,
  emitPrintReady,
  exportHtml,
  readMarkdown,
} from "../services/ipc";
import type {
  ExportHtmlMode,
  FrontmatterDisplay,
  OutlineNode,
  ResolvedTheme,
} from "../types";
import { buildHtmlExport } from "./htmlExport";
import { renderMarkdown } from "./preview";

/* ── 前后端契约 ─────────────────────────────────────────────── */

/**
 * Rust 侧经 `initialization_script` 注入到打印窗口的全局变量名。
 * **必须与 src-tauri/src/export.rs 的 `PRINT_JOB_GLOBAL` 逐字一致**，改一侧即改两侧。
 *
 * 用初始化脚本而不是 URL query 传参的三个理由：
 *   1. Windows 路径里的反斜杠、中文、空格、`#`、`%` 在 query 里要来回编解码，错一次就打不开文件；
 *   2. 初始化脚本在页面任何脚本之前执行，main.tsx 一开始就能判断「这是不是打印窗口」，
 *      不必先挂载应用再拆掉；
 *   3. 它由 WebView2 的 AddScriptToExecuteOnDocumentCreated 注入，不受 CSP `script-src 'self'` 限制
 *      （Tauri 自身的 IPC 初始化脚本走的就是同一条路）。
 */
export const PRINT_JOB_GLOBAL = "__MDNAONAO_PRINT_JOB__";

/**
 * 装载完成后打在 `<html>` 上的就绪标志。
 * PRINT_READY 事件是给 Rust 的主信号，这个属性是给排查用的旁证：
 * 导出的 PDF 若是空白，先看这个属性在不在，就能立刻分清是「前端没渲染完」还是「Rust 印早了」。
 */
export const PRINT_READY_ATTR = "data-print-ready";

/** 渲染失败时改打这个属性（值为错误信息），失败原因会直接印进 PDF，不留一页空白 */
export const PRINT_ERROR_ATTR = "data-print-error";

/**
 * 隐藏渲染窗口的三种作业：
 * - `pdf`    Rust 走 PrintToPdf 静默导出；本窗口只负责渲染 + 发 PRINT_READY；
 * - `dialog` Rust 走 ShowPrintUI 弹系统对话框；同上；
 * - `html`   `--action to-html` 的无 UI 路径。**方向与前两者相反**：产物要靠前端
 *            渲染出的 payload，所以由本窗口自己 invoke `export_html` 落盘，
 *            再发 HEADLESS_EXPORT_DONE 告诉 Rust 成败。
 */
export type PrintMode = "pdf" | "dialog" | "html";

/** Rust 注入的打印任务（字段名与 export.rs 的 `PrintJob` serde camelCase 一致） */
export interface PrintJob {
  /** 待打印的 Markdown 文档绝对路径 */
  source: string;
  /** 是否插入文内目录页（PrintToPdf 不产生 PDF 书签，只能做文内目录，FR-08） */
  includeToc: boolean;
  mode: PrintMode;
  /** 仅 `html` 作业：产物落点绝对路径。其余两态为 null（落点在 Rust 侧） */
  output: string | null;
  /** 仅 `html` 作业：单文件内联 / HTML + 资源目录 */
  htmlMode: ExportHtmlMode | null;
}

declare global {
  interface Window {
    /** 见 [`PRINT_JOB_GLOBAL`]；非打印窗口下恒为 undefined */
    __MDNAONAO_PRINT_JOB__?: unknown;
  }
}

/* ── 版式常量 ───────────────────────────────────────────────── */

/**
 * 打印恒用浅色。理由见文件头注释第三段（省墨 / 专业 / 可读），不跟随 settings.theme。
 */
const PRINT_THEME: ResolvedTheme = "light";

/**
 * A4 正文宽度（CSS px）。
 *
 * 算式与 export.rs 的 COM 打印设置同源，改一处必须改另一处：
 *   A4 宽 8.27in × 96dpi = 793.9px，减去左右各 0.4in（PDF_MARGIN_IN）× 96 = 76.8px
 *   → 717px。
 *
 * 为什么必须是这个数而不是「随便给个宽度」：Mermaid 在渲染时会按容器宽度算图的版面，
 * KaTeX 与表格同理。用屏幕宽度渲染再拿去打印，宽图会被裁在页边之外——
 * 而 PDF 没有横向滚动条，裁掉就是永久丢失。
 */
const PRINT_CONTENT_WIDTH_PX = 717;

/**
 * 打印正文基准字号（px），**刻意不跟随 settings.fontSize / zoomPercent**。
 *
 * 阅读区的字号是「这台机器上这个人此刻看得舒服」的设置；PDF 是要发出去的产物，
 * 版式必须可复现：同一份文档在谁的机器上导出都应该是同样的页数与断行。
 * 15px 在 717px 正文宽下约合每行 47 个汉字，是中文长文的舒适区间。
 */
const PRINT_FONT_PX = 15;

/** 正文根节点的类名：与 App.tsx 阅读区容器保持一致，样式才吃得到同一套规则 */
const PRINT_ROOT_CLASS =
  "markdown-body md-content vditor-reset vditor-reset--anchor md-print-root";

/** 装载后等字体与布局稳定的上限（KaTeX 字体是按需触发的，内联样式表后会重新解析一次） */
const MOUNT_SETTLE_TIMEOUT_MS = 3000;

/* ── 1. 读取 Rust 注入的打印任务 ────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 读取并校验打印任务；非打印窗口（或注入体不合法）返回 null。
 *
 * main.tsx 的用法：
 * ```ts
 * const job = readPrintJob();
 * if (job !== null) { void renderPrintPage(job); } else { ReactDOM.createRoot(...).render(<App/>); }
 * ```
 * 逐字段校验而不是直接断言类型：注入体来自 Rust 的 JSON 序列化，理论上可信，
 * 但「可信来源 + 不校验」正是最难查的一类崩溃（字段改名后前端静默拿到 undefined）。
 */
export function readPrintJob(): PrintJob | null {
  const raw: unknown = window[PRINT_JOB_GLOBAL];
  if (!isRecord(raw)) {
    return null;
  }
  const source: unknown = raw.source;
  if (typeof source !== "string" || source === "") {
    console.warn("[print] print job injected without a usable source path", raw);
    return null;
  }
  const mode: PrintMode =
    raw.mode === "dialog" ? "dialog" : raw.mode === "html" ? "html" : "pdf";
  const output = typeof raw.output === "string" && raw.output !== "" ? raw.output : null;
  const htmlMode: ExportHtmlMode | null =
    raw.htmlMode === "single-file" || raw.htmlMode === "with-assets" ? raw.htmlMode : null;

  if (mode === "html" && output === null) {
    // 只在这一态是硬伤：没有落点就没有产物，继续走只会白渲染一遍再静默失败
    console.warn("[print] html job injected without an output path", raw);
    return null;
  }

  return { source, includeToc: raw.includeToc === true, mode, output, htmlMode };
}

/* ── 2. 离屏正文渲染（复用渲染管线） ────────────────────────── */

interface PrintStage {
  readonly host: HTMLDivElement;
  readonly dispose: () => void;
}

/**
 * 造一个「A4 正文宽度」的离屏容器交给 renderMarkdown。
 *
 * 三条约束与 preview.ts 的 createRenderStage 同源，缺一不可：
 *   1. 必须挂在 document 上——脱离文档树没有布局，Mermaid 的 getBBox 会全拿到 0；
 *   2. 只能 visibility:hidden，不能 display:none——后者同样没有布局盒；
 *   3. 宽度必须写死成 [`PRINT_CONTENT_WIDTH_PX`]，理由见该常量注释。
 *
 * 排版变量直接写在 inline style 上：renderMarkdown 内部的舞台会整段镜像这份 style，
 * 于是离屏测量与最终版面用的是同一套字号。
 */
function createPrintStage(): PrintStage {
  const stage = document.createElement("div");
  stage.setAttribute("data-print-stage", "true");
  stage.setAttribute("aria-hidden", "true");
  stage.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${PRINT_CONTENT_WIDTH_PX}px`,
    "height:0",
    "overflow:hidden",
    "visibility:hidden",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");

  const host = document.createElement("div");
  host.className = PRINT_ROOT_CLASS;
  // 代码一律折行：纸面没有横向滚动条，不折行就是把超长行裁掉（FR-08「代码块不截断换行」）
  host.setAttribute("data-code-wrap", "on");
  host.style.cssText = [
    `width:${PRINT_CONTENT_WIDTH_PX}px`,
    `--md-reading-font:${PRINT_FONT_PX}px`,
    "--md-zoom:1",
  ].join(";");

  stage.appendChild(host);
  document.body.appendChild(stage);
  return {
    host,
    dispose: () => {
      stage.remove();
    },
  };
}

/* ── 3. 文内目录页（FR-08） ─────────────────────────────────── */

/**
 * 从大纲树生成目录列表 DOM。
 *
 * 用 DOM API 而不是拼字符串：标题文本来自作者文档，textContent 赋值天然不解析标记，
 * 这条路径因此整体在 XSS 面之外；序列化时 outerHTML 也会把属性值里的引号转义好。
 */
function buildTocList(nodes: readonly OutlineNode[]): HTMLOListElement {
  const list = document.createElement("ol");
  list.className = "md-print-toc-list";
  for (const node of nodes) {
    const item = document.createElement("li");
    item.className = "md-print-toc-item";
    item.setAttribute("data-level", String(node.level));

    // 页内锚点：PrintToPdf 不产生 PDF 书签（FR-08 已如实告知用户），
    // 但文内 `#id` 链接在生成的 PDF 里是可点的，等于给了一份能跳转的目录。
    const link = document.createElement("a");
    link.setAttribute("href", `#${node.id}`);
    link.textContent = node.text;
    item.appendChild(link);

    if (node.children.length > 0) {
      item.appendChild(buildTocList(node.children));
    }
    list.appendChild(item);
  }
  return list;
}

/** 无标题的文档不生成目录页（一页只写着"目录"两个字的空页是纯浪费） */
function buildTocHtml(outline: readonly OutlineNode[]): string {
  if (outline.length === 0) {
    return "";
  }
  const nav = document.createElement("nav");
  nav.className = "md-print-toc";
  const title = document.createElement("div");
  title.className = "md-print-toc-title";
  title.textContent = t.preview.tocTitle;
  nav.append(title, buildTocList(outline));
  return nav.outerHTML;
}

/* ── 4. 样式收集与内联 ──────────────────────────────────────── */

/**
 * 把 CSS 里的相对 `url(...)` 改写成绝对地址。
 *
 * 不做这一步最典型的翻车是 KaTeX：katex.min.css 里写的是 `url(fonts/KaTeX_Main-Regular.woff2)`，
 * 相对的是 `/vditor/dist/js/katex/`；一旦被内联进 `/index.html` 的 <style>，
 * 它就会去要 `/fonts/KaTeX_Main-Regular.woff2` —— 404，公式全部退化成系统字体。
 * 同理适用于打包产物 CSS 里的字体与背景图。
 */
function absolutizeCssUrls(css: string, baseUrl: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]*)\1\s*\)/g,
    (whole: string, quote: string, reference: string): string => {
      // 空引用、绝对 URL（含 data:/blob:）、协议相对、纯 fragment 一律原样保留
      if (reference === "" || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) {
        return whole;
      }
      try {
        return `url(${quote}${new URL(reference, baseUrl).href}${quote})`;
      } catch {
        return whole;
      }
    },
  );
}

/**
 * `</style>` 防护。
 *
 * CSS 里出现这个序列只可能来自字符串字面量或注释（如 `content: "</style>"`），
 * 但只要出现一次，内联进 `<style>` 就会**提前闭合标签**，后面的 CSS 全部变成正文文本。
 * 改写成 `<\/style` 在 CSS 字符串里是合法的同一性转义，视觉结果不变。
 */
function sanitizeStyleText(css: string): string {
  return css.replace(/<\/(style|script)/gi, "<\\/$1");
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, document.baseURI).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * 收集当前文档里**全部**同源样式，按文档顺序拼成一段 CSS 文本。
 *
 * 【为什么是"扫当前文档"而不是"按名单 fetch 几个文件"】
 * 打印窗口加载的就是本应用自己的页面，此刻 head 里已经齐了三类样式：
 *   ① 打包产物：tokens.css / index.css（Tailwind）/ github-markdown-css 基底 / markdown.css 增量
 *      —— 生产是一个 <link>，dev 是 Vite 注入的若干 <style>，两种形态这里都吃得到；
 *   ② 自托管 hljs 主题：Vditor 的 highlightRender 在渲染时注入的
 *      `/vditor/dist/js/highlight.js/styles/github.min.css`（浅色，因为我们按 light 渲染）；
 *   ③ 自托管 KaTeX：mathRender 注入的 `/vditor/dist/js/katex/katex.min.css`。
 * 按名单硬编码的话，②③ 的文件名一改（或将来换主题）这里就会静默少一份样式；
 * 扫文档则天然跟着渲染管线走，且顺序就是原本的层叠顺序，不会把基底盖在增量之上。
 *
 * **必须在 renderMarkdown 之后调用**：②③ 是渲染过程中才注入的。
 */
async function collectPrintStyles(): Promise<string> {
  const chunks: string[] = [];
  const nodes = document.querySelectorAll<HTMLElement>(
    'link[rel~="stylesheet"], style',
  );

  for (const node of Array.from(nodes)) {
    if (node instanceof HTMLStyleElement) {
      chunks.push(absolutizeCssUrls(node.textContent ?? "", document.baseURI));
      continue;
    }
    if (!(node instanceof HTMLLinkElement)) {
      continue;
    }
    const href = node.href;
    // 红线 8 的连带保障：外部样式表一律不取（产物里本就不该有，出现即异常，记一条 warn）
    if (!isSameOrigin(href)) {
      console.warn("[print] skipped a non same-origin stylesheet", href);
      continue;
    }
    try {
      const response = await fetch(href);
      if (!response.ok) {
        console.warn("[print] stylesheet fetch failed", href, response.status);
        continue;
      }
      chunks.push(absolutizeCssUrls(await response.text(), href));
    } catch (error) {
      console.warn("[print] stylesheet fetch threw", href, error);
    }
  }
  return chunks.join("\n");
}

/**
 * 打印专用增量样式（排在收集到的应用样式之后，靠源顺序压过基底）。
 *
 * 【为什么大部分规则不写在 `@media print` 里】
 * PrintToPdf 确实走 print media，但隐藏窗口的**屏幕布局**才是 Mermaid 测量与分页计算的依据。
 * 只写在 @media print 里会出现「屏幕一套版式、纸面另一套」——最典型的后果是表格与代码块
 * 在屏幕上有横向滚动条（不占高度），到了纸面上展开成好几行，分页位置整体错位。
 * 因此版式规则一律无条件生效，只有真正与纸张相关的（@page、分页控制）才收进 @media print。
 */
const PRINT_OVERLAY_CSS = `
/* ── 页面盒 ──
   刻意**只声明 size 不声明 margin**：页边距的唯一事实来源是 export.rs 的 COM
   PrintSettings（A4_WIDTH_IN / PDF_MARGIN_IN），M0-① 实测通过的就是那一套。
   在 CSS 里再写一遍 @page margin 会被 Chromium 视为「作者显式指定」而压过打印设置，
   两处一旦不同步就是「PDF 边距莫名其妙变了」这类查半天的问题。 */
@page { size: A4; }

/* ── 拆掉应用外壳的整窗约束（**这条漏了就只印得出一页**）──
   index.css 的 base 层给 html/body/#root 写了 height:100% + overflow:hidden
   （桌面外壳「整窗不滚动，滚动交给内部容器」的正确设计）。
   但打印文档是一份长文，body 一旦被钉成一屏高又 overflow:hidden，
   PrintToPdf 只会拿到第一屏——后面几十页凭空消失，且完全没有报错。
   加 !important 不是偷懒：这是正确性规则，不容任何后续样式覆盖。 */
html, body {
  height: auto !important;
  min-height: 0 !important;
  overflow: visible !important;
  margin: 0;
  padding: 0;
  /* 打印恒用浅色（理由见文件头）：底色写死白，不依赖 Token，
     免得将来 Token 改了把 PDF 一起改成灰底 */
  background: #ffffff;
  /* 外壳的 user-select:none 与 overscroll 约束在文档里没有意义，一并还原 */
  user-select: text;
  overscroll-behavior: auto;
}

/* 正文根：宽度撑满页面盒，字号与离屏渲染时完全一致（否则断行会重排、图表会错位） */
.md-print-root {
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 0;
  --md-reading-font: ${PRINT_FONT_PX}px;
  --md-zoom: 1;
  /* 代码块底色、表格斑马纹、告警块语义色全靠它；
     COM 侧的 ShouldPrintBackgrounds(true) 只是打开了总开关，元素级仍要显式声明 */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ── 屏幕上的交互件在纸上全部收起 ── */

/* 代码块增强的工具条（语言标签 + 复制按钮）：wrapper 里除 pre 之外的都是它 */
[data-code-block] > *:not(pre) { display: none !important; }
/* 标题左侧的锚点小链接：屏幕上是导航件，纸上是噪点 */
a.vditor-anchor { display: none !important; }
/* 外链图片占位块保留（如实说明这里原本有一张图），但按钮去掉——纸上点不动 */
[data-external-image] button { display: none !important; }

/* ── 溢出容器必须展开 ──
   屏幕上「超宽就横向滚动」是好设计，纸上没有滚动条，overflow 就等于**永久裁掉**。 */
.md-table-wrap { overflow: visible !important; }
/* 表格「压缩以适应页宽」。
   屏幕规则（markdown.css）现在就是 width:auto + max-width:100%（格内换行，
   只有 min-content 放不下才壳内滚动），打印本可直接继承；这条 !important
   是防御性钉死：纸上没有滚动条，任何回归把表格改回自然宽度都会让超页宽的列
   被**永久裁掉**且悄无声息——宁可单元格多换几行挤一点，也不能丢内容。 */
.md-print-root .md-table-wrap > table {
  max-width: 100% !important;
}
.md-print-root pre {
  overflow: visible !important;
  /* 与 data-code-wrap="on" 同款：长行折行而不是裁断（FR-08「代码块不截断换行」） */
  white-space: pre-wrap !important;
  overflow-wrap: anywhere;
}
.md-print-root pre > code {
  white-space: pre-wrap !important;
  overflow-wrap: anywhere;
  word-break: normal;
}
.md-print-root img,
.md-print-root svg {
  max-width: 100%;
  height: auto;
}

/* ── 链接：**不**在后面追加 URL ──
   学术论文的排版惯例是把 href 打出来，但我们导出的是工作文档：
   正文里每个链接后面拖一串 https:// 会把版面冲垮，且这些链接在 PDF 里本就是可点的。
   这条是防御性覆盖：万一哪天基底或第三方样式加了这类规则，这里把它按住。 */
.md-print-root a[href]::after { content: none !important; }

/* ── 文内目录页 ── */
.md-print-toc { margin: 0 0 1em; }
.md-print-toc-title {
  font-size: 1.5em;
  font-weight: 600;
  margin-bottom: 0.75em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--md-border-l2, #d1d9e0);
}
.md-print-toc-list { list-style: none; margin: 0; padding: 0; }
.md-print-toc-list .md-print-toc-list { padding-left: 1.5em; }
.md-print-toc-item { margin: 0.25em 0; line-height: 1.6; }
.md-print-toc-item > a { text-decoration: none; color: inherit; }
/* 一级条目略重，层级一眼可辨（PDF 没有书签树，目录页就是唯一的结构视图） */
.md-print-toc-item[data-level="1"] > a { font-weight: 600; }

/* ── 渲染失败兜底页 ── */
.md-print-failure {
  font-family: var(--md-font-mono, monospace);
  white-space: pre-wrap;
  word-break: break-word;
}

@media print {
  /* 目录页独占一页：正文从新页开始，装订与阅读都更像正式文档 */
  .md-print-toc { break-after: page; page-break-after: always; }

  /* 标题不许落在页脚：孤零零一行标题、内容全在下一页，是最刺眼的排版事故 */
  .md-print-root h1,
  .md-print-root h2,
  .md-print-root h3,
  .md-print-root h4,
  .md-print-root h5,
  .md-print-root h6 {
    break-after: avoid;
    page-break-after: avoid;
    break-inside: avoid;
  }

  /* 整块不拆：代码块、表格、图表、告警块、引用块。
     注意这只是"尽量"——单块高度超过一页时浏览器会自行放宽，不会把内容吃掉。 */
  .md-print-root pre,
  .md-print-root table,
  .md-print-root .md-table-wrap,
  .md-print-root .md-alert,
  .md-print-root blockquote,
  .md-print-root figure,
  .md-print-root img,
  .md-print-root svg {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* 长表格终究会被拆开，此时靠表头重复兜住：
     否则第二页起就是一堆没有列名的数字，读者只能翻回去对照。 */
  .md-print-root thead { display: table-header-group; }
  .md-print-root tr { break-inside: avoid; page-break-inside: avoid; }

  /* 段落首尾不留孤行 */
  .md-print-root p,
  .md-print-root li { orphans: 3; widows: 3; }
}
`;

/* ── 5. 组装完整文档 ────────────────────────────────────────── */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PrintDocumentOptions {
  /** 文内目录页（FR-08） */
  includeToc: boolean;
  /** .md 所在目录，本地图片相对路径基准（DG 8「查看态本地图片」） */
  baseDir: string | null;
  /** 写进 `<title>`；PDF 的文档属性会取它，另存时的默认文件名也跟着它 */
  title?: string;
  /** frontmatter 三态显示（FR-14）；不传按 card，与阅读区默认一致 */
  frontmatterDisplay?: FrontmatterDisplay;
  /** 大文件：渲染管线据此限量做代码块增强（打印场景增强件本就会被隐藏，限量只是省时间） */
  isLarge?: boolean;
}

/**
 * 生成完整的打印用 HTML 文档字符串（自洽：样式全内联，不依赖任何外链）。
 *
 * @param source Markdown 原文（未剥离 frontmatter，剥离由渲染管线负责）
 */
export async function buildPrintDocument(
  source: string,
  options: PrintDocumentOptions,
): Promise<string> {
  const stage = createPrintStage();
  let bodyHtml = "";
  let tocHtml = "";

  try {
    const result = await renderMarkdown({
      source,
      container: stage.host,
      theme: PRINT_THEME,
      baseDir: options.baseDir,
      encoding: "utf8",
      isLarge: options.isLarge === true,
      frontmatterDisplay: options.frontmatterDisplay ?? "card",
      // 打印就绪信号由 renderPrintPage 在**文档装载之后**发，这里发就早了：
      // 此刻内容还在离屏容器里，真实文档还是空的
      emitPrintReadySignal: false,
    });
    if (!result.committed) {
      console.warn("[print] render pipeline reported an uncommitted result");
    }
    bodyHtml = stage.host.innerHTML;
    tocHtml = options.includeToc ? buildTocHtml(result.outline) : "";
    // 解除渲染期的监听与定时器；此刻 HTML 已取走，节点可以整棵丢掉
    result.dispose();

    // 样式收集必须在渲染之后：hljs 主题与 KaTeX 样式是渲染过程中才注入 head 的
    const css = await collectPrintStyles();
    const title = options.title !== undefined && options.title !== "" ? options.title : t.app.name;

    return [
      "<!doctype html>",
      // data-theme 写死 light：打印恒用浅色，理由见文件头注释
      '<html lang="zh-CN" data-theme="light">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>${escapeHtml(title)}</title>`,
      `<style>${sanitizeStyleText(css)}</style>`,
      `<style>${PRINT_OVERLAY_CSS}</style>`,
      "</head>",
      '<body class="md-print-body">',
      `<div class="${PRINT_ROOT_CLASS}" data-code-wrap="on">`,
      tocHtml,
      bodyHtml,
      "</div>",
      "</body>",
      "</html>",
    ].join("\n");
  } finally {
    stage.dispose();
  }
}

/* ── 6. 装载到当前文档 ──────────────────────────────────────── */

/**
 * 把生成的文档字符串装载进**当前** document（打印窗口里跑的就是这一步）。
 *
 * 用 DOMParser 解析再逐节点 importNode，而不是 `document.write` / `innerHTML`：
 *   - document.write 会重开文档流，Tauri 注入的 IPC 全局有被一并冲掉的风险，
 *     那样 PRINT_READY 就发不出去了；
 *   - DOMParser 产出的文档「脚本被标记为不可执行」（HTML 规范明文），
 *     即使将来模板里混进 <script> 也不会执行，这是免费的一层保险。
 * 替换 head 会连带移走应用自己的 <link>/<style>——这是有意的：样式已经全部内联进来了，
 * 留着外链只会在打印瞬间引入一次不必要的重新解析。
 */
export function mountPrintDocument(html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");

  // <html> 上的属性（data-theme="light" / lang）必须搬过来，否则主题变量还是跟着旧文档走
  for (const attribute of Array.from(parsed.documentElement.attributes)) {
    document.documentElement.setAttribute(attribute.name, attribute.value);
  }
  document.head.replaceChildren(
    ...Array.from(parsed.head.childNodes, (node) => document.importNode(node, true)),
  );
  for (const attribute of Array.from(parsed.body.attributes)) {
    document.body.setAttribute(attribute.name, attribute.value);
  }
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes, (node) => document.importNode(node, true)),
  );
}

/* ── 7. 打印页入口 ─────────────────────────────────────────── */

/** 取父目录，作为本地图片相对路径基准；无分隔符（裸文件名）返回 null */
function parentDirOf(path: string): string | null {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index <= 0 ? null : path.slice(0, index);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      resolve();
    });
  });
}

/**
 * 装载之后再等一轮：内联样式表是新解析的，字体会重新触发一次加载，
 * 布局也要重新走一遍。不等就 emit，Rust 有可能印在「样式刚生效、行高还没稳」的那一帧上。
 */
async function settleAfterMount(): Promise<void> {
  if (typeof document.fonts !== "undefined") {
    await Promise.race([document.fonts.ready, delay(MOUNT_SETTLE_TIMEOUT_MS)]);
  }
  await nextFrame();
  await nextFrame();
}

/**
 * 渲染失败时的兜底页：把错误信息印出来。
 *
 * 为什么失败也照样 emit PRINT_READY：不发信号的话 Rust 只能干等到超时（默认 20s）
 * 再按现状开印，用户面对的是「点了导出，长时间没反应，最后拿到一页空白」。
 * 发信号 + 把原因印在纸上，等待时间恢复正常，且拿到的 PDF 自己解释了发生什么。
 * 文案刻意只放原始错误信息（技术值，非 UI 文案），不引 i18n——
 * 见交付说明里关于 `t.print.renderFailed` 的后续建议。
 */
function mountFailurePage(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.setAttribute(PRINT_ERROR_ATTR, message);
  const block = document.createElement("pre");
  block.className = "md-print-failure";
  block.textContent = message;
  document.body.replaceChildren(block);
}

/**
 * `--action to-html` 的无 UI 导出：本窗口渲染 → 自己 invoke `export_html` 落盘 → 回报成败。
 *
 * 与 PDF 那条链方向相反的原因见 [`PrintMode`]。这里不装载打印文档、不发 PRINT_READY——
 * 没有任何东西要被「印」，Rust 那边等的是 HEADLESS_EXPORT_DONE。
 *
 * `overwrite: true` 是刻意的：命令行没有可以确认覆盖的地方。推导出来的落点已在
 * Rust 侧 `vacant_output` 顺延过编号，不会撞既有文件；显式 `--output` 则是调用方
 * 点名要写那儿，此时报 EXPORT_TARGET_EXISTS 只会变成一次无从解释的失败。
 */
async function runHeadlessHtmlExport(job: PrintJob): Promise<void> {
  let ok = false;
  let message: string | null = null;
  try {
    if (job.output === null) {
      throw new Error("html job without output path");
    }
    const payload = await readMarkdown(job.source);
    const built = await buildHtmlExport({
      source: payload.content,
      title: payload.title,
      baseDir: parentDirOf(job.source),
      sourcePath: job.source,
      encoding: payload.encoding,
      isLarge: payload.isLarge,
    });
    await exportHtml(built, job.output, job.htmlMode ?? "single-file", true);
    ok = true;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
    console.error("[print] headless html export failed", error);
  }

  try {
    await emitHeadlessExportDone(ok, message);
  } catch (error) {
    // 发不出信号 = Rust 只能等到 120s 超时。日志是这条路径唯一的线索。
    console.error("[print] emit HEADLESS_EXPORT_DONE failed", error);
  }
}

/**
 * 打印窗口的前端入口：读原文 → 渲染 → 装载 → 发就绪信号。
 *
 * main.tsx 在 [`readPrintJob`] 返回非 null 时调用本函数，并且**不要**挂载 React 应用：
 * 打印文档里出现顶栏/左栏就是这次改造要消灭的东西。
 */
export async function renderPrintPage(job: PrintJob): Promise<void> {
  if (job.mode === "html") {
    await runHeadlessHtmlExport(job);
    return;
  }

  try {
    const payload = await readMarkdown(job.source);
    const html = await buildPrintDocument(payload.content, {
      includeToc: job.includeToc,
      baseDir: parentDirOf(job.source),
      title: payload.title,
      isLarge: payload.isLarge,
    });
    mountPrintDocument(html);
    await settleAfterMount();
  } catch (error) {
    console.error("[print] failed to build print document", error);
    mountFailurePage(error);
  }

  document.documentElement.setAttribute(PRINT_READY_ATTR, "true");
  try {
    await emitPrintReady();
  } catch (error) {
    // 走到这里通常只有一个原因：打印窗口没有被 capabilities 覆盖（core:event:allow-emit 缺失）。
    // Rust 侧会走超时分支照常开印，所以不抛错，只留一条可检索的日志。
    console.error("[print] emit PRINT_READY failed (missing capability for the print window?)", error);
  }
}
