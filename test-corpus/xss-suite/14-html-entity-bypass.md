# XSS 样本 14：HTML 实体编码绕过

**攻击手法**：同一个字符有十进制实体、十六进制实体、命名实体、百分号编码、Unicode 转义等多种写法，且 HTML 解析器会在**属性值解码之后**才判断协议。基于字符串匹配的过滤器（"包含 `javascript:` 就拦"）在这里必然失效。多重编码（`&amp;#106;`）还会因为"解码一次就放行"的实现而绕过。

**预期：脚本不执行、无外网请求。**

**验证方法**：打开本文件 → 逐条点击/悬停 → 无弹窗、Console 无 `XSS-14` 输出 → Network 零请求 → Elements 面板中检查这些属性解码后的最终值。

> 编码对照表（人工核对用）：
> `&#106;` = `j`、`&#97;` = `a`、`&#118;` = `v`、`&#115;` = `s`、`&#99;` = `c`、`&#114;` = `r`、`&#105;` = `i`、`&#112;` = `p`、`&#116;` = `t`、`&#58;` = `:`、`&#x6a;` = `j`、`&#x3a;` = `:`、`&#9;` = 制表符、`&#10;` = 换行、`&#13;` = 回车

---

## payload 1：单字符实体替换

<a href="java&#115;cript:alert('XSS-14-A')">点我-A（&amp;#115; = s）</a>

<a href="&#106;avascript:alert('XSS-14-B')">点我-B（首字母实体化）</a>

<a href="javascript&#58;alert('XSS-14-C')">点我-C（冒号实体化）</a>

<a href="javascript&#x3a;alert('XSS-14-D')">点我-D（十六进制冒号）</a>

<a href="javascript&colon;alert('XSS-14-E')">点我-E（命名实体冒号）</a>

## payload 2：整串实体化

<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;&#88;&#83;&#83;&#45;&#49;&#52;&#45;&#70;&#39;&#41;">点我-F（全实体化）</a>

<a href="&#x6a;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3a;alert('XSS-14-G')">点我-G（全十六进制）</a>

## payload 3：无分号的实体（HTML 解析器仍会解码）

<a href="&#106avascript:alert('XSS-14-H')">点我-H（缺分号）</a>

<a href="&#0000106avascript:alert('XSS-14-I')">点我-I（前导零填充）</a>

## payload 4：协议中插入编码后的空白字符

<a href="jav&#9;ascript:alert('XSS-14-J')">点我-J（制表符实体）</a>

<a href="jav&#10;ascript:alert('XSS-14-K')">点我-K（换行实体）</a>

<a href="jav&#13;ascript:alert('XSS-14-L')">点我-L（回车实体）</a>

<a href="&#1;javascript:alert('XSS-14-M')">点我-M（控制字符前缀）</a>

## payload 5：双重编码（针对"只解码一次"的实现）

<a href="&amp;#106;avascript:alert('XSS-14-N')">点我-N（双重实体）</a>

<a href="%25 6a avascript:alert('XSS-14-O')">点我-O（双重百分号编码变体）</a>

<a href="java%2573cript:alert('XSS-14-P')">点我-P（%2573 二次解码为 s）</a>

## payload 6：事件属性值中的实体

<img src=x onerror="&#97;lert('XSS-14-Q')">

<div onmouseover="&#x61;lert('XSS-14-R')">悬停这行字-R</div>

<img src=x onerror="&#101;val('al'+'ert(\'XSS-14-S\')')">

## payload 7：实体化的标签括号（试图重建 script 标签）

&#60;script&#62;alert('XSS-14-T')&#60;/script&#62;

&lt;script&gt;alert('XSS-14-U')&lt;/script&gt;

&#x3c;script&#x3e;alert('XSS-14-V')&#x3c;/script&#x3e;

预期：以上三行应当作为**可见文本**显示成 `<script>alert(...)</script>` 的字面形态，**不得**被二次解析成真正的标签。这是"过度解码"缺陷的探针——若渲染后页面上看不见这三行文字，说明它们被当成标签处理了。

## payload 8：Markdown 语法 + 实体（跨样本组合）

[点我-W](java&#115;cript:alert('XSS-14-W'))

[点我-X](&#106;avascript:alert('XSS-14-X'))

## payload 9：Unicode 与同形字混淆

<a href="ｊａｖａｓｃｒｉｐｔ:alert('XSS-14-Y')">点我-Y（全角字母）</a>

<a href="java&#x0073;cript&#x0000003a;alert('XSS-14-Z')">点我-Z（补零十六进制）</a>

---

## 对照组（正常实体应正确显示为字符）

- 转义的和号：`&amp;` 应显示为 &amp;
- 转义的尖括号：`&lt;` `&gt;` 应显示为 &lt; &gt;
- 转义的引号：`&quot;` `&#39;` 应显示为 &quot; &#39;
- 版权与破折号：`&copy;` `&mdash;` 应显示为 &copy; &mdash;
- 不间断空格：前&nbsp;后

> **判定口径**：所有 payload 失效（不弹窗、不发请求、不导航）+ payload 7 的三行以**文本形式可见** + 对照组实体正确显示为字符 = 通过。
> **实现建议**：判定协议时必须先做**完整解码 + 去空白 + 转小写**再匹配白名单协议（`http`/`https`/`mailto`/应用自定义的本地资源协议），而不是对原始字符串做黑名单匹配。
