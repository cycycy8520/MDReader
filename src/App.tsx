/**
 * 应用外壳 + M1 主链路接线 —— 视觉规格来自对参考项目（DeepSeek Harness 客户端）设计系统的实测提取，
 * 数值一律走 src/styles/tokens.css 的两层 Token，本文件只写语义类名。
 *
 * 关键数值（与 tailwind.config.js 的 Token 映射一一对应）：
 *   顶栏 40px / 状态栏 26px / 左栏 280px / 大纲栏 300px / 阅读列宽 748px
 *   行高 32px（文件条目）、34px（分组标题）、输入框 32px、主按钮 36px、图标钮 28px
 *   圆角 6/8/12/18/24；字号 14-22、13-20、12-18（UI）与 22-32（Hero 标题）
 *   左栏外壳内边距 12px/6px；阅读区 32px/16px；列表底部渐隐 24px
 *
 * 交互纪律（违反就"不像"）：
 *   1. hover / 选中背景**不加 transition**，瞬时切换；过渡只给 opacity、transform、布局尺寸
 *   2. 交互反馈只换背景色：无 scale、无位移、无阴影抬升、无 ring-offset
 *   3. 列表选中态 = hover 同一枚半透明底色 + 8px 圆角整块高亮，无竖条、无边框、不加粗
 *   4. 主按钮是近黑/近白（brand），蓝色（accent）只留给链接 / 焦点环 / 进度
 *   5. 图标恒比同行文字淡一档（文字 primary → 图标 tertiary，hover 才升一档）
 *   6. 输入框聚焦只把描边换成 border-brand，无外发光
 *   7. 空状态就是一行 13/20 的 tertiary 文字，不画插画、不做骨架屏
 *   9. 图标只有 16/14/12 三档，stroke-width 1.5，颜色一律 currentColor
 *
 * M1 接线：
 *   打开（对话框 / 双击关联 / 拖拽 / 最近列表）→ fileSession.openPath → ipc.readMarkdown
 *   → renderMarkdown 渲染进阅读区 → 回填大纲与统计 → recentFiles 计入最近列表
 *   → ipc.watchFile 监听外部变更（重渲染并保持滚动位置 + 顶栏 ● 闪一次）
 *
 * 批次 1「驯服 WebView、接通断线」本文件负责的部分（UPGRADE_PLAN 1.1/1.4/1.6/1.7/1.8）：
 *   1.1 阅读区 click/auxclick 委托：外链交系统浏览器、相对 .md 应用内打开、#锚点走平滑跳转，
 *       其余协议一律拦下——WebView 永远不会被导航走；
 *   1.4 字号/缩放以 CSS 变量注入阅读容器（Ctrl+滚轮 / Ctrl+= / Ctrl+- / Ctrl+0），codeWrap 走 data 属性；
 *   1.6 未实现按钮一律 disabled（tooltip 说明"开发中"），状态栏缩放与主题两个按钮真正接线；
 *   1.7 阅读区可聚焦 + 打开后自动聚焦（键盘翻页生效）、Esc 语义链、点击已打开文件不重开；
 *   1.8 file-removed 警示条、失效条目的出路、拖入不支持类型的 danger 反馈、工具条文字不可选中。
 *
 * 阅读区唯一允许的滚动动画是大纲跳转的 250ms 平滑滚动（军规 1）；
 * 加载态一律是一行淡字 + 10px 微 spinner，**不做骨架屏**（DG 6.6）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import { t } from "./i18n/zh-CN";
import { renderMarkdown, resolveLocalPath } from "./render/preview";
import {
  onDragDrop,
  onFileChanged,
  onFileRemoved,
  onOpenPath,
  takePendingOpen,
  onWindowResized,
  openExternal,
  openFileDialog,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleMaximize,
} from "./services/ipc";
import {
  describeError,
  useFileSessionStore,
  type SessionErrorKind,
  type SessionPhase,
} from "./stores/fileSession";
import { useRecentFilesStore } from "./stores/recentFiles";
import {
  readingStyleVars,
  useSettingsStore,
  ZOOM_PRESETS,
  ZOOM_STEP,
} from "./stores/settings";
import { useUiStateStore } from "./stores/uiState";
import {
  ENCODING_LABEL,
  type OutlineNode,
  type RecentFile,
  type Theme,
} from "./types";

/* ── 常量（技术值，不是文案） ─────────────────────────────────── */

/** 与 tauri.conf.json 的 bundle.fileAssociations.ext / Rust SUPPORTED_EXTENSIONS 保持一致 */
const SUPPORTED_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "mkdn"] as const;

/** 大纲跳转的滚动时长：阅读区唯一允许的滚动动画（军规 1 / DG 6.3） */
const OUTLINE_SCROLL_MS = 250;
/** 跳转落点距容器顶部的留白 */
const HEADING_JUMP_PADDING = 16;
/** 跳转动画期间抑制滚动高亮回填的时长，避免高亮沿途逐个点亮 */
const ACTIVE_SYNC_SUPPRESS_MS = 320;
/** ● 刷新指示点存活时长（DG 6.4-7：闪一次即隐，不弹 toast） */
const REFRESH_FLASH_MS = 600;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ── 警示条 ──────────────────────────────────────────────────── */

/** 提示型警示条（拖入不支持类型等）的自动撤条时长；错误型不自动撤 */
const NOTICE_AUTO_DISMISS_MS = 4000;

/* ── 链接判定（1.1 点击委托） ───────────────────────────────── */

/** 交系统浏览器的外链 */
const EXTERNAL_HREF_RE = /^https?:\/\//i;
/** 盘符绝对路径 / UNC：不再以当前文档目录为基准解析 */
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/* ── 纯函数工具 ─────────────────────────────────────────────── */

function isSupportedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

/** 状态栏 zoom% 点击循环：取比当前值大的第一档，越界回到最小档（档位表在 settings store） */
function nextZoomPreset(current: number): number {
  return ZOOM_PRESETS.find((step) => step > current) ?? ZOOM_PRESETS[0];
}

/** URI 解码兜底：中文/空格链接必然是编码过的，畸形序列时原样返回 */
function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 拆出 href 的路径部分与 fragment（不含 #），查询串一并丢弃 */
function splitHash(href: string): { readonly path: string; readonly hash: string } {
  const hashIndex = href.indexOf("#");
  const withoutHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const hash = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";
  const queryIndex = withoutHash.indexOf("?");
  return {
    path: queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash,
    hash,
  };
}

/** Windows 路径包含判定：分隔符与大小写都不敏感（复用 samePath 的口径） */
function includesPath(list: readonly string[], path: string): boolean {
  return list.some((item) => samePath(item, path));
}

/** 取所在目录，作为本地图片相对路径基准；根路径或无分隔符时返回 null */
function dirNameOf(path: string): string | null {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : null;
}

/** 取文件名（含扩展名）；读取完成前顶栏先用它顶着，避免闪一下「未打开文件」 */
function baseNameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index >= 0 ? path.slice(index + 1) : path;
}

/**
 * Windows 路径比较：分隔符与大小写都不敏感。
 * 后端 watch 事件回传的路径与 readMarkdown 回传的路径可能来自不同拼接方式，
 * 直接 === 比较会漏判，导致外部修改后不刷新。
 */
