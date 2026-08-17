//! DG 7.1 `logging.rs` 职责：文件日志（轮转），`--action` 无 UI 模式必写。
//!
//! 规则来源：
//! * DG 7.3 存储设计——日志落在 `%APPDATA%\MDViewer\logs\`，按天分文件，
//!   保留 7 天或总量 10MB（先到为准）自动轮转。
//! * DG 10-8——GUI 应用无法向控制台回写，`--action` 每一步都必须留日志，
//!   否则右键菜单失败时无从排查。
//!
//! 本模块在 `main()` 里**最先**初始化（早于 Tauri Builder），因此不能依赖 AppHandle，
//! 目录解析走 `settings::app_data_dir()`（读 `%APPDATA%` 环境变量）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};

use crate::error::{AppError, AppResult};

/// 日志文件名前缀，`tracing_appender::rolling::daily` 会追加 `.YYYY-MM-DD`。
pub const LOG_FILE_PREFIX: &str = "md-viewer.log";

/// 保留天数（DG 7.3）。
pub const LOG_RETAIN_DAYS: u64 = 7;

/// 日志目录总量上限（DG 7.3）。
pub const LOG_TOTAL_LIMIT_BYTES: u64 = 10 * 1024 * 1024;

/// 覆盖日志级别的环境变量，例：`MD_VIEWER_LOG=debug`。
pub const LOG_ENV: &str = "MD_VIEWER_LOG";

const SECONDS_PER_DAY: u64 = 24 * 60 * 60;

/// 日志目录：`%APPDATA%\MDViewer\logs\`。
pub fn log_dir() -> AppResult<PathBuf> {
    Ok(crate::settings::app_data_dir()?.join("logs"))
}

/// 初始化全局 tracing 订阅器。
///
/// 返回的 [`WorkerGuard`] 必须在进程存活期间一直持有（非阻塞写入的刷盘句柄），
/// 一旦被 drop，未落盘的日志会丢失。
pub fn init() -> AppResult<WorkerGuard> {
    let dir = log_dir()?;
    fs::create_dir_all(&dir)?;

    // 先清理再开写，避免刚创建的当天文件被误判
    if let Err(err) = prune(&dir) {
        eprintln!("[md-viewer] 清理历史日志失败（不影响启动）：{err}");
    }

    let appender = tracing_appender::rolling::daily(&dir, LOG_FILE_PREFIX);
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let filter = EnvFilter::try_from_env(LOG_ENV).unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(writer),
        )
        .init();

    Ok(guard)
}

/// 轮转清理：删除超过 [`LOG_RETAIN_DAYS`] 天的文件；再按「新 → 旧」累计体积，
/// 超过 [`LOG_TOTAL_LIMIT_BYTES`] 的旧文件一并删除。最新一个文件永不删除。
fn prune(dir: &Path) -> AppResult<()> {
    let mut files: Vec<(PathBuf, SystemTime, u64)> = Vec::new();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(LOG_FILE_PREFIX) {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        files.push((entry.path(), modified, meta.len()));
    }

    // 按修改时间倒序：新的在前
    files.sort_by(|a, b| b.1.cmp(&a.1));

    let now = SystemTime::now();
    let mut total: u64 = 0;

    for (index, (path, modified, size)) in files.into_iter().enumerate() {
        total = total.saturating_add(size);

        // 最新的一份始终保留（它就是当前正在写的文件）
        if index == 0 {
            continue;
        }

        let too_old = now
            .duration_since(modified)
            .map(|age| age.as_secs() > LOG_RETAIN_DAYS * SECONDS_PER_DAY)
            .unwrap_or(false);

        if too_old || total > LOG_TOTAL_LIMIT_BYTES {
            let _ = fs::remove_file(&path);
        }
    }

    Ok(())
}

/// 供 `--action` 无 UI 路径调用：把一步操作的开始事件写进日志（DG 10-8）。
///
/// TODO(M2)：`--action` 全链路落地后，把「参数、解析结果、每一步耗时、最终结果」
/// 统一经本函数记录，保证右键菜单失败时可从 `logs\` 复原现场。
pub fn trace_action_step(action: &str, detail: &str) {
    tracing::info!(action, detail, "action 步骤");
}

/// 兜底：`%APPDATA%` 不可用时至少让错误可见（不静默吞掉）。
pub fn fallback_report(err: &AppError) {
    eprintln!("[md-viewer] 日志系统不可用：{err}");
}
