//! DG 7.1 `shell_integ.rs` 职责：**与 Windows 外壳打交道的那一层**——
//! 「额外右键动词」的注册表读写（文件关联本身交给 bundler），
//! 以及「把本应用自己的产物交给系统默认程序打开」（[`open_in_browser`]）。
//!
//! 后者放在本模块而不是 `export_html`，是因为它的风险面属于外壳而非导出：
//! 落地点是 `ShellExecuteExW`，等于「让系统按扩展名挑一个程序跑起来」。
//! 相关的安全边界集中写在 [`open_in_browser`] 的文档里，改那个函数前先读完。
//!
//! ## 铁律（红线 2/3、DG 10-2/10-6/10-7）
//! 1. **UserChoice 永远不碰**：不写、不删、不猜哈希（Windows 10+ 带哈希保护，
//!    应用不可写）。「设为默认程序」只能**引导用户手动操作**（首启引导跳系统设置页）。
//!    只读检测「当前默认程序是谁」是允许的——首启引导需要。
//! 2. 写入范围仅限：自家 ProgID 下的键 + 额外右键动词。
//!    **永不整删 `.md` 等扩展名键。**
//! 3. 运行时写入的每一个键都必须同步登记进 `nsis-hooks.nsh` 的
//!    `NSIS_HOOK_PREUNINSTALL` 删除清单——卸载残留是差评重灾区。
//! 4. 变更后调用 `SHChangeNotify(SHCNE_ASSOCCHANGED)` 刷新 Shell 缓存。
//! 5. Win11 下 HKCU 动词进「显示更多选项」是**设计行为，不是 bug**；
//!    一级菜单需 COM 组件 + 代码签名，属 V2（DG 9.1 M4）。
//!
//! 正常路径下额外动词由 NSIS 安装钩子写入；本模块只在
//! 「安装后用户在设置页手动开关右键菜单项」时使用。
//!
//! ## 便携模式（UPGRADE_PLAN 2.0 / DG F19）
//!
//! 便携版的承诺是「解压即用、拷走即净」——**在系统里不留任何痕迹**。
//! 因此本模块所有注册表**写入**路径（含删除，删除也是写）统一走
//! [`ensure_registry_writable`] 闸门：便携模式下一律短路 + `warn`，绝不落键。
//! 只读检测（[`query_default_app`]）不受影响，它本来就不改系统。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 自家 ProgID。
/// TODO(M2)：`tauri build` 后核对 bundler 为 fileAssociations 生成的实际 ProgID
/// 名称并与 `nsis-hooks.nsh` 的 `MDV_PROGID` 保持一致（挂错 = 右键菜单不出现）。
pub const PROGID: &str = "MDNaonao.md";

/// 动词注册根（installMode=currentUser → HKCU）。
pub const CLASSES_ROOT: &str = r"Software\Classes";

/// 只读检测默认程序时使用的键（**只读，永不写入**）。
pub const USER_CHOICE_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice";

/// 额外右键动词。每新增一项，必须同步：
/// (1) `nsis-hooks.nsh` 的写入与删除清单；(2) DG 3.1 的 FR 编号；(3) 设置页开关。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShellVerb {
    /// 转为 HTML（v1.0 / M2，FR-07）
    ToHtml,
    /// 转为 PDF（v1.0 / M2，FR-08）
    ToPdf,
    /// 导入 Obsidian（v1.1 / M3，FR-09）
    ImportObsidian,
    /// 生成长图（v1.1 / M3，FR-10）
    ShareImage,
}

impl ShellVerb {
    /// 注册表子键名（挂在 `HKCU\Software\Classes\<PROGID>\shell\` 下）。
    pub fn key_name(&self) -> &'static str {
        match self {
            ShellVerb::ToHtml => "MDNaonao.ToHtml",
            ShellVerb::ToPdf => "MDNaonao.ToPdf",
            ShellVerb::ImportObsidian => "MDNaonao.ImportObsidian",
            ShellVerb::ShareImage => "MDNaonao.ShareImage",
        }
    }

    /// 对应的 `--action` 取值，必须与 [`crate::cmdline::Action`] 一一对应。
    pub fn action(&self) -> crate::cmdline::Action {
        match self {
            ShellVerb::ToHtml => crate::cmdline::Action::ToHtml,
            ShellVerb::ToPdf => crate::cmdline::Action::ToPdf,
            ShellVerb::ImportObsidian => crate::cmdline::Action::ImportObsidian,
            ShellVerb::ShareImage => crate::cmdline::Action::ShareImage,
        }
    }
}

/// 当前 `.md` 默认程序的只读检测结果（首启引导用，FR-09 之外的 F9 引导流程）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppStatus {
    /// UserChoice 里记录的 ProgID（读不到则为 None）
    pub current_progid: Option<String>,
    /// 是否已是本应用
    pub is_self: bool,
}

// ---------------------------------------------------------------------------
// 便携模式闸门
// ---------------------------------------------------------------------------

/// 注册表写入的统一闸门：便携模式下短路（UPGRADE_PLAN 2.0）。
///
/// 返回 `Err` 而不是 `Ok(())`：静默成功会让设置页的开关看起来生效了，
/// 下次打开却又是关的——「点了没反应」正是批次 1 刚清零的那类问题。
/// 前端按 `kind = "config"` 提示「便携版不改系统设置」即可。
///
/// **每一个** winreg 写入（`create_subkey` / `set_value` / `delete_subkey*`）
/// 落地前都必须先过这里；新增写入函数时同步加一行调用。
fn ensure_registry_writable(what: &str) -> AppResult<()> {
    if !crate::settings::is_portable() {
        return Ok(());
    }
    tracing::warn!(
        operation = what,
        "便携模式：已短路注册表写入（系统里不留痕迹）"
    );
    Err(AppError::config(format!(
        "便携模式不写注册表（{what}）：文件关联与右键菜单请使用安装版"
    )))
}

// ---------------------------------------------------------------------------
// 命令骨架
// ---------------------------------------------------------------------------

/// **只读**检测 `.md` 当前默认程序（首启引导判断是否需要提示「设为默认」）。
///
/// TODO(M1)：winreg 读 [`USER_CHOICE_KEY`] 的 `ProgId` 值。
/// 读不到属正常情况（系统未记录 / 权限受限），返回 `current_progid: None` 即可，不报错。
/// **此函数只读，任何情况下不得写入该键。**
#[tauri::command]
pub async fn query_default_app() -> AppResult<DefaultAppStatus> {
    Err(AppError::not_implemented(
        "shell_integ::query_default_app（M1，只读检测）",
    ))
}

/// 引导用户手动设默认：跳系统「默认应用」设置页。
///
/// TODO(M1)：`ms-settings:defaultapps` 深链；不同 Windows 版本落点不同，
/// 引导文案与动图由前端负责（DG 6.4-14 三步向导）。
#[tauri::command]
pub async fn open_default_apps_settings() -> AppResult<()> {
    Err(AppError::not_implemented(
        "shell_integ::open_default_apps_settings（M1）",
    ))
}

/// 注册额外右键动词（设置页开关打开时）。
///
/// TODO(M2)：winreg 在 `HKCU\Software\Classes\<PROGID>\shell\<key_name>` 下写
/// 默认值（菜单文案）、`Icon`、`command\(默认) = "<exe>" --action <action> "%1"`；
/// 写完调用 [`refresh_shell`]。**新增键必须同步进 `nsis-hooks.nsh` 删除清单。**
#[tauri::command]
pub async fn register_extra_verbs(verbs: Vec<ShellVerb>) -> AppResult<()> {
    ensure_registry_writable("register_extra_verbs")?;
    Err(AppError::not_implemented(format!(
        "shell_integ::register_extra_verbs（M2）：{verbs:?}"
    )))
}

