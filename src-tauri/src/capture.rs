//! DG 7.1 `capture.rs` 职责：长图（FR-10 主路径）—— CDP `Page.captureScreenshot`
//! （`captureBeyondViewport: true`）。
//!
//! **红线 9（不可动摇）**：WebView2 的 `CapturePreview` 只截可视区——这是微软官方
//! 确认的设计行为（事实库 #5），**不可用于长图**。唯一路线是走 WebView2 自带的
//! CDP 通道 `CallDevToolsProtocolMethod` 调 `Page.captureScreenshot`，
//! 且必须显式设 `captureBeyondViewport: true`（默认值与 CapturePreview 一样只截可视区）。
//!
//! ## 编排（与 export.rs 的 PDF 链同构，刻意复用同一扇窗）
//!
//! ```text
//! capture_long_image
//!   ├─ arm_render_ready()        先挂 PRINT_READY 监听，再建窗口（顺序不能反）
//!   ├─ open_capture_window()     隐藏窗口加载应用自身页面，initialization_script
//!   │                            注入 export::PRINT_JOB_GLOBAL，mode = "image"
//!   │                            → 前端 render/longImage.ts 按 720px 微信版式渲染
//!   ├─ await_render_ready()      等 PRINT_READY（超时则按现状截图并 warn）
//!   ├─ Emulation.setDeviceMetricsOverride   钉死宽度与 DPR（不受宿主显示器缩放影响）
//!   ├─ Page.getLayoutMetrics     取整页内容高度（CSS px）
//!   ├─ Page.captureScreenshot ×N 按 [`MAX_TEXTURE_HEIGHT_PX`] 分段
//!   └─ close_capture_window()    无论成败都关，绝不留僵尸窗口
//! ```
//!
//! 三处刻意的复用（都来自 export.rs，**不再抄一份**）：
//! * [`crate::export::call_cdp_method`] —— COM 侧 `CallDevToolsProtocolMethod` 的通用封装；
//! * [`crate::export::PRINT_WINDOW_LABEL`] —— 同一个窗口 label。Tauri 2 的 ACL 按 label 授权，
//!   `capabilities/print.json` 已经覆盖了它；换一个新 label 就得同步改 capabilities，
//!   否则这扇窗连 `plugin:event|emit` 都调不动，PRINT_READY 永远发不出来；
//! * [`crate::export::PRINT_JOB_GLOBAL`] / [`crate::export::PRINT_READY_EVENT`] ——
//!   与打印窗口同一套前后端契约，前端只多认一个 `mode: "image"`。
//!
//! ## 超长文档：为什么是「分段 + 前端 canvas 合成」而不是「Rust 自写 PNG 编码」
//!
//! GPU 纹理上限约 16384px（DG 4.1「长图截图」行），超限必须分段。要把 N 段拼成一张，
//! 拼接方必须先拿到**像素**：
//! * CDP 只会返回**已编码**的 png/jpeg/webp，没有裸像素传输模式；
//! * 因此 Rust 侧拼接 = 先写一个 inflate 解码器（zlib + PNG 逐行 filter 还原）再写编码器，
//!   约四百行纯位运算，且本批次纪律不允许自跑 cargo（无法验证）；引入 `png`/`image` crate
//!   则触红线 12（新增运行时依赖须先申请）。
//! * 而渲染窗口本身就是一个 Chromium：`createImageBitmap` + `<canvas>` 的解码与编码
//!   都是浏览器原生实现，零依赖、零手写位运算。
//!
//! 所以本模块只做「分段落盘 / 分段回传」，合成交给 `src/render/longImage.ts` 的
//! `composeSegments()`：
//! * `output = Some(path)`：直接落盘。单段 → 就是 `path` 本身；多段 → `path-1.png`、
//!   `path-2.png`…（[`segment_path`]），并在 [`CaptureResult::segments`] 如实回报张数。
//!   命令行 `--action share-image` 走的就是这一条（无前端可用，也就不合成）。
//! * `output = None`：不落盘，逐段 base64 放进 [`CaptureResult::png_base64`] 回传前端，
//!   由 `composeSegments()` 合成一张再写剪贴板 / 另存。
//!
//! ## 不加水印、不加页眉页脚
//!
//! 用户没要求，加了就是擅自决定产品形态：分享出去的图上挂着应用名，等于替用户做了署名。
//! 版式只做一件与阅读相关的事——四周留白（在 `longImage.ts` 里），免得文字贴着图片边缘。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::export::{
    call_cdp_method, decode_base64, PRINT_JOB_GLOBAL, PRINT_READY_EVENT, PRINT_WINDOW_LABEL,
};

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// GPU 纹理高度上限（经验值，超过即分段）。这是**设备像素**上限：
/// 版式高度乘以 `deviceScaleFactor` 之后才拿来跟它比。
pub const MAX_TEXTURE_HEIGHT_PX: u32 = 16384;

