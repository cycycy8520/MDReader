/**
 * 四套右键菜单的条目定义 —— **逐行照抄 UPGRADE_PLAN 附录 A**（该附录是唯一规格源）。
 *
 * 为什么与 ContextMenu.tsx 分开：附录 A 的验收方式是"实物与规格逐项对拍"，
 * 条目排布跟 UI 细节混在一起就没法读。本文件只产出数据（顺序、分组、置灰、文案、动作），
 * 不含任何 DOM/样式；动作实现由 App.tsx 以 `ContextMenuActions` 注入，
 * 因此这里既不碰 store，也不碰 ipc。
 *
 * 【点亮批次】附录 A 的「点亮」列 = 该项从置灰变可用的批次。当前已点亮：
 *   复制 / 复制为纯文本 / 复制全文源、用其他编辑器打开、在资源管理器中显示、
 *   缩放 ▸、主题 ▸、关于 MDNaonao，以及最近列表那一套
 *   （打开 / 打开所在文件夹 / 复制路径 / 置顶 / 移除）。
 * 其余一律 `pending: true`（置灰 + hover 提示「开发中」），**照画不省**——
 * 用户要看到完整的产品形态，而不是一份被裁剪过的菜单：
 *   导出 ▸ / 在浏览器中打开 / 打印…            → M2
 *   分享 ▸ / 导入 Obsidian…                     → M3（v1.1 生态版）
 *   禅模式 F11                                   → 3.3 尚未实现，先置灰（不为它临时造半成品）
 *
 * 置灰的子菜单父项（导出 / 分享）**不展开**：hover 无背景、cursor-not-allowed，
 * 与「禁用项不响应 hover」的规格一致；子项定义仍然写在这里，供对拍附录 A，
 * 等父项在 M2/M3 点亮时同一处改一行 pending 即可。
 */

import { t } from "../i18n/zh-CN";
import { ZOOM_PRESETS } from "../stores/settings";
import type { RecentFile, Theme } from "../types";
import type { MenuNode } from "./ContextMenu";

/* ── 执行入口（全部由 App 注入） ─────────────────────────────────── */

export interface ContextMenuActions {
  /** 通用复制：链接地址 / 图片地址 / 文件路径 */
  readonly copyText: (text: string) => void;
  /** 复制选区原文（保留换行结构） */
  readonly copySelection: () => void;
  /** 复制选区并去格式（归一化空白与零宽字符） */
  readonly copySelectionPlain: () => void;
  /** 复制当前文档的 Markdown 全文源 */
  readonly copySource: () => void;
  readonly revealPath: (path: string) => void;
  readonly openWithDefaultApp: (path: string) => void;
  readonly openExternalUrl: (url: string) => void;
  /** 应用内打开一篇 .md（hash 为空串表示不跳锚点） */
  readonly openDocument: (path: string, hash: string) => void;
  readonly setZoom: (percent: number) => void;
  readonly resetZoom: () => void;
  readonly setTheme: (theme: Theme) => void;
  readonly openRecent: (path: string) => void;
  readonly toggleRecentPinned: (path: string) => void;
  readonly removeRecent: (path: string) => void;
  /**
   * 打开「关于 MDNaonao」对话框。
   * 对话框本体**刻意不放在菜单层**（ContextMenu 只管菜单，不该长出第二种浮层）：
   * 由 App.tsx 持有开合状态并渲染，这里只发一个「请打开」的信号。
   */
  readonly showAbout: () => void;
}

/** 正文 / 链接 / 图片三套菜单共用的上下文 */
export interface DocumentMenuInput {
  /** 右键时是否存在非空选区（决定「复制」两项是否可用） */
  readonly hasSelection: boolean;
  /** 当前文档路径；null = 空状态，凡是要路径的条目一律置灰 */
  readonly documentPath: string | null;
  readonly zoomPercent: number;
  readonly theme: Theme;
  readonly actions: ContextMenuActions;
}

/** 链接目标：外链与本地 .md **二选一**（附录 A.2 的注解） */
export type LinkTarget =
  | { readonly kind: "external"; readonly url: string }
  | {
      readonly kind: "document";
      readonly path: string;
      readonly hash: string;
      readonly address: string;
    }
  /** 其余协议（mailto: 之类）：只留「复制链接地址」，不给打开动作 */
  | { readonly kind: "other"; readonly address: string };

export type ImageTarget =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "external"; readonly url: string };

/* ── 组装工具 ───────────────────────────────────────────────────── */

function separator(id: string): MenuNode {
  return { kind: "separator", id };
}

const THEME_OPTIONS: readonly { readonly value: Theme; readonly label: string }[] = [
  { value: "system", label: t.status.themeSystem },
  { value: "light", label: t.status.themeLight },
  { value: "dark", label: t.status.themeDark },
];

/* ── 附录 A.1 正文菜单的五个分组 ───────────────────────────────── */

