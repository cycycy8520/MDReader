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
        // 以下插件之间彼此无序，只要都排在 single-instance 之后即可。
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // opener：外链交系统浏览器 / 源文件交系统「打开方式」（UPGRADE_PLAN 1.1、3.3）。
        // 前端经 src/services/ipc.ts 的 openExternal / openWithDefaultApp 调用官方 JS API，
        // 不再自写 command——ShellExecute 的参数转义、UAC、UWP 目标都是插件已趟过的坑。
        // 权限见 capabilities/default.json 的 opener:allow-open-url / allow-default-urls /
        // allow-open-path（后者带路径 scope，只放行 Markdown 五扩展名）。
        .plugin(tauri_plugin_opener::init())
        // 导航守卫：主窗口除应用自身 origin 外一律 deny（1.1 的纵深防御）。
        // 必须排在窗口创建之前注册——插件钩子在 webview 创建时被装上。
        .plugin(mdnaonao_lib::navigation_guard())
        // dialog：Ctrl+O「打开文件」的文件选择框（M1 主链路入口之一）。
        // 只在前端经 src/services/ipc.ts 的 openFileDialog 调用；权限见
        // capabilities/default.json 的 dialog:allow-open（只放行 open，不放行 save/message）。
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| mdnaonao_lib::run(app))
        // 注意：这里刻意**不**用 on_page_load 投递冷启动路径。
        // 实测 PageLoadEvent::Finished 早于 React 挂载完成、早于 listen() 注册，
        // emit 出去照样没人接（Tauri 不重放事件），反而把暂存值提前消费掉。
        // 冷启动统一走「前端挂载后主动拉取」：cmdline::take_pending_open。
        .invoke_handler(tauri::generate_handler![
            // files（DG 7.1）
            mdnaonao_lib::files::read_markdown,
            mdnaonao_lib::files::list_recent,
            mdnaonao_lib::files::touch_recent,
            mdnaonao_lib::files::remove_recent,
            mdnaonao_lib::files::set_recent_pinned,
            mdnaonao_lib::files::set_scroll_anchor,
            mdnaonao_lib::files::probe_paths,
            mdnaonao_lib::files::reveal_in_explorer,
            mdnaonao_lib::files::watch_file,
            mdnaonao_lib::files::unwatch_file,
            // dirtree（F20 文件夹模式）：单层懒加载枚举 + 目录递归监听。
            // 与 files 的单文件监听是两套独立槽位，互不替换。
            mdnaonao_lib::dirtree::list_dir_children,
            mdnaonao_lib::dirtree::watch_dir,
            mdnaonao_lib::dirtree::unwatch_dir,
            // export（PDF 与系统打印对话框；两者都经隐藏打印窗口渲染）
            mdnaonao_lib::export::export_pdf,
            mdnaonao_lib::export::print_document,
            // export_html（FR-07）：正文由前端渲染成 payload，后端只做路径重写与落盘。
            // 注意与 export 模块**不可并列同名命令** —— generate_handler! 用路径最后
            // 一段做命令名，两个 export_html 会生成重复的 match 分支，编译期即失败。
            mdnaonao_lib::export_html::export_html,
            mdnaonao_lib::export_html::export_html_conflict,
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
            // 「在浏览器中打开」两步：先取临时落点，导出后再交系统默认程序打开。
            // open_in_browser 自带 .html/.htm 扩展名白名单——那是这条链路上唯一的检查
            // （自家 command 不走 ACL，opener 的 Rust 自由函数也绕开插件 scope）。
            mdnaonao_lib::shell_integ::browser_preview_path,
            mdnaonao_lib::shell_integ::open_in_browser,
            // 「用其他编辑器打开源文件」：弹系统「打开方式」，而不是用默认程序打开
            // （默认程序很可能就是本应用，那样点了等于没反应）
            mdnaonao_lib::shell_integ::open_with_dialog,
            // 「用其他编辑器打开 ▸」：探测本机已装的编辑器并直接拉起。
            // open_in_editor 内部会重新探测一遍做白名单校验——前端递来的 exe 路径
            // 只是 UI 缓存不是凭据，原样执行就等于「以本应用身份运行任意程序」。
            mdnaonao_lib::shell_integ::list_editors,
            mdnaonao_lib::shell_integ::open_in_editor,
            mdnaonao_lib::shell_integ::register_extra_verbs,
            mdnaonao_lib::shell_integ::unregister_extra_verbs,
            // cmdline：前端挂载后取走冷启动待打开的文件（双击 .md / 命令行传参）
            mdnaonao_lib::cmdline::take_pending_open,
            // 无 UI 动作（--action）的作业描述：隐藏渲染窗口挂载后据此知道该渲染哪一篇。
            // 与 take_pending_open 不同，本命令**不消费**，可重复问。
            mdnaonao_lib::cmdline::headless_job,
            // settings
            mdnaonao_lib::settings::load_settings,
            mdnaonao_lib::settings::save_settings,
            mdnaonao_lib::settings::save_lark_credential,
            // 飞书凭据的只读状态与解绑。状态对象永不含 appSecret/token（settings.rs 有单测钉死），
            // 前端拿它渲染「已配置 / 未配置 + 打码 appId」，绝不把密钥读回界面。
            mdnaonao_lib::settings::lark_credential_status,
            mdnaonao_lib::settings::clear_lark_credential,
            // 版本号 / 便携标志 / 数据根目录：右键菜单「关于」的数据源（附录 A.1）。
            // 前端拿不到这三样——版本只在 Cargo.toml，便携与数据根只有后端探测得出。
            mdnaonao_lib::settings::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