/// 微信长图版式宽度（DG 8）。
pub const WECHAT_IMAGE_WIDTH_PX: u32 = 720;

/// 版式宽度下限：再窄的话中文正文一行放不下十几个字，代码块必然横向溢出。
pub const MIN_IMAGE_WIDTH_PX: u32 = 320;

/// 版式宽度上限：宽度直接决定像素总量（宽 × 高 × 4 字节的解码峰值），
/// 而长图的用途是聊天窗口粘贴，超过这个宽度没有收益只有体积。
pub const MAX_IMAGE_WIDTH_PX: u32 = 2048;

/// 设备像素比上限。2 已经是「高清但体积翻倍」，3 是给 4K 屏用户的余量；
/// 再往上分段数会失控（可用版式高度 = 16384 / dpr）。
pub const MAX_DEVICE_SCALE_FACTOR: f32 = 3.0;

/// 隐藏渲染窗口的视口高度（逻辑像素）。长图不关心视口高度——整页高度由
/// `Page.getLayoutMetrics` 给出——这里只要一个不至于让响应式样式走窄屏分支的值。
const CAPTURE_WINDOW_HEIGHT: f64 = 1024.0;

/// 等前端 `PRINT_READY` 的上限。
///
/// 比 PDF 的 20s 宽：长图版式要把整篇文档一次性布局出来（没有分页可以偷懒），
/// 图片、Mermaid、KaTeX 全部就绪才算数。超时不算失败，只 warn 后按现状截图——
/// 半张图也比什么都没有强，且失败模式在日志里可查。
const CAPTURE_READY_TIMEOUT_SECS: u64 = 60;

/// 关掉旧窗口后、建新窗口前的让路时间（毫秒）。窗口销毁是异步排队的，
/// 紧接着用同一个 label 建窗有概率撞上「label 已存在」。
const WINDOW_RECYCLE_MS: u64 = 120;

/// 改完设备参数（宽度 / DPR）后等布局重排的时间。
/// 不等就取 `getLayoutMetrics`，拿到的是旧宽度下的高度，分段会整体错位。
const METRICS_SETTLE_MS: u64 = 200;

/// 注入任务里的 `mode` 值。**必须与 `src/render/longImage.ts` 的 `LONG_IMAGE_MODE` 逐字一致。**
const CAPTURE_JOB_MODE: &str = "image";

/// 渲染窗口标题（窗口是隐藏的，这里给应用名只是不让任务管理器显示 "print"）。
/// Rust 侧没有 i18n 文件，这是产品名而非可译文案。
const CAPTURE_WINDOW_TITLE: &str = "MDNaonao";

/// PNG 魔数，落盘前自检用。
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

// ---------------------------------------------------------------------------
// 契约结构体
// ---------------------------------------------------------------------------

/// 长图导出选项。
///
/// 容器级 `#[serde(default)]`：前端只传 `{ source }` 也能工作，其余走
/// [`CaptureOptions::default`]（微信版式 720px、DPR 1、只回传不落盘）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptureOptions {
    /// 待渲染的 Markdown 文档绝对路径。
    ///
    /// 为什么是 `Option` 而不是必填：本字段是本批次**新增**的，老调用方
    /// （`cmdline.rs` 的 `bridge::share_image`）用 `..Default::default()` 构造，
    /// 加必填字段会把它编译坏。缺失时不猜、不静默截主窗口，直接报配置错误——
    /// 「截出一张不知道是什么文档的图」比失败更糟。
    pub source: Option<String>,
    /// 渲染宽度（CSS px），默认 [`WECHAT_IMAGE_WIDTH_PX`]。
    /// 越界值会被夹到 [`MIN_IMAGE_WIDTH_PX`]..=[`MAX_IMAGE_WIDTH_PX`]。
    pub width: u32,
    /// 另存路径；为 None 表示不落盘，PNG 经 [`CaptureResult::png_base64`] 回传前端。
    pub output: Option<PathBuf>,
    /// 设备像素比（1 = 标准，2 = 高清但体积翻倍）。
    /// 夹到 1.0..=[`MAX_DEVICE_SCALE_FACTOR`]。
    pub device_scale_factor: f32,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self {
            source: None,
            width: WECHAT_IMAGE_WIDTH_PX,
            output: None,
            device_scale_factor: 1.0,
        }
    }
}

