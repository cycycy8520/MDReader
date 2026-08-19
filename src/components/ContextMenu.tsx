/**
 * 通用右键菜单组件 —— UPGRADE_PLAN 3.2「应用内右键菜单四套」的 UI 外壳。
 *
 * 【为什么必须有这个组件】批次 1 把 WebView2 的 `AreDefaultContextMenusEnabled` 关成了 false
 * （src-tauri/src/lib.rs），浏览器右键菜单已经没了；在自绘菜单到位之前，全应用右键是**死区**。
 * 本组件只负责「菜单长什么样、怎么用」，**四套菜单的条目定义在 contextMenuItems.ts**
 * （与 UI 分离，便于逐行对拍 UPGRADE_PLAN 附录 A），动作实现在 App.tsx。
 *
 * 行为契约（附录 B 的结论：抄 Radix ContextMenu 的行为语义，UI 自写贴本项目 Token）：
 *   位置   根层以鼠标点为锚点，间隙 4px；超出右/下边缘翻到另一侧，再夹回视口内（绝不被裁切）；
 *          菜单高于视口时自身滚动（`max-h` + `overflow-y`），仍然不裁切
 *   关闭   点条目后 / 点外部 / Esc / 窗口 blur / 外部滚动 / resize
 *   键盘   ↑↓ 移动（循环）、Home/End 首末项、Enter 触发（走 button 原生激活）、
 *          → 展开子菜单、← 收起子菜单并归还焦点、Esc 关闭整棵、Tab 在本级内打转（焦点陷阱）；
 *          打开时焦点进第一项，关闭后归还触发元素
 *   子菜单 hover 或 → 展开（hover 展开不抢焦点，键盘展开才把焦点送进去）。
 *          **贴合与手感对齐系统菜单**（批次 5.6，用户 2026-08-19 点名对标 Win11）：
 *          · 定位：压在父菜单**卡**边缘上重叠 4px（不是贴菜单项留缝），顶边与父项行顶
 *            精确对齐（补回卡 padding 与描边）；右侧放不下翻到左侧，同样重叠；
 *          · 宽限：指针滑到兄弟项**不立刻**收起子菜单，起 280ms 宽限计时——期间进入
 *            子菜单面板或折回父项即取消。没有宽限的话，从父项斜滑向子菜单必然
 *            路过下一行，子菜单在够到之前就被关了（用户只能退化成点击）；
 *          · 父项在子菜单展开期间保持 bg-hover 常亮（看得出子菜单从哪长出来）；
 *          · 键盘不吃宽限：↑↓ 离开父项立刻收起（Win11 同款）。
 *   置灰项 aria-disabled + opacity-40 + cursor-not-allowed + 不响应 hover 背景；
 *          点了**什么都不发生**（不报错、不关菜单），hover 用 title 说明「开发中」
 *
 * 视觉规格（实测提取值，改动前先回看 UPGRADE_PLAN 3.2 的规格段）：
 *   菜单卡 rounded-card(12px) + p-1 + bg-layer + border-float + shadow-lv3，宽 218–360px
 *   菜单项 min-h-10 + px-2.5 py-2 + gap-2 + rounded-[10px] + text-ui；hover 背景**不加 transition**
 *   图标恒比文字淡一档（text-tertiary）；分隔线 h-px + border-l1 + my-1 mx-0.5
 *   **无进出场动画**（参考项目的菜单是直出）——所以定位靠「先隐形量一次再落位」，不是淡入
 *
 * 纪律：本文件不 import @tauri-apps/api（ESLint 已强制），不写内联中文文案（注释除外）。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { t } from "../i18n/zh-CN";

/* ── 数据模型（UI 契约；具体条目见 contextMenuItems.ts） ────────── */

