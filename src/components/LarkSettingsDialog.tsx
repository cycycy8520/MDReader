/**
 * 飞书凭据设置对话框 —— FR-11「进阶通道」的唯一配置入口，M3 批次。
 *
 * 【这张卡为什么长这样】后端（settings.rs + share/lark.rs）的三条契约直接决定了界面顺序，
 * 不是排版偏好：
 *   1. `test_lark_connection()` **无入参**——它测的是磁盘上那份已保存的凭据，
 *      而不是输入框里的草稿。所以流程只能是「先保存、再测试」，未保存时
 *      「测试连接」必须置灰并说清原因（用户对着一个不能点的按钮猜，比没有这个按钮更糟）。
 *   2. 密钥**永不回显**：`lark_credential_status()` 只回打码后的 appId，后端压根不提供
 *      把 secret 读回前端的能力（settings.rs 写明：解出来送进 WebView 就等于暴露给
 *      DevTools 与任何一处 console.log，再也收不回来）。因此本卡的两个输入框
 *      **永远从空开始**，是一张「替换凭据」的表单，不是「当前值」的镜像。
 *   3. `save_lark_credential` 要求 appId 与 secret **同时非空**（空的一侧直接报 config 错），
 *      也没有「只改 appId」的偏路径。所以两栏必须同填同交：只填一栏时保存按钮置灰，
 *      并如实说明「密钥不回显，无法只改其一」——而不是让用户点下去吃一个后端错误。
 *
 * 【为什么直接 import ipc 而不是像 ShareDialog 那样注入】ShareDialog 成文时 capture.rs
 * 还没实装，注入是为了让「通道未就绪」变成一个显式的 null。飞书这条链后端已全部实装，
 * ipc.ts 也已封装齐全，再包一层注入只是多一份会漂移的契约。
 *
 * 【职责边界】
 *   本文件   凭据表单 + 保存/测试/解除三个动作 + 结果就地反馈；
 *   App.tsx  从哪儿唤起（设置入口）、Esc 语义链、以及拿 onDone 回传的状态去决定
 *            「导入飞书」那个入口该亮还是该灰；
 *   ipc.ts   save/status/clear/test 四个命令的封装。
 * 结果**不走 toast**：卡片不会因为保存成功而关闭（多数人保存完紧接着就要测一次连接），
 * 反馈就该留在卡里，跟着表单一起看。
 *
 * 【视觉】沿用导出/分享那张卡的语义类（rounded-card / border-float / bg-layer / shadow-lv3），
 * 输入框沿用左栏搜索框的写法（h-input / rounded-row / border / bg-card / focus-within:border-brand），
 * 一个新 CSS 类都不加；交互反馈只换背景色、不加 transition。
 *
 * 【右键菜单】两个输入框**刻意不挂 onContextMenu**：App 的全局委托对
 * `input, textarea, [contenteditable]` 一律 return 且不 preventDefault（见 App.tsx 的
 * NATIVE_MENU_SELECTOR），系统的粘贴菜单与输入法候选菜单因此原样保留。
 * 在这里自绘一套只会把粘贴这条路堵死——而 App Secret 几乎必然是粘贴进来的。
 *
 * 纪律：不 import @tauri-apps/api（ESLint 强制，一律走 services/ipc.ts）；
 * 不写内联中文文案（注释除外），全部取自 i18n/zh-CN.ts 的 larkSettings 组；
 * 严格只读红线不受影响——本卡只写自己的凭据文件，不碰用户的 .md。
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { t } from "../i18n/zh-CN";
import {
  clearLarkCredential,
  larkCredentialStatus,
  saveLarkCredential,
  testLarkConnection,
} from "../services/ipc";
import { describeError } from "../stores/fileSession";
import type { LarkCredentialStatus } from "../types";

/* ── 对外契约（App.tsx 按这个形状接线，与 ExportDialog 同构） ── */

