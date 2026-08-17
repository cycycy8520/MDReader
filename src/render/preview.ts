/**
 * 渲染管线 —— 对应 DG 7.1 渲染层与 DG 7.2-2 数据流。
 *
 * 【批次 2.1 离屏双缓冲】整条管线在**离屏容器**里跑完，settled 后才用一次
 * `replaceChildren` 把子节点整体搬进真实容器（搬运前后各给调用方一个同步回调，
 * 用于同帧读取/恢复 scrollTop）。这样外部保存触发的重渲染全程不清空旧内容：
 * 没有白闪、没有滚动高度塌缩、没有"先跳顶再弹回"。
 * 离屏容器必须**挂在 document 上**且用 `visibility:hidden` 而非 `display:none`——
 * 后者没有布局盒，Mermaid 的 getBBox 与 KaTeX 的宽度测量全会拿到 0。
 *
 * 固定顺序（不得调换，安全与正确性都依赖它）：
 *   1. 剥离 frontmatter（FR-14，按 frontmatterDisplay 渲染成属性卡片 / 代码块 / 不显示）
 *   2. Vditor.md2html()：cdn 指向本地自托管目录、markdown.sanitize = true
 *      —— 红线 1/8：sanitize 任何代码路径不得置 false；cdn 不得指向任何公共 CDN
 *      （注释里也不写那两个域名字面量：scripts/check-no-cdn.mjs 扫产物字符串，
 *       debug 构建不 minify，写了就会被误报成命中）
 *   3. DOMPurify 后处理（XSS 第二层，DG 8「XSS 三层防御」）——必须在「作者 HTML」阶段完成
 *   4. 本地图片改写（asset 协议）+ 外链图片占位（红线 4）
 *   5. hljs / KaTeX / Mermaid 三个渲染器（产物来自本地可信库，不再过第 2 层的严格配置，
 *      Mermaid 因 securityLevel="loose" 额外单独过一遍图表专用配置）
 *   6. 等待「真正就绪」：三个渲染器全部落地 + document.fonts.ready + 两帧
 *   7. 代码块增强（语言标签 + 复制按钮）
 *   8. 大纲树 + 滚动高亮（官方不提供，自研；大文件下降级为节流）
 *   9. 打印模板场景：全部就绪后 emit PRINT_READY，通知 Rust 侧执行 PrintToPdf（DG 7.2-4）
 *
 * 【为什么不用 Vditor.preview()】
 * previewRender 内部会 `await addScript(`${cdn}/dist/js/i18n/zh_CN.js`)` 与
 * `${cdn}/dist/js/icons/ant.js`，并且 addScript 在 onerror 时是 **reject**。
 * 这两个目录不在 DG 8 的自托管白名单里（scripts/fetch-vditor.mjs 未复制），
 * 生产包里必然 404 → preview() 整体 reject → 阅读区永远空白。
 * 另外 previewRender 会 setContentTheme() 去拉 dist/css/content-theme/*.css（同样未复制），
 * 并注入一套依赖内联 onclick 的复制按钮（会被 DOMPurify 清成死按钮）。
 * 因此这里改用 `Vditor.md2html()` 拿到 HTML 字符串，再自己按上面的顺序编排渲染器：
 * 既避开缺失资源，也拿回了「DOMPurify 夹在作者 HTML 与 KaTeX/Mermaid 产物之间」的排序控制权。
 */

import DOMPurify, { type Config as PurifyConfig } from "dompurify";
import Vditor from "vditor";

import { t } from "../i18n/zh-CN";
import { emitPrintReady, toAssetUrl } from "../services/ipc";
import type {
  DocumentStats,
  FileEncoding,
  Frontmatter,
  FrontmatterDisplay,
  HeadingLevel,
  OutlineNode,
  ResolvedTheme,
} from "../types";

/**
 * Vditor 自托管资源根目录（红线 8）。
 * Vditor 会以 `${cdn}/dist/...` 拼接资源路径，因此该目录下必须存在 dist/ 子目录：
 * scripts/fetch-vditor.mjs 按 DG 8 白名单裁剪产出到 vendor/vditor/，
 * vite.config.ts 的 publicDir:"vendor" 使其在 dev 与产物中都落在 /vditor/dist/... 下。
 */
export const VDITOR_LOCAL_CDN = "/vditor";

/**
 * DOMPurify 配置（XSS 第二层）。
 * 必须放行 svg / mathml：Mermaid 输出 SVG、KaTeX 输出 MathML + span 树。
 * 注意：本配置只作用于「作者 Markdown 转出来的 HTML」，此时公式与图表都还是纯文本，
 * 所以 FORBID_ATTR 里的 style 不会误伤 KaTeX / Mermaid（它们在这一步之后才渲染）。
 */
const PURIFY_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  // 代码高亮与 Mermaid 依赖 class；锚点跳转依赖 id
  ADD_ATTR: ["id", "class", "target", "rel", "data-lang", "data-anchor"],
  // 禁止内联事件与自定义样式表注入
  FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["style", "srcdoc", "formaction"],
  KEEP_CONTENT: true,
};

/**
 * 图表产物专用配置（XSS 第二层之补充，只作用于 Mermaid 生成的子树）。
 *
 * Vditor 的 mermaidRender 固定 `securityLevel: "loose"` + `htmlLabels: true`，
 * 图表标签里的内容来自作者 Markdown，因此 Mermaid 产物必须再过一遍过滤——
 * 但 SVG 的可视化完全依赖 <style> 与 style 属性，用上面那套严格配置会把图冲成裸骨架。
 * 故这里在「只覆盖图表子树」的前提下放行 style / foreignObject，
 * 同时把脚本类标签与 srcdoc/formaction/ping 显式钉死。
 * 这是**新增**一层过滤（原本 Mermaid 产物根本过不了第 2 层），不构成对红线的削弱。
 */
const DIAGRAM_PURIFY_CONFIG: PurifyConfig & { IN_PLACE: true } = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_TAGS: ["style", "foreignobject"],
  ADD_ATTR: ["style", "id", "class", "transform", "xmlns", "xmlns:xlink"],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "base", "meta"],
  FORBID_ATTR: ["srcdoc", "formaction", "ping"],
  KEEP_CONTENT: true,
  IN_PLACE: true,
};

/* ── 调参常量 ──────────────────────────────────────────────── */

