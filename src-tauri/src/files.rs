//! DG 7.1 `files.rs` 职责：文件读写、编码检测（UTF-8/BOM/GBK）、标题提取、
//! `recent.json` 持久化、notify 文件监听。
//!
//! 关键约束：
//! * **严格只读**（红线 5）：本模块只提供读取能力，任何写回 `.md` 的函数都不许出现。
//!   本模块唯一的写盘目标是 `%APPDATA%\MDNaonao\recent.json`（应用自身数据）。
//! * 编码（DG 8「编码」+ DG 10-4）：UTF-8 优先 → 去 BOM → 失败按 GBK 兜底，
//!   状态栏显示实际编码。GBK 兜底不做会被中文用户骂乱码。
//! * 最近列表（DG 5.3 / 7.3）：上限 200 条 LRU，内存缓存 + 同步写盘。
//! * 监听（DG 7.2-3 / FR-06）：notify 事件 → 防抖 300ms → 前端离屏重渲染 →
//!   一次性替换并保持滚动位置；文件被删除/移动 → 顶栏警示条。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};

/// 最近列表上限（DG 5.3）。
pub const RECENT_LIMIT: usize = 200;

/// 最近列表写盘防抖（DG 7.3）。
///
/// 说明：M1 实现选择「内存缓存 + 每次变更同步写盘」——200 条 JSON 不足 100KB，
/// 单次写入远低于一帧预算，引入定时器反而带来「退出时丢最后一次变更」的风险。
/// 常量保留，供后续如果改成定时刷盘时复用。
pub const RECENT_WRITE_DEBOUNCE_MS: u64 = 500;

/// 文件变更防抖（DG 7.2-3）。
pub const WATCH_DEBOUNCE_MS: u64 = 300;

/// 大文件阈值（FR-01：>5MB 直接打开 + 提示条 + 分段渲染）。
pub const LARGE_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// 支持的扩展名，必须与 `tauri.conf.json` 的 `bundle.fileAssociations.ext` 完全一致。
pub const SUPPORTED_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "mkdn"];

/// 后端 → 前端：当前文件内容变更（payload 为绝对路径字符串）。
/// 必须与 `src/services/ipc.ts` 的 `EVENT_FILE_CHANGED` 一致。
pub const EVENT_FILE_CHANGED: &str = "file-changed";

/// 后端 → 前端：当前文件被删除/移走（payload 为绝对路径字符串，**不是对象**）。
/// 前端 `services/ipc.ts` 的 `EVENT_FILE_REMOVED` / `onFileRemoved` 与之对应，
/// 顶栏 slide-down 警示条据此弹出；文件回来时会再收到一次
/// [`EVENT_FILE_CHANGED`]（同样是路径字符串），前端据此撤条（FR-06）。
pub const EVENT_FILE_REMOVED: &str = "file-removed";

/// UTF-8 BOM 字节序列。
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 实际使用的解码方式，回传前端显示在状态栏。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Gbk,
}

impl Encoding {
    /// 状态栏展示名。
    pub fn label(&self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf8Bom => "UTF-8 BOM",
            Encoding::Gbk => "GBK",
        }
    }
}

/// 一次「打开文件」的完整回传载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    /// 绝对路径
    pub path: String,
    /// 标题：首个 H1，无则文件名（DG 5.3）
    pub title: String,
    /// 原始 Markdown 文本（frontmatter 的剥离在前端渲染层做，FR-14）
    pub content: String,
    pub encoding: Encoding,
    pub byte_size: u64,
    pub line_count: usize,
    /// 是否超过 [`LARGE_FILE_BYTES`]，前端据此走分段渲染 + 顶部提示条
    pub is_large: bool,
}

/// 滚动位置记忆（FR-16：首个可见标题锚点 + 偏移）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollAnchor {
    /// 标题元素 id；文档无标题时为空串，退化为纯偏移
    pub heading_id: String,
    /// 相对该标题顶部的像素偏移
    pub offset: f64,
}

/// 最近列表条目（DG 5.3 数据模型）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub title: String,
    /// Unix 毫秒时间戳
    pub opened_at: i64,
    pub pinned: bool,
    /// 滚动位置记忆（FR-16）；与前端 `ScrollAnchor` 类型逐字段对应
    pub scroll_anchor: Option<ScrollAnchor>,
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

