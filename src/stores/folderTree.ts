/**
 * 文件夹树 store（F20，DG 5.3.1）——左栏「文件夹」视图的运行态。
 *
 * 与 settings store 的分工：
 * * 本 store 持有**运行态**：每层的子项缓存（nodesByDir）、加载状态、截断标记；
 * * settings 持有**持久态**：folderRoot / folderExpanded / sidebarView / recentFolders。
 *   挂载、展开、切视图都经 settings 的 setter 落盘，本 store 只镜像出便于渲染的形状。
 *
 * 懒加载纪律（DG 5.3.1 性能条）：只有「展开某层」才调 listDirChildren(那一层)，
 * 整棵树永远不会被一口气扫完。dir-tree-changed 到达时也只重列**已加载**的受影响层。
 *
 * 路径口径：一律 normalizePath（recentFiles 同款）作比较键，原始写法只作展示与传参。
 */

import { create } from "zustand";

import { listDirChildren, unwatchDir, watchDir } from "../services/ipc";
import { useSettingsStore } from "./settings";
import { normalizePath } from "./recentFiles";
import type { DirChild } from "../types";

/** 一层的加载状态：undefined（未加载）没有显式状态值——Map 里没这个键就是没加载 */
export interface DirLayer {
  children: DirChild[];
  truncated: boolean;
  /** 拉取失败（权限/网络盘断线）：树里显示一行淡字，可点重试 */
  error: boolean;
}

/** 文件夹在前 + 中文拼音序 + 数字自然序（DG 5.3.1）。Collator 实例复用，避免每次排序重建 */
const collator = new Intl.Collator("zh", { numeric: true, sensitivity: "base" });

export function sortChildren(children: readonly DirChild[]): DirChild[] {
  return [...children].sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return collator.compare(a.name, b.name);
  });
}

interface FolderTreeState {
  /** 归一化路径 → 该层子项；键集合即「已加载的层」 */
  layers: Map<string, DirLayer>;
  /** 正在拉取中的层（归一化键），防重复请求 */
  loading: Set<string>;
  /**
   * 在途加载期间又收到刷新请求的层：完成后自动补拉一次。
   * 没有它，dir-tree-changed 撞上首次加载在途时会被 loadLayer 的去重**静默吞掉**，
   * 而在途那次 readdir 极可能枚举于变更发生之前——该层从此陈旧（复审确认项）。
   */
  dirty: Set<string>;

  /** 挂载新根：清空旧缓存 → settings 落盘 → 加载根层 → 起目录监听 */
  mount: (root: string) => Promise<void>;
  /** 卸载：停监听、清缓存、settings 归零（视图退回 recent） */
  unmount: () => Promise<void>;
  /** 展开/收起一个目录（写 settings.folderExpanded；展开时懒加载该层） */
  toggleDir: (path: string) => void;
  /** 确保某层已加载（重试入口也走这里） */
  ensureLoaded: (path: string) => Promise<void>;
  /** dir-tree-changed：重列受影响的已加载层 */
  refreshLayers: (dirs: string[]) => Promise<void>;
  /** 打开文件后：把从根到该文件父目录的整条链展开（reveal） */
  revealPath: (filePath: string) => Promise<void>;
  /** 启动恢复：settings 已 load 且有根时调用——重放展开集并起监听 */
  restore: () => Promise<void>;
}

/** 展开集的读写都经 settings（唯一持久真源），这里包一层「按归一化键去重」 */
function isExpanded(path: string): boolean {
  const key = normalizePath(path);
  return useSettingsStore
    .getState()
    .folderExpanded.some((item) => normalizePath(item) === key);
}

function setExpanded(path: string, expanded: boolean): void {
  const settings = useSettingsStore.getState();
  const key = normalizePath(path);
  const rest = settings.folderExpanded.filter((item) => normalizePath(item) !== key);
  settings.setFolderExpanded(expanded ? [...rest, path] : rest);
}

/** root 是否 path 的祖先（含相等）；两侧都归一化后按段比较，防 "C:\a" 误配 "C:\ab" */
function isAncestorOrSelf(root: string, path: string): boolean {
  const rootKey = normalizePath(root).replace(/\\+$/, "");
  const pathKey = normalizePath(path).replace(/\\+$/, "");
  return pathKey === rootKey || pathKey.startsWith(`${rootKey}\\`);
}

