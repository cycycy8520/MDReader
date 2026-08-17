//! DG 7.1 `settings.rs` 职责：配置读写；飞书密钥 DPAPI 加密。
//!
//! 存储位置（DG 7.3）：`%APPDATA%\MDNaonao\`
//! * `settings.json` —— 主题、字号、缩放、导出偏好、代码折行、frontmatter 显示、
//!   大纲钉住态、左栏宽度/折叠、窗口几何；字段契约见 [`Settings`]；
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

use serde::{Deserialize, Deserializer, Serialize};
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

/// frontmatter 属性区的显示方式（FR-14 三态）。
///
/// 取代旧的 `show_metadata: bool`——布尔只能表达「显示/隐藏」，而 FR-14 要的是
/// 卡片 / 隐藏 / 原样代码块三态。旧配置的迁移由前端 `stores/settings.ts`
/// 的 `migrateSettings` 承担（`showMetadata:true→card`、`false→hidden`），
/// 后端只认新字段：读到旧文件时本字段走 serde default（`card`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FrontmatterDisplay {
    /// 渲染为属性卡片（默认）
    #[default]
    Card,
    /// 整块隐藏
    Hidden,
    /// 原样显示为代码块
    Raw,
}

/// 窗口几何，用于重启还原（DG 6.2「窗口记忆」）。
///
/// `x`/`y` 是 `Option`：`null` = **尚无记录**（首启）或坐标被判废（显示器被拔掉），
/// 由启动逻辑回落主屏居中。用 `0,0` 当哨兵是不行的——那本身就是一个合法坐标。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowGeometry {
    #[serde(deserialize_with = "deserialize_coordinate")]
    pub x: Option<i32>,
    #[serde(deserialize_with = "deserialize_coordinate")]
    pub y: Option<i32>,
    #[serde(deserialize_with = "deserialize_dimension")]
    pub width: u32,
    #[serde(deserialize_with = "deserialize_dimension")]
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: 1200,
            height: 800,
            maximized: false,
        }
    }
}

/// 窗口宽高的宽松反序列化。
///
/// 为什么不直接用 `u32`：`settings.json` 是用户可手改的文本，一旦出现
/// `"width": -1` 或 `"width": 800.5`，`u32` 会让**整个** Settings 解析失败 →
/// 走备份重建 → 用户所有偏好归零。这里统一收成 `f64` 再判：负数/0/NaN 一律
/// 归 0，由 [`Settings::sanitize`] 换成默认尺寸；超大值先夹到上限。
fn deserialize_dimension<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = f64::deserialize(deserializer)?;
    if !raw.is_finite() || raw < 1.0 {
        // 0 是「非法尺寸」哨兵，sanitize 会把它换成默认值
        return Ok(0);
    }
    Ok(raw.min(f64::from(WINDOW_MAX_EDGE)) as u32)
}

/// 窗口坐标的宽松反序列化：`null` / 非有限值 / 离谱到不可能是屏幕坐标的值
/// 一律回落 `None`（= 无记录，启动时居中）。坐标可以为负（副屏在主屏左侧）。
fn deserialize_coordinate<'de, D>(deserializer: D) -> Result<Option<i32>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Option::<f64>::deserialize(deserializer)?;
    Ok(raw
        .filter(|value| value.is_finite() && value.abs() <= f64::from(WINDOW_MAX_EDGE))
        .map(|value| value as i32))
}