/** 前置图标名：条目定义层只写名字，图形收在本文件，两层互不牵连 */
export type MenuIconName =
  | "copy"
  | "plainText"
  | "markdown"
  | "export"
  | "share"
  | "obsidian"
  | "browser"
  | "editor"
  | "folder"
  | "print"
  | "zen"
  | "zoom"
  | "theme"
  | "info"
  | "link"
  | "image"
  | "file"
  | "pin"
  | "unpin"
  | "remove";

interface MenuNodeBase {
  /** React key 与内部寻址用，同一套菜单内唯一 */
  readonly id: string;
  readonly label: string;
  readonly icon?: MenuIconName;
  /**
   * 应用真实图标（`data:image/png;base64,…`，批次 5.7 编辑器子菜单用）。
   * 与 `icon` 同槽渲染、优先级更高：有真图标就不画手绘图形。
   */
  readonly iconUrl?: string;
  /**
   * 条件不满足（如无选区、无当前文档）→ 置灰但**不**提示「开发中」。
   * 与 pending 的区别是：disabled 是"此刻不可用"，pending 是"还没做"。
   */
  readonly disabled?: boolean;
  /** 功能尚未落地：置灰 + hover 提示「开发中」（DG 6.4 全局条 B：不许点了才知道没做） */
  readonly pending?: boolean;
}

export interface MenuActionItem extends MenuNodeBase {
  readonly kind: "item";
  /** 右侧快捷键提示，如 Ctrl+C；只写已经真的注册了的键 */
  readonly shortcut?: string;
  /** 危险项（如「从列表移除」）：text-danger + hover:bg-hover-danger */
  readonly danger?: boolean;
  /** 单选组成员（缩放档位 / 主题三态）：role=menuitemradio，选中项前置对勾 */
  readonly checkable?: boolean;
  readonly checked?: boolean;
  /** 置灰项可以不给（点了本就什么都不做） */
  readonly run?: () => void;
}

export interface MenuSubmenuItem extends MenuNodeBase {
  readonly kind: "submenu";
  readonly items: readonly MenuNode[];
}

export interface MenuSeparator {
  readonly kind: "separator";
  readonly id: string;
}

export type MenuNode = MenuActionItem | MenuSubmenuItem | MenuSeparator;

/* ── 几何：边界翻转 ─────────────────────────────────────────────── */

/** 触发点与根菜单之间的间隙 */
const ANCHOR_GAP = 4;
/** 菜单与窗口边缘的最小留白 */
const VIEWPORT_MARGIN = 8;
/** 菜单卡自身的 padding（p-1）：子菜单纵向对齐父项时要把它补回去 */
const CARD_PADDING = 4;
/** 菜单卡描边宽度（border）：纵向对齐同样要补 */
const CARD_BORDER = 1;
/** 子菜单压在父菜单卡边缘上的重叠量（Win11 同款；留缝会变成两座分离的岛） */
const SUBMENU_OVERLAP = 4;
/**
 * 悬停宽限（批次 5.6）：指针滑到兄弟项后延迟这么久才真正收起子菜单。
 * 取值参考 Radix（300）与 Win11（约 400）的下沿——太长会显得菜单"反应迟钝"。
 */
const SUBMENU_CLOSE_GRACE_MS = 280;

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * 子菜单锚点：横向取**父菜单卡**的左右缘（重叠定位的基准），
 * 纵向取**父项行**的顶边（首行对齐的基准）。只取需要的三个数，不搬整个 DOMRect。
 */
interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
}

