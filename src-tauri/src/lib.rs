//! MDNaonao 后端库入口：模块声明与启动流程。
//!
//! 模块划分严格对应 DG 7.1，一个模块一份职责，不要跨模块塞逻辑：
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`files`] | 文件读取、编码检测、标题提取、recent.json、notify 监听 |
//! | [`export`] | 打印模板组装、PrintToPdf COM 桥接、CDP 兜底 |
//! | [`capture`] | 长图（CDP captureScreenshot + captureBeyondViewport） |
//! | [`share`] | 分享通道（微信 / 飞书 / 钉钉），飞书 API 在 [`share::lark`] |
//! | [`obsidian`] | Vault 枚举、复制导入、URI 唤起 |
//! | [`shell_integ`] | **仅**额外右键动词（关联本身交给 bundler） |
//! | [`settings`] | 配置读写、飞书密钥 DPAPI 加密 |
//! | [`cmdline`] | `--action` clap 解析（cli 插件与单实例回调共用） |
//! | [`logging`] | 文件日志与轮转 |
//! | [`error`] | 全局 `AppError` |
//!
//! **Tauri `Builder` 链写在 `main.rs`**——插件注册顺序是硬性约束
//! （single-instance 必须最先），集中在一处才好审查，不要挪进本文件。

pub mod capture;
pub mod cmdline;
pub mod error;
pub mod export;
pub mod files;
pub mod logging;
pub mod obsidian;
pub mod settings;
pub mod share;
pub mod shell_integ;

use tauri::App;

/// 启动流程入口：由 `main.rs` 在 `Builder::setup` 阶段调用。
///
/// 这里只做「窗口出现之前必须完成」的事；耗时操作一律不要放这里（冷启动预算
/// ≤3s 含 ≤300ms splash，DG 3.2）。
///
/// TODO(M1)：
/// * 恢复窗口几何（[`settings::WindowGeometry`]，DG 6.2「窗口记忆」），
///   异常位置回落主屏居中；
/// * 把 [`settings::Settings`] 注入 `app.manage()` 供各命令共享；
/// * 冷启动命令行分发（[`cmdline::handle_first_instance`]）。
pub fn run(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "MDNaonao 启动（严格只读模式）"
    );

    // 命令行解析失败不阻塞启动：内部已降级为「无参数启动」
    cmdline::handle_first_instance(app.handle())?;

    Ok(())
}
