/**
 * IPC 服务层 —— 对应 DG 7.1「服务层: ipc.ts —— 统一封装 invoke() 调用，杜绝散落调用」。
 *
 * 纪律（AI_DEV_GUIDE 第 5 节）：
 *   - 组件禁止直接 import @tauri-apps/api，ESLint 的 no-restricted-imports 已强制；
 *     本文件是唯一豁免点。
 *   - 每个 Rust command 一个类型化函数；Rust 侧统一返回 Result<T, AppError>，
 *     Err 会以 reject 形式抛出，调用方按需 try/catch。
 *
 * 【契约纪律】本文件的 command 名与参数名必须与 src-tauri/src/*.rs 的
 * #[tauri::command] 签名逐字一致（Rust 侧为准，因为它已注册进 main.rs 的
 * generate_handler!）。改任何一侧都要同步改另一侧，否则运行期才会暴露。
 * Rust struct 统一 #[serde(rename_all = "camelCase")]，故 TS 侧直接用 camelCase。
 *
 * 实现进度（2026-08-18）：files.rs（读文件/监听/最近列表/资源管理器定位）与
 * settings.rs（读写配置）已实装；export.rs 的 export_pdf 主路线（PrintToPdf COM 桥接）
 * 已在 M0-① 打通，export_html / print_document 与「打印专用隐藏窗口」由 M2 批次实装中；
 * shell_integ 的部分命令、settings 的飞书凭据位仍返回 AppError::NotImplemented，
 * 调用会 reject，属预期行为（前端一律 try/catch 并转成面向用户的提示，不留白屏）。
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Image } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

import type {
  ClipboardImage,
  FileClipboardResult,
  LongImageRequest,
  LongImageResult,
} from "../components/ShareDialog";
import type { EditorApp } from "../components/contextMenuItems";
import type { RichTextPayload, RichTextResult } from "../components/shareRichText";
import type { HtmlExportPayload } from "../render/htmlExport";
import type {
  DefaultAppStatus,
  DocumentPayload,
  ImportOutcome,
  ImportRequest,
  LarkCredential,
  LarkCredentialStatus,
  LarkImportResult,
  Vault,
  ExportHtmlMode,
  ExportPdfOptions,
  ExportResult,
  HeadlessJob,
  HeadlessResult,
  HtmlExportConflict,
  HtmlExportResult,
  DirChildren,
  RecentFile,
  ScrollAnchor,
  Settings,
} from "../types";

/** 前端 → 后端事件名（DG 7.2 数据流 4：打印模板渲染完成信号） */
export const EVENT_PRINT_READY = "PRINT_READY";
/** 前端 → 后端（`--action to-html` 的隐藏渲染窗口回报成败，Rust export.rs 同名常量） */
export const EVENT_HEADLESS_EXPORT_DONE = "HEADLESS_EXPORT_DONE";
/** 后端 → 前端（无 UI 动作在**应用已开着**时完成，Rust cmdline.rs 同名常量） */
export const EVENT_HEADLESS_RESULT = "headless-result";
/** 后端 → 前端事件名（FR-06 file watch / FR-12 单实例路由） */
export const EVENT_FILE_CHANGED = "file-changed";
/** 监听中的文件被删除/改名（Rust files.rs 同名常量，两侧不得各改各的） */
export const EVENT_FILE_REMOVED = "file-removed";
/** 已挂载文件夹内结构变化（F20；Rust dirtree.rs 同名常量），payload = 受影响父目录数组 */
export const EVENT_DIR_TREE_CHANGED = "dir-tree-changed";
export const EVENT_OPEN_PATH = "open-path";

/* ── 文件（M1：files.rs） ─────────────────────────────────────── */

/**
 * 读取并解码 Markdown：UTF-8 优先 → 去 BOM → 失败按 GBK 兜底（DG 8「编码」）。
 * 返回体含 isLarge，前端据此走 FR-01 的渲染分档。
 * → Rust: files::read_markdown(path)
 */
export async function readMarkdown(path: string): Promise<DocumentPayload> {
  return invoke<DocumentPayload>("read_markdown", { path });
}

