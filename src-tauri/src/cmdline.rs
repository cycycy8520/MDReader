//! DG 7.1 `cmdline.rs` 职责：`--action` 分发与 clap 解析（cli 插件与单实例回调共用）。
//!
//! 两条入口共用**同一套**解析逻辑（DG 7.4）：
//! 1. 冷启动：本进程自己的 `argv`（也可经 tauri-plugin-cli 的 matches 取得）；
//! 2. 热启动：tauri-plugin-single-instance 回调转发过来的第二实例 `argv` + `cwd`。
//!
//! 相对路径必须以**第二实例的 cwd**为基准解析——主实例的 cwd 通常不同，
//! 直接用 `std::env::current_dir()` 会解析到错误的文件。
//!
//! ## 无 UI 动作（headless）的时序（M1 4.4 落地）
//!
//! ```text
//! 冷启动（右键动词 / 命令行直调，本进程就是唯一实例）
//!   main() 初始化日志
//!     └ Builder::setup → lib::run → handle_first_instance
//!         ├ parse(argv)                       ── 解析失败 → 降级为无参数启动（不退出）
//!         ├ dispatch(ColdStart)
//!         │   ├ 校验目标文件（存在 + 扩展名受支持）  ── 失败 → 记日志 → exit(1)
//!         │   ├ 推导 output（未给 --output 时：源文件同目录同名 + 对应扩展名）
//!         │   ├ set_headless_job()            ── 渲染窗口据此知道「要渲染哪一篇」
//!         │   ├ hide_main_window()            ── 不展示主窗口（窗口仍然创建，见下）
//!         │   └ spawn_headless()              ── 事件循环起来后才真正开跑
//!         └ setup 返回，事件循环启动
//!               └ 异步任务：export/capture/obsidian 各自创建**隐藏渲染窗口**、
//!                 等 PRINT_READY、产出文件 → 记日志 → 等日志落盘 → exit(0/1)
//!                 （`print` 例外：成功后不退出，见 [`exits_when_done`]）
//!
//! 热启动（应用已开着，用户又点了一次右键动词）
//!   第二实例进程 → single-instance 插件把 argv/cwd 转给主实例后自己退出
//!     └ handle_second_instance → dispatch(SecondInstance)
//!         └ 同上，但**绝不 exit**：主实例是用户正开着的窗口，做完只发一条
//!           [`EVENT_HEADLESS_RESULT`] 事件（前端可选择性做 toast）。
//! ```
//!
//! 「不展示主窗口」= **窗口照常创建但不可见**，不是不创建窗口：打印模板与 HTML 都靠
//! 前端渲染，没有 WebView 就没有产物（DG 7.2-4）。
//!
//! 无 UI 路径下用户看不到任何界面，**日志与退出码是唯一线索**（DG 10-8）：
//! 每一步都经 [`crate::logging::trace_action_step`] 留痕，成功 exit(0)、失败 exit(1)。

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};

/// 无 UI 动作完成后的广播事件名（前后端契约；冷启动时没有前端接收，纯属兜底）。
///
/// 用途只有一个：应用**已经开着**时用户又点了一次右键动词，产物已经写好但界面上
/// 什么都没发生——那正是「点了没反应」的观感。前端可监听本事件做一条 toast。
pub const EVENT_HEADLESS_RESULT: &str = "headless-result";

/// 无 UI 动作的进程退出码（右键动词失败时，调用方与日志都靠它区分成败）。
pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;

/// 退出前给非阻塞日志的落盘余量。
///
/// `AppHandle::exit` 最终走 `std::process::exit`，不会 drop `tracing_appender` 的
/// `WorkerGuard`——不等一下，失败原因这行日志恰好会丢在缓冲区里，
/// 而它正是 DG 10-8 要求的那条唯一线索。
const LOG_FLUSH_GRACE_MS: u64 = 120;

/// 推导输出路径时的重名让位上限（`a (1).pdf` … `a (999).pdf`）。
const MAX_OUTPUT_SUFFIX: u32 = 999;

