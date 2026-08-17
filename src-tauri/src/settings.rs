//! DG 7.1 `settings.rs` 职责：配置读写；飞书密钥 DPAPI 加密。
//!
//! 存储位置（DG 7.3）：`%APPDATA%\MDNaonao\`
//! * `settings.json` —— 主题、字号、缩放、导出偏好、代码折行、元数据显示、
//!   大纲钉住态、窗口几何；
//! * `lark-token.json` —— 飞书 app_id / app_secret / token 缓存，
//!   **必须 Windows DPAPI 加密后落盘**，不得明文。
//!
//! 注意：这里刻意不使用 Tauri 的 `app_data_dir()`——它返回
//! `%APPDATA%\com.mdnaonao.app`，与 DG 7.3 规定的 `%APPDATA%\MDNaonao` 不一致；
//! 且 [`crate::logging::init`] 在 Tauri App 建立之前就要用到本目录。
//!
//! 另外本模块还收口 **asset 协议目录授权**（[`allow_asset_dir`]）——它是
//! `tauri.conf.json > app.security.assetProtocol.scope` 的运行时另一半，
//! 属于「权限接线」而非文件读写，故与配置一起放在这里，便于集中审查。

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, AppResult};

/// 用户数据根目录：`%APPDATA%\MDNaonao\`。
pub fn app_data_dir() -> AppResult<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .ok_or_else(|| AppError::config("未取到 %APPDATA% 环境变量"))?;
    Ok(PathBuf::from(base).join("MDNaonao"))
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

// ---------------------------------------------------------------------------
// 合法区间（与前端 stores/settings.ts、stores/uiState.ts 的常量必须一一对应）
// ---------------------------------------------------------------------------

/// 正文字号档位下限（前端 `READING_FONT_SIZE_MIN`，DG 6.7）
const FONT_SIZE_MIN: u16 = 14;
/// 正文字号档位上限（前端 `READING_FONT_SIZE_MAX`，DG 6.7）
const FONT_SIZE_MAX: u16 = 20;
/// 缩放下限（前端 `ZOOM_MIN`，DG 5.2）
const ZOOM_MIN: u16 = 90;
/// 缩放上限（前端 `ZOOM_MAX`，DG 5.2）
const ZOOM_MAX: u16 = 150;
/// 左栏宽度下限（前端 `SIDEBAR_WIDTH_MIN`，DG 5.2）
const SIDEBAR_WIDTH_MIN: u32 = 200;
/// 左栏宽度上限（前端 `SIDEBAR_WIDTH_MAX`，DG 5.2）
const SIDEBAR_WIDTH_MAX: u32 = 360;
/// 窗口最小尺寸，与 `tauri.conf.json > app.windows[0].minWidth/minHeight` 一致
const WINDOW_MIN_WIDTH: u32 = 800;
const WINDOW_MIN_HEIGHT: u32 = 600;
/// 窗口尺寸上限：纯脏数据防御（多屏拼接也到不了这个量级）
const WINDOW_MAX_EDGE: u32 = 32_000;

/// 解析失败时坏文件的归档名。固定名而非时间戳：损坏往往会连续复现，
/// 时间戳会在用户目录里堆一地垃圾；只留最近一份足够排查。
const CORRUPT_BACKUP_NAME: &str = "settings.corrupt.json";

/// UTF-8 BOM。用户用记事本手改过 `settings.json` 就会带上它，
/// `serde_json` 见到 BOM 会直接报 `expected value`，必须先剥掉。
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