/**
 * 开始监听当前文件变更（FR-06，防抖 300ms 在 Rust 侧完成）。
 * 变更经 EVENT_FILE_CHANGED 推送；AppHandle 由 Tauri 注入，前端只传 path。
 * → Rust: files::watch_file(app, path)
 */
export async function watchFile(path: string): Promise<void> {
  return invoke<void>("watch_file", { path });
}

/** → Rust: files::unwatch_file(app) */
export async function unwatchFile(): Promise<void> {
  return invoke<void>("unwatch_file");
}

/* ── 文件夹树（F20：dirtree.rs） ──────────────────────────────── */

/**
 * 列出目录的**直接**子项（子目录 + 受支持的 Markdown 文件），懒加载配套——
 * 展开哪层才调哪层，绝不出现一口气扫全库的调用。排序在前端做
 * （`Intl.Collator('zh')` 拼音序只有前端给得出）。
 * → Rust: dirtree::list_dir_children(path)
 */
export async function listDirChildren(path: string): Promise<DirChildren> {
  return invoke<DirChildren>("list_dir_children", { path });
}

/**
 * 递归监听已挂载的文件夹（与 watchFile 的单文件监听是两套独立槽位）。
 * 变更防抖合并后经 EVENT_DIR_TREE_CHANGED 推送受影响父目录数组。
 * → Rust: dirtree::watch_dir(app, path)
 */
export async function watchDir(path: string): Promise<void> {
  return invoke<void>("watch_dir", { path });
}

/** → Rust: dirtree::unwatch_dir(app) */
export async function unwatchDir(): Promise<void> {
  return invoke<void>("unwatch_dir");
}

/** 在资源管理器中定位文件（FR-03 右键菜单）。→ Rust: files::reveal_in_explorer(path) */
export async function revealInExplorer(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path });
}

/**
 * 批量探测路径是否存在，返回**不存在**的那部分（最近列表失效条目灰显，FR-03）。
 *
 * 只回传失效子集而不是全量布尔表：200 条的列表里失效通常只有个位数，
 * 前端拿到的就是可以直接塞进 missingPaths 的东西。
 * → Rust: files::probe_paths(paths)
 */
export async function probePaths(paths: string[]): Promise<string[]> {
  return invoke<string[]>("probe_paths", { paths });
}

/**
 * 本地文件绝对路径 → WebView 可加载的 asset 协议 URL（DG 8「查看态本地图片」）。
 *
 * 不是 invoke，而是 Tauri 内置的 `convertFileSrc`：它把路径编码进
 * `http://asset.localhost/...`（Windows），中文与空格由内部 encodeURIComponent 处理。
 * 放在这里的唯一理由是纪律——渲染层（src/render/preview.ts）同样禁止直接 import
 * @tauri-apps/api，本文件是唯一豁免点。
 *
 * 注意：非 Tauri 环境（纯浏览器 dev / 单测）下 __TAURI_INTERNALS__ 不存在，本函数会抛错，
 * 调用方需自行 try/catch 降级。
 * 另外，能否真正加载还取决于 tauri.conf.json 的 security.assetProtocol.scope 是否放行该路径。
 */
export function toAssetUrl(path: string): string {
  return convertFileSrc(path);
}

/* ── 外部打开（tauri-plugin-opener，非自定义 command） ────────── */
/* 走官方插件而不是自己写 command：ShellExecute 的参数转义、UAC、UWP 应用调用
   都是插件已经处理过的坑。权限见 capabilities/default.json 的
   `opener:allow-open-url` / `opener:allow-open-path`。 */

/** openExternal 只放行的两种协议——其余（file:/javascript:/data: …）一律拒绝 */
const EXTERNAL_PROTOCOLS = ["http:", "https:"];

/**
 * 用**系统默认浏览器**打开外链（UPGRADE_PLAN 1.1：正文外链绝不导航走 WebView）。
 *
 * 这里再做一次协议白名单，是纵深防御的最后一环：调用方（链接委托）已经判过一次，
 * 但只要有一处漏判，file:/javascript: 就会被交给 ShellExecute 执行任意程序。
 * 非法 URL 直接抛错，由调用方按失败处理（不弹系统对话框、不静默吞掉）。
 */
