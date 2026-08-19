/**
 * HTML 导出（FR-07）—— 前端半。
 *
 * 职责：复用 `render/preview.ts` 的整条渲染管线产出正文 DOM，再把它连同**内联样式**
 * 组装成一份自包含的 HTML 文档字符串，交 Rust 侧（`src-tauri/src/export_html.rs`）
 * 决定本地图片是 base64 内联还是拷进资源目录。
 *
 * 【为什么正文必须走 renderMarkdown 而不是另写一条渲染路径】
 * DG 8「附件路径重写」与 FR-07 的验收词是「样式与预览一致」。只要另起一条管线，
 * 告警块 / [TOC] / Mermaid 失败卡片 / 表格滚动壳 / frontmatter 三态就会各自漂移一点点，
 * 半年后就是两套观感。这里的做法是：建一个与阅读区同宽同类的离屏容器，
 * 让 renderMarkdown 把结果**搬进去**，我们只做导出特有的后处理（摘掉交互件、
 * 把本地图片换成占位 token），从根上保证「阅读区 = PDF = 导出 HTML」三者同源。
 *
 * 【样式怎么内联】
 * 直接从 `document.styleSheets` 抓取运行期真正生效的那几张表（tokens / Tailwind /
 * github-markdown-css 基底 / markdown.css / Vditor 运行时注入的 hljs 与 KaTeX 样式），
 * 而不是在这里 import 具体 CSS 文件——后者一旦有人加一张样式表就会漏，
 * 而漏样式在导出场景里是静默的（用户打开才发现难看）。全部同源，CSSOM 可读。
 *
 * 【主题选择：导出恒用浅色】
 * 导出件的使用场景是「发给别人 / 打印 / 归档」，浅色底最通用，也是唯一能保证
 * 打印出来不是一整页黑的选择。深色导出仅在调用方显式传 theme="dark" 时才发生。
 *
 * 【本文件不碰 IPC】
 * 只产出数据结构，invoke 由 `services/ipc.ts` 封装（DG 7.1 服务层纪律）。
 */

import { t } from "../i18n/zh-CN";
import { renderMarkdown } from "./preview";
import type { FileEncoding, FrontmatterDisplay, ResolvedTheme } from "../types";

/* ── 前后端契约常量（Rust `export_html.rs` 有同名常量，改一侧必须同步另一侧） ── */

/**
 * 本地图片占位 token 的协议前缀。
 *
 * 为什么用「假协议 + 序号」而不是把绝对路径直接写进 src：
 *   ① Rust 侧只需按**整串相等**做字符串替换，不必在后端解析 HTML（解析 HTML
 *      是导出功能的第二大 bug 源，仅次于路径重写本身）；
 *   ② 万一某张图替换失败，浏览器只会当成一个无法识别的协议、显示 alt 文本，
 *      而不是把用户的本机绝对路径明晃晃地印在页面里。
 */
export const ASSET_TOKEN_SCHEME = "mdnaonao-asset";

/** 生成第 index 张本地图片的占位 token（与 Rust 的 `asset_token()` 逐字一致） */
export function assetToken(index: number): string {
  return `${ASSET_TOKEN_SCHEME}://${index}`;
}

/* ── 调参常量 ──────────────────────────────────────────────── */

/**
 * 离屏舞台宽度（CSS px）。取「适中列宽 748 + 两侧 32 padding」的量级：
 * 表格列宽、代码折行、Mermaid 版面都在这个宽度下定稿，与导出件打开后的观感一致。
 */
const EXPORT_STAGE_WIDTH = 812;

/** 导出件的正文列宽档（对应 markdown.css 的 [data-reading-width] 三态） */
const EXPORT_READING_WIDTH = "medium";

/** 导出件的正文基准字号与缩放（阅读区那两个变量由 App 注入，导出件自己定死） */
const EXPORT_READING_FONT = "16px";
const EXPORT_ZOOM = "1";

/** 单个 CSS 附属资源（字体等）内联上限：超过就放弃内联，避免一张表把文档撑爆 */
const CSS_ASSET_MAX_BYTES = 1024 * 1024;

/** 全部 CSS 附属资源的总预算（KaTeX 全套 woff2 约 300KB，留足余量） */
const CSS_ASSET_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * 无法内联的 CSS 资源统一指向它。
 * 不保留原始 `http://tauri.localhost/...`：那个地址在导出件里必然 404，
 * 留着既误导人（看起来像外链），也会让离线打开时多几次无谓的请求。
 */
