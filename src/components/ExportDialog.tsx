/**
 * 导出对话框 —— FR-07（HTML）/ FR-08（PDF）的唯一交互入口，M2 批次点亮。
 *
 * 【为什么是一个对话框而不是"点了就导"】FR-07 明写两种 HTML 模式必须是**显式选项**
 * （单文件 base64 内联 / HTML + 资源目录），FR-08 的文内目录同理；再加上"导到哪儿"
 * 这件事用户必须能看见并能改——三件事凑在一起，就只能是一张卡。
 *
 * 【职责边界】
 *   本文件   选项 UI + 调 ipc 执行导出 + 把结果（成功路径 / 失败原因）交回调用方；
 *   App.tsx  何时唤起（右键菜单「导出 ▸」/ 顶栏导出钮）、结果 toast、Esc 语义链；
 *   ipc.ts   export_html / export_pdf / save 对话框的封装。
 * 本文件**不认识** store 之外的任何全局状态，也不自己弹 toast——导出完成时对话框
 * 已经关了，toast 必须由还活着的 App 来渲染。
 *
 * 【HTML 模式的持久化】选中的模式直接写 settings.htmlExportMode（DG 7.3 的导出偏好位），
 * 所以下次打开对话框停在上次的选择上；PDF 的「包含文内目录」刻意**不持久化**——
 * 它更像"这一次要不要目录"的一次性决定，不是长期偏好。
 *
 * 【视觉】沿用「关于」对话框那张卡的语义类（rounded-card / border-float / bg-layer /
 * shadow-lv3），一个新 CSS 类都不加；交互反馈只换背景色、不加 transition（铁律 1/2）。
 *
 * 纪律：不 import @tauri-apps/api（ESLint 强制，一律走 services/ipc.ts）；
 * 不写内联中文文案（注释除外），全部取自 i18n/zh-CN.ts 的 exportDialog 组。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { t } from "../i18n/zh-CN";
import { buildHtmlExport } from "../render/htmlExport";
import {
  exportHtml,
  exportHtmlConflict,
  exportPdf,
  probePaths,
  saveFileDialog,
  ERR_EXPORT_TARGET_EXISTS,
  HTML_SAVE_FILTERS,
  PDF_SAVE_FILTERS,
  type SaveDialogFilter,
} from "../services/ipc";
import { describeError, useFileSessionStore } from "../stores/fileSession";
import { useSettingsStore } from "../stores/settings";
import type { ExportHtmlMode } from "../types";

/* ── 对外契约（App.tsx 与 contextMenuItems.ts 都按这三个类型接线） ── */

/** 本批次可用的两种导出格式；长图 PNG 属 M3（capture.rs 未实现），刻意不在此枚举内 */
export type ExportKind = "html" | "pdf";

export interface ExportRequest {
  /** 唤起时预选的格式；卡内仍可切换（顶栏导出钮唤起时默认 HTML） */
  readonly kind: ExportKind;
  /** 当前文档的绝对路径：默认输出路径与资源解析都以它为基准 */
  readonly sourcePath: string;
}

/** 导出结局。成功只回传产物路径（toast 的两个动作要用），失败只回传面向用户的原因 */
export type ExportOutcome =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly message: string };

export interface ExportDialogProps {
  readonly request: ExportRequest;
  /**
   * 导出中/导出结束的开关。App 据此决定 Esc 与遮罩点击是否放行——
   * 导出进行中关掉卡片并不能让后端停下来，只会让用户失去唯一的进度反馈。
   */
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
  readonly onDone: (outcome: ExportOutcome) => void;
}

/* ── 常量（技术值，不是文案） ─────────────────────────────────── */

/** 超过这个时长才显示进度说明（DG 6.6：导出中 >2s 追加提示） */
const SLOW_HINT_MS = 2000;

const EXTENSION: Record<ExportKind, string> = { html: "html", pdf: "pdf" };