/// 无 UI 动作。取值必须与 `nsis-hooks.nsh` 里写入的右键动词命令行、
/// 以及 `tauri.conf.json` 的 `plugins.cli.args[action].description` 保持一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    /// 打开并显示（默认）
    Open,
    /// 转为 HTML（v1.0 / M2，FR-07）
    ///
    /// 别名 `export-html`：DG 12「M1 出口」的验收命令行是这个写法。
    /// **写进注册表动词的规范取值仍是 `to-html`**，别名只为兼容既有文档与手输。
    #[value(alias = "export-html")]
    ToHtml,
    /// 转为 PDF（v1.0 / M2，FR-08）
    #[value(alias = "export-pdf")]
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

    /// 该动作产物的扩展名；`None` = 本动作不写文件（open / print / import-obsidian）。
    ///
    /// 未提供 `--output` 时据此推导「源文件同目录同名 + 对应扩展名」。
    pub fn output_extension(&self) -> Option<&'static str> {
        match self {
            Action::ToHtml => Some("html"),
            Action::ToPdf => Some("pdf"),
            Action::ShareImage => Some("png"),
            Action::Open | Action::Print | Action::ImportObsidian => None,
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
    name = "mdnaonao",
    version,
    about = "MDNaonao —— Windows 轻量 Markdown 查看器（严格只读）"
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
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        PathBuf::from(cwd).join(path)
    };
    normalize(&joined)
}

/// 消化路径里的 `.` 与 `..`，但**不碰盘符、UNC 前缀与符号链接**。
///
/// 为什么必须做：`mdnaonao .\a\b.md` 拼出来的是 `E:\dir\.\a\b.md`。它能正常打开文件，
/// 于是很容易被认为无所谓——但这个字符串会**原样出现在用户面前**（导出对话框的输出路径、
/// 最近列表、窗口标题、日志），看上去就像软件坏了。同一份文档还会因为写法不同
/// （`.\a.md` 与 `a.md`）产生两条最近记录。
///
/// 刻意不用 `canonicalize`：它要求文件已存在，还会把结果变成 `\\?\` 前缀的扩展长度路径，
/// 那个前缀显示给用户同样是穿帮，且部分 Win32 API 不认。
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            // 只有当上一段是普通目录名时才回退；`..` 位于根之后（如 `C:\..`）保持原样
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 输出路径推导
// ---------------------------------------------------------------------------

/// 未给 `--output` 时的默认产物路径：**源文件同目录同名 + 对应扩展名**。
///
/// `set_extension` 只换最后一段扩展名，所以 `年报.v2.md` → `年报.v2.pdf`（保留中间的 `.v2`），
/// 这与用户对「同名」的直觉一致。本动作不写文件（open / print / import-obsidian）时返回 `None`。
pub fn derive_output(source: &Path, action: Action) -> Option<PathBuf> {
    let extension = action.output_extension()?;
    let mut output = source.to_path_buf();
    // 无文件名（如 `D:\`）时 set_extension 返回 false 且原样不动，此时推导没有意义
    if !output.set_extension(extension) || output == source {
        return None;
    }
    Some(output)
}

/// 重名让位：`a.pdf` → `a (1).pdf`，沿用资源管理器的习惯写法。
pub fn numbered_path(path: &Path, index: u32) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = match path.extension() {
        Some(extension) => format!("{stem} ({index}).{}", extension.to_string_lossy()),
        None => format!("{stem} ({index})"),
    };
    path.with_file_name(name)
}

/// 推导出来的路径若已被占用就顺延编号。
///
/// 为什么只对**推导**出来的路径这么做：显式 `--output` 是用户点名要写到那里，
/// 替他改名反而是添乱；而右键「转 PDF」按两次就该得到两份文件，
/// 静默覆盖掉上一份在一个「严格只读」的产品里尤其说不过去。
fn vacant_output(path: &Path) -> AppResult<PathBuf> {
    if !path.exists() {
        return Ok(path.to_path_buf());
    }
    for index in 1..=MAX_OUTPUT_SUFFIX {
        let candidate = numbered_path(path, index);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::config(format!(
        "推导输出路径失败：{} 及其 1–{MAX_OUTPUT_SUFFIX} 号副本都已存在，请显式指定 --output",
        path.display()
    )))
}

// ---------------------------------------------------------------------------
// headless 作业状态
// ---------------------------------------------------------------------------

/// 一次无 UI 作业的全部输入。
///
/// 它同时是**渲染窗口的信息源**：打印模板 / HTML 导出都由前端渲染，
/// 那个隐藏窗口起来之后需要知道「我该渲染哪一篇」——它调 [`headless_job`] 就能拿到，
/// 不必再为每条导出链路各发明一套传参方式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessJob {
    pub action: Action,
    /// 目标 Markdown 绝对路径
    pub source: PathBuf,
    /// 产物路径；print / import-obsidian 为 None
    pub output: Option<PathBuf>,
}

