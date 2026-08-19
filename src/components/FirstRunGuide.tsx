/**
 * 首启引导（设为默认查看器）—— DG F2 的 P0 部分 / DG 6.4-14 三步卡片式向导。
 *
 * 【为什么必须有这一页】Windows 10+ 的 UserChoice 键带系统哈希保护，
 * **应用无法把自己静默设为默认程序**（DG 2.3-2、红线 2：UserChoice 永不写入）。
 * 安装器只能把自己注册成「候选程序」，最后那一下必须由用户在系统设置里点。
 * 这是平台约束而不是缺陷，所以本页的措辞一律如实：
 *   - 不写「一键设为默认」，写「Windows 不允许应用自己设为默认，需要你手动选一次」；
 *   - 「打开系统设置」只承诺把设置页打开，不承诺设置结果；
 *   - 设完与否都能继续用，向导可跳过、可再次进入。
 *
 * 【三步】① 欢迎（一句话说清这是什么）→ ② 一键跳系统设置（图文说明）→ ③ 完成。
 * 已经是默认程序时（`queryDefaultApp().isSelf`）**整步跳过第二步**，末页显示「已是默认」。
 *
 * 【视觉与动效纪律】
 *   - 卡片 `rounded-modal`，主按钮 `bg-brand text-inverted rounded-btn h-btn`（DG 6.4-14）；
 *   - 步进切换 = 200ms 横向 transform（`duration-base` 恰为 200ms），只动 transform，
 *     不淡入淡出正文、不改卡片高度（三块面板同时存在，容器高度取最高的那块，切换时不跳）；
 *   - 整块 `animate-fade-in` 一次淡入，**不做 stagger、不画插画**（DG 6.4-12 / 全局条 C）——
 *     所以第二步的「图文说明」是编号步骤文字，不是动图；
 *   - 按钮 hover 只换底色且瞬时（军规 2）。
 *
 * 【首启标志存在哪】localStorage，键 [`FIRST_RUN_STORAGE_KEY`]。
 * 刻意**不**进 settings.json：那份契约由 Rust `settings::Settings` + TS `types/Settings`
 * + `SETTINGS_KEYS` 三处对拍单测锁死（少一个字段就静默丢设置），为一个布尔量去动契约
 * 不划算。代价是清空 WebView 数据后会再弹一次向导——一次可跳过的引导页，可以接受。
 * 若将来主控决定把它并进 settings 契约，只需替换本文件底部那两个读写函数。
 *
 * 纪律：不 import @tauri-apps/api（走 services/ipc），不写内联中文（注释除外），无 any。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { t } from "../i18n/zh-CN";
import { openDefaultAppsSettings, queryDefaultApp } from "../services/ipc";

/* ── 首启标志（本组件自带的一点点持久化） ───────────────────── */

/** localStorage 键名。加应用前缀，避免与将来别的 key 撞车 */
export const FIRST_RUN_STORAGE_KEY = "mdnaonao.firstRunDone";

/** 只用它当"已完成"的标记值；其余取值一律视为未完成 */
const FIRST_RUN_DONE_VALUE = "1";

/**
 * 是否该弹首启引导（= 从未走完/跳过过一次）。
 *
 * localStorage 不可用（隐私模式、WebView 存储被禁）时返回 false：
 * 宁可少弹一次，也不要每次启动都糊用户一脸——它毕竟只是引导，不是必经流程。
 */
export function shouldShowFirstRunGuide(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_STORAGE_KEY) !== FIRST_RUN_DONE_VALUE;
  } catch (error: unknown) {
    console.warn("[first-run] localStorage 不可读，按已完成处理", error);
    return false;
  }
}

/**
 * 记下"引导已经出现过"。走完、跳过、Esc 关掉都算——用户已经做出了选择，
 * 下次启动再弹一次就是纠缠。想重看的入口在空状态页（[`t.reading.setDefaultViewer`]）。
 */
export function markFirstRunDone(): void {
  try {
    window.localStorage.setItem(FIRST_RUN_STORAGE_KEY, FIRST_RUN_DONE_VALUE);
  } catch (error: unknown) {
    console.warn("[first-run] localStorage 不可写，首启标志未能保存", error);
  }
}

/* ── 常量（技术值，不是文案） ───────────────────────────────── */

/** 三步：欢迎 / 设默认 / 完成 */
const STEP_COUNT = 3;
const STEP_WELCOME = 0;
const STEP_DEFAULT = 1;
const STEP_DONE = 2;

