# XSS 样本 07：事件属性注入（onmouseover 等）

**攻击手法**：不用 `<script>`、不用 `<img>`，直接给**任意良性标签**挂事件属性。HTML 有上百个 `on*` 事件，过滤器一旦采用黑名单就必然漏。本样本刻意混用需要交互触发（`onmouseover`/`onclick`）与自动触发（`ontoggle`/`onfocus`+`autofocus`/`onanimationstart`）两类，后者不需要用户做任何动作。

**预期：脚本不执行、无外网请求。**（含**悬停**与**点击**每个 payload 后仍不执行）

**验证方法**：打开本文件 → 逐个悬停/点击下方元素 → 无弹窗、Console 无 `XSS-07` 输出 → Network 零请求 → Elements 面板中所有 `on*` 属性已被剥离。

---

## payload 1：onmouseover（悬停触发）

<div onmouseover="alert('XSS-07-A')">把鼠标移到这行字上-A</div>

<span onmouseenter="alert('XSS-07-B')">把鼠标移到这行字上-B</span>

<b onpointerover="alert('XSS-07-C')">把鼠标移到这行字上-C</b>

## payload 2：onclick / ondblclick / oncontextmenu（点击触发）

<p onclick="alert('XSS-07-D')">点击这行字-D</p>

<p ondblclick="alert('XSS-07-E')">双击这行字-E</p>

<p oncontextmenu="alert('XSS-07-F')">在这行字上点右键-F</p>

## payload 3：ontoggle（无需用户交互，details 默认展开即触发）

<details open ontoggle="alert('XSS-07-G')">
  <summary>这个折叠块打开时就会触发-G</summary>
  内容
</details>

## payload 4：autofocus + onfocus（页面加载即触发）

<input autofocus onfocus="alert('XSS-07-H')" value="自动聚焦输入框-H">

<textarea autofocus onfocus="alert('XSS-07-I')">自动聚焦文本域-I</textarea>

<select autofocus onfocus="alert('XSS-07-J')"><option>选项</option></select>

## payload 5：CSS 动画驱动（完全无需交互）

<style>@keyframes xss07 { from { opacity: 0.99 } to { opacity: 1 } }</style>
<div style="animation-name:xss07;animation-duration:0.1s" onanimationstart="alert('XSS-07-K')" onanimationend="fetch('https://xss-beacon.example.invalid/07-l')">CSS 动画触发-K/L</div>

## payload 6：滚动与尺寸事件

<div onscroll="alert('XSS-07-M')" style="height:40px;overflow:auto"><div style="height:400px">滚动这个小框-M</div></div>

<body onresize="alert('XSS-07-N')">

## payload 7：表格与列表元素上的事件（结构标签同样可挂）

<table>
  <tr onmouseover="alert('XSS-07-O')"><td>悬停这一行-O</td></tr>
  <tr><td onclick="alert('XSS-07-P')">点击这个单元格-P</td></tr>
</table>

<ul><li onmouseover="alert('XSS-07-Q')">悬停这个列表项-Q</li></ul>

## payload 8：媒体元素事件

<video src="x" onerror="alert('XSS-07-R')" oncanplay="alert('XSS-07-S')" width="200"></video>

<audio src="x" onerror="alert('XSS-07-T')"></audio>

## payload 9：拖拽与剪贴板事件（与本应用的拖入打开、复制功能正面冲突）

<div ondrop="alert('XSS-07-U')" ondragover="alert('XSS-07-V')" style="border:1px dashed #888;padding:8px">往这里拖一个文件-U/V</div>

<div oncopy="alert('XSS-07-W')" oncut="alert('XSS-07-X')" onpaste="alert('XSS-07-Y')">选中这行字并复制-W</div>

---

## 对照组（良性属性应保留）

<div title="这是一个良性的 title 属性，悬停应显示原生 tooltip" class="note" id="benign-block" data-role="note">良性属性块</div>

> **判定口径**：所有 `on*` 一律剥离（白名单策略，而非黑名单）；`title`/`class`/`id`/`data-*` 等良性属性保留。
> **特别注意 payload 9**：本应用自身有"拖入 .md 打开"与"三种复制"功能，文档若能挂 `ondrop`/`oncopy`，等于文档能劫持应用的核心交互——这是本样本中危害最高的一组。
