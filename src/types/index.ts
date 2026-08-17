/**
 * 共享类型定义。
 * 依据：DG 5.3（最近列表数据模型）、DG 7.3（存储设计）、DG 3.1（FR 清单）。
 * 与 Rust 侧 serde 结构一一对应的类型，字段名保持 camelCase（Rust 侧用 serde rename_all）。
 */

/* ── 主题（DG 5.5 / F9：首启跟随系统） ─────────────────────────── */
export type Theme = "system" | "light" | "dark";
/** 系统偏好解析后的实际主题，供渲染管线（Vditor mode / hljs 主题）取用 */
export type ResolvedTheme = "light" | "dark";

/* ── 文件与会话 ───────────────────────────────────────────────── */

/**
 * 文件实际编码（DG 8「编码」：UTF-8 优先，BOM 去除，GBK 兜底）。
 * 取值 = Rust `files::Encoding` 的 kebab-case 序列化结果，改一侧必须同步另一侧。
 */
export type FileEncoding = "utf8" | "utf8-bom" | "gbk";

/** 状态栏展示名（对应 Rust `Encoding::label()`） */
export const ENCODING_LABEL: Record<FileEncoding, string> = {
  utf8: "UTF-8",
  "utf8-bom": "UTF-8 BOM",
  gbk: "GBK",
};

/** 滚动位置记忆（FR-16：记录首个可见标题锚点 + 偏移） */
export interface ScrollAnchor {
  /** 标题元素 id；文档无标题时为空串，退化为纯偏移 */
  headingId: string;
  /** 相对该标题顶部的像素偏移 */
  offset: number;
}

/** 最近列表条目（DG 5.3 数据模型 / DG 7.3 recent.json 字段） */
export interface RecentFile {
  path: string;
  /** 首个 H1，无则文件名 */
  title: string;
  /** 打开时间，Unix 毫秒 */
  openedAt: number;
  pinned: boolean;
  scrollAnchor: ScrollAnchor | null;
}

/**
 * 一次「打开文件」的完整回传载荷。
 * 字段与 Rust `files::DocumentPayload` 逐一对应（camelCase 序列化）。
 */
export interface DocumentPayload {
  path: string;
  /** 首个 H1，无则文件名（DG 5.3） */
  title: string;
  /** 已解码、已去 BOM 的 Markdown 原文（frontmatter 剥离在前端渲染层做，FR-14） */
  content: string;
  encoding: FileEncoding;
  /** 字节数，用于 FR-01 渲染分档 */
  byteSize: number;
  lineCount: number;
  /** 超过大文件阈值：前端走分段渲染 + 顶部提示条（FR-01） */
  isLarge: boolean;
}

/** 状态栏统计（DG 5.2 状态栏） */
export interface DocumentStats {
  charCount: number;
  lineCount: number;
  encoding: FileEncoding;
  /** 渲染耗时（毫秒），仅开发模式显示 */
  renderMs?: number;
}

/* ── 大纲（FR-04） ───────────────────────────────────────────── */

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface OutlineNode {
  /** 与阅读区标题元素 id 一致，用于锚点跳转与滚动高亮 */
  id: string;
  level: HeadingLevel;
  text: string;
  children: OutlineNode[];
}

/** 大纲两态 + 收起（DG 5.2 大纲面板） */
export type OutlineMode = "hidden" | "floating" | "pinned";

/* ── frontmatter（FR-14：折叠为「属性」卡片） ────────────────── */

/** 键值对形式的属性表；复杂值序列化为字符串展示，不做 YAML 语义还原 */
export type Frontmatter = Record<string, string>;

/** 元数据显示模式（设置项「显示元数据」） */
export type FrontmatterDisplay = "card" | "hidden" | "raw";

/* ── 导出（FR-07 / FR-08） ───────────────────────────────────── */

/** 单文件（图片 base64 内联）/ HTML + 资源目录（xxx_files/） */
export type ExportHtmlMode = "single-file" | "with-assets";

/** 导出 HTML 的 UI 侧状态；调用时拆成 export_html(source, output, mode) 三个参数 */
export interface ExportHtmlOptions {
  /** 目标 .html 路径 */
  output: string;
  mode: ExportHtmlMode;
}

/** 与 Rust `export::PdfOptions` 对应 */
export interface ExportPdfOptions {
  /** 输出文件路径 */
  output: string;
  /** 文内目录页（PrintToPdf 不产生 PDF 书签，FR-08） */
  includeToc: boolean;
}

/** PDF 实际走通的路线，写进日志与 M0-① 验证报告（对应 Rust `export::PdfRoute`） */
export type PdfRoute = "print-to-pdf" | "cdp-edge" | "edge-cli";

/** 导出结果，用于 toast 的「打开所在文件夹」（对应 Rust `export::ExportResult`） */
export interface ExportResult {
  output: string;
  /** 仅 PDF 导出有值 */
  route: PdfRoute | null;
  elapsedMs: number;
}

/* ── 默认程序检测（F2 首启引导） ─────────────────────────────── */

/** 对应 Rust `shell_integ::DefaultAppStatus`（红线 2：UserChoice 只读） */
export interface DefaultAppStatus {
  /** UserChoice 中记录的 ProgID，读不到为 null */
  currentProgid: string | null;
  /** 当前默认程序是否已是本应用 */
  isSelf: boolean;
}

/* ── 设置（DG 7.3 settings.json） ───────────────────────────── */

export interface Settings {
  theme: Theme;
  /** 正文字号档位 14–20px（DG 6.7） */
  readingFontSize: number;
  /** 缩放 90–150（DG 5.2 状态栏） */
  zoom: number;
  /** 代码折行；关闭时代码块横向滚动（DG 5.4） */
  codeWrap: boolean;
  frontmatterDisplay: FrontmatterDisplay;
  /** 大纲钉住态持久化（DG 5.2） */
  outlinePinned: boolean;
  exportHtmlMode: ExportHtmlMode;
}

/* ── 状态反馈（DG 6.6） ─────────────────────────────────────── */

export type ToastKind = "info" | "success" | "warn" | "danger";

export interface ToastAction {
  labelKey: string;
  actionId: string;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  actions?: ToastAction[];
}