const CSS_ASSET_UNAVAILABLE = "about:invalid";

/**
 * `enhanceCodeBlocks` 给代码块套的壳标记（preview.ts 的 `CODE_WRAP_MARKER`，未导出）。
 * 导出件里没有 hover，也没有剪贴板，那层壳与工具条一并摘掉。
 * 契约：preview.ts 改这个字面量时本处必须同步。
 */
const CODE_BLOCK_MARKER = "data-code-block";

/** 渲染期留下的中间态属性，导出前一律清掉（`data-mermaid-source` 会整段复制图表原文） */
const TRANSIENT_ATTRS = ["data-mermaid-source", "data-purified", "data-render-error"];

/* ── 对外类型 ──────────────────────────────────────────────── */

/** 一张待处理的本地图片：HTML 里的占位 token ↔ 本机绝对路径 */
export interface HtmlExportAsset {
  /** 形如 `mdnaonao-asset://0`，在 html 字段里出现且仅出现在 img[src] 上 */
  token: string;
  /** 已由渲染管线还原出的本机绝对路径（可能含中文 / 空格 / UNC） */
  path: string;
}

/** 交给 Rust `export_html` 的完整载荷（字段名即 wire 格式，camelCase） */
export interface HtmlExportPayload {
  /** 自包含的 HTML 文档字符串（含 doctype / meta charset / 内联样式） */
  html: string;
  /** 本地图片清单；空数组表示全文没有本地图片，Rust 侧无事可做 */
  assets: HtmlExportAsset[];
  /** 源 .md 的绝对路径；Rust 侧用它作为「万一有相对路径」时的解析基准 */
  sourcePath: string | null;
}

export interface BuildHtmlExportOptions {
  /** Markdown 原文（已解码、已去 BOM，frontmatter 尚未剥离） */
  source: string;
  /** 文档标题（首个 H1，无则文件名）——写进 `<title>` */
  title: string;
  /** .md 所在目录，本地图片相对路径基准（DG 8「查看态本地图片」） */
  baseDir: string | null;
  /** 源文件绝对路径，原样回传给 Rust */
  sourcePath?: string | null;
  /** 文件编码，仅供渲染管线回填统计，不影响导出件（导出件恒为 UTF-8） */
  encoding: FileEncoding;
  /** frontmatter 三态（FR-14）；不传按 card，与阅读区默认一致 */
  frontmatterDisplay?: FrontmatterDisplay;
  /** 大文件：渲染管线据此限量增强代码块（导出件本就不需要那些增强） */
  isLarge?: boolean;
  /** 导出主题；**默认浅色**，理由见文件头 */
  theme?: ResolvedTheme;
  /** 中止令牌：用户在导出过程中切文档 / 取消时 abort */
  signal?: AbortSignal;
}

/* ── 1. 离屏舞台 ───────────────────────────────────────────── */

interface ExportStage {
  /** 正文容器：类名与 data 属性与 App.tsx 的阅读区逐一对齐 */
  readonly host: HTMLDivElement;
  readonly dispose: () => void;
}

/**
 * 建一个与阅读区同构的离屏容器。
 *
 * 三层结构与 App.tsx 一致：外层挂列宽档与排版变量，内层是正文容器。
 * renderMarkdown 会按 `host.clientWidth` 建自己的测量舞台，所以这里的宽度
 * 必须是**内容宽度**（外层 812 − padding 32×2 = 748，正好等于 --md-reading-w）。
 *
 * `visibility:hidden` 而非 `display:none`：后者没有布局盒，Mermaid 的 getBBox()
 * 与 KaTeX 的宽度测量会全部拿到 0（preview.ts 的 createRenderStage 同理）。
 */
