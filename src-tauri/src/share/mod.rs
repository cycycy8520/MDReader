//! DG 7.1 `share/` 职责：分享通道。
//!
//! 三个目标平台的能力边界（DG 2.3 硬性平台约束 + DG 10-1，**产品文案必须与之一致**）：
//! * **微信**：无 API；聊天窗口粘贴富文本必退化为纯文本（平台确定性行为，事实库 #6）。
//!   因此聊天场景只做长图（[`crate::capture`]）与文件；富文本只面向**公众号编辑器**。
//!   永不承诺、永不实现「自动发到微信」（红线 7）。
//! * **飞书**：默认通道 = 复制富文本粘贴；进阶通道 = API 导入（[`lark`]）。
//! * **钉钉**：无公开文档导入 API（事实库 #8），只做富文本 / 长图 / 发送文件三兜底。
//!
//! 富文本写剪贴板一律用 clipboard-manager 的 `write_html(html, alt_text)`——
//! 它自动生成 CF_HTML 头并同时写入纯文本回退（事实库 #14），
//! **不手工拼 CF_HTML 头**（红线 11）。权限见 capabilities/default.json 的
//! `clipboard-manager:allow-write-html`（已放行）。
//!
//! ## 本模块的两条命令与它们的分工
//!
//! | 命令 | 剪贴板格式 | 收件端 |
//! |---|---|---|
//! | [`copy_rich_text`] | CF_HTML + CF_UNICODETEXT（插件一次写两份） | 公众号图文编辑器 / 飞书文档 / 钉钉文档 / Word |
//! | [`copy_file_to_clipboard`] | CF_HDROP（文件拖放列表） | 微信 / 企业微信 / 钉钉**聊天窗口**（粘贴长图 PNG 发送） |
//!
//! 两条命令刻意不合并：它们服务的是两类**互斥**的收件端。聊天窗口只取
//! `text/plain`，把富文本写给它等于什么都没做；富文本编辑器则不接受文件列表。
//! 分享面板据此把入口分成两组，文案分别说清适用场景（不写笼统的「分享到微信」）。
//!
//! ## 样式内联发生在前端
//!
//! 收件端不会带上本应用的 CSS，因此 `html` 必须是**逐元素内联样式**的产物。
//! 这件事只能在前端做（`src/components/shareRichText.ts`：离屏渲染 →
//! `getComputedStyle` → 白名单属性内联），后端拿到的已经是成品，
//! 这里**不做任何 HTML 解析**——只按整串相等替换本地图片占位 token，
//! 与 `export_html.rs` 是同一套契约、同一个理由（后端解析 HTML 是导出类功能的头号 bug 源）。

pub mod lark;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::error::{AppError, AppResult};

/* ── 体积闸门（技术值，不是产品参数） ─────────────────────────── */

/// 单张本地图片允许内联的字节上限（base64 会再放大约 1/3）。
///
/// 超限的图**不静默丢弃**：占位 token 换成 [`IMAGE_UNAVAILABLE_URI`]，
/// 收件端显示 alt 文本，同时结果里回传 `skipped_images`，由前端如实告诉用户
/// 「有 N 张图没能带上」。悄悄少几张图是分享功能里最气人的失败方式。
pub const MAX_INLINE_IMAGE_BYTES: u64 = 2 * 1024 * 1024;

/// 全部内联图片的总预算。一篇图多的文档若不设总闸门，
/// 剪贴板里会出现几十 MB 的 CF_HTML，粘贴端（尤其是公众号编辑器）会直接卡死。
pub const INLINE_IMAGE_BUDGET_BYTES: u64 = 8 * 1024 * 1024;

/// 最终写进剪贴板的 HTML 字节硬上限。超过即拒绝并给出可执行的出路
/// （前端提示改用长图 / 导出 HTML），而不是把编辑器写崩。
pub const MAX_CLIPBOARD_HTML_BYTES: usize = 24 * 1024 * 1024;

