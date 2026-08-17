/**
 * 前端入口。样式加载顺序：tokens.css（由 index.css 首行 @import）→ Tailwind 层。
 */

import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles/index.css";
// GitHub 排版基底（github-markdown-css@5.9.0 变量版，MPE 默认主题的同源观感）。
// 顺序契约：必须在 index.css（Tailwind preflight）之后、markdown.css 之前 ——
// markdown.css 顶部的「.markdown-body 变量桥」与基底同特异性，靠源顺序压过
// 它媒体查询里跟系统走的取值（含默认白底），调换顺序 = 深色主题翻车。
import "github-markdown-css/github-markdown.css";
// 正文增量与变量桥（DG 5.4）：必须最后引入，理由见上
import "./styles/markdown.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  // 开发期断言，非用户可见文案，不进 i18n
  throw new Error("Root element #root not found in index.html");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
