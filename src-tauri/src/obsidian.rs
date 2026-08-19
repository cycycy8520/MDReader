//! DG 7.1 `obsidian.rs` 职责：读全局 `obsidian.json` → Vault 列表 → 复制导入 → URI 唤起。
//!
//! 方案要点（DG 8「Obsidian 导入」+ FR-09）：
//! * Vault 枚举：读 `%APPDATA%\obsidian\obsidian.json`（以官方数据目录文档为准），
//!   其 `vaults` 字段是 `{ "<hash>": { "path": "...", "ts": 0, "open": true } }` 形态；
//! * 导入：复制 .md 到 vault（可选子目录）+ 附件复制到 vault 附件目录并**重写链接**；
//! * 同名冲突：提示「覆盖 / 改名」，不静默覆盖；
//! * 完成后 `obsidian://open?vault=<name>&file=<相对路径>` 唤起定位；
//!   深定位（跳到具体标题）需 Advanced URI 插件，**检测到才启用**，否则退化为打开文件。
//!
//! 附件路径重写与「导出 HTML」「单文件内联」共用同一个解析器（DG 8「附件路径重写」、
//! DG 10-5：修一处即修三处），中文 / 空格 / UNC 路径全部进语料库。
//! 本模块**直接复用** [`crate::export_html::resolve_asset_path`]，不另起炉灶：
//! 七形态（相对 / 盘符绝对 / 正反斜杠混写 / 中文 / 空格 / UNC / `file:` URL / 百分号编码）
//! 的判定只有一份实现，才谈得上「修一处即修三处」。
//!
//! 【严格只读（红线 5）】
//! 源 .md 与源图片**只读不写**：导入是「拷贝进 Vault」，任何情况下都不回写、不移动源文件。
//! 目标位置一旦与源文件重合（用户把 Vault 里的笔记再导入同一 Vault），直接短路成
//! 「已在 Vault 中，定位即可」，而不是把源文件当成输出去覆盖。
//!
//! 【冲突策略】
//! 附件**永不覆盖**：同名但内容不同一律改名（`图-1.png`），同名且内容一致则复用现有文件；
//! 笔记本身按 [`ConflictPolicy`] 走——`Rename` 追加 `-1`、`-2`，`Overwrite` 只可能来自
//! 用户在冲突对话框里的显式选择（DG 8「不静默覆盖」），落盘前 warn 留痕。

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::export_html::resolve_asset_path;

/// Obsidian 全局配置文件所在目录（相对 `%APPDATA%`）。
pub const OBSIDIAN_CONFIG_DIR: &str = "obsidian";
pub const OBSIDIAN_CONFIG_FILE: &str = "obsidian.json";

/// Vault 内的配置目录与应用配置文件（附件目录设置在这里）。
const VAULT_CONFIG_DIR: &str = ".obsidian";
const VAULT_APP_CONFIG: &str = "app.json";

/// 唤起 URI 的协议头；[`open_in_obsidian`] 只放行它。
const OBSIDIAN_URI_SCHEME: &str = "obsidian://";

/// 冲突改名的最大尝试次数：真到 999 说明目录里有问题，继续试下去只是空转。
const MAX_RENAME_ATTEMPTS: u32 = 999;

/// 文件名被清洗到空时的兜底名。
const FALLBACK_NOTE_NAME: &str = "note";
const FALLBACK_ASSET_NAME: &str = "asset";

/// 一个 Vault。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    /// obsidian.json 里的 key（hash）
    pub id: String,
    /// Vault 根目录
    pub path: PathBuf,
    /// 展示名：取 path 的最后一段
    pub name: String,
    /// 是否为当前打开的 Vault
    pub open: bool,
}

/// 同名冲突处理策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictPolicy {
    /// 覆盖已有文件
    Overwrite,
    /// 自动改名（追加 `-1`、`-2`…）
    Rename,
}

/// 导入请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    /// 源 .md 绝对路径
    pub source: PathBuf,
    /// 目标 Vault id
    pub vault_id: String,
    /// Vault 内子目录（可空 = 根目录）
    pub subfolder: Option<String>,
    pub conflict: ConflictPolicy,
}

/// 导入结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    /// Vault 内相对路径（用于拼 `obsidian://open` 的 file 参数）
    pub relative_path: String,
    /// 一并复制的附件数量
    pub attachment_count: usize,
    /// 唤起用的 URI
    pub uri: String,
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 枚举本机 Obsidian Vault（FR-09 第一步）。
///
/// **只读**：从头到尾只 `read` 一个 JSON，不写、不猜、不探测别的路径。
/// 文件不存在 = 用户没装 Obsidian（或从未建过 Vault），返回空列表让前端显示引导，
/// **不报错**——把「没装」渲染成一屏红色错误是最没必要的惊吓。
/// 真正的异常（`%APPDATA%` 缺失、JSON 损坏、读取无权限）才报错，且带上路径便于排查。
#[tauri::command]
pub async fn list_vaults() -> AppResult<Vec<Vault>> {
    tauri::async_runtime::spawn_blocking(load_vaults)
        .await
        .map_err(|err| {
            tracing::error!(%err, "枚举 Vault 任务失败");
            AppError::native(format!("枚举 Vault 任务失败：{err}"))
        })?
}

/// 导入当前文档到指定 Vault（FR-09）。
///
/// 复制 .md → 扫描正文引用的本地附件 → 拷进 Vault 附件目录 → 重写链接 →
/// 处理同名冲突 → 返回 [`ImportOutcome`]（含 `obsidian://open` URI）。
///
/// 整个流程是同步 IO（读文本 + 拷图，可能几十 MB），丢到阻塞线程池执行。
#[tauri::command]
pub async fn import_to_vault(request: ImportRequest) -> AppResult<ImportOutcome> {
    tauri::async_runtime::spawn_blocking(move || run_import(&request))
        .await
        .map_err(|err| {
            tracing::error!(%err, "导入 Vault 任务失败");
            AppError::native(format!("导入 Vault 任务失败：{err}"))
        })?
}

/// 唤起 Obsidian 定位到刚导入的文件。
///
/// 只放行 `obsidian://` 前缀：这个命令的入参来自前端，不设协议白名单就等于给页面
/// 递了一把「用系统默认程序打开任意 URI」的钥匙。
///
/// 调用方注意：唤起失败**不等于导入失败**（文件已经躺在 Vault 里了），
/// 上层应当只 warn，见 `cmdline::bridge::import_obsidian`。
#[tauri::command]
pub async fn open_in_obsidian(uri: String) -> AppResult<()> {
    if !uri.starts_with(OBSIDIAN_URI_SCHEME) {
        return Err(AppError::config(format!(
            "拒绝唤起非 obsidian:// 协议的 URI：{uri}"
        )));
    }

    tauri::async_runtime::spawn_blocking(move || {
        // 用 opener 插件而不是自写 ShellExecute：转义与 UAC 的坑插件已经趟过（Cargo.toml 注释）
        tauri_plugin_opener::open_url(&uri, None::<&str>).map_err(|err| {
            tracing::warn!(%err, %uri, "唤起 Obsidian 失败");
            AppError::native(format!("唤起 Obsidian 失败：{err}"))
        })
    })
    .await
    .map_err(|err| AppError::native(format!("唤起 Obsidian 任务失败：{err}")))?
}

// ---------------------------------------------------------------------------
// Vault 枚举
// ---------------------------------------------------------------------------

fn load_vaults() -> AppResult<Vec<Vault>> {
    let config = obsidian_config_path()?;
    let bytes = match std::fs::read(&config) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!(path = %config.display(), "未找到 obsidian.json：本机可能未安装 Obsidian");
            return Ok(Vec::new());
        }
        Err(err) => {
            tracing::error!(path = %config.display(), %err, "读取 obsidian.json 失败");
            return Err(AppError::Io(err));
        }
    };

    // obsidian.json 规范是 UTF-8；复用 files 的解码器只是为了容忍 BOM 与极端情况
    let (text, _) = crate::files::detect_and_decode(&bytes)?;
    let vaults = parse_vaults(&text)?;
    tracing::info!(count = vaults.len(), "已枚举 Obsidian Vault");
    Ok(vaults)
}