/// 注销额外右键动词（设置页开关关闭时 / 卸载兜底）。
///
/// TODO(M2)：只 `delete_subkey_all` 自己的动词子键，
/// **不动 `<PROGID>` 本身，更不动 `.md` 扩展名键**。
#[tauri::command]
pub async fn unregister_extra_verbs(verbs: Vec<ShellVerb>) -> AppResult<()> {
    // 删除同样是写：便携版从来没写过键，也就没有可删的键
    ensure_registry_writable("unregister_extra_verbs")?;
    Err(AppError::not_implemented(format!(
        "shell_integ::unregister_extra_verbs（M2）：{verbs:?}"
    )))
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 通知 Shell 关联已变更：`SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL)`。
///
/// TODO(M2)：用已锁定版本的 `windows` crate 调用（红线 10：版本跟随 wry）。
pub fn refresh_shell() -> AppResult<()> {
    // 便携模式下没有任何关联变更需要广播，直接短路（省一次全系统 Shell 通知）
    ensure_registry_writable("refresh_shell")?;
    Err(AppError::not_implemented(
        "shell_integ::refresh_shell（M2）",
    ))
}

// ---------------------------------------------------------------------------
// 在浏览器中打开（右键菜单「打开方式」组，UPGRADE_PLAN 附录 A.1）
// ---------------------------------------------------------------------------

/// 允许交给系统默认程序打开的扩展名（小写比较）。
///
/// **这份清单就是本命令的全部安全边界，加一项之前先把下面那段读完。**
pub const BROWSER_OPEN_EXTENSIONS: [&str; 2] = ["html", "htm"];

/// 「目标不是 HTML 产物」错误的稳定前缀 —— 前端按它分支给专门的提示，
/// 而不是把一句 Rust 日志原样糊到用户脸上。放在 message 里而不是新增
/// `AppError` 变体，与 `export_html::ERR_TARGET_EXISTS` 同一套路数：
/// `AppError::kind()` 是全局前后端契约，不该为一个功能点扩张。
pub const ERR_NOT_HTML: &str = "OPEN_IN_BROWSER_NOT_HTML";

/// 临时预览目录：`%TEMP%\MDNaonao\browser-preview\`。
///
/// 单独开一层自家目录（而不是直接把文件丢进 `%TEMP%` 根）是为了让
/// [`prune_stale_previews`] 的删除范围有一个物理边界：只在这个目录里动手。
const PREVIEW_ROOT_DIR: &str = "MDNaonao";
const PREVIEW_SUB_DIR: &str = "browser-preview";

/// 预览文件保留时长。超过就在下一次分配路径时顺手清掉。
///
/// 不是关窗即删：用户「在浏览器中打开」之后多半还要在浏览器里读一会儿、
/// 甚至收藏起来待会儿再看，应用一退出就把文件抽走 = 一刷新就白屏。
/// 24 小时是「今天还看得到、明天不留垃圾」的折中。
const PREVIEW_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// 预览文件名里保留的源文件名长度上限（字符数）。
///
/// 纯粹为了不撞 `MAX_PATH`：`%TEMP%` 本身就已经很深（`C:\Users\<很长的用户名>\AppData\Local\Temp`）。
const PREVIEW_STEM_MAX_CHARS: usize = 40;

/// 源文件名清洗后为空时的兜底名。
const FALLBACK_PREVIEW_STEM: &str = "preview";

/// Windows 文件名里非法的字符。
const ILLEGAL_NAME_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 把一份 HTML 产物交给系统默认程序打开（右键菜单「在浏览器中打开」的后半程）。
///
/// # 为什么必须是后端出这条命令
///
/// 前端 `services/ipc.ts` 的 `openExternal` **只放行 http(s)**，capabilities 里
/// `opener:allow-open-path` 的 scope 也只授权了 Markdown 五扩展名 + html/htm/pdf。
/// 那两道门是纵深防御，不是绊脚石：放宽任意一道，都等于把
/// 「渲染层被注入 → ShellExecute 拉起任意程序」这条路打通。所以正路是后端自己走
/// opener 插件，并在这里**自带**一道比 ACL 更窄的闸门。
///
/// # 这道闸门为什么不能省
///
/// 本项目没有 app ACL manifest（无 `src-tauri/permissions/`），Tauri 2.11 因此
/// **不对自家 `#[tauri::command]` 做权限检查**；而 `tauri_plugin_opener::open_path`
/// 这个 Rust 侧自由函数也绕开了插件命令层的 scope 校验（scope 只写在插件的
/// `commands.rs` 里，2026-08-18 对照本机 `tauri-plugin-opener-2.5.4` 源码核实）。
/// 也就是说：**[`BROWSER_OPEN_EXTENSIONS`] 是这条链路上唯一的检查**。
/// 不校验的话，这个命令就是一句「用系统默认程序打开任意文件」——
/// 渲染层一旦被注入，`C:\...\payload.exe` 就直接跑起来了。
///
/// 校验顺序刻意是「先扩展名、后存在性」：扩展名不合格的目标连 `stat` 都不该发生。
///
/// # 为什么不自己 ShellExecute
///
/// 参数转义、UAC 提权目标、UWP 应用这些坑插件已经趟过。核实过的落地路径：
/// `open_path` → `open::that_detached` → `ShellExecuteExW`（`open` crate 开了
/// `shellexecute-on-windows` feature，路径以 `lpFile` 宽字符指针整体传入，
/// 不经过任何命令行拼接，因此文件名里的 `&` `"` 之类没有注入面）。
///
/// # 诚实说明
///
/// 它打开的是「.html 的系统默认程序」。绝大多数机器上那就是浏览器，但用户若把
/// .html 关联给了编辑器，打开的就是编辑器 —— 这是「打开方式」的固有语义，
/// 应用无从也不该干预（红线 2：默认程序归用户和系统管）。
#[tauri::command]
pub async fn open_in_browser(path: PathBuf) -> AppResult<()> {
    ensure_openable_html(&path)?;

    // ShellExecuteExW 会同步等外壳把请求派发出去（冷启动浏览器时可达数百毫秒），
    // 不该占着 async 运行时的工作线程
    tauri::async_runtime::spawn_blocking(move || {
        let shown = path.display().to_string();
        tracing::info!(path = %shown, "在浏览器中打开（交系统默认程序）");
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|err| {
            tracing::error!(path = %shown, %err, "交系统默认程序打开失败");
            AppError::native(format!("交系统默认程序打开失败：{err}"))
        })
    })
    .await
    .map_err(|err| AppError::native(format!("打开任务失败：{err}")))?
}

/// 分配一条「临时 HTML 预览」的落点，并顺手清掉过期的旧预览。
///
/// 前端拿到路径后用它当 `export_html` 的 `output`（单文件模式），导出成功再调
/// [`open_in_browser`]。**目录取自 `std::env::temp_dir()`**：Tauri 的
/// `PathResolver::temp_dir()` 在桌面端的实现就是 `Ok(std::env::temp_dir())`
/// （2026-08-18 对照本机 `tauri-2.11.5/src/path/desktop.rs` 核实），
/// 用标准库这一版可以不接 `AppHandle`，单测里也跑得起来。
///
/// `source` 是当前文档的绝对路径，只用来起名（不读、不写、不校验存在性）。
#[tauri::command]
pub async fn browser_preview_path(source: Option<PathBuf>) -> AppResult<PathBuf> {
    tauri::async_runtime::spawn_blocking(move || allocate_preview_path(source.as_deref()))
        .await
        .map_err(|err| AppError::native(format!("分配浏览器预览路径失败：{err}")))?
}

/// 目标扩展名是否在白名单内（大小写不敏感）。
///
/// 用 `Path::extension` 而不是「字符串以 .html 结尾」：后者会把
/// `payload.html.exe` 这种双扩展名放进来，那正是要挡的东西。
fn has_openable_extension(path: &Path) -> bool {
    let Some(extension) = path.extension() else {
        return false;
    };
    let extension = extension.to_string_lossy().to_ascii_lowercase();
    BROWSER_OPEN_EXTENSIONS.contains(&extension.as_str())
}

/// 完整校验：扩展名白名单 → 存在 → 是文件（不是目录）。
fn ensure_openable_html(path: &Path) -> AppResult<()> {
    if !has_openable_extension(path) {
        tracing::warn!(path = %path.display(), "拒绝打开：扩展名不在 HTML 白名单内");
        return Err(AppError::config(format!(
            "{ERR_NOT_HTML}：只允许打开本应用导出的 HTML 产物（{BROWSER_OPEN_EXTENSIONS:?}），收到：{}",
            path.display()
        )));
    }

    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Ok(_) => Err(AppError::not_found(format!(
            "目标不是文件（目录？）：{}",
            path.display()
        ))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(AppError::not_found(
            format!("预览文件不存在：{}", path.display()),
        )),
        Err(err) => {
            tracing::error!(path = %path.display(), %err, "读取预览文件元数据失败");
            Err(AppError::Io(err))
        }
    }
}

/// `%TEMP%\MDNaonao\browser-preview\`。
fn preview_dir() -> PathBuf {
    std::env::temp_dir()
        .join(PREVIEW_ROOT_DIR)
        .join(PREVIEW_SUB_DIR)
}

fn allocate_preview_path(source: Option<&Path>) -> AppResult<PathBuf> {
    let dir = preview_dir();
    std::fs::create_dir_all(&dir)?;

    let target = dir.join(preview_file_name(source));
    prune_stale_previews(&dir, &target);

    tracing::info!(output = %target.display(), "已分配浏览器预览落点");
    Ok(target)
}

/// 预览文件名 = `<清洗后的源文件名>-<源路径哈希 8 位>.html`。
///
/// 两段各有分工：
/// * 文件名那半是给**人**看的 —— 地址栏里能一眼认出是哪篇；
/// * 哈希那半负责**区分**同名文档。`D:\a\README.md` 与 `D:\b\README.md`
///   若共用 `README.html`，用户在两个标签页里刷新就会看到另一篇的内容 ——
///   那是实打实的「打开了错的东西」，比文件名难看严重得多。
///
/// 同一篇文档反复预览必然落到同一个文件名（哈希是纯函数）：既让浏览器刷新即更新，
/// 也避免临时目录里堆出一串 `README (3).html`。
///
/// 顺带解决了 Windows 保留设备名：拼了 `-<hash>` 之后不可能出现光秃秃的 `CON.html`。
fn preview_file_name(source: Option<&Path>) -> String {
    let stem = source
        .and_then(Path::file_stem)
        .map(|value| sanitize_stem(&value.to_string_lossy()))
        .unwrap_or_else(|| FALLBACK_PREVIEW_STEM.to_string());
    format!("{stem}-{:08x}.html", fnv1a32(&preview_key(source)))
}

/// 哈希的输入：按 Windows 语义归一化的完整路径（分隔符统一 + 大小写不敏感）。
/// `D:/notes/a.md` 与 `D:\Notes\A.MD` 在 Windows 上是同一个文件，必须落到同一个哈希。
fn preview_key(source: Option<&Path>) -> String {
    source
        .map(|path| path.to_string_lossy().replace('/', "\\").to_lowercase())
        .unwrap_or_default()
}

/// 清洗成合法的 Windows 文件名分量并截断。
fn sanitize_stem(raw: &str) -> String {
    let mut cleaned: String = raw
        .chars()
        .filter(|ch| !ch.is_control())
        .map(|ch| {
            if ILLEGAL_NAME_CHARS.contains(&ch) {
                '_'
            } else {
                ch
            }
        })
        .take(PREVIEW_STEM_MAX_CHARS)
        .collect();
    // Windows 会静默吃掉结尾的点与空格，留着会让「写出去的名字」与「要打开的名字」对不上
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    if cleaned.trim().is_empty() {
        FALLBACK_PREVIEW_STEM.to_string()
    } else {
        cleaned
    }
}

