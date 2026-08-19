//! DG 7.1 `settings.rs` 职责：配置读写；飞书密钥 DPAPI 加密。
//!
//! 存储位置（DG 7.3 + UPGRADE_PLAN 2.0「便携版 F19」）：数据根目录有两种形态，
//! 由「exe 同级是否存在 `portable.marker`」决定，**整个进程只探测一次**：
//!
//! | 模式 | 判据 | 数据根 |
//! |---|---|---|
//! | 安装版（默认） | 无 marker | `%APPDATA%\MDNaonao\` |
//! | 便携版 | exe 同级有 `portable.marker` | `<exe 所在目录>\data\` |
//!
//! 两种模式**共用同一份 exe**（不做两套构建），根目录之下的结构完全相同：
//! * `settings.json` —— 主题、字号、缩放、正文列宽、导出偏好、代码折行、
//!   frontmatter 显示、大纲钉住态、左栏宽度/折叠、窗口几何；字段契约见 [`Settings`]；
//! * `lark-token.json` —— 飞书 app_id / app_secret / token 缓存，
//!   **必须 Windows DPAPI 加密后落盘**，不得明文（格式见 [`LarkCredentialEnvelope`]）。
//!   便携版有一条必须如实告知用户的后果：**DPAPI 密文绑定当前 Windows 用户**，
//!   所以便携目录拷到别的电脑（或换个账号登录）之后，飞书凭据一定解不开、
//!   需要重新填一次 —— 其余配置照常跟着走。这不是 bug，是「凭据不该能被拷走」；
//! * `logs\` —— 见 [`crate::logging::log_dir`]（便携版日志同样落在便携目录里，
//!   否则「解压即用、拷走即净」就不成立）。
//!
//! 便携版另有一条硬约束：**不碰注册表**（不注册文件关联、不写额外右键动词），
//! 闸门在 [`crate::shell_integ`]，判据就是本模块的 [`is_portable`]。
//!
//! 注意：这里刻意不使用 Tauri 的 `app_data_dir()`——它返回
//! `%APPDATA%\com.mdnaonao.app`，与 DG 7.3 规定的 `%APPDATA%\MDNaonao` 不一致；
//! 且 [`crate::logging::init`] 在 Tauri App 建立之前就要用到本目录。
//!
//! 另外本模块还收口 **asset 协议目录授权**（[`allow_asset_dir`]）——它是
//! `tauri.conf.json > app.security.assetProtocol.scope` 的运行时另一半，
//! 属于「权限接线」而非文件读写，故与配置一起放在这里，便于集中审查。

use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Deserializer, Serialize};
use tauri::Manager;

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// 数据根目录（安装版 / 便携版，UPGRADE_PLAN 2.0 = DG F19）
// ---------------------------------------------------------------------------

/// 便携标记文件名：放在 exe 同级即切换为便携模式。
/// 内容不做任何解析（空文件即可），存在性就是全部语义。
pub const PORTABLE_MARKER: &str = "portable.marker";

/// 便携模式下的数据子目录名：`<exe 目录>\data\`。
/// 不直接把 settings.json 摊在 exe 旁边——便携包解压出来要一眼能分清「程序」和「我的数据」。
const PORTABLE_DATA_DIR: &str = "data";

/// 安装模式下 `%APPDATA%` 之下的目录名（DG 7.3）。
const INSTALLED_DIR_NAME: &str = "MDNaonao";

/// 可写性探测用的临时文件名。用固定名而非随机名：探测失败时残留也只有这一个，
/// 且下次探测会直接覆盖它。
const WRITE_PROBE_NAME: &str = ".write-probe";

/// 数据根目录的两种形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataRootMode {
    /// `%APPDATA%\MDNaonao\`
    Installed,
    /// `<exe 目录>\data\`
    Portable,
}

impl DataRootMode {
    /// 日志与 IPC 用的稳定标识。
    pub fn as_str(self) -> &'static str {
        match self {
            DataRootMode::Installed => "installed",
            DataRootMode::Portable => "portable",
        }
    }
}

/// 探测结果：模式 + 绝对路径。
#[derive(Debug, Clone)]
struct DataRoot {
    mode: DataRootMode,
    path: PathBuf,
}

/// 探测结果缓存。
///
/// 为什么必须缓存：[`app_data_dir`] 在启动路径上被反复调用（日志初始化、settings 读写、
/// recent.json 读写），每次都去 `current_exe()` + `metadata()` 敲一次盘是纯浪费；
/// 更要命的是**中途结果翻转**——用户在运行期间删掉 marker，一半数据写进便携目录、
/// 另一半写进 `%APPDATA%`，比彻底不支持便携版还糟。一次探测定终身。
///
/// 存 `Result<_, String>` 而不是 `AppResult<_>`：[`AppError`] 不是 `Clone`，
/// 而 `OnceLock` 只能借出引用，错误分支需要每次调用都能造一个新的 [`AppError`]。
static DATA_ROOT: OnceLock<Result<DataRoot, String>> = OnceLock::new();

/// exe 同级有没有 marker —— 纯函数，便于单测（真实探测见 [`detect_portable_root`]）。
fn portable_root_for_exe_dir(exe_dir: &Path) -> Option<PathBuf> {
    // 必须是**文件**：同名目录（用户手滑 mkdir）不该把整个应用切进便携模式
    exe_dir
        .join(PORTABLE_MARKER)
        .is_file()
        .then(|| exe_dir.join(PORTABLE_DATA_DIR))
}

/// 取 exe 所在目录并探测 marker。取不到 exe 路径（极端权限场景）视为安装模式。
fn detect_portable_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    portable_root_for_exe_dir(exe.parent()?)
}

fn resolve_data_root() -> Result<DataRoot, String> {
    if let Some(path) = detect_portable_root() {
        return Ok(DataRoot {
            mode: DataRootMode::Portable,
            path,
        });
    }
    let base =
        std::env::var_os("APPDATA").ok_or_else(|| "未取到 %APPDATA% 环境变量".to_string())?;
    Ok(DataRoot {
        mode: DataRootMode::Installed,
        path: PathBuf::from(base).join(INSTALLED_DIR_NAME),
    })
}

fn data_root() -> AppResult<&'static DataRoot> {
    DATA_ROOT
        .get_or_init(resolve_data_root)
        .as_ref()
        .map_err(|message| AppError::config(message.clone()))
}

/// 用户数据根目录：便携版 `<exe 目录>\data\`，否则 `%APPDATA%\MDNaonao\`。
pub fn app_data_dir() -> AppResult<PathBuf> {
    Ok(data_root()?.path.clone())
}