export interface LarkSettingsDialogProps {
  /**
   * 保存 / 测试 / 解除进行中的开关。App 据此决定 Esc 与遮罩点击是否放行——
   * 动作进行中关掉卡片并不能让后端停下来，只会让用户失去唯一的进度反馈。
   */
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
  /**
   * 凭据状态**每次发生变化**时回调（保存成功 / 解除成功 / 测试成功后各一次），
   * 不是"关闭时结算一次"。App 拿它刷新「导入飞书」入口的可用性：
   * 未配置时那个入口必须置灰，配好了就该当场亮起来，而不是等用户关掉这张卡。
   */
  readonly onDone: (status: LarkCredentialStatus) => void;
}

/* ── 内部状态（技术值，不是文案） ─────────────────────────────── */

/** 正在跑的动作；null = 空闲。初次读状态不算在内（那期间 Esc 照常可用） */
type Running = null | "saving" | "testing" | "clearing";

interface Feedback {
  readonly kind: "ok" | "error";
  /** 主句：失败时**原样透出**后端文案（api 类里已带飞书的 code + msg） */
  readonly message: string;
  /** 按错误 kind 追加的下一步；成功或无对应建议时为 null */
  readonly hint: string | null;
}

/**
 * 后端 AppError.kind → 一句「接下来做什么」。
 *
 * 只做**追加**，绝不替换主句：飞书业务错误里那串 code + msg 是排查的唯一线索，
 * 换成我们自己编的一句「导入失败」等于把它扔了。
 * kind 取值见 src-tauri/src/error.rs 的 `AppError::kind()`。
 */
function hintForKind(kind: string): string | null {
  switch (kind) {
    case "config":
      return t.larkSettings.hintConfig;
    case "api":
      return t.larkSettings.hintApi;
    case "http":
      return t.larkSettings.hintHttp;
    case "timeout":
      return t.larkSettings.hintTimeout;
    default:
      return null;
  }
}

function failureOf(error: unknown): Feedback {
  const described = describeError(error);
  return { kind: "error", message: described.message, hint: hintForKind(described.kind) };
}

/* ── 图标（与 Export/Share/ContextMenu 同一套画法：24 视窗 / stroke 1.5 / currentColor） ── */

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

/** 显示密钥：睁眼 */
function IconEye() {
  return (
    <Glyph size={14}>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </Glyph>
  );
}

/** 隐藏密钥：闭眼（斜线） */
function IconEyeOff() {
  return (
    <Glyph size={14}>
      <path d="M2.5 12S6 6.5 12 6.5c1.6 0 3 .4 4.2 1M21.5 12s-1.5 2.4-4.2 4" />
      <path d="M9.9 9.9a2.8 2.8 0 0 0 4 4" />
      <path d="M4 4l16 16" />
    </Glyph>
  );
}

/** 按钮内的 10px 微 spinner：颜色跟随按钮文字（与 Export/Share 同一实现） */
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

/* ── 次级动作按钮（测试连接 / 解除绑定） ───────────────────────── */

interface ActionButtonProps {
  readonly label: string;
  /** 置灰原因；非空即置灰并作为 title——不做"看起来能点、点了报错"的按钮 */
  readonly disabledReason: string | null;
  /** 本按钮自己正在跑（显示 spinner，保持原亮度） */
  readonly busy: boolean;
  /** 卡里已有别的动作在跑：本按钮不可点（点了也只会被 run 的守卫吞掉，那就是死交互） */
  readonly blocked: boolean;
  /** 危险动作（解除绑定）：文字与 hover 底色走 danger 语义 */
  readonly danger?: boolean;
  readonly onRun: () => void;
}

function ActionButton({
  label,
  disabledReason,
  busy,
  blocked,
  danger,
  onRun,
}: ActionButtonProps) {
  const inert = disabledReason !== null || blocked;
  // 正在跑的那个保持原亮度（它有 spinner），其余淡下去——
  // 不淡的话用户会以为自己点了没反应
  const dimmed = disabledReason !== null || (blocked && !busy);
  return (
    <button
      type="button"
      aria-disabled={inert ? true : undefined}
      title={disabledReason ?? undefined}
      onClick={inert ? undefined : onRun}
      className={`flex h-row items-center gap-1.5 rounded-row px-2 text-ui-sm ${
        danger === true ? "text-danger hover:bg-hover-danger" : "text-primary hover:bg-hover"
      } ${dimmed ? "cursor-default opacity-40" : inert ? "cursor-default" : ""}`}
    >
      {busy ? <MicroSpinner /> : null}
      {label}
    </button>
  );
}

