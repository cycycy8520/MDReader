/**
 * 当前文档会话 store —— 对应 DG 7.1 状态层的 fileSession，数据流见 DG 7.2-2（渲染管线）。
 * 只承载「当前打开的这一个文件」的状态；历史列表在 recentFiles store。
 */

import { create } from "zustand";

import type {
  DocumentStats,
  Frontmatter,
  OutlineNode,
  ScrollAnchor,
} from "../types";

/** 会话阶段：空 → 读取中 → 渲染中（分段渲染时可长时间停留）→ 就绪 / 出错 */
export type SessionPhase = "empty" | "loading" | "rendering" | "ready" | "error";

interface FileSessionState {
  phase: SessionPhase;
  path: string | null;
  /** 首个 H1，无则文件名（DG 5.3） */
  title: string;
  /** Markdown 原文（已解码、已去 BOM），frontmatter 未剥离 */
  source: string;
  frontmatter: Frontmatter | null;
  outline: OutlineNode[];
  stats: DocumentStats | null;
  /** 当前滚动位置锚点（FR-16），随滚动节流写入 */
  scrollAnchor: ScrollAnchor | null;
  /** 大文件分段渲染中（FR-01：>5MB 直接打开 + 提示条） */
  partialRender: boolean;
  /** 文件被移动/删除（FR-06 顶栏警示条） */
  missing: boolean;
  /** 面向日志的错误信息；用户可见文案由 i18n 决定 */
  error: string | null;

  beginLoad: (path: string) => void;
  setSource: (path: string, title: string, source: string) => void;
  setRendered: (payload: {
    outline: OutlineNode[];
    frontmatter: Frontmatter | null;
    stats: DocumentStats;
  }) => void;
  setPartialRender: (partial: boolean) => void;
  setScrollAnchor: (anchor: ScrollAnchor) => void;
  setMissing: (missing: boolean) => void;
  setError: (message: string) => void;
  reset: () => void;
}

const emptySession = {
  phase: "empty" as SessionPhase,
  path: null,
  title: "",
  source: "",
  frontmatter: null,
  outline: [] as OutlineNode[],
  stats: null,
  scrollAnchor: null,
  partialRender: false,
  missing: false,
  error: null,
};

export const useFileSessionStore = create<FileSessionState>()((set) => ({
  ...emptySession,

  beginLoad: (path) => {
    set({ ...emptySession, phase: "loading", path });
  },

  setSource: (path, title, source) => {
    set({ phase: "rendering", path, title, source, error: null });
  },

  setRendered: ({ outline, frontmatter, stats }) => {
    set({ phase: "ready", outline, frontmatter, stats });
  },

  setPartialRender: (partial) => {
    set({ partialRender: partial });
  },

  setScrollAnchor: (anchor) => {
    set({ scrollAnchor: anchor });
  },

  setMissing: (missing) => {
    set({ missing });
  },

  setError: (message) => {
    set({ phase: "error", error: message });
  },

  reset: () => {
    set({ ...emptySession });
  },
}));
