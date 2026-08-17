/**
 * 文档内查找浮条 —— UPGRADE_PLAN 3.1（blocker）。
 *
 * 【分工】本文件只管「长什么样、怎么用」：
 *   查找核心（文本索引 / 命中 / CSS Highlight 登记 / 滚动与脉冲）在 src/render/find.ts；
 *   开合与 n/m 状态在 src/stores/uiState.ts；
 *   App 只需要挂一个 <FindBar scrollerRef contentRef />，别的都不用管（接线说明见文件末尾）。
 *
 * 【视觉规格】
 *   浮条    阅读区顶部居中，fixed 定位（跟着阅读区的矩形走，左栏折叠/大纲开合都会重新贴合），
 *           rounded-card + bg-layer + border-float + shadow-lv3，与右键菜单卡同一套外观
 *   高度    36px（h-btn），输入框 208px，计数区固定宽度（否则 9/10 → 10/10 会把按钮挤得抖一下）
 *   按钮    28px 圆形幽灵钮，图标恒比同行文字淡一档（text-tertiary），hover 只换背景且**不加 transition**
 *   无命中  输入框横向抖一次（±4px / 120ms，Web Animations API，不改 DOM 也不进 CSS 层）
 *
 * 【交互契约】
 *   Ctrl+F        唤起并聚焦；已开着则全选输入框内容（换个词接着找）
 *   Enter / F3    下一处；Shift+Enter / Shift+F3 上一处；末尾循环回开头
 *   Esc           关闭并把焦点还给阅读区（键盘翻页立刻恢复）
 *   输入          防抖 80ms 后即时重算并高亮，视线跟到最近的一处命中
 *   跳转          命中滚进视口并居中（已在视野里就不滚），当前命中给 400ms 高亮脉冲
 *
 * 【纪律】不 import @tauri-apps/api；文案一律取 i18n；hover/选中背景不加 transition。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { t } from "../i18n/zh-CN";
import { onFindIndexInvalidated, setFindRoot } from "../render/find";
import { useUiStateStore } from "../stores/uiState";

/* ── 常量（技术值，不是文案） ───────────────────────────────────── */

/** 输入防抖：规格钦定 80ms（比 --md-duration-fast 更短，打字时几乎无感） */
const FIND_DEBOUNCE_MS = 80;
/** 文档重渲染（外部保存 / F5 / 切主题）后静默重算的延时：等 DOM 彻底安定 */
const INVALIDATE_RERUN_MS = 120;
/** 浮条距阅读区顶部的留白 */
const BAR_TOP_GAP = 8;
/** 无命中时的抖动：±4px / 120ms */
const SHAKE_OFFSET_PX = 4;
const SHAKE_MS = 120;

/* ── 图标：与 App / ContextMenu 同一套画法（24 视窗 / stroke 1.5 / currentColor） ── */

