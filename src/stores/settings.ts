/**
 * 用户设置 store —— 对应 DG 7.3「settings.json」（主题、字号、缩放、导出偏好、
 * 代码折行、frontmatter 显示、大纲钉住态、左栏宽度/折叠、窗口几何）。
 *
 * 【契约】本 store 的持久化字段 = `types/Settings` = Rust `settings::Settings`，
 * wire 格式 camelCase，三处必须逐字段一致（审计 2026-08-18 blocker：字段名对不上
 * 导致保存即静默丢失，且未发送的字段被反向覆写成默认值）。
 *
 * 窗口几何虽然由 Rust 侧在 setup / CloseRequested 时直接读写，但它是 settings.json 的
 * 一部分：前端 persist 时必须把 window 原样带回去，否则每次保存都会把几何抹成默认值。
 */

import { create } from "zustand";

import { loadSettings, saveSettings } from "../services/ipc";
import type {
  ExportHtmlMode,
  FrontmatterDisplay,
  ReadingStyleVars,
  ResolvedTheme,
  Settings,
  Theme,
  WindowGeometry,
} from "../types";

/* ── 合法区间（与 Rust settings.rs 的同名常量必须一一对应） ──── */

/** 缩放范围与默认值（DG 5.2 状态栏） */
export const ZOOM_MIN = 90;
export const ZOOM_MAX = 150;
export const ZOOM_DEFAULT = 100;
/** Ctrl+滚轮 / Ctrl+= / Ctrl+- 的单步幅度（DG 6.5） */
export const ZOOM_STEP = 10;
/** 状态栏 zoom% 按钮的档位菜单（UPGRADE_PLAN 1.4 / 附录 A 缩放子菜单） */
export const ZOOM_PRESETS: readonly number[] = [90, 100, 110, 125, 150];

/** 正文字号档位（DG 6.7） */
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_DEFAULT = 16;

/**
 * 左栏宽度（DG 5.2）。此前 uiState（200–360）、tokens.css（264–420）、Rust（260）
 * 三处打架，本次按 UPGRADE_PLAN 4.3 与全局契约统一为 264–420，默认 280（= tokens.css）。
 */
export const SIDEBAR_WIDTH_MIN = 264;
export const SIDEBAR_WIDTH_MAX = 420;
export const SIDEBAR_WIDTH_DEFAULT = 280;

/** 窗口默认几何：x/y 为 null 表示无记录，由 Rust 侧回落主屏居中 */
export const DEFAULT_WINDOW_GEOMETRY: WindowGeometry = {
  x: null,
  y: null,
  width: 1200,
  height: 800,
  maximized: false,
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  fontSize: FONT_SIZE_DEFAULT,
  zoomPercent: ZOOM_DEFAULT,
  codeWrap: false,
  frontmatterDisplay: "card",
  outlinePinned: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  sidebarCollapsed: false,
  htmlExportMode: "single-file",
  window: DEFAULT_WINDOW_GEOMETRY,
};

interface SettingsState extends Settings {
  loaded: boolean;
  /** system 解析后的实际主题，供渲染管线取用（hljs 主题 / Mermaid 主题） */
  resolvedTheme: ResolvedTheme;

  load: () => Promise<void>;
  setTheme: (theme: Theme) => void;
  /** 状态栏月亮钮：system → light → dark → system（UPGRADE_PLAN 1.5） */
  cycleTheme: () => void;
  setResolvedTheme: (theme: ResolvedTheme) => void;
  setFontSize: (size: number) => void;
  setZoomPercent: (zoom: number) => void;
  /** Ctrl+滚轮 / Ctrl+= / Ctrl+-：在当前值上增减（内部已钳位） */
  nudgeZoom: (delta: number) => void;
  resetZoom: () => void;
  setCodeWrap: (wrap: boolean) => void;
  setFrontmatterDisplay: (display: FrontmatterDisplay) => void;
  setOutlinePinned: (pinned: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setWindowGeometry: (geometry: WindowGeometry) => void;
  setHtmlExportMode: (mode: ExportHtmlMode) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ── 旧格式迁移（1.3：别让用户旧配置失效） ───────────────────── */

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const FRONTMATTER_DISPLAYS: readonly FrontmatterDisplay[] = ["card", "hidden", "raw"];
const HTML_EXPORT_MODES: readonly ExportHtmlMode[] = ["single-file", "with-assets"];

/** 旧版本（≤ 2026-08-18）写下的字段名，读到就映射到新名并回写一次 */
const LEGACY_KEYS = ["readingFontSize", "zoom", "exportHtmlMode", "showMetadata"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(Math.round(value), min, max)
    : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 可空整数（窗口坐标）：非法值一律退化为 null，交 Rust 侧回落主屏居中 */
function pickNullableInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function normalizeWindow(value: unknown): WindowGeometry {
  if (!isRecord(value)) {
    return DEFAULT_WINDOW_GEOMETRY;
  }
  return {
    x: pickNullableInt(value["x"]),
    y: pickNullableInt(value["y"]),
    width: pickNumber(value["width"], DEFAULT_WINDOW_GEOMETRY.width, 800, 32_000),
    height: pickNumber(value["height"], DEFAULT_WINDOW_GEOMETRY.height, 600, 32_000),
    maximized: pickBoolean(value["maximized"], false),
  };
}

/** 读到的配置里是否带旧字段（带 = 需要迁移后回写一次新格式） */
export function hasLegacySettingsKeys(raw: unknown): boolean {
  return isRecord(raw) && LEGACY_KEYS.some((key) => key in raw);
}

/**
 * 把任意来源的配置对象归一化为当前 Settings：
 * 新字段优先，缺失时回落旧字段（readingFontSize→fontSize、zoom→zoomPercent、
 * exportHtmlMode→htmlExportMode、showMetadata:boolean→frontmatterDisplay 三态），
 * 全部越界值钳回区间。任何异常输入都回落默认值——配置读不出来不该演变成界面打不开。
 */
export function migrateSettings(raw: unknown): Settings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_SETTINGS };
  }