const SAVE_FILTERS: Record<ExportKind, readonly SaveDialogFilter[]> = {
  html: HTML_SAVE_FILTERS,
  pdf: PDF_SAVE_FILTERS,
};

const FORMATS: readonly { readonly value: ExportKind; readonly label: string }[] = [
  { value: "html", label: t.exportDialog.formatHtml },
  { value: "pdf", label: t.exportDialog.formatPdf },
];

const HTML_MODES: readonly {
  readonly value: ExportHtmlMode;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: "single-file",
    label: t.exportDialog.htmlSingleFile,
    hint: t.exportDialog.htmlSingleFileHint,
  },
  {
    value: "with-assets",
    label: t.exportDialog.htmlWithAssets,
    hint: t.exportDialog.htmlWithAssetsHint,
  },
];

/* ── 路径工具 ───────────────────────────────────────────────── */

/**
 * 换扩展名（`D:\笔记\周报.md` → `D:\笔记\周报.pdf`）。
 * 只认最后一个点，且必须出现在最后一个分隔符之后——
 * `D:\v1.2\周报`（目录名带点、文件名没扩展名）不能被误切成 `D:\v1.pdf`。
 */
function withExtension(path: string, extension: string): string {
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dot = path.lastIndexOf(".");
  const stem = dot > separator + 1 ? path.slice(0, dot) : path;
  return `${stem}.${extension}`;
}

/** 取父目录（本地图片相对路径的解析基准）；无分隔符（裸文件名）返回 null */
function parentDirOf(path: string): string | null {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : null;
}

/* ── HTML 导出（前端渲染 payload → 后端重写路径落盘） ───────── */

/**
 * HTML 导出的前端半：先把正文渲染成一份自包含文档，再交后端做图片路径重写与落盘。
 *
 * 为什么用**会话里已加载的正文**而不是重新读一次盘：用户看到的就是这一份，
 * 「预览 = 导出」是这条链的立身之本。文件若在打开之后被外部改过，重新读盘会导出
 * 一份用户从没见过的东西——那比稍旧一点糟得多。
 *
 * `overwrite` **只在卡片上真的显示过覆盖警告时才为 true**。这不是多此一举：
 * 无条件传 true 等于把后端「目标已存在就拒绝」这道安全网整个拆掉，一旦探测那步
 * 失败（权限不足、路径刚被创建）用户就会在毫不知情的情况下丢掉一个文件。
 * 让警告本身充当授权，探测失败时后端照常拦下来，最坏也只是多一次提示。
 */
export async function runHtmlExport(
  sourcePath: string,
  output: string,
  mode: ExportHtmlMode,
  overwrite: boolean,
): Promise<{ output: string }> {
  const session = useFileSessionStore.getState();
  const payload = await buildHtmlExport({
    source: session.source,
    title: session.title,
    baseDir: parentDirOf(sourcePath),
    sourcePath,
    encoding: session.encoding ?? "utf8",
    frontmatterDisplay: useSettingsStore.getState().frontmatterDisplay,
    isLarge: session.isLarge,
  });
  return exportHtml(payload, output, mode, overwrite);
}

/* ── 图标（与 App/ContextMenu 同一套画法：24 视窗 / stroke 1.5 / currentColor） ── */