/// FNV-1a（32 位）。
///
/// 自己写而不是引 crate（红线 12），也不用 `DefaultHasher`——后者的输出跨 Rust 版本
/// 不保证稳定，而这个哈希会变成磁盘上的文件名，换个编译器就换一批文件是纯粹的垃圾制造。
/// 这里只要「同一路径恒定映射到同一名字」，不要任何抗碰撞性质。
fn fnv1a32(input: &str) -> u32 {
    const OFFSET_BASIS: u32 = 0x811c_9dc5;
    const PRIME: u32 = 0x0100_0193;
    input.as_bytes().iter().fold(OFFSET_BASIS, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(PRIME)
    })
}

/// 清掉自家预览目录里过期的旧产物。**尽力而为，失败一律不打断主流程。**
///
/// 删除范围刻意收得很死（这是应用里为数不多真的会 `remove_file` 的地方）：
/// 1. 只在 `dir` 这一层，**不递归**；
/// 2. 只删扩展名在 [`BROWSER_OPEN_EXTENSIONS`] 内的**普通文件**；
/// 3. 只删修改时间早于 [`PREVIEW_TTL`] 的；
/// 4. `keep`（本次即将写入的落点）永远跳过。
///
/// 读不到修改时间就当它不过期：宁可留下一个垃圾文件，也不能误删用户的东西。
fn prune_stale_previews(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut removed = 0usize;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.as_path() == keep || !has_openable_extension(&path) {
            continue;
        }
        // DirEntry::metadata 在 Windows 上不跟随符号链接：链接本身不是普通文件，会被跳过
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let expired = meta
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > PREVIEW_TTL);
        if expired && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }

    if removed > 0 {
        tracing::info!(removed, dir = %dir.display(), "已清理过期的浏览器预览产物");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 右键动词与 `--action` 取值必须一一对应（写错就是右键菜单点了没反应）。
    #[test]
    fn verbs_map_to_matching_actions() {
        assert_eq!(ShellVerb::ToHtml.action().as_str(), "to-html");
        assert_eq!(ShellVerb::ToPdf.action().as_str(), "to-pdf");
        assert_eq!(
            ShellVerb::ImportObsidian.action().as_str(),
            "import-obsidian"
        );
        assert_eq!(ShellVerb::ShareImage.action().as_str(), "share-image");
    }

    /* ── 在浏览器中打开：扩展名白名单 ─────────────────────────── */

    /// 白名单是这条链路上唯一的安全边界，逐形态钉死。
    #[test]
    fn allows_only_html_extensions() {
        for good in ["a.html", "a.htm", r"D:\导出\我的 笔记.html"] {
            assert!(has_openable_extension(Path::new(good)), "应放行：{good}");
        }
        // 大小写混写：Windows 文件名大小写不敏感，只认小写会漏
        for good in ["a.HTML", "a.HtMl", "a.HTM", "a.Htm"] {
            assert!(has_openable_extension(Path::new(good)), "应放行：{good}");
        }
        for bad in [
            "a.md",       // 源文档：本命令不负责打开它（那是 openWithDefaultApp 的活）
            "a.exe",      // 这条命令存在的全部理由就是挡住它
            "a.bat",      // 同上，且 .bat 双击即执行
            "a.pdf",      // 与 capabilities 的 open-path scope 刻意不一致：本命令只管 HTML
            "a",          // 无扩展名
            "a.",         // 光秃秃一个点：extension() 给出空串，同样不在白名单里
            ".html",      // 整串是文件名而非扩展名（隐藏文件写法）
            "a.html.exe", // 双扩展名 —— 「以 .html 结尾」式判断会在这里破功
            "a.htmlx",    // 前缀相同不算
            r"D:\x\dir",
        ] {
            assert!(!has_openable_extension(Path::new(bad)), "应拒绝：{bad}");
        }
    }

    /* ── 在浏览器中打开：完整校验 ─────────────────────────────── */

    /// 每个用例一个独立目录，避免并行测试互踩。
    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mdnaonao-shell-integ-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录应成功");
        dir
    }

    /// 扩展名不合格时**连磁盘都不该碰**：路径根本不存在，报的却必须是白名单错误。
    /// 这一条钉的是校验顺序，不是校验本身。
    #[test]
    fn rejects_bad_extension_before_touching_disk() {
        let err = ensure_openable_html(Path::new(r"D:\不存在的目录\payload.exe"))
            .expect_err("非 HTML 必须拒绝");
        assert_eq!(err.kind(), "config");
        assert!(
            err.to_string().contains(ERR_NOT_HTML),
            "错误里要带稳定前缀供前端分支：{err}"
        );
    }

    /// 存在的 .html / .htm（含大写扩展名）放行。
    #[test]
    fn accepts_existing_html_files() {
        let dir = scratch_dir("ok");
        for name in ["预览 1.html", "b.htm", "c.HTML"] {
            let file = dir.join(name);
            std::fs::write(&file, b"<h1>hi</h1>").expect("写临时文件应成功");
            ensure_openable_html(&file).unwrap_or_else(|err| panic!("{name} 应放行：{err}"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 导出失败却照样去打开 = 用户看到一个空标签页；必须在这里就拦下。
    #[test]
    fn rejects_missing_file() {
        let dir = scratch_dir("missing");
        let target = dir.join("never-written.html");
        let err = ensure_openable_html(&target).expect_err("文件不存在必须拒绝");
        assert_eq!(err.kind(), "not-found");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 名字像 HTML 的**目录**：扩展名这关过得去，必须栽在「是不是文件」这关上。
    #[test]
    fn rejects_directory_named_like_html() {
        let dir = scratch_dir("dir");
        let fake = dir.join("看起来像文件.html");
        std::fs::create_dir_all(&fake).expect("建目录应成功");

        assert!(has_openable_extension(&fake), "前提：扩展名这关是过的");
        let err = ensure_openable_html(&fake).expect_err("目录必须拒绝");
        assert_eq!(err.kind(), "not-found");
        assert!(err.to_string().contains("不是文件"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ── 预览落点命名 ─────────────────────────────────────────── */

    /// 同一篇恒定同名（浏览器刷新即更新，临时目录不堆垃圾）；
    /// 不同目录下的同名文档必须分开（否则会在标签页里读到另一篇）。
    #[test]
    fn preview_names_are_stable_and_collision_free() {
        let a = PathBuf::from(r"D:\a\README.md");
        let b = PathBuf::from(r"D:\b\README.md");

        let name_a = preview_file_name(Some(&a));
        assert_eq!(name_a, preview_file_name(Some(&a)), "同一路径必须恒定");
        assert!(name_a.starts_with("README-"), "{name_a}");
        assert!(name_a.ends_with(".html"), "{name_a}");
        assert_ne!(name_a, preview_file_name(Some(&b)), "同名不同目录必须分开");
    }

    /// Windows 语义：分隔符与大小写不影响身份，同一个文件只该有一份预览。
    #[test]
    fn preview_key_follows_windows_path_semantics() {
        assert_eq!(
            preview_key(Some(Path::new(r"D:\Notes\A.MD"))),
            preview_key(Some(Path::new("d:/notes/a.md")))
        );
        assert_ne!(
            preview_key(Some(Path::new(r"D:\a\x.md"))),
            preview_key(Some(Path::new(r"D:\b\x.md")))
        );
    }

    /// 文件名清洗：非法字符替换、中文保留、超长截断、空名兜底。
    #[test]
    fn sanitizes_preview_stem() {
        assert_eq!(sanitize_stem("我的 笔记"), "我的 笔记");
        assert_eq!(sanitize_stem("a?b*c|d"), "a_b_c_d");
        assert_eq!(sanitize_stem("  "), FALLBACK_PREVIEW_STEM);
        assert_eq!(sanitize_stem("名字."), "名字");
        assert_eq!(
            sanitize_stem(&"长".repeat(200)).chars().count(),
            PREVIEW_STEM_MAX_CHARS,
            "截断按字符数，不能把多字节字符切成半个"
        );
        // 无源文档时也要给出合法名字
        assert!(preview_file_name(None).starts_with(FALLBACK_PREVIEW_STEM));
    }

    /// FNV-1a 32 的标准测试向量：哈希一旦漂移，磁盘上就会换一批文件名。
    #[test]
    fn hashes_match_fnv1a_reference_vectors() {
        assert_eq!(fnv1a32(""), 0x811c_9dc5);
        assert_eq!(fnv1a32("a"), 0xe40c_292c);
        assert_eq!(fnv1a32("foobar"), 0xbf9c_f968);
    }

    /* ── 过期预览清理 ─────────────────────────────────────────── */

    /// 只删「自家目录里、.html/.htm、普通文件、超期、且不是本次落点」的东西，
    /// 一条不满足就必须留着。这是应用里少数会 remove_file 的地方，错删代价极高。
    #[test]
    fn prunes_only_expired_preview_artifacts() {
        let dir = scratch_dir("prune");
        let old = SystemTime::now() - PREVIEW_TTL - Duration::from_secs(3600);

        let write = |name: &str| {
            let path = dir.join(name);
            std::fs::write(&path, b"x").expect("写临时文件应成功");
            path
        };
        let age = |path: &Path| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .expect("打开临时文件应成功")
                .set_modified(old)
                .expect("改修改时间应成功");
        };

        let stale = write("stale.html");
        let stale_htm = write("stale.htm");
        let fresh = write("fresh.html");
        let keep = write("keep.html");
        let other = write("旧笔记.md");
        age(&stale);
        age(&stale_htm);
        age(&keep);
        age(&other);

        prune_stale_previews(&dir, &keep);

        assert!(!stale.exists(), "超期的 .html 应被清掉");
        assert!(!stale_htm.exists(), "超期的 .htm 应被清掉");
        assert!(fresh.exists(), "未超期的不能动");
        assert!(keep.exists(), "本次落点即便超期也不能动");
        assert!(other.exists(), "白名单之外的扩展名一律不碰");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 目录不存在时静默返回，不能 panic（清理是尽力而为，绝不打断主流程）。
    #[test]
    fn prune_tolerates_missing_directory() {
        let dir = std::env::temp_dir().join("mdnaonao-shell-integ-nonexistent-dir");
        let _ = std::fs::remove_dir_all(&dir);
        prune_stale_previews(&dir, &dir.join("keep.html"));
    }

    /// 落点必须落在自家临时子目录里 —— 清理的删除范围就是靠这个目录圈定的。
    #[test]
    fn preview_dir_lives_under_our_own_temp_subdir() {
        let dir = preview_dir();
        let expected_tail = Path::new(PREVIEW_ROOT_DIR).join(PREVIEW_SUB_DIR);
        assert!(dir.ends_with(&expected_tail), "{dir:?}");
        assert!(dir.starts_with(std::env::temp_dir()), "{dir:?}");
    }

    /* ── App Paths 默认值解析 ─────────────────────────────────── */

    /// 带引号 / 不带引号 / 前后空白都要认；指向不存在的文件必须当作「没装」。
    #[test]
    fn parses_app_paths_default_value() {
        let dir = scratch_dir("app-paths");
        let exe = dir.join("Code.exe");
        std::fs::write(&exe, b"stub").expect("写临时文件应成功");
        let shown = exe.display().to_string();

        assert_eq!(
            parse_app_paths_value(&shown).as_deref(),
            Some(exe.as_path())
        );
        assert_eq!(
            parse_app_paths_value(&format!("\"{shown}\"")).as_deref(),
            Some(exe.as_path()),
            "个别安装程序会把路径写成带引号的"
        );
        assert_eq!(
            parse_app_paths_value(&format!("  {shown}  ")).as_deref(),
            Some(exe.as_path())
        );

        // 卸载残留：键还在、exe 已经没了 —— 收下它就等于在菜单里放一个必然报错的条目
        let gone = dir.join("Gone.exe").display().to_string();
        assert_eq!(parse_app_paths_value(&gone), None);
        assert_eq!(parse_app_paths_value(""), None);
        assert_eq!(parse_app_paths_value("\"\""), None);
        // 目录不是可执行文件
        assert_eq!(parse_app_paths_value(&dir.display().to_string()), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ── 目标文件白名单 ───────────────────────────────────────── */

    /// 这条命令把文件交给**外部程序执行环境**，扩展名白名单是唯一的闸门，逐形态钉死。
    #[test]
    fn accepts_only_markdown_sources() {
        for good in [
            "a.md",
            "a.MD",
            "a.markdown",
            "a.mkdn",
            r"D:\笔记\我的 文档.mkd",
        ] {
            assert!(has_markdown_extension(Path::new(good)), "应放行：{good}");
        }
        for bad in [
            "a.exe",    // 这条白名单存在的全部理由
            "a.bat",    // 双击即执行
            "a",        // 无扩展名
            "a.",       // 光秃秃一个点
            ".md",      // 整串是文件名而非扩展名
            "a.md.exe", // 双扩展名 ——「以 .md 结尾」式判断会在这里破功
            "a.html",   // 导出产物走 open_in_browser，不走这里
            "a.mdx",    // 前缀相同不算
        ] {
            assert!(!has_markdown_extension(Path::new(bad)), "应拒绝：{bad}");
        }
    }

    /// 扩展名不合格时连磁盘都不该碰：路径根本不存在，报的却必须是白名单错误。
    #[test]
    fn rejects_non_markdown_before_touching_disk() {
        let err = ensure_markdown_source(Path::new(r"D:\不存在的目录\payload.exe"))
            .expect_err("非 Markdown 必须拒绝");
        assert_eq!(err.kind(), "config");
    }

    /// 存在的 .md 放行；不存在的报 not-found（而不是默默拉起编辑器开一个空文件）。
    #[test]
    fn accepts_existing_markdown_and_rejects_missing() {
        let dir = scratch_dir("source");
        let file = dir.join("我的 笔记.md");
        std::fs::write(&file, b"# hi").expect("写临时文件应成功");
        ensure_markdown_source(&file).expect("存在的 .md 应放行");

        let err = ensure_markdown_source(&dir.join("never.md")).expect_err("不存在必须拒绝");
        assert_eq!(err.kind(), "not-found");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ── editor 白名单 ───────────────────────────────────────── */

    /// 前端递过来的 exe 路径**不是凭据**：不在探测结果里的一律拒绝。
    /// 这条判断一旦破功，`open_in_editor` 就等于「以本应用身份执行任意程序」。
    #[test]
    fn rejects_editors_outside_detected_list() {
        let known = vec![EditorApp {
            id: "vscode".to_string(),
            name: "Visual Studio Code".to_string(),
            path: PathBuf::from(r"C:\Users\x\AppData\Local\Programs\Microsoft VS Code\Code.exe"),
            icon_data_url: None,
        }];

        assert!(is_known_editor(
            Path::new(r"C:\Users\x\AppData\Local\Programs\Microsoft VS Code\Code.exe"),
            &known
        ));
        // Windows 语义：分隔符与大小写不影响身份，否则前端写小写盘符就把自己挡在门外
        assert!(is_known_editor(
            Path::new("c:/users/x/appdata/local/programs/microsoft vs code/CODE.EXE"),
            &known
        ));

        for hostile in [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Users\x\Downloads\payload.exe",
            // 前缀相同也不行：路径比对是整串相等，不是 starts_with
            r"C:\Users\x\AppData\Local\Programs\Microsoft VS Code\Code.exe.exe",
        ] {
            assert!(!is_known_editor(Path::new(hostile), &known), "{hostile}");
        }
        // 一个都没探到时，什么都不该放行
        assert!(!is_known_editor(Path::new(r"C:\payload.exe"), &[]));
    }

    /* ── 顺序与探测结果 ───────────────────────────────────────── */

    /// 候选兜底表的顺序就是兜底段的菜单顺序：VS Code 系列在最前，记事本永远垫底。
    #[test]
    fn candidate_table_puts_vscode_first_and_notepad_last() {
        let exes: Vec<&str> = EDITOR_CANDIDATES
            .iter()
            .map(|candidate| candidate.exe)
            .collect();
        assert_eq!(exes.first().copied(), Some("Code.exe"));
        assert_eq!(exes.get(1).copied(), Some("Code - Insiders.exe"));
        assert_eq!(exes.last().copied(), Some("notepad.exe"));
        // exe 名兼作菜单项 id（小写化后），重了就是 React 渲染出问题
        let mut sorted: Vec<String> = exes.iter().map(|exe| exe.to_lowercase()).collect();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), exes.len(), "候选 exe 名必须互不重复");
    }

    /// 规则驱动探测（批次 5.7）的三条不变式：
    /// （a）逐个真实存在；（b）按路径去重；（c）绝不包含本应用自身。
    #[test]
    fn detected_editors_exist_dedupe_and_exclude_self() {
        let detected = detect_editors();
        let mut seen = std::collections::HashSet::new();
        for editor in &detected {
            assert!(
                editor.path.is_file(),
                "探测结果必须逐个 is_file 校验过：{editor:?}"
            );
            assert!(
                seen.insert(normalize_for_compare(&editor.path)),
                "同一路径出现两次：{detected:?}"
            );
            let stem = editor
                .path
                .file_stem()
                .map(|value| value.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            assert_ne!(stem, SELF_EXE_STEM, "探测结果包含了本应用自身：{detected:?}");
        }
    }

    /// 记事本是系统自带的兜底：它探不到，说明候选兜底那条退路整条坏了。
    /// （规则来源可能把别的编辑器排在它前面，但它必须**在**且在兜底段的最后。）
    #[cfg(windows)]
    #[test]
    fn notepad_is_the_always_available_fallback() {
        let detected = detect_editors();
        assert_eq!(
            detected.last().map(|editor| editor.id.as_str()),
            Some("notepad.exe"),
            "记事本必须探得到且垫底：{detected:?}"
        );
    }

    /// 图标提取全链路（SHGetFileInfo → WIC → base64）：拿系统必有的记事本当靶子。
    /// 只断言前缀与非空——PNG 字节因系统主题/版本而异，比内容就是比运气。
    #[cfg(windows)]
    #[test]
    fn extracts_notepad_icon_as_png_data_url() {
        let Some(notepad) = lookup_well_known(&[
            ("SystemRoot", r"System32\notepad.exe"),
            ("SystemRoot", "notepad.exe"),
        ]) else {
            return; // 极端精简镜像没有记事本：放弃断言而不是误报
        };
        let icon = editor_icon_data_url(&notepad).expect("记事本必须能提出图标");
        assert!(icon.starts_with("data:image/png;base64,"), "{icon:.60}");
        assert!(icon.len() > 100, "PNG 不该只有头没有身子");
    }

    /* ── OpenWith 规则来源的纯函数 ─────────────────────────────── */

    /// MRUList 顺序还原：列到的按序取，没列到的追加在尾。
    #[test]
    fn mru_ordering_follows_the_list_then_appends_rest() {
        let entries: Vec<(String, String)> = [
            ("a", "ima.exe"),
            ("b", "rider64.exe"),
            ("c", "Code.exe"),
            ("d", "stray.exe"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
        assert_eq!(
            order_by_mru(&entries, "cab"),
            vec!["Code.exe", "ima.exe", "rider64.exe", "stray.exe"]
        );
        // MRUList 缺失：按枚举顺序原样输出
        assert_eq!(order_by_mru(&entries, "").len(), 4);
    }

    /// open command 的三种历史写法都要能取出 exe：带引号带参、不带引号带参、纯路径。
    #[test]
    fn parses_open_command_variants() {
        let dir = scratch_dir("open-command");
        let spaced = dir.join("sub dir");
        std::fs::create_dir_all(&spaced).unwrap();
        let exe = spaced.join("editor.exe");
        std::fs::write(&exe, [0u8; 4]).unwrap();
        let exe_str = exe.to_string_lossy();

        assert_eq!(
            parse_command_exe(&format!("\"{exe_str}\" \"%1\"")),
            Some(exe.clone())
        );
        assert_eq!(
            parse_command_exe(&format!("{exe_str} %1")),
            Some(exe.clone())
        );
        assert_eq!(parse_command_exe(&exe_str), Some(exe.clone()));
        // 指向不存在的程序：一律当「没装」
        assert_eq!(parse_command_exe(r#""C:\nope\editor.exe" "%1""#), None);
        assert_eq!(parse_command_exe(""), None);

        std::fs::remove_dir_all(&dir).ok();
    }
}

// ---------------------------------------------------------------------------
// 「用其他编辑器打开源文件」——系统「打开方式」对话框
// ---------------------------------------------------------------------------

/// 弹出 Windows 的「打开方式」对话框（`ShellExecuteW` 的 `openas` 动词）。
///
/// # 为什么不是 `open_path`
///
/// 这个菜单项叫「用**其他**编辑器打开」，UPGRADE_PLAN 3.3 写的也是「交系统『打开方式』」。
/// 而 `open_path` 打开的是**默认程序**——一旦用户把 .md 关联给了本应用（这正是我们
/// 引导用户去做的事），点它就等于打开自己：单实例把当前窗口拉到前台，
/// 屏幕上什么都没发生。用户报的「点击后根本没反应」就是这个。
/// 「打开方式」对话框才是这个菜单项的正确语义：它把选择权交回用户。
///
/// # 它现在的定位
///
/// 探测式的编辑器清单（[`list_editors`]）落地后，这条路成了子菜单末尾的
/// 「其他程序…」：**用户想用的编辑器不在探测名单里时的出路**。保留它是因为
/// 探测表永远列不全（自编译的 vim、公司自研的编辑器、绿色版），
/// 而「打开方式」对话框把选择权完整交回用户，不需要我们认识那个程序。
///
/// # 安全边界
///
/// 只接受本应用支持的 Markdown 扩展名（[`ensure_markdown_source`]）。
/// 与 [`open_in_browser`] 同理：自家 command 不走 ACL，这条白名单是唯一的检查。
/// `openas` 只是弹选择框、由用户点确认，比直接执行更保守，但仍不该放开任意扩展名。
#[tauri::command]
pub async fn open_with_dialog(path: PathBuf) -> AppResult<()> {
    ensure_markdown_source(&path)?;

    tauri::async_runtime::spawn_blocking(move || open_as_dialog(&path))
        .await
        .map_err(|err| AppError::native(format!("「打开方式」任务失败：{err}")))?
}

/// `ShellExecuteW(nullptr, "openas", path, nullptr, nullptr, SW_SHOWNORMAL)`。
///
/// 【为什么手写 extern 而不用 `windows` crate】与 `share::hdrop` 同一个理由：
/// `Win32::UI::Shell::ShellExecuteW` 需要 `Win32_UI_Shell` feature，而 Cargo.toml 里没开，
/// 加 feature 属改动依赖清单（红线 12 要求先申请）。这里只用一个函数、三个常量，
/// 手写十行 extern 比动依赖便宜得多。
#[cfg(windows)]
fn open_as_dialog(path: &Path) -> AppResult<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    /// `SHELLEXECUTEINFOW`（x64 下 112 字节，由 repr(C) 自然对齐算出，无需手填 padding）。
    /// 字段顺序与 MSDN 逐个对应，未用到的一律置零/空指针。
    #[allow(non_snake_case)]
    #[repr(C)]
    struct ShellExecuteInfoW {
        cbSize: u32,
        fMask: u32,
        hwnd: *mut c_void,
        lpVerb: *const u16,
        lpFile: *const u16,
        lpParameters: *const u16,
        lpDirectory: *const u16,
        nShow: i32,
        hInstApp: *mut c_void,
        lpIDList: *mut c_void,
        lpClass: *const u16,
        hkeyClass: *mut c_void,
        dwHotKey: u32,
        hIconOrMonitor: *mut c_void,
        hProcess: *mut c_void,
    }

    #[allow(non_snake_case)]
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfoW) -> i32;
    }

    /// 【这一位是整件事的关键】没有它，`openas` 在现代 Windows 上直接返回
    /// 31（SE_ERR_NOASSOC）——字面意思是「没有关联程序」，把人往完全错误的方向带
    /// （.md 明明有关联程序）。`openas` 由 Shell 的上下文菜单动词处理器实现，
    /// 必须让 Shell 先构造出 item ID list 才轮得到它，这一位就是干这个的。
    /// 2026-08-18 实测：裸 `ShellExecuteW` + "openas" 必失败，换成本函数后正常弹框。
    const SEE_MASK_INVOKEIDLIST: u32 = 0x0000_000C;
    /// 让调用**同步**等到动词执行完再返回。
    ///
    /// 不加它，`ShellExecuteExW` 立刻返回、Shell 在后台继续干活；调用方一旦很快退出，
    /// 对话框还没来得及出现就随之消失（实测：短生命周期的测试进程里返回成功但屏幕上什么都没有）。
    /// 本应用是长驻进程，理论上不加也能出框，但这条链路本来就跑在
    /// `spawn_blocking` 的阻塞线程上，同步等待零代价，不值得赌进程生命周期。
    const SEE_MASK_NOASYNC: u32 = 0x0000_0100;
    const SW_SHOWNORMAL: i32 = 1;

    // 【COM 也必须先起来】本函数跑在 spawn_blocking 的 tokio 工作线程上，那里没有 COM 单元。
    // MSDN：「调用 ShellExecute 前应初始化 COM，部分 Shell 扩展要求 STA」——
    // 「打开方式」正是这样一个扩展。RAII 保证配对，中途 return 也不会漏掉 CoUninitialize；
    // 已在别的模式下初始化过（RPC_E_CHANGED_MODE）时不重复反初始化，那会把别人的单元拆了。
    struct ComGuard {
        should_uninit: bool,
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.should_uninit {
                // SAFETY: 与本线程上成功的 CoInitializeEx 一一配对
                unsafe { windows::Win32::System::Com::CoUninitialize() };
            }
        }
    }
    // SAFETY: 标准 COM 初始化，入参为 null + STA 标志，不涉及任何自有指针
    let com_result = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
        )
    };
    let _com = ComGuard {
        should_uninit: com_result.is_ok(),
    };
    if com_result.is_err() {
        tracing::warn!(hr = ?com_result, "CoInitializeEx 未成功，仍尝试弹出「打开方式」");
    }

    let verb: Vec<u16> = "openas".encode_utf16().chain(std::iter::once(0)).collect();
    let file: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut info = ShellExecuteInfoW {
        cbSize: std::mem::size_of::<ShellExecuteInfoW>() as u32,
        fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_NOASYNC,
        hwnd: std::ptr::null_mut(),
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: std::ptr::null(),
        lpDirectory: std::ptr::null(),
        nShow: SW_SHOWNORMAL,
        hInstApp: std::ptr::null_mut(),
        lpIDList: std::ptr::null_mut(),
        lpClass: std::ptr::null(),
        hkeyClass: std::ptr::null_mut(),
        dwHotKey: 0,
        hIconOrMonitor: std::ptr::null_mut(),
        hProcess: std::ptr::null_mut(),
    };

    // SAFETY: info 是本函数栈上的完整结构，cbSize 已按实际大小填写；
    // verb / file 两个宽字符缓冲同样在栈上、以 NUL 结尾，存活到调用返回。
    // ShellExecuteExW 只读它们，不获取所有权。
    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        let code = std::io::Error::last_os_error();
        return Err(AppError::native(format!(
            "「打开方式」对话框未能弹出（ShellExecuteExW 失败：{code}）：{}",
            path.display()
        )));
    }
    tracing::info!(path = %path.display(), "已弹出「打开方式」对话框");
    Ok(())
}

#[cfg(not(windows))]
fn open_as_dialog(path: &Path) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "「打开方式」对话框仅 Windows 可用：{}",
        path.display()
    )))
}

// ---------------------------------------------------------------------------
// 「用其他编辑器打开」——探测本机已装编辑器，直接拉起
// ---------------------------------------------------------------------------
//
// 为什么在「打开方式」对话框之外还要这一套：用户说的是「我要在 VS Code 里打开」，
// 不是「我要在系统列表里再翻一遍」。`openas` 每次都从零开始让人挑，
// 挑完还不记住（那个对话框的「始终使用」会改默认程序，而默认程序我们不碰，红线 2），
// 于是「用其他编辑器打开」实际是每次三四步点击。探测出来直接列在菜单里才是一步到位。

/// App Paths 注册表根。**只读**——本模块的注册表写入闸门与它无关，
/// 因为这里从头到尾一个字节都不写（红线 2）。
///
/// 这是 Windows 官方登记「某个 exe 装在哪」的地方：安装程序自己写、卸载时自己删，
/// 比我们猜安装目录可靠得多。
pub const APP_PATHS_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";

/// 一个本机可用的外部编辑器（探测结果，直接喂给右键子菜单）。
///
/// `name` 是**产品名**（Visual Studio Code / Notepad++），不是可译文案，
/// 因此由后端给出、不进前端 i18n：翻译一个产品名只会翻错。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorApp {
    /// 稳定标识（菜单项 id、日志用）= exe 文件名小写
    pub id: String,
    /// 菜单里显示的产品名
    pub name: String,
    /// 可执行文件绝对路径（已 `is_file()` 校验）
    pub path: PathBuf,
    /// 应用真实图标的 `data:image/png;base64,…`（批次 5.7）。
    /// 只在 [`list_editors`]（菜单展示）时提取；open_in_editor 的白名单复探不带它。
    /// 提不出来（无图标资源/WIC 失败）为 None，前端退回通用图标槽。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

/// 一个候选编辑器的探测配方。
/// （曾有 `id` 字段作菜单项标识；规则驱动探测后 id 统一取 exe 文件名小写，字段随之删除。）
struct EditorCandidate {
    name: &'static str,
    /// App Paths 下的键名（首选探测方式）
    exe: &'static str,
    /// 众所周知的安装位置：`(环境变量名, 相对该目录的子路径)`，按可能性从高到低。
    /// **一律用环境变量拼**，不写死 `C:\Program Files`——换个系统盘就全废。
    well_known: &'static [(&'static str, &'static str)],
}

/// 候选兜底表（2026-08-19 批次 5.7 起**不再是主来源**，主来源是系统 OpenWith 登记，
/// 见 [`detect_editors`]）。它兜住的是「装了、但从没用系统『打开方式』打开过 .md」
/// 的常见编辑器——这类程序不会出现在 OpenWith 登记里，但用户大概率想要。
/// 顺序仍然有意义：兜底部分按此排列，记事本永远垫底（保证子菜单永不为空）。
static EDITOR_CANDIDATES: [EditorCandidate; 7] = [
    EditorCandidate {
        name: "Visual Studio Code",
        exe: "Code.exe",
        // 用户级安装（默认）落 %LOCALAPPDATA%，System 版才在 Program Files
        well_known: &[
            ("LOCALAPPDATA", r"Programs\Microsoft VS Code\Code.exe"),
            ("ProgramFiles", r"Microsoft VS Code\Code.exe"),
            ("ProgramFiles(x86)", r"Microsoft VS Code\Code.exe"),
        ],
    },
    EditorCandidate {
        name: "Visual Studio Code Insiders",
        exe: "Code - Insiders.exe",
        well_known: &[
            (
                "LOCALAPPDATA",
                r"Programs\Microsoft VS Code Insiders\Code - Insiders.exe",
            ),
            (
                "ProgramFiles",
                r"Microsoft VS Code Insiders\Code - Insiders.exe",
            ),
        ],
    },
    EditorCandidate {
        name: "Cursor",
        exe: "Cursor.exe",
        well_known: &[
            ("LOCALAPPDATA", r"Programs\cursor\Cursor.exe"),
            ("ProgramFiles", r"cursor\Cursor.exe"),
        ],
    },
    EditorCandidate {
        name: "Sublime Text",
        exe: "sublime_text.exe",
        well_known: &[
            ("ProgramFiles", r"Sublime Text\sublime_text.exe"),
            ("ProgramFiles", r"Sublime Text 3\sublime_text.exe"),
            ("ProgramFiles(x86)", r"Sublime Text 3\sublime_text.exe"),
        ],
    },
    EditorCandidate {
        name: "Notepad++",
        exe: "notepad++.exe",
        // 32 位版装在 Program Files (x86) 相当常见，两处都要探
        well_known: &[
            ("ProgramFiles", r"Notepad++\notepad++.exe"),
            ("ProgramFiles(x86)", r"Notepad++\notepad++.exe"),
        ],
    },
    EditorCandidate {
        name: "Typora",
        exe: "Typora.exe",
        well_known: &[
            ("LOCALAPPDATA", r"Programs\Typora\Typora.exe"),
            ("ProgramFiles", r"Typora\Typora.exe"),
        ],
    },
    EditorCandidate {
        name: "记事本",
        exe: "notepad.exe",
        // 兜底项：系统自带，保证子菜单永远不是空的。
        // %SystemRoot%\notepad.exe 在 Win11 22H2 起已移除，所以 System32 排前面。
        well_known: &[
            ("SystemRoot", r"System32\notepad.exe"),
            ("SystemRoot", "notepad.exe"),
        ],
    },
];

/// 探测本机已安装的编辑器，供右键子菜单直接列出。
///
/// 探不到的一律不回传：菜单里出现一个点了报「找不到程序」的条目，
/// 比根本没有这一项更糟（DG 6.4 全局条 B）。
#[tauri::command]
pub async fn list_editors() -> AppResult<Vec<EditorApp>> {
    // 注册表 + 一串 stat + 图标提取：都是阻塞 IO，不该占 async 运行时的工作线程
    tauri::async_runtime::spawn_blocking(|| detect_editors_with(true))
        .await
        .map_err(|err| AppError::native(format!("探测本机编辑器失败：{err}")))
}

/// 用**指定**编辑器打开源文件（右键「用其他编辑器打开 ▸ Visual Studio Code」）。
///
/// # 安全边界：两条白名单，缺一条这命令就是「以本应用身份执行任意程序」
///
/// 1. `path` 只接受本应用支持的 Markdown 扩展名（[`ensure_markdown_source`]，
///    与 [`open_with_dialog`] 同一份清单）；
/// 2. `editor` **必须是 [`detect_editors`] 当场探测出来的路径之一**。
///
/// 第 2 条是重点：本项目没有 app ACL manifest，自家 `#[tauri::command]` 不做权限检查
/// （理由详见 [`open_in_browser`]），前端递过来的 `editor` 就是渲染层可以完全控制的一个字符串。
/// 若原样交给 `Command::new`，渲染层一旦被注入，`C:\...\payload.exe` 就以本进程的身份跑起来了。
/// 因此这里**不信任前端传来的任何 exe 路径**，而是重新探测一遍做白名单比对——
/// 前端那份列表只是 UI 缓存，不是凭据。重新探测的成本是几次注册表读 + 几次 stat，
/// 相对「点一下菜单」这个频次可以忽略。
#[tauri::command]
pub async fn open_in_editor(editor: PathBuf, path: PathBuf) -> AppResult<()> {
    ensure_markdown_source(&path)?;

    tauri::async_runtime::spawn_blocking(move || {
        let known = detect_editors();
        if !is_known_editor(&editor, &known) {
            tracing::warn!(
                editor = %editor.display(),
                "拒绝拉起：不在本机探测出的编辑器名单里"
            );
            return Err(AppError::config(format!(
                "只能用本机探测到的编辑器打开，收到：{}",
                editor.display()
            )));
        }
        spawn_editor(&editor, &path)
    })
    .await
    .map_err(|err| AppError::native(format!("拉起编辑器任务失败：{err}")))?
}

/// 本应用自己的 exe 名主干：探测结果里必须排除自己——
/// 「用其他编辑器打开」列出本应用，点了等于单实例把自己拉到前台，什么都没发生。
const SELF_EXE_STEM: &str = "mdnaonao";

/// HKCU 下 .md 的「打开方式」记录（Explorer 维护：OpenWithList 是用户实际用过的
/// 程序 + MRU 顺序，OpenWithProgids 是各应用安装时登记的能力）。**只读**。
const FILE_EXTS_MD_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md";

/// 探测「能打开 .md 的编辑器」（批次 5.7 起为**规则驱动**，不再是手写名单）：
///
/// 规则 = 与资源管理器「打开方式」同一数据源，检测到什么菜单就列什么：
/// 1. **HKCU FileExts\.md\OpenWithList**（用户用系统对话框打开过 .md 的程序），
///    按 MRUList 顺序——最常用的排最前。这也回答了「怎么增加」：
///    用「其他程序…」选一次，Windows 记下它，下次它就自动出现在这里；
/// 2. **OpenWithProgids**（HKCU FileExts + HKCR\.md）：各应用安装时登记的 .md 能力
///    （装了但没用系统对话框打开过的也在此现身）；
/// 3. [`EDITOR_CANDIDATES`] 兜底：装了却两处都没登记的常见编辑器（+记事本垫底）。
///
/// 三源按序合并、按路径去重、排除本应用自身。显示名走
/// FriendlyAppName → exe 版本信息 FileDescription（系统「打开方式」同源）→ 候选表名 → 文件名。
///
/// 白名单复探（open_in_editor）走这个不带图标的入口——比对只看路径，
/// 每次点菜单都抽一轮图标纯属浪费。
fn detect_editors() -> Vec<EditorApp> {
    detect_editors_with(false)
}

fn detect_editors_with(include_icons: bool) -> Vec<EditorApp> {
    let mut found: Vec<EditorApp> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 来源 1：OpenWithList（MRU 顺序 = 菜单顺序的最前段）
    for token in open_with_list_mru() {
        if token
            .trim_end_matches(".exe")
            .eq_ignore_ascii_case(SELF_EXE_STEM)
        {
            continue;
        }
        if let Some(path) = resolve_exe_token(&token) {
            push_editor(&mut found, &mut seen, &token, path, include_icons);
        }
    }

    // 来源 2：OpenWithProgids（登记过 .md 能力的应用）
    for progid in open_with_progids() {
        let Some(command) = progid_command(&progid) else {
            continue;
        };
        if let Some(path) = parse_command_exe(&command) {
            let token = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            push_editor(&mut found, &mut seen, &token, path, include_icons);
        }
    }

    // 来源 3：候选兜底表（装了但没在系统里登记 .md 的常见编辑器；记事本垫底）
    for candidate in &EDITOR_CANDIDATES {
        let located =
            lookup_app_paths(candidate.exe).or_else(|| lookup_well_known(candidate.well_known));
        let Some(path) = located else {
            continue;
        };
        push_editor(&mut found, &mut seen, candidate.exe, path, include_icons);
    }

    tracing::info!(count = found.len(), "编辑器探测完成（OpenWith 规则 + 候选兜底）");
    found
}

/// 去重（按归一化全路径）+ 排除自身 + 解析显示名后入表。
fn push_editor(
    found: &mut Vec<EditorApp>,
    seen: &mut std::collections::HashSet<String>,
    exe_token: &str,
    path: PathBuf,
    include_icons: bool,
) {
    let stem_is_self = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().eq_ignore_ascii_case(SELF_EXE_STEM))
        .unwrap_or(false);
    if stem_is_self {
        return;
    }
    let key = normalize_for_compare(&path);
    if !seen.insert(key) {
        return;
    }
    let name = display_name(&path, exe_token);
    // id 用 exe 文件名小写：稳定、可读，且天然与去重后的条目一一对应
    let id = path
        .file_name()
        .map(|file| file.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| exe_token.to_lowercase());
    let icon_data_url = if include_icons {
        editor_icon_data_url(&path)
    } else {
        None
    };
    tracing::debug!(editor = %name, path = %path.display(), "已探测到编辑器");
    found.push(EditorApp {
        id,
        name,
        path,
        icon_data_url,
    });
}

/// OpenWithList：值名是 a/b/c… 单字母，值数据是 exe 文件名，MRUList 记顺序。
#[cfg(windows)]
fn open_with_list_mru() -> Vec<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(format!(r"{FILE_EXTS_MD_KEY}\OpenWithList"))
    else {
        return Vec::new();
    };
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut mru = String::new();
    for (name, value) in key.enum_values().flatten() {
        let text = String::from_utf16_lossy(
            &value
                .bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<u16>>(),
        )
        .trim_end_matches('\0')
        .to_string();
        if name.eq_ignore_ascii_case("MRUList") {
            mru = text;
        } else if name.len() == 1 && !text.is_empty() {
            entries.push((name, text));
        }
    }
    order_by_mru(&entries, &mru)
}

