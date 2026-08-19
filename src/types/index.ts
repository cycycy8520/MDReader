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

/* ── 正文列宽（阅读区外层容器的 data-reading-width） ────────── */

/**
 * 正文列宽三态，取值 = Rust `settings::ReadingWidth` 的 kebab-case 序列化结果，
 * 也**逐字**等于 `styles/markdown.css` 里 `[data-reading-width="…"]` 的选择器取值——
 * 三处是同一串字面量，改一处必须三处同改（改错的症状是列宽整档失效而不报错）。
 *
 * `fluid`（默认）= 宽度跟随窗口；`medium` = 748px（旧版列宽）；`wide` = 1000px。
 * 具体像素只存在于 CSS，TS 与 Rust 都只搬运档位名。
 */
export type ReadingWidth = "fluid" | "medium" | "wide";

/* ── 导出（FR-07 / FR-08） ───────────────────────────────────── */

/** 单文件（图片 base64 内联）/ HTML + 资源目录（xxx_files/） */
export type ExportHtmlMode = "single-file" | "with-assets";

/** 导出 HTML 的 UI 侧状态；调用时拆成 export_html(payload, output, mode, overwrite) 四个参数 */
export interface ExportHtmlOptions {
  /** 目标 .html 路径 */
  output: string;
  mode: ExportHtmlMode;
}

/**
 * HTML 导出结果（对应 Rust `export_html::HtmlExportResult`）。
 * 继承 ExportResult 的前三个字段，其中 `route` 恒为 null（那是 PDF 的概念）。
 */
export interface HtmlExportResult extends ExportResult {
  mode: ExportHtmlMode;
  /** 资源目录绝对路径；单文件模式为 null */
  assetsDir: string | null;
  /** 成功内联 / 拷贝的图片数 */
  assetCount: number;
  /** 找不到或读不出的图片数（不阻断导出，但要如实告知用户） */
  missingCount: number;
  bytes: number;
}

/** 导出前的落点占用探测（对应 Rust `export_html::HtmlExportConflict`） */
export interface HtmlExportConflict {
  fileExists: boolean;
  assetsDirConflict: boolean;
  assetsDir: string | null;
}

/** 与 Rust `export::PdfOptions` 对应 */
export interface ExportPdfOptions {
  /** 输出文件路径 */
  output: string;
  /** 文内目录页（PrintToPdf 不产生 PDF 书签，FR-08） */
  includeToc: boolean;
}

/**
 * PDF 实际走通的路线，写进日志与 M0-① 验证报告（对应 Rust `export::PdfRoute`）。
 *
 * `cdp-webview2` 是当前的兜底 A：走 WebView2 自带的 CallDevToolsProtocolMethod 调
 * `Page.printToPDF`，零新增依赖。`cdp-edge`（驱动外部 msedge.exe）与 `edge-cli`
 * 尚未接通，保留在联合类型里是因为 Rust 的 wire 值已存在，前端不能假装它不会出现。
 */
export type PdfRoute = "print-to-pdf" | "cdp-webview2" | "cdp-edge" | "edge-cli";

/** 导出结果，用于 toast 的「打开所在文件夹」（对应 Rust `export::ExportResult`） */
export interface ExportResult {
  output: string;
  /** 仅 PDF 导出有值 */
  route: PdfRoute | null;
  elapsedMs: number;
}

/* ── Obsidian 导入（FR-09，M3） ─────────────────────────────── */

/** 对应 Rust `obsidian::Vault`。`open` = Obsidian 里当前打开的那个 */
export interface Vault {
  id: string;
  path: string;
  name: string;
  open: boolean;
}

/** 同名冲突策略；**无 serde default，必须显式传** */
export type ConflictPolicy = "rename" | "overwrite";

/** 对应 Rust `obsidian::ImportRequest` */
export interface ImportRequest {
  /** 源 .md 绝对路径 */
  source: string;
  vaultId: string;
  /** Vault 内子目录；null / 省略 = 根目录 */
  subfolder?: string | null;
  conflict: ConflictPolicy;
}

/** 对应 Rust `obsidian::ImportOutcome` */
export interface ImportOutcome {
  /** Vault 内相对路径 */
  relativePath: string;
  /** 一并复制过去的附件数（含「同名同内容而复用」的那些） */
  attachmentCount: number;
  /** obsidian:// 唤起 URI */
  uri: string;
}

/* ── 飞书凭据（FR-11 进阶通道，M3） ─────────────────────────── */

/** 只往下走，**永不从后端读回来**——状态查询只回打码后的 appId */
export interface LarkCredential {
  appId: string;
  appSecret: string;
}

/** 对应 Rust `settings::lark_credential_status`。刻意不含 appSecret / token */
export interface LarkCredentialStatus {
  configured: boolean;
  /** 打码后的 appId，未配置时为 null */
  appIdMasked: string | null;
  hasCachedToken: boolean;
}

/** 对应 Rust `share::lark` 的导入结果 */
export interface LarkImportResult {
  state: "uploading" | "importing" | "succeeded" | "failed";
  url: string | null;
  message: string | null;
}

/* ── 无 UI 动作（--action，DG 7.4） ─────────────────────────── */

/** 与 Rust `cmdline::Action` 一一对应（serde kebab-case） */
export type HeadlessAction =
  | "open"
  | "to-html"
  | "to-pdf"
  | "print"
  | "import-obsidian"
  | "share-image";

