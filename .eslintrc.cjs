// ESLint 配置（eslintrc 经典格式，配合 @typescript-eslint 7.x + ESLint 8.x）
// 规范依据：AI_DEV_GUIDE 第 5 节「编码规范」
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: [
    "dist",
    "node_modules",
    "src-tauri",
    "vendor",
    "test-corpus",
    "public",
    "*.cjs",
  ],
  rules: {
    // 禁止 any（确需逃逸用 unknown + 收窄）
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/consistent-type-imports": [
      "warn",
      { prefer: "type-imports", fixStyle: "inline-type-imports" },
    ],
    // 组件禁止直接 invoke / emit：一律经 src/services/ipc.ts（DG 7.1 服务层）
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@tauri-apps/api/core",
            message: "禁止直接调用 invoke，请在 src/services/ipc.ts 中封装后使用。",
          },
          {
            name: "@tauri-apps/api/event",
            message: "禁止直接收发事件，请在 src/services/ipc.ts 中封装后使用。",
          },
        ],
      },
    ],
    eqeqeq: ["error", "always"],
    "no-console": ["warn", { allow: ["warn", "error"] }],
  },
  overrides: [
    {
      // ipc.ts 是唯一允许接触 Tauri 原始 API 的模块
      files: ["src/services/ipc.ts"],
      rules: { "no-restricted-imports": "off" },
    },
    {
      files: ["scripts/**/*.mjs", "*.config.js", "*.config.ts"],
      env: { node: true, browser: false },
    },
  ],
};
