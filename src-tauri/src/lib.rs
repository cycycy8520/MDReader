//! MDNaonao 后端库入口：模块声明与启动流程。
//!
//! 模块划分严格对应 DG 7.1，一个模块一份职责，不要跨模块塞逻辑：
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`files`] | 文件读取、编码检测、标题提取、recent.json、notify 监听 |
//! | [`export`] | 打印模板组装、PrintToPdf COM 桥接、CDP 兜底 |
//! | [`capture`] | 长图（CDP captureScreenshot + captureBeyondViewport） |
//! | [`share`] | 分享通道（微信 / 飞书 / 钉钉），飞书 API 在 [`share::lark`] |
//! | [`obsidian`] | Vault 枚举、复制导入、URI 唤起 |
//! | [`shell_integ`] | **仅**额外右键动词（关联本身交给 bundler） |
//! | [`settings`] | 配置读写、飞书密钥 DPAPI 加密 |
//! | [`cmdline`] | `--action` clap 解析（cli 插件与单实例回调共用） |
//! | [`logging`] | 文件日志与轮转 |
//! | [`error`] | 全局 `AppError` |
//!
//! **Tauri `Builder` 链写在 `main.rs`**——插件注册顺序是硬性约束
//! （single-instance 必须最先），集中在一处才好审查，不要挪进本文件。

pub mod capture;
pub mod cmdline;
pub mod error;
pub mod export;
pub mod files;
pub mod logging;
pub mod obsidian;
pub mod settings;
pub mod share;
pub mod shell_integ;

use tauri::plugin::TauriPlugin;
use tauri::{App, Runtime, Url, Webview};

/// 「打开某个路径」事件名 —— 前后端契约，前端 `services/ipc.ts` 的
/// `EVENT_OPEN_PATH` 必须逐字一致（单实例转发 / 文件关联双击都汇聚到这里）。
pub const EVENT_OPEN_PATH: &str = "open-path";

/// 主窗口 label，必须与 `tauri.conf.json > app.windows[0].label` 一致。
/// 导航守卫与 WebView 行为接管都只针对它（PDF/长图用的临时窗口不能被限制）。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 应用自身页面的 host。Tauri 2 在 Windows 上把 `tauri://localhost`
/// 落地成 `http(s)://tauri.localhost`（见 tauri 的 `tauri_protocol_url`）。
const APP_ORIGIN_HOST: &str = "tauri.localhost";

/// 启动流程入口：由 `main.rs` 在 `Builder::setup` 阶段调用。
///
/// 这里只做「窗口出现之前必须完成」的事；耗时操作一律不要放这里（冷启动预算
/// ≤3s 含 ≤300ms splash，DG 3.2）。
///
/// 注：配置里声明的窗口在 `setup` **之前**就已创建（tauri 2.11 `setup()`：
/// 先 `WebviewWindowBuilder::from_config(...).build()`，再调用本函数），
/// 所以这里能直接拿到主窗口的 WebView 句柄。
///
/// TODO(M1)：
/// * 恢复窗口几何（[`settings::WindowGeometry`]，DG 6.2「窗口记忆」，批次 2.7），
///   异常位置回落主屏居中；
/// * 把 [`settings::Settings`] 注入 `app.manage()` 供各命令共享。
pub fn run(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "MDNaonao 启动（严格只读模式）"
    );

    // 先驯服 WebView 再做别的：它只是几次 COM 属性写入（微秒级），
    // 而一旦后面的步骤提前 return，用户就会拿到一个「浏览器味」的窗口。
    tame_webview(app);

    // 命令行解析失败不阻塞启动：内部已降级为「无参数启动」
    cmdline::handle_first_instance(app.handle())?;

    // M0-① PoC 验证入口（仅在设置环境变量时触发，正常启动不受影响）
    if let Ok(poc) = std::env::var(PDF_POC_ENV) {
        spawn_pdf_poc(app.handle().clone(), poc);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 导航兜底（UPGRADE_PLAN 1.1 的纵深防御）
// ---------------------------------------------------------------------------

/// 导航守卫插件：主窗口除应用自身 origin 外的导航一律 deny。
///
/// 为什么是插件而不是 `WebviewWindowBuilder::on_navigation`：主窗口由
/// `tauri.conf.json` 声明、由 Tauri 自己 `from_config` 构建，拿不到那个 builder；
/// 而 `plugin::Builder::on_navigation` 是全局钩子，对配置创建的窗口同样生效
/// （tauri `manager/webview.rs` 在 navigation handler 之后调用插件钩子）。
///
/// 它是**兜底**不是主路线：外链的正路是前端点击委托 → `openExternal` 交系统浏览器。
/// 委托一旦漏了一种情况（新窗口、表单提交、脚本 `location.href`），这里保证应用
/// 不会被导航走——用户点一下就回不来的事故，一次都不能有。
///
/// 只管主窗口：PDF/长图用的临时窗口要加载 `file://` 测试页与打印模板，不能被拦。
pub fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("mdnaonao-navigation-guard")
        .on_navigation(|webview: &Webview<R>, url: &Url| {
            if webview.label() != MAIN_WINDOW_LABEL || is_app_origin(url) {
                return true;
            }
            tracing::info!(%url, "已拦截主窗口导航（外链只走系统浏览器）");
            false
        })
        .build()
}