/**
 * 复制组（附录 A.1 第 1 段）：复制 / 复制为纯文本 / 复制全文 Markdown 源。
 *
 * 「复制」与「复制为纯文本」的区别：前者按选区原样写入剪贴板（保留换行与缩进），
 * 后者额外做去格式（收尾空白、零宽字符、连续空行归一）。带样式的富文本复制要等
 * clipboard-manager 的 write_html（M2 才接），届时「复制」升级为富文本，两项自然分家。
 */
function copyGroup(input: DocumentMenuInput): MenuNode[] {
  const { hasSelection, documentPath, actions } = input;
  return [
    {
      kind: "item",
      id: "copy-selection",
      label: t.common.copy,
      icon: "copy",
      shortcut: "Ctrl+C",
      disabled: !hasSelection,
      run: actions.copySelection,
    },
    {
      kind: "item",
      id: "copy-selection-plain",
      label: t.contextMenu.copyPlain,
      icon: "plainText",
      disabled: !hasSelection,
      run: actions.copySelectionPlain,
    },
    {
      kind: "item",
      id: "copy-source",
      label: t.contextMenu.copySource,
      icon: "markdown",
      disabled: documentPath === null,
      run: actions.copySource,
    },
  ];
}

/** 导出与分享组（附录 A.1 第 2 段）：整组待点亮，M2/M3 */
function exportGroup(): MenuNode[] {
  return [
    {
      kind: "submenu",
      id: "export",
      label: t.contextMenu.export,
      icon: "export",
      pending: true,
      items: [
        { kind: "item", id: "export-html", label: t.contextMenu.exportHtml, pending: true },
        { kind: "item", id: "export-pdf", label: t.contextMenu.exportPdf, pending: true },
        {
          kind: "item",
          id: "export-long-image",
          label: t.contextMenu.exportLongImage,
          pending: true,
        },
      ],
    },
    {
      kind: "submenu",
      id: "share",
      label: t.contextMenu.share,
      icon: "share",
      pending: true,
      items: [
        {
          kind: "item",
          id: "share-wechat-image",
          label: t.contextMenu.shareWechatImage,
          pending: true,
        },
        {
          kind: "item",
          id: "share-wechat-rich",
          label: t.contextMenu.shareWechatRich,
          pending: true,
        },
        { kind: "item", id: "share-feishu", label: t.contextMenu.shareFeishu, pending: true },
        {
          kind: "item",
          id: "share-dingtalk",
          label: t.contextMenu.shareDingtalk,
          pending: true,
        },
      ],
    },
    {
      kind: "item",
      id: "import-obsidian",
      label: t.contextMenu.importObsidian,
      icon: "obsidian",
      pending: true,
    },
  ];
}

/** 打开方式组（附录 A.1 第 3 段）：中间两项本批次点亮，两头等 M2 */
function openGroup(input: DocumentMenuInput): MenuNode[] {
  const { documentPath, actions } = input;
  return [
    {
      kind: "item",
      id: "open-in-browser",
      label: t.contextMenu.openInBrowser,
      icon: "browser",
      pending: true,
    },
    {
      kind: "item",
      id: "open-with-editor",
      label: t.contextMenu.openWithEditor,
      icon: "editor",
      disabled: documentPath === null,
      run:
        documentPath === null
          ? undefined
          : () => {
              actions.openWithDefaultApp(documentPath);
            },
    },
    {
      kind: "item",
      id: "reveal-document",
      label: t.contextMenu.revealInExplorer,
      icon: "folder",
      disabled: documentPath === null,
      run:
        documentPath === null
          ? undefined
          : () => {
              actions.revealPath(documentPath);
            },
    },
    {
      kind: "item",
      id: "print",
      label: t.contextMenu.print,
      icon: "print",
      shortcut: "Ctrl+P",
      pending: true,
    },
  ];
}

/** 视图组（附录 A.1 第 4 段）：缩放与主题在批次 1 已接线，禅模式（3.3）未实现故置灰 */
function viewGroup(input: DocumentMenuInput): MenuNode[] {
  const { zoomPercent, theme, actions } = input;
  return [
    {
      kind: "item",
      id: "zen-mode",
      label: t.contextMenu.zen,
      icon: "zen",
      shortcut: "F11",
      pending: true,
    },
    {
      kind: "submenu",
      id: "zoom",
      // 父项文案带当前档位，和状态栏那颗 zoom% 按钮读到的是同一个值
      label: t.contextMenu.zoomWith(zoomPercent),
      icon: "zoom",
      items: [
        ...ZOOM_PRESETS.map(
          (preset): MenuNode => ({
            kind: "item",
            id: `zoom-${preset}`,
            // 纯数字档位是技术值，不进 i18n
            label: `${preset}%`,
            checkable: true,
            checked: preset === zoomPercent,
            run: () => {
              actions.setZoom(preset);
            },
          }),
        ),
        {
          kind: "item",
          id: "zoom-reset",
          label: t.contextMenu.zoomReset,
          run: actions.resetZoom,
        },
      ],
    },
    {
      kind: "submenu",
      id: "theme",
      label: t.contextMenu.theme,
      icon: "theme",
      items: THEME_OPTIONS.map(
        (option): MenuNode => ({
          kind: "item",
          id: `theme-${option.value}`,
          label: option.label,
          checkable: true,
          checked: option.value === theme,
          run: () => {
            actions.setTheme(option.value);
          },
        }),
      ),
    },
  ];
}