export async function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`openExternal: malformed url ${url}`);
  }
  if (!EXTERNAL_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(`openExternal: blocked protocol ${parsed.protocol}`);
  }
  return openUrl(parsed.href);
}

/**
 * 用系统**默认程序**打开一个文件（导出完成 toast 的「打开文件」用它）。
 * 严格只读的边界不变：我们只是把文件交给外部程序，自己不写一个字节。
 *
 * 注意别拿它做「用其他编辑器打开源文件」——见 [`openWithDialog`]。
 */
export async function openWithDefaultApp(path: string): Promise<void> {
  return openPath(path);
}

/**
 * 探测本机已安装的编辑器（顺序即菜单顺序，记事本兜底排最后）。
 *
 * 走注册表 `App Paths`（HKCU 优先——VS Code 的用户级安装只写在那儿），查不到再退回
 * 众所周知的安装位置，还查不到就是没装、不猜（与 msedge 探测同一条纪律，事实库 #4）。
 * → Rust: shell_integ::list_editors()
 */
export async function listEditors(): Promise<EditorApp[]> {
  return invoke<EditorApp[]>("list_editors");
}

/**
 * 用指定编辑器打开源文件。
 *
 * `editor` 只是前端缓存的 UI 值、**不是凭据**：后端会重新探测一遍做白名单比对，
 * 不在探测结果里的路径一律拒绝。否则这条命令就等于「以本应用身份执行任意程序」。
 * → Rust: shell_integ::open_in_editor(editor, path)
 */
export async function openInEditor(editor: string, path: string): Promise<void> {
  return invoke<void>("open_in_editor", { editor, path });
}

/**
 * 弹系统「打开方式」对话框（子菜单末项「其他程序…」）。
 *
 * **不能用 `openWithDefaultApp`**：那个打开的是**默认程序**，而一旦用户按我们的引导
 * 把 .md 关联给了本应用，点它就是打开自己——单实例把当前窗口拉到前台，
 * 屏幕上什么都没发生。用户报过一次「点击后根本没反应」，根因就是这个。
 * 「打开方式」把选择权交回用户，才是这个菜单项的语义。
 * → Rust: shell_integ::open_with_dialog(path)
 */
export async function openWithDialog(path: string): Promise<void> {
  return invoke<void>("open_with_dialog", { path });
}

/* ── 最近列表（M1：files.rs + recent.json，DG 7.3） ──────────── */
/* 注意：Rust 侧不做「整表写回」，而是细粒度增删改，每个命令回传最新全表。 */

/** 读取最近列表（上限 200，LRU）。→ Rust: files::list_recent() */
export async function listRecent(): Promise<RecentFile[]> {
  return invoke<RecentFile[]>("list_recent");
}

/**
 * 打开文件后登记/提升该条目（LRU），回传更新后的全表。
 * → Rust: files::touch_recent(entry)
 */
export async function touchRecent(entry: RecentFile): Promise<RecentFile[]> {
  return invoke<RecentFile[]>("touch_recent", { entry });
}

/** 从列表移除（不删文件，FR-03）。→ Rust: files::remove_recent(path) */
export async function removeRecent(path: string): Promise<RecentFile[]> {
  return invoke<RecentFile[]>("remove_recent", { path });
}

/** 置顶/取消置顶（FR-03）。→ Rust: files::set_recent_pinned(path, pinned) */
export async function setRecentPinned(
  path: string,
  pinned: boolean,
): Promise<RecentFile[]> {
  return invoke<RecentFile[]>("set_recent_pinned", { path, pinned });
}

/** 记录滚动位置（FR-16）。→ Rust: files::set_scroll_anchor(path, anchor) */
export async function setScrollAnchor(
  path: string,
  anchor: ScrollAnchor | null,
): Promise<void> {
  return invoke<void>("set_scroll_anchor", { path, anchor });
}

/* ── 导出（M1/v1.0：export.rs） ──────────────────────────────── */