/// 内联失败 / 超限时替换进 `img[src]` 的地址。
///
/// 与 `render/htmlExport.ts` 的 `CSS_ASSET_UNAVAILABLE` 同一个取值，理由也一样：
/// 保留原始本机绝对路径既误导人（看起来像能加载），也等于把用户的目录结构
/// 明晃晃地贴进别人的编辑器。
pub const IMAGE_UNAVAILABLE_URI: &str = "about:invalid";

/* ── 数据契约（字段名即 wire 格式，前端 shareRichText.ts / ShareDialog.tsx 逐一对齐） ── */

/// 分享目标。仅决定日志分类与将来可能的模板差异，**不做任何遥测**（DG 2.2 范围外）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShareTarget {
    /// 微信公众号图文编辑器（富文本粘贴的**唯一**微信场景）
    WechatMp,
    /// 飞书文档（富文本粘贴，零配置默认通道）
    Lark,
    /// 钉钉文档（富文本粘贴；钉钉无导入 API，事实库 #8）
    DingTalk,
}

impl ShareTarget {
    /// 日志用的稳定标识（与 serde 的 kebab-case 一致，便于 grep 日志对上前端行为）
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WechatMp => "wechat-mp",
            Self::Lark => "lark",
            Self::DingTalk => "ding-talk",
        }
    }
}

/// 一张待内联的本地图片：HTML 里的占位 token ↔ 本机绝对路径。
///
/// 与 `render/htmlExport.ts` 的 `HtmlExportAsset` 同形（前端复用同一个 `assetToken()`），
/// 但**不共享 Rust 侧常量**：这里只做整串相等替换，不需要认识 token 的构造规则。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextAsset {
    /// 形如 `mdnaonao-asset://0`，在 `html` 中只出现在 `img[src]` 上
    pub token: String,
    /// 本机绝对路径（可能含中文 / 空格 / UNC）
    pub path: PathBuf,
}

/// 富文本分享载荷。HTML 由前端渲染成**逐元素内联样式**
/// （编辑器普遍丢弃 `<style>` 块，只认元素上的 style 属性）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextPayload {
    /// 内联样式 HTML 片段（不含 `<html>/<head>`，CF_HTML 头由插件生成）
    pub html: String,
    /// 纯文本回退（`write_html` 的 alt_text；聊天窗口只会取到这一份）
    pub plain_text: String,
    pub target: ShareTarget,
    /// 本地图片清单；空数组表示全文没有本地图片，本命令无事可做
    #[serde(default)]
    pub assets: Vec<RichTextAsset>,
}

/// 富文本写入结果。三个数字都是给**用户可见提示**用的，不是调试信息：
/// 少带了几张图必须让用户当场知道，否则他会把一篇缺图的稿子直接发出去。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextResult {
    /// 成功内联为 data URI 的图片数
    pub inlined_images: u32,
    /// 因超限 / 读不出而降级为 alt 文本的图片数
    pub skipped_images: u32,
    /// 最终写进剪贴板的 HTML 字节数（前端据此判断要不要提示「体积较大」）
    pub html_bytes: u64,
}

/// 长图文件写剪贴板的结果。分段长图会有多个文件，全部一次性放进同一个 CF_HDROP。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileClipboardResult {
    pub file_count: u32,
}

/* ── 命令 1：富文本 → CF_HTML ───────────────────────────────── */

/// 把富文本写入剪贴板（FR-10 ② 公众号 / FR-11 飞书默认通道 / FR-18 钉钉）。
///
/// 流程：内联本地图片 → 体积闸门 → `write_html(html, Some(plain_text))`。
///
/// **不做的事**：不解析 HTML、不改写样式、不发起任何网络请求（外链图片保持原样，
/// 由收件端自己决定要不要拉——红线 4 约束的是本应用运行时，不是别人的编辑器）。
///
/// 失败语义：全部返回 [`AppError`]，前端 try/catch 后按 i18n 文案提示并保持面板开着，
/// 用户可以改走长图路径——这条命令失败绝不能变成一个死掉的按钮。
#[tauri::command]
pub async fn copy_rich_text(app: AppHandle, payload: RichTextPayload) -> AppResult<RichTextResult> {
    // 读图 + base64 是同步 IO，可能是几 MB 量级；剪贴板写入在 Windows 上还要
    // 抢 OpenClipboard。整体丢进阻塞线程池，别占着 async 执行器不放。
    tauri::async_runtime::spawn_blocking(move || write_rich_text(&app, payload))
        .await
        .map_err(|error| AppError::native(format!("copy_rich_text 线程池调度失败：{error}")))?
}

