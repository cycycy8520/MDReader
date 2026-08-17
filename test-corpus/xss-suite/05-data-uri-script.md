# XSS 样本 05：data: URI 携带脚本

**攻击手法**：`data:` URI 把整个 HTML 文档塞进链接里。历史上 `data:text/html` 在顶层导航时继承源，可直接读取同源数据；即便现代浏览器已限制顶层导航，`<iframe>`、`<object>`、`<embed>` 仍可能加载它。此外 `data:image/svg+xml` 是"图片"里夹带脚本的常见通道。

**预期：脚本不执行、无外网请求。**

**验证方法**：打开本文件 → 无弹窗 → Console 无 `XSS-05` 输出 → 点击下方链接不得发生任何导航 → Elements 面板中 `data:text/html` 类的 `src`/`href`/`data` 应被剥离。

> base64 解码对照（便于人工核对，勿在渲染器中放行）：
> - `PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==` = `<script>alert(1)</script>`
> - `PGh0bWw+PGJvZHk+PHNjcmlwdD5hbGVydCgiWFNTLTA1Iik8L3NjcmlwdD48L2JvZHk+PC9odG1sPg==` = 一个完整的含脚本 HTML 文档
> - `PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiPjwvc3ZnPg==` = 带 `onload` 的 SVG

---

## payload 1：HTML 链接指向 data:text/html

<a href="data:text/html;base64,PGh0bWw+PGJvZHk+PHNjcmlwdD5hbGVydCgiWFNTLTA1Iik8L3NjcmlwdD48L2JvZHk+PC9odG1sPg==">点我-A（base64 HTML）</a>

<a href="data:text/html,<script>alert('XSS-05-B')</script>">点我-B（明文 HTML）</a>

## payload 2：Markdown 链接语法指向 data:

[点我-C（Markdown 语法 + base64）](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)

[点我-D（Markdown 语法 + 明文）](data:text/html,<script>alert('XSS-05-D')</script>)

## payload 3：iframe 加载 data:

<iframe src="data:text/html;base64,PGh0bWw+PGJvZHk+PHNjcmlwdD5hbGVydCgiWFNTLTA1Iik8L3NjcmlwdD48L2JvZHk+PC9odG1sPg==" width="300" height="80"></iframe>

<iframe srcdoc="&lt;script&gt;alert('XSS-05-F')&lt;/script&gt;" width="300" height="80"></iframe>

## payload 4：object / embed 加载 data:

<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" width="300" height="80"></object>

<embed src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiPjwvc3ZnPg==" width="100" height="100">

## payload 5：图片语法加载带脚本的 SVG data URI

![data URI 的 SVG](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiPjwvc3ZnPg==)

<img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>" alt="明文 SVG data URI">

## payload 6：data: 里的 base 与 meta（组合攻击）

<iframe src="data:text/html,<base href='https://xss-beacon.example.invalid/'><img src='x.png'>" width="300" height="80"></iframe>

## payload 7：script src 指向 data:

<script src="data:text/javascript,alert('XSS-05-K')"></script>

<script src="data:text/javascript;base64,YWxlcnQoJ1hTUy0wNS1MJyk="></script>

---

## 对照组（良性 data URI 图片应保留）

一个 1×1 的透明 GIF，属于正常内容，不应被误杀：

<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="1x1 透明 GIF" width="16" height="16">

> **判定口径**：`data:text/html` 与 `data:text/javascript` 一律不得生效；`data:image/svg+xml` 应被拒绝（SVG 可执行脚本）；`data:image/png|gif|jpeg|webp` 属良性，导出单文件 HTML 时正是靠它内联图片，必须保留。
> **注意**：导出单文件 HTML 后，产物中会大量出现 `data:image/...;base64`，这是设计行为，不要与本样本混淆。