/// 读取并解码一个 Markdown 文件。
///
/// 流程：元数据校验 → 读字节 → [`detect_and_decode`] → [`extract_title`] → 组装载荷。
/// 路径不存在/不是文件返回 [`AppError::NotFound`]（FR-06 警示条依赖此错误 kind）。
#[tauri::command]
pub async fn read_markdown(path: String) -> AppResult<DocumentPayload> {
    let started = Instant::now();
    let target = to_absolute(Path::new(&path));

    let meta = std::fs::metadata(&target).map_err(|err| {
        tracing::warn!(path = %target.display(), %err, "读取文件元数据失败");
        AppError::not_found(format!("{}（{err}）", target.display()))
    })?;
    if !meta.is_file() {
        tracing::warn!(path = %target.display(), "目标不是文件");
        return Err(AppError::not_found(format!(
            "不是文件：{}",
            target.display()
        )));
    }
    if !is_supported(&target) {
        // 不拦截：CLI / 拖拽可能传入 .txt 等，仍按 Markdown 渲染，只留痕
        tracing::warn!(path = %target.display(), "扩展名不在关联清单内，仍按 Markdown 处理");
    }

    let bytes = std::fs::read(&target).map_err(|err| {
        tracing::error!(path = %target.display(), %err, "读取文件内容失败");
        AppError::Io(err)
    })?;
    let byte_size = bytes.len() as u64;

    let (content, encoding) = detect_and_decode(&bytes).map_err(|err| {
        tracing::error!(path = %target.display(), %err, "解码失败");
        err
    })?;

    let title = extract_title(&content, &target);
    let line_count = count_lines(&content);
    let is_large = byte_size > LARGE_FILE_BYTES;

    let elapsed_ms = started.elapsed().as_millis() as u64;
    if is_large {
        tracing::warn!(
            path = %target.display(),
            byte_size,
            elapsed_ms,
            "大文件（>5MB），前端需走分段渲染"
        );
    } else {
        tracing::info!(
            path = %target.display(),
            byte_size,
            line_count,
            encoding = encoding.label(),
            elapsed_ms,
            "文件读取完成"
        );
    }

    Ok(DocumentPayload {
        path: target.to_string_lossy().into_owned(),
        title,
        content,
        encoding,
        byte_size,
        line_count,
        is_large,
    })
}

/// 读取最近列表（已排序：置顶优先，其次打开时间倒序）。
///
/// 文件缺失返回空数组；损坏时备份后重建（不阻塞启动）。
#[tauri::command]
pub async fn list_recent() -> AppResult<Vec<RecentEntry>> {
    let entries = {
        let mut guard = lock_recent();
        guard.get_or_insert_with(read_recent_from_disk).clone()
    };
    tracing::debug!(total = entries.len(), "回传最近列表");
    Ok(entries)
}

/// 打开文件后更新最近列表（LRU 提前 + 超 [`RECENT_LIMIT`] 淘汰）。
///
/// 合并策略：置顶态只由 [`set_recent_pinned`] 变更，故这里保留旧值；
/// 传入未带滚动锚点时同样保留旧值，避免「重新打开就丢失阅读位置」。
#[tauri::command]
pub async fn touch_recent(entry: RecentEntry) -> AppResult<Vec<RecentEntry>> {
    let path = entry.path.clone();
    let snapshot = mutate_recent(|entries| {
        upsert_entry(entries, entry);
    });
    tracing::info!(%path, total = snapshot.len(), "最近列表已更新");
    Ok(snapshot)
}

/// 从最近列表移除（**不删文件**，FR-03）。
#[tauri::command]
pub async fn remove_recent(path: String) -> AppResult<Vec<RecentEntry>> {
    let key = path_key(&path);
    let snapshot = mutate_recent(|entries| {
        entries.retain(|item| path_key(&item.path) != key);
    });
    tracing::info!(%path, total = snapshot.len(), "已从最近列表移除（未删除文件）");
    Ok(snapshot)
}

/// 置顶 / 取消置顶（FR-03）。
#[tauri::command]
pub async fn set_recent_pinned(path: String, pinned: bool) -> AppResult<Vec<RecentEntry>> {
    let key = path_key(&path);
    let mut hit = false;
    let snapshot = mutate_recent(|entries| {
        for item in entries.iter_mut() {
            if path_key(&item.path) == key {
                item.pinned = pinned;
                hit = true;
            }
        }
    });
    if hit {
        tracing::info!(%path, pinned, "最近列表置顶态已更新");
    } else {
        // 容错：条目可能刚被别处移除，不视为错误
        tracing::warn!(%path, "置顶目标不在最近列表中，已忽略");
    }
    Ok(snapshot)
}

/// 记录滚动锚点（FR-16 滚动位置记忆）。
///
/// 契约：返回 `()`（与 `ipc.ts` 的 `setScrollAnchor(): Promise<void>` 对齐）——
/// 该命令在滚动停止后高频调用，不需要回传全表。
#[tauri::command]
pub async fn set_scroll_anchor(path: String, anchor: Option<ScrollAnchor>) -> AppResult<()> {
    let key = path_key(&path);
    let mut hit = false;
    let _ = mutate_recent(|entries| {
        for item in entries.iter_mut() {
            if path_key(&item.path) == key {
                item.scroll_anchor = anchor.clone();
                hit = true;
            }
        }
    });
    if !hit {
        tracing::debug!(%path, "滚动锚点目标不在最近列表中，已忽略");
    }
    Ok(())
}

