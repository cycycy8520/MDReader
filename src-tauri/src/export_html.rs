//! HTML 导出（FR-07）—— Rust 半：附件路径重写与落盘。
//!
//! 分工（与 `src/render/htmlExport.ts` 是一对）：
//! * **前端**负责渲染正文、内联样式、组装完整 HTML 文档，并把每一张本地图片的
//!   `img[src]` 换成占位 token（`mdnaonao-asset://<序号>`），随文档一起送来一张
//!   「token ↔ 本机绝对路径」清单；
//! * **本模块**负责把 token 换成最终引用，并把文件写到盘上：
//!   - [`HtmlExportMode::SingleFile`]：读图 → base64 → `data:` URI 内联，产物是一个
//!     双击即可离线打开的 .html；
//!   - [`HtmlExportMode::WithAssets`]：图片拷进 `<导出名>_files/`，token 换成相对路径。
//!
//! 【为什么后端不解析 HTML】
//! 解析 HTML 是导出功能的第二大 bug 源（第一大是路径重写本身，DG 10-5）。
//! token 方案让后端只做「整串相等的字符串替换」：单次线性扫描、零解析歧义、
//! 前端改了 DOM 结构也不会波及这里。
//!
//! 【路径重写是最常见的 bug 源（DG 10-5）】
//! 相对 / 绝对 / 正反斜杠混写 / 中文 / 空格 / UNC / `file://` / 百分号编码
//! 七种形态全部由 [`resolve_asset_path`] 一处收口，并逐形态写了单测。
//! 百分号编码刻意采用「**先按原样试，文件不存在再试解码**」的顺序——
//! 文件名里合法地含有 `%` 是真实存在的情况，无条件解码会把 `100%达成.png`
//! 变成一个永远找不到的路径。
//!
//! 【严格只读（红线 5）】
//! 本模块只**读**用户的 .md 与配图，写盘目标仅限用户在导出对话框里选定的输出位置。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::settings::HtmlExportMode;

// ---------------------------------------------------------------------------
// 前后端契约常量（前端 `src/render/htmlExport.ts` 有同名常量，改一侧必须同步）
// ---------------------------------------------------------------------------

/// 本地图片占位 token 的完整前缀，token 形如 `mdnaonao-asset://0`。
pub const ASSET_TOKEN_PREFIX: &str = "mdnaonao-asset://";

/// 资源目录后缀：`笔记.html` 的伴生目录是 `笔记_files`（FR-07 的字面要求）。
pub const ASSETS_DIR_SUFFIX: &str = "_files";

/// 导出名取不到时的兜底前缀（`file_stem` 为空的极端路径）。
const FALLBACK_STEM: &str = "export";

/// 文件名被清洗到空时的兜底名。
const FALLBACK_ASSET_NAME: &str = "asset";

/// 单文件模式的体积上限：超过就明确报错并建议改用资源目录模式（本次交付的硬要求）。
///
/// 50MB 不是任性取的：base64 会把二进制放大约 1/3，而 WebView / 浏览器打开
/// 单个巨型 HTML 时的内存放大还要再叠一层，再往上就是「导出成功但打不开」。
pub const SINGLE_FILE_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// 「目标已存在」错误的稳定前缀 —— **前端按它分支**弹确认框，然后带
/// `overwrite: true` 重新调用。放在 message 里而不是新增 `AppError` 变体，
/// 是因为 `AppError::kind()` 是全局前后端契约，不该为一个功能点扩张。
pub const ERR_TARGET_EXISTS: &str = "EXPORT_TARGET_EXISTS";

/// 「单文件模式体积超限」错误的稳定前缀，前端据此提示「改用 HTML + 资源目录」。
pub const ERR_TOO_LARGE: &str = "EXPORT_TOO_LARGE";

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 一张待处理的本地图片。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlExportAsset {
    /// HTML 里的占位 token（`mdnaonao-asset://0`）
    pub token: String,
    /// 本机绝对路径；可能含中文 / 空格 / UNC / `file://` / 百分号编码
    pub path: String,
}

/// 前端送来的完整导出载荷。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlExportPayload {
    /// 自包含的 HTML 文档字符串（含 doctype / meta charset / 内联样式）
    pub html: String,
    /// 本地图片清单；空数组 = 全文没有本地图片
    #[serde(default)]
    pub assets: Vec<HtmlExportAsset>,
    /// 源 .md 绝对路径，作为「万一混进相对路径」时的解析基准
    #[serde(default)]
    pub source_path: Option<String>,
}