interface Position {
  readonly left: number;
  readonly top: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 根层：以鼠标点为锚点。
 * 右边放不下就翻到点的左侧、下边放不下就翻到点的上方；翻完仍越界（菜单比可用空间还大）
 * 再夹回视口——两步都做，才不会出现"翻过去照样被裁"。
 */
function placeAtPoint(
  point: Point,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
): Position {
  let left = point.x + ANCHOR_GAP;
  if (left + width > viewWidth - VIEWPORT_MARGIN) {
    left = point.x - ANCHOR_GAP - width;
  }
  let top = point.y + ANCHOR_GAP;
  if (top + height > viewHeight - VIEWPORT_MARGIN) {
    top = point.y - ANCHOR_GAP - height;
  }
  return {
    left: clamp(left, VIEWPORT_MARGIN, viewWidth - VIEWPORT_MARGIN - width),
    top: clamp(top, VIEWPORT_MARGIN, viewHeight - VIEWPORT_MARGIN - height),
  };
}

/**
 * 子菜单：压在父菜单卡右缘上（重叠 SUBMENU_OVERLAP），放不下翻到左缘同样重叠；
 * 纵向让子菜单**第一行**与父项行顶精确对齐（把卡 padding 与描边补回去）后夹回视口。
 * 重叠而不是留缝，是「子菜单长在父菜单上」观感的全部来源（批次 5.6，对标 Win11）。
 */
function placeBesideRect(
  rect: AnchorRect,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
): Position {
  let left = rect.right - SUBMENU_OVERLAP;
  if (left + width > viewWidth - VIEWPORT_MARGIN) {
    left = rect.left - width + SUBMENU_OVERLAP;
  }
  return {
    left: clamp(left, VIEWPORT_MARGIN, viewWidth - VIEWPORT_MARGIN - width),
    top: clamp(
      rect.top - CARD_PADDING - CARD_BORDER,
      VIEWPORT_MARGIN,
      viewHeight - VIEWPORT_MARGIN - height,
    ),
  };
}

/* ── 图标：内联手绘，不引依赖（与 App.tsx 同一套画法：24 视窗 / stroke 1.5 / currentColor） ── */

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

/** 前置图标 16px；子菜单箭头与对勾复用同一套画法 */
function MenuIcon({ name }: { readonly name: MenuIconName }) {
  switch (name) {
    case "copy":
      return (
        <Glyph size={16}>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h8" />
        </Glyph>
      );
    case "plainText":
      return (
        <Glyph size={16}>
          <path d="M4 6h16M4 11h13M4 16h16M4 21h9" />
        </Glyph>
      );
    case "markdown":
      return (
        <Glyph size={16}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M6.5 15.5v-7l3 3.5 3-3.5v7M17 8.5v7M14.5 13l2.5 2.5 2.5-2.5" />
        </Glyph>
      );
    case "export":
      return (
        <Glyph size={16}>
          <path d="M12 15V4m0 0-3.5 3.5M12 4l3.5 3.5" />
          <path d="M4.5 15v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
        </Glyph>
      );
    case "share":
      return (
        <Glyph size={16}>
          <circle cx="18" cy="5" r="2.5" />
          <circle cx="6" cy="12" r="2.5" />
          <circle cx="18" cy="19" r="2.5" />
          <path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3" />
        </Glyph>
      );
    case "obsidian":
      return (
        <Glyph size={16}>
          <path d="m12 3 7 6-7 12-7-12 7-6Z" />
          <path d="M5 9h14" />
        </Glyph>
      );
    case "browser":
      return (
        <Glyph size={16}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z" />
        </Glyph>
      );
    case "editor":
      return (
        <Glyph size={16}>
          <path d="M11 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V13" />
          <path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4 7.5-7.5Z" />
        </Glyph>
      );
    case "folder":
      return (
        <Glyph size={16}>
          <path d="M4 18.5V6.5A1.5 1.5 0 0 1 5.5 5h3.6l2 2.5H18a1.5 1.5 0 0 1 1.5 1.5v1.5" />
          <path d="M4 18.5 6.3 12.4a1.5 1.5 0 0 1 1.4-.9H21l-2.3 6.1a1.5 1.5 0 0 1-1.4 1H4Z" />
        </Glyph>
      );
    case "print":
      return (
        <Glyph size={16}>
          <path d="M7 9V4h10v5" />
          <path d="M7 18H5.5A1.5 1.5 0 0 1 4 16.5v-5A2.5 2.5 0 0 1 6.5 9h11a2.5 2.5 0 0 1 2.5 2.5v5a1.5 1.5 0 0 1-1.5 1.5H17" />
          <rect x="7" y="14" width="10" height="6" rx="1" />
        </Glyph>
      );
    case "zen":
      return (
        <Glyph size={16}>
          <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
        </Glyph>
      );
    case "zoom":
      return (
        <Glyph size={16}>
          <circle cx="11" cy="11" r="7" />
          <path d="M8.5 11h5M11 8.5v5M20 20l-3.6-3.6" />
        </Glyph>
      );
    case "theme":
      return (
        <Glyph size={16}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
        </Glyph>
      );
    case "info":
      return (
        <Glyph size={16}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5.5M12 7.8h.01" />
        </Glyph>
      );
    case "link":
      return (
        <Glyph size={16}>
          <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.4 1.4" />
          <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.4-1.4" />
        </Glyph>
      );
    case "image":
      return (
        <Glyph size={16}>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <circle cx="8.5" cy="10" r="1.5" />
          <path d="m4 17 4.5-4.5 3.5 3.5 3-3 5 5" />
        </Glyph>
      );
    case "file":
      return (
        <Glyph size={16}>
          <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
          <path d="M13.5 3v5.5H19" />
        </Glyph>
      );
    case "pin":
      return (
        <Glyph size={16}>
          <path d="M12 20V8M8 12l4-4 4 4M5 4h14" />
        </Glyph>
      );
    case "unpin":
      return (
        <Glyph size={16}>
          <path d="M12 4v12M8 12l4 4 4-4M5 20h14" />
        </Glyph>
      );
    case "remove":
      return (
        <Glyph size={16}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 12h7" />
        </Glyph>
      );
    default:
      return null;
  }
}

function IconCheck() {
  return (
    <Glyph size={16}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Glyph>
  );
}

/** 子菜单箭头：与分组标题同款 12px 三角，颜色同前置图标（tertiary） */
function IconSubmenuArrow() {
  return (
    <Glyph size={12}>
      <path d="m9.5 5 7 7-7 7" />
    </Glyph>
  );
}

/* ── 单级菜单面板 ───────────────────────────────────────────────── */

/** 展开中的子菜单：连同父项矩形与"是否键盘展开"一起记，重定位与焦点策略都要用 */
interface OpenSubmenu {
  readonly index: number;
  readonly node: MenuSubmenuItem;
  readonly rect: AnchorRect;
  readonly viaKeyboard: boolean;
}

interface MenuPanelProps {
  readonly items: readonly MenuNode[];
  /** 根层：鼠标点定位（与 parentRect 二选一） */
  readonly point: Point | null;
  /** 子菜单：父项矩形定位 */
  readonly parentRect: AnchorRect | null;
  /**
   * 子菜单的挂载点。**必须挂到本面板之外**：菜单卡自身是 overflow-y:auto 的滚动容器，
   * 子菜单若作为它的后代节点会被裁掉半截。用 portal 送到公共 wrapper 下，
   * DOM 上与根面板平级，React 树上仍是父面板的子节点（状态与回调都不用往上抬）。
   */
  readonly portalTarget: HTMLElement | null;
  /** 无障碍名：根层用触发上下文名，子菜单用父项文案 */
  readonly label: string;
  /** 打开时是否把焦点送进本级（hover 展开的子菜单不抢焦点） */
  readonly autoFocus: boolean;
  /** 关闭整棵菜单（点条目后 / Esc） */
  readonly onCloseAll: () => void;
  /** ← 键：收起本级并把焦点还给父项；根层为 null */
  readonly onCollapse: (() => void) | null;
  /**
   * 指针进入本面板时通知父级「别关我」（取消宽限计时）。
   * 根层没有父级，为 null；子菜单不挂这个就够不着宽限机制。
   */
  readonly onKeepAlive: (() => void) | null;
}

function MenuPanel({
  items,
  point,
  parentRect,
  portalTarget,
  label,
  autoFocus,
  onCloseAll,
  onCollapse,
  onKeepAlive,
}: MenuPanelProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** 当前项在 items 中的下标；只服务键盘寻址，不参与渲染，故用 ref 不用 state */
  const activeIndex = useRef(-1);
  const focusedOnce = useRef(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [submenu, setSubmenu] = useState<OpenSubmenu | null>(null);
  /** 宽限计时器（批次 5.6）：滑到兄弟项 → 延迟收起子菜单；进入子菜单/折回父项 → 取消 */
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelScheduledClose = useCallback(() => {
    if (graceTimer.current !== null) {
      clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
  }, []);

  const scheduleSubmenuClose = useCallback(() => {
    cancelScheduledClose();
    graceTimer.current = setTimeout(() => {
      graceTimer.current = null;
      setSubmenu(null);
    }, SUBMENU_CLOSE_GRACE_MS);
  }, [cancelScheduledClose]);

  // 卸载时清掉在途计时器：整棵菜单关闭后不许有幽灵 setSubmenu 落在已卸载组件上
  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);

  /** 可聚焦项的下标表（分隔线不进）：置灰项**保留**在表内——用户要能走到它、读到「开发中」 */
  const focusables = useMemo(
    () =>
      items
        .map((node, index) => (node.kind === "separator" ? -1 : index))
        .filter((index) => index >= 0),
    [items],
  );

  /**
   * 落位：先以隐形状态按内容量一次实际尺寸，再算翻转后的坐标。
   * useLayoutEffect 保证这一切发生在浏览器绘制之前——菜单没有进出场动画，
   * 任何"先画在错位置再跳过去"都会被看见。
   */
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    const box = card.getBoundingClientRect();
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    setPosition(
      parentRect !== null
        ? placeBesideRect(parentRect, box.width, box.height, viewWidth, viewHeight)
        : placeAtPoint(
            point ?? { x: 0, y: 0 },
            box.width,
            box.height,
            viewWidth,
            viewHeight,
          ),
    );
  }, [items, parentRect, point]);