/// 当前是否便携模式。探测失败一律按**安装模式**处理——
/// 宁可少走一次便携分支，也不能在不确定的情况下放行注册表写入。
pub fn is_portable() -> bool {
    data_root().is_ok_and(|root| root.mode == DataRootMode::Portable)
}

/// 启动日志：模式 + 数据根绝对路径。
///
/// 这一行是「我的设置去哪了 / 为什么设置没保留」的唯一自查入口：
/// 用户把便携包解压到两个位置、或安装版与便携版同机共存时，
/// 只要贴出这行日志就能立刻定位到底在读写哪个目录。
pub fn log_data_root() {
    match data_root() {
        Ok(root) => tracing::info!(
            mode = root.mode.as_str(),
            data_dir = %root.path.display(),
            "数据根目录已确定"
        ),
        Err(err) => tracing::error!(%err, "数据根目录解析失败，配置将无法持久化"),
    }
}

/// 确认数据根目录可创建且可写，不可写时给**明确**错误（绝不静默失败）。
///
/// 触发场景：便携包被解压进 `Program Files`（非管理员不可写）、放在只读 U 盘、
/// 或被公司策略锁定的目录。这些情况下每一次 `save_settings` 都会失败，
/// 用户看到的却是「设置改了但重启就没了」——必须在启动时就把话说清楚。
pub fn ensure_data_root_writable() -> AppResult<PathBuf> {
    let root = app_data_dir()?;
    fs::create_dir_all(&root).map_err(|err| unwritable_error(&root, &err))?;

    let probe = root.join(WRITE_PROBE_NAME);
    fs::write(&probe, b"mdnaonao").map_err(|err| unwritable_error(&root, &err))?;
    // 删不掉不算失败：能写就说明目录可用，残留的探测文件下次会被覆盖
    let _ = fs::remove_file(&probe);

    Ok(root)
}

/// 把底层 IO 错误翻译成「用户能照着做」的配置错误。
fn unwritable_error(root: &Path, err: &std::io::Error) -> AppError {
    let advice = if is_portable() {
        "便携版被放在了只读位置（Program Files / 只读 U 盘 / 受策略保护的目录），请把整个便携目录移到可写位置再运行"
    } else {
        "请检查该目录的访问权限，或确认 %APPDATA% 未被重定向到不可写位置"
    };
    AppError::config(format!(
        "数据目录不可写：{}（{err}）。{advice}",
        root.display()
    ))
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

/// 正文列宽三态（阅读区外层容器的 `data-reading-width`，样式在
/// `src/styles/markdown.css`「三、列宽三态」一节）。
///
/// 默认是 [`ReadingWidth::Fluid`]（正文宽度跟随窗口）而不是固定列宽：那是 MPE 的行为，
/// 也是用户点名要的默认——把窗口拉宽之后正文却仍旧钉在 748px，看起来像应用没响应。
/// 另外两档是**可选**的固定列宽：`medium` 沿用旧版的 748px（= tokens.css 的
/// `--md-reading-w`），`wide` 是 1000px，给宽屏上想要长行但又不要满屏的人。
///
/// 本枚举没有「像素值」这一层：三个档位的实际宽度全部由 CSS 决定，Rust 侧只存档位名。
/// 把 748/1000 写进后端等于让「改一个数字」变成前后端同改，得不偿失。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ReadingWidth {
    /// 跟随窗口宽度（默认，MPE 行为）
    #[default]
    Fluid,
    /// 适中：748px（旧版列宽）
    Medium,
    /// 宽：1000px
    Wide,
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

/// 左栏视图（F20 文件夹模式）：最近列表 / 文件夹树，互斥切换（DG 5.3.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SidebarView {
    Recent,
    Tree,
}

/// `settings.json` 结构 —— **前后端唯一契约**（2026-08-18 批次 1.3）。
///
/// 序列化后的**全部 key**（清单 = 下方单测的 `CONTRACT_KEYS`，那是唯一真相，
/// 这里刻意不写具体数字——写过一次「11 个」，加字段后成了过期谎言）必须与
/// TS `types/Settings`、`stores/settings.ts` 逐字相同，wire 格式一律 camelCase
/// （`font_size` → `fontSize`）。少一个字段的后果不是报错，
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
    /// 正文列宽三态（默认 fluid = 跟随窗口宽度）
    pub reading_width: ReadingWidth,
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
    /// 左栏当前视图（F20：recent=最近列表 / tree=文件夹树）
    pub sidebar_view: SidebarView,
    /// 已挂载的文件夹根（F20）；None = 未挂载。空串/纯空白按 None 处理（sanitize）
    pub folder_root: Option<String>,
    /// 树的展开目录集（绝对路径；上限 [`FOLDER_EXPANDED_LIMIT`]，防手改膨胀）
    pub folder_expanded: Vec<String>,
    /// 最近文件夹（新→旧；上限 [`RECENT_FOLDERS_LIMIT`]，与最近文件分开记，DG 5.3.1）
    pub recent_folders: Vec<String>,
    pub window: WindowGeometry,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            font_size: FONT_SIZE_DEFAULT,
            zoom_percent: ZOOM_DEFAULT,
            reading_width: ReadingWidth::Fluid,
            code_wrap: false,
            frontmatter_display: FrontmatterDisplay::Card,
            outline_pinned: false,
            sidebar_width: SIDEBAR_WIDTH_DEFAULT,
            sidebar_collapsed: false,
            html_export_mode: HtmlExportMode::SingleFile,
            sidebar_view: SidebarView::Recent,
            folder_root: None,
            folder_expanded: Vec::new(),
            recent_folders: Vec::new(),
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
/// 最近文件夹上限（前端 `RECENT_FOLDERS_LIMIT`，DG 5.3.1；参照 Losansky 先例取 12）
const RECENT_FOLDERS_LIMIT: usize = 12;
/// 展开目录集上限：纯脏数据防御（正常使用到不了三位数，手改/损坏才会）
const FOLDER_EXPANDED_LIMIT: usize = 512;
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

        // F20 不变式：空串根 = 未挂载；未挂载时展开集无意义、树视图不可进——
        // 三个字段在这里收敛成一致状态，前端便可以无脑信任读到的组合。
        if self
            .folder_root
            .as_deref()
            .is_some_and(|root| root.trim().is_empty())
        {
            self.folder_root = None;
        }
        if self.folder_root.is_none() {
            self.folder_expanded.clear();
            self.sidebar_view = SidebarView::Recent;
        }
        // 展开集是「追加在尾」的（folderTree.setExpanded），淘汰必须**弃头保尾**：
        // truncate 会把最新展开的那一条丢掉，攒满上限后目录就永远点不开（复审确认项）。
        if self.folder_expanded.len() > FOLDER_EXPANDED_LIMIT {
            let excess = self.folder_expanded.len() - FOLDER_EXPANDED_LIMIT;
            self.folder_expanded.drain(..excess);
        }
        // 最近文件夹是「新的插头」的，truncate（保头弃尾）正是想要的方向
        self.recent_folders.truncate(RECENT_FOLDERS_LIMIT);
    }
}