/// [`HeadlessJob`] 的进程内槽位（与 [`PendingOpen`] 并列，但**取走不清空**：
/// 隐藏渲染窗口可能因重载而问第二次）。
#[derive(Default)]
pub struct HeadlessJobState(pub Mutex<Option<HeadlessJob>>);

fn set_headless_job(app: &AppHandle, job: &HeadlessJob) {
    if app.try_state::<HeadlessJobState>().is_none() {
        app.manage(HeadlessJobState::default());
    }
    if let Some(state) = app.try_state::<HeadlessJobState>() {
        match state.0.lock() {
            Ok(mut slot) => *slot = Some(job.clone()),
            Err(err) => tracing::error!(%err, "写入 headless 作业槽失败"),
        }
    }
}

/// 当前进程是否正在跑一次无 UI 作业，以及它的输入是什么。
///
/// 供**渲染窗口**（打印模板 / 导出模板）在挂载后询问：返回 `Some` 就按其中的 source
/// 渲染并 emit `PRINT_READY`；返回 `None` 说明是普通启动，走正常界面。
/// 与 [`take_pending_open`] 的区别：本命令**不消费**，允许重复询问。
#[tauri::command]
pub async fn headless_job(app: AppHandle) -> AppResult<Option<HeadlessJob>> {
    let Some(state) = app.try_state::<HeadlessJobState>() else {
        return Ok(None);
    };
    let job = state
        .0
        .lock()
        .map_err(|err| AppError::config(format!("读取 headless 作业槽失败：{err}")))?
        .clone();
    Ok(job)
}

/// 无 UI 动作的结果广播体（[`EVENT_HEADLESS_RESULT`] 的 payload）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessResult {
    pub action: Action,
    pub source: PathBuf,
    /// 实际写出的产物路径（失败或无产物时为 None）
    pub output: Option<PathBuf>,
    pub ok: bool,
    /// 失败原因。面向排查，前端只应把它当次要行显示（用户可见主文案在 i18n）
    pub message: Option<String>,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// 入口：冷启动 / 热启动
// ---------------------------------------------------------------------------

/// 分发来源。决定两件事：路径落地方式（暂存 vs emit）、以及**做完能不能退出进程**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchOrigin {
    /// 本进程就是被右键/命令行直接拉起来的那一个：做完必须退出
    ColdStart,
    /// 用户已经开着应用，第二实例把参数转发了过来：**绝不退出**（那是用户正在看的窗口）
    SecondInstance,
}