  const focusAt = useCallback(
    (cursor: number) => {
      if (focusables.length === 0) {
        return;
      }
      const wrapped = ((cursor % focusables.length) + focusables.length) % focusables.length;
      const index = focusables[wrapped];
      if (index === undefined) {
        return;
      }
      // 当前项自己记账，不等 focus 事件回灌：窗口未获得焦点时（应用在后台、
      // 自动化环境）Chromium 只改 activeElement 而不派发 focus 事件，
      // 靠事件同步的话方向键会集体失灵
      activeIndex.current = index;
      // 不加 preventScroll：菜单超高时自身可滚动，键盘导航必须把当前项带进视野
      buttonRefs.current[index]?.focus();
      // 焦点离开子菜单父项即收起该子菜单（同一时刻只展开一条支路）
      setSubmenu((current) => (current !== null && current.index === index ? current : null));
    },
    [focusables],
  );

  /**
   * 打开时焦点进第一项。hover 展开的子菜单**不抢焦点**（autoFocus=false），
   * 焦点留在父项上，↑↓ 仍在父级移动——这是鼠标划过菜单时不该被劫持的手感；
   * 之后用户按 → 展开同一条支路时 autoFocus 才翻 true，本效应随即把焦点送进来。
   */
  useEffect(() => {
    if (position === null || focusedOnce.current || !autoFocus) {
      return;
    }
    focusedOnce.current = true;
    focusAt(0);
  }, [position, autoFocus, focusAt]);