/** `export_html` 目标已被占用时，Rust 错误 message 的稳定前缀（前端据此弹覆盖确认） */
export const ERR_EXPORT_TARGET_EXISTS = "EXPORT_TARGET_EXISTS";
/** 单文件模式产物超 50MB 时的稳定前缀 */
export const ERR_EXPORT_TOO_LARGE = "EXPORT_TOO_LARGE";

/**
 * 导出 HTML（FR-07）：单文件内联 base64 / HTML + 资源目录两种模式。
 *
 * `payload` 是**前端渲染好的自包含文档 + 本地图片清单**（见 render/htmlExport.ts 的
 * buildHtmlExport），不是 Markdown 原文——后端只做路径重写与落盘，零 HTML 解析。
 * 传原文没有意义：那会逼后端再实现一遍渲染管线，「预览 = 导出」当场破功。
 *
 * `overwrite=false` 时目标已存在会 reject，message 以 [`ERR_EXPORT_TARGET_EXISTS`] 开头；
 * 体积超限的前缀是 [`ERR_EXPORT_TOO_LARGE`]。
 * → Rust: export_html::export_html(payload, output, mode, overwrite)
 */
export async function exportHtml(
  payload: HtmlExportPayload,
  output: string,
  mode: ExportHtmlMode,
  overwrite = false,
): Promise<HtmlExportResult> {
  return invoke<HtmlExportResult>("export_html", { payload, output, mode, overwrite });
}

/**
 * 导出前探测落点是否已被占用（.html 本体 + 资源目录各一条）。
 * → Rust: export_html::export_html_conflict(output, mode)
 */
export async function exportHtmlConflict(
  output: string,
  mode: ExportHtmlMode,
): Promise<HtmlExportConflict> {
  return invoke<HtmlExportConflict>("export_html_conflict", { output, mode });
}

/**
 * 导出 PDF（FR-08）：主路线 PrintToPdf COM 桥接，失败自动走 CDP 兜底（DG 8）。
 *
 * `source` 是**文档 .md 的绝对路径**，不是 Markdown 正文：后端据此建一扇隐藏打印
 * 窗口，由它自己读原文、渲染、发 PRINT_READY，然后才轮到 COM 侧开印。
 * → Rust: export::export_pdf(app, source, options)
 */
export async function exportPdf(
  source: string,
  options: ExportPdfOptions,
): Promise<ExportResult> {
  return invoke<ExportResult>("export_pdf", { source, options });
}

/**
 * 打印（FR-17，Ctrl+P）：复用与 PDF 同一扇隐藏窗口和同一份模板，最后弹系统打印对话框。
 * → Rust: export::print_document(app, source)
 */
export async function printDocument(source: string): Promise<void> {
  return invoke<void>("print_document", { source });
}

/* ── 分享（M3：share/mod.rs、capture.rs、share/lark.rs） ───── */

/**
 * 复制富文本到剪贴板（CF_HTML + CF_UNICODETEXT）。
 *
 * `payload.html` 是**前端渲染并把样式逐元素内联过**的自包含 HTML（见 components/shareRichText.ts）——
 * 收件端（公众号/飞书文档/钉钉文档编辑器）不会带我们的 CSS，不内联就是一堆无样式文字。
 * 后端只做本地图片 token → data URI 的替换，零 HTML 解析。
 * → Rust: share::copy_rich_text(app, payload)
 */
export async function copyRichText(payload: RichTextPayload): Promise<RichTextResult> {
  return invoke<RichTextResult>("copy_rich_text", { payload });
}

/**
 * 把文件放进剪贴板（CF_HDROP），用户可直接 Ctrl+V 进聊天窗口。
 * 形参名是 **paths（复数）**：长图分段时会有多张，CF_HDROP 天然支持多文件。
 * → Rust: share::copy_file_to_clipboard(paths)
 */
export async function copyFileToClipboard(
  paths: readonly string[],
): Promise<FileClipboardResult> {
  return invoke<FileClipboardResult>("copy_file_to_clipboard", { paths: [...paths] });
}

/**
 * 生成长图（FR-10）。`options.output` 为 null 时不落盘，逐段 PNG 经 `pngBase64` 回传。
 * → Rust: capture::capture_long_image(app, options)
 */