/// 冷启动路径：进程刚起来时处理自己的命令行。
///
/// 返回 `Ok(())` 不代表动作成功——无 UI 动作是异步跑的，成败经退出码与日志体现。
/// 解析失败**不阻塞启动**：退化成「无参数启动」，用户至少能看到空状态页。
pub fn handle_first_instance(app: &AppHandle) -> AppResult<()> {
    let argv = current_argv();
    let cwd = std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();

    match parse(&argv) {
        Ok(cli) => {
            tracing::info!(?cli, %cwd, "冷启动命令行解析完成");
            let action = cli.action;
            if let Err(err) = dispatch(app, cli, &cwd, DispatchOrigin::ColdStart) {
                if action.is_headless() {
                    // 无 UI 路径没有任何界面可以报错，退出码 + 日志就是全部线索（DG 10-8）
                    tracing::error!(action = action.as_str(), %err, "无 UI 动作参数校验失败");
                    crate::logging::trace_action_step(action.as_str(), &format!("失败：{err}"));
                    exit_later(app, EXIT_FAILED);
                } else {
                    tracing::warn!(%err, "冷启动分发失败，按无参数启动");
                }
            }
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
/// 注意这里跑在**用户正开着的主实例**里：无论动作成败都不许退出进程，
/// 否则「右键转 PDF」会顺手关掉用户正在读的窗口。
pub fn handle_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    tracing::info!(?argv, cwd = %cwd, "收到第二实例参数");
    match parse(&argv) {
        Ok(cli) => {
            let action = cli.action;
            if let Err(err) = dispatch(app, cli, &cwd, DispatchOrigin::SecondInstance) {
                tracing::error!(action = action.as_str(), %err, "第二实例分发失败");
                crate::logging::trace_action_step(action.as_str(), &format!("失败：{err}"));
            }
        }
        Err(err) => {
            tracing::warn!(%err, "第二实例命令行解析失败，忽略本次转发");
        }
    }
}

/// 统一分发入口（两条路径共用）。
///
/// 同步返回的 `Err` 只表示**参数阶段**就没过关（缺文件、文件不存在、扩展名不受支持、
/// 输出路径推不出来）；真正的执行是异步的，成败见退出码与日志。
pub fn dispatch(app: &AppHandle, cli: Cli, cwd: &str, origin: DispatchOrigin) -> AppResult<()> {
    let source = cli.file.as_ref().map(|file| resolve_against(cwd, file));
    crate::logging::trace_action_step(
        cli.action.as_str(),
        &format!(
            "分发（{origin:?}）：file={}",
            source
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        ),
    );

    if !cli.action.is_headless() {
        return dispatch_open(app, source, origin);
    }

    let job = build_headless_job(&cli, source, cwd)?;
    tracing::info!(
        action = job.action.as_str(),
        source = %job.source.display(),
        output = job.output.as_ref().map(|path| path.display().to_string()),
        "无 UI 动作参数就绪"
    );

    // 渲染窗口靠它知道「渲染哪一篇」；必须早于窗口创建落位
    set_headless_job(app, &job);

    if origin == DispatchOrigin::ColdStart {
        // 「不展示主窗口」——窗口本身照常创建（没有 WebView 就没有产物），只是不可见
        hide_main_window(app);
    }

    spawn_headless(app, job, origin);
    Ok(())
}

/// `--action open`（默认动作）：把路径交给前端。
///
/// 冷启动与热启动是**两条不同的通道**，不能互换：
/// 冷启动时前端还没挂载，emit 出去没人接（Tauri 不重放事件），只能暂存等前端来取；
/// 热启动时前端早已就绪，直接 emit 才有 ≤1s 的响应。
fn dispatch_open(
    app: &AppHandle,
    source: Option<PathBuf>,
    origin: DispatchOrigin,
) -> AppResult<()> {
    match origin {
        DispatchOrigin::ColdStart => {
            if let Some(target) = source {
                tracing::info!(path = %target.display(), "冷启动待打开文件已暂存");
                set_pending_open(app, target);
            }
        }
        DispatchOrigin::SecondInstance => {
            // 主窗口拉到前台（DG 7.2-1：双击第二个文件应切到已有实例）
            if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(target) = source {
                let payload = target.to_string_lossy().into_owned();
                if let Err(err) = app.emit(crate::EVENT_OPEN_PATH, payload) {
                    tracing::error!(%err, "转发打开路径失败");
                }
            }
        }
    }
    Ok(())
}

/// 参数校验 + 输出推导。任何一步不过关都在这里同步失败，不进异步阶段。
fn build_headless_job(cli: &Cli, source: Option<PathBuf>, cwd: &str) -> AppResult<HeadlessJob> {
    let source = source
        .ok_or_else(|| AppError::config(format!("--action {} 需要一个目标文件路径", cli.action)))?;
    if !source.is_file() {
        return Err(AppError::not_found(source.display().to_string()));
    }
    if !crate::files::is_supported(&source) {
        return Err(AppError::config(format!(
            "不是受支持的 Markdown 文件：{}",
            source.display()
        )));
    }

    let output = match cli.output.as_ref() {
        // 显式 --output：用户点名要写这里，原样采信（含覆盖）。相对路径与目标文件同口径，
        // 都按调用方的 cwd 解析——两个参数用两套基准是最容易写出「文件去哪了」的做法。
        Some(path) => Some(resolve_against(cwd, path)),
        None => match derive_output(&source, cli.action) {
            Some(derived) => Some(vacant_output(&derived)?),
            None => None,
        },
    };

    // 需要产物却推不出路径：与其写到一个猜出来的地方，不如明确失败
    if cli.action.output_extension().is_some() && output.is_none() {
        return Err(AppError::config(format!(
            "无法为 {} 推导输出路径，请显式指定 --output",
            source.display()
        )));
    }

    Ok(HeadlessJob {
        action: cli.action,
        source,
        output,
    })
}

fn hide_main_window(app: &AppHandle) {
    match app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        Some(window) => {
            if let Err(err) = window.hide() {
                tracing::warn!(%err, "隐藏主窗口失败（无 UI 动作会闪一下窗口）");
            }
        }
        None => tracing::warn!(label = crate::MAIN_WINDOW_LABEL, "找不到主窗口，无需隐藏"),
    }
}

/// 延后一拍再退出：`setup` 阶段事件循环尚未启动，此时直接 exit 时机太早。
fn exit_later(app: &AppHandle, code: i32) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(LOG_FLUSH_GRACE_MS)).await;
        handle.exit(code);
    });
}