/// 导出结果。
///
/// 前 3 个字段与 `export::ExportResult`（TS 侧 `ExportResult`）逐字段同形，
/// 因此前端即使不新增类型也能直接消费；`route` 恒为 `null`（HTML 导出没有
/// 「走通哪条路线」的概念，保留只为结构兼容）。后面几个是 HTML 导出特有的，
/// 供 toast 展示「内联 N 张图 / 资源目录在这里」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlExportResult {
    pub output: PathBuf,
    /// 恒为 `None`：仅为与 `ExportResult` 结构兼容而保留
    pub route: Option<String>,
    pub elapsed_ms: u64,
    pub mode: HtmlExportMode,
    /// 资源目录绝对路径；单文件模式为 `None`
    pub assets_dir: Option<PathBuf>,
    /// 成功内联（单文件）或拷贝（资源目录）的图片数
    pub asset_count: usize,
    /// 找不到 / 读不出的图片数：不让整次导出失败，但如实回传给用户
    pub missing_count: usize,
    /// 产物 .html 的字节数
    pub bytes: u64,
}

/// 目标位置冲突探测结果（前端在弹「另存为」之后、真正导出之前调一次）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlExportConflict {
    /// 目标 .html 已存在
    pub file_exists: bool,
    /// 资源目录已存在**且非空**（单文件模式恒为 false）
    pub assets_dir_conflict: bool,
    /// 资源目录绝对路径（资源目录模式才有值），用于确认框如实展示
    pub assets_dir: Option<PathBuf>,
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 导出 HTML（FR-07）。
///
/// * `payload`：前端渲染好的完整文档 + 本地图片清单
/// * `output`：目标 .html 绝对路径
/// * `mode`：单文件 / HTML + 资源目录
/// * `overwrite`：`false`（默认语义）时目标已存在直接报错，由前端确认后带 `true` 重来。
///   **绝不静默覆盖**——用户选错一次文件名就丢掉别的文档，是不可接受的。
///
/// 整个流程是同步 IO（读图 / base64 / 写盘，几十 MB 量级），因此整体丢到阻塞线程池，
/// 不占用 async 运行时的工作线程。
#[tauri::command]
pub async fn export_html(
    payload: HtmlExportPayload,
    output: PathBuf,
    mode: HtmlExportMode,
    overwrite: bool,
) -> AppResult<HtmlExportResult> {
    tauri::async_runtime::spawn_blocking(move || write_export(&payload, &output, mode, overwrite))
        .await
        .map_err(|err| {
            tracing::error!(%err, "HTML 导出任务失败");
            AppError::native(format!("HTML 导出任务失败：{err}"))
        })?
}

/// 探测目标位置是否已被占用（前端据此决定要不要弹覆盖确认框）。
///
/// 与 [`export_html`] 的守卫是两道独立检查：这道给 UI 用，那道防的是
/// 「探测之后、写盘之前」的时间窗，两者都不能省。
#[tauri::command]
pub async fn export_html_conflict(
    output: PathBuf,
    mode: HtmlExportMode,
) -> AppResult<HtmlExportConflict> {
    tauri::async_runtime::spawn_blocking(move || inspect_conflict(&output, mode))
        .await
        .map_err(|err| AppError::native(format!("探测导出目标失败：{err}")))
}

// ---------------------------------------------------------------------------
// 同步内核
// ---------------------------------------------------------------------------

fn inspect_conflict(output: &Path, mode: HtmlExportMode) -> HtmlExportConflict {
    let target = to_absolute(output);
    let assets_dir = match mode {
        HtmlExportMode::SingleFile => None,
        HtmlExportMode::WithAssets => Some(assets_dir_for(&target)),
    };
    let assets_dir_conflict = assets_dir.as_deref().is_some_and(dir_has_entries);

    HtmlExportConflict {
        file_exists: target.is_file(),
        assets_dir_conflict,
        assets_dir,
    }
}

