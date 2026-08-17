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

    // M0-① PoC 验证入口（仅在设置环境变量时触发，正常启动不受影响）
    if let Ok(poc) = std::env::var(PDF_POC_ENV) {
        spawn_pdf_poc(app.handle().clone(), poc);
    }

    Ok(())
}

/// M0-① 验证开关：设为 `<html路径>|<pdf输出路径>` 即在启动后自动跑一次静默导出。
/// 这是**临时验证脚手架**，M2 打印模板落地后删除。
pub const PDF_POC_ENV: &str = "MDNAONAO_PDF_POC";

/// 打开测试页 → 等待渲染 → 调 PrintToPdf → 打印结果并退出进程。
///
/// 说明：此处用固定等待而非 PRINT_READY 事件，因为测试页是独立 HTML、
/// 没有打包 Tauri 的 JS API，emit 不到宿主。M2 的打印模板由我们自己的前端渲染，
/// 届时改为等 [`crate::export::PRINT_READY_EVENT`]（DG 7.2-4）。
fn spawn_pdf_poc(app: tauri::AppHandle, spec: String) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    tauri::async_runtime::spawn(async move {
        let (html, out) = match spec.split_once('|') {
            Some((h, o)) => (h.to_string(), std::path::PathBuf::from(o)),
            None => {
                tracing::error!("PDF PoC 参数格式应为 <html>|<pdf>");
                app.exit(2);
                return;
            }
        };

        let url = match url::Url::from_file_path(&html) {
            Ok(u) => u,
            Err(()) => {
                tracing::error!(%html, "测试页路径无法转为 file:// URL（需绝对路径）");
                app.exit(2);
                return;
            }
        };

        tracing::info!(%url, "PDF PoC：创建打印窗口");
        let build = WebviewWindowBuilder::new(&app, "pdfpoc", WebviewUrl::External(url))
            .title("PDF PoC")
            .inner_size(900.0, 1200.0)
            .visible(false)
            .build();
        if let Err(err) = build {
            tracing::error!(%err, "PDF PoC：创建窗口失败");
            app.exit(2);
            return;
        }

        // 等待 Mermaid/KaTeX/字体渲染完成（测试页自身约 1–2s，留足余量）
        let wait_secs: u64 = std::env::var("MDNAONAO_PDF_POC_WAIT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(6);
        tracing::info!(wait_secs, "PDF PoC：等待页面渲染");
        tokio::time::sleep(std::time::Duration::from_secs(wait_secs)).await;

        let options = export::PdfOptions {
            output: out.clone(),
            include_toc: false,
        };
        let started = std::time::Instant::now();
        match export::print_pdf_for_window(&app, "pdfpoc", &options).await {
            Ok(()) => {
                let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
                tracing::info!(
                    path = %out.display(),
                    bytes = size,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "PDF PoC：导出成功"
                );
                let _ = app.get_webview_window("pdfpoc").map(|w| w.close());
                app.exit(0);
            }
            Err(err) => {
                tracing::error!(%err, "PDF PoC：导出失败");
                app.exit(1);
            }
        }
    });
}
