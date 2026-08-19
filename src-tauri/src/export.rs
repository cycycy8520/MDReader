//! DG 7.1 `export.rs` 职责：打印窗口编排；PrintToPdf COM 桥接；CDP 兜底驱动。
//!
//! 三条路线（DG 4.1 PDF 三行 + DG 8「PDF 静默导出/兜底」+ 事实库 #1–4）：
//! 1. **主路线**：`with_webview` 拿 ICoreWebView2 → `cast::<ICoreWebView2_7>()`
//!    → `ICoreWebView2Environment6::CreatePrintSettings`（A4 / 边距 / 去页眉页脚）
//!    → `PrintToPdf` → 完成回调经 channel 桥回 async command，超时 30s。
//!    wry 0.56 只有弹窗 `print()`（wry#707 仍 open），社区无现成 PDF 插件，
//!    COM 自行桥接是唯一主路线。
//! 2. **兜底 A**：CDP `Page.printToPDF`。**本次落地的是「经 WebView2 自带 CDP 通道」
//!    这一变体**（[`print_to_pdf_cdp`]），而不是 DG 原文写的「外部库驱动系统 msedge.exe」——
//!    理由见 [`print_to_pdf_cdp_edge`] 的文档注释（一句话：驱动外部 Edge 需要 WebSocket/CDP
//!    客户端这一**新增运行时依赖**，按红线 12 须先向人类申请；而同一个 CDP 方法经
//!    `CallDevToolsProtocolMethod` 调用零依赖、且与长图（capture.rs）复用同一条通道）。
//!    外部 Edge 变体的前置件 [`locate_edge`] 本次已实装，补上依赖即可接通。
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
//!
//! ## M2 改造要点：打印的是**专用隐藏窗口**，不是主窗口
//!
//! M0-① 的 PoC 直接打印主窗口，那会把左栏 / 顶栏 / 状态栏一起印进 PDF。
//! 现在的编排是：
//!
//! ```text
//! export_pdf / print_document
//!   ├─ arm_print_ready()          先挂监听，再建窗口（顺序不能反，否则会漏掉早到的信号）
//!   ├─ open_print_window()        隐藏窗口加载应用自身页面，
//!   │                             initialization_script 注入 PRINT_JOB_GLOBAL
//!   │                             → 前端 main.tsx 读到任务就走 render/printTemplate.ts
//!   │                               的 renderPrintPage()，**不挂载 React 应用**
//!   ├─ await_print_ready()        等 PRINT_READY（超时则按现状打印并 warn）
//!   ├─ PrintToPdf / ShowPrintUI
//!   └─ close_print_window()       无论成败都关，绝不留僵尸窗口
//! ```

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::settings::HtmlExportMode;

/// 前端渲染完成信号的事件名（前后端契约，前端 `render/printTemplate.ts` 负责 emit）。
pub const PRINT_READY_EVENT: &str = "PRINT_READY";

/// PDF 导出超时（DG 8：超时 30s）。指的是 `PrintToPdf` 自身的完成回调等待时长。
pub const PDF_TIMEOUT_SECS: u64 = 30;

/// 等前端 `PRINT_READY` 的上限。
///
/// 与 [`PDF_TIMEOUT_SECS`] 是两段独立预算：前者等「页面渲染完了没」，后者等「PDF 写出来了没」。
/// 20s 的依据是前端渲染管线自己的就绪上限（8s）+ 字体（3s）+ 冷启动 WebView 的余量；
/// 超时不算失败，只 warn 后按现状开印——半张图总比什么都没有强，且失败模式在日志里可查。
pub const PRINT_READY_TIMEOUT_SECS: u64 = 20;

/// 打印专用窗口的 label。
///
/// **必须同步给 `src-tauri/capabilities/`**：Tauri 2 的 ACL 按窗口 label 授权，
/// 没有任何 capability 覆盖该 label 时，这扇窗口连 `plugin:event|emit` 都调不动，
/// PRINT_READY 永远发不出来（表现为每次导出都等满 [`PRINT_READY_TIMEOUT_SECS`]）。
pub const PRINT_WINDOW_LABEL: &str = "print";

/// 注入到打印窗口的任务全局变量名。
/// **必须与 `src/render/printTemplate.ts` 的 `PRINT_JOB_GLOBAL` 逐字一致。**
pub const PRINT_JOB_GLOBAL: &str = "__MDNAONAO_PRINT_JOB__";

/// 打印窗口标题。窗口本身是隐藏的，但系统打印对话框会以宿主窗口的标题作为任务名，
/// 打印队列里显示 "print" 会很奇怪，所以给应用名。
/// （Rust 侧没有 i18n 文件，这里是产品名而非可译文案。）
const PRINT_WINDOW_TITLE: &str = "MDNaonao";

/// 打印窗口尺寸（逻辑像素）。取 A4 @96dpi 的整页大小：794×1123。
///
/// 窗口是隐藏的，尺寸只影响 WebView 的视口——而视口宽度会参与前端的媒体查询判定
/// （markdown.css 有 `max-width: 720px` 的窄屏收边距规则）。给足 A4 宽度，
/// 排版才与打印模板里写死的 717px 正文宽一致。
pub const PRINT_WINDOW_WIDTH: f64 = 794.0;
pub const PRINT_WINDOW_HEIGHT: f64 = 1123.0;

