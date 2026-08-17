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
    let started = std::time::Instant::now();
    print_pdf_for_window(&app, PDF_WINDOW_LABEL, &options).await?;
    Ok(ExportResult {
        output: options.output.clone(),
        route: Some(PdfRoute::PrintToPdf),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 执行打印的窗口标签。M0-① PoC 直接打印主窗口；M2 起改为隐藏的打印专用窗口
/// （加载打印模板而非阅读区，避免把 UI 外壳也印进去）。
pub const PDF_WINDOW_LABEL: &str = "main";

/// 主路线：WebView2 `ICoreWebView2_7::PrintToPdf` 静默导出（事实库 #1/#2）。
///
/// 调用链：`with_webview` → `controller()` → `CoreWebView2()` → cast `ICoreWebView2_7`
/// → `environment()` cast `ICoreWebView2Environment6` → `CreatePrintSettings`
/// → `PrintToPdf(path, settings, handler)` → 完成回调经 channel 桥回。
///
/// 三个关键约束：
/// * `with_webview` 的闭包在**主线程**执行且必须是 `'static + Send`，所以结果只能经 channel 出来；
/// * `PrintToPdf` 是异步完成回调，回调里拿到的 `BOOL` 才是「是否真的写出了文件」；
/// * 调用前页面必须已渲染完成（PRINT_READY），否则会印出半张空白。
#[cfg(windows)]
pub async fn print_pdf_for_window(
    app: &AppHandle,
    window_label: &str,
    options: &PdfOptions,
) -> AppResult<()> {
    use std::sync::mpsc;

    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING, PCWSTR};

    let webview = app
        .get_webview_window(window_label)
        .ok_or_else(|| AppError::config(format!("找不到窗口：{window_label}")))?;

    if let Some(parent) = options.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let output = options.output.clone();
    let include_toc = options.include_toc;

    // 闭包在主线程跑，结果经 channel 回到 async 上下文
    let (tx, rx) = mpsc::channel::<Result<bool, String>>();

    webview
        .with_webview(move |platform| {
            // 每一步都可能失败，统一收集为 Result 再一次性送回
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败：{e}"))?;
                let core7: ICoreWebView2_7 = core
                    .cast()
                    .map_err(|e| format!("cast ICoreWebView2_7 失败（WebView2 运行时过旧？）：{e}"))?;
                let env6: ICoreWebView2Environment6 = platform
                    .environment()
                    .cast()
                    .map_err(|e| format!("cast ICoreWebView2Environment6 失败：{e}"))?;

                let settings = unsafe { env6.CreatePrintSettings() }
                    .map_err(|e| format!("CreatePrintSettings 失败：{e}"))?;
                unsafe {
                    // A4 = 8.27 × 11.69 英寸；单位就是英寸（COM 接口以 double 英寸计）
                    let _ = settings.SetPageWidth(A4_WIDTH_IN);
                    let _ = settings.SetPageHeight(A4_HEIGHT_IN);
                    let _ = settings.SetMarginTop(PDF_MARGIN_IN);
                    let _ = settings.SetMarginBottom(PDF_MARGIN_IN);
                    let _ = settings.SetMarginLeft(PDF_MARGIN_IN);
                    let _ = settings.SetMarginRight(PDF_MARGIN_IN);
                    // 去掉浏览器默认的页眉页脚（日期/URL/页码），否则版面不像正式文档
                    let _ = settings.SetShouldPrintHeaderAndFooter(false);
                    // 打印背景图形：代码块底色、表格斑马纹依赖它
                    let _ = settings.SetShouldPrintBackgrounds(true);
                }
                let _ = include_toc; // 文内目录页由前端模板生成（FR-08），此处无对应 COM 选项

                let path = HSTRING::from(output.as_os_str());
                let tx_done = tx.clone();
                // 注意闭包签名：completed_callback 宏已把原始 COM 类型转过一道
                // （HRESULT → windows::core::Result<()>，BOOL → bool），不是裸类型。
                let handler = PrintToPdfCompletedHandler::create(Box::new(
                    move |hr: windows_core::Result<()>, ok: bool| {
                        let msg = match hr {
                            Ok(()) => Ok(ok),
                            Err(e) => Err(format!("PrintToPdf 回调返回错误：{e}")),
                        };
                        let _ = tx_done.send(msg);
                        Ok(())
                    },
                ));

                unsafe { core7.PrintToPdf(PCWSTR(path.as_ptr()), &settings, &handler) }
                    .map_err(|e| format!("PrintToPdf 调用失败：{e}"))?;
                Ok(())
            })();

            // 同步阶段就失败的话，回调永远不会来，必须自己把错误送回去
            if let Err(err) = result {
                let _ = tx.send(Err(err));
            }
        })
        .map_err(|e| AppError::config(format!("with_webview 失败：{e}")))?;

    // 回调在主线程触发，这里必须在阻塞线程上等，否则会把主线程堵死
    let timeout = std::time::Duration::from_secs(PDF_TIMEOUT_SECS);
    let received = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|e| AppError::config(format!("等待打印结果的任务失败：{e}")))?;

    match received {
        Ok(Ok(true)) => {
            tracing::info!(path = %options.output.display(), "PrintToPdf 成功");
            Ok(())
        }
        Ok(Ok(false)) => Err(AppError::config(
            "PrintToPdf 返回失败（未写出文件）；常见原因：输出路径不可写或页面尚未渲染完成"
                .to_string(),
        )),
        Ok(Err(err)) => Err(AppError::config(err)),
        Err(_) => Err(AppError::config(format!(
            "PrintToPdf 超时（{PDF_TIMEOUT_SECS}s）：页面可能未发出 PRINT_READY 或渲染卡住"
        ))),
    }
}

#[cfg(not(windows))]
pub async fn print_pdf_for_window(
    _app: &AppHandle,
    _window_label: &str,
    _options: &PdfOptions,
) -> AppResult<()> {
    Err(AppError::not_implemented(
        "PrintToPdf 仅 Windows 可用".to_string(),
    ))
}

/// A4 纸张尺寸与页边距（英寸），COM 打印设置以英寸计。
pub const A4_WIDTH_IN: f64 = 8.27;
pub const A4_HEIGHT_IN: f64 = 11.69;
pub const PDF_MARGIN_IN: f64 = 0.4;

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
