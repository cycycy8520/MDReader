//! DG 7.1 `files.rs` 职责：文件读写、编码检测（UTF-8/BOM/GBK）、标题提取、
//! `recent.json` 持久化、notify 文件监听。
//!
//! 关键约束：
//! * **严格只读**（红线 5）：本模块只提供读取能力，任何写回 `.md` 的函数都不许出现。
//! * 编码（DG 8「编码」+ DG 10-4）：UTF-8 优先 → 去 BOM → 失败按 GBK 兜底，
//!   状态栏显示实际编码。GBK 兜底不做会被中文用户骂乱码。
//! * 最近列表（DG 5.3 / 7.3）：上限 200 条 LRU，写入防抖 500ms。
//! * 监听（DG 7.2-3 / FR-06）：notify 事件 → 防抖 300ms → 前端离屏重渲染 →
//!   一次性替换并保持滚动位置；文件被删除/移动 → 顶栏警示条。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

/// 最近列表上限（DG 5.3）。
pub const RECENT_LIMIT: usize = 200;

/// 最近列表写盘防抖（DG 7.3）。
pub const RECENT_WRITE_DEBOUNCE_MS: u64 = 500;

/// 文件变更防抖（DG 7.2-3）。
pub const WATCH_DEBOUNCE_MS: u64 = 300;

/// 大文件阈值（FR-01：>5MB 直接打开 + 提示条 + 分段渲染）。
pub const LARGE_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// 支持的扩展名，必须与 `tauri.conf.json` 的 `bundle.fileAssociations.ext` 完全一致。
pub const SUPPORTED_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "mkdn"];

/// 实际使用的解码方式，回传前端显示在状态栏。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Gbk,
}

impl Encoding {
    /// 状态栏展示名。
    pub fn label(&self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf8Bom => "UTF-8 BOM",
            Encoding::Gbk => "GBK",
        }
    }
}

/// 一次「打开文件」的完整回传载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    /// 绝对路径
    pub path: String,
    /// 标题：首个 H1，无则文件名（DG 5.3）
    pub title: String,
    /// 原始 Markdown 文本（frontmatter 的剥离在前端渲染层做，FR-14）
    pub content: String,
    pub encoding: Encoding,
    pub byte_size: u64,
    pub line_count: usize,
    /// 是否超过 [`LARGE_FILE_BYTES`]，前端据此走分段渲染 + 顶部提示条
    pub is_large: bool,
}

/// 滚动位置记忆（FR-16：首个可见标题锚点 + 偏移）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollAnchor {
    /// 标题元素 id；文档无标题时为空串，退化为纯偏移
    pub heading_id: String,
    /// 相对该标题顶部的像素偏移
    pub offset: f64,
}

/// 最近列表条目（DG 5.3 数据模型）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub title: String,
    /// Unix 毫秒时间戳
    pub opened_at: i64,
    pub pinned: bool,
    /// 滚动位置记忆（FR-16）；与前端 `ScrollAnchor` 类型逐字段对应
    pub scroll_anchor: Option<ScrollAnchor>,
}

// ---------------------------------------------------------------------------
// 命令骨架
// ---------------------------------------------------------------------------

/// 读取并解码一个 Markdown 文件。
///
/// TODO(M1)：读字节 → [`detect_and_decode`] → [`extract_title`] → 组装 [`DocumentPayload`]；
/// 路径不存在返回 [`AppError::NotFound`]（FR-06 警示条依赖此错误 kind）。
#[tauri::command]
pub async fn read_markdown(path: String) -> AppResult<DocumentPayload> {
    Err(AppError::not_implemented(format!(
        "files::read_markdown（M1）：{path}"
    )))
}

/// 读取最近列表。
///
/// TODO(M1)：读 `%APPDATA%\MDNaonao\recent.json`；文件缺失返回空数组；
/// 损坏时备份后重建（不阻塞启动）。
#[tauri::command]
pub async fn list_recent() -> AppResult<Vec<RecentEntry>> {
    Err(AppError::not_implemented("files::list_recent（M1）"))
}

/// 打开文件后更新最近列表（LRU 提前 + 超 [`RECENT_LIMIT`] 淘汰 + 防抖写盘）。
///
/// TODO(M1)：实现 LRU 与防抖写入。
#[tauri::command]
pub async fn touch_recent(entry: RecentEntry) -> AppResult<Vec<RecentEntry>> {
    Err(AppError::not_implemented(format!(
        "files::touch_recent（M1）：{}",
        entry.path
    )))
}