/// URL 是否属于应用自身页面。
///
/// 放行面刻意开得极窄：生产只认 `http(s)://tauri.localhost`，dev 额外认 devUrl 的
/// localhost。`asset.localhost`（图片）与 `file:`、`javascript:`、`data:` 一概不放行——
/// 它们出现在**导航**上下文里只有一种可能：正文里的链接把应用顶掉。
fn is_app_origin(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.host_str().is_some_and(|host| {
            host == APP_ORIGIN_HOST
                // dev 下前端跑在 devUrl（http://localhost:1420）上
                || (tauri::is_dev() && matches!(host, "localhost" | "127.0.0.1" | "[::1]"))
        }),
        // 非 Windows 平台上自定义协议的原始形态，保留以免将来跨平台时误伤
        "tauri" => true,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// WebView 行为接管（UPGRADE_PLAN 1.2，blocker）
// ---------------------------------------------------------------------------

/// 关掉 WebView2 的「浏览器本性」：加速键、整窗缩放、默认右键菜单、DevTools、状态栏。
///
/// 接口分布**已按本机 `webview2-com-sys-0.38.2/src/bindings.rs` 逐个核实**（2026-08-18）：
///
/// | 开关 | 所在接口 |
/// |---|---|
/// | `AreDefaultContextMenusEnabled`、`IsZoomControlEnabled`、`AreDevToolsEnabled`、`IsStatusBarEnabled` | `ICoreWebView2Settings`（基接口，无需 cast） |
/// | `AreBrowserAcceleratorKeysEnabled` | `ICoreWebView2Settings3` |
/// | `IsSwipeNavigationEnabled` | `ICoreWebView2Settings6` |
///
/// 全过程失败只 `warn` 不阻塞启动：运行时版本过旧时 cast 会失败，那时应用仍要能看文档
/// （前端另有键盘白名单，最差情况是浏览器快捷键漏进来，而不是打不开）。
#[cfg(windows)]
fn tame_webview(app: &App) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        tracing::warn!(
            label = MAIN_WINDOW_LABEL,
            "找不到主窗口，WebView 行为未接管"
        );
        return;
    };

    // 闭包要求 'static + Send；在主线程（setup）调用时 Tauri 会当场同步执行它
    let dispatched = window.with_webview(|platform| match apply_webview_settings(&platform) {
        Ok(()) => tracing::info!("WebView 行为已接管：加速键/整窗缩放/右键菜单/DevTools/状态栏"),
        Err(err) => tracing::warn!(%err, "WebView 行为接管未完全生效（应用继续启动）"),
    });
    if let Err(err) = dispatched {
        tracing::warn!(%err, "with_webview 调用失败，WebView 行为未接管");
    }
}

/// 非 Windows 平台没有 WebView2，直接跳过（本产品只发 Windows，此分支仅为可编译性）。
#[cfg(not(windows))]
fn tame_webview(_app: &App) {}