/**
 * 只读检测的三种结局。
 *   checking —— 命令在飞（首帧就是它，避免第二步先闪一下"未设置"）
 *   self     —— 已是默认：第二步整步跳过
 *   other    —— 不是默认：正常走第二步
 *   unknown  —— 检测失败（命令未实现 / 注册表读不到）：**按 other 处理**，
 *               引导照走。读不到默认程序是常态而非错误（DG shell_integ 注释），
 *               不该因此把这条 P0 流程整个吞掉。
 */
type DefaultAppState = "checking" | "self" | "other" | "unknown";

interface PanelSpec {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** 标题与正文之外的补充块（第二步的编号步骤、末页的「已是默认」标记） */
  readonly extra: ReactNode;
}

interface FooterButton {
  readonly label: string;
  readonly run: () => void;
}

export interface FirstRunGuideProps {
  /**
   * 关闭向导。本组件已在调用前写好首启标志，调用方只需把自己的开合状态置回去
   * （首启弹出与空状态页手动唤起共用同一条回路）。
   */
  readonly onClose: () => void;
}

/* ── 小件 ───────────────────────────────────────────────────── */

/** 编号步骤的圆形序号：12px 小字 + 半透明底，属 UI 而非插画 */
function StepNumber({ index }: { readonly index: number }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-hover text-ui-xs text-tertiary"
    >
      {index}
    </span>
  );
}

function NumberedSteps({ steps }: { readonly steps: readonly string[] }) {
  return (
    <ol className="mt-3 space-y-1.5">
      {steps.map((step, index) => (
        <li key={step} className="flex items-start gap-2">
          <StepNumber index={index + 1} />
          <span className="min-w-0 flex-1 text-ui-sm text-tertiary">{step}</span>
        </li>
      ))}
    </ol>
  );
}

/* ── 向导本体 ───────────────────────────────────────────────── */