impl Settings {
    /// 把越界字段钳回合法区间。
    ///
    /// 读盘和入参两侧都要过一遍：磁盘上的值可能被手改过，
    /// 前端传来的值也可能因为版本不一致而超界。钳制而不是报错——
    /// 配置读不出来就打不开应用，这个代价太大（DG 10-8）。
    fn sanitize(&mut self) {
        self.font_size = self.font_size.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX);
        self.zoom_percent = self.zoom_percent.clamp(ZOOM_MIN, ZOOM_MAX);
        self.sidebar_width = self
            .sidebar_width
            .clamp(SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
        self.window.width = self.window.width.clamp(WINDOW_MIN_WIDTH, WINDOW_MAX_EDGE);
        self.window.height = self.window.height.clamp(WINDOW_MIN_HEIGHT, WINDOW_MAX_EDGE);
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
// 读写实现
// ---------------------------------------------------------------------------

/// 写临时文件并强制落盘。`sync_all` 不能省：`write_all` 只保证数据进了内核页缓存，
/// 之后 rename 再断电，磁盘上仍可能是一个长度为 0 的文件。
fn write_all_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// 原子写文件：先写同目录下的 `<name>.tmp`，`sync_all` 落盘后再 `rename` 覆盖目标。
///
/// 为什么必须这样：直接 `File::create` + `write_all` 会先把目标文件截断为 0 字节，
/// 此刻断电/崩溃就得到一个空的 `settings.json`——用户所有偏好归零。
/// Windows 上 [`std::fs::rename`] 走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，
/// 同卷内是原子替换：读者要么看到旧内容，要么看到新内容，不会看到半截文件。
/// 临时文件与目标同目录，保证同卷（跨卷 rename 会退化成复制，失去原子性）。
fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::config(format!("目标路径没有父目录：{}", path.display())))?;
    fs::create_dir_all(dir)?;

    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::config(format!("目标路径不是文件：{}", path.display())))?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(".tmp");
    let tmp = dir.join(tmp_name);

    if let Err(err) = write_all_synced(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }

    if let Err(err) = fs::rename(&tmp, path) {
        // rename 失败要清掉临时文件，否则用户目录里会残留 settings.json.tmp
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }

    Ok(())
}

/// 把损坏的 `settings.json` 挪到 [`CORRUPT_BACKUP_NAME`]，失败只记日志。
///
/// 用 rename 而不是 copy：坏文件必须从原位置消失，否则下次启动又会走一遍
/// 「解析失败 → 备份 → 重建」，日志里全是噪音。
fn archive_corrupt_settings(path: &Path) {
    let Some(dir) = path.parent() else {
        return;
    };
    let backup = dir.join(CORRUPT_BACKUP_NAME);
    match fs::rename(path, &backup) {
        Ok(()) => tracing::warn!(backup = %backup.display(), "已备份损坏的 settings.json"),
        Err(err) => tracing::warn!(%err, path = %path.display(), "备份损坏的 settings.json 失败"),
    }
}

/// 解析 `settings.json` 字节流：剥 BOM → serde。
///
/// 缺字段由 `#[serde(default)]` 兜底（旧版本升级不会丢配置）；
/// 多余字段（新版本降级回来）被忽略而不是报错。
fn parse_settings(raw: &[u8]) -> Result<Settings, serde_json::Error> {
    let body = raw.strip_prefix(&UTF8_BOM[..]).unwrap_or(raw);
    serde_json::from_slice(body)
}

/// 同步版读取，供启动流程（窗口几何恢复，DG 6.2）在 `setup` 阶段直接调用。
///
/// **永不失败**：任何异常（`%APPDATA%` 缺失、文件损坏、无权限）都回落默认值，
/// 因为「配置读不出来」不该演变成「应用打不开」。
pub fn load_settings_sync() -> Settings {
    let path = match settings_path() {
        Ok(path) => path,
        Err(err) => {
            tracing::warn!(%err, "无法定位 settings.json，回落默认配置");
            return Settings::default();
        }
    };

    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // 首启的正常路径，不是错误
            tracing::info!(path = %path.display(), "settings.json 不存在，使用默认配置");
            return Settings::default();
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), %err, "settings.json 读取失败，回落默认配置");
            return Settings::default();
        }
    };

    match parse_settings(&raw) {
        Ok(mut settings) => {
            settings.sanitize();
            settings
        }
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                %err,
                "settings.json 解析失败，备份后重建默认配置"
            );
            archive_corrupt_settings(&path);
            let fallback = Settings::default();
            if let Err(err) = save_settings_sync(&fallback) {
                // 重建失败不影响本次运行，内存里用默认值即可
                tracing::warn!(%err, "重建默认 settings.json 失败");
            }
            fallback
        }
    }
}

