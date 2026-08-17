/**
 * 崩溃兜底 —— UPGRADE_PLAN 4.3「React ErrorBoundary（错误摘要 + 重新加载 + 日志目录指引）」。
 *
 * 【为什么必须是 class】React 的错误边界只有 class 生命周期
 * （getDerivedStateFromError / componentDidCatch）能实现，没有等价 hook。
 * 全项目仅此一处 class 组件。
 *
 * 【它能接住什么、接不住什么】只接**渲染期**（render / 生命周期 / 构造函数）抛出的异常。
 * 事件回调、setTimeout、Promise reject 里的错误不经过这里 —— 那些路径本来就该在各自的
 * try/catch 里降级（见 App 的 openPath / 渲染管线）。所以本组件不是万能兜底，
 * 而是「白屏保险」：React 在未捕获异常时会卸载整棵树，留给用户一片纯白，
 * 那种状态下连"重新打开"都无从点起。
 *
 * 【视觉】居中卡片，走现有语义类。**刻意不做大红警告**：只读查看器崩了不是数据事故，
 * 用户的文件一个字节都没变；界面语气应当是「这一次没画出来」，不是「出大事了」。
 * 语义色只落在 16px 图标上（warn），其余走 primary/secondary/caption 三档灰。
 *
 * 【三个出路】重新加载（多数瞬时错误一次即好） / 复制诊断信息（贴给我们） /
 * 日志目录路径（自己去翻，或在文件管理器里定位）。日志目录经 ipc.appInfo() 取，
 * 取不到就显示占位破折号 —— 兜底组件自己再抛异常就成了黑色幽默，所有分支都吞掉异常。
 *
 * 纪律：不 import @tauri-apps/api（ESLint 强制，走 services/ipc），
 * 不写内联中文（注释除外），不 import App.tsx 的任何类型（本组件要包在 App 外面）。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

import { t } from "../i18n/zh-CN";
import { appInfo } from "../services/ipc";

/** 日志目录相对数据根目录的位置（与 src-tauri/src/logging.rs 的约定一致） */
const LOG_DIR_SUFFIX = "\\logs";
/** 「已复制」回执的存活时长；与代码块复制钮同一手感 */
const COPIED_FEEDBACK_MS = 1600;

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  /** React 给的组件栈（比 error.stack 更能定位是哪块 UI 炸的），仅进诊断文本 */
  readonly componentStack: string;
  readonly logDir: string | null;
  readonly copied: boolean;
}

/** 诊断文本的字段名：技术键名，不是界面文案，故不进 i18n */
const DIAGNOSTIC_KEYS = {
  time: "time",
  name: "name",
  message: "message",
  stack: "stack",
  componentStack: "componentStack",
  userAgent: "userAgent",
} as const;

/**
 * 写剪贴板：优先异步 API，被拒时退回 textarea + execCommand。
 * 刻意不复用 App 里的同名工具 —— 兜底组件必须能在「App 已经炸了」的前提下独立工作。
 */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (error: unknown) {
    console.warn("[error-boundary] clipboard.writeText failed, falling back", error);
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    document.execCommand("copy");
  } catch (error: unknown) {
    console.warn("[error-boundary] execCommand copy failed", error);
  }
  area.remove();
}

/** 三角感叹号 16px，描边 1.5，色由外层给（与 App 的图标口径一致） */
function IconAlert() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-warn"
    >
      <path d="M12 4.5 21 19.5H3L12 4.5Z" />
      <path d="M12 10v4.2M12 17h.01" />
    </svg>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private copiedTimer: number | null = null;

  public override state: ErrorBoundaryState = {
    error: null,
    componentStack: "",
    logDir: null,
    copied: false,
  };

  public static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    // 抛出来的不一定是 Error（throw "字符串" 完全合法），统一收敛成 Error 再展示
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  public override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[error-boundary] render crashed", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
    void this.resolveLogDir();
  }

  public override componentWillUnmount(): void {
    if (this.copiedTimer !== null) {
      window.clearTimeout(this.copiedTimer);
    }
  }

  /** 后端不可用时静默留 null（此刻再弹一个错误没有任何意义） */
  private async resolveLogDir(): Promise<void> {
    try {
      const info = await appInfo();
      this.setState({ logDir: info.logDir ?? `${info.dataDir}${LOG_DIR_SUFFIX}` });
    } catch (error: unknown) {
      console.warn("[error-boundary] appInfo failed", error);
    }
  }

  private buildDiagnostics(): string {
    const { error, componentStack, logDir } = this.state;
    const lines = [
      `${DIAGNOSTIC_KEYS.time}: ${new Date().toISOString()}`,
      `${DIAGNOSTIC_KEYS.name}: ${error?.name ?? ""}`,
      `${DIAGNOSTIC_KEYS.message}: ${error?.message ?? ""}`,
      `${DIAGNOSTIC_KEYS.userAgent}: ${navigator.userAgent}`,
      `${t.errorBoundary.logDir}: ${logDir ?? t.about.unknown}`,
      `${DIAGNOSTIC_KEYS.stack}: ${error?.stack ?? ""}`,
      `${DIAGNOSTIC_KEYS.componentStack}: ${componentStack}`,
    ];
    return lines.join("\n");
  }

  private readonly handleCopy = (): void => {
    void writeClipboard(this.buildDiagnostics()).then(() => {
      this.setState({ copied: true });
      if (this.copiedTimer !== null) {
        window.clearTimeout(this.copiedTimer);
      }
      this.copiedTimer = window.setTimeout(() => {
        this.copiedTimer = null;
        this.setState({ copied: false });
      }, COPIED_FEEDBACK_MS);
    });
  };

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  public override render(): ReactNode {
    const { error, logDir, copied } = this.state;
    if (error === null) {
      return this.props.children;
    }

    const summary = error.message.trim();

    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas p-6 font-ui">
        <div
          role="alert"
          className="w-full max-w-md rounded-card border border-float bg-layer p-4 shadow-lv3"
        >
          <div className="flex items-center gap-2">
            <IconAlert />
            <p className="text-ui font-medium text-primary">
              {t.errorBoundary.title}
            </p>
          </div>

          <p className="mt-2 text-ui-sm text-secondary">{t.errorBoundary.hint}</p>

          {/* 错误摘要：只给一行 message，栈进诊断文本——正文里堆栈只会把人吓走 */}
          <p className="mt-3 break-all rounded-row bg-code px-2.5 py-1.5 font-mono text-ui-xs text-tertiary">
            {summary === "" ? t.errorBoundary.unknownError : summary}
          </p>

          <p className="mt-3 break-all text-ui-xs text-caption">
            {`${t.errorBoundary.logDir}: ${logDir ?? t.about.unknown}`}
          </p>

          <div className="mt-4 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={this.handleCopy}
              className="flex h-row items-center rounded-row px-2 text-ui text-primary hover:bg-hover"
            >
              {copied ? t.common.copied : t.errorBoundary.copy}
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="flex h-btn items-center rounded-btn bg-brand px-3.5 text-ui font-medium text-inverted hover:bg-brand-hover"
            >
              {t.errorBoundary.reload}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