/** 等待 Mermaid/KaTeX/hljs 全部落地的上限；超时后按现状继续，只打 warn */
const RENDER_READY_TIMEOUT_MS = 8000;
/** 就绪轮询间隔 */
const READY_POLL_MS = 60;
/** 字体加载等待上限（KaTeX 的 KaTeX_Main 等字体是按需触发的） */
const FONTS_READY_TIMEOUT_MS = 3000;
/** 复制按钮「已复制」反馈时长 */
const COPY_FEEDBACK_MS = 1500;
/** 大文件下最多增强多少个代码块（避免几千个按钮拖垮首屏） */
const LARGE_DOC_CODE_BLOCK_LIMIT = 200;
/** 大文件下滚动高亮的节流间隔（DG 8「大文件」） */
const LARGE_DOC_SCROLL_THROTTLE_MS = 500;
/** 就绪超时后补做的两次图表兜底过滤时机 */
const DIAGRAM_RESWEEP_MS = [2000, 5000];
/** 无标题文本时的兜底 id 前缀 */
const HEADING_ID_FALLBACK = "heading-";
/** 代码块增强后包裹层的标记类，用于幂等判断 */
const CODE_WRAP_MARKER = "data-code-block";
/**
 * 离屏舞台取不到真实容器宽度时的兜底宽度（阅读区尚未布局完成的极端时序）。
 * 只影响 Mermaid 首次测量，搬进真实容器后 SVG 自身的 max-width:100% 会重新贴合。
 */
const STAGE_FALLBACK_WIDTH = 800;
/**
 * 离屏舞台需要从真实容器镜像过去的属性：样式层的 codeWrap 规则按它选中，
 * 不镜像的话离屏测出来的代码块版面与落地后的不一致。
 *
 * 刻意**不**含 `data-reading-width`：那条规则带 32px padding，而舞台宽度取的是
 * 真实容器的 clientWidth（已是内容宽度），镜像过来会把 padding 算两遍。
 */
const STAGE_MIRRORED_ATTRS = ["data-code-wrap"] as const;

/**
 * 这些 language-* 代码块由专用渲染器接管（或压根没自托管对应资源），
 * 既不做 hljs 高亮，也不加语言标签/复制按钮。列表与 Vditor codeRender/highlightRender 保持一致。
 */
const DIAGRAM_LANGUAGE_CLASSES = [
  "language-mermaid",
  "language-flowchart",
  "language-echarts",
  "language-mindmap",
  "language-plantuml",
  "language-smiles",
  "language-abc",
  "language-graphviz",
  "language-markmap",
  "language-math",
];

/**
 * DG 8 白名单**刻意未复制**的 Vditor 可选资源，及其在 addScript 里的 script id。
 *
 * addScript 只认 `document.getElementById(id)`：只要 DOM 里已存在同 id 的元素就立即 resolve。
 * 于是这里预先塞一个 <meta> 占位（用 meta 而非空 <script>，避免触发 CSP 的内联脚本告警），
 * 让 highlightRender / mathRender 的内层 .then 链能继续走下去。
 * 不这么做的话：third-languages.js 缺失会让**所有**代码高亮静默失效，
 * mhchem.min.js 缺失会让**所有**数学公式静默失效（两处 reject 都在未捕获的 then 链里）。
 */
const OPTIONAL_ASSET_STUB_IDS = [
  // ${cdn}/dist/js/highlight.js/third-languages.js —— 冷门语言补充包，不自托管
  "vditorHljsThirdScript",
  // ${cdn}/dist/js/katex/mhchem.min.js —— 化学式扩展，不自托管
  "vditorKatexChemScript",
];

export interface RenderOptions {
  /** Markdown 原文（已解码、已去 BOM），frontmatter 尚未剥离 */
  source: string;
  /** 阅读区容器；Vditor.preview 的形参类型即为 HTMLDivElement */
  container: HTMLDivElement;
  /** 当前解析后的主题，决定 Vditor mode 与 hljs 主题（GitHub Light/Dark 两套） */
  theme: ResolvedTheme;
  /** .md 所在目录，作为本地图片相对路径基准（DG 8「查看态本地图片」） */
  baseDir: string | null;
  /** 文件编码，仅用于回填状态栏统计 */
  encoding: FileEncoding;
  /** 打印模板场景：渲染全部就绪后 emit PRINT_READY（DG 7.2-4） */
  emitPrintReadySignal?: boolean;
  /** DocumentPayload.isLarge：滚动高亮降级为节流、代码块增强限量（FR-01） */
  isLarge?: boolean;
  /** frontmatter 三态显示（FR-14 / 2.5）；不传按 card */
  frontmatterDisplay?: FrontmatterDisplay;
  /** 当前章节回调（FR-04 滚动高亮）；不传则不挂任何滚动监听 */
  onActiveHeading?: (headingId: string) => void;
  /**
   * 中止令牌（2.1）。调用方切换文档时 abort：本次渲染即使已经跑完也**不会**搬进真实容器，
   * 从根上杜绝"上一篇的渲染结果覆盖下一篇"。已 abort 时返回的结果 `committed` 为 false。
   */
  signal?: AbortSignal;
  /**
   * DOM 落地即回调（2.8）：大纲/字数不再被 Mermaid 的 8s 就绪超时绑架。
   * 此刻元素还在离屏容器里，但标题 id 已经定稿，搬运不会改变它们。
   */
  onOutlineReady?: (outline: OutlineNode[]) => void;
  onStatsReady?: (stats: DocumentStats) => void;
  /** 搬运**之前**同步调用：调用方在这里读取旧内容的 scrollTop（读晚了会被新内容钳位） */
  onBeforeCommit?: (container: HTMLDivElement) => void;
  /** 搬运**之后**同步调用：调用方在这里恢复 scrollTop，与搬运处于同一帧，故无白闪无跳动 */
  onCommit?: (container: HTMLDivElement) => void;
}

export interface RenderResult {
  outline: OutlineNode[];
  frontmatter: Frontmatter | null;
  stats: DocumentStats;
  /** 内容是否真的搬进了真实容器；false = 渲染期间被 signal 中止，调用方应整批丢弃 */
  committed: boolean;
  /** 解除 IntersectionObserver 等副作用；切换文档前必须调用 */
  dispose: () => void;
}

/* ── 1. frontmatter 剥离（FR-14） ───────────────────────────── */