/// 关掉旧打印窗口后、建新窗口前的让路时间（毫秒）。
/// 窗口销毁是异步排队的，紧接着用同一个 label 建窗有概率撞上「label 已存在」。
const PRINT_WINDOW_RECYCLE_MS: u64 = 120;

/// 系统打印对话框弹出后，打印窗口的存活时长（秒）。
///
/// `ShowPrintUI` 只负责「把对话框弹出来」，没有完成回调（有完成回调的是 `Print`，
/// 那是静默送打印机、需要我们自备设置 UI 的路径）。所以这里无法精确知道用户何时点完，
/// 只能给一个足够长的存活期兜底关闭；下一次导出/打印开始时也会先清掉残留窗口。
const PRINT_DIALOG_LINGER_SECS: u64 = 300;

/// msedge.exe 的 App Paths 注册表位置（HKCU 与 HKLM 都要查，事实库 #4）。
pub const EDGE_APP_PATHS_KEY: &str =
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe";

/// A4 纸张尺寸与页边距（英寸），COM 打印设置以英寸计。
///
/// **页边距的唯一事实来源就是这里**：打印模板刻意不写 `@page { margin }`
/// （Chromium 会让作者声明压过打印设置，两处不同步就是「边距莫名其妙变了」）。
/// 打印模板里的 717px 正文宽 = (A4_WIDTH_IN − 2 × PDF_MARGIN_IN) × 96dpi，改这里要一起改。
pub const A4_WIDTH_IN: f64 = 8.27;
pub const A4_HEIGHT_IN: f64 = 11.69;
pub const PDF_MARGIN_IN: f64 = 0.4;

/// PDF 导出走通的实际路线，写进日志与验证报告（M0-① 需要记录耗时与失败模式）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfRoute {
    /// 主路线：WebView2 ICoreWebView2_7::PrintToPdf
    PrintToPdf,
    /// 兜底 A（本次落地）：经 WebView2 自带 CDP 通道调 `Page.printToPDF`
    #[serde(rename = "cdp-webview2")]
    CdpWebView2,
    /// 兜底 A'（未实装）：外部库经 CDP 驱动系统 msedge.exe，见 [`print_to_pdf_cdp_edge`]
    CdpEdge,
    /// 兜底 B：msedge headless CLI（最后手段，未实装）
    EdgeCli,
}

/// PDF 导出选项（FR-08）。
///
/// **字段不要随便加**：`lib.rs` 的 M0-① PoC 脚手架直接构造本结构体，
/// 加字段会连带改到那里（那份代码不在本模块职责内）。
/// 文档路径不放进来也是这个原因，走 `export_pdf` 的独立入参。
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

/// 隐藏渲染窗口的三种作业。前端 `printTemplate.ts` 的 `PrintMode` 与之对应。
///
/// 前两种由 Rust 主导（前端渲染完只管发 `PRINT_READY`，产物由 COM 侧产出）；
/// `Html` 反过来由**前端**主导——`export_html` 要的是前端渲染好的 payload，
/// Rust 这边只负责建窗、等 [`HEADLESS_EXPORT_DONE_EVENT`]、回收窗口。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrintMode {
    /// 静默导出 PDF（PrintToPdf / CDP）
    Pdf,
    /// 弹系统打印对话框（ShowPrintUI）
    Dialog,
    /// 无 UI 导出 HTML（`--action to-html`）：前端渲染 + 自行 invoke `export_html`
    Html,
}

/// 注入打印窗口的任务描述（序列化成 JSON 写进 initialization_script）。
///
/// `source` 用 `&str` 而不是 `&Path`：serde 序列化非 UTF-8 的 `Path` 会直接失败，
/// 而这里的值本来就是从前端 `String` 传下来的，转一圈没有意义。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintJob<'a> {
    source: &'a str,
    include_toc: bool,
    mode: PrintMode,
    /// 仅 [`PrintMode::Html`] 使用：产物落点。PDF/Dialog 两态为 `None`
    /// （它们的落点在 Rust 侧，前端不需要知道）。
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<&'a str>,
    /// 仅 [`PrintMode::Html`] 使用：单文件内联 / HTML + 资源目录。
    #[serde(skip_serializing_if = "Option::is_none")]
    html_mode: Option<HtmlExportMode>,
}

// ---------------------------------------------------------------------------
// 打印窗口生命周期
// ---------------------------------------------------------------------------

/// 组装注入脚本。`Object.freeze` 只是表明「这是只读输入」，防不住恶意页面，
/// 但打印窗口里跑的就是我们自己的前端，这里要防的是无意中被改写。
fn build_print_job_script(job: &PrintJob<'_>) -> AppResult<String> {
    let json = serde_json::to_string(job)?;
    Ok(format!(
        "window.{PRINT_JOB_GLOBAL} = Object.freeze({json});"
    ))
}

