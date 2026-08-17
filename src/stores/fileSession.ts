/**
 * 当前文档会话 store —— 对应 DG 7.1 状态层的 fileSession，数据流见 DG 7.2-2（渲染管线）。
 * 只承载「当前打开的这一个文件」的状态；历史列表在 recentFiles store。
 *
 * M1 主链路（本 store 负责前两步，后两步由 App 的渲染副作用回填）：
 *   openPath → ipc.readMarkdown（解码在 Rust 侧） → recentFiles.touch（计入最近列表）
 *   → ipc.watchFile（FR-06 监听） → 渲染层 renderMarkdown → setRendered（大纲/统计）
 *
 * 约定：
 *   - `revision` 每次成功读入自增，是渲染副作用的唯一触发令牌（同一路径重载也会重渲染）。
 *   - `silentRefresh` 标记「本次读入来自外部变更或 F5，而非用户主动切换文档」，
 *     渲染完成后应保持滚动位置（DG 6.1 军规 1 / 6.4-7）。
 *   - 严格只读：本 store 不提供任何写回 .md 的能力（红线 5）。
 */

import { create } from "zustand";

import { readMarkdown, unwatchFile, watchFile } from "../services/ipc";
import type {
  DocumentStats,
  FileEncoding,
  Frontmatter,
  OutlineNode,
  ScrollAnchor,
} from "../types";
import { useRecentFilesStore } from "./recentFiles";

/** 会话阶段：空 → 读取中 → 渲染中（分段渲染时可长时间停留）→ 就绪 / 出错 */
export type SessionPhase = "empty" | "loading" | "rendering" | "ready" | "error";

/** 出错来源：读文件失败 / 文件不在了 / 渲染管线抛错；决定用户可见文案 */
export type SessionErrorKind = "read" | "missing" | "render";

/** Rust `AppError` 的序列化形态：{ kind, message }（见 src-tauri/src/error.rs） */
interface BackendError {
  readonly kind: string;
  readonly message: string;
}

function isBackendError(value: unknown): value is BackendError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; message?: unknown };
  return (
    typeof candidate.kind === "string" && typeof candidate.message === "string"
  );
}

/**
 * 把 invoke 的 reject 值统一成 { kind, message }。
 * kind 是前后端契约（error.rs 的 `AppError::kind()`），前端据此选文案；
 * message 面向日志与排查，只在错误块的小字里展示。
 */
export function describeError(error: unknown): BackendError {
  if (isBackendError(error)) {
    return { kind: error.kind, message: error.message };
  }
  if (error instanceof Error) {
    return { kind: "frontend", message: error.message };
  }
  return { kind: "frontend", message: String(error) };
}

interface FileSessionState {
  phase: SessionPhase;
  path: string | null;
  /** 首个 H1，无则文件名（DG 5.3） */
  title: string;
  /** Markdown 原文（已解码、已去 BOM），frontmatter 未剥离 */
  source: string;
  /** 实际解码方式，状态栏用 ENCODING_LABEL 查表显示 */
  encoding: FileEncoding | null;
  byteSize: number;
  /** 原文行数（来自后端；渲染完成后以 stats.lineCount 为准） */
  lineCount: number;
  isLarge: boolean;
  frontmatter: Frontmatter | null;
  outline: OutlineNode[];
  stats: DocumentStats | null;
  /** 当前滚动位置锚点（FR-16），随滚动节流写入 */
  scrollAnchor: ScrollAnchor | null;
  /** 大纲当前高亮章节（阅读区滚动时回填，FR-04） */
  activeHeadingId: string | null;
  /** 大文件分段渲染中（FR-01：>5MB 直接打开 + 提示条） */
  partialRender: boolean;
  /** 文件被移动/删除（FR-06 顶栏警示条） */
  missing: boolean;
  /** 面向日志的错误信息；用户可见文案由 errorKind + i18n 决定 */
  error: string | null;
  errorKind: SessionErrorKind | null;
  /** 成功读入计数：渲染副作用的触发令牌 */
  revision: number;
  /** 本次读入是否为静默刷新（外部变更 / F5），渲染后需保持滚动位置 */
  silentRefresh: boolean;

  /** 打开一个路径：读取 → 计入最近列表 → 起监听（渲染由 App 的副作用接手） */
  openPath: (path: string) => Promise<void>;
  /** 重新读入当前文件；silent 时保持滚动位置且不重排最近列表 */
  reload: (options?: { silent?: boolean }) => Promise<void>;
  /** 关闭当前文档并停止监听 */
  close: () => void;

