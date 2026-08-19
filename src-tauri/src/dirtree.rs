//! DG 5.3.1 / F20 文件夹模式后端：目录单层枚举（前端懒加载配套）+ 目录递归监听。
//!
//! 关键约束：
//! * **严格只读**（红线 5）：本模块只 readdir / watch，绝无任何写文件系统的能力。
//! * **不引入 tauri-plugin-fs**（DG 5.3.1 实现约束）：通用 fs 命令面不暴露给渲染层，
//!   前端只能拿到「单层子项」这一种形状的数据。
//! * 懒加载配套：一次只列**一层**（展开哪层才列哪层），递归留在前端的交互节奏里，
//!   永远不会出现「一口气扫全库」的调用路径——大目录性能预算（DG 3.2）由此兜底。
//! * 监听与 files.rs 的单文件监听**并存**（两套独立槽位）：阅读中的文件仍由
//!   `watch_file` 精确跟踪，本模块只负责树结构层面的增删改名。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::files;

/// 后端 → 前端：已挂载文件夹内发生结构变化（新增/删除/改名）。
/// payload 为**受影响父目录的绝对路径数组**——前端据此只重列已加载的那几层，
/// 而不是整树重扫（UP 批次 5.4「只刷新受影响已加载层」）。
/// 必须与 `src/services/ipc.ts` 的 `EVENT_DIR_TREE_CHANGED` 一致。
pub const EVENT_DIR_TREE_CHANGED: &str = "dir-tree-changed";

/// 单层子项上限（DG 5.3.1）：超出即截断并置 `truncated`，前端加一行提示。
/// 2000 行已远超「树还能读」的范畴，继续渲染只是把内存和滚动条一起拖垮。
pub const DIR_CHILDREN_LIMIT: usize = 2000;

/// 目录事件防抖：复用单文件监听的时长口径（files::WATCH_DEBOUNCE_MS）。
const DIR_DEBOUNCE_MS: u64 = files::WATCH_DEBOUNCE_MS;

/// 噪声目录黑名单（DG 5.3.1）。点开头的隐藏目录（.git/.obsidian/.vscode…）
/// 由 `is_noise_name` 统一挡掉，这里只列**不带点**的常见巨物。
const IGNORED_DIRS: [&str; 2] = ["node_modules", "target"];

/// 树的一个子项。`name` 单独回传（而不是让前端自己截 path）：
/// UNC 路径（\\server\share）与盘根（C:\）的「最后一段」规则不同，统一在后端算好。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirChild {
    pub name: String,
    /// 绝对路径
    pub path: String,
    pub is_dir: bool,
}

/// `list_dir_children` 的回传：单层子项 + 截断标记。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirChildren {
    pub children: Vec<DirChild>,
    pub truncated: bool,
}