/// 批量探测路径是否存在，返回其中**不存在**的那部分（UPGRADE_PLAN 1.8「失效路径灰显」）。
///
/// 契约：入参是前端最近列表里的原始路径字符串，回传的也是**原样的那些字符串**——
/// 前端拿到就能直接塞进 `missingPaths` 做集合比对，不必再做一次归一化。
/// 只回传失效子集而不是全量布尔表：200 条列表里失效通常是个位数。
///
/// 探测本身是同步 IO（UNC/离线盘符上单次 `metadata` 可能阻塞数秒），
/// 因此整批丢到阻塞线程池跑，不占用 async 运行时的工作线程。
#[tauri::command]
pub async fn probe_paths(paths: Vec<String>) -> AppResult<Vec<String>> {
    let total = paths.len();
    let missing = tauri::async_runtime::spawn_blocking(move || missing_paths(paths))
        .await
        .map_err(|err| {
            tracing::error!(%err, "批量探测路径的任务失败");
            AppError::native(format!("批量探测路径失败：{err}"))
        })?;

    tracing::debug!(total, missing = missing.len(), "批量探测路径完成");
    Ok(missing)
}

/// 在资源管理器中定位文件（FR-03「打开所在文件夹」）。
///
/// explorer.exe 的命令行解析不遵循 CRT 规则（`/select,` 后必须紧跟带引号的路径，
/// 且整体不能被再包一层引号），故走 `raw_arg` 自己拼；同时它的退出码不可靠
/// （成功也常返回 1），因此只 spawn 不 wait、不据此判失败。
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> AppResult<()> {
    let target = to_absolute(Path::new(&path));
    if !target.exists() {
        tracing::warn!(path = %target.display(), "定位目标不存在");
        return Err(AppError::not_found(target.to_string_lossy().into_owned()));
    }
    spawn_explorer_select(&target)?;
    tracing::info!(path = %target.display(), "已请求资源管理器定位");
    Ok(())
}

#[cfg(windows)]
fn spawn_explorer_select(target: &Path) -> AppResult<()> {
    use std::os::windows::process::CommandExt;

    // explorer 只认反斜杠；正斜杠会被当成参数分隔导致「打开我的文档」
    let native = target.to_string_lossy().replace('/', "\\");
    if native.contains('"') {
        // 路径里出现引号无法安全拼进 raw_arg（Windows 文件名本就不允许 `"`）
        return Err(AppError::native(format!("路径含非法引号字符：{native}")));
    }
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{native}\""))
        .spawn()
        .map_err(|err| {
            tracing::error!(%err, path = %native, "启动 explorer.exe 失败");
            AppError::native(format!("启动 explorer.exe 失败：{err}"))
        })?;
    Ok(())
}

#[cfg(not(windows))]
fn spawn_explorer_select(target: &Path) -> AppResult<()> {
    Err(AppError::not_implemented(format!(
        "资源管理器定位仅 Windows 可用：{}",
        target.display()
    )))
}

/// 开始监听当前文件（同一时刻只监听一个文件，切换文件时自动替换）。
///
/// 监听的是**父目录**而非文件本身：编辑器保存多为「写临时文件 + rename 覆盖」，
/// 直接盯文件的句柄会在第一次保存后失效。事件按目标文件名过滤 → 防抖
/// [`WATCH_DEBOUNCE_MS`] → 依据文件是否仍存在 emit
/// [`EVENT_FILE_CHANGED`] / [`EVENT_FILE_REMOVED`]。
#[tauri::command]
pub async fn watch_file(app: AppHandle, path: String) -> AppResult<()> {
    let target = to_absolute(Path::new(&path));
    let dir = target
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::config(format!("路径没有父目录：{}", target.display())))?;
    if !target.is_file() {
        tracing::warn!(path = %target.display(), "监听目标不是文件");
        return Err(AppError::not_found(target.to_string_lossy().into_owned()));
    }

    let state = watch_state(&app);
    let mut slot = lock_or_recover(&state.inner);

    // 先释放旧 watcher 再建新的：Windows 上目录句柄不释放会拖住重命名/卸载
    if let Some(previous) = slot.target.take() {
        tracing::debug!(path = %previous.display(), "切换监听目标，先释放旧监听");
    }
    slot.watcher = None;

    // 代次自增：留在防抖窗口里的旧线程据此自杀，不会串扰新文件
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let (tx, rx) = mpsc::channel::<()>();
    let filter = target.clone();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |result: notify::Result<notify::Event>| match result {
            Ok(event) => {
                if !is_content_event(&event.kind) {
                    return;
                }
                if event.paths.iter().any(|p| same_path(p, &filter)) {
                    // 发送失败只意味着防抖线程已退出，忽略即可
                    let _ = tx.send(());
                }
            }
            Err(err) => tracing::warn!(%err, "文件监听回调报错"),
        },
    )
    .map_err(|err| {
        tracing::error!(%err, "创建文件监听器失败");
        AppError::native(format!("创建文件监听器失败：{err}"))
    })?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|err| {
            tracing::error!(dir = %dir.display(), %err, "监听目录失败");
            AppError::native(format!("监听目录失败：{}（{err}）", dir.display()))
        })?;

    spawn_debounce_thread(
        app.clone(),
        target.clone(),
        rx,
        Arc::clone(&state.generation),
        generation,
    );

    slot.watcher = Some(watcher);
    slot.target = Some(target.clone());
    drop(slot);

    tracing::info!(path = %target.display(), dir = %dir.display(), generation, "已开始监听文件");
    Ok(())
}

