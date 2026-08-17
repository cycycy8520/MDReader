# XSS 样本 13：Markdown 链接语法内藏 javascript:

**攻击手法**：不写一个 HTML 标签，全部用**纯 Markdown 语法**。这是最"无辜"的攻击面——文档看起来完全是正常 Markdown，消毒器若只处理内联 HTML 而信任 Markdown 解析器的输出，就会中招。Lute 的 CVE-2026-25647 正属于此类（href 注入）。

本样本覆盖：内联链接、引用式链接、自动链接、图片语法、以及各种大小写/编码/空白混淆。

**预期：脚本不执行、无外网请求。**（需**逐条点击**）

**验证方法**：打开本文件 → 逐条点击 → 无弹窗、Console 无 `XSS-13` 输出 → 不发生任何导航 → Elements 面板中这些 `<a>` 的 `href` 已被替换为无害值。

---

## payload 1：内联链接基础形态

[点我-A](javascript:alert('XSS-13-A'))

[点我-B](javascript:void(alert('XSS-13-B')))

## payload 2：大小写混淆

[点我-C](JavaScript:alert('XSS-13-C'))

[点我-D](JAVASCRIPT:alert('XSS-13-D'))

## payload 3：前后空白与不可见字符

[点我-E]( javascript:alert('XSS-13-E'))

[点我-F](	javascript:alert('XSS-13-F'))

[点我-G](
javascript:alert('XSS-13-G'))

## payload 4：尖括号包裹（CommonMark 允许的写法）

[点我-H](<javascript:alert('XSS-13-H')>)

[点我-I](<javascript:alert("XSS-13-I")>)

## payload 5：百分号编码与实体混淆

[点我-J](java%73cript:alert('XSS-13-J'))

[点我-K](javascript&#58;alert('XSS-13-K'))

[点我-L](&#106;avascript:alert('XSS-13-L'))

## payload 6：引用式链接（定义与使用分离，最容易漏过滤）

[点我-M][ref-js]

[点我-N][ref-data]

[点我-O][ref-vb]

[ref-js]: javascript:alert('XSS-13-M')
[ref-data]: data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==
[ref-vb]: vbscript:msgbox('XSS-13-O')

## payload 7：带 title 的链接（title 里也能塞东西）

[点我-P](javascript:alert('XSS-13-P') "标题也是攻击者可控的")

[点我-Q](https://v2.tauri.app/ "\" onmouseover=\"alert('XSS-13-Q')")

## payload 8：图片语法（src 走 javascript 协议）

![图片-R](javascript:alert('XSS-13-R'))

[![图片链接-S](../assets/architecture.png)](javascript:alert('XSS-13-S'))

## payload 9：自动链接语法

<javascript:alert('XSS-13-T')>

<data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==>

<vbscript:msgbox('XSS-13-V')>

## payload 10：脚注定义里的恶意链接（脚注区同样要消毒）

正文引用一个脚注[^evil]，脚注内容出现在文末，容易被遗漏。

[^evil]: 这是脚注里的恶意链接：[点我-W](javascript:alert('XSS-13-W'))，以及一张外链图片 ![外链](https://xss-beacon.example.invalid/13-x.png)

## payload 11：表格单元格内的恶意链接

| 场景 | 链接 |
| --- | --- |
| 表格内 javascript 链接 | [点我-Y](javascript:alert('XSS-13-Y')) |
| 表格内 data URI | [点我-Z](data:text/html,<script>alert('XSS-13-Z')</script>) |

## payload 12：列表与引用块内的恶意链接

- [列表内-AA](javascript:alert('XSS-13-AA'))

> [引用块内-AB](javascript:alert('XSS-13-AB'))

---

## 对照组（良性 Markdown 链接必须可用）

- [良性外链](https://v2.tauri.app/)
- [良性相对 .md 链接](../full-gfm.md)
- [良性锚点](#payload-1内联链接基础形态)
- 裸 URL 自动链接：https://github.com/Vanessa219/vditor
- 邮件自动链接：<mailto:noreply@example.invalid>

> **判定口径**：payload 全部失效 + 对照组五条全部可用 = 通过。
> **回归纪律（红线）**：每次升级 Vditor / Lute **必须**重跑本文件——href 注入是该依赖链的历史高发缺陷类型。