#[cfg(not(windows))]
fn open_with_list_mru() -> Vec<String> {
    Vec::new()
}

/// 按 MRUList（如 "cfeabd"）排序：列出的字母按序取值，没列到的追加在末尾。
fn order_by_mru(entries: &[(String, String)], mru: &str) -> Vec<String> {
    let mut ordered = Vec::with_capacity(entries.len());
    for slot in mru.chars() {
        if let Some((_, value)) = entries
            .iter()
            .find(|(name, _)| name.chars().next().is_some_and(|c| c == slot))
        {
            ordered.push(value.clone());
        }
    }
    for (name, value) in entries {
        if !mru.contains(name.chars().next().unwrap_or('\0')) {
            ordered.push(value.clone());
        }
    }
    ordered
}

/// OpenWithProgids 的值名集合（HKCU FileExts 与 HKCR\.md 两处并集，顺序 HKCU 先）。
#[cfg(windows)]
fn open_with_progids() -> Vec<String> {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
    use winreg::RegKey;

    let mut result: Vec<String> = Vec::new();
    let mut push_names = |key: winreg::RegKey| {
        for name in key.enum_values().flatten().map(|(name, _)| name) {
            if !name.is_empty() && !result.iter().any(|item| item.eq_ignore_ascii_case(&name)) {
                result.push(name);
            }
        }
    };
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(format!(r"{FILE_EXTS_MD_KEY}\OpenWithProgids"))
    {
        push_names(key);
    }
    if let Ok(key) = RegKey::predef(HKEY_CLASSES_ROOT).open_subkey(r".md\OpenWithProgids") {
        push_names(key);
    }
    result
}