/// 关掉打印窗口；返回「原本是否存在一扇」。幂等，可以随便多调。
fn close_print_window(app: &AppHandle) -> bool {
    use tauri::Manager;

    let Some(window) = app.get_webview_window(PRINT_WINDOW_LABEL) else {
        return false;
    };
    if let Err(err) = window.close() {
        tracing::warn!(%err, "关闭打印窗口失败（可能已被销毁）");
    }
    true
}

/// 建一扇隐藏的打印窗口并加载应用自身页面。
///
/// 三个刻意为之的选项：
/// * `visible(false)`：导出期间主窗口不该被打扰——不抢焦点、不闪窗（M0-① 已验证隐藏窗口
///   照样能被 PrintToPdf 正确渲染并出图）；
/// * `focused(false)`：`visible(false)` 只管画不画，不管抢不抢焦点，两个都要给；
/// * `skip_taskbar(true)`：否则任务栏会闪出一个没有内容的空图标。
async fn open_print_window(app: &AppHandle, job: &PrintJob<'_>) -> AppResult<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // 上一次的残留（典型来源：打印对话框还没到 linger 时限）必须先清掉，
    // 否则同 label 建窗会直接失败。
    if close_print_window(app) {
        tokio::time::sleep(Duration::from_millis(PRINT_WINDOW_RECYCLE_MS)).await;
    }

    let script = build_print_job_script(job)?;
    WebviewWindowBuilder::new(
        app,
        PRINT_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title(PRINT_WINDOW_TITLE)
    .inner_size(PRINT_WINDOW_WIDTH, PRINT_WINDOW_HEIGHT)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .initialization_script(script)
    .build()?;

    tracing::info!(
        label = PRINT_WINDOW_LABEL,
        source = job.source,
        mode = ?job.mode,
        include_toc = job.include_toc,
        "打印窗口已创建（隐藏）"
    );
    Ok(())
}

/// 先挂 PRINT_READY 监听，返回接收端。
///
/// **必须在建窗口之前调用**：前端可能在窗口 build 返回之前就渲染完并 emit，
/// 而 Tauri 不重放事件，晚挂一步就等成超时。
fn arm_print_ready(app: &AppHandle) -> std::sync::mpsc::Receiver<()> {
    use std::sync::mpsc;

    use tauri::Listener;

    let (tx, rx) = mpsc::channel::<()>();
    // once 而不是 listen：一次导出只需要一个信号，用完自动摘除。
    // 若本次超时，这个监听会残留到下一次 emit 才被消费——那时 Sender 已随本次
    // 调用一起析构，send 失败即静默丢弃，不会抢走后续导出的信号（emit 会通知所有监听）。
    app.once(PRINT_READY_EVENT, move |_event| {
        let _ = tx.send(());
    });
    rx
}

/// 等 PRINT_READY。超时/通道断开返回 false，由调用方决定「照常打印 + warn」。
async fn await_print_ready(rx: std::sync::mpsc::Receiver<()>) -> bool {
    let timeout = Duration::from_secs(PRINT_READY_TIMEOUT_SECS);
    // 回调在主线程触发，这里必须在阻塞线程上等，否则会把主线程堵死
    match tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout)).await {
        Ok(Ok(())) => true,
        Ok(Err(_)) => false,
        Err(err) => {
            tracing::warn!(%err, "等待 PRINT_READY 的任务失败");
            false
        }
    }
}

