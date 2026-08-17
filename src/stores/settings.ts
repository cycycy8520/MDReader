/**
 * 用户设置 store —— 对应 DG 7.3「settings.json」（主题、字号、缩放、导出偏好、
 * 代码折行、元数据显示、大纲钉住态、窗口几何）。窗口几何由 Rust 侧直接读写，不进本 store。
 */

import { create } from "zustand";

import { loadSettings, saveSettings } from "../services/ipc";
import type {
  ExportHtmlMode,
  FrontmatterDisplay,
  ResolvedTheme,
  Settings,
  Theme,
} from "../types";

/** 缩放范围与字号档位（DG 5.2 状态栏 / DG 6.7） */
export const ZOOM_MIN = 90;
export const ZOOM_MAX = 150;
export const ZOOM_DEFAULT = 100;
export const READING_FONT_SIZE_MIN = 14;
export const READING_FONT_SIZE_MAX = 20;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  readingFontSize: 16,
  zoom: ZOOM_DEFAULT,
  codeWrap: false,
  frontmatterDisplay: "card",
  outlinePinned: false,
  exportHtmlMode: "single-file",
};

interface SettingsState extends Settings {
  loaded: boolean;
  /** system 解析后的实际主题，供渲染管线取用（Vditor mode / hljs 主题） */
  resolvedTheme: ResolvedTheme;

  load: () => Promise<void>;
  setTheme: (theme: Theme) => void;
  setResolvedTheme: (theme: ResolvedTheme) => void;
  setReadingFontSize: (size: number) => void;
  setZoom: (zoom: number) => void;
  resetZoom: () => void;
  setCodeWrap: (wrap: boolean) => void;
  setFrontmatterDisplay: (display: FrontmatterDisplay) => void;
  setOutlinePinned: (pinned: boolean) => void;
  setExportHtmlMode: (mode: ExportHtmlMode) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 把 Theme 落到 <html data-theme>：system 时移除属性，交给 CSS 的 prefers-color-scheme 兜底 */
export function applyThemeAttribute(theme: Theme): ResolvedTheme {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  root.setAttribute("data-theme", theme);
  return theme;
}

export const useSettingsStore = create<SettingsState>()((set, get) => {
  /** 保存整表；写盘由 Rust 侧负责（M1-settings） */
  const persist = (): void => {
    const state = get();
    const settings: Settings = {
      theme: state.theme,
      readingFontSize: state.readingFontSize,
      zoom: state.zoom,
      codeWrap: state.codeWrap,
      frontmatterDisplay: state.frontmatterDisplay,
      outlinePinned: state.outlinePinned,
      exportHtmlMode: state.exportHtmlMode,
    };
    void saveSettings(settings).catch((error: unknown) => {
      console.warn("[settings] persist failed", error);
    });
  };

  return {
    ...DEFAULT_SETTINGS,
    loaded: false,
    resolvedTheme: "dark",

    load: async () => {
      try {
        const settings = await loadSettings();
        set({
          ...settings,
          loaded: true,
          resolvedTheme: applyThemeAttribute(settings.theme),
        });
      } catch (error: unknown) {
        // M0：后端 command 尚未实现，用默认值继续（不阻塞界面）
        console.warn("[settings] load failed", error);
        set({
          ...DEFAULT_SETTINGS,
          loaded: true,
          resolvedTheme: applyThemeAttribute(DEFAULT_SETTINGS.theme),
        });
      }
    },

    setTheme: (theme) => {
      set({ theme, resolvedTheme: applyThemeAttribute(theme) });
      persist();
    },

    setResolvedTheme: (theme) => {
      set({ resolvedTheme: theme });
    },

    setReadingFontSize: (size) => {
      set({
        readingFontSize: clamp(size, READING_FONT_SIZE_MIN, READING_FONT_SIZE_MAX),
      });
      persist();
    },

    setZoom: (zoom) => {
      set({ zoom: clamp(Math.round(zoom), ZOOM_MIN, ZOOM_MAX) });
      persist();
    },

    resetZoom: () => {
      set({ zoom: ZOOM_DEFAULT });
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

    setExportHtmlMode: (mode) => {
      set({ exportHtmlMode: mode });
      persist();
    },
  };
});
