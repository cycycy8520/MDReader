//! DG 7.1 `capture.rs` 职责：长图 —— CDP `Page.captureScreenshot`
//! （`captureBeyondViewport: true`）。
//!
//! **红线 9（不可动摇）**：WebView2 的 `CapturePreview` 只截可视区——这是微软官方
//! 确认的设计行为（事实库 #5），**不可用于长图**。唯一路线是走 WebView2 自带的
//! CDP 通道 `CallDevToolsProtocolMethod` 调 `Page.captureScreenshot`，
//! 且必须显式设 `captureBeyondViewport: true`（默认值与 CapturePreview 一样只截可视区）。
//!
//! 其它约束（DG 4.1「长图截图」行 + DG 8「微信分享」）：
//! * 超长页面受 GPU 纹理上限（约 16384px）限制，超限**强制分段截图拼接**；
//! * 微信长图版式宽度 720px；
//! * 产物 PNG 写剪贴板（clipboard-manager `write_image`）并支持另存；
//! * 与预览渲染同源，因此不引入 html-to-image（规避 foreignObject 字体丢失）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

/// GPU 纹理高度上限（经验值，超过即分段拼接）。M0-② 需实测确认本机实际上限并回填。
pub const MAX_TEXTURE_HEIGHT_PX: u32 = 16384;

/// 微信长图版式宽度（DG 8）。
pub const WECHAT_IMAGE_WIDTH_PX: u32 = 720;

/// 长图导出选项。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    /// 渲染宽度，默认 [`WECHAT_IMAGE_WIDTH_PX`]
    pub width: u32,
    /// 另存路径；为 None 表示只写剪贴板
    pub output: Option<PathBuf>,
    /// 设备像素比（1 = 标准，2 = 高清但体积翻倍）
    pub device_scale_factor: f32,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self {
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
    pub outputs: Vec<PathBuf>,
    pub segments: u32,
    pub total_height_px: u32,
    pub copied_to_clipboard: bool,
}

// ---------------------------------------------------------------------------
// 命令骨架
// ---------------------------------------------------------------------------

/// 生成当前文档长图（FR-10 主路径）。
///
/// TODO(M0-②/M3)：
/// 1. M0-② 先做实测原型：CDP `Page.captureScreenshot` +
///    `captureBeyondViewport: true`，含 >16384px 分页场景；
/// 2. M3 正式实现：调整渲染宽度 → 等待图片/字体加载完成（复用
///    [`crate::export::PRINT_READY_EVENT`] 同类信号）→ 截图 →
///    超限分段 → PNG 写剪贴板（clipboard-manager `write_image`）/ 另存。
#[tauri::command]
pub async fn capture_long_image(
    app: AppHandle,
    options: CaptureOptions,
) -> AppResult<CaptureResult> {
    let _ = app;
    Err(AppError::not_implemented(format!(
        "capture::capture_long_image（M0-②/M3）：width={}",
        options.width
    )))
}

// ---------------------------------------------------------------------------
// 内部实现位
// ---------------------------------------------------------------------------

/// 经 WebView2 CDP 通道执行一次 `Page.captureScreenshot`。
///
/// TODO(M0-②)：`ICoreWebView2::CallDevToolsProtocolMethod("Page.captureScreenshot", json)`，
/// 参数至少包含：`{"format":"png","captureBeyondViewport":true,"clip":{...},"fromSurface":true}`。
/// 返回值是 base64 编码的 PNG，注意大图的 base64 内存峰值（10MB 文档的长图可达数十 MB）。
///
/// **禁止**改用 `CapturePreview`（红线 9）。
pub async fn capture_screenshot_cdp(
    app: &AppHandle,
    clip_top: u32,
    clip_height: u32,
) -> AppResult<Vec<u8>> {
    let _ = (app, clip_top, clip_height);
    Err(AppError::not_implemented(
        "capture::capture_screenshot_cdp（M0-②）",
    ))
}

/// 按 [`MAX_TEXTURE_HEIGHT_PX`] 把总高切成若干段，返回每段的 (top, height)。
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

    /// 边界：零高度不产生分段（避免死循环）。
    #[test]
    fn handles_zero_height() {
        assert!(plan_segments(0, MAX_TEXTURE_HEIGHT_PX).is_empty());
        assert!(plan_segments(1000, 0).is_empty());
    }
}