/// `settings.json` 结构 —— **前后端唯一契约**（2026-08-18 批次 1.3）。
///
/// 序列化后的 10 个 key 必须与 TS `types/Settings`、`stores/settings.ts` 逐字相同，
/// wire 格式一律 camelCase（`font_size` → `fontSize`）。少一个字段的后果不是报错，
/// 而是**静默丢失**：前端不发的字段被 `#[serde(default)]` 填成默认值再原样写回盘，
/// 等于把用户的设置反向覆写。这条契约由下方 `serialized_keys_match_contract` 单测
/// 机器把关（多一个 / 少一个 / 改名都会红）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: ThemeMode,
    /// 正文字号（px，范围 14–20，DG 5.4 基准 16）
    pub font_size: u16,
    /// 缩放百分比，范围 90–150（DG 5.2 状态栏）
    pub zoom_percent: u16,
    /// 代码块折行（关=横向滚动，DG 5.4）
    pub code_wrap: bool,
    /// frontmatter 显示方式（FR-14 三态）
    pub frontmatter_display: FrontmatterDisplay,
    /// 大纲钉住态（FR-04）
    pub outline_pinned: bool,
    /// 左栏宽度，范围 264–420（DG 5.2 / UPGRADE_PLAN 4.3 统一后的区间）
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
            font_size: FONT_SIZE_DEFAULT,
            zoom_percent: ZOOM_DEFAULT,
            code_wrap: false,
            frontmatter_display: FrontmatterDisplay::Card,
            outline_pinned: false,
            sidebar_width: SIDEBAR_WIDTH_DEFAULT,
            sidebar_collapsed: false,
            html_export_mode: HtmlExportMode::SingleFile,
            window: WindowGeometry::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// 合法区间（与前端 stores/settings.ts、stores/uiState.ts 的常量必须一一对应）
// ---------------------------------------------------------------------------

