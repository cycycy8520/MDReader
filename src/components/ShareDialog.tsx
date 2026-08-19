/**
 * 分享面板 —— FR-10（微信）/ FR-11（飞书默认通道）/ FR-18（钉钉）的唯一交互入口，M3 批次。
 *
 * 【为什么必须分成两组，而不是一排「分享到微信 / 飞书 / 钉钉」】
 * 事实库 #6 与 DG 2.3-1 是确定性平台约束，不是风险：
 *   - 微信 / 企业微信 / 钉钉的**聊天窗口**只取 `text/plain`，粘贴富文本必掉排版；
 *   - 公众号图文编辑器、飞书文档、钉钉文档这类**富文本容器**才认 CF_HTML。
 * 所以本面板按「收件端是什么」分组，而不是按「哪个 App」分组。
 * 一个笼统的「分享到微信」按钮必然骗人：它在群聊里塌成纯文本，在公众号里却好好的，
 * 用户只会以为是我们的 bug。文案也据此逐条写清适用场景（DG 10-1 的文案纪律）。
 *
 * 【职责边界】
 *   本文件            选项 UI + 组装载荷 + 调注入的后端能力 + 把结果交回调用方；
 *   shareRichText.ts  离屏渲染 → 计算样式内联 → 产出可粘贴的 HTML 片段；
 *   App.tsx           何时唤起（右键菜单「分享 ▸」/ 顶栏分享钮）、结果 toast、Esc 语义链；
 *   ipc.ts            copy_rich_text / capture_long_image / copy_file_to_clipboard 的封装。
 *
 * 【为什么后端能力走 props 注入而不是直接 import ipc】
 * 本批次只拥有 share/mod.rs 与本目录下的新组件；ipc.ts 由主控统一接线（长图那条
 * 还依赖并行批次的 capture.rs）。注入式契约让本组件能独立编译与独立测试，
 * 也让「某条通道尚未就绪」变成一个显式的 `null` 而不是一个运行期才炸的 invoke——
 * 传 null 即如实置灰，绝不交付点了报错的菜单项。
 *
 * 【视觉】沿用导出对话框那张卡的语义类（rounded-card / border-float / bg-layer /
 * shadow-lv3），一个新 CSS 类都不加；交互反馈只换背景色、不加 transition。
 *
 * 纪律：不 import @tauri-apps/api（ESLint 强制）；不写内联中文文案（注释除外），
 * 全部取自 i18n/zh-CN.ts 的 shareDialog 组。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { t } from "../i18n/zh-CN";
import { composeSegments, decodePngToRgba } from "../render/longImage";
import { buildRichText, type RichTextPayload, type RichTextResult, type ShareTarget } from "./shareRichText";
import { describeError, useFileSessionStore } from "../stores/fileSession";
import { useSettingsStore } from "../stores/settings";

/* ── 对外契约（App.tsx / contextMenuItems.ts 按这些类型接线） ── */

export interface ShareRequest {
  /** 当前文档的绝对路径：长图另存的默认落点以它为基准 */
  readonly sourcePath: string;
}

/** 长图请求，与 Rust `capture::CaptureOptions` 逐字段对齐（camelCase wire 格式） */
export interface LongImageRequest {
  /** 待渲染的 .md 绝对路径。capture.rs 缺它会直接报配置错，不猜也不截主窗口 */
  readonly source: string;
  readonly width: number;
  /** null = 不落盘，PNG 经 `pngBase64` 回传前端 */
  readonly output: string | null;
  readonly deviceScaleFactor: number;
}

/**
 * Rust `capture::CaptureResult` 中**本面板真正消费的那几个字段**。
 * 刻意不把 `widthPx` / `elapsedMs` 也抄一遍：结构化类型下多出来的字段照样可赋值，
 * 少抄一个字段就少一处将来会漂移的契约。
 */
export interface LongImageResult {
  /** 实际落盘的文件（`output` 为 null 时为空数组） */
  readonly outputs: readonly string[];
  /** 分段张数；>1 = 超过 GPU 纹理上限被切开 */
  readonly segments: number;
  /** capture.rs 当前恒为 false（Rust 侧写不了图片剪贴板，见该文件注释） */
  readonly copiedToClipboard: boolean;
  /** 仅当 `output` 为 null：逐段 PNG 的 base64，顺序即拼接顺序 */
  readonly pngBase64?: readonly string[];
}

/** 与 Rust `share::FileClipboardResult` 对齐 */
export interface FileClipboardResult {
  readonly fileCount: number;
}