/// 目录存在且至少有一个条目。读目录失败按「有内容」处理：
/// 拿不准的时候宁可多问用户一句，也不要闷头往里写。
fn dir_has_entries(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_some(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

fn write_export(
    payload: &HtmlExportPayload,
    output: &Path,
    mode: HtmlExportMode,
    overwrite: bool,
) -> AppResult<HtmlExportResult> {
    let started = std::time::Instant::now();
    let target = to_absolute(output);

    // 1) 冲突守卫（绝不静默覆盖）
    if !overwrite {
        let conflict = inspect_conflict(&target, mode);
        if conflict.file_exists {
            return Err(AppError::config(format!(
                "{ERR_TARGET_EXISTS}：目标文件已存在：{}",
                target.display()
            )));
        }
        if conflict.assets_dir_conflict {
            let dir = conflict.assets_dir.unwrap_or_default();
            return Err(AppError::config(format!(
                "{ERR_TARGET_EXISTS}：资源目录已存在且非空：{}",
                dir.display()
            )));
        }
    }

    // 2) 附件基准目录：源 .md 所在目录优先，取不到退回输出目录
    let source_dir = payload
        .source_path
        .as_deref()
        .map(|raw| to_absolute(Path::new(raw)))
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| target.parent().map(Path::to_path_buf));

    // 3) 逐张处理图片，得到 token → 最终引用
    let assets_dir = match mode {
        HtmlExportMode::SingleFile => None,
        HtmlExportMode::WithAssets => Some(assets_dir_for(&target)),
    };
    let plan = build_replacements(payload, source_dir.as_deref(), mode, assets_dir.as_deref())?;

    // 4) 单次线性扫描完成替换
    let (html, hits) = substitute_tokens(&payload.html, &plan.table);
    if hits < plan.table.len() {
        // 清单里有、正文里没有：多半是前端后处理漏改了某张图，留痕但不阻断
        tracing::warn!(
            listed = plan.table.len(),
            hit = hits,
            "部分图片占位 token 未在正文中命中"
        );
    }

    let bytes = html.len() as u64;
    if matches!(mode, HtmlExportMode::SingleFile) && bytes > SINGLE_FILE_MAX_BYTES {
        return Err(AppError::config(format!(
            "{ERR_TOO_LARGE}：单文件模式产物约 {} MB，超过 {} MB 上限，请改用「HTML + 资源目录」模式",
            bytes / (1024 * 1024),
            SINGLE_FILE_MAX_BYTES / (1024 * 1024)
        )));
    }

    // 5) 原子写：先写同目录的临时文件再 rename（Windows 的 rename 会覆盖同名文件）
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(&target, html.as_bytes())?;

    let elapsed_ms = started.elapsed().as_millis() as u64;
    tracing::info!(
        output = %target.display(),
        ?mode,
        bytes,
        asset_count = plan.asset_count,
        missing = plan.missing_count,
        elapsed_ms,
        "HTML 导出完成"
    );

    Ok(HtmlExportResult {
        output: target,
        route: None,
        elapsed_ms,
        mode,
        assets_dir,
        asset_count: plan.asset_count,
        missing_count: plan.missing_count,
        bytes,
    })
}

/// 先写 `<目标>.tmp` 再 rename，避免中途失败留下半截 HTML。
fn write_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut tmp = target.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);

    std::fs::write(&tmp, bytes)?;
    if let Err(err) = std::fs::rename(&tmp, target) {
        // rename 失败要把临时文件收掉，否则用户的目录里会攒出一堆 .tmp
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(err));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 附件处理
// ---------------------------------------------------------------------------

struct ReplacementPlan {
    /// token → 最终 `src` 值
    table: HashMap<String, String>,
    /// 成功内联 / 拷贝的张数
    asset_count: usize,
    /// 找不到或读不出的张数
    missing_count: usize,
}

/// 无法定位的图片统一指向它：浏览器会显示 alt 文本而不是把用户的本机路径印在页面上。
const MISSING_ASSET_SRC: &str = "about:invalid#missing-asset";

