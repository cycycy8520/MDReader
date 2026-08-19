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
 *   缩放 ▸、主题 ▸、关于 MDNaonao，最近列表那一套
 *   （打开 / 打开所在文件夹 / 复制路径 / 置顶 / 移除），
 *   M2 点亮的 导出 ▸ HTML / PDF、打印…、禅模式 F11，
 *   以及 M3 本批次新点亮的：**导出 ▸ 长图 PNG、分享 ▸ 四项、导入 Obsidian…**。
 * 至此正文菜单**再无 pending 项**：最后一个「在浏览器中打开」已由后端专用命令点亮，
 * 且两道门一道都没放宽（理由见 openGroup 的注释）。
 *
 * 【点亮的前提】"点了真能用"，而不是"点了能弹出点什么"。所以本文件区分两种灰：
 *   `pending`  功能还没做（hover 提示「开发中」）；
 *   `disabled` 功能做好了，只是此刻条件不满足（无文档 / 无选区），不提示「开发中」。
 * 导出 / 分享 / 打印都吃 `disabled: documentPath === null`——空状态下没有可分享的东西。
 *
 * 【M3 对附录 A 的一处解读】「分享 ▸」的四个子项（微信长图 / 公众号富文本 / 飞书 / 钉钉）
 * 全部指向**同一张分享面板**（components/ShareDialog）。不在菜单层做四选一，是因为
 * 「粘到哪儿会得到什么」是平台约束决定的分组（DG 2.3-1：聊天窗口只吃纯文本，
 * 富文本容器才认 CF_HTML），面板已按收件端分了两组并逐条写清适用场景；菜单层再复述
 * 一遍必然两处漂移。四个入口保留是为了**可发现性**——它们是这个产品的差异化本身，
 * 从菜单里删掉等于把卖点藏起来。
 */

import { t } from "../i18n/zh-CN";
import { ZOOM_PRESETS } from "../stores/settings";
import type { RecentFile, Theme } from "../types";
import type { MenuNode } from "./ContextMenu";
import type { ExportKind } from "./ExportDialog";

/* ── 执行入口（全部由 App 注入） ─────────────────────────────────── */

/**
 * 后端探测到的一个本机编辑器（Rust: `shell_integ::EditorApp`）。
 *
 * `name` 是**产品名**（Visual Studio Code / Notepad++ / 记事本），由后端给出，
 * **刻意不进 i18n**：产品名不是可译文案，翻它只会翻错。
 */
