/**
 * 界面瞬时状态 store —— 对应 DG 7.1 状态层的 uiState。
 * 规则：需要跨重启记忆的（主题/字号/缩放/大纲钉住/左栏宽度与折叠/窗口几何）属于
 *       settings store，这里只放会话内的开合状态与浮层状态（DG 5.2 / 6.6）。
 *
 * 例外说明：`sidebarCollapsed` / `sidebarWidth` 两项**真源在 settings**（需持久化），
 * 本 store 保留同名镜像字段并把 setter 转发过去——既满足持久化契约，
 * 又不打断既有组件的订阅路径（见文件末尾的订阅回灌）。
 *
 * 查找（UPGRADE_PLAN 3.1）的分工：
 *   src/render/find.ts   引擎：文本索引、命中偏移、CSS Highlight 登记、滚动与脉冲（重资源，不进 store）
 *   本文件               状态：开合、关键词、n/m、忙碌位 + 把引擎包成 store action（主控唯一接线面）
 *   components/FindBar   UI：浮条外观、防抖、键盘、抖动反馈
 * 主控只需要认识本文件导出的 openFind / closeFind / findNext / findPrev / invalidateFindIndex。
 */

import { create } from "zustand";

import {
  activateFindMatch,
  clearFindHighlights,
  invalidateFindIndex as invalidateFindEngine,
  isFindIndexReady,
  nearestFindMatch,
  runFindQuery,
} from "../render/find";
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

/** runFind 的可选行为 */
export interface RunFindOptions {
  /**
   * 是否顺带把视线带到最近的一处命中（默认 true）。
   * 输入过程中为 true（跟随关键词走），文档重渲染后的静默重算为 false（不夺走视线）。
   */
  readonly jump?: boolean;
}

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
  /** 当前命中序号（**1-based**，0 = 无命中）/ 总命中数，浮条与状态栏显示 n/m */
  findIndex: number;
  findTotal: number;
  /** 命中数触顶（引擎封顶）：计数要显示 `m+` 而不是假装刚好这么多 */
  findTruncated: boolean;
  /** 正在建全文索引（仅大文档会看到）：浮条显示「正在索引…」 */
  findBusy: boolean;
  /**
   * 每次 openFind 自增。FindBar 据此聚焦输入框并全选已有关键词——
   * 「已经开着时再按 Ctrl+F 要能直接改词」靠的就是它（findOpen 本身不变，effect 不会重跑）。
   */
  findFocusToken: number;
  /**
   * 每次「查完了一处也没有」自增。FindBar 据此抖一下输入框——
   * 连续输入 abc→abcd 时 findTotal 始终是 0、状态不变，只有令牌能表达"又落空了一次"。
   */
  findMissToken: number;
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
  /** 按当前关键词重算命中并刷新高亮（FindBar 防抖后调用，主控一般不用直接碰） */
  runFind: (options?: RunFindOptions) => void;
  /** 下一处 / 上一处：循环（末尾回开头），带 400ms 高亮脉冲 */
  findNext: () => void;
  findPrev: () => void;
  /** 文档重渲染后丢弃查找索引；查找条开着时由 FindBar 静默重算 */
  invalidateFindIndex: () => void;
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
  findTruncated: false,
  findBusy: false,
  findFocusToken: 0,
  findMissToken: 0,
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

  /**
   * Ctrl+F / 顶栏查找按钮。已经开着时**不重置关键词**，只让 FindBar 重新聚焦并全选——
   * 与所有查找条一致的手感（再按一次 = 换个词接着找，而不是从头来）。
   */
  openFind: () => {
    set({ findOpen: true, findFocusToken: get().findFocusToken + 1 });
  },

  /** 关闭 = 清关键词 + 撤掉全部命中标记；焦点归还阅读区由 FindBar 负责（它才有 ref） */
  closeFind: () => {
    clearFindHighlights();
    set({
      findOpen: false,
      findQuery: "",
      findIndex: 0,
      findTotal: 0,
      findTruncated: false,
      findBusy: false,
    });
  },

  setFindQuery: (query) => {
    set({ findQuery: query });
  },

  setFindResult: (index, total) => {
    set({ findIndex: index, findTotal: total });
  },

  runFind: (options) => {
    const jump = options?.jump !== false;
    const query = get().findQuery;
    if (query === "") {
      clearFindHighlights();
      set({ findIndex: 0, findTotal: 0, findTruncated: false, findBusy: false });
      return;
    }
    // 索引没建好才亮「正在索引…」：已就绪时整条链路在同一个微任务里走完，
    // 无条件先置忙会让小文档的浮条闪一下忙碌态
    if (!isFindIndexReady()) {
      set({ findBusy: true });
    }

    void runFindQuery(query)
      .then((outcome) => {
        // 期间又敲了新的键：这一批结果整个作废，界面维持在最新一次的状态
        if (outcome.stale) {
          return;
        }
        set({
          findBusy: false,
          findTotal: outcome.total,
          findTruncated: outcome.truncated,
        });
        if (outcome.total === 0) {
          set({ findIndex: 0, findMissToken: get().findMissToken + 1 });
          return;
        }
        const previous = get().findIndex;
        // jump=false（静默重算）时尽量守住原来的序号，避免外部保存一下就把读者甩走
        const target =
          jump || previous < 1 || previous > outcome.total
            ? nearestFindMatch()
            : previous;
        activateFindMatch(target);
        set({ findIndex: target });
      })
      .catch((error: unknown) => {
        console.warn("[uiState] find failed", error);
        set({ findBusy: false });
      });
  },

  findNext: () => {
    const { findTotal, findIndex } = get();
    if (findTotal === 0) {
      return;
    }
    const target = findIndex >= findTotal ? 1 : findIndex + 1;
    if (activateFindMatch(target, { pulse: true })) {
      set({ findIndex: target });
    }
  },

  findPrev: () => {
    const { findTotal, findIndex } = get();
    if (findTotal === 0) {
      return;
    }
    const target = findIndex <= 1 ? findTotal : findIndex - 1;
    if (activateFindMatch(target, { pulse: true })) {
      set({ findIndex: target });
    }
  },

  /**
   * 主控在「渲染 settled」之后调用。引擎会同时通知订阅者，
   * 查找条开着的话 FindBar 会静默重算一遍（关键词与序号尽量守住）。
   */
  invalidateFindIndex: () => {
    invalidateFindEngine();
    if (get().findOpen) {
      set({ findTotal: 0, findTruncated: false });
    }
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