  setRendered: (payload: {
    outline: OutlineNode[];
    frontmatter: Frontmatter | null;
    stats: DocumentStats;
  }) => void;
  setPartialRender: (partial: boolean) => void;
  setScrollAnchor: (anchor: ScrollAnchor) => void;
  setActiveHeading: (headingId: string | null) => void;
  setMissing: (missing: boolean) => void;
  /** 渲染管线抛错（读取失败走 openPath 内部分支） */
  setRenderError: (message: string) => void;
  reset: () => void;
}

const emptySession = {
  phase: "empty" as SessionPhase,
  path: null as string | null,
  title: "",
  source: "",
  encoding: null as FileEncoding | null,
  byteSize: 0,
  lineCount: 0,
  isLarge: false,
  frontmatter: null as Frontmatter | null,
  outline: [] as OutlineNode[],
  stats: null as DocumentStats | null,
  scrollAnchor: null as ScrollAnchor | null,
  activeHeadingId: null as string | null,
  partialRender: false,
  missing: false,
  error: null as string | null,
  errorKind: null as SessionErrorKind | null,
  silentRefresh: false,
};

/**
 * 载入序号：连点两个文件时，后发的请求先返回也不会被先发的覆盖。
 * 放模块级而非 state，是因为它不参与渲染，进 state 只会制造无谓的订阅通知。
 */
let loadSequence = 0;

export const useFileSessionStore = create<FileSessionState>()((set, get) => {
  /** openPath / reload 共用的读入流程 */
  const load = async (path: string, silent: boolean): Promise<void> => {
    const token = ++loadSequence;

    try {
      const payload = await readMarkdown(path);
      if (token !== loadSequence) {
        return;
      }

      set({
        phase: "rendering",
        path: payload.path,
        title: payload.title,
        source: payload.content,
        encoding: payload.encoding,
        byteSize: payload.byteSize,
        lineCount: payload.lineCount,
        isLarge: payload.isLarge,
        partialRender: payload.isLarge,
        missing: false,
        error: null,
        errorKind: null,
        silentRefresh: silent,
        revision: get().revision + 1,
      });

      // 静默刷新不重排最近列表（外部保存一次就把条目顶到最前会很吵）
      if (!silent) {
        useRecentFilesStore
          .getState()
          .touch({ path: payload.path, title: payload.title });
      }

      // 监听同一时刻只有一个目标，后端会自动替换上一个（files::watch_file）
      void watchFile(payload.path).catch((error: unknown) => {
        console.warn("[fileSession] watchFile failed", error);
      });
    } catch (error: unknown) {
      if (token !== loadSequence) {
        return;
      }
      const described = describeError(error);
      const missing = described.kind === "not-found";
      set({
        phase: "error",
        path,
        error: described.message,
        errorKind: missing ? "missing" : "read",
        missing,
        silentRefresh: false,
      });
    }
  };

  return {
    ...emptySession,
    revision: 0,

    openPath: async (path) => {
      set({ ...emptySession, phase: "loading", path });
      await load(path, false);
    },

    reload: async (options) => {
      const { path } = get();
      if (path === null) {
        return;
      }
      const silent = options?.silent ?? true;
      if (!silent) {
        set({ phase: "loading" });
      }
      await load(path, silent);
    },

    close: () => {
      loadSequence += 1;
      set({ ...emptySession });
      void unwatchFile().catch((error: unknown) => {
        console.warn("[fileSession] unwatchFile failed", error);
      });
    },

    setRendered: ({ outline, frontmatter, stats }) => {
      set({
        phase: "ready",
        outline,
        frontmatter,
        stats,
        error: null,
        errorKind: null,
      });
    },

    setPartialRender: (partial) => {
      set({ partialRender: partial });
    },

    setScrollAnchor: (anchor) => {
      set({ scrollAnchor: anchor });
    },

    setActiveHeading: (headingId) => {
      set({ activeHeadingId: headingId });
    },

    setMissing: (missing) => {
      set({ missing });
    },

    setRenderError: (message) => {
      set({ phase: "error", error: message, errorKind: "render" });
    },

    reset: () => {
      loadSequence += 1;
      set({ ...emptySession });
    },
  };
});
