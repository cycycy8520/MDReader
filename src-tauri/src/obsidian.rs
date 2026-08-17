//! DG 7.1 `obsidian.rs` 职责：读全局 `obsidian.json` → Vault 列表 → 复制导入 → URI 唤起。
//!
//! 方案要点（DG 8「Obsidian 导入」+ FR-09）：
//! * Vault 枚举：读 `%APPDATA%\obsidian\obsidian.json`（以官方数据目录文档为准），
//!   其 `vaults` 字段是 `{ "<hash>": { "path": "...", "ts": 0, "open": true } }` 形态；
//! * 导入：复制 .md 到 vault（可选子目录）+ 附件复制到 vault 附件目录并**重写链接**；
//! * 同名冲突：提示「覆盖 / 改名」，不静默覆盖；
//! * 完成后 `obsidian://open?vault=<name>&file=<相对路径>` 唤起定位；
//!   深定位（跳到具体标题）需 Advanced URI 插件，**检测到才启用**，否则退化为打开文件。
//!
//! 附件路径重写与「导出 HTML」「单文件内联」共用同一个解析器（DG 8「附件路径重写」、
//! DG 10-5：修一处即修三处），中文 / 空格 / UNC 路径全部进语料库。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Obsidian 全局配置文件所在目录（相对 `%APPDATA%`）。
pub const OBSIDIAN_CONFIG_DIR: &str = "obsidian";
pub const OBSIDIAN_CONFIG_FILE: &str = "obsidian.json";

/// 一个 Vault。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    /// obsidian.json 里的 key（hash）
    pub id: String,
    /// Vault 根目录
    pub path: PathBuf,
    /// 展示名：取 path 的最后一段
    pub name: String,
    /// 是否为当前打开的 Vault
    pub open: bool,
}

/// 同名冲突处理策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictPolicy {
    /// 覆盖已有文件
    Overwrite,
    /// 自动改名（追加 `-1`、`-2`…）
    Rename,
}

/// 导入请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    /// 源 .md 绝对路径
    pub source: PathBuf,
    /// 目标 Vault id
    pub vault_id: String,
    /// Vault 内子目录（可空 = 根目录）
    pub subfolder: Option<String>,
    pub conflict: ConflictPolicy,
}

/// 导入结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    /// Vault 内相对路径（用于拼 `obsidian://open` 的 file 参数）
    pub relative_path: String,
    /// 一并复制的附件数量
    pub attachment_count: usize,
    /// 唤起用的 URI
    pub uri: String,
}

// ---------------------------------------------------------------------------
// 命令骨架
// ---------------------------------------------------------------------------

/// 枚举本机 Obsidian Vault（FR-09 第一步）。
///
/// TODO(M3)：读 `%APPDATA%\obsidian\obsidian.json`；文件不存在说明用户未装 Obsidian，
/// 返回空列表让前端显示引导，**不要报错**。
#[tauri::command]
pub async fn list_vaults() -> AppResult<Vec<Vault>> {
    Err(AppError::not_implemented("obsidian::list_vaults（M3）"))
}

/// 导入当前文档到指定 Vault（FR-09）。
///
/// TODO(M3)：复制 .md → 扫描并复制附件到 vault 附件目录 → 重写链接 →
/// 处理同名冲突 → 返回 [`ImportOutcome`]（含 `obsidian://open` URI）。
#[tauri::command]
pub async fn import_to_vault(request: ImportRequest) -> AppResult<ImportOutcome> {
    Err(AppError::not_implemented(format!(
        "obsidian::import_to_vault（M3）：{} → vault={}",
        request.source.display(),
        request.vault_id
    )))
}

/// 唤起 Obsidian 定位到刚导入的文件。
///
/// TODO(M3)：`obsidian://open?vault=<urlencoded>&file=<urlencoded>`；
/// URL 编码必须覆盖中文与空格，否则唤起失败。
#[tauri::command]
pub async fn open_in_obsidian(uri: String) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "obsidian::open_in_obsidian（M3）：{uri}"
    )))
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// `%APPDATA%\obsidian\obsidian.json` 路径。
pub fn obsidian_config_path() -> AppResult<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .ok_or_else(|| AppError::config("未取到 %APPDATA% 环境变量"))?;
    Ok(PathBuf::from(base)
        .join(OBSIDIAN_CONFIG_DIR)
        .join(OBSIDIAN_CONFIG_FILE))
}

/// 检测是否安装了 Advanced URI 插件（决定能否深定位到标题）。
///
/// TODO(M3)：检查 `<vault>/.obsidian/plugins/obsidian-advanced-uri/` 是否存在；
/// 未检测到就退化为普通 `obsidian://open`，不提示、不报错。
pub fn has_advanced_uri_plugin(vault_root: &std::path::Path) -> bool {
    vault_root
        .join(".obsidian")
        .join("plugins")
        .join("obsidian-advanced-uri")
        .is_dir()
}