/** 写进剪贴板的位图（tauri `JsImage::Rgba` 变体，不需要 `image-png` feature） */
export interface ClipboardImage {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * 注入的后端能力。**为 null 即视为该通道尚未就绪**，对应入口如实置灰。
 * 主控接线时按 ipc.ts 的封装逐个填上；capture.rs 未实装期间 `captureLongImage` 传 null。
 */
export interface ShareBackend {
  readonly copyRichText: (payload: RichTextPayload) => Promise<RichTextResult>;
  readonly captureLongImage: ((request: LongImageRequest) => Promise<LongImageResult>) | null;
  /**
   * 位图写剪贴板（clipboard-manager 的 `writeImage`）。
   * 长图的剪贴板一环**必须由前端完成**：Rust 侧的 `write_image` 要 RGBA，
   * 而 PNG→RGBA 解码被 tauri 的 `image-png` feature 门着（capture.rs 已写明理由）。
   * 解码在本文件里做（canvas），这里只负责把 RGBA 交出去。
   */
  readonly writeImageToClipboard: ((image: ClipboardImage) => Promise<void>) | null;
  /** 长图已落盘时的兜底：把 PNG 文件放进 CF_HDROP，用户照样能 Ctrl+V 进聊天窗口 */
  readonly copyFileToClipboard:
    | ((paths: readonly string[]) => Promise<FileClipboardResult>)
    | null;
  /** 「另存长图…」的保存对话框；无权限/未接线时传 null（该入口置灰，复制通道不受影响） */
  readonly pickImagePath: ((defaultPath: string) => Promise<string | null>) | null;
}

/**
 * 分享结局。形状与 ExportOutcome 保持一致，App 可以复用同一个 ExportToast 渲染，
 * 不必为分享再造一套提示条。
 */
export type ShareOutcome =
  | { readonly ok: true; readonly message: string; readonly output?: string }
  | { readonly ok: false; readonly message: string };

export interface ShareDialogProps {
  readonly request: ShareRequest;
  readonly backend: ShareBackend;
  /** 生成中/结束的开关。App 据此决定 Esc 与遮罩点击是否放行（进行中关掉只会丢反馈） */
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
  readonly onDone: (outcome: ShareOutcome) => void;
}

/* ── 常量（技术值，不是文案） ─────────────────────────────── */

/** 微信长图版式宽度（DG 8「微信分享」行 / Rust `capture::WECHAT_IMAGE_WIDTH_PX`） */
const LONG_IMAGE_WIDTH = 720;

/**
 * 长图的设备像素比。取 2 而不是 capture.rs 的默认 1：720px 宽的 1× 长图在
 * 手机上看正文就是一团糊，而 2× 只是把 PNG 体积翻两三倍，聊天窗口完全吃得下。
 */
const LONG_IMAGE_SCALE = 2;

/* ── 路径工具 ───────────────────────────────────────────────── */

/**
 * 换扩展名（`D:\笔记\周报.md` → `D:\笔记\周报.png`）。
 * 只认最后一个点，且必须出现在最后一个分隔符之后——
 * `D:\v1.2\周报`（目录名带点、文件名没扩展名）不能被误切成 `D:\v1.png`。
 */
function withExtension(path: string, extension: string): string {
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dot = path.lastIndexOf(".");
  const stem = dot > separator + 1 ? path.slice(0, dot) : path;
  return `${stem}.${extension}`;
}

/** 取文件名（结果 toast 里只报名字，绝对路径太长会把提示条撑爆） */
function baseNameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index >= 0 ? path.slice(index + 1) : path;
}

/** 取父目录（本地图片相对路径的解析基准）；无分隔符（裸文件名）返回 null */
function parentDirOf(path: string): string | null {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : null;
}

/* ── 长图 base64 → 剪贴板位图 ───────────────────────────────── */

/**
 * 把 Rust 分段回传的 PNG base64 拼成一张、再解成 RGBA。
 *
 * 拼接与解码都直接复用 `render/longImage.ts`（同批次已实现）——那两个函数是长图链路的
 * 既有资产，重写一遍只会多出第二套 canvas 上限判断与第二种失败语义。
 *
 * `head` 为 true 时只取第一段：整篇拼起来超出 Chromium 的 canvas 上限时的退路，
 * 让用户至少能发出前半篇（并由调用方如实说明只复制了第 1 张）。
 */
async function segmentsToClipboardImage(
  segments: readonly string[],
  head: boolean,
): Promise<ClipboardImage> {
  const composed = await composeSegments(head ? segments.slice(0, 1) : segments);
  return decodePngToRgba(composed.bytes);
}

