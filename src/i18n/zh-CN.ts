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
  },

  sidebar: {
    searchPlaceholder: "搜索文件",
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
  },

  outline: {
    title: "大纲",
    pin: "钉住",
    unpin: "取消钉住",
    close: "关闭大纲",
    empty: "此文档没有标题结构",
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
