//! DG 7.1 `export.rs` 职责：打印模板组装；PrintToPdf COM 桥接；CDP 兜底驱动。
//!
//! 三条路线（DG 4.1 PDF 三行 + DG 8「PDF 静默导出/兜底」+ 事实库 #1–4）：
//! 1. **主路线**：`with_webview` 拿 ICoreWebView2 → `cast::<ICoreWebView2_7>()`
//!    → `ICoreWebView2Environment6::CreatePrintSettings`（A4 / 边距 / 去页眉页脚）
//!    → `PrintToPdf` → 完成回调经 channel 桥回 async command，超时 30s。
//!    wry 0.56 只有弹窗 `print()`（wry#707 仍 open），社区无现成 PDF 插件，
//!    COM 自行桥接是唯一主路线。
//! 2. **兜底 A**：headless_chrome / chromiumoxide 经 CDP 驱动**系统 msedge.exe**
//!    调 `Page.printToPDF`（推荐兜底，规避 CLI 回归）。
//! 3. **兜底 B（最后手段）**：`msedge --headless --print-to-pdf --no-pdf-header-footer`，
//!    Edge 141 起有「无报错不出文件」回归（Chromium #381548416），
//!    `--headless=old` 已自 Chromium 132 移除。
//!
//! 硬性注意：
//! * `webview2-com` / `windows` 版本必须与 wry 锁定一致（红线 10）；
//! * 打印前必须等前端 `PRINT_READY` 事件（Mermaid / 字体渲染完成，DG 7.2-4）；
//! * msedge.exe 一律经 `App Paths` 注册表探测（事实库 #4），
//!   **不得硬编码 Program Files 路径，也不得以「WebView2 Runtime 存在」推断 Edge 存在**；
//! * PrintToPdf 不产生 PDF 书签，「目录」只能是文内目录页（FR-08，需如实告知用户）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::settings::HtmlExportMode;

/// 前端渲染完成信号的事件名（前后端契约，前端 `render/preview.ts` 负责 emit）。
pub const PRINT_READY_EVENT: &str = "PRINT_READY";

/// PDF 导出超时（DG 8：超时 30s）。
pub const PDF_TIMEOUT_SECS: u64 = 30;

/// msedge.exe 的 App Paths 注册表位置（HKLM 与 HKCU 都要查，事实库 #4）。
pub const EDGE_APP_PATHS_KEY: &str =
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe";

/// PDF 导出走通的实际路线，写进日志与验证报告（M0-① 需要记录耗时与失败模式）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfRoute {
    /// 主路线：WebView2 ICoreWebView2_7::PrintToPdf
    PrintToPdf,
    /// 兜底 A：CDP 驱动系统 msedge.exe
    CdpEdge,
    /// 兜底 B：msedge headless CLI（最后手段）
    EdgeCli,
}

/// PDF 导出选项（FR-08）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOptions {
    /// 输出文件路径
    pub output: PathBuf,
    /// 是否插入文内目录页（PrintToPdf 不产生 PDF 书签，只能做文内目录）
    pub include_toc: bool,
}

/// 导出结果，回传前端做 toast 与「打开所在文件夹」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output: PathBuf,
    pub route: Option<PdfRoute>,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// 命令骨架
// ---------------------------------------------------------------------------

/// 导出 HTML（FR-07）：单文件（图片 base64 内联）或 HTML + `xxx_files/` 资源目录。
///
/// TODO(M1)：两种模式共用同一个附件路径解析器（DG 8「附件路径重写」+ DG 10-5：
/// 相对 / 绝对 / 中文 / 空格 / UNC 路径全部进语料库，三条重写路径修一处即修三处）。
#[tauri::command]
pub async fn export_html(
    app: AppHandle,
    source: String,
    output: PathBuf,
    mode: HtmlExportMode,
) -> AppResult<ExportResult> {
    let _ = app;
    Err(AppError::not_implemented(format!(
        "export::export_html（M1）：{source} → {} mode={mode:?}",
        output.display()
    )))
}