/**
 * 当前进程正在执行的无 UI 作业（对应 Rust `cmdline::HeadlessJob`）。
 * 隐藏渲染窗口挂载后调 `headlessJob()` 拿它，据此知道要渲染哪一篇。
 * 与 `takePendingOpen` 不同，本命令**不消费**，可重复问。
 */
export interface HeadlessJob {
  action: HeadlessAction;
  source: string;
  /** 产物落点；open / print / import-obsidian 无产物，为 null */
  output: string | null;
}

/**
 * 无 UI 作业完成的广播载荷（对应 Rust `cmdline::EVENT_HEADLESS_RESULT`）。
 * 只在**应用已经开着**时才有人接收——冷启动那条路做完就退出进程了。
 */
export interface HeadlessResult {
  action: HeadlessAction;
  source: string;
  output: string | null;
  ok: boolean;
  message: string | null;
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

/**
 * 窗口几何（DG 6.2「窗口记忆」），对应 Rust `settings::WindowGeometry`。
 * x/y 为 null = 尚无记录（首启）或坐标越界被判废，由 Rust 侧回落主屏居中。
 */
export interface WindowGeometry {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * 用户设置（= settings.json 全表）。
 *
 * 【契约】本接口与 Rust `settings::Settings` **逐字段对应**，wire 格式一律 camelCase
 * （Rust 侧 `#[serde(rename_all = "camelCase")]`，故 snake_case 的 font_size 序列化为 fontSize）。
 * 字段增删改必须两侧同步，否则 serde 的「忽略未知字段 + 缺省补默认」会让保存静默丢失，
 * 甚至把未发送的字段反向覆写成默认值（审计 2026-08-18 blocker）。
 * 键集合由 [`SETTINGS_KEYS`] 锁死，对拍单测见 `src/stores/settings.test.ts`。
 */
/** 左栏视图（F20 文件夹模式，DG 5.3.1）：最近列表 / 文件夹树，互斥切换（Rust: SidebarView） */
export type SidebarView = "recent" | "tree";

export interface Settings {
  theme: Theme;
  /** 正文字号档位 14–20px（DG 6.7；Rust: font_size） */
  fontSize: number;
  /** 缩放百分比 90–150（DG 5.2 状态栏；Rust: zoom_percent） */
  zoomPercent: number;
  /** 正文列宽三态（Rust: reading_width；默认 fluid = 跟随窗口宽度） */
  readingWidth: ReadingWidth;
  /** 代码折行；关闭时代码块横向滚动（DG 5.4） */
  codeWrap: boolean;
  /** frontmatter 三态显示（FR-14：卡片 / 隐藏 / 原样代码块） */
  frontmatterDisplay: FrontmatterDisplay;
  /** 大纲钉住态持久化（DG 5.2） */
  outlinePinned: boolean;
  /** 左栏宽度 264–420（DG 5.2） */
  sidebarWidth: number;
  /** 左栏折叠态（Ctrl+B） */
  sidebarCollapsed: boolean;
  /** 导出 HTML 模式（Rust: html_export_mode） */
  htmlExportMode: ExportHtmlMode;
  /** 左栏当前视图（F20；Rust: sidebar_view） */
  sidebarView: SidebarView;
  /** 已挂载的文件夹根（F20）；null = 未挂载（Rust: folder_root） */
  folderRoot: string | null;
  /** 树的展开目录集，绝对路径（F20；Rust: folder_expanded） */
  folderExpanded: string[];
  /** 最近文件夹，新→旧、上限 12（F20；Rust: recent_folders） */
  recentFolders: string[];
  window: WindowGeometry;
}

/**
 * Settings 的键全集（运行期可枚举，供契约单测与迁移逻辑使用）。
 * 用 `Record<keyof Settings, true>` 声明：漏写字段编译报错，多写字段同样报错——
 * 接口一旦增删字段，这里会立刻红，不会出现「类型改了、迁移忘了」。
 */
const SETTINGS_KEY_MAP: Record<keyof Settings, true> = {
  theme: true,
  fontSize: true,
  zoomPercent: true,
  readingWidth: true,
  codeWrap: true,
  frontmatterDisplay: true,
  outlinePinned: true,
  sidebarWidth: true,
  sidebarCollapsed: true,
  htmlExportMode: true,
  sidebarView: true,
  folderRoot: true,
  folderExpanded: true,
  recentFolders: true,
  window: true,
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_KEY_MAP) as (keyof Settings)[];

/**
 * 阅读区排版变量（1.4）：`.md-content` 的字号体系是
 * `calc(var(--md-reading-font) * var(--md-zoom))`，两个变量由 settings store
 * 计算后注入阅读容器 style（见 `stores/settings.ts` 的 `readingStyleVars`）。
 */
export interface ReadingStyleVars {
  /** 带单位的正文基准字号，如 "16px" */
  "--md-reading-font": string;
  /** 无单位的缩放系数，如 "1.25" */
  "--md-zoom": string;
}

/* ── 文件夹树（F20，DG 5.3.1） ────────────────────────────────── */

/** 树的一个子项；`name` 由后端算好（UNC/盘根的「最后一段」规则不同）。Rust: dirtree::DirChild */
export interface DirChild {
  name: string;
  /** 绝对路径 */
  path: string;
  isDir: boolean;
}

/** `list_dir_children` 回传：单层子项 + 截断标记（>2000 项）。Rust: dirtree::DirChildren */
export interface DirChildren {
  children: DirChild[];
  truncated: boolean;
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