/// 长图结果。分段时 `segments > 1`，前端需提示用户「已分为 N 张」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// 实际落盘的文件（`output` 为 None 时为空）。多段时按顺序编号。
    pub outputs: Vec<PathBuf>,
    /// 分段张数。1 = 一张完整长图；>1 = 超过 [`MAX_TEXTURE_HEIGHT_PX`] 被切开。
    pub segments: u32,
    /// 成图总高（**设备像素**，即 CSS 高 × DPR）。
    pub total_height_px: u32,
    /// 成图宽度（设备像素）。
    pub width_px: u32,
    /// 恒为 false：Rust 侧写不了图片剪贴板。
    ///
    /// `tauri-plugin-clipboard-manager` 的 `write_image` 要的是 [`tauri::image::Image`]，
    /// 而 `Image::from_bytes`（PNG → RGBA 解码）被 tauri 的 `image-png` feature 门着，
    /// 本项目没开——开它等于引入 `image` crate 这个新运行时依赖（红线 12，须先申请）。
    /// 因此剪贴板由**前端**写：PNG → canvas → `getImageData` → RGBA → `writeImage`，
    /// 主窗口的 `clipboard-manager:allow-write-image` 已经就位。
    pub copied_to_clipboard: bool,
    /// 仅当 `output` 为 None：逐段 PNG 的 base64（顺序即拼接顺序）。
    ///
    /// 落盘路径下**不**回传，避免把几 MB 的 base64 白白塞进 IPC 返回体。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub png_base64: Option<Vec<String>>,
    pub elapsed_ms: u64,
}

/// 注入渲染窗口的任务描述。
///
/// 字段名与 `export.rs` 的 `PrintJob` 对齐（camelCase），这样前端
/// `printTemplate.ts::readPrintJob` 与 `longImage.ts::readLongImageJob`
/// 读的是同一个全局变量、同一套字段名。多出来的 `imageWidth` 只有长图会看。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureJob<'a> {
    source: &'a str,
    /// 长图不插目录页：微信长图是一整条内容流，凭空多一屏目录只会让人以为发错了。
    include_toc: bool,
    /// 恒为 [`CAPTURE_JOB_MODE`]。
    mode: &'static str,
    /// 版式宽度（CSS px），前端据此设正文宽。
    image_width: u32,
}