export interface StrippedSource {
  frontmatter: Frontmatter | null;
  /** 原样的 frontmatter 文本（含 `---` 围栏，去掉结尾换行）；无 frontmatter 时为空串。
   *  `frontmatterDisplay === "raw"` 直接把它渲染成代码块。 */
  raw: string;
  /** 剥离后的正文；行号偏移不修正（查找与锚点都基于渲染后 DOM） */
  body: string;
}

// 开头的 BOM 用转义而非字面 BOM 字符：字面 BOM 在编辑器里不可见，
// 容易被格式化工具或批量替换误删，删掉后正则会变成非法的 `^?`。
// 中间那段整体可选，用来覆盖「空 frontmatter」（`---\n---\n`）这种退化写法。
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** 去掉 YAML 标量外层成对的引号；不做转义还原（属性卡片只负责展示） */
function unquote(value: string): string {
  if (value.length >= 2) {
    const head = value[0];
    if ((head === '"' || head === "'") && value.endsWith(head)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 剥离文档头部的 YAML frontmatter。
 *
 * 只做展示导向的浅层解析（DG 5.2 属性卡片是 key/value 两列表格，不还原 YAML 语义）：
 *   - 顶格 `key: value` 记为一项，值去掉成对引号
 *   - 缩进行视为上一项的续行（列表项去掉 `- ` 前缀），用 `, ` 拼进父项，
 *     这样 `tags:\n  - a\n  - b` 会显示成 `tags = a, b` 而不是凭空多出两个键
 *   - `#` 注释行整行跳过
 */
export function stripFrontmatter(source: string): StrippedSource {
  const match = FRONTMATTER_RE.exec(source);
  if (match === null) {
    return { frontmatter: null, raw: "", body: source };
  }

  // RegExpExecArray 的下标类型是 string，但可选分组未命中时实际是 undefined，需显式放宽
  const captured: string | undefined = match[1];
  const frontmatter: Frontmatter = {};
  let lastKey: string | null = null;

  for (const rawLine of (captured ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/[ \t]+$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    // 缩进行 = 上一个键的续行（列表项 / 嵌套映射），并入父项展示
    if (/^[ \t]/.test(line)) {
      if (lastKey === null) {
        continue;
      }
      const item = unquote(trimmed.replace(/^-[ \t]*/, ""));
      if (item === "") {
        continue;
      }
      const previous = lastKey in frontmatter ? frontmatter[lastKey] : "";
      frontmatter[lastKey] = previous === "" ? item : `${previous}, ${item}`;
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      lastKey = null;
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key === "") {
      lastKey = null;
      continue;
    }
    frontmatter[key] = unquote(line.slice(separator + 1).trim());
    lastKey = key;
  }

  return {
    frontmatter,
    raw: match[0].replace(/\r?\n$/, ""),
    body: source.slice(match[0].length),
  };
}

/* ── 1.5 frontmatter 的三种落地形态（2.5，样式类 .md-frontmatter 已就绪） ── */

/**
 * `card`：正文顶部的 dl 属性卡片。
 * 用 DOM API 逐个建节点而不是拼 HTML 字符串：键与值都来自作者文档，
 * textContent 赋值天然不解析标记，等于把这条路径整体挪出 XSS 面之外。
 */
function buildFrontmatterCard(frontmatter: Frontmatter): HTMLElement | null {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) {
    return null;
  }
  const card = document.createElement("dl");
  card.className = "md-frontmatter";
  for (const [key, value] of entries) {
    const term = document.createElement("dt");
    term.textContent = key;
    const detail = document.createElement("dd");
    detail.textContent = value;
    card.append(term, detail);
  }
  return card;
}

/**
 * `raw`：原样代码块。挂 language-yaml 让 hljs 正常接管——
 * 不挂的话 `pre > code` 依旧会被就绪判定盯上（它等的是 .hljs 类），白等一轮超时。
 */
function buildFrontmatterRaw(raw: string): HTMLElement | null {
  if (raw === "") {
    return null;
  }
  const block = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-yaml";
  code.textContent = raw;
  block.appendChild(code);
  return block;
}

/** 按 frontmatterDisplay 把 frontmatter 插到正文最前面；hidden 或无内容时什么都不做 */
function renderFrontmatter(
  host: HTMLElement,
  frontmatter: Frontmatter | null,
  raw: string,
  display: FrontmatterDisplay,
): void {
  if (frontmatter === null || display === "hidden") {
    return;
  }
  const node = display === "raw" ? buildFrontmatterRaw(raw) : buildFrontmatterCard(frontmatter);
  if (node !== null) {
    host.prepend(node);
  }
}

/* ── 2. Markdown → HTML（lute，本地自托管） ─────────────────── */

/**
 * 预注册「刻意不自托管」的可选资源占位，详见 OPTIONAL_ASSET_STUB_IDS 的说明。
 * 幂等：同 id 已存在时直接跳过。
 */
function ensureOptionalAssetStubs(): void {
  for (const id of OPTIONAL_ASSET_STUB_IDS) {
    if (document.getElementById(id) !== null) {
      continue;
    }
    const stub = document.createElement("meta");
    stub.id = id;
    stub.setAttribute("data-vditor-stub", "not-self-hosted");
    document.head.appendChild(stub);
  }
}

/**
 * md2html 只用到其中的 cdn / markdown / math / anchor 几项，
 * 但 IPreviewOptions 要求 mode 必填，故一并给全。
 *
 *   - cdn：红线 8，恒为本地目录
 *   - markdown.sanitize：红线 1，恒 true
 *   - anchor: 1：让 lute 在标题里生成 `<a class="vditor-anchor">`，同时 SetHeadingID(true)
 *     保证标题带 id（大纲跳转与 FR-16 滚动锚点都依赖它）
 *   - icon: undefined / theme.current: "" ：显式关掉 Vditor 想去拉的 icons/*.js 与
 *     content-theme/*.css（两者都不在自托管白名单里）；md2html 路径本身不会碰它们，
 *     写在这里是为了将来若有人切回 preview() 时不至于立刻 404
 */
function buildPreviewOptions(theme: ResolvedTheme) {
  return {
    mode: theme,
    cdn: VDITOR_LOCAL_CDN,
    anchor: 1,
    icon: undefined,
    theme: { current: "" },
    hljs: buildHljsOptions(theme),
    math: buildMathOptions(),
    markdown: {
      // 红线 1：永不置 false
      sanitize: true,
      // 中文与西文之间自动加空格（DG 4.1 选型理由）
      autoSpace: true,
      // 目录页由导出模板自己生成，正文不插 TOC
      toc: false,
      // ==高亮== 语法，只读查看器里纯展示，无副作用
      mark: true,
    },
  };
}

function buildHljsOptions(theme: ResolvedTheme) {
  return {
    enable: true,
    // 仅这两套主题在自托管白名单内（fetch-vditor.mjs 的 accept 规则）
    style: theme === "dark" ? "github-dark" : "github",
    lineNumber: false,
    defaultLang: "",
  };
}

function buildMathOptions() {
  // 数学引擎固定 KaTeX（DG 8：MathJax 已从白名单剔除）
  return { engine: "KaTeX" as const, inlineDigit: false, macros: {} };
}

/* ── 3. DOMPurify 后处理 ────────────────────────────────────── */

/**
 * 过滤一段 HTML 字符串（红线 1：这一层永不移除）。
 * 独立成函数是为了让调用方能「先净化、后写入」——
 * 直接把未净化的 HTML 赋给已挂载的容器会立刻触发 `<img onerror>`，
 * 净化再赋值就没有这个窗口期。
 */
export function purifyHtml(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/**
 * 对已经渲染出来的 DOM 再过滤一遍。
 * 就地替换 innerHTML，保持容器引用不变（file watch 重渲染需要原位替换）。
 * 注意：本函数会抹掉 KaTeX/Mermaid 的内联样式，只适用于「尚未跑图表/公式渲染器」的阶段。
 */
export function purifyInPlace(container: HTMLElement): void {
  container.innerHTML = purifyHtml(container.innerHTML);
}

/** 对 Mermaid 产出的子树单独过滤（配置见 DIAGRAM_PURIFY_CONFIG） */
function purifyDiagrams(container: HTMLElement): void {
  for (const diagram of container.querySelectorAll<HTMLElement>(".language-mermaid")) {
    if (diagram.querySelector("svg") === null) {
      continue;
    }
    if (diagram.getAttribute("data-purified") === "true") {
      continue;
    }
    try {
      DOMPurify.sanitize(diagram, DIAGRAM_PURIFY_CONFIG);
      diagram.setAttribute("data-purified", "true");
    } catch (error) {
      // 过滤失败时宁可不显示：把图表整体清空，绝不放行未过滤的产物
      diagram.textContent = "";
      console.error("[preview] diagram sanitize failed", error);
    }
  }
}

/* ── 4. 图片：本地改写 + 外链拦截（DG 8 / 红线 4） ──────────── */

/** http(s) 外链（含协议相对 `//host/...`） */
const EXTERNAL_SRC_RE = /^(?:https?:)?\/\//i;
/**
 * 无需处理，直接放行：data/blob、asset 协议本身，以及 Windows 上 asset 协议实际落地的
 * `http://asset.localhost/...` 形态（它会被下面的外链正则误判，所以必须先于外链判断）。
 */
const PASSTHROUGH_SRC_RE = /^(?:data:|blob:|asset:|https?:\/\/asset\.localhost\/)/i;
/** 应用自身资源（emoji 等），以 / 开头，交给 dev server / tauri 协议 */
const APP_ROOTED_SRC_RE = /^\//;
/** Windows 盘符绝对路径 */
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;
/** UNC 路径 */
const UNC_ABS_RE = /^\\\\/;
/** file:// URL */
const FILE_URL_RE = /^file:\/\/\/?/i;

/** 尽力解码百分号编码；解码失败（含单独的 % 字面量）时返回原串 */
function tryDecodePath(value: string): string {
  if (!value.includes("%")) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 以 .md 所在目录为基准解析相对路径。
 * 手写而不用 Node 的 path：前端产物里没有 node:path，且这里只需要处理
 * Windows 反斜杠 / 正斜杠混写与 `.` `..` 三种情况。
 */
export function resolveLocalPath(baseDir: string, relative: string): string {
  const separator = baseDir.includes("\\") ? "\\" : "/";
  const segments = baseDir.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const segment of relative.split(/[\\/]/)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 1) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join(separator);
}

/** convertFileSrc 在非 Tauri 环境（纯浏览器 dev / 单测）会抛错，这里兜底成 null */
function safeAssetUrl(absolutePath: string): string | null {
  try {
    return toAssetUrl(absolutePath);
  } catch (error) {
    console.warn("[preview] convertFileSrc unavailable", error);
    return null;
  }
}

/** 占位块上的小按钮（点击加载 / 本篇全部加载 / 重试）共用同一套类名 */
function createPlaceholderButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "shrink-0 rounded-chip px-2 py-0.5 text-ui-sm text-accent hover:bg-hover";
  button.textContent = label;
  return button;
}

/**
 * 把外链图片换成占位块（红线 4：默认不发起任何外部请求，必须用户显式点击），
 * 返回该占位块的「加载」入口供批量加载复用（2.6）。
 *
 * 三态就地切换，不弹 toast、不换位置：
 *   待加载 → 正在加载…（按钮禁用）→ 成功则整块换成 <img>；失败则回到占位块并把按钮改成"重试"。
 * 失败态**保留占位块**而不是留一个裂图：裂图什么信息也不给，占位块至少还能再点一次。
 */
function replaceWithExternalPlaceholder(
  image: HTMLImageElement,
  onLoadAll: (() => void) | null,
  signal: AbortSignal,
): () => void {
  const source = image.getAttribute("src") ?? "";
  const alt = image.getAttribute("alt") ?? "";

  const placeholder = document.createElement("span");
  placeholder.className =
    "my-1 inline-flex max-w-full items-center gap-2 rounded-row border border-l2 bg-card px-3 py-1.5 align-middle text-ui-sm text-tertiary";
  placeholder.setAttribute("data-external-image", source);

  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = t.preview.externalImageBlocked;

  const action = createPlaceholderButton(t.preview.loadExternalImage);

  let loading = false;
  const load = (): void => {
    // isConnected 判断兼作"已成功替换"的判据：成功后占位块已被移出文档
    if (loading || !placeholder.isConnected) {
      return;
    }
    loading = true;
    label.textContent = t.preview.externalImageLoading;
    action.disabled = true;

    const loaded = document.createElement("img");
    loaded.className = "max-w-full rounded-card";
    loaded.alt = alt;
    loaded.loading = "lazy";
    loaded.referrerPolicy = "no-referrer";
    loaded.addEventListener(
      "load",
      () => {
        placeholder.replaceWith(loaded);
      },
      { signal, once: true },
    );
    loaded.addEventListener(
      "error",
      () => {
        loading = false;
        label.textContent = t.preview.externalImageFailed;
        action.textContent = t.common.retry;
        action.disabled = false;
      },
      { signal, once: true },
    );
    // src 最后赋值：两个监听必须先就位，否则缓存命中时 load 事件会早于监听注册
    loaded.src = source;
  };

  action.addEventListener("click", load, { signal });
  placeholder.append(label, action);

  // 单张图不给批量入口（点它和点上一个按钮是同一件事，只会显得啰嗦）
  if (onLoadAll !== null) {
    const all = createPlaceholderButton(t.preview.loadAllExternalImages);
    all.addEventListener("click", onLoadAll, { signal });
    placeholder.append(all);
  }

  image.replaceWith(placeholder);
  return load;
}

/**
 * 遍历正文里的 img：
 *   - http(s) 外链 → 占位块（红线 4）
 *   - data:/blob:/asset:/ 应用根路径 → 原样放行
 *   - 绝对路径 / file:// / 相对路径 → 经 asset 协议改写为可加载 URL（DG 8「查看态本地图片」）
 * srcset 一律移除：它会绕过 src 改写，直接把原始相对路径发出去。
 */
function rewriteImages(
  container: HTMLElement,
  baseDir: string | null,
  signal: AbortSignal,
): void {
  // 外链图先攒起来：占位块要不要给「本篇全部加载」入口，取决于全篇有几张
  const external: HTMLImageElement[] = [];

  for (const image of Array.from(container.querySelectorAll("img"))) {
    image.removeAttribute("srcset");
    const raw = image.getAttribute("src");
    if (raw === null || raw.trim() === "") {
      continue;
    }
    const source = raw.trim();

    // 顺序不能换：asset.localhost 形态同时满足外链正则，必须先被放行判断截住
    if (PASSTHROUGH_SRC_RE.test(source) || APP_ROOTED_SRC_RE.test(source)) {
      continue;
    }
    if (EXTERNAL_SRC_RE.test(source)) {
      external.push(image);
      continue;
    }

    let filePath: string | null = null;
    if (FILE_URL_RE.test(source)) {
      filePath = tryDecodePath(source.replace(FILE_URL_RE, ""));
    } else if (WINDOWS_ABS_RE.test(source) || UNC_ABS_RE.test(source)) {
      filePath = tryDecodePath(source);
    } else if (baseDir !== null && baseDir !== "") {
      // 不切 ?query / #hash：本地文件名里真可能出现这两个字符，切了反而找不到文件
      filePath = resolveLocalPath(baseDir, tryDecodePath(source));
    }

    if (filePath === null) {
      continue;
    }
    const assetUrl = safeAssetUrl(filePath);
    if (assetUrl === null) {
      continue;
    }
    image.setAttribute("src", assetUrl);
    image.setAttribute("data-local-path", filePath);
    // 供阅读区做灯箱事件委托（DG 6.4-4）
    image.setAttribute("data-preview-image", "true");
    image.loading = "lazy";
  }

  if (external.length === 0) {
    return;
  }
  // loaders 先建空数组再填：每个占位块的「全部加载」都要能触发**所有**兄弟占位块，
  // 包括在它之后才创建的那些，所以批量入口只能是读数组的闭包。
  const loaders: (() => void)[] = [];
  const loadAll = (): void => {
    for (const load of [...loaders]) {
      load();
    }
  };
  const batch = external.length > 1 ? loadAll : null;
  for (const image of external) {
    loaders.push(replaceWithExternalPlaceholder(image, batch, signal));
  }
}

/**
 * 把裸 table 包进 overflow-x:auto 的滚动容器（样式见 markdown.css 的 .md-table-wrap）。
 * github-markdown-css 基底把 table 自身设为滚动容器（display:block），但那会丢掉
 * table 布局语义；包裹层方案让表格恢复 display:table，超宽时只在容器内横向滚动，
 * 内容绝不裁切（列宽自适应 fluid 档下的关键保障）。
 * 幂等：已包裹的跳过（file watch 重渲染整体重建 DOM，此处为防御性判断）。
 */
function wrapTables(container: HTMLElement): void {
  for (const table of Array.from(container.querySelectorAll("table"))) {
    const parent = table.parentElement;
    if (parent === null || parent.classList.contains("md-table-wrap")) {
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = "md-table-wrap";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

/* ── 5. 代码块增强（语言标签 + 复制按钮） ───────────────────── */

function isDiagramCode(element: Element): boolean {
  return DIAGRAM_LANGUAGE_CLASSES.some((name) => element.classList.contains(name));
}

/** 从 `language-xxx` 里取语言名；取不到返回空串（此时不显示标签） */
function codeLanguage(element: Element): string {
  const matched = /(?:^|\s)language-([\w+#.-]+)/.exec(element.className);
  const captured: string | undefined = matched?.[1];
  return captured ?? "";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn("[preview] clipboard API failed, falling back", error);
  }

  // 兜底：WebView2 在个别配置下拿不到异步剪贴板权限
  const carrier = document.createElement("textarea");
  carrier.value = text;
  carrier.setAttribute("readonly", "readonly");
  // 移到视口外而不是设成 0 尺寸：零尺寸元素在部分内核里 select() 拿不到选区
  carrier.className = "pointer-events-none fixed -left-full top-0 h-8 w-8 opacity-0";
  document.body.appendChild(carrier);
  try {
    carrier.select();
    return document.execCommand("copy");
  } catch (error) {
    console.warn("[preview] execCommand copy failed", error);
    return false;
  } finally {
    carrier.remove();
  }
}

/**
 * 为每个普通代码块套一层相对定位壳，右上角挂「语言标签 + 复制按钮」。
 * hover 才出现：只对 opacity 加过渡（DG 6：hover 背景不得加 transition）。
 * 复制反馈就地把按钮文案换成「已复制」，不弹 toast。
 */
function enhanceCodeBlocks(
  container: HTMLElement,
  limit: number,
  signal: AbortSignal,
  timers: Set<number>,
): void {
  let enhanced = 0;
  for (const code of Array.from(container.querySelectorAll<HTMLElement>("pre > code"))) {
    if (enhanced >= limit) {
      break;
    }
    if (isDiagramCode(code)) {
      continue;
    }
    const pre = code.parentElement;
    if (pre === null || pre.parentElement?.hasAttribute(CODE_WRAP_MARKER) === true) {
      continue;
    }

    const wrapper = document.createElement("div");
    wrapper.setAttribute(CODE_WRAP_MARKER, "true");
    wrapper.className = "group relative";
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);

    const toolbar = document.createElement("div");
    toolbar.className =
      "pointer-events-none absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity duration-fast group-hover:opacity-100";

    const language = codeLanguage(code);
    if (language !== "") {
      const tag = document.createElement("span");
      tag.className = "rounded-chip bg-layer px-1.5 py-0.5 font-mono text-ui-xs text-tertiary";
      tag.textContent = language;
      toolbar.appendChild(tag);
    }

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className =
      "pointer-events-auto rounded-chip bg-layer px-1.5 py-0.5 text-ui-xs text-secondary hover:bg-hover hover:text-primary";
    copyButton.textContent = t.common.copy;
    copyButton.addEventListener(
      "click",
      () => {
        // 去掉代码块结尾那个由围栏语法带出来的换行，粘贴出来才干净
        const source = (code.textContent ?? "").replace(/\n$/, "");
        void copyToClipboard(source).then((ok) => {
          if (!ok) {
            return;
          }
          copyButton.textContent = t.common.copied;
          copyButton.setAttribute("data-copied", "true");
          const timer = window.setTimeout(() => {
            timers.delete(timer);
            copyButton.textContent = t.common.copy;
            copyButton.removeAttribute("data-copied");
          }, COPY_FEEDBACK_MS);
          timers.add(timer);
        });
      },
      { signal },
    );
    toolbar.appendChild(copyButton);
    wrapper.appendChild(toolbar);
    enhanced += 1;
  }
}

/* ── 6. 大纲提取（FR-04） ──────────────────────────────────── */

function headingLevel(heading: HTMLElement): HeadingLevel {
  switch (heading.tagName) {
    case "H1":
      return 1;
    case "H2":
      return 2;
    case "H3":
      return 3;
    case "H4":
      return 4;
    case "H5":
      return 5;
    default:
      return 6;
  }
}

/** 标题纯文本：剔除 Vditor 注入的锚点链接，压缩空白 */
function headingText(heading: HTMLElement): string {
  const clone = heading.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".vditor-anchor").forEach((anchor) => {
    anchor.remove();
  });
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 生成 slug：保留中日韩与字母数字，空白转连字符 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}\-_]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 去重：冲突时追加 -2 / -3 …… */
function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

function toOutlineTree(flat: OutlineNode[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const node of flat) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

/**
 * 从阅读区标题元素构建类型化大纲树，并**就地补齐/去重标题 id**。
 *
 * lute 的 SetHeadingID 会给标题生成 id，但同名标题会重复、纯符号标题会为空，
 * 而滚动高亮（FR-04）与滚动位置记忆（FR-16）都要求 id 全局唯一，
 * 所以这里统一兜底：沿用可用的原 id，冲突/缺失则按 slug 重算并加后缀，
 * 同时把标题内 `<a class="vditor-anchor">` 的 href 一并改掉，避免锚点指向旧 id。
 */
export function buildOutline(container: HTMLElement): OutlineNode[] {
  const headings = Array.from(
    container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
  );
  const used = new Set<string>();
  const flat: OutlineNode[] = [];

  headings.forEach((heading, index) => {
    const text = headingText(heading);
    const existing = heading.getAttribute("id");
    const base =
      existing !== null && existing !== ""
        ? existing
        : slugify(text) || `${HEADING_ID_FALLBACK}${index + 1}`;
    const id = uniqueId(base, used);
    if (id !== existing) {
      heading.id = id;
      // lute 生成的锚点是 <a id="vditorAnchor-{旧id}" href="#{旧id}">，两处都要跟着改
      const anchor = heading.querySelector("a.vditor-anchor");
      if (anchor !== null) {
        anchor.setAttribute("href", `#${id}`);
        anchor.setAttribute("id", `vditorAnchor-${id}`);
      }
    }
    flat.push({ id, level: headingLevel(heading), text, children: [] });
  });

  return toOutlineTree(flat);
}

/**
 * 兼容入口：官方 API 为 `Vditor.outlineRender(contentElement, targetElement)`，
 * 它把大纲 DOM 写进 targetElement；类型化的 OutlineNode 树另行从标题元素构建，
 * 因为滚动高亮与跳转都需要稳定的 heading id。
 * 大纲面板改由 React 从 OutlineNode[] 渲染后，本函数只在需要官方 DOM 时才用得上。
 */
export function renderOutline(
  contentElement: HTMLElement,
  targetElement: HTMLElement,
): OutlineNode[] {
  const outline = buildOutline(contentElement);
  Vditor.outlineRender(contentElement, targetElement);
  return outline;
}

/* ── 7. 滚动高亮（自研，事实库 #9：官方不提供） ─────────────── */

/** 阅读区滚动容器：由外壳组件打 data-reading-root 标记 */
function scrollRootOf(container: HTMLElement): HTMLElement | null {
  return container.closest<HTMLElement>("[data-reading-root]");
}

/**
 * 监听阅读区标题进入视口，回调当前章节 id。
 * 大文件（>5MB 分段渲染）下不挂本监听，改为 observeHeadingsThrottled（DG 8「大文件」）。
 */
export function observeHeadings(
  container: HTMLElement,
  onActive: (headingId: string) => void,
): () => void {
  const headings = container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible?.target.id) {
        onActive(visible.target.id);
      }
    },
    {
      root: scrollRootOf(container),
      // 命中「视口上沿附近的标题」而不是整屏，避免长章节内高亮跳动
      rootMargin: "0px 0px -70% 0px",
      threshold: 0,
    },
  );

  headings.forEach((heading) => {
    observer.observe(heading);
  });

  return () => {
    observer.disconnect();
  };
}

/**
 * 大文件降级版滚动高亮：不给成百上千个标题各挂一个 IntersectionObserver 目标，
 * 改成一个节流的 scroll 监听，每次只算「最后一个越过判定线的标题」。
 * 判定线取滚动容器顶部 + 80px，与 observeHeadings 的 rootMargin 观感对齐。
 */
export function observeHeadingsThrottled(
  container: HTMLElement,
  onActive: (headingId: string) => void,
  intervalMs: number = LARGE_DOC_SCROLL_THROTTLE_MS,
): () => void {
  const headings = Array.from(
    container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
  );
  if (headings.length === 0) {
    return () => undefined;
  }

  const scrollRoot = scrollRootOf(container);
  const target: HTMLElement | Window = scrollRoot ?? window;
  let timer: number | null = null;
  let lastId = "";

  const compute = (): void => {
    timer = null;
    const rootTop = scrollRoot === null ? 0 : scrollRoot.getBoundingClientRect().top;
    const threshold = rootTop + 80;
    let current = headings[0];
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top > threshold) {
        break;
      }
      current = heading;
    }
    if (current.id !== "" && current.id !== lastId) {
      lastId = current.id;
      onActive(current.id);
    }
  };

  const onScroll = (): void => {
    if (timer === null) {
      timer = window.setTimeout(compute, intervalMs);
    }
  };

  target.addEventListener("scroll", onScroll, { passive: true });
  compute();

  return () => {
    target.removeEventListener("scroll", onScroll);
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  };
}