/// 同步版写入，供启动/退出流程（窗口几何持久化）直接调用。
pub fn save_settings_sync(settings: &Settings) -> AppResult<()> {
    let mut normalized = settings.clone();
    normalized.sanitize();

    let path = settings_path()?;
    let json = serde_json::to_vec_pretty(&normalized)?;
    write_atomic(&path, &json)?;
    tracing::debug!(path = %path.display(), bytes = json.len(), "settings.json 已写入");
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 读取配置；文件不存在返回 [`Settings::default`]，损坏则备份后重建（不要直接报错吓用户）。
#[tauri::command]
pub async fn load_settings() -> AppResult<Settings> {
    Ok(load_settings_sync())
}

/// 写入配置。写入需防抖（前端侧节流，后端保证原子写：临时文件 + rename）。
#[tauri::command]
pub async fn save_settings(settings: Settings) -> AppResult<()> {
    save_settings_sync(&settings)
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
// asset 协议目录授权（DG 8「查看态本地图片」= convertFileSrc + 动态 scope）
// ---------------------------------------------------------------------------

/// 把「刚打开的文档所在目录」加入 asset 协议白名单，让 `<img src="asset://...">` 能读到图片。
///
/// # 为什么需要运行时授权
///
/// `tauri.conf.json > app.security.assetProtocol.scope` 只能写静态 glob，
/// 但用户的 .md 可能在任意盘符（`D:\笔记\`）或 UNC 共享（`\\server\share\`）上，
/// 静态 scope 覆盖不到，又不能写成 `["**"]` 全盘放行。
/// M1 的配置 scope 只覆盖用户 profile 下的常用文档目录（Desktop/Documents/…），
/// 其余位置靠本函数在打开文档时按需追加一条。
///
/// **M2 收敛计划**：配置里的 `$HOME/**` 整条删掉，只保留 `deny`，
/// 全部授权改为本函数按打开的单个目录下发（授权集合随进程生命周期存在，不落盘）。
///
/// # 安全边界
///
/// * 只授权目录，不授权整盘：当 `dir` 是盘符根或 UNC 根（`parent()` 为 `None`）时
///   降级为非递归（只放行该目录直属文件），避免 `D:\a.md` 把整个 D 盘放行。
/// * 配置里的 `deny` 优先级高于任何 allow（Tauri 的 `Scope::is_allowed` 先查 forbidden），
///   所以凭据目录即使被本函数授权也依然读不到。
///
/// # 调用点
///
/// 在 `files::read_markdown` 成功解码后调用一次：
/// `crate::settings::allow_asset_dir(&app, parent_dir)?;`
/// （`read_markdown` 加 `app: AppHandle` 形参不影响前端契约——`AppHandle`
/// 由 Tauri 自动注入，前端仍然只传 `{ path }`。）
pub fn allow_asset_dir<R: tauri::Runtime, M: Manager<R>>(manager: &M, dir: &Path) -> AppResult<()> {
    let recursive = dir.parent().is_some();
    manager
        .asset_protocol_scope()
        .allow_directory(dir, recursive)?;
    tracing::debug!(dir = %dir.display(), recursive, "asset 协议：已授权目录");
    Ok(())
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

    /// 手改过的越界值必须被钳回区间，而不是原样带进 UI。
    #[test]
    fn sanitize_clamps_out_of_range_values() {
        let mut settings = Settings {
            font_size: 999,
            zoom_percent: 1,
            sidebar_width: 10_000,
            ..Settings::default()
        };
        settings.window.width = 10;
        settings.window.height = 0;

        settings.sanitize();

        assert_eq!(settings.font_size, FONT_SIZE_MAX);
        assert_eq!(settings.zoom_percent, ZOOM_MIN);
        assert_eq!(settings.sidebar_width, SIDEBAR_WIDTH_MAX);
        assert_eq!(settings.window.width, WINDOW_MIN_WIDTH);
        assert_eq!(settings.window.height, WINDOW_MIN_HEIGHT);
    }

    /// 缺字段走 serde default，多余字段忽略——升级/降级都不该炸。
    #[test]
    fn parses_partial_and_unknown_fields() {
        let raw = br#"{ "theme": "dark", "legacyOption": 42 }"#;
        let settings = parse_settings(raw).expect("缺字段/多字段都应能解析");
        assert_eq!(settings.theme, ThemeMode::Dark);
        assert_eq!(settings.font_size, Settings::default().font_size);
    }

    /// 记事本另存为会加 BOM，不剥掉 serde_json 会直接报错。
    #[test]
    fn parses_file_with_utf8_bom() {
        let mut raw = UTF8_BOM.to_vec();
        raw.extend_from_slice(br#"{ "zoomPercent": 120 }"#);
        let settings = parse_settings(&raw).expect("带 BOM 的配置也要能解析");
        assert_eq!(settings.zoom_percent, 120);
    }

    /// 原子写：能覆盖已有文件，且不留下 `.tmp` 残渣。
    #[test]
    fn write_atomic_replaces_existing_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!(
            "mdnaonao-settings-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let target = dir.join("settings.json");

        write_atomic(&target, b"old").expect("首次写入应成功");
        assert_eq!(fs::read(&target).expect("应能读回"), b"old");

        write_atomic(&target, b"new-and-longer").expect("覆盖写入应成功");
        assert_eq!(fs::read(&target).expect("应能读回"), b"new-and-longer");
        assert!(
            !dir.join("settings.json.tmp").exists(),
            "临时文件必须已被 rename 消耗掉"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