function createExportStage(): ExportStage {
  const stage = document.createElement("div");
  stage.setAttribute("data-html-export-stage", "true");
  stage.setAttribute("aria-hidden", "true");
  stage.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${EXPORT_STAGE_WIDTH}px`,
    "height:0",
    "overflow:hidden",
    "visibility:hidden",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");

  const column = document.createElement("div");
  column.setAttribute("data-reading-width", EXPORT_READING_WIDTH);
  column.setAttribute("data-code-wrap", "on");
  column.style.setProperty("--md-reading-font", EXPORT_READING_FONT);
  column.style.setProperty("--md-zoom", EXPORT_ZOOM);

  const host = document.createElement("div");
  host.className = "markdown-body md-content vditor-reset vditor-reset--anchor";
  // 与真实阅读区一样在正文层再挂一份：renderMarkdown 的测量舞台只镜像 host 自身
  host.setAttribute("data-code-wrap", "on");
  host.style.setProperty("--md-reading-font", EXPORT_READING_FONT);
  host.style.setProperty("--md-zoom", EXPORT_ZOOM);

  column.appendChild(host);
  stage.appendChild(column);
  document.body.appendChild(stage);

  return {
    host,
    dispose: () => {
      stage.remove();
    },
  };
}

/* ── 2. 正文后处理（导出件不需要的交互件 + 图片换 token） ───── */

/**
 * 摘掉代码块的 hover 工具条与外壳，把 `<pre>` 还原到原位。
 * 导出件里既没有 hover 也没有剪贴板权限，留着只会是一坨点不动的死按钮。
 */
function stripCodeBlockChrome(host: HTMLElement): void {
  for (const wrapper of Array.from(host.querySelectorAll<HTMLElement>(`[${CODE_BLOCK_MARKER}]`))) {
    const pre = wrapper.querySelector("pre");
    if (pre === null) {
      wrapper.remove();
      continue;
    }
    wrapper.replaceWith(pre);
  }
}

/**
 * 外链图片：把「点击加载」占位块换回真正的 `<img>`。
 *
 * 红线 4 约束的是**本应用运行时**不得擅自发起外部请求；导出件是一份交给别人的文档，
 * 里面留一个点不动的占位块才是真的丢信息。加载与否由打开导出件的那个浏览器决定，
 * 与本应用的网络行为无关。`referrerpolicy=no-referrer` 一并带上，别把来路泄出去。
 */
function restoreExternalImages(host: HTMLElement): void {
  for (const placeholder of Array.from(host.querySelectorAll<HTMLElement>("[data-external-image]"))) {
    const source = placeholder.getAttribute("data-external-image") ?? "";
    if (source === "") {
      placeholder.remove();
      continue;
    }
    const image = document.createElement("img");
    image.setAttribute("src", source);
    image.setAttribute("referrerpolicy", "no-referrer");
    // 占位块没有留存 alt（preview.ts 未记录），这里只能退回空 alt；
    // 交付说明里已请求渲染层补 `data-external-alt`，补上后此处直接取用即可
    image.setAttribute("alt", placeholder.getAttribute("data-external-alt") ?? "");
    placeholder.replaceWith(image);
  }
}

/**
 * 本地图片 → 占位 token，并收集「token ↔ 绝对路径」清单。
 *
 * 同一张图在文中出现多次时共用一个 token：Rust 侧因此只读一次盘、只拷一份文件，
 * 单文件模式下也不会把同一段 base64 塞进文档两遍（大图重复出现时体积差好几倍）。
 */
function extractLocalAssets(host: HTMLElement): HtmlExportAsset[] {
  const assets: HtmlExportAsset[] = [];
  const tokenByPath = new Map<string, string>();

  for (const image of Array.from(host.querySelectorAll<HTMLImageElement>("img[data-local-path]"))) {
    const path = image.getAttribute("data-local-path") ?? "";
    image.removeAttribute("data-local-path");
    image.removeAttribute("data-preview-image");
    image.removeAttribute("loading");
    if (path === "") {
      continue;
    }
    let token = tokenByPath.get(path);
    if (token === undefined) {
      token = assetToken(assets.length);
      tokenByPath.set(path, token);
      assets.push({ token, path });
    }
    image.setAttribute("src", token);
  }
  return assets;
}

/** 清掉渲染期的中间态属性（体积 + 观感，二者都不该带进交付物） */
function stripTransientAttrs(host: HTMLElement): void {
  for (const name of TRANSIENT_ATTRS) {
    for (const node of Array.from(host.querySelectorAll(`[${name}]`))) {
      node.removeAttribute(name);
    }
  }
}

/* ── 3. 样式采集与内联 ─────────────────────────────────────── */

interface CssChunk {
  /** null = CSSOM 读不到，需要按 href 现抓（见 collectInlineStyles） */
  css: string | null;
  /** 解析 `url()` 相对地址的基准（该样式表自己的 href，内联 <style> 则用文档 base） */
  base: string;
  /** 读不到时的兜底来源；内联 <style> 没有 href，只能放弃 */
  href: string | null;
}

/** `url(...)`：三种引号形态一网打尽；括号内不含 `)` 是 CSS 的既有约束 */
const CSS_URL_RE = /url\(\s*(["']?)([^"')]*)\1\s*\)/g;

/** 无需（也无法）内联的地址：数据 URI、SVG 片段引用、内存对象 */
const CSS_URL_PASSTHROUGH_RE = /^(?:data:|blob:|about:|#)/i;

/** 只内联 woff2：同一条 @font-face 里的 woff/ttf 是给老浏览器的重复品，内联它们纯属浪费 */
const FONT_INLINE_EXT = [".woff2"];
/** 明确丢弃的字体格式（保留原地址毫无意义：导出件里那个地址必然打不开） */
const FONT_DROP_EXT = [".woff", ".ttf", ".otf", ".eot"];

/** 值类型带 undefined：TS 默认认为下标访问必中，不写就会把 `?? 兜底` 判成死代码 */
const ASSET_MIME: Record<string, string | undefined> = {
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function extensionOf(url: string): string {
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/**
 * 递归展开一张样式表，按文档顺序追加 chunk。
 *
 * 两种「读不出来」的情况都不能让导出失败，而是留下 href 待会儿现抓：
 *   ① 跨源样式表读 `cssRules` 抛 SecurityError（本应用不该有，真有就是红线 8 的问题）；
 *   ② **样式表尚未加载完**——Vditor 的 hljs / KaTeX 样式是渲染时才注入的 `<link>`，
 *      此刻 `cssRules` 可能还是空的。漏掉 KaTeX 样式的后果是公式糊成一团，
 *      而且是静默的（导出成功、打开才发现），所以必须兜住。
 */
function collectSheet(sheet: CSSStyleSheet, chunks: CssChunk[]): void {
  const base = sheet.href ?? document.baseURI;
  let rules: CSSRuleList | null = null;
  try {
    rules = sheet.cssRules;
  } catch (error) {
    console.warn("[htmlExport] stylesheet is not readable via CSSOM", sheet.href, error);
  }

  if (rules === null || rules.length === 0) {
    if (sheet.href !== null) {
      chunks.push({ css: null, base, href: sheet.href });
    }
    return;
  }

  const own: string[] = [];
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSImportRule) {
      const nested: CSSStyleSheet | null = rule.styleSheet;
      if (nested !== null) {
        collectSheet(nested, chunks);
      }
      continue;
    }
    own.push(rule.cssText);
  }
  if (own.length > 0) {
    chunks.push({ css: own.join("\n"), base, href: sheet.href });
  }
}

/** 把 chunk 里的相对 `url()` 就地换成绝对地址（各表按自己的 href 解析） */
function absolutizeUrls(chunk: CssChunk & { css: string }): string {
  return chunk.css.replace(CSS_URL_RE, (whole, _quote: string, raw: string) => {
    const target = raw.trim();
    if (target === "" || CSS_URL_PASSTHROUGH_RE.test(target)) {
      return whole;
    }
    try {
      return `url("${new URL(target, chunk.base).href}")`;
    } catch {
      return whole;
    }
  });
}

/** ArrayBuffer → base64（分片处理：一次性 apply 几百 KB 会爆调用栈） */
function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * 把 CSS 里剩下的绝对地址换成 data URI。
 *
 * 只处理同源地址：跨源地址不该出现（红线 8），出现了也不能替用户去请求它。
 * 字体是唯一真正需要内联的一类——KaTeX 不带字体就是一坨挤在一起的伪公式；
 * 而全套 woff2 约 300KB，只在文档确实含公式时才付这个体积。
 */
async function inlineCssAssets(css: string, inlineFonts: boolean): Promise<string> {
  const targets = new Set<string>();
  for (const matched of css.matchAll(CSS_URL_RE)) {
    const target = (matched[2] ?? "").trim();
    if (target !== "" && !CSS_URL_PASSTHROUGH_RE.test(target)) {
      targets.add(target);
    }
  }
  if (targets.size === 0) {
    return css;
  }

  const replacement = new Map<string, string>();
  let budget = CSS_ASSET_BUDGET_BYTES;

  for (const target of targets) {
    const extension = extensionOf(target);
    if (FONT_DROP_EXT.includes(extension)) {
      replacement.set(target, CSS_ASSET_UNAVAILABLE);
      continue;
    }
    const isFont = FONT_INLINE_EXT.includes(extension);
    if (isFont && !inlineFonts) {
      replacement.set(target, CSS_ASSET_UNAVAILABLE);
      continue;
    }

    let sameOrigin = false;
    try {
      sameOrigin = new URL(target, document.baseURI).origin === window.location.origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      replacement.set(target, CSS_ASSET_UNAVAILABLE);
      continue;
    }

    try {
      const response = await fetch(target);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > CSS_ASSET_MAX_BYTES || buffer.byteLength > budget) {
        replacement.set(target, CSS_ASSET_UNAVAILABLE);
        continue;
      }
      budget -= buffer.byteLength;
      const mime = ASSET_MIME[extension] ?? response.headers.get("content-type") ?? "application/octet-stream";
      replacement.set(target, `data:${mime};base64,${bytesToBase64(buffer)}`);
    } catch (error) {
      console.warn("[htmlExport] failed to inline css asset", target, error);
      replacement.set(target, CSS_ASSET_UNAVAILABLE);
    }
  }

  return css.replace(CSS_URL_RE, (whole, _quote: string, raw: string) => {
    const resolved = replacement.get(raw.trim());
    return resolved === undefined ? whole : `url("${resolved}")`;
  });
}

/**
 * 采集当前文档全部生效样式，并把附属资源内联成 data URI。
 *
 * `inlineFonts` 由调用方按「正文里是否真的有 KaTeX 产物」决定——
 * Vditor 的 KaTeX 样式表一旦注入就常驻，不加这道闸门的话，一篇纯文字文档也会
 * 平白背上 300KB 字体。
 */
async function collectInlineStyles(inlineFonts: boolean): Promise<string> {
  const chunks: CssChunk[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.disabled) {
      continue;
    }
    collectSheet(sheet, chunks);
  }

  // CSSOM 读不到的那几张按 href 现抓，**填回原位**而不是追加到末尾：
  // CSS 靠源顺序决胜负（markdown.css 的变量桥就是压着 github 基底生效的），
  // 顺序一乱，导出件的深浅色与字号体系会整体错位。
  const filled = await Promise.all(
    chunks.map(async (chunk): Promise<string> => {
      if (chunk.css !== null) {
        return absolutizeUrls({ ...chunk, css: chunk.css });
      }
      if (chunk.href === null) {
        return "";
      }
      try {
        const response = await fetch(chunk.href);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return absolutizeUrls({ ...chunk, css: await response.text() });
      } catch (error) {
        console.warn("[htmlExport] failed to fetch stylesheet", chunk.href, error);
        return "";
      }
    }),
  );

  return inlineCssAssets(filled.filter((css) => css !== "").join("\n"), inlineFonts);
}

/* ── 4. 导出件自己的外壳样式 ───────────────────────────────── */

/**
 * 页面外壳：只补「阅读区之外」的那一层——阅读区内部的一切都由采集来的样式负责。
 * 全程走 tokens 语义变量，不写裸色值（红线 14）。
 *
 * `@page` 与 `@media print` 一并给上：导出件常被再打印一次，
 * 那时页边距与背景由这里兜底（与 PDF 主路线的 A4 / 0.4in 保持同一量级）。
 */
const EXPORT_SHELL_CSS = `
/* 【必须放在最前，且必须带 !important】
   采集来的样式里含 index.css 的 base 层，那一层为了做"整页不滚、滚动交给内部容器"
   的应用外壳，给 html/body 写死了 height:100% + overflow:hidden。
   那对应用是对的，对一份独立文档是灾难性的：导出件会**只显示第一屏**，
   剩下的内容一像素都滚不到，而且不报任何错——打开的人只会以为文档就这么短。
   导出件没有"内部滚动容器"，滚动必须回到文档本身。 */