fn write_rich_text(app: &AppHandle, payload: RichTextPayload) -> AppResult<RichTextResult> {
    let target = payload.target;
    let inlined = inline_assets(&payload.html, &payload.assets);

    if inlined.html.len() > MAX_CLIPBOARD_HTML_BYTES {
        return Err(AppError::config(format!(
            "富文本体积 {} 字节超过剪贴板上限 {} 字节（target={}），建议改用长图或导出 HTML",
            inlined.html.len(),
            MAX_CLIPBOARD_HTML_BYTES,
            target.as_str()
        )));
    }

    let html_bytes = inlined.html.len() as u64;
    // write_html 的两个形参是同一个泛型 T，故必须同为 String（插件 2.3.2 的签名）
    app.clipboard()
        .write_html(inlined.html, Some(payload.plain_text))
        .map_err(|error| AppError::native(format!("写入 CF_HTML 失败：{error}")))?;

    // 字段名刻意不叫 `target`：那是 tracing 宏的保留字（`target:` 用来指定日志目标），
    // 拿它当普通字段名会在宏展开期报错。
    tracing::info!(
        share_target = target.as_str(),
        html_bytes = html_bytes,
        inlined_images = inlined.inlined as u64,
        skipped_images = inlined.skipped as u64,
        "已写入富文本到剪贴板"
    );

    Ok(RichTextResult {
        inlined_images: inlined.inlined,
        skipped_images: inlined.skipped,
        html_bytes,
    })
}

/* ── 命令 2：长图文件 → CF_HDROP ────────────────────────────── */

/// 把文件放进剪贴板（CF_HDROP），供用户在**聊天窗口**直接 Ctrl+V（FR-10 ①）。
///
/// 主用场景是 [`crate::capture`] 刚生成的长图 PNG（分段时是多张，一次全放进去）。
/// 微信 / 企业微信 / 钉钉的聊天输入框都接受文件粘贴，图片文件会以图片形式发出——
/// 这是「排版不糊地发进群」唯一可靠的路径（事实库 #6）。
///
/// 【为什么是 CF_HDROP 而不是 CF_DIB】clipboard-manager 的 `write_image` 要的是
/// 解好的 RGBA（`tauri::image::Image`），而 `Image::from_bytes` 被 tauri 的
/// `image-png` feature 门着，当前 Cargo.toml 没开；开它等于引入 PNG 解码依赖，
/// 属红线 12 要先问人的范畴。CF_HDROP 用已声明的系统 API 就能做到，
/// 且额外白送「粘贴到资源管理器 = 拷贝文件」这一个行为。
#[tauri::command]
pub async fn copy_file_to_clipboard(paths: Vec<PathBuf>) -> AppResult<FileClipboardResult> {
    tauri::async_runtime::spawn_blocking(move || write_files(&paths))
        .await
        .map_err(|error| {
            AppError::native(format!("copy_file_to_clipboard 线程池调度失败：{error}"))
        })?
}

fn write_files(paths: &[PathBuf]) -> AppResult<FileClipboardResult> {
    if paths.is_empty() {
        return Err(AppError::config("copy_file_to_clipboard：路径列表为空"));
    }
    for path in paths {
        if !path.is_file() {
            return Err(AppError::not_found(path.display().to_string()));
        }
    }

    hdrop::set_clipboard_files(paths)?;
    tracing::info!(
        file_count = paths.len() as u64,
        "已写入 CF_HDROP 文件列表到剪贴板"
    );

    Ok(FileClipboardResult {
        file_count: paths.len() as u32,
    })
}

/* ── 本地图片内联 ───────────────────────────────────────────── */

struct InlineOutcome {
    html: String,
    inlined: u32,
    skipped: u32,
}