/// 导出 PDF（FR-08）：主路线失败自动降级兜底 A；均失败才提示用户。
///
/// TODO(M0-①/M2)：先在 M0-① 用 `docs/m0/print-poc.html` 打通两条路线，
/// 再在 M2 接入真实打印模板。
#[tauri::command]
pub async fn export_pdf(app: AppHandle, options: PdfOptions) -> AppResult<ExportResult> {
    let _ = app;
    Err(AppError::not_implemented(format!(
        "export::export_pdf（M0-①/M2）：{}",
        options.output.display()
    )))
}

/// 打印（FR-17 / Ctrl+P）：调起系统打印对话框，使用与 PDF 相同的打印模板。
///
/// TODO(M2)：wry 只提供弹窗式 `print()`，此处正是它的正确用途。
#[tauri::command]
pub async fn print_document(app: AppHandle) -> AppResult<()> {
    let _ = app;
    Err(AppError::not_implemented("export::print_document（M2）"))
}

// ---------------------------------------------------------------------------
// 主路线：PrintToPdf COM 桥接位
// ---------------------------------------------------------------------------

/// 隐藏窗口加载打印模板 → 等 [`PRINT_READY_EVENT`] → COM `PrintToPdf`。
///
/// TODO(M0-①)：实现要点（事实库 #2 的范例为 SO 78327694 的被采纳答案 78330108，
/// 该范例基于 Tauri 1.x + webview2-com 0.19，移植到 Tauri 2 时注意版本对齐）：
/// 1. `cargo tree -i webview2-com` / `cargo tree -i windows` 核对版本并写死进 Cargo.toml；
/// 2. `window.with_webview(|webview| { ... })` 内拿 `ICoreWebView2`；
/// 3. `cast::<ICoreWebView2_7>()`（可 cast 更高版本接口）；
/// 4. `ICoreWebView2Environment6::CreatePrintSettings` 设 A4 / 边距 / 去页眉页脚；
/// 5. `PrintToPdf` 的完成回调经 channel 桥回 async command，加 [`PDF_TIMEOUT_SECS`] 超时；
/// 6. 隐藏窗口的生命周期：无论成功失败都必须关闭，避免僵尸窗口。
pub async fn print_to_pdf_com(app: &AppHandle, options: &PdfOptions) -> AppResult<ExportResult> {
    let _ = (app, options);
    Err(AppError::not_implemented(
        "export::print_to_pdf_com（M0-① 主路线）",
    ))
}

// ---------------------------------------------------------------------------
// 兜底：CDP / CLI
// ---------------------------------------------------------------------------

/// 兜底 A：CDP 驱动系统 msedge.exe 调 `Page.printToPDF`。
///
/// TODO(M0-①)：驱动库（headless_chrome / chromiumoxide）属于新增运行时依赖，
/// 按红线 12 须先向人类申请后再写进 Cargo.toml。
pub async fn print_to_pdf_cdp(options: &PdfOptions) -> AppResult<ExportResult> {
    let _ = options;
    Err(AppError::not_implemented(
        "export::print_to_pdf_cdp（M0-① 兜底 A）",
    ))
}

/// 探测系统 msedge.exe 真实路径：HKCU 优先，其次 HKLM，读 [`EDGE_APP_PATHS_KEY`] 默认值。
///
/// 探测失败必须**隐藏兜底选项**而不是硬编码路径（事实库 #4）。
///
/// TODO(M0-①)：用 winreg 实现。
pub fn locate_edge() -> AppResult<PathBuf> {
    Err(AppError::not_implemented("export::locate_edge（M0-①）"))
}

/// 组装打印模板（A4、`@media print`、可选文内目录页）。
///
/// 模板由前端渲染（保证「预览 = 导出」同源），本函数只负责把参数传给前端并等待
/// [`PRINT_READY_EVENT`]。
///
/// TODO(M2)：与前端 `render/preview.ts` 对齐模板参数。
pub fn build_print_payload(include_toc: bool) -> AppResult<String> {
    let _ = include_toc;
    Err(AppError::not_implemented(
        "export::build_print_payload（M2）",
    ))
}