html,
body {
  height: auto !important;
  min-height: 100%;
  overflow: visible !important;
}
html {
  background: var(--md-bg-canvas);
}
body {
  margin: 0;
  padding: 0;
  background: var(--md-bg-canvas);
  color: var(--md-text-primary);
  font-family: var(--md-font-ui);
  -webkit-font-smoothing: antialiased;
}
.md-export-page {
  box-sizing: border-box;
}
.md-export-page img {
  max-width: 100%;
  height: auto;
}
@page {
  size: A4;
  margin: 10mm;
}
@media print {
  html,
  body {
    background: var(--md-bg-canvas);
  }
  .md-export-page {
    max-width: none;
    padding: 0;
  }
  .md-content :where(h1, h2, h3, h4, h5, h6) {
    break-after: avoid-page;
  }
  .md-content :where(pre, table, blockquote, .md-alert) {
    break-inside: avoid;
  }
}
`;

/* ── 5. 文档组装 ───────────────────────────────────────────── */

const HTML_ESCAPE: Record<string, string | undefined> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] ?? char);
}

/**
 * 让一段任意文本能安全地待在 `<style>` 里。
 *
 * HTML 解析器对 `<style>` 内容只认一个终止序列 `</style`，别的都是字面量；
 * 因此只要把这个序列（以及注释开启符）拆开就足够，不必也不应该去改写 CSS 语义。
 * 采集来的样式全部出自本应用自己的样式表，这一步是纯防御。
 */
function fenceStyleContent(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

function buildDocument(params: {
  title: string;
  theme: ResolvedTheme;
  styles: string;
  body: string;
}): string {
  const title = escapeHtml(params.title.trim() === "" ? t.app.name : params.title.trim());
  return [
    "<!doctype html>",
    `<html lang="zh-CN" data-theme="${params.theme}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${escapeHtml(t.app.name)}">`,
    `<title>${title}</title>`,
    `<style>${fenceStyleContent(params.styles)}</style>`,
    `<style>${fenceStyleContent(EXPORT_SHELL_CSS)}</style>`,
    "</head>",
    "<body>",
    `<div class="md-export-page" data-reading-width="${EXPORT_READING_WIDTH}" data-code-wrap="on"` +
      ` style="--md-reading-font:${EXPORT_READING_FONT};--md-zoom:${EXPORT_ZOOM}">`,
    `<article class="markdown-body md-content vditor-reset vditor-reset--anchor"` +
      ` data-code-wrap="on">`,
    params.body,
    "</article>",
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/* ── 主入口 ─────────────────────────────────────────────────── */

/**
 * 渲染并组装一份自包含 HTML 文档。
 *
 * 返回值里的 `html` 已经是完整文档，`assets` 里的每个 token 在 `html` 中恰好对应
 * 一处（或多处，同图复用时）`img[src]`；Rust 侧按模式把 token 换成 data URI 或
 * `xxx_files/` 下的相对路径即可，**不需要解析 HTML**。
 *
 * 失败语义：渲染管线抛错（Vditor 资源缺失、文档畸形）时原样抛出；
 * 中止（signal）时抛 DOMException，调用方按取消处理。
 */
export async function buildHtmlExport(
  options: BuildHtmlExportOptions,
): Promise<HtmlExportPayload> {
  const theme: ResolvedTheme = options.theme ?? "light";
  const stage = createExportStage();

  try {
    const rendered = await renderMarkdown({
      source: options.source,
      container: stage.host,
      theme,
      baseDir: options.baseDir,
      encoding: options.encoding,
      frontmatterDisplay: options.frontmatterDisplay,
      isLarge: options.isLarge,
      signal: options.signal,
      // 导出不是打印：绝不能发 PRINT_READY，否则会误触 Rust 侧正在等待的 PDF 流程
      emitPrintReadySignal: false,
    });
    // 渲染期切了文档 / 用户取消：committed=false 意味着内容压根没落地，不能拿去导出
    if (!rendered.committed) {
      rendered.dispose();
      throw new DOMException("html export aborted", "AbortError");
    }
    // 监听器与定时器可以立刻收：下面只读 DOM 结构，不依赖任何交互
    rendered.dispose();

    stripCodeBlockChrome(stage.host);
    restoreExternalImages(stage.host);
    const assets = extractLocalAssets(stage.host);
    stripTransientAttrs(stage.host);

    // 字体只在真的有公式时才背：KaTeX 样式表一旦注入就常驻，不能按样式表在不在来判断
    const inlineFonts = stage.host.querySelector(".katex, .katex-display") !== null;
    const styles = await collectInlineStyles(inlineFonts);

    const html = buildDocument({
      title: options.title,
      theme,
      styles,
      body: stage.host.innerHTML,
    });

    return { html, assets, sourcePath: options.sourcePath ?? null };
  } finally {
    stage.dispose();
  }
}
