/**
 * 文案集中处 —— DG 11.7：V1 仅简体中文，预留英文位。
 * 规范：代码中禁止内联中文字符串（className 等技术值除外），一律从这里取。
 * 连带把「非文案但会显示的字形」（如 Hero 标记 M↓、刷新指示点 ●、占位破折号）也收在这里，
 * 免得组件里出现裸字符串。
 *
 * 编码名（UTF-8 / UTF-8 BOM / GBK）不在本文件：它是与 Rust `files::Encoding` 一一对应的
 * 契约值，映射表在 src/types/index.ts 的 ENCODING_LABEL，状态栏直接查表。
 */

export const zhCN = {
  app: {
    name: "MDNaonao",
    /** 中文名候选（DG 5.8），暂不在界面使用 */
    nameZh: "墨读",
    /** Hero 应用图标里的标记字形（非文案，集中于此避免组件内联字符） */
    mark: "M↓",
  },

  topbar: {
    toggleSidebar: "折叠 / 展开侧栏",
    open: "打开文件",
    find: "查找",
    outline: "大纲",
    export: "导出",
    share: "分享",
    more: "更多",
    untitled: "未打开文件",
    /** file watch 刷新后文件名旁闪一次的指示点字形（DG 6.4-7） */
    refreshMark: "●",
    refreshed: "文件已刷新",
  },

  window: {
    minimize: "最小化",
    maximize: "最大化",
    restore: "向下还原",
    close: "关闭",
    /**
     * 任务栏与 Alt-Tab 的窗口标题（3.3）：多开几个窗口时只有它能区分谁是谁。
     * 分隔符用半角连字符而非中文破折号——任务栏悬停条会按半角截断，中文标点在那里会糊。
     */
    titleWithDocument: (title: string): string => `${title} - MDNaonao`,
  },

  sidebar: {
    searchPlaceholder: "搜索文件",
    /** 过滤框右侧的清空钮（有值时才出现） */
    clearFilter: "清空",
    groupPinned: "置顶",
    groupToday: "今天",
    groupYesterday: "昨天",
    groupWeek: "近 7 天",
    groupEarlier: "更早",
    collapseGroup: "折叠分组",
    expandGroup: "展开分组",
    empty: "暂无最近打开的文件",
    /** 过滤框有内容但无命中（与「一条都没有」区分，避免误导） */
    emptyFiltered: "没有匹配的文件",
    settings: "设置",
    /** role=listbox 的无障碍名（屏幕阅读器读出"这是一个最近文件列表"） */
    recentListLabel: "最近打开的文件",
    /** 条目 hover 浮现的第二个钮：点开即右键菜单那一套（附录 A.2） */
    moreActions: "更多操作",
  },

  outline: {
    title: "大纲",
    pin: "钉住",
    unpin: "取消钉住",
    close: "关闭大纲",
    empty: "此文档没有标题结构",
  },

  /**
   * 文档内查找浮条（FR-05 / UPGRADE_PLAN 3.1）。
   * 顶栏「查找」按钮的名字复用 topbar.find，这里只放浮条自己的文案。
   */
  find: {
    placeholder: "查找",
    previous: "上一处",
    next: "下一处",
    close: "关闭查找",
    /** 未输入 / 无命中时的计数：两种情况都显示 0/0，位置不留空（否则浮条会抖一下） */
    countEmpty: "0/0",
    count: (index: number, total: number): string => `${index}/${total}`,
    /** 命中数触顶（引擎封顶）：后缀 + 表示"还不止这些" */
    countTruncated: (index: number, total: number): string => `${index}/${total}+`,
    /** 大文档首次查找要先建全文索引，期间浮条显示这一行 */
    indexing: "正在索引…",
  },

  /**
   * GitHub alerts 告警块的类型名（UPGRADE_PLAN 4.1）。
   * 语法 `> [!NOTE]` 等五种，是当下 README 的事实标准；渲染层识别后
   * 用这些名字做标题行。刻意保留英文原义的中文译法，与 GitHub 中文界面一致。
   */
  alert: {
    note: "注意",
    tip: "提示",
    important: "重要",
    warning: "警告",
    caution: "当心",
  },

  reading: {
    emptyTitle: "打开一个 Markdown 文件",
    emptyHint: "拖入 .md 文件，或按 Ctrl+O 打开",
    setDefaultViewer: "设为默认查看器",
    /** 加载/渲染中的一行淡字（DG 6.6：不做骨架屏） */
    opening: "正在打开…",
    rendering: "正在渲染…",
    /** 错误态标题（技术细节另起一行小字，见 App 的 ReadingError） */
    readFailed: "无法打开该文件",
    renderFailed: "渲染失败",
    fileMissing: "文件已被移动或删除",
    /** 拖入文件时的全窗遮罩文案（FR-13 / DG 6.4-9） */
    dropHint: "松开以打开文件",
    /** 拖入的是不支持的类型：遮罩换 danger 描边，配这一行说明 */
    dropUnsupported: "仅支持 Markdown 文件",
    /**
     * 大文件顶部细提示条（FR-01 / DG 6.6）：说明降级了什么，而不是只说"文件很大"。
     * 出现在正文列顶部，一行小字，不占用阅读注意力。
     */
    largeMode: "大文件模式：代码块工具条限量、滚动高亮降级为节流",
    /** 超过 MAX_OPEN_MB 直接拒开（错误块标题） */
    tooLarge: "文件过大，暂不打开",
    /** 拒开的说明行；参数为上限（MB），与 fileSession 的 MAX_OPEN_MB 同源 */
    tooLargeDetail: (limitMb: number): string =>
      `单个文档上限 ${limitMb} MB，超过后渲染会长时间无响应，请拆分后再打开`,
  },

  /**
   * 顶栏下方的警示条（DG 6.4-13：非模态、不遮内容、带一个出路动作）。
   * 与阅读区的全屏错误块分工：正文还在、只是外部世界变了，用警示条；
   * 正文根本读不出来，才走错误块。
   */
  notice: {
    fileRemoved: "文件已被移动或删除，正文为最后一次成功读取的内容",
    recentMissing: "该文件已不在原位置",
    dropUnsupported: "只能打开 .md / .markdown / .mdown / .mkd / .mkdn 文件",
  },

  /**
   * 渲染管线（src/render/preview.ts）注入正文的就地文案。
   * 代码块的「复制 / 已复制」复用 common.copy / common.copied，不在此重复。
   */
  preview: {
    /** 红线 4：外链图片默认不发起任何外部请求，只显示占位块 */
    externalImageBlocked: "外链图片默认不加载",
    /** 占位块上的按钮：点击后才写入真实 src */
    loadExternalImage: "点击加载",
    /** 已写入 src、等待网络回来的中间态（避免"点了没反应"） */
    externalImageLoading: "正在加载…",
    /** 加载失败：占位块留在原地并给出重试出路（按钮文案复用 common.retry） */
    externalImageFailed: "外链图片加载失败",
    /** 一篇文档里有多张外链图时，占位块上追加的批量入口 */
    loadAllExternalImages: "本篇全部加载",

    /* ── 排版补完（UPGRADE_PLAN 4.2）产出的应用文字 ── */

    /** [TOC] 指令渲染出的文内目录标题 */
    tocTitle: "目录",
    /** Mermaid 语法错误：显示错误卡片 + 原始代码回退，不留空白也不显示半成品图 */
    diagramError: "图表渲染失败",
    /** KaTeX 公式错误 */
    formulaError: "公式渲染失败",
    /** \ce{} 化学式：mhchem 扩展未打包，明确告知而非静默失败 */
    chemNotBundled: "本版本未内置化学式扩展（mhchem），\\ce{} 语法暂不支持",
  },

  status: {
    words: "字",
    lines: "行",
    zoom: "缩放",
    fontSize: "字号",
    theme: "主题",
    toggleTheme: "切换主题",
    /** 主题三态名：状态栏月亮/太阳/显示器钮的 tooltip 显示当前态 */
    themeSystem: "跟随系统",
    themeLight: "浅色",
    themeDark: "深色",
    /** 无文档时的占位字形（编码位等） */
    placeholder: "—",
  },

  /**
   * 应用内右键菜单四套（UPGRADE_PLAN 附录 A 是唯一规格源，条目排布见
   * src/components/contextMenuItems.ts —— 那里逐组对照附录 A 的 ASCII 图）。
   *
   * 命名规则：键名按「附录 A 里出现的位置」分组排列，方便与规格逐行对拍；
   * 与 common 完全同义的文案（复制 / 打开所在文件夹 / 复制文件路径 / 从列表移除）
   * **不在这里重复定义**，条目层直接取 common，避免两处文案漂移。
   */
  contextMenu: {
    /* 四套菜单的无障碍名（role=menu 的 aria-label，屏幕阅读器用来报"这是哪套菜单"） */
    labelDocument: "正文右键菜单",
    labelLink: "链接右键菜单",
    labelImage: "图片右键菜单",
    labelRecent: "最近文件右键菜单",

    /* 复制组（正文 / 链接 / 图片菜单共用） */
    copyPlain: "复制为纯文本",
    copySource: "复制全文 Markdown 源",

    /* 导出与分享组（导出 M2 / 分享与 Obsidian M3，本批次全部置灰） */
    export: "导出",
    exportHtml: "HTML",
    exportPdf: "PDF",
    exportLongImage: "长图 PNG",
    share: "分享",
    shareWechatImage: "微信长图",
    shareWechatRich: "公众号富文本",
    shareFeishu: "飞书",
    shareDingtalk: "钉钉",
    importObsidian: "导入 Obsidian…",

    /* 打开方式组 */
    openInBrowser: "在浏览器中打开",
    openWithEditor: "用其他编辑器打开源文件",
    revealInExplorer: "在资源管理器中显示",
    print: "打印…",

    /* 视图组 */
    zen: "禅模式",
    /** 缩放子菜单的父项：括号里带当前档位（如「缩放（125%）」） */
    zoomWith: (percent: number): string => `缩放（${percent}%）`,
    zoomReset: "重置",
    theme: "主题",

    /* 关于组 */
    about: "关于 MDNaonao",

    /* 链接菜单（外链与本地 .md 二选一） */
    openLinkInBrowser: "在浏览器中打开该链接",
    openLinkInApp: "在本应用中打开",
    copyLinkAddress: "复制链接地址",

    /* 图片菜单 */
    copyImageAddress: "复制图片地址",

    /* 左栏最近文件条目菜单 */
    openRecent: "打开",
    pin: "置顶",
    unpin: "取消置顶",
  },

  /**
   * 「关于」对话框（附录 A.1 关于组，批次 2 点亮）。
   * 极简四行：版本 / 运行模式 / 数据目录 + 一个「打开日志目录」出路——
   * 排查"我的设置去哪了""日志在哪"这两个高频问题，靠的就是后两项。
   */
  about: {
    version: "版本",
    mode: "运行模式",
    modePortable: "便携版",
    modeInstalled: "安装版",
    dataDir: "数据目录",
    openLogDir: "打开日志目录",
    /** 后端 app_info 尚未就绪时的占位（不留空白，也不假装有值） */
    unknown: "—",
  },

  /**
   * 栏宽拖拽把手（UPGRADE_PLAN 4.3）。全是无障碍名：把手本身是一条透明命中带，
   * 屏幕阅读器只能靠 aria-label 知道自己停在哪根分隔条上。
   */
  resize: {
    /** 通用兜底（ResizeHandle 未传 label 时用） */
    handle: "调整栏宽",
    sidebar: "调整左栏宽度",
    outline: "调整大纲栏宽度",
  },

  /** 图片灯箱（UPGRADE_PLAN 4.3 / DG 6.4-4） */
  lightbox: {
    /** role=dialog 的无障碍名 */
    label: "图片预览",
    close: "关闭预览",
  },

  /**
   * 崩溃兜底卡片（UPGRADE_PLAN 4.3）。
   * 语气刻意收着：只读查看器渲染失败不动用户一个字节，不该用事故级措辞吓人。
   */
  errorBoundary: {
    title: "界面没能画出来",
    hint: "文件本身没有被改动。重新加载通常就能恢复；如果反复出现，请复制诊断信息反馈。",
    /** error.message 为空时的占位 */
    unknownError: "未知错误",
    reload: "重新加载",
    copy: "复制诊断信息",
    /** 日志目录一行的前缀标签（值由后端 app_info 回传） */
    logDir: "日志目录",
  },

  common: {
    open: "打开文件",
    confirm: "确定",
    cancel: "取消",
    copy: "复制",
    copied: "已复制",
    close: "关闭",
    retry: "重试",
    remove: "从列表移除",
    relocate: "重新定位",
    openFolder: "打开所在文件夹",
    copyPath: "复制文件路径",
    /**
     * 未实现功能的按钮 tooltip 后缀（拼在功能名后面，如「导出（开发中）」）。
     * 界面上不允许存在"看起来能点、点了没反应"的元素：没做的一律置灰并如实说明。
     */
    comingSoonSuffix: "（开发中）",
  },
} as const;

export type Messages = typeof zhCN;

/** V1 单语言：直接导出当前语言包，后续接入多语言时替换为 hook */
export const t = zhCN;
