//! 「打开方式」对话框的冒烟测试。
//!
//! 【为什么必须有这个测试】`open_with_dialog` 的失败模式是**只有真跑起来才暴露**的：
//! 单测能覆盖扩展名白名单与存在性校验，却覆盖不到 `ShellExecuteW` 本身——
//! 而 2026-08-18 的缺陷恰恰在那里：调用发生在 `spawn_blocking` 的 tokio 工作线程上，
//! 那里没有 COM 单元，`openas` 直接返回 31（SE_ERR_NOASSOC）。
//! 编译绿、单测绿、注册表探测也绿，用户一点却弹出「原生调用失败」。
//!
//! 本测试**真的会弹出一次「打开方式」对话框**，所以默认 `#[ignore]`，
//! 只在需要验收这条链路时手动跑：
//!
//! ```text
//! cargo test --test open_as_dialog_smoke -- --ignored --nocapture
//! ```
//!
//! 跑完记得关掉弹出来的那个框。

use std::path::PathBuf;

/// 真跑一次 `open_with_dialog`：COM 没起来的话这里会拿到 31。
#[test]
#[ignore = "会弹出系统「打开方式」对话框，需人工关闭"]
fn open_with_dialog_actually_pops() {
    let fixture = std::env::temp_dir().join("mdnaonao-openas-smoke.md");
    std::fs::write(&fixture, b"# smoke\n").expect("写入临时 .md 失败");

    let outcome = tauri::async_runtime::block_on(mdnaonao_lib::shell_integ::open_with_dialog(
        PathBuf::from(&fixture),
    ));

    // 不删 fixture：对话框还开着，删了会让它指向一个不存在的文件
    match outcome {
        Ok(()) => {
            // 真实应用是长驻进程；测试进程若调完就退，Shell 还没把框画出来就被带走了。
            // 这几秒是留给「肉眼确认框真的在屏幕上」的，不是给 API 的。
            println!("「打开方式」已弹出（请手动关闭）：{}", fixture.display());
            std::thread::sleep(std::time::Duration::from_secs(8));
        }
        Err(err) => panic!(
            "「打开方式」未能弹出：{err}\n\
             返回 31（SE_ERR_NOASSOC）时先查调用线程的 COM 单元是否初始化。"
        ),
    }
}

/// 非 Markdown 扩展名必须在碰磁盘之前就被挡下（安全边界，不弹任何框）。
#[test]
fn rejects_non_markdown_without_touching_disk() {
    let outcome = tauri::async_runtime::block_on(mdnaonao_lib::shell_integ::open_with_dialog(
        PathBuf::from(r"C:\Windows\System32\calc.exe"),
    ));
    let err = outcome.expect_err("非 Markdown 必须被拒绝");
    assert_eq!(
        err.kind(),
        "config",
        "应是配置错（白名单拒绝），实际：{err}"
    );
}