/** path 的父目录（字符串层面；到根返回 null）。用字符串而非 URL/Path API：wire 上就是字符串 */
export function parentOf(path: string): string | null {
  const trimmed = path.replace(/\\+$/, "");
  const index = trimmed.lastIndexOf("\\");
  if (index <= 0) {
    return null;
  }
  const parent = trimmed.slice(0, index);
  // 盘根（"C:"）补回反斜杠，保持与后端回传的绝对路径形状一致
  return parent.endsWith(":") ? `${parent}\\` : parent;
}

async function loadLayer(
  path: string,
  set: (updater: (state: FolderTreeState) => Partial<FolderTreeState>) => void,
  get: () => FolderTreeState,
): Promise<void> {
  const key = normalizePath(path);
  if (get().loading.has(key)) {
    // 在途去重不许变成丢事件：记 dirty，完成后由 finally 补拉一次
    set((state) => ({ dirty: new Set(state.dirty).add(key) }));
    return;
  }
  set((state) => ({ loading: new Set(state.loading).add(key) }));
  try {
    const result = await listDirChildren(path);
    set((state) => {
      const layers = new Map(state.layers);
      layers.set(key, {
        children: sortChildren(result.children),
        truncated: result.truncated,
        error: false,
      });
      return { layers };
    });
  } catch (error: unknown) {
    console.warn("[folderTree] list failed", path, error);
    set((state) => {
      const layers = new Map(state.layers);
      layers.set(key, { children: [], truncated: false, error: true });
      return { layers };
    });
  } finally {
    set((state) => {
      const loading = new Set(state.loading);
      loading.delete(key);
      return { loading };
    });
    if (get().dirty.has(key)) {
      set((state) => {
        const dirty = new Set(state.dirty);
        dirty.delete(key);
        return { dirty };
      });
      // 补拉不 await：调用方等的是「本次」加载，补拉是后台自愈
      void loadLayer(path, set, get);
    }
  }
}

export const useFolderTreeStore = create<FolderTreeState>()((set, get) => ({
  layers: new Map(),
  loading: new Set(),
  dirty: new Set(),

  mount: async (root) => {
    // 先验证再落盘：拖进来的可能根本不是目录（无后缀的文件）、也可能没权限。
    // 验证失败直接抛给调用方出警示条，settings 里绝不留一个打不开的根。
    const first = await listDirChildren(root);
    const layers = new Map<string, DirLayer>();
    layers.set(normalizePath(root), {
      children: sortChildren(first.children),
      truncated: first.truncated,
      error: false,
    });
    set({ layers, loading: new Set(), dirty: new Set() });
    useSettingsStore.getState().setFolderRoot(root);
    try {
      await watchDir(root);
    } catch (error: unknown) {
      // 监听起不来不阻断挂载：树照常可用，只是不自动刷新
      console.warn("[folderTree] watchDir failed", error);
    }
  },

  unmount: async () => {
    set({ layers: new Map(), loading: new Set(), dirty: new Set() });
    useSettingsStore.getState().setFolderRoot(null);
    try {
      await unwatchDir();
    } catch (error: unknown) {
      console.warn("[folderTree] unwatchDir failed", error);
    }
  },

  toggleDir: (path) => {
    const expanded = isExpanded(path);
    setExpanded(path, !expanded);
    if (!expanded) {
      void get().ensureLoaded(path);
    }
  },

  ensureLoaded: async (path) => {
    const key = normalizePath(path);
    const existing = get().layers.get(key);
    // 已加载且没出错的层不重拉；error 层允许再试（这就是「重试」入口）
    if (existing !== undefined && !existing.error) {
      return;
    }
    await loadLayer(path, set, get);
  },

  refreshLayers: async (dirs) => {
    const root = useSettingsStore.getState().folderRoot;
    if (root === null) {
      return;
    }
    const state = get();
    // 「加载在途」的层也要进 loadLayer（它会记 dirty 完成后补拉）——
    // 只认 layers 的话，首次加载在途时到达的事件就够不着 dirty 机制
    const targets = dirs.filter((dir) => {
      const key = normalizePath(dir);
      return (
        isAncestorOrSelf(root, dir) &&
        (state.layers.has(key) || state.loading.has(key))
      );
    });
    await Promise.all(targets.map((dir) => loadLayer(dir, set, get)));
  },

  revealPath: async (filePath) => {
    const root = useSettingsStore.getState().folderRoot;
    if (root === null || !isAncestorOrSelf(root, filePath)) {
      return;
    }
    // 从文件父目录向上收集到根的整条目录链，逐层展开 + 加载
    const chain: string[] = [];
    let cursor = parentOf(filePath);
    while (cursor !== null && isAncestorOrSelf(root, cursor)) {
      chain.unshift(cursor);
      if (normalizePath(cursor) === normalizePath(root)) {
        break;
      }
      cursor = parentOf(cursor);
    }
    for (const dir of chain) {
      if (normalizePath(dir) !== normalizePath(root) && !isExpanded(dir)) {
        setExpanded(dir, true);
      }
      // 顺序加载：子层的存在性依赖父层已在缓存里，且链条深度有限（人手点出来的）
      // eslint-disable-next-line no-await-in-loop
      await get().ensureLoaded(dir);
    }
  },

  restore: async () => {
    const settings = useSettingsStore.getState();
    const root = settings.folderRoot;
    if (root === null) {
      return;
    }
    // 每轮 await 后都复核根没被换掉：restore 停在慢速网络盘的 readdir 上时，
    // 用户完全来得及挂载新根——晚醒的 watchDir(旧根) 是单槽替换语义，会把新根的
    // 监听整个顶掉，树从此静默失活（复审确认项）。stale 即中止，绝不带病收尾。
    const stale = (): boolean => {
      const current = useSettingsStore.getState().folderRoot;
      return current === null || normalizePath(current) !== normalizePath(root);
    };
    await loadLayer(root, set, get);
    if (stale()) {
      return;
    }
    // 重放展开集：只加载仍然在根下的层（根换过之后的孤儿路径被 sanitize 清掉，
    // 但手改 settings.json 的情况仍要防）
    await Promise.all(
      settings.folderExpanded
        .filter((dir) => isAncestorOrSelf(root, dir))
        .map((dir) => loadLayer(dir, set, get)),
    );
    if (stale()) {
      return;
    }
    try {
      await watchDir(root);
    } catch (error: unknown) {
      console.warn("[folderTree] watchDir failed", error);
    }
  },
}));

