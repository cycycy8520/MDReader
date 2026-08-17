// 发布构建不挂控制台窗口（debug 下保留，方便看 panic）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 二进制入口：Tauri `Builder` 链就在这里，插件注册顺序集中在一处以便审查。
//! 业务逻辑一律在 `mdnaonao_lib`（src/lib.rs 及其子模块）里，本文件不写业务。

fn main() {
    // 日志必须最先初始化：`--action` 是无 UI 路径，GUI 应用无法向控制台回写，
    // 出问题只能靠 %APPDATA%\MDNaonao\logs\ 复现场（DG 10-8）。
    // 初始化失败不阻塞启动，只是没有文件日志。
    let _log_guard = match mdnaonao_lib::logging::init() {
        Ok(guard) => Some(guard),
        Err(err) => {
            mdnaonao_lib::logging::fallback_report(&err);
            None
        }
    };

    tauri::Builder::default()
        // 顺序不可变：tauri-plugin-single-instance 必须最先注册。
        // 它内部即 CreateMutexW + WM_COPYDATA——只有抢在其它插件与窗口初始化之前
        // 拿到互斥体，第二个进程才能在「什么都还没做」的时候就把 argv/cwd 转发给
        // 主实例并立刻退出；晚注册会让第二实例先完成部分初始化（甚至闪一下窗口、
        // 重复读配置）才被拦下，破坏 DG 7.4 的单实例语义与 DG 3.2 的热启动 ≤1s 预算。
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            mdnaonao_lib::cmdline::handle_second_instance(app, argv, cwd);
        }))
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| mdnaonao_lib::run(app))
        .invoke_handler(tauri::generate_handler![
            // files（DG 7.1）
            mdnaonao_lib::files::read_markdown,
            mdnaonao_lib::files::list_recent,
            mdnaonao_lib::files::touch_recent,
            mdnaonao_lib::files::remove_recent,
            mdnaonao_lib::files::set_recent_pinned,
            mdnaonao_lib::files::set_scroll_anchor,
            mdnaonao_lib::files::reveal_in_explorer,
            mdnaonao_lib::files::watch_file,
            mdnaonao_lib::files::unwatch_file,
            // export
            mdnaonao_lib::export::export_html,
            mdnaonao_lib::export::export_pdf,
            mdnaonao_lib::export::print_document,
            // capture
            mdnaonao_lib::capture::capture_long_image,
            // share
            mdnaonao_lib::share::copy_rich_text,
            mdnaonao_lib::share::copy_file_to_clipboard,
            mdnaonao_lib::share::lark::import_to_lark,
            mdnaonao_lib::share::lark::test_lark_connection,
            // obsidian
            mdnaonao_lib::obsidian::list_vaults,
            mdnaonao_lib::obsidian::import_to_vault,
            mdnaonao_lib::obsidian::open_in_obsidian,
            // shell_integ（只读检测 + 额外右键动词）
            mdnaonao_lib::shell_integ::query_default_app,
            mdnaonao_lib::shell_integ::open_default_apps_settings,
            mdnaonao_lib::shell_integ::register_extra_verbs,
            mdnaonao_lib::shell_integ::unregister_extra_verbs,
            // settings
            mdnaonao_lib::settings::load_settings,
            mdnaonao_lib::settings::save_settings,
            mdnaonao_lib::settings::save_lark_credential,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
