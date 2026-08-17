//! DG 7.1 `share/lark.rs` 职责：token 缓存刷新、`medias/upload_all` + `import_tasks`、降级逻辑。
//!
//! 链路（事实库 #7，已联网核验，**不要重新调研、不要"好心纠正"**）：
//! 1. `POST /open-apis/drive/v1/medias/upload_all`（`parent_type=ccm_import_open`）→ 拿 `file_token`；
//! 2. `POST /open-apis/drive/v1/import_tasks`（**复数**，不是 `import_task`）→ 拿 `ticket`；
//! 3. 轮询 `GET /open-apis/drive/v1/import_tasks/:ticket` → 成功后拿云文档 url 并打开。
//!
//! 硬性细节：
//! * MD 上限 **20MB**，超限直接提示不支持 API 导入并降级默认通道（复制富文本）；
//! * `file_extension` 必须与实际后缀**严格一致**，否则报错码 **1069910**；
//! * 最小权限集只申请两个：`docs:document:import` + `docs:document.media:upload`；
//! * 个人版账号须先免费建团队才能创建自建应用（配置引导四步的第一步）；
//! * 任一步失败 → 降级默认通道（DG 7.2-6），不得让用户卡在错误里。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 飞书开放平台域名。
pub const LARK_BASE_URL: &str = "https://open.feishu.cn";

/// 上传接口的 parent_type（导入场景固定值）。
pub const PARENT_TYPE_IMPORT: &str = "ccm_import_open";

/// API 导入的文件大小上限（20MB）。
pub const MAX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;

/// `file_extension` 与实际后缀不一致时的错误码。
pub const ERR_EXTENSION_MISMATCH: i64 = 1069910;

/// 轮询间隔与上限（轮询是异步任务，飞书侧转换需要时间）。
pub const POLL_INTERVAL_MS: u64 = 1000;
pub const POLL_MAX_ATTEMPTS: u32 = 60;

/// 导入任务状态机。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportState {
    Uploading,
    Importing,
    Succeeded,
    Failed,
}

/// 导入结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub state: ImportState,
    /// 成功后的云文档链接
    pub url: Option<String>,
    /// 失败原因（面向日志；用户文案由前端 i18n 决定）
    pub message: Option<String>,
}

/// tenant_access_token 缓存（落盘时经 DPAPI 加密，见 [`crate::settings`]）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCache {
    pub token: String,
    /// 过期时间戳（秒）。提前 5 分钟视为过期以避开边界。
    pub expires_at: i64,
}

// ---------------------------------------------------------------------------
// 命令骨架
// ---------------------------------------------------------------------------

/// 进阶通道：把当前 .md 导入飞书云文档并返回链接（FR-11）。
///
/// TODO(M3)：串起 [`upload_media`] → [`create_import_task`] → [`poll_import_task`]；
/// 任一步失败都要 `tracing::warn!` 记录并返回可降级的错误（前端据此自动降级默认通道）。
#[tauri::command]
pub async fn import_to_lark(path: PathBuf) -> AppResult<ImportResult> {
    Err(AppError::not_implemented(format!(
        "share::lark::import_to_lark（M3）：{}",
        path.display()
    )))
}

/// 设置页「测试连接」：用 app_id/secret 换一次 tenant_access_token 即可验证。
///
/// TODO(M3)：调用 [`fetch_tenant_access_token`]，不要顺带发起导入。
#[tauri::command]
pub async fn test_lark_connection() -> AppResult<()> {
    Err(AppError::not_implemented(
        "share::lark::test_lark_connection（M3）",
    ))
}

// ---------------------------------------------------------------------------
// 内部实现位
// ---------------------------------------------------------------------------

/// 获取 / 刷新 tenant_access_token（带缓存，过期前 5 分钟刷新）。
///
/// TODO(M3)：`POST /open-apis/auth/v3/tenant_access_token/internal`。
pub async fn fetch_tenant_access_token() -> AppResult<TokenCache> {
    Err(AppError::not_implemented(
        "share::lark::fetch_tenant_access_token（M3）",
    ))
}

/// 第 1 步：`medias/upload_all`（multipart），`parent_type` 固定 [`PARENT_TYPE_IMPORT`]。
///
/// TODO(M3)：注意 `file_name` 的后缀必须与 [`create_import_task`] 传的
/// `file_extension` 一致，否则报 [`ERR_EXTENSION_MISMATCH`]。
pub async fn upload_media(token: &str, path: &Path) -> AppResult<String> {
    let _ = (token, path);
    Err(AppError::not_implemented("share::lark::upload_media（M3）"))
}

/// 第 2 步：`POST import_tasks`（复数）创建导入任务，返回 ticket。
///
/// `point.mount_key` 传空字符串 = 挂到云空间根目录（DG 7.2-6）。
pub async fn create_import_task(
    token: &str,
    file_token: &str,
    extension: &str,
) -> AppResult<String> {
    let _ = (token, file_token, extension);
    Err(AppError::not_implemented(
        "share::lark::create_import_task（M3）",
    ))
}

/// 第 3 步：轮询 `GET import_tasks/:ticket` 直到成功 / 失败 / 超过 [`POLL_MAX_ATTEMPTS`]。
pub async fn poll_import_task(token: &str, ticket: &str) -> AppResult<ImportResult> {
    let _ = (token, ticket);
    Err(AppError::not_implemented(
        "share::lark::poll_import_task（M3）",
    ))
}

/// 导入前置校验：大小 ≤ 20MB 且扩展名可被飞书识别。
pub fn precheck(byte_size: u64, extension: &str) -> AppResult<()> {
    if byte_size > MAX_IMPORT_BYTES {
        return Err(AppError::api(format!(
            "文件 {} 字节超过飞书导入上限 {} 字节，需降级默认通道",
            byte_size, MAX_IMPORT_BYTES
        )));
    }
    if !matches!(extension, "md" | "markdown") {
        return Err(AppError::api(format!(
            "飞书导入不接受扩展名 .{}（file_extension 必须与实际后缀严格一致，否则报错码 {}）",
            extension, ERR_EXTENSION_MISMATCH
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 超过 20MB 必须在发请求之前就拦下并降级。
    #[test]
    fn rejects_oversized_file() {
        assert!(precheck(MAX_IMPORT_BYTES + 1, "md").is_err());
        assert!(precheck(MAX_IMPORT_BYTES, "md").is_ok());
    }

    /// 扩展名不匹配是 1069910 的根因，前置拦截。
    #[test]
    fn rejects_unsupported_extension() {
        assert!(precheck(1024, "mkd").is_err());
        assert!(precheck(1024, "markdown").is_ok());
    }
}