/// 建窗 + 等就绪的公共前半段。
async fn prepare_print_window(app: &AppHandle, job: &PrintJob<'_>) -> AppResult<()> {
    let ready_rx = arm_print_ready(app);
    open_print_window(app, job).await?;

    if await_print_ready(ready_rx).await {
        tracing::info!("打印窗口已就绪（PRINT_READY）");
    } else {
        tracing::warn!(
            timeout_secs = PRINT_READY_TIMEOUT_SECS,
            label = PRINT_WINDOW_LABEL,
            "未等到 PRINT_READY，按当前页面状态继续；\
             常见原因：渲染卡住，或 capabilities 未覆盖打印窗口 label（emit 被 ACL 拒绝）"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 无 UI 导出 HTML（--action to-html）
// ---------------------------------------------------------------------------

/// 前端完成无 UI HTML 导出后回报的事件名（前后端契约，`printTemplate.ts` 负责 emit）。
pub const HEADLESS_EXPORT_DONE_EVENT: &str = "HEADLESS_EXPORT_DONE";

/// 无 UI HTML 导出的等待上限。
///
/// 比 PDF 的 20s 宽得多：这条路要跑完 Mermaid/KaTeX 渲染 **再加**整篇图片的
/// base64 内联，大文档带几十张图时几十秒是正常的，卡死一次的代价远小于
/// 把一次正常导出误杀。
const HEADLESS_HTML_TIMEOUT_SECS: u64 = 120;

/// 前端回报的导出结果。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessExportDone {
    ok: bool,
    /// 失败原因（已是面向用户的中文，直接进日志与退出码说明）
    message: Option<String>,
}

/// 挂 [`HEADLESS_EXPORT_DONE_EVENT`] 监听。同 [`arm_print_ready`]，**必须在建窗之前调用**。
fn arm_headless_done(app: &AppHandle) -> std::sync::mpsc::Receiver<HeadlessExportDone> {
    use std::sync::mpsc;

    use tauri::Listener;

    let (tx, rx) = mpsc::channel::<HeadlessExportDone>();
    app.once(HEADLESS_EXPORT_DONE_EVENT, move |event| {
        // 解析失败按「成功但说不清」处理：产物大概率已经落盘，
        // 报成失败反而让调用方以为白跑了一趟。
        let done = serde_json::from_str::<HeadlessExportDone>(event.payload()).unwrap_or(
            HeadlessExportDone {
                ok: true,
                message: None,
            },
        );
        let _ = tx.send(done);
    });
    rx
}

/// 无 UI 导出 HTML：建隐藏渲染窗口 → 前端渲染并自行 invoke `export_html` → 等回报。
///
/// 与 PDF 那条链的方向**相反**：PDF 是「前端只管渲染、Rust 出产物」，
/// 而 HTML 的产物要靠前端渲染出的 payload，所以由前端主导落盘，
/// Rust 这边只做建窗、等信号、回收三件事。
///
/// 不是 `#[tauri::command]`：交互式导出走的是主窗口里现成的 DOM
/// （`export_html::export_html`），只有命令行动词才需要这扇窗。
pub async fn export_html_headless(
    app: AppHandle,
    source: String,
    output: PathBuf,
    mode: HtmlExportMode,
) -> AppResult<ExportResult> {
    let started = std::time::Instant::now();
    tracing::info!(%source, output = %output.display(), ?mode, "无 UI 导出 HTML：开始");

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let output_str = output.to_string_lossy().into_owned();
    let job = PrintJob {
        source: &source,
        include_toc: false,
        mode: PrintMode::Html,
        output: Some(&output_str),
        html_mode: Some(mode),
    };

    let done_rx = arm_headless_done(&app);
    open_print_window(&app, &job).await?;

    let timeout = Duration::from_secs(HEADLESS_HTML_TIMEOUT_SECS);
    let received =
        tauri::async_runtime::spawn_blocking(move || done_rx.recv_timeout(timeout)).await;
    close_print_window(&app);

    let elapsed_ms = started.elapsed().as_millis() as u64;
    match received {
        Ok(Ok(done)) if done.ok => {
            tracing::info!(output = %output.display(), elapsed_ms, "无 UI 导出 HTML：完成");
            Ok(ExportResult {
                output,
                route: None,
                elapsed_ms,
            })
        }
        Ok(Ok(done)) => {
            Err(AppError::native(done.message.unwrap_or_else(|| {
                "导出 HTML 失败（前端未给出原因）".to_string()
            })))
        }
        // 超时与通道断开都归到这里：产物是否落盘不确定，必须报失败让退出码为 1
        _ => Err(AppError::timeout(format!(
            "无 UI 导出 HTML 超时（{HEADLESS_HTML_TIMEOUT_SECS}s）：渲染窗口未回报结果"
        ))),
    }
}

// ---------------------------------------------------------------------------
// 命令：PDF
// ---------------------------------------------------------------------------

/// 导出 PDF（FR-08）：主路线失败自动降级兜底 A；均失败才提示用户。
///
/// `source` 是**文档路径**（前端据此在打印窗口里读原文并渲染），
/// `options.output` 才是 PDF 落盘路径，两者不要混。
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    source: String,
    options: PdfOptions,
) -> AppResult<ExportResult> {
    let started = std::time::Instant::now();
    tracing::info!(
        %source,
        output = %options.output.display(),
        include_toc = options.include_toc,
        "导出 PDF：开始"
    );

    // 目录不存在时 PrintToPdf 只会回一个「写失败」的 BOOL，看不出原因，先建好
    if let Some(parent) = options.output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let job = PrintJob {
        source: &source,
        include_toc: options.include_toc,
        mode: PrintMode::Pdf,
        output: None,
        html_mode: None,
    };
    let outcome = run_pdf_routes(&app, &job, &options).await;
    // 无论成败都关：僵尸打印窗口会一直占着一个 WebView2 进程
    close_print_window(&app);

    let route = outcome?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    tracing::info!(
        output = %options.output.display(),
        route = ?route,
        elapsed_ms,
        bytes = std::fs::metadata(&options.output).map(|meta| meta.len()).unwrap_or(0),
        "导出 PDF：完成"
    );

    Ok(ExportResult {
        output: options.output.clone(),
        route: Some(route),
        elapsed_ms,
    })
}

/// 主路线 → 兜底 A 的降级链。返回真正走通的路线（如实回填 [`ExportResult::route`]）。
async fn run_pdf_routes(
    app: &AppHandle,
    job: &PrintJob<'_>,
    options: &PdfOptions,
) -> AppResult<PdfRoute> {
    prepare_print_window(app, job).await?;

    let primary = print_pdf_for_window(app, PRINT_WINDOW_LABEL, options).await;
    let primary_err = match primary {
        Ok(()) => return Ok(PdfRoute::PrintToPdf),
        Err(err) => err,
    };
    tracing::warn!(%primary_err, "导出 PDF：主路线（PrintToPdf）失败，降级兜底 A（CDP）");

    match print_to_pdf_cdp(app, PRINT_WINDOW_LABEL, options).await {
        Ok(()) => Ok(PdfRoute::CdpWebView2),
        Err(fallback_err) => {
            tracing::error!(%primary_err, %fallback_err, "导出 PDF：两条路线均失败");
            Err(AppError::native(format!(
                "PDF 导出失败。主路线：{primary_err}；兜底 A：{fallback_err}"
            )))
        }
    }
}

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
///
/// `window_label` 保留成入参而非写死 [`PRINT_WINDOW_LABEL`]：`lib.rs` 的 M0-① PoC
/// 脚手架用它打印自己的临时窗口。
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

    // 闭包在主线程跑，结果经 channel 回到 async 上下文
    let (tx, rx) = mpsc::channel::<Result<bool, String>>();

    webview
        .with_webview(move |platform| {
            // 每一步都可能失败，统一收集为 Result 再一次性送回
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败：{e}"))?;
                let core7: ICoreWebView2_7 = core.cast().map_err(|e| {
                    format!("cast ICoreWebView2_7 失败（WebView2 运行时过旧？）：{e}")
                })?;
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
                // 注：文内目录页（options.include_toc）由前端打印模板生成，
                // COM 侧没有对应选项——PrintToPdf 也不产生 PDF 书签（FR-08 已如实告知用户）。

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
        .map_err(|e| AppError::native(format!("with_webview 失败：{e}")))?;

    // 回调在主线程触发，这里必须在阻塞线程上等，否则会把主线程堵死
    let timeout = Duration::from_secs(PDF_TIMEOUT_SECS);
    let received = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|e| AppError::native(format!("等待打印结果的任务失败：{e}")))?;

    match received {
        Ok(Ok(true)) => {
            tracing::info!(path = %options.output.display(), "PrintToPdf 成功");
            Ok(())
        }
        Ok(Ok(false)) => Err(AppError::native(
            "PrintToPdf 返回失败（未写出文件）；常见原因：输出路径不可写或页面尚未渲染完成"
                .to_string(),
        )),
        Ok(Err(err)) => Err(AppError::native(err)),
        Err(_) => Err(AppError::timeout(format!(
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

// ---------------------------------------------------------------------------
// 命令：打印（FR-17 / Ctrl+P）
// ---------------------------------------------------------------------------

/// 打印（FR-17 / Ctrl+P）：调起系统打印对话框，使用与 PDF **完全相同**的打印模板。
///
/// 与 PDF 的唯一差别是最后一步：这里调 `ICoreWebView2_16::ShowPrintUI`
/// （`COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM`，系统对话框），而不是 `PrintToPdf`。
///
/// 【为什么用 SYSTEM 而不是 BROWSER】BROWSER 是 Edge 那套「打印预览」界面，
/// 它渲染在 WebView **内部**——而我们的打印窗口是隐藏的，用户什么都看不见。
/// SYSTEM 弹的是 Win32 打印对话框（独立顶层窗口），隐藏宿主照样看得见、点得到。
#[tauri::command]
pub async fn print_document(app: AppHandle, source: String) -> AppResult<()> {
    tracing::info!(%source, "打印：开始");

    let job = PrintJob {
        source: &source,
        // 打印场景不插目录页：纸质件通常是几页的片段，凭空多一页目录反而碍事。
        // 若将来要跟随设置项，把它提到入参即可。
        include_toc: false,
        mode: PrintMode::Dialog,
        output: None,
        html_mode: None,
    };

    if let Err(err) = prepare_print_window(&app, &job).await {
        close_print_window(&app);
        return Err(err);
    }
    if let Err(err) = show_print_ui(&app, PRINT_WINDOW_LABEL).await {
        close_print_window(&app);
        return Err(err);
    }

    // ShowPrintUI 没有完成回调（见 PRINT_DIALOG_LINGER_SECS 的注释），
    // 只能给对话框留出足够长的存活期后兜底回收；下一次导出/打印也会先清掉它。
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(PRINT_DIALOG_LINGER_SECS)).await;
        if close_print_window(&handle) {
            tracing::info!("打印窗口已按存活期回收");
        }
    });

    tracing::info!("打印：系统对话框已弹出");
    Ok(())
}

/// 调起系统打印对话框。接口名已按本机 `webview2-com-sys-0.38.2/src/bindings.rs` 核实：
/// `ShowPrintUI` 在 `ICoreWebView2_16` 上，参数类型 `COREWEBVIEW2_PRINT_DIALOG_KIND`。
#[cfg(windows)]
async fn show_print_ui(app: &AppHandle, window_label: &str) -> AppResult<()> {
    use std::sync::mpsc;

    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
    };
    use windows_core::Interface;

    let webview = app
        .get_webview_window(window_label)
        .ok_or_else(|| AppError::config(format!("找不到窗口：{window_label}")))?;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    webview
        .with_webview(move |platform| {
            // SAFETY：与 lib.rs 的 apply_webview_settings 同一套理由——闭包由 Tauri 保证
            // 运行在创建该 WebView 的 UI 线程（STA）上，接口指针在闭包执行期间必然存活，
            // 且这里不缓存任何指针。
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败：{e}"))?;
                let core16: ICoreWebView2_16 = core.cast().map_err(|e| {
                    format!("cast ICoreWebView2_16 失败（WebView2 运行时过旧？）：{e}")
                })?;
                unsafe { core16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM) }
                    .map_err(|e| format!("ShowPrintUI 调用失败：{e}"))?;
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| AppError::native(format!("with_webview 失败：{e}")))?;

    let timeout = Duration::from_secs(PDF_TIMEOUT_SECS);
    let received = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|e| AppError::native(format!("等待打印对话框的任务失败：{e}")))?;

    match received {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(AppError::native(err)),
        Err(_) => Err(AppError::timeout(
            "ShowPrintUI 超时：主线程未响应".to_string(),
        )),
    }
}

#[cfg(not(windows))]
async fn show_print_ui(_app: &AppHandle, _window_label: &str) -> AppResult<()> {
    Err(AppError::not_implemented(
        "ShowPrintUI 仅 Windows 可用".to_string(),
    ))
}

// ---------------------------------------------------------------------------
// 兜底 A：CDP `Page.printToPDF`
// ---------------------------------------------------------------------------

/// 经 WebView2 自带的 CDP 通道执行一次 DevTools Protocol 调用，返回结果 JSON 文本。
///
/// 这是**长图（capture.rs 的 `Page.captureScreenshot`）与 PDF 兜底共用的通道**，
/// 故意做成通用签名：capture.rs 实装时直接调本函数，不要再抄一份 COM 桥接。
/// （红线 9 的那句「唯一路线是 CallDevToolsProtocolMethod」说的就是这条通道。）
#[cfg(windows)]
pub async fn call_cdp_method(
    app: &AppHandle,
    window_label: &str,
    method: &str,
    params_json: &str,
) -> AppResult<String> {
    use std::sync::mpsc;

    use tauri::Manager;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::{HSTRING, PCWSTR};

    let webview = app
        .get_webview_window(window_label)
        .ok_or_else(|| AppError::config(format!("找不到窗口：{window_label}")))?;

    let method_owned = method.to_string();
    let params_owned = params_json.to_string();
    let (tx, rx) = mpsc::channel::<Result<String, String>>();

    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败：{e}"))?;

                // HSTRING 必须在调用期间保持存活：PCWSTR 只是借出去的裸指针
                let method_wide = HSTRING::from(method_owned.as_str());
                let params_wide = HSTRING::from(params_owned.as_str());

                let tx_done = tx.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |hr: windows_core::Result<()>, json: String| {
                        let msg = match hr {
                            Ok(()) => Ok(json),
                            Err(e) => Err(format!("CDP 回调返回错误：{e}")),
                        };
                        let _ = tx_done.send(msg);
                        Ok(())
                    },
                ));

                unsafe {
                    core.CallDevToolsProtocolMethod(
                        PCWSTR(method_wide.as_ptr()),
                        PCWSTR(params_wide.as_ptr()),
                        &handler,
                    )
                }
                .map_err(|e| format!("CallDevToolsProtocolMethod 调用失败：{e}"))?;
                Ok(())
            })();

            if let Err(err) = result {
                let _ = tx.send(Err(err));
            }
        })
        .map_err(|e| AppError::native(format!("with_webview 失败：{e}")))?;

    let timeout = Duration::from_secs(PDF_TIMEOUT_SECS);
    let received = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|e| AppError::native(format!("等待 CDP 结果的任务失败：{e}")))?;

    match received {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(err)) => Err(AppError::native(err)),
        Err(_) => Err(AppError::timeout(format!(
            "CDP {method} 超时（{PDF_TIMEOUT_SECS}s）"
        ))),
    }
}