/// 一次 `Page.captureScreenshot` 的裁剪区（CSS px，`scale` 为设备像素倍率）。
#[derive(Debug, Clone, Copy)]
pub struct ClipRect {
    pub top: u32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// `Page.getLayoutMetrics` 里的整页内容尺寸（CSS px）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ContentBox {
    width: u32,
    height: u32,
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

/// 生成当前文档长图（FR-10 主路径）。
///
/// 无论成败都会回收渲染窗口；失败时不会留下半张图（落盘是逐段原子写，
/// 中途失败已写出的段会保留在 `outputs` 之外，日志里可查）。
#[tauri::command]
pub async fn capture_long_image(
    app: AppHandle,
    options: CaptureOptions,
) -> AppResult<CaptureResult> {
    let started = Instant::now();

    let source = options.source.clone().ok_or_else(|| {
        AppError::config(
            "生成长图缺少源文档路径（CaptureOptions.source 为空）；\
             调用方必须显式传入待渲染的 .md 绝对路径",
        )
    })?;
    let width = options.width.clamp(MIN_IMAGE_WIDTH_PX, MAX_IMAGE_WIDTH_PX);
    let scale = f64::from(
        options
            .device_scale_factor
            .clamp(1.0, MAX_DEVICE_SCALE_FACTOR),
    );

    tracing::info!(
        %source,
        width,
        scale,
        output = options.output.as_ref().map(|path| path.display().to_string()),
        "生成长图：开始"
    );

    let job = CaptureJob {
        source: &source,
        include_toc: false,
        mode: CAPTURE_JOB_MODE,
        image_width: width,
    };

    let ready_rx = arm_render_ready(&app);
    if let Err(err) = open_capture_window(&app, &job).await {
        close_capture_window(&app);
        return Err(err);
    }
    if await_render_ready(ready_rx).await {
        tracing::info!("长图渲染窗口已就绪（PRINT_READY）");
    } else {
        tracing::warn!(
            timeout_secs = CAPTURE_READY_TIMEOUT_SECS,
            label = PRINT_WINDOW_LABEL,
            "未等到 PRINT_READY，按当前页面状态继续；\
             常见原因：渲染卡住，或 capabilities 未覆盖渲染窗口 label（emit 被 ACL 拒绝）"
        );
    }

    let outcome = capture_document(&app, &options, width, scale).await;
    // 无论成败都关：僵尸渲染窗口会一直占着一个 WebView2 进程
    close_capture_window(&app);

    let mut result = outcome?;
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    tracing::info!(
        segments = result.segments,
        width_px = result.width_px,
        total_height_px = result.total_height_px,
        outputs = result.outputs.len(),
        elapsed_ms = result.elapsed_ms,
        "生成长图：完成"
    );
    Ok(result)
}

/// 就绪之后的正题：钉住设备参数 → 量整页高度 → 分段截图 → 落盘 / 回传。
async fn capture_document(
    app: &AppHandle,
    options: &CaptureOptions,
    width: u32,
    scale: f64,
) -> AppResult<CaptureResult> {
    // 钉死宽度与 DPR：不这么做的话，同一篇文档在 100% 与 150% 缩放的机器上
    // 会截出 720px 与 1080px 两种宽度的图（窗口的 inner_size 是逻辑像素，
    // 而截图取的是合成器的设备像素）。失败不致命，退回 clip.scale。
    let pinned = apply_device_metrics(app, width, scale).await;
    // 滚动条会占掉 15px 版面宽、并被一起截进图里。前端也有一层 CSS 兜底
    // （longImage.ts 的 ::-webkit-scrollbar），但那层只在长图版式接线之后才生效，
    // 而这条 CDP 开关对任何渲染模式都管用。失败不致命。
    hide_scrollbars(app).await;
    if pinned {
        tokio::time::sleep(Duration::from_millis(METRICS_SETTLE_MS)).await;
    }
    // 设备参数已经把 DPR 钉进合成器时，clip 再乘一次就是双重放大
    let clip_scale = if pinned { 1.0 } else { scale };

    let content = fetch_content_box(app).await?;
    // 内容宽度可能比版式宽度小（滚动条占位）或大（有元素横向溢出）：
    // 取二者较小值，既不留一条死白边，也不把溢出物一起截进来。
    let clip_width = content.width.clamp(1, width);
    let total_height = content.height.max(1);

    // 可用版式高度 = 纹理上限 / 设备倍率。dpr=2 时单段只能装 8192 CSS px。
    // 两条路径下最终倍率都是 `scale`：钉住时由 Emulation 提供（clip 不再乘），
    // 没钉住时由 clip.scale 提供（此时宿主 DPR 还会再乘一道，只能按 1 估——
    // 也正因如此，钉不住时成图宽度会漂，apply_device_metrics 已 warn 过）。
    let max_css_height =
        ((f64::from(MAX_TEXTURE_HEIGHT_PX) / scale.max(1.0)).floor() as u32).max(1);
    let plan = plan_segments(total_height, max_css_height);
    if plan.is_empty() {
        return Err(AppError::native(
            "长图内容高度为 0：页面可能没有渲染出任何正文".to_string(),
        ));
    }
    if plan.len() > 1 {
        tracing::info!(
            total_height,
            max_css_height,
            segments = plan.len(),
            "长图超过 GPU 纹理上限，按段截取（合成交前端 canvas，见模块文档）"
        );
    }

    let mut outputs = Vec::with_capacity(plan.len());
    let mut png_base64 = if options.output.is_none() {
        Some(Vec::with_capacity(plan.len()))
    } else {
        None
    };
    let mut captured_height = 0_u32;

    for (index, (top, height)) in plan.iter().copied().enumerate() {
        let clip = ClipRect {
            top,
            width: clip_width,
            height,
            scale: clip_scale,
        };
        let encoded = capture_screenshot_cdp(app, clip).await?;
        let bytes = decode_base64(&encoded).map_err(AppError::native)?;
        let (image_width, image_height) = verify_png(&bytes, index, &clip)?;
        captured_height += image_height;

        match options.output.as_deref() {
            Some(base) => {
                let path = segment_path(base, index, plan.len());
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&path, &bytes)?;
                tracing::info!(
                    path = %path.display(),
                    bytes = bytes.len(),
                    image_width,
                    image_height,
                    "长图分段已落盘"
                );
                outputs.push(path);
            }
            None => {
                tracing::info!(
                    index,
                    bytes = bytes.len(),
                    image_width,
                    image_height,
                    "长图分段已回传（不落盘）"
                );
                if let Some(list) = png_base64.as_mut() {
                    list.push(encoded);
                }
            }
        }
    }

    Ok(CaptureResult {
        outputs,
        segments: plan.len() as u32,
        total_height_px: captured_height,
        width_px: (f64::from(clip_width) * scale).round() as u32,
        copied_to_clipboard: false,
        png_base64,
        elapsed_ms: 0,
    })
}

// ---------------------------------------------------------------------------
// 渲染窗口生命周期（与 export.rs 同一扇窗、同一套契约）
// ---------------------------------------------------------------------------

/// 组装注入脚本。`Object.freeze` 只是表明「这是只读输入」，防不住恶意页面，
/// 但这扇窗里跑的就是我们自己的前端，要防的是无意中被改写。
fn build_capture_job_script(job: &CaptureJob<'_>) -> AppResult<String> {
    let json = serde_json::to_string(job)?;
    Ok(format!(
        "window.{PRINT_JOB_GLOBAL} = Object.freeze({json});"
    ))
}

