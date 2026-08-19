/**
 * 富文本分享（FR-10 ② 公众号 / FR-11 飞书默认通道 / FR-18 钉钉）—— 前端半。
 *
 * 【为什么必须逐元素内联样式】
 * 收件端（公众号图文编辑器、飞书文档、钉钉文档、Word）粘贴时只保留 **元素 style 属性**，
 * `<style>` 块与 class 一律丢弃。所以导出 HTML 那套「抓整张样式表塞进 <style>」的做法
 * （见 render/htmlExport.ts）在这里一个字都用不上：粘过去会变成一篇裸 HTML，
 * 比纯文本还难看。这里的做法是把运行期 `getComputedStyle` 的结果按白名单写回元素上。
 *
 * 【为什么正文仍走 renderMarkdown】
 * 「预览 = 导出 = 分享」是本产品的立身之本（DG 0）。另起一条渲染路径，
 * 告警块 / [TOC] / 表格 / frontmatter 三态就会各自漂移。这里与 htmlExport 一样：
 * 建一个与阅读区同构的离屏舞台，让渲染管线把结果搬进去，我们只做分享特有的后处理。
 *
 * 【为什么要强行按浅色主题取值】
 * 计算样式取的是**当前主题**的真实值。用户开着深色主题分享，粘出去就是黑底白字，
 * 在公众号里是灾难。tokens.css 把语义变量定义在 `:root`，深色只是重绑同名变量；
 * 因此这里从 CSSOM 里捞出「浅色那一份」`--md-*`，就地写在离屏舞台上——
 * 自定义属性会向下继承，且元素上的声明恒压过继承值，整棵子树因此稳定按浅色计算。
 *
 * 【本文件不碰 IPC】
 * 只产出数据结构；invoke 由 services/ipc.ts 封装、由 ShareDialog 经 props 注入
 * （DG 7.1 服务层纪律 + ESLint no-restricted-imports）。
 *
 * 【已知不保真项，UI 必须如实说明，不许让用户以为「粘过去一模一样」】
 *   - 公式（KaTeX）与图表（Mermaid，SVG）在多数编辑器粘贴后会丢失或变形；
 *   - 本地图片以 data URI 内联，部分编辑器会拒收 data URI，需要手动重新上传；
 *   - 外链图片保持原地址，由收件端自行决定是否拉取（红线 4 约束的是本应用，不是别人的编辑器）。
 */

import { t } from "../i18n/zh-CN";
import { assetToken } from "../render/htmlExport";
import { renderMarkdown } from "../render/preview";
import type { FileEncoding, FrontmatterDisplay } from "../types";

/* ── 对外契约（与 src-tauri/src/share/mod.rs 的 RichTextPayload 逐字段对齐） ── */

/** 与 Rust `ShareTarget` 的 serde kebab-case 取值一一对应 */
export type ShareTarget = "wechat-mp" | "lark" | "ding-talk";

/** 一张本地图片：HTML 里的占位 token ↔ 本机绝对路径（Rust 侧读盘并换成 data URI） */
export interface RichTextAsset {
  readonly token: string;
  readonly path: string;
}

/** 交给 Rust `copy_rich_text` 的完整载荷（字段名即 wire 格式，camelCase） */
export interface RichTextPayload {
  readonly html: string;
  readonly plainText: string;
  readonly target: ShareTarget;
  readonly assets: readonly RichTextAsset[];
}

/** Rust `copy_rich_text` 的返回体 */
export interface RichTextResult {
  readonly inlinedImages: number;
  readonly skippedImages: number;
  readonly htmlBytes: number;
}

/** 渲染产物（尚未绑定具体目标平台；target 由调用方在最后一步补上） */
export interface RichTextDocument {
  readonly html: string;
  readonly plainText: string;
  readonly assets: readonly RichTextAsset[];
  /** 正文里是否含公式/图表——UI 据此决定要不要多挂一行「可能不保真」的说明 */
  readonly hasFragileBlocks: boolean;
}

export interface BuildRichTextOptions {
  /** Markdown 原文（已解码、已去 BOM，frontmatter 尚未剥离） */
  readonly source: string;
  /** .md 所在目录，本地图片相对路径基准 */
  readonly baseDir: string | null;
  /** 文件编码，仅供渲染管线回填统计 */
  readonly encoding: FileEncoding;
  /** frontmatter 三态（FR-14）；不传按 card，与阅读区默认一致 */
  readonly frontmatterDisplay?: FrontmatterDisplay;
  /** 大文件：渲染管线据此限量增强代码块 */
  readonly isLarge?: boolean;
  /** 中止令牌：用户在生成过程中切文档 / 关面板时 abort */
  readonly signal?: AbortSignal;
}