/// 真正写那几个 COM 属性。每一步失败都带上下文回传，由调用方统一 warn。
#[cfg(windows)]
fn apply_webview_settings(platform: &tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2Settings6,
    };
    use windows_core::Interface;

    // SAFETY（以下所有 unsafe 共用这一段理由）：
    // * 线程：闭包由 Tauri 保证运行在**创建该 WebView 的 UI 线程**上。WebView2 是
    //   单线程套间（STA），跨线程调这些接口是未定义行为，因此绝不能把 platform 挪出闭包。
    // * 生命周期：接口指针来自 Tauri 自己持有的 controller，闭包执行期间必然存活；
    //   这里既不转移所有权也不缓存指针，出了闭包什么都不留。
    // * 参数：全是 `bool` 值传递的属性 setter，没有裸指针入参；HRESULT 已由绑定层
    //   转成 `windows_core::Result`，失败走 Err 而不是 panic。
    let core = unsafe { platform.controller().CoreWebView2() }
        .map_err(|err| format!("取 CoreWebView2 失败：{err}"))?;
    let settings = unsafe { core.Settings() }.map_err(|err| format!("取 Settings 失败：{err}"))?;

    unsafe {
        // 默认右键菜单**保持开启**，由前端逐目标决定拦不拦（App.tsx 的 contextmenu 委托）：
        // 非输入框目标 → preventDefault + 弹自绘菜单；输入框 → 放行，让系统菜单接管
        // （粘贴、输入法候选、拼写建议这些是 WebView 原生能力，自绘菜单做不出等价物）。
        //
        // 曾经在这里全局 SetAreDefaultContextMenusEnabled(false)：那是自绘菜单未就位时的
        // 保底措施，代价是输入框也一起哑了 —— 现在自绘菜单已上线，必须把这条还回去，
        // 否则搜索框里连粘贴都没有。**改这行前先确认前端委托仍在拦截正文/链接/图片/左栏。**
        settings
            .SetAreDefaultContextMenusEnabled(true)
            .map_err(|err| format!("设置默认右键菜单开关失败：{err}"))?;
        // Ctrl+滚轮「缩放整个窗口」的根源；改由前端只缩正文（1.4）
        settings
            .SetIsZoomControlEnabled(false)
            .map_err(|err| format!("关闭 WebView 缩放失败：{err}"))?;
        // 左下角悬停链接时冒出来的浏览器状态条，桌面应用里是穿帮
        settings
            .SetIsStatusBarEnabled(false)
            .map_err(|err| format!("关闭状态栏失败：{err}"))?;
        // DevTools：发布构建一律关闭；debug 构建保留，否则开发期连元素都查不了。
        // F12 本身已被下面的 AreBrowserAcceleratorKeysEnabled=false 拿掉，
        // 发布构建这里是第二道保险（右键菜单也已关，没有别的入口）。
        settings
            .SetAreDevToolsEnabled(cfg!(debug_assertions))
            .map_err(|err| format!("设置 DevTools 开关失败：{err}"))?;
    }

    let settings3: ICoreWebView2Settings3 = settings.cast().map_err(|err| {
        format!("cast ICoreWebView2Settings3 失败（WebView2 运行时过旧？）：{err}")
    })?;
    // Ctrl+R / Ctrl+P / Ctrl+F / Ctrl+U / F12 / F3 / Alt+←→ 等浏览器加速键整体收回，
    // 需要的键由前端按 DG 6.5 白名单重新实现（Ctrl+R = 重新渲染，不丢文档）
    unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) }
        .map_err(|err| format!("关闭浏览器加速键失败：{err}"))?;

    // 触摸板/触屏的左右滑手势 = 前进/后退导航，与「应用永不被导航走」是同一件事。
    // Settings6 在较老运行时上不存在：cast 失败只降级记录，不影响上面已生效的开关。
    match settings.cast::<ICoreWebView2Settings6>() {
        Ok(settings6) => {
            if let Err(err) = unsafe { settings6.SetIsSwipeNavigationEnabled(false) } {
                tracing::warn!(%err, "关闭滑动手势导航失败（其余开关不受影响）");
            }
        }
        Err(err) => {
            tracing::debug!(%err, "运行时无 ICoreWebView2Settings6，跳过滑动手势导航开关");
        }
    }

    Ok(())
}