/// 关掉渲染窗口；返回「原本是否存在一扇」。幂等，可以随便多调。
fn close_capture_window(app: &AppHandle) -> bool {
    use tauri::Manager;

    let Some(window) = app.get_webview_window(PRINT_WINDOW_LABEL) else {
        return false;
    };
    if let Err(err) = window.close() {
        tracing::warn!(%err, "关闭长图渲染窗口失败（可能已被销毁）");
    }
    true
}

/// 建一扇隐藏的渲染窗口并加载应用自身页面。
///
/// `inner_size` 的宽度就是版式宽度：它决定 CSS 视口宽度，媒体查询与
/// Mermaid 的版面测量都吃这个值。高度随便给（长图不分页）。
async fn open_capture_window(app: &AppHandle, job: &CaptureJob<'_>) -> AppResult<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // 上一次的残留（典型来源：打印对话框还没到 linger 时限）必须先清掉，
    // 否则同 label 建窗会直接失败。
    if close_capture_window(app) {
        tokio::time::sleep(Duration::from_millis(WINDOW_RECYCLE_MS)).await;
    }

    let script = build_capture_job_script(job)?;
    WebviewWindowBuilder::new(
        app,
        PRINT_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title(CAPTURE_WINDOW_TITLE)
    .inner_size(f64::from(job.image_width), CAPTURE_WINDOW_HEIGHT)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .initialization_script(script)
    .build()?;

    tracing::info!(
        label = PRINT_WINDOW_LABEL,
        source = job.source,
        image_width = job.image_width,
        "长图渲染窗口已创建（隐藏）"
    );
    Ok(())
}

/// 先挂 PRINT_READY 监听，返回接收端。
///
/// **必须在建窗口之前调用**：前端可能在窗口 build 返回之前就渲染完并 emit，
/// 而 Tauri 不重放事件，晚挂一步就等成超时。
fn arm_render_ready(app: &AppHandle) -> std::sync::mpsc::Receiver<()> {
    use std::sync::mpsc;

    use tauri::Listener;

    let (tx, rx) = mpsc::channel::<()>();
    app.once(PRINT_READY_EVENT, move |_event| {
        let _ = tx.send(());
    });
    rx
}

/// 等 PRINT_READY。超时/通道断开返回 false，由调用方决定「照常截图 + warn」。
async fn await_render_ready(rx: std::sync::mpsc::Receiver<()>) -> bool {
    let timeout = Duration::from_secs(CAPTURE_READY_TIMEOUT_SECS);
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

// ---------------------------------------------------------------------------
// CDP 调用
// ---------------------------------------------------------------------------

/// 钉死版式宽度与设备像素比。返回是否成功（失败不致命，调用方退回 `clip.scale`）。
///
/// `mobile: false` 很重要：置 true 会让 Chromium 切到移动端视口语义
/// （meta viewport 生效、字体自动放大），版面会和阅读区对不上。
async fn apply_device_metrics(app: &AppHandle, width: u32, scale: f64) -> bool {
    let params = serde_json::json!({
        "width": width,
        "height": CAPTURE_WINDOW_HEIGHT as u32,
        "deviceScaleFactor": scale,
        "mobile": false,
    })
    .to_string();

    match call_cdp_method(
        app,
        PRINT_WINDOW_LABEL,
        "Emulation.setDeviceMetricsOverride",
        &params,
    )
    .await
    {
        Ok(_) => {
            tracing::info!(width, scale, "长图：设备参数已钉死");
            true
        }
        Err(err) => {
            tracing::warn!(
                %err,
                "Emulation.setDeviceMetricsOverride 失败，退回 clip.scale；\
                 后果：成图宽度会随宿主显示器缩放比变化"
            );
            false
        }
    }
}

/// 藏掉滚动条。失败只 warn：这是版面洁癖，不是正确性。
async fn hide_scrollbars(app: &AppHandle) {
    let params = serde_json::json!({ "hidden": true }).to_string();
    if let Err(err) = call_cdp_method(
        app,
        PRINT_WINDOW_LABEL,
        "Emulation.setScrollbarsHidden",
        &params,
    )
    .await
    {
        tracing::warn!(%err, "Emulation.setScrollbarsHidden 失败，滚动条可能被截进图里");
    }
}

/// 取整页内容尺寸（CSS px）。
async fn fetch_content_box(app: &AppHandle) -> AppResult<ContentBox> {
    let response = call_cdp_method(app, PRINT_WINDOW_LABEL, "Page.getLayoutMetrics", "{}").await?;
    let content = parse_content_box(&response)?;
    tracing::info!(
        width = content.width,
        height = content.height,
        "长图：整页内容尺寸（CSS px）"
    );
    Ok(content)
}

/// 解析 `Page.getLayoutMetrics` 的返回体。
///
/// 优先 `cssContentSize`：Chromium 在把 `contentSize` 改成设备像素之后补了这一组
/// 明确以 CSS px 计的字段，两者都在时以它为准，混用会让分段整体错位。
fn parse_content_box(response: &str) -> AppResult<ContentBox> {
    let value: serde_json::Value = serde_json::from_str(response)?;
    for key in ["cssContentSize", "contentSize"] {
        let Some(node) = value.get(key) else {
            continue;
        };
        let width = node.get("width").and_then(serde_json::Value::as_f64);
        let height = node.get("height").and_then(serde_json::Value::as_f64);
        if let (Some(width), Some(height)) = (width, height) {
            if width >= 1.0 && height >= 1.0 {
                return Ok(ContentBox {
                    width: width.ceil() as u32,
                    height: height.ceil() as u32,
                });
            }
        }
    }
    // 不把整个返回体塞进错误消息：它可能很长
    Err(AppError::native(format!(
        "Page.getLayoutMetrics 返回体缺少可用的 contentSize（前 200 字符：{}）",
        response.chars().take(200).collect::<String>()
    )))
}

/// 经 WebView2 CDP 通道执行一次 `Page.captureScreenshot`，返回 base64 PNG。
///
/// **禁止**改用 `CapturePreview`（红线 9）。三个参数一个都不能省：
/// * `captureBeyondViewport: true` —— 没有它就退化成「只截可视区」，和 CapturePreview 一样；
/// * `fromSurface: true` —— 从合成器表面取图，隐藏窗口才截得出东西；
/// * `clip` —— 分段的落实处，`scale` 即设备像素倍率。
pub async fn capture_screenshot_cdp(app: &AppHandle, clip: ClipRect) -> AppResult<String> {
    let params = serde_json::json!({
        "format": "png",
        "captureBeyondViewport": true,
        "fromSurface": true,
        // false：宁可慢一点也要更小的体积——长图是要发进聊天窗口的
        "optimizeForSpeed": false,
        "clip": {
            "x": 0.0,
            "y": f64::from(clip.top),
            "width": f64::from(clip.width),
            "height": f64::from(clip.height),
            "scale": clip.scale,
        },
    })
    .to_string();

    let response =
        call_cdp_method(app, PRINT_WINDOW_LABEL, "Page.captureScreenshot", &params).await?;
    let parsed: serde_json::Value = serde_json::from_str(&response)?;
    parsed
        .get("data")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            AppError::native(format!(
                "Page.captureScreenshot 返回体缺少 data 字段（前 200 字符：{}）",
                response.chars().take(200).collect::<String>()
            ))
        })
}