/// 从最近列表移除（**不删文件**，FR-03）。
#[tauri::command]
pub async fn remove_recent(path: String) -> AppResult<Vec<RecentEntry>> {
    Err(AppError::not_implemented(format!(
        "files::remove_recent（M1）：{path}"
    )))
}

/// 置顶 / 取消置顶（FR-03）。
#[tauri::command]
pub async fn set_recent_pinned(path: String, pinned: bool) -> AppResult<Vec<RecentEntry>> {
    Err(AppError::not_implemented(format!(
        "files::set_recent_pinned（M1）：{path} pinned={pinned}"
    )))
}

/// 记录滚动锚点（FR-16 滚动位置记忆）。
#[tauri::command]
pub async fn set_scroll_anchor(path: String, anchor: Option<ScrollAnchor>) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "files::set_scroll_anchor（v1.0/M2）：{path} anchor={anchor:?}"
    )))
}

/// 在资源管理器中定位文件（FR-03「打开所在文件夹」）。
///
/// TODO(M1)：`explorer.exe /select,"<path>"`；注意路径含空格/中文时的引号处理，
/// 且 explorer 的退出码不可靠（返回 1 也可能成功），不要据此判失败。
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "files::reveal_in_explorer（M1）：{path}"
    )))
}

/// 开始监听当前文件（同一时刻只监听一个文件，切换文件时自动替换）。
///
/// TODO(M1)：notify RecommendedWatcher 监听**父目录**（编辑器多为「写临时文件 + rename」，
/// 直接监听文件本身会在保存后丢失句柄）→ 过滤目标文件事件 → 防抖
/// [`WATCH_DEBOUNCE_MS`] → `emit("file-changed" | "file-removed")` 给前端。
#[tauri::command]
pub async fn watch_file(app: AppHandle, path: String) -> AppResult<()> {
    let _ = app;
    Err(AppError::not_implemented(format!(
        "files::watch_file（M1）：{path}"
    )))
}

/// 停止监听。
#[tauri::command]
pub async fn unwatch_file(app: AppHandle) -> AppResult<()> {
    let _ = app;
    Err(AppError::not_implemented("files::unwatch_file（M1）"))
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 编码检测与解码：UTF-8 优先 → BOM 去除 → 失败按 GBK 兜底（DG 8「编码」）。
///
/// TODO(M1)：GBK 解码需要一个解码器。当前依赖清单里没有 `encoding_rs`，
/// 按红线 12 必须先向人类申请后再加，**不要自己塞进 Cargo.toml**。
/// 申请前可先实现 UTF-8/BOM 两条分支，GBK 分支返回 [`AppError::Encoding`]。
pub fn detect_and_decode(bytes: &[u8]) -> AppResult<(String, Encoding)> {
    let _ = bytes;
    Err(AppError::not_implemented("files::detect_and_decode（M1）"))
}

/// 提取标题：首个 H1（`# `），无则回退文件名（不含扩展名）（DG 5.3）。
///
/// TODO(M1)：注意跳过 frontmatter 区块，避免把 YAML 里的 `#` 注释当标题。
pub fn extract_title(content: &str, path: &Path) -> String {
    let _ = content;
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 是否为受支持的 Markdown 扩展名（大小写不敏感）。
pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            SUPPORTED_EXTENSIONS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

/// `recent.json` 路径。
pub fn recent_path() -> AppResult<PathBuf> {
    Ok(crate::settings::app_data_dir()?.join("recent.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 扩展名判定必须覆盖五个关联后缀且大小写不敏感（与 fileAssociations 对齐）。
    #[test]
    fn recognizes_all_associated_extensions() {
        for ext in SUPPORTED_EXTENSIONS {
            let path = PathBuf::from(format!("D:\\a.{ext}"));
            assert!(is_supported(&path), "应支持 .{ext}");
        }
        assert!(is_supported(Path::new("D:\\A.MD")));
        assert!(!is_supported(Path::new("D:\\a.txt")));
        assert!(!is_supported(Path::new("D:\\a")));
    }

    /// 无 H1 时标题回退为文件名（不含扩展名）。
    #[test]
    fn falls_back_to_file_stem_as_title() {
        let title = extract_title("正文没有标题", Path::new("D:\\笔记\\我的文档.md"));
        assert_eq!(title, "我的文档");
    }
}
