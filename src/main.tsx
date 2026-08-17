/**
 * 前端入口。样式加载顺序：tokens.css（由 index.css 首行 @import）→ Tailwind 层。
 */

import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles/index.css";

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