// ---------------------------------------------------------------------------
// 分段与落盘
// ---------------------------------------------------------------------------

/// 按 `max_height` 把总高切成若干段，返回每段的 (top, height)。**段间不重叠**——
/// 前端合成时直接首尾相接即可，多一像素重叠在拼缝处就是一条可见的重影。
///
/// 纯函数，便于单测覆盖分页边界（DG 11.2 必测项）。
pub fn plan_segments(total_height: u32, max_height: u32) -> Vec<(u32, u32)> {
    if total_height == 0 || max_height == 0 {
        return Vec::new();
    }
    let mut segments = Vec::new();
    let mut top = 0;
    while top < total_height {
        let height = max_height.min(total_height - top);
        segments.push((top, height));
        top += height;
    }
    segments
}

/// 多段时的落盘文件名：`note.png` → `note-1.png` / `note-2.png`…
///
/// 十段以上补零到两位，否则资源管理器按名排序会给出 1、10、11、2 这种顺序，
/// 用户照着顺序发图就发错了。单段时原样返回用户选定的路径（不加任何后缀）。
fn segment_path(base: &Path, index: usize, total: usize) -> PathBuf {
    if total <= 1 {
        return base.to_path_buf();
    }
    let stem = base
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("long-image");
    let extension = base
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let pad: usize = if total >= 10 { 2 } else { 1 };
    base.with_file_name(format!(
        "{stem}-{number:0pad$}.{extension}",
        number = index + 1,
        pad = pad
    ))
}