#[cfg(not(windows))]
fn open_with_progids() -> Vec<String> {
    Vec::new()
}

/// `HKCR\Applications\{exe}\shell\open\command` 的默认值。
#[cfg(windows)]
fn application_command(exe: &str) -> Option<String> {
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(format!(r"Applications\{exe}\shell\open\command"))
        .ok()?
        .get_value::<String, _>("")
        .ok()
}

#[cfg(not(windows))]
fn application_command(_exe: &str) -> Option<String> {
    None
}

/// `HKCR\{progid}\shell\open\command` 的默认值。
#[cfg(windows)]
fn progid_command(progid: &str) -> Option<String> {
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(format!(r"{progid}\shell\open\command"))
        .ok()?
        .get_value::<String, _>("")
        .ok()
}

#[cfg(not(windows))]
fn progid_command(_progid: &str) -> Option<String> {
    None
}

/// 把 OpenWithList 里的 exe 文件名解析成绝对路径：
/// Applications 的 open command（安装器登记的首选）→ App Paths。两处都查不到就放弃。
fn resolve_exe_token(exe: &str) -> Option<PathBuf> {
    if let Some(command) = application_command(exe) {
        if let Some(path) = parse_command_exe(&command) {
            return Some(path);
        }
    }
    lookup_app_paths(exe)
}

