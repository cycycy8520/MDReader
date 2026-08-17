/**
 * 应用外壳骨架 —— 严格按 DG 5.1 线框 + DG 5.2 区域规格搭建：
 *   顶栏 44px（自绘、整条为拖动区）/ 左栏 260px / 阅读区（内容列宽 760px 居中）
 *   / 大纲面板 240px（此处展示钉住态）/ 状态栏 26px。
 *
 * M0 阶段只有布局与主题变量，不接任何功能：按钮无行为、列表为占位骨架。
 * 交互与状态在 M1 由 stores + 各组件接管（届时本文件拆分为 components/ 下的组件）。
 */

import type { ReactNode } from "react";

import { t } from "./i18n/zh-CN";

/* ── 图标：Lucide 风格线性 1.5px 描边（DG 5.8），M0 内联手绘，避免引入依赖 ── */

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function IconMenu() {
  return (
    <svg {...iconProps}>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg {...iconProps}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function IconOutline() {
  return (
    <svg {...iconProps}>
      <path d="M4 6h16M7 12h13M10 18h10M4 12h.01M7 18h.01" />
    </svg>
  );
}

function IconExport() {
  return (
    <svg {...iconProps}>
      <path d="M12 3v11m0 0 4-4m-4 4-4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function IconShare() {
  return (
    <svg {...iconProps}>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg {...iconProps}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  );
}

/* ── 小组件 ─────────────────────────────────────────────────── */

interface ToolButtonProps {
  label: string;
  children: ReactNode;
}

/** 顶栏图标按钮：图标 + 文字并列，带 aria-label（DG 6.7） */
function ToolButton({ label, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs text-secondary transition-colors duration-hover ease-standard hover:bg-brand-soft hover:text-primary"
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

/** 窗口控制三键（DG 6.2 自绘标题栏）；关闭键 hover 为 danger 色 */
function WindowControls() {
  return (
    <div className="flex items-center">
      <button
        type="button"
        aria-label={t.window.minimize}
        className="flex h-topbar w-11 items-center justify-center text-secondary transition-colors duration-hover hover:bg-brand-soft hover:text-primary"
      >
        <svg {...iconProps}>
          <path d="M5 12h14" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={t.window.maximize}
        className="flex h-topbar w-11 items-center justify-center text-secondary transition-colors duration-hover hover:bg-brand-soft hover:text-primary"
      >
        <svg {...iconProps}>
          <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={t.window.close}
        className="flex h-topbar w-11 items-center justify-center text-secondary transition-colors duration-hover hover:bg-danger hover:text-primary"
      >
        <svg {...iconProps}>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

/** 左栏条目占位骨架：M1 由 recentFiles store 渲染真实条目（DG 5.3） */
function SidebarPlaceholderRow({ active = false }: { active?: boolean }) {
  return (
    <div
      aria-hidden
      className={`flex flex-col gap-1.5 rounded-sm px-2 py-2 ${
        active ? "border-l-[3px] border-brand bg-brand-soft" : "border-l-[3px] border-transparent"
      }`}
    >
      <div className="h-3 w-3/4 rounded-sm bg-card" />
      <div className="h-2.5 w-1/2 rounded-sm bg-card opacity-60" />
    </div>
  );
}

function SidebarGroup({ label, rows }: { label: string; rows: number }) {
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <div className="px-2 pb-1 pt-2 text-xs text-secondary">{label}</div>
      {Array.from({ length: rows }, (_, index) => (
        <SidebarPlaceholderRow key={index} active={index === 0 && label === t.sidebar.groupToday} />
      ))}
    </div>
  );
}

/* ── 应用外壳 ───────────────────────────────────────────────── */

export default function App() {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas font-ui text-primary">
      {/* 顶栏 44px：整条空白区为窗口拖动区；data-tauri-drag-region 不作用于子元素，
          按钮自然排除（已核验事实 #16） */}
      <header
        data-tauri-drag-region
        className="flex h-topbar shrink-0 items-center gap-2 border-b bg-panel pl-2"
      >
        <button
          type="button"
          aria-label={t.topbar.toggleSidebar}
          title={t.topbar.toggleSidebar}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-secondary transition-colors duration-hover ease-standard hover:bg-brand-soft hover:text-primary"
        >
          <IconMenu />
        </button>

        <span data-tauri-drag-region className="text-sm font-medium">
          {t.app.name}
        </span>
        <span data-tauri-drag-region className="truncate-line text-xs text-secondary">
          {t.topbar.untitled}
        </span>

        <div data-tauri-drag-region className="flex-1" />

        <nav className="flex items-center gap-1 pr-2">
          <ToolButton label={t.topbar.find}>
            <IconSearch />
          </ToolButton>
          <ToolButton label={t.topbar.outline}>
            <IconOutline />
          </ToolButton>
          <ToolButton label={t.topbar.export}>
            <IconExport />
          </ToolButton>
          <ToolButton label={t.topbar.share}>
            <IconShare />
          </ToolButton>
          <ToolButton label={t.topbar.more}>
            <IconMore />
          </ToolButton>
        </nav>

        <WindowControls />
      </header>

      {/* 中部三栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 左栏 260px（可拖拽 200–360，Ctrl+B 折叠 —— M1 实现） */}
        <aside className="flex w-sidebar shrink-0 flex-col border-r bg-panel">
          <div className="p-2">
            <input
              type="text"
              placeholder={t.sidebar.filterPlaceholder}
              className="h-8 w-full rounded-md border bg-canvas px-2.5 text-xs text-primary placeholder:text-secondary"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarGroup label={t.sidebar.groupPinned} rows={1} />
            <SidebarGroup label={t.sidebar.groupToday} rows={3} />
            <SidebarGroup label={t.sidebar.groupEarlier} rows={2} />
          </div>

          <div className="border-t p-2">
            <button
              type="button"
              className="h-7 w-full rounded-sm px-2 text-left text-xs text-secondary transition-colors duration-hover ease-standard hover:bg-brand-soft hover:text-primary"
            >
              {t.sidebar.settings}
            </button>
          </div>
        </aside>

        {/* 阅读区：内容列宽 760px 居中，两侧留白自适应 */}
        <main
          data-reading-root
          className="min-w-0 flex-1 overflow-y-auto bg-canvas font-body"
        >
          <div className="mx-auto flex min-h-full max-w-reading flex-col items-center justify-center px-6 py-10 text-center">
            {/* 空状态（DG 5.3 / 6.6：插画位 + 提示 + 设为默认查看器） */}
            <div
              aria-hidden
              className="mb-6 flex h-24 w-24 items-center justify-center rounded-lg border bg-card"
            >
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-brand"
              >
                <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
                <path d="M14 3v4h4" />
                <path d="M9 13v-2l2 2 2-2v2M16.5 11v3m0 0-1.2-1.2M16.5 14l1.2-1.2" />
              </svg>
            </div>

            <p className="text-base text-primary">{t.reading.emptyTitle}</p>
            <p className="mt-2 text-xs text-secondary">{t.reading.emptyHint}</p>

            <div className="mt-6 flex items-center gap-2">
              <button
                type="button"
                className="h-8 rounded-md bg-brand px-3 text-xs text-canvas transition-opacity duration-press hover:opacity-90"
              >
                {t.common.open}
              </button>
              <button
                type="button"
                className="h-8 rounded-md border px-3 text-xs text-secondary transition-colors duration-hover ease-standard hover:bg-brand-soft hover:text-primary"
              >
                {t.reading.setDefaultViewer}
              </button>
            </div>
          </div>
        </main>

        {/* 大纲面板 240px：此处呈现「钉住态」；浮层态在 M1 实现（FR-04） */}
        <aside className="flex w-outline shrink-0 flex-col border-l bg-panel">
          <div className="flex h-9 items-center justify-between border-b px-3">
            <span className="text-xs text-primary">{t.outline.title}</span>
            <button
              type="button"
              aria-label={t.outline.unpin}
              title={t.outline.unpin}
              className="flex h-6 w-6 items-center justify-center rounded-sm text-secondary transition-colors duration-hover ease-standard hover:bg-brand-soft hover:text-primary"
            >
              <svg {...iconProps} width={14} height={14}>
                <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
                <path d="M12 14v6" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 text-xs text-secondary">
            {t.outline.empty}
          </div>
        </aside>
      </div>

      {/* 状态栏 26px */}
      <footer className="flex h-statusbar shrink-0 items-center justify-between border-t bg-panel px-3 text-xs text-secondary">
        <div className="flex items-center gap-1">
          <span>0 {t.status.words}</span>
          <span aria-hidden>·</span>
          <span>0 {t.status.lines}</span>
          <span aria-hidden>·</span>
          <span>UTF-8</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={t.status.zoom}
            title={t.status.zoom}
            className="rounded-sm px-1 transition-colors duration-hover ease-standard hover:text-primary"
          >
            100%
          </button>
          <button
            type="button"
            aria-label={t.status.fontSize}
            title={t.status.fontSize}
            className="rounded-sm px-1 transition-colors duration-hover ease-standard hover:text-primary"
          >
            Aa
          </button>
          <button
            type="button"
            aria-label={t.status.theme}
            title={t.status.theme}
            className="flex items-center rounded-sm px-1 transition-colors duration-hover ease-standard hover:text-primary"
          >
            <svg {...iconProps} width={14} height={14}>
              <circle cx="12" cy="12" r="4.5" />
              <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
}