/// 把 `html` 里的每个占位 token 换成 data URI（或降级地址）。
///
/// 纯字符串替换，**不解析 HTML**：token 由前端生成、形如 `mdnaonao-asset://0`，
/// 在文档中只出现在 `img[src]` 里，整串相等替换不存在误伤正文的可能。
/// 同一张图在文中出现多次时前端已经复用同一个 token，因此这里只读一次盘。
fn inline_assets(html: &str, assets: &[RichTextAsset]) -> InlineOutcome {
    if assets.is_empty() {
        return InlineOutcome {
            html: html.to_string(),
            inlined: 0,
            skipped: 0,
        };
    }

    let mut out = html.to_string();
    let mut budget = INLINE_IMAGE_BUDGET_BYTES;
    let mut inlined = 0_u32;
    let mut skipped = 0_u32;

    for asset in assets {
        match read_inlineable(&asset.path, budget) {
            Ok((bytes, mime)) => {
                budget = budget.saturating_sub(bytes.len() as u64);
                let uri = format!("data:{};base64,{}", mime, base64_encode(&bytes));
                out = out.replace(&asset.token, &uri);
                inlined += 1;
            }
            Err(reason) => {
                // 读不出/太大都不是致命错误：换成 about:invalid，收件端显示 alt 文本，
                // 数量回传给前端如实提示。悄悄少图才是真正的失败。
                tracing::warn!(
                    path = %asset.path.display(),
                    reason = %reason,
                    "富文本内联跳过一张本地图片"
                );
                out = out.replace(&asset.token, IMAGE_UNAVAILABLE_URI);
                skipped += 1;
            }
        }
    }

    InlineOutcome {
        html: out,
        inlined,
        skipped,
    }
}

/// 读一张图并给出 MIME；超过单图上限或剩余预算时直接拒绝（先看元数据，不读进内存）。
fn read_inlineable(path: &Path, budget: u64) -> Result<(Vec<u8>, &'static str), String> {
    let size = std::fs::metadata(path)
        .map_err(|error| format!("读取元数据失败：{error}"))?
        .len();
    if size > MAX_INLINE_IMAGE_BYTES {
        return Err(format!(
            "{size} 字节超过单图上限 {MAX_INLINE_IMAGE_BYTES} 字节"
        ));
    }
    if size > budget {
        return Err(format!("{size} 字节超过剩余内联预算 {budget} 字节"));
    }
    let bytes = std::fs::read(path).map_err(|error| format!("读取失败：{error}"))?;
    Ok((bytes, mime_for_path(path)))
}