fn build_replacements(
    payload: &HtmlExportPayload,
    source_dir: Option<&Path>,
    mode: HtmlExportMode,
    assets_dir: Option<&Path>,
) -> AppResult<ReplacementPlan> {
    let mut table: HashMap<String, String> = HashMap::with_capacity(payload.assets.len());
    let mut used_names: HashSet<String> = HashSet::new();
    let mut asset_count = 0usize;
    let mut missing_count = 0usize;

    // 单文件模式的体积闸门：正文本身 + 已内联的 data URI，边算边判，
    // 免得先花几十秒把 200MB base64 拼出来再告诉用户「太大了」
    let mut projected = payload.html.len() as u64;

    let dir_href_prefix = assets_dir
        .and_then(|dir| dir.file_name())
        .map(|name| format!("{}/", encode_uri_component(&name.to_string_lossy())))
        .unwrap_or_default();

    for asset in &payload.assets {
        if table.contains_key(&asset.token) {
            // 前端已按路径去重；真出现重复 token 时以先到者为准
            continue;
        }

        let Some(resolved) = resolve_asset_path(source_dir, &asset.path) else {
            tracing::warn!(raw = %asset.path, "图片路径无法解析，导出件中该图将缺失");
            table.insert(asset.token.clone(), MISSING_ASSET_SRC.to_string());
            missing_count += 1;
            continue;
        };

        let size = match std::fs::metadata(&resolved) {
            Ok(meta) if meta.is_file() => meta.len(),
            _ => {
                tracing::warn!(path = %resolved.display(), "图片不存在或不是文件，导出件中该图将缺失");
                table.insert(asset.token.clone(), MISSING_ASSET_SRC.to_string());
                missing_count += 1;
                continue;
            }
        };

        match mode {
            HtmlExportMode::SingleFile => {
                // base64 放大约 4/3，先按元数据预判，避免读进内存才发现超限
                projected += size / 3 * 4 + 128;
                if projected > SINGLE_FILE_MAX_BYTES {
                    return Err(AppError::config(format!(
                        "{ERR_TOO_LARGE}：单文件模式内联后预计超过 {} MB 上限，请改用「HTML + 资源目录」模式",
                        SINGLE_FILE_MAX_BYTES / (1024 * 1024)
                    )));
                }
                let bytes = std::fs::read(&resolved).map_err(|err| {
                    tracing::error!(path = %resolved.display(), %err, "读取图片失败");
                    AppError::Io(err)
                })?;
                let data_url = format!(
                    "data:{};base64,{}",
                    mime_for(&resolved),
                    base64_encode(&bytes)
                );
                table.insert(asset.token.clone(), data_url);
                asset_count += 1;
            }
            HtmlExportMode::WithAssets => {
                let dir = assets_dir.ok_or_else(|| {
                    AppError::config("资源目录模式缺少资源目录路径（内部错误）".to_string())
                })?;
                std::fs::create_dir_all(dir)?;

                let name = unique_asset_name(&resolved, &mut used_names);
                let destination = dir.join(&name);
                // 源与目标是同一个文件时不拷（重复导出到同一位置的退化情形）
                if !same_file(&resolved, &destination) {
                    std::fs::copy(&resolved, &destination).map_err(|err| {
                        tracing::error!(
                            from = %resolved.display(),
                            to = %destination.display(),
                            %err,
                            "拷贝图片失败"
                        );
                        AppError::Io(err)
                    })?;
                }
                table.insert(
                    asset.token.clone(),
                    format!("{dir_href_prefix}{}", encode_uri_component(&name)),
                );
                asset_count += 1;
            }
        }
    }

    Ok(ReplacementPlan {
        table,
        asset_count,
        missing_count,
    })
}