/// 列出目录的**直接**子项：子目录 + 受支持的 Markdown 文件。
///
/// 排序不在这里做——中文拼音序（`Intl.Collator('zh')`）只有前端给得出，
/// 后端排一遍纯属浪费。过滤规则（与 DG 5.3.1 逐条对应）：
/// * 跳过符号链接（防循环；`DirEntry::file_type` 本就不追链接，直接判掉）；
/// * 跳过点开头的隐藏项与 [`IGNORED_DIRS`]；
/// * 文件只保留 [`files::is_supported`] 的五种扩展名。
#[tauri::command]
pub async fn list_dir_children(path: String) -> AppResult<DirChildren> {
    let root = files::to_absolute(Path::new(&path));
    let meta = std::fs::symlink_metadata(&root)
        .map_err(|_| AppError::not_found(root.to_string_lossy().into_owned()))?;
    if !meta.is_dir() {
        return Err(AppError::config(format!("不是目录：{}", root.display())));
    }

    let entries = std::fs::read_dir(&root).map_err(|err| {
        tracing::warn!(dir = %root.display(), %err, "读取目录失败");
        AppError::native(format!("读取目录失败：{}（{err}）", root.display()))
    })?;

    let mut children = Vec::new();
    let mut truncated = false;
    for entry in entries {
        // 单个条目读不出元数据（权限/竞态删除）只跳过，不让整层失败
        let Ok(entry) = entry else { continue };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_noise_name(&name) {
            continue;
        }
        // Windows 的隐藏语义是**属性**而不是点前缀（DG 5.3.1「隐藏目录」的另一半口径）。
        // DirEntry::metadata() 在 Windows 上直接复用 FindFirstFile 已带回的数据，
        // 不产生额外 per-item syscall，懒加载性能预算不受影响。
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // FILE_ATTRIBUTE_HIDDEN(0x2) | FILE_ATTRIBUTE_SYSTEM(0x4)
            if let Ok(meta) = entry.metadata() {
                if meta.file_attributes() & 0x6 != 0 {
                    continue;
                }
            }
        }
        let is_dir = file_type.is_dir();
        if !is_dir && !files::is_supported(&entry.path()) {
            continue;
        }
        if children.len() >= DIR_CHILDREN_LIMIT {
            truncated = true;
            break;
        }
        children.push(DirChild {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }

    Ok(DirChildren {
        children,
        truncated,
    })
}

/// 开始递归监听已挂载的文件夹（同一时刻只监听一个根，切换即替换——与 F20
/// 「单根项目」的产品形态一致，也避免多 watcher 把目录句柄攒成卸载障碍）。
#[tauri::command]
pub async fn watch_dir(app: AppHandle, path: String) -> AppResult<()> {
    let root = files::to_absolute(Path::new(&path));
    if !root.is_dir() {
        return Err(AppError::not_found(root.to_string_lossy().into_owned()));
    }

    let state = dir_watch_state(&app);
    let mut slot = files::lock_or_recover(&state.inner);
    slot.watcher = None;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let (tx, rx) = mpsc::channel::<PathBuf>();
    let filter_root = root.clone();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |result: notify::Result<notify::Event>| match result {
            Ok(event) => {
                // 树只关心**结构**：新增/删除/改名；EventKind::Any（rescan/未知）宁可多刷。
                // 刻意不复用 files::is_content_event——那是给「正文内容变了」用的口径，
                // 它放行全部 Modify(_)，而 Windows 后端（notify/ReadDirectoryChangesW）把
                // 内容保存与杀软/索引器的属性刷新一律映射为 Modify(ModifyKind::Any)，
                // 不滤掉它，外部编辑器的自动保存会变成持续的无效层重列风暴。
                // 结构变化在 Windows 上总以 ADDED/REMOVED/RENAMED_*（→ Create/Remove/
                // Modify(Name)）独立到达，丢弃 Modify(Any) 不损失任何结构事件。
                if !is_structural_event(&event.kind) {
                    return;
                }
                for changed in &event.paths {
                    if !is_tree_relevant(changed, &filter_root) {
                        continue;
                    }
                    // 受影响的「层」= 变更条目的父目录；父目录取不到（根自身）就用根
                    let layer = changed
                        .parent()
                        .map(Path::to_path_buf)
                        .unwrap_or_else(|| filter_root.clone());
                    // 发送失败只意味着防抖线程已退出，忽略即可
                    let _ = tx.send(layer);
                }
            }
            Err(err) => tracing::warn!(%err, "目录监听回调报错"),
        })
        .map_err(|err| {
            tracing::error!(%err, "创建目录监听器失败");
            AppError::native(format!("创建目录监听器失败：{err}"))
        })?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|err| {
            tracing::error!(dir = %root.display(), %err, "监听文件夹失败");
            AppError::native(format!("监听文件夹失败：{}（{err}）", root.display()))
        })?;

    spawn_dir_debounce_thread(app.clone(), rx, Arc::clone(&state.generation), generation);

    slot.watcher = Some(watcher);
    slot.root = Some(root.clone());
    drop(slot);

    tracing::info!(dir = %root.display(), generation, "已开始监听文件夹");
    Ok(())
}