/* ── 图标（与 ExportDialog/ContextMenu 同一套画法：24 视窗 / stroke 1.5 / currentColor） ── */

function Glyph({ size, children }: { readonly size: number; readonly children: ReactNode }) {
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

/** 长图：一张竖向的图片 */
function IconLongImage() {
  return (
    <Glyph size={16}>
      <rect x="5" y="3" width="14" height="18" rx="2.5" />
      <path d="M8 13.5 10.5 11l2.5 2.5 2-2 2 2" />
      <circle cx="9.5" cy="7.5" r="1.2" />
    </Glyph>
  );
}

/** 另存：向下的箭头进托盘 */
function IconSave() {
  return (
    <Glyph size={16}>
      <path d="M12 4v9m0 0 3.2-3.2M12 13l-3.2-3.2" />
      <path d="M5 15.5v2.2A2.3 2.3 0 0 0 7.3 20h9.4a2.3 2.3 0 0 0 2.3-2.3v-2.2" />
    </Glyph>
  );
}

/** 富文本：两张叠起来的稿纸 */
function IconRichText() {
  return (
    <Glyph size={16}>
      <rect x="4" y="3" width="11" height="14" rx="2" />
      <path d="M9 20h8a2 2 0 0 0 2-2V8" />
      <path d="M7 7h5M7 10.5h5M7 14h3" />
    </Glyph>
  );
}

/** 按钮内的 10px 微 spinner：颜色跟随按钮文字（与 ExportDialog 同一实现） */
function MicroSpinner() {
  return (
    <span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 animate-spin-micro rounded-full border-[1.5px]"
      style={{ borderColor: "currentColor", borderTopColor: "transparent" }}
    />
  );
}

/* ── 一行分享入口 ───────────────────────────────────────────── */

interface ShareRowProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly hint: string;
  /** 置灰原因；非空即置灰（并作为 title 显示，不做"看起来能点、点了没反应"的按钮） */
  readonly disabledReason: string | null;
  readonly busy: boolean;
  /** 面板里已经有别的动作在跑：本行不置灰但不可点（避免并发写剪贴板互相覆盖） */
  readonly blocked: boolean;
  readonly onRun: () => void;
}