  // showMetadata:false 曾经等价于「隐藏元数据」，true 等价于「卡片」；raw 模式旧版没有
  const legacyFrontmatter: FrontmatterDisplay | undefined =
    typeof raw["showMetadata"] === "boolean"
      ? raw["showMetadata"]
        ? "card"
        : "hidden"
      : undefined;

  return {
    theme: pickEnum(raw["theme"], THEMES, DEFAULT_SETTINGS.theme),
    fontSize: pickNumber(
      raw["fontSize"] ?? raw["readingFontSize"],
      DEFAULT_SETTINGS.fontSize,
      FONT_SIZE_MIN,
      FONT_SIZE_MAX,
    ),
    zoomPercent: pickNumber(
      raw["zoomPercent"] ?? raw["zoom"],
      DEFAULT_SETTINGS.zoomPercent,
      ZOOM_MIN,
      ZOOM_MAX,
    ),
    codeWrap: pickBoolean(raw["codeWrap"], DEFAULT_SETTINGS.codeWrap),
    frontmatterDisplay: pickEnum(
      raw["frontmatterDisplay"],
      FRONTMATTER_DISPLAYS,
      legacyFrontmatter ?? DEFAULT_SETTINGS.frontmatterDisplay,
    ),
    outlinePinned: pickBoolean(raw["outlinePinned"], DEFAULT_SETTINGS.outlinePinned),
    sidebarWidth: pickNumber(
      raw["sidebarWidth"],
      DEFAULT_SETTINGS.sidebarWidth,
      SIDEBAR_WIDTH_MIN,
      SIDEBAR_WIDTH_MAX,
    ),
    sidebarCollapsed: pickBoolean(
      raw["sidebarCollapsed"],
      DEFAULT_SETTINGS.sidebarCollapsed,
    ),
    htmlExportMode: pickEnum(
      raw["htmlExportMode"] ?? raw["exportHtmlMode"],
      HTML_EXPORT_MODES,
      DEFAULT_SETTINGS.htmlExportMode,
    ),
    window: normalizeWindow(raw["window"]),
  };
}

/* ── 主题解析与系统跟随（1.5） ───────────────────────────────── */

const DARK_QUERY = "(prefers-color-scheme: dark)";

function matchDarkQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(DARK_QUERY);
}

/** 当前系统偏好；拿不到 matchMedia（单测/非浏览器环境）时按浅色处理 */
export function systemResolvedTheme(): ResolvedTheme {
  return matchDarkQuery()?.matches === true ? "dark" : "light";
}

/** 把 Theme 落到 <html data-theme>：system 时移除属性，交给 CSS 的 prefers-color-scheme 兜底 */
export function applyThemeAttribute(theme: Theme): ResolvedTheme {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
  }
  return theme === "system" ? systemResolvedTheme() : theme;
}

let disposeSystemThemeWatch: (() => void) | null = null;

/** 撤销系统深浅色监听（卸载时调用；未挂过则为 no-op） */
export function stopSystemThemeWatch(): void {
  disposeSystemThemeWatch?.();
}

/**
 * 系统深浅色监听（审计：theme==="system" 时运行中切系统主题，hljs/Mermaid 停在旧主题）。
 *
 * 只更新 resolvedTheme，不写盘（系统偏好不是用户设置）。返回取消订阅函数；
 * `load()` 会自动挂一次，App 侧若要显式管理生命周期，可在 effect 中调用本函数并在
 * 卸载时执行返回值（重复调用安全：内部先撤旧监听）。
 */
export function startSystemThemeWatch(): () => void {
  stopSystemThemeWatch();
  const query = matchDarkQuery();
  if (!query) {
    return () => undefined;
  }
  const listener = (event: MediaQueryListEvent): void => {
    if (useSettingsStore.getState().theme === "system") {
      useSettingsStore.getState().setResolvedTheme(event.matches ? "dark" : "light");
    }
  };
  query.addEventListener("change", listener);
  disposeSystemThemeWatch = () => {
    query.removeEventListener("change", listener);
    disposeSystemThemeWatch = null;
  };
  return stopSystemThemeWatch;
}