  const openSubmenu = useCallback(
    (index: number, node: MenuSubmenuItem, viaKeyboard: boolean) => {
      const button = buttonRefs.current[index];
      const card = cardRef.current;
      if (button === null || button === undefined || card === null) {
        return;
      }
      cancelScheduledClose();
      const buttonBox = button.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      // 横向锚定**卡**缘（重叠定位），纵向锚定**行**顶（首行对齐）——见 AnchorRect 注释
      const rect: AnchorRect = {
        left: cardBox.left,
        top: buttonBox.top,
        right: cardBox.right,
      };
      setSubmenu((current) =>
        current !== null && current.index === index && !viaKeyboard
          ? current
          : { index, node, rect, viaKeyboard },
      );
    },
    [cancelScheduledClose],
  );

  const collapseSubmenu = useCallback(() => {
    setSubmenu((current) => {
      if (current !== null) {
        buttonRefs.current[current.index]?.focus();
      }
      return null;
    });
  }, []);

  /** 条目激活：置灰项一律「什么都不发生」——不执行、不关菜单、更不报错 */
  const activate = useCallback(
    (index: number) => {
      const node = items[index];
      if (node === undefined || node.kind === "separator") {
        return;
      }
      if (node.disabled === true || node.pending === true) {
        return;
      }
      if (node.kind === "submenu") {
        openSubmenu(index, node, true);
        return;
      }
      onCloseAll();
      node.run?.();
    },
    [items, onCloseAll, openSubmenu],
  );