#[cfg(not(windows))]
pub async fn call_cdp_method(
    _app: &AppHandle,
    _window_label: &str,
    _method: &str,
    _params_json: &str,
) -> AppResult<String> {
    Err(AppError::not_implemented("CDP 通道仅 Windows 可用"))
}

/// 兜底 A：CDP `Page.printToPDF`（经 WebView2 自带通道，零新增依赖）。
///
/// 纸张与边距参数**与主路线的 COM PrintSettings 逐项对齐**（同样以英寸计），
/// 这样两条路线出来的 PDF 版面一致，用户不会因为「今天走了兜底」而拿到不同版式的文件。
///
/// 返回体形如 `{"data":"<base64>"}`（`transferMode` 取默认的 ReturnAsBase64）。
#[cfg(windows)]
pub async fn print_to_pdf_cdp(
    app: &AppHandle,
    window_label: &str,
    options: &PdfOptions,
) -> AppResult<()> {
    let params = serde_json::json!({
        "landscape": false,
        "displayHeaderFooter": false,
        "printBackground": true,
        "scale": 1.0,
        "paperWidth": A4_WIDTH_IN,
        "paperHeight": A4_HEIGHT_IN,
        "marginTop": PDF_MARGIN_IN,
        "marginBottom": PDF_MARGIN_IN,
        "marginLeft": PDF_MARGIN_IN,
        "marginRight": PDF_MARGIN_IN,
        // false：纸张尺寸以上面几项为准，不让打印模板里的 `@page { size: A4 }` 反客为主，
        // 与主路线（COM 侧同样忽略 CSS 页面盒）保持同一个事实来源
        "preferCSSPageSize": false,
        "transferMode": "ReturnAsBase64"
    })
    .to_string();

    let response = call_cdp_method(app, window_label, "Page.printToPDF", &params).await?;
    let parsed: serde_json::Value = serde_json::from_str(&response)?;
    let data = parsed
        .get("data")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            // 不把整个返回体塞进错误消息：失败时它可能是几 MB 的 base64
            AppError::native(format!(
                "Page.printToPDF 返回体缺少 data 字段（前 200 字符：{}）",
                response.chars().take(200).collect::<String>()
            ))
        })?;

    let bytes = decode_base64(data).map_err(AppError::native)?;
    if let Some(parent) = options.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&options.output, &bytes)?;
    tracing::info!(
        path = %options.output.display(),
        bytes = bytes.len(),
        "CDP Page.printToPDF 成功"
    );
    Ok(())
}