export async function captureLongImage(
  options: LongImageRequest,
): Promise<LongImageResult> {
  return invoke<LongImageResult>("capture_long_image", { options });
}

/**
 * 把位图写进剪贴板。
 *
 * **必须传 RGBA，不能传 PNG 字节**：tauri 2.11.5 的 `JsImage::into_img` 只有
 * `Rgba{rgba,width,height}` 这一条分支不受 `image-png` feature 约束，而本项目没开该
 * feature（开它等于引入 image crate，触红线 12）。传 PNG 字节会在运行期报
 * "expected RGBA image data"。PNG → RGBA 的解码在前端用 canvas 做
 * （render/longImage.ts 的 decodePngToRgba）。
 */
export async function writeImageToClipboard(image: ClipboardImage): Promise<void> {
  return writeImage(await Image.new(image.rgba, image.width, image.height));
}

/** 长图「另存为…」的过滤器 */
export const PNG_SAVE_FILTERS: readonly SaveDialogFilter[] = [
  { name: "PNG", extensions: ["png"] },
];

/* ── 飞书（FR-11 进阶通道） ────────────────────────────────── */

/**
 * 保存飞书自建应用凭据。密钥经 DPAPI 加密后落盘，**任何路径都不会明文存**。
 * 这个值只往下走：状态查询永远只回打码后的 appId，绝不把 secret 读回界面。
 * → Rust: settings::save_lark_credential(credential)
 */
export async function saveLarkCredential(credential: LarkCredential): Promise<void> {
  return invoke<void>("save_lark_credential", { credential });
}

/** → Rust: settings::lark_credential_status() */
export async function larkCredentialStatus(): Promise<LarkCredentialStatus> {
  return invoke<LarkCredentialStatus>("lark_credential_status");
}

/** 解除绑定（删除凭据文件）。→ Rust: settings::clear_lark_credential() */
export async function clearLarkCredential(): Promise<void> {
  return invoke<void>("clear_lark_credential");
}

/**
 * 测试连接。**测的是已保存的凭据，不是输入框里的草稿**——所以 UI 上必须先保存再测试。
 * → Rust: share::lark::test_lark_connection()
 */
export async function testLarkConnection(): Promise<void> {
  return invoke<void>("test_lark_connection");
}

/** 导入到飞书云文档。→ Rust: share::lark::import_to_lark(path) */
export async function importToLark(path: string): Promise<LarkImportResult> {
  return invoke<LarkImportResult>("import_to_lark", { path });
}

/* ── 在浏览器中打开（右键菜单「打开方式」组） ──────────────── */

/**
 * 取「在浏览器中打开」的临时落点（`%TEMP%\MDNaonao\browser-preview\` 下）。
 *
 * 文件名 = 清洗后的源文件名 + 源路径哈希：前半给人看（地址栏能认出是哪篇），
 * 后半区分同名文档——两个目录下的 README.md 若共用一个 README.html，
 * 用户在两个标签页里刷新就会看到另一篇的内容。命名是纯函数，
 * 同一篇反复预览恒定落到同一文件，浏览器刷新即更新。
 * → Rust: shell_integ::browser_preview_path(source)
 */
export async function browserPreviewPath(source: string | null): Promise<string> {
  return invoke<string>("browser_preview_path", { source });
}

/**
 * 把一份 .html/.htm 产物交给系统默认程序打开。
 *
 * 刻意**不**走 `openExternal`（只放行 http(s)，放宽它等于把「渲染层被注入 →
 * 执行任意程序」这条路打开），也不走 opener 插件的 JS `openPath`（它的 scope
 * 是渲染层可达的攻击面）。后端命令自带扩展名白名单，比 ACL 更窄。
 * → Rust: shell_integ::open_in_browser(path)
 */
export async function openInBrowser(path: string): Promise<void> {
  return invoke<void>("open_in_browser", { path });
}

/* ── Obsidian 导入（FR-09） ────────────────────────────────── */

/**
 * 枚举 Obsidian Vault（只读 obsidian.json）。
 * **未安装 Obsidian 返回空数组而不是报错**——那不是故障，是一种正常状态，
 * UI 据此显示引导而不是错误页。
 * → Rust: obsidian::list_vaults()
 */
