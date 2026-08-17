/**
 * 渲染管线 —— 对应 DG 7.1 渲染层与 DG 7.2-2 数据流。
 *
 * 固定顺序（不得调换，安全与正确性都依赖它）：
 *   1. 剥离 frontmatter（FR-14，交属性卡片展示，不进正文）
 *   2. Vditor.preview()：cdn 指向本地自托管目录、markdown.sanitize = true
 *      —— 红线 1/8：sanitize 任何代码路径不得置 false；cdn 不得指向 unpkg/jsdelivr
 *   3. DOMPurify 后处理（XSS 第二层，DG 8「XSS 三层防御」）
 *   4. Vditor.outlineRender()：提取标题树供大纲面板（FR-04）
 *   5. IntersectionObserver 挂滚动高亮（官方不提供，自研；大文件下降级为节流）
 *   6. 打印模板场景：全部就绪后 emit PRINT_READY，通知 Rust 侧执行 PrintToPdf（DG 7.2-4）
 *
 * 本文件当前是 M0 骨架：签名与调用形态已定，具体实现在 M0-②「Vditor 实测包」落地。
 */

import DOMPurify from "dompurify";
import Vditor from "vditor";

import { emitPrintReady } from "../services/ipc";
import type {
  DocumentStats,
  FileEncoding,
  Frontmatter,
  OutlineNode,
  ResolvedTheme,
} from "../types";

/**
 * Vditor 自托管资源根目录（红线 8）。
 * Vditor 会以 `${cdn}/dist/...` 拼接资源路径，因此该目录下必须存在 dist/ 子目录：
 * scripts/fetch-vditor.mjs 按 DG 8 白名单裁剪产出到 vendor/vditor/，构建时随产物一起发布。
 * TODO(M0-②)：确认最终发布路径（public/ 复制 vs Tauri asset 协议），并写入 DG 8。
 */
export const VDITOR_LOCAL_CDN = "/vditor";

/**
 * DOMPurify 配置（XSS 第二层）。
 * 必须放行 svg / mathml：Mermaid 输出 SVG、KaTeX 输出 MathML + span 树。
 * TODO(M0-②)：用 test-corpus/xss-suite 全量回归，确认放行面不多不少。
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
}

export interface RenderResult {
  outline: OutlineNode[];
  frontmatter: Frontmatter | null;
  stats: DocumentStats;
  /** 解除 IntersectionObserver 等副作用；切换文档前必须调用 */
  dispose: () => void;
}

/* ── 1. frontmatter 剥离（FR-14） ───────────────────────────── */

export interface StrippedSource {
  frontmatter: Frontmatter | null;
  /** 剥离后的正文；行号偏移不修正（查找与锚点都基于渲染后 DOM） */
  body: string;
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * 剥离文档头部的 YAML frontmatter。
 * TODO(M0-②)：实测 Vditor 对 frontmatter 的默认处理（是否当正文渲染），据此确认剥离层位置；
 * 结论写入 DG 8。当前只做 `key: value` 的浅层解析，复杂结构原样转字符串。
 */
export function stripFrontmatter(source: string): StrippedSource {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    return { frontmatter: null, body: source };
  }

  const frontmatter: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: source.slice(match[0].length) };
}

/* ── 3. DOMPurify 后处理 ────────────────────────────────────── */

/**
 * 对 Vditor 产出的 DOM 再过滤一遍（红线 1：这一层永不移除）。
 * 就地替换 innerHTML，保持容器引用不变（file watch 重渲染需要原位替换）。
 */
export function purifyInPlace(container: HTMLElement): void {
  container.innerHTML = DOMPurify.sanitize(container.innerHTML, PURIFY_CONFIG);
}

/* ── 4. 大纲提取（FR-04） ──────────────────────────────────── */

/**
 * 生成大纲。官方 API 为 `Vditor.outlineRender(contentElement, targetElement)`，
 * 它把大纲 DOM 写进 targetElement；类型化的 OutlineNode 树另行从标题元素构建，
 * 因为滚动高亮与跳转都需要稳定的 heading id。
 * TODO(M0-②)：实现标题树构建 + id 去重规则，并处理无标题文档（隐藏大纲入口）。
 */
export function renderOutline(
  contentElement: HTMLElement,
  targetElement: HTMLElement,
): OutlineNode[] {
  Vditor.outlineRender(contentElement, targetElement);
  return [];
}

/* ── 5. 滚动高亮（自研，事实库 #9：官方不提供） ─────────────── */

/**
 * 监听阅读区标题进入视口，回调当前章节 id。
 * 大文件（>5MB 分段渲染）下不挂本监听，改为节流 500ms 的滚动计算（DG 8「大文件」）。
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
      root: container.closest("[data-reading-root]") ?? null,
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

/* ── 主入口 ─────────────────────────────────────────────────── */

/**
 * 执行完整渲染管线。
 * TODO(M0-②)：补全 Vditor.preview 的 after 回调时序（Mermaid/KaTeX 异步渲染完成才算就绪）、
 *             本地图片路径改写（asset 协议 vs data URL 二选一定案）、外链图片占位（红线 4）、
 *             分段渲染（FR-01）与滚动位置保持（DG 6.1 军规 1 双缓冲）。
 */
export async function renderMarkdown(options: RenderOptions): Promise<RenderResult> {
  const startedAt = performance.now();
  const { frontmatter, body } = stripFrontmatter(options.source);

  await new Promise<void>((resolve) => {
    Vditor.preview(options.container, body, {
      cdn: VDITOR_LOCAL_CDN,
      mode: options.theme,
      markdown: {
        // 红线 1：永不置 false
        sanitize: true,
        // 中文与西文之间自动加空格（DG 4.1 选型理由）
        autoSpace: true,
        toc: false,
      },
      hljs: {
        enable: true,
        style: options.theme === "dark" ? "github-dark" : "github",
        lineNumber: false,
      },
      math: {
        // 数学引擎固定 KaTeX（DG 8：MathJax 已从白名单剔除）
        engine: "KaTeX",
      },
      after: () => {
        resolve();
      },
    });
  });

  purifyInPlace(options.container);

  // TODO(M0-②)：大纲目标容器由调用方（大纲面板组件）提供，此处先返回空树
  const outline: OutlineNode[] = [];

  const disposeHighlight = observeHeadings(options.container, () => {
    // TODO(M1-outline)：回填 uiState/大纲 store 的当前章节
  });

  const stats: DocumentStats = {
    charCount: body.length,
    lineCount: body.length === 0 ? 0 : body.split("\n").length,
    encoding: options.encoding,
    renderMs: Math.round(performance.now() - startedAt),
  };

  if (options.emitPrintReadySignal === true) {
    await emitPrintReady();
  }

  return {
    outline,
    frontmatter,
    stats,
    dispose: disposeHighlight,
  };
}
