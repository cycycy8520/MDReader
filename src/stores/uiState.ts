/**
 * 界面瞬时状态 store —— 对应 DG 7.1 状态层的 uiState。
 * 规则：需要跨重启记忆的（主题/字号/缩放/大纲钉住/窗口几何）属于 settings store，
 *       这里只放会话内的开合状态与浮层状态（DG 5.2 / 6.6）。
 */

import { create } from "zustand";

import type { OutlineMode, Toast } from "../types";

/** 左栏宽度约束（DG 5.2：默认 260，可拖拽 200–360） */
export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 360;

interface UiState {
  /** Ctrl+B 折叠左栏（DG 6.5） */
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  /** 大纲两态 + 收起（FR-04；钉住态由 settings 持久化后回灌） */
  outlineMode: OutlineMode;
  /** Ctrl+F 查找浮条（FR-05） */
  findOpen: boolean;
  findQuery: string;
  /** 当前命中序号 / 总命中数，状态栏与浮条显示 n/m */
  findIndex: number;
  findTotal: number;
  /** 图片灯箱（DG 6.4-4）中展示的图片地址 */
  lightboxSrc: string | null;
  /** 拖入文件的全窗虚线遮罩（FR-13） */
  dragOverlay: boolean;
  /** 同屏最多 3 条（DG 6.3 toast 行） */
  toasts: Toast[];

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setOutlineMode: (mode: OutlineMode) => void;
  toggleOutlinePinned: () => void;
  openFind: () => void;
  closeFind: () => void;
  setFindQuery: (query: string) => void;
  setFindResult: (index: number, total: number) => void;
  setLightboxSrc: (src: string | null) => void;
  setDragOverlay: (visible: boolean) => void;
  pushToast: (toast: Toast) => void;
  dismissToast: (id: string) => void;
  /** Esc：关闭最上层浮层（DG 6.5）。返回 true 表示确实关掉了某一层 */
  closeTopLayer: () => boolean;
}

const TOAST_LIMIT = 3;

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width));
}

export const useUiStateStore = create<UiState>()((set, get) => ({
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  outlineMode: "hidden",
  findOpen: false,
  findQuery: "",
  findIndex: 0,
  findTotal: 0,
  lightboxSrc: null,
  dragOverlay: false,
  toasts: [],

  toggleSidebar: () => {
    set({ sidebarCollapsed: !get().sidebarCollapsed });
  },

  setSidebarWidth: (width) => {
    set({ sidebarWidth: clampWidth(width) });
  },

  setOutlineMode: (mode) => {
    set({ outlineMode: mode });
  },

  toggleOutlinePinned: () => {
    set({ outlineMode: get().outlineMode === "pinned" ? "hidden" : "pinned" });
  },

  openFind: () => {
    set({ findOpen: true });
  },

  closeFind: () => {
    set({ findOpen: false, findQuery: "", findIndex: 0, findTotal: 0 });
  },

  setFindQuery: (query) => {
    set({ findQuery: query });
  },

  setFindResult: (index, total) => {
    set({ findIndex: index, findTotal: total });
  },

  setLightboxSrc: (src) => {
    set({ lightboxSrc: src });
  },

  setDragOverlay: (visible) => {
    set({ dragOverlay: visible });
  },

  pushToast: (toast) => {
    set({ toasts: [...get().toasts, toast].slice(-TOAST_LIMIT) });
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },

  closeTopLayer: () => {
    // 层级顺序：灯箱 > 查找条 > 大纲浮层（钉住态不受 Esc 影响）
    const state = get();
    if (state.lightboxSrc !== null) {
      set({ lightboxSrc: null });
      return true;
    }
    if (state.findOpen) {
      state.closeFind();
      return true;
    }
    if (state.outlineMode === "floating") {
      set({ outlineMode: "hidden" });
      return true;
    }
    return false;
  },
}));