/* ── 8. 就绪判定（Mermaid / KaTeX / hljs 都是异步的） ────────── */

function delay(ms: number, timers: Set<number>): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, ms);
    timers.add(timer);
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
 * 三个渲染器是否都落地。
 *
 *   - Mermaid：Vditor 在 render 成功/失败后都会写 data-processed="true"；
 *     但**空代码块会被直接 return**，永远等不到该属性，所以空内容视为已就绪。
 *   - KaTeX：Vditor 在 renderToString 前会写 data-math。
 *   - hljs：高亮成功的 code 会带上 .hljs；图表类语言在 highlightRender 里被跳过，
 *     判定时必须用同一份跳过名单，否则永远等不到。
 */
function isRenderSettled(container: HTMLElement): boolean {
  for (const diagram of container.querySelectorAll(".language-mermaid")) {
    if ((diagram.textContent ?? "").trim() === "") {
      continue;
    }
    if (diagram.getAttribute("data-processed") === "true") {
      continue;
    }
    if (diagram.querySelector("svg") !== null) {
      continue;
    }
    return false;
  }

  for (const formula of container.querySelectorAll(".language-math")) {
    if (formula.hasAttribute("data-math")) {
      continue;
    }
    if ((formula.textContent ?? "").trim() === "") {
      continue;
    }
    return false;
  }

  for (const code of container.querySelectorAll("pre > code")) {
    if (isDiagramCode(code) || code.classList.contains("hljs")) {
      continue;
    }
    return false;
  }

  return true;
}

