/**
 * 栏宽拖拽把手 —— UPGRADE_PLAN 4.3「布局打磨」。
 *
 * 【定位】通用可复用组件：左栏与大纲栏各挂一个，本文件不知道自己在拖谁，
 * 宽度的真源、钳位区间、持久化全部由调用方（App.tsx + settings store）负责，
 * 这里只把「指针位移」翻译成「新宽度」并回调。
 *
 * 【几何：骑在列边界上】命中带宽 8px（细边界很难点中，是拖拽体验最常见的失败点），
 * 但用 `-mx-1` 把左右各 4px 的外边距抵消掉 —— 在 flex 行里净占位 0px，
 * 所以它插进 [左栏][把手][阅读区] 之间不会挤动任何一列，只是一条骑在缝上的透明带。
 * `relative z-10` 保证它压在相邻两列的背景之上，指针不会被邻居抢走。
 *
 * 【药丸】只有右侧（大纲栏）那颗给（showPill）：12×32 / 圆角 10px / bg-card + border-l2，
 * 平时 opacity:0，**hover 相邻栏、hover 把手本身、或正在拖拽**时才显形（参考项目行为）。
 * 「hover 相邻栏」用 JS 监听兄弟节点而不是 CSS —— 把手与栏是相邻兄弟，
 * CSS 没有「前一个兄弟」选择器，用 :has() 又要赌 WebView2 版本，不如老实监听。
 * 左栏把手只有命中带、没有药丸：左栏与阅读区之间已经有一道 border-l1，再加药丸就吵了。
 *
 * 【交互铁律】
 *   - 显隐是瞬时的，不加 transition（与全站 hover 同一手感）；
 *   - 拖拽期间在 <html> 上挂 data-md-resizing，由 styles/index.css 全局掐掉过渡与选中，
 *     否则任何一条 width/transform 过渡都会让列宽「追」着指针走，看起来像掉帧；
 *   - 无位移、无缩放、无阴影抬升。
 *
 * 【无障碍】role="separator" + aria-orientation + aria-valuenow/min/max，可 Tab 聚焦，
 * ←/→ 调宽（Shift 加速）、Home/End 直达上下限；焦点环走全局 :focus-visible。
 *
 * 纪律：不 import @tauri-apps/api（ESLint 强制），不写内联中文（注释除外）。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { t } from "../i18n/zh-CN";

/** 把手在哪一列的外侧：left = 被拖的列在把手左边（左栏）；right = 在右边（大纲栏） */
export type ResizeSide = "left" | "right";

export interface ResizeHandleProps {
  /** 当前列宽（px）。受控：本组件不持有宽度状态，只回调新值 */
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** 拖拽/按键产生的新宽度（已四舍五入并钳位到 [min, max]） */
  readonly onChange: (width: number) => void;
  readonly side: ResizeSide;
  /** 是否画那颗可见药丸（大纲栏 true，左栏不传） */
  readonly showPill?: boolean;
  /** 无障碍名；不传用通用文案 */
  readonly label?: string;
}

/** 键盘微调步长（px）；按住 Shift 走大步 */
const KEY_STEP = 8;
const KEY_STEP_LARGE = 32;

/**
 * 拖拽期间挂在 <html> 上的标记。样式在 styles/index.css：
 * 全局 cursor: col-resize（指针滑出把手也不变回箭头）+ 掐掉过渡与文本选中。
 */
const RESIZING_ATTR = "data-md-resizing";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 一次拖拽的起点快照：过程中不读 props，避免中途 re-render 让基准漂移 */
interface DragOrigin {
  readonly pointerX: number;
  readonly width: number;
  readonly min: number;
  readonly max: number;
  readonly side: ResizeSide;
}

export function ResizeHandle({
  value,
  min,
  max,
  onChange,
  side,
  showPill = false,
  label,
}: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<DragOrigin | null>(null);
  const [dragging, setDragging] = useState(false);
  const [handleHot, setHandleHot] = useState(false);
  const [columnHot, setColumnHot] = useState(false);

  // onChange 每帧都可能是新函数；存进 ref，让下面的 document 监听只依赖 dragging，
  // 否则一次拖拽里会反复解绑重绑监听（掉帧的经典来源）。
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  /* ── hover 相邻栏也点亮药丸 ── */

  useEffect(() => {
    if (!showPill) {
      return;
    }
    const handle = handleRef.current;
    if (handle === null) {
      return;
    }
    const sibling =
      side === "right" ? handle.nextElementSibling : handle.previousElementSibling;
    if (!(sibling instanceof HTMLElement)) {
      return;
    }
    const enter = (): void => setColumnHot(true);
    const leave = (): void => setColumnHot(false);
    // enter/leave 而非 over/out：后者会被栏内子元素的冒泡打成一串开关
    sibling.addEventListener("pointerenter", enter);
    sibling.addEventListener("pointerleave", leave);
    return () => {
      sibling.removeEventListener("pointerenter", enter);
      sibling.removeEventListener("pointerleave", leave);
    };
  }, [showPill, side]);

  /* ── 拖拽：document 级监听 ── */

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 只认主键；右键要留给右键菜单，中键滚动更不能被吃掉
      if (event.button !== 0) {
        return;
      }
      // 阻止把手所在行发生原生拖选（拖到阅读区会选中一大片正文）
      event.preventDefault();
      originRef.current = {
        pointerX: event.clientX,
        width: value,
        min,
        max,
        side,
      };
      setDragging(true);
    },
    [max, min, side, value],
  );

  useEffect(() => {
    if (!dragging) {
      return;
    }
    const root = document.documentElement;
    root.setAttribute(RESIZING_ATTR, "");

    const move = (event: PointerEvent): void => {
      const origin = originRef.current;
      if (origin === null) {
        return;
      }
      const delta = event.clientX - origin.pointerX;
      // 左栏：指针右移 = 变宽；右侧的大纲栏：指针右移 = 变窄
      const next = origin.side === "left" ? origin.width + delta : origin.width - delta;
      onChangeRef.current(clamp(Math.round(next), origin.min, origin.max));
    };

    const stop = (): void => {
      originRef.current = null;
      setDragging(false);
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    // 系统手势/设备断连会发 pointercancel；窗口失焦时也必须收尾，
    // 否则回到窗口时鼠标一动，列宽会从半路继续跟手
    document.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);

    return () => {
      root.removeAttribute(RESIZING_ATTR);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [dragging]);

  /* ── 键盘 ── */

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      const grow = side === "left" ? step : -step;
      let next: number | null = null;
      if (event.key === "ArrowRight") {
        next = value + grow;
      } else if (event.key === "ArrowLeft") {
        next = value - grow;
      } else if (event.key === "Home") {
        next = min;
      } else if (event.key === "End") {
        next = max;
      }
      if (next === null) {
        return;
      }
      event.preventDefault();
      onChange(clamp(Math.round(next), min, max));
    },
    [max, min, onChange, side, value],
  );

  const pillVisible = dragging || handleHot || columnHot;

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? t.resize.handle}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-md-resize-handle={side}
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={startDrag}
      onPointerEnter={() => setHandleHot(true)}
      onPointerLeave={() => setHandleHot(false)}
      onKeyDown={onKeyDown}
      // touch-none = touch-action:none：不写的话触屏/触控板的拖拽会先被判成滚动手势
      className="relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none select-none"
    >
      {showPill ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute left-1/2 top-1/2 h-8 w-3 -translate-x-1/2 -translate-y-1/2 rounded-[10px] border border-l2 bg-card ${
            pillVisible ? "opacity-100" : "opacity-0"
          }`}
        />
      ) : null}
    </div>
  );
}