/* ── 对话框本体 ─────────────────────────────────────────────── */

export function LarkSettingsDialog({ onBusyChange, onClose, onDone }: LarkSettingsDialogProps) {
  /** null = 还没读到（首帧就是它，避免先闪一下"未配置"再跳成"已绑定"） */
  const [status, setStatus] = useState<LarkCredentialStatus | null>(null);
  /** 状态读不出来（命令未注册 / 数据目录不可读）：如实说，并给一个重试出路 */
  const [statusFailed, setStatusFailed] = useState(false);

  /**
   * 两个输入框**永远从空开始**：secret 后端不提供读回能力，appId 也只有打码值，
   * 预填任何一个都会变成"看起来是当前值、其实是我编的"。
   */
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const [running, setRunning] = useState<Running>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** 解除绑定的二次确认（自绘，不弹系统对话框） */
  const [confirmUnbind, setConfirmUnbind] = useState(false);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const appIdRef = useRef<HTMLInputElement | null>(null);
  const saveRef = useRef<HTMLButtonElement | null>(null);
  /** 只抢一次焦点：状态刷新（保存/测试之后）不该把焦点从用户手里夺走 */
  const focusClaimed = useRef(false);
  /** 卡片卸载后不再 setState（动作仍在后端跑） */
  const mounted = useRef(true);

  const appIdInputId = useId();
  const appSecretInputId = useId();

  const busy = running !== null;
  const configured = status?.configured === true;
  /** 输入框里有草稿 = 有尚未保存的改动（输入框恒从空开始，所以非空即脏） */
  const dirty = appId.trim() !== "" || appSecret !== "";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 忙碌位上抛给 App（Esc / 遮罩点击据此放行或吃掉）
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  /* ── 读状态 ── */

  const loadStatus = useCallback(() => {
    void (async () => {
      try {
        const next = await larkCredentialStatus();
        if (mounted.current) {
          setStatus(next);
          setStatusFailed(false);
        }
      } catch (error: unknown) {
        // 读不出状态不是致命的：保存那条路仍然可以走，所以只标记、不封面板
        console.warn("[lark] credential status failed", error);
        if (mounted.current) {
          setStatus(null);
          setStatusFailed(true);
        }
      }
    })();
  }, []);

  useEffect(loadStatus, [loadStatus]);

  /**
   * 首次拿到结果后落一次焦点。
   * 未配置时焦点给 App ID 输入框——那时"主按钮"必然是置灰的保存钮，把焦点放上去
   * 等于什么都没聚焦；已配置时才把焦点交给主按钮，键盘用户一路 Tab 就能走完。
   */
  useEffect(() => {
    if (focusClaimed.current) {
      return;
    }
    if (status === null && !statusFailed) {
      return;
    }
    focusClaimed.current = true;
    if (status?.configured === true) {
      saveRef.current?.focus();
    } else {
      appIdRef.current?.focus();
    }
  }, [status, statusFailed]);

  /* ── 键盘：Esc（进行中吃掉）+ Tab 焦点陷阱（DG 6.5） ── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      // 捕获阶段一律吃掉：本卡是最上层，App 的 Esc 语义链不该同时响应
      event.preventDefault();
      event.stopPropagation();
      // 确认条开着：Esc 先撤确认（这是用户最可能想要的"上一步"）
      if (confirmUnbind) {
        setConfirmUnbind(false);
        return;
      }
      // 动作进行中：后端停不下来，关掉只会丢掉唯一的进度反馈
      if (running !== null) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [confirmUnbind, onClose, running]);

  const onTrapKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") {
      return;
    }
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    const focusables = Array.from(
      card.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"),
    );
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  /* ── 三个动作 ── */

  /** 统一外壳：置忙 → 跑 → 成功/失败都落进卡内反馈（不弹 toast，卡片不关） */
  const run = useCallback(
    (action: Exclude<Running, null>, task: () => Promise<Feedback>) => {
      if (running !== null) {
        return;
      }
      setRunning(action);
      setFeedback(null);
      // 有别的动作开跑，悬着的解除确认就该撤掉（用户显然改主意了）
      setConfirmUnbind(false);
      void (async () => {
        let result: Feedback;
        try {
          result = await task();
        } catch (error: unknown) {
          // Rust AppError.message 已是面向用户的中文，原样透出比套一句"操作失败"有用得多
          console.warn("[lark] action failed", action, error);
          result = failureOf(error);
        }
        if (mounted.current) {
          setFeedback(result);
          setRunning(null);
        }
      })();
    },
    [running],
  );

  /** 保存后立刻回读一次状态：打码 appId 与 token 缓存位都以后端为准，不在前端猜 */
  const syncStatus = useCallback(async () => {
    const next = await larkCredentialStatus();
    if (mounted.current) {
      setStatus(next);
      setStatusFailed(false);
    }
    onDone(next);
  }, [onDone]);

  const runSave = useCallback(() => {
    run("saving", async () => {
      await saveLarkCredential({ appId: appId.trim(), appSecret: appSecret.trim() });
      // 表单回到"空 = 不修改"的初始约定；当前绑定的是谁，交给上方的状态行说
      if (mounted.current) {
        setAppId("");
        setAppSecret("");
        setShowSecret(false);
      }
      await syncStatus();
      return { kind: "ok", message: t.larkSettings.saved, hint: null };
    });
  }, [appId, appSecret, run, syncStatus]);

  const runTest = useCallback(() => {
    run("testing", async () => {
      await testLarkConnection();
      // 测试成功时后端顺手写了 token 缓存，状态行要跟着变
      await syncStatus();
      return { kind: "ok", message: t.larkSettings.tested, hint: null };
    });
  }, [run, syncStatus]);

  const runUnbind = useCallback(() => {
    setConfirmUnbind(false);
    run("clearing", async () => {
      await clearLarkCredential();
      if (mounted.current) {
        setAppId("");
        setAppSecret("");
        setShowSecret(false);
      }
      await syncStatus();
      return { kind: "ok", message: t.larkSettings.unbound, hint: null };
    });
  }, [run, syncStatus]);

  /* ── 置灰理由（如实告知，绝不交付点了报错的入口） ── */

  const idFilled = appId.trim() !== "";
  const secretFilled = appSecret.trim() !== "";
  /** 只填了一栏：既不是"没改"，也不是"能保存"，要单独说清楚（见下） */
  const partiallyFilled = idFilled !== secretFilled;

  /**
   * 保存：两栏同填同交。
   * 后端 `save_lark_credential` 对空值直接报 config 错，且没有"只改 appId"的偏路径——
   * 密钥不回显，我们也拿不出旧值来补，所以只填一栏时这里就得拦住并说清楚。
   */
  const saveDisabledReason = partiallyFilled
    ? t.larkSettings.savePartial
    : idFilled && secretFilled
      ? null
      : configured
        ? t.larkSettings.saveNothingChanged
        : t.larkSettings.saveNeedsBoth;

  /**
   * 测试连接：`test_lark_connection()` 无入参，测的永远是磁盘上那份。
   * 所以未保存时不可点；有未保存草稿时同样不可点——那时测出来的"正常"说的是旧凭据，
   * 比测不了更误导。
   */
  const testDisabledReason = !configured
    ? t.larkSettings.testNeedsSave
    : dirty
      ? t.larkSettings.testNeedsSaveDraft
      : null;

  const unbindDisabledReason = configured ? null : t.larkSettings.unbindNeedsConfigured;

  /* ── 状态行文案 ── */

  const statusText = statusFailed
    ? t.larkSettings.statusLoadFailed
    : status === null
      ? t.larkSettings.statusLoading
      : status.configured
        ? t.larkSettings.statusConfigured(status.appIdMasked ?? t.larkSettings.appIdUnknown)
        : t.larkSettings.statusNotConfigured;

  const tokenText =
    status !== null && status.configured
      ? status.hasCachedToken
        ? t.larkSettings.tokenCached
        : t.larkSettings.tokenNotCached
      : null;

  const runningText =
    running === "saving"
      ? t.larkSettings.saving
      : running === "testing"
        ? t.larkSettings.testing
        : running === "clearing"
          ? t.larkSettings.unbinding
          : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-mask p-6 animate-fade-in"
      // 动作进行中点遮罩不关窗：后端停不下来，关掉只会丢掉唯一的进度反馈
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.larkSettings.title}
        aria-busy={busy ? true : undefined}
        onKeyDown={onTrapKeyDown}
        // 卡内点击不该关窗（用户会在输入框里选中文本）
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-card border border-float bg-layer p-4 shadow-lv3"
      >
        <p className="text-ui font-medium text-primary">{t.larkSettings.title}</p>
        <p className="mt-1 text-ui-xs text-tertiary">{t.larkSettings.intro}</p>

        {/* 当前状态：已绑定哪个应用（只有打码值）+ token 缓存位 */}
        <div className="mt-3 flex items-center gap-2">
          <span className="w-16 shrink-0 text-ui-sm text-tertiary">
            {t.larkSettings.statusLabel}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-ui-sm ${
              statusFailed ? "text-warn" : "text-secondary"
            }`}
          >
            {statusText}
          </span>
          {statusFailed ? (
            <button
              type="button"
              onClick={loadStatus}
              className="flex h-row shrink-0 items-center rounded-row px-2 text-ui-sm text-primary hover:bg-hover"
            >
              {t.common.retry}
            </button>
          ) : null}
        </div>
        {tokenText === null ? null : (
          <p className="mt-0.5 pl-[72px] text-ui-xs text-tertiary">{tokenText}</p>
        )}

        {/* App ID */}
        <div className="mt-3">
          <label htmlFor={appIdInputId} className="block text-ui-sm text-tertiary">
            {t.larkSettings.appIdLabel}
          </label>
          <div className="mt-1 flex h-input items-center rounded-row border bg-card px-2.5 focus-within:border-brand">
            <input
              ref={appIdRef}
              id={appIdInputId}
              type="text"
              value={appId}
              onChange={(event) => {
                setAppId(event.target.value);
              }}
              placeholder={t.larkSettings.appIdPlaceholder}
              // 凭据不该进浏览器的自动填充与拼写检查库
              autoComplete="off"
              spellCheck={false}
              readOnly={busy}
              className="min-w-0 flex-1 border-none bg-transparent text-ui text-primary outline-none placeholder:text-caption"
            />
          </div>
        </div>

        {/* App Secret：type=password + 可切换显示；值只往下走，永不从后端读回来 */}
        <div className="mt-2">
          <label htmlFor={appSecretInputId} className="block text-ui-sm text-tertiary">
            {t.larkSettings.appSecretLabel}
          </label>
          <div className="mt-1 flex h-input items-center gap-1 rounded-row border bg-card pl-2.5 pr-1 focus-within:border-brand">
            <input
              id={appSecretInputId}
              type={showSecret ? "text" : "password"}
              value={appSecret}
              onChange={(event) => {
                setAppSecret(event.target.value);
              }}
              placeholder={t.larkSettings.appSecretPlaceholder}
              autoComplete="off"
              spellCheck={false}
              readOnly={busy}
              className="min-w-0 flex-1 border-none bg-transparent text-ui text-primary outline-none placeholder:text-caption"
            />
            <button
              type="button"
              aria-label={showSecret ? t.larkSettings.hideSecret : t.larkSettings.showSecret}
              title={showSecret ? t.larkSettings.hideSecret : t.larkSettings.showSecret}
              aria-pressed={showSecret}
              onClick={() => {
                setShowSecret(!showSecret);
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-tertiary hover:bg-hover hover:text-secondary"
            >
              {showSecret ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
        </div>

        {/* 表单说明：已配置时说清"留空 = 不动已保存的那份"；只填一栏时说清为什么不行 */}
        {partiallyFilled ? (
          <p className="mt-1 text-ui-xs text-warn">{t.larkSettings.savePartial}</p>
        ) : configured ? (
          <p className="mt-1 text-ui-xs text-tertiary">{t.larkSettings.appSecretKeepHint}</p>
        ) : null}

        {/* 次级动作：测试连接 / 解除绑定 */}
        <div className="mt-3 flex items-center gap-1">
          <ActionButton
            label={t.larkSettings.test}
            disabledReason={testDisabledReason}
            busy={running === "testing"}
            blocked={busy}
            onRun={runTest}
          />
          <ActionButton
            label={t.larkSettings.unbind}
            disabledReason={unbindDisabledReason}
            busy={running === "clearing"}
            blocked={busy}
            danger
            onRun={() => {
              setConfirmUnbind(true);
            }}
          />
        </div>
        {/* 「测试连接」为什么不能点，摆在按钮下面而不是只做 tooltip——
            tooltip 要悬停才看得见，而置灰的按钮多数人根本不会去悬停 */}
        {testDisabledReason === null || busy ? null : (
          <p className="mt-1 text-ui-xs text-tertiary">{testDisabledReason}</p>
        )}

        {/* 解除绑定的二次确认（自绘）：说清代价，再给一次反悔的机会 */}
        {confirmUnbind ? (
          <div className="mt-2 rounded-row border border-float bg-card p-2.5">
            <p className="text-ui-xs text-warn">{t.larkSettings.unbindConfirm}</p>
            <div className="mt-1.5 flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => {
                  setConfirmUnbind(false);
                }}
                className="flex h-row items-center rounded-row px-2 text-ui-sm text-primary hover:bg-hover"
              >
                {t.common.cancel}
              </button>
              <button
                type="button"
                onClick={runUnbind}
                className="flex h-row items-center rounded-row px-2 text-ui-sm text-danger hover:bg-hover-danger"
              >
                {t.larkSettings.unbindConfirmYes}
              </button>
            </div>
          </div>
        ) : null}

        {/* 配置引导：「配了却报权限不足」几乎全是第 2 条没做（改完权限没发新版本） */}
        <div className="mt-3 rounded-row bg-card p-2.5">
          <p className="text-ui-xs text-secondary">{t.larkSettings.guideTitle}</p>
          <ol className="mt-1 list-decimal pl-4 text-ui-xs text-tertiary">
            <li>{t.larkSettings.guideStep1}</li>
            <li className="mt-0.5">{t.larkSettings.guideStep2}</li>
          </ol>
        </div>

        {/* DPAPI 绑定当前 Windows 用户：便携版换机器/换账号必然解不开，
            不写在界面上就会被当成 bug 报回来 */}
        <p className="mt-2 text-ui-xs text-tertiary">{t.larkSettings.dpapiHint}</p>

        {/* 结果就地反馈：失败主句原样透出后端文案，按 kind 追加一句下一步 */}
        {feedback === null ? null : (
          <div className="mt-3 animate-fade-in" role="status">
            <p
              className={`break-all text-ui-sm ${
                feedback.kind === "error" ? "text-danger" : "text-success"
              }`}
            >
              {feedback.message}
            </p>
            {feedback.hint === null ? null : (
              <p className="mt-0.5 text-ui-xs text-tertiary">{feedback.hint}</p>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-1">
          {runningText === null ? null : (
            <span className="mr-auto min-w-0 truncate text-ui-xs text-tertiary animate-fade-in">
              {runningText}
            </span>
          )}
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
          <button
            ref={saveRef}
            type="button"
            aria-disabled={saveDisabledReason !== null || busy ? true : undefined}
            title={saveDisabledReason ?? undefined}
            onClick={saveDisabledReason !== null || busy ? undefined : runSave}
            className={`flex h-btn items-center gap-2 rounded-btn bg-brand px-3.5 text-ui font-medium text-inverted ${
              saveDisabledReason !== null || busy
                ? "cursor-default opacity-60"
                : "hover:bg-brand-hover"
            }`}
          >
            {running === "saving" ? <MicroSpinner /> : null}
            {running === "saving" ? t.larkSettings.saving : t.larkSettings.save}
          </button>
        </div>
      </div>
    </div>
  );
}
