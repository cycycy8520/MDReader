//! DG 7.1 `share/` 职责：分享通道。
//!
//! 三个目标平台的能力边界（DG 2.3 硬性平台约束 + DG 10-1，**产品文案必须与之一致**）：
//! * **微信**：无 API；聊天窗口粘贴富文本必退化为纯文本（平台确定性行为）。
//!   因此聊天场景只做长图（[`crate::capture`]）与文件；富文本只面向**公众号编辑器**。
//!   永不承诺、永不实现「自动发到微信」（红线 7）。
//! * **飞书**：默认通道 = 复制富文本粘贴；进阶通道 = API 导入（[`lark`]）。
//! * **钉钉**：无公开文档导入 API（事实库 #8），只做富文本 / 长图 / 发送文件三兜底。
//!
//! 富文本写剪贴板一律用 clipboard-manager 的 `write_html(html, alt_text)`——
//! 它自动生成 CF_HTML 头并同时写入纯文本回退（事实库 #14），
//! **不手工拼 CF_HTML 头**（红线 11）。

pub mod lark;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

/// 分享目标，仅用于日志与埋点式的行为区分（无遥测，DG 2.2 范围外）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShareTarget {
    /// 微信公众号编辑器（富文本）
    WechatMp,
    /// 飞书文档（富文本粘贴，默认通道）
    Lark,
    /// 钉钉文档（富文本粘贴）
    DingTalk,
}

/// 富文本分享载荷。HTML 由前端按 doocs/md 思路渲染成**内联样式**
/// （编辑器普遍会丢弃 `<style>` 块，只认内联样式）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextPayload {
    /// 内联样式 HTML
    pub html: String,
    /// 纯文本回退（`write_html` 的 alt_text；聊天窗口只会取到这一份）
    pub plain_text: String,
    pub target: ShareTarget,
}

/// 把富文本写入剪贴板（FR-10 ② / FR-11 默认通道 / FR-18）。
///
/// TODO(M3)：调用 clipboard-manager 的 `write_html(html, alt_text)`；
/// 成功后前端提示「已复制，粘贴到公众号编辑器 / 飞书文档即可保留排版」。
#[tauri::command]
pub async fn copy_rich_text(app: AppHandle, payload: RichTextPayload) -> AppResult<()> {
    let _ = app;
    Err(AppError::not_implemented(format!(
        "share::copy_rich_text（M3）：target={:?}",
        payload.target
    )))
}

/// 「发送文件」兜底：把 .md 原文件复制到剪贴板（CF_HDROP），供用户直接粘进聊天窗口。
///
/// TODO(M3)：clipboard-manager 不覆盖 CF_HDROP；若确需实现，属于新增能力，
/// 先按红线 12 向人类确认方案（也可退化为「打开所在文件夹」引导用户手动拖拽）。
#[tauri::command]
pub async fn copy_file_to_clipboard(path: String) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "share::copy_file_to_clipboard（M3，方案待确认）：{path}"
    )))
}