/// 解析 obsidian.json 的 `vaults` 字段。
///
/// 脏数据容忍度是刻意放宽的：Obsidian 自己会在里面留下历史条目，个别条目缺 `path`
/// 或类型不对时**跳过该条**而不是让整个列表失败——用户装了三个 Vault，
/// 不该因为第四个残缺条目而一个都看不到。
fn parse_vaults(raw: &str) -> AppResult<Vec<Vault>> {
    let root: serde_json::Value = serde_json::from_str(raw)
        .map_err(|err| AppError::config(format!("obsidian.json 解析失败：{err}")))?;

    let Some(entries) = root.get("vaults").and_then(serde_json::Value::as_object) else {
        tracing::warn!("obsidian.json 缺少 vaults 字段或类型不是对象");
        return Ok(Vec::new());
    };

    let mut vaults: Vec<Vault> = Vec::with_capacity(entries.len());
    for (id, entry) in entries {
        let Some(raw_path) = entry.get("path").and_then(serde_json::Value::as_str) else {
            tracing::warn!(%id, "Vault 条目缺少 path 字段，跳过");
            continue;
        };
        let raw_path = raw_path.trim();
        if raw_path.is_empty() {
            tracing::warn!(%id, "Vault 条目的 path 为空，跳过");
            continue;
        }

        let path = PathBuf::from(raw_path);
        let name = vault_display_name(&path);
        // `open` 缺省按 false 处理：Obsidian 关闭 Vault 时是把该字段删掉而不是置 false
        let open = entry
            .get("open")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if !path.is_dir() {
            // 目录被移走后 Obsidian 会留下陈旧条目；如实列出（用户才知道要清理），
            // 真选中它导入时 import_into 会给出明确的 not-found
            tracing::warn!(%id, path = %path.display(), "Vault 目录当前不可访问（条目可能已陈旧）");
        }

        vaults.push(Vault {
            id: id.clone(),
            path,
            name,
            open,
        });
    }

    // 当前打开的排最前，其余按名字排；顺序必须稳定，否则每次打开对话框列表都在跳
    vaults.sort_by(|left, right| {
        right
            .open
            .cmp(&left.open)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(vaults)
}

/// 展示名 = 路径最后一段；盘根（`D:\`）退化为盘符本身。
fn vault_display_name(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim_end_matches(['\\', '/']);
    let tail = trimmed
        .rsplit(['\\', '/'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(trimmed);
    if tail.is_empty() {
        raw.into_owned()
    } else {
        tail.to_string()
    }
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

fn run_import(request: &ImportRequest) -> AppResult<ImportOutcome> {
    let vault = load_vaults()?
        .into_iter()
        .find(|vault| vault.id == request.vault_id)
        .ok_or_else(|| {
            AppError::not_found(format!(
                "Vault 不存在或已从 Obsidian 移除：{}",
                request.vault_id
            ))
        })?;
    import_into(&vault, request)
}

/// 导入的同步内核（与 Vault 枚举解耦，便于单测直接喂一个临时目录当 Vault）。
fn import_into(vault: &Vault, request: &ImportRequest) -> AppResult<ImportOutcome> {
    let started = std::time::Instant::now();

    if !vault.path.is_dir() {
        return Err(AppError::not_found(format!(
            "Vault 目录不存在或不可访问：{}",
            vault.path.display()
        )));
    }
    let source = to_absolute(&request.source);
    if !source.is_file() {
        return Err(AppError::not_found(format!(
            "源文件不存在：{}",
            source.display()
        )));
    }
    let source_dir = source
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::config(format!("源文件没有父目录：{}", source.display())))?;

    let note_dir_rel = sanitize_relative_dir(request.subfolder.as_deref());
    let note_dir_abs = join_components(&vault.path, &note_dir_rel);
    let note_name = note_file_name(&source);

    // 源文件就在目标位置：不写盘、直接定位。
    // 这道守卫同时是红线 5 的最后一层保险——Overwrite 策略撞上源文件本身就是「导入
    // 把原稿截断成空文件」，绝不能发生。
    let direct_target = note_dir_abs.join(&note_name);
    if same_file(&source, &direct_target) {
        let relative = vault_relative_display(&note_dir_rel, &note_name);
        let uri = build_open_uri(&vault.name, &relative);
        tracing::info!(
            vault = %vault.path.display(),
            relative = %relative,
            "源文件已在 Vault 目标位置，跳过复制直接定位"
        );
        return Ok(ImportOutcome {
            relative_path: relative,
            attachment_count: 0,
            uri,
        });
    }

    let bytes = std::fs::read(&source)?;
    let (text, encoding) = crate::files::detect_and_decode(&bytes)?;
    drop(bytes);

    std::fs::create_dir_all(&note_dir_abs)?;
    let target = resolve_note_target(&note_dir_abs, &note_name, request.conflict)?;
    let final_name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| note_name.clone());

    // 附件目录：读 Vault 自己的 app.json，尊重用户在 Obsidian 里的设置
    let attach_dir_rel = attachment_dir_components(&vault.path, &note_dir_rel);
    let mut pipeline = AssetPipeline {
        vault_root: vault.path.clone(),
        source_dir,
        note_dir: note_dir_rel.clone(),
        attach_dir: attach_dir_rel,
        by_raw: HashMap::new(),
        by_path: HashMap::new(),
        used_names: HashSet::new(),
        copied: 0,
        reused: 0,
        missing: 0,
        copied_bytes: 0,
    };

    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    for asset in scan_asset_refs(&text) {
        let Some(components) = pipeline.prepare(&asset.raw)? else {
            continue;
        };
        let replacement = match asset.kind {
            // wikilink 内是**原样**文本，百分号编码反而会让 Obsidian 找不到文件
            RefKind::Wiki => components.join("/"),
            RefKind::Markdown | RefKind::Html => {
                encode_link_path(&relative_link(&pipeline.note_dir, &components))
            }
        };
        if replacement != asset.raw {
            edits.push((asset.span, replacement));
        }
    }

    let rewritten = apply_edits(&text, edits);
    if matches!(request.conflict, ConflictPolicy::Overwrite) && target.exists() {
        // 只可能来自用户在冲突对话框里的显式选择（DG 8「不静默覆盖」），留痕
        // 字段名刻意不叫 target：`target` 在 tracing 宏里是保留的特殊参数
        tracing::warn!(note = %target.display(), "按用户选择覆盖 Vault 内的同名笔记");
    }
    write_atomic(&target, rewritten.as_bytes())?;

    let relative = vault_relative_display(&note_dir_rel, &final_name);
    let uri = build_open_uri(&vault.name, &relative);
    let attachment_count = pipeline.copied + pipeline.reused;

    if pipeline.missing > 0 {
        tracing::warn!(
            missing = pipeline.missing,
            "部分附件未找到，正文中的对应链接保持原样"
        );
    }
    if has_advanced_uri_plugin(&vault.path) {
        // 有插件才谈得上深定位；本次没有标题锚点可用，先只留痕（后续做「跳到当前章节」时接上）
        tracing::debug!("目标 Vault 已安装 Advanced URI 插件");
    }
    tracing::info!(
        vault = %vault.path.display(),
        relative = %relative,
        ?encoding,
        copied = pipeline.copied,
        reused = pipeline.reused,
        missing = pipeline.missing,
        copied_bytes = pipeline.copied_bytes,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "导入 Obsidian 完成"
    );

    Ok(ImportOutcome {
        relative_path: relative,
        attachment_count,
        uri,
    })
}

/// 按冲突策略定下最终落点。
///
/// `Rename` 分支永远不会返回一个已存在的路径；`Overwrite` 分支原样返回，
/// 由调用方在写盘前 warn 留痕（源文件重合的情况已在上游短路）。
fn resolve_note_target(dir: &Path, name: &str, conflict: ConflictPolicy) -> AppResult<PathBuf> {
    let direct = dir.join(name);
    if matches!(conflict, ConflictPolicy::Overwrite) || !direct.exists() {
        return Ok(direct);
    }

    let (stem, extension) = split_file_name(name);
    for serial in 1..=MAX_RENAME_ATTEMPTS {
        let candidate = dir.join(format!("{stem}-{serial}{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::config(format!(
        "同名文件过多，改名 {MAX_RENAME_ATTEMPTS} 次仍未找到空位：{}",
        direct.display()
    )))
}

/// 笔记落到 Vault 里的文件名：清洗非法字符，并保证扩展名是 `.md`
/// （`.markdown` / `.txt` 在 Obsidian 里根本不会被当成笔记）。
fn note_file_name(source: &Path) -> String {
    let raw = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned = safe_file_name(&raw, FALLBACK_NOTE_NAME);
    let (stem, extension) = split_file_name(&cleaned);
    if extension.eq_ignore_ascii_case(".md") {
        cleaned
    } else {
        format!("{stem}.md")
    }
}

// ---------------------------------------------------------------------------
// 附件流水线
// ---------------------------------------------------------------------------

struct AssetPipeline {
    vault_root: PathBuf,
    /// 源 .md 所在目录（相对引用的解析基准）
    source_dir: PathBuf,
    /// 笔记在 Vault 内的目录分量
    note_dir: Vec<String>,
    /// 附件目标目录在 Vault 内的分量
    attach_dir: Vec<String>,
    /// 正文原始引用串 → Vault 内分量（`None` = 非本地 / 找不到）
    by_raw: HashMap<String, Option<Vec<String>>>,
    /// 已解析的本机路径（归一化）→ Vault 内分量，同一张图被引用多次只拷一份
    by_path: HashMap<String, Vec<String>>,
    /// 本次导入已占用的附件文件名（小写），避免同批次内互相覆盖
    used_names: HashSet<String>,
    copied: usize,
    reused: usize,
    missing: usize,
    copied_bytes: u64,
}

impl AssetPipeline {
    /// 把正文里的一处引用变成「Vault 内分量」，必要时把文件拷进去。
    ///
    /// 返回 `Ok(None)` 表示这处引用不该动（外链 / 锚点 / 找不到的本地文件）——
    /// 找不到时**保持原样**而不是改成占位符：查看器里坏掉的链接至少还留着线索，
    /// 被改写成别的东西就彻底追不回来了。
    fn prepare(&mut self, raw: &str) -> AppResult<Option<Vec<String>>> {
        if let Some(cached) = self.by_raw.get(raw) {
            return Ok(cached.clone());
        }
        let prepared = self.prepare_uncached(raw)?;
        self.by_raw.insert(raw.to_string(), prepared.clone());
        Ok(prepared)
    }

    fn prepare_uncached(&mut self, raw: &str) -> AppResult<Option<Vec<String>>> {
        if !is_local_reference(raw) {
            return Ok(None);
        }
        let Some(resolved) = resolve_asset_path(Some(self.source_dir.as_path()), raw) else {
            return Ok(None);
        };
        if !resolved.is_file() {
            tracing::warn!(raw = %raw, path = %resolved.display(), "附件不存在，链接保持原样");
            self.missing += 1;
            return Ok(None);
        }

        let key = normalize_key(&resolved);
        if let Some(components) = self.by_path.get(&key) {
            return Ok(Some(components.clone()));
        }

        // 附件本来就在 Vault 里（用户把 Vault 内的笔记重新导入）：只重写链接，不再拷一份
        if let Some(inside) = vault_relative_components(&self.vault_root, &resolved) {
            self.reused += 1;
            self.by_path.insert(key, inside.clone());
            return Ok(Some(inside));
        }

        let dir_abs = join_components(&self.vault_root, &self.attach_dir);
        std::fs::create_dir_all(&dir_abs)?;
        let (name, needs_copy) = self.claim_attachment_name(&resolved, &dir_abs)?;
        let destination = dir_abs.join(&name);
        if needs_copy {
            let bytes = std::fs::copy(&resolved, &destination).map_err(|err| {
                tracing::error!(
                    from = %resolved.display(),
                    to = %destination.display(),
                    %err,
                    "拷贝附件失败"
                );
                AppError::Io(err)
            })?;
            self.copied += 1;
            self.copied_bytes += bytes;
        } else {
            self.reused += 1;
        }

        let mut components = self.attach_dir.clone();
        components.push(name);
        self.by_path.insert(key, components.clone());
        Ok(Some(components))
    }

    /// 为一个附件在目标目录里定下文件名。
    ///
    /// 返回 `(文件名, 是否需要拷贝)`：同名且内容一致时复用现有文件（重复导入不会
    /// 攒出 `图-1.png`、`图-2.png` 的垃圾堆），内容不同才改名。**任何情况下都不覆盖。**
    fn claim_attachment_name(
        &mut self,
        source: &Path,
        dir_abs: &Path,
    ) -> AppResult<(String, bool)> {
        let raw = source
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let cleaned = safe_file_name(&raw, FALLBACK_ASSET_NAME);
        let (stem, extension) = split_file_name(&cleaned);

        for serial in 0..=MAX_RENAME_ATTEMPTS {
            let candidate = if serial == 0 {
                cleaned.clone()
            } else {
                format!("{stem}-{serial}{extension}")
            };
            if self.used_names.contains(&candidate.to_lowercase()) {
                continue;
            }
            let destination = dir_abs.join(&candidate);
            match std::fs::metadata(&destination) {
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    self.used_names.insert(candidate.to_lowercase());
                    return Ok((candidate, true));
                }
                Err(err) => return Err(AppError::Io(err)),
                Ok(meta) if meta.is_file() && same_content(source, &destination, meta.len()) => {
                    self.used_names.insert(candidate.to_lowercase());
                    return Ok((candidate, false));
                }
                Ok(_) => continue,
            }
        }
        Err(AppError::config(format!(
            "附件同名过多，改名 {MAX_RENAME_ATTEMPTS} 次仍未找到空位：{}",
            dir_abs.join(cleaned).display()
        )))
    }
}

/// 内容是否一致：先比长度（几乎总能一票否决），一致才读进来逐字节比。
fn same_content(source: &Path, destination: &Path, destination_len: u64) -> bool {
    match std::fs::metadata(source) {
        Ok(meta) if meta.len() == destination_len => {}
        _ => return false,
    }
    match (std::fs::read(source), std::fs::read(destination)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Vault 附件目录（Vault 内分量）。
///
/// 读 `<vault>/.obsidian/app.json` 的 `attachmentFolderPath`，语义与 Obsidian 一致：
/// * `"/"` 或空 → Vault 根；
/// * `"./sub"` / `"."` → 笔记所在目录（的子目录）；
/// * 其余 → 从 Vault 根算起的路径。
///
/// **读不到配置时退化为「笔记所在目录」而不是 Vault 根**：拿不准的时候把图片放在
/// 笔记旁边，最坏结果是多几个文件挨着笔记；倒进知识库根目录则是用户要手工收拾的烂摊子。
fn attachment_dir_components(vault_root: &Path, note_dir: &[String]) -> Vec<String> {
    let configured = read_attachment_setting(vault_root);
    let Some(raw) = configured else {
        return note_dir.to_vec();
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "/" || trimmed == "\\" {
        return Vec::new();
    }
    if trimmed == "." || trimmed == "./" {
        return note_dir.to_vec();
    }
    if let Some(rest) = trimmed
        .strip_prefix("./")
        .or_else(|| trimmed.strip_prefix(".\\"))
    {
        let mut components = note_dir.to_vec();
        components.extend(split_clean_components(rest));
        return components;
    }
    split_clean_components(trimmed)
}

/// 只取 `attachmentFolderPath` 一个键；读不到 / 不是字符串一律当「没配置」。
fn read_attachment_setting(vault_root: &Path) -> Option<String> {
    let path = vault_root.join(VAULT_CONFIG_DIR).join(VAULT_APP_CONFIG);
    let bytes = std::fs::read(&path).ok()?;
    let (text, _) = crate::files::detect_and_decode(&bytes).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("attachmentFolderPath")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// 正文扫描：找出所有本地附件引用
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefKind {
    /// `![alt](dest)` 与链接引用定义 `[id]: dest`
    Markdown,
    /// `![[dest]]`（Obsidian 内嵌语法）
    Wiki,
    /// `<img src="dest">`
    Html,
}

#[derive(Debug, Clone)]
struct AssetRef {
    kind: RefKind,
    /// 目标串在原文中的字节范围（只覆盖目标本身，不含括号与引号）
    span: Range<usize>,
    raw: String,
}

/// 扫描正文里所有可能指向本地附件的引用。
///
/// 逐行扫描而不是整篇正则：① 围栏代码块必须整块跳过（示例代码里的
/// `![图](a.png)` 改写了就是给用户添乱）；② 行内代码同理；
/// ③ 跨行书写的链接极其罕见，为它把状态机复杂度翻倍不值得（已知取舍）。
fn scan_asset_refs(text: &str) -> Vec<AssetRef> {
    let mut refs = Vec::new();
    let mut offset = 0usize;
    let mut fence: Option<(char, usize)> = None;

    for raw_line in text.split_inclusive('\n') {
        let line = raw_line.trim_end_matches(['\r', '\n']);
        if let Some((marker, width)) = fence {
            if matches!(fence_marker(line), Some((ch, len)) if ch == marker && len >= width) {
                fence = None;
            }
        } else if let Some(open) = fence_marker(line) {
            fence = Some(open);
        } else {
            scan_line(line, offset, &mut refs);
        }
        offset += raw_line.len();
    }
    refs
}

/// 围栏起止标记：行首最多 3 个空格 + 至少 3 个连续的 ``` 或 ~~~。
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = rest.chars().next().filter(|ch| *ch == '`' || *ch == '~')?;
    let width = rest.chars().take_while(|ch| *ch == marker).count();
    (width >= 3).then_some((marker, width))
}

fn scan_line(line: &str, base: usize, out: &mut Vec<AssetRef>) {
    let spans = code_spans(line);
    if let Some(span) =
        parse_reference_definition(line).filter(|span| !in_spans(&spans, span.start))
    {
        push_ref(line, base, span, RefKind::Markdown, out);
    }

    let mut index = 0usize;
    while index < line.len() {
        let parsed = if in_spans(&spans, index) {
            None
        } else {
            parse_at(line, index)
        };
        match parsed {
            Some((kind, span, next)) => {
                push_ref(line, base, span, kind, out);
                index = next;
            }
            None => index += 1,
        }
    }
}

/// 尝试把 `index` 处解析成一处引用。返回（种类, 目标范围, 下一个扫描位置）。
fn parse_at(line: &str, index: usize) -> Option<(RefKind, Range<usize>, usize)> {
    let bytes = line.as_bytes();
    // 被反斜杠转义的 `!` / `<` 不构成语法
    if index > 0 && bytes[index - 1] == b'\\' {
        return None;
    }
    match bytes[index] {
        // `!` 是 ASCII，index 必然落在字符边界上，切片安全
        b'!' if line[index..].starts_with("![[") => {
            parse_wiki_embed(line, index).map(|(span, next)| (RefKind::Wiki, span, next))
        }
        b'!' if bytes.get(index + 1) == Some(&b'[') => {
            parse_inline_image(line, index).map(|(span, next)| (RefKind::Markdown, span, next))
        }
        b'<' if starts_img_tag(bytes, index) => {
            parse_html_img(line, index).map(|(span, next)| (RefKind::Html, span, next))
        }
        _ => None,
    }
}

fn push_ref(line: &str, base: usize, span: Range<usize>, kind: RefKind, out: &mut Vec<AssetRef>) {
    if span.start >= span.end {
        return;
    }
    out.push(AssetRef {
        kind,
        raw: line[span.clone()].to_string(),
        span: base + span.start..base + span.end,
    });
}

/// 是否是 `<img` 标签开头（按字节比较：`index + 4` 未必落在字符边界上，不能切片）。
fn starts_img_tag(bytes: &[u8], index: usize) -> bool {
    if bytes.len() < index + 4 || !bytes[index + 1..index + 4].eq_ignore_ascii_case(b"img") {
        return false;
    }
    // `<imgx` 不是 img 标签
    match bytes.get(index + 4).copied() {
        None => true,
        Some(next) => next.is_ascii_whitespace() || next == b'>' || next == b'/',
    }
}

/// `![[目标|别名]]` / `![[目标#标题]]`：只取目标段。
fn parse_wiki_embed(line: &str, start: usize) -> Option<(Range<usize>, usize)> {
    let inner_start = start + 3;
    let close = line[inner_start..].find("]]")? + inner_start;
    let inner = &line[inner_start..close];
    let cut = inner.find(['|', '#']).unwrap_or(inner.len());
    Some((inner_start..inner_start + cut, close + 2))
}

/// `![alt](dest "title")`：`start` 指向 `!`。返回目标范围与下一个扫描位置。
fn parse_inline_image(line: &str, start: usize) -> Option<(Range<usize>, usize)> {
    let bytes = line.as_bytes();
    let mut index = start + 2;
    let mut depth = 1usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                index += 2;
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        index += 1;
    }
    if index >= bytes.len() || bytes.get(index + 1) != Some(&b'(') {
        return None;
    }
    parse_destination(line, index + 1)
}

/// 解析 `(` 之后的链接目标；`open` 是 `(` 的下标。
///
/// 【为什么不在第一个空格处截断】
/// 严格 CommonMark 里不带尖括号的目标不能含空格，但中文用户手写的
/// `![图](图 片/示例.png)` 在真实语料里遍地都是。这里的策略是：吃到收尾的 `)`，
/// 只把**引号或括号开头的尾段**当 title 剥掉。多吃进来的那点内容不会造成误伤——
/// 附件流水线只在「这个路径在磁盘上真的存在」时才改写，不存在就原样留着。
fn parse_destination(line: &str, open: usize) -> Option<(Range<usize>, usize)> {
    let bytes = line.as_bytes();
    let length = bytes.len();
    let mut index = open + 1;
    while index < length && matches!(bytes[index], b' ' | b'\t') {
        index += 1;
    }
    if index >= length {
        return None;
    }

    if bytes[index] == b'<' {
        // `<dest>` 形态：里面允许空格，不允许换行
        let start = index + 1;
        let mut cursor = start;
        while cursor < length && bytes[cursor] != b'>' {
            if bytes[cursor] == b'\\' {
                cursor += 1;
            }
            cursor += 1;
        }
        if cursor >= length {
            return None;
        }
        let end = cursor;
        index = cursor + 1;
        while index < length && bytes[index] != b')' {
            index += 1;
        }
        if index >= length {
            return None;
        }
        return Some((start..end, index + 1));
    }

    let start = index;
    let mut depth = 0usize;
    while index < length {
        match bytes[index] {
            b'\\' => {
                index += 2;
                continue;
            }
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            _ => {}
        }
        index += 1;
    }
    if index >= length {
        return None;
    }

    let mut end = index;
    while end > start && matches!(bytes[end - 1], b' ' | b'\t') {
        end -= 1;
    }
    if let Some(cut) = title_start(bytes, start, end) {
        end = cut;
    }
    Some((start..end, index + 1))
}

/// 目标串尾部若挂着一段 `"标题"` / `'标题'` / `(标题)`，返回它前面的截断位置。
fn title_start(bytes: &[u8], start: usize, end: usize) -> Option<usize> {
    let mut cursor = end;
    while cursor > start {
        cursor -= 1;
        if !matches!(bytes[cursor], b' ' | b'\t') {
            continue;
        }
        let candidate = cursor + 1;
        if candidate < end && matches!(bytes[candidate], b'"' | b'\'' | b'(') {
            let mut cut = cursor;
            while cut > start && matches!(bytes[cut - 1], b' ' | b'\t') {
                cut -= 1;
            }
            return Some(cut);
        }
        return None;
    }
    None
}

/// `<img ... src="dest" ...>`：`start` 指向 `<`。
fn parse_html_img(line: &str, start: usize) -> Option<(Range<usize>, usize)> {
    let end = line[start..]
        .find('>')
        .map_or(line.len(), |offset| start + offset + 1);
    let region = &line[start..end];
    // ASCII 小写化不改变字节长度，下标可以直接互用
    let lower = region.to_ascii_lowercase();
    let bytes = region.as_bytes();

    let mut at = 0usize;
    while let Some(found) = lower[at..].find("src") {
        let name = at + found;
        // 前一个字符必须是空白，否则 `data-src` / `srcset` 会被误当成 src
        let preceded_by_space = name > 0 && bytes[name - 1].is_ascii_whitespace();
        let mut cursor = name + 3;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if preceded_by_space && bytes.get(cursor) == Some(&b'=') {
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            let (value_start, value_end) = match bytes.get(cursor).copied() {
                Some(quote) if quote == b'"' || quote == b'\'' => {
                    let value_start = cursor + 1;
                    let value_end = region[value_start..]
                        .find(quote as char)
                        .map(|offset| value_start + offset)?;
                    (value_start, value_end)
                }
                Some(_) => {
                    let value_start = cursor;
                    let value_end = region[value_start..]
                        .find(|ch: char| ch.is_ascii_whitespace() || ch == '>')
                        .map_or(region.len(), |offset| value_start + offset);
                    (value_start, value_end)
                }
                None => return None,
            };
            return Some((start + value_start..start + value_end, end));
        }
        at = name + 3;
    }
    None
}

/// 链接引用定义：`[id]: dest "title"`（行首最多 3 个空格）。
fn parse_reference_definition(line: &str) -> Option<Range<usize>> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    if !rest.starts_with('[') {
        return None;
    }
    let label_end = rest.find("]:")?;
    let bytes = rest.as_bytes();
    let mut index = label_end + 2;
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
        index += 1;
    }
    if index >= bytes.len() {
        return None;
    }
    let (start, end) = if bytes[index] == b'<' {
        let start = index + 1;
        let end = rest[start..].find('>').map(|offset| start + offset)?;
        (start, end)
    } else {
        let start = index;
        let end = rest[start..]
            .find(char::is_whitespace)
            .map_or(rest.len(), |offset| start + offset);
        (start, end)
    };
    Some(indent + start..indent + end)
}

/// 行内代码区间（成对的等长反引号 run）。
fn code_spans(line: &str) -> Vec<Range<usize>> {
    let bytes = line.as_bytes();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let start = index;
            while index < bytes.len() && bytes[index] == b'`' {
                index += 1;
            }
            runs.push((start, index - start));
        } else {
            index += 1;
        }
    }

    let mut spans = Vec::new();
    let mut cursor = 0usize;
    while cursor < runs.len() {
        let (start, width) = runs[cursor];
        match runs[cursor + 1..]
            .iter()
            .position(|(_, other)| *other == width)
        {
            Some(offset) => {
                let (close_start, close_width) = runs[cursor + 1 + offset];
                spans.push(start..close_start + close_width);
                cursor = cursor + offset + 2;
            }
            None => cursor += 1,
        }
    }
    spans
}

