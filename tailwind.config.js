/**
 * Tailwind 配置 —— 所有颜色/尺寸一律映射到 src/styles/tokens.css 的语义变量，
 * 组件层只写语义类名（bg-canvas / text-secondary / border-l2 …），禁止裸色值（红线 14）。
 *
 * 刻意不启用的默认能力：
 *  - 不用 Tailwind 默认调色板（gray-500 之类），避免绕过 Token 层
 *  - hover 背景不加 transition（参考设计里 hover 是瞬时响应，过渡只给 opacity/transform/尺寸）
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    // 覆盖而非扩展：断掉 Tailwind 默认色板，强制走 Token
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#ffffff",

      canvas: "var(--md-bg-canvas)",
      panel: "var(--md-bg-panel)",
      card: "var(--md-bg-card)",
      layer: "var(--md-bg-layer)",
      code: "var(--md-bg-code)",
      "inline-code": "var(--md-bg-inline-code)",

      hover: "var(--md-bg-hover)",
      active: "var(--md-bg-active)",
      "hover-danger": "var(--md-bg-hover-danger)",

      primary: "var(--md-text-primary)",
      secondary: "var(--md-text-secondary)",
      tertiary: "var(--md-text-tertiary)",
      caption: "var(--md-text-caption)",
      disabled: "var(--md-text-disabled)",
      inverted: "var(--md-text-inverted)",

      brand: "var(--md-brand)",
      "brand-hover": "var(--md-brand-hover)",
      accent: "var(--md-accent)",
      "accent-soft": "var(--md-accent-soft)",

      success: "var(--md-success)",
      warn: "var(--md-warn)",
      danger: "var(--md-danger)",

      tooltip: "var(--md-tooltip-bg)",
      mask: "var(--md-mask)",
    },

    borderColor: {
      DEFAULT: "var(--md-border-l2)",
      transparent: "transparent",
      l1: "var(--md-border-l1)",
      l2: "var(--md-border-l2)",
      l3: "var(--md-border-l3)",
      l4: "var(--md-border-l4)",
      float: "var(--md-border-float)",
      accent: "var(--md-accent)",
      brand: "var(--md-brand)",
    },

    extend: {
      spacing: {
        // 参考设计是 2px 粒度、以 4/6/8/12 为主力，需要这些半档
        4.5: "18px",
        5.5: "22px",
        topbar: "var(--md-topbar-h)",
        statusbar: "var(--md-statusbar-h)",
        sidebar: "var(--md-sidebar-w)",
        outline: "var(--md-outline-w)",
      },

      width: {
        sidebar: "var(--md-sidebar-w)",
        "sidebar-collapsed": "var(--md-sidebar-collapsed)",
        outline: "var(--md-outline-w)",
      },

      maxWidth: {
        reading: "var(--md-reading-w)",
      },

      height: {
        topbar: "var(--md-topbar-h)",
        statusbar: "var(--md-statusbar-h)",
        row: "32px",
        "row-group": "34px",
        btn: "36px",
        "btn-sm": "28px",
        input: "32px",
      },

      borderRadius: {
        // 圆角层级（参考设计的语义分档）
        chip: "6px",
        row: "8px",
        card: "12px",
        btn: "18px",
        modal: "24px",
      },

      fontFamily: {
        ui: "var(--md-font-ui)",
        mono: "var(--md-font-mono)",
      },

      fontSize: {
        // UI chrome 用 14/22 与 13/20，次要信息 12/18
        ui: ["14px", "22px"],
        "ui-sm": ["13px", "20px"],
        "ui-xs": ["12px", "18px"],
        // 阅读区正文与标题
        body: ["16px", "28px"],
        h1: ["24px", "34px"],
        h2: ["22px", "32px"],
        h3: ["20px", "30px"],
        h4: ["16px", "28px"],
        "code-block": ["13px", "22px"],
        "code-inline": ["14px", "22px"],
      },

      boxShadow: {
        lv1: "var(--md-shadow-lv1)",
        lv2: "var(--md-shadow-lv2)",
        lv3: "var(--md-shadow-lv3)",
        // 焦点环：用 box-shadow 而非 outline，不撑破行边界
        focus: "0 0 0 2px var(--md-accent)",
        "focus-subtle": "0 0 0 2px var(--md-border-l3)",
      },

      transitionTimingFunction: {
        standard: "var(--md-ease)",
      },

      transitionDuration: {
        fast: "var(--md-duration-fast)",
        base: "var(--md-duration)",
        slow: "var(--md-duration-slow)",
      },

      backdropBlur: {
        mask: "2px",
        drop: "10px",
      },

      keyframes: {
        "row-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        spin: {
          to: { transform: "rotate(360deg)" },
        },
      },

      animation: {
        "row-in": "row-in 150ms var(--md-ease)",
        "fade-in": "fade-in 160ms ease-out",
        // 行内微 spinner：10px/1.5px/700ms（比整页 spinner 更快更小）
        "spin-micro": "spin 700ms linear infinite",
        "spin-page": "spin 800ms linear infinite",
      },
    },
  },
  plugins: [],
};