/// 停止监听。
#[tauri::command]
pub async fn unwatch_file(app: AppHandle) -> AppResult<()> {
    let state = watch_state(&app);
    let mut slot = lock_or_recover(&state.inner);
    // 代次自增会让仍在防抖窗口里的线程放弃本次 emit
    state.generation.fetch_add(1, Ordering::SeqCst);
    let previous = slot.target.take();
    // 丢弃 watcher 即停止监听，并连带关闭 channel，让防抖线程自然退出
    slot.watcher = None;
    drop(slot);

    match previous {
        Some(path) => tracing::info!(path = %path.display(), "已停止监听文件"),
        None => tracing::debug!("当前没有正在监听的文件"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 监听内部实现
// ---------------------------------------------------------------------------

/// 监听句柄容器，经 `app.manage()` 挂在 Tauri 全局状态上（同一时刻只有一个监听）。
#[derive(Default)]
pub struct WatchState {
    inner: Mutex<WatchSlot>,
    /// 单调递增代次：切换/停止监听时自增，防抖线程据此判断自己是否已过期
    generation: Arc<AtomicU64>,
}

#[derive(Default)]
struct WatchSlot {
    /// 丢弃即停止监听
    watcher: Option<RecommendedWatcher>,
    target: Option<PathBuf>,
}

/// 取（必要时惰性注册）监听状态。
///
/// 说明：`lib.rs::run` 目前没有注册这个状态，为了不越界改别的文件，这里首次调用时
/// 自行 `manage`。并发首调时后到者的 `manage` 返回 false 且值被丢弃，取到的仍是同一个实例。
fn watch_state(app: &AppHandle) -> tauri::State<'_, WatchState> {
    if app.try_state::<WatchState>().is_none() {
        let _ = app.manage(WatchState::default());
    }
    app.state::<WatchState>()
}

/// 只关心「内容可能变了」的事件：Access（打开/读取）在某些后端会刷屏，直接滤掉。
fn is_content_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Any | EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

/// 防抖线程：首个事件到达后持续吞并后续事件，直到静默 [`WATCH_DEBOUNCE_MS`] 才 emit 一次。
///
/// Windows 上一次「保存」通常产生 3–5 个事件（临时文件写入 + rename + 属性更新），
/// 不合并会让前端连着重渲染好几遍。
fn spawn_debounce_thread(
    app: AppHandle,
    target: PathBuf,
    rx: mpsc::Receiver<()>,
    generation: Arc<AtomicU64>,
    my_generation: u64,
) {
    let build = std::thread::Builder::new()
        .name("mdnaonao-watch".into())
        .spawn(move || {
            let payload = target.to_string_lossy().into_owned();
            loop {
                // 阻塞等第一个事件；sender 随 watcher 一起被丢弃时退出
                if rx.recv().is_err() {
                    break;
                }
                let mut aborted = false;
                loop {
                    match rx.recv_timeout(Duration::from_millis(WATCH_DEBOUNCE_MS)) {
                        Ok(()) => continue,
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            aborted = true;
                            break;
                        }
                    }
                }
                if aborted || generation.load(Ordering::SeqCst) != my_generation {
                    break;
                }

                // 「删除 + 重建」式保存在防抖窗口内已经归位，这里以最终状态为准
                let event_name = if target.is_file() {
                    EVENT_FILE_CHANGED
                } else {
                    EVENT_FILE_REMOVED
                };
                tracing::info!(path = %payload, event_name, "文件变更已防抖合并，推送前端");
                if let Err(err) = app.emit(event_name, payload.clone()) {
                    tracing::error!(%err, event_name, "推送文件变更事件失败");
                }
            }
            tracing::debug!(path = %target.display(), my_generation, "防抖线程退出");
        });
    if let Err(err) = build {
        tracing::error!(%err, "创建防抖线程失败，本次监听不会推送事件");
    }
}

// ---------------------------------------------------------------------------
// 最近列表内部实现
// ---------------------------------------------------------------------------

/// 进程内缓存，避免每次命令都读盘。`None` 表示尚未从磁盘加载。
static RECENT_CACHE: OnceLock<Mutex<Option<Vec<RecentEntry>>>> = OnceLock::new();

fn lock_recent() -> MutexGuard<'static, Option<Vec<RecentEntry>>> {
    lock_or_recover(RECENT_CACHE.get_or_init(|| Mutex::new(None)))
}

/// 锁中毒时取回内部值继续用：最近列表是可再生数据，为它把整个应用卡死不值当。
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 变更缓存 → 排序截断 → 释放锁 → 写盘，返回变更后的全表快照。
fn mutate_recent(change: impl FnOnce(&mut Vec<RecentEntry>)) -> Vec<RecentEntry> {
    let snapshot = {
        let mut guard = lock_recent();
        let entries = guard.get_or_insert_with(read_recent_from_disk);
        change(entries);
        sort_entries(entries);
        entries.truncate(RECENT_LIMIT);
        entries.clone()
    };
    // 写盘放在锁外：IO 再慢也不阻塞其它命令读最近列表
    persist_recent(&snapshot);
    snapshot
}