/* ── 调参常量（技术值） ─────────────────────────────────────── */

/**
 * 离屏舞台宽度。与 htmlExport 的 812 刻意不同：公众号正文区实测约 677px，
 * 飞书/钉钉文档区更窄。按 680 定稿能让表格列宽、代码折行在粘贴后不至于立刻横向溢出。
 */
const STAGE_WIDTH = 680;

/** 正文列宽档（对应 markdown.css 的 [data-reading-width] 三态） */
const STAGE_READING_WIDTH = "medium";

/** 分享件的正文基准字号与缩放（阅读区那两个变量由 App 注入，这里自己定死） */
const STAGE_READING_FONT = "16px";
const STAGE_ZOOM = "1";

/**
 * `enhanceCodeBlocks` 给代码块套的壳标记（preview.ts 的 `CODE_WRAP_MARKER`，未导出）。
 * 契约：preview.ts 改这个字面量时本处必须同步（htmlExport.ts 有同一份注释）。
 */
const CODE_BLOCK_MARKER = "data-code-block";

/** 整棵子树原样保留、不做样式内联的元素（见文件头「已知不保真项」） */
const OPAQUE_SUBTREE = "svg";

/** 后处理时整个摘掉的元素：脚本/样式/交互件/重复内容 */
const DROP_SELECTORS = [
  "script",
  "style",
  "link",
  "noscript",
  "template",
  // 代码块 hover 工具条里的复制按钮、外链图占位块上的加载按钮——粘出去都是死件
  "button",
  // 标题锚点：它是 UI 而非正文（preview.ts 1190 行注释同义）
  "a.vditor-anchor",
  // KaTeX 同时输出 MathML 与 HTML 两份，粘贴后会出现两遍公式文字
  ".katex-mathml",
].join(",");

/** 粘贴后仍有意义的属性；其余（class / id / data-* / aria-* / role / loading…）一律清掉 */
const KEEP_ATTRS = new Set([
  "href",
  "src",
  "alt",
  "title",
  "colspan",
  "rowspan",
  "span",
  "start",
  "reversed",
  "align",
  "cite",
  "datetime",
]);

/**
 * 继承类属性：只在**与父元素不同**时才写。
 * 不做这个比对的话，每一个 `<span>`（代码高亮一行能有十几个）都会背上一份完整字体栈，
 * 一篇普通文档的 HTML 能膨胀到十几 MB，公众号编辑器直接卡死。
 */
const INHERITED_PROPS = [
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-indent",
  "text-transform",
  "white-space",
  "word-break",
  "overflow-wrap",
] as const;

/**
 * 非继承类属性 → 「无趣值」。取值等于无趣值就不写，
 * 让收件端用自己的默认值（那通常比我们强塞一个 0px 更合适）。
 */
const BOX_PROPS: readonly (readonly [string, readonly string[]])[] = [
  // display 只写"非常规"的那几种：block/inline 是编辑器本来就有的默认
  ["display", ["inline", "block"]],
  ["background-color", ["rgba(0, 0, 0, 0)", "transparent"]],
  ["margin-top", ["0px"]],
  ["margin-right", ["0px"]],
  ["margin-bottom", ["0px"]],
  ["margin-left", ["0px"]],
  ["padding-top", ["0px"]],
  ["padding-right", ["0px"]],
  ["padding-bottom", ["0px"]],
  ["padding-left", ["0px"]],
  ["border-top-left-radius", ["0px"]],
  ["border-top-right-radius", ["0px"]],
  ["border-bottom-right-radius", ["0px"]],
  ["border-bottom-left-radius", ["0px"]],
  ["text-decoration-line", ["none"]],
  ["vertical-align", ["baseline"]],
  ["opacity", ["1"]],
];

/** 四条边各自判断：宽度为 0 或 style 为 none 时，三条边框属性一条都不写 */
const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;

/** 只对特定标签才有意义的属性（写给所有元素纯属噪声） */
const TAG_SCOPED_PROPS: readonly (readonly [string, readonly string[]])[] = [
  ["list-style-type", ["ul", "ol", "li"]],
  ["border-collapse", ["table"]],
  ["border-spacing", ["table"]],
];

