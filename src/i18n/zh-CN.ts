/**
 * 文案集中处 —— DG 11.7：V1 仅简体中文，预留英文位。
 * 规范：代码中禁止内联中文字符串（className 等技术值除外），一律从这里取。
 * 连带把「非文案但会显示的字形」（如 Hero 标记 M↓、编码名 UTF-8）也收在这里，
 * 免得组件里出现裸字符串。
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
    settings: "设置",

    /**
     * M0 视觉占位数据的文件名。
     * M1 接入 recent.json（services/ipc.listRecent）后，本块与 App.tsx 里的
     * M0_SAMPLE_GROUPS 一并删除。
     */
    sample: {
      readme: "README.md",
      guide: "开发指南.md",
      api: "接口约定.md",
      meeting: "会议纪要 0812.md",
      changelog: "CHANGELOG.md",
      design: "设计规范.md",
    },
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
  },

  status: {
    words: "字",
    lines: "行",
    /** 编码名：技术值，但属可见文本，一并收口 */
    encoding: "UTF-8",
    zoom: "缩放",
    fontSize: "字号",
    theme: "主题",
    toggleTheme: "切换主题",
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
