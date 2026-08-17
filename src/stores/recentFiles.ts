/**
 * 最近文件列表 store —— 对应 DG 5.3（左侧最近列表数据模型）与 DG 7.3（recent.json 持久化）。
 * 注意：这是「最近打开历史」，不是打开中的标签集合；点击 = 打开/切换，无「关闭」概念。
 */

import { create } from "zustand";

import {
  listRecent,
  removeRecent,
  setRecentPinned,
  setScrollAnchor,
  touchRecent,
} from "../services/ipc";
import type { RecentFile, ScrollAnchor } from "../types";

/** LRU 上限（DG 5.3 / 7.3） */
export const RECENT_LIMIT = 200;

interface RecentFilesState {
  items: RecentFile[];
  /** 首次从后端加载是否完成（未完成时左栏显示骨架而非空状态） */
  loaded: boolean;
  /** 过滤框内容（FR-03，Ctrl+Shift+F 聚焦） */
  filter: string;
  /** 路径失效条目集合，灰显用（FR-03）；由后端探测结果回填 */
  missingPaths: string[];

  load: () => Promise<void>;
  /** 打开/切换文件后置顶到列表首位（LRU） */
  touch: (file: Pick<RecentFile, "path" | "title">) => void;
  togglePin: (path: string) => void;
  remove: (path: string) => void;
  updateScrollAnchor: (path: string, anchor: ScrollAnchor) => void;
  setFilter: (filter: string) => void;
  setMissingPaths: (paths: string[]) => void;
}

/** 排序：置顶优先，其次按最近打开时间倒序 */
function sortItems(items: RecentFile[]): RecentFile[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return b.openedAt - a.openedAt;
  });
}

/**
 * 后端不做「整表写回」，而是细粒度增删改，每个命令回传最新全表（DG 7.3，写入防抖 500ms 在 Rust 侧）。
 * 本地先乐观更新保证手感，命令返回后以后端全表为准；M0 阶段后端未就绪，失败仅告警不回滚。
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
      // M0：后端 command 尚未实现，按空列表进入空状态（DG 6.6「无最近文件」）
      console.warn("[recentFiles] load failed", error);
      set({ items: [], loaded: true });
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
    set({ items: get().items.filter((item) => item.path !== path) });
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