/// 落盘前自检：必须是 PNG，且尺寸要对得上这一段的裁剪区。
///
/// 尺寸对不上通常意味着撞了纹理上限被静默截断——这类失败**没有报错**
/// （截图接口照样返回一张图，只是短了一截），不主动核对就会悄悄发出去半张图。
fn verify_png(bytes: &[u8], index: usize, clip: &ClipRect) -> AppResult<(u32, u32)> {
    let Some((width, height)) = png_dimensions(bytes) else {
        return Err(AppError::native(format!(
            "第 {} 段截图不是合法 PNG（{} 字节）",
            index + 1,
            bytes.len()
        )));
    };

    let expected_height = (f64::from(clip.height) * clip.scale).round() as u32;
    // 容差 2px：CDP 内部按设备像素取整，边界上差一像素是正常的
    if expected_height.abs_diff(height) > 2 {
        tracing::warn!(
            index,
            expected_height,
            actual_height = height,
            "长图分段高度与预期不符（疑似撞上 GPU 纹理上限被截断）"
        );
    }
    Ok((width, height))
}

/// 读 PNG 的 IHDR 取宽高。非 PNG 或长度不足返回 None。
///
/// 布局是固定的：8 字节魔数 + 4 字节块长 + 4 字节 "IHDR" + 4 字节宽 + 4 字节高（大端）。
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || bytes[..8] != PNG_MAGIC || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

