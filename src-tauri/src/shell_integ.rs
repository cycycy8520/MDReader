//! DG 7.1 `shell_integ.rs` 职责：**仅**「额外右键动词」的注册表读写
//! （文件关联本身交给 bundler）。
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
    Err(AppError::not_implemented("shell_integ::refresh_shell（M2）"))
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
}
