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
    /** F20（批次 5.5）：顶栏文件夹入口；导出/分享钮已撤（与右键重复，用户 2026-08-19 决定） */
    openFolder: "打开文件夹",
    find: "查找",
    outline: "大纲",
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
    /** 栏宽拖拽把手的无障碍名（它是个 separator role，屏幕阅读器只能靠这句知道拖的是谁） */
    resizeLabel: "调整侧栏宽度",
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

    /* ── 文件夹模式（F20，DG 5.3.1） ── */
    /** 栏头视图切换：时钟图标（回最近列表） */
    viewRecent: "最近",
    /** 栏头视图切换：树图标（回文件夹树） */
    viewFolder: "文件夹",
    /** role=listbox（树视图）的无障碍名 */
    treeListLabel: "文件夹树",
    /** 展开后一个受支持文件都没有的目录（DG 5.3.1：一行淡字占位，不藏目录） */
    treeEmptyDir: "无 Markdown 文件",
    /** 单层子项超过 2000 截断（Rust DIR_CHILDREN_LIMIT，两侧数字必须一致） */
    treeTruncated: "项目过多，仅显示前 2000 项",
    /** 某层读取失败（权限/网络盘断线），整行可点重试 */
    treeError: "读取失败，点击重试",
    /** 根层尚在读取（网络盘/超大目录会持续数秒）：绝不能把「加载中」误报成「无文件」 */
    treeLoading: "读取中…",
    /** 栏头 × 钮：卸载文件夹回到最近列表（不动磁盘上的任何东西） */
    closeFolder: "关闭文件夹",
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
    /** F20：选中/拖入的路径不是可读目录（无权限、已删除、或根本是个文件） */
    folderOpenFailed: "无法打开该文件夹",
  },

  /**
   * 渲染管线（src/render/preview.ts）注入正文的就地文案。
   * 代码块的「复制 / 已复制」复用 common.copy / common.copied，不在此重复。
   */
  preview: {
    /**
     * 本地图片加载失败（文件被挪走/改名、路径写错、盘符掉线）。
     * 占位块后面会跟上解析出来的完整路径——那才是用户真正需要的信息，
     * 只说「加载失败」等于没说。
     */
    localImageFailed: "图片无法加载",
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
    labelTree: "文件夹条目右键菜单",
    labelSidebar: "左栏右键菜单",

    /* 文件夹模式入口（F20，附录 A.1 打开方式组增补） */
    openFolderDialog: "打开文件夹",
    /** 「打开文件夹 ▸」子菜单首项：弹系统选择框（其下列最近文件夹） */
    openFolderPick: "选择文件夹…",
    openParentAsProject: "把所在文件夹作为项目打开",

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
    /**
     * 「用其他编辑器打开源文件 ▸」子菜单的末项：弹系统「打开方式」对话框。
     * 子菜单前面那几项是**后端探测到的编辑器**，文案是产品名（Visual Studio Code /
     * 记事本 …），由 shell_integ::list_editors 给出，**刻意不进这里**——产品名不是可译文案。
     */
    openWithOtherApp: "其他程序…",
    revealInExplorer: "在资源管理器中显示",
    print: "打印…",

    /* 视图组 */
    zen: "专注阅读",
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
   * 导出对话框与导出结果 toast（FR-07 HTML / FR-08 PDF / DG 6.6「导出中」「导出完成」）。
   *
   * 菜单里的「导出 / HTML / PDF / 长图 PNG」是**菜单条目文案**，在 contextMenu 组，
   * 这里只放对话框自己的字，两处刻意不复用——菜单项是动词入口，对话框里是选项标签，
   * 将来任何一侧改词都不该牵连另一侧。
   */
  exportDialog: {
    /** role=dialog 的无障碍名，同时是卡片标题 */
    title: "导出",

    /* 格式段：HTML 与 PDF 二选一。长图 PNG 属 M3（capture.rs 未实现），不在此出现 */
    format: "格式",
    formatHtml: "HTML",
    formatPdf: "PDF",

    /* HTML 两种模式 —— FR-07 要求「两个显式选项」，且如实提示各自代价 */
    htmlSingleFile: "单文件（图片内联，便于分享）",
    htmlSingleFileHint: "图片以 base64 内联，单个文件可离线打开，体积可能较大",
    htmlWithAssets: "HTML + 资源目录",
    htmlWithAssetsHint: "图片放在同名 _files 目录，转发时需连目录一起复制",

    /* PDF 选项 */
    includeToc: "包含文内目录",
    /** FR-08 明写：PrintToPdf 不产生 PDF 书签，必须如实告知，不能让用户以为有导航树 */
    tocHint: "PDF 不含书签，目录以文内目录页的形式插在正文之前",

    /* 输出路径 */
    output: "输出路径",
    /** 默认值的说明：源文件同目录同名（用户不改路径就是这个结果） */
    outputDefaultHint: "默认导出到源文件所在目录",
    saveAs: "另存为…",
    /** 保存对话框不可用（权限未放行等）时的一行说明：不阻断按默认路径导出 */
    saveAsFailed: "无法打开保存对话框，可直接按默认路径导出",
    /**
     * 覆盖预警。刻意在**按导出之前**出现而不是导出到一半弹确认框——
     * 中途冒出来的模态框只会让人条件反射点确定，等于没有告知。
     */
    overwriteFileWarning: "该文件已存在，导出会覆盖它",
    overwriteAssetsDirWarning: "同名资源目录已存在，导出会写入其中",
    /**
     * 落点在探测之后才被占用（探测失败 / 并发写入）：后端拦下了，如实说清怎么继续。
     * 「再导出一次」是真的能成：卡片重新打开时会再探测一遍，届时覆盖警告就在那儿了。
     */
    overwriteRefused: "目标文件已存在，本次没有覆盖。再导出一次会先提示确认",

    /* 主按钮与进度 */
    run: "导出",
    running: "正在导出…",
    /** 超过 2s 才出现的进度提示（DG 6.6：导出中 >2s 追加提示，避免"点了没反应"） */
    slowHint: "文档较长，正在排版并写出文件…",

    /* 结果 toast（DG 6.6：已导出 · 打开文件 / 打开所在文件夹） */
    done: (name: string): string => `已导出 ${name}`,
    failed: "导出失败",
    printFailed: "打印失败",
    openFile: "打开文件",
    /** toast 的关闭钮复用 common.close，此处不另起 */
  },

  /**
   * 首启引导（F2，DG 6.4-14 三步卡片式向导）。
   *
   * 【文案纪律】Windows 10+ 的 UserChoice 带系统哈希保护，**应用无法把自己设为默认程序**
   * （DG 2.3-2 / 红线 2）。所有措辞必须与这条平台约束一致：不写「一键设为默认」，
   * 而是如实说明「需要你在系统设置里手动选一次」。给用户「点一下就好了」的错觉，
   * 换来的只是他点完发现没生效——那比一开始就说清楚糟糕得多。
   *
   * 三步之外还有一条：向导可跳过、可从空状态页的
   * [`reading.setDefaultViewer`] 再次打开，所以任何一步都不必写「必须」「否则无法使用」。
   */
  firstRun: {
    /** role=dialog 的无障碍名 */
    label: "首次使用引导",
    /** 步进指示器：圆点是装饰（aria-hidden），真正读给屏幕阅读器的是这一句 */
    stepIndicator: (current: number, total: number): string =>
      `第 ${current} 步，共 ${total} 步`,
    skip: "跳过",
    next: "下一步",
    /** 第二步的次要出路：不设默认也能继续，不做拦路弹窗 */
    later: "稍后再说",
    finish: "开始阅读",

    welcomeTitle: "欢迎使用 MDNaonao",
    welcomeBody:
      "双击 .md 文件即可阅读。它是严格只读的查看器——不改你的文件，一个字节都不写。",

    defaultTitle: "让 .md 默认用 MDNaonao 打开",
    defaultBody:
      "Windows 不允许应用把自己设为默认程序，需要你在系统设置里手动选一次。",
    openSettings: "打开系统设置",
    /**
     * 图文说明的三条步骤（DG 6.4-14）。用编号步骤而不是插画/动图：
     * DG 6.4 全局条 C 与第 12 条都要求引导页不画插画，况且动图还得进包体。
     */
    settingsStep1: "在打开的「默认应用」页里搜索 .md",
    settingsStep2: "点击 .md 当前的默认程序",
    settingsStep3: "在列表里选择 MDNaonao 并确认",
    /** 深链打不开（老版本 Windows / 组策略限制）时的兜底路径，必须给得出手动走法 */
    openSettingsFailed: "没能打开设置页，请手动打开：设置 → 应用 → 默认应用",
    /** 只读检测默认程序期间的一行淡字 */
    checking: "正在检查当前默认程序…",

    doneTitle: "可以开始阅读了",
    doneBody: "拖入 .md 文件，或按 Ctrl+O 打开。",
    /** 已是默认时的小标记（第二步整步跳过） */
    alreadyDefault: "已是默认",
    alreadyDefaultBody: ".md 文件已经在用 MDNaonao 打开，设默认这一步跳过了。",
    /** 没设默认就走完向导：不催第二遍，只说清再次进入的入口 */
    notDefaultBody:
      "以后想设为默认，可以从空状态页的「设为默认查看器」再次打开本向导。",
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

  /**
   * 分享面板（FR-10 微信 / FR-11 飞书默认通道 / FR-18 钉钉，M3 批次）。
   *
   * 【文案纪律，比别处更硬】DG 2.3-1 与事实库 #6 是**确定性平台约束**，不是风险：
   * 微信 / 企业微信 / 钉钉的聊天窗口只取纯文本，粘贴富文本必掉排版；只有公众号
   * 图文编辑器、飞书文档、钉钉文档这类富文本容器才认 CF_HTML。
   * 因此这里**不许出现笼统的「分享到微信」**——它在群聊里塌、在公众号里好，
   * 用户只会当成我们的 bug。每一条都要说清「粘到哪儿、会得到什么」。
   * 同样地：永不写「一键发送到微信」（微信没有 API，红线 7）。
   */
  shareDialog: {
    /** role=dialog 的无障碍名，同时是卡片标题 */
    title: "分享",

    /* 第一组：聊天窗口 —— 长图是唯一能保住排版的形态 */
    chatTitle: "发到聊天窗口",
    chatHint:
      "微信 / 企业微信 / 钉钉的聊天窗口只接受纯文本，粘贴富文本会掉光排版。要排版不糊，只能发长图。",
    chatCopy: "复制长图",
    chatCopyHint: "生成整篇长图放进剪贴板，切到聊天窗口 Ctrl+V 即可发送",
    chatSave: "另存长图…",
    chatSaveHint: "存成 PNG 文件，再拖进聊天窗口",

    /* 第二组：富文本容器 —— CF_HTML 在这里才成立 */
    richTitle: "粘进富文本编辑器",
    richHint: "样式已逐条内联，粘贴后保留排版。",
    richWechatMp: "公众号图文编辑器",
    richWechatMpHint: "公众号后台的图文编辑器支持富文本粘贴（聊天窗口不支持）",
    richLark: "飞书文档",
    richLarkHint: "粘贴到飞书文档即可保留排版，无需任何配置",
    richDingtalk: "钉钉文档",
    richDingtalkHint: "钉钉没有公开的文档导入接口，只能粘贴（聊天窗口同样会掉排版）",

    /**
     * 不保真项前置告知。与其让用户粘完才发现公式没了，不如现在就说清楚——
     * 这一行是「如实」而不是「免责」，所以写在面板里而不是藏进帮助文档。
     */
    fragileHint:
      "公式与图表在多数编辑器里会丢失或变形；本地图片随稿带上，个别编辑器需要手动重新上传。",

    /* 进行中（>1s 的动作不能没有反馈） */
    preparing: "正在排版…",
    capturing: "正在生成长图…",
    copying: "正在写入剪贴板…",

    /* 结果（交给 App 的 toast 渲染） */
    copiedRichText: "已复制富文本，粘贴到编辑器即可保留排版",
    /** 少带了图必须当场说，否则用户会把一篇缺图的稿子直接发出去 */
    copiedRichTextPartial: (skipped: number): string =>
      `已复制富文本，但有 ${skipped} 张图片没能带上`,
    copiedImage: "已复制长图，切到聊天窗口 Ctrl+V 发送",
    /**
     * 剪贴板一次只装得下一张图。文档过长被切成多段时，如实说清「只复制了第 1 张」
     * 并指出出路——让用户发完才发现后半篇没了，是这条链上最坏的失败方式。
     */
    copiedImageFirstOfMany: (total: number): string =>
      `文档较长，长图被切成 ${total} 张，只复制了第 1 张；要发完整版请用「另存长图…」`,
    savedImage: (name: string): string => `已保存 ${name}`,
    /** 超过 GPU 纹理上限被迫分段（DG 4.1「长图截图」行） */
    savedImageSegments: (count: number): string => `长图过高，已分成 ${count} 张保存`,
    failed: "分享失败",

    /* 未就绪通道的置灰说明（如实置灰，绝不交付点了报错的入口） */
    longImageUnavailable: "长图功能开发中",
    clipboardImageUnavailable: "图片剪贴板不可用，可改用「另存长图…」",
    saveUnavailable: "保存对话框不可用，可改用「复制长图」",

    /**
     * 任务列表勾选框的替代字形（非文案）。富文本编辑器一律剥离 `<input>`，
     * 不换成字符的话粘过去只剩没有任何标记的裸条目，「做了 / 没做」就此丢失。
     */
    taskDone: "☑ ",
    taskTodo: "☐ ",
  },

  /**
   * Obsidian 导入对话框（FR-09，M3 批次）。
   *
   * 【文案纪律】这是本应用唯一会往**用户自己的知识库**里写文件的功能，措辞必须精确：
   *   - 「未检测到 Obsidian」是正常状态（list_vaults 返回空数组），不许写成错误；
   *   - 覆盖策略要说清边界——会被替换的只有笔记本身，附件在 Rust 侧永不覆盖；
   *   - 唤起 Obsidian 失败不等于导入失败（文件已经进 Vault 了），只补一句提示。
   */
  obsidianDialog: {
    /** role=dialog 的无障碍名，同时是卡片标题；主按钮置灰时的 tooltip 也用它（只写功能名） */
    title: "导入 Obsidian",

    /* Vault 选择 */
    vault: "目标 Vault",
    vaultLoading: "正在查找 Vault…",
    /** 只有真正读失败（%APPDATA% 缺失 / JSON 损坏 / 无权限）才用它；「没装」不走这条 */
    vaultLoadFailed: "没能读取 Obsidian 的 Vault 列表",
    /** 当前在 Obsidian 里打开的那个 Vault（后端已排在最前，默认选中） */
    vaultOpen: "当前打开",

    /* 未检测到 Obsidian —— list_vaults 返回空数组，是正常状态而不是故障 */
    notInstalledTitle: "未检测到 Obsidian",
    notInstalledBody:
      "本机没有安装 Obsidian，或者还没有建过 Vault。安装 Obsidian 并新建一个 Vault 后，回到这里重试即可。",

    /* 子目录（可空 = Vault 根目录） */
    subfolder: "子目录",
    subfolderPlaceholder: "留空 = Vault 根目录",
    subfolderHint: "目录不存在会自动创建；上级目录符号与盘符会被忽略",

    /* 落点预览：把「留空 = 根目录」这句抽象规则变成一行看得见的结果 */
    target: "落点",
    targetRoot: (vault: string): string => `${vault}（Vault 根目录）`,
    targetSub: (vault: string, folder: string): string => `${vault} / ${folder}`,
    /** Obsidian 只把 .md 当笔记，扩展名会被统一改写，如实说清 */
    targetNameHint: "笔记以源文件名保存，扩展名统一为 .md",

    /* 同名冲突（Rust 侧 conflict 无 serde default，界面必须显式给出二选一） */
    conflict: "同名冲突",
    conflictRename: "自动改名",
    conflictRenameHint: "Vault 里已有同名笔记时，本篇存为「原名-1.md」，两份都保留",
    conflictOverwrite: "覆盖同名笔记",
    conflictOverwriteHint: "用本篇替换 Vault 里的同名笔记",
    /**
     * 选中覆盖才出现的警示行。必须同时说清两件事：会没的是**笔记本身**且不可恢复；
     * 附件永远不会被覆盖（Rust 侧同名不同内容一律改名）。
     */
    conflictOverwriteWarning:
      "覆盖会替换 Vault 里的同名笔记，原内容无法恢复；附件永不覆盖，同名不同内容的附件会自动改名",

    /* 导入后唤起 */
    openAfter: "导入后在 Obsidian 中打开",
    openAfterHint: "用 obsidian:// 唤起 Obsidian 并定位到这篇笔记",

    /* 主按钮与进度 */
    run: "导入",
    running: "正在导入…",
    /** >2s 才出现：大文档要扫附件、拷图，几秒是正常的 */
    slowHint: "正在扫描附件并复制到 Vault…",

    /* 结果（交给 App 的 toast 渲染） */
    done: (path: string): string => `已导入 ${path}`,
    /** 附件数为 0 时不说这句废话，故分成两条而不是拼一个可能为空的尾巴 */
    doneWithAttachments: (path: string, count: number): string =>
      `已导入 ${path}，已一并复制 ${count} 个附件`,
    /** 唤起失败不算导入失败：文件已经在 Vault 里了，只在成功文案后补一句 */
    doneOpenFailed: (message: string): string =>
      `${message}；没能唤起 Obsidian，请手动打开 Vault 查看`,
    /** 失败 toast 的前缀（App 用，形如「导入 Obsidian 失败：<原因>」） */
    failed: "导入 Obsidian 失败",
  },

  /**
   * 飞书凭据设置对话框（FR-11 进阶通道，M3 批次）。
   *
   * 【文案纪律】这一组的每一句都受后端契约约束，改词前先看 settings.rs / share/lark.rs：
   *   - `test_lark_connection()` 无入参 → 测的是**已保存**的那份，所以永远不许出现
   *     「填好就能测」这类暗示，只能写「先保存、再测试」；
   *   - 密钥永不回显、也没有「只改 App ID」的偏路径 → 换凭据必须两栏同填，
   *     文案要把「为什么不能只改一个」说明白，而不是只说「不能」；
   *   - DPAPI 密文绑定当前 Windows 用户 → 便携目录换机器/换账号必然解不开，
   *     这句必须出现在界面上（[`dpapiHint`]），否则会被当成 bug 报回来；
   *   - 飞书自建应用「改完权限要发布新版本才生效」是「配好了却报权限不足」的头号原因，
   *     所以它进的是配置引导正文（[`guideStep2`]），不是错误发生后才说的话。
   */
  larkSettings: {
    /** role=dialog 的无障碍名，同时是卡片标题 */
    title: "飞书导入设置",
    intro:
      "配置飞书自建应用凭据后，可把当前文档直接导入飞书云文档，省掉手动粘贴。不配置也不影响「复制富文本粘进飞书文档」那条通道。",

    /* 当前状态行 */
    statusLabel: "当前状态",
    statusLoading: "正在读取…",
    /** 参数是后端回传的**打码** App ID（形如 cli_a1b2***），明文永远不出现在界面上 */
    statusConfigured: (appIdMasked: string): string => `已绑定 ${appIdMasked}`,
    statusNotConfigured: "未配置",
    /** 后端回了 configured 却没给打码值时的占位（不留空，也不假装知道） */
    appIdUnknown: "未知应用",
    statusLoadFailed: "读不到凭据状态",
    tokenCached: "已缓存访问令牌，下次导入可直接开始",
    tokenNotCached: "尚未缓存访问令牌，首次导入会先换一次",

    /* 表单 */
    appIdLabel: "App ID",
    appIdPlaceholder: "在开放平台「凭证与基础信息」页复制",
    appSecretLabel: "App Secret",
    appSecretPlaceholder: "与 App ID 同一页复制",
    /** 已配置时的说明：两栏都留空 = 保持已保存的那份不动（保存钮此时也是灰的） */
    appSecretKeepHint: "密钥已保存且不会回显；两栏留空即保持现有凭据不变。",
    showSecret: "显示密钥",
    hideSecret: "隐藏密钥",

    /* 动作 */
    save: "保存",
    saving: "正在保存…",
    test: "测试连接",
    testing: "正在测试连接…",
    unbind: "解除绑定",
    unbinding: "正在解除绑定…",

    /* 置灰理由（如实告知：写清"此刻为什么不能点"，不是「开发中」） */
    saveNeedsBoth: "请先填写 App ID 与 App Secret",
    saveNothingChanged: "两栏都空着，没有要保存的改动",
    savePartial: "更换凭据要两栏一起填：密钥不回显，无法只改其中一项",
    testNeedsSave: "测试连接验的是已保存的那一份凭据，请先保存",
    testNeedsSaveDraft: "输入框里的改动还没保存，此时测的仍是旧凭据；请先保存",
    unbindNeedsConfigured: "当前没有已保存的凭据",

    /* 解除绑定的二次确认（自绘，不弹系统对话框） */
    unbindConfirm:
      "解除后本机不再保存这份凭据，下次导入需要重新填写 App ID 与 App Secret。确定解除？",
    unbindConfirmYes: "确定解除",

    /* 结果（就地显示在卡里，不走 toast——保存完多半紧接着要测一次连接） */
    saved: "凭据已保存。建议接着测一次连接，确认权限已经生效",
    tested: "连接正常，凭据可用",
    unbound: "已解除绑定",

    /* 失败时按错误 kind 追加的下一步；主句一律原样透出后端文案（api 类含飞书 code+msg） */
    hintConfig: "多半是两栏没填全或还没保存，检查后重新保存一次",
    hintApi:
      "飞书返回了业务错误：确认应用已开通云文档的导入与编辑权限，并且改完权限后发布了新版本",
    hintHttp: "网络没通：检查代理与防火墙，或稍后再试",
    hintTimeout: "飞书接口迟迟没有响应，稍后再试一次",

    /* 配置引导（写在界面上，而不是等出错了才说） */
    guideTitle: "配置前先做这两件事",
    guideStep1:
      "在飞书开放平台创建自建应用，复制「凭证与基础信息」页的 App ID 与 App Secret",
    guideStep2:
      "为应用开通云文档的导入与编辑权限，然后创建并发布新版本 —— 权限要等新版本发布后才生效，这是「配好了却报权限不足」最常见的原因",

    /**
     * DPAPI 绑定当前 Windows 用户（必须如实告知，见本组头部注释）。
     * 措辞同时覆盖安装版（换 Windows 账号）与便携版（拷到别的机器），两种情形结论一样。
     */
    dpapiHint:
      "凭据经 Windows DPAPI 加密保存，只有当前 Windows 用户能解开。换账号登录、或把便携目录拷到另一台机器后，飞书凭据必定解不开、需要重新填写（其余设置照常跟着走）。",
  },

  /**
   * 设置页（左栏底部「设置」唤起，components/SettingsDialog.tsx）。
   *
   * 【结构】左侧分区导航（外观 / 阅读 / 导出与分享）+ 右侧内容区，每个分区
   * 顶部一句分区说明、下面每行「标签 + 一行短说明 + 右侧控件」。文案因此分成两层：
   *   - `section*Desc` 承载**跨行才说得清**的话（字号与缩放的分工、"只影响显示不改文件"），
   *     它们此前挤在单项说明里，把每一行撑成三四行，正是版面散掉的根因；
   *   - 单项 `*Hint` 只留**一句**，说的仍是代价或分工，不是把标题换个说法：
   *     折行的代价是打乱缩进、单文件 HTML 的代价是体积、fluid 要写明"跟随窗口"。
   * 「设置」两个字之外的所有标题都用具体名词（正文字号 / 正文列宽 / 代码块折行），
   * 不用「显示」「外观选项」这类什么都没说的词。
   */
  settingsDialog: {
    /** role=dialog 的无障碍名，同时是左栏顶部的标题 */
    title: "设置",
    /** 底栏那行淡字：这是偏好设置不是表单，说清没有「确定 / 取消」这一步 */
    autoSaveHint: "改动即时生效并自动保存，没有「确定 / 取消」这一步",

    /* 分区导航项（同时用作 nav 的无障碍名） */
    nav: "设置分区",
    sectionAppearance: "外观",
    sectionReading: "阅读",
    sectionExport: "导出与分享",

    /* 分区说明（内容区顶部一句，收走原本挤在每行下面的长解释） */
    sectionAppearanceDesc:
      "字号定的是基准，缩放是在这个基准之上再乘的倍率——两者不是同一件事，不必两边各调一遍。",
    sectionReadingDesc: "只改变正文在阅读区的呈现方式，文件本身一个字节都不动。",
    sectionExportDesc:
      "导出与分享的默认选项。这里改的与导出对话框里是同一项，不存在两份偏好。",

    /* 主题（状态栏月亮钮改的是同一项，说清楚免得被当成两个设置） */
    theme: "主题",
    themeSystem: "跟随系统",
    themeLight: "浅色",
    themeDark: "深色",
    themeHint: "状态栏的月亮钮改的是同一项",

    /* 正文字号 —— 与缩放的分工写在分区说明里 */
    fontSize: "正文字号",
    /** 档位钮上的数字（单位写在说明里，避免七个钮各带一个 px 挤成一片） */
    fontSizeValue: (px: number): string => `${px}`,
    fontSizeHint: "正文基准字号 14–20 px，标题与代码块按它换算",

    /* 缩放（与状态栏、Ctrl+滚轮同源） */
    zoom: "缩放",
    zoomValue: (percent: number): string => `${percent}%`,
    zoomHint: "与状态栏百分比、Ctrl+滚轮改的是同一个值",

    /* 正文列宽（CSS 在 styles/markdown.css 的 [data-reading-width]） */
    readingWidth: "正文列宽",
    readingWidthFluid: "跟随窗口",
    readingWidthMedium: "适中",
    readingWidthWide: "宽",
    readingWidthHint: "适中 748 px、宽 1000 px 是固定列宽，宽屏上不至于一行读到串行",

    /* 代码折行（两档标签直接说后果，不写"开 / 关"） */
    codeWrap: "代码块折行",
    codeWrapOn: "折行",
    codeWrapOff: "横向滚动",
    codeWrapHint: "折行不出横向滚动条，代价是打乱原本对齐的缩进",

    /* frontmatter 三态（FR-14） */
    frontmatter: "frontmatter 属性区",
    frontmatterCard: "属性卡片",
    frontmatterHidden: "隐藏",
    frontmatterRaw: "原样代码块",
    frontmatterHint: "文档开头那段 YAML 元数据，导出 HTML 与长图照此显示",

    /* 导出 HTML（与导出对话框读写同一个字段） */
    htmlExport: "导出 HTML",
    htmlSingleFile: "单文件",
    htmlWithAssets: "HTML + 资源目录",
    htmlExportHint: "单文件把图片内联、体积较大；资源目录转发时要连目录一起带",

    /* 飞书凭据：设置页只给入口，表单仍在「飞书导入设置」那张卡 */
    lark: "飞书导入",
    larkOpen: "打开飞书设置…",
    larkHint: "配置自建应用凭据后，可把当前文档导入飞书云文档",
  },

  /**
   * 「在浏览器中打开」（右键菜单「打开方式」组，UPGRADE_PLAN 附录 A.1）。
   *
   * 这条链路是「导出一份临时 HTML → 交系统默认程序打开」两步，文案要能覆盖
   * 中间那一秒的等待与两种可预期的失败。措辞刻意不承诺「浏览器」：
   * 打开的其实是 .html 的系统默认程序，用户若把 .html 关联给了编辑器就是编辑器，
   * 应用无从也不该干预（红线 2：默认程序归用户和系统管）。
   */
  browserPreview: {
    /** 导出 + 打开要一两秒，不给反馈又是「点了没反应」 */
    preparing: "正在准备预览…",
    /** 成功 toast：不写「已打开浏览器」，因为默认程序未必是浏览器 */
    opened: "已交给系统默认程序打开",
    /** 失败 toast 前缀（App 用，形如「在浏览器中打开失败：<原因>」） */
    failed: "在浏览器中打开失败",
    /**
     * 后端 EXPORT_TOO_LARGE 的专属说法。临时预览必须走单文件模式
     * （自包含、无伴生资源目录，清理策略才成立），因此会撞上 50MB 上限；
     * 这时候正确的出路是走正式导出的「HTML + 资源目录」，得说清楚，
     * 别把一句裸报错丢给用户。
     */
    tooLarge:
      "文档中的图片过多，无法生成单文件预览。请改用「导出 ▸ HTML」并选择「HTML + 资源目录」",
  },

  common: {
    open: "打开文件",
    /** 空状态页/入口按钮：挂载一个文件夹为项目（F20；与「打开所在文件夹」是两件事） */
    mountFolder: "打开文件夹",
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