/// 单次线性扫描把 token 换成最终引用，返回（新正文, 命中数）。
///
/// 不用 `str::replace` 逐个 token 跑一遍：那是 O(图片数 × 正文长度)，
/// 一篇几百张图的文档配上几十 MB 正文能扫出十几 GB 的无效比较。
fn substitute_tokens(html: &str, table: &HashMap<String, String>) -> (String, usize) {
    if table.is_empty() {
        return (html.to_string(), 0);
    }
    let mut out = String::with_capacity(html.len() + 1024);
    let mut cursor = 0usize;
    let mut hits = 0usize;

    while let Some(found) = html[cursor..].find(ASSET_TOKEN_PREFIX) {
        let start = cursor + found;
        let digits_start = start + ASSET_TOKEN_PREFIX.len();
        // 序号是纯 ASCII 数字，切片边界必然落在字符边界上
        let digits = html[digits_start..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        let end = digits_start + digits;

        out.push_str(&html[cursor..start]);
        let token = &html[start..end];
        match table.get(token) {
            Some(value) => {
                out.push_str(value);
                hits += 1;
            }
            // 认不出的 token 原样留下：宁可留一个坏图，也不要吞掉正文
            None => out.push_str(token),
        }
        // digits == 0 时 end == digits_start > start，游标依然前进，不会死循环
        cursor = end;
    }
    out.push_str(&html[cursor..]);
    (out, hits)
}

// ---------------------------------------------------------------------------
// 路径解析（DG 10-5 的核心，七种形态全部收口在这里）
// ---------------------------------------------------------------------------

/// 把前端给的原始引用还原成本机路径。
///
/// 处理顺序：去空白 → 剥 `file://` → 判绝对/相对 → 相对则拼基准目录 →
/// 「原样」与「百分号解码」两个候选中挑存在的那一个。
///
/// 返回 `None` 只有两种情况：空串，或相对路径但没有基准目录。
pub fn resolve_asset_path(base_dir: Option<&Path>, raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let from_url = is_file_url(trimmed);
    let stripped = strip_file_url(trimmed);
    let mut candidates: Vec<String> = vec![stripped.clone()];
    if stripped.contains('%') {
        if let Some(decoded) = percent_decode(&stripped) {
            if decoded != stripped {
                // URL 里的 `%20` **必然**是转义（URL 语法如此规定），解码形态优先；
                // 而普通路径里的 `%` 完全可能是文件名的一部分（`100%达成.png`），
                // 那时原样形态优先、解码只是备选。两条都留着，最终由「谁真的存在」定夺。
                if from_url {
                    candidates.insert(0, decoded);
                } else {
                    candidates.push(decoded);
                }
            }
        }
    }

    let mut resolved: Vec<PathBuf> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if is_absolute_like(&candidate) {
            resolved.push(PathBuf::from(&candidate));
        } else if let Some(base) = base_dir {
            resolved.push(join_relative(base, Path::new(&candidate)));
        }
    }

    // 存在的那个优先；都不存在则回落首个候选（错误信息里能看到原始写法）
    if let Some(found) = resolved.iter().find(|path| path.is_file()) {
        return Some(found.clone());
    }
    resolved.into_iter().next()
}

/// 是否是 `file:` URL（大小写不敏感；只看协议头，不做完整 URL 校验）。
fn is_file_url(raw: &str) -> bool {
    raw.get(..5)
        .is_some_and(|head| head.eq_ignore_ascii_case("file:"))
}

/// 剥掉 `file://` 前缀并还原成 Windows 写法。
///
/// * `file:///D:/a/b.png` → `D:/a/b.png`
/// * `file://server/share/a.png` → `\\server\share\a.png`（UNC）
/// * 非 file URL 原样返回
fn strip_file_url(raw: &str) -> String {
    if !is_file_url(raw) {
        return raw.to_string();
    }
    // `file:` 是 5 个 ASCII 字节，切片边界安全
    let rest = &raw[5..];
    match rest.strip_prefix("//") {
        // `///D:/…` 本地盘符：再吃掉那个多余的斜杠
        Some(after) => match after.strip_prefix('/') {
            Some(local) => local.to_string(),
            None => format!(r"\\{after}"),
        },
        None => rest.trim_start_matches('/').to_string(),
    }
}

/// 是否是「不需要拼基准目录」的路径。
///
/// 自己判而不是用 `Path::is_absolute()`：后者的语义随目标平台变化，
/// 而本产品处理的永远是 Windows 语义的路径（单测也要能在任意平台跑出同一结果）。
fn is_absolute_like(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    // UNC：`\\server\share` 或 `//server/share`，含 `\\?\C:\…` 扩展前缀
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return true;
    }
    // 盘符：`D:\…` / `D:/…`（`D:a.png` 是「D 盘当前目录」的相对写法，不算）
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return bytes[2] == b'\\' || bytes[2] == b'/';
    }
    // 当前盘根：`\a\b` / `/a/b`
    matches!(bytes.first(), Some(b'\\') | Some(b'/'))
}

/// 以 `base` 为基准拼相对路径，逐段消化 `.` 与 `..`。
///
/// 不用 `base.join(relative)`：`join` 不会消化 `..`，留在路径里虽然大多数 API 能忍，
/// 但拷贝出来的文件名与日志都会难看得多，且 `\\?\` 前缀的路径根本不接受 `..`。
fn join_relative(base: &Path, relative: &Path) -> PathBuf {
    let mut result = base.to_path_buf();
    for segment in relative.to_string_lossy().split(['\\', '/']) {
        match segment {
            "" | "." => continue,
            ".." => {
                result.pop();
            }
            other => result.push(other),
        }
    }
    result
}

/// 百分号解码；解出来不是合法 UTF-8 时返回 `None`（保持原样更安全）。
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).ok()
}

/// 两个路径是否指向同一个文件（按 Windows 语义归一化后比较）。
fn same_file(a: &Path, b: &Path) -> bool {
    fn key(path: &Path) -> String {
        path.to_string_lossy().replace('/', "\\").to_lowercase()
    }
    key(a) == key(b)
}

