/**
 * 最近文件列表 store —— 对应 DG 5.3（左侧最近列表数据模型）与 DG 7.3（recent.json 持久化）。
 * 注意：这是「最近打开历史」，不是打开中的标签集合；点击 = 打开/切换，无「关闭」概念。
 */

import { create } from "zustand";

import {
  listRecent,
  probePaths,
  removeRecent,
  setRecentPinned,
  setScrollAnchor,
  touchRecent,
} from "../services/ipc";
import type { RecentFile, ScrollAnchor } from "../types";

/** LRU 上限（DG 5.3 / 7.3） */
export const RECENT_LIMIT = 200;

/**
 * 会话内排序冻结（修复「点击第二项立刻跳到第一位、鼠标下的条目来回跳」）。
 *
 * 通行做法（DeepSeek/ChatGPT 会话列表、VS Code Open Editors 同理）：
 * **可见列表在交互期间保持稳定，绝不在鼠标下重排**。LRU 的真实时间照常写入
 * recent.json（下次启动自然按新顺序展示），但本次会话内展示用的 openedAt
 * 固定为条目**首次出现时**的值——排序、分组、时间戳三者因此都不会跳。
 * 会话内新打开的文件不在基线里，按真实时间进「今天」组顶部（发生在列表最上方，
 * 不会造成鼠标下位移）。置顶/移除是用户显式操作，移动是符合预期的，不冻结。
 */
const sessionBaseline = new Map<string, number>();

function baselineKey(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

/** 展示层覆盖：openedAt 固定为会话内首见值，真实值仍由后端持久化 */
function freezeForDisplay(items: RecentFile[]): RecentFile[] {
  return items.map((item) => {
    const key = baselineKey(item.path);
    const frozen = sessionBaseline.get(key);
    if (frozen === undefined) {
      sessionBaseline.set(key, item.openedAt);
      return item;
    }
    return frozen === item.openedAt ? item : { ...item, openedAt: frozen };
  });
}

interface RecentFilesState {
  items: RecentFile[];
  /** 首次从后端加载是否完成（未完成时左栏显示骨架而非空状态） */
  loaded: boolean;
  /** 过滤框内容（FR-03，Ctrl+Shift+F 聚焦） */
  filter: string;
  /** 路径失效条目集合，灰显用（FR-03）；由后端探测结果回填 */
  missingPaths: string[];

  load: () => Promise<void>;
  /**
   * 批量探测条目路径是否还在，回填 missingPaths（失效条目灰显，FR-03）。
   * 调用点：load() 之后自动跑一次；App 侧建议在窗口重新获得焦点时再跑一次
   * （用户很可能刚在资源管理器里删了文件）。
   */
  refreshMissing: () => Promise<void>;
  /** 打开/切换文件后置顶到列表首位（LRU） */
  touch: (file: Pick<RecentFile, "path" | "title">) => void;
  togglePin: (path: string) => void;
  remove: (path: string) => void;
  updateScrollAnchor: (path: string, anchor: ScrollAnchor) => void;
  setFilter: (filter: string) => void;
  setMissingPaths: (paths: string[]) => void;
}

/** 排序：置顶优先，其次按（冻结后的）打开时间倒序 */
function sortItems(items: RecentFile[]): RecentFile[] {
  return [...freezeForDisplay(items)].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return b.openedAt - a.openedAt;
  });
}

/**
 * 后端不做「整表写回」，而是细粒度增删改，每个命令回传最新全表（DG 7.3，写入防抖 500ms 在 Rust 侧）。
 * 本地先乐观更新保证手感，命令返回后以后端全表为准；命令失败仅告警不回滚
 * （本地状态已经是用户看到的结果，回滚反而是二次跳变）。
 */
function reconcile(
  promise: Promise<RecentFile[]>,
  set: (partial: Partial<RecentFilesState>) => void,
  action: string,
): void {
  void promise
    .then((items) => {
      set({ items: sortItems(items).slice(0, RECENT_LIMIT) });
    })
    .catch((error: unknown) => {
      console.warn(`[recentFiles] ${action} failed`, error);
    });
}

export const useRecentFilesStore = create<RecentFilesState>()((set, get) => ({
  items: [],
  loaded: false,
  filter: "",
  missingPaths: [],

  load: async () => {
    try {
      const items = await listRecent();
      set({ items: sortItems(items).slice(0, RECENT_LIMIT), loaded: true });
    } catch (error: unknown) {
      // 后端不可用时按空列表进入空状态（DG 6.6「无最近文件」），不阻塞界面
      console.warn("[recentFiles] load failed", error);
      set({ items: [], loaded: true });
    }
    // 探测与加载解耦：失效灰显晚一拍出现无所谓，但绝不能拖慢左栏首屏
    await get().refreshMissing();
  },

  refreshMissing: async () => {
    const paths = get().items.map((item) => item.path);
    if (paths.length === 0) {
      if (get().missingPaths.length > 0) {
        set({ missingPaths: [] });
      }
      return;
    }
    try {
      const missing = await probePaths(paths);
      set({ missingPaths: missing });
    } catch (error: unknown) {
      // 探测失败就维持原状：宁可不灰显，也不能把好条目误判成失效
      console.warn("[recentFiles] refreshMissing failed", error);
    }
  },

  touch: (file) => {
    const previous = get().items.find((item) => item.path === file.path);
    const entry: RecentFile = {
      path: file.path,
      title: file.title,
      openedAt: Date.now(),
      pinned: previous?.pinned ?? false,
      scrollAnchor: previous?.scrollAnchor ?? null,
    };
    const items = sortItems([
      entry,
      ...get().items.filter((item) => item.path !== file.path),
    ]).slice(0, RECENT_LIMIT);
    set({ items });
    reconcile(touchRecent(entry), set, "touch");
  },

  togglePin: (path) => {
    const target = get().items.find((item) => item.path === path);
    if (!target) {
      return;
    }
    const pinned = !target.pinned;
    set({
      items: sortItems(
        get().items.map((item) => (item.path === path ? { ...item, pinned } : item)),
      ),
    });
    reconcile(setRecentPinned(path, pinned), set, "togglePin");
  },

  remove: (path) => {
    // 仅从列表移除，绝不删除磁盘文件（FR-03）
    set({
      items: get().items.filter((item) => item.path !== path),
      // 同步清掉失效标记，避免同名文件重新加入时残留灰显
      missingPaths: get().missingPaths.filter((missing) => missing !== path),
    });
    reconcile(removeRecent(path), set, "remove");
  },

  updateScrollAnchor: (path, anchor) => {
    set({
      items: get().items.map((item) =>
        item.path === path ? { ...item, scrollAnchor: anchor } : item,
      ),
    });
    // 该命令不回传全表，单独处理
    void setScrollAnchor(path, anchor).catch((error: unknown) => {
      console.warn("[recentFiles] updateScrollAnchor failed", error);
    });
  },

  setFilter: (filter) => {
    set({ filter });
  },

  setMissingPaths: (paths) => {
    set({ missingPaths: paths });
  },
}));