/// 从 `"C:\x y\a.exe" "%1"` 或 `C:\x y\a.exe %1` 里取出 exe 路径（**存在性校验**）。
///
/// 未加引号且路径带空格的历史写法：从右往左逐个空格断开试 `is_file`，
/// 第一个存在的前缀即答案（`C:\Program Files\X\y.exe %1` 会先试全串再试去掉 %1 的前缀）。
fn parse_command_exe(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('"') {
        let end = rest.find('"')?;
        let path = PathBuf::from(rest[..end].trim());
        return path.is_file().then_some(path);
    }
    let mut candidate = trimmed;
    loop {
        let path = Path::new(candidate);
        if path.is_file() {
            return Some(path.to_path_buf());
        }
        let cut = candidate.rfind(' ')?;
        candidate = candidate[..cut].trim_end();
        if candidate.is_empty() {
            return None;
        }
    }
}

/// 显示名解析链（与系统「打开方式」同一取向）：
/// FriendlyAppName → exe 版本信息 FileDescription → 候选表的产品名 → exe 文件名主干。
fn display_name(path: &Path, exe_token: &str) -> String {
    if let Some(friendly) = friendly_app_name(exe_token) {
        return friendly;
    }
    if let Some(description) = file_description(path) {
        return description;
    }
    if let Some(candidate) = EDITOR_CANDIDATES
        .iter()
        .find(|candidate| candidate.exe.eq_ignore_ascii_case(exe_token))
    {
        return candidate.name.to_string();
    }
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| exe_token.to_string())
}