// ---------------------------------------------------------------------------
// 资源目录与文件名
// ---------------------------------------------------------------------------

/// `D:\out\笔记.html` → `D:\out\笔记_files`。
pub fn assets_dir_for(output: &Path) -> PathBuf {
    let stem = output
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| FALLBACK_STEM.to_string());
    let parent = output.parent().map(Path::to_path_buf).unwrap_or_default();
    parent.join(format!("{stem}{ASSETS_DIR_SUFFIX}"))
}

/// Windows 文件名里非法的字符（外加控制字符，见 [`sanitize_component`]）。
const ILLEGAL_NAME_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Windows 保留设备名：叫 `CON.png` 的文件在资源管理器里根本创建不出来。
const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// 为资源目录里的一张图起一个合法且唯一的文件名。
///
/// 中文一律保留（改成拼音或哈希会让用户在资源目录里认不出自己的图）；
/// 只清洗 Windows 真正不接受的字符，并处理保留设备名与同名冲突。
fn unique_asset_name(source: &Path, used: &mut HashSet<String>) -> String {
    let raw = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned = sanitize_component(&raw);

    let (stem, extension) = match cleaned.rfind('.') {
        // 首字符就是点（`.gitkeep`）时整串当 stem，不要切出一个空 stem
        Some(dot) if dot > 0 => (cleaned[..dot].to_string(), cleaned[dot..].to_string()),
        _ => (cleaned.clone(), String::new()),
    };
    let stem = if RESERVED_NAMES.contains(&stem.to_ascii_lowercase().as_str()) {
        format!("_{stem}")
    } else {
        stem
    };

    let mut candidate = format!("{stem}{extension}");
    let mut serial = 1u32;
    while !used.insert(candidate.to_lowercase()) {
        candidate = format!("{stem}-{serial}{extension}");
        serial += 1;
    }
    candidate
}

/// 清洗单个路径分量：替换非法字符与控制字符，去掉 Windows 不允许的结尾点/空格。
fn sanitize_component(raw: &str) -> String {
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
    if cleaned.trim().is_empty() {
        FALLBACK_ASSET_NAME.to_string()
    } else {
        cleaned
    }
}

/// 百分号编码一个 URI 分量：只保留 RFC 3986 的 unreserved 字符。
///
/// 中文与空格因此都会被编码。这不是洁癖：`href="图 片.png"` 在 `file://`
/// 场景里各家浏览器的容错行为并不一致，编码后是唯一的确定解。
fn encode_uri_component(raw: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            other => {
                out.push('%');
                out.push(HEX[(other >> 4) as usize] as char);
                out.push(HEX[(other & 0x0f) as usize] as char);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// MIME 与 base64
// ---------------------------------------------------------------------------

/// 按扩展名判 MIME（大小写不敏感）。
///
/// 刻意不做「嗅探文件头」：查看器里的图片是作者自己放进 Markdown 的，
/// 扩展名与内容不符时按扩展名走恰恰是最不意外的行为，也与浏览器一致。
fn mime_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" | "cur" => "image/x-icon",
        "avif" => "image/avif",
        "tif" | "tiff" => "image/tiff",
        "apng" => "image/apng",
        // 认不出就交给浏览器嗅探——比硬写一个错的 image/* 更安全
        _ => "application/octet-stream",
    }
}

