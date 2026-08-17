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
 * 左栏的分组标识（3.4：折叠态提升到本 store 后，类型跟着一起搬过来）。
 * 分组归属规则（按 pinned / openedAt 落桶）仍在 App.tsx 的 groupIdOf——
 * 那是展示逻辑，store 只需要知道"有哪几个组"。
 */
export type RecentGroupId = "pinned" | "today" | "yesterday" | "week" | "earlier";

/**
 * Windows 路径归一化：分隔符与大小写都不敏感（与 App.tsx 的 samePath 同一口径）。
 * 3.4 要求「同一文件不同大小写/分隔符只出现一条」，前端所有比较一律经过它，
 * 不再出现「这里用 ===、那里用 toLowerCase」的两套口径。
 */
export function normalizePath(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

/**
 * 归一化键 → 见过的全部原始写法。
 * 去重只是把展示合并成一条，后端 recent.json 里那几条变体还在；移除时若只删点中的
 * 那一条，reconcile 回来的全表会把变体原地复活，用户看到的是"删不掉"。
 */
const pathAliases = new Map<string, Set<string>>();

function rememberAlias(path: string): void {
  const key = normalizePath(path);
  const known = pathAliases.get(key);
  if (known === undefined) {
    pathAliases.set(key, new Set([path]));
    return;
  }
  known.add(path);
}

/** 该文件在后端可能存在的全部写法（至少含传入的这一条） */
function aliasesOf(path: string): string[] {
  const known = pathAliases.get(normalizePath(path));
  if (known === undefined) {
    return [path];
  }
  return known.has(path) ? Array.from(known) : [...known, path];
}

/**
 * 同一文件的不同写法合并成一条（3.4）：
 * 保留先出现的那条（列表已按 置顶 → 时间 排好，先出现的就是更"新"的），
 * pinned 取或、openedAt 取较新、scrollAnchor 取先有的——合并后不丢任何一边的用户意图。
 */
function dedupe(items: RecentFile[]): RecentFile[] {
  const merged = new Map<string, RecentFile>();
  for (const item of items) {
    rememberAlias(item.path);
    const key = normalizePath(item.path);
    const kept = merged.get(key);
    if (kept === undefined) {
      merged.set(key, item);
      continue;
    }
    merged.set(key, {
      ...kept,
      pinned: kept.pinned || item.pinned,
      openedAt: Math.max(kept.openedAt, item.openedAt),
      scrollAnchor: kept.scrollAnchor ?? item.scrollAnchor,
    });
  }
  return Array.from(merged.values());
}

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

/** 展示层覆盖：openedAt 固定为会话内首见值，真实值仍由后端持久化 */
function freezeForDisplay(items: RecentFile[]): RecentFile[] {
  return items.map((item) => {
    const key = normalizePath(item.path);
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
  /**
   * 折叠起来的分组（3.4）。此前是 RecentGroupBlock 的组件内 useState：
   * 过滤把某组滤空、或 Ctrl+B 折起侧栏，组件一卸载折叠态就清零。
   * 提到 store 后至少会话内稳定；跨重启不记（那属于 settings，本项没必要占契约位）。
   */
  collapsedGroups: readonly RecentGroupId[];

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
  toggleGroup: (id: RecentGroupId) => void;
}

/** 排序：置顶优先，其次按（冻结后的）打开时间倒序；去重在排序之前（合并后再定序） */
function sortItems(items: RecentFile[]): RecentFile[] {
  return freezeForDisplay(dedupe(items)).sort((a, b) => {
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
  collapsedGroups: [],

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
    const key = normalizePath(file.path);
    const previous = get().items.find((item) => normalizePath(item.path) === key);
    const entry: RecentFile = {
      path: file.path,
      title: file.title,
      openedAt: Date.now(),
      pinned: previous?.pinned ?? false,
      scrollAnchor: previous?.scrollAnchor ?? null,
    };
    const items = sortItems([
      entry,
      ...get().items.filter((item) => normalizePath(item.path) !== key),
    ]).slice(0, RECENT_LIMIT);
    set({ items });
    reconcile(touchRecent(entry), set, "touch");
  },

  togglePin: (path) => {
    const key = normalizePath(path);
    const target = get().items.find((item) => normalizePath(item.path) === key);
    if (!target) {
      return;
    }
    const pinned = !target.pinned;
    set({
      items: sortItems(
        get().items.map((item) =>
          normalizePath(item.path) === key ? { ...item, pinned } : item,
        ),
      ),
    });
    // 用列表里那一条的原始写法发给后端：调用方给的可能是另一种大小写写法
    reconcile(setRecentPinned(target.path, pinned), set, "togglePin");
  },

  remove: (path) => {
    const key = normalizePath(path);
    // 仅从列表移除，绝不删除磁盘文件（FR-03）
    set({
      items: get().items.filter((item) => normalizePath(item.path) !== key),
      // 同步清掉失效标记，避免同名文件重新加入时残留灰显
      missingPaths: get().missingPaths.filter(
        (missing) => normalizePath(missing) !== key,
      ),
    });
    /**
     * 变体一并删掉，否则 reconcile 回来的全表会把它复活（见 pathAliases 的注释）。
     * 串行而非 Promise.all：后端写盘是 500ms 防抖的单写者，并发发多条只会互相盖。
     */
    const pending = aliasesOf(path).reduce<Promise<RecentFile[]>>(
      (chain, variant) => chain.then(() => removeRecent(variant)),
      Promise.resolve<RecentFile[]>([]),
    );
    pathAliases.delete(key);
    reconcile(pending, set, "remove");
  },

  updateScrollAnchor: (path, anchor) => {
    const key = normalizePath(path);
    set({
      items: get().items.map((item) =>
        normalizePath(item.path) === key ? { ...item, scrollAnchor: anchor } : item,
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

  toggleGroup: (id) => {
    const collapsed = get().collapsedGroups;
    set({
      collapsedGroups: collapsed.includes(id)
        ? collapsed.filter((item) => item !== id)
        : [...collapsed, id],
    });
  },
}));