/// 飞书进阶通道凭据（DG 8「飞书分享（双通道）」）。
/// **明文只在内存中存在**，落盘前必须经 [`dpapi_protect`]。
///
/// `#[serde(default)]` 的用途：设置页只会传 `{ appId, appSecret }` 两个字段——
/// token 缓存是后端自己维护的，前端既拿不到也不该拿。缺字段直接走默认值，
/// 而不是让整个 `save_lark_credential` 因为「少了 tenantAccessToken」而报错。
///
/// **这个结构体永远不会被整体回传给前端**（回传的是 [`LarkCredentialStatus`]）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LarkCredential {
    pub app_id: String,
    pub app_secret: String,
    /// tenant_access_token 缓存及其过期时间戳（秒）
    pub tenant_access_token: Option<String>,
    pub expires_at: Option<i64>,
}

/// 凭据的**对外可见状态**：设置页据此渲染「已配置 / 未配置」。
///
/// 里面刻意**不含** `app_secret` 与 token —— 密文一旦解出来送进 WebView，
/// 就等于把它暴露给整条前端链路（DevTools、错误上报、任何一处 `console.log`），
/// 再也收不回来。前端需要的信息只有三条：配没配、配的是哪个应用、要不要重测连接。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LarkCredentialStatus {
    /// 是否已存在**可解密**的凭据（文件在但解不开 = 未配置，见 [`load_lark_credential_sync`]）
    pub configured: bool,
    /// 掩码后的 app_id（形如 `cli_***`），仅供用户确认「填的是哪个应用」
    pub app_id_masked: Option<String>,
    /// 是否已有未过期的 token 缓存（用户据此判断还要不要重跑「测试连接」）
    pub has_cached_token: bool,
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
    write_atomic(&path, &json).map_err(|err| explain_save_failure(&path, err))?;
    tracing::debug!(path = %path.display(), bytes = json.len(), "settings.json 已写入");
    Ok(())
}

/// 写盘失败时把「权限类」错误升级成带处置建议的配置错误。
///
/// 便携版放进 `Program Files` 时，用户看到的原始错误是「拒绝访问。(os error 5)」——
/// 这句话对用户毫无信息量。其余错误（磁盘满、路径过长）原样透传，不做无根据的猜测。
fn explain_save_failure(path: &Path, err: AppError) -> AppError {
    // ERROR_ACCESS_DENIED(5) / ERROR_WRITE_PROTECT(19)：只读介质在部分路径上
    // 不会被 std 映射成 PermissionDenied，补一道原始错误码判断
    let is_permission = matches!(
        &err,
        AppError::Io(io)
            if io.kind() == std::io::ErrorKind::PermissionDenied
                || matches!(io.raw_os_error(), Some(5) | Some(19))
    );
    if !is_permission {
        return err;
    }
    let dir = path.parent().unwrap_or(path);
    let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, err.to_string());
    unwritable_error(dir, &io)
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

/// 「关于」对话框需要的应用元信息（UPGRADE_PLAN 附录 A.1「关于 MDNaonao」）。
///
/// 三个字段都是前端拿不到的：版本号只存在于 `Cargo.toml`（前端 package.json 是另一份，
/// 会漂）；便携标志与数据根目录只有后端探测得出。字段名即前后端契约（camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// `CARGO_PKG_VERSION`，与安装包版本同源
    pub version: String,
    /// 是否便携模式（关于框据此显示模式徽标）
    pub portable: bool,
    /// 数据根目录绝对路径（用户排查「我的设置去哪了」）
    pub data_dir: String,
}