function samePath(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase()
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function startOfToday(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 今天显示 HH:MM，更早显示 MM-DD（12px 小字，超过一年也不显示年份，宁可省） */
function formatStamp(openedAt: number, todayStart: number): string {
  const date = new Date(openedAt);
  if (openedAt >= todayStart) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

type RecentGroupId = "pinned" | "today" | "yesterday" | "week" | "earlier";

const GROUP_ORDER: readonly RecentGroupId[] = [
  "pinned",
  "today",
  "yesterday",
  "week",
  "earlier",
];

const GROUP_LABEL: Record<RecentGroupId, string> = {
  pinned: t.sidebar.groupPinned,
  today: t.sidebar.groupToday,
  yesterday: t.sidebar.groupYesterday,
  week: t.sidebar.groupWeek,
  earlier: t.sidebar.groupEarlier,
};

function groupIdOf(file: RecentFile, todayStart: number): RecentGroupId {
  if (file.pinned) {
    return "pinned";
  }
  if (file.openedAt >= todayStart) {
    return "today";
  }
  if (file.openedAt >= todayStart - DAY_MS) {
    return "yesterday";
  }
  if (file.openedAt >= todayStart - 6 * DAY_MS) {
    return "week";
  }
  return "earlier";
}

interface RecentEntryView {
  readonly file: RecentFile;
  readonly stamp: string;
}

interface RecentGroupView {
  readonly id: RecentGroupId;
  readonly label: string;
  readonly entries: readonly RecentEntryView[];
}

/**
 * 分组：置顶 / 今天 / 昨天 / 近 7 天 / 更早。
 * 组内顺序沿用 store 的排序（置顶优先 + openedAt 倒序），此处不再排。
 */
function buildRecentGroups(
  items: readonly RecentFile[],
  filter: string,
): RecentGroupView[] {
  const keyword = filter.trim().toLowerCase();
  const todayStart = startOfToday();
  const buckets = new Map<RecentGroupId, RecentEntryView[]>();

  for (const file of items) {
    if (
      keyword.length > 0 &&
      !file.title.toLowerCase().includes(keyword) &&
      !file.path.toLowerCase().includes(keyword)
    ) {
      continue;
    }
    const id = groupIdOf(file, todayStart);
    const entry: RecentEntryView = {
      file,
      stamp: formatStamp(file.openedAt, todayStart),
    };
    const bucket = buckets.get(id);
    if (bucket) {
      bucket.push(entry);
    } else {
      buckets.set(id, [entry]);
    }
  }

  const groups: RecentGroupView[] = [];
  for (const id of GROUP_ORDER) {
    const entries = buckets.get(id);
    if (entries && entries.length > 0) {
      groups.push({ id, label: GROUP_LABEL[id], entries });
    }
  }
  return groups;
}

/**
 * 标题文本 → slug。既用于「渲染层没给 id 时兜底生成」，也用于
 * 1.1 锚点跳转 id 未命中时的模糊回退（手写 `#中文标题` 与实际 id 常常差一层编码）。
 */
function slugOf(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[\s]+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "") || "heading"
  );
}

/** 标题文本 → 锚点 id（仅在渲染层没给 id 时兜底），同名自动加序号 */
function toHeadingId(text: string, used: Set<string>): string {
  const base = slugOf(text);
  let id = base;
  let index = 2;
  while (used.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  used.add(id);
  return id;
}

/**
 * 从已渲染的 DOM 兜底提取大纲树。
 * 正常路径是 renderMarkdown 直接回传 outline；当渲染层尚未产出（返回空树）时用这条，
 * 保证「打开 → 大纲可用」这一链路不因渲染层的实现进度而断掉。
 */
function buildOutlineFromDom(container: HTMLElement): OutlineNode[] {
  const headings = Array.from(
    container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
  );
  const used = new Set<string>();
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const element of headings) {
    const parsed = Number.parseInt(element.tagName.slice(1), 10);
    const level = (Number.isNaN(parsed) ? 1 : parsed) as OutlineNode["level"];
    const text = (element.textContent ?? "").trim();
    if (element.id === "") {
      element.id = toHeadingId(text, used);
    } else {
      used.add(element.id);
    }

    const node: OutlineNode = { id: element.id, level, text, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
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
 * 渲染后处理：把「不属于正文」的浮层文字挡在文本选择之外。
 *
 * 代码块工具条（语言标签 + 复制钮）与外链图片占位块都是渲染层注入的 UI，
 * 拖选正文时会被一起选中，粘贴出来混着「python 复制」（审计 minor）。
 * 正统做法是渲染层建这些节点时就带 select-none，这里做的是幂等的兜底加固：
 * `[data-reading-root] *` 在 base 层强制 user-select:text，utilities 层的 select-none 覆盖得掉。
 */
function hardenToolbarSelection(container: HTMLElement): void {
  const toolbars = container.querySelectorAll<HTMLElement>(
    "[data-code-block] > div, [data-external-image]",
  );
  for (const toolbar of Array.from(toolbars)) {
    toolbar.classList.add("select-none");
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 250ms 平滑滚动（自研而非 scroll-behavior：时长必须可控且可被降级动效关掉） */
function smoothScrollTo(scroller: HTMLElement, top: number): void {
  const start = scroller.scrollTop;
  const distance = top - start;
  if (prefersReducedMotion() || Math.abs(distance) < 2) {
    scroller.scrollTop = top;
    return;
  }
  const startedAt = performance.now();
  const step = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / OUTLINE_SCROLL_MS);
    // 与 --md-ease（cubic-bezier(.4,0,.2,1)）同族的 ease-in-out 近似
    const eased =
      progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    scroller.scrollTop = start + distance * eased;
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

/* ── 图标：内联手绘，不引依赖。三档尺寸 16/14/12，描边 1.5，色用 currentColor ── */

type IconSize = 12 | 14 | 16;

interface IconProps {
  readonly size?: IconSize;
  readonly className?: string;
}

function Glyph({
  size = 16,
  className,
  children,
}: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  );
}

/** 折叠 / 展开左栏：面板轮廓 + 分栏线，比汉堡更贴合语义 */
function IconPanelLeft(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </Glyph>
  );
}

function IconSearch(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Glyph>
  );
}

/** 打开文件：敞口文件夹，与「导出」的上箭头区分开 */
function IconFolderOpen(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 18.5V6.5A1.5 1.5 0 0 1 5.5 5h3.6l2 2.5H18a1.5 1.5 0 0 1 1.5 1.5v1.5" />
      <path d="M4 18.5 6.3 12.4A1.5 1.5 0 0 1 7.7 11.5H21l-2.3 6.1a1.5 1.5 0 0 1-1.4 1H4Z" />
    </Glyph>
  );
}

function IconOutline(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 6h16M7 12h13M10 18h10" />
      <path d="M4 12h.01M7 18h.01" />
    </Glyph>
  );
}

function IconExport(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 15V4m0 0-3.5 3.5M12 4l3.5 3.5" />
      <path d="M4.5 15v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
    </Glyph>
  );
}

function IconShare(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3" />
    </Glyph>
  );
}

/** 三角箭头：默认指右（收起），展开时由调用方 rotate-90 指下 */
function IconChevron(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m9.5 5 7 7-7 7" />
    </Glyph>
  );
}

function IconFile(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
      <path d="M13.5 3v5.5H19" />
    </Glyph>
  );
}

function IconClose(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Glyph>
  );
}

function IconMinimize(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 12h14" />
    </Glyph>
  );
}

function IconMaximize(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
    </Glyph>
  );
}

function IconRestore(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="7.5" y="7.5" width="11" height="11" rx="1.5" />
      <path d="M5.5 16V6.5A1.5 1.5 0 0 1 7 5h9" />
    </Glyph>
  );
}

function IconMoon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20 14.3A8.5 8.5 0 0 1 9.7 4a8.5 8.5 0 1 0 10.3 10.3Z" />
    </Glyph>
  );
}

/** 浅色态：短射线的太阳，12px 下不糊 */
function IconSun(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </Glyph>
  );
}

/** 跟随系统：显示器轮廓（与浅/深两态形成三态区分） */
function IconMonitor(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20.5h6M12 16.5v4" />
    </Glyph>
  );
}

/** 警示条图标：三角感叹号，色由调用方给（danger / warn） */
function IconAlert(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 4.5 21 19.5H3L12 4.5Z" />
      <path d="M12 10v4.2M12 17h.01" />
    </Glyph>
  );
}