/* ── 1. 浅色 Token 快照 ────────────────────────────────────── */

/**
 * 从 CSSOM 里捞出「浅色那一份」自定义属性。
 *
 * 规则：只认选择器**恰好**是 `:root` 的规则，且不在 `prefers-color-scheme: dark`
 * 媒体块内。tokens.css 的深色重绑写作 `:root[data-theme="dark"]` 与
 * `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`，
 * 两者都被这条规则天然排除，无需维护第二份色表。
 *
 * 读不到（跨源样式表）不是错误：那种样式表不该存在（红线 8），真出现就退化为
 * 「按当前主题取值」，最坏结果是深色主题下分享出深色排版，而不是整个功能失败。
 */
function collectLightTokens(): Map<string, string> {
  const tokens = new Map<string, string>();

  const visit = (rules: CSSRuleList, inDark: boolean): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        const dark = /prefers-color-scheme\s*:\s*dark/i.test(rule.conditionText);
        visit(rule.cssRules, inDark || dark);
        continue;
      }
      if (rule instanceof CSSSupportsRule) {
        visit(rule.cssRules, inDark);
        continue;
      }
      if (inDark || !(rule instanceof CSSStyleRule)) {
        continue;
      }
      if (rule.selectorText.trim() !== ":root") {
        continue;
      }
      const declarations = rule.style;
      for (let index = 0; index < declarations.length; index += 1) {
        const name = declarations.item(index);
        if (name.startsWith("--")) {
          tokens.set(name, declarations.getPropertyValue(name).trim());
        }
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.disabled) {
      continue;
    }
    try {
      visit(sheet.cssRules, false);
    } catch (error: unknown) {
      console.warn("[shareRichText] stylesheet is not readable via CSSOM", sheet.href, error);
    }
  }
  return tokens;
}

/* ── 2. 离屏舞台 ───────────────────────────────────────────── */

interface Stage {
  readonly host: HTMLDivElement;
  readonly dispose: () => void;
}

/**
 * 建一个与阅读区同构、但**强制浅色**的离屏容器。
 *
 * `visibility:hidden` 而非 `display:none`：后者没有布局盒，`getComputedStyle` 拿到的
 * 尺寸类属性全是 0/auto，Mermaid 的 getBBox() 与 KaTeX 的宽度测量也会集体失灵
 * （preview.ts / htmlExport.ts 的离屏舞台同理）。
 */