export async function listVaults(): Promise<Vault[]> {
  return invoke<Vault[]>("list_vaults");
}

/**
 * 把文档拷贝进 Vault（连同正文引用的本地图片）。**全程只读源文件。**
 * `conflict` 无默认值，必须显式传。
 * → Rust: obsidian::import_to_vault(request)
 */
export async function importToVault(request: ImportRequest): Promise<ImportOutcome> {
  return invoke<ImportOutcome>("import_to_vault", { request });
}

/** 用 obsidian:// URI 唤起 Obsidian 并定位到刚导入的笔记。→ Rust: obsidian::open_in_obsidian(uri) */
export async function openInObsidian(uri: string): Promise<void> {
  return invoke<void>("open_in_obsidian", { uri });
}

/** 「另存为…」对话框的扩展名过滤项（技术值，不是文案：name 显示在系统对话框的类型下拉里） */
export interface SaveDialogFilter {
  readonly name: string;
  /** 不带点的扩展名，如 ["html", "htm"] */
  readonly extensions: readonly string[];
}

/** 导出对话框「另存为…」用的两组过滤器（与导出格式一一对应，集中一处免得两地漂移） */
export const HTML_SAVE_FILTERS: readonly SaveDialogFilter[] = [
  { name: "HTML", extensions: ["html", "htm"] },
];
export const PDF_SAVE_FILTERS: readonly SaveDialogFilter[] = [
  { name: "PDF", extensions: ["pdf"] },
];

/**
 * 「另存为…」对话框（导出对话框里改输出路径用）。用户取消返回 null。
 *
 * 【权限】走官方 tauri-plugin-dialog 的 `save`，需要 capabilities 里的 **`dialog:allow-save`**——
 * 当前 default.json 只放行了 `dialog:allow-open`，因此本函数在权限补上之前会 reject。
 * 调用方（ExportDialog）已按"失败不阻断"处理：另存为不可用时提示一行小字，
 * 默认路径（源文件同目录同名）照样能导出。
 *
 * 与「严格只读」的边界说明：save 对话框本身**不写任何文件**，它只回传用户选定的路径；
 * 真正落盘的是 export.rs 的导出命令，写的也只是用户显式要求生成的导出产物，
 * 从不触碰源文件——只读红线是"不改用户的 .md"，不是"永不产生新文件"。
 */
export async function saveFileDialog(
  defaultPath: string,
  filters: readonly SaveDialogFilter[],
): Promise<string | null> {
  const picked = await saveDialog({
    defaultPath,
    // 插件签名要可变数组，这里把只读契约拷贝一份过去（顺带隔离外部改动）
    filters: filters.map((filter) => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
  });
  return picked ?? null;
}

/* ── 默认程序引导（F2 首启引导，M1 P0） ─────────────────────── */

/**
 * 只读检测当前 .md 默认程序是谁（红线 2：UserChoice 只读，永不写入）。
 * → Rust: shell_integ::query_default_app()
 */
export async function queryDefaultApp(): Promise<DefaultAppStatus> {
  return invoke<DefaultAppStatus>("query_default_app");
}

/**
 * 跳转到系统「默认应用」设置页（ms-settings:defaultapps）。
 * Windows 10+ 的 UserChoice 禁止静默抢默认，只能引导用户手动选（DG 2.3-2）。
 * → Rust: shell_integ::open_default_apps_settings()
 */
export async function openDefaultAppsSettings(): Promise<void> {
  return invoke<void>("open_default_apps_settings");
}

/* ── 应用信息（「关于」对话框，UPGRADE_PLAN 附录 A 关于组） ──── */

/**
 * 应用自述信息（对应 Rust `settings::app_info()`）。
 *
 * 类型刻意留在本文件而不是 `types/index.ts`：它只服务「关于」对话框这一个消费者，
 * 且与 Rust 命令的返回体一一对应，放在 command 封装旁边最不容易漂移。
 */
export interface AppInfo {
  /** 与 tauri.conf.json 的 version 同源 */
  version: string;
  /** 便携模式（exe 同级存在 portable.marker）= true；安装模式 = false（F19） */
  portable: boolean;
  /** 数据根目录：便携版 `<exe目录>\data\`，安装版 `%APPDATA%\MDNaonao\` */
  dataDir: string;
  /**
   * 日志目录。Rust 侧不回传时，前端按 `dataDir\logs` 兜底
   * （与 src-tauri/src/logging.rs 的 `app_data_dir()/logs` 同一约定）。
   */
  logDir?: string;
}

/** → Rust: settings::app_info() */
export async function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/* ── 设置（M1：settings.rs，DG 7.3） ────────────────────────── */

/** → Rust: settings::load_settings() */
export async function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

/** → Rust: settings::save_settings(settings) */
export async function saveSettings(settings: Settings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

/* ── 打开文件（Ctrl+O / 空状态按钮） ───────────────────────── */

/**
 * 「打开文件」对话框（Ctrl+O）。用户取消返回 null。
 *
 * 走官方 tauri-plugin-dialog 而非自定义 command：对话框是插件内置能力。
 * 权限见 capabilities/default.json 的 `dialog:allow-open`——**只放行 open**，
 * save/message/ask/confirm 一律不给（save 属写盘能力，与严格只读冲突）。
 * 扩展名过滤与 bundle.fileAssociations 注册的五个后缀保持一致（DG 8）。
 */
export async function openFileDialog(): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Markdown", extensions: MARKDOWN_EXTENSIONS }],
  });
  return typeof picked === "string" ? picked : null;
}