/// 按扩展名给 MIME。认不出就交给 `application/octet-stream`——
/// 浏览器与编辑器都能从 data URI 的字节自行嗅探，给个错的 image/* 反而更糟。
fn mime_for_path(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// 标准 base64（RFC 4648，带 `=` 补位）。
///
/// 自己写而不是引 `base64` crate：新增运行时依赖需要先向人类申请（红线 12）。
/// `export_html.rs` 里有一份同名同义的实现，两处刻意不互相 `pub use`——
/// 让 share 模块保持零跨模块耦合，将来任一侧改体积策略都不会波及另一侧。
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
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

/* ── CF_HDROP（Win32 剪贴板文件列表） ───────────────────────── */

#[cfg(windows)]
mod hdrop {
    //! 把一组绝对路径写成 `CF_HDROP`（= 资源管理器「复制文件」时放的那份格式）。
    //!
    //! 【为什么是手写 `extern "system"` 而不是 `windows` crate】
    //! 本项目已依赖 `windows` 0.61.3，其中确有
    //! `Win32::System::DataExchange::{OpenClipboard, EmptyClipboard, SetClipboardData,
    //! CloseClipboard}`、`Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock}`、
    //! `Win32::UI::Shell::DROPFILES`、`Win32::System::Ole::CF_HDROP`（已逐个核对到行号），
    //! 但它们分属四个尚未启用的 feature（`Win32_System_DataExchange` /
    //! `Win32_System_Memory` / `Win32_UI_Shell` / `Win32_System_Ole`），
    //! 而 `Cargo.toml` 不在本批次的改动范围内（跨文件改动交主控接线）。
    //! 这七个 API 的签名三十年未变，手写声明是这一批次里唯一不欠债的做法；
    //! 主控若愿意开那四个 feature，本模块可原样换成 crate 版本（见交付说明）。
    //!
    //! 【所有权约定，写错就是句柄泄漏或二次释放】
    //! `SetClipboardData` **成功后系统接管** HGLOBAL，调用方绝不能再 `GlobalFree`；
    //! 失败（含中途任何一步失败）则必须由我们释放。下面每条分支都显式走了一遍。

    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;

    use crate::error::{AppError, AppResult};

    /// `CF_HDROP`（windows crate 里是 `Win32::System::Ole::CF_HDROP = CLIPBOARD_FORMAT(15u16)`）
    const CF_HDROP: u32 = 15;
    /// `GMEM_MOVEABLE`（`Win32::System::Memory::GMEM_MOVEABLE = GLOBAL_ALLOC_FLAGS(2u32)`）；
    /// 剪贴板要求可移动内存，传 GMEM_FIXED 在部分收件端会失败。
    const GMEM_MOVEABLE: u32 = 0x0002;

    /// `OpenClipboard` 抢锁重试：剪贴板是全局互斥资源，别的程序（尤其输入法、
    /// 剪贴板管理器）刚好持有时会失败。不重试的话用户看到的就是「偶尔点了没反应」。
    const OPEN_RETRY: u32 = 10;
    const OPEN_RETRY_INTERVAL_MS: u64 = 30;

    #[allow(non_snake_case)]
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(new_owner: *mut c_void) -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, mem: *mut c_void) -> *mut c_void;
        fn CloseClipboard() -> i32;
    }

    #[allow(non_snake_case)]
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
        fn GlobalLock(mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(mem: *mut c_void) -> i32;
        fn GlobalFree(mem: *mut c_void) -> *mut c_void;
    }

    /// `DROPFILES`（Win32 `shlobj_core.h`；windows crate 的
    /// `Win32::UI::Shell::DROPFILES` 与此逐字段等价）。
    ///
    /// 全部字段都是 4 字节对齐的 32 位量，故 `repr(C)` 的布局与官方的
    /// `repr(C, packed(1))` 完全一致（20 字节），不必用 packed——
    /// packed 结构取字段引用是 UB，能不用就不用。
    ///
    /// `allow(dead_code)`：这些字段只被**写**给系统看，Rust 侧永远不会读回来，
    /// 不豁免的话 `-D warnings` 会因「field is never read」直接判失败。
    #[allow(dead_code)]
    #[repr(C)]
    struct DropFiles {
        /// 文件名列表相对结构体起点的偏移（= 本结构体大小）
        p_files: u32,
        /// 拖放点（剪贴板场景无意义，填 0）
        pt_x: i32,
        pt_y: i32,
        /// 是否落在非客户区（填 0）
        f_nc: i32,
        /// 文件名是否为宽字符（我们只写 UTF-16，恒为 1）
        f_wide: i32,
    }

    /// 把 `paths` 写进剪贴板的 CF_HDROP 槽位。调用前调用方已确保每个路径都存在。
    pub fn set_clipboard_files(paths: &[PathBuf]) -> AppResult<()> {
        // 双 NUL 结尾的宽字符列表："a\0b\0\0"
        let mut list: Vec<u16> = Vec::new();
        for path in paths {
            for unit in path.as_os_str().encode_wide() {
                if unit == 0 {
                    return Err(AppError::config(format!(
                        "路径含 NUL 字符，无法写入剪贴板：{}",
                        path.display()
                    )));
                }
                list.push(unit);
            }
            list.push(0);
        }
        list.push(0);

        let header_size = std::mem::size_of::<DropFiles>();
        // UTF-16 列表按 2 字节/单元算；溢出即视为「路径列表长得离谱」，直接拒绝而不是绕回小数值
        let total = header_size
            .checked_add(list.len().saturating_mul(2))
            .ok_or_else(|| AppError::config("路径列表过长，无法写入剪贴板"))?;

        // SAFETY: 下面每一处裸指针都在同一次分配的 [0, total) 内；
        // handle 的所有权在 SetClipboardData 成功那一刻转移给系统，其余分支均自行释放。
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, total);
            if handle.is_null() {
                return Err(AppError::native(
                    "GlobalAlloc 失败：无法为 CF_HDROP 分配内存",
                ));
            }

            let locked = GlobalLock(handle);
            if locked.is_null() {
                GlobalFree(handle);
                return Err(AppError::native("GlobalLock 失败：CF_HDROP 内存不可写"));
            }
            std::ptr::write(
                locked.cast::<DropFiles>(),
                DropFiles {
                    p_files: header_size as u32,
                    pt_x: 0,
                    pt_y: 0,
                    f_nc: 0,
                    f_wide: 1,
                },
            );
            // header_size = 20，GlobalAlloc 的返回值至少 8 字节对齐 ⇒ 该偏移满足 u16 的对齐要求
            std::ptr::copy_nonoverlapping(
                list.as_ptr(),
                locked.cast::<u8>().add(header_size).cast::<u16>(),
                list.len(),
            );
            // 返回值刻意不判：锁计数归零时 GlobalUnlock 返回 0 且 GetLastError 为
            // NO_ERROR，把它当失败处理是经典误报。
            GlobalUnlock(handle);

            if !open_clipboard_with_retry() {
                GlobalFree(handle);
                return Err(AppError::native("OpenClipboard 失败：剪贴板被其他程序占用"));
            }

            if EmptyClipboard() == 0 {
                CloseClipboard();
                GlobalFree(handle);
                return Err(AppError::native("EmptyClipboard 失败"));
            }

            let placed = SetClipboardData(CF_HDROP, handle);
            // 无论成败都要还锁：不关剪贴板会让整个系统的复制粘贴卡住
            CloseClipboard();

            if placed.is_null() {
                GlobalFree(handle);
                return Err(AppError::native("SetClipboardData(CF_HDROP) 失败"));
            }
            // 成功：handle 已归系统所有，此处**不得** GlobalFree
        }
        Ok(())
    }

    /// SAFETY: 仅在 `set_clipboard_files` 的 unsafe 块内调用；成功返回 true 时
    /// 调用方有义务配对调用 `CloseClipboard`。
    ///
    /// 【owner 传 NULL 是否安全】MSDN 在 `EmptyClipboard` 页上有一句"NULL owner 会让
    /// SetClipboardData 失败"，那句话只适用于**延迟渲染**（`SetClipboardData(fmt, NULL)`）。
    /// 我们传的是真实句柄，属立即渲染。佐证：本应用已在用的 clipboard-manager →
    /// arboard → clipboard-win 5.4.1 走的正是同一条 NULL-owner 路径
    /// （`raw.rs` 的 `open_for` / `set_file_list_inner`），而它的 write_text/write_html
    /// 在本机是通的。
    unsafe fn open_clipboard_with_retry() -> bool {
        for attempt in 0..OPEN_RETRY {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                return true;
            }
            if attempt + 1 < OPEN_RETRY {
                std::thread::sleep(std::time::Duration::from_millis(OPEN_RETRY_INTERVAL_MS));
            }
        }
        false
    }
}