export interface EditorApp {
  /** 稳定标识，用来拼菜单项 id */
  readonly id: string;
  /** 菜单里显示的产品名 */
  readonly name: string;
  /** 可执行文件绝对路径（后端已 is_file 校验过） */
  readonly path: string;
}

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
  /**
   * 「其他程序…」：弹系统「打开方式」对话框（Rust: `shell_integ::open_with_dialog`）。
   * 名字沿用历史叫法，它打开的**不是**默认程序——那样点了等于打开本应用自己。
   */
  readonly openWithDefaultApp: (path: string) => void;
  /**
   * 本机探测到的编辑器清单（Rust: `shell_integ::list_editors`），**顺序即菜单顺序**
   * （VS Code 系列在前，记事本垫底）。由 App 层在启动时取一次填进来。
   *
   * 为空数组时子菜单只留「其他程序…」——理论上不会发生（记事本是系统自带的兜底），
   * 但这里不假设它非空：探测失败就少列几项，绝不交付点了报错的菜单项。
   */
  readonly editors: readonly EditorApp[];
  /**
   * 用**指定**编辑器打开当前源文件（Rust: `shell_integ::open_in_editor`）。
   *
   * 传的是 `EditorApp.path`。后端**不信任这个值**，会重新探测一遍做白名单校验：
   * 这条命令等于「以本应用身份执行一个程序」，渲染层给的路径只能算 UI 缓存，不是凭据。
   */
  readonly openInEditor: (editorPath: string) => void;
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
   * 打开导出对话框（M2）。菜单只发"用哪种格式起头"的信号，
   * 选项（HTML 两模式 / PDF 文内目录）与输出路径都在对话框里，
   * 因为它们是 FR-07/FR-08 明写的**显式选项**，不该塞进菜单层。
   */
  readonly exportDocument: (kind: ExportKind) => void;
  /**
   * 打开分享面板（M3 / FR-10 微信 / FR-11 飞书 / FR-18 钉钉）。
   * 菜单只发"请打开面板"的信号：选项（发到聊天窗口的长图 / 粘进富文本编辑器的三个目标）
   * 与各自的适用场景说明都在 ShareDialog 里，那是平台约束决定的分组，不该塞进菜单层。
   */
  readonly openShare: () => void;
  /**
   * 「在浏览器中打开」：导出一份临时 HTML，再交系统默认程序打开。
   * 不承诺一定是浏览器——.html 关联给谁由用户和系统定，应用不该干预（红线 2）。
   */
  readonly openInBrowser: () => void;
  /**
   * 打开「导入 Obsidian」对话框（FR-09）。
   *
   * **为 null 即视为该入口尚未就绪**，菜单项据此保持 pending 置灰——绝不交付
   * 点了报错的菜单项。M3 已接上（App 传的是真回调），这条 null 分支留着不是摆设：
   * 导入是本应用唯一会往用户目录写东西的功能，将来若要按"后端是否可用"整条摘掉，
   * 摘的地方就是这里，而不是把菜单项删掉让用户以为功能没了。
   */
  readonly importObsidian: (() => void) | null;
  /** 系统打印对话框（FR-17 / Ctrl+P，与 PDF 共用打印模板） */
  readonly printDocument: () => void;
  /**
   * 专注阅读（原禅模式，UPGRADE_PLAN 3.3）。F11 早已可用，此前菜单项还挂着 pending
   * 只是接口没补，本批次一并点亮——"功能能用却在菜单里装作没做"同样是
   * DG 6.4 全局条 B 要消灭的东西。
   */
  readonly toggleZen: () => void;
  /** 弹「打开文件」对话框（左栏空白菜单用；顶栏按钮/Ctrl+O 同一入口） */
  readonly openFile: () => void;
  /** 弹「选择文件夹」对话框并挂载为项目（F20，Ctrl+Shift+O 同一入口） */
  readonly openFolderMount: () => void;
  /** 把**当前文档**所在文件夹挂载为项目（F20 的显式升级动作；父目录由 App 算） */
  readonly mountParentFolder: () => void;
  /**
   * 最近文件夹（F20，新→旧，上限 12）。这是它在全应用**唯一的显示面**
   * （DG 5.3.1 持久化条钉的位置：「打开文件夹 ▸」子菜单）。
   */
  readonly recentFolders: readonly string[];
  /**
   * 挂载一条最近文件夹。与 openFolderMount 的区别：失败（目录已删/改名）时
   * 由 App 侧顺手把该条从最近文件夹剔除——「失效显示时自动剔除」落在这里。
   */
  readonly mountRecentFolder: (path: string) => void;
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

/** 最近文件夹菜单项的展示名：路径尾段；盘根（C:\）退回整串（F20） */
function folderLabelOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index >= 0 && index < trimmed.length - 1 ? trimmed.slice(index + 1) : path;
}

/**
 * 「打开文件夹 ▸」子菜单（F20）：选择文件夹… + 最近文件夹清单（recentFolders
 * 唯一的显示面）。正文菜单打开方式组与左栏空白菜单（A.5）共用同一份——
 * 两处各写一遍必然漂移。
 */