#[cfg(not(windows))]
pub async fn print_to_pdf_cdp(
    _app: &AppHandle,
    _window_label: &str,
    _options: &PdfOptions,
) -> AppResult<()> {
    Err(AppError::not_implemented("CDP 兜底仅 Windows 可用"))
}

/// 兜底 A'（**未实装**）：外部库经 CDP 驱动系统 msedge.exe 调 `Page.printToPDF`。
///
/// 为什么本次没做：驱动一个外部浏览器进程要先 `--remote-debugging-port` 起进程，
/// 再用 **WebSocket** 说 CDP。项目现有依赖里没有 WS 客户端
/// （reqwest 未开 ws feature，tokio 只开了 time），headless_chrome / chromiumoxide
/// 属于新增运行时依赖 —— 按红线 12 必须先向人类申请，不能由本批次自行写进 Cargo.toml。
///
/// 前置件已就位：[`locate_edge`] 已按事实库 #4 用 App Paths 注册表实装。
/// 补上依赖后，本函数的实现顺序是：
/// 1. [`locate_edge`] 拿到 msedge.exe（探测不到就**隐藏这条兜底**，不要硬编码路径）；
/// 2. 以 `--headless=new --remote-debugging-port=0 --user-data-dir=<临时目录>` 起进程；
/// 3. 从 stderr 首行的 `DevTools listening on ws://…` 取 WS 地址；
/// 4. `Page.navigate` 到打印模板（写成临时 .html 文件）→ 等 `Page.loadEventFired`；
/// 5. `Page.printToPDF`（参数照抄 [`print_to_pdf_cdp`]）→ base64 解码落盘；
/// 6. 无论成败都 kill 进程 + 清临时目录。
pub async fn print_to_pdf_cdp_edge(options: &PdfOptions) -> AppResult<ExportResult> {
    let _ = options;
    Err(AppError::not_implemented(
        "export::print_to_pdf_cdp_edge（兜底 A'：需先引入 CDP/WebSocket 依赖，红线 12）",
    ))
}