#[cfg(not(windows))]
mod hdrop {
    use std::path::PathBuf;

    use crate::error::{AppError, AppResult};

    /// 本产品仅面向 Windows（DG 2.2）；非 Windows 目标只为让 `cargo check` 过得去。
    pub fn set_clipboard_files(_paths: &[PathBuf]) -> AppResult<()> {
        Err(AppError::native("CF_HDROP 仅在 Windows 上可用"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ── base64（与 export_html.rs 同一组 RFC 4648 向量对拍） ── */

    #[test]
    fn encodes_base64_per_rfc4648() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
    }

    /* ── MIME ── */

    #[test]
    fn maps_common_image_extensions() {
        assert_eq!(mime_for_path(Path::new("a.PNG")), "image/png");
        assert_eq!(mime_for_path(Path::new("图 表.jpeg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("a.svg")), "image/svg+xml");
        // 认不出就交给收件端嗅探，不硬编一个可能是错的 image/*
        assert_eq!(
            mime_for_path(Path::new("a.unknown")),
            "application/octet-stream"
        );
        assert_eq!(
            mime_for_path(Path::new("noext")),
            "application/octet-stream"
        );
    }

    /* ── 占位 token 替换 ── */

    #[test]
    fn returns_html_untouched_when_no_assets() {
        let outcome = inline_assets("<p>hi</p>", &[]);
        assert_eq!(outcome.html, "<p>hi</p>");
        assert_eq!(outcome.inlined, 0);
        assert_eq!(outcome.skipped, 0);
    }

    /// 读不出的图必须降级成 about:invalid 并计入 skipped，
    /// **绝不能**把本机绝对路径留在交给别人的 HTML 里。
    #[test]
    fn degrades_unreadable_asset_without_leaking_path() {
        let html = r#"<img src="mdnaonao-asset://0" alt="图">"#;
        let outcome = inline_assets(
            html,
            &[RichTextAsset {
                token: "mdnaonao-asset://0".to_string(),
                path: PathBuf::from(r"D:\这个目录\一定\不存在.png"),
            }],
        );
        assert_eq!(outcome.inlined, 0);
        assert_eq!(outcome.skipped, 1);
        assert!(outcome.html.contains(IMAGE_UNAVAILABLE_URI));
        assert!(!outcome.html.contains("mdnaonao-asset://0"));
        assert!(!outcome.html.contains("不存在.png"));
    }

    /// 真实文件走内联分支：token 消失、data URI 出现、计数正确。
    #[test]
    fn inlines_real_file_as_data_uri() {
        let mut path = std::env::temp_dir();
        path.push(format!("mdnaonao-share-{}.png", std::process::id()));
        std::fs::write(&path, b"foobar").expect("写临时文件");

        let outcome = inline_assets(
            r#"<img src="mdnaonao-asset://0"><img src="mdnaonao-asset://0">"#,
            &[RichTextAsset {
                token: "mdnaonao-asset://0".to_string(),
                path: path.clone(),
            }],
        );
        let _ = std::fs::remove_file(&path);

        assert_eq!(outcome.inlined, 1);
        assert_eq!(outcome.skipped, 0);
        // 同一 token 的多处引用一次替换全覆盖（前端已做去重，后端只读一次盘）
        assert_eq!(
            outcome
                .html
                .matches("data:image/png;base64,Zm9vYmFy")
                .count(),
            2
        );
    }

    /// 单图超限时不读进内存就拒绝（用元数据判），并给出可读原因。
    #[test]
    fn rejects_oversized_image_by_metadata() {
        let mut path = std::env::temp_dir();
        path.push(format!("mdnaonao-share-big-{}.png", std::process::id()));
        std::fs::write(&path, vec![0_u8; 64]).expect("写临时文件");

        // 把剩余预算压到 8 字节：64 字节的文件必须被预算闸门挡下
        let err = read_inlineable(&path, 8).expect_err("超预算应拒绝");
        let _ = std::fs::remove_file(&path);
        assert!(err.contains("剩余内联预算"));
    }

    /* ── 契约 ── */

    /// ShareTarget 的 wire 值是前后端契约（前端 ShareDialog 直接写这三个字面量）。
    #[test]
    fn serializes_share_target_as_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ShareTarget::WechatMp).expect("序列化"),
            "\"wechat-mp\""
        );
        assert_eq!(
            serde_json::to_string(&ShareTarget::DingTalk).expect("序列化"),
            "\"ding-talk\""
        );
        assert_eq!(ShareTarget::Lark.as_str(), "lark");
    }

    /// assets 缺省可省略（老前端 / 无图文档不必传空数组）。
    #[test]
    fn accepts_payload_without_assets_field() {
        let payload: RichTextPayload =
            serde_json::from_str(r#"{"html":"<p>x</p>","plainText":"x","target":"wechat-mp"}"#)
                .expect("assets 应可缺省");
        assert!(payload.assets.is_empty());
        assert_eq!(payload.target, ShareTarget::WechatMp);
    }

    /// 空路径列表必须当场拒绝，而不是去开一次剪贴板再失败。
    #[test]
    fn rejects_empty_file_list() {
        assert!(write_files(&[]).is_err());
    }
}