/// 读盘：任何失败都降级成空表，绝不阻塞启动（DG 7.3）。
fn read_recent_from_disk() -> Vec<RecentEntry> {
    let path = match recent_path() {
        Ok(path) => path,
        Err(err) => {
            tracing::warn!(%err, "取不到 recent.json 路径，按空表处理");
            return Vec::new();
        }
    };

    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(path = %path.display(), "recent.json 不存在，按空表处理");
            return Vec::new();
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), %err, "读取 recent.json 失败，按空表处理");
            return Vec::new();
        }
    };

    match serde_json::from_slice::<Vec<RecentEntry>>(&raw) {
        Ok(mut entries) => {
            sort_entries(&mut entries);
            entries.truncate(RECENT_LIMIT);
            tracing::debug!(total = entries.len(), "最近列表已载入");
            entries
        }
        Err(err) => {
            tracing::error!(path = %path.display(), %err, "recent.json 解析失败，备份后重建");
            backup_corrupt(&path);
            Vec::new()
        }
    }
}

/// 把损坏的 `recent.json` 挪到 `recent.json.corrupt-<毫秒>`，保留现场供排查。
fn backup_corrupt(path: &Path) {
    let backup = path.with_extension(format!("json.corrupt-{}", now_millis()));
    match std::fs::rename(path, &backup) {
        Ok(()) => tracing::warn!(backup = %backup.display(), "损坏的最近列表已备份"),
        Err(err) => tracing::error!(%err, "备份损坏的最近列表失败"),
    }
}

/// 写盘失败不向前端报错：最近列表是辅助数据，本次会话仍以内存表为准，失败只留日志。
fn persist_recent(entries: &[RecentEntry]) {
    if let Err(err) = write_recent(entries) {
        tracing::error!(%err, "最近列表写盘失败（本次会话继续使用内存表）");
    }
}

/// 原子写：先写 `.tmp` 再 rename（Windows 的 rename 会覆盖同名文件）。
fn write_recent(entries: &[RecentEntry]) -> AppResult<()> {
    let path = recent_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(entries)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// 排序：置顶优先，其次打开时间倒序（DG 5.3）。
fn sort_entries(entries: &mut [RecentEntry]) {
    entries.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.opened_at.cmp(&a.opened_at))
    });
}

/// LRU 插入：同路径去重后插到队首；置顶态/滚动锚点/标题在缺省时沿用旧值。
fn upsert_entry(entries: &mut Vec<RecentEntry>, incoming: RecentEntry) {
    let key = path_key(&incoming.path);
    let mut merged = incoming;
    if merged.opened_at <= 0 {
        merged.opened_at = now_millis();
    }

    if let Some(index) = entries.iter().position(|item| path_key(&item.path) == key) {
        let old = entries.remove(index);
        // 置顶态只由 set_recent_pinned 变更，重新打开不该把它抹掉
        merged.pinned = merged.pinned || old.pinned;
        if merged.scroll_anchor.is_none() {
            merged.scroll_anchor = old.scroll_anchor;
        }
        if merged.title.trim().is_empty() {
            merged.title = old.title;
        }
    }

    entries.insert(0, merged);
    sort_entries(entries);
    entries.truncate(RECENT_LIMIT);
}

/// 路径归一化比较键：Windows 大小写不敏感，且 `/` 与 `\` 等价。
fn path_key(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// 两个路径是否指向同一个文件（按 [`path_key`] 归一化后比较）。
fn same_path(a: &Path, b: &Path) -> bool {
    path_key(&a.to_string_lossy()) == path_key(&b.to_string_lossy())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// [`probe_paths`] 的同步内核：过滤出**当前不存在**的路径，保留调用方给的原始写法。
///
/// 空串/纯空白直接算失效（`Path::new("").exists()` 本就是 false，这里显式短路，
/// 省掉一次对当前工作目录的 stat）。
fn missing_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| path.trim().is_empty() || !to_absolute(Path::new(path)).exists())
        .collect()
}

/// 相对路径按当前工作目录补全；不做 `canonicalize`——它会返回 `\\?\C:\…`
/// 这种 UNC 前缀，explorer 与前端展示都不认。
fn to_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

/// 行数：末尾换行不额外计一行（与编辑器口径一致）。
fn count_lines(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    let newlines = content.bytes().filter(|byte| *byte == b'\n').count();
    if content.ends_with('\n') {
        newlines
    } else {
        newlines + 1
    }
}