function ShareRow({ icon, label, hint, disabledReason, busy, blocked, onRun }: ShareRowProps) {
  const disabled = disabledReason !== null;
  const inert = disabled || blocked;
  // 正在跑的那一行保持原亮度（它有 spinner），其余行淡下去——
  // 不淡的话用户会以为自己点了没反应，那正是批次 1 清零过的那类死交互
  const dimmed = disabled || (blocked && !busy);
  return (
    <button
      type="button"
      aria-disabled={inert ? true : undefined}
      title={disabledReason ?? undefined}
      onClick={inert ? undefined : onRun}
      className={`flex w-full items-start gap-2 rounded-row px-2 py-1.5 text-left ${
        dimmed ? "cursor-default opacity-40" : inert ? "cursor-default" : "hover:bg-hover"
      }`}
    >
      <span
        aria-hidden
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-tertiary"
      >
        {busy ? <MicroSpinner /> : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui text-primary">{label}</span>
        <span className="block text-ui-xs text-tertiary">
          {disabled ? disabledReason : hint}
        </span>
      </span>
    </button>
  );
}

/* ── 面板本体 ───────────────────────────────────────────────── */

/** 正在跑的动作标识；null = 空闲 */
type RunningAction =
  | null
  | "image-copy"
  | "image-save"
  | `rich:${ShareTarget}`;

export function ShareDialog({
  request,
  backend,
  onBusyChange,
  onClose,
  onDone,
}: ShareDialogProps) {
  const [running, setRunning] = useState<RunningAction>(null);
  /** 进行中的一行说明（排版 / 截图 / 写剪贴板三个阶段，>1s 的动作不能没有反馈） */
  const [stage, setStage] = useState<string | null>(null);

  /** 面板被卸载后不再 setState（后端仍在跑，结果由 onDone 交给 App） */
  const mounted = useRef(true);
  /** 关闭面板即中止排版（渲染一篇 10MB 文档要好几秒，用户已经走了就别占着 CPU） */
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  useEffect(() => {
    onBusyChange(running !== null);
  }, [running, onBusyChange]);

  /**
   * 统一的动作外壳：置忙 → 跑 → 成功/失败都交给 onDone。
   * 失败一律走 describeError：Rust 的 AppError.message 已是中文，原样交给 toast 比
   * 硬套一句「分享失败」有用得多（用户至少知道是权限、是文件没了、还是体积超限）。
   */
  const run = useCallback(
    (
      action: Exclude<RunningAction, null>,
      // 返回 null = 用户自己取消（保存框按了取消），什么都不该发生，也不该弹提示
      task: () => Promise<ShareOutcome | null>,
    ) => {
      if (running !== null) {
        return;
      }
      setRunning(action);
      setStage(null);
      void (async () => {
        try {
          const outcome = await task();
          if (outcome !== null) {
            onDone(outcome);
          }
        } catch (error: unknown) {
          // 中止（切文档 / 关面板）不是失败：渲染管线抛的是 DOMException("AbortError")
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          console.warn("[share] action failed", action, error);
          onDone({ ok: false, message: describeError(error).message });
        } finally {
          if (mounted.current) {
            setRunning(null);
            setStage(null);
          }
        }
      })();
    },
    [onDone, running],
  );

  /* ── 富文本：排版 → 内联 → 写 CF_HTML ── */

  const copyRich = useCallback(
    (target: ShareTarget) => {
      run(`rich:${target}`, async () => {
        const controller = new AbortController();
        abort.current = controller;
        const session = useFileSessionStore.getState();
        setStage(t.shareDialog.preparing);
        // 变量名刻意不叫 document：那会遮蔽全局 document，而本组件下游还要用它
        const article = await buildRichText({
          source: session.source,
          baseDir: parentDirOf(request.sourcePath),
          encoding: session.encoding ?? "utf8",
          frontmatterDisplay: useSettingsStore.getState().frontmatterDisplay,
          isLarge: session.isLarge,
          signal: controller.signal,
        });
        if (mounted.current) {
          setStage(t.shareDialog.copying);
        }
        const result = await backend.copyRichText({
          html: article.html,
          plainText: article.plainText,
          target,
          assets: article.assets,
        });
        // 少带了图必须当场说：否则用户会把一篇缺图的稿子直接发出去
        return {
          ok: true,
          message:
            result.skippedImages > 0
              ? t.shareDialog.copiedRichTextPartial(result.skippedImages)
              : t.shareDialog.copiedRichText,
        };
      });
    },
    [backend, request.sourcePath, run],
  );

  /* ── 长图：截图 → 剪贴板 / 落盘 ── */

  const copyLongImage = useCallback(() => {
    const capture = backend.captureLongImage;
    if (capture === null) {
      return;
    }
    run("image-copy", async () => {
      setStage(t.shareDialog.capturing);
      const result = await capture({
        source: request.sourcePath,
        width: LONG_IMAGE_WIDTH,
        output: null,
        deviceScaleFactor: LONG_IMAGE_SCALE,
      });
      if (result.copiedToClipboard) {
        return { ok: true, message: t.shareDialog.copiedImage };
      }
      if (mounted.current) {
        setStage(t.shareDialog.copying);
      }

      // 路线 A（capture.rs 当前实现）：后端回传逐段 PNG base64，前端拼接+解码后写剪贴板
      const segments = result.pngBase64 ?? [];
      const writeImage = backend.writeImageToClipboard;
      if (segments.length > 0 && writeImage !== null) {
        try {
          await writeImage(await segmentsToClipboardImage(segments, false));
          return { ok: true, message: t.shareDialog.copiedImage };
        } catch (error: unknown) {
          // 多半是整篇拼起来超出了 Chromium 的 canvas 上限；技术原因对用户没意义，落日志
          console.warn("[share] compose long image failed", error);
        }
        // 退路：只复制第一段，并如实说清「只有第 1 张」+ 完整版怎么拿。
        // 能发出去的半张，远胜于一句「分享失败」。
        if (segments.length > 1) {
          try {
            await writeImage(await segmentsToClipboardImage(segments, true));
            return {
              ok: true,
              message: t.shareDialog.copiedImageFirstOfMany(segments.length),
            };
          } catch (error: unknown) {
            console.warn("[share] copy first long image segment failed", error);
          }
        }
        return { ok: false, message: t.shareDialog.failed };
      }

      // 路线 B：后端已落盘（将来若 capture.rs 改成写临时文件），走 CF_HDROP
      const copyFiles = backend.copyFileToClipboard;
      if (copyFiles !== null && result.outputs.length > 0) {
        await copyFiles(result.outputs);
        return { ok: true, message: t.shareDialog.copiedImage };
      }
      return { ok: false, message: t.shareDialog.failed };
    });
  }, [backend, request.sourcePath, run]);

  const saveLongImage = useCallback(() => {
    const capture = backend.captureLongImage;
    const pick = backend.pickImagePath;
    if (capture === null || pick === null) {
      return;
    }
    run("image-save", async () => {
      const picked = await pick(withExtension(request.sourcePath, "png"));
      if (picked === null || picked === "") {
        // 用户在保存框里按了取消：什么都别做，也别弹提示
        return null;
      }
      setStage(t.shareDialog.capturing);
      const result = await capture({
        source: request.sourcePath,
        width: LONG_IMAGE_WIDTH,
        output: picked,
        deviceScaleFactor: LONG_IMAGE_SCALE,
      });
      const first = result.outputs[0] ?? picked;
      return {
        ok: true,
        output: first,
        message:
          result.segments > 1
            ? t.shareDialog.savedImageSegments(result.segments)
            : t.shareDialog.savedImage(baseNameOf(first)),
      };
    });
  }, [backend, request.sourcePath, run]);

  /* ── 置灰理由（如实告知，不做假按钮） ── */

  const longImageBlocked =
    backend.captureLongImage === null ? t.shareDialog.longImageUnavailable : null;
  // 截得出图但递不进剪贴板，等于点了没用：两条写入路径都没有就一并置灰
  const copyImageBlocked =
    longImageBlocked ??
    (backend.writeImageToClipboard === null && backend.copyFileToClipboard === null
      ? t.shareDialog.clipboardImageUnavailable
      : null);
  const saveBlocked =
    longImageBlocked ?? (backend.pickImagePath === null ? t.shareDialog.saveUnavailable : null);

  const busy = running !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-mask p-6 animate-fade-in"
      // 生成中点遮罩不关窗：后端停不下来，关掉只会丢掉唯一的进度反馈
      onClick={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.shareDialog.title}
        aria-busy={busy ? true : undefined}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-card border border-float bg-layer p-4 shadow-lv3"
      >
        <p className="text-ui font-medium text-primary">{t.shareDialog.title}</p>

        {/* 第一组：聊天窗口 —— 只有长图能保住排版（DG 2.3-1，平台确定性行为） */}
        <p className="mt-3 text-ui-sm text-secondary">{t.shareDialog.chatTitle}</p>
        <p className="mt-0.5 text-ui-xs text-tertiary">{t.shareDialog.chatHint}</p>
        <div className="mt-1">
          <ShareRow
            icon={<IconLongImage />}
            label={t.shareDialog.chatCopy}
            hint={t.shareDialog.chatCopyHint}
            disabledReason={copyImageBlocked}
            busy={running === "image-copy"}
            blocked={busy}
            onRun={copyLongImage}
          />
          <ShareRow
            icon={<IconSave />}
            label={t.shareDialog.chatSave}
            hint={t.shareDialog.chatSaveHint}
            disabledReason={saveBlocked}
            busy={running === "image-save"}
            blocked={busy}
            onRun={saveLongImage}
          />
        </div>

        {/* 第二组：富文本容器 —— CF_HTML 在这里才成立 */}
        <p className="mt-3 text-ui-sm text-secondary">{t.shareDialog.richTitle}</p>
        <p className="mt-0.5 text-ui-xs text-tertiary">{t.shareDialog.richHint}</p>
        <div className="mt-1">
          <ShareRow
            icon={<IconRichText />}
            label={t.shareDialog.richWechatMp}
            hint={t.shareDialog.richWechatMpHint}
            disabledReason={null}
            busy={running === "rich:wechat-mp"}
            blocked={busy}
            onRun={() => {
              copyRich("wechat-mp");
            }}
          />
          <ShareRow
            icon={<IconRichText />}
            label={t.shareDialog.richLark}
            hint={t.shareDialog.richLarkHint}
            disabledReason={null}
            busy={running === "rich:lark"}
            blocked={busy}
            onRun={() => {
              copyRich("lark");
            }}
          />
          <ShareRow
            icon={<IconRichText />}
            label={t.shareDialog.richDingtalk}
            hint={t.shareDialog.richDingtalkHint}
            disabledReason={null}
            busy={running === "rich:ding-talk"}
            blocked={busy}
            onRun={() => {
              copyRich("ding-talk");
            }}
          />
        </div>

        {/* 不保真项如实前置：与其让用户粘完才发现公式没了，不如现在就说 */}
        <p className="mt-2 text-ui-xs text-tertiary">{t.shareDialog.fragileHint}</p>

        <div className="mt-4 flex items-center justify-end gap-1">
          {stage !== null ? (
            <span className="mr-auto min-w-0 truncate text-ui-xs text-tertiary animate-fade-in">
              {stage}
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
            {t.common.close}
          </button>
        </div>
      </div>
    </div>
  );
}