/// 读取应用元信息（版本 / 便携标志 / 数据根目录）。
#[tauri::command]
pub async fn app_info() -> AppResult<AppInfo> {
    let root = data_root()?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        portable: root.mode == DataRootMode::Portable,
        data_dir: root.path.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// 飞书凭据（DPAPI 密文落盘，M3 / DG 8「飞书分享（双通道）」）
// ---------------------------------------------------------------------------

/// `lark-token.json` 的信封版本。
///
/// 存版本号是为了让「换加密方案 / 换 entropy」有一条不需要用户自己删文件的退路：
/// 读到不认识的版本就当没配过（走重新配置流程），而不是抛一个用户看不懂的解析错误。
const LARK_ENVELOPE_VERSION: u8 = 1;

/// 解不开的凭据文件的归档名（与 [`CORRUPT_BACKUP_NAME`] 同一套思路：不删用户数据，
/// 但必须让它从原位置消失，否则每次启动都要重走一遍「解密失败」）。
const LARK_UNREADABLE_BACKUP_NAME: &str = "lark-token.unreadable.json";

/// DPAPI 的可选 entropy（第二因子）。
///
/// 作用：DPAPI 的默认作用域是「当前 Windows 用户」——同一账号下**任何**进程都能解开
/// 我们的密文。补一段应用私有的 entropy 后，别的程序还得先知道这串常量才行。
/// 这不是强安全边界（常量就在二进制里），但把「随手一读」抬高到「得先逆向」是值得的。
///
/// **改动它 = 让所有已保存的凭据立刻失效**（解密会失败 → 走重新配置流程）。
/// 真要改，请同时把 [`LARK_ENVELOPE_VERSION`] 加一，好在日志里分得清是哪种失败。
const DPAPI_ENTROPY: &[u8] = b"MDNaonao/lark-credential/v1";

/// `lark-token.json` 的磁盘结构。
///
/// 为什么套一层 JSON 而不是直接写裸的 DPAPI 二进制：文件名是 `.json`（DG 7.3 定的），
/// 写二进制进去会让任何一个想 `type lark-token.json` 排查问题的人先懵一下；
/// 而 JSON 信封既保住了后缀的诚实，又能带上版本号。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LarkCredentialEnvelope {
    version: u8,
    /// DPAPI 密文的十六进制串。
    ///
    /// 用 hex 而不是 base64：密文只有几百字节，hex 多出来的一倍体积无关紧要，
    /// 换来的是编解码逻辑短到一眼能看完（base64 的填充分支是本项目已经踩过的地方）。
    /// 附带好处：DPAPI blob 固定以 `01000000d08c9ddf...` 开头，肉眼即可确认
    /// 「这确实是一份 DPAPI 密文」而不是别的什么东西。
    dpapi: String,
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // write! 到 String 不会失败，但 fmt::Write 要求处理 Result；用查表避免整段 unwrap
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    if bytes.len() % 2 != 0 {
        return Err(format!("十六进制串长度为奇数：{}", bytes.len()));
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = hex_value(pair[0])?;
        let lo = hex_value(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(format!("非十六进制字符：0x{byte:02x}")),
    }
}

/// 把敏感串打码后再进日志 / 进前端。
///
/// 只留前 4 个**字符**（不是字节——app_id 是 ASCII，但这函数将来也可能喂进别的东西，
/// 按字节切会在多字节字符中间切断，产出一个非法 UTF-8 的分片）。
fn mask_secret(value: &str) -> String {
    if value.chars().count() <= 4 {
        // 太短的值连前缀都算泄露（比如空串会打出 `***`，正好也表达了「里面没东西」）
        return "***".to_string();
    }
    let head: String = value.chars().take(4).collect();
    format!("{head}***")
}

/// 把内存里的明文缓冲区抹零。
///
/// `Vec` 的 `Drop` 只归还内存、不清内容，序列化出来的明文 secret 会在堆上留一份残影，
/// 直到那块内存被别的东西覆盖为止（进程崩溃转储、休眠文件都可能把它带出去）。
/// 用 `write_volatile` 逐字节写：普通赋值会被优化器判定为「写了之后没人读」而整段删掉。
fn zeroize(buffer: &mut [u8]) {
    for slot in buffer.iter_mut() {
        // SAFETY：指针来自当前可变借用的切片元素，必然对齐且可写，写入的是 POD 类型。
        unsafe { std::ptr::write_volatile(slot, 0) };
    }
}

/// 写入飞书凭据（明文 → DPAPI → hex → 原子写）。
///
/// **每次保存都会丢弃已有的 token 缓存**：调用点只有「用户改了 app_id/app_secret」
/// 这一种，而换了应用之后旧的 tenant_access_token 必然作废——留着它只会让下一次
/// 导入拿一个必定 401 的 token 去撞一次墙。缓存由 [`store_lark_token`] 单独维护。
pub fn save_lark_credential_sync(credential: &LarkCredential) -> AppResult<()> {
    if credential.app_id.trim().is_empty() || credential.app_secret.trim().is_empty() {
        return Err(AppError::config(
            "飞书 app_id / app_secret 不能为空（请在开放平台的凭证与基础信息页复制）".to_string(),
        ));
    }

    let stored = LarkCredential {
        app_id: credential.app_id.trim().to_string(),
        app_secret: credential.app_secret.trim().to_string(),
        tenant_access_token: None,
        expires_at: None,
    };
    write_lark_credential(&stored)?;
    tracing::info!(
        app_id = %mask_secret(&stored.app_id),
        "飞书凭据已保存（DPAPI 密文），token 缓存已重置"
    );
    Ok(())
}

/// 真正落盘的那一层，不做校验也不写日志（[`store_lark_token`] 刷新缓存时复用）。
fn write_lark_credential(credential: &LarkCredential) -> AppResult<()> {
    let mut plain = serde_json::to_vec(credential)?;
    let cipher = dpapi_protect(&plain);
    // 无论加密成功与否，明文缓冲区都要立刻抹掉
    zeroize(&mut plain);
    let cipher = cipher?;

    let envelope = LarkCredentialEnvelope {
        version: LARK_ENVELOPE_VERSION,
        dpapi: to_hex(&cipher),
    };
    let json = serde_json::to_vec_pretty(&envelope)?;
    let path = lark_credential_path()?;
    write_atomic(&path, &json).map_err(|err| explain_save_failure(&path, err))
}

/// 读取飞书凭据。**永不把失败抛给用户**——读不出来一律等价于「没配过」。
///
/// 三种「等于没配过」的情况：
/// * 文件不存在（首次使用）；
/// * 信封版本不认识（降级回旧版本运行）；
/// * DPAPI 解密失败 —— 换机、换 Windows 用户、把便携目录拷到别的电脑上，
///   都会必然走到这里。DPAPI 密文绑定当前用户，这是设计使然而不是 bug。
///
/// 后两种情况会把坏文件归档成 [`LARK_UNREADABLE_BACKUP_NAME`]，
/// 免得每次启动都重走一遍失败路径（也给用户留一份「原来这里有东西」的痕迹）。
pub fn load_lark_credential_sync() -> AppResult<Option<LarkCredential>> {
    let path = lark_credential_path()?;
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            tracing::warn!(path = %path.display(), %err, "飞书凭据读取失败，按未配置处理");
            return Ok(None);
        }
    };

    let body = raw.strip_prefix(&UTF8_BOM[..]).unwrap_or(&raw);
    let envelope: LarkCredentialEnvelope = match serde_json::from_slice(body) {
        Ok(envelope) => envelope,
        Err(err) => {
            tracing::warn!(%err, "飞书凭据信封解析失败，归档后按未配置处理");
            archive_unreadable_credential(&path);
            return Ok(None);
        }
    };
    if envelope.version != LARK_ENVELOPE_VERSION {
        tracing::warn!(
            version = envelope.version,
            expected = LARK_ENVELOPE_VERSION,
            "飞书凭据信封版本不匹配，归档后按未配置处理"
        );
        archive_unreadable_credential(&path);
        return Ok(None);
    }

    let cipher = match from_hex(&envelope.dpapi) {
        Ok(cipher) => cipher,
        Err(err) => {
            tracing::warn!(%err, "飞书凭据密文不是合法十六进制，归档后按未配置处理");
            archive_unreadable_credential(&path);
            return Ok(None);
        }
    };

    let mut plain = match dpapi_unprotect(&cipher) {
        Ok(plain) => plain,
        Err(err) => {
            // 这里刻意只记 kind 而不记 err 全文：DPAPI 的错误串里不含密钥，
            // 但保持「凭据相关日志一律最小化」的习惯，免得将来有人往里加内容。
            tracing::warn!(
                kind = err.kind(),
                "飞书凭据解密失败（换机 / 换 Windows 用户 / 便携目录被拷走），需重新配置"
            );
            archive_unreadable_credential(&path);
            return Ok(None);
        }
    };

    let parsed = serde_json::from_slice::<LarkCredential>(&plain);
    zeroize(&mut plain);
    match parsed {
        Ok(credential) => Ok(Some(credential)),
        Err(err) => {
            tracing::warn!(%err, "飞书凭据明文结构异常，归档后按未配置处理");
            archive_unreadable_credential(&path);
            Ok(None)
        }
    }
}