// ---------------------------------------------------------------------------
// Edge 探测（事实库 #4）
// ---------------------------------------------------------------------------

/// 探测系统 msedge.exe 真实路径：HKCU 优先，其次 HKLM，读 [`EDGE_APP_PATHS_KEY`] 默认值。
///
/// 三条纪律（事实库 #4）：
/// * **不得硬编码** `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
///   —— 企业环境、便携版、非 C 盘安装都会打脸；
/// * **不得以「WebView2 Runtime 存在」推断 Edge 存在** —— 两者是不同的产品，
///   只装 Runtime 的机器相当常见；
/// * 探测失败时调用方必须**隐藏兜底选项**（或直接放弃该路线），而不是猜一个路径去试。
///
/// HKCU 优先是因为 Edge 支持按用户安装，此时 HKLM 下可能压根没有这个键，
/// 或者指向的是另一份（更旧的）安装。
#[cfg(windows)]
pub fn locate_edge() -> AppResult<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    for (root, name) in [(HKEY_CURRENT_USER, "HKCU"), (HKEY_LOCAL_MACHINE, "HKLM")] {
        let key = match RegKey::predef(root).open_subkey_with_flags(EDGE_APP_PATHS_KEY, KEY_READ) {
            Ok(key) => key,
            Err(err) => {
                tracing::debug!(hive = name, %err, "App Paths 下无 msedge.exe 键");
                continue;
            }
        };
        // App Paths 的**默认值**（空名）就是可执行文件全路径，个别写入方会带引号
        let raw: String = match key.get_value("") {
            Ok(value) => value,
            Err(err) => {
                tracing::debug!(hive = name, %err, "读 msedge.exe 默认值失败");
                continue;
            }
        };
        let path = PathBuf::from(raw.trim().trim_matches('"'));
        if path.is_file() {
            tracing::info!(hive = name, path = %path.display(), "已探测到系统 Edge");
            return Ok(path);
        }
        tracing::warn!(hive = name, path = %path.display(), "注册表记录的 Edge 路径不存在（残留键？）");
    }

    Err(AppError::not_found(
        "未探测到系统 msedge.exe（App Paths 无有效记录）；CDP/CLI 兜底不可用".to_string(),
    ))
}

