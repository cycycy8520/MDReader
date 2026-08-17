/**
 * 应用外壳 —— 视觉规格来自对参考项目（DeepSeek Harness 客户端）设计系统的实测提取，
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
 * M0 阶段不接任何业务功能：未实现的按钮不写 onClick；左栏列表为视觉占位数据
 * （M0_SAMPLE_GROUPS），M1 由 recentFiles store 接管后删除。
 * 窗口三键、侧栏 / 大纲栏的显隐是纯外壳能力，已实装。
 */

import { useEffect, useState, type ReactNode } from "react";

import { t } from "./i18n/zh-CN";
import {
  onWindowResized,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleMaximize,
} from "./services/ipc";

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
  readonly onToggleSidebar: () => void;
  readonly onToggleOutline: () => void;
  readonly outlineOpen: boolean;
}

/**
 * 顶栏 40px：整条为拖动区（data-tauri-drag-region 不作用于子元素，按钮天然可点）。
 * 底部分隔线用 ::after 画而非 border-b —— 后续加 tab 激活条时两者不会打架。
 */
function TopBar({ onToggleSidebar, onToggleOutline, outlineOpen }: TopBarProps) {
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
        className="flex min-w-0 flex-1 items-center justify-center px-4"
      >
        <span
          data-tauri-drag-region
          className="truncate text-ui-sm text-tertiary"
        >
          {t.topbar.untitled}
        </span>
      </div>

      <nav className="flex shrink-0 items-center gap-0.5 pr-1.5">
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

interface RecentEntry {
  readonly id: string;
  readonly name: string;
  /** 已格式化的时间戳文本；M1 由 RecentFile.lastOpenedAt 计算 */
  readonly time: string;
}

interface RecentGroup {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly RecentEntry[];
}

/**
 * M0 视觉占位数据：只为让外壳能被目测验收。
 * M1 接入 services/ipc.listRecent() 后，本常量与 i18n 的 sidebar.sample 一并删除。
 */
const M0_SAMPLE_GROUPS: readonly RecentGroup[] = [
  {
    id: "pinned",
    label: t.sidebar.groupPinned,
    entries: [{ id: "p-readme", name: t.sidebar.sample.readme, time: "14:32" }],
  },
  {
    id: "today",
    label: t.sidebar.groupToday,
    entries: [
      { id: "t-guide", name: t.sidebar.sample.guide, time: "13:05" },
      { id: "t-api", name: t.sidebar.sample.api, time: "11:47" },
      { id: "t-meeting", name: t.sidebar.sample.meeting, time: "09:18" },
    ],
  },
  {
    id: "earlier",
    label: t.sidebar.groupEarlier,
    entries: [
      { id: "e-changelog", name: t.sidebar.sample.changelog, time: "08-15" },
      { id: "e-design", name: t.sidebar.sample.design, time: "08-12" },
    ],
  },
];

/** M0 固定高亮一条，用于呈现选中态；M1 改由当前文档路径推导 */
const M0_SELECTED_ID = "t-guide";

/** 搜索框：聚焦只把描边换成墨色，不加 ring、不加发光（铁律 6） */
function SidebarSearch() {
  return (
    <div className="flex h-input shrink-0 items-center gap-1.5 rounded-row border bg-card px-2.5 focus-within:border-brand">
      <IconSearch size={14} className="shrink-0 text-tertiary" />
      <input
        type="text"
        placeholder={t.sidebar.searchPlaceholder}
        className="min-w-0 flex-1 border-none bg-transparent text-ui text-primary outline-none placeholder:text-caption"
      />
    </div>
  );
}

interface RecentRowProps {
  readonly entry: RecentEntry;
  readonly selected: boolean;
}

/**
 * 文件条目 32px：选中态与 hover 共用同一枚半透明底 + 8px 圆角整块高亮，
 * 没有左侧竖条、没有边框、字重不变（铁律 3）。
 */
function RecentRow({ entry, selected }: RecentRowProps) {
  return (
    <button
      type="button"
      title={entry.name}
      aria-current={selected ? "true" : undefined}
      className={`flex h-row w-full items-center gap-1.5 rounded-row px-2 text-left hover:bg-hover ${
        selected ? "bg-hover" : ""
      }`}
    >
      <IconFile size={14} className="shrink-0 text-tertiary" />
      <span className="min-w-0 flex-1 truncate text-ui text-primary">
        {entry.name}
      </span>
      <span className="shrink-0 text-ui-xs text-tertiary">{entry.time}</span>
    </button>
  );
}

function RecentGroupBlock({ group }: { readonly group: RecentGroup }) {
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
              key={entry.id}
              entry={entry}
              selected={entry.id === M0_SELECTED_ID}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Sidebar({ groups }: { readonly groups: readonly RecentGroup[] }) {
  return (
    <aside className="flex w-sidebar shrink-0 flex-col border-r border-l1 bg-panel px-3 py-1.5">
      <SidebarSearch />

      <div className="relative mt-1.5 flex min-h-0 flex-1 flex-col">
        <div className="quiet-bars min-h-0 flex-1 overflow-y-auto pb-4 [scrollbar-gutter:stable]">
          {groups.length === 0 ? (
            <p className="px-3 py-4 text-ui-sm text-tertiary">
              {t.sidebar.empty}
            </p>
          ) : (
            groups.map((group) => (
              <RecentGroupBlock key={group.id} group={group} />
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

/** M0 无文档：Hero 式空状态（不是灰块、不是骨架屏） */
function ReadingArea() {
  return (
    <main
      data-reading-root
      className="quiet-bars min-w-0 flex-1 overflow-y-auto bg-canvas"
    >
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
          className="mt-5 flex h-btn items-center rounded-btn bg-brand px-3.5 text-ui font-medium text-inverted hover:bg-brand-hover"
        >
          {t.common.open}
        </button>
      </div>
    </main>
  );
}

/* ── 大纲栏 ─────────────────────────────────────────────────── */

/** 与阅读区同底色，故左边界需要比左栏更明显一档：border-l2（铁律 8） */
function OutlinePanel({ onClose }: { readonly onClose: () => void }) {
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

      <div className="quiet-bars min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="text-ui-sm text-tertiary">{t.outline.empty}</p>
      </div>
    </aside>
  );
}

/* ── 状态栏 ─────────────────────────────────────────────────── */

/** M0 无文档，统计恒为 0；M1 由当前 DocumentPayload 推导 */
const M0_STATS = { words: 0, lines: 0 } as const;
const M0_ZOOM = "100%";

function StatusBar() {
  return (
    <footer className="flex h-statusbar shrink-0 items-center justify-between border-t border-l2 bg-panel px-3">
      <div className="truncate whitespace-nowrap text-ui-xs text-tertiary">
        <span>{`${M0_STATS.words} ${t.status.words}`}</span>
        <span aria-hidden className="mx-2.5">
          ·
        </span>
        <span>{`${M0_STATS.lines} ${t.status.lines}`}</span>
        <span aria-hidden className="mx-2.5">
          ·
        </span>
        <span>{t.status.encoding}</span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={t.status.zoom}
          title={t.status.zoom}
          className="flex h-5 items-center rounded-chip px-1.5 text-ui-xs text-tertiary hover:bg-hover hover:text-secondary"
        >
          {M0_ZOOM}
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

/* ── 应用外壳 ───────────────────────────────────────────────── */

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(true);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas font-ui text-primary">
      <TopBar
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
        onToggleOutline={() => setOutlineOpen((value) => !value)}
        outlineOpen={outlineOpen}
      />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen ? <Sidebar groups={M0_SAMPLE_GROUPS} /> : null}
        <ReadingArea />
        {outlineOpen ? (
          <OutlinePanel onClose={() => setOutlineOpen(false)} />
        ) : null}
      </div>

      <StatusBar />
    </div>
  );
}
