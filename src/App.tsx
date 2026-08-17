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
 * M1 接线（本次）：
 *   打开（对话框 / 双击关联 / 拖拽 / 最近列表）→ fileSession.openPath → ipc.readMarkdown
 *   → renderMarkdown 渲染进阅读区 → 回填大纲与统计 → recentFiles 计入最近列表
 *   → ipc.watchFile 监听外部变更（重渲染并保持滚动位置 + 顶栏 ● 闪一次）
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
  type ReactNode,
  type RefObject,
} from "react";

import { t } from "./i18n/zh-CN";
import { renderMarkdown } from "./render/preview";
import {
  onDragDrop,
  onFileChanged,
  onOpenPath,
  takePendingOpen,
  onWindowResized,
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
import { useSettingsStore } from "./stores/settings";
import { useUiStateStore } from "./stores/uiState";
import { ENCODING_LABEL, type OutlineNode, type RecentFile } from "./types";

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

/* ── 纯函数工具 ─────────────────────────────────────────────── */

function isSupportedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
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

/** 标题文本 → 锚点 id（仅在渲染层没给 id 时兜底），同名自动加序号 */
function toHeadingId(text: string, used: Set<string>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/[\s]+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "") || "heading";
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

/** 更多（⋯）：三点用实心，线框圆环在 16px 下会糊成一团 */
function IconMore(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="5.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
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

/* ── 通用小件 ───────────────────────────────────────────────── */

interface IconButtonProps {
  readonly label: string;
  readonly children: ReactNode;
  /** 未实现的功能不传，按钮保持无行为（不写 alert 之类占位） */
  readonly onClick?: () => void;
  readonly active?: boolean;
  readonly className?: string;
}

/**
 * 幽灵图标钮 28px 圆形：反馈只有背景色，且不加 transition（铁律 1 / 2）。
 * 图标常态 tertiary，hover 升一档到 secondary（铁律 5）。
 */
function IconButton({
  label,
  children,
  onClick,
  active = false,
  className = "",
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={onClick ? active : undefined}
      onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-hover hover:text-secondary ${
        active ? "bg-hover text-secondary" : "text-tertiary"
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
        <IconButton label={t.topbar.find}>
          <IconSearch />
        </IconButton>
        <IconButton
          label={t.topbar.outline}
          onClick={onToggleOutline}
          active={outlineOpen}
        >
          <IconOutline />
        </IconButton>
        <IconButton label={t.topbar.export}>
          <IconExport />
        </IconButton>
        <IconButton label={t.topbar.share}>
          <IconShare />
        </IconButton>
        <IconButton label={t.topbar.more}>
          <IconMore />
        </IconButton>
      </nav>

      <WindowControls />
    </header>
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
              missing={missingPaths.includes(entry.file.path)}
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
  onOpenFile,
  onRetry,
}: ReadingAreaProps) {
  const busy = phase === "loading" || phase === "rendering";

  return (
    <main
      ref={scrollerRef}
      data-reading-root
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
            md-content：本项目增量与变量桥的作用域，样式在 styles/markdown.css。 */}
        <div ref={contentRef} className="markdown-body md-content" />
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
  readonly zoom: number;
}

function StatusBar({ words, lines, encodingLabel, zoom }: StatusBarProps) {
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
        <button
          type="button"
          aria-label={t.status.zoom}
          title={t.status.zoom}
          className="flex h-5 items-center rounded-chip px-1.5 text-ui-xs text-tertiary hover:bg-hover hover:text-secondary"
        >
          {`${zoom}%`}
        </button>
        <button
          type="button"
          aria-label={t.status.toggleTheme}
          title={t.status.toggleTheme}
          className="flex h-5 w-5 items-center justify-center rounded-full text-tertiary hover:bg-hover hover:text-secondary"
        >
          <IconMoon size={12} />
        </button>
      </div>
    </footer>
  );
}

/* ── 拖入遮罩（FR-13 / DG 6.4-9） ───────────────────────────── */

function DragOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-mask p-3 animate-fade-in"
    >
      <div className="flex h-full w-full items-center justify-center rounded-card border-2 border-dashed border-brand">
        <span className="text-ui font-medium text-primary">
          {t.reading.dropHint}
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

  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const outlinePinned = useSettingsStore((state) => state.outlinePinned);
  const zoom = useSettingsStore((state) => state.zoom);

  const scrollerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 平滑跳转期间抑制高亮重算，避免沿途逐个点亮 */
  const suppressActiveSyncUntil = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);
  const [refreshed, setRefreshed] = useState(false);

  const { path, source, revision, silentRefresh, encoding, isLarge } = session;

  /* ── 回调 ── */

  const openPath = useCallback((target: string) => {
    void useFileSessionStore.getState().openPath(target);
  }, []);

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

  const jumpToHeading = useCallback((headingId: string) => {
    const scroller = scrollerRef.current;
    const container = contentRef.current;
    if (scroller === null || container === null) {
      return;
    }
    const target = container.querySelector<HTMLElement>(
      `#${CSS.escape(headingId)}`,
    );
    if (target === null) {
      return;
    }
    const top =
      scroller.scrollTop +
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      HEADING_JUMP_PADDING;
    suppressActiveSyncUntil.current = performance.now() + ACTIVE_SYNC_SUPPRESS_MS;
    smoothScrollTo(scroller, Math.max(0, top));
    useFileSessionStore.getState().setActiveHeading(headingId);
  }, []);

  /* ── 启动：设置与最近列表 ── */

  useEffect(() => {
    void useSettingsStore.getState().load();
    void useRecentFilesStore.getState().load();
  }, []);

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
        }
      });
    })
      .then(track)
      .catch(warn);

    void onDragDrop((payload) => {
      if (payload.phase === "enter") {
        setDragOverlay(payload.paths.some(isSupportedPath));
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
        }
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
  }, [flashRefreshed, setDragOverlay]);

  /* ── 快捷键（只实现 DG 6.5 总表里版本=M1 且外壳已具备的项） ── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();

      if (event.key === "F5") {
        event.preventDefault();
        const state = useFileSessionStore.getState();
        if (state.path !== null) {
          void state.reload({ silent: true });
        }
        return;
      }
      if (!event.ctrlKey) {
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
  }, [openFile, toggleOutline, toggleSidebar]);

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
  }, [path, revision, resolvedTheme, handleActiveHeading]);

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
          onOpenFile={openFile}
          onRetry={retry}
        />

        {outlineOpen ? (
          <OutlinePanel
            nodes={session.outline}
            activeId={session.activeHeadingId}
            onJump={jumpToHeading}
            onClose={toggleOutline}
          />
        ) : null}
      </div>

      <StatusBar
        words={words}
        lines={lines}
        encodingLabel={encodingLabel}
        zoom={zoom}
      />

      {dragOverlay ? <DragOverlay /> : null}
    </div>
  );
}
