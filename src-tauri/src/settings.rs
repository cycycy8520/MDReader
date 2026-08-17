//! DG 7.1 `settings.rs` 职责：配置读写；飞书密钥 DPAPI 加密。
//!
//! 存储位置（DG 7.3）：`%APPDATA%\MDViewer\`
//! * `settings.json` —— 主题、字号、缩放、导出偏好、代码折行、元数据显示、
//!   大纲钉住态、窗口几何；
//! * `lark-token.json` —— 飞书 app_id / app_secret / token 缓存，
//!   **必须 Windows DPAPI 加密后落盘**，不得明文。
//!
//! 注意：这里刻意不使用 Tauri 的 `app_data_dir()`——它返回
//! `%APPDATA%\com.mdviewer.app`，与 DG 7.3 规定的 `%APPDATA%\MDViewer` 不一致；
//! 且 [`crate::logging::init`] 在 Tauri App 建立之前就要用到本目录。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 用户数据根目录：`%APPDATA%\MDViewer\`。
pub fn app_data_dir() -> AppResult<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .ok_or_else(|| AppError::config("未取到 %APPDATA% 环境变量"))?;
    Ok(PathBuf::from(base).join("MDViewer"))
}

/// `settings.json` 完整路径。
pub fn settings_path() -> AppResult<PathBuf> {
    Ok(app_data_dir()?.join("settings.json"))
}

/// `lark-token.json` 完整路径（内容为 DPAPI 密文）。
pub fn lark_credential_path() -> AppResult<PathBuf> {
    Ok(app_data_dir()?.join("lark-token.json"))
}

/// 主题模式（DG 5.5：深浅共用同一套语义 Token；首启跟随系统）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

/// 导出 HTML 的两种模式（FR-07）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HtmlExportMode {
    /// 单文件：图片全部 base64 内联（默认）
    #[default]
    SingleFile,
    /// HTML + `xxx_files/` 资源目录
    WithAssets,
}

/// 窗口几何，用于重启还原（DG 6.2「窗口记忆」）。
/// 异常位置（显示器被拔掉）由前端/启动逻辑回落主屏居中。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
            maximized: false,
        }
    }
}

/// `settings.json` 结构。字段名走 camelCase，前端 `stores/settings` 直接对齐。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: ThemeMode,
    /// 正文字号（px，DG 5.4 基准 16）
    pub font_size: u16,
    /// 缩放百分比，范围 90–150（DG 5.2 状态栏）
    pub zoom_percent: u16,
    /// 代码块折行（关=横向滚动，DG 5.4）
    pub code_wrap: bool,
    /// 显示 frontmatter 属性卡片（FR-14）
    pub show_metadata: bool,
    /// 大纲钉住态（FR-04）
    pub outline_pinned: bool,
    /// 左栏宽度，范围 200–360（DG 5.2）
    pub sidebar_width: u32,
    /// 左栏是否折叠（Ctrl+B）
    pub sidebar_collapsed: bool,
    pub html_export_mode: HtmlExportMode,
    pub window: WindowGeometry,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            font_size: 16,
            zoom_percent: 100,
            code_wrap: false,
            show_metadata: true,
            outline_pinned: false,
            sidebar_width: 260,
            sidebar_collapsed: false,
            html_export_mode: HtmlExportMode::SingleFile,
            window: WindowGeometry::default(),
        }
    }
}

/// 飞书进阶通道凭据（DG 8「飞书分享（双通道）」）。
/// **明文只在内存中存在**，落盘前必须经 [`dpapi_protect`]。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LarkCredential {
    pub app_id: String,
    pub app_secret: String,
    /// tenant_access_token 缓存及其过期时间戳（秒）
    pub tenant_access_token: Option<String>,
    pub expires_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// 命令骨架
// ---------------------------------------------------------------------------

/// 读取配置；文件不存在返回 [`Settings::default`]，损坏则备份后重建（不要直接报错吓用户）。
///
/// TODO(M1)：实现读取 + 字段容错（缺字段走 serde default）+ 范围钳制。
#[tauri::command]
pub async fn load_settings() -> AppResult<Settings> {
    Err(AppError::not_implemented("settings::load_settings（M1）"))
}

/// 写入配置。写入需防抖（前端侧节流，后端保证原子写：临时文件 + rename）。
///
/// TODO(M1)：实现原子写。
#[tauri::command]
pub async fn save_settings(settings: Settings) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "settings::save_settings（M1）：theme={:?}",
        settings.theme
    )))
}

/// 保存飞书凭据（进 DPAPI 密文）。
///
/// TODO(M3)：调用 [`dpapi_protect`] 后写 `lark-token.json`。
#[tauri::command]
pub async fn save_lark_credential(credential: LarkCredential) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "settings::save_lark_credential（M3）：app_id={}",
        credential.app_id
    )))
}

// ---------------------------------------------------------------------------
// DPAPI 加密位
// ---------------------------------------------------------------------------

/// DPAPI 加密（CryptProtectData，CRYPTPROTECT_UI_FORBIDDEN，作用域为当前用户）。
///
/// TODO(M3)：用已锁定版本的 `windows` crate 调用
/// `Windows::Win32::Security::Cryptography::CryptProtectData`；
/// 依赖版本必须跟随 wry 锁定（红线 10），不得为此单独引入新版本。
pub fn dpapi_protect(plain: &[u8]) -> AppResult<Vec<u8>> {
    let _ = plain;
    Err(AppError::not_implemented("settings::dpapi_protect（M3）"))
}

/// DPAPI 解密（CryptUnprotectData）。换机/换用户后必然解密失败——
/// 此时应清空凭据并引导用户重新配置，而不是把错误直接抛给用户。
pub fn dpapi_unprotect(cipher: &[u8]) -> AppResult<Vec<u8>> {
    let _ = cipher;
    Err(AppError::not_implemented("settings::dpapi_unprotect（M3）"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认值必须与 DG 5.2 / 5.4 的基准一致。
    #[test]
    fn default_settings_match_spec() {
        let settings = Settings::default();
        assert_eq!(settings.font_size, 16);
        assert_eq!(settings.zoom_percent, 100);
        assert_eq!(settings.sidebar_width, 260);
        assert_eq!(settings.theme, ThemeMode::System);
    }

    /// 序列化字段名走 camelCase（前端 store 直接对齐）。
    #[test]
    fn serializes_with_camel_case_keys() {
        let json = serde_json::to_value(Settings::default()).expect("序列化不应失败");
        assert!(json.get("fontSize").is_some());
        assert!(json.get("zoomPercent").is_some());
        assert!(json.get("htmlExportMode").is_some());
    }
}