fn in_spans(spans: &[Range<usize>], index: usize) -> bool {
    spans.iter().any(|span| span.contains(&index))
}

/// 是否指向本机文件（而不是外链 / 锚点 / data URI）。
///
/// 判协议时刻意把「单字母协议」放行：Windows 盘符 `D:\图\a.png` 在 URL 语法里
/// 长得就像一个协议名，一刀切会把所有盘符绝对路径当成外链漏掉。
fn is_local_reference(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return false;
    }
    match scheme_of(trimmed) {
        // `file:` 仍然是本机文件，交给统一解析器还原
        Some(scheme) => scheme.eq_ignore_ascii_case("file"),
        None => true,
    }
}

/// 取出 URI 协议名；**单字母「协议」是 Windows 盘符**（`D:\…`），不算协议。
fn scheme_of(raw: &str) -> Option<&str> {
    let colon = raw.find(':')?;
    if colon <= 1 {
        return None;
    }
    let scheme = &raw[..colon];
    let valid = scheme.starts_with(|ch: char| ch.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'));
    valid.then_some(scheme)
}

/// 按字节区间就地替换；区间必须来自同一次扫描，重叠的后来者直接丢弃。
fn apply_edits(text: &str, mut edits: Vec<(Range<usize>, String)>) -> String {
    if edits.is_empty() {
        return text.to_string();
    }
    edits.sort_by_key(|(span, _)| span.start);

    let mut out = String::with_capacity(text.len() + 64);
    let mut cursor = 0usize;
    for (span, replacement) in edits {
        if span.start < cursor || span.end > text.len() {
            continue;
        }
        out.push_str(&text[cursor..span.start]);
        out.push_str(&replacement);
        cursor = span.end;
    }
    out.push_str(&text[cursor..]);
    out
}

// ---------------------------------------------------------------------------
// 路径与编码工具
// ---------------------------------------------------------------------------

/// 从笔记所在目录看向目标文件的相对分量（含文件名）。
fn relative_link(note_dir: &[String], target: &[String]) -> Vec<String> {
    let Some((file_name, target_dir)) = target.split_last() else {
        return Vec::new();
    };
    let common = note_dir
        .iter()
        .zip(target_dir.iter())
        .take_while(|(left, right)| left.to_lowercase() == right.to_lowercase())
        .count();

    let mut parts = vec!["..".to_string(); note_dir.len() - common];
    parts.extend(target_dir[common..].iter().cloned());
    parts.push(file_name.clone());
    parts
}

/// 目标文件是否落在 Vault 内；是则返回它的 Vault 内分量（保留原始大小写）。
fn vault_relative_components(vault_root: &Path, target: &Path) -> Option<Vec<String>> {
    if is_unc(vault_root) != is_unc(target) {
        return None;
    }
    let root = path_components(vault_root);
    let full = path_components(target);
    if full.len() <= root.len() {
        return None;
    }
    for (left, right) in root.iter().zip(full.iter()) {
        if left.to_lowercase() != right.to_lowercase() {
            return None;
        }
    }
    Some(full[root.len()..].to_vec())
}

fn is_unc(path: &Path) -> bool {
    let raw = path.to_string_lossy();
    raw.starts_with("\\\\") || raw.starts_with("//")
}

/// 拆成路径分量并消化 `.` 与 `..`（保留原始大小写；UNC 的双反斜杠头不在分量里）。
fn path_components(path: &Path) -> Vec<String> {
    let raw = path.to_string_lossy().replace('/', "\\");
    let mut parts: Vec<String> = Vec::new();
    for segment in raw.split('\\') {
        match segment {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_string()),
        }
    }
    parts
}

