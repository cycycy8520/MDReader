# MD Viewer for Windows

Windows 轻量 Markdown 查看器（Tauri 2 + React + Vditor），严格只读，差异化 = Obsidian 一键导入 + 微信长图/飞书分享。当前阶段：M0 技术验证（进度见 DEV_GUIDE.md 9.2）。

## 文档体系（先读这个再干活）

1. **[AI_DEV_GUIDE.md](AI_DEV_GUIDE.md)** —— 你的执行手册：启动协议、红线、已核验事实库、任务卡、完成定义。**每次会话按其第 1 节"启动协议"开始。**
2. **[DEV_GUIDE.md](DEV_GUIDE.md)（v0.2）** —— 需求与方案的唯一事实来源。按任务需要查阅对应章节，冲突时以它为准。

## 红线速览（完整 15 条见 AI_DEV_GUIDE.md 第 2 节）

- XSS 三层防御（sanitize + DOMPurify + CSP）永不削弱；UserChoice 注册表永不写入（只读检测允许）。
- V1 严格只读：不实现任何编辑能力，哪怕"顺手"。
- Vditor 资源必须本地自托管，产物出现 unpkg/jsdelivr 即失败。
- 长图只走 CDP captureBeyondViewport（CapturePreview 截不了长图）。
- 官方能力优先：fileAssociations / single-instance（最先注册）/ clipboard-manager write_html，不自研这三样。
- 新运行时依赖、偏离既定方案 → 先问人类。
- 技术断言已全部联网核验过（AI_DEV_GUIDE.md 第 3 节事实库）——不要重新调研，发现矛盾先报告。

## 常用命令

建仓后回填：`pnpm tauri dev` / `pnpm lint && pnpm test` / `cargo test && cargo clippy -- -D warnings`（在 src-tauri/ 下）。