function Glyph({
  size,
  children,
}: {
  readonly size: number;
  readonly children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function IconSearch() {
  return (
    <Glyph size={14}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Glyph>
  );
}

/** 上一处：向上的箭头（与大纲的三角区分开，避免读成"折叠"） */
function IconArrowUp() {
  return (
    <Glyph size={14}>
      <path d="M12 19V5m0 0-5.5 5.5M12 5l5.5 5.5" />
    </Glyph>
  );
}

function IconArrowDown() {
  return (
    <Glyph size={14}>
      <path d="M12 5v14m0 0 5.5-5.5M12 19l-5.5-5.5" />
    </Glyph>
  );
}

function IconClose() {
  return (
    <Glyph size={12}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Glyph>
  );
}

/* ── 幽灵图标钮 28px（与 App 的 IconButton 同规格，此处不跨文件复用是因为那个没导出） ── */

interface BarButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  /** 此刻不可用（无命中）：置灰且不响应，但仍可聚焦、仍有 tooltip */
  readonly disabled?: boolean;
  readonly children: ReactNode;
}

function BarButton({ label, onClick, disabled = false, children }: BarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-disabled={disabled ? true : undefined}
      onClick={disabled ? undefined : onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
        disabled
          ? "cursor-default text-tertiary opacity-40"
          : "text-tertiary hover:bg-hover hover:text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

/* ── 浮条 ───────────────────────────────────────────────────────── */

export interface FindBarProps {
  /** 阅读区滚动容器（App 的 scrollerRef，即 main[data-reading-root]）：定位基准 + 跳转时滚它 */
  readonly scrollerRef: RefObject<HTMLElement>;
  /** 正文容器（App 的 contentRef，即 .md-content）：文本索引的根 */
  readonly contentRef: RefObject<HTMLElement>;
  /**
   * 由本组件自行注册全局 Ctrl+F / F3 / Shift+F3（默认开）。
   * **主控若在 App 的 keydown 里也接了同名快捷键，必须把这里关掉**，否则 F3 会一次跳两处。
   */
  readonly bindShortcuts?: boolean;
}

/** 浮条相对视口的落点（跟随阅读区矩形；左栏折叠、大纲开合、警示条出现都会重算） */
interface BarFrame {
  readonly top: number;
  readonly centerX: number;
}

export function FindBar({ scrollerRef, contentRef, bindShortcuts = true }: FindBarProps) {
  const open = useUiStateStore((state) => state.findOpen);
  const query = useUiStateStore((state) => state.findQuery);
  const index = useUiStateStore((state) => state.findIndex);
  const total = useUiStateStore((state) => state.findTotal);
  const truncated = useUiStateStore((state) => state.findTruncated);
  const busy = useUiStateStore((state) => state.findBusy);
  const focusToken = useUiStateStore((state) => state.findFocusToken);
  const missToken = useUiStateStore((state) => state.findMissToken);
  const setFindQuery = useUiStateStore((state) => state.setFindQuery);

  const barRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rerunTimer = useRef<number | undefined>(undefined);
  /** 上一次的开合态：用来判断"刚刚被别人关掉了"，好把焦点还回去 */
  const wasOpen = useRef(false);
  const [frame, setFrame] = useState<BarFrame | null>(null);

  /* ── 引擎绑定：把两个容器交给 render/find.ts ── */

  useEffect(() => {
    setFindRoot(contentRef.current, scrollerRef.current);
  }, [contentRef, scrollerRef, open]);

  useEffect(
    () => () => {
      // 组件卸载（热更新 / 应用退出）时解绑，顺带撤掉残留的高亮
      setFindRoot(null, null);
    },
    [],
  );

  /* ── 无命中抖动 ── */

  const shake = useCallback(() => {
    const input = inputRef.current;
    if (input === null || typeof input.animate !== "function") {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    input.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(-${SHAKE_OFFSET_PX}px)` },
        { transform: `translateX(${SHAKE_OFFSET_PX}px)` },
        { transform: "translateX(0)" },
      ],
      { duration: SHAKE_MS, easing: "ease-in-out" },
    );
  }, []);

  useEffect(() => {
    if (missToken === 0) {
      return;
    }
    shake();
  }, [missToken, shake]);

  /* ── 关闭：归还焦点给阅读区（军规：焦点掉到 body 上键盘翻页就死了） ── */

  const close = useCallback(() => {
    useUiStateStore.getState().closeFind();
    scrollerRef.current?.focus({ preventScroll: true });
  }, [scrollerRef]);

  /**
   * 被别处关掉（App 的 Esc 语义链走 closeTopLayer）时同样要还焦点。
   * 只在"焦点还在浮条里或已经掉到 body"时才抢——用户如果正好点进了左栏过滤框，
   * 这里再抢一次焦点就成了打断。
   */
  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      const insideBar = active !== null && barRef.current?.contains(active) === true;
      if (insideBar || active === null || active === document.body) {
        scrollerRef.current?.focus({ preventScroll: true });
      }
    }
    wasOpen.current = open;
  }, [open, scrollerRef]);

  /* ── 打开即聚焦；已开着再按 Ctrl+F 则全选（换词接着找） ── */

  useEffect(() => {
    if (!open) {
      return;
    }
    const input = inputRef.current;
    if (input === null) {
      return;
    }
    input.focus({ preventScroll: true });
    input.select();
  }, [open, focusToken]);

  /* ── 输入防抖 80ms → 重算命中 ── */

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      useUiStateStore.getState().runFind({ jump: true });
    }, FIND_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, query]);

  /* ── 文档重渲染：索引作废后静默重算（关键词与序号尽量守住，不夺走视线） ── */

  useEffect(() => {
    const unsubscribe = onFindIndexInvalidated(() => {
      const state = useUiStateStore.getState();
      if (!state.findOpen || state.findQuery === "") {
        return;
      }
      window.clearTimeout(rerunTimer.current);
      rerunTimer.current = window.setTimeout(() => {
        useUiStateStore.getState().runFind({ jump: false });
      }, INVALIDATE_RERUN_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(rerunTimer.current);
    };
  }, []);

  /* ── 全局快捷键（可由 bindShortcuts 关掉，避免与主控重复接线） ── */

  useEffect(() => {
    if (!bindShortcuts) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = useUiStateStore.getState();

      if (event.key === "F3") {
        event.preventDefault();
        if (!state.findOpen) {
          state.openFind();
          return;
        }
        if (event.shiftKey) {
          state.findPrev();
        } else {
          state.findNext();
        }
        return;
      }

      // Ctrl+Shift+F 是左栏过滤框的键（DG 6.5），这里必须把 shift 排除掉
      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        state.openFind();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [bindShortcuts]);

  /* ── 落点：跟着阅读区矩形走 ── */

  /**
   * 必须是 layout effect：浮条没有进出场动画，量完再落位的过程一旦拖到绘制之后，
   * 用户就会看见它"先出现在左上角再跳到中间"。layout effect 里 setState 触发的
   * 重渲染发生在浏览器绘制之前，所以第一帧就已经在正确位置上。
   */
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const measure = (): void => {
      const rect = scroller.getBoundingClientRect();
      setFrame({ top: rect.top + BAR_TOP_GAP, centerX: rect.left + rect.width / 2 });
    };
    measure();

    // 左栏折叠、大纲开合、警示条出现撤销、窗口缩放——都会改变阅读区的尺寸
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(scroller);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, scrollerRef]);

  /* ── 键盘：Enter / Shift+Enter / Esc（F3 走全局监听） ── */

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        // 不让它冒到 App 的 Esc 语义链：那条链会再走一次 closeTopLayer，
        // 顺手把大纲也收了（查找条的优先级必须高于关大纲）
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const state = useUiStateStore.getState();
        if (state.findTotal === 0) {
          // 一处都没有还按 Enter：给同一枚"落空"反馈，而不是静默无反应
          if (state.findQuery !== "") {
            shake();
          }
          return;
        }
        if (event.shiftKey) {
          state.findPrev();
        } else {
          state.findNext();
        }
      }
    },
    [close, shake],
  );

  if (!open) {
    return null;
  }

  const hasHits = total > 0;
  const counter = busy
    ? t.find.indexing
    : query === "" || total === 0
      ? t.find.countEmpty
      : truncated
        ? t.find.countTruncated(index, total)
        : t.find.count(index, total);

  return createPortal(
    <div
      ref={barRef}
      role="search"
      aria-label={t.topbar.find}
      onKeyDown={handleKeyDown}
      style={{
        top: frame?.top ?? BAR_TOP_GAP,
        left: frame?.centerX ?? 0,
        // 兜底的一层保险（正常路径下 layout effect 已经在绘制前落好位）。
        // 刻意用 opacity 而不是 visibility：visibility:hidden 的元素**不可聚焦**，
        // 用它的话打开瞬间那次 focus() 会静默失败，Ctrl+F 就成了"开了但打不了字"。
        opacity: frame === null ? 0 : 1,
      }}
      // 不挂 select-none：body 已经全局 user-select:none（只有 [data-reading-root] 内放开），
      // 浮条在 body 上是 portal 出去的，本就选不中；再叠一道反而有让输入框选不了字的风险
      className="fixed z-40 flex h-btn -translate-x-1/2 items-center gap-0.5 rounded-card border border-float bg-layer pl-2.5 pr-1 shadow-lv3"
    >
      <span aria-hidden className="flex shrink-0 items-center text-tertiary">
        <IconSearch />
      </span>

      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => setFindQuery(event.target.value)}
        placeholder={t.find.placeholder}
        spellCheck={false}
        autoComplete="off"
        // 浮条自身就是那道边框，输入框再画一道会变成"框里套框"（铁律 6 的边框态由外层承担）
        className="ml-1.5 h-7 w-52 min-w-0 border-none bg-transparent text-ui text-primary outline-none placeholder:text-caption"
      />

      {/* 计数位宽度固定：9/10 → 10/10 时按钮不能跟着抖 */}
      <span className="w-14 shrink-0 text-center text-ui-xs tabular-nums text-tertiary">
        {counter}
      </span>

      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--md-border-l2)]" />

      <BarButton
        label={t.find.previous}
        onClick={() => useUiStateStore.getState().findPrev()}
        disabled={!hasHits}
      >
        <IconArrowUp />
      </BarButton>
      <BarButton
        label={t.find.next}
        onClick={() => useUiStateStore.getState().findNext()}
        disabled={!hasHits}
      >
        <IconArrowDown />
      </BarButton>
      <BarButton label={t.find.close} onClick={close}>
        <IconClose />
      </BarButton>
    </div>,
    document.body,
  );
}