function createStage(): Stage {
  const stage = document.createElement("div");
  stage.setAttribute("data-share-stage", "true");
  stage.setAttribute("aria-hidden", "true");
  // 显式主题标记：给可能按 [data-theme] 选择的样式一个正确答案（tokens 走下面的变量覆盖）
  stage.setAttribute("data-theme", "light");
  stage.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${STAGE_WIDTH}px`,
    "height:0",
    "overflow:hidden",
    "visibility:hidden",
    "pointer-events:none",
    "z-index:-1",
    // 原生部件（滚动条、表单件）也按浅色算，避免个别 UA 色渗进计算值
    "color-scheme:light",
  ].join(";");

  for (const [name, value] of collectLightTokens()) {
    stage.style.setProperty(name, value);
  }

  const column = document.createElement("div");
  column.setAttribute("data-reading-width", STAGE_READING_WIDTH);
  // 分享件里没有横向滚动条可用，代码一律折行
  column.setAttribute("data-code-wrap", "on");
  column.style.setProperty("--md-reading-font", STAGE_READING_FONT);
  column.style.setProperty("--md-zoom", STAGE_ZOOM);

  const host = document.createElement("div");
  host.className = "markdown-body md-content vditor-reset vditor-reset--anchor";
  host.setAttribute("data-code-wrap", "on");
  host.style.setProperty("--md-reading-font", STAGE_READING_FONT);
  host.style.setProperty("--md-zoom", STAGE_ZOOM);

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

/* ── 3. 正文后处理 ─────────────────────────────────────────── */

/** 摘掉代码块外壳与工具条，把 `<pre>` 还原到原位（分享件里没有 hover，也没有剪贴板） */
function stripCodeBlockChrome(host: HTMLElement): void {
  for (const wrapper of Array.from(
    host.querySelectorAll<HTMLElement>(`[${CODE_BLOCK_MARKER}]`),
  )) {
    const pre = wrapper.querySelector("pre");
    if (pre === null) {
      wrapper.remove();
      continue;
    }
    wrapper.replaceWith(pre);
  }
}

/**
 * 外链图片占位块 → 真正的 `<img>`。
 * 是否发起请求由收件端决定：红线 4 管的是本应用运行时的网络行为，
 * 而一份交给别人的稿子里留个点不动的占位块才是真的丢信息。
 */
function restoreExternalImages(host: HTMLElement): void {
  for (const placeholder of Array.from(
    host.querySelectorAll<HTMLElement>("[data-external-image]"),
  )) {
    const source = placeholder.getAttribute("data-external-image") ?? "";
    if (source === "") {
      placeholder.remove();
      continue;
    }
    const image = document.createElement("img");
    image.setAttribute("src", source);
    image.setAttribute("alt", placeholder.getAttribute("data-external-alt") ?? "");
    placeholder.replaceWith(image);
  }
}

/**
 * 任务列表的 `<input type=checkbox>` → 字符勾选框。
 * 编辑器一律剥离表单控件，不换成字符的话，粘过去只剩没有任何标记的裸条目，
 * 「做了 / 没做」这条信息就此丢失。
 */
function replaceTaskCheckboxes(host: HTMLElement): void {
  for (const box of Array.from(
    host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  )) {
    const glyph = document.createElement("span");
    glyph.textContent = box.checked ? t.shareDialog.taskDone : t.shareDialog.taskTodo;
    box.replaceWith(glyph);
  }
}

/**
 * 本地图片 → 占位 token，并收集「token ↔ 绝对路径」清单。
 * 同一张图多处出现共用一个 token：Rust 侧因此只读一次盘、只内联一份 base64。
 */
function extractLocalAssets(host: HTMLElement): RichTextAsset[] {
  const assets: RichTextAsset[] = [];
  const tokenByPath = new Map<string, string>();

  for (const image of Array.from(
    host.querySelectorAll<HTMLImageElement>("img[data-local-path]"),
  )) {
    const path = image.getAttribute("data-local-path") ?? "";
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

/* ── 4. 样式内联 ───────────────────────────────────────────── */

function isOpaque(element: Element): boolean {
  return element.tagName.toLowerCase() === OPAQUE_SUBTREE;
}

/** 组装一个元素的 style 声明串；`parent` 为 null 表示这是根（继承属性全量输出） */
function declarationsFor(
  element: Element,
  computed: CSSStyleDeclaration,
  parent: CSSStyleDeclaration | null,
): string {
  const tag = element.tagName.toLowerCase();
  const parts: string[] = [];

  for (const prop of INHERITED_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value === "") {
      continue;
    }
    if (parent !== null && parent.getPropertyValue(prop) === value) {
      continue;
    }
    parts.push(`${prop}:${value}`);
  }

  for (const [prop, boring] of BOX_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value === "" || boring.includes(value)) {
      continue;
    }
    parts.push(`${prop}:${value}`);
  }

  for (const side of BORDER_SIDES) {
    const width = computed.getPropertyValue(`border-${side}-width`);
    const style = computed.getPropertyValue(`border-${side}-style`);
    if (width === "" || width === "0px" || style === "none" || style === "") {
      continue;
    }
    parts.push(`border-${side}:${width} ${style} ${computed.getPropertyValue(`border-${side}-color`)}`);
  }

  for (const [prop, tags] of TAG_SCOPED_PROPS) {
    if (!tags.includes(tag)) {
      continue;
    }
    const value = computed.getPropertyValue(prop);
    if (value !== "") {
      parts.push(`${prop}:${value}`);
    }
  }

  // 图片：宽度交给收件端自适应，绝不写死 px（编辑器正文宽度各不相同）
  if (tag === "img") {
    parts.push("max-width:100%", "height:auto");
  }
  // 表格：编辑器里默认不撑满，显式给 100% 才不会缩成一小坨
  if (tag === "table") {
    parts.push("width:100%");
  }

  return parts.join(";");
}

/**
 * 两趟处理。
 *
 * 【为什么必须分两趟】计算样式依赖 class 与样式表。第一趟只**读**（把每个元素该写的
 * 声明串存进 Map），第二趟才**改**（删属性、写 style）。合成一趟的话，删掉第一个元素的
 * class 会立刻改变它后代的计算样式，越往后越失真——而且失真是渐进的、肉眼很难发现。
 */
function inlineComputedStyles(host: HTMLElement): void {
  const declarations = new Map<Element, string>();

  const read = (element: Element, parent: CSSStyleDeclaration | null): void => {
    if (isOpaque(element)) {
      return;
    }
    const computed = window.getComputedStyle(element);
    declarations.set(element, declarationsFor(element, computed, parent));
    for (const child of Array.from(element.children)) {
      read(child, computed);
    }
  };

  const hostStyle = window.getComputedStyle(host);
  for (const child of Array.from(host.children)) {
    read(child, hostStyle);
  }

  const write = (element: Element): void => {
    if (isOpaque(element)) {
      return;
    }
    for (const name of Array.from(element.getAttributeNames())) {
      if (!KEEP_ATTRS.has(name)) {
        element.removeAttribute(name);
      }
    }
    const declaration = declarations.get(element) ?? "";
    if (declaration !== "") {
      element.setAttribute("style", declaration);
    }
    for (const child of Array.from(element.children)) {
      write(child);
    }
  };

  for (const child of Array.from(host.children)) {
    write(child);
  }
}

/** 根容器的样式：继承属性全量写一遍 + 白底，让整篇稿子有一个确定的起点 */
function rootDeclarations(host: HTMLElement): string {
  const computed = window.getComputedStyle(host);
  const parts: string[] = [];
  for (const prop of INHERITED_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value !== "") {
      parts.push(`${prop}:${value}`);
    }
  }
  const background = computed.getPropertyValue("background-color");
  if (background !== "" && background !== "rgba(0, 0, 0, 0)") {
    parts.push(`background-color:${background}`);
  }
  return parts.join(";");
}

/* ── 主入口 ─────────────────────────────────────────────────── */

/**
 * 渲染当前文档并产出一份可直接粘进富文本编辑器的 HTML 片段。
 *
 * 返回的 `html` 是一个 `<section>` 包裹的片段（不是完整文档）：CF_HTML 的头部
 * 由 clipboard-manager 生成（事实库 #14），我们不手工拼。
 * `assets` 里的每个 token 在 `html` 中只出现在 `img[src]` 上，Rust 侧整串替换即可。
 *
 * 失败语义：渲染管线抛错时原样抛出；被 `signal` 中止时抛 AbortError，调用方按取消处理。
 */
export async function buildRichText(
  options: BuildRichTextOptions,
): Promise<RichTextDocument> {
  const stage = createStage();

  try {
    const rendered = await renderMarkdown({
      source: options.source,
      container: stage.host,
      // 恒浅色：见文件头「为什么要强行按浅色主题取值」
      theme: "light",
      baseDir: options.baseDir,
      encoding: options.encoding,
      frontmatterDisplay: options.frontmatterDisplay,
      isLarge: options.isLarge,
      signal: options.signal,
      // 分享不是打印：绝不能发 PRINT_READY，否则会误触 Rust 侧正在等待的 PDF 流程
      emitPrintReadySignal: false,
    });
    if (!rendered.committed) {
      rendered.dispose();
      throw new DOMException("share rich text aborted", "AbortError");
    }
    rendered.dispose();

    // 顺序有讲究：先摘壳与占位块（改结构），再抽图片（改 src），最后才内联样式（读计算值）
    stripCodeBlockChrome(stage.host);
    restoreExternalImages(stage.host);
    replaceTaskCheckboxes(stage.host);
    for (const node of Array.from(stage.host.querySelectorAll(DROP_SELECTORS))) {
      node.remove();
    }
    const hasFragileBlocks =
      stage.host.querySelector(".katex, .katex-display, svg, [data-mermaid-source]") !== null;
    const assets = extractLocalAssets(stage.host);

    // 纯文本回退取渲染后的可见文本（聊天窗口只会拿到这一份）。
    // innerText 依赖布局，因此必须在舞台还挂在文档里的时候取。
    const plainText = (stage.host.innerText || stage.host.textContent || "").trim();

    inlineComputedStyles(stage.host);

    // 用真实 DOM 组装外层，让浏览器负责属性转义：
    // 字体栈里带双引号（"Segoe UI"），手拼字符串必然出错。
    const section = document.createElement("section");
    section.setAttribute("style", rootDeclarations(stage.host));
    while (stage.host.firstChild !== null) {
      section.appendChild(stage.host.firstChild);
    }

    return {
      html: section.outerHTML,
      plainText,
      assets,
      hasFragileBlocks,
    };
  } finally {
    stage.dispose();
  }
}