/// 刷新 token 缓存（[`crate::share::lark`] 换到新 tenant_access_token 后调用）。
///
/// 凭据不存在时**静默返回**：这只可能发生在「用户正好在导入过程中清空了凭据」，
/// 为此报错除了让一次已经成功的导入显示成失败之外没有任何好处。
pub fn store_lark_token(token: &str, expires_at: i64) -> AppResult<()> {
    let Some(mut credential) = load_lark_credential_sync()? else {
        tracing::debug!("无飞书凭据，跳过 token 缓存写入");
        return Ok(());
    };
    credential.tenant_access_token = Some(token.to_string());
    credential.expires_at = Some(expires_at);
    write_lark_credential(&credential)?;
    // 只记过期时间，绝不记 token 本身（任务硬性要求）
    tracing::debug!(expires_at, "飞书 token 缓存已更新");
    Ok(())
}

/// 把解不开的凭据文件挪走。失败只记日志——挪不动顶多是下次再走一遍同样的分支。
fn archive_unreadable_credential(path: &Path) {
    let Some(dir) = path.parent() else {
        return;
    };
    let backup = dir.join(LARK_UNREADABLE_BACKUP_NAME);
    match fs::rename(path, &backup) {
        Ok(()) => tracing::warn!(backup = %backup.display(), "已归档无法读取的飞书凭据"),
        Err(err) => tracing::warn!(%err, path = %path.display(), "归档飞书凭据失败"),
    }
}

/// 保存飞书凭据（DPAPI 加密后落盘）。
///
/// 前端只需传 `{ appId, appSecret }`；返回值刻意是 `()` 而不是状态对象——
/// 想拿状态请单独调 [`lark_credential_status`]，保证「写」与「读」两条路径的
/// 出参形状不会互相牵扯。
#[tauri::command]
pub async fn save_lark_credential(credential: LarkCredential) -> AppResult<()> {
    save_lark_credential_sync(&credential)
}

/// 读取凭据的可见状态（**不含 secret 与 token**，见 [`LarkCredentialStatus`]）。
#[tauri::command]
pub async fn lark_credential_status() -> AppResult<LarkCredentialStatus> {
    let credential = load_lark_credential_sync()?;
    Ok(match credential {
        Some(credential) => LarkCredentialStatus {
            configured: true,
            app_id_masked: Some(mask_secret(&credential.app_id)),
            has_cached_token: credential.tenant_access_token.is_some(),
        },
        None => LarkCredentialStatus {
            configured: false,
            app_id_masked: None,
            has_cached_token: false,
        },
    })
}