/// 编码检测与解码：UTF-8 BOM → 严格 UTF-8 → GBK 兜底（DG 8「编码」）。
///
/// GBK 分支用 `encoding_rs`，它的 GBK 解码器实际按 GB18030 超集工作，
/// 能覆盖绝大多数中文老文件；个别不可映射字节退化为替换字符而非报错——
/// 显示部分乱码也远好过整篇打不开（DG 10-4）。
pub fn detect_and_decode(bytes: &[u8]) -> AppResult<(String, Encoding)> {
    if bytes.starts_with(&UTF8_BOM) {
        let body = &bytes[UTF8_BOM.len()..];
        return match std::str::from_utf8(body) {
            Ok(text) => Ok((text.to_owned(), Encoding::Utf8Bom)),
            Err(err) => Err(AppError::encoding(format!(
                "带 UTF-8 BOM 但正文不是合法 UTF-8：{err}"
            ))),
        };
    }

    // UTF-16 只能明确报错：Encoding 枚举是前后端契约，不能私自加变体
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(AppError::encoding(
            "检测到 UTF-16 BOM，当前仅支持 UTF-8 / GBK".to_string(),
        ));
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_owned(), Encoding::Utf8));
    }

    let (text, had_errors) = encoding_rs::GBK.decode_without_bom_handling(bytes);
    if had_errors {
        tracing::warn!("GBK 兜底解码遇到不可映射字节，已用替换字符占位");
    }
    Ok((text.into_owned(), Encoding::Gbk))
}

/// 提取标题：首个 H1（`# `），无则回退文件名（不含扩展名）（DG 5.3）。
pub fn extract_title(content: &str, path: &Path) -> String {
    first_h1(content).unwrap_or_else(|| {
        path.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default()
    })
}

/// 扫描正文取首个 ATX H1；跳过 YAML frontmatter 与围栏代码块
/// （否则 YAML 注释 `# xxx` 或 shell 代码块里的 `# 注释` 会被误当标题）。
fn first_h1(content: &str) -> Option<String> {
    let mut fence: Option<(char, usize)> = None;

    for line in strip_frontmatter(content).lines() {
        if let Some((marker, width)) = fence {
            // 闭合围栏：同种字符且不短于开栏
            if matches!(fence_marker(line), Some((ch, len)) if ch == marker && len >= width) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_marker(line) {
            fence = Some(open);
            continue;
        }
        if let Some(title) = atx_h1(line) {
            return Some(title);
        }
    }
    None
}

/// 剥掉 YAML frontmatter，返回正文切片。
///
/// 只有「首行恰为 `---` 且后续存在闭合行」才算 frontmatter；未闭合时原样返回，
/// 避免把一篇以分隔线开头的普通文档整段吞掉。
fn strip_frontmatter(content: &str) -> &str {
    let mut lines = content.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return content;
    };
    if trim_line(first) != "---" {
        return content;
    }

    let mut offset = first.len();
    for line in lines {
        offset += line.len();
        let trimmed = trim_line(line);
        if trimmed == "---" || trimmed == "..." {
            return &content[offset..];
        }
    }
    content
}

fn trim_line(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r']).trim_end()
}

/// 围栏代码块起止标记：行首最多 3 个空格 + 连续 ≥3 个 `` ` `` 或 `~`。
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let marker = body.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let width = body.chars().take_while(|ch| *ch == marker).count();
    (width >= 3).then_some((marker, width))
}

/// ATX 一级标题：行首最多 3 个空格 + 单个 `#` + 空白 + 文本，末尾可带闭合 `#`。
fn atx_h1(line: &str) -> Option<String> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let rest = body.strip_prefix('#')?;
    // `##` 是 H2、`#Title` 不是标题（CommonMark 要求 `#` 后必须有空白）
    if !rest.starts_with([' ', '\t']) {
        return None;
    }

    let mut text = rest.trim();
    // 闭合序列只有在其前面是空白（或整行只剩 `#`）时才算，否则 `# C#` 会被砍成 `C`
    if let Some(stripped) = text.strip_suffix('#') {
        let head = stripped.trim_end_matches('#');
        if head.is_empty() || head.ends_with([' ', '\t']) {
            text = head.trim_end();
        }
    }

    (!text.is_empty()).then(|| text.to_owned())
}

/// 是否为受支持的 Markdown 扩展名（大小写不敏感）。
pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            SUPPORTED_EXTENSIONS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