/* ── 通用小件 ───────────────────────────────────────────────── */

interface IconButtonProps {
  readonly label: string;
  readonly children: ReactNode;
  /** 未实现的功能不传，按钮保持无行为（不写 alert 之类占位） */
  readonly onClick?: () => void;
  readonly active?: boolean;
  /** 功能尚未落地：opacity-40 + cursor-default + tooltip「开发中」，且不触发 onClick */
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * 幽灵图标钮 28px 圆形：反馈只有背景色，且不加 transition（铁律 1 / 2）。
 * 图标常态 tertiary，hover 升一档到 secondary（铁律 5）。
 *
 * 禁用态用 aria-disabled 而非原生 disabled：原生禁用元素在 Chromium 下不接收鼠标事件，
 * 连 title 提示都弹不出来——而「点了才知道没做」正是这次要消灭的体验（DG 6.4 全局条 B）。
 */
function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = "",
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled ? `${label}${t.common.comingSoonSuffix}` : label}
      aria-disabled={disabled ? true : undefined}
      aria-pressed={!disabled && onClick ? active : undefined}
      onClick={disabled ? undefined : onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
        disabled
          ? "cursor-default text-tertiary opacity-40"
          : `hover:bg-hover hover:text-secondary ${
              active ? "bg-hover text-secondary" : "text-tertiary"
            }`
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** 加载态：一行淡字 + 10px 微 spinner（DG 6.6：全局不做骨架屏） */
function LoadingLine({ label }: { readonly label: string }) {
  return (
    <p className="flex items-center gap-2 py-1 text-ui-sm text-tertiary animate-fade-in">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 animate-spin-micro rounded-full border-[1.5px] border-l4 border-t-transparent"
      />
      {label}
    </p>
  );
}

/* ── 顶栏 ───────────────────────────────────────────────────── */

/** 窗口三键：宽 44px、满高；关闭键 hover 为 danger 实底 + 白字 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void windowIsMaximized().then(setMaximized);
    void onWindowResized(setMaximized).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const base =
    "flex h-topbar w-11 shrink-0 items-center justify-center text-tertiary";

  return (
    <div className="flex items-center">
      <button
        type="button"
        aria-label={t.window.minimize}
        title={t.window.minimize}
        onClick={() => void windowMinimize()}
        className={`${base} hover:bg-hover hover:text-primary`}
      >
        <IconMinimize />
      </button>
      <button
        type="button"
        aria-label={maximized ? t.window.restore : t.window.maximize}
        title={maximized ? t.window.restore : t.window.maximize}
        onClick={() => void windowToggleMaximize()}
        className={`${base} hover:bg-hover hover:text-primary`}
      >
        {maximized ? <IconRestore /> : <IconMaximize />}
      </button>
      <button
        type="button"
        aria-label={t.window.close}
        title={t.window.close}
        onClick={() => void windowClose()}
        className={`${base} hover:bg-danger hover:text-white`}
      >
        <IconClose />
      </button>
    </div>
  );
}

interface TopBarProps {
  readonly title: string;
  readonly path: string | null;
  /** file watch 刷新后的 ● 指示（DG 6.4-7） */
  readonly refreshed: boolean;
  readonly outlineOpen: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleOutline: () => void;
  readonly onOpenFile: () => void;
}

/**
 * 顶栏 40px：整条为拖动区（data-tauri-drag-region 不作用于子元素，按钮天然可点）。
 * 底部分隔线用 ::after 画而非 border-b —— 后续加 tab 激活条时两者不会打架。
 */
function TopBar({
  title,
  path,
  refreshed,
  outlineOpen,
  onToggleSidebar,
  onToggleOutline,
  onOpenFile,
}: TopBarProps) {
  const hasDocument = path !== null;

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-topbar shrink-0 items-center bg-panel pl-1.5 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[var(--md-border-l2)] after:content-['']"
    >
      <div data-tauri-drag-region className="flex shrink-0 items-center gap-2">
        <IconButton label={t.topbar.toggleSidebar} onClick={onToggleSidebar}>
          <IconPanelLeft />
        </IconButton>
        <span
          data-tauri-drag-region
          className="text-ui font-medium text-primary"
        >
          {t.app.name}
        </span>
      </div>

      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-4"
      >
        {refreshed ? (
          <span
            aria-label={t.topbar.refreshed}
            title={t.topbar.refreshed}
            className="shrink-0 text-ui-xs text-tertiary animate-fade-in"
          >
            {t.topbar.refreshMark}
          </span>
        ) : null}
        <span
          data-tauri-drag-region
          title={path ?? undefined}
          className={`truncate text-ui-sm ${
            hasDocument ? "text-secondary" : "text-tertiary"
          }`}
        >
          {title}
        </span>
      </div>

      <nav className="flex shrink-0 items-center gap-0.5 pr-1.5">
        <IconButton label={t.topbar.open} onClick={onOpenFile}>
          <IconFolderOpen />
        </IconButton>
        {/* 查找在批次 3 点亮，导出/分享在 M2；未实现一律 disabled，不写占位 onClick。
            「更多」菜单在批次 3 的右键菜单一并落地，无内容期间直接不画。 */}
        <IconButton label={t.topbar.find} disabled>
          <IconSearch />
        </IconButton>
        <IconButton
          label={t.topbar.outline}
          onClick={onToggleOutline}
          active={outlineOpen}
        >
          <IconOutline />
        </IconButton>
        <IconButton label={t.topbar.export} disabled>
          <IconExport />
        </IconButton>
        <IconButton label={t.topbar.share} disabled>
          <IconShare />
        </IconButton>
      </nav>

      <WindowControls />
    </header>
  );
}

/* ── 警示条（DG 6.4-13：顶栏下方 slide-down，非模态、不遮内容） ── */

interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

interface Notice {
  /** danger = 出事了（文件没了）；warn = 操作没生效（拖入不支持类型） */
  readonly kind: "danger" | "warn";
  readonly message: string;
  readonly action: NoticeAction | null;
  /** 提示型自动撤条；错误型必须由用户处理或由 file-changed 自动撤 */
  readonly autoDismiss: boolean;
}

interface NoticeBarProps {
  readonly notice: Notice;
  /** 挂载后下一帧翻 true，触发 160ms 的 transform+opacity 展开 */
  readonly shown: boolean;
  readonly onDismiss: () => void;
}

function NoticeBar({ notice, shown, onDismiss }: NoticeBarProps) {
  const tone = notice.kind === "danger" ? "text-danger" : "text-warn";

  return (
    <div
      role="status"
      className={`flex h-row-group shrink-0 items-center gap-2 border-b border-l2 bg-panel px-3 transition-[opacity,transform] duration-base ease-standard ${
        shown ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
      }`}
    >
      <IconAlert size={14} className={`shrink-0 ${tone}`} />
      <span className={`min-w-0 flex-1 truncate text-ui-sm ${tone}`}>
        {notice.message}
      </span>
      {notice.action === null ? null : (
        <button
          type="button"
          onClick={notice.action.run}
          className="flex h-6 shrink-0 items-center rounded-row px-2 text-ui-sm text-primary hover:bg-hover-danger"
        >
          {notice.action.label}
        </button>
      )}
      <IconButton label={t.common.close} onClick={onDismiss}>
        <IconClose size={12} />
      </IconButton>
    </div>
  );
}

/* ── 左栏 ───────────────────────────────────────────────────── */

