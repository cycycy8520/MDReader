<!--
本模板 = AI_DEV_GUIDE 第 6 节「任务执行协议与完成定义（DoD）」的勾选化。
六步缺一步不算完成。报告纪律：测试失败就说失败并贴输出；跳过的步骤明说跳过；
不确定的标注不确定。禁止"应该没问题"式收尾。
-->

## 1. 这个 PR 做了什么

<!-- 一段话说清改了什么、为什么。关联任务卡：AI_DEV_GUIDE 第 7 节 M0-X / M1 任务卡编号 -->

- 任务卡 / Issue：
- 变更类型：`feat` / `fix` / `refactor` / `docs` / `chore` / `test`

## 2. 对齐（DoD 步骤 1）

> 从 DEV_GUIDE 找到本任务对应的 FR 编号与验收项——**这是本次的验收契约**。

| FR / 验收项编号 | 出处（DG 章节） | 本 PR 是否覆盖 |
|---|---|---|
| FR-xx |  | ✅ / 部分 / 后续 PR |

- [ ] 已列出全部对齐的 FR 编号与验收项，无"顺手改的、没写进契约的行为变更"

## 3. 自测（DoD 步骤 3）—— 贴命令输出

- [ ] `pnpm lint && pnpm test`
- [ ] `cargo test`（在 `src-tauri/`）
- [ ] `cargo clippy -- -D warnings` **零告警**（在 `src-tauri/`）
- [ ] `pnpm check:no-cdn`（产物中无 `unpkg` / `jsdelivr` 字符串，红线 8）
- [ ] `pnpm tauri build` —— **仅在 M0-0 / 触碰打包配置的任务 / 里程碑出口时必跑**；本 PR：跑了 / 不适用
- [ ] 涉及渲染的改动已跑 `test-corpus` 相关语料（自 M0-② 起适用）；本 PR：跑了 / 不适用

<details><summary>命令输出（点开）</summary>

```text
（粘贴关键输出。失败就贴失败输出并说明，不要只写"通过"）
```

</details>

## 4. 验收自查（DoD 步骤 4）

> 逐条核对第 2 节列出的验收项。能自动验证的给证据（命令输出/截图），需真机的标注"待人类验证"。

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 |  | ✅ 达标 / ❌ 未达标 / ⏳ 待人类验证 |  |

- [ ] 未达标项已列出并给出降级预案，或已按 AI_DEV_GUIDE 第 9 节格式上报人类
- [ ] UI 视觉首次成形的改动已附截图交人类过目（AI_DEV_GUIDE 第 9 节）

## 5. 文档同步（DoD 步骤 5）—— **代码与文档不同步 = 任务未完成**

- [ ] 已更新 **DEV_GUIDE.md 9.2 进度表**状态（⬜ / 🔄 / ✅ / ⛔）——进度的唯一事实源
- [ ] 若改动影响 DG 记载的行为或方案：已修改对应章节，并在 **DG 14 更新日志**追加一行
- [ ] 新增/修改快捷键：**先**更新 DG 6.5 快捷键总表（唯一事实源），再写代码（红线 13）
- [ ] 新增 UI Token：先进 DG 5.5，再使用
- [ ] 新增运行时依赖：已登记进 `THIRD-PARTY-NOTICES.md`，且**已获人类批准**（红线 12）
- [ ] M0 任务卡：已在 `docs/m0/` 产出对应验证报告（模板见 `docs/m0/README.md`）
- [ ] 借鉴了参考项目代码：commit message 已注明来源与许可证，并已登记 THIRD-PARTY-NOTICES 4.2（红线 15）

## 6. 红线自查（AI_DEV_GUIDE 第 2 节，逐条确认"没违反"）

**安全**
- [ ] 未关闭 Lute `markdown.sanitize`、未移除 DOMPurify、未放宽 CSP（三层防御一层不少）
- [ ] 未写入/删除/伪造 UserChoice 注册表键（只读检测允许）
- [ ] 新增的注册表写入仅限自家 ProgID 与额外右键动词，且已同步登记到 NSIS 卸载钩子清单
- [ ] 渲染管线中外链图片默认不发起网络请求

**范围**
- [ ] 未引入任何编辑能力（V1 严格只读），哪怕"Vditor 顺带就有"
- [ ] 未实现 DG 2.2 范围外清单中的任何项（便携版 / 遥测 / 钉钉 API / 自动更新等）
- [ ] 未承诺任何绕过 DG 2.3 平台硬约束的功能（"自动发到微信"之类）

**技术**
- [ ] Vditor `cdn` 参数指向本地自托管目录，产物无 unpkg/jsdelivr
- [ ] 长图只走 CDP `Page.captureScreenshot` + `captureBeyondViewport: true`，未使用 CapturePreview
- [ ] `webview2-com` / `windows` crate 版本跟随 Tauri 内部 wry 锁定，未单独升级
- [ ] 未自研官方能力已覆盖的轮子（fileAssociations / single-instance「最先注册」/ clipboard-manager `write_html`）
- [ ] UI 未写裸色值，只引用 DG 5.5 Token；动效遵守 DG 6.1 三条军规
- [ ] TypeScript 无 `any`；组件未直接 `invoke`（一律经 `services/ipc.ts`）；中文文案集中在 `i18n/zh-CN.ts`

**法务**
- [ ] 未复制任何 AGPL-3.0 项目（wandao / MarkFlowy / Inkdown / mdSilo）的代码

## 7. 提交规范（DoD 步骤 6）

- [ ] Conventional Commits，分支名形如 `feat/m0-1-pdf-poc`
- [ ] PR 描述已引用 FR 编号与验收证据（即上面第 2、4 节）

## 8. 备注 / 已知问题 / 留给人类的决策

<!-- 跳过了什么、不确定什么、需要人类拍板什么（给选项 + 你的推荐） -->