/// 真正执行无 UI 动作：异步跑，做完记日志 → 广播 → （冷启动才）退出进程。
fn spawn_headless(app: &AppHandle, job: HeadlessJob, origin: DispatchOrigin) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let action = job.action;
        crate::logging::trace_action_step(
            action.as_str(),
            &format!("开始执行：{}", job.source.display()),
        );

        let result = run_headless(&handle, &job).await;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let ok = match &result {
            Ok(output) => {
                tracing::info!(
                    action = action.as_str(),
                    elapsed_ms,
                    output = output.as_ref().map(|path| path.display().to_string()),
                    "无 UI 动作完成"
                );
                crate::logging::trace_action_step(action.as_str(), "完成");
                true
            }
            Err(err) => {
                tracing::error!(action = action.as_str(), elapsed_ms, %err, "无 UI 动作失败");
                crate::logging::trace_action_step(action.as_str(), &format!("失败：{err}"));
                false
            }
        };

        let payload = HeadlessResult {
            action,
            source: job.source.clone(),
            output: result.as_ref().ok().and_then(|path| path.clone()),
            ok,
            message: result.as_ref().err().map(|err| err.to_string()),
            elapsed_ms,
        };
        if let Err(err) = handle.emit(EVENT_HEADLESS_RESULT, payload) {
            tracing::debug!(%err, "广播无 UI 动作结果失败（冷启动时无人接收，属正常）");
        }

        if origin != DispatchOrigin::ColdStart {
            // 第二实例转发过来的：这是用户正开着的窗口，做完什么都不做
            return;
        }
        if ok && !exits_when_done(action) {
            tracing::info!(
                action = action.as_str(),
                "动作已交给系统对话框，进程不在此退出（生命周期归打印窗口）"
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(LOG_FLUSH_GRACE_MS)).await;
        handle.exit(if ok { EXIT_OK } else { EXIT_FAILED });
    });
}

/// 动作跑完能不能立刻退出进程。
///
/// `print` 是唯一的例外：wry 的 `print()` 只负责把**系统打印对话框**弹出来就返回，
/// 真正的打印发生在用户点「打印」之后。此时 `app.exit(0)` 会连对话框一起带走——
/// 用户看到的是「右键打印，闪一下没了」。它的生命周期属于那扇打印窗口，不属于本次调用。
///
/// 失败路径不受此表影响：什么都没弹出来，就没有理由让进程赖着不走。
fn exits_when_done(action: Action) -> bool {
    !matches!(action, Action::Print)
}

/// 按动作路由。返回值是**实际写出的产物路径**（无产物的动作为 `None`），只用于日志与广播。
async fn run_headless(app: &AppHandle, job: &HeadlessJob) -> AppResult<Option<PathBuf>> {
    match job.action {
        // dispatch 已经把 Open 挡在外面，这里只是把 match 补全
        Action::Open => Ok(None),
        Action::ToHtml => bridge::to_html(app, job).await,
        Action::ToPdf => bridge::to_pdf(app, job).await,
        Action::Print => bridge::print(app, job).await,
        Action::ImportObsidian => bridge::import_obsidian(job).await,
        Action::ShareImage => bridge::share_image(app, job).await,
    }
}

// ---------------------------------------------------------------------------
// 跨模块调用的唯一收敛点
// ---------------------------------------------------------------------------

/// export / capture / obsidian 的调用**全部**收敛在本模块内。
///
/// 这些函数由别的批次同期实现，签名有漂移的可能；集中在一处的好处是：
/// 签名一变只需要改这里的几行，`dispatch` 的时序与日志/退出码逻辑一个字都不用动。
mod bridge {
    use super::{AppError, AppHandle, AppResult, HeadlessJob, Path, PathBuf};

    /// 需要产物的动作在 [`super::build_headless_job`] 阶段已经保证了 output 非空。
    fn require_output(job: &HeadlessJob) -> AppResult<&Path> {
        job.output
            .as_deref()
            .ok_or_else(|| AppError::config(format!("{} 缺少输出路径", job.action)))
    }