/// `HKCR\Applications\{exe}\FriendlyAppName`（`@dll,-id` 形式的间接串直接放弃——
/// 解析它要 SHLoadIndirectString，版本信息链已经够用，不为边角多拉一个 API）。
#[cfg(windows)]
fn friendly_app_name(exe: &str) -> Option<String> {
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    let raw = RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(format!(r"Applications\{exe}"))
        .ok()?
        .get_value::<String, _>("FriendlyAppName")
        .ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty() && !trimmed.starts_with('@')).then(|| trimmed.to_string())
}

#[cfg(not(windows))]
fn friendly_app_name(_exe: &str) -> Option<String> {
    None
}

/// exe 版本信息里的 FileDescription（「打开方式」列表显示名的来源）。
/// 语言取 \VarFileInfo\Translation 的第一组，取不到退回美英 0409/04B0。
#[cfg(windows)]
fn file_description(path: &Path) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };

    let wide = HSTRING::from(path.as_os_str());
    let size = unsafe { GetFileVersionInfoSizeW(&wide, None) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    unsafe { GetFileVersionInfoW(&wide, None, size, buffer.as_mut_ptr().cast()) }.ok()?;

    let mut value: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut len: u32 = 0;
    let translation = unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast(),
            &HSTRING::from(r"\VarFileInfo\Translation"),
            &mut value,
            &mut len,
        )
    };
    let (lang, codepage) = if translation.as_bool() && len >= 4 && !value.is_null() {
        let words = unsafe { std::slice::from_raw_parts(value.cast::<u16>(), 2) };
        (words[0], words[1])
    } else {
        (0x0409, 0x04B0)
    };

    let query = format!(r"\StringFileInfo\{lang:04X}{codepage:04X}\FileDescription");
    let mut text_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut text_len: u32 = 0;
    let ok = unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast(),
            &HSTRING::from(query.as_str()),
            &mut text_ptr,
            &mut text_len,
        )
    };
    if !ok.as_bool() || text_ptr.is_null() || text_len == 0 {
        return None;
    }
    let slice = unsafe { std::slice::from_raw_parts(text_ptr.cast::<u16>(), text_len as usize) };
    let text = String::from_utf16_lossy(slice)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(not(windows))]
fn file_description(_path: &Path) -> Option<String> {
    None
}

