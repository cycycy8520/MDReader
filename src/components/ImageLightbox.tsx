/**
 * 图片灯箱 —— UPGRADE_PLAN 4.3 / DG 6.4-4。
 *
 * 【为什么是 FLIP 而不是淡入】正文里的配图往往只有栏宽的一半，弹出的大图如果凭空淡入，
 * 用户会丢掉「我点的是哪一张」这个上下文。FLIP（First-Last-Invert-Play）让大图从原图
 * 所在的那一小块位置长出来：先按最终布局落位测一次（Last），再用 transform 把它压回
 * 原图的位置与尺寸（Invert），最后一帧解除（Play）。全程只动 transform，不触发重排。
 * 关掉时反着走一遍，图会缩回它在正文里的位置——视线不用重新找。
 *
 * 【交互】滚轮缩放 0.5×–5×（以指针为中心，不是以图心）、拖拽平移、双击复位、
 * Esc / 点击背景关闭。缩放与平移期间**不加过渡**（跟手），只有 FLIP 与双击复位才有 200ms。
 *
 * 【实现取舍：缩放/平移走命令式，不进 React state】滚轮一次手势能发几十个事件，
 * 每个都 setState 会把 React 的调和塞满，而且 React 重渲染会覆写 img 的 style.transform，
 * 与 FLIP 的命令式写入打架。所以视图状态存在 ref 里，直接写 style —— 本组件内部
 * 没有第二个消费者需要知道当前缩放值。
 *
 * 【降级动效】prefers-reduced-motion 下跳过 FLIP：直接落位、直接卸载
 * （全局那条 `transition-duration: 0.01ms !important` 会把动画压没，此时再等 200ms
 * 收尾就是白等，关闭会显得「点了才反应」）。
 *
 * 纪律：不 import @tauri-apps/api（ESLint 强制），不写内联中文（注释除外）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { t } from "../i18n/zh-CN";

/**
 * 原图在视口中的位置与尺寸。刻意不用 DOMRect 而是四个数：
 * 调用方通常在点击时 `getBoundingClientRect()` 存一份快照，DOMRect 结构上兼容本类型，
 * 直接传即可；同时也允许调用方自己拼（比如从右键菜单打开时没有真实矩形）。
 */
export interface LightboxRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageLightboxProps {
  /** 已经可直接加载的地址（asset:// 改写后的本地图或 http(s) 外链） */
  readonly src: string;
  readonly alt?: string;
  /** 原图矩形；给 null 表示没有起点（跳过 FLIP，直接落位） */
  readonly originRect?: LightboxRect | null;
  /** 退场动画跑完后调用，调用方在这里卸载本组件 */
  readonly onClose: () => void;
}

/* ── 常量（技术值，不是文案） ─────────────────────────────────── */

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;
/** FLIP 与双击复位的时长/缓动（规格钦定：200ms cubic-bezier(0.2,0,0,1)） */
const FLIP_MS = 200;
const FLIP_EASE = "cubic-bezier(0.2, 0, 0, 1)";
const FLIP_TRANSITION = `transform ${FLIP_MS}ms ${FLIP_EASE}`;
/** 退场：给动画留一点余量再卸载，避免最后一帧被剪掉 */
const EXIT_GRACE_MS = 40;
/**
 * 滚轮灵敏度：指数缩放（每 100px 滚动 ≈ ×1.16），
 * 线性加减会让大倍率下手感突然变粗、小倍率下几乎不动。
 */
const WHEEL_SENSITIVITY = 0.0015;

interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