    /// FR-07 转 HTML。模式取用户设置里的 `htmlExportMode`（单文件 / 带资源目录）——
    /// 命令行没有对应开关，沿用用户在界面上的选择才不会「同一台机器两套行为」。
    pub async fn to_html(app: &AppHandle, job: &HeadlessJob) -> AppResult<Option<PathBuf>> {
        let output = require_output(job)?.to_path_buf();
        let mode = crate::settings::load_settings_sync().html_export_mode;
        // 走 export::export_html_headless 而不是 export_html::export_html：后者要的是
        // **前端渲染好的 payload**，无 UI 路径下没有任何窗口渲染过这篇文档，
        // 必须先建一扇隐藏渲染窗口把正文跑出来。
        let result = crate::export::export_html_headless(
            app.clone(),
            job.source.to_string_lossy().into_owned(),
            output,
            mode,
        )
        .await?;
        Ok(Some(result.output))
    }

    /// FR-08 转 PDF。文内目录页默认不加：命令行没有让用户表达意愿的地方，
    /// 而凭空多出一页目录比少一页更容易被当成 bug。
    pub async fn to_pdf(app: &AppHandle, job: &HeadlessJob) -> AppResult<Option<PathBuf>> {
        let output = require_output(job)?.to_path_buf();
        let result = crate::export::export_pdf(
            app.clone(),
            job.source.to_string_lossy().into_owned(),
            crate::export::PdfOptions {
                output,
                include_toc: false,
            },
        )
        .await?;
        Ok(Some(result.output))
    }

    /// FR-17 打印。系统打印对话框由 WebView 弹出，所以这一条虽走 headless 分发，
    /// 用户仍会看到一个原生对话框——这是它与其余无 UI 动作唯一的不同。
    pub async fn print(app: &AppHandle, job: &HeadlessJob) -> AppResult<Option<PathBuf>> {
        crate::export::print_document(app.clone(), job.source.to_string_lossy().into_owned())
            .await?;
        Ok(None)
    }

    /// FR-09 导入 Obsidian。命令行里没有「选 Vault」这一步，取当前打开的那个，
    /// 没有则取第一个；一个都没有就明确失败（而不是静默什么都不做）。
    /// 冲突策略固定为改名：覆盖用户 Vault 里的既有文件在只读产品里绝不可接受。
    pub async fn import_obsidian(job: &HeadlessJob) -> AppResult<Option<PathBuf>> {
        let vaults = crate::obsidian::list_vaults().await?;
        let vault = vaults
            .iter()
            .find(|vault| vault.open)
            .or_else(|| vaults.first())
            .ok_or_else(|| {
                AppError::not_found("未找到 Obsidian Vault（未安装 Obsidian 或尚未创建 Vault）")
            })?;

        let outcome = crate::obsidian::import_to_vault(crate::obsidian::ImportRequest {
            source: job.source.clone(),
            vault_id: vault.id.clone(),
            subfolder: None,
            conflict: crate::obsidian::ConflictPolicy::Rename,
        })
        .await?;

        // 唤起 Obsidian 是锦上添花：失败不该把「已经导入成功」判成失败
        if let Err(err) = crate::obsidian::open_in_obsidian(outcome.uri.clone()).await {
            tracing::warn!(%err, uri = %outcome.uri, "导入成功，但唤起 Obsidian 失败");
        }
        Ok(Some(vault.path.join(&outcome.relative_path)))
    }

    /// FR-10 长图。宽度与 DPR 用默认值（微信版式 720px）——命令行同样没有表达它们的位置。
    pub async fn share_image(app: &AppHandle, job: &HeadlessJob) -> AppResult<Option<PathBuf>> {
        let output = require_output(job)?.to_path_buf();
        let result = crate::capture::capture_long_image(
            app.clone(),
            crate::capture::CaptureOptions {
                // source 不传的话运行期会报「缺少源文档路径」——capture.rs 刻意选了
                // 「宁可失败也不猜截哪篇」，所以这里必须显式给。
                source: Some(job.source.to_string_lossy().into_owned()),
                output: Some(output),
                ..Default::default()
            },
        )
        .await?;
        if result.segments > 1 {
            // WARN 而不是 INFO：用户点「生成长图」期待的是**一张图**，这里给了好几张。
            // 无 UI 路径下日志是唯一线索，把每个文件名都列出来，否则用户只会看到
            // 完成日志里的第一张，以为软件把文档截断了。
            //
            // 为什么不在这里合成：CDP 只回已编码 PNG，Rust 侧没有 PNG 解码器
            // （引入 image crate 触红线 12）。界面上那条路由前端 canvas 合成成一张
            // （render/longImage.ts 的 composeSegments），所以只有命令行动词会分段，
            // 且只在文档高度超过 16384 CSS px 时才会——普通笔记远到不了。
            let files = result
                .outputs
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join("；");
            tracing::warn!(
                segments = result.segments,
                total_height_px = result.total_height_px,
                %files,
                "长图超过单张上限，已切成多张落盘（不是一张图）"
            );
        }
        Ok(result.outputs.first().cloned())
    }
}

