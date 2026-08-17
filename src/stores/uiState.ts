/**
 * 界面瞬时状态 store —— 对应 DG 7.1 状态层的 uiState。
 * 规则：需要跨重启记忆的（主题/字号/缩放/大纲钉住/左栏宽度与折叠/窗口几何）属于
 *       settings store，这里只放会话内的开合状态与浮层状态（DG 5.2 / 6.6）。
 *
 * 例外说明：`sidebarCollapsed` / `sidebarWidth` 两项**真源在 settings**（需持久化），
 * 本 store 保留同名镜像字段并把 setter 转发过去——既满足持久化契约，
 * 又不打断既有组件的订阅路径（见文件末尾的订阅回灌）。
 */

import { create } from "zustand";

import { useSettingsStore } from "./settings";
import type { OutlineMode, Toast } from "../types";

/**
 * 左栏宽度约束（DG 5.2）。**唯一定义在 settings store**（264–420，默认 280），
 * 这里只做转出，避免此前「uiState 200–360 / tokens.css 264–420 / Rust 260」三处打架。
 */
export {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} from "./settings";

interface UiState {
  /**
   * Ctrl+B 折叠左栏（DG 6.5）。
   * 真源在 settings store（要跨重启记忆），这里是订阅回灌的**只读镜像**——
   * 组件既可以读 uiState 也可以读 settings，两边永远一致；写请走下面的 action。
   */
  sidebarCollapsed: boolean;
  /** 同上：真源是 settings.sidebarWidth，此处为镜像 */
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

export const useUiStateStore = create<UiState>()((set, get) => ({
  sidebarCollapsed: useSettingsStore.getState().sidebarCollapsed,
  sidebarWidth: useSettingsStore.getState().sidebarWidth,
  outlineMode: "hidden",
  findOpen: false,
  findQuery: "",
  findIndex: 0,
  findTotal: 0,
  lightboxSrc: null,
  dragOverlay: false,
  toasts: [],

  // 下面两个 action 只转发给 settings store（钳位 + 持久化在那边），
  // 本 store 的镜像字段由文件末尾的订阅回灌，不在这里 set，保证单一真源。
  toggleSidebar: () => {
    const settings = useSettingsStore.getState();
    settings.setSidebarCollapsed(!settings.sidebarCollapsed);
  },

  setSidebarWidth: (width) => {
    useSettingsStore.getState().setSidebarWidth(width);
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

/**
 * settings → uiState 的单向回灌：左栏折叠态/宽度要跨重启记忆，真源必须是 settings，
 * 但既有组件按 `useUiStateStore(s => s.sidebarCollapsed)` 订阅，故在此镜像一份。
 * 只在两个字段真变化时 setState，避免无谓渲染。
 */
useSettingsStore.subscribe((state, previous) => {
  if (
    state.sidebarCollapsed !== previous.sidebarCollapsed ||
    state.sidebarWidth !== previous.sidebarWidth
  ) {
    useUiStateStore.setState({
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: state.sidebarWidth,
    });
  }
});
