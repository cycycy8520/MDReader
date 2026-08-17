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
 * 当前为 M0 骨架：Rust 侧命令体一律返回 AppError::NotImplemented，
 * 前端调用会 reject，属预期行为（实现随 M1 各任务落地）。
 */

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type {
  DefaultAppStatus,
  DocumentPayload,
  ExportHtmlMode,
  ExportPdfOptions,
  ExportResult,
  RecentFile,
  ScrollAnchor,
  Settings,
} from "../types";

/** 前端 → 后端事件名（DG 7.2 数据流 4：打印模板渲染完成信号） */
export const EVENT_PRINT_READY = "PRINT_READY";
/** 后端 → 前端事件名（FR-06 file watch / FR-12 单实例路由） */
export const EVENT_FILE_CHANGED = "file-changed";
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

/** 在资源管理器中定位文件（FR-03 右键菜单）。→ Rust: files::reveal_in_explorer(path) */
export async function revealInExplorer(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path });
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

/**
 * 导出 HTML（FR-07）：单文件内联 base64 / HTML + 资源目录两种模式。
 * → Rust: export::export_html(app, source, output, mode)
 */
export async function exportHtml(
  source: string,
  output: string,
  mode: ExportHtmlMode,
): Promise<ExportResult> {
  return invoke<ExportResult>("export_html", { source, output, mode });
}

/**
 * 导出 PDF（FR-08）：主路线 PrintToPdf COM 桥接，失败自动走 CDP 兜底（DG 8）。
 * 调用前需保证打印模板已 emit PRINT_READY。
 * → Rust: export::export_pdf(app, options)
 */
export async function exportPdf(
  options: ExportPdfOptions,
): Promise<ExportResult> {
  return invoke<ExportResult>("export_pdf", { options });
}

/** 打印（FR-17，Ctrl+P，复用 PDF 打印模板）。→ Rust: export::print_document(app) */
export async function printDocument(): Promise<void> {
  return invoke<void>("print_document");
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

/* ── 设置（M1：settings.rs，DG 7.3） ────────────────────────── */

/** → Rust: settings::load_settings() */
export async function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

/** → Rust: settings::save_settings(settings) */
export async function saveSettings(settings: Settings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

/* ── 尚未就绪的能力（不要调用，会因命令不存在而 reject） ────── */

/**
 * 「打开文件」对话框（Ctrl+O，FR-13 之外的显式入口）。
 *
 * 【阻塞】Tauri 2 的文件对话框需要 tauri-plugin-dialog，属新增运行时依赖，
 * 按 AI_DEV_GUIDE 红线 12 必须先经人类批准，故 Rust 侧当前没有对应 command。
 * M1 实现前请先申请该依赖；在此之前本函数直接抛错，避免调用一个不存在的命令。
 */
export async function openFileDialog(): Promise<string | null> {
  throw new Error(
    "openFileDialog 未就绪：需先引入 tauri-plugin-dialog（红线 12：新增运行时依赖需人类批准）",
  );
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

/** 订阅后端推送的文件变更事件（FR-06）。 */
export async function onFileChanged(
  handler: (path: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(EVENT_FILE_CHANGED, (event) => {
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