/// Vault 内相对路径的展示形态（正斜杠，`obsidian://` 的 file 参数用它）。
fn vault_relative_display(dir: &[String], file_name: &str) -> String {
    if dir.is_empty() {
        file_name.to_string()
    } else {
        format!("{}/{}", dir.join("/"), file_name)
    }
}

fn join_components(root: &Path, components: &[String]) -> PathBuf {
    let mut path = root.to_path_buf();
    for component in components {
        path.push(component);
    }
    path
}

/// 前端送来的子目录字符串 → 安全的分量列表（吃掉 `..`、盘符、非法字符）。
fn sanitize_relative_dir(raw: Option<&str>) -> Vec<String> {
    raw.map(split_clean_components).unwrap_or_default()
}

fn split_clean_components(raw: &str) -> Vec<String> {
    raw.split(['\\', '/'])
        .filter(|segment| !segment.trim().is_empty() && *segment != "." && *segment != "..")
        .map(|segment| safe_file_name(segment, FALLBACK_NOTE_NAME))
        .collect()
}

/// Windows 文件名里非法的字符。
const ILLEGAL_NAME_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Windows 保留设备名：叫 `CON.md` 的文件根本创建不出来。
const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// 清洗成合法的 Windows 文件名（中文一律保留：改成拼音或哈希用户就认不出自己的文件了）。
fn safe_file_name(raw: &str, fallback: &str) -> String {
    let mut cleaned: String = raw
        .chars()
        .map(|ch| {
            if ILLEGAL_NAME_CHARS.contains(&ch) || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    // Windows 会静默吃掉结尾的点与空格，留着会让「写出去的名字」与「引用的名字」对不上
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    let cleaned = cleaned.trim_start().to_string();
    if cleaned.is_empty() {
        return fallback.to_string();
    }

    let (stem, extension) = split_file_name(&cleaned);
    if RESERVED_NAMES.contains(&stem.to_ascii_lowercase().as_str()) {
        format!("_{stem}{extension}")
    } else {
        cleaned
    }
}

/// `图 片.png` → `("图 片", ".png")`；`.gitkeep` 整串当 stem（不切出空 stem）。
fn split_file_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(dot) if dot > 0 => (name[..dot].to_string(), name[dot..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// 百分号编码用的十六进制表。
const HEX_DIGITS: &[u8; 16] = b"0123456789ABCDEF";

/// Markdown 链接目标的编码：只处理会破坏链接语法的字符，中文原样保留。
///
/// 全量 `encodeURIComponent` 会把中文路径糊成一串 `%E4%B8%AD`，在 Obsidian 编辑器里
/// 用户根本认不出自己的图；而空格、括号、`#`、`?` 不编码就会当场把链接截断。
fn encode_link_path(components: &[String]) -> String {
    let mut out = String::new();
    for (index, component) in components.iter().enumerate() {
        if index > 0 {
            out.push('/');
        }
        for ch in component.chars() {
            match ch {
                '%' => out.push_str("%25"),
                ' ' => out.push_str("%20"),
                '(' => out.push_str("%28"),
                ')' => out.push_str("%29"),
                '#' => out.push_str("%23"),
                '?' => out.push_str("%3F"),
                '<' => out.push_str("%3C"),
                '>' => out.push_str("%3E"),
                other if other.is_control() => {
                    let mut buffer = [0u8; 4];
                    for byte in other.encode_utf8(&mut buffer).as_bytes() {
                        out.push('%');
                        out.push(HEX_DIGITS[(byte >> 4) as usize] as char);
                        out.push(HEX_DIGITS[(byte & 0x0f) as usize] as char);
                    }
                }
                other => out.push(other),
            }
        }
    }
    out
}

/// `obsidian://open?vault=<name>&file=<相对路径>`（DG 8）。
///
/// 两个参数都按 RFC 3986 严格编码（中文、空格、`/` 全编）：URI 要穿过
/// ShellExecute 与 Obsidian 自己的解析器，只有严格编码是各环节都认的确定解。
fn build_open_uri(vault_name: &str, relative_path: &str) -> String {
    format!(
        "{OBSIDIAN_URI_SCHEME}open?vault={}&file={}",
        encode_uri_component(vault_name),
        encode_uri_component(relative_path)
    )
}

/// 百分号编码一个 URI 分量：只保留 RFC 3986 的 unreserved 字符。
fn encode_uri_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            other => {
                out.push('%');
                out.push(HEX_DIGITS[(other >> 4) as usize] as char);
                out.push(HEX_DIGITS[(other & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// 归一化成可比较的键：正斜杠统一成反斜杠、消化 `.` 与 `..`、大小写归一（Windows 语义）。
fn normalize_key(path: &Path) -> String {
    let joined = path_components(path).join("\\").to_lowercase();
    if is_unc(path) {
        format!("\\\\{joined}")
    } else {
        joined
    }
}

/// 两个路径是否指向同一个文件（按 Windows 语义归一化后比较）。
fn same_file(left: &Path, right: &Path) -> bool {
    normalize_key(left) == normalize_key(right)
}

/// 相对路径按当前工作目录补全；不做 `canonicalize`——它会返回 `\\?\C:\…`
/// 这种前缀，explorer 与前端展示都不认（与 `files.rs` / `export_html.rs` 同一约定）。
fn to_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

/// 先写 `<目标>.tmp` 再 rename，避免中途失败在用户 Vault 里留下半截笔记。
fn write_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut tmp = target.as_os_str().to_os_string();
    tmp.push(".mdnaonao-tmp");
    let tmp = PathBuf::from(tmp);

    std::fs::write(&tmp, bytes)?;
    if let Err(err) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(err));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 内部工具（对外可见部分）
// ---------------------------------------------------------------------------

/// `%APPDATA%\obsidian\obsidian.json` 路径。
pub fn obsidian_config_path() -> AppResult<PathBuf> {
    let base =
        std::env::var_os("APPDATA").ok_or_else(|| AppError::config("未取到 %APPDATA% 环境变量"))?;
    Ok(PathBuf::from(base)
        .join(OBSIDIAN_CONFIG_DIR)
        .join(OBSIDIAN_CONFIG_FILE))
}

/// 检测是否安装了 Advanced URI 插件（决定能否深定位到标题）。
///
/// 未检测到就退化为普通 `obsidian://open`，不提示、不报错。
pub fn has_advanced_uri_plugin(vault_root: &std::path::Path) -> bool {
    vault_root
        .join(VAULT_CONFIG_DIR)
        .join("plugins")
        .join("obsidian-advanced-uri")
        .is_dir()
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独占一个临时目录，避免并行测试互相踩。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "mdnaonao-obsidian-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("建临时目录应成功");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, relative: &str, content: &[u8]) -> PathBuf {
            let target = self.0.join(relative.replace('/', "\\"));
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("建父目录应成功");
            }
            std::fs::write(&target, content).expect("写临时文件应成功");
            target
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn vault_at(root: &Path) -> Vault {
        Vault {
            id: "vault-id".to_string(),
            path: root.to_path_buf(),
            name: vault_display_name(root),
            open: true,
        }
    }

    fn request(source: &Path, subfolder: Option<&str>, conflict: ConflictPolicy) -> ImportRequest {
        ImportRequest {
            source: source.to_path_buf(),
            vault_id: "vault-id".to_string(),
            subfolder: subfolder.map(str::to_string),
            conflict,
        }
    }

    /* ── obsidian.json 解析 ───────────────────────────────────── */

    /// 正常形态：id / path / name / open 四项都对，且「当前打开的」排最前。
    #[test]
    fn parses_vaults_and_sorts_open_first() {
        let raw = r#"{
            "vaults": {
                "aaa": { "path": "D:\\库\\Zeta", "ts": 1, "open": false },
                "bbb": { "path": "D:\\库\\Alpha", "ts": 2 },
                "ccc": { "path": "D:\\库\\当前", "ts": 3, "open": true }
            },
            "frame": { "width": 100 }
        }"#;

        let vaults = parse_vaults(raw).expect("解析不应失败");
        assert_eq!(vaults.len(), 3);
        assert_eq!(vaults[0].id, "ccc", "当前打开的 Vault 必须排最前");
        assert!(vaults[0].open);
        assert_eq!(vaults[0].name, "当前");
        assert_eq!(vaults[0].path, PathBuf::from(r"D:\库\当前"));
        assert_eq!(vaults[1].name, "Alpha", "其余按名字排序");
        assert!(!vaults[1].open, "缺 open 字段按 false 处理");
        assert_eq!(vaults[2].name, "Zeta");
    }

    /// 脏数据：缺 path / path 为空 / 条目不是对象 —— 逐条跳过，好的条目照常返回。
    #[test]
    fn skips_dirty_vault_entries() {
        let raw = r#"{
            "vaults": {
                "good": { "path": "D:\\库\\好的" },
                "nopath": { "ts": 7 },
                "empty": { "path": "   " },
                "wrongtype": { "path": 42 },
                "scalar": "这不是对象"
            }
        }"#;

        let vaults = parse_vaults(raw).expect("脏条目不应让整体失败");
        assert_eq!(vaults.len(), 1);
        assert_eq!(vaults[0].id, "good");
    }

    /// 缺 vaults 字段 / vaults 类型不对 → 空列表（不是错误）。
    #[test]
    fn returns_empty_when_vaults_field_missing() {
        assert!(parse_vaults(r#"{"frame":{}}"#)
            .expect("不应失败")
            .is_empty());
        assert!(parse_vaults(r#"{"vaults":[]}"#)
            .expect("不应失败")
            .is_empty());
        assert!(parse_vaults("{}").expect("不应失败").is_empty());
    }

    /// JSON 本身损坏必须明确报错（而不是静默当成「没有 Vault」）。
    #[test]
    fn reports_broken_json() {
        let err = parse_vaults("{ 这不是 JSON").expect_err("损坏的 JSON 必须报错");
        assert_eq!(err.kind(), "config");
        assert!(err.to_string().contains("obsidian.json"));
    }

    #[test]
    fn derives_vault_display_name() {
        assert_eq!(
            vault_display_name(Path::new(r"D:\库\我的 笔记")),
            "我的 笔记"
        );
        assert_eq!(vault_display_name(Path::new(r"D:\库\笔记\")), "笔记");
        assert_eq!(vault_display_name(Path::new("D:/库/笔记")), "笔记");
        assert_eq!(vault_display_name(Path::new(r"\\NAS\共享\库")), "库");
    }

    /* ── 冲突改名 ─────────────────────────────────────────────── */

    /// Rename 策略下同名文件逐个让位，**绝不覆盖**既有文件。
    #[test]
    fn renames_instead_of_overwriting() {
        let dir = TempDir::new("rename");
        dir.write("笔记.md", b"original");

        let first = resolve_note_target(dir.path(), "笔记.md", ConflictPolicy::Rename)
            .expect("改名不应失败");
        assert_eq!(first.file_name().expect("有文件名"), "笔记-1.md");

        std::fs::write(&first, b"one").expect("写文件应成功");
        let second = resolve_note_target(dir.path(), "笔记.md", ConflictPolicy::Rename)
            .expect("改名不应失败");
        assert_eq!(second.file_name().expect("有文件名"), "笔记-2.md");

        // 既有文件内容分毫未动
        assert_eq!(
            std::fs::read(dir.path().join("笔记.md"))
                .expect("读文件应成功")
                .as_slice(),
            b"original"
        );
    }

    /// Overwrite 只可能来自用户显式选择，此时如实指向原路径。
    #[test]
    fn overwrite_targets_existing_path() {
        let dir = TempDir::new("overwrite");
        dir.write("笔记.md", b"original");
        let target = resolve_note_target(dir.path(), "笔记.md", ConflictPolicy::Overwrite)
            .expect("不应失败");
        assert_eq!(target, dir.path().join("笔记.md"));
    }

    /// 非 .md 扩展名统一改成 .md，否则 Obsidian 不当它是笔记。
    #[test]
    fn forces_markdown_extension() {
        assert_eq!(note_file_name(Path::new(r"D:\a\笔记.md")), "笔记.md");
        assert_eq!(note_file_name(Path::new(r"D:\a\笔记.MD")), "笔记.MD");
        assert_eq!(note_file_name(Path::new(r"D:\a\笔记.markdown")), "笔记.md");
        assert_eq!(note_file_name(Path::new(r"D:\a\README")), "README.md");
        assert_eq!(note_file_name(Path::new(r"D:\a\CON.md")), "_CON.md");
    }

    /* ── 正文扫描 ─────────────────────────────────────────────── */

    fn scanned(text: &str) -> Vec<(RefKind, String)> {
        scan_asset_refs(text)
            .into_iter()
            .map(|item| (item.kind, item.raw))
            .collect()
    }

    /// 四种引用形态都要认出来，且 span 精确覆盖目标串。
    #[test]
    fn scans_every_reference_form() {
        let text = concat!(
            "![图](图 片/示例.png)\n",
            "![带标题](a.png \"标题\")\n",
            "![尖括号](<有 空格.png>)\n",
            "![[附件/图.png]]\n",
            "![[图.png|300]]\n",
            "<img src=\"截图.png\" width=\"20\">\n",
            "[ref]: 参考/图.png\n",
        );
        let found = scanned(text);
        assert_eq!(
            found,
            vec![
                (RefKind::Markdown, "图 片/示例.png".to_string()),
                (RefKind::Markdown, "a.png".to_string()),
                (RefKind::Markdown, "有 空格.png".to_string()),
                (RefKind::Wiki, "附件/图.png".to_string()),
                (RefKind::Wiki, "图.png".to_string()),
                (RefKind::Html, "截图.png".to_string()),
                (RefKind::Markdown, "参考/图.png".to_string()),
            ]
        );
    }

    /// 手写的带空格路径要完整取到；尾部的 title 要剥掉；括号要按配对吃。
    #[test]
    fn keeps_spaces_in_destination_but_strips_title() {
        assert_eq!(
            scanned("![图](图 片/示 例.png)"),
            vec![(RefKind::Markdown, "图 片/示 例.png".to_string())]
        );
        assert_eq!(
            scanned("![图](图 片.png \"标题\")"),
            vec![(RefKind::Markdown, "图 片.png".to_string())]
        );
        assert_eq!(
            scanned("![图](a.png '标题')"),
            vec![(RefKind::Markdown, "a.png".to_string())]
        );
        assert_eq!(
            scanned("![图](示例(1).png)"),
            vec![(RefKind::Markdown, "示例(1).png".to_string())]
        );
        // 没有收尾括号的残句不能被当成引用
        assert_eq!(scanned("![图](未闭合.png"), Vec::<(RefKind, String)>::new());
    }

    /// 围栏代码块与行内代码里的写法是**示例**，不能被改写。
    #[test]
    fn ignores_code_blocks_and_spans() {
        let text = concat!(
            "```md\n",
            "![不该动](a.png)\n",
            "```\n",
            "行内 `![也不该动](b.png)` 结束\n",
            "~~~\n",
            "![同样不动](c.png)\n",
            "~~~\n",
            "![要动的](d.png)\n",
        );
        assert_eq!(
            scanned(text),
            vec![(RefKind::Markdown, "d.png".to_string())]
        );
    }

    /// 外链 / data URI / 锚点不是本地附件。
    #[test]
    fn distinguishes_local_references() {
        assert!(is_local_reference("图 片/a.png"));
        assert!(is_local_reference(r"D:\图\a.png"));
        assert!(is_local_reference("D:/图/a.png"));
        assert!(is_local_reference(r"\\NAS\共享\a.png"));
        assert!(is_local_reference("file:///D:/a.png"));
        assert!(!is_local_reference("https://example.com/a.png"));
        assert!(!is_local_reference("HTTP://example.com/a.png"));
        assert!(!is_local_reference("data:image/png;base64,AA"));
        assert!(!is_local_reference("#标题"));
        assert!(!is_local_reference("   "));
    }

    /// `data-src` / `srcset` 不能被当成 `src`。
    #[test]
    fn html_img_only_matches_real_src_attribute() {
        assert_eq!(
            scanned("<img data-src=\"假的.png\" src='真的.png'>"),
            vec![(RefKind::Html, "真的.png".to_string())]
        );
        assert_eq!(
            scanned("<img srcset=\"假的.png\">"),
            Vec::<(RefKind, String)>::new()
        );
    }

    /* ── 链接重写 ─────────────────────────────────────────────── */

    #[test]
    fn builds_relative_links_between_folders() {
        let note = vec!["笔记".to_string(), "子".to_string()];
        let target = vec!["附件".to_string(), "图 片.png".to_string()];
        assert_eq!(
            relative_link(&note, &target),
            vec!["..", "..", "附件", "图 片.png"]
        );

        let same = vec!["笔记".to_string()];
        assert_eq!(
            relative_link(&same, &["笔记".to_string(), "a.png".to_string()]),
            vec!["a.png"]
        );
        assert_eq!(relative_link(&[], &["a.png".to_string()]), vec!["a.png"]);
    }

    /// 只编码会破坏链接语法的字符，中文原样保留（Obsidian 里要人能看懂）。
    #[test]
    fn encodes_only_link_breaking_characters() {
        assert_eq!(
            encode_link_path(&["图 片".to_string(), "示例(1).png".to_string()]),
            "图%20片/示例%281%29.png"
        );
        assert_eq!(
            encode_link_path(&["100%达成.png".to_string()]),
            "100%25达成.png"
        );
        assert_eq!(encode_link_path(&["a-b_c.png".to_string()]), "a-b_c.png");
    }

    /// URI 参数按 RFC 3986 严格编码（中文、空格、斜杠全编）。
    #[test]
    fn builds_open_uri_with_strict_encoding() {
        let uri = build_open_uri("我的 库", "子目录/笔记.md");
        assert_eq!(
            uri,
            "obsidian://open?vault=%E6%88%91%E7%9A%84%20%E5%BA%93&file=%E5%AD%90%E7%9B%AE%E5%BD%95%2F%E7%AC%94%E8%AE%B0.md"
        );
        assert!(uri.starts_with(OBSIDIAN_URI_SCHEME));
    }

    #[test]
    fn applies_edits_in_order_and_skips_overlaps() {
        let text = "![a](x.png) 与 ![b](y.png)";
        let spans: Vec<Range<usize>> = scan_asset_refs(text)
            .into_iter()
            .map(|item| item.span)
            .collect();
        assert_eq!(spans.len(), 2);

        // 故意乱序，并混入一条与首条重叠的编辑：排序要生效，重叠的那条必须被丢弃
        let edits = vec![
            (spans[1].clone(), "B.png".to_string()),
            (spans[0].clone(), "A.png".to_string()),
            (spans[0].start + 1..spans[0].end - 1, "重叠".to_string()),
        ];
        assert_eq!(apply_edits(text, edits), "![a](A.png) 与 ![b](B.png)");
        assert_eq!(apply_edits(text, Vec::new()), text);
    }

    /* ── 附件目录 ─────────────────────────────────────────────── */

    #[test]
    fn reads_attachment_folder_setting() {
        let dir = TempDir::new("attach-cfg");
        let note_dir = vec!["笔记".to_string()];

        // 没有 app.json：退化为笔记所在目录（不往 Vault 根倒图）
        assert_eq!(
            attachment_dir_components(dir.path(), &note_dir),
            note_dir.clone()
        );

        dir.write(
            ".obsidian/app.json",
            r#"{"attachmentFolderPath":"附件"}"#.as_bytes(),
        );
        assert_eq!(
            attachment_dir_components(dir.path(), &note_dir),
            vec!["附件".to_string()]
        );

        dir.write(
            ".obsidian/app.json",
            r#"{"attachmentFolderPath":"./图"}"#.as_bytes(),
        );
        assert_eq!(
            attachment_dir_components(dir.path(), &note_dir),
            vec!["笔记".to_string(), "图".to_string()]
        );

        dir.write(".obsidian/app.json", br#"{"attachmentFolderPath":"/"}"#);
        assert!(attachment_dir_components(dir.path(), &note_dir).is_empty());

        dir.write(".obsidian/app.json", b"{ broken");
        assert_eq!(attachment_dir_components(dir.path(), &note_dir), note_dir);
    }

    /// 子目录字符串必须被关在 Vault 里：`..` 与盘符一律吃掉。
    #[test]
    fn sanitizes_subfolder_input() {
        assert_eq!(
            sanitize_relative_dir(Some("笔记/2026")),
            vec!["笔记".to_string(), "2026".to_string()]
        );
        assert_eq!(
            sanitize_relative_dir(Some(r"..\..\Windows\System32")),
            vec!["Windows".to_string(), "System32".to_string()]
        );
        assert_eq!(
            sanitize_relative_dir(Some(r"D:\别处")),
            vec!["D_".to_string(), "别处".to_string()]
        );
        assert!(sanitize_relative_dir(None).is_empty());
        assert!(sanitize_relative_dir(Some("  /  ")).is_empty());
    }

    #[test]
    fn normalizes_paths_for_comparison() {
        assert!(same_file(
            Path::new(r"D:\a\b\..\c\笔记.md"),
            Path::new("D:/A/C/笔记.md")
        ));
        assert!(!same_file(Path::new(r"D:\a.md"), Path::new(r"D:\b.md")));
        assert_eq!(
            vault_relative_components(Path::new(r"D:\库"), Path::new(r"D:\库\附件\图.png")),
            Some(vec!["附件".to_string(), "图.png".to_string()])
        );
        assert_eq!(
            vault_relative_components(Path::new(r"D:\库"), Path::new(r"D:\别处\图.png")),
            None
        );
    }

    /* ── 端到端导入 ───────────────────────────────────────────── */

    /// 主路径：拷贝 .md + 拷贝正文引用的本地图片 + 重写链接 + 源文件分毫未动。
    #[test]
    fn imports_note_with_attachments() {
        let workspace = TempDir::new("import");
        let vault_root = workspace.path().join("库");
        std::fs::create_dir_all(&vault_root).expect("建 Vault 应成功");

        let source_text = concat!(
            "# 标题\n\n",
            "![相对](图 片/示例.png)\n",
            "![再引一次](./图 片/示例.png)\n",
            "![外链](https://example.com/a.png)\n",
            "![缺失](不存在.png)\n",
            "<img src=\"图 片/示例.png\">\n",
        );
        let source = workspace.write("原始/笔记.md", source_text.as_bytes());
        workspace.write("原始/图 片/示例.png", b"PNGDATA");

        let vault = vault_at(&vault_root);
        let outcome = import_into(
            &vault,
            &request(&source, Some("收件箱"), ConflictPolicy::Rename),
        )
        .expect("导入不应失败");

        assert_eq!(outcome.relative_path, "收件箱/笔记.md");
        assert_eq!(outcome.attachment_count, 1, "同一张图只拷一份");
        assert!(outcome.uri.starts_with("obsidian://open?vault="));

        let imported = std::fs::read_to_string(vault_root.join("收件箱").join("笔记.md"))
            .expect("导入产物应可读");
        assert!(
            imported.contains("![相对](示例.png)"),
            "相对链接应指向同目录的附件：{imported}"
        );
        assert!(
            imported.contains("![再引一次](示例.png)"),
            "同一张图的第二处引用也要重写：{imported}"
        );
        assert!(
            imported.contains("![外链](https://example.com/a.png)"),
            "外链不能被改写：{imported}"
        );
        assert!(
            imported.contains("![缺失](不存在.png)"),
            "找不到的附件保持原样：{imported}"
        );
        assert!(
            imported.contains("<img src=\"示例.png\">"),
            "HTML img 同样重写：{imported}"
        );

        // 附件落在笔记旁（无 app.json 时的约定），内容一致
        let copied = vault_root.join("收件箱").join("示例.png");
        assert_eq!(
            std::fs::read(&copied).expect("附件应存在").as_slice(),
            b"PNGDATA"
        );

        // 红线 5：源文件与源图片分毫未动
        assert_eq!(
            std::fs::read_to_string(&source).expect("源文件应仍可读"),
            source_text
        );
        assert!(workspace.path().join("原始/图 片/示例.png").is_file());
    }

    /// 重复导入：笔记改名让位，同名同内容的附件复用（不攒垃圾、不覆盖）。
    #[test]
    fn second_import_renames_note_and_reuses_identical_attachment() {
        let workspace = TempDir::new("import-twice");
        let vault_root = workspace.path().join("库");
        std::fs::create_dir_all(&vault_root).expect("建 Vault 应成功");
        let source = workspace.write("原始/笔记.md", "![图](图.png)\n".as_bytes());
        workspace.write("原始/图.png", b"SAME");

        let vault = vault_at(&vault_root);
        let first =
            import_into(&vault, &request(&source, None, ConflictPolicy::Rename)).expect("首次导入");
        assert_eq!(first.relative_path, "笔记.md");

        let second =
            import_into(&vault, &request(&source, None, ConflictPolicy::Rename)).expect("二次导入");
        assert_eq!(second.relative_path, "笔记-1.md", "笔记改名让位");
        assert_eq!(second.attachment_count, 1);
        assert!(
            !vault_root.join("图-1.png").exists(),
            "同名同内容的附件应复用，不该攒出 图-1.png"
        );

        // 同名但内容不同的附件必须改名，绝不覆盖
        std::fs::write(workspace.path().join("原始/图.png"), b"DIFFERENT").expect("改写源图应成功");
        let third =
            import_into(&vault, &request(&source, None, ConflictPolicy::Rename)).expect("三次导入");
        assert_eq!(third.relative_path, "笔记-2.md");
        assert_eq!(
            std::fs::read(vault_root.join("图.png"))
                .expect("原附件应还在")
                .as_slice(),
            b"SAME",
            "既有附件绝不被覆盖"
        );
        assert_eq!(
            std::fs::read(vault_root.join("图-1.png"))
                .expect("新附件应写入")
                .as_slice(),
            b"DIFFERENT"
        );
    }

    /// 附件目录与笔记目录不同层时，相对链接要正确地回退。
    #[test]
    fn rewrites_links_across_attachment_folder() {
        let workspace = TempDir::new("import-attach-dir");
        let vault_root = workspace.path().join("库");
        std::fs::create_dir_all(&vault_root).expect("建 Vault 应成功");
        std::fs::create_dir_all(vault_root.join(".obsidian")).expect("建配置目录应成功");
        std::fs::write(
            vault_root.join(".obsidian").join("app.json"),
            r#"{"attachmentFolderPath":"附件"}"#,
        )
        .expect("写 app.json 应成功");

        let source = workspace.write("原始/笔记.md", "![图](图 片.png)\n".as_bytes());
        workspace.write("原始/图 片.png", b"X");

        let outcome = import_into(
            &vault_at(&vault_root),
            &request(&source, Some("收件箱/2026"), ConflictPolicy::Rename),
        )
        .expect("导入不应失败");

        assert_eq!(outcome.relative_path, "收件箱/2026/笔记.md");
        let imported =
            std::fs::read_to_string(vault_root.join("收件箱").join("2026").join("笔记.md"))
                .expect("产物应可读");
        assert!(
            imported.contains("![图](../../附件/图%20片.png)"),
            "跨目录相对链接应带 ../ 且空格编码：{imported}"
        );
        assert!(vault_root.join("附件").join("图 片.png").is_file());
    }

    /// 源文件本来就在目标位置：不写盘、不复制，直接给定位 URI（红线 5 的兜底）。
    #[test]
    fn importing_a_note_already_in_place_never_writes() {
        let workspace = TempDir::new("import-inplace");
        let vault_root = workspace.path().join("库");
        std::fs::create_dir_all(&vault_root).expect("建 Vault 应成功");
        let source = {
            let path = vault_root.join("笔记.md");
            std::fs::write(&path, b"original").expect("写源文件应成功");
            path
        };

        let outcome = import_into(
            &vault_at(&vault_root),
            &request(&source, None, ConflictPolicy::Overwrite),
        )
        .expect("导入不应失败");

        assert_eq!(outcome.relative_path, "笔记.md");
        assert_eq!(outcome.attachment_count, 0);
        assert_eq!(
            std::fs::read(&source).expect("源文件应仍可读").as_slice(),
            b"original",
            "源文件绝不能被自己覆盖"
        );
    }

    /// Vault 不存在 / 源文件不存在都要给明确错误，而不是静默失败。
    #[test]
    fn reports_missing_vault_or_source() {
        let workspace = TempDir::new("import-missing");
        let missing_vault = Vault {
            id: "vault-id".to_string(),
            path: workspace.path().join("不存在的库"),
            name: "不存在的库".to_string(),
            open: false,
        };
        let source = workspace.write("a.md", b"x");
        let err = import_into(
            &missing_vault,
            &request(&source, None, ConflictPolicy::Rename),
        )
        .expect_err("Vault 不存在必须报错");
        assert_eq!(err.kind(), "not-found");

        let vault_root = workspace.path().join("库");
        std::fs::create_dir_all(&vault_root).expect("建 Vault 应成功");
        let err = import_into(
            &vault_at(&vault_root),
            &request(
                &workspace.path().join("没有这个文件.md"),
                None,
                ConflictPolicy::Rename,
            ),
        )
        .expect_err("源文件不存在必须报错");
        assert_eq!(err.kind(), "not-found");
    }

    /* ── 序列化契约 ───────────────────────────────────────────── */

    #[test]
    fn types_serialize_with_camel_case_keys() {
        let vault = serde_json::to_value(Vault {
            id: "abc".to_string(),
            path: PathBuf::from(r"D:\库"),
            name: "库".to_string(),
            open: true,
        })
        .expect("序列化不应失败");
        assert_eq!(vault["id"], "abc");
        assert!(vault["open"].as_bool().expect("open 应序列化成布尔"));

        let outcome = serde_json::to_value(ImportOutcome {
            relative_path: "a/b.md".to_string(),
            attachment_count: 2,
            uri: "obsidian://open".to_string(),
        })
        .expect("序列化不应失败");
        assert_eq!(outcome["relativePath"], "a/b.md");
        assert_eq!(outcome["attachmentCount"], 2);

        let request: ImportRequest = serde_json::from_str(
            r#"{"source":"D:\\a.md","vaultId":"abc","subfolder":null,"conflict":"rename"}"#,
        )
        .expect("反序列化不应失败");
        assert_eq!(request.conflict, ConflictPolicy::Rename);
        assert!(request.subfolder.is_none());
    }
}