// ---------------------------------------------------------------------------
// base64 解码（CDP 返回体）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 未超上限时不分段。
    #[test]
    fn keeps_single_segment_below_limit() {
        let segments = plan_segments(9000, MAX_TEXTURE_HEIGHT_PX);
        assert_eq!(segments, vec![(0, 9000)]);
    }

    /// 超上限按上限切分，末段为余数，且总高守恒。
    #[test]
    fn splits_beyond_texture_limit() {
        let total = MAX_TEXTURE_HEIGHT_PX * 2 + 500;
        let segments = plan_segments(total, MAX_TEXTURE_HEIGHT_PX);
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[2], (MAX_TEXTURE_HEIGHT_PX * 2, 500));
        let sum: u32 = segments.iter().map(|(_, height)| height).sum();
        assert_eq!(sum, total);
    }

    /// 段间必须首尾相接、不重叠（前端 canvas 合成直接按 y 累加，重叠即重影）。
    #[test]
    fn segments_are_contiguous() {
        let segments = plan_segments(5000, 1000);
        let mut cursor = 0;
        for (top, height) in segments {
            assert_eq!(top, cursor);
            cursor += height;
        }
        assert_eq!(cursor, 5000);
    }

    /// 边界：零高度不产生分段（避免死循环）。
    #[test]
    fn handles_zero_height() {
        assert!(plan_segments(0, MAX_TEXTURE_HEIGHT_PX).is_empty());
        assert!(plan_segments(1000, 0).is_empty());
    }

    /// dpr=2 时可用版式高度减半——分段规划必须按设备像素算，否则每段都会撞上限。
    #[test]
    fn halves_usable_height_at_double_dpr() {
        let max_css = MAX_TEXTURE_HEIGHT_PX / 2;
        let segments = plan_segments(max_css + 1, max_css);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[1], (max_css, 1));
    }

    /// 单段不改名；多段按 1 起编号，且保留原扩展名。
    #[test]
    fn numbers_multi_segment_outputs() {
        let base = Path::new(r"D:\分享\周报.png");
        assert_eq!(segment_path(base, 0, 1), PathBuf::from(r"D:\分享\周报.png"));
        assert_eq!(
            segment_path(base, 0, 3),
            PathBuf::from(r"D:\分享\周报-1.png")
        );
        assert_eq!(
            segment_path(base, 2, 3),
            PathBuf::from(r"D:\分享\周报-3.png")
        );
    }

    /// 十段以上补零，否则资源管理器按名排序会给出 1、10、2 这种顺序。
    #[test]
    fn pads_segment_numbers_past_nine() {
        let base = Path::new(r"D:\a\b.png");
        assert_eq!(segment_path(base, 0, 12), PathBuf::from(r"D:\a\b-01.png"));
        assert_eq!(segment_path(base, 11, 12), PathBuf::from(r"D:\a\b-12.png"));
    }

    /// 无扩展名的落点也要能编号（补 .png）。
    #[test]
    fn falls_back_to_png_extension() {
        let base = Path::new(r"D:\a\长图");
        assert_eq!(segment_path(base, 1, 2), PathBuf::from(r"D:\a\长图-2.png"));
    }

    /// 注入脚本必须是合法 JS，字段名 camelCase，且反斜杠被 JSON 转义。
    #[test]
    fn builds_capture_job_script() {
        let job = CaptureJob {
            source: r"D:\笔记\a b.md",
            include_toc: false,
            mode: CAPTURE_JOB_MODE,
            image_width: WECHAT_IMAGE_WIDTH_PX,
        };
        let script = build_capture_job_script(&job).expect("序列化不应失败");
        assert!(script.starts_with("window.__MDNAONAO_PRINT_JOB__ = Object.freeze({"));
        assert!(script.contains(r#""mode":"image""#));
        assert!(script.contains(r#""imageWidth":720"#));
        assert!(script.contains(r#""includeToc":false"#));
        assert!(script.contains(r"D:\\笔记\\a b.md"));
    }

    /// 前后端契约：CaptureOptions 缺字段时必须落到默认版式，而不是反序列化失败。
    #[test]
    fn deserializes_partial_options() {
        let options: CaptureOptions =
            serde_json::from_str(r#"{"source":"D:\\a.md"}"#).expect("部分字段应可解析");
        assert_eq!(options.source.as_deref(), Some(r"D:\a.md"));
        assert_eq!(options.width, WECHAT_IMAGE_WIDTH_PX);
        assert!(options.output.is_none());
        assert!((options.device_scale_factor - 1.0).abs() < f32::EPSILON);
    }

    /// 优先 cssContentSize；两组都在时不能混用（混用即分段错位）。
    #[test]
    fn prefers_css_content_size() {
        let response = r#"{
            "contentSize":{"x":0,"y":0,"width":1440,"height":24000},
            "cssContentSize":{"x":0,"y":0,"width":720,"height":12000}
        }"#;
        let content = parse_content_box(response).expect("应解析成功");
        assert_eq!(
            content,
            ContentBox {
                width: 720,
                height: 12000
            }
        );
    }

    /// 老版本只回 contentSize 时照样要能用。
    #[test]
    fn falls_back_to_content_size() {
        let response = r#"{"contentSize":{"x":0,"y":0,"width":720.4,"height":5000.2}}"#;
        let content = parse_content_box(response).expect("应解析成功");
        // 向上取整：截少一像素就是把最后一行文字切掉半截
        assert_eq!(
            content,
            ContentBox {
                width: 721,
                height: 5001
            }
        );
    }

    /// 返回体不含尺寸时必须报错，而不是拿 0 去截一张空图。
    #[test]
    fn rejects_metrics_without_content_size() {
        let err = parse_content_box(r#"{"layoutViewport":{"clientWidth":720}}"#)
            .expect_err("缺 contentSize 应报错");
        assert!(err.to_string().contains("contentSize"));
    }

    /// PNG 头解析：正例 + 非 PNG + 长度不足。
    #[test]
    fn reads_png_dimensions() {
        let mut png = Vec::from(PNG_MAGIC);
        png.extend_from_slice(&13_u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&720_u32.to_be_bytes());
        png.extend_from_slice(&5400_u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Some((720, 5400)));

        assert_eq!(png_dimensions(b"not a png at all........."), None);
        assert_eq!(png_dimensions(&PNG_MAGIC), None);
    }

    /// 截断的 PNG（高度短了一大截）要被记为异常但不阻断——尺寸照实回报。
    #[test]
    fn verify_png_reports_actual_size() {
        let mut png = Vec::from(PNG_MAGIC);
        png.extend_from_slice(&13_u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&720_u32.to_be_bytes());
        png.extend_from_slice(&4000_u32.to_be_bytes());
        let clip = ClipRect {
            top: 0,
            width: 720,
            height: 8000,
            scale: 1.0,
        };
        let (width, height) = verify_png(&png, 0, &clip).expect("合法 PNG 不应报错");
        assert_eq!((width, height), (720, 4000));
    }

    /// 非 PNG 必须直接失败：写一个坏文件出去比报错更糟。
    #[test]
    fn verify_png_rejects_garbage() {
        let clip = ClipRect {
            top: 0,
            width: 720,
            height: 100,
            scale: 1.0,
        };
        let err = verify_png(b"garbage", 0, &clip).expect_err("非 PNG 应报错");
        assert!(err.to_string().contains("PNG"));
    }

    /// base64：三种余数长度 + 中文多字节都要正确还原。
    #[test]
    fn decodes_base64_payloads() {
        assert_eq!(decode_base64("").expect("空串合法"), Vec::<u8>::new());
        assert_eq!(decode_base64("TWFu").expect("无填充"), b"Man".to_vec());
        assert_eq!(decode_base64("TWE=").expect("一个填充"), b"Ma".to_vec());
        assert_eq!(decode_base64("TQ==").expect("两个填充"), b"M".to_vec());
        assert_eq!(decode_base64("TWFu\n").expect("含换行"), b"Man".to_vec());
    }

    /// PNG 魔数经 base64 往返后仍能被 png_dimensions 认出（解码链路自检）。
    #[test]
    fn decodes_png_magic() {
        assert_eq!(
            decode_base64("iVBORw0KGgo=").expect("PNG 魔数"),
            PNG_MAGIC.to_vec()
        );
    }

    /// 非法字符必须报错而不是静默产出一张坏图。
    #[test]
    fn rejects_invalid_base64() {
        let err = decode_base64("TW@u").expect_err("非法字符应报错");
        assert!(err.contains("非法"));
    }
}