  const handlePointerEnter = useCallback(
    (index: number) => {
      const node = items[index];
      if (node === undefined || node.kind === "separator") {
        return;
      }
      // 焦点跟随指针：键盘与鼠标共用同一枚「当前项」，两种操作方式随时可以接力
      activeIndex.current = index;
      buttonRefs.current[index]?.focus({ preventScroll: true });
      if (node.kind === "submenu" && node.disabled !== true && node.pending !== true) {
        // 折回已展开的父项 = 取消在途的宽限关闭（openSubmenu 内已做）
        openSubmenu(index, node, false);
        return;
      }
      // 滑到兄弟项**不立刻**收起——没有宽限，斜滑向子菜单的路径必然被下一行打断
      scheduleSubmenuClose();
    },
    [items, openSubmenu, scheduleSubmenuClose],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const cursor = focusables.indexOf(activeIndex.current);
      const current = items[activeIndex.current];

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusAt(cursor + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          focusAt(cursor - 1);
          return;
        case "Home":
          event.preventDefault();
          focusAt(0);
          return;
        case "End":
          event.preventDefault();
          focusAt(focusables.length - 1);
          return;
        case "Tab":
          // 焦点陷阱：菜单打开期间不允许 Tab 把焦点带出去
          event.preventDefault();
          focusAt(event.shiftKey ? cursor - 1 : cursor + 1);
          return;
        case "ArrowRight":
          if (
            current !== undefined &&
            current.kind === "submenu" &&
            current.disabled !== true &&
            current.pending !== true
          ) {
            event.preventDefault();
            openSubmenu(activeIndex.current, current, true);
          }
          return;
        case "ArrowLeft":
          if (onCollapse !== null) {
            event.preventDefault();
            onCollapse();
          }
          return;
        case "Escape":
          // Esc 一律关闭整棵菜单（子菜单单独收起走 ← 键，规格如此）；
          // 不让它继续冒泡到 App 的 Esc 语义链，否则会顺手把大纲/查找条也收了
          event.preventDefault();
          event.stopPropagation();
          onCloseAll();
          return;
        default:
          // Enter / Space 交给 button 原生激活（onClick），此处不重复处理，避免触发两次
          return;
      }
    },
    [focusAt, focusables, items, onCloseAll, onCollapse, openSubmenu],
  );

  return (
    <>
      <div
        ref={cardRef}
        role="menu"
        aria-label={label}
        data-context-menu=""
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        // 子菜单面板：指针进来即通知父级取消宽限关闭（本面板就是被宽限保护的对象）
        onPointerEnter={onKeepAlive ?? undefined}
        // 本级自身滚动（菜单超高时）会让父项挪位，已展开的子菜单会停在旧坐标上，
        // 干脆收起——重新 hover 一次就是新位置，比跟着重算便宜也更稳
        onScroll={() => {
          setSubmenu(null);
        }}
        // 菜单上再次右键不叠开第二层（App 的全局监听也会挡一道，这里是就近防线）
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          // 量尺寸的那一帧先隐形：无进出场动画的菜单不能让人看见"先错位再跳正"
          visibility: position === null ? "hidden" : "visible",
        }}
        // 刻意不挂 .quiet-bars：那条工具类带 scrollbar-gutter:stable，会给**每一张**
        // 菜单卡右侧留出 8px 永久空槽（条目底色到不了右边、子菜单也会往里错位）。
        // 菜单只在超高时才滚，用默认滚动条样式即可。
        className="fixed z-50 flex max-h-[calc(100vh-16px)] min-w-[218px] max-w-[360px] select-none flex-col overflow-y-auto overflow-x-hidden overscroll-contain rounded-card border border-float bg-layer p-1 shadow-lv3"
      >
        {items.map((node, index) => {
          if (node.kind === "separator") {
            return (
              <div
                key={node.id}
                role="separator"
                className="mx-0.5 my-1 h-px shrink-0 bg-[var(--md-border-l1)]"
              />
            );
          }

          const inactive = node.disabled === true || node.pending === true;
          const isSubmenu = node.kind === "submenu";
          const danger = node.kind === "item" && node.danger === true;
          const checkable = node.kind === "item" && node.checkable === true;
          const checked = node.kind === "item" && node.checked === true;

          return (
            <button
              key={node.id}
              ref={(element) => {
                buttonRefs.current[index] = element;
              }}
              type="button"
              // 单选组（缩放档位 / 主题三态）用 menuitemradio 表达选中态，其余一律 menuitem
              role={checkable ? "menuitemradio" : "menuitem"}
              aria-checked={checkable ? checked : undefined}
              // 用 aria-disabled 而非原生 disabled：置灰项仍要可聚焦、可 hover，
              // 否则用户既读不到「开发中」，键盘也走不到它（DG 6.4 全局条 B）
              aria-disabled={inactive ? true : undefined}
              aria-haspopup={isSubmenu ? "menu" : undefined}
              aria-expanded={isSubmenu ? submenu?.index === index : undefined}
              title={node.pending === true ? `${node.label}${t.common.comingSoonSuffix}` : undefined}
              tabIndex={-1}
              onClick={() => {
                activate(index);
              }}
              onPointerEnter={() => {
                handlePointerEnter(index);
              }}
              onFocus={() => {
                activeIndex.current = index;
              }}
              className={`flex min-h-10 w-full shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] px-2.5 py-2 text-left text-ui ${
                danger ? "text-danger" : "text-primary"
              } ${
                inactive
                  ? "cursor-not-allowed opacity-40"
                  : danger
                    ? "hover:bg-hover-danger"
                    : "hover:bg-hover"
              } ${
                // 子菜单展开期间父项保持常亮（批次 5.6）：指针已进入子菜单、hover 态
                // 早就不在了，没有这条就看不出子菜单从哪长出来
                isSubmenu && submenu?.index === index ? "bg-hover" : ""
              }`}
            >
              {/* 前置图标槽恒占 16px：单选组放对勾 > 应用真图标 > 手绘图形，空着也保持左缘对齐 */}
              <span
                aria-hidden
                className="flex h-4 w-4 shrink-0 items-center justify-center text-tertiary"
              >
                {checkable ? (
                  checked ? (
                    <IconCheck />
                  ) : null
                ) : node.iconUrl !== undefined ? (
                  // 32px 源渲染在 16px 槽：150% DPI 下仍然锐利；alt 留空 + aria-hidden，纯装饰
                  <img
                    src={node.iconUrl}
                    alt=""
                    draggable={false}
                    className="h-4 w-4 select-none"
                  />
                ) : node.icon === undefined ? null : (
                  <MenuIcon name={node.icon} />
                )}
              </span>

              <span className="min-w-0 flex-1 truncate">{node.label}</span>

              {node.kind === "item" && node.shortcut !== undefined ? (
                <span className="shrink-0 text-ui-xs text-tertiary">{node.shortcut}</span>
              ) : null}

              {isSubmenu ? (
                <span aria-hidden className="flex shrink-0 items-center text-tertiary">
                  <IconSubmenuArrow />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {submenu === null || portalTarget === null
        ? null
        : createPortal(
            <MenuPanel
              key={submenu.node.id}
              items={submenu.node.items}
              point={null}
              parentRect={submenu.rect}
              portalTarget={portalTarget}
              label={submenu.node.label}
              autoFocus={submenu.viaKeyboard}
              onCloseAll={onCloseAll}
              onCollapse={collapseSubmenu}
              onKeepAlive={cancelScheduledClose}
            />,
            portalTarget,
          )}
    </>
  );
}

/* ── 对外组件 ───────────────────────────────────────────────────── */

export interface ContextMenuProps {
  /** 鼠标点（clientX/clientY）；菜单以它为锚点并做边界翻转 */
  readonly anchor: Point;
  readonly items: readonly MenuNode[];
  /** 无障碍名（哪一套菜单） */
  readonly label: string;
  readonly onClose: () => void;
}

/**
 * 同一时刻只允许一个菜单：调用方用单个 state 承载，换菜单时换 key 让本组件整体重挂，
 * 内部状态（展开的子菜单、焦点）随之归零，不必写额外的重置逻辑。
 */
export function ContextMenu({ anchor, items, label, onClose }: ContextMenuProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  /** 触发元素：关闭后焦点必须回到它，否则焦点掉到 body，键盘翻页当场失效 */
  const restoreRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setPortalTarget(wrapperRef.current);
  }, []);

  // 必须是 layout effect：面板把焦点收进第一项是在 passive effect 里做的，
  // 用 useEffect 记录会有"记到菜单自己身上"的时序风险，归还焦点就成了空转
  useLayoutEffect(() => {
    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement ? active : null;
    return () => {
      const target = restoreRef.current;
      if (target !== null && target.isConnected && target !== document.body) {
        // preventScroll：焦点归还不能顺带把阅读位置拽走（军规 1）
        target.focus({ preventScroll: true });
      }
    };
  }, []);

  /* 关闭：点外部 / 外部滚动 / resize / 窗口 blur（点条目与 Esc 在面板内处理） */
  useEffect(() => {
    const isInside = (node: EventTarget | null): boolean =>
      node instanceof Node && wrapperRef.current !== null && wrapperRef.current.contains(node);

    const onPointerDown = (event: PointerEvent): void => {
      if (!isInside(event.target)) {
        onClose();
      }
    };
    // 菜单自身超高时的内部滚动不算"页面滚走了"，不能因此关掉自己
    const onScroll = (event: Event): void => {
      if (!isInside(event.target)) {
        onClose();
      }
    };
    const onWindowChange = (): void => {
      onClose();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    // scroll 不冒泡，必须在捕获阶段听
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onWindowChange);
    window.addEventListener("blur", onWindowChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("blur", onWindowChange);
    };
  }, [onClose]);

  return (
    // display:contents —— wrapper 只是子菜单的 portal 挂载点与"点外部"判定边界，
    // 不能在布局里占位（它挂在应用外壳的 flex 容器里）
    <div ref={wrapperRef} className="contents">
      <MenuPanel
        items={items}
        point={anchor}
        parentRect={null}
        portalTarget={portalTarget}
        label={label}
        autoFocus
        onCloseAll={onClose}
        onCollapse={null}
        onKeepAlive={null}
      />
    </div>
  );
}