/// 正文字号档位下限（前端 `FONT_SIZE_MIN`，DG 6.7）
const FONT_SIZE_MIN: u16 = 14;
/// 正文字号档位上限（前端 `FONT_SIZE_MAX`，DG 6.7）
const FONT_SIZE_MAX: u16 = 20;
/// 正文字号默认值（前端 `FONT_SIZE_DEFAULT`，DG 5.4）
const FONT_SIZE_DEFAULT: u16 = 16;
/// 缩放下限（前端 `ZOOM_MIN`，DG 5.2）
const ZOOM_MIN: u16 = 90;
/// 缩放上限（前端 `ZOOM_MAX`，DG 5.2）
const ZOOM_MAX: u16 = 150;
/// 缩放默认值（前端 `ZOOM_DEFAULT`）
const ZOOM_DEFAULT: u16 = 100;
/// 左栏宽度下限（前端 `SIDEBAR_WIDTH_MIN`）。
///
/// 2026-08-18：此前 Rust(200–360) / uiState(200–360) / tokens.css(264–420) 三处打架，
/// 按 UPGRADE_PLAN 4.3 与批次 1 全局契约统一为 264–420、默认 280（= tokens.css 基准）。
const SIDEBAR_WIDTH_MIN: u32 = 264;
/// 左栏宽度上限（前端 `SIDEBAR_WIDTH_MAX`）
const SIDEBAR_WIDTH_MAX: u32 = 420;
/// 左栏宽度默认值（前端 `SIDEBAR_WIDTH_DEFAULT`）
const SIDEBAR_WIDTH_DEFAULT: u32 = 280;
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

        // 窗口几何：0（含反序列化时判废的负数/NaN）意味着「这不是一组可用的尺寸」，
        // 回落**默认值**而不是最小值——把窗口开成 800×600 的最小尺寸不像还原，像出故障。
        let defaults = WindowGeometry::default();
        if self.window.width == 0 {
            self.window.width = defaults.width;
        }
        if self.window.height == 0 {
            self.window.height = defaults.height;
        }
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
    use std::collections::BTreeSet;

    use super::*;

    /// 契约 A（2026-08-18 批次 1.3）：`settings.json` / IPC 载荷的 **全部** 顶层 key。
    /// 与 TS `types/index.ts` 的 `SETTINGS_KEY_MAP`、`stores/settings.ts` 的
    /// `DEFAULT_SETTINGS` 一一对应。改这里等于改前后端契约，必须三处同改。
    const CONTRACT_KEYS: [&str; 10] = [
        "theme",
        "fontSize",
        "zoomPercent",
        "codeWrap",
        "frontmatterDisplay",
        "outlinePinned",
        "sidebarWidth",
        "sidebarCollapsed",
        "htmlExportMode",
        "window",
    ];

    /// `window` 子对象的 key 全集（TS `WindowGeometry`）。
    const CONTRACT_WINDOW_KEYS: [&str; 5] = ["x", "y", "width", "height", "maximized"];

    /// 默认值必须与 DG 5.2 / 5.4 的基准一致。
    #[test]
    fn default_settings_match_spec() {
        let settings = Settings::default();
        assert_eq!(settings.font_size, 16);
        assert_eq!(settings.zoom_percent, 100);
        assert_eq!(settings.sidebar_width, 280);
        assert_eq!(settings.theme, ThemeMode::System);
        assert_eq!(settings.frontmatter_display, FrontmatterDisplay::Card);
        assert_eq!(settings.window.x, None);
        assert_eq!(settings.window.y, None);
    }

    /// **契约闸门**：序列化后的 key 集合必须与 [`CONTRACT_KEYS`] 恰好相等。
    ///
    /// 多一个（后端偷偷加字段，前端 save 时不带 → 被覆写成默认值）、
    /// 少一个（前端存了、后端不认 → 保存即丢）、改名（同上）——三种漂移全部在此拦下。
    /// 这是批次 1.3 那个 blocker 的机器闸门，别把它改成「包含」断言。
    #[test]
    fn serialized_keys_match_contract() {
        let json = serde_json::to_value(Settings::default()).expect("序列化不应失败");
        let object = json.as_object().expect("Settings 应序列化为 JSON 对象");

        let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
        let expected: BTreeSet<&str> = CONTRACT_KEYS.into_iter().collect();
        assert_eq!(
            actual, expected,
            "settings 字段契约漂移：Rust 侧的 key 集合与契约 A 不一致（TS 侧 types/Settings 也要同步）"
        );

        let window = object["window"]
            .as_object()
            .expect("window 应序列化为 JSON 对象");
        let actual_window: BTreeSet<&str> = window.keys().map(String::as_str).collect();
        let expected_window: BTreeSet<&str> = CONTRACT_WINDOW_KEYS.into_iter().collect();
        assert_eq!(actual_window, expected_window, "window 子对象字段契约漂移");
    }

    /// 枚举的 wire 取值也是契约的一部分（TS 侧是字面量联合类型，拼错即类型不匹配）。
    #[test]
    fn enum_wire_values_match_contract() {
        let json = serde_json::to_value(Settings::default()).expect("序列化不应失败");
        assert_eq!(json["theme"], "system");
        assert_eq!(json["frontmatterDisplay"], "card");
        assert_eq!(json["htmlExportMode"], "single-file");
        assert!(json["window"]["x"].is_null(), "无记录的坐标必须是 null");

        for (value, wire) in [
            (FrontmatterDisplay::Card, "card"),
            (FrontmatterDisplay::Hidden, "hidden"),
            (FrontmatterDisplay::Raw, "raw"),
        ] {
            assert_eq!(
                serde_json::to_value(value).expect("序列化不应失败"),
                serde_json::Value::from(wire)
            );
        }
        assert_eq!(
            serde_json::to_value(HtmlExportMode::WithAssets).expect("序列化不应失败"),
            serde_json::Value::from("with-assets")
        );
        for (value, wire) in [(ThemeMode::Light, "light"), (ThemeMode::Dark, "dark")] {
            assert_eq!(
                serde_json::to_value(value).expect("序列化不应失败"),
                serde_json::Value::from(wire)
            );
        }
    }

    /// 前端发来的完整载荷必须原样解析回来（保存 → 重启 → 全部保留）。
    #[test]
    fn round_trips_full_payload_from_frontend() {
        let raw = br#"{
            "theme": "dark",
            "fontSize": 18,
            "zoomPercent": 125,
            "codeWrap": true,
            "frontmatterDisplay": "raw",
            "outlinePinned": true,
            "sidebarWidth": 320,
            "sidebarCollapsed": true,
            "htmlExportMode": "with-assets",
            "window": { "x": -1280, "y": 40, "width": 1600, "height": 900, "maximized": true }
        }"#;
        let mut settings = parse_settings(raw).expect("完整载荷必须能解析");
        settings.sanitize();

        assert_eq!(settings.theme, ThemeMode::Dark);
        assert_eq!(settings.font_size, 18);
        assert_eq!(settings.zoom_percent, 125);
        assert!(settings.code_wrap);
        assert_eq!(settings.frontmatter_display, FrontmatterDisplay::Raw);
        assert!(settings.outline_pinned);
        assert_eq!(settings.sidebar_width, 320);
        assert!(settings.sidebar_collapsed);
        assert_eq!(settings.html_export_mode, HtmlExportMode::WithAssets);
        assert_eq!(settings.window.x, Some(-1280));
        assert_eq!(settings.window.width, 1600);
        assert!(settings.window.maximized);

        // 再走一圈序列化 → 反序列化，值不能被路上改掉
        let json = serde_json::to_vec(&settings).expect("序列化不应失败");
        assert_eq!(parse_settings(&json).expect("回环解析应成功"), settings);
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
        settings.window.height = 900;

        settings.sanitize();

        assert_eq!(settings.font_size, FONT_SIZE_MAX);
        assert_eq!(settings.zoom_percent, ZOOM_MIN);
        assert_eq!(settings.sidebar_width, SIDEBAR_WIDTH_MAX);
        assert_eq!(settings.window.width, WINDOW_MIN_WIDTH);
        assert_eq!(settings.window.height, 900, "区间内的高度不应被动");
    }

    /// 窗口宽高为 0 / 负数 / 非有限值：整份配置不许因此解析失败，几何回落默认。
    #[test]
    fn window_geometry_falls_back_to_defaults_on_bogus_size() {
        let defaults = WindowGeometry::default();

        let mut zeroed = parse_settings(br#"{ "window": { "width": 0, "height": 0 } }"#)
            .expect("宽高为 0 也要能解析");
        zeroed.sanitize();
        assert_eq!(zeroed.window.width, defaults.width);
        assert_eq!(zeroed.window.height, defaults.height);

        let mut negative = parse_settings(br#"{ "window": { "width": -1, "height": -900.5 } }"#)
            .expect("负数宽高不许让整份配置解析失败");
        negative.sanitize();
        assert_eq!(negative.window.width, defaults.width);
        assert_eq!(negative.window.height, defaults.height);

        let mut huge = parse_settings(br#"{ "window": { "width": 9e99, "height": 1e12 } }"#)
            .expect("超大宽高同样不该炸");
        huge.sanitize();
        assert_eq!(huge.window.width, WINDOW_MAX_EDGE);
        assert_eq!(huge.window.height, WINDOW_MAX_EDGE);
    }

    /// 坐标：null / 缺失 / 离谱值都退化为「无记录」，交启动逻辑居中。
    #[test]
    fn window_coordinates_degrade_to_none() {
        let explicit_null =
            parse_settings(br#"{ "window": { "x": null, "y": 12 } }"#).expect("null 坐标应能解析");
        assert_eq!(explicit_null.window.x, None);
        assert_eq!(explicit_null.window.y, Some(12));

        let absurd = parse_settings(br#"{ "window": { "x": 999999999, "y": -999999999 } }"#)
            .expect("离谱坐标应能解析");
        assert_eq!(absurd.window.x, None);
        assert_eq!(absurd.window.y, None);
    }

    /// 旧版本写下的 `showMetadata` 已被移除：读到只当未知字段忽略，
    /// frontmatterDisplay 走默认值（真正的值迁移在前端 migrateSettings 里做）。
    #[test]
    fn ignores_legacy_show_metadata_field() {
        let settings = parse_settings(br#"{ "showMetadata": false }"#).expect("旧字段应被忽略");
        assert_eq!(settings.frontmatter_display, FrontmatterDisplay::Card);
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
