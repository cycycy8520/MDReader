/**
 * 文案集中处 —— DG 11.7：V1 仅简体中文，预留英文位。
 * 规范：代码中禁止内联中文字符串（className 等技术值除外），一律从这里取。
 * M0 阶段只放脚手架用得到的少量文案，其余随功能落地补充。
 */

export const zhCN = {
  app: {
    name: "MD Viewer",
    /** 中文名候选（DG 5.8），暂不在界面使用 */
    nameZh: "墨读",
  },

  topbar: {
    toggleSidebar: "折叠/展开侧栏",
    find: "查找",
    outline: "大纲",
    export: "导出",
    share: "分享",
    more: "更多",
    untitled: "未打开文件",
  },

  window: {
    minimize: "最小化",
    maximize: "最大化",
    close: "关闭",
  },

  sidebar: {
    filterPlaceholder: "过滤…",
    groupPinned: "置顶",
    groupToday: "今天",
    groupYesterday: "昨天",
    groupWeek: "近 7 天",
    groupEarlier: "更早",
    empty: "还没有最近打开的文件",
    settings: "设置",
  },

  outline: {
    title: "大纲",
    pin: "钉住",
    unpin: "取消钉住",
    empty: "本文档没有标题",
  },

  reading: {
    emptyTitle: "拖入 Markdown 文件，或 Ctrl+O 打开",
    emptyHint: "只读查看器：支持 GFM、Mermaid、KaTeX、代码高亮",
    setDefaultViewer: "设为默认查看器",
  },

  status: {
    words: "字",
    lines: "行",
    zoom: "缩放",
    fontSize: "字号",
    theme: "主题",
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
  },
} as const;

export type Messages = typeof zhCN;

/** V1 单语言：直接导出当前语言包，后续接入多语言时替换为 hook */
export const t = zhCN;