/**
 * 选择要挂载的文件夹（F20）。同一个 dialog:allow-open 权限——open 命令
 * 不区分 directory 标志，权限面零扩张（DG 5.3.1 实现约束）。
 */
export async function openFolderDialog(): Promise<string | null> {
  const picked = await openDialog({ multiple: false, directory: true });
  return typeof picked === "string" ? picked : null;
}

/** 与 tauri.conf.json 的 bundle.fileAssociations.ext 保持一致（DG 8） */
export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "mkdn"];

/**
 * 取走冷启动待打开的文件路径（双击 .md 或命令行传参启动时）。
 *
 * 为什么不用事件：冷启动时 Rust 侧解析完命令行，前端还没挂载，
 * emit 出去无人接收且 Tauri 不重放事件。故后端暂存、前端挂载后主动取。
 * 取走即清空，返回 null 表示无参数启动（走空状态页）。
 * → Rust: cmdline::take_pending_open(app)
 */
export async function takePendingOpen(): Promise<string | null> {
  return invoke<string | null>("take_pending_open");
}

/* ── 窗口控制（DG 6.2 自绘标题栏三键） ─────────────────────── */
/* 走 @tauri-apps/api/window 而非自定义 command：这些是 Tauri 内置能力，
   对应权限见 capabilities/default.json 的 core:window:allow-*。 */

/** 最小化窗口 */
export async function windowMinimize(): Promise<void> {
  return getCurrentWindow().minimize();
}