/// 清空飞书凭据（设置页「解除绑定」）。文件不存在时按成功处理（幂等）。
#[tauri::command]
pub async fn clear_lark_credential() -> AppResult<()> {
    let path = lark_credential_path()?;
    match fs::remove_file(&path) {
        Ok(()) => {
            tracing::info!("飞书凭据已清除");
            Ok(())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
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
///
/// # 幂等
///
/// 同一个目录只真正下发一次授权：外部保存触发的静默刷新会让同一篇文档反复走
/// `read_markdown`，而 Tauri 的 scope 是一个不断 push 的 glob 列表——重复 allow
/// 会让它无限膨胀，之后**每一次**资源请求都要多匹配一条 glob。
pub fn allow_asset_dir<R: tauri::Runtime, M: Manager<R>>(manager: &M, dir: &Path) -> AppResult<()> {
    // 本进程已授权过的目录集合（不落盘：授权随进程生命周期存在）
    static AUTHORIZED_DIRS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

    let authorized = AUTHORIZED_DIRS.get_or_init(|| Mutex::new(HashSet::new()));
    // 锁中毒（某次持锁时 panic）不该让图片从此全部裂开：拿回内部值继续用，
    // 最坏后果只是重复下发一次授权。
    let mut authorized = authorized
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if authorized.contains(dir) {
        return Ok(());
    }

    let recursive = dir.parent().is_some();
    manager
        .asset_protocol_scope()
        .allow_directory(dir, recursive)?;
    authorized.insert(dir.to_path_buf());
    tracing::debug!(dir = %dir.display(), recursive, "asset 协议：已授权目录");
    Ok(())
}

// ---------------------------------------------------------------------------
// DPAPI 加密位
// ---------------------------------------------------------------------------

/// `CRYPTPROTECT_UI_FORBIDDEN`：禁止 DPAPI 弹任何 UI。
///
/// 必须给：我们可能在**无 UI 路径**（`--action` 右键动词、隐藏渲染窗口）里读凭据，
/// 那种场景下弹一个没有父窗口的系统对话框 = 进程挂死在一个用户永远看不见的框上。
#[cfg(windows)]
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

/// DPAPI 的最小 FFI 面（`crypt32.dll` 两个函数 + `kernel32` 的 `LocalFree`）。
///
/// # 为什么手写 extern 而不是开 `windows` crate 的 feature
///
/// `windows` crate 已在依赖里（`=0.61.3`，跟随 wry 锁定），它的
/// `Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData}` 确实存在
/// （本机 registry 源码已核对）——但要用就得往 `Cargo.toml` 的 features 里加
/// `Win32_Security_Cryptography`，而 `Cargo.toml` 不在本次任务的改动范围内。
///
/// 这三个函数的签名三十年没变过、没有指针别名的花样、总共二十行，手写 extern 的
/// 代价远低于跨文件接线。若主控愿意开那个 feature，把本模块整段换成 crate 绑定即可，
/// 上层的 [`dpapi_protect`] / [`dpapi_unprotect`] 签名不受影响。
#[cfg(windows)]
#[allow(non_snake_case)]
mod dpapi_ffi {
    /// `DATA_BLOB`（SDK 里叫 `CRYPTOAPI_BLOB`）：DPAPI 所有进出参数的容器。
    ///
    /// 字段顺序与 `#[repr(C)]` 都是硬约束——写反了不会编译报错，
    /// 只会在运行时把长度当指针用。
    #[repr(C)]
    pub struct DataBlob {
        pub cb_data: u32,
        pub pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        pub fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut core::ffi::c_void,
            p_prompt_struct: *mut core::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        pub fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            pp_sz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut core::ffi::c_void,
            p_prompt_struct: *mut core::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        /// DPAPI 的出参缓冲区由 LocalAlloc 分配，只能用 LocalFree 归还
        /// （用 `free`/`Vec::from_raw_parts` 会直接堆损坏）。
        pub fn LocalFree(h_mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }
}

/// DPAPI 加密（`CryptProtectData`，作用域 = 当前 Windows 用户 + [`DPAPI_ENTROPY`]）。
#[cfg(windows)]
pub fn dpapi_protect(plain: &[u8]) -> AppResult<Vec<u8>> {
    dpapi_transform(plain, true)
}

/// DPAPI 解密（`CryptUnprotectData`）。
///
/// 换机 / 换 Windows 用户 / 便携目录被拷到别的电脑上 —— 这三种情况下解密**必然失败**，
/// 那是 DPAPI「密钥绑定用户」的设计使然。调用方（[`load_lark_credential_sync`]）
/// 据此把凭据当作未配置并引导重配，不要把这个错误直接扔到用户脸上。
#[cfg(windows)]
pub fn dpapi_unprotect(cipher: &[u8]) -> AppResult<Vec<u8>> {
    dpapi_transform(cipher, false)
}

/// 加解密共用的一段 FFI 编排（两条路径除了调哪个函数以外完全相同）。
#[cfg(windows)]
fn dpapi_transform(input: &[u8], protect: bool) -> AppResult<Vec<u8>> {
    use dpapi_ffi::{CryptProtectData, CryptUnprotectData, DataBlob, LocalFree};

    let verb = if protect { "加密" } else { "解密" };
    if input.is_empty() {
        // DPAPI 对 cbData=0 的行为没有文档保证，短路掉而不是赌它的实现细节
        return Err(AppError::config(format!("DPAPI {verb}输入为空")));
    }
    let len = u32::try_from(input.len())
        .map_err(|_| AppError::config(format!("DPAPI {verb}输入过大：{} 字节", input.len())))?;

    let in_blob = DataBlob {
        cb_data: len,
        // pb_data 在 C 结构里是 *mut，但 pDataIn 是 [in] 参数，DPAPI 不会写它
        pb_data: input.as_ptr().cast_mut(),
    };
    // entropy 同样要一个可写指针，拷一份到堆缓冲区里借出去。
    // 这份拷贝**不需要**抹零：它的内容是编译期常量，本来就明明白白躺在二进制里。
    let mut entropy_buffer = DPAPI_ENTROPY.to_vec();
    let entropy = DataBlob {
        cb_data: entropy_buffer.len() as u32,
        pb_data: entropy_buffer.as_mut_ptr(),
    };
    let mut out = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };

    // SAFETY：
    // * 三个入参 blob 指向的缓冲区在整个调用期间都被本函数的局部变量持有，不会被移动或释放；
    // * `pv_reserved` / `p_prompt_struct` 按文档必须为 NULL（配合 UI_FORBIDDEN）；
    // * `out` 是未初始化的出参，成功时由 DPAPI 用 LocalAlloc 填上，失败时保持 null；
    // * 返回值是 BOOL，0 = 失败，此时必须用 GetLastError（= `last_os_error`）取原因。
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                &entropy,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        }
    };

    if ok == 0 {
        // 必须紧挨着调用取错误码：中间插任何一句都可能把 LastError 冲掉
        let err = std::io::Error::last_os_error();
        return Err(AppError::native(format!("DPAPI {verb}失败：{err}")));
    }
    if out.pb_data.is_null() {
        return Err(AppError::native(format!("DPAPI {verb}返回了空缓冲区")));
    }

    let size = out.cb_data as usize;
    // SAFETY：DPAPI 保证成功时 pb_data 指向 cb_data 字节的有效内存。
    let result = unsafe { std::slice::from_raw_parts(out.pb_data, size) }.to_vec();
    // 解密出来的明文在 DPAPI 的缓冲区里也留着一份，还给系统之前先抹掉
    // SAFETY：同上，这块内存此刻仍归我们支配，尚未 LocalFree。
    unsafe { std::ptr::write_bytes(out.pb_data, 0, size) };
    // SAFETY：out.pb_data 来自 DPAPI 的 LocalAlloc，配对的释放函数只有 LocalFree。
    unsafe { LocalFree(out.pb_data.cast()) };
    // entropy_buffer 必须活到这里：DPAPI 在调用期间会读它，提前 drop 就是悬垂指针
    drop(entropy_buffer);

    Ok(result)
}

/// 非 Windows 平台没有 DPAPI。本产品只发 Windows，这两个分支仅为可编译性存在——
/// 真要跨平台，凭据存储必须整体换方案（keyring / 用户口令派生密钥），而不是明文落盘。
#[cfg(not(windows))]
pub fn dpapi_protect(plain: &[u8]) -> AppResult<Vec<u8>> {
    let _ = plain;
    Err(AppError::not_implemented("DPAPI 仅 Windows 可用"))
}

#[cfg(not(windows))]
pub fn dpapi_unprotect(cipher: &[u8]) -> AppResult<Vec<u8>> {
    let _ = cipher;
    Err(AppError::not_implemented("DPAPI 仅 Windows 可用"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    /// 契约 A（2026-08-18 批次 1.3）：`settings.json` / IPC 载荷的 **全部** 顶层 key。
    /// 与 TS `types/index.ts` 的 `SETTINGS_KEY_MAP`、`stores/settings.ts` 的
    /// `DEFAULT_SETTINGS` 一一对应。改这里等于改前后端契约，必须三处同改。
    const CONTRACT_KEYS: [&str; 15] = [
        "theme",
        "fontSize",
        "zoomPercent",
        "readingWidth",
        "codeWrap",
        "frontmatterDisplay",
        "outlinePinned",
        "sidebarWidth",
        "sidebarCollapsed",
        "htmlExportMode",
        "sidebarView",
        "folderRoot",
        "folderExpanded",
        "recentFolders",
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
        // 默认跟随窗口宽度（MPE 行为）：固定列宽是可选项，不是出厂状态
        assert_eq!(settings.reading_width, ReadingWidth::Fluid);
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
        assert_eq!(json["readingWidth"], "fluid");
        // F20：出厂 = 最近列表视图、未挂载文件夹
        assert_eq!(json["sidebarView"], "recent");
        assert!(json["folderRoot"].is_null(), "未挂载的根必须是 null");
        assert!(json["window"]["x"].is_null(), "无记录的坐标必须是 null");

        // 三档列宽的 wire 值即 CSS 的 data-reading-width 取值，拼错一个档位就整档失效
        for (value, wire) in [
            (ReadingWidth::Fluid, "fluid"),
            (ReadingWidth::Medium, "medium"),
            (ReadingWidth::Wide, "wide"),
        ] {
            assert_eq!(
                serde_json::to_value(value).expect("序列化不应失败"),
                serde_json::Value::from(wire)
            );
        }

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
            "readingWidth": "wide",
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
        assert_eq!(settings.reading_width, ReadingWidth::Wide);
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

    /// F20 不变式（TS 侧 settings.test.ts 有同款 describe，双侧都必须钉住）：
    /// 空白根 = 未挂载 → 视图退回 recent、展开集清空。
    #[test]
    fn sanitize_enforces_folder_mode_invariants() {
        let mut settings = Settings {
            sidebar_view: SidebarView::Tree,
            folder_root: Some("  ".into()),
            folder_expanded: vec![r"C:\a".into(), r"C:\b".into()],
            ..Settings::default()
        };
        settings.sanitize();
        assert_eq!(settings.folder_root, None);
        assert_eq!(settings.sidebar_view, SidebarView::Recent);
        assert!(settings.folder_expanded.is_empty());
    }

    /// F20 上限截断方向：展开集追加在尾 → 弃头保尾（保住最新展开的）；
    /// 最近文件夹新的插头 → 保头弃尾。有根时视图与展开集不许被误清。
    #[test]
    fn sanitize_folder_limits_keep_the_right_end() {
        let mut settings = Settings {
            sidebar_view: SidebarView::Tree,
            folder_root: Some(r"C:\notes".into()),
            folder_expanded: (0..FOLDER_EXPANDED_LIMIT + 10)
                .map(|index| format!(r"C:\notes\d{index}"))
                .collect(),
            recent_folders: (0..RECENT_FOLDERS_LIMIT + 5)
                .map(|index| format!(r"C:\roots\r{index}"))
                .collect(),
            ..Settings::default()
        };
        settings.sanitize();
        assert_eq!(settings.sidebar_view, SidebarView::Tree, "有根不许清视图");
        assert_eq!(settings.folder_expanded.len(), FOLDER_EXPANDED_LIMIT);
        // 弃头保尾：最新（尾部）那条必须幸存
        assert_eq!(
            settings.folder_expanded.last().map(String::as_str),
            Some(format!(r"C:\notes\d{}", FOLDER_EXPANDED_LIMIT + 9).as_str())
        );
        assert_eq!(settings.recent_folders.len(), RECENT_FOLDERS_LIMIT);
        // 保头弃尾：最新（头部）那条必须幸存
        assert_eq!(
            settings.recent_folders.first().map(String::as_str),
            Some(r"C:\roots\r0")
        );
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
        // 升级路径：旧 settings.json 里没有 readingWidth，必须落到 fluid 而不是让解析失败
        assert_eq!(settings.reading_width, ReadingWidth::Fluid);
    }

    /// 记事本另存为会加 BOM，不剥掉 serde_json 会直接报错。
    #[test]
    fn parses_file_with_utf8_bom() {
        let mut raw = UTF8_BOM.to_vec();
        raw.extend_from_slice(br#"{ "zoomPercent": 120 }"#);
        let settings = parse_settings(&raw).expect("带 BOM 的配置也要能解析");
        assert_eq!(settings.zoom_percent, 120);
    }

    /// 建一个本次测试专属的空目录。
    ///
    /// 不引入 `tempfile` dev-dependency：Cargo.toml 属编译面，为三个单测加一棵依赖树
    /// 不划算；进程 id + 线程 id 已足够避免并行测试互相踩。
    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mdnaonao-portable-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能创建临时目录");
        dir
    }

    /// 便携探测（UPGRADE_PLAN 2.0）：exe 同级有 marker → 数据根落到 `<exe 目录>\data\`。
    #[test]
    fn portable_marker_redirects_data_root_next_to_exe() {
        let exe_dir = scratch_dir("with-marker");
        fs::write(exe_dir.join(PORTABLE_MARKER), b"").expect("应能写入 marker");

        assert_eq!(
            portable_root_for_exe_dir(&exe_dir),
            Some(exe_dir.join(PORTABLE_DATA_DIR)),
            "有 marker 时必须切到 exe 同级的 data 目录"
        );

        let _ = fs::remove_dir_all(&exe_dir);
    }

    /// 无 marker（安装版的常态）：探测必须返回 None，交由调用方回落 `%APPDATA%`。
    #[test]
    fn missing_marker_keeps_installed_mode() {
        let exe_dir = scratch_dir("no-marker");

        assert_eq!(
            portable_root_for_exe_dir(&exe_dir),
            None,
            "无 marker 时不得进入便携模式"
        );

        let _ = fs::remove_dir_all(&exe_dir);
    }

    /// 同名**目录**不是 marker：用户手滑 `mkdir portable.marker` 不该把数据根整个搬家。
    #[test]
    fn marker_must_be_a_file_not_a_directory() {
        let exe_dir = scratch_dir("marker-dir");
        fs::create_dir_all(exe_dir.join(PORTABLE_MARKER)).expect("应能创建同名目录");

        assert_eq!(portable_root_for_exe_dir(&exe_dir), None);

        let _ = fs::remove_dir_all(&exe_dir);
    }

    /// 安装模式的根目录名不许漂（DG 7.3 写死 `%APPDATA%\MDNaonao`）。
    #[test]
    fn installed_root_name_matches_spec() {
        assert_eq!(INSTALLED_DIR_NAME, "MDNaonao");
        assert_eq!(PORTABLE_MARKER, "portable.marker");
        assert_eq!(DataRootMode::Portable.as_str(), "portable");
        assert_eq!(DataRootMode::Installed.as_str(), "installed");
    }

    /// 契约 B：`app_info` 的 wire 字段（前端「关于」对话框逐字依赖）。
    #[test]
    fn app_info_wire_keys_match_contract() {
        let value = serde_json::to_value(AppInfo {
            version: "0.1.0".to_string(),
            portable: true,
            data_dir: r"D:\MDNaonao\data".to_string(),
        })
        .expect("序列化不应失败");
        let object = value.as_object().expect("AppInfo 应序列化为 JSON 对象");

        let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
        let expected: BTreeSet<&str> = ["version", "portable", "dataDir"].into_iter().collect();
        assert_eq!(actual, expected, "app_info 字段契约漂移（TS 侧需同步）");
        assert_eq!(object["dataDir"], r"D:\MDNaonao\data");
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

    // -----------------------------------------------------------------------
    // 飞书凭据（M3）
    //
    // 注意：这里刻意**不测** save/load_lark_credential_sync —— 它们写的是真实的
    // `%APPDATA%\MDNaonao\lark-token.json`，跑一次单测就会把开发者自己配的凭据覆盖掉。
    // 落盘那一层由 write_atomic 的测试覆盖，此处只钉住纯逻辑与 FFI 往返。
    // -----------------------------------------------------------------------

    /// 契约 C：`LarkCredentialStatus` 的 wire 字段（设置页逐字依赖），
    /// 且**绝不能**出现 appSecret / token —— 这条断言就是那道闸门。
    #[test]
    fn lark_status_wire_keys_match_contract() {
        let value = serde_json::to_value(LarkCredentialStatus {
            configured: true,
            app_id_masked: Some("cli_***".to_string()),
            has_cached_token: false,
        })
        .expect("序列化不应失败");
        let object = value.as_object().expect("应序列化为 JSON 对象");

        let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
        let expected: BTreeSet<&str> = ["configured", "appIdMasked", "hasCachedToken"]
            .into_iter()
            .collect();
        assert_eq!(actual, expected, "飞书凭据状态字段契约漂移（TS 侧需同步）");

        let serialized = value.to_string();
        for leaked in ["appSecret", "app_secret", "tenantAccessToken"] {
            assert!(
                !serialized.contains(leaked),
                "凭据状态里绝不允许出现 {leaked}"
            );
        }
    }

    /// 前端只传 `{ appId, appSecret }`，缺的字段必须走默认值而不是解析失败。
    #[test]
    fn lark_credential_accepts_partial_payload_from_frontend() {
        let credential: LarkCredential =
            serde_json::from_str(r#"{ "appId": "cli_a1b2c3", "appSecret": "s3cr3t" }"#)
                .expect("两字段载荷必须能解析");
        assert_eq!(credential.app_id, "cli_a1b2c3");
        assert_eq!(credential.tenant_access_token, None);
        assert_eq!(credential.expires_at, None);

        // wire 名同样是契约（落盘的密文里就是这套 key，换名 = 老凭据解出来全是默认值）
        let json = serde_json::to_value(&credential).expect("序列化不应失败");
        let actual: BTreeSet<&str> = json
            .as_object()
            .expect("应为对象")
            .keys()
            .map(String::as_str)
            .collect();
        let expected: BTreeSet<&str> = ["appId", "appSecret", "tenantAccessToken", "expiresAt"]
            .into_iter()
            .collect();
        assert_eq!(actual, expected);
    }

    /// 打码只留前 4 字符；短值整串打掉，别把「secret 只有 3 位」这种信息也漏出去。
    #[test]
    fn masks_secrets_for_logs_and_ui() {
        assert_eq!(mask_secret("cli_a1b2c3d4"), "cli_***");
        assert_eq!(mask_secret(""), "***");
        assert_eq!(mask_secret("abcd"), "***");
        assert_eq!(mask_secret("abcde"), "abcd***");
        // 多字节字符不许被从中间切断（切断会产出非法 UTF-8）
        assert_eq!(mask_secret("中文应用标识"), "中文应用***");
    }

    /// hex 往返 + 非法输入必须报错（而不是静默产出一份坏密文）。
    #[test]
    fn hex_round_trips_and_rejects_garbage() {
        let bytes = vec![0x00, 0x01, 0x0f, 0x10, 0x7f, 0x80, 0xff];
        let text = to_hex(&bytes);
        assert_eq!(text, "00010f107f80ff");
        assert_eq!(from_hex(&text).expect("往返应成功"), bytes);

        // 大写也要认（用户可能手工改过文件）
        assert_eq!(from_hex("FF00").expect("大写应可解"), vec![0xff, 0x00]);
        assert_eq!(from_hex("").expect("空串合法"), Vec::<u8>::new());
        assert!(from_hex("abc").is_err(), "奇数长度应报错");
        assert!(from_hex("zz").is_err(), "非十六进制字符应报错");
    }

    /// 信封是磁盘格式，key 名与版本号都不许随手改（改了 = 所有人的凭据失效）。
    #[test]
    fn credential_envelope_disk_format_is_stable() {
        let json = serde_json::to_string(&LarkCredentialEnvelope {
            version: LARK_ENVELOPE_VERSION,
            dpapi: "01000000".to_string(),
        })
        .expect("序列化不应失败");
        assert_eq!(json, r#"{"version":1,"dpapi":"01000000"}"#);
        assert_eq!(LARK_ENVELOPE_VERSION, 1);
    }

    /// 抹零必须真的抹掉（防止有人把 write_volatile 改回普通赋值被优化器删掉）。
    #[test]
    fn zeroize_clears_buffer() {
        let mut buffer = b"app-secret".to_vec();
        zeroize(&mut buffer);
        assert!(buffer.iter().all(|byte| *byte == 0));
    }

    /// DPAPI 往返：密文既不能等于明文，也必须能原样解回来。
    ///
    /// 这条同时验证了 [`DPAPI_ENTROPY`] 在加解密两侧对称使用——
    /// 只在一侧传 entropy 是本类代码最典型的 bug，且症状是「保存看着成功、下次读不出来」。
    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_credential_payload() {
        let plain = br#"{"appId":"cli_a1b2c3","appSecret":"s3cr3t","tenantAccessToken":null,"expiresAt":null}"#;

        let cipher = dpapi_protect(plain).expect("当前用户会话下 DPAPI 加密应成功");
        assert_ne!(cipher.as_slice(), &plain[..], "密文不得等于明文");
        assert!(cipher.len() > plain.len(), "DPAPI 密文必然带头部与校验");

        let round = dpapi_unprotect(&cipher).expect("同一用户解密应成功");
        assert_eq!(round.as_slice(), &plain[..]);
    }

    /// 空输入短路，不去赌 DPAPI 对 cbData=0 的未文档化行为。
    #[cfg(windows)]
    #[test]
    fn dpapi_rejects_empty_input() {
        assert!(dpapi_protect(&[]).is_err());
        assert!(dpapi_unprotect(&[]).is_err());
    }

    /// 被篡改 / 别人家的密文必须解密失败，而不是解出一堆垃圾当成凭据用。
    #[cfg(windows)]
    #[test]
    fn dpapi_rejects_tampered_ciphertext() {
        let mut cipher = dpapi_protect(b"payload").expect("加密应成功");
        let last = cipher.len() - 1;
        cipher[last] ^= 0xff;
        assert!(dpapi_unprotect(&cipher).is_err(), "篡改后的密文必须解不开");
    }
}