function openFolderSubmenu(actions: ContextMenuActions): MenuNode {
  return {
    kind: "submenu",
    id: "open-folder-mount",
    label: t.contextMenu.openFolderDialog,
    icon: "folder",
    items: [
      {
        kind: "item",
        id: "open-folder-pick",
        label: t.contextMenu.openFolderPick,
        shortcut: "Ctrl+Shift+O",
        run: actions.openFolderMount,
      },
      ...(actions.recentFolders.length > 0
        ? [
            separator("sep-open-folder-recent"),
            ...actions.recentFolders.map(
              (folder, index): MenuNode => ({
                kind: "item",
                // 显示文件夹名（路径尾段）；路径是数据不是文案，不进 i18n
                id: `open-folder-recent-${index}`,
                label: folderLabelOf(folder),
                run: () => {
                  actions.mountRecentFolder(folder);
                },
              }),
            ),
          ]
        : []),
    ],
  };
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

/**
 * 导出与分享组（附录 A.1 第 2 段）。
 *
 * 导出 ▸ 的 HTML / PDF 在 M2 点亮（点开导出对话框，见 ContextMenuActions.exportDocument）；
 * **长图 PNG 与分享 ▸ 四项在 M3 一并点亮**，全部落到同一张分享面板：长图的两条出路
 * （复制进剪贴板 / 另存 PNG）本就在那张卡里，为它单开一张只会多一条要维护的路。
 * 无文档时整个「导出 ▸」「分享 ▸」置灰（disabled 而非 pending：功能有，只是此刻没东西可分享）。
 *
 * 「导入 Obsidian…」按 actions.importObsidian 是否为 null 自动在 pending / 可用之间切换，
 * 理由见 ContextMenuActions 上的注释。
 */
function exportGroup(input: DocumentMenuInput): MenuNode[] {
  const { documentPath, actions } = input;
  const noDocument = documentPath === null;
  /** 四个分享入口共用的动作：菜单层不做四选一，面板自己按收件端分组（见文件头） */
  const openShare = noDocument ? undefined : actions.openShare;
  const importObsidian = actions.importObsidian;

  return [
    {
      kind: "submenu",
      id: "export",
      label: t.contextMenu.export,
      icon: "export",
      disabled: noDocument,
      items: [
        {
          kind: "item",
          id: "export-html",
          label: t.contextMenu.exportHtml,
          disabled: noDocument,
          run: noDocument
            ? undefined
            : () => {
                actions.exportDocument("html");
              },
        },
        {
          kind: "item",
          id: "export-pdf",
          label: t.contextMenu.exportPdf,
          disabled: noDocument,
          run: noDocument
            ? undefined
            : () => {
                actions.exportDocument("pdf");
              },
        },
        {
          // 长图落在分享面板里（那里同时有「复制长图」与「另存长图…」两条出路）
          kind: "item",
          id: "export-long-image",
          label: t.contextMenu.exportLongImage,
          disabled: noDocument,
          run: openShare,
        },
      ],
    },
    {
      kind: "submenu",
      id: "share",
      label: t.contextMenu.share,
      icon: "share",
      disabled: noDocument,
      items: [
        {
          kind: "item",
          id: "share-wechat-image",
          label: t.contextMenu.shareWechatImage,
          disabled: noDocument,
          run: openShare,
        },
        {
          kind: "item",
          id: "share-wechat-rich",
          label: t.contextMenu.shareWechatRich,
          disabled: noDocument,
          run: openShare,
        },
        {
          kind: "item",
          id: "share-feishu",
          label: t.contextMenu.shareFeishu,
          disabled: noDocument,
          run: openShare,
        },
        {
          kind: "item",
          id: "share-dingtalk",
          label: t.contextMenu.shareDingtalk,
          disabled: noDocument,
          run: openShare,
        },
      ],
    },
    importObsidian === null
      ? {
          kind: "item",
          id: "import-obsidian",
          label: t.contextMenu.importObsidian,
          icon: "obsidian",
          pending: true,
        }
      : {
          kind: "item",
          id: "import-obsidian",
          label: t.contextMenu.importObsidian,
          icon: "obsidian",
          disabled: noDocument,
          run: noDocument ? undefined : importObsidian,
        },
  ];
}

/**
 * 打开方式组（附录 A.1 第 3 段）：三项全部点亮。
 *
 * 「在浏览器中打开」是怎么点亮的（**两道门一道都没放宽**）：
 * 它要「先导出一份临时 HTML，再把它交给系统默认程序」。曾经的判断是这条路只能靠
 * 放宽 openExternal 的协议白名单或给 opener 的 open-path 补 `.html` 授权——两条都不可接受：
 * 前者挡的是正文里的任意链接（file:/javascript: 一律拦下），为一个菜单项松开它，
 * 等于用整篇文档的攻击面换一次便利；后者的 scope 是渲染层可达的。
 * 现在走的是第三条路：后端专用命令 `shell_integ::open_in_browser`，**只接受 .html/.htm**，
 * 比 opener 的 scope 更窄，且渲染层拿不到「打开任意路径」这个能力。
 * openExternal 的 http(s) 白名单原封不动。
 *
 * 「用其他编辑器打开」为什么从单项变成子菜单：用户要的是「在 VS Code 里打开」，
 * 而不是「每次都在系统『打开方式』列表里翻一遍」。那个对话框既不记住选择
 * （它的「始终使用」会改默认程序，而默认程序我们不碰——红线 2），
 * 于是一次「打开源文件」实际是三四步点击。现在后端探测本机装了哪些编辑器
 * （`shell_integ::list_editors`）直接列出来，一步到位；探测表覆盖不到的编辑器
 * 仍有末尾的「其他程序…」这条出路，一个用户都不会被挡在门外。
 */
function openGroup(input: DocumentMenuInput): MenuNode[] {
  const { documentPath, actions } = input;
  return [
    {
      kind: "item",
      id: "open-in-browser",
      label: t.contextMenu.openInBrowser,
      icon: "browser",
      disabled: documentPath === null,
      run: documentPath === null ? undefined : actions.openInBrowser,
    },
    {
      // 探测到的编辑器直接列出来，点一下就在那个编辑器里打开（见本组注释第二段）
      kind: "submenu",
      id: "open-with-editor",
      label: t.contextMenu.openWithEditor,
      icon: "editor",
      disabled: documentPath === null,
      items: [
        ...actions.editors.map(
          (editor): MenuNode => ({
            kind: "item",
            id: `open-with-editor-${editor.id}`,
            // 产品名来自后端探测结果，不进 i18n（翻译产品名只会翻错）
            label: editor.name,
            disabled: documentPath === null,
            run:
              documentPath === null
                ? undefined
                : () => {
                    actions.openInEditor(editor.path);
                  },
          }),
        ),
        // 一个都没探到时不留一条孤零零的分隔线
        ...(actions.editors.length > 0 ? [separator("sep-open-with-editor")] : []),
        {
          // 兜底出路：探测表永远列不全（绿色版、自编译、公司自研），
          // 「打开方式」对话框不需要我们认识那个程序
          kind: "item",
          id: "open-with-editor-other",
          label: t.contextMenu.openWithOtherApp,
          disabled: documentPath === null,
          run:
            documentPath === null
              ? undefined
              : () => {
                  actions.openWithDefaultApp(documentPath);
                },
        },
      ],
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
      // 打印走系统打印对话框（FR-17），与 PDF 导出共用打印模板；无文档时无从打印
      kind: "item",
      id: "print",
      label: t.contextMenu.print,
      icon: "print",
      shortcut: "Ctrl+P",
      disabled: documentPath === null,
      run: documentPath === null ? undefined : actions.printDocument,
    },
    // F20 入口之一：任何时候都能挂载一个文件夹（无文档也行——空状态正是入口场景）
    openFolderSubmenu(actions),
    {
      // F20 显式升级动作：文件关联打开单文件后想要项目视图，从这里一步到位。
      // 绝不自动挂载父目录（DG 5.3.1 反 Typora 条）——这一项就是那个「显式」。
      kind: "item",
      id: "open-parent-as-project",
      label: t.contextMenu.openParentAsProject,
      icon: "folder",
      disabled: documentPath === null,
      run: documentPath === null ? undefined : actions.mountParentFolder,
    },
  ];
}

/** 视图组（附录 A.1 第 4 段）：缩放与主题在批次 1 已接线，禅模式本批次补上接口后点亮 */
function viewGroup(input: DocumentMenuInput): MenuNode[] {
  const { zoomPercent, theme, actions } = input;
  return [
    {
      kind: "item",
      id: "zen-mode",
      label: t.contextMenu.zen,
      icon: "zen",
      shortcut: "F11",
      run: actions.toggleZen,
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
    ...exportGroup(input),
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

/**
 * 附录 A.5：左栏空白区右键（批次 5.5，用户 2026-08-19 反馈「打开文件夹只在正文
 * 右键里 = 反人类」）。只有两件事——左栏的职责就是「打开东西」，别的动作都有
 * 自己的家（条目动作在条目上，视图切换在栏头）。
 */
export function buildSidebarMenu(input: {
  readonly actions: ContextMenuActions;
}): MenuNode[] {
  const { actions } = input;
  return [
    {
      kind: "item",
      id: "sidebar-open-file",
      label: t.common.open,
      icon: "file",
      shortcut: "Ctrl+O",
      run: actions.openFile,
    },
    openFolderSubmenu(actions),
  ];
}

/**
 * 附录 A.4：左栏文件夹树条目右键（F20，DG 5.3.1）。
 * 只读红线（红线 5）在菜单层的体现：**没有**新建/重命名/删除/移动——
 * 这里少一项不是没做完，是刻意不做；将来谁想"顺手"补文件管理，先读 DG 2.2。
 * 目录行没有「打开」（查看器只打开文档；展开/收起是单击语义，进菜单只会重复）。
 */
export function buildTreeMenu(input: {
  readonly path: string;
  readonly isDir: boolean;
  readonly actions: ContextMenuActions;
}): MenuNode[] {
  const { path, isDir, actions } = input;
  return [
    ...(isDir
      ? []
      : [
          {
            kind: "item",
            id: "tree-open",
            label: t.contextMenu.openRecent,
            icon: "file",
            run: () => {
              actions.openRecent(path);
            },
          } satisfies MenuNode,
        ]),
    {
      kind: "item",
      id: "tree-reveal",
      label: t.contextMenu.revealInExplorer,
      icon: "folder",
      run: () => {
        actions.revealPath(path);
      },
    },
    {
      kind: "item",
      id: "tree-copy-path",
      label: t.common.copyPath,
      icon: "copy",
      run: () => {
        actions.copyText(path);
      },
    },
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