const IDENTITY: View = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function transformOf(view: View): string {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

export function ImageLightbox({
  src,
  alt = "",
  originRect = null,
  onClose,
}: ImageLightboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef<View>(IDENTITY);
  const closingRef = useRef(false);
  const exitTimerRef = useRef<number | null>(null);
  const panRef = useRef<{ pointerX: number; pointerY: number; view: View } | null>(
    null,
  );

  /**
   * 起点矩形只取挂载时那一份。调用方很可能在 render 里现拼这个对象
   * （`{ left: r.left, ... }`），每帧新身份会让下面的进场 effect 反复重播 FLIP，
   * 表现为「大图一直在原地抽搐」。它本来也只在开合两个瞬间有意义，冻住最省心。
   */
  const originRef = useRef(originRect);

  /** 图片解码完成才有真实尺寸，FLIP 必须等它 —— 同一张图多半已在缓存里，通常是同一帧 */
  const [measured, setMeasured] = useState(false);
  const [panning, setPanning] = useState(false);
  const [leaving, setLeaving] = useState(false);

  /**
   * 缓存命中时图片可能在 React 挂上 onLoad 之前就 complete 了，那一次 load 事件收不到
   * （正文里刚显示过的图，几乎必然走这条路）。挂载后补一次判定，否则 FLIP 永远不触发。
   */
  useEffect(() => {
    if (imageRef.current?.complete === true) {
      setMeasured(true);
    }
  }, []);

  const applyView = useCallback((view: View, transition: string | null): void => {
    const image = imageRef.current;
    if (image === null) {
      return;
    }
    viewRef.current = view;
    image.style.transition = transition ?? "none";
    image.style.transform = transformOf(view);
  }, []);

  /* ── 进场 FLIP ── */

  useLayoutEffect(() => {
    if (!measured) {
      return;
    }
    const image = imageRef.current;
    if (image === null) {
      return;
    }
    const origin = originRef.current;
    const target = image.getBoundingClientRect();
    if (
      origin === null ||
      target.width === 0 ||
      target.height === 0 ||
      origin.width === 0 ||
      prefersReducedMotion()
    ) {
      applyView(IDENTITY, null);
      return;
    }

    // Invert：把大图压回原图的位置与尺寸
    const scale = origin.width / target.width;
    const inverted: View = {
      scale,
      x: origin.left + origin.width / 2 - (target.left + target.width / 2),
      y: origin.top + origin.height / 2 - (target.top + target.height / 2),
    };
    applyView(inverted, null);
    // 强制读一次布局，让上面的 transform 真正成为「起始值」；
    // 少了这一行，两次赋值会被合并成一帧，动画根本不会跑
    void image.offsetWidth;
    applyView(IDENTITY, FLIP_TRANSITION);
    const timer = window.setTimeout(() => {
      const current = imageRef.current;
      if (current !== null) {
        current.style.transition = "none";
      }
    }, FLIP_MS + EXIT_GRACE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [applyView, measured]);

  /* ── 退场 ── */

  const beginClose = useCallback(() => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;

    const image = imageRef.current;
    const origin = originRef.current;
    if (image === null || origin === null || prefersReducedMotion()) {
      // 降级动效下全局过渡被压成 0.01ms，再等 200ms 收尾就是纯粹的延迟：直接卸载
      onClose();
      return;
    }

    // 从「当前视觉矩形」反推未变换时的基准（布局落位），再算出落回原图所需的 transform。
    // 直接用当前 rect 算会把已有的缩放/平移算两遍，缩回去会飞出屏幕。
    const rect = image.getBoundingClientRect();
    const view = viewRef.current;
    const baseWidth = rect.width / view.scale;
    if (baseWidth === 0) {
      onClose();
      return;
    }
    const baseCenterX = rect.left + rect.width / 2 - view.x;
    const baseCenterY = rect.top + rect.height / 2 - view.y;

    setLeaving(true);
    applyView(
      {
        scale: origin.width / baseWidth,
        x: origin.left + origin.width / 2 - baseCenterX,
        y: origin.top + origin.height / 2 - baseCenterY,
      },
      FLIP_TRANSITION,
    );
    // 用定时器而不是 transitionend 收尾：transitionend 在「目标值与当前值相同」时根本不触发，
    // 那种情况下灯箱会永远关不掉；定时器最坏也只是早 / 晚一帧。
    exitTimerRef.current = window.setTimeout(onClose, FLIP_MS + EXIT_GRACE_MS);
  }, [applyView, onClose]);

  /** 调用方若在退场动画跑完前就把本组件卸了，别再让那一发 onClose 迟到触发 */
  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
    },
    [],
  );

  /* ── 键盘：Esc 关闭 ── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      // 捕获阶段吃掉：灯箱是最上层，Esc 语义链的其余层（查找条/大纲浮层）不该同时响应
      event.preventDefault();
      event.stopPropagation();
      beginClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [beginClose]);

  /** 打开即取焦点：否则滚轮/按键还落在阅读区，背后的正文会跟着滚 */
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  /* ── 滚轮缩放（以指针为中心） ── */

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      // 必须 preventDefault：否则 Ctrl+滚轮会落到 App 的缩放接线上，正文字号跟着变
      event.preventDefault();
      const image = imageRef.current;
      if (image === null || closingRef.current) {
        return;
      }
      const view = viewRef.current;
      const next = clamp(
        view.scale * Math.exp(-event.deltaY * WHEEL_SENSITIVITY),
        MIN_SCALE,
        MAX_SCALE,
      );
      if (next === view.scale) {
        return;
      }
      const ratio = next / view.scale;
      const rect = image.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      // 指针下的那一点保持不动：t' = t + (c - p)(r - 1)
      applyView(
        {
          scale: next,
          x: view.x + (centerX - event.clientX) * (ratio - 1),
          y: view.y + (centerY - event.clientY) * (ratio - 1),
        },
        null,
      );
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
    };
  }, [applyView]);

  /* ── 拖拽平移 ── */

  useEffect(() => {
    if (!panning) {
      return;
    }
    const move = (event: PointerEvent): void => {
      const origin = panRef.current;
      if (origin === null) {
        return;
      }
      applyView(
        {
          scale: origin.view.scale,
          x: origin.view.x + (event.clientX - origin.pointerX),
          y: origin.view.y + (event.clientY - origin.pointerY),
        },
        null,
      );
    };
    const stop = (): void => {
      panRef.current = null;
      setPanning(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [applyView, panning]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t.lightbox.label}
      tabIndex={-1}
      // 点背景关闭：只认落在遮罩自身上的点击，点图片不该把灯箱关掉
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          beginClose();
        }
      }}
      className={`fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-mask p-6 backdrop-blur-mask transition-opacity duration-base ease-standard ${
        leaving ? "opacity-0" : "opacity-100 animate-fade-in"
      }`}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => setMeasured(true)}
        // 加载失败也要落位：否则 alt 文字会停在未变换的初始 transform 上
        onError={() => setMeasured(true)}
        onPointerDown={(event) => {
          if (event.button !== 0 || closingRef.current) {
            return;
          }
          event.preventDefault();
          panRef.current = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            view: viewRef.current,
          };
          setPanning(true);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          applyView(IDENTITY, FLIP_TRANSITION);
        }}
        className={`max-h-full max-w-full select-none object-contain ${
          panning ? "cursor-grabbing" : "cursor-grab"
        }`}
      />
    </div>
  );
}