/**
 * 树视图渲染用的扁平行（缩进由 depth 决定；键盘导航按 node 行的数组顺序走）。
 * notice 行是不可聚焦的说明行：空目录占位 / 单层截断提示 / 读取失败重试。
 */
export type TreeRow =
  | {
      kind: "node";
      child: DirChild;
      depth: number;
      expanded: boolean;
    }
  | {
      kind: "notice";
      notice: "empty" | "truncated" | "error";
      /** 说明行所属的目录（error 行点击重试用） */
      dir: string;
      depth: number;
    };

/**
 * 把「根层 + 展开集 + 各层缓存」摊平成可渲染的行数组（纯函数，App 侧 useMemo 消费）。
 * filter 非空时按名字过滤**已加载**的行（树视图的过滤不递归扫盘——查看器不做全文索引），
 * 且过滤态下不渲染 notice 行（过滤是找文件，不是巡查空目录）。
 */
export function flattenTree(
  root: string | null,
  layers: Map<string, DirLayer>,
  expandedPaths: readonly string[],
  filter: string,
): TreeRow[] {
  if (root === null) {
    return [];
  }
  const expandedKeys = new Set(expandedPaths.map((item) => normalizePath(item)));
  const needle = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];

  const emitLayerNotices = (dir: string, depth: number): void => {
    if (needle !== "") {
      return;
    }
    const layer = layers.get(normalizePath(dir));
    if (layer === undefined) {
      return;
    }
    if (layer.error) {
      rows.push({ kind: "notice", notice: "error", dir, depth });
      return;
    }
    if (layer.children.length === 0) {
      rows.push({ kind: "notice", notice: "empty", dir, depth });
    } else if (layer.truncated) {
      rows.push({ kind: "notice", notice: "truncated", dir, depth });
    }
  };

  const walk = (dir: string, depth: number): void => {
    const layer = layers.get(normalizePath(dir));
    if (layer === undefined || layer.error) {
      return;
    }
    for (const child of layer.children) {
      const expanded = child.isDir && expandedKeys.has(normalizePath(child.path));
      const matches = needle === "" || child.name.toLowerCase().includes(needle);
      if (matches) {
        rows.push({ kind: "node", child, depth, expanded });
      }
      if (child.isDir && expanded) {
        emitLayerNotices(child.path, depth + 1);
      }
      // 过滤时目录即使自身不命中也要下钻——子孙可能命中；不过滤时只走展开的
      if (child.isDir && (expanded || needle !== "")) {
        walk(child.path, depth + 1);
      }
    }
  };

  emitLayerNotices(root, 0);
  walk(root, 0);
  return rows;
}