/**
 * 等待「真正渲染完成」。
 * Vditor 的 after 回调只代表同步部分结束，Mermaid/KaTeX/hljs 都还在各自的 then 链里，
 * 直接截图或打印会拿到半成品（DG 7.2-4 的三个注意点之一）。
 * 因此这里先轮询三者的落地标记，再等 document.fonts.ready（KaTeX 字体是按需触发的），
 * 最后再放过两帧让布局稳定。全程有 8s 上限，超时只 warn 不阻断。
 */
async function waitForRenderSettled(
  container: HTMLElement,
  timers: Set<number>,
  isDisposed: () => boolean,
): Promise<boolean> {
  const deadline = performance.now() + RENDER_READY_TIMEOUT_MS;
  let settled = isRenderSettled(container);
  while (!settled && performance.now() < deadline) {
    if (isDisposed()) {
      return false;
    }
    await delay(READY_POLL_MS, timers);
    settled = isRenderSettled(container);
  }

  if (!settled) {
    console.warn("[preview] render did not settle within timeout, continuing anyway");
  }

  if (typeof document.fonts !== "undefined") {
    await Promise.race([document.fonts.ready, delay(FONTS_READY_TIMEOUT_MS, timers)]);
  }
  await nextFrame();
  await nextFrame();
  return settled;
}