#[cfg(not(windows))]
pub fn locate_edge() -> AppResult<PathBuf> {
    Err(AppError::not_implemented("Edge 探测仅 Windows 可用"))
}

// ---------------------------------------------------------------------------
// base64 解码（CDP 返回体）
// ---------------------------------------------------------------------------

/// 标准 base64 字母表的反查。非法字符返回 None。
fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// 解码标准 base64（跳过空白，遇 `=` 即停）。
///
/// 【为什么手写而不加 `base64` crate】只为解一个 CDP 返回体就新增一个运行时依赖，
/// 与红线 12「新增依赖先申请」不成比例；这段逻辑二十行、有单测、无 unsafe。
///
/// `pub(crate)` 而不是私有：`capture.rs` 解 CDP 截图返回体要用同一套逻辑。
/// 那边一度各自持有一份逐字相同的副本 —— 两份实现意味着将来只修其中一份，
/// 而这种「解码差一位」的缺陷在产物上表现为整张图/整份 PDF 损坏，极难倒查。
/// base64 编码（标准字母表 + `=` 填充）。与下方解码器同居一处、同一份字母表——
/// 编码/解码分家在两个文件里，字母表改一处漏一处的事故只是时间问题。
/// 当前唯一用户：shell_integ 的编辑器图标 data URI（几 KB 级，性能无虞）。
pub(crate) fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 0x3F] as char);
        out.push(TABLE[(triple >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 0x3F] as char
        } else {
            '='
        });
    }
    out
}

pub(crate) fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    // 4 个字符出 3 字节，先按上界预分配，避免几 MB 的 PDF 反复扩容
    let mut out = Vec::with_capacity(input.len() / 4 * 3 + 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;

    for (index, byte) in input.bytes().enumerate() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            break;
        }
        let value = base64_value(byte)
            .ok_or_else(|| format!("base64 第 {index} 字节非法：0x{byte:02x}"))?;
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 打印任务的注入脚本必须是合法 JS，且字段名为 camelCase（前端按这套读）。
    #[test]
    fn builds_print_job_script() {
        let job = PrintJob {
            source: r"D:\笔记\a b.md",
            include_toc: true,
            mode: PrintMode::Pdf,
            output: None,
            html_mode: None,
        };
        let script = build_print_job_script(&job).expect("序列化不应失败");
        assert!(script.starts_with("window.__MDNAONAO_PRINT_JOB__ = Object.freeze({"));
        assert!(script.contains(r#""includeToc":true"#));
        assert!(script.contains(r#""mode":"pdf""#));
        // 反斜杠必须被 JSON 转义，否则注入脚本里的 \笔 会变成非法转义序列
        assert!(script.contains(r"D:\\笔记\\a b.md"));
    }

    /// 路线枚举的 wire 值是前后端契约（TS 的 PdfRoute 联合类型逐字对应）。
    #[test]
    fn serializes_route_contract() {
        let value = |route: PdfRoute| serde_json::to_string(&route).expect("枚举可序列化");
        assert_eq!(value(PdfRoute::PrintToPdf), r#""print-to-pdf""#);
        assert_eq!(value(PdfRoute::CdpWebView2), r#""cdp-webview2""#);
        assert_eq!(value(PdfRoute::CdpEdge), r#""cdp-edge""#);
        assert_eq!(value(PdfRoute::EdgeCli), r#""edge-cli""#);
    }

    /// A4 正文宽度与打印模板里写死的 717px 必须对得上（改一处就会红）。
    #[test]
    fn a4_content_width_matches_print_template() {
        let width_px = (A4_WIDTH_IN - 2.0 * PDF_MARGIN_IN) * 96.0;
        assert_eq!(width_px.round() as i32, 717);
    }

    /// base64：三种余数长度 + 中文多字节都要正确还原。
    #[test]
    fn decodes_base64_payloads() {
        assert_eq!(decode_base64("").expect("空串合法"), Vec::<u8>::new());
        assert_eq!(decode_base64("TWFu").expect("无填充"), b"Man".to_vec());
        assert_eq!(decode_base64("TWE=").expect("一个填充"), b"Ma".to_vec());
        assert_eq!(decode_base64("TQ==").expect("两个填充"), b"M".to_vec());
        assert_eq!(
            decode_base64("SGVsbG8sIOS4lueVjA==").expect("含中文"),
            "Hello, 世界".as_bytes().to_vec()
        );
        // CDP 返回体是单行，但换行容错不该让整份 PDF 报废
        assert_eq!(decode_base64("TWFu\n").expect("含换行"), b"Man".to_vec());
    }

    /// 非法字符必须报错而不是静默产出一份坏 PDF。
    #[test]
    fn rejects_invalid_base64() {
        let err = decode_base64("TW@u").expect_err("非法字符应报错");
        assert!(err.contains("非法"));
    }

    /// PDF 头四字节应为 %PDF —— 兜底路线落盘前的自检基准（这里只验解码链路本身）。
    #[test]
    fn decodes_pdf_magic() {
        assert_eq!(
            decode_base64("JVBERi0=").expect("PDF 魔数"),
            b"%PDF-".to_vec()
        );
    }
}