/// 停止目录监听（卸载文件夹 / 退出树视图挂载新根前调用）。
#[tauri::command]
pub async fn unwatch_dir(app: AppHandle) -> AppResult<()> {
    let state = dir_watch_state(&app);
    let mut slot = files::lock_or_recover(&state.inner);
    state.generation.fetch_add(1, Ordering::SeqCst);
    let previous = slot.root.take();
    slot.watcher = None;
    drop(slot);

    match previous {
        Some(path) => tracing::info!(dir = %path.display(), "已停止监听文件夹"),
        None => tracing::debug!("当前没有正在监听的文件夹"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/// 目录监听槽位；与 files.rs 的单文件 WatchState 结构同款但**独立管理**，
/// 两者的生命周期互不牵连（切换阅读文件不影响树，卸载文件夹不影响正文刷新）。
#[derive(Default)]
pub struct DirWatchState {
    inner: Mutex<DirWatchSlot>,
    generation: Arc<AtomicU64>,
}

#[derive(Default)]
struct DirWatchSlot {
    /// 丢弃即停止监听
    watcher: Option<RecommendedWatcher>,
    root: Option<PathBuf>,
}

/// 取（必要时惰性注册）目录监听状态——与 files::watch_state 同款的惰性 manage。
fn dir_watch_state(app: &AppHandle) -> tauri::State<'_, DirWatchState> {
    if app.try_state::<DirWatchState>().is_none() {
        let _ = app.manage(DirWatchState::default());
    }
    app.state::<DirWatchState>()
}

/// 隐藏项 / 噪声目录判定：点开头一律隐藏（.git/.obsidian 自然被覆盖），
/// 另加 [`IGNORED_DIRS`] 黑名单。文件与目录同一口径——树里本来就不显示隐藏文件。
fn is_noise_name(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name.to_ascii_lowercase().as_str())
}

/// 只放行结构事件（见 watch_dir 回调处的完整理由）。
fn is_structural_event(kind: &notify::EventKind) -> bool {
    use notify::event::ModifyKind;
    matches!(
        kind,
        notify::EventKind::Any
            | notify::EventKind::Create(_)
            | notify::EventKind::Remove(_)
            | notify::EventKind::Modify(ModifyKind::Name(_))
    )
}

/// 明确该滤的临时产物扩展名（编辑器换名保存、下载器占位）。
/// 这是**黑名单**而不是 Markdown 白名单——见 [`is_tree_relevant`] 的教训注释。
const JUNK_EXTS: [&str; 5] = ["tmp", "swp", "swx", "bak", "crdownload"];

/// 这条变更值不值得刷新树：
/// * 路径落在噪声目录里（.git 的对象写入风暴）→ 不值得；
/// * 路径还存在且是**目录** → 一律值得——目录名带点极常见（「1.前端」「2024.08」），
///   `Path::extension()` 会给它们切出伪扩展名，早期版本按 Markdown 白名单过滤，
///   导致这类目录的新建/改名在树里**永久失明**（复审 2026-08-19 确认的 major）；
/// * 路径还存在且是文件 → 按五种受支持扩展名放行；
/// * 路径已不存在（删除/改名旧址，无法 stat）→ 无从区分目录与文件，
///   只滤明确的临时产物黑名单 [`JUNK_EXTS`]，其余宁可多刷一次
///   （防抖已合并层，代价只是每 300ms 窗口一次单层 readdir）。
fn is_tree_relevant(changed: &Path, root: &Path) -> bool {
    let under_noise = changed
        .strip_prefix(root)
        .ok()
        .map(|rel| {
            rel.components().any(|part| {
                part.as_os_str()
                    .to_str()
                    .map(is_noise_name)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if under_noise {
        return false;
    }
    if let Ok(meta) = std::fs::symlink_metadata(changed) {
        if meta.is_dir() {
            return true;
        }
        return files::is_supported(changed);
    }
    match changed.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if JUNK_EXTS.contains(&ext.to_ascii_lowercase().as_str()) => false,
        _ => !changed.to_string_lossy().ends_with('~'),
    }
}

/// 目录防抖线程：吞并防抖窗口内的所有事件，**汇总受影响的父目录集合**后一次 emit。
/// 与 files.rs 的单文件防抖同一节奏（300ms 静默才发），不同点在于 payload 带信息量：
/// 一次「解压 50 个 md 进子目录」只产生一条事件、一个父目录，前端只重列那一层。
fn spawn_dir_debounce_thread(
    app: AppHandle,
    rx: mpsc::Receiver<PathBuf>,
    generation: Arc<AtomicU64>,
    my_generation: u64,
) {
    let build = std::thread::Builder::new()
        .name("mdnaonao-dirwatch".into())
        .spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut layers: HashSet<PathBuf> = HashSet::from([first]);
                let mut aborted = false;
                loop {
                    match rx.recv_timeout(Duration::from_millis(DIR_DEBOUNCE_MS)) {
                        Ok(layer) => {
                            layers.insert(layer);
                        }
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

                let payload: Vec<String> = layers
                    .iter()
                    .map(|layer| layer.to_string_lossy().into_owned())
                    .collect();
                tracing::info!(layers = payload.len(), "文件夹变更已防抖合并，推送前端");
                if let Err(err) = app.emit(EVENT_DIR_TREE_CHANGED, payload) {
                    tracing::error!(%err, "推送文件夹变更事件失败");
                }
            }
            tracing::debug!(my_generation, "目录防抖线程退出");
        });
    if let Err(err) = build {
        tracing::error!(%err, "创建目录防抖线程失败，本次监听不会推送事件");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_names_are_filtered() {
        assert!(is_noise_name(".git"));
        assert!(is_noise_name(".obsidian"));
        assert!(is_noise_name("node_modules"));
        assert!(is_noise_name("NODE_MODULES"));
        assert!(!is_noise_name("docs"));
        assert!(!is_noise_name("中文目录"));
    }

    #[test]
    fn tree_relevance_filters_temp_files_but_keeps_dirs() {
        let root = Path::new(r"C:\notes");
        // 无扩展名（已不存在，stat 不到）：可能是目录，宁可多刷
        assert!(is_tree_relevant(Path::new(r"C:\notes\子目录"), root));
        // 带点的目录名（已不存在）：伪扩展名不在黑名单 → 放行（major 回归的钉子）
        assert!(is_tree_relevant(Path::new(r"C:\notes\v1.0"), root));
        assert!(is_tree_relevant(Path::new(r"C:\notes\2024.08"), root));
        // 受支持扩展名
        assert!(is_tree_relevant(Path::new(r"C:\notes\周报.md"), root));
        // 编辑器临时文件与换名保存产物
        assert!(!is_tree_relevant(Path::new(r"C:\notes\周报.md.tmp"), root));
        assert!(!is_tree_relevant(Path::new(r"C:\notes\a.swp"), root));
        assert!(!is_tree_relevant(Path::new(r"C:\notes\周报.md~"), root));
        // 噪声目录内部的风暴
        assert!(!is_tree_relevant(
            Path::new(r"C:\notes\.git\objects\ab"),
            root
        ));
        assert!(!is_tree_relevant(
            Path::new(r"C:\notes\node_modules\x\README.md"),
            root
        ));
    }

    #[test]
    fn tree_relevance_stats_existing_paths() {
        // 真实存在的「带点目录」必须放行；存在的非 Markdown 文件必须滤掉
        let dir =
            std::env::temp_dir().join(format!("mdnaonao-dirtree-stat-{}", std::process::id()));
        let dotted = dir.join("1.前端");
        std::fs::create_dir_all(&dotted).unwrap();
        std::fs::write(dir.join("图.png"), [0u8; 4]).unwrap();

        assert!(is_tree_relevant(&dotted, &dir));
        assert!(!is_tree_relevant(&dir.join("图.png"), &dir));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn structural_event_filter_matches_windows_semantics() {
        use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};
        use notify::EventKind;
        // 结构事件放行
        assert!(is_structural_event(&EventKind::Any));
        assert!(is_structural_event(&EventKind::Create(CreateKind::Any)));
        assert!(is_structural_event(&EventKind::Remove(RemoveKind::Any)));
        assert!(is_structural_event(&EventKind::Modify(ModifyKind::Name(
            RenameMode::Any
        ))));
        // 内容/属性事件滤掉——Windows 后端把内容保存映射为 Modify(Any)，必须挡住
        assert!(!is_structural_event(&EventKind::Modify(ModifyKind::Any)));
        assert!(!is_structural_event(&EventKind::Modify(ModifyKind::Data(
            DataChange::Any
        ))));
    }

    #[cfg(windows)]
    #[test]
    fn hidden_attribute_dirs_are_filtered() {
        let dir =
            std::env::temp_dir().join(format!("mdnaonao-dirtree-hidden-{}", std::process::id()));
        let hidden = dir.join("隐藏区");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(dir.join("可见.md"), "# t").unwrap();
        // 用 attrib 设置隐藏属性；环境异常（attrib 不可用）时放弃断言而不是误报
        let set = std::process::Command::new("attrib")
            .arg("+h")
            .arg(&hidden)
            .status();
        if set.map(|status| status.success()).unwrap_or(false) {
            let result = tauri::async_runtime::block_on(list_dir_children(
                dir.to_string_lossy().into_owned(),
            ))
            .unwrap();
            let names: Vec<&str> = result.children.iter().map(|c| c.name.as_str()).collect();
            assert!(names.contains(&"可见.md"));
            assert!(!names.contains(&"隐藏区"));
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_dir_children_filters_and_reports() {
        let dir =
            std::env::temp_dir().join(format!("mdnaonao-dirtree-test-{}", std::process::id()));
        let sub = dir.join("子目录");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
        std::fs::write(dir.join("笔记.md"), "# t").unwrap();
        std::fs::write(dir.join("图.png"), [0u8; 4]).unwrap();

        let result =
            tauri::async_runtime::block_on(list_dir_children(dir.to_string_lossy().into_owned()))
                .unwrap();
        let names: Vec<&str> = result.children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"子目录"));
        assert!(names.contains(&"笔记.md"));
        assert!(!names.contains(&".obsidian"));
        assert!(!names.contains(&"图.png"));
        assert!(!result.truncated);

        std::fs::remove_dir_all(&dir).ok();
    }
}