interface SidebarSearchProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** 搜索框：聚焦只把描边换成墨色，不加 ring、不加发光（铁律 6） */
function SidebarSearch({ value, onChange }: SidebarSearchProps) {
  return (
    <div className="flex h-input shrink-0 items-center gap-1.5 rounded-row border bg-card px-2.5 focus-within:border-brand">
      <IconSearch size={14} className="shrink-0 text-tertiary" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t.sidebar.searchPlaceholder}
        // Esc 语义链要区分「焦点在过滤框」与「焦点在别处」，用属性标记而非 id 选择器
        data-sidebar-filter="true"
        className="min-w-0 flex-1 border-none bg-transparent text-ui text-primary outline-none placeholder:text-caption"
      />
    </div>
  );
}

interface RecentRowProps {
  readonly entry: RecentEntryView;
  readonly selected: boolean;
  /** 路径失效：整行 opacity-40，不换色（DG 6.4 全局条 B） */
  readonly missing: boolean;
  readonly onOpen: (path: string) => void;
}

/**
 * 文件条目 32px：选中态与 hover 共用同一枚半透明底 + 8px 圆角整块高亮，
 * 没有左侧竖条、没有边框、字重不变（铁律 3）。
 */
function RecentRow({ entry, selected, missing, onOpen }: RecentRowProps) {
  const { file } = entry;
  return (
    <button
      type="button"
      title={file.path}
      aria-current={selected ? "true" : undefined}
      onClick={() => onOpen(file.path)}
      className={`flex h-row w-full items-center gap-1.5 rounded-row px-2 text-left hover:bg-hover ${
        selected ? "bg-hover" : ""
      } ${missing ? "opacity-40" : ""}`}
    >
      <IconFile size={14} className="shrink-0 text-tertiary" />
      <span className="min-w-0 flex-1 truncate text-ui text-primary">
        {file.title}
      </span>
      <span className="shrink-0 text-ui-xs text-tertiary">{entry.stamp}</span>
    </button>
  );
}

interface RecentGroupBlockProps {
  readonly group: RecentGroupView;
  readonly currentPath: string | null;
  readonly missingPaths: readonly string[];
  readonly onOpen: (path: string) => void;
}

