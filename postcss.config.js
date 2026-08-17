// PostCSS：Tailwind + Autoprefixer（WebView2 为 Chromium，前缀需求极少，保留以防 KaTeX 等第三方 CSS）
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