/**
 * 关于组（附录 A.1 第 5 段）—— **已点亮**。
 *
 * 此前置灰的理由是「前端拿不到版本号」；版本号来源与对话框现由 App 层提供
 * （见 ContextMenuActions.showAbout 的注释），本处只负责发信号，不认识版本号也不认识浮层。
 * 「检查更新」入口仍属 M2，由对话框内部自行置灰，与菜单无关。
 */
function aboutGroup(input: DocumentMenuInput): MenuNode[] {
  return [
    {
      kind: "item",
      id: "about",
      label: t.contextMenu.about,
      icon: "info",
      run: input.actions.showAbout,
    },
  ];
}

/* ── 四套菜单 ───────────────────────────────────────────────────── */

/** 附录 A.1：正文菜单（在阅读区任意位置右键） */
export function buildDocumentMenu(input: DocumentMenuInput): MenuNode[] {
  return [
    ...copyGroup(input),
    separator("sep-copy"),
    ...exportGroup(),
    separator("sep-export"),
    ...openGroup(input),
    separator("sep-open"),
    ...viewGroup(input),
    separator("sep-view"),
    ...aboutGroup(input),
  ];
}

/**
 * 附录 A.2：链接上右键 —— 链接组追加在正文菜单**之上**，其后接
 * 「正文菜单的复制组与视图组」（附录原文如此：导出组与打开方式组不进链接菜单）。
 */
export function buildLinkMenu(
  input: DocumentMenuInput & { readonly link: LinkTarget },
): MenuNode[] {
  const { link, actions } = input;
  const head: MenuNode[] = [];

  if (link.kind === "external") {
    head.push({
      kind: "item",
      id: "link-open-external",
      label: t.contextMenu.openLinkInBrowser,
      icon: "browser",
      run: () => {
        actions.openExternalUrl(link.url);
      },
    });
  }
  if (link.kind === "document") {
    head.push({
      kind: "item",
      id: "link-open-in-app",
      label: t.contextMenu.openLinkInApp,
      icon: "file",
      run: () => {
        actions.openDocument(link.path, link.hash);
      },
    });
  }

  const address = link.kind === "external" ? link.url : link.address;
  head.push({
    kind: "item",
    id: "link-copy-address",
    label: t.contextMenu.copyLinkAddress,
    icon: "link",
    run: () => {
      actions.copyText(address);
    },
  });

  return [
    ...head,
    separator("sep-link"),
    ...copyGroup(input),
    separator("sep-link-copy"),
    ...viewGroup(input),
  ];
}

/** 附录 A.2：图片上右键（「在资源管理器中显示」仅本地图片才出现） */
export function buildImageMenu(
  input: DocumentMenuInput & { readonly image: ImageTarget },
): MenuNode[] {
  const { image, actions } = input;
  const address = image.kind === "local" ? image.path : image.url;
  const head: MenuNode[] = [
    {
      kind: "item",
      id: "image-copy-address",
      label: t.contextMenu.copyImageAddress,
      icon: "image",
      run: () => {
        actions.copyText(address);
      },
    },
  ];

  if (image.kind === "local") {
    head.push({
      kind: "item",
      id: "image-reveal",
      label: t.contextMenu.revealInExplorer,
      icon: "folder",
      run: () => {
        actions.revealPath(image.path);
      },
    });
  }

  return [
    ...head,
    separator("sep-image"),
    ...copyGroup(input),
    separator("sep-image-copy"),
    ...viewGroup(input),
  ];
}

/** 附录 A.2：左栏最近文件条目右键（与 DG 5.3 一致；移除只离开列表，绝不删磁盘文件） */
export function buildRecentMenu(input: {
  readonly file: RecentFile;
  readonly actions: ContextMenuActions;
}): MenuNode[] {
  const { file, actions } = input;
  return [
    {
      kind: "item",
      id: "recent-open",
      label: t.contextMenu.openRecent,
      icon: "file",
      run: () => {
        actions.openRecent(file.path);
      },
    },
    {
      kind: "item",
      id: "recent-reveal",
      label: t.common.openFolder,
      icon: "folder",
      run: () => {
        actions.revealPath(file.path);
      },
    },
    {
      kind: "item",
      id: "recent-copy-path",
      label: t.common.copyPath,
      icon: "copy",
      run: () => {
        actions.copyText(file.path);
      },
    },
    separator("sep-recent-open"),
    {
      // 文案按当前状态切换（附录 A.2 的注解）
      kind: "item",
      id: "recent-pin",
      label: file.pinned ? t.contextMenu.unpin : t.contextMenu.pin,
      icon: file.pinned ? "unpin" : "pin",
      run: () => {
        actions.toggleRecentPinned(file.path);
      },
    },
    separator("sep-recent-pin"),
    {
      kind: "item",
      id: "recent-remove",
      label: t.common.remove,
      icon: "remove",
      danger: true,
      run: () => {
        actions.removeRecent(file.path);
      },
    },
  ];
}