/// M0-① 验证开关：设为 `<html路径>|<pdf输出路径>` 即在启动后自动跑一次静默导出。
/// 这是**临时验证脚手架**，M2 打印模板落地后删除。
pub const PDF_POC_ENV: &str = "MDNAONAO_PDF_POC";

/// 打开测试页 → 等待渲染 → 调 PrintToPdf → 打印结果并退出进程。
///
/// 说明：此处用固定等待而非 PRINT_READY 事件，因为测试页是独立 HTML、
/// 没有打包 Tauri 的 JS API，emit 不到宿主。M2 的打印模板由我们自己的前端渲染，
/// 届时改为等 [`crate::export::PRINT_READY_EVENT`]（DG 7.2-4）。
fn spawn_pdf_poc(app: tauri::AppHandle, spec: String) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    tauri::async_runtime::spawn(async move {
        let (html, out) = match spec.split_once('|') {
            Some((h, o)) => (h.to_string(), std::path::PathBuf::from(o)),
            None => {
                tracing::error!("PDF PoC 参数格式应为 <html>|<pdf>");
                app.exit(2);
                return;
            }
        };

        let url = match url::Url::from_file_path(&html) {
            Ok(u) => u,
            Err(()) => {
                tracing::error!(%html, "测试页路径无法转为 file:// URL（需绝对路径）");
                app.exit(2);
                return;
            }
        };

        tracing::info!(%url, "PDF PoC：创建打印窗口");
        let build = WebviewWindowBuilder::new(&app, "pdfpoc", WebviewUrl::External(url))
            .title("PDF PoC")
            .inner_size(900.0, 1200.0)
            .visible(false)
            .build();
        if let Err(err) = build {
            tracing::error!(%err, "PDF PoC：创建窗口失败");
            app.exit(2);
            return;
        }

        // 等待 Mermaid/KaTeX/字体渲染完成（测试页自身约 1–2s，留足余量）
        let wait_secs: u64 = std::env::var("MDNAONAO_PDF_POC_WAIT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(6);
        tracing::info!(wait_secs, "PDF PoC：等待页面渲染");
        tokio::time::sleep(std::time::Duration::from_secs(wait_secs)).await;

        let options = export::PdfOptions {
            output: out.clone(),
            include_toc: false,
        };
        let started = std::time::Instant::now();
        match export::print_pdf_for_window(&app, "pdfpoc", &options).await {
            Ok(()) => {
                let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
                tracing::info!(
                    path = %out.display(),
                    bytes = size,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "PDF PoC：导出成功"
                );
                let _ = app.get_webview_window("pdfpoc").map(|w| w.close());
                app.exit(0);
            }
            Err(err) => {
                tracing::error!(%err, "PDF PoC：导出失败");
                app.exit(1);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin_allowed(raw: &str) -> bool {
        is_app_origin(&Url::parse(raw).expect("测试 URL 应可解析"))
    }

    /// 应用自身页面必须放行，否则窗口连自己的首页都加载不了。
    #[test]
    fn allows_app_origin() {
        assert!(origin_allowed("http://tauri.localhost/index.html"));
        assert!(origin_allowed("https://tauri.localhost/"));
        assert!(origin_allowed("tauri://localhost"));
    }

    /// 外链、本地文件、脚本伪协议、乃至 asset 协议地址，出现在**导航**上下文里
    /// 一律拦下（正常的图片加载走资源请求，根本不经过导航钩子）。
    #[test]
    fn blocks_everything_else() {
        for raw in [
            "https://github.com/tauri-apps/tauri",
            "http://example.com",
            // 前缀相同但域名不同：必须整段相等才算自己人
            "https://tauri.localhost.evil.com/",
            "file:///D:/notes/a.md",
            "javascript:alert(1)",
            "data:text/html,<h1>x</h1>",
            "http://asset.localhost/D%3A%2Fa.png",
        ] {
            assert!(!origin_allowed(raw), "应拦截：{raw}");
        }
    }
}