/** 最大化 / 还原切换（顶栏空白区双击是 Tauri 内置行为，无需接管） */
export async function windowToggleMaximize(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

/** 关闭窗口 */
export async function windowClose(): Promise<void> {
  return getCurrentWindow().close();
}

/**
 * 设置窗口标题（UPGRADE_PLAN 3.3）：打开文档后带上文件名，
 * 让任务栏悬停预览与 Alt-Tab 能区分开多个窗口 —— 全都叫 "MDNaonao" 时没法认。
 * 关闭文档/出错时由调用方传回纯应用名。
 * 权限：capabilities 的 core:window:allow-set-title。
 */
export async function windowSetTitle(title: string): Promise<void> {
  return getCurrentWindow().setTitle(title);
}

/** 当前是否为最大化态（用于切换按钮图标：方框 ⇄ 双层方框） */
export async function windowIsMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

/** 订阅窗口尺寸变化，回调最大化状态；用于图标随窗口状态同步 */
export async function onWindowResized(
  handler: (maximized: boolean) => void,
): Promise<UnlistenFn> {
  const win = getCurrentWindow();
  return win.onResized(() => {
    void win.isMaximized().then(handler);
  });
}

/* ── 事件封装（同样禁止组件直接使用 @tauri-apps/api/event） ──── */

/**
 * 打印模板渲染完成（含 Mermaid/KaTeX/字体）后通知 Rust 侧开始 PrintToPdf。
 * 见 DG 7.2 数据流 4 与 DG 8「PDF 静默导出（主）」的三个注意点。
 */
export async function emitPrintReady(): Promise<void> {
  return emit(EVENT_PRINT_READY);
}

/**
 * `--action to-html` 的隐藏渲染窗口做完后回报成败。
 *
 * 失败也必须发：不发的话 Rust 只能等到 120s 超时，用户面对的是「右键转 HTML，
 * 长时间没反应，最后拿到一个超时错误」，真正的原因（比如图片读不出）就此丢失。
 */
export async function emitHeadlessExportDone(
  ok: boolean,
  message: string | null,
): Promise<void> {
  return emit(EVENT_HEADLESS_EXPORT_DONE, { ok, message });
}

/**
 * 取当前进程的无 UI 作业（隐藏渲染窗口据此知道渲染哪一篇）。
 * 非 `--action` 启动时返回 null。**不消费**，可重复调用。
 * → Rust: cmdline::headless_job()
 */
export async function headlessJob(): Promise<HeadlessJob | null> {
  return invoke<HeadlessJob | null>("headless_job");
}

/**
 * 订阅无 UI 动作完成事件。只在**应用已经开着**时才会收到：
 * 用户又点了一次右键动词，产物已经写好但界面上什么都没发生——那正是「点了没反应」的观感。
 */
export async function onHeadlessResult(
  handler: (result: HeadlessResult) => void,
): Promise<UnlistenFn> {
  return listen<HeadlessResult>(EVENT_HEADLESS_RESULT, (event) => {
    handler(event.payload);
  });
}

/** 订阅后端推送的文件变更事件（FR-06）。 */
export async function onFileChanged(
  handler: (path: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(EVENT_FILE_CHANGED, (event) => {
    handler(event.payload);
  });
}

/**
 * 订阅「监听中的文件已消失」事件（删除 / 改名 / 移动，FR-06）。
 * payload 与 file-changed 一样是文件绝对路径。约定：正文保留，只在顶栏挂警示条，
 * 文件恢复时后端会重新发 file-changed，由前端撤条（UPGRADE_PLAN 1.8）。
 */
export async function onFileRemoved(
  handler: (path: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(EVENT_FILE_REMOVED, (event) => {
    handler(event.payload);
  });
}

/**
 * 订阅「文件夹结构变化」事件（F20）。payload = 受影响父目录的绝对路径数组，
 * 前端只重列其中**已加载**的层——未展开过的层无所谓变没变，展开时自然会拉新。
 */
export async function onDirTreeChanged(
  handler: (dirs: string[]) => void,
): Promise<UnlistenFn> {
  return listen<string[]>(EVENT_DIR_TREE_CHANGED, (event) => {
    handler(event.payload);
  });
}

/** 订阅「打开路径」事件：单实例回调 / 文件关联双击 / --action 均汇聚到这里（FR-12）。 */
export async function onOpenPath(
  handler: (path: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(EVENT_OPEN_PATH, (event) => {
    handler(event.payload);
  });
}

/* ── 拖拽打开（FR-13） ──────────────────────────────────────── */
/* tauri.conf.json 的 dragDropEnabled = true：拖放由 WebView2 原生接管，
   HTML5 的 dragover/drop 事件不会派发到页面，必须走 Tauri 的 webview 事件才拿得到
   绝对路径。这里把官方的四态事件收敛成前端需要的三态。 */

export type DragDropPhase = "enter" | "over" | "drop" | "leave";

export interface DragDropPayload {
  phase: DragDropPhase;
  /** enter / drop 才有路径；over / leave 为空数组 */
  paths: string[];
}

/** 订阅窗口拖放事件（遮罩显隐 + 松手打开）。 */
export async function onDragDrop(
  handler: (payload: DragDropPayload) => void,
): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => {
    const data = event.payload;
    handler({
      phase: data.type,
      paths: data.type === "enter" || data.type === "drop" ? data.paths : [],
    });
  });
}