/* ── 排版变量（1.4：CSS 由样式代理消费，DOM 注入由 App 代理做） ── */

/**
 * 阅读容器要注入的两个 CSS 变量。
 *
 * 刻意做成**纯函数**而不是 store 方法/选择器：zustand 选择器每次返回新对象会触发
 * React 18 的 getSnapshot 缓存告警，调用方按 `useMemo(() => readingStyleVars(fontSize, zoomPercent), [...])`
 * 消费即可。`.md-content` 侧对应 `calc(var(--md-reading-font) * var(--md-zoom))`。
 */
export function readingStyleVars(
  fontSize: number,
  zoomPercent: number,
): ReadingStyleVars {
  return {
    "--md-reading-font": `${clamp(Math.round(fontSize), FONT_SIZE_MIN, FONT_SIZE_MAX)}px`,
    "--md-zoom": (clamp(Math.round(zoomPercent), ZOOM_MIN, ZOOM_MAX) / 100).toFixed(2),
  };
}

/* ── 写盘节流 ────────────────────────────────────────────────── */

/**
 * Rust 侧每次 save 都是「临时文件 + fsync + rename」的原子写，
 * 而 Ctrl+滚轮缩放会在一次手势里连发十几次变更——必须节流，否则一路 fsync。
 * 尾沿触发，间隔取 200ms（人类连续操作的间隙都大于它，感知不到延迟）。
 */
const PERSIST_DEBOUNCE_MS = 200;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPending = false;

function writeSettings(settings: Settings): void {
  void saveSettings(settings).catch((error: unknown) => {
    console.warn("[settings] persist failed", error);
  });
}

/** 立即落盘挂起的变更（窗口关闭前可调用，避免最后一次改动丢失） */
export function flushSettings(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistPending) {
    return;
  }
  persistPending = false;
  writeSettings(snapshotSettings());
}

/** 从 store 取出「只含契约字段」的快照——多发字段会被 Rust 忽略，少发字段会被覆写成默认值 */
function snapshotSettings(): Settings {
  const state = useSettingsStore.getState();
  return {
    theme: state.theme,
    fontSize: state.fontSize,
    zoomPercent: state.zoomPercent,
    codeWrap: state.codeWrap,
    frontmatterDisplay: state.frontmatterDisplay,
    outlinePinned: state.outlinePinned,
    sidebarWidth: state.sidebarWidth,
    sidebarCollapsed: state.sidebarCollapsed,
    htmlExportMode: state.htmlExportMode,
    window: state.window,
  };
}

function persist(): void {
  persistPending = true;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistPending = false;
    writeSettings(snapshotSettings());
  }, PERSIST_DEBOUNCE_MS);
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  // 初值直接读系统偏好，而不是硬编码——settings 加载完成前打开的文档不会先按错误主题渲染一遍
  resolvedTheme: systemResolvedTheme(),

  load: async () => {
    let raw: unknown;
    try {
      raw = await loadSettings();
    } catch (error: unknown) {
      console.warn("[settings] load failed", error);
      raw = null;
    }

    const settings = migrateSettings(raw);
    set({
      ...settings,
      loaded: true,
      resolvedTheme: applyThemeAttribute(settings.theme),
    });
    startSystemThemeWatch();

    // 读到旧字段：迁移结果立刻回写一次，把 settings.json 升到新格式
    if (hasLegacySettingsKeys(raw)) {
      persist();
    }
  },

  setTheme: (theme) => {
    set({ theme, resolvedTheme: applyThemeAttribute(theme) });
    persist();
  },

  cycleTheme: () => {
    const order: readonly Theme[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(get().theme) + 1) % order.length] ?? "system";
    get().setTheme(next);
  },

  setResolvedTheme: (theme) => {
    set({ resolvedTheme: theme });
  },

  setFontSize: (size) => {
    set({ fontSize: clamp(Math.round(size), FONT_SIZE_MIN, FONT_SIZE_MAX) });
    persist();
  },

  setZoomPercent: (zoom) => {
    set({ zoomPercent: clamp(Math.round(zoom), ZOOM_MIN, ZOOM_MAX) });
    persist();
  },

  nudgeZoom: (delta) => {
    get().setZoomPercent(get().zoomPercent + delta);
  },

  resetZoom: () => {
    set({ zoomPercent: ZOOM_DEFAULT });
    persist();
  },

  setCodeWrap: (wrap) => {
    set({ codeWrap: wrap });
    persist();
  },

  setFrontmatterDisplay: (display) => {
    set({ frontmatterDisplay: display });
    persist();
  },

  setOutlinePinned: (pinned) => {
    set({ outlinePinned: pinned });
    persist();
  },

  setSidebarWidth: (width) => {
    set({
      sidebarWidth: clamp(Math.round(width), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX),
    });
    persist();
  },

  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed });
    persist();
  },

  setWindowGeometry: (geometry) => {
    set({ window: normalizeWindow(geometry) });
    persist();
  },

  setHtmlExportMode: (mode) => {
    set({ htmlExportMode: mode });
    persist();
  },
}));