export function FirstRunGuide({ onClose }: FirstRunGuideProps) {
  const [step, setStep] = useState(STEP_WELCOME);
  const [defaultState, setDefaultState] = useState<DefaultAppState>("checking");
  /** 点过「打开系统设置」之后，次要按钮从「稍后再说」变成「下一步」 */
  const [settingsOpened, setSettingsOpened] = useState(false);
  /** 深链没打开（老系统 / 策略限制）：补一行手动路径，不假装成功 */
  const [settingsFailed, setSettingsFailed] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  /** 窗口重新获得焦点时的复检要读到当前步，但不该因此重挂监听 */
  const stepRef = useRef(step);

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const isSelf = defaultState === "self";

  /* ── 只读检测当前默认程序（红线 2：只读，永不写 UserChoice） ── */

  const refreshDefaultApp = useCallback((): void => {
    void queryDefaultApp()
      .then((status) => {
        setDefaultState(status.isSelf ? "self" : "other");
        // 用户刚在系统设置里选完切回来：第二步的使命已经完成，直接推到末页
        if (status.isSelf && stepRef.current === STEP_DEFAULT) {
          setStep(STEP_DONE);
        }
      })
      .catch((error: unknown) => {
        // 命令尚未实装 / 注册表读不到都会走这里，一律按"不确定"处理并继续引导
        console.warn("[first-run] query default app failed", error);
        setDefaultState("unknown");
      });
  }, []);

  useEffect(() => {
    refreshDefaultApp();
  }, [refreshDefaultApp]);

  /**
   * 用户去系统设置点完再切回来，本窗口会重新获得焦点——那正是复检的时机。
   * 没有这一下，末页就只能一直说"没设成"，而用户明明刚设好。
   */
  useEffect(() => {
    const onFocus = (): void => {
      refreshDefaultApp();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshDefaultApp]);

  /* ── 步进与关闭 ── */

  const close = useCallback((): void => {
    markFirstRunDone();
    onClose();
  }, [onClose]);

  const goNext = useCallback((): void => {
    setStep((current) => {
      // 已是默认 → 第二步没有任何事可做，整步跳过（规格明确要求）
      if (current === STEP_WELCOME && isSelf) {
        return STEP_DONE;
      }
      return Math.min(current + 1, STEP_DONE);
    });
  }, [isSelf]);

  const openSettings = useCallback((): void => {
    void openDefaultAppsSettings()
      .then(() => {
        setSettingsFailed(false);
        setSettingsOpened(true);
      })
      .catch((error: unknown) => {
        console.warn("[first-run] open default apps settings failed", error);
        setSettingsFailed(true);
      });
  }, []);

  /* ── 键盘：Esc 关闭 + Tab 焦点陷阱（DG 6.5） ── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      // 捕获阶段吃掉：向导是最上层，App 的 Esc 语义链不该同时响应
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close]);

  /** 每步把焦点放到主按钮：键盘用户一路回车就能走完 */
  useEffect(() => {
    primaryRef.current?.focus();
  }, [step]);

  const onTrapKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") {
      return;
    }
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    const focusables = Array.from(
      card.querySelectorAll<HTMLElement>("button:not([disabled])"),
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

  /* ── 三块面板 ── */

  const panels: readonly PanelSpec[] = [
    {
      key: "welcome",
      title: t.firstRun.welcomeTitle,
      body: t.firstRun.welcomeBody,
      extra: null,
    },
    {
      key: "default",
      title: t.firstRun.defaultTitle,
      body: t.firstRun.defaultBody,
      extra: (
        <>
          <NumberedSteps
            steps={[
              t.firstRun.settingsStep1,
              t.firstRun.settingsStep2,
              t.firstRun.settingsStep3,
            ]}
          />
          {settingsFailed ? (
            <p className="mt-3 text-ui-sm text-warn">
              {t.firstRun.openSettingsFailed}
            </p>
          ) : null}
          {defaultState === "checking" ? (
            <p className="mt-3 text-ui-sm text-caption">{t.firstRun.checking}</p>
          ) : null}
        </>
      ),
    },
    {
      key: "done",
      title: t.firstRun.doneTitle,
      body: isSelf ? t.firstRun.alreadyDefaultBody : t.firstRun.notDefaultBody,
      extra: (
        <p className="mt-3 text-ui-sm text-tertiary">
          {isSelf ? (
            <span className="mr-2 inline-flex h-5 items-center rounded-chip bg-hover px-2 text-ui-xs text-secondary">
              {t.firstRun.alreadyDefault}
            </span>
          ) : null}
          {t.firstRun.doneBody}
        </p>
      ),
    },
  ];

  /* ── 底部按钮：最多两个（次要 + 主按钮），三步各不相同 ── */

  const secondary: FooterButton | null =
    step === STEP_WELCOME
      ? { label: t.firstRun.skip, run: close }
      : step === STEP_DEFAULT
        ? {
            label: settingsOpened ? t.firstRun.next : t.firstRun.later,
            run: goNext,
          }
        : null;

  const primary: FooterButton =
    step === STEP_WELCOME
      ? { label: t.firstRun.next, run: goNext }
      : step === STEP_DEFAULT
        ? { label: t.firstRun.openSettings, run: openSettings }
        : { label: t.firstRun.finish, run: close };

  return (
    // 遮罩点击**不关**向导：这是一次需要明确表态的引导（跳过/走完都有按钮），
    // 手滑点到卡片外就永久错过它，比多点一下糟糕。Esc 仍然是通用退路（DG 6.5）。
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-mask p-6 animate-fade-in">
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.firstRun.label}
        onKeyDown={onTrapKeyDown}
        className="w-full max-w-md rounded-modal border border-float bg-layer p-6 shadow-lv3"
      >
        {/* 面板轨道：三块并排，整体左移一屏一屏。只动 transform（DG 6.3 可过渡属性表） */}
        <div className="overflow-hidden">
          <div
            className="flex transition-transform duration-base ease-standard"
            style={{ transform: `translateX(-${step * 100}%)` }}
          >
            {panels.map((panel, index) => (
              <section
                key={panel.key}
                // 非当前面板始终在 DOM 里（容器高度才不会随步进跳动），但不进无障碍树
                aria-hidden={index !== step}
                className="w-full shrink-0"
              >
                <h2 className="text-h3 font-semibold text-primary">{panel.title}</h2>
                <p className="mt-2 text-ui text-secondary">{panel.body}</p>
                {panel.extra}
              </section>
            ))}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          {/* 步进指示：圆点纯装饰，真正读出来的是 sr-only 那句 */}
          <div className="flex items-center gap-1.5">
            <span className="sr-only">
              {t.firstRun.stepIndicator(step + 1, STEP_COUNT)}
            </span>
            {panels.map((panel, index) => (
              <span
                key={panel.key}
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${
                  index === step ? "bg-secondary" : "bg-disabled"
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {secondary === null ? null : (
              <button
                type="button"
                onClick={secondary.run}
                className="flex h-row items-center rounded-row px-2 text-ui text-primary hover:bg-hover"
              >
                {secondary.label}
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              onClick={primary.run}
              className="flex h-btn items-center rounded-btn bg-brand px-3.5 text-ui font-medium text-inverted hover:bg-brand-hover"
            >
              {primary.label}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