/* ── 9. 统计（DG 5.2 状态栏） ───────────────────────────────── */

/** 中日韩表意文字与假名/谚文：逐字计数 */
const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
/** 西文词：字母数字加词内连字符与撇号 */
const WESTERN_WORD_RE = /[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*/g;

/** 字数：中文按字符计、英文按词计（DG 5.2） */
export function countWords(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const western = text.replace(CJK_RE, " ").match(WESTERN_WORD_RE)?.length ?? 0;
  return cjk + western;
}

function countLines(body: string): number {
  return body === "" ? 0 : body.split(/\r\n|\r|\n/).length;
}

/* ── 10. 离屏舞台（2.1 双缓冲） ─────────────────────────────── */

interface RenderStage {
  /** 镜像真实容器的离屏节点：整条管线都在它里面跑 */
  readonly host: HTMLDivElement;
  readonly dispose: () => void;
}

/**
 * 建一个「与真实容器同宽同类同变量」的离屏舞台。
 *
 * 三个约束缺一不可：
 *   1. **必须挂到 document 上**——脱离文档树的节点没有布局，Mermaid 的 getBBox()
 *      与 KaTeX 的宽度测量会全部拿到 0，图表会缩成一团。
 *   2. **只能用 visibility:hidden，不能用 display:none**——后者同样没有布局盒。
 *   3. 宽度必须等于真实容器的内容宽度，否则表格列宽、代码块折行、Mermaid 版面
 *      都会按错误宽度算一遍，搬进去以后再抖一次，等于白做双缓冲。
 * height:0 + overflow:hidden 则保证它不参与页面滚动、不撑出任何滚动条。
 */
function createRenderStage(container: HTMLDivElement): RenderStage {
  const stage = document.createElement("div");
  stage.setAttribute("data-render-stage", "true");
  stage.setAttribute("aria-hidden", "true");
  const width = container.clientWidth > 0 ? container.clientWidth : STAGE_FALLBACK_WIDTH;
  stage.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${width}px`,
    "height:0",
    "overflow:hidden",
    "visibility:hidden",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");

  const host = document.createElement("div");
  host.className = container.className;
  // 排版变量（--md-reading-font / --md-zoom）由 App 以 inline style 注入真实容器，
  // 离屏节点不是它的后代，拿不到继承值，只能整段搬过来
  const inlineStyle = container.getAttribute("style");
  if (inlineStyle !== null) {
    host.setAttribute("style", inlineStyle);
  }
  for (const name of STAGE_MIRRORED_ATTRS) {
    const value = container.getAttribute(name);
    if (value !== null) {
      host.setAttribute(name, value);
    }
  }

  stage.appendChild(host);
  document.body.appendChild(stage);
  return {
    host,
    dispose: () => {
      stage.remove();
    },
  };
}

/* ── 主入口 ─────────────────────────────────────────────────── */

/**
 * 执行完整渲染管线（离屏 → settled → 一次性搬进真实容器）。
 * 返回值里的 dispose 必须在切换文档 / 卸载前调用，
 * 否则滚动监听与「已复制」回退定时器会泄漏到下一个文档。
 */
export async function renderMarkdown(options: RenderOptions): Promise<RenderResult> {
  const startedAt = performance.now();
  const { container, theme } = options;
  const { frontmatter, raw: frontmatterRaw, body } = stripFrontmatter(options.source);

  let disposed = false;
  let committed = false;
  const abort = new AbortController();
  const timers = new Set<number>();
  let disposeHeadingTracking: () => void = () => undefined;

  const stage = createRenderStage(container);
  const host = stage.host;

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    abort.abort();
    timers.forEach((timer) => {
      window.clearTimeout(timer);
    });
    timers.clear();
    disposeHeadingTracking();
    // 已搬运时舞台已空，remove 是纯清理；未搬运时这一步把半成品整个丢掉
    stage.dispose();
  };

  /** 本次渲染是否已经作废：自身被 dispose，或调用方已切到别的文档 */
  const cancelled = (): boolean => disposed || options.signal?.aborted === true;

  const buildStats = (charCount: number): DocumentStats => ({
    charCount,
    lineCount: countLines(body),
    encoding: options.encoding,
    renderMs: Math.round(performance.now() - startedAt),
  });

  let outline: OutlineNode[] = [];
  let charCount = 0;

  try {
    ensureOptionalAssetStubs();

    // 1) Markdown → HTML（lute 内部已按 sanitize:true 过滤一遍，这是第一层）
    const html = await Vditor.md2html(body, buildPreviewOptions(theme));

    // 2) 第二层：先净化字符串再写入，绝不把未净化的 HTML 挂到已连接的节点上
    host.innerHTML = purifyHtml(html);
    // 与 previewRender 对齐的两个类名：vditor-reset 是正文排版基类，
    // vditor-reset--anchor 对应 anchor:1（标题锚点靠左），阅读区样式层按需接管。
    host.classList.add("vditor-reset", "vditor-reset--anchor");

    // 统计要在「增强 DOM」之前取，也要在属性卡片插入之前取：
    // 语言标签、复制按钮、frontmatter 的键值都不属于正文字数
    charCount = countWords(host.textContent ?? "");

    // 2.5) frontmatter 落地（card / raw / hidden）
    renderFrontmatter(
      host,
      frontmatter,
      frontmatterRaw,
      options.frontmatterDisplay ?? "card",
    );

    // 3) 图片：本地改写 + 外链拦截
    rewriteImages(host, options.baseDir, abort.signal);

    // 3.5) 表格：包进 .md-table-wrap 横向滚动容器（列宽自适应下超宽表格不裁切）
    wrapTables(host);

    // 4) 大纲：id 此刻定稿，搬运不会改变它，因此可以立刻回填（2.8）
    outline = buildOutline(host);
    options.onOutlineReady?.(outline);
    options.onStatsReady?.(buildStats(charCount));

    // 5) 三个渲染器（产物来自本地可信库；Mermaid 另有专用过滤，见 purifyDiagrams）
    Vditor.highlightRender(buildHljsOptions(theme), host, VDITOR_LOCAL_CDN);
    Vditor.mathRender(host, { cdn: VDITOR_LOCAL_CDN, math: buildMathOptions() });
    Vditor.mermaidRender(host, VDITOR_LOCAL_CDN, theme);

    const settled = await waitForRenderSettled(host, timers, cancelled);

    // 6) 等待期间用户可能已经开了别的文件——整批丢弃，绝不覆盖新文档。
    //    这一步放在过滤与增强之前：作废的 DOM 不会进入任何容器，也就没有再加工的意义。
    if (cancelled()) {
      stage.dispose();
      return {
        outline,
        frontmatter,
        stats: buildStats(charCount),
        committed: false,
        dispose,
      };
    }

    purifyDiagrams(host);

    // 7) 代码块增强（在高亮之后做：hljs 会重写 innerHTML，但 textContent 不变）
    //    仍在离屏阶段完成：监听器随节点一起搬家，搬完即可用
    enhanceCodeBlocks(
      host,
      options.isLarge === true ? LARGE_DOC_CODE_BLOCK_LIMIT : Number.POSITIVE_INFINITY,
      abort.signal,
      timers,
    );

    container.classList.add("vditor-reset", "vditor-reset--anchor");
    // 三步必须同步连做：中间一旦让出主线程就会画出一帧空容器，白闪就是这么来的
    options.onBeforeCommit?.(container);
    container.replaceChildren(...Array.from(host.childNodes));
    options.onCommit?.(container);
    committed = true;
    stage.dispose();

    // 8) 超时收尾：Mermaid 可能在超时之后才吐出 SVG，补两次兜底过滤（此时节点已在真实容器里）
    if (!settled) {
      for (const at of DIAGRAM_RESWEEP_MS) {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          if (!disposed) {
            purifyDiagrams(container);
          }
        }, at);
        timers.add(timer);
      }
    }

    // 9) 滚动高亮：必须挂在真实容器上（IntersectionObserver 的 root 要取阅读区滚动壳）
    const onActiveHeading = options.onActiveHeading;
    if (onActiveHeading !== undefined && !disposed) {
      disposeHeadingTracking =
        options.isLarge === true
          ? observeHeadingsThrottled(container, onActiveHeading)
          : observeHeadings(container, onActiveHeading);
    }
  } catch (error) {
    // 失败路径同样要收走舞台，否则每失败一次就在 body 上留一坨离屏 DOM
    if (!committed) {
      dispose();
    }
    throw error;
  }

  const stats = buildStats(charCount);

  // 10) 打印模板：所有异步渲染都已落地才发信号（DG 7.2-4）
  if (options.emitPrintReadySignal === true) {
    await emitPrintReady();
  }

  return { outline, frontmatter, stats, committed, dispose };
}