/// `recent.json` 路径。
pub fn recent_path() -> AppResult<PathBuf> {
    Ok(crate::settings::app_data_dir()?.join("recent.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, opened_at: i64, pinned: bool) -> RecentEntry {
        RecentEntry {
            path: path.to_string(),
            title: path.to_string(),
            opened_at,
            pinned,
            scroll_anchor: None,
        }
    }

    /// 扩展名判定必须覆盖五个关联后缀且大小写不敏感（与 fileAssociations 对齐）。
    #[test]
    fn recognizes_all_associated_extensions() {
        for ext in SUPPORTED_EXTENSIONS {
            let path = PathBuf::from(format!("D:\\a.{ext}"));
            assert!(is_supported(&path), "应支持 .{ext}");
        }
        assert!(is_supported(Path::new("D:\\A.MD")));
        assert!(!is_supported(Path::new("D:\\a.txt")));
        assert!(!is_supported(Path::new("D:\\a")));
    }

    /// 无 H1 时标题回退为文件名（不含扩展名）。
    #[test]
    fn falls_back_to_file_stem_as_title() {
        let title = extract_title("正文没有标题", Path::new("D:\\笔记\\我的文档.md"));
        assert_eq!(title, "我的文档");
    }

    /* ── 编码检测（DG 8） ─────────────────────────────────────── */

    #[test]
    fn decodes_plain_utf8() {
        let (text, encoding) = detect_and_decode("中文 hello".as_bytes()).expect("应解码成功");
        assert_eq!(text, "中文 hello");
        assert_eq!(encoding, Encoding::Utf8);
    }

    /// BOM 必须被剥掉，否则 Vditor 会把 U+FEFF 当正文首字符渲染出来。
    #[test]
    fn strips_utf8_bom_and_reports_it() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice("# 标题".as_bytes());
        let (text, encoding) = detect_and_decode(&bytes).expect("应解码成功");
        assert_eq!(text, "# 标题");
        assert!(!text.starts_with('\u{feff}'));
        assert_eq!(encoding, Encoding::Utf8Bom);
    }

    /// 非法 UTF-8 走 GBK 兜底（中文用户的老文件大量如此）。
    #[test]
    fn falls_back_to_gbk_for_non_utf8_bytes() {
        let (bytes, _, _) = encoding_rs::GBK.encode("你好，世界");
        assert!(std::str::from_utf8(&bytes).is_err(), "样本应当不是合法 UTF-8");
        let (text, encoding) = detect_and_decode(&bytes).expect("应解码成功");
        assert_eq!(text, "你好，世界");
        assert_eq!(encoding, Encoding::Gbk);
    }

    /// UTF-16 不在支持范围内，必须明确报编码错误而不是吐一屏乱码。
    #[test]
    fn rejects_utf16_with_encoding_error() {
        let bytes = [0xFF, 0xFE, 0x41, 0x00];
        let err = detect_and_decode(&bytes).expect_err("应报错");
        assert_eq!(err.kind(), "encoding");
    }

    #[test]
    fn counts_lines_without_trailing_newline_inflation() {
        assert_eq!(count_lines(""), 0);
        assert_eq!(count_lines("a"), 1);
        assert_eq!(count_lines("a\n"), 1);
        assert_eq!(count_lines("a\nb"), 2);
        assert_eq!(count_lines("a\r\nb\r\n"), 2);
    }

    /* ── 标题提取（DG 5.3） ───────────────────────────────────── */

    #[test]
    fn takes_first_h1_as_title() {
        let content = "前言段落\n\n# 真正的标题\n\n# 第二个标题";
        assert_eq!(extract_title(content, Path::new("D:\\a.md")), "真正的标题");
    }

    /// H2 及「`#` 后无空白」都不是 H1。
    #[test]
    fn ignores_non_h1_headings() {
        let content = "## 二级\n#紧贴的井号\n# 正确的一级";
        assert_eq!(extract_title(content, Path::new("D:\\a.md")), "正确的一级");
    }

    /// 闭合式 ATX 要去掉尾部 `#`，但 `C#` 这种正文里的井号不能误伤。
    #[test]
    fn trims_closing_hashes_but_keeps_inline_hash() {
        assert_eq!(
            extract_title("# 标题 ###", Path::new("D:\\a.md")),
            "标题"
        );
        assert_eq!(extract_title("# C#", Path::new("D:\\a.md")), "C#");
    }

    /// frontmatter 里的 YAML 注释不能被当成标题（DG 5.3 / FR-14）。
    #[test]
    fn skips_yaml_frontmatter_when_extracting_title() {
        let content = "---\ntitle: 元数据\n# 这是 YAML 注释\ntags: [a]\n---\n\n# 正文标题\n";
        assert_eq!(extract_title(content, Path::new("D:\\a.md")), "正文标题");
    }

    /// frontmatter 没有闭合时不能把整篇正文吞掉。
    #[test]
    fn keeps_body_when_frontmatter_is_unterminated() {
        let content = "---\ntitle: 没有闭合\n\n# 仍然要取到的标题\n";
        assert_eq!(
            extract_title(content, Path::new("D:\\a.md")),
            "仍然要取到的标题"
        );
    }

    /// 围栏代码块里的 `# 注释` 不是标题。
    #[test]
    fn skips_fenced_code_blocks_when_extracting_title() {
        let content = "```bash\n# 这是 shell 注释\necho hi\n```\n\n# 真标题\n";
        assert_eq!(extract_title(content, Path::new("D:\\a.md")), "真标题");

        let tilde = "~~~\n# 注释\n~~~\n# 波浪号之后的标题\n";
        assert_eq!(
            extract_title(tilde, Path::new("D:\\a.md")),
            "波浪号之后的标题"
        );
    }

    /* ── 最近列表 ─────────────────────────────────────────────── */

    /// 排序契约：置顶优先，其次打开时间倒序。
    #[test]
    fn sorts_pinned_first_then_recent() {
        let mut entries = vec![
            entry("D:\\c.md", 300, false),
            entry("D:\\a.md", 100, true),
            entry("D:\\b.md", 200, false),
            entry("D:\\d.md", 50, true),
        ];
        sort_entries(&mut entries);
        let paths: Vec<&str> = entries.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["D:\\a.md", "D:\\d.md", "D:\\c.md", "D:\\b.md"]
        );
    }

    /// 同路径去重后置于队首。
    #[test]
    fn upsert_moves_existing_entry_to_front() {
        let mut entries = vec![entry("D:\\a.md", 100, false), entry("D:\\b.md", 200, false)];
        upsert_entry(&mut entries, entry("D:\\a.md", 300, false));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "D:\\a.md");
        assert_eq!(entries[0].opened_at, 300);
    }

    /// 路径比较需大小写不敏感且兼容正斜杠（Windows 语义）。
    #[test]
    fn upsert_dedupes_case_insensitively() {
        let mut entries = vec![entry("D:\\Notes\\A.md", 100, false)];
        upsert_entry(&mut entries, entry("d:/notes/a.md", 200, false));
        assert_eq!(entries.len(), 1, "同一文件的不同写法必须去重");
    }

    /// 重新打开不能抹掉置顶态与滚动锚点。
    #[test]
    fn upsert_preserves_pin_and_anchor() {
        let mut existing = entry("D:\\a.md", 100, true);
        existing.scroll_anchor = Some(ScrollAnchor {
            heading_id: "h-1".to_string(),
            offset: 12.5,
        });
        let mut entries = vec![existing];

        upsert_entry(&mut entries, entry("D:\\a.md", 200, false));
        assert!(entries[0].pinned, "置顶态应保留");
        let anchor = entries[0].scroll_anchor.as_ref().expect("锚点应保留");
        assert_eq!(anchor.heading_id, "h-1");
    }

    /// 超过上限时淘汰最旧的未置顶条目，置顶条目不受影响。
    #[test]
    fn upsert_evicts_beyond_limit_keeping_pinned() {
        let mut entries: Vec<RecentEntry> = (0..RECENT_LIMIT)
            .map(|index| entry(&format!("D:\\{index}.md"), index as i64, false))
            .collect();
        entries[0].pinned = true; // opened_at 最小但置顶
        let pinned_path = entries[0].path.clone();
        sort_entries(&mut entries);

        upsert_entry(&mut entries, entry("D:\\new.md", 9_999, false));

        assert_eq!(entries.len(), RECENT_LIMIT);
        assert_eq!(entries[0].path, pinned_path, "置顶条目仍在首位");
        assert!(
            entries.iter().any(|item| item.path == "D:\\new.md"),
            "新条目应被保留"
        );
    }

    /// 空 opened_at（前端未填）时补当前时间，避免排到列表末尾。
    #[test]
    fn upsert_fills_missing_timestamp() {
        let mut entries = Vec::new();
        upsert_entry(&mut entries, entry("D:\\a.md", 0, false));
        assert!(entries[0].opened_at > 0);
    }

    /* ── 批量探测（1.8 失效路径灰显） ─────────────────────────── */

    /// 只回传失效子集，且**原样**回传调用方给的字符串（前端按字符串比对）。
    #[test]
    fn missing_paths_returns_only_absent_originals() {
        let dir = std::env::temp_dir().join(format!(
            "mdnaonao-probe-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录应成功");
        let alive = dir.join("在的.md");
        std::fs::write(&alive, b"# hi").expect("写临时文件应成功");
        let alive_str = alive.to_string_lossy().into_owned();
        // 大小写/正斜杠的另一种写法也应被认成同一个存在的文件
        let alive_alt = alive_str.replace('\\', "/");
        let gone = dir.join("不在的.md").to_string_lossy().into_owned();

        let missing = missing_paths(vec![
            alive_str.clone(),
            gone.clone(),
            alive_alt,
            String::new(),
            "   ".to_string(),
        ]);

        assert_eq!(missing, vec![gone, String::new(), "   ".to_string()]);
        assert!(
            !missing.contains(&alive_str),
            "存在的文件不该出现在失效列表里"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ── 序列化契约 ───────────────────────────────────────────── */

    /// Encoding 序列化为 kebab-case，与 TS 的 FileEncoding 联合类型逐字对应。
    #[test]
    fn encoding_serializes_as_kebab_case() {
        assert_eq!(
            serde_json::to_string(&Encoding::Utf8Bom).expect("序列化不应失败"),
            "\"utf8-bom\""
        );
        assert_eq!(
            serde_json::to_string(&Encoding::Gbk).expect("序列化不应失败"),
            "\"gbk\""
        );
    }

    /// RecentEntry 走 camelCase，且未设锚点时序列化为 null（TS 侧 `ScrollAnchor | null`）。
    #[test]
    fn recent_entry_serializes_with_camel_case_keys() {
        let json = serde_json::to_value(entry("D:\\a.md", 1, false)).expect("序列化不应失败");
        assert!(json.get("openedAt").is_some());
        assert!(json["scrollAnchor"].is_null());
    }
}
