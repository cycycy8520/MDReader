/**
 * Tailwind 配置：所有视觉值一律映射到 src/styles/tokens.css 的 CSS 变量。
 * 红线 14：UI 中不写裸色值，只引用 DG 5.5 的 Token —— 因此此处只允许出现 var(--...)。
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // 语义色（DG 5.5，深浅主题共用同一套语义名）
      colors: {
        canvas: "var(--color-bg-canvas)",
        panel: "var(--color-bg-panel)",
        card: "var(--color-bg-card)",
        code: "var(--color-bg-code)",
        line: "var(--color-border)",
        primary: "var(--color-text-primary)",
        secondary: "var(--color-text-secondary)",
        brand: {
          DEFAULT: "var(--color-brand)",
          soft: "var(--color-brand-soft)",
        },
        success: "var(--color-success)",
        warn: "var(--color-warn)",
        danger: "var(--color-danger)",
      },
      // 裸 `border` 类默认取 Token 描边色，避免误用 Tailwind 默认灰
      borderColor: {
        DEFAULT: "var(--color-border)",
      },
      // 字体栈（DG 5.6）
      fontFamily: {
        ui: "var(--font-ui)",
        body: "var(--font-body)",
        mono: "var(--font-mono)",
      },
      // 圆角三档（DG 5.7）：sm=4 小控件 / md=8 卡片输入框代码块 / lg=12 弹窗菜单
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      // 阴影两档（DG 5.7，浅色主题透明度在 tokens.css 中减半）
      boxShadow: {
        card: "var(--shadow-card)",
        float: "var(--shadow-float)",
      },
      // 布局尺寸（DG 5.2）
      height: {
        topbar: "var(--size-topbar)",
        statusbar: "var(--size-statusbar)",
      },
      minHeight: {
        topbar: "var(--size-topbar)",
      },
      width: {
        sidebar: "var(--size-sidebar)",
        outline: "var(--size-outline)",
        find: "var(--size-find)",
      },
      minWidth: {
        sidebar: "var(--size-sidebar-min)",
      },
      maxWidth: {
        sidebar: "var(--size-sidebar-max)",
        reading: "var(--size-reading)",
      },
      // 动效（DG 6.3；prefers-reduced-motion 下 tokens.css 将时长归零）
      transitionDuration: {
        hover: "var(--duration-hover)",
        press: "var(--duration-press)",
        panel: "var(--duration-panel)",
        overlay: "var(--duration-overlay-in)",
      },
      transitionTimingFunction: {
        standard: "var(--ease-standard)",
      },
    },
  },
  plugins: [],
};