// ---------------------------------------------------------------------------
// 冷启动待打开文件
// ---------------------------------------------------------------------------

/// 冷启动待打开文件的暂存槽。
///
/// 为什么不直接 emit：`handle_first_instance` 在 `Builder::setup` 阶段执行，
/// 此时 WebView 尚未加载完前端，Tauri 的事件没有重放机制，emit 出去会石沉大海。
#[derive(Default)]
pub struct PendingOpen(pub std::sync::Mutex<Option<PathBuf>>);

fn set_pending_open(app: &AppHandle, path: PathBuf) {
    if app.try_state::<PendingOpen>().is_none() {
        app.manage(PendingOpen::default());
    }
    if let Some(state) = app.try_state::<PendingOpen>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(path);
        }
    }
}

/// 前端挂载后调用一次：取走并清空冷启动待打开的文件路径。
///
/// 这是冷启动的**唯一**通道。曾试过在 `on_page_load(Finished)` 里 emit 事件，
/// 实测该时机仍早于 React 挂载与 `listen()` 注册，事件照样丢失且会提前消费掉暂存值——
/// 拉取模型（前端就绪后主动要）才是无竞态的那个。
///
/// 返回 None 表示无参数启动（走空状态页）。取走即清空，避免刷新页面时重复打开。
///
/// 注意：无 UI 动作**不写这个槽**（走 [`headless_job`]），因此隐藏起来的主窗口
/// 在 headless 模式下拿到的永远是 None——它本来就不该渲染任何东西。
#[tauri::command]
pub async fn take_pending_open(app: AppHandle) -> AppResult<Option<String>> {
    let Some(state) = app.try_state::<PendingOpen>() else {
        return Ok(None);
    };
    let taken = state
        .0
        .lock()
        .map_err(|e| AppError::config(format!("读取冷启动暂存失败：{e}")))?
        .take();
    tracing::info!(
        hit = taken.is_some(),
        path = taken.as_ref().map(|p| p.display().to_string()),
        "前端取走冷启动暂存"
    );
    Ok(taken.map(|p| p.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 相对路径按 cwd 展开，并且**不能把 `.` 留在结果里**——那个字符串会直接
    /// 显示在导出对话框、最近列表与窗口标题上（实测 `E:\MDyuedu\.\test-corpus\a.html`）。
    #[test]
    fn resolve_against_normalizes_dot_segments() {
        assert_eq!(
            resolve_against("E:\\proj", Path::new(".\\docs\\a.md")),
            PathBuf::from("E:\\proj\\docs\\a.md")
        );
        assert_eq!(
            resolve_against("E:\\proj\\sub", Path::new("..\\docs\\a.md")),
            PathBuf::from("E:\\proj\\docs\\a.md")
        );
        // 绝对路径同样要清洗：调用方给什么我们就显示什么，脏的进来就是脏的出去
        assert_eq!(
            resolve_against("E:\\ignored", Path::new("D:\\a\\.\\b\\..\\c.md")),
            PathBuf::from("D:\\a\\c.md")
        );
        // 已经干净的路径必须原样返回（含中文与空格）
        let clean = PathBuf::from("D:\\我的 笔记\\周报.md");
        assert_eq!(resolve_against("E:\\ignored", &clean), clean);
    }

    /// `..` 越过根时保持原样，不能把盘符弹掉。
    #[test]
    fn normalize_keeps_parent_dir_at_root() {
        assert_eq!(
            normalize(Path::new("C:\\..\\a.md")),
            PathBuf::from("C:\\..\\a.md")
        );
    }

    /// 默认动作为 open，位置参数落到 file。
    #[test]
    fn parses_bare_file_path() {
        let argv = vec!["mdnaonao.exe".to_string(), "D:\\doc\\a.md".to_string()];
        let cli = parse(&argv).expect("应解析成功");
        assert_eq!(cli.action, Action::Open);
        assert_eq!(cli.file, Some(PathBuf::from("D:\\doc\\a.md")));
    }

    /// `--action to-html` 走 kebab-case 取值。
    #[test]
    fn parses_action_flag() {
        let argv = vec![
            "mdnaonao.exe".to_string(),
            "--action".to_string(),
            "to-html".to_string(),
            "a.md".to_string(),
        ];
        let cli = parse(&argv).expect("应解析成功");
        assert_eq!(cli.action, Action::ToHtml);
        assert!(cli.action.is_headless());
    }

    /// DG 12「M1 出口」里的验收命令行写作 `--action export-html`，别名必须认。
    #[test]
    fn accepts_documented_action_aliases() {
        for (raw, expected) in [
            ("export-html", Action::ToHtml),
            ("to-html", Action::ToHtml),
            ("export-pdf", Action::ToPdf),
            ("to-pdf", Action::ToPdf),
        ] {
            let argv = vec![
                "mdnaonao.exe".to_string(),
                format!("--action={raw}"),
                "a.md".to_string(),
            ];
            let cli = parse(&argv).unwrap_or_else(|err| panic!("{raw} 应解析成功：{err}"));
            assert_eq!(cli.action, expected, "{raw}");
        }
    }

    /// 相对路径必须按第二实例的 cwd 解析。
    #[test]
    fn resolves_relative_path_against_cwd() {
        let resolved = resolve_against("D:\\work", &PathBuf::from("notes\\a.md"));
        assert_eq!(resolved, PathBuf::from("D:\\work\\notes\\a.md"));
    }

    /// 未给 --output 时：源文件同目录同名 + 对应扩展名（含中文与空格）。
    #[test]
    fn derives_output_beside_source() {
        let source = PathBuf::from("D:\\我的 笔记\\季度 报告.md");
        assert_eq!(
            derive_output(&source, Action::ToHtml),
            Some(PathBuf::from("D:\\我的 笔记\\季度 报告.html"))
        );
        assert_eq!(
            derive_output(&source, Action::ToPdf),
            Some(PathBuf::from("D:\\我的 笔记\\季度 报告.pdf"))
        );
        assert_eq!(
            derive_output(&source, Action::ShareImage),
            Some(PathBuf::from("D:\\我的 笔记\\季度 报告.png"))
        );
    }

    /// 多段扩展名只换最后一段：`年报.v2.md` → `年报.v2.pdf`。
    #[test]
    fn derive_output_keeps_inner_dots() {
        let source = PathBuf::from("D:\\doc\\年报.v2.md");
        assert_eq!(
            derive_output(&source, Action::ToPdf),
            Some(PathBuf::from("D:\\doc\\年报.v2.pdf"))
        );
    }

    /// 不写文件的动作没有推导结果（推出来反而会造出无人认领的空文件）。
    #[test]
    fn actions_without_artifacts_derive_nothing() {
        let source = PathBuf::from("D:\\doc\\a.md");
        for action in [Action::Open, Action::Print, Action::ImportObsidian] {
            assert_eq!(derive_output(&source, action), None, "{action}");
        }
    }

    /// 重名让位沿用资源管理器写法，且不碰扩展名前的其余部分。
    #[test]
    fn numbered_path_follows_explorer_convention() {
        assert_eq!(
            numbered_path(Path::new("D:\\doc\\年报.v2.pdf"), 1),
            PathBuf::from("D:\\doc\\年报.v2 (1).pdf")
        );
        assert_eq!(
            numbered_path(Path::new("D:\\doc\\无扩展名"), 7),
            PathBuf::from("D:\\doc\\无扩展名 (7)")
        );
    }

    /// print 弹的是系统对话框，进程一退它就没了——只有它不在「跑完即退」之列。
    #[test]
    fn only_print_outlives_its_own_call() {
        for action in [
            Action::ToHtml,
            Action::ToPdf,
            Action::ImportObsidian,
            Action::ShareImage,
        ] {
            assert!(exits_when_done(action), "{action} 跑完应当退出");
        }
        assert!(!exits_when_done(Action::Print));
    }

    /// 动作三件事必须自洽：是否 headless、是否产文件、产什么扩展名。
    /// 新增动作时这条会逼着把三者一起想清楚，而不是漏掉输出推导。
    #[test]
    fn every_action_declares_artifact_semantics() {
        for (action, extension) in [
            (Action::Open, None),
            (Action::ToHtml, Some("html")),
            (Action::ToPdf, Some("pdf")),
            (Action::Print, None),
            (Action::ImportObsidian, None),
            (Action::ShareImage, Some("png")),
        ] {
            assert_eq!(action.output_extension(), extension, "{action}");
            assert_eq!(action.is_headless(), action != Action::Open, "{action}");
        }
    }
}