function Glyph({
  size,
  children,
}: {
  readonly size: number;
  readonly children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** 单选：选中时圆心实心点（不用色块，避免在 hover 底色上出现第二枚色块） */
function IconRadio({ checked }: { readonly checked: boolean }) {
  return (
    <Glyph size={16}>
      <circle cx="12" cy="12" r="8" />
      {checked ? <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" /> : null}
    </Glyph>
  );
}

/** 复选：方框 + 对勾 */
function IconCheckbox({ checked }: { readonly checked: boolean }) {
  return (
    <Glyph size={16}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      {checked ? <path d="m8 12.3 2.8 2.8L16.2 9.5" /> : null}
    </Glyph>
  );
}

function IconSuccess() {
  return (
    <Glyph size={14}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.3 12.3 2.6 2.6 4.8-5.2" />
    </Glyph>
  );
}

function IconFailure() {
  return (
    <Glyph size={14}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.2M12 16.2h.01" />
    </Glyph>
  );
}

/** 进行中：转四分之三圈的环。不用 IconSuccess 的对勾——事情还没成 */
function IconBusy() {
  return (
    <Glyph size={14}>
      <circle cx="12" cy="12" r="8.5" opacity="0.3" />
      <path d="M20.5 12a8.5 8.5 0 0 0-8.5-8.5" />
    </Glyph>
  );
}

function IconClose() {
  return (
    <Glyph size={12}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Glyph>
  );
}

/** 按钮内的 10px 微 spinner：颜色跟随按钮文字（brand 底上是反白，卡片上是墨色） */
function MicroSpinner() {
  return (
    <span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 animate-spin-micro rounded-full border-[1.5px]"
      // 关键词而非色值（红线 14 禁的是裸色值）：借按钮自身的 currentColor，
      // 主按钮反白、次按钮墨色，两种底色下都看得见
      style={{ borderColor: "currentColor", borderTopColor: "transparent" }}
    />
  );
}

/* ── 选项行 ─────────────────────────────────────────────────── */

interface OptionRowProps {
  readonly role: "radio" | "checkbox";
  readonly checked: boolean;
  readonly label: string;
  readonly hint?: string;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}

/**
 * 一行可选项：左侧 16px 标记槽 + 主文案 + 可选的一行淡字说明。
 * 用 button + role 而非原生 input：原生控件带浏览器默认外观与聚焦环，
 * 和本项目"反馈只换背景色"的语言对不上；语义靠 role/aria-checked 补齐。
 */
function OptionRow({ role, checked, label, hint, disabled, onSelect }: OptionRowProps) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      aria-disabled={disabled ? true : undefined}
      onClick={disabled ? undefined : onSelect}
      className={`flex w-full items-start gap-2 rounded-row px-2 py-1.5 text-left ${
        disabled ? "cursor-default opacity-40" : "hover:bg-hover"
      }`}
    >
      <span
        aria-hidden
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${
          checked ? "text-primary" : "text-tertiary"
        }`}
      >
        {role === "radio" ? <IconRadio checked={checked} /> : <IconCheckbox checked={checked} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui text-primary">{label}</span>
        {hint === undefined ? null : (
          <span className="block text-ui-xs text-tertiary">{hint}</span>
        )}
      </span>
    </button>
  );
}

/* ── 对话框本体 ─────────────────────────────────────────────── */

export function ExportDialog({
  request,
  onBusyChange,
  onClose,
  onDone,
}: ExportDialogProps) {
  const htmlMode = useSettingsStore((state) => state.htmlExportMode);

  const [kind, setKind] = useState<ExportKind>(request.kind);
  const [includeToc, setIncludeToc] = useState(false);
  /**
   * 输出路径的"基底"：初值是源文件路径，用户另存为之后换成他选的路径。
   * 真正的输出路径由基底 + 当前格式的扩展名推导——这样切换格式时扩展名自动跟上，
   * 不会出现「选了 PDF、路径还写着 .html」这种自相矛盾的界面。
   */
  const [outputBase, setOutputBase] = useState(request.sourcePath);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  /** 「另存为…」不可用（多半是 dialog:allow-save 权限没放行）：给一行说明，不阻断默认路径导出 */
  const [saveDialogFailed, setSaveDialogFailed] = useState(false);
  /**
   * 落点已被占用。**提前告知而不是导出到一半弹确认框**：用户按下「导出」时就该
   * 知道这一下会覆盖什么，中途冒出来的模态框只会让人条件反射点确定。
   * 探测失败一律按「不占用」处理——探测只是提前量，真正的覆盖由后端执行。
   */
  const [conflict, setConflict] = useState<null | { file: boolean; assetsDir: boolean }>(
    null,
  );

  const slowTimer = useRef<number | undefined>(undefined);
  /** 卡片被卸载后不再 setState（导出仍在后端跑，结果由 onDone 交给 App） */
  const mounted = useRef(true);

  const output = useMemo(() => withExtension(outputBase, EXTENSION[kind]), [outputBase, kind]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(slowTimer.current);
    };
  }, []);

  // 忙碌位上抛给 App（Esc / 遮罩点击据此放行或吃掉）
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // 落点占用探测。HTML 走 export_html_conflict（连资源目录一起查），
  // PDF 没有对应命令，用 probePaths 反查——它回传的是**不存在**的那部分，
  // 所以「返回空数组」才等于「文件已存在」。
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        if (kind === "html") {
          const found = await exportHtmlConflict(output, htmlMode);
          if (!stale && mounted.current) {
            setConflict({ file: found.fileExists, assetsDir: found.assetsDirConflict });
          }
          return;
        }
        const missing = await probePaths([output]);
        if (!stale && mounted.current) {
          setConflict({ file: missing.length === 0, assetsDir: false });
        }
      } catch (error: unknown) {
        console.warn("[export] conflict probe failed", error);
        if (!stale && mounted.current) {
          setConflict(null);
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [htmlMode, kind, output]);

  /** 另存为…：用户取消返回 null，此时保持原路径不动（取消就是"什么都别变"） */
  const pickOutput = useCallback(() => {
    void (async () => {
      try {
        const picked = await saveFileDialog(output, SAVE_FILTERS[kind]);
        if (picked !== null && picked !== "" && mounted.current) {
          setOutputBase(picked);
          setSaveDialogFailed(false);
        }
      } catch (error: unknown) {
        // 权限未放行 / 对话框被系统拒绝：不弹错误页，只在卡内挂一行说明
        console.warn("[export] saveFileDialog failed", error);
        if (mounted.current) {
          setSaveDialogFailed(true);
        }
      }
    })();
  }, [kind, output]);

  const runExport = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    setSlow(false);
    window.clearTimeout(slowTimer.current);
    slowTimer.current = window.setTimeout(() => {
      if (mounted.current) {
        setSlow(true);
      }
    }, SLOW_HINT_MS);

    void (async () => {
      try {
        // 覆盖授权来自「用户看过卡片上的警告」这件事本身，见 runHtmlExport 的注释
        const authorized = conflict !== null && (conflict.file || conflict.assetsDir);
        const result =
          kind === "html"
            ? await runHtmlExport(request.sourcePath, output, htmlMode, authorized)
            : await exportPdf(request.sourcePath, { output, includeToc });
        // 以后端回传的路径为准：Rust 侧可能做过规范化（相对→绝对、扩展名补齐）
        onDone({ ok: true, output: result.output });
      } catch (error: unknown) {
        // Rust AppError 的 message 已经是面向用户的中文，原样交给 toast
        console.warn("[export] export failed", error);
        // 唯一需要改写的一类：落点在探测之后才被占用（探测失败 / 并发写入）。
        // 后端那句话是给开发者看的前缀式技术信息，直接扔给用户等于没说。
        // 失败即关卡片（见 App 的 handleExportDone），所以这里不必回填冲突态：
        // 用户再次唤起导出时卡片会重新探测一遍，那时警告就出来了。
        if (describeError(error).message.startsWith(ERR_EXPORT_TARGET_EXISTS)) {
          onDone({ ok: false, message: t.exportDialog.overwriteRefused });
          return;
        }
        onDone({ ok: false, message: describeError(error).message });
      } finally {
        window.clearTimeout(slowTimer.current);
        if (mounted.current) {
          setBusy(false);
          setSlow(false);
        }
      }
    })();
  }, [busy, conflict, htmlMode, includeToc, kind, onDone, output, request.sourcePath]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-mask p-6 animate-fade-in"
      // 导出进行中点遮罩不关窗：后端停不下来，关掉只会丢掉唯一的进度反馈
      onClick={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.exportDialog.title}
        aria-busy={busy ? true : undefined}
        // 卡内点击不该关窗（用户会想选中路径复制）
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-card border border-float bg-layer p-4 shadow-lv3"
      >
        <p className="text-ui font-medium text-primary">{t.exportDialog.title}</p>

        {/* 格式：两枚 chip 型单选（长图 PNG 属 M3，不在此出现） */}
        <div className="mt-3 flex items-center gap-2">
          <span className="w-16 shrink-0 text-ui-sm text-tertiary">
            {t.exportDialog.format}
          </span>
          <div
            role="radiogroup"
            aria-label={t.exportDialog.format}
            className="flex items-center gap-1"
          >
            {FORMATS.map((format) => {
              const active = format.value === kind;
              return (
                <button
                  key={format.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-disabled={busy ? true : undefined}
                  onClick={
                    busy
                      ? undefined
                      : () => {
                          setKind(format.value);
                        }
                  }
                  className={`flex h-7 items-center rounded-chip px-2.5 text-ui-sm ${
                    busy ? "cursor-default opacity-40" : "hover:bg-hover"
                  } ${active ? "bg-hover text-primary" : "text-secondary"}`}
                >
                  {format.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 格式相关选项：HTML 两模式二选一 / PDF 的文内目录 */}
        <div className="mt-2">
          {kind === "html" ? (
            <div role="radiogroup" aria-label={t.exportDialog.formatHtml}>
              {HTML_MODES.map((mode) => (
                <OptionRow
                  key={mode.value}
                  role="radio"
                  checked={mode.value === htmlMode}
                  label={mode.label}
                  hint={mode.hint}
                  disabled={busy}
                  onSelect={() => {
                    // 直接落进 settings（DG 7.3 的导出偏好位），下次打开停在这一档
                    useSettingsStore.getState().setHtmlExportMode(mode.value);
                  }}
                />
              ))}
            </div>
          ) : (
            <OptionRow
              role="checkbox"
              checked={includeToc}
              label={t.exportDialog.includeToc}
              hint={t.exportDialog.tocHint}
              disabled={busy}
              onSelect={() => {
                setIncludeToc(!includeToc);
              }}
            />
          )}
        </div>

        {/* 输出路径：默认源文件同目录同名，可另存为 */}
        <div className="mt-3 flex items-center gap-2">
          <span className="w-16 shrink-0 text-ui-sm text-tertiary">
            {t.exportDialog.output}
          </span>
          {/* 长路径截尾并挂 title：不用 dir=rtl 那种"让文件名露出来"的技巧，
              它会把 Windows 路径里的冒号与反斜杠重排，读起来是错的 */}
          <span title={output} className="min-w-0 flex-1 truncate text-ui-sm text-secondary">
            {output}
          </span>
          <button
            type="button"
            aria-disabled={busy ? true : undefined}
            onClick={busy ? undefined : pickOutput}
            className={`flex h-row shrink-0 items-center rounded-row px-2 text-ui-sm text-primary ${
              busy ? "cursor-default opacity-40" : "hover:bg-hover"
            }`}
          >
            {t.exportDialog.saveAs}
          </button>
        </div>
        <p className="mt-1 pl-[72px] text-ui-xs text-tertiary">
          {saveDialogFailed ? t.exportDialog.saveAsFailed : t.exportDialog.outputDefaultHint}
        </p>
        {/* 覆盖预警：按下导出之前就说清这一下会盖掉什么，而不是中途弹确认框 */}
        {conflict !== null && (conflict.file || conflict.assetsDir) ? (
          <p className="mt-1 pl-[72px] text-ui-xs text-warn">
            {conflict.file
              ? t.exportDialog.overwriteFileWarning
              : t.exportDialog.overwriteAssetsDirWarning}
          </p>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-1">
          {/* 超过 2s 才出现，位置在左侧（DG 6.6：导出中 >2s 追加进度提示） */}
          {slow ? (
            <span className="mr-auto min-w-0 truncate text-ui-xs text-tertiary animate-fade-in">
              {t.exportDialog.slowHint}
            </span>
          ) : null}
          <button
            type="button"
            aria-disabled={busy ? true : undefined}
            onClick={busy ? undefined : onClose}
            className={`flex h-row items-center rounded-row px-2 text-ui text-primary ${
              busy ? "cursor-default opacity-40" : "hover:bg-hover"
            }`}
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            // 打开即可直接回车导出：默认路径与上次的模式都已就位，多数场景一步到位
            autoFocus
            aria-disabled={busy ? true : undefined}
            onClick={busy ? undefined : runExport}
            className={`flex h-btn items-center gap-2 rounded-btn bg-brand px-3.5 text-ui font-medium text-inverted ${
              busy ? "cursor-default opacity-60" : "hover:bg-brand-hover"
            }`}
          >
            {busy ? <MicroSpinner /> : null}
            {busy ? t.exportDialog.running : t.exportDialog.run}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 结果 toast（DG 6.6：已导出 · 打开文件 / 打开所在文件夹） ──────
   刻意与对话框放在同一文件：它只服务导出结果这一件事，两者的文案也在同一个 i18n 组。
   状态由 App 持有（对话框关掉之后 toast 还要活着），本组件是纯展示 + 自动撤条。 */

export interface ExportToastAction {
  readonly label: string;
  readonly run: () => void;
}

export interface ExportToastState {
  /** 自增序号：连续两次导出的文案可能一模一样，靠它重置计时器与入场动画 */
  readonly id: number;
  /**
   * `info` 是**进行中**（如「正在准备预览…」），不是结果：
   * 有些动作要一两秒才有产物，不给这一条反馈就是「点了没反应」。
   * 它撤得最快，且从不带动作按钮——事情还没做完，没有产物可开。
   */
  readonly kind: "success" | "danger" | "info";
  readonly message: string;
  /** 失败时为空数组（失败没有"打开产物"可言） */
  readonly actions: readonly ExportToastAction[];
}

/** 成功条撤得快些，失败条多留一会儿（用户需要时间读原因）；进行中那条最短 */
const TOAST_MS: Record<ExportToastState["kind"], number> = {
  info: 4000,
  success: 6000,
  danger: 9000,
};

export interface ExportToastProps {
  readonly toast: ExportToastState;
  readonly onDismiss: () => void;
}

export function ExportToast({ toast, onDismiss }: ExportToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, TOAST_MS[toast.kind]);
    return () => {
      window.clearTimeout(timer);
    };
    // id 变化 = 换了一条，计时重来；kind 变化同理
  }, [toast.id, toast.kind, onDismiss]);

  return (
    <div
      role="status"
      // bottom-9(36px) 而不是 bottom-4：状态栏高 26px，压在它上面会盖住字数/编码那一行
      className="fixed bottom-9 right-4 z-50 flex max-w-sm items-start gap-2 rounded-card border border-float bg-layer px-3 py-2.5 shadow-lv3 animate-fade-in"
    >
      <span
        aria-hidden
        className={`mt-0.5 shrink-0 ${
          toast.kind === "danger"
            ? "text-danger"
            : toast.kind === "info"
              ? "text-tertiary"
              : "text-success"
        }`}
      >
        {toast.kind === "danger" ? (
          <IconFailure />
        ) : toast.kind === "info" ? (
          <IconBusy />
        ) : (
          <IconSuccess />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="break-all text-ui-sm text-primary">{toast.message}</p>
        {toast.actions.length === 0 ? null : (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {toast.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.run}
                className="flex h-6 items-center rounded-row px-2 text-ui-sm text-primary hover:bg-hover"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        aria-label={t.common.close}
        title={t.common.close}
        onClick={onDismiss}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-tertiary hover:bg-hover hover:text-secondary"
      >
        <IconClose />
      </button>
    </div>
  );
}