/// 标准 base64（RFC 4648，带 `=` 补位）。
///
/// 自己写而不是引 `base64` crate：新增运行时依赖需要先向人类申请（红线 12），
/// 而这段编码逻辑只有二十行且已被下面的官方测试向量钉死。
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6) as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[triple as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 相对路径按当前工作目录补全；不做 `canonicalize`——它会返回 `\\?\C:\…`
/// 这种前缀，explorer 与前端展示都不认（与 `files.rs` 同一约定）。
fn to_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> PathBuf {
        PathBuf::from(r"D:\笔记\子目录")
    }

    fn resolved(raw: &str) -> String {
        resolve_asset_path(Some(base().as_path()), raw)
            .expect("应能解析")
            .to_string_lossy()
            .into_owned()
    }

    /* ── 路径重写：七种形态（DG 10-5 语料库） ─────────────────── */

    /// 相对路径以 .md 所在目录为基准，中文与空格必须原样保留。
    #[test]
    fn resolves_relative_path_with_cjk_and_spaces() {
        assert_eq!(
            resolved("图 片/示例 1.png"),
            r"D:\笔记\子目录\图 片\示例 1.png"
        );
        assert_eq!(resolved("./a.png"), r"D:\笔记\子目录\a.png");
    }

    /// `..` 必须被消化掉，而不是原样留在路径里。
    #[test]
    fn resolves_parent_segments() {
        assert_eq!(resolved("../assets/图.png"), r"D:\笔记\assets\图.png");
        assert_eq!(resolved("..\\..\\x.png"), r"D:\x.png");
    }

    /// 盘符绝对路径（正反斜杠两种写法）不拼基准目录。
    #[test]
    fn keeps_absolute_drive_paths() {
        assert_eq!(resolved(r"E:\图库\a.png"), r"E:\图库\a.png");
        assert_eq!(resolved("E:/图库/a.png"), "E:/图库/a.png");
    }

    /// UNC 共享路径同样是绝对路径（`\\server\share\…`）。
    #[test]
    fn keeps_unc_paths() {
        assert_eq!(resolved(r"\\NAS\共享\图 片.png"), r"\\NAS\共享\图 片.png");
        assert_eq!(resolved(r"\\?\C:\x\a.png"), r"\\?\C:\x\a.png");
    }

    /// `D:a.png` 是「D 盘当前目录」的相对写法，不能当绝对路径处理。
    #[test]
    fn drive_relative_form_is_not_absolute() {
        assert!(!is_absolute_like("D:a.png"));
        assert!(is_absolute_like(r"D:\a.png"));
        assert!(is_absolute_like("D:/a.png"));
    }

    /// `file://` URL 的三种形态。
    #[test]
    fn strips_file_url_forms() {
        assert_eq!(strip_file_url("file:///D:/a/b.png"), "D:/a/b.png");
        assert_eq!(strip_file_url("FILE:///D:/a.png"), "D:/a.png");
        assert_eq!(strip_file_url("file://NAS/共享/a.png"), r"\\NAS/共享/a.png");
        assert_eq!(strip_file_url("D:/a.png"), "D:/a.png");
    }

    /// 百分号编码：文件不存在时退回解码结果（`%20` → 空格）。
    #[test]
    fn falls_back_to_percent_decoded_path() {
        assert_eq!(resolved("file:///D:/a/b%20c.png"), r"D:/a/b c.png");
        assert_eq!(
            percent_decode("%E4%B8%AD%E6%96%87.png").as_deref(),
            Some("中文.png")
        );
        // 非法转义原样留下，不能把整个路径判废
        assert_eq!(
            percent_decode("100%达成.png").as_deref(),
            Some("100%达成.png")
        );
    }

    /// 文件名里真的含 `%` 时，磁盘上存在的那个写法优先（解码只是备选）。
    #[test]
    fn prefers_existing_literal_percent_name() {
        let dir = std::env::temp_dir().join(format!(
            "mdnaonao-export-html-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录应成功");
        let literal = dir.join("100%41.png");
        std::fs::write(&literal, b"x").expect("写临时文件应成功");

        let picked = resolve_asset_path(Some(dir.as_path()), "100%41.png").expect("应能解析");
        assert_eq!(
            picked, literal,
            "磁盘上存在的原样写法优先于解码结果（%41=A）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空串 / 无基准目录的相对路径必须明确失败，而不是拼出一个野路径。
    #[test]
    fn rejects_unresolvable_inputs() {
        assert!(resolve_asset_path(Some(base().as_path()), "   ").is_none());
        assert!(resolve_asset_path(None, "a.png").is_none());
        assert!(resolve_asset_path(None, r"D:\a.png").is_some());
    }

    /* ── 资源目录与文件名 ─────────────────────────────────────── */

    #[test]
    fn derives_assets_dir_from_output_stem() {
        assert_eq!(
            assets_dir_for(Path::new(r"D:\导出\我的 笔记.html")),
            PathBuf::from(r"D:\导出\我的 笔记_files")
        );
    }

    /// 非法字符替换、保留设备名规避、中文保留、同名去重。
    #[test]
    fn builds_unique_and_legal_asset_names() {
        let mut used = HashSet::new();
        assert_eq!(
            unique_asset_name(Path::new(r"D:\a\图 片.png"), &mut used),
            "图 片.png"
        );
        // 同名第二张加序号（大小写不敏感，Windows 语义）
        assert_eq!(
            unique_asset_name(Path::new(r"D:\b\图 片.PNG"), &mut used),
            "图 片-1.PNG"
        );
        assert_eq!(
            unique_asset_name(Path::new(r"D:\c\CON.png"), &mut used),
            "_CON.png"
        );
        assert_eq!(
            unique_asset_name(Path::new(r"D:\d\a?b*c.png"), &mut used),
            "a_b_c.png"
        );
        // 无扩展名不能被切出空 stem
        assert_eq!(
            unique_asset_name(Path::new(r"D:\e\.gitkeep"), &mut used),
            ".gitkeep"
        );
    }

    #[test]
    fn encodes_uri_components_for_file_urls() {
        assert_eq!(encode_uri_component("a b.png"), "a%20b.png");
        assert_eq!(encode_uri_component("中.png"), "%E4%B8%AD.png");
        assert_eq!(encode_uri_component("a-b_c.d~e"), "a-b_c.d~e");
    }

    /* ── token 替换 ───────────────────────────────────────────── */

    #[test]
    fn substitutes_every_occurrence_of_a_token() {
        let mut table = HashMap::new();
        table.insert(
            format!("{ASSET_TOKEN_PREFIX}0"),
            "a_files/x.png".to_string(),
        );
        table.insert(
            format!("{ASSET_TOKEN_PREFIX}1"),
            "data:image/png;base64,AA".to_string(),
        );

        let html = concat!(
            r#"<img src="mdnaonao-asset://0"><p>中文</p>"#,
            r#"<img src="mdnaonao-asset://1"><img src="mdnaonao-asset://0">"#
        );
        let (out, hits) = substitute_tokens(html, &table);
        assert_eq!(hits, 3, "同一 token 出现两次应各替换一次");
        assert!(!out.contains(ASSET_TOKEN_PREFIX), "不得残留占位 token");
        assert_eq!(out.matches("a_files/x.png").count(), 2);
        assert!(out.contains("data:image/png;base64,AA"));
        assert!(out.contains("<p>中文</p>"), "正文不得被破坏");
    }

    /// 认不出的 token 原样留下，且不能把扫描卡死。
    #[test]
    fn leaves_unknown_tokens_untouched() {
        let table = HashMap::new();
        let html = r#"<img src="mdnaonao-asset://7"><img src="mdnaonao-asset://">"#;
        let (out, hits) = substitute_tokens(html, &table);
        assert_eq!(hits, 0);
        assert_eq!(out, html);
    }

    /* ── base64 / MIME ───────────────────────────────────────── */

    /// RFC 4648 第 10 节的官方测试向量。
    #[test]
    fn encodes_base64_per_rfc4648() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 高位字节不能被符号扩展成负数
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn maps_mime_by_extension_case_insensitively() {
        assert_eq!(mime_for(Path::new("a.PNG")), "image/png");
        assert_eq!(mime_for(Path::new("a.jpeg")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("a.unknown")), "application/octet-stream");
        assert_eq!(mime_for(Path::new("a")), "application/octet-stream");
    }

    /* ── 序列化契约 ───────────────────────────────────────────── */

    /// 结果体走 camelCase，且 `route` 恒为 null（与 TS 的 ExportResult 结构兼容）。
    #[test]
    fn result_serializes_with_camel_case_keys() {
        let value = serde_json::to_value(HtmlExportResult {
            output: PathBuf::from(r"D:\a.html"),
            route: None,
            elapsed_ms: 12,
            mode: HtmlExportMode::WithAssets,
            assets_dir: Some(PathBuf::from(r"D:\a_files")),
            asset_count: 2,
            missing_count: 0,
            bytes: 4096,
        })
        .expect("序列化不应失败");

        assert!(value["route"].is_null());
        assert_eq!(value["elapsedMs"], 12);
        assert_eq!(value["assetCount"], 2);
        assert_eq!(value["missingCount"], 0);
        assert_eq!(value["mode"], "with-assets");
    }

    /// 载荷按 camelCase 反序列化，`assets` / `sourcePath` 缺省时不报错。
    #[test]
    fn payload_deserializes_with_optional_fields() {
        let payload: HtmlExportPayload =
            serde_json::from_str(r#"{"html":"<p>hi</p>"}"#).expect("反序列化不应失败");
        assert_eq!(payload.html, "<p>hi</p>");
        assert!(payload.assets.is_empty());
        assert!(payload.source_path.is_none());
    }
}
