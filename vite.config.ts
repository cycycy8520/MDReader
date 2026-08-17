import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 在 dev 时通过该环境变量提供移动端/局域网调试主机名；桌面端通常为空
const host = process.env["TAURI_DEV_HOST"];

// Vite 配置：端口固定 1420 且 strictPort（Tauri 的 devUrl 与之硬绑定，端口漂移会导致白屏）
export default defineConfig({
  plugins: [react()],

  // Tauri CLI 自己负责终端输出，Vite 不得清屏，否则 Rust 侧编译错误会被冲掉
  clearScreen: false,

  /**
   * 静态资源根 = vendor/（由 scripts/fetch-vditor.mjs 产出 vendor/vditor/dist/...）。
   * 映射结果：dev 与产物中均可用 /vditor/dist/... 访问，正好等于 preview.ts 里
   * VDITOR_LOCAL_CDN = "/vditor" 的拼接规则（Vditor 内部拼 `${cdn}/dist/...`）。
   * 红线 8：资源必须自托管，不得回落 unpkg/jsdelivr。
   */
  publicDir: "vendor",

  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // src-tauri 由 Rust 侧监听重编，前端不参与，避免重复触发
      ignored: ["**/src-tauri/**"],
    },
  },

  // 只有 VITE_ / TAURI_ENV_ 前缀的变量会被注入前端产物
  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    // Windows 的 WebView2（Chromium）目标；其余平台仅为兜底，本项目只发 Windows
    target: process.env["TAURI_ENV_PLATFORM"] === "windows" ? "chrome105" : "es2021",
    minify: process.env["TAURI_ENV_DEBUG"] ? false : "esbuild",
    sourcemap: Boolean(process.env["TAURI_ENV_DEBUG"]),
  },
});