function RecentGroupBlock({
  group,
  currentPath,
  missingPaths,
  onOpen,
}: RecentGroupBlockProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <section className="mt-1 first:mt-0">
      <button
        type="button"
        aria-expanded={expanded}
        title={expanded ? t.sidebar.collapseGroup : t.sidebar.expandGroup}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-row-group w-full items-center gap-1 rounded-row px-2 text-left hover:bg-hover"
      >
        <IconChevron
          size={12}
          className={`shrink-0 text-tertiary transition-transform duration-150 ease-standard ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="truncate text-ui text-tertiary">{group.label}</span>
      </button>

      {expanded ? (
        <div className="space-y-0.5">
          {group.entries.map((entry) => (
            <RecentRow
              key={entry.file.path}
              entry={entry}
              selected={samePath(entry.file.path, currentPath)}
              missing={includesPath(missingPaths, entry.file.path)}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface SidebarProps {
  readonly groups: readonly RecentGroupView[];
  readonly filtering: boolean;
  readonly filter: string;
  readonly currentPath: string | null;
  readonly missingPaths: readonly string[];
  readonly onFilterChange: (value: string) => void;
  readonly onOpen: (path: string) => void;
  readonly onOpenFile: () => void;
}

function Sidebar({
  groups,
  filtering,
  filter,
  currentPath,
  missingPaths,
  onFilterChange,
  onOpen,
  onOpenFile,
}: SidebarProps) {
  return (
    <aside className="flex w-sidebar shrink-0 flex-col border-r border-l1 bg-panel px-3 py-1.5">
      <SidebarSearch value={filter} onChange={onFilterChange} />

      <div className="relative mt-1.5 flex min-h-0 flex-1 flex-col">
        <div className="quiet-bars min-h-0 flex-1 overflow-y-auto pb-4 [scrollbar-gutter:stable]">
          {groups.length === 0 ? (
            <div className="px-2 py-4">
              <p className="text-ui-sm text-tertiary">
                {filtering ? t.sidebar.emptyFiltered : t.sidebar.empty}
              </p>
              {filtering ? null : (
                <button
                  type="button"
                  onClick={onOpenFile}
                  className="mt-2 flex h-row items-center rounded-row px-2 text-ui text-primary hover:bg-hover"
                >
                  {t.common.open}
                </button>
              )}
            </div>
          ) : (
            groups.map((group) => (
              <RecentGroupBlock
                key={group.id}
                group={group}
                currentPath={currentPath}
                missingPaths={missingPaths}
                onOpen={onOpen}
              />
            ))
          )}
        </div>

        {/* 列表底部渐隐：让滚动内容淡出而不是被硬切 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent to-panel"
        />
      </div>
    </aside>
  );
}

/* ── 阅读区 ─────────────────────────────────────────────────── */

/** 无文档：Hero 式空状态（不是灰块、不是骨架屏） */
function ReadingHero({ onOpenFile }: { readonly onOpenFile: () => void }) {
  return (
    <div className="mx-auto flex min-h-full max-w-reading flex-col items-center justify-center px-8 pb-[12vh] pt-4 text-center animate-fade-in">
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-card bg-brand text-inverted"
      >
        <span className="text-ui font-semibold">{t.app.mark}</span>
      </div>

      <h1 className="mt-4 text-h2 font-semibold text-primary">
        {t.reading.emptyTitle}
      </h1>
      <p className="mt-1.5 text-ui text-tertiary">{t.reading.emptyHint}</p>

      <button
        type="button"
        onClick={onOpenFile}
        className="mt-5 flex h-btn items-center rounded-btn bg-brand px-3.5 text-ui font-medium text-inverted hover:bg-brand-hover"
      >
        {t.common.open}
      </button>
    </div>
  );
}

interface ReadingErrorProps {
  readonly kind: SessionErrorKind;
  readonly path: string | null;
  readonly message: string | null;
  readonly onRetry: () => void;
  readonly onOpenFile: () => void;
}

/** 出错不留白屏：一行标题 + 路径 + 日志级细节 + 两个文字按钮 */
function ReadingError({
  kind,
  path,
  message,
  onRetry,
  onOpenFile,
}: ReadingErrorProps) {
  const title =
    kind === "missing"
      ? t.reading.fileMissing
      : kind === "render"
        ? t.reading.renderFailed
        : t.reading.readFailed;

  return (
    <div className="mx-auto max-w-reading px-8 py-8 animate-fade-in">
      <p className="text-ui font-medium text-danger">{title}</p>
      {path === null ? null : (
        <p className="mt-1.5 break-all text-ui-sm text-tertiary">{path}</p>
      )}
      {message === null ? null : (
        <p className="mt-1 break-all text-ui-xs text-caption">{message}</p>
      )}
      <div className="mt-4 flex items-center gap-1">
        <button
          type="button"
          onClick={onRetry}
          className="flex h-row items-center rounded-row px-2 text-ui text-primary hover:bg-hover"
        >
          {t.common.retry}
        </button>
        <button
          type="button"
          onClick={onOpenFile}
          className="flex h-row items-center rounded-row px-2 text-ui text-primary hover:bg-hover"
        >
          {t.common.open}
        </button>
      </div>
    </div>
  );
}

interface ReadingAreaProps {
  readonly phase: SessionPhase;
  readonly errorKind: SessionErrorKind | null;
  readonly errorMessage: string | null;
  readonly path: string | null;
  readonly scrollerRef: RefObject<HTMLElement>;
  readonly contentRef: RefObject<HTMLDivElement>;
  /** 正文字号档位 14–20px（settings.fontSize） */
  readonly fontSize: number;
  /** 缩放百分比 90–150（settings.zoomPercent） */
  readonly zoomPercent: number;
  readonly codeWrap: boolean;
  readonly onOpenFile: () => void;
  readonly onRetry: () => void;
}

function ReadingArea({
  phase,
  errorKind,
  errorMessage,
  path,
  scrollerRef,
  contentRef,
  fontSize,
  zoomPercent,
  codeWrap,
  onOpenFile,
  onRetry,
}: ReadingAreaProps) {
  const busy = phase === "loading" || phase === "rendering";

  /**
   * 字号与缩放以 CSS 变量注入，样式层用 calc(var(--md-reading-font) * var(--md-zoom))
   * 消费（styles/markdown.css）。只作用于阅读容器，顶栏/状态栏不受影响。
   * 变量的钳位与格式化在 settings store 的 readingStyleVars 里（唯一事实来源）。
   */
  const readingVars = useMemo(
    () => readingStyleVars(fontSize, zoomPercent) as CSSProperties,
    [fontSize, zoomPercent],
  );
  const codeWrapAttr = codeWrap ? "on" : "off";

  return (
    <main
      ref={scrollerRef}
      data-reading-root
      // 键盘翻页（PgDn/PgUp/Space/Home/End）作用于焦点所在的滚动容器：
      // 没有 tabIndex 就永远拿不到焦点，按键落到 body 上什么也不滚（审计 major）
      tabIndex={-1}
      className="quiet-bars min-w-0 flex-1 overflow-y-auto bg-canvas"
    >
      {phase === "empty" ? <ReadingHero onOpenFile={onOpenFile} /> : null}

      {phase === "error" ? (
        <ReadingError
          kind={errorKind ?? "read"}
          path={path}
          message={errorMessage}
          onRetry={onRetry}
          onOpenFile={onOpenFile}
        />
      ) : null}

      {/* 渲染容器常驻（error / empty 时不挂载），切换文档时由渲染层原位替换内容。
          列宽三态 data-reading-width="fluid|medium|wide"（CSS 在 styles/markdown.css）：
          默认 fluid = 内容宽度跟随窗口（MPE 行为），padding 32px / 窄窗 16px 也由那里接管；
          切换 UI 属后续设置页，本次只保证容器属性与 CSS 就位。 */}
      <div
        data-reading-width="fluid"
        data-code-wrap={codeWrapAttr}
        style={readingVars}
        className={phase === "empty" || phase === "error" ? "hidden" : ""}
      >
        {busy ? (
          <LoadingLine
            label={
              phase === "rendering" ? t.reading.rendering : t.reading.opening
            }
          />
        ) : null}
        {/* markdown-body：github-markdown-css 排版基底（MPE 同源观感）；
            md-content：本项目增量与变量桥的作用域，样式在 styles/markdown.css。
            变量与 data-code-wrap 在外层与本层各挂一份：外层保证「非正文的阅读区元素」
            也能取到变量，本层保证样式层无论按哪一级选择器写都命中。 */}
        <div
          ref={contentRef}
          data-code-wrap={codeWrapAttr}
          style={readingVars}
          className="markdown-body md-content"
        />
      </div>
    </main>
  );
}

/* ── 大纲栏 ─────────────────────────────────────────────────── */

/** 层级缩进用静态类查表，避免内联像素值绕过 Token 层 */
const OUTLINE_INDENT: readonly string[] = [
  "pl-2",
  "pl-5",
  "pl-8",
  "pl-11",
  "pl-14",
  "pl-16",
];

interface OutlineRowProps {
  readonly node: OutlineNode;
  readonly depth: number;
  readonly activeId: string | null;
  readonly onJump: (headingId: string) => void;
}

function OutlineRow({ node, depth, activeId, onJump }: OutlineRowProps) {
  const active = node.id === activeId;
  const indent = OUTLINE_INDENT[Math.min(depth, OUTLINE_INDENT.length - 1)];

  return (
    <>
      <button
        type="button"
        title={node.text}
        aria-current={active ? "true" : undefined}
        onClick={() => onJump(node.id)}
        className={`flex h-row w-full items-center rounded-row pr-2 text-left hover:bg-hover ${indent} ${
          active ? "bg-hover" : ""
        }`}
      >
        <span
          className={`truncate text-ui ${
            active ? "text-primary" : "text-secondary"
          }`}
        >
          {node.text}
        </span>
      </button>
      {node.children.map((child) => (
        <OutlineRow
          key={child.id}
          node={child}
          depth={depth + 1}
          activeId={activeId}
          onJump={onJump}
        />
      ))}
    </>
  );
}

interface OutlinePanelProps {
  readonly nodes: readonly OutlineNode[];
  readonly activeId: string | null;
  readonly onJump: (headingId: string) => void;
  readonly onClose: () => void;
}

/** 与阅读区同底色，故左边界需要比左栏更明显一档：border-l2（铁律 8） */
function OutlinePanel({ nodes, activeId, onJump, onClose }: OutlinePanelProps) {
  return (
    <aside className="flex w-outline shrink-0 flex-col border-l border-l2 bg-canvas">
      <div className="flex shrink-0 items-center justify-between border-b border-l2 px-3 pb-3 pt-3.5">
        <span className="text-ui font-medium text-primary">
          {t.outline.title}
        </span>
        <IconButton label={t.outline.close} onClick={onClose}>
          <IconClose size={14} />
        </IconButton>
      </div>

      <div className="quiet-bars min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {nodes.length === 0 ? (
          <p className="px-2 text-ui-sm text-tertiary">{t.outline.empty}</p>
        ) : (
          <div className="space-y-0.5">
            {nodes.map((node) => (
              <OutlineRow
                key={node.id}
                node={node}
                depth={0}
                activeId={activeId}
                onJump={onJump}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/* ── 状态栏 ─────────────────────────────────────────────────── */

interface StatusBarProps {
  readonly words: number;
  readonly lines: number;
  readonly encodingLabel: string;
  readonly zoomPercent: number;
  readonly theme: Theme;
  readonly onCycleZoom: () => void;
  readonly onCycleTheme: () => void;
}

/** 三态主题的图标与名称：跟随系统=显示器 / 浅色=太阳 / 深色=月亮 */
const THEME_LABEL: Record<Theme, string> = {
  system: t.status.themeSystem,
  light: t.status.themeLight,
  dark: t.status.themeDark,
};

function ThemeGlyph({ theme }: { readonly theme: Theme }) {
  if (theme === "light") {
    return <IconSun size={12} />;
  }
  if (theme === "dark") {
    return <IconMoon size={12} />;
  }
  return <IconMonitor size={12} />;
}

function StatusBar({
  words,
  lines,
  encodingLabel,
  zoomPercent,
  theme,
  onCycleZoom,
  onCycleTheme,
}: StatusBarProps) {
  return (
    <footer className="flex h-statusbar shrink-0 items-center justify-between border-t border-l2 bg-panel px-3">
      <div className="truncate whitespace-nowrap text-ui-xs text-tertiary">
        <span>{`${words} ${t.status.words}`}</span>
        <span aria-hidden className="mx-2.5">
          ·
        </span>
        <span>{`${lines} ${t.status.lines}`}</span>
        <span aria-hidden className="mx-2.5">
          ·
        </span>
        <span>{encodingLabel}</span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* 点击循环 90/100/110/125/150（批次 3 的右键菜单再给完整档位菜单） */}
        <button
          type="button"
          aria-label={t.status.zoom}
          title={t.status.zoom}
          onClick={onCycleZoom}
          className="flex h-5 items-center rounded-chip px-1.5 text-ui-xs text-tertiary hover:bg-hover hover:text-secondary"
        >
          {`${zoomPercent}%`}
        </button>
        <button
          type="button"
          aria-label={t.status.toggleTheme}
          title={THEME_LABEL[theme]}
          onClick={onCycleTheme}
          className="flex h-5 w-5 items-center justify-center rounded-full text-tertiary hover:bg-hover hover:text-secondary"
        >
          <ThemeGlyph theme={theme} />
        </button>
      </div>
    </footer>
  );
}

/* ── 拖入遮罩（FR-13 / DG 6.4-9） ───────────────────────────── */

/** 拖入的是不支持的类型时同样出遮罩，但换 danger 描边 + 说明文案，不再静默 */
function DragOverlay({ supported }: { readonly supported: boolean }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-mask p-3 animate-fade-in"
    >
      <div
        className={`flex h-full w-full items-center justify-center rounded-card border-2 border-dashed ${
          supported ? "border-brand" : "border-danger"
        }`}
      >
        <span
          className={`text-ui font-medium ${
            supported ? "text-primary" : "text-danger"
          }`}
        >
          {supported ? t.reading.dropHint : t.reading.dropUnsupported}
        </span>
      </div>
    </div>
  );
}

/* ── 应用外壳 ───────────────────────────────────────────────── */

export default function App() {
  const sidebarCollapsed = useUiStateStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const outlineMode = useUiStateStore((state) => state.outlineMode);
  const setOutlineMode = useUiStateStore((state) => state.setOutlineMode);
  const dragOverlay = useUiStateStore((state) => state.dragOverlay);
  const setDragOverlay = useUiStateStore((state) => state.setDragOverlay);

  const session = useFileSessionStore();

  const recentItems = useRecentFilesStore((state) => state.items);
  const recentFilter = useRecentFilesStore((state) => state.filter);
  const missingPaths = useRecentFilesStore((state) => state.missingPaths);
  const setRecentFilter = useRecentFilesStore((state) => state.setFilter);

  const theme = useSettingsStore((state) => state.theme);
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const outlinePinned = useSettingsStore((state) => state.outlinePinned);
  const zoomPercent = useSettingsStore((state) => state.zoomPercent);
  const fontSize = useSettingsStore((state) => state.fontSize);
  const codeWrap = useSettingsStore((state) => state.codeWrap);

  const scrollerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 平滑跳转期间抑制高亮重算，避免沿途逐个点亮 */
  const suppressActiveSyncUntil = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);
  const [refreshed, setRefreshed] = useState(false);

  /** 顶栏下方的警示条（文件被删 / 拖入不支持类型 / 点了失效条目） */
  const [notice, setNotice] = useState<Notice | null>(null);
  /** 挂载后下一帧才翻 true，让 slide-down 有起点（DG 6.4-13） */
  const [noticeShown, setNoticeShown] = useState(false);
  const noticeTimer = useRef<number | undefined>(undefined);
  /** 拖入的文件是否含受支持类型；决定遮罩是 brand 还是 danger */
  const [dragSupported, setDragSupported] = useState(true);
  /**
   * 相对 .md 链接带 `#fragment` 时的待跳锚点：目标文档渲染 settled 后消费一次。
   * 放 ref 而非 state：它不参与渲染，进 state 只会多一轮无谓的重绘。
   */
  const pendingAnchor = useRef<{ path: string; hash: string } | null>(null);

  const { path, source, revision, silentRefresh, encoding, isLarge } = session;

  /* ── 回调 ── */

  const focusReading = useCallback(() => {
    // preventScroll：焦点归还不能顺带把阅读位置拽走（军规 1）
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);

  const dismissNotice = useCallback(() => {
    window.clearTimeout(noticeTimer.current);
    setNoticeShown(false);
    setNotice(null);
  }, []);

  const showNotice = useCallback((next: Notice) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(next);
  }, []);

  /**
   * 打开一个路径。三条防线：
   *   1. 点击当前已打开的文件 → 直接返回（不重读盘、不归零滚动），只把焦点还给阅读区；
   *   2. 已知失效的路径 → 出警示条给「从列表移除」的出路，而不是摔进全屏错误页；
   *   3. 其余照常读入，渲染完成后由渲染副作用把焦点交给阅读区。
   */
  const openPath = useCallback(
    (target: string) => {
      const state = useFileSessionStore.getState();
      if (samePath(state.path, target) && state.phase !== "error") {
        focusReading();
        return;
      }
      if (includesPath(useRecentFilesStore.getState().missingPaths, target)) {
        showNotice({
          kind: "danger",
          message: t.notice.recentMissing,
          action: {
            label: t.common.remove,
            run: () => {
              useRecentFilesStore.getState().remove(target);
              dismissNotice();
            },
          },
          autoDismiss: false,
        });
        return;
      }
      void state.openPath(target);
    },
    [dismissNotice, focusReading, showNotice],
  );

  const openFile = useCallback(() => {
    void (async () => {
      try {
        const picked = await openFileDialog();
        if (picked !== null && picked !== "") {
          await useFileSessionStore.getState().openPath(picked);
        }
      } catch (error: unknown) {
        // 对话框未就绪（tauri-plugin-dialog 未接入）时只告警，不打断界面
        console.warn("[app] openFileDialog failed", error);
      }
    })();
  }, []);

  const retry = useCallback(() => {
    const state = useFileSessionStore.getState();
    if (state.path !== null) {
      void state.openPath(state.path);
    }
  }, []);

  const toggleOutline = useCallback(() => {
    const next =
      useUiStateStore.getState().outlineMode === "pinned" ? "hidden" : "pinned";
    useUiStateStore.getState().setOutlineMode(next);
    useSettingsStore.getState().setOutlinePinned(next === "pinned");
  }, []);

  const flashRefreshed = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    setRefreshed(true);
    refreshTimer.current = window.setTimeout(() => {
      setRefreshed(false);
    }, REFRESH_FLASH_MS);
  }, []);

  /**
   * 滚动高亮回填：判定逻辑在渲染层（IntersectionObserver，大文件自动降级为节流），
   * 这里只负责去重与「跳转动画期间不接收」。
   */
  const handleActiveHeading = useCallback((headingId: string) => {
    if (performance.now() < suppressActiveSyncUntil.current) {
      return;
    }
    const store = useFileSessionStore.getState();
    if (store.activeHeadingId !== headingId) {
      store.setActiveHeading(headingId);
    }
  }, []);

  /** 跳到容器内某个 id；命中并滚动了返回 true（锚点回退逻辑要据此决定是否再试一次） */
  const jumpToHeading = useCallback((headingId: string): boolean => {
    const scroller = scrollerRef.current;
    const container = contentRef.current;
    if (scroller === null || container === null || headingId === "") {
      return false;
    }
    const target = container.querySelector<HTMLElement>(
      `#${CSS.escape(headingId)}`,
    );
    if (target === null) {
      return false;
    }
    const top =
      scroller.scrollTop +
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      HEADING_JUMP_PADDING;
    suppressActiveSyncUntil.current = performance.now() + ACTIVE_SYNC_SUPPRESS_MS;
    smoothScrollTo(scroller, Math.max(0, top));
    useFileSessionStore.getState().setActiveHeading(headingId);
    return true;
  }, []);

  /** 大纲行点击：与文内锚点同一条跳转路径，忽略命中与否的返回值 */
  const jumpFromOutline = useCallback(
    (headingId: string): void => {
      jumpToHeading(headingId);
    },
    [jumpToHeading],
  );

  /**
   * 文内锚点（标题锚点 / 脚注 / 手写 `#xxx`）：先按 id 直跳，
   * 未命中时按标题文本 slug 模糊回退一次——手写的 `#中文标题` 与渲染层生成的 id
   * 常常只差一层编码或标点，直接放弃会让脚注/目录类链接看起来是坏的。
   */
  const jumpToAnchor = useCallback(
    (rawHash: string): boolean => {
      const hash = decodeSafe(rawHash);
      if (hash === "") {
        return false;
      }
      if (jumpToHeading(hash)) {
        return true;
      }
      const container = contentRef.current;
      if (container === null) {
        return false;
      }
      const wanted = slugOf(hash);
      const headings = Array.from(
        container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
      );
      const matched = headings.find(
        (heading) => slugOf(heading.textContent ?? "") === wanted,
      );
      if (matched === undefined || matched.id === "") {
        return false;
      }
      return jumpToHeading(matched.id);
    },
    [jumpToHeading],
  );

  /** 相对 .md 链接：先记下 fragment，等目标文档渲染 settled 后再跳 */
  const openDocumentAt = useCallback(
    (absolutePath: string, hash: string) => {
      const current = useFileSessionStore.getState();
      // 链接指向的就是当前这篇：不重开（否则滚动归零），有锚点就地跳
      if (samePath(current.path, absolutePath) && current.phase !== "error") {
        focusReading();
        if (hash !== "") {
          jumpToAnchor(hash);
        }
        return;
      }
      pendingAnchor.current = hash === "" ? null : { path: absolutePath, hash };
      openPath(absolutePath);
    },
    [focusReading, jumpToAnchor, openPath],
  );

  /**
   * 阅读区链接点击委托（1.1）。WebView 的默认行为是就地导航——自绘标题栏下没有后退，
   * 一次误点就等于应用被劫持，所以这里**一律 preventDefault**，再按 href 形态分发：
   *   `#锚点` → jumpToHeading（平滑 + 留白 + 大纲高亮同步，且不写 location.hash 污染 history）
   *   http(s) → 交系统浏览器
   *   相对/绝对的 .md 家族路径 → 应用内打开（带 fragment 则渲染后跳锚点）
   *   其余协议（file: / javascript: / mailto: …）→ 只记一条 warn，什么都不做
   */
  const handleReadingActivate = useCallback(
    (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      // 中键：等同左键的分发，但必须挡住 WebView 的「新窗口 / 自动滚动」默认行为
      if (event.type === "auxclick" && event.button !== 1) {
        return;
      }
      event.preventDefault();

      const href = (anchor.getAttribute("href") ?? "").trim();
      if (href === "" || href === "#") {
        return;
      }

      if (href.startsWith("#")) {
        if (!jumpToAnchor(href.slice(1))) {
          console.warn("[app] anchor not found", href);
        }
        return;
      }

      if (EXTERNAL_HREF_RE.test(href)) {
        void openExternal(href).catch((error: unknown) => {
          console.warn("[app] openExternal failed", error);
        });
        return;
      }

      const { path: rawPath, hash } = splitHash(href);
      const relative = decodeSafe(rawPath);
      if (relative !== "" && isSupportedPath(relative)) {
        if (ABSOLUTE_PATH_RE.test(relative)) {
          openDocumentAt(relative, hash);
          return;
        }
        const baseDir = dirNameOf(useFileSessionStore.getState().path ?? "");
        if (baseDir !== null) {
          openDocumentAt(resolveLocalPath(baseDir, relative), hash);
          return;
        }
      }

      console.warn("[app] link blocked", href);
    },
    [jumpToAnchor, openDocumentAt],
  );

  /* ── 缩放与主题（1.6：状态栏两个按钮必须真能用） ── */

  /** 状态栏 zoom% 点击：按 90/100/110/125/150 循环 */
  const cycleZoom = useCallback(() => {
    const state = useSettingsStore.getState();
    state.setZoomPercent(nextZoomPreset(state.zoomPercent));
  }, []);

  /** 状态栏月亮钮：跟随系统 → 浅色 → 深色 → 跟随系统 */
  const cycleTheme = useCallback(() => {
    useSettingsStore.getState().cycleTheme();
  }, []);

  /** 失效路径回填（1.8）：探测逻辑在 store，这里只负责挑时机 */
  const refreshMissing = useCallback(() => {
    void useRecentFilesStore.getState().refreshMissing();
  }, []);

  /* ── 启动：设置与最近列表 ── */

  useEffect(() => {
    void useSettingsStore.getState().load();
    // load() 内部已带一次失效探测，这里不重复调
    void useRecentFilesStore.getState().load();
  }, []);

  /** 切回窗口时重新探测：文件多半是在应用失焦期间被挪走的 */
  useEffect(() => {
    window.addEventListener("focus", refreshMissing);
    return () => {
      window.removeEventListener("focus", refreshMissing);
    };
  }, [refreshMissing]);

  /* ── 警示条的展开与自动撤条 ── */

  useEffect(() => {
    if (notice === null) {
      setNoticeShown(false);
      return;
    }
    const frame = requestAnimationFrame(() => {
      setNoticeShown(true);
    });
    if (!notice.autoDismiss) {
      return () => {
        cancelAnimationFrame(frame);
      };
    }
    noticeTimer.current = window.setTimeout(() => {
      setNoticeShown(false);
      setNotice(null);
    }, NOTICE_AUTO_DISMISS_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(noticeTimer.current);
    };
  }, [notice]);

  /** 大纲钉住态由 settings 持久化后回灌（DG 5.2） */
  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }
    setOutlineMode(outlinePinned ? "pinned" : "hidden");
  }, [settingsLoaded, outlinePinned, setOutlineMode]);

  useEffect(
    () => () => {
      window.clearTimeout(refreshTimer.current);
      window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  /* ── 后端事件：双击/单实例打开、文件变更、拖入 ── */

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (fn: () => void): void => {
      if (disposed) {
        fn();
        return;
      }
      unlisteners.push(fn);
    };
    const warn = (error: unknown): void => {
      console.warn("[app] listener registration failed", error);
    };

    void onOpenPath((target) => {
      void useFileSessionStore.getState().openPath(target);
    })
      .then(track)
      .catch(warn);

    // 冷启动（双击 .md / 命令行传参）：后端在 setup 阶段已暂存路径，
    // 事件不会重放，必须由挂载完成的前端主动取一次。
    void takePendingOpen()
      .then((pending) => {
        if (pending) {
          void useFileSessionStore.getState().openPath(pending);
        }
      })
      .catch(warn);

    void onFileChanged((changed) => {
      const state = useFileSessionStore.getState();
      if (!samePath(state.path, changed)) {
        return;
      }
      void state.reload({ silent: true }).then(() => {
        // 刷新失败（文件被删/被占用）时不闪 ●，交给阅读区错误块说明
        if (useFileSessionStore.getState().phase !== "error") {
          flashRefreshed();
          // 文件又回来了（编辑器的「先删后写」保存策略很常见）：自动撤条
          useFileSessionStore.getState().setMissing(false);
          dismissNotice();
        }
      });
    })
      .then(track)
      .catch(warn);

    // 当前文档被移动/删除：正文保留，只在顶栏下方出一条非模态警示（DG 6.4-13）
    void onFileRemoved((removed) => {
      const state = useFileSessionStore.getState();
      if (!samePath(state.path, removed)) {
        return;
      }
      state.setMissing(true);
      showNotice({
        kind: "danger",
        message: t.notice.fileRemoved,
        action: {
          label: t.common.remove,
          run: () => {
            useRecentFilesStore.getState().remove(removed);
            dismissNotice();
          },
        },
        autoDismiss: false,
      });
    })
      .then(track)
      .catch(warn);

    void onDragDrop((payload) => {
      if (payload.phase === "enter") {
        // 不支持的类型也出遮罩，只是换 danger 描边 + 文案，不再静默（DG 6.4-9）。
        // 拿不到路径（部分拖拽源在 enter 阶段不给）时按「可能可以」处理，不吓唬用户。
        setDragSupported(
          payload.paths.length === 0 || payload.paths.some(isSupportedPath),
        );
        setDragOverlay(true);
        return;
      }
      if (payload.phase === "leave") {
        setDragOverlay(false);
        return;
      }
      if (payload.phase === "drop") {
        setDragOverlay(false);
        const target = payload.paths.find(isSupportedPath);
        if (target !== undefined) {
          void useFileSessionStore.getState().openPath(target);
          return;
        }
        showNotice({
          kind: "warn",
          message: t.notice.dropUnsupported,
          action: null,
          autoDismiss: true,
        });
      }
    })
      .then(track)
      .catch(warn);

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [dismissNotice, flashRefreshed, setDragOverlay, showNotice]);

  /* ── 快捷键（只实现 DG 6.5 总表里版本=M1 且外壳已具备的项） ── */

  useEffect(() => {
    const reloadCurrent = (): void => {
      const state = useFileSessionStore.getState();
      if (state.path !== null) {
        void state.reload({ silent: true });
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();

      // Esc 语义链（DG 6.5）：过滤框有值 → 清空并失焦；否则逐层收浮层；都没有则无动作
      if (event.key === "Escape") {
        const active = document.activeElement;
        if (
          active instanceof HTMLInputElement &&
          active.dataset.sidebarFilter === "true"
        ) {
          if (active.value !== "") {
            event.preventDefault();
            useRecentFilesStore.getState().setFilter("");
            active.blur();
            focusReading();
            return;
          }
          active.blur();
          return;
        }
        if (useUiStateStore.getState().closeTopLayer()) {
          event.preventDefault();
        }
        return;
      }

      if (event.key === "F5") {
        event.preventDefault();
        reloadCurrent();
        return;
      }
      if (!event.ctrlKey) {
        return;
      }
      // Ctrl+R 在关掉 WebView2 快捷键后不再是「整页刷新」，按 DG 6.5 白名单映射为重新渲染
      if (key === "r" && !event.altKey) {
        event.preventDefault();
        reloadCurrent();
        return;
      }
      // 缩放三键：数字键盘的 +/- 同样落在 "+"/"-"，一并接住
      if (key === "=" || key === "+") {
        event.preventDefault();
        useSettingsStore.getState().nudgeZoom(ZOOM_STEP);
        return;
      }
      if (key === "-" || key === "_") {
        event.preventDefault();
        useSettingsStore.getState().nudgeZoom(-ZOOM_STEP);
        return;
      }
      if (key === "0") {
        event.preventDefault();
        useSettingsStore.getState().resetZoom();
        return;
      }
      if (key === "o" && event.altKey) {
        event.preventDefault();
        toggleOutline();
        return;
      }
      if (key === "o" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        openFile();
        return;
      }
      if (key === "b" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [focusReading, openFile, toggleOutline, toggleSidebar]);

  /* ── 阅读区事件委托：链接点击（1.1）与 Ctrl+滚轮缩放（1.4） ── */

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        return;
      }
      // 不 preventDefault 的话，WebView2 会把整个界面（含顶栏状态栏）一起缩放
      event.preventDefault();
      useSettingsStore
        .getState()
        .nudgeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    };

    scroller.addEventListener("click", handleReadingActivate);
    scroller.addEventListener("auxclick", handleReadingActivate);
    // passive:false 是硬要求：React 的合成 wheel 是被动监听，preventDefault 会被忽略
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      scroller.removeEventListener("click", handleReadingActivate);
      scroller.removeEventListener("auxclick", handleReadingActivate);
      scroller.removeEventListener("wheel", onWheel);
    };
  }, [handleReadingActivate]);

  /* ── 渲染管线：revision 变化（含同路径重载）即重渲染 ── */

  useEffect(() => {
    const container = contentRef.current;
    if (path === null || container === null || revision === 0) {
      return;
    }

    let cancelled = false;
    let disposeRender: (() => void) | null = null;
    const scroller = scrollerRef.current;
    // 外部变更 / F5 保持滚动位置；主动切换文档回到顶部（DG 6.1 军规 1）
    const keepTop = silentRefresh && scroller !== null ? scroller.scrollTop : 0;

    void renderMarkdown({
      source,
      container,
      theme: resolvedTheme,
      baseDir: dirNameOf(path),
      encoding: encoding ?? "utf8",
      isLarge,
      onActiveHeading: handleActiveHeading,
    })
      .then((result) => {
        if (cancelled) {
          result.dispose();
          return;
        }
        disposeRender = result.dispose;
        // 渲染层暂未产出大纲时从 DOM 兜底，保证「打开 → 大纲可用」不断链
        const outline =
          result.outline.length > 0
            ? result.outline
            : buildOutlineFromDom(container);
        useFileSessionStore.getState().setRendered({
          outline,
          frontmatter: result.frontmatter,
          stats: result.stats,
        });
        if (scroller !== null) {
          scroller.scrollTop = keepTop;
        }
        suppressActiveSyncUntil.current = 0;
        hardenToolbarSelection(container);

        // 主动打开的文档把焦点交给阅读区：PgDn/PgUp/Space/Home/End 立刻能翻页。
        // 静默刷新不抢焦点（用户可能正在左栏过滤框里打字）。
        if (!silentRefresh && scroller !== null) {
          scroller.focus({ preventScroll: true });
        }

        // 相对 .md 链接带 #fragment：等到这一刻（渲染 settled）再跳，早跳必落空
        const pending = pendingAnchor.current;
        pendingAnchor.current = null;
        if (pending !== null && samePath(pending.path, path)) {
          jumpToAnchor(pending.hash);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const described = describeError(error);
        console.warn("[app] renderMarkdown failed", error);
        useFileSessionStore.getState().setRenderError(described.message);
      });

    return () => {
      cancelled = true;
      disposeRender?.();
    };
    // source / silentRefresh / encoding / isLarge 与 revision 同批更新（fileSession 的一次 set），
    // 故只用 revision 当触发令牌，避免同一次读入触发两次渲染。
  }, [path, revision, resolvedTheme, handleActiveHeading, jumpToAnchor]);

  /* ── 派生数据 ── */

  const groups = useMemo(
    () => buildRecentGroups(recentItems, recentFilter),
    [recentItems, recentFilter],
  );

  // 读取完成前先用文件名顶着，避免顶栏闪一下「未打开文件」
  const displayTitle =
    session.title !== ""
      ? session.title
      : path === null
        ? t.topbar.untitled
        : baseNameOf(path);
  const encodingLabel =
    encoding === null ? t.status.placeholder : ENCODING_LABEL[encoding];
  const words = session.stats?.charCount ?? 0;
  const lines = session.stats?.lineCount ?? session.lineCount;
  const outlineOpen = outlineMode !== "hidden";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas font-ui text-primary">
      <TopBar
        title={displayTitle}
        path={path}
        refreshed={refreshed}
        outlineOpen={outlineOpen}
        onToggleSidebar={toggleSidebar}
        onToggleOutline={toggleOutline}
        onOpenFile={openFile}
      />

      {notice === null ? null : (
        <NoticeBar
          notice={notice}
          shown={noticeShown}
          onDismiss={dismissNotice}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {sidebarCollapsed ? null : (
          <Sidebar
            groups={groups}
            filtering={recentFilter.trim().length > 0}
            filter={recentFilter}
            currentPath={path}
            missingPaths={missingPaths}
            onFilterChange={setRecentFilter}
            onOpen={openPath}
            onOpenFile={openFile}
          />
        )}

        <ReadingArea
          phase={session.phase}
          errorKind={session.errorKind}
          errorMessage={session.error}
          path={path}
          scrollerRef={scrollerRef}
          contentRef={contentRef}
          fontSize={fontSize}
          zoomPercent={zoomPercent}
          codeWrap={codeWrap}
          onOpenFile={openFile}
          onRetry={retry}
        />

        {outlineOpen ? (
          <OutlinePanel
            nodes={session.outline}
            activeId={session.activeHeadingId}
            onJump={jumpFromOutline}
            onClose={toggleOutline}
          />
        ) : null}
      </div>

      <StatusBar
        words={words}
        lines={lines}
        encodingLabel={encodingLabel}
        zoomPercent={zoomPercent}
        theme={theme}
        onCycleZoom={cycleZoom}
        onCycleTheme={cycleTheme}
      />

      {dragOverlay ? <DragOverlay supported={dragSupported} /> : null}
    </div>
  );
}
