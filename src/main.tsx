/**
 * 前端入口。样式加载顺序：tokens.css（由 index.css 首行 @import）→ Tailwind 层。
 *
 * 【一份 bundle，两种窗口】
 * 同一个 index.html 既是主窗口也是「打印/导出隐藏窗口」，靠 Rust 注入的
 * `__MDNAONAO_PRINT_JOB__` 分流（见 render/printTemplate.ts）。分流必须发生在
 * **挂载 React 之前**：打印窗口一旦挂上 App，左栏顶栏就会跟着被印进 PDF，
 * 而 PRINT_READY 永远不会有人发，Rust 只能等到超时再把那套界面外壳印出来。
 *
 * 三条 CSS 的 import 对两种窗口都必要 —— 打印文档的样式正是靠它们先被加载进
 * document，collectPrintStyles() 才收集得到（见 printTemplate.ts 文件头末段）。
 */

import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { readLongImageJob, renderLongImagePage } from "./render/longImage";
import { readPrintJob, renderPrintPage } from "./render/printTemplate";
import "./styles/index.css";
// GitHub 排版基底（github-markdown-css@5.9.0 变量版，MPE 默认主题的同源观感）。
// 顺序契约：必须在 index.css（Tailwind preflight）之后、markdown.css 之前 ——
// markdown.css 顶部的「.markdown-body 变量桥」与基底同特异性，靠源顺序压过
// 它媒体查询里跟系统走的取值（含默认白底），调换顺序 = 深色主题翻车。
import "github-markdown-css/github-markdown.css";
// 正文增量与变量桥（DG 5.4）：必须最后引入，理由见上
import "./styles/markdown.css";

// 【顺序不能反】长图必须先判。readPrintJob 对认不出的 mode 一律兜底成 "pdf"，
// 所以放到它后面的话，长图作业会被静默当成 PDF 渲染——**不报错**，只是版式变成
// A4 的 717px 无留白 15px 字号，截出来的图看着"就是丑了点"，极难倒查。
const imageJob = readLongImageJob();
const printJob = imageJob === null ? readPrintJob() : null;

if (imageJob !== null) {
  // 长图窗口：微信版式（720px 画布 + 留白），同样不挂载应用
  void renderLongImagePage(imageJob);
} else if (printJob !== null) {
  // 打印/导出窗口：只渲染文档本身，绝不挂载应用
  void renderPrintPage(printJob);
} else {
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
}
