//! DG 7.1 `cmdline.rs` 职责：`--action` 分发与 clap 解析（cli 插件与单实例回调共用）。
//!
//! 两条入口共用**同一套**解析逻辑（DG 7.4）：
//! 1. 冷启动：本进程自己的 `argv`（也可经 tauri-plugin-cli 的 matches 取得）；
//! 2. 热启动：tauri-plugin-single-instance 回调转发过来的第二实例 `argv` + `cwd`。
//!
//! 相对路径必须以**第二实例的 cwd**为基准解析——主实例的 cwd 通常不同，
//! 直接用 `std::env::current_dir()` 会解析到错误的文件。

use std::fmt;
use std::path::{Path, PathBuf};

use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

/// 无 UI 动作。取值必须与 `nsis-hooks.nsh` 里写入的右键动词命令行、
/// 以及 `tauri.conf.json` 的 `plugins.cli.args[action].description` 保持一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    /// 打开并显示（默认）
    Open,
    /// 转为 HTML（v1.0 / M2，FR-07）
    ToHtml,
    /// 转为 PDF（v1.0 / M2，FR-08）
    ToPdf,
    /// 调起系统打印对话框（v1.0 / M2，FR-17）
    Print,
    /// 导入 Obsidian（v1.1 / M3，FR-09）
    ImportObsidian,
    /// 生成长图（v1.1 / M3，FR-10）
    ShareImage,
}

impl Action {
    /// 是否为「无 UI 动作」——这类动作全程不展示主窗口，每一步必须写日志（DG 10-8）。
    pub fn is_headless(&self) -> bool {
        !matches!(self, Action::Open)
    }

    /// 命令行取值（kebab-case），与右键动词命令行一一对应。
    pub fn as_str(&self) -> &'static str {
        match self {
            Action::Open => "open",
            Action::ToHtml => "to-html",
            Action::ToPdf => "to-pdf",
            Action::Print => "print",
            Action::ImportObsidian => "import-obsidian",
            Action::ShareImage => "share-image",
        }
    }
}

impl fmt::Display for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 命令行契约。新增参数必须同步 `tauri.conf.json` 的 `plugins.cli.args`。
#[derive(Debug, Clone, Parser)]
#[command(
    name = "md-viewer",
    version,
    about = "MD Viewer —— Windows 轻量 Markdown 查看器（严格只读）"
)]
pub struct Cli {
    /// 无 UI 动作
    #[arg(short = 'a', long = "action", value_enum, default_value_t = Action::Open)]
    pub action: Action,

    /// 输出路径（to-html / to-pdf / share-image 使用）
    #[arg(short = 'o', long = "output", value_name = "OUT")]
    pub output: Option<PathBuf>,

    /// 目标 Markdown 文件路径
    #[arg(value_name = "FILE")]
    pub file: Option<PathBuf>,
}

/// 解析一份完整 argv（含 argv[0] 可执行文件路径）。
pub fn parse(argv: &[String]) -> AppResult<Cli> {
    Cli::try_parse_from(argv).map_err(|err| AppError::config(err.to_string()))
}

/// 取当前进程的 argv（`std::env::args()` 遇到非 UTF-8 参数会 panic，故走 `args_os` + lossy）。
pub fn current_argv() -> Vec<String> {
    std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

/// 把可能是相对路径的目标文件，按给定 cwd 解析成绝对路径。
pub fn resolve_against(cwd: &str, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        PathBuf::from(cwd).join(path)
    }
}

/// 冷启动路径：进程刚起来时处理自己的命令行。
///
/// TODO(M1)：按 [`Action`] 分发——`Open` 交前端渲染管线（emit 事件带文件路径），
/// 其余 headless 动作走 export/capture/obsidian 后直接退出进程。
/// 也可改用 tauri-plugin-cli 的 `app.cli().matches()` 取参数，但**解析结果必须
/// 落到同一个 [`Cli`] 结构**，不允许出现第二套语义。
pub fn handle_first_instance(app: &AppHandle) -> AppResult<()> {
    let argv = current_argv();
    match parse(&argv) {
        Ok(cli) => {
            tracing::info!(?cli, "冷启动命令行解析完成");
            let _ = app;
            // TODO(M1)：dispatch(app, cli, cwd)
        }
        Err(err) => {
            // 解析失败不阻塞启动：退化成「无参数启动」，走空状态页
            tracing::warn!(%err, "命令行解析失败，按无参数启动");
        }
    }
    Ok(())
}

/// 热启动路径：tauri-plugin-single-instance 回调转发的第二实例参数（DG 7.2-1）。
///
/// 性能契约（DG 3.2）：自本回调收到路径至首帧渲染完成 ≤ 1s。
///
/// TODO(M1)：解析后 —— 聚焦并置前主窗口 → 打开/切换到目标文件 → 计入最近列表。
pub fn handle_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    tracing::info!(?argv, cwd = %cwd, "收到第二实例参数");
    match parse(&argv) {
        Ok(cli) => {
            let target = cli.file.as_ref().map(|file| resolve_against(&cwd, file));
            tracing::info!(action = ?cli.action, ?target, "第二实例命令行解析完成");
            let _ = app;
            // TODO(M1)：dispatch(app, cli, &cwd)
        }
        Err(err) => {
            tracing::warn!(%err, "第二实例命令行解析失败，忽略本次转发");
        }
    }
}

/// 统一分发入口（两条路径共用）。
///
/// TODO(M1/M2/M3)：按 [`Action`] 路由到 files / export / capture / obsidian 模块；
/// headless 动作全程 [`crate::logging::trace_action_step`] 留痕。
pub fn dispatch(app: &AppHandle, cli: Cli, cwd: &str) -> AppResult<()> {
    let _ = (app, cwd);
    Err(AppError::not_implemented(format!(
        "cmdline::dispatch（M1）：action={:?}",
        cli.action
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认动作为 open，位置参数落到 file。
    #[test]
    fn parses_bare_file_path() {
        let argv = vec!["md-viewer.exe".to_string(), "D:\\doc\\a.md".to_string()];
        let cli = parse(&argv).expect("应解析成功");
        assert_eq!(cli.action, Action::Open);
        assert_eq!(cli.file, Some(PathBuf::from("D:\\doc\\a.md")));
    }

    /// `--action to-html` 走 kebab-case 取值。
    #[test]
    fn parses_action_flag() {
        let argv = vec![
            "md-viewer.exe".to_string(),
            "--action".to_string(),
            "to-html".to_string(),
            "a.md".to_string(),
        ];
        let cli = parse(&argv).expect("应解析成功");
        assert_eq!(cli.action, Action::ToHtml);
        assert!(cli.action.is_headless());
    }

    /// 相对路径必须按第二实例的 cwd 解析。
    #[test]
    fn resolves_relative_path_against_cwd() {
        let resolved = resolve_against("D:\\work", &PathBuf::from("notes\\a.md"));
        assert_eq!(resolved, PathBuf::from("D:\\work\\notes\\a.md"));
    }
}