/// 应用真实图标 → `data:image/png;base64,…`（批次 5.7，用户点名要系统同款图标）。
///
/// 链路全部是 Windows 自带能力（红线 12：零新 crate）：
/// `SHGetFileInfoW` 取 32px HICON（16px 槽在 150% DPI 下用 32px 源更锐）→
/// WIC `CreateBitmapFromHICON` → WIC PNG 编码器写进内存流 → 自家 base64。
/// 任何一步失败都回 None：菜单退回空图标槽，绝不因图标毁掉整个列表。
#[cfg(windows)]
fn editor_icon_data_url(path: &Path) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatPng, IWICBitmapFrameEncode,
        IWICImagingFactory, WICBitmapEncoderNoCache,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        CreateStreamOnHGlobal, GetHGlobalFromStream, IPropertyBag2,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    // spawn_blocking 线程不保证初始化过 COM；S_FALSE（已初始化）也要配对 CoUninitialize，
    // RPC_E_CHANGED_MODE（线程已是 MTA）则继续用现成的，不配对
    let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let must_uninit = com.is_ok();

    let result = (|| -> Option<String> {
        let mut info = SHFILEINFOW::default();
        let wide = HSTRING::from(path.as_os_str());
        let got = unsafe {
            SHGetFileInfoW(
                &wide,
                Default::default(),
                Some(&mut info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        if got == 0 || info.hIcon.is_invalid() {
            return None;
        }

        let encoded = (|| -> Option<Vec<u8>> {
            let factory: IWICImagingFactory =
                unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
                    .ok()?;
            let bitmap = unsafe { factory.CreateBitmapFromHICON(info.hIcon) }.ok()?;
            let stream =
                unsafe { CreateStreamOnHGlobal(windows::Win32::Foundation::HGLOBAL::default(), true) }
                    .ok()?;
            let encoder =
                unsafe { factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()) }.ok()?;
            unsafe { encoder.Initialize(&stream, WICBitmapEncoderNoCache) }.ok()?;

            let mut frame: Option<IWICBitmapFrameEncode> = None;
            let mut options: Option<IPropertyBag2> = None;
            unsafe { encoder.CreateNewFrame(&mut frame, &mut options) }.ok()?;
            let frame = frame?;
            unsafe { frame.Initialize(options.as_ref()) }.ok()?;
            unsafe { frame.WriteSource(&bitmap, std::ptr::null()) }.ok()?;
            unsafe { frame.Commit() }.ok()?;
            unsafe { encoder.Commit() }.ok()?;

            let hglobal = unsafe { GetHGlobalFromStream(&stream) }.ok()?;
            let size = unsafe { GlobalSize(hglobal) };
            if size == 0 {
                return None;
            }
            let locked = unsafe { GlobalLock(hglobal) };
            if locked.is_null() {
                return None;
            }
            let bytes =
                unsafe { std::slice::from_raw_parts(locked.cast::<u8>(), size) }.to_vec();
            let _ = unsafe { GlobalUnlock(hglobal) };
            Some(bytes)
        })();

        let _ = unsafe { DestroyIcon(info.hIcon) };
        let png = encoded?;
        Some(format!(
            "data:image/png;base64,{}",
            crate::export::encode_base64(&png)
        ))
    })();

    if must_uninit {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(not(windows))]
fn editor_icon_data_url(_path: &Path) -> Option<String> {
    None
}

/// 读 `App Paths\<exe>` 的默认值：**HKCU 优先，其次 HKLM**，最后补一次 32 位视图。
///
/// 纪律照抄事实库 #4（那条原文说的是 msedge.exe，道理对任何 exe 都一样）：
/// * HKCU 优先——VS Code / Cursor / Typora 默认都是**用户级安装**，
///   HKLM 下要么没这个键，要么指向另一份（更旧的）安装；
/// * 探不到就是没装，**跳过它，不要猜一个路径去试**。
///
/// 第三次用 `KEY_WOW64_32KEY` 再读一遍：App Paths 对 32 位程序做注册表重定向，
/// 本进程是 64 位，默认视图里看不到 32 位版 Notepad++ 之类写下的键。
#[cfg(windows)]
fn lookup_app_paths(exe: &str) -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    use winreg::RegKey;

    let subkey = format!(r"{APP_PATHS_KEY}\{exe}");
    for (root, flags, hive) in [
        (HKEY_CURRENT_USER, KEY_READ, "HKCU"),
        (HKEY_LOCAL_MACHINE, KEY_READ, "HKLM"),
        (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_32KEY, "HKLM32"),
    ] {
        let Ok(key) = RegKey::predef(root).open_subkey_with_flags(&subkey, flags) else {
            continue;
        };
        // App Paths 的**默认值**（空名）就是可执行文件全路径，个别写入方会带引号
        let Ok(raw) = key.get_value::<String, _>("") else {
            continue;
        };
        if let Some(path) = parse_app_paths_value(&raw) {
            tracing::debug!(hive, exe, path = %path.display(), "App Paths 命中");
            return Some(path);
        }
        tracing::debug!(hive, exe, raw = %raw, "App Paths 记录的路径不存在（卸载残留？）");
    }
    None
}

#[cfg(not(windows))]
fn lookup_app_paths(_exe: &str) -> Option<PathBuf> {
    None
}

/// 把 App Paths 默认值那串原始文本变成可用路径：去空白 → 去引号 → **存在性校验**。
///
/// 最后一步不能省：卸载程序删主体却漏删这个键是常事，
/// 照单全收的话菜单里就会多一个「点了说找不到文件」的条目。
fn parse_app_paths_value(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    path.is_file().then_some(path)
}

/// App Paths 查不到时的退路：拼几个众所周知的安装位置试一试。
///
/// 只用环境变量拼（`%LOCALAPPDATA%` / `%ProgramFiles%` / `%ProgramFiles(x86)%` / `%SystemRoot%`）。
/// 硬编码 `C:\Program Files` 在换过系统盘、企业定制镜像、非英文系统上都会打脸——
/// 这正是事实库 #4 点名要避免的那种写法。
fn lookup_well_known(candidates: &[(&str, &str)]) -> Option<PathBuf> {
    for (variable, relative) in candidates {
        let Ok(base) = std::env::var(variable) else {
            continue;
        };
        if base.trim().is_empty() {
            continue;
        }
        let path = PathBuf::from(base.trim()).join(relative);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// 按 Windows 路径语义归一化（分隔符统一 + 大小写不敏感），只用于比较。
///
/// 与 [`preview_key`] 同一套理由：`D:\A\Code.exe` 与 `d:/a/code.exe` 在 Windows 上是同一个文件，
/// 白名单比对若认字节串，前端把盘符写成小写就能把自己挡在门外。
fn normalize_for_compare(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// `editor` 是否确实是本次探测结果之一（[`open_in_editor`] 的白名单闸门）。
///
/// 拆成独立函数是为了能单测：这条判断错了，命令就退化成「执行任意程序」。
fn is_known_editor(editor: &Path, known: &[EditorApp]) -> bool {
    let wanted = normalize_for_compare(editor);
    known
        .iter()
        .any(|candidate| normalize_for_compare(&candidate.path) == wanted)
}

/// 目标扩展名是否是本应用支持的 Markdown（大小写不敏感）。
///
/// 用 `Path::extension` 而不是「字符串以 .md 结尾」，理由与
/// [`has_openable_extension`] 相同：后者会放行 `payload.md.exe`。
fn has_markdown_extension(path: &Path) -> bool {
    let Some(extension) = path.extension() else {
        return false;
    };
    let extension = extension.to_string_lossy().to_ascii_lowercase();
    crate::files::SUPPORTED_EXTENSIONS.contains(&extension.as_str())
}

/// 「把源文档交给外部程序」这件事的统一闸门：扩展名白名单 → 存在 → 是文件。
///
/// [`open_with_dialog`]（弹选择框）与 [`open_in_editor`]（直接拉起）共用它。
/// 两条路通向同一件事，检查只该有一份：分成两份的下场是将来只收紧其中一条。
/// 校验顺序刻意是「先扩展名、后存在性」——扩展名不合格的目标连 `stat` 都不该发生。
fn ensure_markdown_source(path: &Path) -> AppResult<()> {
    if !has_markdown_extension(path) {
        tracing::warn!(path = %path.display(), "拒绝交给外部程序：不是 Markdown 源文件");
        return Err(AppError::config(format!(
            "「用其他编辑器打开」只接受 Markdown 文件（{}），收到：{}",
            crate::files::SUPPORTED_EXTENSIONS.join(" / "),
            path.display()
        )));
    }
    if !path.is_file() {
        return Err(AppError::not_found(format!(
            "文件不存在或已被移动：{}",
            path.display()
        )));
    }
    Ok(())
}

/// 直接拉起 `<editor> <path>`。
///
/// # 为什么不经 shell、不拼命令行字符串
///
/// 参数以**独立 `arg`** 传入，标准库在 Windows 上按 `CommandLineToArgvW` 的规则自行加引号转义；
/// 我们从不自己拼一整行命令，也不经 `cmd /c`。于是文件名里的空格 / 中文 / `&` / `"`
/// 天然没有注入面。这与 [`open_in_browser`] 注释里记的
/// 「`ShellExecuteExW` 把路径以 `lpFile` 宽字符指针整体传入」同源：
/// 凡是把路径拼进一个字符串再交给别人解析的写法，都是这类漏洞的温床。
#[cfg(windows)]
fn spawn_editor(editor: &Path, path: &Path) -> AppResult<()> {
    use std::os::windows::process::CommandExt;

    /// 不给编辑器闪一个控制台黑框（`CREATE_NO_WINDOW`）
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // 刻意不 wait()：编辑器是长驻进程，等它就是把自己挂死。
    // Child 被 drop 只是关掉句柄，不会杀死已经起来的进程。
    std::process::Command::new(editor)
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|err| {
            tracing::error!(editor = %editor.display(), %err, "拉起编辑器失败");
            AppError::native(format!("拉起编辑器失败（{}）：{err}", editor.display()))
        })?;

    tracing::info!(
        editor = %editor.display(),
        path = %path.display(),
        "已用指定编辑器打开源文件"
    );
    Ok(())
}

#[cfg(not(windows))]
fn spawn_editor(editor: &Path, path: &Path) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "「用其他编辑器打开」仅 Windows 可用：{} ← {}",
        editor.display(),
        path.display()
    )))
}
